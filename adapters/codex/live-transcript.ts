// Memory-only live transcript for a Codex App Server session (`endo.workbench-transcript.v3`).
//
// Canonical evidence (`adapters/codex/events.ts`) withholds message text, reasoning text, command lines and tool output.
// A paired DEVELOP workbench needs the live conversation, so this is a separate, private, bounded, memory-only projection
// built from `CodexDevelopAdapterV0` observations and streaming deltas. It is NEVER persisted to disk, event logs, side stores,
// error messages or exports, is served only to a paired operator, and is cleared when the session ends or is disposed.
//
// Partial-item update semantics:
//  - Streaming deltas (`item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`) update one
//    bounded `open` snapshot beside the completed item list, keyed by `(itemId, contentKind, reasoningKind)`, without appending
//    duplicate items across polls.
//  - When the authoritative `item/completed` observation arrives, its matching open block is removed (clearing `open` when no
//    other streamed block remains open) and a single completed `message` item is appended with `from` naming the snapshot it
//    completes so the browser carries disclosure state across cleanly.
//  - Reasoning provenance (`raw-thinking` vs `reasoning-summary`) and redacted/empty states are preserved honestly; summaries
//    are NEVER relabeled as raw thinking.

import type {
	EndoAdapterReasoningKindV0,
	EndoDevelopAdapterDescriptorV0,
	EndoDevelopObservationV0,
} from "../../protocol/develop-adapter.ts";
import type {
	ActivityDescriptor,
	ActivityField,
	DescriptorBasis,
	PrivateActivity,
} from "../../protocol/private-activity.ts";
import {
	LIVE_TRANSCRIPT_MAX_BYTES_V0,
	LIVE_TRANSCRIPT_MAX_ITEMS_V0,
	LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0,
	LIVE_TRANSCRIPT_MAX_PARTS_V1,
	LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1,
	LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1,
	LIVE_TRANSCRIPT_PAGE_BYTES_V1,
	LIVE_TRANSCRIPT_PAGE_V0,
	LIVE_TRANSCRIPT_SCHEMA_V3,
	type LiveTranscriptReasoningV1,
} from "../pi/live-transcript.ts";
import type { CodexTranscriptDeltaV0 } from "./develop-adapter.ts";

export {
	LIVE_TRANSCRIPT_MAX_BYTES_V0,
	LIVE_TRANSCRIPT_MAX_ITEMS_V0,
	LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0,
	LIVE_TRANSCRIPT_MAX_PARTS_V1,
	LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1,
	LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1,
	LIVE_TRANSCRIPT_PAGE_BYTES_V1,
	LIVE_TRANSCRIPT_PAGE_V0,
	LIVE_TRANSCRIPT_SCHEMA_V3,
};

export type CodexTranscriptPartV1 =
	| { kind: "text"; text: string; truncated: boolean }
	| {
			kind: "reasoning";
			state: "supplied" | "withheld" | "empty";
			provenance?: "raw-thinking" | "reasoning-summary";
			text: string;
			truncated: boolean;
			bytes: number;
	  };

export type CodexTranscriptItemV0 =
	| {
			seq: number;
			kind: "message";
			role: "user" | "assistant";
			parts: CodexTranscriptPartV1[];
			truncated: boolean;
			partsDropped: number;
			stopReason: string | null;
			from: number | null;
	  }
	| PrivateActivity
	| { seq: number; kind: "run"; state: "started" | "ended" };

export interface CodexTranscriptOpenV1 {
	id: number;
	afterSeq: number;
	parts: CodexTranscriptPartV1[];
}

export interface CodexTranscriptViewV0 {
	items: CodexTranscriptItemV0[];
	descriptor: ActivityDescriptor;
	watermark: number;
	firstSeq: number;
	evicted: number;
	more: boolean;
	open: CodexTranscriptOpenV1 | null;
	reasoning: LiveTranscriptReasoningV1;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function cut(text: string, limit: number): { text: string; truncated: boolean } {
	if (limit <= 0) return { text: "", truncated: text.length > 0 };
	if (text.length * 3 <= limit) return { text, truncated: false };
	const encoded = Buffer.from(text, "utf8");
	if (encoded.length <= limit) return { text, truncated: false };
	let end = limit;
	while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
	return { text: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

const partBytes = (part: CodexTranscriptPartV1): number => (part.text.length === 0 ? 0 : bytes(part.text));
const itemBytes = (item: CodexTranscriptItemV0): number =>
	item.kind === "message"
		? item.parts.reduce((sum, part) => sum + partBytes(part), 0)
		: item.kind === "run"
			? 0
			: bytes(JSON.stringify(item));

const SAFE_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_REF = /^[a-zA-Z0-9_.:|-]{1,128}$/;

function safeActivityName(raw: string): string {
	return SAFE_NAME.test(raw) ? raw : raw.length === 0 ? "name unavailable" : "name withheld";
}

function safeRef(raw: string | null): string | null {
	return raw !== null && SAFE_REF.test(raw) ? raw : null;
}

function standingToBasis(standing: string | undefined): DescriptorBasis {
	if (standing === "admitted" || standing === "admitted-partial") return "assessed";
	if (standing === "unsupported") return "unavailable";
	return "unknown";
}

interface OpenBlock {
	readonly key: string;
	readonly kind: "text" | "reasoning";
	readonly provenance: "raw-thinking" | "reasoning-summary" | undefined;
	text: string;
	received: number;
	kept: number;
	truncated: boolean;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

export class CodexLiveTranscriptV0 {
	readonly #describe: (() => EndoDevelopAdapterDescriptorV0) | undefined;
	#items: CodexTranscriptItemV0[] = [];
	#bytes = 0;
	#seq = 0;
	#evicted = 0;
	#firstSeq = 1;
	#cleared = false;
	#runOpen = false;
	#turnCount = 0;
	#turn: number | null = null;
	#sawToolStart = false;
	#sawToolEnd = false;
	#sawFileChange = false;
	#sawSubagent = false;
	#sawApproval = false;
	readonly #pending = new Map<string, { kind: PrivateActivity["kind"]; occurrence: number } | null>();
	#overflow = false;
	#open: { id: number; afterSeq: number; blocks: Map<string, OpenBlock> } | null = null;
	#openIds = 0;

	constructor(describe?: () => EndoDevelopAdapterDescriptorV0) {
		this.#describe = describe;
	}

	/** Apply one memory-only streaming delta (assistant text or reasoning summary/raw). */
	pushDelta(delta: CodexTranscriptDeltaV0): void {
		if (this.#cleared || delta.delta.length === 0) return;
		const key = `${delta.itemId ?? "anon"}:${delta.contentKind}:${delta.reasoningKind ?? "text"}`;
		const provenance: "raw-thinking" | "reasoning-summary" | undefined =
			delta.contentKind === "reasoning"
				? delta.reasoningKind === "raw-thinking"
					? "raw-thinking"
					: "reasoning-summary"
				: undefined;
		if (this.#open === null) {
			this.#openIds += 1;
			this.#open = { id: this.#openIds, afterSeq: this.#seq, blocks: new Map() };
		}
		let block = this.#open.blocks.get(key);
		if (block === undefined) {
			if (this.#open.blocks.size >= LIVE_TRANSCRIPT_MAX_PARTS_V1) return;
			block = {
				key,
				kind: delta.contentKind,
				provenance,
				text: "",
				received: 0,
				kept: 0,
				truncated: false,
			};
			this.#open.blocks.set(key, block);
		}
		const limit =
			block.kind === "text" ? LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0 : LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1;
		const size = bytes(delta.delta);
		block.received += size;
		if (block.truncated) return;
		const shown = cut(delta.delta, limit - block.kept);
		block.text += shown.text;
		block.kept += shown.truncated ? bytes(shown.text) : size;
		block.truncated = shown.truncated;
	}

	/** Apply one canonical adapter observation to the memory-only transcript. */
	pushObservation(obs: EndoDevelopObservationV0, extras?: { fileChangeCount?: number | null }): void {
		if (this.#cleared) return;
		const body = obs.body;
		switch (body.kind) {
			case "lifecycle": {
				if (body.event === "turn-started") {
					this.#turnCount += 1;
					this.#turn = this.#turnCount;
					this.#pending.clear();
					this.#overflow = false;
					if (!this.#runOpen) {
						this.#runOpen = true;
						this.#add({ kind: "run", state: "started" });
					}
				} else if (
					body.event === "turn-completed" ||
					body.event === "turn-interrupted" ||
					body.event === "turn-failed"
				) {
					this.#open = null;
					this.#turn = null;
					this.#pending.clear();
					this.#overflow = false;
					if (this.#runOpen) {
						this.#runOpen = false;
						this.#add({ kind: "run", state: "ended" });
					}
				} else if (body.event === "connection-lost" || body.event === "session-detached") {
					this.#open = null;
					this.#turn = null;
					this.#pending.clear();
					this.#overflow = false;
				}
				return;
			}
			case "native-approval": {
				this.#sawApproval = true;
				return;
			}
			case "transcript": {
				if (body.role !== "user" && body.role !== "assistant") return;
				const itemId = obs.nativeIds.itemId;
				const key = `${itemId ?? "anon"}:${body.contentKind}:${body.reasoningKind ?? "text"}`;
				let from: number | null = null;
				if (body.role === "assistant" && this.#open !== null) {
					if (this.#open.blocks.has(key)) {
						from = this.#open.id;
						this.#open.blocks.delete(key);
						if (this.#open.blocks.size === 0) this.#open = null;
					} else if (body.contentKind === "text") {
						// Clear any matching/anonymous text open block for the same assistant reply.
						for (const [bKey, b] of this.#open.blocks.entries()) {
							if (b.kind === "text") {
								from = this.#open.id;
								this.#open.blocks.delete(bKey);
							}
						}
						if (this.#open.blocks.size === 0) this.#open = null;
					} else {
						// Clear matching itemId or anonymous reasoning open blocks (e.g. summary delta followed by redacted completion).
						const itemPrefix = itemId === null ? "anon:reasoning:" : `${itemId}:reasoning:`;
						for (const [bKey, b] of this.#open.blocks.entries()) {
							if (
								b.kind === "reasoning" &&
								(bKey.startsWith(itemPrefix) || bKey.startsWith("anon:reasoning:"))
							) {
								from = this.#open.id;
								this.#open.blocks.delete(bKey);
							}
						}
						if (this.#open.blocks.size === 0) this.#open = null;
					}
				}
				if (body.contentKind === "text") {
					const raw = body.text ?? "";
					const shown = cut(raw, LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0);
					const truncated = body.truncated || shown.truncated;
					const parts: CodexTranscriptPartV1[] =
						shown.text.length > 0 || truncated ? [{ kind: "text", text: shown.text, truncated }] : [];
					this.#add({
						kind: "message",
						role: body.role,
						parts,
						truncated,
						partsDropped: 0,
						stopReason: body.stopReason === null ? null : body.stopReason.slice(0, 32),
						from,
					});
					return;
				}
				const part = this.#reasoningPart(body.reasoningKind, body.text, body.truncated);
				this.#add({
					kind: "message",
					role: "assistant",
					parts: [part],
					truncated: part.truncated,
					partsDropped: 0,
					stopReason: body.stopReason === null ? null : body.stopReason.slice(0, 32),
					from,
				});
				return;
			}
			case "tool-activity": {
				this.#pushActivity(body, extras?.fileChangeCount ?? null);
				return;
			}
			default:
				return;
		}
	}

	#reasoningPart(
		reasoningKind: EndoAdapterReasoningKindV0 | null,
		text: string | null,
		upstreamTruncated: boolean,
	): Extract<CodexTranscriptPartV1, { kind: "reasoning" }> {
		if (reasoningKind === "redacted") {
			return { kind: "reasoning", state: "withheld", text: "", truncated: false, bytes: 0 };
		}
		const raw = text ?? "";
		if (reasoningKind === "unavailable" || raw.length === 0) {
			return { kind: "reasoning", state: "empty", text: "", truncated: false, bytes: 0 };
		}
		const provenance: "raw-thinking" | "reasoning-summary" =
			reasoningKind === "raw-thinking" ? "raw-thinking" : "reasoning-summary";
		const size = bytes(raw);
		const shown = cut(raw, LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1);
		return {
			kind: "reasoning",
			state: "supplied",
			provenance,
			text: shown.text,
			truncated: upstreamTruncated || shown.truncated,
			bytes: size,
		};
	}

	#pushActivity(
		body: Extract<EndoDevelopObservationV0["body"], { kind: "tool-activity" }>,
		fileChangeCount: number | null,
	): void {
		const callId = safeRef(body.callId);
		const isOpen = body.phase === "started" || body.phase === "updated";
		if (isOpen) this.#sawToolStart = true;
		else this.#sawToolEnd = true;

		const reportedStatus = (
			phase: typeof body.phase,
		): "in-progress" | "completed" | "failed" | "declined" | "unknown" =>
			phase === "started" || phase === "updated" ? "in-progress" : phase;
		const toolStatus = (
			phase: Exclude<typeof body.phase, "declined">,
		): "running" | "completed" | "failed" | "unknown" =>
			phase === "started" || phase === "updated" ? "running" : phase;

		if (body.activityKind === "file-change") {
			this.#sawFileChange = true;
			const status = reportedStatus(body.phase);
			const occurrence = this.#correlate("file-change", callId, "fileChange", isOpen);
			const fields: ActivityField[] =
				fileChangeCount !== null && Number.isSafeInteger(fileChangeCount) && fileChangeCount >= 0
					? [{ label: "Edits", state: "counted", text: String(fileChangeCount) }]
					: [];
			this.#add({
				kind: "file-change",
				source: "codex-live",
				turn: this.#turn,
				category: "file-change",
				occurrence,
				nativeRef: callId,
				status,
				fields,
			});
			return;
		}

		const name = safeActivityName(body.name);
		if (body.activityKind === "subagent-activity") {
			this.#sawSubagent = true;
			const status = reportedStatus(body.phase);
			const occurrence = this.#correlate("activity", callId, name, isOpen);
			this.#add({
				kind: "activity",
				source: "codex-live",
				turn: this.#turn,
				category: "other",
				occurrence,
				name,
				nativeRef: callId,
				status,
				fields: [],
			});
			return;
		}

		if (body.activityKind === "mcp-tool" || body.phase === "declined") {
			const category =
				body.activityKind === "command-execution"
					? "command"
					: body.activityKind === "mcp-tool"
						? "external"
						: "other";
			const status = reportedStatus(body.phase);
			const occurrence = this.#correlate("activity", callId, name, isOpen);
			this.#add({
				kind: "activity",
				source: "codex-live",
				turn: this.#turn,
				category,
				occurrence,
				name,
				nativeRef: callId,
				status,
				fields: [],
			});
			return;
		}

		const category = body.activityKind === "command-execution" ? "command" : "other";
		const status = toolStatus(body.phase);
		const occurrence = this.#correlate("tool", callId, name, isOpen);
		const fields: ActivityField[] =
			!isOpen && body.exitCode !== null && Number.isSafeInteger(body.exitCode)
				? [{ label: "Exit code", state: "reported", text: String(body.exitCode) }]
				: [];
		this.#add({
			kind: "tool",
			source: "codex-live",
			turn: this.#turn,
			category,
			occurrence,
			callId,
			name,
			status,
			fields,
		});
	}

	#correlate(kind: PrivateActivity["kind"], ref: string | null, name: string, isOpen: boolean): number {
		const nextSeq = this.#seq + 1;
		if (this.#overflow || ref === null) return nextSeq;
		const key = JSON.stringify([kind, ref, name]);
		const prior = this.#pending.get(key);
		if (isOpen) {
			if (prior === undefined) {
				if (this.#pending.size >= LIVE_TRANSCRIPT_MAX_ITEMS_V0) {
					this.#pending.clear();
					this.#overflow = true;
				} else {
					this.#pending.set(key, { kind, occurrence: nextSeq });
				}
			} else {
				this.#pending.set(key, null);
			}
			return nextSeq;
		}
		if (prior !== undefined && prior !== null && prior.kind === kind) {
			this.#pending.delete(key);
			return prior.occurrence;
		}
		return nextSeq;
	}

	#add(item: DistributiveOmit<CodexTranscriptItemV0, "seq">): void {
		this.#seq += 1;
		const full = { ...item, seq: this.#seq } as CodexTranscriptItemV0;
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

	#openView(): CodexTranscriptOpenV1 | null {
		const open = this.#open;
		if (open === null || open.blocks.size === 0) return null;
		let textLeft = LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0;
		let reasoningLeft = LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1;
		const parts: CodexTranscriptPartV1[] = [];
		for (const block of open.blocks.values()) {
			if (block.kind === "text") {
				const shown = cut(block.text, textLeft);
				textLeft -= bytes(shown.text);
				parts.push({ kind: "text", text: shown.text, truncated: block.truncated || shown.truncated });
			} else {
				const shown = cut(block.text, reasoningLeft);
				reasoningLeft -= bytes(shown.text);
				parts.push({
					kind: "reasoning",
					state: block.received === 0 ? "empty" : "supplied",
					...(block.provenance === undefined ? {} : { provenance: block.provenance }),
					text: shown.text,
					truncated: block.truncated || shown.truncated,
					bytes: block.received,
				});
			}
		}
		return { id: open.id, afterSeq: open.afterSeq, parts };
	}

	#descriptor(): ActivityDescriptor {
		const d = this.#describe?.();
		return {
			observation: {
				nativeSessionIdentity: d?.session.nativeRef !== null && d !== undefined ? "observed" : "unknown",
				stableCallIdentity: this.#sawToolStart || this.#sawToolEnd ? "observed" : "unknown",
				toolBoundaries: this.#sawToolStart && this.#sawToolEnd ? "observed" : "unknown",
				argumentPreview: "unavailable",
				resultPreview: "unavailable",
				fileChanges: this.#sawFileChange ? "observed" : "unknown",
				subagents: this.#sawSubagent ? "observed" : "unknown",
			},
			providerControls: {
				interrupt: standingToBasis(d?.operations.stop.capability.standing),
				steer: standingToBasis(d?.operations.steer.capability.standing),
				approvals: this.#sawApproval ? "observed" : "assessed",
				toolCancellation: "unavailable",
				resume: "unavailable",
			},
		};
	}

	view(after = 0): CodexTranscriptViewV0 {
		const rest = this.#items.filter((item) => item.seq > after);
		const items: CodexTranscriptItemV0[] = [];
		let pageBytes = 0;
		for (const item of rest) {
			if (items.length >= LIVE_TRANSCRIPT_PAGE_V0) break;
			const size = itemBytes(item);
			if (items.length > 0 && pageBytes + size > LIVE_TRANSCRIPT_PAGE_BYTES_V1) break;
			pageBytes += size;
			items.push(item);
		}
		return {
			descriptor: this.#descriptor(),
			items: items.map((item) =>
				item.kind === "message"
					? { ...item, parts: item.parts.map((part) => ({ ...part })) }
					: item.kind === "tool" || item.kind === "file-change" || item.kind === "activity"
						? { ...item, fields: item.fields.map((f) => ({ ...f })) }
						: { ...item },
			),
			watermark: this.#seq,
			firstSeq: this.#firstSeq,
			evicted: this.#evicted,
			more: rest.length > items.length,
			open: this.#openView(),
			reasoning: { relay: "relayed", reason: null },
		};
	}

	/** Forget all private text immediately and ignore any further events. Idempotent. */
	clear(): void {
		this.#items = [];
		this.#bytes = 0;
		this.#open = null;
		this.#pending.clear();
		this.#cleared = true;
	}

	get watermark(): number {
		return this.#seq;
	}

	get firstSeq(): number {
		return this.#firstSeq;
	}

	get cleared(): boolean {
		return this.#cleared;
	}

	get size(): { items: number; bytes: number } {
		return { items: this.#items.length, bytes: this.#bytes };
	}

	recount(): number {
		return this.#items.reduce((sum, item) => sum + itemBytes(item), 0);
	}
}
