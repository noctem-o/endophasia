// The Pi session lifecycle as pure functions: recorded attachment events folded into `lifecycle.*` events
// (adapters/pi/lifecycle.ts), and those reduced to a session overview (runtime/contracts/session-overview.ts).
// Synthetic recorded streams, so every ordering — including the hostile ones — is exact and fast:
// out-of-order records, a duplicate after resume, a STOP accepted with no termination, unknown lifecycle records.
import { describe, expect, it } from "vitest";
import {
	PI_LIFECYCLE_UNAVAILABLE_V0,
	piLifecycleFoldV0,
	piLifecycleInitialStateV0,
	piLifecycleStepV0,
} from "../adapters/pi/lifecycle.ts";
import {
	mapPiLiveEventV0,
	PI_RUNTIME_TEXT_LIMIT_V0,
	type PiMappingContextV0,
	piFailureClassV0,
} from "../adapters/pi/mapping.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";

/** A recorded attachment stream, built one Pi record at a time. */
function recording() {
	const events: EndoEventV0[] = [];
	let sequence = 0;
	let instance = "i1";
	let live = 0;
	const add = (kind: string, payload: Record<string, JsonValueV0> = {}) => {
		sequence += 1;
		live += 1;
		events.push({
			schemaVersion: "endo.event.v0",
			id: `endo.event.pi-live.${instance}.${live}`,
			kind,
			source: "runtime-fact",
			sequence,
			at: `2026-10-03T12:00:${String(sequence % 60).padStart(2, "0")}Z`,
			coordinates: { sessionId: "endo.session.pi.s1" },
			producer: "pi-rpc-adapter:pi.default",
			derivedFrom: [],
			payload,
		});
	};
	const api = {
		events,
		attach(id: string, piSessionId = "s1") {
			instance = id;
			live = 0;
			add("harness.store-opened", {
				recovery: { truncated: false, recovered: false, discarded: null, sealed: false },
			});
			add("harness.attached", { instance: id, piSessionId });
			return api;
		},
		run(stopReason = "stop", extra: Record<string, JsonValueV0> = {}) {
			add("agent.run-started", { runtimeEvent: "agent_start" });
			add("agent.turn-started", { runtimeEvent: "turn_start" });
			add("agent.turn-finished", { runtimeEvent: "turn_end", stopReason, ...extra });
			add("agent.run-ended", { runtimeEvent: "agent_end" });
			add("agent.settled", { runtimeEvent: "agent_settled" });
			return api;
		},
		add(kind: string, payload: Record<string, JsonValueV0> = {}) {
			add(kind, payload);
			return api;
		},
		exit(expected: boolean, signal: string | null = null) {
			add("harness.process-exited", { code: expected ? 0 : null, signal, spawnFailed: false, expected });
			return api;
		},
	};
	return api;
}

/** A failure-text reference as the mapping records it. */
function ref(source: string, text: string, classification: string): Record<string, JsonValueV0> {
	return { source, sha256: sha256HexV0(text), bytes: Buffer.byteLength(text), truncated: false, classification };
}

function lifecycleOf(events: EndoEventV0[]) {
	const { events: derived } = piLifecycleFoldV0(events, "pi.default");
	return { derived, kinds: derived.map((event) => event.kind), overview: reduceEndoSessionOverviewV0(derived) };
}

describe("lifecycle fold: the documented paths", () => {
	it("a completed run: session started, run and turn events, completion with Pi's stop reason, detach", () => {
		const { derived, kinds, overview } = lifecycleOf(recording().attach("i1").run("stop").exit(true).events);
		expect(kinds).toEqual([
			"lifecycle.session-started",
			"lifecycle.run-started",
			"lifecycle.turn-started",
			"lifecycle.turn-completed",
			"lifecycle.run-completed",
			"lifecycle.detached",
		]);
		expect(derived.every((event) => event.source === "interpretation" && event.derivedFrom.length === 1)).toBe(true);
		expect(derived.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(overview.state).toBe("detached");
		expect(overview.lastRun).toEqual({
			outcome: "completed",
			turns: 1,
			stopReason: { status: "reported", value: "stop" },
			cause: null,
			stopRequested: false,
		});
		expect(overview.session).toEqual({ status: "reported", value: { runtime: "pi", runtimeSessionId: "s1" } });
		expect(overview.unavailable).toEqual(PI_LIFECYCLE_UNAVAILABLE_V0);
		expect(overview.anomalies).toEqual([]);
	});

	it("a failed run carries Pi's own cause by reference (digest, length, classification), never as text", () => {
		const overloaded = ref("assistant-message.errorMessage", "529 overloaded", "overloaded");
		const failed = lifecycleOf(recording().attach("i1").run("error", { errorMessage: overloaded }).events).overview
			.lastRun;
		expect(failed?.outcome).toBe("failed");
		expect(failed?.cause).toEqual({
			source: "assistant-message",
			stopReason: { status: "reported", value: "error" },
			message: { status: "reported", value: overloaded },
		});
		// A malformed reference is not a cause: UNAVAILABLE, never a guess.
		const malformed = lifecycleOf(
			recording()
				.attach("i1")
				.run("error", { errorMessage: { ...overloaded, classification: "made-up" } }).events,
		).overview.lastRun;
		expect(malformed?.cause).toMatchObject({ message: { status: "UNAVAILABLE" } });
		// No errorMessage reported: the cause's message is UNAVAILABLE, not a placeholder.
		const silent = lifecycleOf(recording().attach("i1").run("error").events).overview.lastRun;
		expect(silent?.cause).toMatchObject({ message: { status: "UNAVAILABLE" } });
		// A retry loop that gave up is a failure with the retry's final error, whatever the last stop reason.
		const retried = recording().attach("i1");
		retried
			.add("agent.run-started")
			.add("retry.finished", {
				success: false,
				finalError: ref("auto_retry_end.finalError", "retries exhausted", "unclassified"),
			})
			.add("agent.settled");
		expect(lifecycleOf(retried.events).overview.lastRun?.cause).toMatchObject({
			source: "retry-exhausted",
			message: {
				status: "reported",
				value: { source: "auto_retry_end.finalError", classification: "unclassified" },
			},
		});
	});

	it("a STOP: request, Pi's own abort termination, and the acceptance that Pi sends once idle, kept apart", () => {
		const stream = recording().attach("i1");
		stream
			.add("agent.run-started")
			.add("agent.turn-started")
			.add("control.requested", { capability: "steering.stop", action: "abort" })
			.add("agent.turn-finished", { stopReason: "aborted" })
			.add("agent.settled")
			.add("control.accepted", { capability: "steering.stop", action: "abort" });
		const { derived, kinds, overview } = lifecycleOf(stream.events);
		expect(kinds.slice(-3)).toEqual(["lifecycle.turn-completed", "lifecycle.run-aborted", "lifecycle.stop-accepted"]);
		expect(derived.find((event) => event.kind === "lifecycle.stop-accepted")?.payload).toEqual({ runOpen: false });
		expect(overview.lastRun).toMatchObject({ outcome: "aborted", stopRequested: true });
		expect(overview.counts).toMatchObject({ stopsRequested: 1, stopsAccepted: 1, aborted: 1 });
	});

	it("an abort Pi reports without any STOP request is an abort, not an accepted STOP", () => {
		const { overview } = lifecycleOf(recording().attach("i1").run("aborted").events);
		expect(overview.lastRun).toMatchObject({ outcome: "aborted", stopRequested: false });
		expect(overview.counts.stopsRequested).toBe(0);
	});

	it("continuations (a second agent_start before agent_settled) stay one run", () => {
		const stream = recording().attach("i1");
		stream
			.add("agent.run-started")
			.add("agent.turn-started")
			.add("agent.turn-finished", { stopReason: "stop" })
			.add("agent.run-ended")
			.add("agent.run-started")
			.add("agent.turn-started")
			.add("agent.turn-finished", { stopReason: "stop" })
			.add("agent.settled");
		const { overview } = lifecycleOf(stream.events);
		expect(overview.counts).toMatchObject({ runs: 1, turns: 2, completed: 1 });
	});

	it("a Pi process that exits mid-turn interrupts the run: no outcome is invented", () => {
		const stream = recording().attach("i1");
		stream.add("agent.run-started").add("agent.turn-started").exit(false, "SIGKILL");
		const { derived, overview } = lifecycleOf(stream.events);
		expect(derived.at(-1)?.kind).toBe("lifecycle.interrupted");
		expect(derived.at(-1)?.payload).toMatchObject({
			cause: "runtime-exited",
			runOpen: true,
			turnOpen: true,
			exit: { signal: "SIGKILL", expected: false },
		});
		expect(overview.state).toBe("interrupted");
		expect(overview.lastRun).toMatchObject({ outcome: "interrupted", stopReason: { status: "UNAVAILABLE" } });
	});

	it("an observer lost mid-turn: the next attachment records the interruption with the store recovery, then the resume", () => {
		const stream = recording().attach("i1");
		stream.add("agent.run-started").add("agent.turn-started");
		// No process exit was recorded: the observer died. The reopening observer recovered a torn tail.
		stream.add("harness.store-opened", {
			recovery: {
				truncated: true,
				recovered: true,
				discarded: { bytes: 9, sha256: "ab".repeat(32) },
				sealed: false,
			},
		});
		stream.add("harness.attached", { instance: "i2", piSessionId: "s1" });
		stream.run("stop");
		const { derived, overview } = lifecycleOf(stream.events);
		const interrupted = derived.find((event) => event.kind === "lifecycle.interrupted");
		expect(interrupted?.payload).toMatchObject({
			cause: "observer-lost",
			instance: "i1",
			runOpen: true,
			turnOpen: true,
			storeRecovery: { recovered: true, discarded: { bytes: 9 } },
		});
		const resumed = derived.find((event) => event.kind === "lifecycle.session-resumed");
		expect(resumed?.payload).toMatchObject({ instance: "i2", previousInstance: "i1", previousEnd: "interrupted" });
		expect(overview.counts).toMatchObject({ interrupted: 1, completed: 1, runs: 2 });
		expect(overview.attachments).toEqual({ count: 2, resumes: 1, lastInstance: "i2" });
	});

	it("a compaction with a result is recorded; a failed one is not a compaction", () => {
		const stream = recording().attach("i1");
		stream
			.add("compaction.finished", { succeeded: true, reason: "threshold", firstKeptEntryId: "e9", tokensBefore: 10 })
			.add("compaction.finished", {
				succeeded: false,
				reason: "overflow",
				errorMessage: ref("compaction_end.errorMessage", "summary failed", "unclassified"),
			});
		const { derived, overview } = lifecycleOf(stream.events);
		expect(derived.filter((event) => event.kind === "lifecycle.compacted").map((event) => event.payload)).toEqual([
			{ reason: "threshold", firstKeptEntryId: "e9", tokensBefore: 10 },
		]);
		expect(overview.counts.compactions).toBe(1);
	});

	it("events of other producers, and the lifecycle stream itself, are not folded", () => {
		const stream = recording().attach("i1").run();
		const { derived } = lifecycleOf(stream.events);
		const again = piLifecycleFoldV0([...stream.events, ...derived], "pi.default");
		expect(again.events).toEqual(derived);
		const foreign = { ...stream.events[1]!, id: "endo.event.other.1", producer: "someone-else" };
		expect(piLifecycleStepV0(piLifecycleInitialStateV0("pi.default"), foreign).events).toEqual([]);
		// Another attachment recording into the same store is another stream: it neither feeds nor disturbs this fold.
		const other = recording()
			.attach("o1")
			.add("agent.run-started")
			.events.map((event) => ({
				...event,
				id: event.id.replace("pi-live", "pi-live-other"),
				producer: "pi-rpc-adapter:pi.other",
			}));
		const interleaved = [stream.events[0]!, ...other, ...stream.events.slice(1)];
		expect(piLifecycleFoldV0(interleaved, "pi.default").events).toEqual(derived);
		expect(piLifecycleFoldV0(interleaved, "pi.other").events.map((event) => event.kind)).toEqual([
			"lifecycle.session-started",
			"lifecycle.run-started",
		]);
	});
});

describe("lifecycle: hostile streams", () => {
	it("out-of-order records become anomalies, never a silent correction", () => {
		const stream = recording().attach("i1");
		stream
			.add("agent.turn-finished", { stopReason: "stop" }) // a turn that never started
			.add("agent.settled") // a settle with no run
			.add("agent.turn-started") // a turn outside a run
			.add("agent.run-started")
			.add("agent.turn-finished", { stopReason: "stop" }) // inside a run, but no turn started
			.add("agent.turn-started")
			.add("agent.turn-started") // a second turn while one is open
			.add("agent.turn-finished", { stopReason: "stop" })
			.add("agent.settled")
			.exit(true)
			.exit(true) // a second exit
			.add("agent.run-started"); // a run with no attached process
		const { overview } = lifecycleOf(stream.events);
		expect(overview.anomalies.map((entry) => entry.problem)).toEqual([
			"a turn finished with no run open",
			"agent_settled with no run open",
			"a turn started with no run open",
			"a turn finished that had not started",
			"a turn started while another turn was open",
			"a process exit with no attached process",
			"a run started with no attached process",
		]);
		// The well-formed part still reduces: one run, completed.
		expect(overview.counts).toMatchObject({ runs: 1, completed: 1 });
		expect(overview.state).toBe("detached");
	});

	it("a duplicate after resume: a replayed agent_settled from the new process completes nothing twice", () => {
		const stream = recording().attach("i1").run("stop").exit(false);
		stream.attach("i2");
		stream.add("agent.settled"); // Pi re-reports a settle for the run that already ended
		const { overview } = lifecycleOf(stream.events);
		expect(overview.counts.completed).toBe(1);
		expect(overview.anomalies).toEqual([
			expect.objectContaining({ observed: "agent.settled", problem: "agent_settled with no run open" }),
		]);
		expect(overview.attachments.resumes).toBe(1);
	});

	it("a duplicate lifecycle event (same id) is counted once, wherever it reappears", () => {
		const { derived } = lifecycleOf(recording().attach("i1").run().events);
		const duplicated = [...derived, derived[1]!, derived[4]!];
		const overview = reduceEndoSessionOverviewV0(duplicated);
		expect(overview.duplicatesIgnored).toBe(2);
		expect(overview.counts).toMatchObject({ runs: 1, completed: 1 });
		expect(canonicalEndoJsonV0({ ...overview, duplicatesIgnored: 0 })).toBe(
			canonicalEndoJsonV0(reduceEndoSessionOverviewV0(derived)),
		);
	});

	it("a STOP accepted with no termination: accepted, termination UNAVAILABLE, and then interrupted, never aborted", () => {
		const stream = recording().attach("i1");
		stream
			.add("agent.run-started")
			.add("agent.turn-started")
			.add("control.requested", { capability: "steering.stop", action: "abort" })
			.add("control.accepted", { capability: "steering.stop", action: "abort" });
		const open = lifecycleOf(stream.events).overview;
		expect(open.state).toBe("running");
		expect(open.run?.stop).toEqual({
			requested: true,
			accepted: true,
			termination: { status: "UNAVAILABLE", reason: "no termination has been observed for this run" },
		});
		stream.exit(false, "SIGKILL");
		const ended = lifecycleOf(stream.events).overview;
		expect(ended.lastRun).toMatchObject({ outcome: "interrupted", stopRequested: true });
		expect(ended.counts.aborted).toBe(0);
	});

	it("an unknown runtime lifecycle record surfaces as unrecognized, not dropped", () => {
		const stream = recording().attach("i1");
		stream.add("agent.run-started").add("runtime.unrecognized-event", { runtimeEvent: "agent_paused" });
		const { overview } = lifecycleOf(stream.events);
		expect(overview.unrecognized).toEqual([
			expect.objectContaining({ kind: "lifecycle.unrecognized-runtime-event", runtimeEvent: "agent_paused" }),
		]);
	});

	it("an unknown lifecycle kind (a newer producer's) surfaces as unrecognized, and a malformed one as an anomaly", () => {
		const { derived } = lifecycleOf(recording().attach("i1").events);
		const future: EndoEventV0 = { ...derived[0]!, id: "endo.event.future.1", kind: "lifecycle.paused", payload: {} };
		const malformed: EndoEventV0 = {
			...derived[0]!,
			id: "endo.event.bad.1",
			kind: "lifecycle.session-started",
			payload: { runtime: 7 },
		};
		const overview = reduceEndoSessionOverviewV0([...derived, future, malformed]);
		expect(overview.unrecognized).toEqual([
			{ eventId: "endo.event.future.1", kind: "lifecycle.paused", runtimeEvent: null },
		]);
		expect(overview.anomalies).toEqual([
			{
				eventId: "endo.event.bad.1",
				observed: "lifecycle.session-started",
				problem: "a session start without the runtime or its session id",
			},
		]);
		expect(overview.attachments.count).toBe(1);
	});
});

describe("lifecycle: determinism", () => {
	it("folding the same recording twice gives byte-identical lifecycle events and overviews", () => {
		const build = () => {
			const stream = recording().attach("i1").run("stop");
			stream.add("agent.run-started").add("agent.turn-started");
			stream
				.attach("i2")
				.run("error", { errorMessage: ref("assistant-message.errorMessage", "boom", "unclassified") })
				.exit(true);
			return stream.events;
		};
		const first = lifecycleOf(build());
		const second = lifecycleOf(JSON.parse(JSON.stringify(build())));
		expect(canonicalEndoJsonV0(second.derived)).toBe(canonicalEndoJsonV0(first.derived));
		expect(canonicalEndoJsonV0(second.overview)).toBe(canonicalEndoJsonV0(first.overview));
	});
});

describe("failure text in the mapping (D1: digest, length and classification only)", () => {
	const context = (): PiMappingContextV0 => {
		let n = 0;
		return {
			attachment: "pi.default",
			piSessionId: "s1",
			instance: "i1",
			producer: "pi-rpc-adapter:pi.default",
			nextSequence: () => ++n,
			nextLive: () => n,
			now: () => "2026-10-03T12:00:00Z",
		};
	};

	it("turn_end with an error: the event carries a reference, the text travels beside it", () => {
		const text = "HTTP 429: rate limit reached for prompt 'my secret plan'";
		const mapped = mapPiLiveEventV0(context(), "turn_end", {
			message: { role: "assistant", stopReason: "error", errorMessage: text },
			toolResults: [],
		});
		if (mapped.kind !== "event") throw new Error("expected an event");
		expect(mapped.event.payload).toMatchObject({
			errorMessage: {
				source: "assistant-message.errorMessage",
				sha256: sha256HexV0(text),
				bytes: Buffer.byteLength(text),
				truncated: false,
				classification: "rate-limited",
			},
		});
		expect(JSON.stringify(mapped.event)).not.toContain("secret");
		expect(mapped.runtimeTexts).toEqual([{ sha256: sha256HexV0(text), text }]);
	});

	it("a stop reason other than error carries no cause, and keeps no text", () => {
		const mapped = mapPiLiveEventV0(context(), "message_end", {
			message: { role: "assistant", stopReason: "stop", errorMessage: "ignored" },
		});
		if (mapped.kind !== "event") throw new Error("expected an event");
		expect(mapped.event.payload).not.toHaveProperty("errorMessage");
		expect(mapped.runtimeTexts).toEqual([]);
	});

	it("over-long text is cut before digesting, and the cut is flagged", () => {
		const mapped = mapPiLiveEventV0(context(), "auto_retry_end", {
			success: false,
			attempt: 3,
			finalError: "x".repeat(PI_RUNTIME_TEXT_LIMIT_V0 + 10),
		});
		if (mapped.kind !== "event") throw new Error("expected an event");
		expect(mapped.event.payload).toMatchObject({
			finalError: { truncated: true, bytes: PI_RUNTIME_TEXT_LIMIT_V0, classification: "unclassified" },
		});
	});

	it("classification is a closed vocabulary, first matching rule wins", () => {
		expect(piFailureClassV0("529 overloaded")).toBe("overloaded");
		expect(piFailureClassV0("Request timed out")).toBe("timeout");
		expect(piFailureClassV0("401 Unauthorized")).toBe("authentication");
		expect(piFailureClassV0("maximum context length exceeded")).toBe("context-length");
		expect(piFailureClassV0("fetch failed: ECONNREFUSED")).toBe("network");
		expect(piFailureClassV0("HTTP 500")).toBe("server-error");
		expect(piFailureClassV0("HTTP 418")).toBe("client-error");
		expect(piFailureClassV0("something odd")).toBe("unclassified");
	});
});
