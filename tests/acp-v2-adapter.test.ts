// The ACP v2 (Draft, baseline) client against a deterministic fake agent (tests/fixtures/fake-acp-v2-agent.ts), which
// speaks raw JSON-RPC so it can send what an SDK agent would refuse to. No OMP, network, model or credentials.
// ACP v2 is experimental: see docs/acp-v2-study.md. The v1 adapter has its own suites and is not exercised here except to
// show that it stays v1 (negotiation).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AcpClientV0,
	AcpClosedErrorV0,
	AcpProcessExitedErrorV0,
	AcpProtocolErrorV0,
	AcpRefusedErrorV0,
	AcpTimeoutErrorV0,
	AcpUnavailableErrorV0,
} from "../adapters/acp/index.ts";
import {
	AcpClientV2,
	type AcpV2ClientOptionsV0,
	AcpVersionNegotiationErrorV0,
	compareAcpV2ReplayV0,
	connectAcpNegotiatedV0,
} from "../adapters/acp/v2.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-v2-agent.ts");
const FAKE_V1 = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");

let scratch: string;
let out: string;
let store: string;
let live: AcpClientV2[];
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "endo-acp2-"));
	out = join(scratch, "agent-notes.jsonl");
	store = join(scratch, "store.json");
	live = [];
});
afterEach(async () => {
	await Promise.all(live.map((client) => client.close()));
	rmSync(scratch, { recursive: true, force: true });
});

const launch = (flags: string, env: Record<string, string> = {}) => ({
	command: process.execPath,
	args: [FAKE],
	cwd: scratch,
	env: { FAKE_V2_FLAGS: flags, FAKE_V2_OUT: out, FAKE_V2_STORE: store, ...env },
});

async function attach(
	flags = "",
	options: Partial<AcpV2ClientOptionsV0> = {},
	open: Parameters<typeof AcpClientV2.connect>[1] = { cwd: scratch },
	env: Record<string, string> = {},
) {
	const events: EndoEventV0[] = [];
	const client = await AcpClientV2.connect(
		{
			launch: launch(flags, env),
			attachment: "fake.v2",
			onEvent: (event) => events.push(event),
			closeGraceMs: 300,
			...options,
		},
		open,
	);
	live.push(client);
	return { client, events };
}

async function attachFailing(flags: string, open: Parameters<typeof AcpClientV2.connect>[1] = { cwd: scratch }) {
	const events: EndoEventV0[] = [];
	const error = await AcpClientV2.connect(
		{ launch: launch(flags), attachment: "fake.v2", onEvent: (event) => events.push(event), closeGraceMs: 300 },
		open,
	).then(
		() => null,
		(caught: unknown) => caught,
	);
	return { error, events };
}

const kinds = (events: readonly EndoEventV0[]) => events.map((event) => event.kind);
const find = (events: readonly EndoEventV0[], kind: string) => events.filter((event) => event.kind === kind);
const payload = (event: EndoEventV0 | undefined) => (event?.payload ?? {}) as Record<string, unknown>;
const notes = (): Array<Record<string, unknown>> =>
	existsSync(out)
		? readFileSync(out, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>)
		: [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
	Promise.race([
		promise.then(
			() => true,
			() => true,
		),
		sleep(ms).then(() => false),
	]);
const LIFECYCLE_ENDS = [
	"lifecycle.run-completed",
	"lifecycle.run-aborted",
	"lifecycle.run-unclassified",
	"lifecycle.run-failed",
];
const endsOf = (events: readonly EndoEventV0[]) => events.filter((event) => LIFECYCLE_ENDS.includes(event.kind));

describe("ACP v2 negotiation", () => {
	it("requests protocolVersion 2 and records the v2 initialize evidence", async () => {
		const { client, events } = await attach();
		expect(notes().find((note) => note.received === "initialize")).toMatchObject({ protocolVersion: 2 });
		expect(client.initialize.protocolVersion).toBe(2);
		const initialized = payload(find(events, "harness.acp-initialized")[0]);
		expect(initialized).toMatchObject({
			mapping: "acp-v2-mapping.0",
			protocolVersion: 2,
			sessionSurface: "baseline",
			info: { name: "fake-acp-v2-agent", version: "9.9.9" },
		});
		expect(typeof initialized.capabilitiesDigest).toBe("string");
		const started = payload(find(events, "lifecycle.session-started")[0]);
		expect(started).toMatchObject({ protocol: "acp-v2-draft", openedBy: "session/new" });
		// What v2 does not report is declared, in v2's own words.
		const unavailable = (started.unavailable as Array<{ field: string; reason: string }>).map((entry) => entry.field);
		expect(unavailable).toEqual(expect.arrayContaining(["run.id", "run.start", "run.attribution", "usage"]));
		expect(JSON.stringify(started.unavailable)).not.toMatch(/ACP v1/);
	});

	it("fails closed, typed, when a v1-only agent answers 1: nothing is reinterpreted and no session opens", async () => {
		const { error, events } = await attachFailing("version=1");
		expect(error).toBeInstanceOf(AcpVersionNegotiationErrorV0);
		expect(error).toMatchObject({ kind: "agent-answered-v1", offered: 2, answered: 1 });
		expect(payload(find(events, "harness.protocol-fault")[0])).toMatchObject({
			fault: "unsupported-protocol-version",
			offered: 2,
			answered: 1,
		});
		expect(kinds(events)).not.toContain("harness.attached");
		expect(notes().some((note) => note.received === "session/new")).toBe(false);
	});

	it("fails closed on any other version and on incoherent answers", async () => {
		const three = await attachFailing("version=3");
		expect(three.error).toMatchObject({ kind: "unsupported-version", answered: 3 });
		const incoherent = await attachFailing("incoherent");
		expect(incoherent.error).toBeInstanceOf(AcpVersionNegotiationErrorV0);
		// Version 2 answered in a bad shape is incoherent, never "version 2 unsupported".
		expect(incoherent.error).toMatchObject({ kind: "incoherent" });
		expect(find(incoherent.events, "harness.protocol-fault").map((event) => payload(event).fault)).toEqual([
			"initialize-response-schema-invalid",
		]);
		expect(kinds(incoherent.events)).not.toContain("harness.attached");
		const text = await attachFailing("version=two");
		expect(text.error).toBeInstanceOf(AcpVersionNegotiationErrorV0);
		expect(kinds(text.events)).not.toContain("harness.attached");
	});

	it("does not let the v1 client attach to a v2 answer", async () => {
		const events: EndoEventV0[] = [];
		const error = await AcpClientV0.connect(
			{
				launch: { command: process.execPath, args: [FAKE], cwd: scratch, env: { FAKE_V2_OUT: out } },
				attachment: "fake.v1",
				onEvent: (event) => events.push(event),
				closeGraceMs: 300,
			},
			{ cwd: scratch },
		).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(AcpProtocolErrorV0);
		expect(kinds(events)).not.toContain("harness.attached");
	});

	describe("explicit v1 fallback", () => {
		const v1Launch = () => ({
			command: process.execPath,
			args: [FAKE_V1],
			cwd: scratch,
			env: { FAKE_ACP_MODE: "normal" },
		});

		it("is off unless asked for: an agent that answers 1 is an error", async () => {
			await expect(
				connectAcpNegotiatedV0(
					{ v2: { launch: launch("version=1"), attachment: "fake.v2", onEvent: () => {}, closeGraceMs: 300 } },
					{ cwd: scratch },
				),
			).rejects.toBeInstanceOf(AcpVersionNegotiationErrorV0);
		});

		it("relaunches the agent with the v1 client when asked, and v1 then works as before", async () => {
			const v2Events: EndoEventV0[] = [];
			const v1Events: EndoEventV0[] = [];
			const result = await connectAcpNegotiatedV0(
				{
					v2: {
						launch: { ...launch("version=1"), args: [FAKE_V1], env: { FAKE_ACP_MODE: "normal" } },
						attachment: "fake.v2",
						onEvent: (event) => v2Events.push(event),
						closeGraceMs: 300,
					},
					fallbackToV1: {
						launch: v1Launch(),
						attachment: "fake.v1",
						onEvent: (event) => v1Events.push(event),
						closeGraceMs: 300,
					},
				},
				{ cwd: scratch },
			);
			try {
				expect(result.version).toBe(1);
				expect(result.fallback).toEqual({ offered: 2, answered: 1 });
				expect(payload(find(v2Events, "harness.protocol-fault")[0])).toMatchObject({ answered: 1 });
				expect(payload(find(v1Events, "harness.acp-initialized")[0])).toMatchObject({ protocolVersion: 1 });
				if (result.version === 1) {
					const done = await result.client.prompt("hello");
					expect(done.stopReason).toBe("end_turn");
				}
			} finally {
				await result.client.close();
			}
		});

		it("never downgrades a request for history replay", async () => {
			await expect(
				connectAcpNegotiatedV0(
					{
						v2: {
							launch: { ...launch("version=1"), args: [FAKE_V1], env: { FAKE_ACP_MODE: "normal" } },
							attachment: "fake.v2",
							onEvent: () => {},
							closeGraceMs: 300,
						},
						fallbackToV1: { launch: v1Launch(), attachment: "fake.v1", onEvent: () => {}, closeGraceMs: 300 },
					},
					{ cwd: scratch, resume: { sessionId: "s", replay: "start" } },
				),
			).rejects.toThrow(/cannot replay history/);
		});

		it("does not fall back on anything but an answer of exactly 1", async () => {
			await expect(
				connectAcpNegotiatedV0(
					{
						v2: { launch: launch("version=3"), attachment: "fake.v2", onEvent: () => {}, closeGraceMs: 300 },
						fallbackToV1: { launch: v1Launch(), attachment: "fake.v1", onEvent: () => {}, closeGraceMs: 300 },
					},
					{ cwd: scratch },
				),
			).rejects.toMatchObject({ kind: "unsupported-version" });
		});
	});
});

describe("ACP v2 baseline session surface", () => {
	it("fails closed before session/new when no session surface is advertised", async () => {
		for (const caps of ["none", "null"]) {
			const { error, events } = await attachFailing(`caps=${caps}`);
			expect(error, caps).toBeInstanceOf(AcpUnavailableErrorV0);
			expect(payload(find(events, "harness.acp-initialized")[0]), caps).toMatchObject({ sessionSurface: "none" });
			expect(kinds(events), caps).toContain("control.unavailable");
			expect(
				notes().some((note) => note.received === "session/new"),
				caps,
			).toBe(false);
		}
	});

	it("treats `{}` as the coherent baseline and infers nothing optional or unstable", async () => {
		const { client, events } = await attach("caps=extras");
		const initialized = payload(find(events, "harness.acp-initialized")[0]);
		expect(initialized.ignoredOptionalSessionCapabilities).toEqual(["delete", "additionalDirectories", "fork"]);
		expect(initialized.ignoredUnstableCapabilities).toEqual(["providers", "nes", "positionEncoding"]);
		// The surface works as one contract: list, prompt and close are all callable without per-method markers.
		expect((await client.listSessions()).sessions).toHaveLength(1);
		const accepted = await client.prompt("hi");
		await accepted.completed;
		await client.closeSession();
		expect(notes().map((note) => note.received)).toEqual(
			expect.not.arrayContaining(["session/delete", "session/fork", "providers/list"]),
		);
	});
});

describe("ACP v2 prompt lifecycle: accepted is not completed", () => {
	it("resolves prompt() on acceptance while the run is still open, and completes only on idle", async () => {
		const { client, events } = await attach("hold");
		const accepted = await client.prompt("hi");
		expect(accepted.messageId).toBe("um-1");
		// The response is in; foreground work is not over, and nothing says it is.
		expect(await settledWithin(accepted.completed, 150)).toBe(false);
		expect(client.runOpen).toBe(true);
		expect(endsOf(events)).toEqual([]);
		const acceptedEvent = find(events, "agent.prompt-accepted")[0];
		expect(payload(acceptedEvent)).toMatchObject({ messageId: "um-1" });
		// No lifecycle event is derived from the acceptance.
		expect(events.filter((event) => event.derivedFrom.includes(acceptedEvent?.id as string))).toEqual([]);
		await client.cancel();
		const end = await accepted.completed;
		expect(end).toEqual({ stopReason: "cancelled", classification: "aborted" });
		expect(client.runOpen).toBe(false);
	});

	it("starts the run on the agent's running state and ends it on its idle, with the stop reason", async () => {
		const { client, events } = await attach();
		const { completed } = await client.prompt("hi");
		expect(await completed).toEqual({ stopReason: "end_turn", classification: "completed" });
		const order = kinds(events).filter((kind) => kind.startsWith("lifecycle.run") || kind === "agent.state-reported");
		expect(order).toEqual([
			"agent.state-reported",
			"lifecycle.run-started",
			"agent.state-reported",
			"lifecycle.run-completed",
		]);
		expect(payload(find(events, "lifecycle.run-started")[0])).toMatchObject({
			basis: "agent-state-update",
			attribution: "client-prompt-by-order",
		});
		expect(payload(find(events, "lifecycle.run-completed")[0])).toMatchObject({ stopRequested: false });
	});

	it("tolerates the acceptance arriving after the idle, and after the echoed user message", async () => {
		for (const flag of ["ack-late", "ack-after-echo"]) {
			const { client, events } = await attach(flag);
			const accepted = await client.prompt("hi");
			expect(await accepted.completed, flag).toEqual({ stopReason: "end_turn", classification: "completed" });
			expect(find(events, "agent.prompt-accepted"), flag).toHaveLength(1);
			expect(find(events, "harness.protocol-fault"), flag).toEqual([]);
			await client.close();
		}
	});

	it("never calls an end without a start, or an end without a reason, a completion", async () => {
		const idleOnly = await attach("idle-only");
		const first = await idleOnly.client.prompt("hi");
		expect(await first.completed).toEqual({ stopReason: "end_turn", classification: "unclassified" });
		expect(payload(find(idleOnly.events, "lifecycle.run-unclassified")[0])).toMatchObject({
			reason: "idle-without-running",
		});
		expect(kinds(idleOnly.events)).not.toContain("lifecycle.run-completed");

		const noStop = await attach("idle-no-stop");
		const second = await noStop.client.prompt("hi");
		expect(await second.completed).toEqual({ stopReason: null, classification: "unclassified" });
		expect(payload(find(noStop.events, "lifecycle.run-unclassified")[0])).toMatchObject({
			reason: "idle-without-stop-reason",
		});
	});

	it("ignores an idle that ended nothing, and does not let it complete the run", async () => {
		const { client, events } = await attach("idle-first");
		const { completed } = await client.prompt("hi");
		expect((await completed).classification).toBe("completed");
		// Two idles were reported; only the one after running ended the run.
		expect(find(events, "agent.state-reported").filter((event) => payload(event).state === "idle")).toHaveLength(2);
		expect(endsOf(events)).toHaveLength(1);
	});

	it("classifies stop reasons: only end_turn completes, a cancelled report aborts, everything else is unclassified", async () => {
		const expected: Record<string, [string, string]> = {
			end_turn: ["lifecycle.run-completed", "completed"],
			max_tokens: ["lifecycle.run-unclassified", "unclassified"],
			max_turn_requests: ["lifecycle.run-unclassified", "unclassified"],
			refusal: ["lifecycle.run-unclassified", "unclassified"],
			cancelled: ["lifecycle.run-aborted", "aborted"],
			// A custom stop reason, and the `error` the migration prose mentions but the baseline schema does not list.
			_vendor: ["lifecycle.run-unclassified", "unclassified"],
			error: ["lifecycle.run-unclassified", "unclassified"],
		};
		for (const [reason, [kind, classification]] of Object.entries(expected)) {
			const { client, events } = await attach(`stop=${reason}`);
			const { completed } = await client.prompt("hi");
			expect((await completed).classification, reason).toBe(classification);
			expect(
				endsOf(events).map((event) => event.kind),
				reason,
			).toEqual([kind]);
			await client.close();
		}
	});

	it("claims no run when the agent refuses the prompt, and a malformed acceptance is a protocol fault", async () => {
		const refused = await attach("refuse-prompt");
		await expect(refused.client.prompt("hi")).rejects.toBeInstanceOf(AcpRefusedErrorV0);
		expect(kinds(refused.events)).toContain("agent.prompt-refused");
		expect(endsOf(refused.events)).toEqual([]);
		expect(refused.client.runOpen).toBe(false);

		const malformed = await attach("malformed-accept");
		await expect(malformed.client.prompt("hi")).rejects.toBeInstanceOf(AcpProtocolErrorV0);
		expect(payload(find(malformed.events, "harness.protocol-fault").at(-1))).toMatchObject({
			fault: "prompt-response-malformed",
		});
		expect(malformed.client.runOpen).toBe(false);
	});

	it("bounds the wait for idle without inventing an end, and keeps the run open", async () => {
		const { client, events } = await attach("no-idle", { promptTimeoutMs: 150 });
		const accepted = await client.prompt("hi");
		await expect(accepted.completed).rejects.toBeInstanceOf(AcpTimeoutErrorV0);
		expect(kinds(events)).toContain("harness.prompt-timeout");
		expect(endsOf(events)).toEqual([]);
		expect(client.runOpen).toBe(true);
	});

	it("records an interruption, not an end, when the agent dies mid-run", async () => {
		const { client, events } = await attach("exit-mid-run");
		const accepted = await client.prompt("hi");
		await expect(accepted.completed).rejects.toBeInstanceOf(AcpProcessExitedErrorV0);
		expect(kinds(events)).toContain("lifecycle.interrupted");
		expect(endsOf(events)).toEqual([]);
	});

	it("records requires_action as reported without a lifecycle transition", async () => {
		const { client, events } = await attach("requires-action");
		const { completed } = await client.prompt("hi");
		await completed;
		const states = find(events, "agent.state-reported").map((event) => payload(event).state);
		expect(states).toEqual(["running", "requires_action", "idle"]);
		expect(find(events, "lifecycle.run-started")).toHaveLength(1);
	});

	it("allows one run at a time and a new prompt after idle, with the next message id", async () => {
		const { client } = await attach("hold");
		const first = await client.prompt("one");
		await expect(client.prompt("two")).rejects.toThrow(/already open/);
		await client.cancel();
		await first.completed;
		const idleAgain = await attach();
		const a = await idleAgain.client.prompt("one");
		await a.completed;
		const b = await idleAgain.client.prompt("two");
		expect(b.messageId).toBe("um-2");
		await b.completed;
	});

	it("cancel() sends session/cancel, and the agent's idle (not a response) ends the run", async () => {
		const { client, events } = await attach("hold");
		const accepted = await client.prompt("hi");
		expect(await client.cancel()).toBe(true);
		expect(await client.cancel()).toBe(false);
		expect(await accepted.completed).toEqual({ stopReason: "cancelled", classification: "aborted" });
		expect(notes().some((note) => note.cancelled === true)).toBe(true);
		expect(payload(find(events, "lifecycle.run-aborted")[0])).toMatchObject({ stopRequested: true });
		expect(kinds(events)).toContain("lifecycle.stop-requested");
	});

	it("leaves a run open when the agent ignores a cancel, rather than inventing an abort", async () => {
		const { client, events } = await attach("ignore-cancel", { promptTimeoutMs: 200 });
		const accepted = await client.prompt("hi");
		await client.cancel();
		await expect(accepted.completed).rejects.toBeInstanceOf(AcpTimeoutErrorV0);
		expect(endsOf(events)).toEqual([]);
	});
});

describe("ACP v2 hardening", () => {
	it("keeps concurrent session/list answers apart", async () => {
		const { client } = await attach();
		const pages = await Promise.all(["a", "b", "c"].map((cursor) => client.listSessions({ cursor })));
		expect(pages.map((page) => page.sessions[0]?.title)).toEqual(["a", "b", "c"]);
	});

	it("rejects an impossible calendar date in a listed session", async () => {
		const { client, events } = await attach("list-bad-date");
		await expect(client.listSessions()).rejects.toBeInstanceOf(AcpProtocolErrorV0);
		expect(payload(find(events, "harness.protocol-fault").at(-1))).toMatchObject({
			fault: "session-list-response-malformed",
		});
	});

	it("records no detach for a session that never attached", async () => {
		const { error, events } = await attachFailing("", {
			cwd: scratch,
			resume: { sessionId: "nope", replay: "start" },
		});
		expect(error).toBeInstanceOf(AcpRefusedErrorV0);
		expect(kinds(events)).not.toContain("harness.attached");
		expect(kinds(events)).not.toContain("lifecycle.detached");
	});

	it("counts custom plan statuses without prototype collisions, and reports terminal clears", async () => {
		const { client, events } = await attach("extras");
		await (await client.prompt("hi")).completed;
		const observed = find(events, "session.update-observed").map(payload);
		const plan = observed.find((entry) => entry.planId === "plan-2")?.byStatus as Record<string, unknown>;
		expect(Object.hasOwn(plan, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(plan, "__proto__")?.value).toBe(1);
		expect(plan.toString).toBe(2);
		expect(plan.pending).toBe(0);
		const terminal = observed.find((entry) => entry.update === "terminal_update");
		expect(terminal).toMatchObject({ exitCleared: true, outputCleared: true });
		expect(terminal?.exited).toBeUndefined();
		expect(terminal?.outputPresent).toBeUndefined();
	});

	it("releases the completion waiter when the session is closed, without deriving an end", async () => {
		const { client, events } = await attach("hold");
		const accepted = await client.prompt("hi");
		await client.closeSession();
		await expect(accepted.completed).rejects.toBeInstanceOf(AcpClosedErrorV0);
		expect(endsOf(events)).toEqual([]);
		expect(client.runOpen).toBe(false);
	});

	it("faults an accepted prompt whose required user-message echo never arrives", async () => {
		const missing = await attach("no-echo");
		await (await missing.client.prompt("hi")).completed;
		expect(find(missing.events, "harness.protocol-fault").map((event) => payload(event).fault)).toEqual([
			"prompt-echo-missing",
		]);
		// The outcome of the run is not rewritten by it.
		expect(endsOf(missing.events).map((event) => event.kind)).toEqual(["lifecycle.run-completed"]);
		const present = await attach();
		await (await present.client.prompt("hi")).completed;
		expect(find(present.events, "harness.protocol-fault")).toEqual([]);
	});

	it("fixes the run an update is about before the observer can re-enter", async () => {
		const events: EndoEventV0[] = [];
		let reentry: Promise<unknown> | undefined;
		const holder: { client?: AcpClientV2 } = {};
		const client = await AcpClientV2.connect(
			{
				launch: launch("spontaneous"),
				attachment: "fake.v2",
				closeGraceMs: 300,
				onEvent: (event) => {
					events.push(event);
					// An observer that reacts to the agent's unsolicited `running` by sending a prompt of its own.
					if (event.kind === "agent.state-reported" && payload(event).state === "running" && reentry === undefined)
						reentry = holder.client?.prompt("mine").catch((error: unknown) => error);
				},
			},
			{ cwd: scratch },
		);
		holder.client = client;
		live.push(client);
		await client.listSessions();
		for (let i = 0; i < 300 && reentry === undefined; i += 1) await sleep(10);
		// Foreground work was already open: the observer's prompt is refused, and the run is not attributed to it.
		expect(String(await reentry)).toMatch(/already open/);
		expect(payload(find(events, "lifecycle.run-started")[0])).toMatchObject({ attribution: "none" });
	});
});

describe("ACP v2 evidence through the existing session overview", () => {
	// The core consumer is unchanged and knows nothing of ACP: what v2 produces must reduce without anomalies, including
	// the shapes v1 never made (an end with no start, work the client never asked for, a stop against such work).
	const until = async (done: () => boolean) => {
		for (let i = 0; i < 300 && !done(); i += 1) await sleep(10);
	};
	const overviewOf = async (flags: string, drive: (client: AcpClientV2) => Promise<void>) => {
		const { client, events } = await attach(flags);
		await drive(client);
		await client.close();
		return reduceEndoSessionOverviewV0(events);
	};
	const counts = (overview: ReturnType<typeof reduceEndoSessionOverviewV0>) => overview.counts;

	it("reduces a completed run, a cancelled run and an interrupted run", async () => {
		const completed = await overviewOf("", async (client) => void (await (await client.prompt("x")).completed));
		expect(completed.anomalies).toEqual([]);
		expect(counts(completed)).toMatchObject({ runs: 1, completed: 1 });
		expect(completed.lastRun?.stopReason).toEqual({ status: "reported", value: "end_turn" });
		expect(completed.unavailable.map((entry) => entry.field)).toEqual(
			expect.arrayContaining(["run.id", "run.start", "run.attribution", "operation.outcome"]),
		);

		const cancelled = await overviewOf("hold", async (client) => {
			const accepted = await client.prompt("x");
			await client.cancel();
			await accepted.completed;
		});
		expect(cancelled.anomalies).toEqual([]);
		expect(counts(cancelled)).toMatchObject({ runs: 1, aborted: 1, stopsRequested: 1 });
		expect(cancelled.lastRun).toMatchObject({ outcome: "aborted", stopRequested: true });

		const interrupted = await overviewOf(
			"exit-mid-run",
			async (client) => void (await (await client.prompt("x")).completed.catch(() => {})),
		);
		expect(interrupted.anomalies).toEqual([]);
		expect(interrupted.state).toBe("interrupted");
		expect(counts(interrupted)).toMatchObject({ runs: 1, interrupted: 1, completed: 0 });
	});

	it("reduces an end with no start, and an end with no stop reason, as unclassified and never completed", async () => {
		const idleOnly = await overviewOf(
			"idle-only",
			async (client) => void (await (await client.prompt("x")).completed),
		);
		expect(idleOnly.anomalies).toEqual([]);
		expect(counts(idleOnly)).toMatchObject({ completed: 0, unclassified: 1 });
		const noStop = await overviewOf(
			"idle-no-stop",
			async (client) => void (await (await client.prompt("x")).completed),
		);
		expect(noStop.anomalies).toEqual([]);
		expect(counts(noStop)).toMatchObject({ runs: 1, completed: 0, unclassified: 1 });
	});

	it("reduces foreground work the client never asked for, and a stop requested against it", async () => {
		const spontaneous = await overviewOf("spontaneous", async (client) => {
			await client.listSessions();
			await until(() => client.updateCounts.state_update === 2);
		});
		expect(spontaneous.anomalies).toEqual([]);
		expect(counts(spontaneous)).toMatchObject({ runs: 1, completed: 1 });
		const held = await overviewOf("spontaneous-hold", async (client) => {
			await client.listSessions();
			await until(() => client.runOpen);
			expect(client.runOpen).toBe(true);
			await client.cancel();
			await until(() => !client.runOpen);
		});
		expect(held.anomalies).toEqual([]);
		expect(counts(held)).toMatchObject({ runs: 1, aborted: 1, stopsRequested: 1 });
	});
});

describe("ACP v2 updates and extensibility", () => {
	it("records unknown and unstable variants by name and digest, never as interpreted evidence", async () => {
		const { client, events } = await attach("extras");
		const { completed } = await client.prompt("hi");
		await completed;
		const unrecognized = find(events, "runtime.unrecognized-event").map(payload);
		const byName = Object.fromEntries(unrecognized.map((entry) => [String(entry.runtimeEvent), entry]));
		expect(
			byName.unprintable ??
				byName["_vendor/progress"] ??
				unrecognized.find((entry) => entry.schemaStatus === "unknown"),
		).toBeDefined();
		expect(byName.notice).toMatchObject({ schemaStatus: "unstable" });
		const stateEvents = unrecognized.filter((entry) => entry.runtimeEvent === "state_update");
		expect(stateEvents.map((entry) => entry.schemaStatus).sort()).toEqual(["unknown", "unstable"]);
		for (const entry of unrecognized) {
			expect(typeof entry.rawSha256).toBe("string");
			expect(typeof entry.rawBytes).toBe("number");
		}
		// A custom or unstable state does not move the run: the run still ended once, on the real idle.
		expect(endsOf(events)).toHaveLength(1);
		// A baseline variant that fails the baseline is malformed, recorded, and not counted.
		expect(find(events, "runtime.malformed-event").map(payload)).toContainEqual(
			expect.objectContaining({ variant: "agent_message", problem: "schema-invalid" }),
		);
		expect(client.updateCounts.agent_message ?? 0).toBe(0);
	});

	it("projects baseline variants without text, titles, plan text or commands", async () => {
		const { client, events } = await attach("extras,config,live-only");
		const { completed } = await client.prompt("SECRET-PROMPT-TEXT");
		await completed;
		const text = JSON.stringify(events);
		for (const secret of ["SECRET", "Hello", "think", "local command output"])
			expect(text, secret).not.toContain(secret);
		expect(find(events, "session.update-observed").map((event) => payload(event).update)).toEqual(
			expect.arrayContaining(["tool_call_update", "plan_update", "usage_update", "session_info_update"]),
		);
		expect(payload(find(events, "session.config-observed")[0])).toMatchObject({
			origin: "session/new",
			optionCount: 2,
			options: [
				{ configId: "model", type: "select", category: "model", current: "m1" },
				{ configId: "verbose", type: "boolean", current: false },
			],
		});
	});
});

describe("ACP v2 session/list and session/close", () => {
	it("lists as reported, keeps counts only in the record, and rejects a malformed page", async () => {
		const { client, events } = await attach();
		const page = await client.listSessions();
		expect(page.sessions[0]).toMatchObject({
			sessionId: "fake-v2-session-1",
			title: "t",
			updatedAt: "2026-01-01T00:00:00Z",
		});
		expect(payload(find(events, "session.listed")[0])).toEqual({ count: 1, hasNextCursor: false });
		const bad = await attach("list-malformed");
		await expect(bad.client.listSessions()).rejects.toBeInstanceOf(AcpProtocolErrorV0);
		expect(payload(find(bad.events, "harness.protocol-fault").at(-1))).toMatchObject({
			fault: "session-list-response-malformed",
		});
	});

	it("closes the session, after which nothing new starts; a refusal leaves it live", async () => {
		const closed = await attach();
		await closed.client.closeSession();
		expect(kinds(closed.events)).toContain("session.close-accepted");
		await expect(closed.client.prompt("hi")).rejects.toThrow(/closed/);
		const refused = await attach("close-refuse");
		await expect(refused.client.closeSession()).rejects.toBeInstanceOf(AcpRefusedErrorV0);
		const { completed } = await refused.client.prompt("still works");
		expect((await completed).classification).toBe("completed");
	});
});

describe("ACP v2 review round 2", () => {
	const settle = (completed: Promise<unknown>) =>
		completed.then(
			() => "completed",
			(error: unknown) => (error instanceof AcpClosedErrorV0 ? "closed" : "other"),
		);

	it("releases an open run's waiter when session/close times out or comes back malformed", async () => {
		for (const [flags, options] of [
			["hold,close-hang", { requestTimeoutMs: 300 }],
			["hold,close-malformed", {}],
		] as const) {
			const { client } = await attach(flags, options);
			const accepted = await client.prompt("hi");
			const outcome = settle(accepted.completed);
			await expect(client.closeSession(), flags).rejects.toBeDefined();
			expect(await Promise.race([outcome, sleep(2000).then(() => "still waiting")]), flags).toBe("closed");
		}
	});

	it("leaves a pending permission pending until the close is accepted", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client, events } = await attach("hold,perm=command,close-refuse", {
			permissionHandler: async () => {
				await gate;
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
		});
		await client.prompt("hi");
		for (let i = 0; i < 100 && find(events, "permission.requested").length === 0; i += 1) await sleep(10);
		await expect(client.closeSession()).rejects.toBeInstanceOf(AcpRefusedErrorV0);
		await sleep(50);
		// The refused close cancelled nothing: the agent has been told nothing yet.
		expect(notes().find((note) => "permissionAnswer" in note)).toBeUndefined();
		release();
		for (let i = 0; i < 100 && !notes().some((note) => "permissionAnswer" in note); i += 1) await sleep(10);
		expect(notes().find((note) => "permissionAnswer" in note)?.permissionAnswer).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});
	});

	it("answers a pending permission cancelled once the close is accepted", async () => {
		const { client, events } = await attach("hold,perm=command", {
			permissionHandler: () => new Promise<never>(() => {}),
		});
		const accepted = await client.prompt("hi");
		for (let i = 0; i < 100 && find(events, "permission.requested").length === 0; i += 1) await sleep(10);
		await client.closeSession();
		for (let i = 0; i < 100 && !notes().some((note) => "permissionAnswer" in note); i += 1) await sleep(10);
		expect(notes().find((note) => "permissionAnswer" in note)?.permissionAnswer).toEqual({
			outcome: { outcome: "cancelled" },
		});
		await expect(accepted.completed).rejects.toBeInstanceOf(AcpClosedErrorV0);
	});

	it("reports an idle that carries a stop reason, with nothing running, as an unclassified run", async () => {
		const { client, events } = await attach("spontaneous-idle");
		await client.listSessions();
		for (let i = 0; i < 100 && find(events, "agent.state-reported").length === 0; i += 1) await sleep(10);
		expect(payload(find(events, "lifecycle.run-unclassified")[0])).toMatchObject({
			reason: "idle-without-running",
			stopRequested: false,
		});
		expect(kinds(events)).not.toContain("lifecycle.run-completed");
	});

	it("accepts the empty session id the baseline allows, for new and for resume", async () => {
		const first = await attach("empty-session");
		expect(first.client.sessionId).toBe("");
		await first.client.close();
		const again = await attach("empty-session", {}, { cwd: scratch, resume: { sessionId: "" } });
		expect(again.client.sessionId).toBe("");
	});
});

describe("ACP v2 resume and replay", () => {
	/** Run one live session on a first agent, retain it in the store, and return what it reconstructed. */
	async function liveSession(flags = "") {
		const first = await attach(flags);
		const { completed } = await first.client.prompt("hello");
		await completed;
		const state = first.client.liveState();
		await first.client.close();
		return { state, sessionId: first.client.sessionId };
	}
	async function resumed(flags: string, sessionId: string, replay?: "start") {
		return attach(flags, {}, { cwd: scratch, resume: { sessionId, ...(replay === undefined ? {} : { replay }) } });
	}

	it("resumes without replayFrom: nothing is replayed, and it says so", async () => {
		const { sessionId } = await liveSession();
		const { client, events } = await resumed("", sessionId);
		expect(
			notes()
				.filter((note) => note.received === "session/resume")
				.at(-1),
		).toMatchObject({ replayFrom: null });
		expect(client.replayState()).toBeNull();
		expect(client.liveState().messages).toEqual([]);
		expect(payload(find(events, "harness.attached")[0])).toMatchObject({
			openedBy: "session/resume",
			historyReplay: "not-requested",
		});
	});

	it("treats history arriving without a request as a protocol fault and applies none of it", async () => {
		const { sessionId } = await liveSession();
		const { client, events } = await resumed("replay-unrequested", sessionId);
		const faults = find(events, "harness.protocol-fault").map(payload);
		expect(faults.some((fault) => fault.fault === "history-replayed-without-request")).toBe(true);
		expect(client.liveState().messages).toEqual([]);
		expect(client.replayState()).toBeNull();
	});

	it("replays from the start, completes the replay before the response, and the state is equivalent to the live session", async () => {
		const { state, sessionId } = await liveSession();
		const { client, events } = await resumed("", sessionId, "start");
		expect(
			notes()
				.filter((note) => note.received === "session/resume")
				.at(-1),
		).toMatchObject({ replayFrom: { type: "start" } });
		const replayed = client.replayState();
		expect(replayed).not.toBeNull();
		expect(payload(find(events, "harness.attached")[0])).toMatchObject({ historyReplay: "requested" });
		expect(Number(payload(find(events, "harness.attached")[0]).replayedUpdates)).toBeGreaterThan(0);
		expect(client.replayUpdateCounts.agent_message_chunk).toBe(2);
		// Everything recorded while the replay was in flight (before the attachment) says so; nothing live is tagged.
		const attachedAt = events.findIndex((event) => event.kind === "harness.attached");
		const replayedUpdates = events.slice(0, attachedAt).filter((event) => event.kind === "session.update-observed");
		expect(replayedUpdates.length).toBeGreaterThan(0);
		for (const event of replayedUpdates) expect(payload(event), event.id).toMatchObject({ phase: "replay" });
		for (const event of events.slice(attachedAt)) expect(payload(event).phase, event.id).toBeUndefined();
		// Replayed traffic is not live traffic.
		expect(client.updateCounts.agent_message_chunk).toBeUndefined();
		const comparison = compareAcpV2ReplayV0(state, replayed!);
		expect(comparison.reasons).toEqual([]);
		expect(comparison.equivalent).toBe(true);
		// What was replayed is digests and ids, never text.
		expect(JSON.stringify(events)).not.toMatch(/Hello|think hard|SECRET/);
	});

	it("accepts every equivalent way of retaining the same history", async () => {
		for (const retain of ["chunks", "whole", "empty-first", "dup", "clear-then-whole", "chunks-after-replace"]) {
			rmSync(store, { force: true });
			const { state, sessionId } = await liveSession();
			const { client } = await resumed(`retain=${retain}`, sessionId, "start");
			const comparison = compareAcpV2ReplayV0(state, client.replayState()!);
			expect(comparison.reasons, retain).toEqual([]);
			expect(comparison.equivalent, retain).toBe(true);
			await client.close();
		}
	});

	it("does not call the absence of live-only messages a violation, and reports them", async () => {
		const { state, sessionId } = await liveSession("live-only");
		expect(state.messages.map((message) => message.id)).toContain("lo-1");
		const { client } = await resumed("", sessionId, "start");
		const comparison = compareAcpV2ReplayV0(state, client.replayState()!);
		expect(comparison.equivalent).toBe(true);
		expect(comparison.liveOnly.messages).toContain("lo-1");
	});

	it("rejects replays that change content or kind, invent a message, or contradict themselves", async () => {
		for (const [retain, reason] of [
			["mutate", /changed content/],
			["kind-swap", /changed kind/],
			["invent", /never in the live session/],
			["contradict", /contradiction/],
		] as const) {
			rmSync(store, { force: true });
			const { state, sessionId } = await liveSession();
			const { client, events } = await resumed(`retain=${retain}`, sessionId, "start");
			const comparison = compareAcpV2ReplayV0(state, client.replayState()!);
			expect(comparison.equivalent, retain).toBe(false);
			expect(comparison.reasons.join("\n"), retain).toMatch(reason);
			if (retain === "contradict") expect(kinds(events)).toContain("session.state-conflict");
			await client.close();
		}
	});

	it("does not let replayed history drive foreground work", async () => {
		const { sessionId } = await liveSession();
		const { client, events } = await resumed("replay-state", sessionId, "start");
		expect(client.runOpen).toBe(false);
		expect(endsOf(events)).toEqual([]);
		expect(kinds(events)).not.toContain("lifecycle.run-started");
	});

	it("treats replay after the response as live: the replay boundary is the response", async () => {
		const { sessionId } = await liveSession();
		const { client } = await resumed("replay-late", sessionId, "start");
		// Poll with a deadline, not a fixed sleep: the late updates arrive on the agent's schedule.
		for (let i = 0; i < 300 && client.updateCounts.agent_message_chunk !== 2; i += 1) await sleep(10);
		expect(client.replayState()?.messages).toEqual([]);
		expect(client.updateCounts.agent_message_chunk).toBe(2);
	});

	it("refuses an unknown session and a malformed response", async () => {
		await liveSession();
		const unknown = await attachFailing("", { cwd: scratch, resume: { sessionId: "nope", replay: "start" } });
		expect(unknown.error).toBeInstanceOf(AcpRefusedErrorV0);
		expect(kinds(unknown.events)).toContain("control.refused");
		const { sessionId } = await liveSession();
		const bad = await attachFailing("resume-malformed", { cwd: scratch, resume: { sessionId } });
		expect(bad.error).toBeInstanceOf(AcpProtocolErrorV0);
	});
});

describe("ACP v2 permission requests", () => {
	const answerOf = () => notes().find((note) => "permissionAnswer" in note)?.permissionAnswer as Record<string, any>;
	const decided = (events: readonly EndoEventV0[]) => payload(find(events, "permission.decided")[0]);
	const requested = (events: readonly EndoEventV0[]) => payload(find(events, "permission.requested")[0]);
	const approving = () => {
		const seen: unknown[] = [];
		return {
			seen,
			handler: (request: unknown) => {
				seen.push(request);
				return { outcome: { outcome: "selected" as const, optionId: "allow" } };
			},
		};
	};

	it("denies by default, with the agent's own reject_once, whatever the subject", async () => {
		for (const subject of ["none", "tool_call", "command", "unknown", "future", "null"]) {
			rmSync(out, { force: true });
			const { client, events } = await attach(`perm=${subject},perm-description`);
			const { completed } = await client.prompt("hi");
			await completed;
			expect(answerOf(), subject).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
			expect(decided(events), subject).toMatchObject({
				decidedBy: "adapter-default",
				handlerConsulted: false,
				decision: "selected",
				optionKind: "reject_once",
			});
			// Never the copy: no title, description, command or tool title in any event.
			expect(JSON.stringify(events), subject).not.toMatch(/SECRET/);
			expect(requested(events).hasDescription, subject).toBe(true);
			await client.close();
		}
	});

	it("records the subject kind, and the tool call id for the subjects that carry one", async () => {
		const cases: Array<[string, string, string | null]> = [
			["none", "none", null],
			["null", "none", null],
			["tool_call", "tool_call", "tc-1"],
			["command", "command", "tc-1"],
			["unknown", "unrecognized", null],
			["future", "unrecognized", null],
			["malformed-command", "malformed", null],
			["malformed-tool", "malformed", null],
		];
		for (const [flag, kind, toolCallId] of cases) {
			const { client, events } = await attach(`perm=${flag}`);
			const { completed } = await client.prompt("hi");
			await completed;
			expect(requested(events), flag).toMatchObject({ subjectKind: kind, toolCallId });
			await client.close();
		}
	});

	it("lets an explicit handler decide for the subjects it can interpret, and only among offered options", async () => {
		for (const subject of ["none", "tool_call", "command"]) {
			rmSync(out, { force: true });
			const { seen, handler } = approving();
			const { client, events } = await attach(`perm=${subject}`, { permissionHandler: handler });
			const { completed } = await client.prompt("hi");
			await completed;
			expect(seen, subject).toHaveLength(1);
			expect((seen[0] as { title: string }).title, subject).toMatch(/SECRET-TITLE/);
			expect(answerOf(), subject).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
			expect(decided(events), subject).toMatchObject({
				decidedBy: "handler",
				handlerConsulted: true,
				optionKind: "allow_once",
				subjectKind: subject,
			});
			await client.close();
		}
	});

	it("never shows an unrecognized or malformed subject to the handler, and never approves it", async () => {
		for (const subject of ["unknown", "future", "malformed-command", "malformed-tool"]) {
			rmSync(out, { force: true });
			const { seen, handler } = approving();
			const { client, events } = await attach(`perm=${subject}`, { permissionHandler: handler });
			const { completed } = await client.prompt("hi");
			await completed;
			expect(seen, subject).toEqual([]);
			expect(JSON.stringify(answerOf()), subject).not.toContain("allow");
			if (subject.startsWith("malformed")) {
				// Refused with invalid-params: the agent received no approval and no outcome at all.
				expect(answerOf().error.code, subject).toBe(-32602);
				expect(decided(events), subject).toMatchObject({
					decision: "error",
					subjectKind: "malformed",
					handlerConsulted: false,
				});
			} else {
				expect(answerOf(), subject).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
				expect(decided(events), subject).toMatchObject({
					handlerConsulted: false,
					decision: "selected",
					optionKind: "reject_once",
				});
			}
			await client.close();
		}
	});

	it("refuses with an error, not a false cancellation, when no reject option was offered", async () => {
		for (const subject of ["none", "command", "unknown"]) {
			rmSync(out, { force: true });
			const { client, events } = await attach(`perm=${subject},perm-no-reject`);
			const { completed } = await client.prompt("hi");
			await completed;
			// The work was not cancelled, so `cancelled` ("active session work was cancelled") would be untrue.
			expect(answerOf().error.code, subject).toBe(-32600);
			expect(answerOf().outcome, subject).toBeUndefined();
			expect(decided(events), subject).toMatchObject({ decision: "error", optionKind: null });
			await client.close();
		}
		// A custom option kind is not a reject: it is never selected by default.
		rmSync(out, { force: true });
		const custom = await attach("perm=none,perm-custom-kind-only");
		await (await custom.client.prompt("hi")).completed;
		expect(answerOf().error.code).toBe(-32600);
	});

	it("never selects an option that was not offered, and treats a throwing handler as no decision", async () => {
		const wrong = await attach("perm=none", {
			permissionHandler: () => ({ outcome: { outcome: "selected", optionId: "allow-everything" } }),
		});
		await (await wrong.client.prompt("hi")).completed;
		expect(answerOf().error.code).toBe(-32600);
		expect(decided(wrong.events)).toMatchObject({
			decidedBy: "adapter-default",
			handlerConsulted: true,
			decision: "error",
		});
		rmSync(out, { force: true });
		const throwing = await attach("perm=none", {
			permissionHandler: () => {
				throw new Error("boom");
			},
		});
		await (await throwing.client.prompt("hi")).completed;
		expect(answerOf().error.code).toBe(-32600);
		// The handler's own explicit cancellation is its decision, and is attributed to it.
		rmSync(out, { force: true });
		const declining = await attach("perm=none", { permissionHandler: () => ({ outcome: { outcome: "cancelled" } }) });
		await (await declining.client.prompt("hi")).completed;
		expect(answerOf()).toEqual({ outcome: { outcome: "cancelled" } });
		expect(decided(declining.events)).toMatchObject({ decidedBy: "handler", decision: "cancelled" });
	});

	it("does not consult a handler when the options are ambiguous", async () => {
		const { seen, handler } = approving();
		const { client } = await attach("perm=none,perm-dup-ids", { permissionHandler: handler });
		await (await client.prompt("hi")).completed;
		expect(seen).toEqual([]);
		expect(answerOf().error.code).toBe(-32600);
	});

	it("answers a pending request cancelled when the work is cancelled, even if the handler later approves", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { client, events } = await attach("perm=command", {
			permissionHandler: async () => {
				await gate;
				return { outcome: { outcome: "selected", optionId: "allow" } };
			},
		});
		const accepted = await client.prompt("hi");
		// Wait until the request is pending.
		for (let i = 0; i < 100 && find(events, "permission.requested").length === 0; i += 1) await sleep(10);
		expect(find(events, "permission.requested")).toHaveLength(1);
		await client.cancel();
		expect(await accepted.completed).toEqual({ stopReason: "cancelled", classification: "aborted" });
		release();
		await sleep(50);
		expect(answerOf()).toEqual({ outcome: { outcome: "cancelled" } });
		expect(decided(events)).toMatchObject({ decision: "cancelled", decidedBy: "adapter-default" });
	});

	it("does not execute a command subject, even when the handler approves it", async () => {
		const sentinel = join(scratch, "SENTINEL");
		const { handler } = approving();
		const { client } = await attach(
			"perm=command",
			{ permissionHandler: handler },
			{ cwd: scratch },
			{ FAKE_V2_COMMAND: `touch ${sentinel}` },
		);
		await (await client.prompt("hi")).completed;
		expect(answerOf()).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
		expect(existsSync(sentinel)).toBe(false);
	});
});

describe("ACP v2 process ownership", () => {
	it("ends the agent on close, idempotently", async () => {
		const { client } = await attach();
		const first = client.close();
		expect(client.close()).toBe(first);
		await first;
		expect(client.liveProcessMembers()).toBeFalsy();
	});

	it("does not leak the parent's environment to the agent", async () => {
		process.env.ENDO_ACP_V2_LEAK_PROBE = "leaked";
		try {
			await attach();
			// launch.env is the whole of the agent's environment: the probe set here never reaches it.
			expect(notes().find((note) => "leakProbe" in note)).toEqual({ leakProbe: null });
		} finally {
			delete process.env.ENDO_ACP_V2_LEAK_PROBE;
		}
	});
});
