// The session lifecycle end to end against the fake Pi (tests/fixtures/fake-pi): the attachment records Pi's records,
// folds them into lifecycle events as it goes, and the overview is reduced from the store. The fake Pi speaks Pi
// 1.0.0's documented records; nothing here shows what a real Pi or model does (see pi-lifecycle-fixtures.test.ts for
// the real-fixture check, which stays skipped until a maintainer records one).
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAttachmentV0, PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { harnessOverviewCommand } from "../cli/harness.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoSessionOverviewV0 } from "../protocol/session-overview.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import {
	killPiSessionChildV0,
	type PiLifecycleRecorderOptionsV0,
	recordPiLifecycleFixturesV0,
} from "../scripts/record-lifecycle-fixture.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { type FakePiInstall, fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { recordFakeLifecycleFixtures } from "./fixtures/pi-lifecycle/record-fake.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
	vi.restoreAllMocks();
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function setup() {
	const install = installFakePi("1.0.0");
	cleanup.push(() => install.remove());
	return { install, root: temp("endo-lifecycle-root-"), cwd: temp("endo-lifecycle-cwd-") };
}

const ENV = fakePiEnv({ FAKE_PI_STEP_MS: "15" });

function attachment(install: FakePiInstall, root: string, cwd: string) {
	return new PiAttachmentV0({ root, cwd, executable: install.bin, env: ENV, requestTimeoutMs: 10_000 });
}

/** Local checks and the (authorized) live study, so STOP is admitted; then the scenario for the session itself. */
async function ready(scenario = "") {
	const { install, root, cwd } = setup();
	const pi = attachment(install, root, cwd);
	await pi.checkLocal();
	await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
	install.setScenario(scenario);
	return { install, root, cwd, pi };
}

function events(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const all = store.page({ limit: 10_000 }).events;
	store.close();
	return all;
}

function overviewOf(root: string): EndoSessionOverviewV0 {
	return reduceEndoSessionOverviewV0(events(root));
}

async function untilStreaming(session: PiSessionAttachmentV0): Promise<void> {
	const start = session.counters.deltasDropped;
	const deadline = Date.now() + 10_000;
	while (session.counters.deltasDropped - start < 2) {
		if (Date.now() > deadline) throw new Error("Pi never streamed");
		await new Promise((done) => setTimeout(done, 5));
	}
}

async function runPrompt(session: PiSessionAttachmentV0, text: string): Promise<void> {
	const settled = session.waitForSettled(10_000);
	await session.prompt(text);
	expect(await settled).toBe(true);
}

describe("runtime-reported outcomes", () => {
	it("a failed run records Pi's errorMessage as the cause", async () => {
		const { root, pi } = await ready("fail-run");
		const session = await pi.openSession();
		await runPrompt(session, "hello");
		await session.close();
		expect(overviewOf(root).lastRun).toMatchObject({
			outcome: "failed",
			cause: {
				source: "assistant-message",
				stopReason: { status: "reported", value: "error" },
				message: { status: "reported", value: "fake provider: 529 overloaded" },
			},
		});
	});

	it("a retry loop that gives up records auto_retry_end's finalError as the cause", async () => {
		const { root, pi } = await ready("retry-fail");
		const session = await pi.openSession();
		await runPrompt(session, "hello");
		await session.close();
		expect(overviewOf(root).lastRun?.cause).toMatchObject({
			source: "retry-exhausted",
			message: { status: "reported", value: "fake provider: retries exhausted" },
		});
	});

	it("a compaction is recorded as compacted, with Pi's first kept entry", async () => {
		const { root, pi } = await ready("compact-after-run");
		const session = await pi.openSession();
		await runPrompt(session, "hello");
		await session.close();
		const compacted = events(root).filter((event) => event.kind === "lifecycle.compacted");
		expect(compacted).toHaveLength(1);
		expect(compacted[0]!.payload).toMatchObject({ reason: "threshold", tokensBefore: 1234 });
		expect(overviewOf(root).counts).toMatchObject({ compactions: 1, completed: 1 });
	});

	it("an undocumented lifecycle record from Pi surfaces in the overview", async () => {
		const { root, pi } = await ready("unknown-lifecycle");
		const session = await pi.openSession();
		await runPrompt(session, "hello");
		await session.close();
		expect(overviewOf(root).unrecognized).toEqual([
			expect.objectContaining({ kind: "lifecycle.unrecognized-runtime-event", runtimeEvent: "agent_paused" }),
		]);
	});
});

describe("STOP", () => {
	it("mid-turn: requested, Pi's abort observed at settle, and the acceptance (sent once idle) recorded after", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		await session.stop();
		expect(await settled).toBe(true);
		await session.close();
		const kinds = events(root)
			.map((event) => event.kind)
			.filter((kind) => kind.startsWith("lifecycle.") && kind !== "lifecycle.turn-started");
		expect(kinds.slice(kinds.indexOf("lifecycle.stop-requested"))).toEqual([
			"lifecycle.stop-requested",
			"lifecycle.turn-completed",
			"lifecycle.run-aborted",
			"lifecycle.stop-accepted",
			"lifecycle.detached",
		]);
		expect(overviewOf(root).lastRun).toMatchObject({ outcome: "aborted", stopRequested: true });
	});

	it("an acceptance with no termination: the run then completes on its own, and is not recorded as aborted", async () => {
		const { root, pi } = await ready("abort-ack-only");
		const session = await pi.openSession();
		const settled = session.waitForSettled(10_000);
		await session.prompt("count to forty");
		await untilStreaming(session);
		await session.stop();
		const mid = overviewOf(root);
		expect(mid.state).toBe("running");
		expect(mid.run?.stop).toEqual({
			requested: true,
			accepted: true,
			termination: { status: "UNAVAILABLE", reason: "no termination has been observed for this run" },
		});
		expect(await settled).toBe(true);
		await session.close();
		const done = overviewOf(root);
		expect(done.lastRun).toMatchObject({ outcome: "completed", stopRequested: true });
		expect(done.counts).toMatchObject({ aborted: 0, stopsAccepted: 1 });
	});
});

describe("crashes", () => {
	it("Pi killed mid-turn: the run is interrupted (runtime-exited); the reconnect resumes and catches up without duplicates", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		await session.prompt("count to forty");
		await untilStreaming(session);
		process.kill(session.pid!, "SIGKILL");
		await session.exited();
		await session.reconnect();
		await runPrompt(session, "again");
		await session.close();
		const recorded = events(root);
		expect(recorded.find((event) => event.kind === "lifecycle.interrupted")?.payload).toMatchObject({
			cause: "runtime-exited",
			runOpen: true,
			exit: { signal: "SIGKILL", expected: false },
		});
		expect(recorded.find((event) => event.kind === "lifecycle.session-resumed")?.payload).toMatchObject({
			previousEnd: "runtime-exited-unexpected",
		});
		const entries = recorded.filter((event) => event.kind === "session.entry-observed").map((event) => event.id);
		expect(new Set(entries).size).toBe(entries.length);
		expect(overviewOf(root).counts).toMatchObject({ interrupted: 1, completed: 1, runs: 2 });
	});

	it("Endophasia killed mid-turn, then a torn tail: reopening records the interruption with what was recovered, resumes, and catch-up stays deduplicated", async () => {
		const { install, root, cwd } = setup();
		const scratch = { directory: temp("endo-lifecycle-scratch-"), env: ENV, cwd };
		const options: PiLifecycleRecorderOptionsV0 = {
			pi: install.bin,
			baseUrl: null,
			model: "fake-1",
			providerName: "fake",
			apiKeyEnv: null,
			out: temp("endo-lifecycle-out-"),
			authorizeLiveStudy: false,
			timeoutMs: 20_000,
			kind: "fake-pi",
		};
		const notes: string[] = [];
		// A real child process: opens the session, starts the long prompt, and is SIGKILLed once Pi streams.
		expect(await killPiSessionChildV0(options, scratch, root, notes)).toBe(true);
		const log = join(root, "events", "events.log");
		const intact = statSync(log).size;
		// The child died mid-append, too: a torn frame at the end of the log.
		const torn = Buffer.from([0, 0, 1, 0, 9, 9, 9]);
		const fd = openSync(log, "a");
		writeSync(fd, torn);
		closeSync(fd);
		const before = events(root).length;

		const pi = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: ENV,
			provider: "fake",
			model: "fake-1",
			requestTimeoutMs: 10_000,
		});
		const session = await pi.openSession();
		expect(statSync(log).size).toBeGreaterThan(intact);
		expect(readdirSync(join(root, "events")).some((name) => name.startsWith("events.log.discarded-"))).toBe(true);
		await runPrompt(session, "after the crash");
		await session.close();

		const recorded = events(root);
		const opened = recorded.filter((event) => event.kind === "harness.store-opened").at(-1)!;
		expect(opened.payload).toMatchObject({
			recovery: { truncated: true, recovered: true, discarded: { bytes: torn.length } },
		});
		const interrupted = recorded.find((event) => event.kind === "lifecycle.interrupted")!;
		expect(interrupted.payload).toMatchObject({
			cause: "observer-lost",
			runOpen: true,
			storeRecovery: { recovered: true, discarded: { bytes: torn.length } },
		});
		const resumed = recorded.find((event) => event.kind === "lifecycle.session-resumed")!;
		expect(resumed.payload).toMatchObject({ previousEnd: "interrupted" });
		expect(recorded.indexOf(interrupted)).toBeLessThan(recorded.indexOf(resumed));
		const entries = recorded.filter((event) => event.kind === "session.entry-observed").map((event) => event.id);
		expect(new Set(entries).size).toBe(entries.length);
		expect(recorded.length).toBeGreaterThan(before);
		const overview = overviewOf(root);
		expect(overview.counts).toMatchObject({ interrupted: 1, completed: 1, runs: 2 });
		expect(overview.attachments).toMatchObject({ count: 2, resumes: 1 });
		expect(overview.lastRun?.outcome).toBe("completed");
	}, 60_000);

	it("lifecycle events a crash kept from being stored are re-derived on open, identically", async () => {
		const fixture = readFileSync(
			new URL("./fixtures/pi-lifecycle/fake-pi-1.0.0/killed-and-resumed.events.jsonl", import.meta.url),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as EndoEventV0);
		const { install, root, cwd } = setup();
		// The store holds every recorded fact but none of the lifecycle events derived from them.
		const store = createEndoDurableEventStoreV0(root);
		for (const event of fixture.filter((candidate) => candidate.source === "runtime-fact")) store.ingest(event);
		store.close();
		const pi = attachment(install, root, cwd);
		const { fingerprint } = await pi.identify();
		const session = new PiSessionAttachmentV0(pi, fingerprint!, pi.state());
		const expected = fixture.filter((event) => event.kind.startsWith("lifecycle."));
		expect(session.counters.lifecycleRepaired).toBe(expected.length);
		await session.close();
		const repaired = events(root).filter((event) => event.kind.startsWith("lifecycle."));
		expect(canonicalEndoJsonV0(repaired)).toBe(canonicalEndoJsonV0(expected));
		// A second open finds nothing missing.
		const again = new PiSessionAttachmentV0(pi, fingerprint!, pi.state());
		expect(again.counters.lifecycleRepaired).toBe(0);
		await again.close();
	});
});

describe("the recorder and the overview command", () => {
	it("the recorder records all three sessions against the fake Pi and labels them fake", async () => {
		const out = temp("endo-lifecycle-fixture-");
		const provenance = (await recordFakeLifecycleFixtures(out)) as {
			kind: string;
			pi: { isDeterministicSuiteFake: boolean };
			sessions: { name: string; status: string }[];
			model: { endpoint: unknown; apiKey: string };
		};
		expect(provenance.kind).toBe("fake-pi");
		expect(provenance.pi.isDeterministicSuiteFake).toBe(true);
		expect(provenance.model.endpoint).toBeNull();
		expect(provenance.sessions.map((session) => [session.name, session.status])).toEqual([
			["completes", "recorded"],
			["stop-mid-turn", "recorded"],
			["killed-and-resumed", "recorded"],
		]);
		const overview = (name: string) =>
			JSON.parse(readFileSync(join(out, `${name}.overview.json`), "utf8")) as EndoSessionOverviewV0;
		expect(overview("completes").lastRun?.outcome).toBe("completed");
		expect(overview("stop-mid-turn").lastRun).toMatchObject({ outcome: "aborted", stopRequested: true });
		expect(overview("killed-and-resumed").counts).toMatchObject({ interrupted: 1, completed: 1 });
		expect(overview("killed-and-resumed").attachments.resumes).toBe(1);
	}, 90_000);

	it("the recorder refuses to label the fake Pi a real recording", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const out = temp("endo-lifecycle-refuse-");
		await expect(
			recordPiLifecycleFixturesV0({
				pi: install.bin,
				baseUrl: null,
				model: "fake-1",
				providerName: "fake",
				apiKeyEnv: null,
				out,
				authorizeLiveStudy: false,
				timeoutMs: 10_000,
				kind: "real",
				log: () => {},
			}),
		).rejects.toThrow(/fake Pi/);
		expect(readdirSync(out)).toEqual([]);
	});

	it("endo harness overview prints the reduced overview and leaves the store byte-identical", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		await runPrompt(session, "hello");
		await session.close();
		const log = join(root, "events", "events.log");
		const before = readFileSync(log);
		const printed: string[] = [];
		vi.spyOn(console, "log").mockImplementation((value: unknown) => {
			printed.push(String(value));
		});
		await harnessOverviewCommand([root]);
		const output = JSON.parse(printed[0]!) as { overview: EndoSessionOverviewV0 };
		expect(canonicalEndoJsonV0(output.overview)).toBe(canonicalEndoJsonV0(overviewOf(root)));
		expect(output.overview.lastRun?.outcome).toBe("completed");
		expect(readFileSync(log)).toEqual(before);
	});
});
