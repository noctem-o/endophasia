// Governed Cognitive Resource Policy (`endo.coordinator-resource-policy.v1`, COORDINATOR-REASONING-001).
//
// Defines explicit, opt-in, closed resource-allocation tiers for asynchronous Coordinator advisory cognition.
// Existing V0 pools and S2 authorizations without a `resourceProfile` keep their exact V0 limits (<= 2,048 output tokens,
// <= 135 s member timeout, <= 240 s turn wall clock, <= 300 s advisory lease). Opting into a governed V1 resource profile
// widens ONLY the explicitly declared compute and wall-clock ceilings for local advisory inference while preserving every
// authority, tool-surface, grounding, lease-fencing, accounting, revocation and answer-size (`maxAnswerBytes = 4096`) boundary.
//
// Invariant: protocol imports only protocol. Every object is closed and deep-frozen.

import { isPlainJsonObjectV0 } from "./primitives.ts";
import { EndoInvalidRecordV0, endoBoundedDetailV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1 = "endo.coordinator-resource-policy.v1";

/** Closed conceptual cognitive-resource tiers. `reflex` authorizes zero inference tokens (deterministic-only). */
export const ENDO_COORDINATOR_RESOURCE_TIERS_V1 = ["reflex", "light", "deliberate", "deep", "extended"] as const;
export type EndoCoordinatorResourceTierV1 = (typeof ENDO_COORDINATOR_RESOURCE_TIERS_V1)[number];

/**
 * Closed reasoning-control modes supported across governed local backends.
 * - `unchanged`: send no reasoning-control override fields; preserve the server/model default.
 * - `reasoning-effort`: explicit `reasoning_effort` wire field (`minimal` | `low` | `medium` | `high`).
 *   NOTE: `"none"` is intentionally excluded because llama.cpp b12622 erases `reasoning_effort` when `"none"` is requested
 *   and sets `enable_thinking=false`, which Inkling-2-Mini's Jinja chat template ignores, silently reverting to `0.9` (`high`).
 * - `reasoning-budget-tokens`: explicit positive `reasoning_budget_tokens` wire field (`1 <= tokens <= maxOutputTokensPerRequest - 256`).
 *   NOTE: `0` is intentionally excluded because llama.cpp b12622 + Inkling-2-Mini enters an infinite thinking-tag loop at `0`.
 */
export const ENDO_COORDINATOR_REASONING_CONTROL_MODES_V1 = [
	"unchanged",
	"reasoning-effort",
	"reasoning-budget-tokens",
] as const;
export type EndoCoordinatorReasoningControlModeV1 = (typeof ENDO_COORDINATOR_REASONING_CONTROL_MODES_V1)[number];

export const ENDO_COORDINATOR_REASONING_EFFORT_LEVELS_V1 = ["minimal", "low", "medium", "high"] as const;
export type EndoCoordinatorReasoningEffortV1 = (typeof ENDO_COORDINATOR_REASONING_EFFORT_LEVELS_V1)[number];

export type EndoCoordinatorReasoningControlV1 =
	| { readonly mode: "unchanged" }
	| { readonly mode: "reasoning-effort"; readonly effort: EndoCoordinatorReasoningEffortV1 }
	| { readonly mode: "reasoning-budget-tokens"; readonly tokens: number };

export interface EndoCoordinatorResourceTierCeilingV1 {
	readonly tier: EndoCoordinatorResourceTierV1;
	readonly allowsInference: boolean;
	readonly minOutputTokensPerRequest: number;
	readonly maxOutputTokensPerRequest: number;
	readonly minMemberTimeoutMs: number;
	readonly maxMemberTimeoutMs: number;
	readonly maxTurnWallClockMs: number;
	readonly minPublicationReserveMs: number;
	readonly maxPublicationReserveMs: number;
	readonly defaultPublicationReserveMs: number;
	readonly maxLeaseTtlMs: number;
	readonly minContextWindowTokens: number;
	readonly maxContextWindowTokens: number;
	readonly minRelayTransferredBytes: number;
	readonly maxRelayTransferredBytes: number;
}

const MiB = 1024 * 1024;

export const ENDO_COORDINATOR_RESOURCE_TIER_CEILINGS_V1: Readonly<
	Record<EndoCoordinatorResourceTierV1, EndoCoordinatorResourceTierCeilingV1>
> = Object.freeze({
	reflex: Object.freeze({
		tier: "reflex",
		allowsInference: false,
		minOutputTokensPerRequest: 0,
		maxOutputTokensPerRequest: 0,
		minMemberTimeoutMs: 0,
		maxMemberTimeoutMs: 0,
		maxTurnWallClockMs: 0,
		minPublicationReserveMs: 0,
		maxPublicationReserveMs: 0,
		defaultPublicationReserveMs: 0,
		maxLeaseTtlMs: 0,
		minContextWindowTokens: 0,
		maxContextWindowTokens: 0,
		minRelayTransferredBytes: 0,
		maxRelayTransferredBytes: 0,
	}),
	light: Object.freeze({
		tier: "light",
		allowsInference: true,
		minOutputTokensPerRequest: 256,
		maxOutputTokensPerRequest: 4_096,
		minMemberTimeoutMs: 5_000,
		maxMemberTimeoutMs: 720_000,
		maxTurnWallClockMs: 780_000,
		minPublicationReserveMs: 20_000,
		maxPublicationReserveMs: 120_000,
		defaultPublicationReserveMs: 60_000,
		maxLeaseTtlMs: 840_000,
		minContextWindowTokens: 32_768,
		maxContextWindowTokens: 131_072,
		minRelayTransferredBytes: 8 * MiB,
		maxRelayTransferredBytes: 16 * MiB,
	}),
	deliberate: Object.freeze({
		tier: "deliberate",
		allowsInference: true,
		minOutputTokensPerRequest: 256,
		maxOutputTokensPerRequest: 8_192,
		minMemberTimeoutMs: 5_000,
		maxMemberTimeoutMs: 720_000,
		maxTurnWallClockMs: 780_000,
		minPublicationReserveMs: 20_000,
		maxPublicationReserveMs: 120_000,
		defaultPublicationReserveMs: 60_000,
		maxLeaseTtlMs: 840_000,
		minContextWindowTokens: 32_768,
		maxContextWindowTokens: 131_072,
		minRelayTransferredBytes: 8 * MiB,
		maxRelayTransferredBytes: 24 * MiB,
	}),
	deep: Object.freeze({
		tier: "deep",
		allowsInference: true,
		minOutputTokensPerRequest: 256,
		maxOutputTokensPerRequest: 16_384,
		minMemberTimeoutMs: 5_000,
		maxMemberTimeoutMs: 720_000,
		maxTurnWallClockMs: 780_000,
		minPublicationReserveMs: 20_000,
		maxPublicationReserveMs: 120_000,
		defaultPublicationReserveMs: 60_000,
		maxLeaseTtlMs: 840_000,
		minContextWindowTokens: 65_536,
		maxContextWindowTokens: 131_072,
		minRelayTransferredBytes: 8 * MiB,
		maxRelayTransferredBytes: 32 * MiB,
	}),
	extended: Object.freeze({
		tier: "extended",
		allowsInference: true,
		minOutputTokensPerRequest: 256,
		maxOutputTokensPerRequest: 24_576,
		minMemberTimeoutMs: 5_000,
		maxMemberTimeoutMs: 1_080_000,
		maxTurnWallClockMs: 1_140_000,
		minPublicationReserveMs: 20_000,
		maxPublicationReserveMs: 120_000,
		defaultPublicationReserveMs: 60_000,
		maxLeaseTtlMs: 1_200_000,
		minContextWindowTokens: 131_072,
		maxContextWindowTokens: 262_144,
		minRelayTransferredBytes: 8 * MiB,
		maxRelayTransferredBytes: 48 * MiB,
	}),
});

/** Absolute upper bounds across all governed V1 tiers. Never raised implicitly. */
export const ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1 = Object.freeze({
	maxOutputTokensPerRequest: 24_576,
	completionRequestsPerTurn: 2,
	maxAggregateGeneratedTokensPerTurn: 2 * 24_576,
	maxGeneratedTokensPerPeriod: 96 * 2 * 24_576,
	maxMemberTimeoutMs: 1_080_000,
	maxTurnWallClockMs: 1_140_000,
	minPublicationReserveMs: 20_000,
	maxPublicationReserveMs: 120_000,
	maxLeaseTtlMs: 1_200_000,
	maxRelayTransferredBytes: 48 * MiB,
	maxAnswerBytes: 4096 as const,
	maxFileBytes: 64 * 1024,
	minVisibleHeadroomTokens: 256,
	minPromptHeadroomTokens: 8_192,
});

export interface EndoCoordinatorResourceProfileV1 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1;
	readonly tier: EndoCoordinatorResourceTierV1;
	/** Configured context window for the client/provider guard (must exceed `maxOutputTokensPerRequest` + prompt headroom). */
	readonly contextWindowTokens: number;
	/** Per-completion generation cap (`max_tokens`). Shared between reasoning and visible tokens on OpenAI-compat backends. */
	readonly maxOutputTokensPerRequest: number;
	/** Explicit backend reasoning control (`unchanged`, `reasoning-effort`, or positive `reasoning-budget-tokens`). */
	readonly reasoningControl: EndoCoordinatorReasoningControlV1;
	/**
	 * Desired visible answer length in tokens. Advisory-only: not enforced as a separate server token ceiling unless a backend
	 * natively splits visible vs reasoning budgets; final published output remains hard-capped by `maxAnswerBytes = 4096`.
	 */
	readonly desiredVisibleAnswerTokens: number;
	readonly desiredVisibleAnswerTokensAdvisoryOnly: true;
	/** Fixed relay exchange ceiling (`0` for `reflex`, `2` for inference tiers). */
	readonly completionRequestsPerTurn: 0 | 2;
	/** Aggregate generated-token reservation ceiling per turn (`completionRequestsPerTurn * maxOutputTokensPerRequest`). */
	readonly maxAggregateGeneratedTokensPerTurn: number;
	/** Per-member model execution timeout (ms). Strictly `<= advisoryTurnDeadlineMs`. */
	readonly modelExecutionTimeoutMs: number;
	/** Whole-turn inference deadline from admission (ms). Strictly `<= advisoryLeaseTtlMs - publicationReserveMs`. */
	readonly advisoryTurnDeadlineMs: number;
	/** Reserved tail of the advisory lease for re-observation and publication after the inference deadline (ms). */
	readonly publicationReserveMs: number;
	/** Advisory duty lease TTL (ms) for turns governed by this profile. */
	readonly advisoryLeaseTtlMs: number;
	/** Aggregate relay wire-transfer byte cap (both directions across both exchanges, including SSE overhead). */
	readonly relayMaxTransferredBytes: number;
	/** Final published briefing answer byte ceiling. Pinned unchanged at 4,096 bytes across all tiers. */
	readonly maxAnswerBytes: 4096;
}

const PROFILE_KEYS_V1 = [
	"schemaVersion",
	"tier",
	"contextWindowTokens",
	"maxOutputTokensPerRequest",
	"reasoningControl",
	"desiredVisibleAnswerTokens",
	"desiredVisibleAnswerTokensAdvisoryOnly",
	"completionRequestsPerTurn",
	"maxAggregateGeneratedTokensPerTurn",
	"modelExecutionTimeoutMs",
	"advisoryTurnDeadlineMs",
	"publicationReserveMs",
	"advisoryLeaseTtlMs",
	"relayMaxTransferredBytes",
	"maxAnswerBytes",
] as const;

function fail(detail: string): never {
	throw new EndoInvalidRecordV0(endoBoundedDetailV0(detail));
}

function closed(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const unknown = endoFirstUnknownKeyV0(record, keys);
	if (unknown !== undefined) fail(`${at} has an unknown field ${JSON.stringify(String(unknown))}`);
	for (const key of keys) if (!Object.hasOwn(record, key)) fail(`${at}.${key} is required`);
	return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
		fail(`${at} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
	return value as T;
}

function int(value: unknown, min: number, max: number, at: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		fail(`${at} must be an integer from ${min} to ${max}`);
	return value as number;
}

export function validateEndoCoordinatorReasoningControlV1(
	value: unknown,
	maxOutputTokensPerRequest: number,
	allowsInference: boolean,
	at = "reasoningControl",
): EndoCoordinatorReasoningControlV1 {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const mode = oneOf(record.mode, ENDO_COORDINATOR_REASONING_CONTROL_MODES_V1, `${at}.mode`);
	if (!allowsInference && mode !== "unchanged") fail(`${at}.mode must be "unchanged" for non-inference tier`);
	if (mode === "unchanged") {
		closed(record, ["mode"], at);
		return Object.freeze({ mode: "unchanged" });
	}
	if (mode === "reasoning-effort") {
		closed(record, ["mode", "effort"], at);
		const effort = oneOf(record.effort, ENDO_COORDINATOR_REASONING_EFFORT_LEVELS_V1, `${at}.effort`);
		return Object.freeze({ mode: "reasoning-effort", effort });
	}
	closed(record, ["mode", "tokens"], at);
	const maxBudget = maxOutputTokensPerRequest - ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.minVisibleHeadroomTokens;
	if (maxBudget < 1)
		fail(`${at}.tokens cannot be set when maxOutputTokensPerRequest leaves no visible-answer headroom`);
	const tokens = int(record.tokens, 1, maxBudget, `${at}.tokens`);
	return Object.freeze({ mode: "reasoning-budget-tokens", tokens });
}

export function validateEndoCoordinatorResourceProfileV1(
	value: unknown,
	at = "resourceProfile",
): EndoCoordinatorResourceProfileV1 {
	const r = closed(value, PROFILE_KEYS_V1, at);
	if (r.schemaVersion !== ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1)
		fail(`${at}.schemaVersion must be ${JSON.stringify(ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1)}`);
	const tier = oneOf(r.tier, ENDO_COORDINATOR_RESOURCE_TIERS_V1, `${at}.tier`);
	const ceiling = ENDO_COORDINATOR_RESOURCE_TIER_CEILINGS_V1[tier];
	if (r.desiredVisibleAnswerTokensAdvisoryOnly !== true)
		fail(`${at}.desiredVisibleAnswerTokensAdvisoryOnly must be true`);
	if (r.maxAnswerBytes !== ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.maxAnswerBytes)
		fail(`${at}.maxAnswerBytes must be ${ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.maxAnswerBytes}`);

	if (!ceiling.allowsInference) {
		const reasoningControl = validateEndoCoordinatorReasoningControlV1(
			r.reasoningControl,
			0,
			false,
			`${at}.reasoningControl`,
		);
		return Object.freeze({
			schemaVersion: ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1,
			tier,
			contextWindowTokens: int(r.contextWindowTokens, 0, 0, `${at}.contextWindowTokens`),
			maxOutputTokensPerRequest: int(r.maxOutputTokensPerRequest, 0, 0, `${at}.maxOutputTokensPerRequest`),
			reasoningControl,
			desiredVisibleAnswerTokens: int(r.desiredVisibleAnswerTokens, 0, 0, `${at}.desiredVisibleAnswerTokens`),
			desiredVisibleAnswerTokensAdvisoryOnly: true,
			completionRequestsPerTurn: int(r.completionRequestsPerTurn, 0, 0, `${at}.completionRequestsPerTurn`) as 0,
			maxAggregateGeneratedTokensPerTurn: int(
				r.maxAggregateGeneratedTokensPerTurn,
				0,
				0,
				`${at}.maxAggregateGeneratedTokensPerTurn`,
			),
			modelExecutionTimeoutMs: int(r.modelExecutionTimeoutMs, 0, 0, `${at}.modelExecutionTimeoutMs`),
			advisoryTurnDeadlineMs: int(r.advisoryTurnDeadlineMs, 0, 0, `${at}.advisoryTurnDeadlineMs`),
			publicationReserveMs: int(r.publicationReserveMs, 0, 0, `${at}.publicationReserveMs`),
			advisoryLeaseTtlMs: int(r.advisoryLeaseTtlMs, 0, 0, `${at}.advisoryLeaseTtlMs`),
			relayMaxTransferredBytes: int(r.relayMaxTransferredBytes, 0, 0, `${at}.relayMaxTransferredBytes`),
			maxAnswerBytes: 4096,
		});
	}

	const maxOutputTokensPerRequest = int(
		r.maxOutputTokensPerRequest,
		ceiling.minOutputTokensPerRequest,
		ceiling.maxOutputTokensPerRequest,
		`${at}.maxOutputTokensPerRequest`,
	);
	const contextWindowTokens = int(
		r.contextWindowTokens,
		ceiling.minContextWindowTokens,
		ceiling.maxContextWindowTokens,
		`${at}.contextWindowTokens`,
	);
	if (
		contextWindowTokens <
		maxOutputTokensPerRequest + ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.minPromptHeadroomTokens
	) {
		fail(
			`${at}.contextWindowTokens must exceed maxOutputTokensPerRequest by at least ${ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.minPromptHeadroomTokens} tokens`,
		);
	}
	const reasoningControl = validateEndoCoordinatorReasoningControlV1(
		r.reasoningControl,
		maxOutputTokensPerRequest,
		true,
		`${at}.reasoningControl`,
	);
	const desiredVisibleAnswerTokens = int(
		r.desiredVisibleAnswerTokens,
		256,
		Math.min(4096, maxOutputTokensPerRequest),
		`${at}.desiredVisibleAnswerTokens`,
	);
	if (r.completionRequestsPerTurn !== 2) fail(`${at}.completionRequestsPerTurn must be 2 for inference tiers`);
	const expectedAggregate = 2 * maxOutputTokensPerRequest;
	if (r.maxAggregateGeneratedTokensPerTurn !== expectedAggregate)
		fail(`${at}.maxAggregateGeneratedTokensPerTurn must equal 2 * maxOutputTokensPerRequest (${expectedAggregate})`);
	const modelExecutionTimeoutMs = int(
		r.modelExecutionTimeoutMs,
		ceiling.minMemberTimeoutMs,
		ceiling.maxMemberTimeoutMs,
		`${at}.modelExecutionTimeoutMs`,
	);
	const advisoryTurnDeadlineMs = int(
		r.advisoryTurnDeadlineMs,
		Math.max(10_000, modelExecutionTimeoutMs),
		ceiling.maxTurnWallClockMs,
		`${at}.advisoryTurnDeadlineMs`,
	);
	const publicationReserveMs = int(
		r.publicationReserveMs,
		ceiling.minPublicationReserveMs,
		ceiling.maxPublicationReserveMs,
		`${at}.publicationReserveMs`,
	);
	const minLeaseTtlMs = advisoryTurnDeadlineMs + publicationReserveMs;
	if (minLeaseTtlMs > ceiling.maxLeaseTtlMs) {
		fail(
			`${at}.advisoryTurnDeadlineMs + publicationReserveMs (${minLeaseTtlMs} ms) exceeds ${tier} lease ceiling (${ceiling.maxLeaseTtlMs} ms)`,
		);
	}
	const advisoryLeaseTtlMs = int(
		r.advisoryLeaseTtlMs,
		minLeaseTtlMs,
		ceiling.maxLeaseTtlMs,
		`${at}.advisoryLeaseTtlMs`,
	);
	const relayMaxTransferredBytes = int(
		r.relayMaxTransferredBytes,
		ceiling.minRelayTransferredBytes,
		ceiling.maxRelayTransferredBytes,
		`${at}.relayMaxTransferredBytes`,
	);

	return Object.freeze({
		schemaVersion: ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1,
		tier,
		contextWindowTokens,
		maxOutputTokensPerRequest,
		reasoningControl,
		desiredVisibleAnswerTokens,
		desiredVisibleAnswerTokensAdvisoryOnly: true,
		completionRequestsPerTurn: 2,
		maxAggregateGeneratedTokensPerTurn: expectedAggregate,
		modelExecutionTimeoutMs,
		advisoryTurnDeadlineMs,
		publicationReserveMs,
		advisoryLeaseTtlMs,
		relayMaxTransferredBytes,
		maxAnswerBytes: 4096,
	});
}

/** Build a validated canonical resource profile for one named cognitive tier. */
export function presetEndoCoordinatorResourceProfileV1(
	tier: EndoCoordinatorResourceTierV1,
	overrides: {
		readonly reasoningControl?: EndoCoordinatorReasoningControlV1;
		readonly desiredVisibleAnswerTokens?: number;
		readonly modelExecutionTimeoutMs?: number;
		readonly advisoryTurnDeadlineMs?: number;
		readonly publicationReserveMs?: number;
		readonly advisoryLeaseTtlMs?: number;
		readonly contextWindowTokens?: number;
		readonly relayMaxTransferredBytes?: number;
	} = {},
): EndoCoordinatorResourceProfileV1 {
	const ceiling = ENDO_COORDINATOR_RESOURCE_TIER_CEILINGS_V1[tier];
	if (!ceiling.allowsInference) {
		return validateEndoCoordinatorResourceProfileV1({
			schemaVersion: ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1,
			tier: "reflex",
			contextWindowTokens: 0,
			maxOutputTokensPerRequest: 0,
			reasoningControl: { mode: "unchanged" },
			desiredVisibleAnswerTokens: 0,
			desiredVisibleAnswerTokensAdvisoryOnly: true,
			completionRequestsPerTurn: 0,
			maxAggregateGeneratedTokensPerTurn: 0,
			modelExecutionTimeoutMs: 0,
			advisoryTurnDeadlineMs: 0,
			publicationReserveMs: 0,
			advisoryLeaseTtlMs: 0,
			relayMaxTransferredBytes: 0,
			maxAnswerBytes: 4096,
		});
	}
	const defaultsByTier: Record<
		Exclude<EndoCoordinatorResourceTierV1, "reflex">,
		{
			readonly contextWindowTokens: number;
			readonly modelExecutionTimeoutMs: number;
			readonly advisoryTurnDeadlineMs: number;
			readonly publicationReserveMs: number;
			readonly advisoryLeaseTtlMs: number;
			readonly relayMaxTransferredBytes: number;
		}
	> = {
		light: {
			contextWindowTokens: 32_768,
			modelExecutionTimeoutMs: 360_000,
			advisoryTurnDeadlineMs: 420_000,
			publicationReserveMs: 60_000,
			advisoryLeaseTtlMs: 480_000,
			relayMaxTransferredBytes: 16 * MiB,
		},
		deliberate: {
			contextWindowTokens: 32_768,
			modelExecutionTimeoutMs: 480_000,
			advisoryTurnDeadlineMs: 540_000,
			publicationReserveMs: 60_000,
			advisoryLeaseTtlMs: 600_000,
			relayMaxTransferredBytes: 24 * MiB,
		},
		deep: {
			contextWindowTokens: 65_536,
			modelExecutionTimeoutMs: 720_000,
			advisoryTurnDeadlineMs: 780_000,
			publicationReserveMs: 60_000,
			advisoryLeaseTtlMs: 840_000,
			relayMaxTransferredBytes: 32 * MiB,
		},
		extended: {
			contextWindowTokens: 131_072,
			modelExecutionTimeoutMs: 1_080_000,
			advisoryTurnDeadlineMs: 1_140_000,
			publicationReserveMs: 60_000,
			advisoryLeaseTtlMs: 1_200_000,
			relayMaxTransferredBytes: 48 * MiB,
		},
	};
	const d = defaultsByTier[tier as Exclude<EndoCoordinatorResourceTierV1, "reflex">];
	return validateEndoCoordinatorResourceProfileV1({
		schemaVersion: ENDO_COORDINATOR_RESOURCE_POLICY_SCHEMA_V1,
		tier,
		contextWindowTokens: overrides.contextWindowTokens ?? d.contextWindowTokens,
		maxOutputTokensPerRequest: ceiling.maxOutputTokensPerRequest,
		reasoningControl: overrides.reasoningControl ?? { mode: "unchanged" },
		desiredVisibleAnswerTokens: overrides.desiredVisibleAnswerTokens ?? 1024,
		desiredVisibleAnswerTokensAdvisoryOnly: true,
		completionRequestsPerTurn: 2,
		maxAggregateGeneratedTokensPerTurn: 2 * ceiling.maxOutputTokensPerRequest,
		modelExecutionTimeoutMs: overrides.modelExecutionTimeoutMs ?? d.modelExecutionTimeoutMs,
		advisoryTurnDeadlineMs: overrides.advisoryTurnDeadlineMs ?? d.advisoryTurnDeadlineMs,
		publicationReserveMs: overrides.publicationReserveMs ?? d.publicationReserveMs,
		advisoryLeaseTtlMs: overrides.advisoryLeaseTtlMs ?? d.advisoryLeaseTtlMs,
		relayMaxTransferredBytes: overrides.relayMaxTransferredBytes ?? d.relayMaxTransferredBytes,
		maxAnswerBytes: 4096,
	});
}
