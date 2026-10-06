// The ACP v1 -> endo.* translation (ACP_MAPPING_VERSION). ACP types stop here: this module reads `unknown` runtime
// values and produces `endo.event.v0` events; nothing under protocol/ or runtime/ knows ACP exists.
//
// Two streams, as for the Pi attachment:
// - recorded events (producer `acp-adapter:<attachment>`, source "runtime-fact" unless noted): what the adapter
//   observed or what the agent reported, named by the Pi adapter's kinds where the meaning is the same
//   (harness.attached, harness.process-exited, control.requested, runtime.unrecognized-event, ...);
// - lifecycle events (producer `acp-lifecycle:<attachment>`, source "interpretation"): canonical `lifecycle.*` events
//   (protocol/session-lifecycle.ts), each derived from one recorded event, with deterministic ids.
//
// Payloads are minimal. No prompt text, message or thought text, tool title, tool input or output, plan text, or
// permission option label ever enters an event: ACP carries them in the same updates this module reads, so only the
// update's variant, a bounded identifier, a status and counts are kept. Streaming chunks are counted, not stored.
// A `session/update` variant this version does not translate is recorded by name (`runtime.unrecognized-event`),
// never dropped.
//
// What ACP v1 does not report is declared UNAVAILABLE (ACP_LIFECYCLE_UNAVAILABLE_V0). A field the agent did not send is
// absent or UNAVAILABLE, never zero or false.

import type { EndoEventV0 } from "../../protocol/event.ts";
import { validateEndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	type EndoLifecycleKindV0,
	type EndoUnavailableFieldV0,
	endoReportedV0,
} from "../../protocol/session-lifecycle.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

export const ACP_MAPPING_VERSION = "acp-v1-mapping.1";

export const ACP_RECORDING_PRODUCER_PREFIX_V0 = "acp-adapter:";
export const ACP_LIFECYCLE_PRODUCER_PREFIX_V0 = "acp-lifecycle:";

/** What ACP v1 does not tell a client, declared on every session start. */
export const ACP_LIFECYCLE_UNAVAILABLE_V0: readonly EndoUnavailableFieldV0[] = Object.freeze([
	{ field: "run.id", reason: "ACP v1 prompt turns carry no run identifier; session/prompt is the only turn handle" },
	{ field: "turn.id", reason: "ACP v1 reports no turn identifier inside a prompt turn" },
	{
		field: "turns",
		reason:
			"ACP v1 reports no turn count: lifecycle payloads omit `turns` and `turnOpen`, and the session overview's turn count (0 for want of any) is not a count",
	},
	{
		field: "run.start",
		reason: "ACP v1 has no run-start notification; the run start is the client's own prompt request",
	},
	{
		field: "operation.outcome",
		reason: "ACP v1 reports a stopReason on the session/prompt response and no durable operation outcome",
	},
	{ field: "stop.target", reason: "session/cancel names the session, not one prompt turn" },
	{ field: "usage", reason: "not read by this adapter version" },
	{ field: "lanes", reason: "ACP v1 exposes one session per session/new and no lanes" },
]);

/** The ACP v1 stop reasons: the closed vocabulary of the session/prompt response. */
export const ACP_STOP_REASONS_V0 = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;
export type AcpStopReasonV0 = (typeof ACP_STOP_REASONS_V0)[number];

export function isAcpStopReasonV0(value: unknown): value is AcpStopReasonV0 {
	return typeof value === "string" && (ACP_STOP_REASONS_V0 as readonly string[]).includes(value);
}

/** Streaming chunks: counted, never stored. */
const DELTA_VARIANTS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

const LOCAL = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * The endo session coordinate for an ACP session: `endo.session.acp.<instance>.<id>`, the id replaced by a digest when
 * it is not in grammar. ACP session ids are agent-local and unique to nothing but the agent that issued them (two
 * launches of one agent, or two agents, can issue the same one), so the coordinate carries the process instance.
 */
export function acpEndoSessionIdV0(instance: string, acpSessionId: string): string {
	const local = LOCAL.test(acpSessionId) ? acpSessionId : `sha256-${sha256HexV0(acpSessionId).slice(0, 48)}`;
	return `endo.session.acp.${instance}.${local}`;
}

/**
 * The session id as evidence carries it, in both the recorded and the lifecycle event: the id itself when it is short
 * and printable, else a digest of it. One rule, so the lifecycle can be rebuilt from the recording.
 */
export function acpSessionRefV0(acpSessionId: string): string {
	return /^[\x21-\x7e]{1,256}$/.test(acpSessionId) ? acpSessionId : `sha256-${sha256HexV0(acpSessionId).slice(0, 48)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bounded printable string, or undefined. Anything else (a long or odd string) is not carried. */
export function shortText(value: unknown, max = 128): string | undefined {
	return typeof value === "string" && /^[\x21-\x7e]{1,}$/.test(value) && value.length <= max ? value : undefined;
}

/**
 * An opaque identifier the agent chose (ACP types a tool call id as an unconstrained string): itself when short and
 * printable, else a digest of it, so two events about one call still correlate. Undefined when it is not a string.
 */
export function opaqueIdRefV0(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return shortText(value) ?? `sha256-${sha256HexV0(value).slice(0, 48)}`;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact(fields: Record<string, JsonValueV0 | undefined>): Record<string, JsonValueV0> {
	const out: Record<string, JsonValueV0> = {};
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
	return out;
}

const isText = (value: unknown): value is string => typeof value === "string";

/** An ACP v1 ContentBlock: a closed union by `type`, each with its required fields. */
function isContentBlock(value: unknown): boolean {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "text":
			return isText(value.text);
		case "image":
		case "audio":
			return isText(value.data) && isText(value.mimeType);
		case "resource_link":
			return isText(value.name) && isText(value.uri);
		case "resource":
			// TextResourceContents or BlobResourceContents.
			return (
				isRecord(value.resource) &&
				isText(value.resource.uri) &&
				(isText(value.resource.text) || isText(value.resource.blob))
			);
		default:
			return false;
	}
}

/** An ACP v1 SessionConfigOption: a select (string current value, options) or a boolean (boolean current value). */
function isConfigOption(option: unknown): boolean {
	if (!isRecord(option) || !isText(option.id) || !isText(option.name)) return false;
	if (option.type === "select") return isText(option.currentValue) && Array.isArray(option.options);
	if (option.type === "boolean") return typeof option.currentValue === "boolean";
	return false;
}

const PLAN_PRIORITIES = ["high", "medium", "low"];
const PLAN_STATUSES = ["pending", "in_progress", "completed"];

/**
 * Whether a recognized variant carries what ACP v1 requires of it, nested fields included. These updates are taken
 * off the SDK stream before its schema router, so nothing else validates them. Variants this module does not
 * recognize pass: they are recorded by name, not read.
 */
function hasRequiredFields(variant: string, update: Record<string, unknown>): boolean {
	switch (variant) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
		case "user_message_chunk":
			return isContentBlock(update.content);
		case "tool_call":
			return isText(update.toolCallId) && isText(update.title);
		case "tool_call_update":
			return isText(update.toolCallId);
		case "plan":
			return (
				Array.isArray(update.entries) &&
				update.entries.every(
					(entry) =>
						isRecord(entry) &&
						isText(entry.content) &&
						PLAN_PRIORITIES.includes(entry.priority as string) &&
						PLAN_STATUSES.includes(entry.status as string),
				)
			);
		case "available_commands_update":
			return (
				Array.isArray(update.availableCommands) &&
				update.availableCommands.every(
					(command) => isRecord(command) && isText(command.name) && isText(command.description),
				)
			);
		case "current_mode_update":
			return isText(update.currentModeId);
		case "config_option_update":
			return Array.isArray(update.configOptions) && update.configOptions.every(isConfigOption);
		case "usage_update":
			return finite(update.used) !== undefined && finite(update.size) !== undefined;
		default:
			return true;
	}
}

/** The clock and counters the recorded stream of one launched agent process needs. */
export interface AcpRecorderOptionsV0 {
	readonly attachment: string;
	/** One per launched agent process. */
	readonly instance: string;
	readonly now: () => string;
	readonly onEvent: (event: EndoEventV0) => void;
}

/** Builds and emits the two event streams of one attachment. The only thing here that is not pure is `onEvent`. */
export class AcpRecorderV0 {
	readonly #options: AcpRecorderOptionsV0;
	#sessionId: string | null = null;
	#sequence = 0;
	#live = 0;
	#lifecycle = 0;

	constructor(options: AcpRecorderOptionsV0) {
		this.#options = options;
	}

	get instance(): string {
		return this.#options.instance;
	}

	/** The session coordinate every later event carries. */
	setSession(acpSessionId: string): void {
		this.#sessionId = acpEndoSessionIdV0(this.#options.instance, acpSessionId);
	}

	#emit(event: Record<string, unknown>): EndoEventV0 {
		const validated = validateEndoEventV0(event);
		if (validated === null)
			throw new TypeError(`the mapped ${String(event.kind)} event failed endo.event.v0 validation`);
		this.#options.onEvent(validated);
		return validated;
	}

	/** A recorded event: something the adapter observed or the agent reported. */
	record(
		kind: string,
		payload: Record<string, JsonValueV0>,
		source: "runtime-fact" | "authority-decision" = "runtime-fact",
		derivedFrom: readonly string[] = [],
	): EndoEventV0 {
		this.#live += 1;
		this.#sequence += 1;
		return this.#emit({
			schemaVersion: "endo.event.v0",
			id: `endo.event.acp-live.${this.#options.instance}.${this.#live}`,
			kind,
			source,
			sequence: this.#sequence,
			at: this.#options.now(),
			coordinates: this.#sessionId === null ? {} : { sessionId: this.#sessionId },
			producer: `${ACP_RECORDING_PRODUCER_PREFIX_V0}${this.#options.attachment}`,
			derivedFrom: [...derivedFrom],
			payload,
		});
	}

	/** A lifecycle interpretation of one recorded event. Same recorded event and kind, same id. */
	derive(kind: EndoLifecycleKindV0, payload: Record<string, JsonValueV0>, from: EndoEventV0, index = 0): EndoEventV0 {
		this.#lifecycle += 1;
		return this.#emit({
			schemaVersion: "endo.event.v0",
			id: `endo.event.acp-lifecycle.${sha256HexV0(`${from.id}\u0000${kind}\u0000${index}`).slice(0, 48)}`,
			kind,
			source: "interpretation",
			sequence: this.#lifecycle,
			at: from.at,
			coordinates: { ...from.coordinates },
			producer: `${ACP_LIFECYCLE_PRODUCER_PREFIX_V0}${this.#options.attachment}`,
			derivedFrom: [from.id],
			payload,
		});
	}
}

/** The result of translating one `session/update` notification's params. */
export type AcpUpdateTranslationV0 =
	| { readonly kind: "delta"; readonly variant: string }
	/** Not counted: a recognized variant missing what it requires, or no variant at all. */
	| { readonly kind: "malformed"; readonly variant: string; readonly payload: Record<string, JsonValueV0> }
	| {
			readonly kind: "event";
			readonly variant: string;
			readonly eventKind: string;
			readonly payload: Record<string, JsonValueV0>;
	  };

/**
 * Translate the `update` of one `session/update` notification. `params` is whatever the agent sent: it is not
 * assumed to match any schema. A variant this version does not translate becomes `runtime.unrecognized-event`, a
 * non-object or variant-less update becomes `runtime.malformed-event`; neither is dropped.
 */
export function translateAcpUpdateV0(update: unknown): AcpUpdateTranslationV0 {
	if (!isRecord(update) || typeof update.sessionUpdate !== "string") {
		return {
			kind: "malformed",
			variant: "unprintable",
			payload: { runtimeEvent: "session/update", problem: "no-sessionUpdate-variant" },
		};
	}
	const raw = update.sessionUpdate;
	const variant = /^[A-Za-z0-9_.-]{1,128}$/.test(raw) ? raw : "unprintable";
	if (!hasRequiredFields(variant, update)) {
		return {
			kind: "malformed",
			variant,
			payload: { runtimeEvent: "session/update", variant, problem: "required-field-missing" },
		};
	}
	if (DELTA_VARIANTS.has(variant)) return { kind: "delta", variant };
	const observed = (fields: Record<string, JsonValueV0 | undefined>): AcpUpdateTranslationV0 => ({
		kind: "event",
		variant,
		eventKind: "session.update-observed",
		payload: { update: variant, ...compact(fields) },
	});
	switch (variant) {
		case "tool_call":
			return observed({
				toolCallId: opaqueIdRefV0(update.toolCallId),
				toolKind: shortText(update.kind, 32),
				status: shortText(update.status, 32),
			});
		case "tool_call_update":
			return observed({ toolCallId: opaqueIdRefV0(update.toolCallId), status: shortText(update.status, 32) });
		case "plan":
			return observed({ entries: Array.isArray(update.entries) ? update.entries.length : undefined });
		case "available_commands_update":
			return observed({
				commands: Array.isArray(update.availableCommands) ? update.availableCommands.length : undefined,
			});
		case "current_mode_update":
			return observed({ modeId: shortText(update.currentModeId) });
		case "config_option_update":
			return observed({ options: Array.isArray(update.configOptions) ? update.configOptions.length : undefined });
		case "session_info_update":
			// Present only when the agent said something about the title: a string is a title, null a cleared one.
			return observed({
				titled: typeof update.title === "string" ? true : update.title === null ? false : undefined,
			});
		case "usage_update":
			return observed({ used: finite(update.used), size: finite(update.size) });
		default:
			return {
				kind: "event",
				variant,
				eventKind: "runtime.unrecognized-event",
				payload: { runtimeEvent: variant, method: "session/update" },
			};
	}
}

/** The lifecycle end of a prompt turn the agent answered with a recognized stop reason. */
export function lifecycleEndForStopReasonV0(
	stopReason: AcpStopReasonV0,
	stopRequested: boolean,
): { kind: EndoLifecycleKindV0; payload: Record<string, JsonValueV0> } {
	const reported = endoReportedV0(stopReason);
	switch (stopReason) {
		case "end_turn":
			return { kind: "lifecycle.run-completed", payload: { stopReason: reported, stopRequested } };
		case "cancelled":
			// The agent's own report that the turn was cancelled. Whether the operator's request caused it is not inferred.
			return { kind: "lifecycle.run-aborted", payload: { stopRequested } };
		default:
			// max_tokens, max_turn_requests, refusal: a reported stop that is neither completion nor abort. Not called a
			// failure: ACP does not say the turn failed.
			return {
				kind: "lifecycle.run-unclassified",
				payload: { reason: `acp-stop-reason:${stopReason}`, stopReason: reported, stopRequested },
			};
	}
}
