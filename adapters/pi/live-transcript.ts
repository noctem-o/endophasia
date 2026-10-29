// The live transcript: what a running Pi session has said, held IN MEMORY ONLY by the process that owns the session.
//
// Canonical evidence withholds message text, tool arguments and results (adapters/pi/mapping.ts). A workbench has to show the
// conversation, so this is a separate, private, bounded view built from the live runtime events the attached process receives
// (PiSessionAttachmentV0.onLiveEvent). It is never written anywhere: not to the event store, the runtime-text side store, a log,
// an error or an export. It is served only by the workbench broker, to a paired operator, and is cleared when the session ends.
//
// What it keeps: user and assistant message text (text parts only; reasoning/"thinking" is never kept), and for a tool call only its
// name and outcome (arguments and results are not kept at all in v0). What it never does: reconstruct text from digests, infer
// content from a tool name, or claim a message it did not receive. A message that arrived before it began is simply absent, and the
// view says its first sequence number so a reader can tell.
//
// Bounds: at most MAX_ITEMS items and MAX_BYTES of text in all; a longer message is cut at MAX_MESSAGE_BYTES and marked
// `truncated`. The oldest items are evicted first and counted in `evicted`, so a reader sees a gap as a gap.

import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";

export const LIVE_TRANSCRIPT_MAX_ITEMS_V0 = 400;
export const LIVE_TRANSCRIPT_MAX_BYTES_V0 = 1024 * 1024;
export const LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0 = 32 * 1024;
export const LIVE_TRANSCRIPT_PAGE_V0 = 200;

export type LiveTranscriptItemV0 =
	| {
			seq: number;
			kind: "message";
			role: "user" | "assistant";
			text: string;
			truncated: boolean;
			/** The runtime's reported stop reason for an assistant message ("stop", "error", …), else null. */
			stopReason: string | null;
	  }
	| { seq: number; kind: "tool"; callId: string; name: string; status: "running" | "ok" | "error" }
	| { seq: number; kind: "run"; state: "started" | "ended" };

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
}

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text parts of a message's content, joined. Reasoning, images and every other part are ignored. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** Cut at a UTF-8 boundary no longer than `limit` bytes. */
function cut(text: string, limit: number): { text: string; truncated: boolean } {
	if (bytes(text) <= limit) return { text, truncated: false };
	let end = Math.min(text.length, limit);
	while (end > 0 && bytes(text.slice(0, end)) > limit) end -= 1;
	return { text: text.slice(0, end), truncated: true };
}

const name = (value: unknown): string =>
	typeof value === "string" && value.length > 0
		? value.slice(0, 128).replace(/[\u0000-\u001f\u007f]/g, "")
		: "unknown";

export class LiveTranscriptV0 {
	#items: LiveTranscriptItemV0[] = [];
	#bytes = 0;
	#seq = 0;
	#evicted = 0;
	#firstSeq = 1;
	#cleared = false;

	/** Take one live runtime event. Anything that is not a message, a tool boundary or a run boundary is ignored. */
	push(event: RpcEventV0): void {
		if (this.#cleared) return;
		const record = event.record;
		if (event.type === "agent_start") this.#add({ kind: "run", state: "started" });
		else if (event.type === "agent_end") this.#add({ kind: "run", state: "ended" });
		else if (event.type === "message_end" && isRecord(record.message)) {
			const role = record.message.role;
			if (role !== "user" && role !== "assistant") return;
			const shown = cut(textOf(record.message.content), LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0);
			const stop = record.message.stopReason;
			this.#add({
				kind: "message",
				role,
				text: shown.text,
				truncated: shown.truncated,
				stopReason: typeof stop === "string" && stop !== "pending" ? stop.slice(0, 32) : null,
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

	#add(item: DistributiveOmit<LiveTranscriptItemV0, "seq">): void {
		this.#seq += 1;
		const full = { ...item, seq: this.#seq } as LiveTranscriptItemV0;
		if (this.#items.length === 0) this.#firstSeq = this.#seq;
		this.#items.push(full);
		if (full.kind === "message") this.#bytes += bytes(full.text);
		while (
			this.#items.length > LIVE_TRANSCRIPT_MAX_ITEMS_V0 ||
			(this.#bytes > LIVE_TRANSCRIPT_MAX_BYTES_V0 && this.#items.length > 1)
		) {
			const gone = this.#items.shift()!;
			if (gone.kind === "message") this.#bytes -= bytes(gone.text);
			this.#evicted += 1;
		}
		this.#firstSeq = this.#items[0]?.seq ?? this.#seq + 1;
	}

	view(after = 0): LiveTranscriptViewV0 {
		const rest = this.#items.filter((item) => item.seq > after);
		const items = rest.slice(0, LIVE_TRANSCRIPT_PAGE_V0);
		return {
			items: items.map((item) => ({ ...item })),
			watermark: this.#seq,
			firstSeq: this.#firstSeq,
			evicted: this.#evicted,
			more: rest.length > items.length,
		};
	}

	/** Forget everything and ignore anything further: the session ended. Idempotent. */
	clear(): void {
		this.#items = [];
		this.#bytes = 0;
		this.#cleared = true;
	}

	get cleared(): boolean {
		return this.#cleared;
	}

	get size(): { items: number; bytes: number } {
		return { items: this.#items.length, bytes: this.#bytes };
	}
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
