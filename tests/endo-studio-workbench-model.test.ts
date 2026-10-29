// The workbench reducer, as a pure function: the incremental transcript (a tool call folds into one row by its call id), the cursor that
// is what was RECEIVED (a failed page is read again, nothing is skipped), a new launch forgetting everything, an unpaired page
// dropping its grant, and an absent workbench.
import { describe, expect, it } from "vitest";
import { initialWorkbench, MAX_ITEMS, reduceWorkbench, type WorkbenchState } from "../studio-ui/src/model/workbench.ts";
import type { TranscriptItem, WorkbenchStatus, WorkbenchTranscript } from "../studio-ui/src/model/workbench-wire.ts";

const LAUNCH = "0123456789abcdef";
const status = (over: Partial<WorkbenchStatus> = {}): WorkbenchStatus => ({
	schemaVersion: "endo.workbench-status.v0",
	launchId: LAUNCH,
	harness: "pi",
	connection: "connected",
	run: "idle",
	session: "endo.session.pi.x",
	attachment: "pi.default",
	offers: { prompt: { offered: true, reason: null } },
	paired: true,
	command: null,
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
