// Reconstructed ACP v2 conversation state, and what it means for a replay to be equivalent to the live session.
//
// ACP v2 sends message and tool-call content as upserts keyed by an identifier, and permits a retained history to be
// replayed as a different update sequence than the live one (a whole-message `agent_message` where the live session
// streamed chunks, an empty message followed by chunks, a repeated upsert). So replay is judged on the state the updates
// reconstruct, never on the update bytes. The state lives in memory only: events carry digests and counts, never text.
//
// Application rules, all from the baseline schema's own descriptions, in the order updates are received:
//   * `<kind>_message_chunk {messageId, content}`  appends one content block to that message;
//   * `<kind>_message {messageId, content?}`       is an upsert: an array REPLACES the whole content (chunks received
//     earlier included), `null` clears it, an omitted `content` leaves it unchanged; a new id with no content is empty;
//   * a `messageId` names one message of one kind; it cannot be a user message and later an agent message;
//   * `tool_call_update` patches the call: omitted fields unchanged, `null` clears, a concrete value replaces,
//     `content: []` and `content: null` both clear; `tool_call_content_chunk` appends one content item.
//
// Replay equivalence (compareAcpV2ReplayV0): the replay is equivalent to the live session iff
//   1. neither reconstruction recorded a contradiction or hit a bound (an unreliable state claims nothing);
//   2. every message the replay reconstructs also exists in the live reconstruction, with the same kind and the same
//      canonical content (a replay may not invent a message, change its kind, or change its content);
//   3. the replayed messages appear in the live session's first-appearance order;
//   4. every tool call the replay reconstructs exists live with an identical reconstructed record.
// Messages and tool calls the live session had and the replay lacks are allowed: ACP does not require an agent to retain
// everything (live-only messages, such as locally handled commands, may be absent from replay). They are reported, not
// failed. The comparison says nothing about messages absent from both.

import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { opaqueIdRefV0 } from "./translate.ts";

export type AcpV2MessageKindV0 = "user" | "agent" | "thought";

const MESSAGE_VARIANTS: Readonly<Record<string, { kind: AcpV2MessageKindV0; chunk: boolean }>> = {
	user_message_chunk: { kind: "user", chunk: true },
	user_message: { kind: "user", chunk: false },
	agent_message_chunk: { kind: "agent", chunk: true },
	agent_message: { kind: "agent", chunk: false },
	agent_thought_chunk: { kind: "thought", chunk: true },
	agent_thought: { kind: "thought", chunk: false },
};

/** Bounds on what one reconstruction keeps. Past them it stops applying and claims nothing. */
export const ACP_V2_CONVERSATION_LIMITS_V0 = Object.freeze({
	messages: 4096,
	toolCalls: 4096,
	contentItems: 65_536,
	/** The serialized size of everything retained (content blocks, tool-call fields), in UTF-16 code units. */
	retainedChars: 16 * 1024 * 1024,
});

/** The serialized size of a baseline-valid value (JSON, so it always serializes). */
const sizeOf = (value: unknown): number => JSON.stringify(value)?.length ?? 0;

interface MessageState {
	readonly kind: AcpV2MessageKindV0;
	content: unknown[];
	/** What `content` is charged against the retention budget. */
	chars: number;
}

const TOOL_FIELDS = ["name", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput"] as const;

export interface AcpV2StateDigestV0 {
	/** In first-appearance order. */
	readonly messages: ReadonlyArray<{
		readonly id: string;
		readonly kind: AcpV2MessageKindV0;
		readonly contentSha256: string;
	}>;
	readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly recordSha256: string }>;
	/** Contradictions seen (one per occurrence, bounded). A non-empty list means the state is not reliable. */
	readonly conflicts: readonly string[];
	/** A bound was reached: updates after it were not applied. */
	readonly truncated: boolean;
}

export type AcpV2ApplyV0 = { readonly applied: true } | { readonly applied: false; readonly problem: string };

export class AcpV2ConversationV0 {
	readonly #messages = new Map<string, MessageState>();
	readonly #toolCalls = new Map<string, Record<string, unknown>>();
	readonly #conflicts: string[] = [];
	#items = 0;
	#chars = 0;
	// What each tool call's retained fields are charged, by field.
	readonly #toolChars = new Map<string, Record<string, number>>();
	#truncated = false;

	/** Whether `update` is one this reconstruction consumes (a message, thought or tool-call content variant). */
	static consumes(variant: string): boolean {
		return variant in MESSAGE_VARIANTS || variant === "tool_call_update" || variant === "tool_call_content_chunk";
	}

	#conflict(problem: string): AcpV2ApplyV0 {
		if (this.#conflicts.length < 32) this.#conflicts.push(problem);
		return { applied: false, problem };
	}

	#room(count: number): boolean {
		if (this.#items + count > ACP_V2_CONVERSATION_LIMITS_V0.contentItems) {
			this.#truncated = true;
			return false;
		}
		this.#items += count;
		return true;
	}

	/** Charge `size` more characters; false (and truncated) when that would pass the retention budget. */
	#spend(size: number): boolean {
		if (this.#chars + size > ACP_V2_CONVERSATION_LIMITS_V0.retainedChars) {
			this.#truncated = true;
			return false;
		}
		this.#chars += size;
		return true;
	}

	/** Apply one baseline-valid `session/update` update, in the order received. */
	apply(update: Record<string, unknown>): AcpV2ApplyV0 {
		const variant = String(update.sessionUpdate);
		const message = MESSAGE_VARIANTS[variant];
		if (message !== undefined) return this.#applyMessage(update, message.kind, message.chunk);
		if (variant === "tool_call_update") return this.#applyToolCall(update);
		if (variant === "tool_call_content_chunk") return this.#applyToolChunk(update);
		return { applied: false, problem: "not-reconstructed" };
	}

	#applyMessage(update: Record<string, unknown>, kind: AcpV2MessageKindV0, chunk: boolean): AcpV2ApplyV0 {
		const id = String(update.messageId);
		let state = this.#messages.get(id);
		if (state !== undefined && state.kind !== kind)
			return this.#conflict(
				`message ${opaqueIdRefV0(id)} is a ${state.kind} message and was then updated as a ${kind} message`,
			);
		if (state === undefined) {
			if (this.#messages.size >= ACP_V2_CONVERSATION_LIMITS_V0.messages) {
				this.#truncated = true;
				return { applied: false, problem: "message-limit" };
			}
			state = { kind, content: [], chars: 0 };
			this.#messages.set(id, state);
		}
		if (chunk) {
			const size = sizeOf(update.content);
			if (!this.#room(1)) return { applied: false, problem: "content-limit" };
			if (!this.#spend(size)) {
				this.#items -= 1;
				return { applied: false, problem: "content-limit" };
			}
			state.content.push(structuredClone(update.content));
			state.chars += size;
			return { applied: true };
		}
		if (!Object.hasOwn(update, "content")) return { applied: true };
		const replacement = update.content === null ? [] : (update.content as unknown[]);
		this.#items -= state.content.length;
		this.#chars -= state.chars;
		state.chars = 0;
		const size = sizeOf(replacement);
		if (!this.#room(replacement.length)) {
			state.content = [];
			return { applied: false, problem: "content-limit" };
		}
		if (!this.#spend(size)) {
			this.#items -= replacement.length;
			state.content = [];
			return { applied: false, problem: "content-limit" };
		}
		state.content = structuredClone(replacement);
		state.chars = size;
		return { applied: true };
	}

	#call(id: string): Record<string, unknown> | undefined {
		let call = this.#toolCalls.get(id);
		if (call === undefined) {
			if (this.#toolCalls.size >= ACP_V2_CONVERSATION_LIMITS_V0.toolCalls) {
				this.#truncated = true;
				return undefined;
			}
			call = {};
			this.#toolCalls.set(id, call);
		}
		return call;
	}

	#applyToolCall(update: Record<string, unknown>): AcpV2ApplyV0 {
		const call = this.#call(String(update.toolCallId));
		if (call === undefined) return { applied: false, problem: "tool-call-limit" };
		const id = String(update.toolCallId);
		const chars = this.#toolChars.get(id) ?? {};
		this.#toolChars.set(id, chars);
		let applied = true;
		for (const field of TOOL_FIELDS) {
			if (!Object.hasOwn(update, field)) continue;
			const value = update[field];
			const collection = field === "content" || field === "locations";
			if (collection) this.#items -= Array.isArray(call[field]) ? (call[field] as unknown[]).length : 0;
			this.#chars -= chars[field] ?? 0;
			delete chars[field];
			// `null` (and `[]` for a collection) clears the field.
			if (value === null || (collection && Array.isArray(value) && value.length === 0)) {
				delete call[field];
				continue;
			}
			const size = sizeOf(value);
			if (collection && !this.#room((value as unknown[]).length)) {
				delete call[field];
				applied = false;
			} else if (!this.#spend(size)) {
				if (collection) this.#items -= (value as unknown[]).length;
				delete call[field];
				applied = false;
			} else {
				call[field] = structuredClone(value);
				chars[field] = size;
			}
		}
		return applied ? { applied: true } : { applied: false, problem: "content-limit" };
	}

	#applyToolChunk(update: Record<string, unknown>): AcpV2ApplyV0 {
		const call = this.#call(String(update.toolCallId));
		if (call === undefined) return { applied: false, problem: "tool-call-limit" };
		const size = sizeOf(update.content);
		if (!this.#room(1)) return { applied: false, problem: "content-limit" };
		if (!this.#spend(size)) {
			this.#items -= 1;
			return { applied: false, problem: "content-limit" };
		}
		const content = Array.isArray(call.content) ? (call.content as unknown[]) : [];
		content.push(structuredClone(update.content));
		call.content = content;
		const chars = this.#toolChars.get(String(update.toolCallId)) ?? {};
		chars.content = (chars.content ?? 0) + size;
		this.#toolChars.set(String(update.toolCallId), chars);
		return { applied: true };
	}

	/** Whether a message of this kind has been reconstructed under this id. */
	hasMessage(id: string, kind: AcpV2MessageKindV0): boolean {
		return this.#messages.get(id)?.kind === kind;
	}

	/** Digests of what has been reconstructed. Never the content. */
	digest(): AcpV2StateDigestV0 {
		const conflicts = [...this.#conflicts];
		const hash = (value: unknown): string => {
			try {
				return sha256HexV0(canonicalEndoJsonV0(value as Parameters<typeof canonicalEndoJsonV0>[0]));
			} catch {
				if (conflicts.length < 32) conflicts.push("content is not canonical JSON");
				return "unhashable";
			}
		};
		return {
			messages: [...this.#messages].map(([id, state]) => ({
				id: opaqueIdRefV0(id) as string,
				kind: state.kind,
				contentSha256: hash(state.content),
			})),
			toolCalls: [...this.#toolCalls].map(([id, call]) => ({
				id: opaqueIdRefV0(id) as string,
				recordSha256: hash(call),
			})),
			conflicts,
			truncated: this.#truncated,
		};
	}
}

export interface AcpV2ReplayComparisonV0 {
	readonly equivalent: boolean;
	/** Why not, when not equivalent. */
	readonly reasons: readonly string[];
	/** Live messages and tool calls the replay does not carry (allowed; reported). */
	readonly liveOnly: { readonly messages: readonly string[]; readonly toolCalls: readonly string[] };
}

/** Whether a replay's reconstructed state is equivalent to the live session's (rules at the top of this module). */
export function compareAcpV2ReplayV0(live: AcpV2StateDigestV0, replay: AcpV2StateDigestV0): AcpV2ReplayComparisonV0 {
	const reasons: string[] = [];
	if (live.conflicts.length > 0) reasons.push("the live reconstruction recorded a contradiction");
	if (replay.conflicts.length > 0) reasons.push("the replay reconstruction recorded a contradiction");
	if (live.truncated) reasons.push("the live reconstruction hit a bound");
	if (replay.truncated) reasons.push("the replay reconstruction hit a bound");
	const liveMessages = new Map(live.messages.map((message, index) => [message.id, { ...message, index }]));
	let previous = -1;
	for (const message of replay.messages) {
		const original = liveMessages.get(message.id);
		if (original === undefined) reasons.push(`replayed message ${message.id} was never in the live session`);
		else {
			if (original.kind !== message.kind) reasons.push(`replayed message ${message.id} changed kind`);
			if (original.contentSha256 !== message.contentSha256)
				reasons.push(`replayed message ${message.id} changed content`);
			if (original.index < previous) reasons.push(`replayed message ${message.id} is out of the live order`);
			previous = Math.max(previous, original.index);
		}
	}
	const liveCalls = new Map(live.toolCalls.map((call) => [call.id, call.recordSha256]));
	for (const call of replay.toolCalls) {
		const original = liveCalls.get(call.id);
		if (original === undefined) reasons.push(`replayed tool call ${call.id} was never in the live session`);
		else if (original !== call.recordSha256)
			reasons.push(`replayed tool call ${call.id} differs from the live record`);
	}
	const replayedMessages = new Set(replay.messages.map((message) => message.id));
	const replayedCalls = new Set(replay.toolCalls.map((call) => call.id));
	return {
		equivalent: reasons.length === 0,
		reasons,
		liveOnly: {
			messages: live.messages.filter((message) => !replayedMessages.has(message.id)).map((message) => message.id),
			toolCalls: live.toolCalls.filter((call) => !replayedCalls.has(call.id)).map((call) => call.id),
		},
	};
}
