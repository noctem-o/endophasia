/**
 * Phase 10 — model/runtime orchestration (README "## Phase 10 — Model/runtime orchestration"):
 * the protocol-bound records and derived views for model orchestration. The phase adds
 * ModelPool, capability-aware routing, adaptive concurrency, queueing, retries, health,
 * performance/resource telemetry, and local-model integrations. Endophasia is not a
 * model-serving engine (README "Non-goals"): nothing here serves, calls, or contacts a
 * model. A profile records what a model is (identity, deployment, observation level,
 * declared capabilities); a pool records who is pooled and at what concurrency bound;
 * a telemetry record records what was observed in a window; the routing decision and
 * the scheduler state are derived views, computed by `models/orchestration.ts` and
 * serialized for persistence and replay, not ledger records.
 *
 * The local-model line follows the donor's honesty rule (README: "Experimental
 * local-model observation, never fabricated for API-only models"): the j-space
 * observation is a door on the profile, not an assumption — a hosted model profile
 * carrying j-space is not a profile.
 */

import type { EndoIdentifierKindV0 } from "./identity.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

/** A recorded identity or name: a non-empty string within the given length bound. Opaque by design. */
function isProfileTextV0(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** A declared capability: a non-empty string within the bound. */
function isCapabilityV0(value: unknown): value is string {
	return isProfileTextV0(value, 512);
}

/** A recorded non-negative integer: a finite, integral, non-negative number. */
function isNonNegativeIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** A recorded positive integer: a finite, integral number of at least one. */
function isPositiveIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1;
}

/** Where a model runs: a hosted (API-only) deployment, or a local deployment on the host. */
export type EndoModelDeploymentV0 = "hosted" | "local";

/** The closed model deployments. */
export const ENDO_MODEL_DEPLOYMENTS_V0 = ["hosted", "local"] as const satisfies readonly EndoModelDeploymentV0[];

/** The observation level a model permits. j-space is the experimental local-model observation. */
export type EndoModelObservationV0 = "none" | "j-space";

/** The closed observation levels. */
export const ENDO_MODEL_OBSERVATIONS_V0 = ["none", "j-space"] as const satisfies readonly EndoModelObservationV0[];

/**
 * A model profile: the identity and declared capabilities of one hosted or local model. A
 * ledger record in the endo.model.* namespace. The per-record door: a profile may claim the
 * j-space observation only when its deployment is local — never fabricated for an API-only
 * model.
 */
export interface EndoModelProfileV0 {
	schemaVersion: "endo.model-profile.v0";
	/** endo.model.* identifier. */
	id: string;
	/** The recorded model name, opaque. */
	name: string;
	/** The provider family: a well-formed dotted kind, open but well-formed. */
	provider: string;
	/** Where the model runs. */
	deployment: EndoModelDeploymentV0;
	/** The observation level the model permits. */
	observation: EndoModelObservationV0;
	/** The capabilities the model declares: 1-512 characters each, unique. */
	capabilities: string[];
}

const ENDO_MODEL_PROFILE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"name",
	"provider",
	"deployment",
	"observation",
	"capabilities",
]);

/**
 * Validates a model profile record. Rejects unknown fields, an id outside the endo.model.*
 * namespace, an over-long name, a provider outside the dotted-kind grammar, a deployment or
 * observation outside the closed sets, and capabilities that are not unique 1-512 character
 * strings. The local-model door: a hosted profile carrying the j-space observation is not a
 * profile (j-space observation is never fabricated for API-only models). Returns the
 * validated value unchanged, or null.
 */
export function validateEndoModelProfileV0(value: unknown): EndoModelProfileV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_PROFILE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-profile.v0") return null;
	if (!isEndoIdentifier(v.id, "model")) return null;
	if (!isProfileTextV0(v.name, 256)) return null;
	if (typeof v.provider !== "string" || !isWellFormedKindV0(v.provider)) return null;
	if (!(ENDO_MODEL_DEPLOYMENTS_V0 as readonly string[]).includes(v.deployment as string)) return null;
	if (!(ENDO_MODEL_OBSERVATIONS_V0 as readonly string[]).includes(v.observation as string)) return null;
	if (!Array.isArray(v.capabilities) || !v.capabilities.every((entry) => isCapabilityV0(entry))) return null;
	if (new Set(v.capabilities).size !== v.capabilities.length) return null;
	if (v.deployment === "hosted" && v.observation === "j-space") return null;
	return value as EndoModelProfileV0;
}

/** One member of a model pool: the pooled model and its concurrency bound. */
export interface EndoModelPoolMemberV0 {
	/** endo.model.* identifier. */
	modelId: string;
	/** The member's concurrency bound: a positive integer. */
	maxConcurrency: number;
}

/**
 * A model pool: which models are pooled and at what concurrency bound, named by the members'
 * model-profile identifiers. A ledger record in the endo.model.* namespace.
 */
export interface EndoModelPoolV0 {
	schemaVersion: "endo.model-pool.v0";
	/** endo.model.* identifier. */
	id: string;
	/** The pooled members, each with its concurrency bound. */
	members: EndoModelPoolMemberV0[];
}

const ENDO_MODEL_POOL_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "members"]);

const ENDO_MODEL_POOL_MEMBER_ALLOWED_KEYS_V0 = new Set(["modelId", "maxConcurrency"]);

/**
 * Validates a model pool record. Rejects unknown fields, an id outside the endo.model.*
 * namespace, a pool with no members, members whose modelId is not an endo.model.* identifier
 * or whose concurrency bound is not a positive integer, and duplicate members. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoModelPoolV0(value: unknown): EndoModelPoolV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_POOL_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-pool.v0") return null;
	if (!isEndoIdentifier(v.id, "model")) return null;
	if (!Array.isArray(v.members) || v.members.length === 0) return null;
	const seen = new Set<string>();
	for (const entry of v.members) {
		if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
		const m = entry as Record<string, unknown>;
		for (const key of Object.keys(m)) if (!ENDO_MODEL_POOL_MEMBER_ALLOWED_KEYS_V0.has(key)) return null;
		if (!isEndoIdentifier(m.modelId, "model")) return null;
		if (!isPositiveIntV0(m.maxConcurrency)) return null;
		if (seen.has(m.modelId)) return null;
		seen.add(m.modelId);
	}
	return value as EndoModelPoolV0;
}

/** The health observed at the end of a telemetry window. */
export type EndoModelHealthV0 = "healthy" | "degraded" | "unhealthy";

/** The closed health states. */
export const ENDO_MODEL_HEALTH_V0 = [
	"healthy",
	"degraded",
	"unhealthy",
] as const satisfies readonly EndoModelHealthV0[];

/**
 * A model telemetry record: payload-minimal performance/resource evidence for one observed
 * window of one model — identities, a health flag, and numbers only. A ledger record in the
 * endo.evidence.* namespace.
 */
export interface EndoModelTelemetryV0 {
	schemaVersion: "endo.model-telemetry.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The observed model: endo.model.* identifier. */
	modelId: string;
	/** The health observed at the end of the window. */
	health: EndoModelHealthV0;
	/** The recorded call count. */
	calls: number;
	/** The recorded input token count. */
	tokensIn: number;
	/** The recorded output token count. */
	tokensOut: number;
	/** The recorded failure count. */
	failures: number;
	/** The recorded wall-clock duration, in milliseconds. */
	durationMs: number;
}

const ENDO_MODEL_TELEMETRY_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"modelId",
	"health",
	"calls",
	"tokensIn",
	"tokensOut",
	"failures",
	"durationMs",
]);

/**
 * Validates a model telemetry record. Rejects unknown fields, an id outside the
 * endo.evidence.* namespace, a modelId outside the endo.model.* namespace, a health outside
 * the closed set, and counts or durations that are not non-negative integers. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoModelTelemetryV0(value: unknown): EndoModelTelemetryV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_TELEMETRY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-telemetry.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.modelId, "model")) return null;
	if (!(ENDO_MODEL_HEALTH_V0 as readonly string[]).includes(v.health as string)) return null;
	if (!isNonNegativeIntV0(v.calls)) return null;
	if (!isNonNegativeIntV0(v.tokensIn)) return null;
	if (!isNonNegativeIntV0(v.tokensOut)) return null;
	if (!isNonNegativeIntV0(v.failures)) return null;
	if (!isNonNegativeIntV0(v.durationMs)) return null;
	return value as EndoModelTelemetryV0;
}

/** Why a routing decision selected (or did not select) a model. */
export type EndoModelRoutingReasonV0 = "capability-match" | "no-eligible-model";

/** The closed routing reasons. */
export const ENDO_MODEL_ROUTING_REASONS_V0 = [
	"capability-match",
	"no-eligible-model",
] as const satisfies readonly EndoModelRoutingReasonV0[];

/**
 * The capability-aware routing decision for one pool against one capability request. A
 * derived report, serialized for persistence and replay; not itself a ledger record.
 */
export interface EndoModelRoutingDecisionV0 {
	schemaVersion: "endo.model-routing-decision.v0";
	/** endo.model.* identifier. */
	poolId: string;
	/** The requested capabilities: 1-512 characters each, unique. */
	requestedCapabilities: string[];
	/** The eligible member models, in pool-member order. */
	eligible: string[];
	/** The selected model, or null when no member is eligible. */
	selected: string | null;
	/** The closed reason for the selection. */
	reason: EndoModelRoutingReasonV0;
}

const ENDO_MODEL_ROUTING_DECISION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"poolId",
	"requestedCapabilities",
	"eligible",
	"selected",
	"reason",
]);

/**
 * Validates a routing decision report. Rejects unknown fields, a poolId outside the
 * endo.model.* namespace, requested capabilities that are not unique 1-512 character
 * strings, eligible entries or a selected entry outside the endo.model.* namespace, a
 * reason outside the closed set, and a report whose reason disagrees with its selection
 * (a selection exists exactly for the capability-match reason) or whose selection is not
 * one of its eligible models. Returns the validated value unchanged, or null.
 */
export function validateEndoModelRoutingDecisionV0(value: unknown): EndoModelRoutingDecisionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_ROUTING_DECISION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-routing-decision.v0") return null;
	if (!isEndoIdentifier(v.poolId, "model")) return null;
	if (!Array.isArray(v.requestedCapabilities) || !v.requestedCapabilities.every((entry) => isCapabilityV0(entry)))
		return null;
	if (new Set(v.requestedCapabilities).size !== v.requestedCapabilities.length) return null;
	if (!Array.isArray(v.eligible) || !v.eligible.every((entry) => isEndoIdentifier(entry, "model"))) return null;
	if (v.selected !== null && !isEndoIdentifier(v.selected, "model")) return null;
	if (!(ENDO_MODEL_ROUTING_REASONS_V0 as readonly string[]).includes(v.reason as string)) return null;
	if ((v.selected !== null) !== (v.reason === "capability-match")) return null;
	if (v.selected !== null && !v.eligible.includes(v.selected)) return null;
	return value as EndoModelRoutingDecisionV0;
}

/** One in-flight row of a scheduler state: a member model and its in-flight count. */
export interface EndoPoolSchedulerInFlightV0 {
	/** endo.model.* identifier. */
	modelId: string;
	/** The in-flight count: a non-negative integer. */
	count: number;
}

/** One per-member concurrency bound of a scheduler state: a member model and its live bound. */
export interface EndoPoolSchedulerBoundV0 {
	/** endo.model.* identifier. */
	modelId: string;
	/** The live concurrency bound: a positive integer. */
	maxConcurrency: number;
}

/**
 * The state of one model pool's scheduler: the in-flight count per member model (in
 * pool-member order, a row per member, zero when idle), the FIFO queue of already-routed work,
 * oldest first, and — when set — the live per-member concurrency bounds the scheduler honours
 * instead of the pool members' own maxima. A derived state, serialized for persistence and
 * replay; not itself a ledger record.
 */
export interface EndoPoolSchedulerStateV0 {
	schemaVersion: "endo.pool-scheduler-state.v0";
	/** endo.model.* identifier. */
	poolId: string;
	/** In-flight work per member model, in pool-member order. */
	inFlight: EndoPoolSchedulerInFlightV0[];
	/** The FIFO queue of already-routed work, oldest first. */
	queue: string[];
	/** The live per-member concurrency bounds, in pool-member order (absent when none are set). */
	bounds?: EndoPoolSchedulerBoundV0[];
}

const ENDO_POOL_SCHEDULER_STATE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "poolId", "inFlight", "queue", "bounds"]);

const ENDO_POOL_SCHEDULER_IN_FLIGHT_ALLOWED_KEYS_V0 = new Set(["modelId", "count"]);

const ENDO_POOL_SCHEDULER_BOUND_ALLOWED_KEYS_V0 = new Set(["modelId", "maxConcurrency"]);

/**
 * Validates a scheduler state. Rejects unknown fields, a poolId outside the endo.model.*
 * namespace, in-flight rows whose modelId is not an endo.model.* identifier or whose count
 * is not a non-negative integer, duplicate in-flight rows, queue entries outside the
 * endo.model.* namespace, and bounds rows with a duplicate modelId, a modelId outside the
 * endo.model.* namespace, or a maxConcurrency that is not a positive integer. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoPoolSchedulerStateV0(value: unknown): EndoPoolSchedulerStateV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_POOL_SCHEDULER_STATE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.pool-scheduler-state.v0") return null;
	if (!isEndoIdentifier(v.poolId, "model")) return null;
	if (!Array.isArray(v.inFlight)) return null;
	const seen = new Set<string>();
	for (const entry of v.inFlight) {
		if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) if (!ENDO_POOL_SCHEDULER_IN_FLIGHT_ALLOWED_KEYS_V0.has(key)) return null;
		if (!isEndoIdentifier(row.modelId, "model")) return null;
		if (!isNonNegativeIntV0(row.count)) return null;
		if (seen.has(row.modelId)) return null;
		seen.add(row.modelId);
	}
	if (!Array.isArray(v.queue) || !v.queue.every((entry) => isEndoIdentifier(entry, "model"))) return null;
	if (v.bounds !== undefined) {
		if (!Array.isArray(v.bounds)) return null;
		const seenBounds = new Set<string>();
		for (const entry of v.bounds) {
			if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
			const row = entry as Record<string, unknown>;
			for (const key of Object.keys(row)) if (!ENDO_POOL_SCHEDULER_BOUND_ALLOWED_KEYS_V0.has(key)) return null;
			if (!isEndoIdentifier(row.modelId, "model")) return null;
			if (!isPositiveIntV0(row.maxConcurrency)) return null;
			if (seenBounds.has(row.modelId)) return null;
			seenBounds.add(row.modelId);
		}
	}
	return value as EndoPoolSchedulerStateV0;
}

/** The kind of one scheduler event. */
export type EndoPoolSchedulerEventKindV0 = "enqueue" | "complete" | "retry";

/** The closed scheduler event kinds. */
export const ENDO_POOL_SCHEDULER_EVENT_KINDS_V0 = [
	"enqueue",
	"complete",
	"retry",
] as const satisfies readonly EndoPoolSchedulerEventKindV0[];

/**
 * One scheduler event: route a work item (enqueue), record a completion (complete), or
 * record a retry of a completed-or-failed work item (retry, carrying its retry number — 1
 * is the first retry). A recorded decision, not a ledger record.
 */
export interface EndoPoolSchedulerEventV0 {
	schemaVersion: "endo.pool-scheduler-event.v0";
	/** The kind of the event. */
	kind: EndoPoolSchedulerEventKindV0;
	/** endo.model.* identifier. */
	modelId: string;
	/** The retry number: present exactly when the kind is "retry". */
	attempt?: number;
}

const ENDO_POOL_SCHEDULER_EVENT_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "kind", "modelId", "attempt"]);

/**
 * Validates a scheduler event. Rejects unknown fields, a kind outside the closed set, a
 * modelId outside the endo.model.* namespace, a retry without a positive integer retry
 * number, and an enqueue or complete carrying a retry number (an unknown field for those
 * kinds). Returns the validated value unchanged, or null.
 */
export function validateEndoPoolSchedulerEventV0(value: unknown): EndoPoolSchedulerEventV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_POOL_SCHEDULER_EVENT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.pool-scheduler-event.v0") return null;
	if (!(ENDO_POOL_SCHEDULER_EVENT_KINDS_V0 as readonly string[]).includes(v.kind as string)) return null;
	if (!isEndoIdentifier(v.modelId, "model")) return null;
	if (v.kind === "retry") {
		if (!isPositiveIntV0(v.attempt)) return null;
	} else if (v.attempt !== undefined) {
		return null;
	}
	return value as EndoPoolSchedulerEventV0;
}

/** The closed routing criterion keys a routing policy may weigh. */
export type EndoRoutingCriterionKeyV0 =
	| "health"
	| "failureRate"
	| "latency"
	| "throughput"
	| "tokenThroughput"
	| "load"
	| "deployment"
	| "modelId";

/** The closed routing criterion keys. */
export const ENDO_ROUTING_CRITERION_KEYS_V0 = [
	"health",
	"failureRate",
	"latency",
	"throughput",
	"tokenThroughput",
	"load",
	"deployment",
	"modelId",
] as const satisfies readonly EndoRoutingCriterionKeyV0[];

/** One weighed criterion of a routing policy: a closed key and whether it gates eligibility. */
export interface EndoRoutingPolicyCriterionV0 {
	/** A closed routing criterion key. */
	key: EndoRoutingCriterionKeyV0;
	/** Whether the criterion gates eligibility (true) or only ranks (false). */
	required: boolean;
}

/**
 * A model routing policy: an explicit, versioned ordering of the closed criterion keys a routing
 * decision weighs, with a deployment preference declared only when a deployment criterion is
 * weighed. A ledger record in the endo.model.* namespace.
 */
export interface EndoModelRoutingPolicyV0 {
	schemaVersion: "endo.model-routing-policy.v0";
	/** endo.model.* identifier. */
	id: string;
	/** The recorded name: 1-256 characters. */
	name: string;
	/** The recorded revision: 1-64 characters. */
	revision: string;
	/** The weighed criteria, in policy order (1-8, unique keys). */
	criteria: EndoRoutingPolicyCriterionV0[];
	/** The deployment preference, present iff a deployment criterion is weighed. */
	deploymentPreference?: EndoModelDeploymentV0;
}

const ENDO_ROUTING_POLICY_CRITERION_ALLOWED_KEYS_V0 = new Set(["key", "required"]);

const ENDO_MODEL_ROUTING_POLICY_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"name",
	"revision",
	"criteria",
	"deploymentPreference",
]);

/**
 * Validates a model routing policy. Rejects unknown fields, an id outside the endo.model.*
 * namespace, a name or revision outside its length bound, a criterion list outside 1-8 entries,
 * a criterion row with a non-closed key, a non-boolean required flag, or a duplicate key, and
 * a deployment preference present without a weighed deployment criterion — or absent with one.
 * Returns the validated value unchanged, or null.
 */
export function validateEndoModelRoutingPolicyV0(value: unknown): EndoModelRoutingPolicyV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_ROUTING_POLICY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-routing-policy.v0") return null;
	if (!isEndoIdentifier(v.id, "model")) return null;
	if (!isProfileTextV0(v.name, 256)) return null;
	if (!isProfileTextV0(v.revision, 64)) return null;
	if (!Array.isArray(v.criteria) || v.criteria.length < 1 || v.criteria.length > 8) return null;
	const seen = new Set<string>();
	for (const entry of v.criteria) {
		if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) if (!ENDO_ROUTING_POLICY_CRITERION_ALLOWED_KEYS_V0.has(key)) return null;
		if (!(ENDO_ROUTING_CRITERION_KEYS_V0 as readonly string[]).includes(row.key as string)) return null;
		if (typeof row.required !== "boolean") return null;
		if (seen.has(row.key as string)) return null;
		seen.add(row.key as string);
	}
	if ((v.deploymentPreference !== undefined) !== seen.has("deployment")) return null;
	if (
		v.deploymentPreference !== undefined &&
		!(ENDO_MODEL_DEPLOYMENTS_V0 as readonly string[]).includes(v.deploymentPreference as string)
	) {
		return null;
	}
	return value as EndoModelRoutingPolicyV0;
}

/** The recorded evaluation of one weighed criterion for one candidate member. */
export interface EndoRoutingPolicyMemberEvaluationV0 {
	/** A closed routing criterion key. */
	criterion: EndoRoutingCriterionKeyV0;
	/** The recorded value: a finite number, a string, or an honest null. */
	value: number | string | null;
}

/** The recorded standing of one pool member under a routing policy decision. */
export interface EndoRoutingPolicyMemberV0 {
	/** endo.model.* identifier. */
	modelId: string;
	/** Whether the member passed every required criterion with source data present. */
	eligible: boolean;
	/** The requested capabilities the member's profile does not declare. */
	missingCapabilities: string[];
	/** The required criteria for which no source data is present. */
	missingData: EndoRoutingCriterionKeyV0[];
	/** The recorded evaluations, in policy criterion order. */
	evaluations: EndoRoutingPolicyMemberEvaluationV0[];
}

/** The recorded reason for one routing policy decision. */
export type EndoModelRoutingPolicyReasonV0 = "policy-selection" | "no-eligible-model" | "tie";

/** The closed routing policy decision reasons. */
export const ENDO_MODEL_ROUTING_POLICY_REASONS_V0 = [
	"policy-selection",
	"no-eligible-model",
	"tie",
] as const satisfies readonly EndoModelRoutingPolicyReasonV0[];

/**
 * A model routing policy decision: which pool member the policy selects for one capability
 * request, with the per-member standing (eligibility, missing capabilities, missing data, the
 * recorded evaluations) that explains the selection. A derived report, serialized for
 * persistence and replay; not itself a ledger record.
 */
export interface EndoModelRoutingPolicyDecisionV0 {
	schemaVersion: "endo.model-routing-policy-decision.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The deciding policy's endo.model.* identifier. */
	policyId: string;
	/** The deciding policy's recorded revision: 1-64 characters. */
	policyRevision: string;
	/** The decided pool's endo.model.* identifier. */
	poolId: string;
	/** The requested capabilities (0-16, unique, 1-512 characters each). */
	requestedCapabilities: string[];
	/** The recorded standing of each member, in pool order (unique, at least one). */
	members: EndoRoutingPolicyMemberV0[];
	/** The selected member's endo.model.* identifier, or null when none. */
	selectedId: string | null;
	/** The criterion that decided the selection, or null when none decided. */
	decidedBy: EndoRoutingCriterionKeyV0 | null;
	/** Why the decision is the way it is. */
	reason: EndoModelRoutingPolicyReasonV0;
}

const ENDO_ROUTING_POLICY_MEMBER_EVALUATION_ALLOWED_KEYS_V0 = new Set(["criterion", "value"]);

const ENDO_ROUTING_POLICY_MEMBER_ALLOWED_KEYS_V0 = new Set([
	"modelId",
	"eligible",
	"missingCapabilities",
	"missingData",
	"evaluations",
]);

const ENDO_MODEL_ROUTING_POLICY_DECISION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"policyId",
	"policyRevision",
	"poolId",
	"requestedCapabilities",
	"members",
	"selectedId",
	"decidedBy",
	"reason",
]);

/**
 * Validates a routing policy decision. Rejects unknown fields, ids outside their namespaces, a
 * policy revision outside its length bound, requested capabilities outside 0-16 entries with a
 * duplicate or an entry outside the capability bound, members with a duplicate modelId or fewer
 * than one entry, a member row with a non-boolean eligible flag, a missing-capability entry
 * outside the capability bound, a missing-data entry outside the closed criterion keys, an
 * evaluation with a non-closed criterion or a value outside a finite number, a string, or
 * null, a selectedId that is not null and not one of the eligible members' ids, a decidedBy
 * outside the closed criterion keys or null, and the reason invariants: policy-selection
 * selects a member, no-eligible-model and tie select none. Returns the validated value
 * unchanged, or null.
 */
export function validateEndoModelRoutingPolicyDecisionV0(value: unknown): EndoModelRoutingPolicyDecisionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_ROUTING_POLICY_DECISION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-routing-policy-decision.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.policyId, "model")) return null;
	if (!isProfileTextV0(v.policyRevision, 64)) return null;
	if (!isEndoIdentifier(v.poolId, "model")) return null;
	if (!Array.isArray(v.requestedCapabilities) || v.requestedCapabilities.length > 16) return null;
	const seenCapabilities = new Set<string>();
	for (const entry of v.requestedCapabilities) {
		if (!isCapabilityV0(entry)) return null;
		if (seenCapabilities.has(entry)) return null;
		seenCapabilities.add(entry);
	}
	if (!Array.isArray(v.members) || v.members.length < 1) return null;
	const seenMembers = new Set<string>();
	const eligibleIds = new Set<string>();
	for (const entry of v.members) {
		if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) if (!ENDO_ROUTING_POLICY_MEMBER_ALLOWED_KEYS_V0.has(key)) return null;
		if (!isEndoIdentifier(row.modelId, "model")) return null;
		if (seenMembers.has(row.modelId)) return null;
		seenMembers.add(row.modelId);
		if (typeof row.eligible !== "boolean") return null;
		if (row.eligible) eligibleIds.add(row.modelId);
		if (!Array.isArray(row.missingCapabilities)) return null;
		for (const entry of row.missingCapabilities) if (!isCapabilityV0(entry)) return null;
		if (!Array.isArray(row.missingData)) return null;
		for (const entry of row.missingData) {
			if (!(ENDO_ROUTING_CRITERION_KEYS_V0 as readonly string[]).includes(entry as string)) return null;
		}
		if (!Array.isArray(row.evaluations)) return null;
		for (const entry of row.evaluations) {
			if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
			const evaluation = entry as Record<string, unknown>;
			for (const key of Object.keys(evaluation)) {
				if (!ENDO_ROUTING_POLICY_MEMBER_EVALUATION_ALLOWED_KEYS_V0.has(key)) return null;
			}
			if (!(ENDO_ROUTING_CRITERION_KEYS_V0 as readonly string[]).includes(evaluation.criterion as string)) {
				return null;
			}
			const evaluationValue = evaluation.value;
			if (evaluationValue !== null && typeof evaluationValue !== "number" && typeof evaluationValue !== "string") {
				return null;
			}
			if (typeof evaluationValue === "number" && !Number.isFinite(evaluationValue)) return null;
		}
	}
	if (v.selectedId !== null && (!isEndoIdentifier(v.selectedId, "model") || !eligibleIds.has(v.selectedId))) {
		return null;
	}
	if (v.decidedBy !== null && !(ENDO_ROUTING_CRITERION_KEYS_V0 as readonly string[]).includes(v.decidedBy as string)) {
		return null;
	}
	if (!(ENDO_MODEL_ROUTING_POLICY_REASONS_V0 as readonly string[]).includes(v.reason as string)) return null;
	if (v.reason === "policy-selection") {
		if (v.selectedId === null) return null;
	} else if (v.selectedId !== null) {
		return null;
	}
	return value as EndoModelRoutingPolicyDecisionV0;
}

/**
 * A model concurrency policy: the explicit, versioned thresholds one adaptive concurrency plan
 * applies per pool member — the observation window, the step size, the concurrency floor, and
 * the failure and latency thresholds with the hysteresis band between the increase and
 * decrease failure thresholds. A ledger record in the endo.model.* namespace.
 */
export interface EndoModelConcurrencyPolicyV0 {
	schemaVersion: "endo.model-concurrency-policy.v0";
	/** endo.model.* identifier. */
	id: string;
	/** The recorded name: 1-256 characters. */
	name: string;
	/** The recorded revision: 1-64 characters. */
	revision: string;
	/** The telemetry records observed per model: 1-1024. */
	windowSize: number;
	/** The concurrency step applied per decision: 1-64. */
	step: number;
	/** The concurrency floor: a positive integer up to 1024. */
	minConcurrency: number;
	/** The window failure rate above which concurrency decreases: 0 < t < 1. */
	failureDecreaseThreshold: number;
	/** The window failure rate below which concurrency increases: 0 <= t < the decrease threshold. */
	failureIncreaseThreshold: number;
	/** The window mean latency in milliseconds below which an increase is permitted, when present: a non-negative integer. */
	latencyIncreaseThresholdMs?: number;
}

const ENDO_MODEL_CONCURRENCY_POLICY_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"name",
	"revision",
	"windowSize",
	"step",
	"minConcurrency",
	"failureDecreaseThreshold",
	"failureIncreaseThreshold",
	"latencyIncreaseThresholdMs",
]);

/**
 * Validates a model concurrency policy. Rejects unknown fields, an id outside the endo.model.*
 * namespace, a name or revision outside its length bound, a window size or step outside its
 * integer bound, a minConcurrency outside its integer bound, a failure decrease threshold
 * outside 0 < t < 1, a failure increase threshold outside 0 <= t < the decrease threshold, and
 * a latency increase threshold, when present, that is not a non-negative integer. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoModelConcurrencyPolicyV0(value: unknown): EndoModelConcurrencyPolicyV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_CONCURRENCY_POLICY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-concurrency-policy.v0") return null;
	if (!isEndoIdentifier(v.id, "model")) return null;
	if (!isProfileTextV0(v.name, 256)) return null;
	if (!isProfileTextV0(v.revision, 64)) return null;
	if (!isPositiveIntV0(v.windowSize) || v.windowSize > 1024) return null;
	if (!isPositiveIntV0(v.step) || v.step > 64) return null;
	if (!isPositiveIntV0(v.minConcurrency) || v.minConcurrency > 1024) return null;
	if (typeof v.failureDecreaseThreshold !== "number" || !Number.isFinite(v.failureDecreaseThreshold)) return null;
	if (v.failureDecreaseThreshold <= 0 || v.failureDecreaseThreshold >= 1) return null;
	if (typeof v.failureIncreaseThreshold !== "number" || !Number.isFinite(v.failureIncreaseThreshold)) return null;
	if (v.failureIncreaseThreshold < 0 || v.failureIncreaseThreshold >= v.failureDecreaseThreshold) return null;
	if (v.latencyIncreaseThresholdMs !== undefined && !isNonNegativeIntV0(v.latencyIncreaseThresholdMs)) return null;
	return value as EndoModelConcurrencyPolicyV0;
}

/** The direction of one concurrency plan row's change. */
export type EndoModelConcurrencyChangeV0 = "increase" | "decrease" | "hold";

/** The closed concurrency plan row change directions. */
export const ENDO_MODEL_CONCURRENCY_CHANGES_V0 = [
	"increase",
	"decrease",
	"hold",
] as const satisfies readonly EndoModelConcurrencyChangeV0[];

/** The recorded reason for one concurrency plan row. */
export type EndoModelConcurrencyPlanReasonV0 =
	| "failure-threshold"
	| "performance-threshold"
	| "no-telemetry"
	| "insufficient-window"
	| "at-bound"
	| "steady";

/** The closed concurrency plan row reasons. */
export const ENDO_MODEL_CONCURRENCY_PLAN_REASONS_V0 = [
	"failure-threshold",
	"performance-threshold",
	"no-telemetry",
	"insufficient-window",
	"at-bound",
	"steady",
] as const satisfies readonly EndoModelConcurrencyPlanReasonV0[];

/** One row of a concurrency plan: a member's current count, its target, and the recorded why. */
export interface EndoModelConcurrencyPlanRowV0 {
	/** endo.model.* identifier. */
	modelId: string;
	/** The current concurrency: a positive integer. */
	current: number;
	/** The target concurrency: a positive integer. */
	target: number;
	/** The direction of the change. */
	change: EndoModelConcurrencyChangeV0;
	/** The recorded reason. */
	reason: EndoModelConcurrencyPlanReasonV0;
}

/**
 * A model concurrency plan: the per-member targets the adaptive concurrency policy computed
 * for one pool, with the recorded reason per row. A derived report, serialized for persistence
 * and replay; not itself a ledger record.
 */
export interface EndoModelConcurrencyPlanV0 {
	schemaVersion: "endo.model-concurrency-plan.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The planned pool's endo.model.* identifier. */
	poolId: string;
	/** The deciding policy's endo.model.* identifier. */
	policyId: string;
	/** The deciding policy's recorded revision: 1-64 characters. */
	policyRevision: string;
	/** The plan rows, one per pool member (unique modelIds, at least one). */
	rows: EndoModelConcurrencyPlanRowV0[];
}

const ENDO_MODEL_CONCURRENCY_PLAN_ROW_ALLOWED_KEYS_V0 = new Set(["modelId", "current", "target", "change", "reason"]);

const ENDO_MODEL_CONCURRENCY_PLAN_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"poolId",
	"policyId",
	"policyRevision",
	"rows",
]);

/**
 * Validates a concurrency plan. Rejects unknown fields, ids outside their namespaces, a policy
 * revision outside its length bound, rows with a duplicate modelId or fewer than one entry, a
 * row with a modelId outside the endo.model.* namespace or a current or target that is not a
 * positive integer, a change outside the closed set, a reason outside the closed set, and the
 * direction invariants: increase raises the target above the current, decrease lowers it
 * below, hold keeps it equal. Returns the validated value unchanged, or null.
 */
export function validateEndoModelConcurrencyPlanV0(value: unknown): EndoModelConcurrencyPlanV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_CONCURRENCY_PLAN_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-concurrency-plan.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.poolId, "model")) return null;
	if (!isEndoIdentifier(v.policyId, "model")) return null;
	if (!isProfileTextV0(v.policyRevision, 64)) return null;
	if (!Array.isArray(v.rows) || v.rows.length < 1) return null;
	const seen = new Set<string>();
	for (const entry of v.rows) {
		if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) return null;
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) if (!ENDO_MODEL_CONCURRENCY_PLAN_ROW_ALLOWED_KEYS_V0.has(key)) return null;
		if (!isEndoIdentifier(row.modelId, "model")) return null;
		if (seen.has(row.modelId)) return null;
		seen.add(row.modelId);
		if (!isPositiveIntV0(row.current)) return null;
		if (!isPositiveIntV0(row.target)) return null;
		if (!(ENDO_MODEL_CONCURRENCY_CHANGES_V0 as readonly string[]).includes(row.change as string)) return null;
		if (!(ENDO_MODEL_CONCURRENCY_PLAN_REASONS_V0 as readonly string[]).includes(row.reason as string)) return null;
		if (row.change === "increase" && row.target <= row.current) return null;
		if (row.change === "decrease" && row.target >= row.current) return null;
		if (row.change === "hold" && row.target !== row.current) return null;
	}
	return value as EndoModelConcurrencyPlanV0;
}
