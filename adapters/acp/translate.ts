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
import { ACP_STABLE_UPDATE_VARIANTS_V0, ACP_UNSTABLE_UPDATE_VARIANTS_V0, acpUpdateVerdictV0 } from "./schema.ts";

export const ACP_MAPPING_VERSION = "acp-v1-mapping.3";

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
	{
		field: "usage",
		reason:
			"the stable ACP v1 surface reports session context-window state (usage_update used, size) and an optional cumulative cost, not per-message input/output/cache/reasoning tokens; a per-turn usage field on the session/prompt response exists in the pinned schema but is marked UNSTABLE and is not read; nothing is derived or split",
	},
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

function compact(fields: Record<string, JsonValueV0 | undefined>): Record<string, JsonValueV0> {
	const out: Record<string, JsonValueV0> = {};
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
	return out;
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
	readonly #observerErrors: unknown[] = [];
	#observerFailures = 0;
	#lastObserverError: unknown;

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

	/**
	 * What `onEvent` threw, in order (the first 16). Observation is evidence, not authority: an observer that throws
	 * never aborts the transition being recorded or the cleanup that must follow it. The failure is kept here, and the
	 * control paths that have a caller to tell (cancel, closeSession) report it once their transition is complete.
	 */
	get observerErrors(): readonly unknown[] {
		return this.#observerErrors;
	}

	/** How many times `onEvent` has thrown, counted without the retention cap, and the latest error. */
	get observerFailures(): number {
		return this.#observerFailures;
	}

	get lastObserverError(): unknown {
		return this.#lastObserverError;
	}

	#emit(event: Record<string, unknown>): EndoEventV0 {
		const validated = validateEndoEventV0(event);
		if (validated === null)
			throw new TypeError(`the mapped ${String(event.kind)} event failed endo.event.v0 validation`);
		try {
			this.#options.onEvent(validated);
		} catch (error) {
			this.#observerFailures += 1;
			this.#lastObserverError = error;
			if (this.#observerErrors.length < 16) this.#observerErrors.push(error);
		}
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
	/** Not counted: a recognized variant the pinned schema rejects, or no variant at all. */
	| { readonly kind: "malformed"; readonly variant: string; readonly payload: Record<string, JsonValueV0> }
	| {
			readonly kind: "event";
			readonly variant: string;
			readonly eventKind: string;
			readonly payload: Record<string, JsonValueV0>;
	  };

const MAX_CONFIG_ENTRIES = 32;

/** What an agent reported about its session configuration options: identifiers, kinds and current values, no labels. */
export function summarizeConfigOptionsV0(options: readonly unknown[]): Record<string, JsonValueV0> {
	const summarized = options.slice(0, MAX_CONFIG_ENTRIES).map((entry) => {
		const option = isRecord(entry) ? entry : {};
		const choices = Array.isArray(option.options) ? option.options : [];
		return compact({
			id: opaqueIdRefV0(option.id),
			type: shortText(option.type, 16),
			category: opaqueIdRefV0(option.category),
			// The value the agent reports as current: its claim about itself, not a verified model or setting.
			current: typeof option.currentValue === "boolean" ? option.currentValue : opaqueIdRefV0(option.currentValue),
			// Selectable values the agent advertised (a group counts its members).
			choices:
				option.type === "select"
					? choices.reduce(
							(n: number, c) => n + (isRecord(c) && Array.isArray(c.options) ? c.options.length : 1),
							0,
						)
					: undefined,
		});
	});
	return {
		optionCount: options.length,
		options: summarized,
		...(options.length > MAX_CONFIG_ENTRIES ? { truncated: true } : {}),
	};
}

/** The legacy session-mode state of a session/new or session/resume response, reduced to the current id and a count. */
export function summarizeModesV0(modes: unknown): Record<string, JsonValueV0> | undefined {
	if (!isRecord(modes)) return undefined;
	return compact({
		currentModeId: opaqueIdRefV0(modes.currentModeId),
		available: Array.isArray(modes.availableModes) ? modes.availableModes.length : undefined,
	});
}

// Presence is the property being carried, null included: `rawInput: null` is not the same message as no rawInput.
const carries = (update: Record<string, unknown>, key: string): boolean => Object.hasOwn(update, key);

/**
 * Translate the `update` of one `session/update` notification. `params` is whatever the agent sent: it is not
 * assumed to match any schema. A recognized stable variant is validated against the pinned schema first
 * (validateAcpUpdateV0) and is `malformed` if it fails. A variant this version does not translate (unknown, or listed
 * UNSTABLE by the pinned schema) becomes `runtime.unrecognized-event`, a non-object or variant-less update becomes
 * `runtime.malformed-event`; neither is dropped.
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
	if (!ACP_STABLE_UPDATE_VARIANTS_V0.includes(raw)) {
		return {
			kind: "event",
			variant,
			eventKind: "runtime.unrecognized-event",
			payload: {
				runtimeEvent: variant,
				method: "session/update",
				schemaStatus: ACP_UNSTABLE_UPDATE_VARIANTS_V0.includes(raw) ? "unstable" : "unknown",
			},
		};
	}
	const verdict = acpUpdateVerdictV0(raw, update);
	if (verdict !== "valid") {
		return {
			kind: "malformed",
			variant,
			// An integer the schema allows but a JS number cannot hold exactly is not the agent's schema error, and it is
			// never recorded rounded: the update is not counted, and says why.
			payload: {
				runtimeEvent: "session/update",
				variant,
				problem: verdict === "inexact-integer" ? "integer-not-exact" : "schema-invalid",
			},
		};
	}
	if (DELTA_VARIANTS.has(variant)) return { kind: "delta", variant };
	const observed = (fields: Record<string, JsonValueV0 | undefined>): AcpUpdateTranslationV0 => ({
		kind: "event",
		variant,
		eventKind: "session.update-observed",
		payload: { update: variant, ...compact(fields) },
	});
	// Validated against the pinned schema above: the fields read below have the types it gives them.
	const u = update;
	const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
	switch (variant) {
		case "tool_call":
		case "tool_call_update":
			// Identity, kind and status as the agent reported them, and only whether content, locations and raw
			// input/output were present. No title, content, argument or result is kept, and nothing is digested: ACP gives
			// no keyed digest of an argument or a result, and one is not made up here.
			return observed({
				toolCallId: opaqueIdRefV0(u.toolCallId),
				toolName: opaqueIdRefV0(u.name),
				toolKind: shortText(u.kind, 32),
				status: shortText(u.status, 32),
				contentItems: Array.isArray(u.content) ? u.content.length : undefined,
				locations: Array.isArray(u.locations) ? u.locations.length : undefined,
				rawInputPresent: carries(u, "rawInput") ? true : undefined,
				rawOutputPresent: carries(u, "rawOutput") ? true : undefined,
			});
		case "plan": {
			const byStatus: Record<string, JsonValueV0> = { pending: 0, in_progress: 0, completed: 0 };
			for (const entry of list(u.entries)) {
				const status = isRecord(entry) ? String(entry.status) : "";
				byStatus[status] = ((byStatus[status] as number | undefined) ?? 0) + 1;
			}
			return observed({ entries: list(u.entries).length, byStatus });
		}
		case "available_commands_update":
			return observed({ commands: list(u.availableCommands).length });
		case "current_mode_update":
			return observed({ modeId: opaqueIdRefV0(u.currentModeId) });
		case "config_option_update":
			return {
				kind: "event",
				variant,
				eventKind: "session.config-observed",
				payload: { origin: "config_option_update", ...summarizeConfigOptionsV0(list(u.configOptions)) },
			};
		case "session_info_update":
			// Present only when the agent said something about the title: a string is a title, null a cleared one.
			return observed({ titled: typeof u.title === "string" ? true : u.title === null ? false : undefined });
		case "usage_update": {
			// Session context-window state, as ACP defines it: not a per-message token ledger, and not split into
			// input/output/cache/reasoning categories ACP did not report. An absent cost is absent, not zero; a cost
			// without a printable currency is not carried (an amount means nothing without its currency).
			const currency = isRecord(u.cost) ? shortText(u.cost.currency, 16) : undefined;
			return observed({
				contextTokensUsed: Number(u.used),
				contextWindowSize: Number(u.size),
				cost: isRecord(u.cost) && currency !== undefined ? { amount: Number(u.cost.amount), currency } : undefined,
				costOmitted: isRecord(u.cost) && currency === undefined ? true : undefined,
			});
		}
		default:
			// Every stable variant is handled above; reaching this is a table that drifted from ACP_STABLE_UPDATE_VARIANTS_V0.
			throw new TypeError(`no translation for the stable ACP update variant ${variant}`);
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
