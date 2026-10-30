// The workbench reducer, as a pure function: the incremental transcript (a tool call folds into one row by its call id), the cursor that
// is what was RECEIVED (a failed page is read again, nothing is skipped), a new launch forgetting everything, an unpaired page
// dropping its grant, and an absent workbench.
import { describe, expect, it } from "vitest";
import {
	anyOpen,
	initialWorkbench,
	interventionWords,
	MAX_ITEMS,
	reduceWorkbench,
	stopInFlight,
	type WorkbenchState,
} from "../studio-ui/src/model/workbench.ts";
import type {
	TranscriptItem,
	WorkbenchIntervention,
	WorkbenchStatus,
	WorkbenchTranscript,
} from "../studio-ui/src/model/workbench-wire.ts";
import { readWorkbenchStatus } from "../studio-ui/src/model/workbench-wire.ts";

const LAUNCH = "0123456789abcdef";
const status = (over: Partial<WorkbenchStatus> = {}): WorkbenchStatus => ({
	schemaVersion: "endo.workbench-status.v0",
	launchId: LAUNCH,
	harness: "pi",
	connection: "connected",
	run: "idle",
	session: "endo.session.pi.x",
	attachment: "pi.default",
	offers: {
		prompt: { offered: true, reason: null },
		steer: { offered: false, reason: "No run is open." },
		queue: { offered: false, reason: "No run is open." },
		stop: { offered: false, reason: "No run is open." },
	},
	paired: true,
	command: null,
	interventions: [],
	transcript: { watermark: 0, firstSeq: 1 },
	...over,
});
const page = (items: TranscriptItem[], watermark: number, more = false): WorkbenchTranscript => ({
	schemaVersion: "endo.workbench-transcript.v0",
	launchId: LAUNCH,
	items,
	watermark,
	firstSeq: 1,
	evicted: 0,
	more,
});
const at = new Date(0);
const msg = (seq: number, text = `m${seq}`): TranscriptItem => ({
	seq,
	kind: "message",
	role: "user",
	text,
	truncated: false,
	stopReason: null,
});
const tool = (seq: number, callId: string, s: "running" | "ok" | "error"): TranscriptItem => ({
	seq,
	kind: "tool",
	callId,
	name: "read",
	status: s,
});
const run = (n: number, from: number): TranscriptItem[] => Array.from({ length: n }, (_, i) => msg(from + i));

const withStatus = (): WorkbenchState => ({
	...reduceWorkbench(initialWorkbench(), { type: "reply", reply: { kind: "status", record: status() }, at }),
	grant: "g".repeat(43),
});
const give = (s: WorkbenchState, t: WorkbenchTranscript) =>
	reduceWorkbench(s, { type: "reply", reply: { kind: "transcript", record: t }, at });

describe("the transcript is incremental", () => {
	it("updates a running tool call in place when its outcome arrives as a new item, by the same cursor", () => {
		let s = give(withStatus(), page([msg(1), tool(2, "c1", "running")], 2));
		expect(s.items.map((i) => i.kind === "tool" && i.status)).toEqual([false, "running"]);
		s = give(s, page([tool(3, "c1", "error")], 3));
		expect(s.items).toHaveLength(2);
		expect(s.items[1]).toMatchObject({ kind: "tool", callId: "c1", status: "error" });
		expect(s.watermark).toBe(3);
		s = give(s, page([tool(4, "orphan", "ok")], 4));
		expect(s.items).toHaveLength(3);
		expect(give(s, page([msg(1)], 4)).items).toHaveLength(3);
	});

	it("keeps the cursor at what was received while pages remain, so a failed later page is read again", () => {
		let s = give(withStatus(), page(run(200, 1), 300, true));
		expect(s.watermark).toBe(200); // 300 exist, 200 arrived: the cursor is 200, not 300
		s = give(s, page(run(100, 201), 300, false));
		expect(s.watermark).toBe(300);
		expect(s.items.map((i) => i.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
	});

	it("holds at most the display bound, newest kept", () => {
		let s = give(withStatus(), page(run(200, 1), 600, true));
		s = give(s, page(run(200, 201), 600, true));
		s = give(s, page(run(200, 401), 600, false));
		expect(s.items).toHaveLength(MAX_ITEMS);
		expect(s.items.at(-1)!.seq).toBe(600);
	});
});

describe("launch, pairing and availability", () => {
	it("forgets the grant, the text and the prompt when a different launch answers", () => {
		let s = give(withStatus(), page([msg(1, "private")], 1));
		expect(s.items).toHaveLength(1);
		s = reduceWorkbench(s, {
			type: "reply",
			reply: { kind: "status", record: status({ launchId: "fedcba9876543210" }) },
			at,
		});
		expect(s).toMatchObject({ launchId: "fedcba9876543210", grant: null, items: [], watermark: 0, command: null });
	});

	it("forgets the private text when the broker reports the session disconnected, but not when it merely cannot be reached", () => {
		const s = give(withStatus(), page([msg(1, "private")], 1));
		const down = reduceWorkbench(s, {
			type: "reply",
			reply: { kind: "failure", status: 0, code: "", message: "x", retrySeconds: null },
			at,
		});
		expect(down.items).toHaveLength(1); // unreachable is not ended: nothing is concluded, nothing cleared
		const gone = reduceWorkbench(s, {
			type: "reply",
			reply: { kind: "status", record: status({ connection: "disconnected", run: "unknown", paired: false }) },
			at,
		});
		expect(gone).toMatchObject({ items: [], watermark: 0, grant: null });
	});

	it("drops a grant the broker says is no longer the paired one, and ignores a transcript of another launch", () => {
		const s = withStatus();
		expect(s.grant).not.toBeNull();
		expect(
			reduceWorkbench(s, { type: "reply", reply: { kind: "status", record: status({ paired: false }) }, at }).grant,
		).toBeNull();
		expect(give(s, { ...page([msg(1)], 1), launchId: "ffffffffffffffff" }).items).toEqual([]);
	});

	it("takes a 401 on a grant-gated route as unpaired, a network failure as unreachable (not ended), and an absent server as absent", () => {
		const s = withStatus();
		const failure = (code: number, name: string) =>
			reduceWorkbench(s, {
				type: "reply",
				reply: { kind: "failure", status: code, code: name, message: "x", retrySeconds: null },
				at,
			});
		expect(failure(401, "grant-required").grant).toBeNull();
		const down = failure(0, "");
		expect(down.unreachable).toBe(true);
		expect(down.grant).not.toBeNull();
		expect(
			reduceWorkbench(down, { type: "reply", reply: { kind: "status", record: status() }, at }).unreachable,
		).toBe(false);
		expect(reduceWorkbench(s, { type: "reply", reply: { kind: "absent" }, at })).toMatchObject({
			availability: "absent",
			view: "recorded",
			grant: null,
		});
	});
});

const intervention = (over: Partial<WorkbenchIntervention> = {}): WorkbenchIntervention => ({
	proposalId: `endo.evidence.intervention.proposal.${"a".repeat(64)}`,
	operation: "stop",
	state: "awaiting-approval",
	approved: false,
	reason: null,
	disposition: null,
	bytes: null,
	digestPrefix: "0123456789abcdef",
	expiresAtMs: 1,
	afterSeq: 0,
	runEnded: null,
	consumption: null,
	...over,
});

describe("interventions", () => {
	it("takes the broker's list from each status and merges a reply to a request by id, without duplicating it", () => {
		const first = intervention();
		let s = reduceWorkbench(withStatus(), { type: "reply", reply: { kind: "intervention", record: first }, at });
		expect(s.interventions).toEqual([first]);
		expect(anyOpen(s)).toBe(true);
		expect(stopInFlight(s)).toEqual(first);
		const sent = intervention({ state: "sent", approved: true });
		s = reduceWorkbench(s, { type: "reply", reply: { kind: "intervention", record: sent }, at });
		expect(s.interventions).toEqual([sent]);
		// A status is the broker's whole list: it replaces what the page held.
		s = reduceWorkbench(s, {
			type: "reply",
			reply: {
				kind: "status",
				record: status({ interventions: [intervention({ state: "accepted", approved: true })] }),
			},
			at,
		});
		expect(s.interventions.map((i) => i.state)).toEqual(["accepted"]);
		expect(anyOpen(s)).toBe(false);
		expect(stopInFlight(s)).toBeNull();
	});

	it("forgets interventions with a different launch, as it forgets the grant and the text", () => {
		let s = reduceWorkbench(withStatus(), {
			type: "reply",
			reply: { kind: "intervention", record: intervention() },
			at,
		});
		s = reduceWorkbench(s, {
			type: "reply",
			reply: { kind: "status", record: status({ launchId: "fedcba9876543210" }) },
			at,
		});
		expect(s.interventions).toEqual([]);
		expect(s.grant).toBeNull();
	});

	it("words each state for what is known: a reply is not use, a stop is not an immediate stop, a lost reply is unknown", () => {
		const say = (over: Partial<WorkbenchIntervention>) => interventionWords(intervention(over));
		expect(say({ state: "awaiting-approval" })).toContain("Waiting for you to approve it in the attached terminal");
		expect(say({ state: "sent" })).toContain("Pi answers a stop once the run is idle");
		expect(say({ operation: "steer", state: "accepted" })).toContain("not proof the message was used");
		expect(say({ state: "accepted" })).toBe("Pi acknowledged the stop request");
		expect(say({ state: "unknown" })).toContain("Outcome unknown");
		expect(say({ state: "unknown" })).not.toMatch(/not sent|refused/i);
		expect(say({ state: "refused", reason: "runtime-refused" })).toBe("Pi refused it");
		expect(say({ state: "refused", reason: "authorization-denied" })).toBe("Not sent");
		for (const word of ["stopped", "completed", "done", "delivered", "consumed"])
			for (const state of ["awaiting-approval", "dispatching", "sent", "accepted", "refused", "unknown"] as const)
				expect(say({ state }).toLowerCase(), `${state}:${word}`).not.toContain(word);
	});
});

describe("an evidence check, and a request a STOP cancelled", () => {
	const progress = { requests: 64, bytes: 64_000 };
	const accepted = (consumption: WorkbenchIntervention["consumption"]) =>
		intervention({ operation: "steer", state: "accepted", approved: true, bytes: 5, consumption });

	it("keeps the page reading while a check runs, and stops when it ends, whatever it found", () => {
		const running = reduceWorkbench(withStatus(), {
			type: "reply",
			reply: {
				kind: "status",
				record: status({ interventions: [accepted({ status: "checking", scanned: progress, total: 500 })] }),
			},
			at,
		});
		expect(anyOpen(running)).toBe(true);
		for (const done of [
			{ status: "incomplete", reason: "work limit", scanned: progress, total: 500, retryAtMs: 1 },
			{ status: "not-observed", reason: "no captured request carries the message" },
			{ status: "observed", exchange: 3, captureEvent: "endo.event.c3" },
		] as const) {
			const ended = reduceWorkbench(running, {
				type: "reply",
				reply: { kind: "status", record: status({ interventions: [accepted(done)] }) },
				at,
			});
			expect(anyOpen(ended)).toBe(false);
		}
	});

	it("accepts the new consumption shapes and the new reason, and refuses a malformed one whole", () => {
		const wire = (consumption: unknown, reason: unknown = null, state = "accepted") => ({
			...status({}),
			interventions: [{ ...accepted(null), state, reason, consumption }],
		});
		expect(readWorkbenchStatus(wire({ status: "checking", scanned: progress, total: 0 }))).not.toBeNull();
		expect(
			readWorkbenchStatus(
				wire({ status: "incomplete", reason: "limit", scanned: progress, total: 9, retryAtMs: 5 }),
			),
		).not.toBeNull();
		expect(readWorkbenchStatus(wire(null, "superseded-by-stop", "refused"))).not.toBeNull();
		for (const bad of [
			{ status: "incomplete", reason: "limit", scanned: progress, total: 9 }, // no retry time
			{ status: "incomplete", reason: "limit", scanned: { requests: -1, bytes: 0 }, total: 9, retryAtMs: 5 },
			{ status: "checking", scanned: progress },
			{ status: "checking", scanned: progress, total: 1, extra: true },
			{ status: "unknown" },
		])
			expect(readWorkbenchStatus(wire(bad)), JSON.stringify(bad)).toBeNull();
		expect(readWorkbenchStatus(wire(null, "invented-reason", "refused"))).toBeNull();
	});
});
