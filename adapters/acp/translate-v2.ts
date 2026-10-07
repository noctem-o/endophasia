// The ACP v2 (Draft, baseline) -> endo.* translation (ACP_V2_MAPPING_VERSION). Same two evidence streams and the same
// payload discipline as the v1 mapping (translate.ts, whose recorder this reuses): ACP types stop at adapters/acp, no
// message text, thought text, tool title, tool input/output, plan text, terminal bytes, command text or permission copy
// ever enters an event, and a field the agent did not send is absent or UNAVAILABLE, never zero or false.
//
// What is NOT shared with v1, because the semantics differ: the update variant set, the state model (`state_update`
// instead of a prompt response), identifiers (`configId`, not `id`), message identity (`messageId`), and the lifecycle's
// unavailable-field declarations. Shared helpers are the ones whose meaning is identical (opaque id references, the
// stop-reason -> lifecycle-end table).

import type { JsonValueV0 } from "../../protocol/primitives.ts";
import type { EndoLifecycleKindV0, EndoUnavailableFieldV0 } from "../../protocol/session-lifecycle.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	ACP_V2_BASELINE_UPDATE_VARIANTS_V0,
	ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0,
	validateAcpV2UpdateV0,
} from "./schema-v2.ts";
import { isRecord, lifecycleEndForStopReasonV0, opaqueIdRefV0, shortText } from "./translate.ts";

export const ACP_V2_MAPPING_VERSION = "acp-v2-mapping.0";

/** What ACP v2 (baseline) does not tell a client, declared on every v2 session start. */
export const ACP_V2_LIFECYCLE_UNAVAILABLE_V0: readonly EndoUnavailableFieldV0[] = Object.freeze([
	{
		field: "run.id",
		reason: "ACP v2 foreground work carries no run identifier; `session/prompt` returns a message id, not a run id",
	},
	{
		field: "turn.id",
		reason:
			"ACP v2 reports no turn identifier: it separates prompt acceptance from foreground work, and neither is a turn",
	},
	{
		field: "turns",
		reason:
			"ACP v2 reports no turn count: lifecycle payloads omit `turns` and `turnOpen`, and the session overview's turn count (0 for want of any) is not a count",
	},
	{
		field: "run.start",
		reason:
			"the run start is the agent's own `state_update` running; the client's `session/prompt` and the agent's acceptance of it are not a run start",
	},
	{
		field: "run.attribution",
		reason:
			"a `state_update` carries no prompt or message identifier: an idle is attributed to the client's prompt by order only (it is the next idle after that prompt was accepted), and foreground work the client did not request is not distinguishable from work it did",
	},
	{
		field: "operation.outcome",
		reason: "ACP v2 reports a stopReason on an idle state_update, optionally, and no durable operation outcome",
	},
	{ field: "stop.target", reason: "session/cancel names the session, not one prompt or one run" },
	{
		field: "usage",
		reason:
			"the baseline reports session context-window state (usage_update used, size) and an optional cumulative cost; per-run token usage on the idle state_update is UNSTABLE and is not read",
	},
	{ field: "lanes", reason: "ACP v2 exposes one session per session/new and no lanes" },
]);

/** The v2 baseline stop reasons Endophasia classifies. A baseline `other` stop reason (custom or future) is not one. */
export const ACP_V2_KNOWN_STOP_REASONS_V0 = [
	"end_turn",
	"max_tokens",
	"max_turn_requests",
	"refusal",
	"cancelled",
] as const;
export type AcpV2StopReasonV0 = (typeof ACP_V2_KNOWN_STOP_REASONS_V0)[number];

export function isAcpV2KnownStopReasonV0(value: unknown): value is AcpV2StopReasonV0 {
	return typeof value === "string" && (ACP_V2_KNOWN_STOP_REASONS_V0 as readonly string[]).includes(value);
}

/** The lifecycle end of foreground work that went idle with a stop reason. A custom or future reason is unclassified. */
export function lifecycleEndForV2StopReasonV0(
	stopReason: string,
	stopRequested: boolean,
): { kind: EndoLifecycleKindV0; payload: Record<string, JsonValueV0> } {
	if (isAcpV2KnownStopReasonV0(stopReason)) return lifecycleEndForStopReasonV0(stopReason, stopRequested);
	return {
		kind: "lifecycle.run-unclassified",
		payload: { reason: "acp-stop-reason:unrecognized", stopRequested },
	};
}

const compact = (fields: Record<string, JsonValueV0 | undefined>): Record<string, JsonValueV0> => {
	const out: Record<string, JsonValueV0> = {};
	for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
	return out;
};

const MAX_CONFIG_ENTRIES = 32;

/** What an agent reported about its v2 session configuration: identifiers, kinds and current values, no labels. */
export function summarizeConfigOptionsV2(options: readonly unknown[]): Record<string, JsonValueV0> {
	const summarized = options.slice(0, MAX_CONFIG_ENTRIES).map((entry) => {
		const option = isRecord(entry) ? entry : {};
		const choices = Array.isArray(option.options) ? option.options : [];
		return compact({
			// v2 names the option `configId`; v1's `id` is a different field.
			configId: opaqueIdRefV0(option.configId),
			type: shortText(option.type, 16),
			category: opaqueIdRefV0(option.category),
			current: typeof option.currentValue === "boolean" ? option.currentValue : opaqueIdRefV0(option.currentValue),
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

/** A bounded digest of a payload the baseline does not describe: it was received and is accounted for, but not kept. */
function rawEvidence(value: unknown): Record<string, JsonValueV0> {
	let canonical: string;
	try {
		canonical = JSON.stringify(value) ?? "";
	} catch {
		return { rawDigest: null };
	}
	return { rawBytes: Buffer.byteLength(canonical), rawSha256: sha256HexV0(canonical) };
}

export type AcpV2UpdateTranslationV0 =
	/** Content that is counted, never stored (message and thought text, tool-call content, terminal bytes). */
	| { readonly kind: "delta"; readonly variant: string }
	/** Not counted: a baseline variant the schema rejects, or no variant at all. */
	| { readonly kind: "malformed"; readonly variant: string; readonly payload: Record<string, JsonValueV0> }
	/** A baseline `state_update`: interpreted by the client against its own run state. */
	| {
			readonly kind: "state";
			readonly variant: "state_update";
			readonly state: "running" | "idle" | "requires_action";
			readonly stopReason: string | null | undefined;
	  }
	| {
			readonly kind: "event";
			readonly variant: string;
			readonly eventKind: string;
			readonly payload: Record<string, JsonValueV0>;
	  };

/**
 * Translate the `update` of one `session/update` notification. `update` is whatever the agent sent. A baseline variant is
 * validated against the vendored baseline first and is `malformed` if it fails. A variant the baseline does not describe
 * (unknown, `_`-prefixed, or only in the SDK's layered unstable schema) becomes `runtime.unrecognized-event` with a digest
 * of the raw payload; a `state_update` whose state the baseline does not name does too. Nothing is dropped, and nothing
 * unstable is interpreted.
 */
export function translateAcpV2UpdateV0(update: unknown): AcpV2UpdateTranslationV0 {
	if (!isRecord(update) || typeof update.sessionUpdate !== "string") {
		return {
			kind: "malformed",
			variant: "unprintable",
			payload: { runtimeEvent: "session/update", problem: "no-sessionUpdate-variant" },
		};
	}
	const raw = update.sessionUpdate;
	const variant = /^[A-Za-z0-9_.-]{1,128}$/.test(raw) ? raw : "unprintable";
	if (!ACP_V2_BASELINE_UPDATE_VARIANTS_V0.includes(raw)) {
		return {
			kind: "event",
			variant,
			eventKind: "runtime.unrecognized-event",
			payload: {
				runtimeEvent: variant,
				method: "session/update",
				schemaStatus: ACP_V2_UNSTABLE_UPDATE_VARIANTS_V0.includes(raw) ? "unstable" : "unknown",
				...rawEvidence(update),
			},
		};
	}
	if (!validateAcpV2UpdateV0(raw, update)) {
		return {
			kind: "malformed",
			variant,
			payload: { runtimeEvent: "session/update", variant, problem: "schema-invalid" },
		};
	}
	const observed = (fields: Record<string, JsonValueV0 | undefined>): AcpV2UpdateTranslationV0 => ({
		kind: "event",
		variant,
		eventKind: "session.update-observed",
		payload: { update: variant, ...compact(fields) },
	});
	const u = update;
	const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
	switch (variant) {
		case "user_message_chunk":
		case "user_message":
		case "agent_message_chunk":
		case "agent_message":
		case "agent_thought_chunk":
		case "agent_thought":
		case "tool_call_content_chunk":
		case "terminal_output_chunk":
			return { kind: "delta", variant };
		case "state_update": {
			const state = u.state;
			if (state === "running" || state === "idle" || state === "requires_action") {
				return {
					kind: "state",
					variant: "state_update",
					state,
					stopReason:
						state === "idle" ? (u.stopReason === null ? null : (u.stopReason as string | undefined)) : undefined,
				};
			}
			// A custom or future state (`unknown` is UNSTABLE upstream): observed, never interpreted as foreground activity.
			return {
				kind: "event",
				variant,
				eventKind: "runtime.unrecognized-event",
				payload: {
					runtimeEvent: "state_update",
					method: "session/update",
					schemaStatus: u.state === "unknown" ? "unstable" : "unknown",
					state: shortText(state, 64) ?? null,
					...rawEvidence(update),
				},
			};
		}
		case "tool_call_update":
			// A partial upsert: an absent field means unchanged, an explicit null clears it. Identity, kind and status as
			// reported, and only whether content, locations and raw input/output were carried.
			return observed({
				toolCallId: opaqueIdRefV0(u.toolCallId),
				toolName: opaqueIdRefV0(u.name),
				toolKind: shortText(u.kind, 32),
				status: shortText(u.status, 32),
				contentItems: Array.isArray(u.content) ? u.content.length : undefined,
				locations: Array.isArray(u.locations) ? u.locations.length : undefined,
				rawInputPresent: Object.hasOwn(u, "rawInput") ? true : undefined,
				rawOutputPresent: Object.hasOwn(u, "rawOutput") ? true : undefined,
			});
		case "terminal_update":
			// An agent-owned, display-only terminal: identity and whether it exited. No command, cwd or output.
			return observed({
				terminalId: opaqueIdRefV0(u.terminalId),
				// Omitted = unchanged; a concrete object = set; an explicit null = cleared. Each is its own fact.
				exited: isRecord(u.exitStatus) ? true : undefined,
				exitCleared: u.exitStatus === null ? true : undefined,
				outputPresent: isRecord(u.output) ? true : undefined,
				outputCleared: u.output === null ? true : undefined,
			});
		case "plan_update": {
			const plan = isRecord(u.plan) ? u.plan : {};
			const type = shortText(plan.type, 32);
			if (type === "items") {
				// Statuses are open (custom and future ones are valid): a null-prototype accumulator, so `__proto__` and
				// `toString` count as statuses and never as inherited members.
				const counted: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, {
					pending: 0,
					in_progress: 0,
					completed: 0,
				});
				for (const entry of list(plan.entries)) {
					const status = isRecord(entry) ? String(entry.status) : "";
					counted[status] = (Object.hasOwn(counted, status) ? (counted[status] as number) : 0) + 1;
				}
				const byStatus: Record<string, JsonValueV0> = {};
				for (const [status, count] of Object.entries(counted))
					Object.defineProperty(byStatus, status, {
						value: count,
						enumerable: true,
						writable: true,
						configurable: true,
					});
				return observed({
					planId: opaqueIdRefV0(plan.planId),
					content: "items",
					entries: list(plan.entries).length,
					byStatus,
				});
			}
			// `file`/`markdown` are UNSTABLE upstream and a custom type is open: counted by type, not interpreted.
			return observed({ planId: opaqueIdRefV0(plan.planId), content: type ?? "unprintable" });
		}
		case "available_commands_update":
			return observed({ commands: list(u.availableCommands).length });
		case "config_option_update":
			return {
				kind: "event",
				variant,
				eventKind: "session.config-observed",
				payload: { origin: "config_option_update", ...summarizeConfigOptionsV2(list(u.configOptions)) },
			};
		case "session_info_update":
			return observed({ titled: typeof u.title === "string" ? true : u.title === null ? false : undefined });
		case "usage_update": {
			const currency = isRecord(u.cost) ? shortText(u.cost.currency, 16) : undefined;
			return observed({
				contextTokensUsed: Number(u.used),
				contextWindowSize: Number(u.size),
				cost: isRecord(u.cost) && currency !== undefined ? { amount: Number(u.cost.amount), currency } : undefined,
				costOmitted: isRecord(u.cost) && currency === undefined ? true : undefined,
			});
		}
		default:
			throw new TypeError(`no translation for the baseline ACP v2 update variant ${variant}`);
	}
}
