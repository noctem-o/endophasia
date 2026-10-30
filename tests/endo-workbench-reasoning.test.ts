// Model-provided reasoning in the live transcript (adapters/pi/live-transcript.ts): what is taken (Pi's structured `thinking` blocks and
// `thinking_*` stream events, nothing else), how it is ordered and bounded, how the message being written is followed and replaced by
// the completed one, and that it is cleared with the session. A controllable stand-in for the session: no Pi, no model, no network.
import { describe, expect, it } from "vitest";
import {
	LIVE_TRANSCRIPT_MAX_BYTES_V0,
	LIVE_TRANSCRIPT_MAX_PARTS_V1,
	LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1,
	LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1,
	LIVE_TRANSCRIPT_PAGE_BYTES_V1,
	type LiveTranscriptItemV0,
	LiveTranscriptV0,
} from "../adapters/pi/live-transcript.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { RpcEventV0 } from "../adapters/rpc-jsonl/rpc-connection.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeSession, textMessage } from "./workbench-fixtures.ts";

const THOUGHT = "REASONING-SENTINEL-7f3a";

const assistant = (content: unknown, stopReason = "stop"): RpcEventV0 => ({
	type: "message_end",
	record: { message: { role: "assistant", stopReason, content } },
});
const start = (): RpcEventV0 => ({ type: "message_start", record: { message: { role: "assistant", content: [] } } });
const update = (assistantMessageEvent: Record<string, unknown>): RpcEventV0 => ({
	type: "message_update",
	record: { assistantMessageEvent },
});
const message = (t: LiveTranscriptV0, at = -1) => {
	const item = t.view().items.at(at)!;
	if (item.kind !== "message") throw new Error(`not a message: ${item.kind}`);
	return item;
};
const shape = (item: LiveTranscriptItemV0) =>
	item.kind === "message"
		? item.parts.map((p) => (p.kind === "text" ? `text:${p.text}` : `${p.state}:${p.text}`))
		: [];

describe("model-provided reasoning in the live transcript", () => {
	it("is absent when the runtime supplies none, and the source still says it relays it", () => {
		const t = new LiveTranscriptV0();
		t.push(assistant([{ type: "text", text: "plain answer" }]));
		expect(shape(message(t))).toEqual(["text:plain answer"]);
		expect(t.view().reasoning).toEqual({ relay: "relayed", reason: null });
		expect(t.view().open).toBeNull();
	});

	it("keeps one completed thinking block, in its place before the answer", () => {
		const t = new LiveTranscriptV0();
		t.push(
			assistant([
				{ type: "thinking", thinking: `${THOUGHT} first, check the parser.`, thinkingSignature: "opaque-sig" },
				{ type: "text", text: "The parser is fine." },
			]),
		);
		const m = message(t);
		expect(shape(m)).toEqual([`supplied:${THOUGHT} first, check the parser.`, "text:The parser is fine."]);
		// The signature is opaque provider state: never read, never relayed.
		expect(JSON.stringify(t.view())).not.toContain("opaque-sig");
	});

	it("keeps several blocks and mixed text in the runtime's order, joins adjacent text, and leaves tool calls and images out", () => {
		const t = new LiveTranscriptV0();
		t.push(
			assistant(
				[
					{ type: "thinking", thinking: "one" },
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/secret" } },
					{ type: "thinking", thinking: "two" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "c" },
				],
				"toolUse",
			),
		);
		const m = message(t);
		expect(shape(m)).toEqual(["supplied:one", "text:ab", "supplied:two", "text:c"]);
		expect(m.stopReason).toBe("toolUse");
		expect(JSON.stringify(t.view())).not.toMatch(/\/secret|AAAA/);
	});

	it("keeps interleaved tool activity as its own items, between the messages it came between", () => {
		const t = new LiveTranscriptV0();
		t.push({ type: "agent_start", record: {} });
		t.push(
			assistant(
				[
					{ type: "thinking", thinking: "plan" },
					{ type: "toolCall", id: "c1", name: "bash" },
				],
				"toolUse",
			),
		);
		t.push({ type: "tool_execution_start", record: { toolCallId: "c1", toolName: "bash" } });
		t.push({ type: "tool_execution_end", record: { toolCallId: "c1", toolName: "bash", isError: false } });
		t.push(
			assistant([
				{ type: "thinking", thinking: "verify" },
				{ type: "text", text: "done" },
			]),
		);
		expect(t.view().items.map((i) => (i.kind === "message" ? shape(i).join("|") : i.kind))).toEqual([
			"run",
			"supplied:plan",
			"tool",
			"tool",
			"supplied:verify|text:done",
		]);
	});

	it("keeps a redacted block as withheld with no text, and an empty block as empty", () => {
		const t = new LiveTranscriptV0();
		t.push(
			assistant([
				{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "ENCRYPTED-PAYLOAD" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking" },
				{ type: "text", text: "ok" },
			]),
		);
		expect(message(t).parts).toEqual([
			{ kind: "reasoning", state: "withheld", text: "", truncated: false, bytes: 0 },
			{ kind: "reasoning", state: "empty", text: "", truncated: false, bytes: 0 },
			{ kind: "reasoning", state: "empty", text: "", truncated: false, bytes: 0 },
			{ kind: "text", text: "ok", truncated: false },
		]);
		expect(JSON.stringify(t.view())).not.toContain("ENCRYPTED-PAYLOAD");
	});

	it("never takes reasoning from ordinary text: a <think> tag in a text block stays text", () => {
		const t = new LiveTranscriptV0();
		t.push(assistant([{ type: "text", text: "<think>not authenticated</think>answer" }]));
		expect(shape(message(t))).toEqual(["text:<think>not authenticated</think>answer"]);
	});

	it("cuts a long block at a UTF-8 boundary, keeps its original size, and bounds a message's reasoning in all", () => {
		const t = new LiveTranscriptV0();
		const long = "漢".repeat(LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1); // three bytes a character
		t.push(
			assistant([
				{ type: "thinking", thinking: long },
				{ type: "thinking", thinking: long },
			]),
		);
		const m = message(t);
		expect(m.truncated).toBe(true);
		const [a, b] = m.parts;
		if (a?.kind !== "reasoning" || b?.kind !== "reasoning") throw new Error("two reasoning parts expected");
		expect(a.truncated).toBe(true);
		expect(a.bytes).toBe(Buffer.byteLength(long));
		expect(Buffer.byteLength(a.text)).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1);
		expect(a.text.includes("�")).toBe(false);
		expect(Buffer.byteLength(a.text) + Buffer.byteLength(b.text)).toBeLessThanOrEqual(
			LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1,
		);
		expect(b.truncated).toBe(true);
	});

	it("keeps at most MAX_PARTS parts and counts the rest", () => {
		const t = new LiveTranscriptV0();
		const blocks = Array.from({ length: LIVE_TRANSCRIPT_MAX_PARTS_V1 + 9 }, (_, i) =>
			i % 2 === 0 ? { type: "thinking", thinking: `r${i}` } : { type: "text", text: `t${i}` },
		);
		t.push(assistant(blocks));
		const m = message(t);
		expect(m.parts.length).toBe(LIVE_TRANSCRIPT_MAX_PARTS_V1);
		expect(m.partsDropped).toBe(9);
		expect(m.truncated).toBe(true);
	});

	it("bounds the whole transcript, text and reasoning together, by evicting the oldest items whole, and counts exactly", () => {
		const t = new LiveTranscriptV0();
		let seed = 7;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		for (let i = 0; i < 400; i++) {
			const r = random();
			if (r < 0.4) t.push(assistant([{ type: "thinking", thinking: "é".repeat(Math.floor(random() * 40_000)) }]));
			else if (r < 0.7) t.push(textMessage("user", "x".repeat(Math.floor(random() * 20_000))));
			else if (r < 0.85) t.push({ type: "tool_execution_start", record: { toolCallId: `c${i}`, toolName: "bash" } });
			else
				t.push(
					assistant([
						{ type: "thinking", thinking: "y".repeat(Math.floor(random() * 90_000)) },
						{ type: "text", text: "z".repeat(Math.floor(random() * 40_000)) },
					]),
				);
			expect(t.size.bytes).toBe(t.recount());
			expect(t.size.bytes).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_BYTES_V0);
		}
		expect(t.view().evicted).toBeGreaterThan(0);
		// Eviction removes items whole: what is held is a contiguous run of sequence numbers.
		const all: number[] = [];
		let after = 0;
		for (;;) {
			const page = t.view(after);
			all.push(...page.items.map((i) => i.seq));
			if (!page.more) break;
			after = page.items.at(-1)!.seq;
		}
		expect(all[0]).toBe(t.view().firstSeq);
		expect(all.every((seq, i) => i === 0 || seq === all[i - 1]! + 1)).toBe(true);
	});

	it("bounds one page by bytes as well as by items, and always makes progress", () => {
		const t = new LiveTranscriptV0();
		for (let i = 0; i < 30; i++) t.push(assistant([{ type: "thinking", thinking: "q".repeat(60_000) }]));
		const page = t.view(0);
		const size = page.items.reduce(
			(sum, item) => sum + (item.kind === "message" ? item.parts.reduce((s, p) => s + p.text.length, 0) : 0),
			0,
		);
		expect(size).toBeLessThanOrEqual(LIVE_TRANSCRIPT_PAGE_BYTES_V1);
		expect(page.more).toBe(true);
		expect(page.items.length).toBeGreaterThan(0);
	});
});

describe("the message being written", () => {
	it("follows streamed reasoning and text by content index, as one snapshot outside the item log", () => {
		const t = new LiveTranscriptV0();
		t.push(textMessage("user", "go"));
		t.push(start());
		t.push(update({ type: "thinking_start", contentIndex: 0 }));
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "Look at " }));
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "the tests." }));
		const view = t.view();
		expect(view.watermark).toBe(1);
		expect(view.open).toEqual({
			id: 1,
			afterSeq: 1,
			parts: [{ kind: "reasoning", state: "supplied", text: "Look at the tests.", truncated: false, bytes: 18 }],
		});
		t.push(update({ type: "thinking_end", contentIndex: 0, content: "Look at the tests first." }));
		t.push(update({ type: "text_start", contentIndex: 1 }));
		t.push(update({ type: "text_delta", contentIndex: 1, delta: "Run" }));
		expect(t.view().open?.parts.map((p) => p.text)).toEqual(["Look at the tests first.", "Run"]);
		// Tool-call blocks and unknown events are not followed.
		t.push(update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "bash" }));
		t.push(update({ type: "toolcall_delta", contentIndex: 2, delta: '{"command":"rm' }));
		expect(t.view().open?.parts.length).toBe(2);
	});

	it("is replaced by the completed message, which is authoritative and names the snapshot it completes", () => {
		const t = new LiveTranscriptV0();
		t.push(start());
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "partial guess" }));
		t.push(
			assistant([
				{ type: "thinking", thinking: "final reasoning" },
				{ type: "text", text: "answer" },
			]),
		);
		const view = t.view();
		expect(view.open).toBeNull();
		expect(view.items).toHaveLength(1);
		const m = message(t);
		expect(m.from).toBe(1);
		expect(shape(m)).toEqual(["supplied:final reasoning", "text:answer"]);
		expect(JSON.stringify(view)).not.toContain("partial guess");
	});

	it("survives an aborted stream only as what the completed message carries, marked aborted", () => {
		const t = new LiveTranscriptV0();
		t.push({ type: "agent_start", record: {} });
		t.push(start());
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "halfway thr" }));
		t.push(assistant([{ type: "thinking", thinking: "halfway thr" }], "aborted"));
		t.push({ type: "agent_end", record: {} });
		t.push({ type: "agent_settled", record: { aborted: true } });
		const view = t.view();
		expect(view.open).toBeNull();
		const m = view.items.find((i) => i.kind === "message");
		expect(m?.kind === "message" && m.stopReason).toBe("aborted");
	});

	it("is replaced by a retry's new message, and dropped when the low-level run or the whole run ends without completing it", () => {
		const t = new LiveTranscriptV0();
		t.push(start());
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "attempt one" }));
		t.push(start());
		expect(t.view().open).toEqual({ id: 2, afterSeq: 0, parts: [] });
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "attempt two" }));
		t.push({ type: "agent_end", record: { willRetry: true } });
		expect(t.view().open).toBeNull();
		t.push(start());
		t.push(update({ type: "text_delta", contentIndex: 0, delta: "x" }));
		t.push({ type: "agent_settled", record: {} });
		expect(t.view().open).toBeNull();
	});

	it("ignores malformed and unexpected updates without throwing", () => {
		const t = new LiveTranscriptV0();
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "no message started" }));
		expect(t.view().open).toBeNull();
		t.push(start());
		const bad: unknown[] = [
			null,
			"thinking_delta",
			{ type: 3 },
			{ type: "thinking_delta" },
			{ type: "thinking_delta", contentIndex: 1e9, delta: "huge index" },
			{ type: "thinking_delta", contentIndex: -1, delta: "negative" },
			{ type: "thinking_delta", contentIndex: 1.5, delta: "fraction" },
			{ type: "thinking_delta", contentIndex: "0", delta: "string index" },
			{ type: "thinking_delta", contentIndex: 0, delta: 42 },
			{ type: "thinking_end", contentIndex: 0, content: { not: "text" } },
			{ type: "weird_delta", contentIndex: 0, delta: "unknown kind" },
			{ type: "thinking", contentIndex: 0 },
		];
		for (const e of bad) t.push({ type: "message_update", record: { assistantMessageEvent: e } });
		t.push({ type: "message_update", record: {} });
		const open = t.view().open;
		expect(open?.parts.every((p) => p.text === "")).toBe(true);
		// A text delta cannot change a reasoning block's kind under the same index.
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "r" }));
		t.push(update({ type: "text_delta", contentIndex: 0, delta: "t" }));
		expect(t.view().open?.parts).toEqual([
			{ kind: "reasoning", state: "supplied", text: "r", truncated: false, bytes: 1 },
		]);
	});

	it("bounds a streamed block in linear time, cutting at a character boundary and counting what it did not keep", () => {
		const t = new LiveTranscriptV0();
		t.push(start());
		const started = performance.now();
		for (let i = 0; i < 40_000; i++) t.push(update({ type: "thinking_delta", contentIndex: 0, delta: "é漢" }));
		expect(performance.now() - started).toBeLessThan(1500);
		const part = t.view().open!.parts[0]!;
		if (part.kind !== "reasoning") throw new Error("reasoning expected");
		expect(part.truncated).toBe(true);
		expect(part.bytes).toBe(40_000 * 5);
		expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1);
		expect(part.text.includes("�")).toBe(false);
	});

	it("is cleared with the session and nothing is taken after", () => {
		const t = new LiveTranscriptV0();
		t.push(start());
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: THOUGHT }));
		t.push(assistant([{ type: "thinking", thinking: THOUGHT }]));
		t.push(start());
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: THOUGHT }));
		t.clear();
		t.push(start());
		t.push(update({ type: "thinking_delta", contentIndex: 0, delta: THOUGHT }));
		expect(JSON.stringify(t.view())).not.toContain(THOUGHT);
		expect(t.view().open).toBeNull();
		expect(t.size).toEqual({ items: 0, bytes: 0 });
	});
});

describe("reasoning at the broker's boundary", () => {
	const setup = () => {
		const session = new FakeSession();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: new Approval().approver,
		});
		const call = (route: string, grant: string | null, query = "") =>
			broker.handle({ method: "GET", route: route.split("/"), query, grant, body: null });
		return { session, broker, call };
	};

	it("serves reasoning only to the paired page, under the v1 schema, and never in the status", async () => {
		const { session, broker, call } = setup();
		session.live_(
			assistant([
				{ type: "thinking", thinking: THOUGHT },
				{ type: "text", text: "ok" },
			]),
		);
		session.live_(start());
		session.live_(update({ type: "thinking_delta", contentIndex: 0, delta: `${THOUGHT}-open` }));
		const unpaired = await call("transcript", null);
		expect(unpaired.status).toBe(401);
		expect(JSON.stringify(unpaired.body)).not.toContain(THOUGHT);
		const status = await call("status", null);
		expect(JSON.stringify(status.body)).not.toContain(THOUGHT);
		const { code } = broker.issuePairingCode();
		const paired = await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } });
		const grant = (paired.body as { grant: string }).grant;
		const read = await call("transcript", grant);
		expect(read.status).toBe(200);
		const body = read.body as { schemaVersion: string; open: unknown };
		expect(body.schemaVersion).toBe("endo.workbench-transcript.v1");
		expect(JSON.stringify(body)).toContain(THOUGHT);
		expect(JSON.stringify(body.open)).toContain(`${THOUGHT}-open`);
		// The session ends: the reasoning goes with it, the open message included.
		session.live = false;
		expect((await call("transcript", grant)).status).toBe(401);
		expect(JSON.stringify(broker.transcript.view())).not.toContain(THOUGHT);
	});
});
