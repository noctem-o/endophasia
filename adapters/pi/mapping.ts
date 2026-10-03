// The Pi RPC → endo.* mapping (PI_MAPPING_VERSION). Two inputs, two identity rules:
//
// - Durable session entries (get_entries, and entry_appended events, which carry a persisted entry) become
//   `session.entry-observed` events whose id is derived from Pi's session id and Pi's entry id. The same entry always
//   maps to the same event id, so a catch-up after a reconnect cannot duplicate an entry the store already holds. Pi's
//   ids stay opaque (endo.source-entry-ref.v0): never parsed, ordered or converted.
// - Live session events (agent_start, tool_execution_end, ...) are observations of one process's stream. Pi does not
//   replay them, so they get ids scoped to the process instance that observed them; a gap between two instances is
//   recorded explicitly (harness.process-exited, harness.attached), never papered over.
//
// Payloads are minimal: no message text, tool arguments or results, queued text, summaries or Pi refusal text ever
// cross into an event. The one runtime-written text kept is a failure's reported cause (an assistant message's
// `errorMessage` when its stopReason is "error", a final retry's `finalError`, a failed compaction's `errorMessage`),
// bounded to 512 characters, because a failure recorded without Pi's own cause would leave the cause to be inferred. Pi supplies no run, turn or operation identity: none is invented. The only coordinate set is
// the session, a namespaced copy of the session id Pi reported.

import type { EndoEventV0 } from "../../protocol/event.ts";
import { validateEndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { PiSessionEntryV0 } from "./rpc.ts";

/** What the mapping needs from the attachment: identities, the producer's sequence, and the clock. */
export interface PiMappingContextV0 {
	readonly attachment: string;
	/** The session id Pi reported (get_state), or null before it is known. */
	readonly piSessionId: string | null;
	/** The live-stream instance: one per launched Pi process. */
	readonly instance: string;
	/** The producer name events carry. */
	readonly producer: string;
	/** The next producer sequence (monotonic in this producer's stream). */
	nextSequence(): number;
	/** The next live-event number within this instance. */
	nextLive(): number;
	/** The emission time, ISO-8601 UTC. */
	now(): string;
}

/** Live event types that are streaming deltas: counted, never stored. */
export const PI_DELTA_EVENT_TYPES_V0: readonly string[] = Object.freeze([
	"message_start",
	"message_update",
	"tool_execution_update",
	"bash_execution_update",
]);

const LOCAL = /^[A-Za-z0-9._-]{1,200}$/;

/** The endo session coordinate for a Pi session id: `endo.session.pi.<id>`, or a digest when the id is not in grammar. */
export function piEndoSessionIdV0(piSessionId: string): string {
	return LOCAL.test(piSessionId)
		? `endo.session.pi.${piSessionId}`
		: `endo.session.pi.sha256-${sha256HexV0(piSessionId).slice(0, 48)}`;
}

/** The event id of one Pi entry in one Pi session: stable across processes, so catch-up deduplicates by id. */
export function piEntryEventIdV0(piSessionId: string, entryId: string): string {
	return `endo.event.pi-entry.${sha256HexV0(`${piSessionId}\u0000${entryId}`).slice(0, 48)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function short(value: unknown, max = 128): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** The usage numbers of a Pi Usage object, or undefined when it is not one. Never the content around it. */
export function piUsageV0(value: unknown): Record<string, JsonValueV0> | undefined {
	if (!isRecord(value)) return undefined;
	const input = finite(value.input);
	const output = finite(value.output);
	const cacheRead = finite(value.cacheRead);
	const cacheWrite = finite(value.cacheWrite);
	const totalTokens = finite(value.totalTokens);
	const cost = isRecord(value.cost) ? finite(value.cost.total) : undefined;
	if ([input, output, cacheRead, cacheWrite, totalTokens].some((part) => part === undefined)) return undefined;
	const usage: Record<string, JsonValueV0> = {
		input: input!,
		output: output!,
		cacheRead: cacheRead!,
		cacheWrite: cacheWrite!,
		totalTokens: totalTokens!,
	};
	if (cost !== undefined) usage.costTotal = cost;
	const reasoning = finite(value.reasoning);
	if (reasoning !== undefined) usage.reasoning = reasoning;
	return usage;
}

function compact(fields: Record<string, JsonValueV0 | undefined>): Record<string, JsonValueV0> {
	const out: Record<string, JsonValueV0> = {};
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
	return out;
}

/** Payload-minimal details of one entry, by its documented type. Unknown types keep only their type. */
function entryDetails(entry: PiSessionEntryV0): { recognized: boolean; details: Record<string, JsonValueV0> } {
	const raw = entry.raw;
	switch (entry.type) {
		case "message": {
			const message = isRecord(raw.message) ? raw.message : {};
			return {
				recognized: true,
				details: compact({
					role: short(message.role, 32),
					stopReason: short(message.stopReason, 32),
					provider: short(message.provider),
					model: short(message.model),
					usage: piUsageV0(message.usage),
				}),
			};
		}
		case "model_change":
			return { recognized: true, details: compact({ provider: short(raw.provider), modelId: short(raw.modelId) }) };
		case "thinking_level_change":
			return { recognized: true, details: compact({ thinkingLevel: short(raw.thinkingLevel, 32) }) };
		case "compaction":
			return {
				recognized: true,
				details: compact({
					firstKeptEntryId: short(raw.firstKeptEntryId, 256),
					tokensBefore: finite(raw.tokensBefore),
					hasSummary: typeof raw.summary === "string" && raw.summary.length > 0,
					usage: piUsageV0(raw.usage),
				}),
			};
		case "branch_summary":
			return {
				recognized: true,
				details: compact({
					fromId: short(raw.fromId, 256),
					hasSummary: typeof raw.summary === "string" && raw.summary.length > 0,
					usage: piUsageV0(raw.usage),
				}),
			};
		case "usage":
			return {
				recognized: true,
				details: compact({
					usageKind: short(raw.kind, 64),
					provider: short(raw.provider),
					model: short(raw.model),
					usage: piUsageV0(raw.usage),
				}),
			};
		case "custom":
		case "custom_message":
		case "context_edit":
		case "session_info":
		case "label":
			return { recognized: true, details: {} };
		default:
			return { recognized: false, details: {} };
	}
}

function build(
	context: PiMappingContextV0,
	id: string,
	kind: string,
	payload: Record<string, JsonValueV0>,
): EndoEventV0 {
	const event = {
		schemaVersion: "endo.event.v0" as const,
		id,
		kind,
		source: "runtime-fact" as const,
		sequence: context.nextSequence(),
		at: context.now(),
		coordinates: context.piSessionId === null ? {} : { sessionId: piEndoSessionIdV0(context.piSessionId) },
		producer: context.producer,
		derivedFrom: [],
		payload,
	};
	const validated = validateEndoEventV0(event);
	if (validated === null) throw new TypeError(`the mapped ${kind} event failed endo.event.v0 validation`);
	return validated;
}

/** Map one durable Pi session entry. Requires the Pi session id (entries are meaningless without their session). */
export function mapPiEntryV0(context: PiMappingContextV0, entry: PiSessionEntryV0): EndoEventV0 {
	if (context.piSessionId === null) throw new TypeError("a Pi entry cannot be mapped before the session id is known");
	const { recognized, details } = entryDetails(entry);
	return build(context, piEntryEventIdV0(context.piSessionId, entry.id), "session.entry-observed", {
		source: {
			schemaVersion: "endo.source-entry-ref.v0",
			runtime: "pi",
			sessionId: context.piSessionId,
			entryId: entry.id,
		},
		entryType: entry.type.slice(0, 64),
		recognized,
		parentId: entry.parentId,
		runtimeTimestamp: entry.timestamp.slice(0, 64),
		details,
	});
}

/** An event the attachment itself observed (process lifecycle, catch-up, controls). */
export function mapAttachmentEventV0(
	context: PiMappingContextV0,
	kind: string,
	payload: Record<string, JsonValueV0>,
): EndoEventV0 {
	return build(context, `endo.event.pi-live.${context.instance}.${context.nextLive()}`, kind, payload);
}

/** The result of mapping one live event: an event, a counted delta, or an entry to route through mapPiEntryV0. */
export type PiLiveMappingV0 =
	| { readonly kind: "event"; readonly event: EndoEventV0 }
	| { readonly kind: "delta"; readonly type: string }
	| { readonly kind: "entry"; readonly entry: PiSessionEntryV0 };

const LIVE_KINDS: Readonly<Record<string, string>> = {
	agent_start: "agent.run-started",
	agent_end: "agent.run-ended",
	agent_settled: "agent.settled",
	turn_start: "agent.turn-started",
	turn_end: "agent.turn-finished",
	message_end: "message.completed",
	tool_execution_start: "tool.started",
	tool_execution_end: "tool.finished",
	queue_update: "queue.changed",
	compaction_start: "compaction.started",
	compaction_end: "compaction.finished",
	auto_retry_start: "retry.started",
	auto_retry_end: "retry.finished",
	thinking_level_changed: "config.thinking-changed",
	session_info_changed: "session.info-changed",
	extension_ui_request: "extension.ui-requested",
};

/** An assistant message's reported failure cause: its errorMessage, only when its stopReason is "error". */
function reportedCause(message: Record<string, unknown>): string | undefined {
	return message.stopReason === "error" ? short(message.errorMessage, 512) : undefined;
}

function livePayload(type: string, record: Readonly<Record<string, unknown>>): Record<string, JsonValueV0> {
	switch (type) {
		case "agent_end":
			return compact({ willRetry: typeof record.willRetry === "boolean" ? record.willRetry : undefined });
		case "turn_end": {
			const message = isRecord(record.message) ? record.message : {};
			return compact({
				stopReason: short(message.stopReason, 32),
				errorMessage: reportedCause(message),
				toolResultCount: Array.isArray(record.toolResults) ? record.toolResults.length : undefined,
			});
		}
		case "message_end": {
			const message = isRecord(record.message) ? record.message : {};
			return compact({
				role: short(message.role, 32),
				stopReason: short(message.stopReason, 32),
				errorMessage: reportedCause(message),
				usage: piUsageV0(message.usage),
			});
		}
		case "tool_execution_start":
			return compact({ toolCallId: short(record.toolCallId, 256), toolName: short(record.toolName) });
		case "tool_execution_end":
			return compact({
				toolCallId: short(record.toolCallId, 256),
				toolName: short(record.toolName),
				isError: typeof record.isError === "boolean" ? record.isError : undefined,
			});
		case "queue_update":
			return compact({
				steering: Array.isArray(record.steering) ? record.steering.length : undefined,
				followUp: Array.isArray(record.followUp) ? record.followUp.length : undefined,
			});
		case "compaction_start":
			return compact({ reason: short(record.reason, 32) });
		case "compaction_end": {
			const result = isRecord(record.result) ? record.result : undefined;
			return compact({
				reason: short(record.reason, 32),
				aborted: typeof record.aborted === "boolean" ? record.aborted : undefined,
				willRetry: typeof record.willRetry === "boolean" ? record.willRetry : undefined,
				succeeded: result !== undefined,
				firstKeptEntryId: result === undefined ? undefined : short(result.firstKeptEntryId, 256),
				tokensBefore: result === undefined ? undefined : finite(result.tokensBefore),
				errorMessage: result === undefined && record.aborted !== true ? short(record.errorMessage, 512) : undefined,
			});
		}
		case "auto_retry_start":
			return compact({ attempt: finite(record.attempt), maxAttempts: finite(record.maxAttempts) });
		case "auto_retry_end":
			return compact({
				attempt: finite(record.attempt),
				success: typeof record.success === "boolean" ? record.success : undefined,
				finalError: record.success === false ? short(record.finalError, 512) : undefined,
			});
		case "thinking_level_changed":
			return compact({ level: short(record.level, 32) });
		case "session_info_changed":
			return { named: typeof record.name === "string" };
		case "extension_ui_request":
			return compact({ method: short(record.method, 32) });
		default:
			return {};
	}
}

/** Map one live Pi event. Unknown event types are recorded by name only, never dropped silently. */
export function mapPiLiveEventV0(
	context: PiMappingContextV0,
	type: string,
	record: Readonly<Record<string, unknown>>,
): PiLiveMappingV0 {
	if (PI_DELTA_EVENT_TYPES_V0.includes(type)) return { kind: "delta", type };
	if (type === "entry_appended" && isRecord(record.entry)) {
		const entry = record.entry;
		if (
			typeof entry.type === "string" &&
			typeof entry.id === "string" &&
			entry.id.length > 0 &&
			(entry.parentId === null || typeof entry.parentId === "string") &&
			typeof entry.timestamp === "string"
		) {
			return {
				kind: "entry",
				entry: {
					type: entry.type,
					id: entry.id,
					parentId: entry.parentId as string | null,
					timestamp: entry.timestamp,
					raw: entry,
				},
			};
		}
	}
	if (type === "entry_appended") {
		// A documented event without the documented entry: recorded as malformed, never as an entry.
		return {
			kind: "event",
			event: mapAttachmentEventV0(context, "runtime.malformed-event", { runtimeEvent: type }),
		};
	}
	const kind = LIVE_KINDS[type];
	if (kind === undefined) {
		const name = /^[A-Za-z0-9_.-]{1,128}$/.test(type) ? type : "unprintable";
		return {
			kind: "event",
			event: mapAttachmentEventV0(context, "runtime.unrecognized-event", { runtimeEvent: name }),
		};
	}
	return {
		kind: "event",
		event: mapAttachmentEventV0(context, kind, { runtimeEvent: type, ...livePayload(type, record) }),
	};
}
