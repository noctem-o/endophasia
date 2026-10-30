// The live transcript: what a running Pi session has said, held IN MEMORY ONLY by the process that owns the session.
//
// Canonical evidence withholds message text, tool arguments and results (adapters/pi/mapping.ts). A workbench has to show the
// conversation, so this is a separate, private, bounded view built from the live runtime events the attached process receives
// (PiSessionAttachmentV0.onLiveEvent). It is never written anywhere: not to the event store, the runtime-text side store, a log,
// an error or an export. It is served only by the workbench broker, to a paired operator, and is cleared when the session ends.
//
// What it keeps, per message, in the order Pi's content array gives them: the text parts (adjacent ones joined) and the model-provided
// reasoning parts. Reasoning is taken ONLY from Pi's structured `thinking` content blocks (and, for the message still being written,
// its `thinking_*` stream events); a `<think>` tag or any other pattern inside ordinary text is ordinary text. A reasoning block Pi
// marks `redacted` is kept as "withheld", with no text; its opaque `thinkingSignature` is never read. Reasoning is what the model emitted
// as reasoning: it is relayed, not interpreted, and nothing here claims it reflects how the model actually computed its answer.
// For a tool call only its name and outcome are kept (arguments and results are not kept at all). What it never does: reconstruct text
// from digests, infer content from a tool name, or claim a message it did not receive. A message that arrived before it began is simply
// absent, and the view says its first sequence number so a reader can tell.
//
// The message being written. Pi streams `message_update` deltas; they are folded into ONE snapshot (`open`), kept beside the item log,
// never in it, and replaced by the completed message when `message_end` arrives (the completed message is authoritative: nothing of the
// snapshot survives it). A new assistant `message_start` (a retry) replaces it; the end of a run or of the session drops it. A reader is
// given the snapshot as it was at the moment it read, and the completed item names the snapshot it completes (`from`), so a reader can
// carry its own display state across. Deltas name a content block by `contentIndex`; one outside 0..MAX_PARTS-1 is ignored.
//
// Bounds (UTF-8 bytes, cut at a character boundary and marked):
//  - message text: MAX_MESSAGE_BYTES across a message's text parts;
//  - reasoning: MAX_REASONING_BLOCK_BYTES per block and MAX_REASONING_MESSAGE_BYTES per message; a block keeps its original size in
//    `bytes`, so a cut says how much was not kept;
//  - at most MAX_PARTS parts per message (any more are counted in `partsDropped`);
//  - the transcript: MAX_ITEMS items and MAX_BYTES of text and reasoning together; the oldest items are evicted whole, first, and counted
//    in `evicted`, so a reader sees a gap as a gap;
//  - one page: at most PAGE items and PAGE_BYTES (always at least one item, so a reader makes progress).

import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";

export const LIVE_TRANSCRIPT_SCHEMA_V1 = "endo.workbench-transcript.v1";
export const LIVE_TRANSCRIPT_MAX_ITEMS_V0 = 400;
export const LIVE_TRANSCRIPT_MAX_BYTES_V0 = 2 * 1024 * 1024;
export const LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0 = 32 * 1024;
export const LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1 = 64 * 1024;
export const LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1 = 96 * 1024;
export const LIVE_TRANSCRIPT_MAX_PARTS_V1 = 32;
export const LIVE_TRANSCRIPT_PAGE_V0 = 200;
export const LIVE_TRANSCRIPT_PAGE_BYTES_V1 = 512 * 1024;

/** One part of a message, in the order the runtime gave it. */
export type LiveTranscriptPartV1 =
	| { kind: "text"; text: string; truncated: boolean }
	| {
			kind: "reasoning";
			/**
			 * `supplied`: the runtime gave reasoning text. `withheld`: the provider redacted it (nothing is shown). `empty`: a reasoning block
			 * arrived with no text.
			 */
			state: "supplied" | "withheld" | "empty";
			text: string;
			truncated: boolean;
			/** The block's size as received, in UTF-8 bytes (the size before any cut). */
			bytes: number;
	  };

export type LiveTranscriptItemV0 =
	| {
			seq: number;
			kind: "message";
			role: "user" | "assistant";
			parts: LiveTranscriptPartV1[];
			/** Some text was cut at a limit, or parts were dropped. */
			truncated: boolean;
			/** Parts beyond MAX_PARTS, not kept. */
			partsDropped: number;
			/** The runtime's reported stop reason for an assistant message ("stop", "error", "aborted", …), else null. */
			stopReason: string | null;
			/** The `open` snapshot this completed message replaces, if one was being shown; else null. */
			from: number | null;
	  }
	| { seq: number; kind: "tool"; callId: string; name: string; status: "running" | "ok" | "error" }
	| { seq: number; kind: "run"; state: "started" | "ended" };

/** The assistant message being written, as of the moment it was read. Not a message: it is replaced by the completed one. */
export interface LiveTranscriptOpenV1 {
	/** This snapshot's number, unique within the transcript. */
	id: number;
	/** The transcript's highest sequence number when the message began: it belongs after that item. */
	afterSeq: number;
	parts: LiveTranscriptPartV1[];
}

/**
 * What this source relays of model-provided reasoning, harness-neutrally. `relayed`: reasoning the runtime supplies in structured form is
 * shown (a turn without any had none supplied). `withheld`: the source has it and does not pass it on. `unsupported`: the source does not
 * provide it. Pi relays.
 */
export interface LiveTranscriptReasoningV1 {
	relay: "relayed" | "withheld" | "unsupported";
	reason: string | null;
}

export interface LiveTranscriptViewV0 {
	/** Items with a sequence number greater than the `after` asked for, oldest first, at most one page. */
	items: LiveTranscriptItemV0[];
	/** The highest sequence number issued so far: pass it back as `after` to continue. 0 before anything was seen. */
	watermark: number;
	/** The first sequence number this transcript could hold; earlier events happened before it began or were evicted. */
	firstSeq: number;
	/** Items evicted to stay within the bounds. */
	evicted: number;
	/** Whether more items follow this page. */
	more: boolean;
	/** The assistant message being written now, or null. */
	open: LiveTranscriptOpenV1 | null;
	reasoning: LiveTranscriptReasoningV1;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cut at a UTF-8 boundary no longer than `limit` bytes. */
function cut(text: string, limit: number): { text: string; truncated: boolean } {
	if (limit <= 0) return { text: "", truncated: text.length > 0 };
	// A string of n UTF-16 units is at most 3n UTF-8 bytes: most text needs no encoding at all to know it fits.
	if (text.length * 3 <= limit) return { text, truncated: false };
	const encoded = Buffer.from(text, "utf8");
	if (encoded.length <= limit) return { text, truncated: false };
	// One encoding, then back to a UTF-8 character boundary (a continuation byte is 10xxxxxx): linear, however long the message.
	let end = limit;
	while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
	return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

const name = (value: unknown): string =>
	typeof value === "string" && value.length > 0
		? value.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, "")
		: "unknown";

/** The UTF-8 bytes a part holds (what counts against the transcript's bound). */
const partBytes = (part: LiveTranscriptPartV1): number => (part.text.length === 0 ? 0 : bytes(part.text));
const itemBytes = (item: LiveTranscriptItemV0): number =>
	item.kind === "message" ? item.parts.reduce((sum, part) => sum + partBytes(part), 0) : 0;

/** A completed message's content, as ordered parts within the bounds. Images, tool calls and every other block are left out. */
function partsOf(content: unknown): { parts: LiveTranscriptPartV1[]; truncated: boolean; dropped: number } {
	const blocks: unknown[] =
		typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	const parts: LiveTranscriptPartV1[] = [];
	let truncated = false;
	let dropped = 0;
	let textLeft = LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0;
	let reasoningLeft = LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1;
	// Adjacent text blocks are one part, as the text was always shown; they are joined before they are cut.
	let pendingText: string[] = [];
	const flushText = () => {
		if (pendingText.length === 0) return;
		const joined = pendingText.join("");
		pendingText = [];
		if (parts.length >= LIVE_TRANSCRIPT_MAX_PARTS_V1) {
			dropped += 1;
			return;
		}
		const shown = cut(joined, textLeft);
		textLeft -= bytes(shown.text);
		truncated ||= shown.truncated;
		parts.push({ kind: "text", text: shown.text, truncated: shown.truncated });
	};
	for (const block of blocks) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			pendingText.push(block.text);
			continue;
		}
		if (block.type !== "thinking") continue;
		flushText();
		if (parts.length >= LIVE_TRANSCRIPT_MAX_PARTS_V1) {
			dropped += 1;
			continue;
		}
		const raw = typeof block.thinking === "string" ? block.thinking : "";
		if (block.redacted === true) {
			parts.push({ kind: "reasoning", state: "withheld", text: "", truncated: false, bytes: 0 });
			continue;
		}
		if (raw.length === 0) {
			parts.push({ kind: "reasoning", state: "empty", text: "", truncated: false, bytes: 0 });
			continue;
		}
		const size = bytes(raw);
		const shown = cut(raw, Math.min(LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1, reasoningLeft));
		reasoningLeft -= bytes(shown.text);
		truncated ||= shown.truncated;
		parts.push({ kind: "reasoning", state: "supplied", text: shown.text, truncated: shown.truncated, bytes: size });
	}
	flushText();
	return { parts, truncated: truncated || dropped > 0, dropped };
}

/** One content block of the message being written, as its deltas have arrived. */
interface OpenBlock {
	kind: "text" | "reasoning";
	text: string;
	/** Bytes received for this block, whether or not they were kept. */
	received: number;
	/** Bytes of `text`, counted as it grows (a block can have tens of thousands of deltas). */
	kept: number;
	truncated: boolean;
	ended: boolean;
}

export class LiveTranscriptV0 {
	#items: LiveTranscriptItemV0[] = [];
	#bytes = 0;
	#seq = 0;
	#evicted = 0;
	#firstSeq = 1;
	#cleared = false;
	// Whether a run is open. As in adapters/pi/lifecycle.ts, a run lasts until agent_settled: an agent_start inside it is a continuation
	// (retry, compaction recovery, queued follow-up) and an agent_end is not the end.
	#runOpen = false;
	// The assistant message being written: its snapshot number, where it belongs, and its blocks by content index.
	#open: { id: number; afterSeq: number; blocks: Map<number, OpenBlock> } | null = null;
	#openIds = 0;

	/** Take one live runtime event. Anything that is not a message, a tool boundary or a run boundary is ignored. */
	push(event: RpcEventV0): void {
		if (this.#cleared) return;
		const record = event.record;
		if (event.type === "agent_start") {
			if (this.#runOpen) return;
			this.#runOpen = true;
			this.#add({ kind: "run", state: "started" });
		} else if (event.type === "agent_settled") {
			this.#open = null;
			if (!this.#runOpen) return;
			this.#runOpen = false;
			this.#add({ kind: "run", state: "ended" });
		} else if (event.type === "agent_end") {
			// A low-level run ended: a message still being written will not be completed by it (a retry starts a new one).
			this.#open = null;
		} else if (event.type === "message_start" && isRecord(record.message)) {
			// A new assistant message replaces whatever was being written (a retry, or one that never completed).
			if (record.message.role === "assistant") {
				this.#openIds += 1;
				this.#open = { id: this.#openIds, afterSeq: this.#seq, blocks: new Map() };
			}
		} else if (event.type === "message_update") {
			this.#update(record.assistantMessageEvent);
		} else if (event.type === "message_end" && isRecord(record.message)) {
			const role = record.message.role;
			if (role !== "user" && role !== "assistant") return;
			const from = role === "assistant" && this.#open !== null ? this.#open.id : null;
			// The completed message is authoritative: nothing of the snapshot is kept, whatever it held.
			if (role === "assistant") this.#open = null;
			const shown = partsOf(record.message.content);
			const stop = record.message.stopReason;
			this.#add({
				kind: "message",
				role,
				parts: shown.parts,
				truncated: shown.truncated,
				partsDropped: shown.dropped,
				stopReason: typeof stop === "string" && stop !== "pending" ? stop.slice(0, 32) : null,
				from,
			});
		} else if (event.type === "tool_execution_start") {
			this.#add({ kind: "tool", callId: name(record.toolCallId), name: name(record.toolName), status: "running" });
		} else if (event.type === "tool_execution_end") {
			// The end of a call is a NEW item with its own sequence number, so a reader that already holds the running item receives the
			// outcome by the same cursor it uses for everything else. A reader folds items of one call id into one row.
			this.#add({
				kind: "tool",
				callId: name(record.toolCallId),
				name: name(record.toolName),
				status: record.isError === true ? "error" : "ok",
			});
		}
	}

	/** One streamed content event of the message being written. Only text and thinking blocks are followed. */
	#update(update: unknown): void {
		const open = this.#open;
		if (open === null || !isRecord(update) || typeof update.type !== "string") return;
		const index = update.contentIndex;
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= LIVE_TRANSCRIPT_MAX_PARTS_V1)
			return;
		const [kind, step] = update.type.split("_") as [string, string | undefined];
		if ((kind !== "text" && kind !== "thinking") || step === undefined) return;
		const blockKind = kind === "text" ? "text" : "reasoning";
		const limit =
			blockKind === "text" ? LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0 : LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1;
		let block = open.blocks.get(index);
		if (step === "start" || block === undefined) {
			// A start, or a delta for a block whose start was not seen: begin it here. A block's kind never changes under its index.
			if (block !== undefined && block.kind !== blockKind) return;
			block = { kind: blockKind, text: "", received: 0, kept: 0, truncated: false, ended: false };
			open.blocks.set(index, block);
			if (step === "start") return;
		}
		if (block.kind !== blockKind || block.ended) return;
		if (step === "delta" && typeof update.delta === "string") {
			const size = bytes(update.delta);
			block.received += size;
			if (block.truncated) return;
			const shown = cut(update.delta, limit - block.kept);
			block.text += shown.text;
			block.kept += shown.truncated ? bytes(shown.text) : size;
			block.truncated = shown.truncated;
		} else if (step === "end" && typeof update.content === "string") {
			// The block ended with its authoritative content: it replaces what the deltas built.
			const shown = cut(update.content, limit);
			block.text = shown.text;
			block.kept = bytes(shown.text);
			block.received = bytes(update.content);
			block.truncated = shown.truncated;
			block.ended = true;
		}
	}

	#add(item: DistributiveOmit<LiveTranscriptItemV0, "seq">): void {
		this.#seq += 1;
		const full = { ...item, seq: this.#seq } as LiveTranscriptItemV0;
		if (this.#items.length === 0) this.#firstSeq = this.#seq;
		this.#items.push(full);
		this.#bytes += itemBytes(full);
		while (
			this.#items.length > LIVE_TRANSCRIPT_MAX_ITEMS_V0 ||
			(this.#bytes > LIVE_TRANSCRIPT_MAX_BYTES_V0 && this.#items.length > 1)
		) {
			const gone = this.#items.shift()!;
			this.#bytes -= itemBytes(gone);
			this.#evicted += 1;
		}
		this.#firstSeq = this.#items[0]?.seq ?? this.#seq + 1;
	}

	#openView(): LiveTranscriptOpenV1 | null {
		const open = this.#open;
		if (open === null) return null;
		let reasoningLeft = LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1;
		const parts: LiveTranscriptPartV1[] = [...open.blocks.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, block]): LiveTranscriptPartV1 => {
				if (block.kind === "text") return { kind: "text", text: block.text, truncated: block.truncated };
				const shown = cut(block.text, reasoningLeft);
				reasoningLeft -= bytes(shown.text);
				return {
					kind: "reasoning",
					state: block.received === 0 ? "empty" : "supplied",
					text: shown.text,
					truncated: block.truncated || shown.truncated,
					bytes: block.received,
				};
			});
		return { id: open.id, afterSeq: open.afterSeq, parts };
	}

	view(after = 0): LiveTranscriptViewV0 {
		const rest = this.#items.filter((item) => item.seq > after);
		const items: LiveTranscriptItemV0[] = [];
		let pageBytes = 0;
		for (const item of rest) {
			if (items.length >= LIVE_TRANSCRIPT_PAGE_V0) break;
			const size = itemBytes(item);
			if (items.length > 0 && pageBytes + size > LIVE_TRANSCRIPT_PAGE_BYTES_V1) break;
			pageBytes += size;
			items.push(item);
		}
		return {
			items: items.map((item) =>
				item.kind === "message" ? { ...item, parts: item.parts.map((part) => ({ ...part })) } : { ...item },
			),
			watermark: this.#seq,
			firstSeq: this.#firstSeq,
			evicted: this.#evicted,
			more: rest.length > items.length,
			open: this.#openView(),
			reasoning: { relay: "relayed", reason: null },
		};
	}

	/** Forget everything and ignore anything further: the session ended. Idempotent. */
	clear(): void {
		this.#items = [];
		this.#bytes = 0;
		this.#open = null;
		this.#cleared = true;
	}

	/** The highest sequence number issued so far. */
	get watermark(): number {
		return this.#seq;
	}

	/** The first sequence number this transcript could hold. */
	get firstSeq(): number {
		return this.#firstSeq;
	}

	get cleared(): boolean {
		return this.#cleared;
	}

	get size(): { items: number; bytes: number } {
		return { items: this.#items.length, bytes: this.#bytes };
	}

	/** The bytes the held items actually contain, counted afresh (for tests: it must equal `size.bytes`). */
	recount(): number {
		return this.#items.reduce((sum, item) => sum + itemBytes(item), 0);
	}
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
