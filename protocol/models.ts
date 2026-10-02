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
	if (typeof value !== "object" || value === null) return null;
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
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MODEL_POOL_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.model-pool.v0") return null;
	if (!isEndoIdentifier(v.id, "model")) return null;
	if (!Array.isArray(v.members) || v.members.length === 0) return null;
	const seen = new Set<string>();
	for (const entry of v.members) {
		if (typeof entry !== "object" || entry === null) return null;
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
	if (typeof value !== "object" || value === null) return null;
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
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return null;
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

/**
 * The state of one model pool's scheduler: the in-flight count per member model (in
 * pool-member order, a row per member, zero when idle) and the FIFO queue of already-routed
 * work, oldest first. A derived state, serialized for persistence and replay; not itself a
 * ledger record.
 */
export interface EndoPoolSchedulerStateV0 {
	schemaVersion: "endo.pool-scheduler-state.v0";
	/** endo.model.* identifier. */
	poolId: string;
	/** In-flight work per member model, in pool-member order. */
	inFlight: EndoPoolSchedulerInFlightV0[];
	/** The FIFO queue of already-routed work, oldest first. */
	queue: string[];
}

const ENDO_POOL_SCHEDULER_STATE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "poolId", "inFlight", "queue"]);

const ENDO_POOL_SCHEDULER_IN_FLIGHT_ALLOWED_KEYS_V0 = new Set(["modelId", "count"]);

/**
 * Validates a scheduler state. Rejects unknown fields, a poolId outside the endo.model.*
 * namespace, in-flight rows whose modelId is not an endo.model.* identifier or whose count
 * is not a non-negative integer, duplicate in-flight rows, and queue entries outside the
 * endo.model.* namespace. Returns the validated value unchanged, or null.
 */
export function validateEndoPoolSchedulerStateV0(value: unknown): EndoPoolSchedulerStateV0 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_POOL_SCHEDULER_STATE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.pool-scheduler-state.v0") return null;
	if (!isEndoIdentifier(v.poolId, "model")) return null;
	if (!Array.isArray(v.inFlight)) return null;
	const seen = new Set<string>();
	for (const entry of v.inFlight) {
		if (typeof entry !== "object" || entry === null) return null;
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) if (!ENDO_POOL_SCHEDULER_IN_FLIGHT_ALLOWED_KEYS_V0.has(key)) return null;
		if (!isEndoIdentifier(row.modelId, "model")) return null;
		if (!isNonNegativeIntV0(row.count)) return null;
		if (seen.has(row.modelId)) return null;
		seen.add(row.modelId);
	}
	if (!Array.isArray(v.queue) || !v.queue.every((entry) => isEndoIdentifier(entry, "model"))) return null;
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
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const proto = Object.getPrototypeOf(value);
	if (proto !== null && proto !== Object.prototype) return null;
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
