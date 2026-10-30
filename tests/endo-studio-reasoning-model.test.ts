// The browser's side of model-provided reasoning: the wire gate for the v1 transcript (every new field checked, a body that breaks a rule
// refused whole), the state that holds the message being written, the page's own bound, and the pure display rules (keys that carry a
// trace's state from the snapshot to the completed message, folding, clamping, and what each trace's head says).
import { describe, expect, it } from "vitest";
import {
	CLAMP_CHARS,
	disclosureOf,
	formatBytes,
	preview,
	reasoningKey,
	traceMeta,
	utf8Length,
	visibleText,
	wordCount,
} from "../studio-ui/src/model/reasoning.ts";
import { initialWorkbench, MAX_TEXT, reduceWorkbench, type WorkbenchState } from "../studio-ui/src/model/workbench.ts";
import {
	readWorkbenchTranscript,
	type TranscriptItem,
	type WorkbenchStatus,
	type WorkbenchTranscript,
} from "../studio-ui/src/model/workbench-wire.ts";

const LAUNCH = "0123456789abcdef";
const body = (over: Record<string, unknown> = {}) => ({
	schemaVersion: "endo.workbench-transcript.v1",
	launchId: LAUNCH,
	items: [
		{
			seq: 1,
			kind: "message",
			role: "assistant",
			parts: [
				{ kind: "reasoning", state: "supplied", text: "think", truncated: false, bytes: 5 },
				{ kind: "text", text: "answer", truncated: false },
			],
			truncated: false,
			partsDropped: 0,
			stopReason: "stop",
			from: null,
		},
	],
	watermark: 1,
	firstSeq: 1,
	evicted: 0,
	more: false,
	open: null,
	reasoning: { relay: "relayed", reason: null },
	...over,
});
const withPart = (part: unknown) => {
	const b = body();
	(b.items[0] as { parts: unknown[] }).parts = [part];
	return b;
};

describe("the v1 transcript at the browser's gate", () => {
	it("accepts a well-formed body with reasoning, an open message and the relay", () => {
		expect(readWorkbenchTranscript(body())).not.toBeNull();
		expect(
			readWorkbenchTranscript(
				body({
					open: {
						id: 3,
						afterSeq: 1,
						parts: [{ kind: "reasoning", state: "supplied", text: "partial", truncated: false, bytes: 7 }],
					},
				}),
			),
		).not.toBeNull();
		expect(
			readWorkbenchTranscript(
				withPart({ kind: "reasoning", state: "withheld", text: "", truncated: false, bytes: 0 }),
			),
		).not.toBeNull();
	});

	it("refuses the v0 schema, an unknown field, and any part that breaks the rules", () => {
		expect(readWorkbenchTranscript(body({ schemaVersion: "endo.workbench-transcript.v0" }))).toBeNull();
		expect(readWorkbenchTranscript(body({ extra: 1 }))).toBeNull();
		const bad: unknown[] = [
			// withheld or empty with text, or with a cut, or with a size
			{ kind: "reasoning", state: "withheld", text: "leak", truncated: false, bytes: 0 },
			{ kind: "reasoning", state: "empty", text: "", truncated: true, bytes: 0 },
			{ kind: "reasoning", state: "withheld", text: "", truncated: false, bytes: 9 },
			// supplied with no text and no cut
			{ kind: "reasoning", state: "supplied", text: "", truncated: false, bytes: 0 },
			// an unknown state, a signature, too long, the wrong types
			{ kind: "reasoning", state: "redacted", text: "", truncated: false, bytes: 0 },
			{ kind: "reasoning", state: "supplied", text: "x", truncated: false, bytes: 1, thinkingSignature: "s" },
			{ kind: "reasoning", state: "supplied", text: "x".repeat(64 * 1024 + 1), truncated: true, bytes: 1 },
			{ kind: "text", text: "x".repeat(32 * 1024 + 1), truncated: true },
			{ kind: "reasoning", state: "supplied", text: "x", truncated: "no", bytes: 1 },
			{ kind: "reasoning", state: "supplied", text: "x", truncated: false, bytes: -1 },
			{ kind: "image", data: "AAAA" },
		];
		for (const part of bad)
			expect(readWorkbenchTranscript(withPart(part)), JSON.stringify(part).slice(0, 80)).toBeNull();
		const many = body();
		(many.items[0] as { parts: unknown[] }).parts = Array.from({ length: 33 }, () => ({
			kind: "text",
			text: "a",
			truncated: false,
		}));
		expect(readWorkbenchTranscript(many)).toBeNull();
	});

	it("refuses an open message placed after an item the broker has not issued, and a malformed relay", () => {
		expect(readWorkbenchTranscript(body({ open: { id: 1, afterSeq: 2, parts: [] } }))).toBeNull();
		expect(readWorkbenchTranscript(body({ open: { id: 0, afterSeq: 1, parts: [] } }))).toBeNull();
		expect(readWorkbenchTranscript(body({ reasoning: { relay: "maybe", reason: null } }))).toBeNull();
		expect(readWorkbenchTranscript(body({ reasoning: { relay: "withheld" } }))).toBeNull();
	});
});

const status = (over: Partial<WorkbenchStatus> = {}): WorkbenchStatus => ({
	schemaVersion: "endo.workbench-status.v0",
	launchId: LAUNCH,
	harness: "pi",
	connection: "connected",
	run: "active",
	session: "endo.session.pi.x",
	attachment: "pi.default",
	offers: {
		prompt: { offered: false, reason: "busy" },
		steer: { offered: true, reason: null },
		queue: { offered: true, reason: null },
		stop: { offered: true, reason: null },
	},
	paired: true,
	command: null,
	interventions: [],
	transcript: { watermark: 0, firstSeq: 1 },
	...over,
});
const at = new Date(0);
const withStatus = (over: Partial<WorkbenchStatus> = {}): WorkbenchState =>
	reduceWorkbench(initialWorkbench(), { type: "reply", reply: { kind: "status", record: status(over) }, at });
const give = (s: WorkbenchState, over: Record<string, unknown>) => {
	const record = readWorkbenchTranscript(body(over));
	if (record === null) throw new Error("fixture refused");
	return reduceWorkbench(s, { type: "reply", reply: { kind: "transcript", record }, at });
};
const OPEN = {
	id: 1,
	afterSeq: 1,
	parts: [{ kind: "reasoning", state: "supplied", text: "draft", truncated: false, bytes: 5 }],
};

describe("the message being written, in the page's state", () => {
	it("is replaced on every read and cleared when the completed message arrives", () => {
		let s = give(withStatus(), { open: OPEN });
		expect(s.open?.id).toBe(1);
		expect(s.reasoning).toEqual({ relay: "relayed", reason: null });
		s = give(s, { items: [], open: null });
		expect(s.open).toBeNull();
	});

	it("is forgotten with the text when the broker says disconnected, and on a new launch; kept while the broker is unreachable", () => {
		const held = give(withStatus(), { open: OPEN });
		const gone = reduceWorkbench(held, {
			type: "reply",
			reply: { kind: "status", record: status({ connection: "disconnected", run: "unknown" }) },
			at,
		});
		expect(gone.open).toBeNull();
		expect(gone.items).toEqual([]);
		const relaunched = reduceWorkbench(held, {
			type: "reply",
			reply: { kind: "status", record: status({ launchId: "fedcba9876543210" }) },
			at,
		});
		expect(relaunched.open).toBeNull();
		const lost = reduceWorkbench(held, {
			type: "reply",
			reply: { kind: "failure", status: 0, code: "", message: "x", retrySeconds: null },
			at,
		});
		expect(lost.unreachable).toBe(true);
		expect(lost.open?.id).toBe(1);
	});

	it("holds at most MAX_TEXT of text, letting the oldest items go and counting them", () => {
		let s = withStatus();
		const big = "r".repeat(60_000);
		for (let i = 1; i <= 60; i += 1) {
			const item: TranscriptItem = {
				seq: i,
				kind: "message",
				role: "assistant",
				parts: [{ kind: "reasoning", state: "supplied", text: big, truncated: false, bytes: big.length }],
				truncated: false,
				partsDropped: 0,
				stopReason: "stop",
				from: null,
			};
			s = reduceWorkbench(s, {
				type: "reply",
				reply: {
					kind: "transcript",
					record: { ...(body() as unknown as WorkbenchTranscript), items: [item], watermark: i },
				},
				at,
			});
		}
		const held = s.items.reduce(
			(n, i) => n + (i.kind === "message" ? i.parts.reduce((m, p) => m + p.text.length, 0) : 0),
			0,
		);
		expect(held).toBeLessThanOrEqual(MAX_TEXT);
		expect(s.trimmed).toBe(60 - s.items.length);
		expect(s.items.at(-1)?.seq).toBe(60);
	});
});

describe("how a trace is shown", () => {
	it("keys a completed message's traces by the snapshot it replaced, so a trace opened while written stays open", () => {
		expect(reasoningKey({ open: 4 }, 0)).toBe("o4:r0");
		expect(reasoningKey({ seq: 9, from: 4 }, 0)).toBe("o4:r0");
		expect(reasoningKey({ seq: 9, from: null }, 1)).toBe("s9:r1");
	});

	it("folds by default, shows under the shown preference, and lets one trace differ either way", () => {
		const none = new Map();
		expect(disclosureOf("folded", none, "k")).toBe("folded");
		expect(disclosureOf("shown", none, "k")).toBe("open");
		const one = new Map([["k", "full" as const]]);
		expect(disclosureOf("folded", one, "k")).toBe("full");
		expect(disclosureOf("shown", new Map([["k", "folded" as const]]), "k")).toBe("folded");
	});

	it("clamps a long trace near the clamp at a line or word, never mid-word, and shows it whole on request", () => {
		const text = `${"word ".repeat(1000)}\nend`;
		const open = visibleText(text, "open");
		expect(open.length).toBeLessThanOrEqual(CLAMP_CHARS);
		expect(open.endsWith("word")).toBe(true);
		expect(visibleText(text, "full")).toBe(text);
		expect(visibleText("short", "open")).toBe("short");
	});

	it("says what each trace is, in words: its place, its size, a cut, and the withheld and empty states", () => {
		expect(
			traceMeta({ kind: "reasoning", state: "supplied", text: "one two three", truncated: false, bytes: 13 }, 0, 1),
		).toBe("3 words");
		expect(
			traceMeta({ kind: "reasoning", state: "supplied", text: "a", truncated: true, bytes: 200_000 }, 1, 2),
		).toBe("2 of 2 · 1 word · cut at 1 B of 195 KB");
		expect(traceMeta({ kind: "reasoning", state: "withheld", text: "", truncated: false, bytes: 0 }, 0, 1)).toBe(
			"withheld by the provider",
		);
		expect(traceMeta({ kind: "reasoning", state: "empty", text: "", truncated: false, bytes: 0 }, 0, 1)).toMatch(
			/no text was supplied/,
		);
		expect(wordCount("  ")).toBe(0);
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(utf8Length("é漢😀")).toBe(2 + 3 + 4);
		expect(preview(`a\n\n  b ${"c".repeat(300)}`).endsWith("…")).toBe(true);
	});
});
