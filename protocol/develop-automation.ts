// Versioned contracts for S1 — Deterministic Coordinator Observations and Durable Schedule Ledger
// (`COORDINATOR-AUTOMATION-S1`, docs/designs/coordinator-automation.md Appendix B,
// docs/designs/coordinator-automation-s1-implementation.md).
//
// Closed schemas:
//   - `endo.develop-schedules.v0`             (<root>/develop/automation/schedules.json)
//   - `endo.develop-automation-lease.v0`      (<root>/develop/automation/lease.json)
//   - `endo.develop-schedule-fire-claim.v0`   (<root>/develop/automation/fires/<idempotencyKey>.claimed.json)
//   - `endo.develop-schedule-fire-outcome.v0` (<root>/develop/automation/fires/<idempotencyKey>.outcome.json)
//   - `endo.develop-resource-observation.v0`  (<root>/develop/automation/resources.json)
//   - `endo.develop-resource-declarations.v0` (<root>/develop/automation/declarations.json)
//
// Invariants:
// - Protocol imports only protocol.
// - No executable command strings, callbacks, shell strings, or credentials appear in any record.
// - S1 action kinds are strictly read-only (`observe-health`, `refresh-projection`).
// - `tokensConsumed` is literally `0` in every S1 fire outcome and resource observation.
// - Every persisted and externally supplied object is closed: unknown keys are refused.

import {
	ENDO_COORDINATOR_MODEL_ID_PATTERN_V0,
	ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0,
	endoCoordinatorLoopbackOriginV0,
} from "./coordinator-model-pool.ts";
import {
	type EndoSessionLivenessObservationV0,
	validateEndoSessionLivenessObservationV0,
} from "./develop-session-liveness.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	endoBoundedDetailV0,
	endoFirstUnknownKeyV0,
	parseEndoVersionedV0,
	readEndoVersionedV0,
} from "./versioned.ts";

export const ENDO_DEVELOP_SCHEDULES_SCHEMA_V0 = "endo.develop-schedules.v0";
export const ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0 = "endo.develop-automation-lease.v0";
export const ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0 = "endo.develop-schedule-fire-claim.v0";
export const ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0 = "endo.develop-schedule-fire-outcome.v0";
export const ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0 = "endo.develop-resource-observation.v0";
export const ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0 = "endo.develop-resource-declarations.v0";

export const ENDO_SCHEDULE_ACTION_KINDS_V0 = ["observe-health", "refresh-projection"] as const;
export type EndoScheduleActionKindV0 = (typeof ENDO_SCHEDULE_ACTION_KINDS_V0)[number];

export const ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0 = ["skip-and-report", "coalesce-once"] as const;
export type EndoScheduleMissedRunPolicyV0 = (typeof ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0)[number];

export const ENDO_SCHEDULE_TRIGGER_KINDS_V0 = ["once", "interval", "calendar"] as const;
export type EndoScheduleTriggerKindV0 = (typeof ENDO_SCHEDULE_TRIGGER_KINDS_V0)[number];

export const ENDO_CALENDAR_CADENCES_V0 = ["hourly", "daily", "weekly"] as const;
export type EndoCalendarCadenceV0 = (typeof ENDO_CALENDAR_CADENCES_V0)[number];

/**
 * Explicit DST transition policy for calendar schedules:
 * - Spring-forward nonexistent local wall-time is skipped (never shifted silently to another hour).
 * - Fall-back ambiguous local wall-time fires once at the first chronological UTC instant.
 */
export const ENDO_CALENDAR_DST_POLICIES_V0 = ["skip-nonexistent-first-ambiguous"] as const;
export type EndoCalendarDstPolicyV0 = (typeof ENDO_CALENDAR_DST_POLICIES_V0)[number];

export const ENDO_SCHEDULE_FIRE_OUTCOME_STATUSES_V0 = [
	"completed",
	"missed-skipped",
	"failed",
	"cancelled-schedule-changed",
] as const;
export type EndoScheduleFireOutcomeStatusV0 = (typeof ENDO_SCHEDULE_FIRE_OUTCOME_STATUSES_V0)[number];

export const ENDO_SCHEDULE_FIRE_PROJECTED_STATES_V0 = [
	"claimed-incomplete",
	"completed",
	"missed-skipped",
	"failed",
	"cancelled-schedule-changed",
	"orphan-outcome",
] as const;
export type EndoScheduleFireProjectedStateV0 = (typeof ENDO_SCHEDULE_FIRE_PROJECTED_STATES_V0)[number];

export const ENDO_RESOURCE_OBSERVATION_BASES_V0 = [
	"authoritative-api",
	"controller-observed",
	"passive-response-header",
	"operator-declared",
	"controller-ledger-estimate",
	"unknown",
] as const;
export type EndoResourceObservationBasisV0 = (typeof ENDO_RESOURCE_OBSERVATION_BASES_V0)[number];

export const ENDO_ALLOWANCE_STANDINGS_V0 = [
	"available",
	"approaching-limit",
	"exhausted-until-reset",
	"degraded-endpoint",
	"unknown",
] as const;
export type EndoAllowanceStandingV0 = (typeof ENDO_ALLOWANCE_STANDINGS_V0)[number];

export const ENDO_PROVIDER_SURFACE_KINDS_V0 = [
	"subscription-window",
	"api-rate-limit",
	"local-compute",
	"unknown",
] as const;
export type EndoProviderSurfaceKindV0 = (typeof ENDO_PROVIDER_SURFACE_KINDS_V0)[number];

export const ENDO_ALLOWANCE_WINDOW_KINDS_V0 = [
	"rolling-5h",
	"weekly",
	"rpm",
	"tpm",
	"rpd",
	"credit-balance",
	"local-vram",
	"custom",
] as const;
export type EndoAllowanceWindowKindV0 = (typeof ENDO_ALLOWANCE_WINDOW_KINDS_V0)[number];

export const ENDO_ALLOWANCE_WINDOW_UNITS_V0 = [
	"requests",
	"tokens",
	"credits-usd-micros",
	"bytes",
	"turns",
	"unknown",
] as const;
export type EndoAllowanceWindowUnitV0 = (typeof ENDO_ALLOWANCE_WINDOW_UNITS_V0)[number];

export const ENDO_RESET_BASES_V0 = [
	"authoritative-api",
	"passive-response-header",
	"operator-declared",
	"unknown",
] as const;
export type EndoResetBasisV0 = (typeof ENDO_RESET_BASES_V0)[number];

export const ENDO_OPERATOR_DECLARABLE_STANDINGS_V0 = ["exhausted-until-reset", "approaching-limit", "unknown"] as const;
export type EndoOperatorDeclarableStandingV0 = (typeof ENDO_OPERATOR_DECLARABLE_STANDINGS_V0)[number];

export const ENDO_HARDWARE_DEVICE_KINDS_V0 = ["gpu", "cpu", "memory", "accelerator-unknown"] as const;
export type EndoHardwareDeviceKindV0 = (typeof ENDO_HARDWARE_DEVICE_KINDS_V0)[number];

export const ENDO_HARDWARE_MEMORY_BASES_V0 = ["controller-observed", "operator-declared", "unknown"] as const;
export type EndoHardwareMemoryBasisV0 = (typeof ENDO_HARDWARE_MEMORY_BASES_V0)[number];

export const ENDO_SHARED_DEVICE_CONTENTION_V0 = ["unknown", "none-observed", "shared-multiple-members"] as const;
export type EndoSharedDeviceContentionV0 = (typeof ENDO_SHARED_DEVICE_CONTENTION_V0)[number];

export const ENDO_HARDWARE_OBSERVATION_MODES_V0 = [
	"extension-seam-unobserved",
	"passive-host-os-only",
	"injected-observer",
] as const;
export type EndoHardwareObservationModeV0 = (typeof ENDO_HARDWARE_OBSERVATION_MODES_V0)[number];

export const ENDO_LOCAL_ENDPOINT_READINESS_V0 = [
	"ready",
	"capacity-unknown",
	"model-unconfirmed",
	"loading",
	"saturated",
	"model-unavailable",
	"unhealthy",
	"unreachable",
	"probe-refused",
] as const;
export type EndoLocalEndpointReadinessV0 = (typeof ENDO_LOCAL_ENDPOINT_READINESS_V0)[number];

export const ENDO_LOCAL_ENDPOINT_PROBE_DETAILS_V0 = [
	"slot-idle",
	"slots-not-observable",
	"router-model-state-not-observed",
	"backend-unidentified",
	"model-listed-residency-unknown",
	"model-sleep-state-unknown",
	"model-sleeping",
	"model-listing-unavailable",
	"model-not-listed",
	"server-loading",
	"no-idle-slot",
	"health-error",
	"connect-failed",
	"timeout",
	"cancelled",
	"redirect",
	"response-too-large",
	"malformed-response",
	"destination-mismatch",
] as const;
export type EndoLocalEndpointProbeDetailV0 = (typeof ENDO_LOCAL_ENDPOINT_PROBE_DETAILS_V0)[number];

export const ENDO_LOCAL_ENDPOINT_BACKENDS_V0 = [
	"llama.cpp-router",
	"llama.cpp-single",
	"openai-compatible",
	"unknown",
] as const;
export type EndoLocalEndpointBackendV0 = (typeof ENDO_LOCAL_ENDPOINT_BACKENDS_V0)[number];

export const ENDO_SCHEDULE_ID_PATTERN_V0 = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const ENDO_PROVIDER_ID_PATTERN_V0 = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const ENDO_QUOTA_POOL_ID_PATTERN_V0 = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
export const ENDO_HOLDER_ID_PATTERN_V0 = /^[\x21-\x7e]{1,128}$/;
export const ENDO_DEVICE_ID_PATTERN_V0 = /^[\x21-\x7e]{1,128}$/;
export const ENDO_SHA256_HEX_PATTERN_V0 = /^[0-9a-f]{64}$/;
export const ENDO_TIMEZONE_PATTERN_V0 = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const SAFE_TEXT_128 = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/;
const SAFE_TEXT_256 = /^[^\u0000-\u001f\u007f-\u009f]{1,256}$/;
const SAFE_TEXT_512 = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/;
const SAFE_PATH_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,1024}$/;
const SAFE_HTTP_PATH = /^\/[\x21-\x7e]{0,127}$/;

const MAX_EPOCH_MS = 8.64e15;

export const ENDO_DEVELOP_AUTOMATION_LIMITS_V0 = Object.freeze({
	maxSchedules: 64,
	maxRetiredCursors: 256,
	maxFileBytes: 512 * 1024,
	maxLeaseFileBytes: 16 * 1024,
	maxFireRecordBytes: 64 * 1024,
	maxFirePairsRetained: 256,
	maxFireDirectoryEntries: 2048,
	maxProbesPerTick: 16,
	maxProbeConcurrency: 4,
	maxDueSchedulesPerTick: 64,
	minIntervalMs: 1_000,
	maxIntervalMs: 365 * 24 * 60 * 60 * 1_000,
	minLeaseTtlMs: 1_000,
	maxLeaseTtlMs: 300_000,
	defaultLeaseTtlMs: 60_000,
	minTickBudgetMs: 100,
	maxTickBudgetMs: 120_000,
	defaultTickBudgetMs: 30_000,
	minStaleAfterMs: 1_000,
	maxStaleAfterMs: 7 * 24 * 60 * 60 * 1_000,
	defaultStaleAfterMs: 300_000,
	defaultOnTimeGraceMs: 60_000,
	maxLocalEndpointsObserved: 16,
	maxProvidersObserved: 32,
	maxDeclarations: 64,
	maxAllowanceWindowsPerProvider: 8,
	maxSessionsObserved: 128,
	maxWorktreesObserved: 64,
	maxHardwareDevicesObserved: 16,
	maxAttributedMembersPerDevice: 32,
	maxResourceLeasesPerDevice: 16,
	maxRequestsPerEndpointProbe: 8,
	maxProjectionGaps: 32,
});

// ---- Schedule Types ----------------------------------------------------------------------------------------------------------------

export type EndoCalendarSpecV0 =
	| { readonly cadence: "hourly"; readonly minute: number }
	| { readonly cadence: "daily"; readonly hour: number; readonly minute: number }
	| { readonly cadence: "weekly"; readonly weekday: number; readonly hour: number; readonly minute: number };

export type EndoScheduleTriggerV0 =
	| { readonly kind: "once"; readonly atMs: number }
	| { readonly kind: "interval"; readonly everyMs: number; readonly anchorMs: number }
	| {
			readonly kind: "calendar";
			readonly timezone: string;
			readonly schedule: EndoCalendarSpecV0;
			readonly dstPolicy: EndoCalendarDstPolicyV0;
	  };

export interface EndoScheduleCursorV0 {
	readonly lastEvaluatedAtMs: number | null;
	/** Monotonic high-water mark: no window <= this timestamp may ever become eligible again, even after fire history pruning. */
	readonly lastConsumedWindowStartMs: number | null;
	/** For `once` schedules: true after the single window has been claimed or missed-skipped. */
	readonly completedOnce: boolean;
	readonly lastFireIdempotencyKey: string | null;
	readonly lastFireStatus: EndoScheduleFireOutcomeStatusV0 | null;
}

export interface EndoDevelopScheduleV0 {
	readonly scheduleId: string;
	readonly label: string | null;
	readonly revision: number;
	readonly enabled: boolean;
	readonly actionKind: EndoScheduleActionKindV0;
	readonly missedRunPolicy: EndoScheduleMissedRunPolicyV0;
	readonly trigger: EndoScheduleTriggerV0;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly cursor: EndoScheduleCursorV0;
}

export interface EndoDevelopRetiredScheduleCursorV0 {
	readonly scheduleId: string;
	readonly lastConsumedWindowStartMs: number;
	readonly retiredAtMs: number;
}

export interface EndoDevelopSchedulesFileV0 {
	readonly schemaVersion: typeof ENDO_DEVELOP_SCHEDULES_SCHEMA_V0;
	readonly revision: number;
	readonly updatedAtMs: number;
	readonly schedules: readonly EndoDevelopScheduleV0[];
	readonly retiredCursors: readonly EndoDevelopRetiredScheduleCursorV0[];
}

// ---- Lease Types -------------------------------------------------------------------------------------------------------------------

export interface EndoDevelopAutomationLeaseV0 {
	readonly schemaVersion: typeof ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0;
	readonly holderId: string;
	readonly epoch: number;
	readonly acquiredAtMs: number;
	readonly expiresAtMs: number;
	readonly releasedAtMs: number | null;
}

// ---- Fire Claim & Outcome Types ----------------------------------------------------------------------------------------------------

export interface EndoDevelopScheduleFireClaimV0 {
	readonly schemaVersion: typeof ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0;
	readonly idempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly actionKind: EndoScheduleActionKindV0;
	readonly triggerKind: EndoScheduleTriggerKindV0;
	readonly triggerCursor: string;
	readonly windowStartMs: number;
	readonly missedWindowsBefore: number;
	readonly claimedAtMs: number;
	readonly leaseEpoch: number;
	readonly holderId: string;
}

export interface EndoDevelopScheduleFireOutcomeV0 {
	readonly schemaVersion: typeof ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0;
	readonly idempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly actionKind: EndoScheduleActionKindV0;
	readonly windowStartMs: number;
	readonly completedAtMs: number;
	readonly leaseEpoch: number;
	readonly holderId: string;
	readonly status: EndoScheduleFireOutcomeStatusV0;
	readonly missedWindowCount: number;
	readonly observationDigest: string | null;
	readonly detail: string | null;
	readonly tokensConsumed: 0;
}

// ---- Resource Observation & Operator Declaration Types -----------------------------------------------------------------------------

export interface EndoObservedLocalEndpointV0 {
	readonly memberId: string;
	readonly endpoint: string;
	readonly modelId: string;
	readonly basis: "controller-observed";
	readonly observedAtMs: number;
	readonly staleAfterMs: number;
	readonly elapsedMs: number;
	readonly readiness: EndoLocalEndpointReadinessV0;
	readonly detail: EndoLocalEndpointProbeDetailV0;
	readonly backend: EndoLocalEndpointBackendV0;
	readonly build: string | null;
	readonly requests: readonly { readonly path: string; readonly status: number | null }[];
	readonly deviceId: string | null;
	readonly inferenceTokens: 0;
}

export interface EndoAllowanceWindowObservationV0 {
	readonly windowKind: EndoAllowanceWindowKindV0;
	readonly resetAtMs: number | null;
	readonly resetBasis: EndoResetBasisV0;
	/** Strictly false unless backed by a fresh authoritative API response; an operator estimate or elapsed reset is never confirmed. */
	readonly availabilityConfirmed: boolean;
	readonly remainingEstimate: number | null;
	readonly limitEstimate: number | null;
	readonly unit: EndoAllowanceWindowUnitV0;
}

export interface EndoLocalLedgerLowerBoundV0 {
	readonly recordedTurns: number;
	readonly recordedAtMs: number;
	readonly note: "local-endophasia-lower-bound-only";
}

export interface EndoProviderAllowanceObservationV0 {
	readonly providerId: string;
	readonly surfaceKind: EndoProviderSurfaceKindV0;
	readonly quotaPoolId: string | null;
	readonly standing: EndoAllowanceStandingV0;
	readonly basis: EndoResourceObservationBasisV0;
	readonly observedAtMs: number;
	readonly staleAfterMs: number;
	readonly windows: readonly EndoAllowanceWindowObservationV0[];
	readonly localLedgerLowerBound: EndoLocalLedgerLowerBoundV0 | null;
	readonly detail: string | null;
}

export interface EndoWorktreeObservationSummaryV0 {
	readonly projectId: string;
	readonly worktreePath: string;
	readonly worktreeId: string | null;
	readonly activeHazardCount: number;
	readonly writeConflictCount: number;
	readonly driftedCandidateCount: number;
	readonly observedAtMs: number;
	readonly basis: "controller-observed" | "recorded" | "unavailable";
}

export interface EndoHardwareDeviceObservationV0 {
	readonly deviceId: string;
	readonly kind: EndoHardwareDeviceKindV0;
	readonly backendFamily: string | null;
	readonly label: string | null;
	readonly memoryTotalBytes: number | null;
	readonly memoryUsedBytes: number | null;
	readonly memoryFreeBytes: number | null;
	readonly memoryBasis: EndoHardwareMemoryBasisV0;
	readonly attributedModelMemberIds: readonly string[];
	readonly sharedDeviceContention: EndoSharedDeviceContentionV0;
	readonly activeResourceLeaseIds: readonly string[];
	readonly supportsCpuOnlyDecisionModel: boolean;
}

export interface EndoHardwareObservationSnapshotV0 {
	readonly mode: EndoHardwareObservationModeV0;
	readonly observedAtMs: number;
	readonly staleAfterMs: number;
	readonly devices: readonly EndoHardwareDeviceObservationV0[];
}

export interface EndoProjectionSummaryObservationV0 {
	readonly statusSha256: string | null;
	readonly coordinationSha256: string | null;
	readonly projectCount: number;
	readonly activeAssignmentCount: number;
	readonly unresolvedHazardCount: number;
	readonly gaps: readonly string[];
}

export interface EndoDevelopResourceObservationV0 {
	readonly schemaVersion: typeof ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0;
	readonly leaseEpoch: number;
	readonly holderId: string;
	readonly observedAtMs: number;
	readonly publishedAtMs: number;
	readonly staleAfterMs: number;
	readonly tokensConsumed: 0;
	readonly modelPool: {
		readonly poolSha256: string | null;
		readonly poolSource: "file" | "m0-default" | "none";
		readonly localEndpoints: readonly EndoObservedLocalEndpointV0[];
	};
	readonly providers: readonly EndoProviderAllowanceObservationV0[];
	readonly sessions: readonly EndoSessionLivenessObservationV0[];
	readonly worktrees: readonly EndoWorktreeObservationSummaryV0[];
	readonly hardware: EndoHardwareObservationSnapshotV0;
	readonly projectionSummary: EndoProjectionSummaryObservationV0 | null;
}

export interface EndoOperatorResourceWindowDeclarationV0 {
	readonly providerId: string;
	readonly surfaceKind: EndoProviderSurfaceKindV0;
	readonly quotaPoolId: string | null;
	readonly windowKind: EndoAllowanceWindowKindV0;
	readonly standing: EndoOperatorDeclarableStandingV0;
	readonly resetAtMs: number;
	readonly declaredAtMs: number;
	readonly basis: "operator-declared";
	readonly note: string | null;
}

export interface EndoDevelopResourceDeclarationsFileV0 {
	readonly schemaVersion: typeof ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0;
	readonly revision: number;
	readonly updatedAtMs: number;
	readonly declarations: readonly EndoOperatorResourceWindowDeclarationV0[];
}

// ---- Validation Helpers ------------------------------------------------------------------------------------------------------------

function fail(detail: string): never {
	throw new EndoInvalidRecordV0(endoBoundedDetailV0(detail));
}

function asArray(value: unknown, max: number, at: string): readonly unknown[] {
	if (!Array.isArray(value)) fail(`${at} must be an array`);
	if (value.length > max) fail(`${at} exceeds limit of ${max}`);
	return value;
}

function closed(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const unknown = endoFirstUnknownKeyV0(record, keys);
	if (unknown !== undefined) fail(`${at} has an unknown field ${JSON.stringify(String(unknown))}`);
	for (const k of keys) if (!Object.hasOwn(record, k)) fail(`${at}.${k} is required`);
	return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
		fail(`${at} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
	return value as T;
}

function intRange(value: unknown, min: number, max: number, at: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		fail(`${at} must be an integer from ${min} to ${max}`);
	return value as number;
}

function nullableIntRange(value: unknown, min: number, max: number, at: string): number | null {
	return value === null ? null : intRange(value, min, max, at);
}

function pattern(value: unknown, re: RegExp, at: string, desc: string): string {
	if (typeof value !== "string" || !re.test(value)) fail(`${at} must be ${desc}`);
	return value as string;
}

function nullablePattern(value: unknown, re: RegExp, at: string, desc: string): string | null {
	return value === null ? null : pattern(value, re, at, desc);
}

function bool(value: unknown, at: string): boolean {
	if (typeof value !== "boolean") fail(`${at} must be a boolean`);
	return value as boolean;
}

/** Validate an IANA timezone name (or `"UTC"`) without external dependencies. */
export function isValidEndoIanaTimezoneV0(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
	if (!ENDO_TIMEZONE_PATTERN_V0.test(value)) return false;
	try {
		const fmt = new Intl.DateTimeFormat("en-US", { timeZone: value });
		const resolved = fmt.resolvedOptions().timeZone;
		return typeof resolved === "string" && resolved.length > 0;
	} catch {
		return false;
	}
}

export function validateEndoScheduleTriggerV0(value: unknown, at = "trigger"): EndoScheduleTriggerV0 {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const kind = oneOf((value as Record<string, unknown>).kind, ENDO_SCHEDULE_TRIGGER_KINDS_V0, `${at}.kind`);
	if (kind === "once") {
		const r = closed(value, ["kind", "atMs"], at);
		return Object.freeze({ kind: "once", atMs: intRange(r.atMs, 1, MAX_EPOCH_MS, `${at}.atMs`) });
	}
	if (kind === "interval") {
		const r = closed(value, ["kind", "everyMs", "anchorMs"], at);
		return Object.freeze({
			kind: "interval",
			everyMs: intRange(
				r.everyMs,
				ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minIntervalMs,
				ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxIntervalMs,
				`${at}.everyMs`,
			),
			anchorMs: intRange(r.anchorMs, 1, MAX_EPOCH_MS, `${at}.anchorMs`),
		});
	}
	const r = closed(value, ["kind", "timezone", "schedule", "dstPolicy"], at);
	if (!isValidEndoIanaTimezoneV0(r.timezone)) fail(`${at}.timezone must be a valid IANA timezone`);
	const dstPolicy = oneOf(r.dstPolicy, ENDO_CALENDAR_DST_POLICIES_V0, `${at}.dstPolicy`);
	if (!isPlainJsonObjectV0(r.schedule)) fail(`${at}.schedule must be a JSON object`);
	const cadence = oneOf(
		(r.schedule as Record<string, unknown>).cadence,
		ENDO_CALENDAR_CADENCES_V0,
		`${at}.schedule.cadence`,
	);
	let schedule: EndoCalendarSpecV0;
	if (cadence === "hourly") {
		const s = closed(r.schedule, ["cadence", "minute"], `${at}.schedule`);
		schedule = Object.freeze({ cadence: "hourly", minute: intRange(s.minute, 0, 59, `${at}.schedule.minute`) });
	} else if (cadence === "daily") {
		const s = closed(r.schedule, ["cadence", "hour", "minute"], `${at}.schedule`);
		schedule = Object.freeze({
			cadence: "daily",
			hour: intRange(s.hour, 0, 23, `${at}.schedule.hour`),
			minute: intRange(s.minute, 0, 59, `${at}.schedule.minute`),
		});
	} else {
		const s = closed(r.schedule, ["cadence", "weekday", "hour", "minute"], `${at}.schedule`);
		schedule = Object.freeze({
			cadence: "weekly",
			weekday: intRange(s.weekday, 0, 6, `${at}.schedule.weekday`),
			hour: intRange(s.hour, 0, 23, `${at}.schedule.hour`),
			minute: intRange(s.minute, 0, 59, `${at}.schedule.minute`),
		});
	}
	return Object.freeze({
		kind: "calendar",
		timezone: r.timezone,
		schedule,
		dstPolicy,
	});
}

function validateScheduleCursor(value: unknown, at: string): EndoScheduleCursorV0 {
	const r = closed(
		value,
		["lastEvaluatedAtMs", "lastConsumedWindowStartMs", "completedOnce", "lastFireIdempotencyKey", "lastFireStatus"],
		at,
	);
	return Object.freeze({
		lastEvaluatedAtMs: nullableIntRange(r.lastEvaluatedAtMs, 0, MAX_EPOCH_MS, `${at}.lastEvaluatedAtMs`),
		lastConsumedWindowStartMs: nullableIntRange(
			r.lastConsumedWindowStartMs,
			0,
			MAX_EPOCH_MS,
			`${at}.lastConsumedWindowStartMs`,
		),
		completedOnce: bool(r.completedOnce, `${at}.completedOnce`),
		lastFireIdempotencyKey: nullablePattern(
			r.lastFireIdempotencyKey,
			ENDO_SHA256_HEX_PATTERN_V0,
			`${at}.lastFireIdempotencyKey`,
			"a 64-hex SHA-256 digest",
		),
		lastFireStatus:
			r.lastFireStatus === null
				? null
				: oneOf(r.lastFireStatus, ENDO_SCHEDULE_FIRE_OUTCOME_STATUSES_V0, `${at}.lastFireStatus`),
	});
}

function validateSchedule(value: unknown, at: string): EndoDevelopScheduleV0 {
	const r = closed(
		value,
		[
			"scheduleId",
			"label",
			"revision",
			"enabled",
			"actionKind",
			"missedRunPolicy",
			"trigger",
			"createdAtMs",
			"updatedAtMs",
			"cursor",
		],
		at,
	);
	const createdAtMs = intRange(r.createdAtMs, 1, MAX_EPOCH_MS, `${at}.createdAtMs`);
	const updatedAtMs = intRange(r.updatedAtMs, 1, MAX_EPOCH_MS, `${at}.updatedAtMs`);
	if (updatedAtMs < createdAtMs) fail(`${at}.updatedAtMs cannot precede createdAtMs`);
	return Object.freeze({
		scheduleId: pattern(
			r.scheduleId,
			ENDO_SCHEDULE_ID_PATTERN_V0,
			`${at}.scheduleId`,
			"1-64 lowercase letters, digits, or inner ._-",
		),
		label: nullablePattern(r.label, SAFE_TEXT_128, `${at}.label`, "1-128 printable characters"),
		revision: intRange(r.revision, 1, Number.MAX_SAFE_INTEGER, `${at}.revision`),
		enabled: bool(r.enabled, `${at}.enabled`),
		actionKind: oneOf(r.actionKind, ENDO_SCHEDULE_ACTION_KINDS_V0, `${at}.actionKind`),
		missedRunPolicy: oneOf(r.missedRunPolicy, ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0, `${at}.missedRunPolicy`),
		trigger: validateEndoScheduleTriggerV0(r.trigger, `${at}.trigger`),
		createdAtMs,
		updatedAtMs,
		cursor: validateScheduleCursor(r.cursor, `${at}.cursor`),
	});
}

function validateRetiredCursor(value: unknown, at: string): EndoDevelopRetiredScheduleCursorV0 {
	const r = closed(value, ["scheduleId", "lastConsumedWindowStartMs", "retiredAtMs"], at);
	return Object.freeze({
		scheduleId: pattern(
			r.scheduleId,
			ENDO_SCHEDULE_ID_PATTERN_V0,
			`${at}.scheduleId`,
			"1-64 lowercase letters, digits, or inner ._-",
		),
		lastConsumedWindowStartMs: intRange(
			r.lastConsumedWindowStartMs,
			0,
			MAX_EPOCH_MS,
			`${at}.lastConsumedWindowStartMs`,
		),
		retiredAtMs: intRange(r.retiredAtMs, 1, MAX_EPOCH_MS, `${at}.retiredAtMs`),
	});
}

export function validateEndoDevelopSchedulesFileV0(value: unknown): EndoDevelopSchedulesFileV0 {
	const r = closed(
		value,
		["schemaVersion", "revision", "updatedAtMs", "schedules", "retiredCursors"],
		"schedules file",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_SCHEDULES_SCHEMA_V0)
		fail(`schedules file.schemaVersion must be ${JSON.stringify(ENDO_DEVELOP_SCHEDULES_SCHEMA_V0)}`);
	const schedules = asArray(
		r.schedules,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxSchedules,
		"schedules file.schedules",
	).map((s, i) => validateSchedule(s, `schedules[${i}]`));
	const ids = new Set<string>();
	for (const s of schedules) {
		if (ids.has(s.scheduleId)) fail(`duplicate scheduleId ${JSON.stringify(s.scheduleId)}`);
		ids.add(s.scheduleId);
	}
	const retiredCursors = asArray(
		r.retiredCursors,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxRetiredCursors,
		"schedules file.retiredCursors",
	).map((c, i) => validateRetiredCursor(c, `retiredCursors[${i}]`));
	const retiredIds = new Set<string>();
	for (const c of retiredCursors) {
		if (retiredIds.has(c.scheduleId)) fail(`duplicate retired scheduleId ${JSON.stringify(c.scheduleId)}`);
		retiredIds.add(c.scheduleId);
	}

	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
		revision: intRange(r.revision, 0, Number.MAX_SAFE_INTEGER, "schedules file.revision"),
		updatedAtMs: intRange(r.updatedAtMs, 0, MAX_EPOCH_MS, "schedules file.updatedAtMs"),
		schedules: Object.freeze(schedules),
		retiredCursors: Object.freeze(retiredCursors),
	});
}

export function emptyEndoDevelopSchedulesFileV0(): EndoDevelopSchedulesFileV0 {
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
		revision: 0,
		updatedAtMs: 0,
		schedules: Object.freeze([]),
		retiredCursors: Object.freeze([]),
	});
}

export function validateEndoDevelopAutomationLeaseV0(value: unknown): EndoDevelopAutomationLeaseV0 {
	const r = closed(
		value,
		["schemaVersion", "holderId", "epoch", "acquiredAtMs", "expiresAtMs", "releasedAtMs"],
		"lease",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0)
		fail(`lease.schemaVersion must be ${JSON.stringify(ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0)}`);
	const acquiredAtMs = intRange(r.acquiredAtMs, 1, MAX_EPOCH_MS, "lease.acquiredAtMs");
	const expiresAtMs = intRange(r.expiresAtMs, 1, MAX_EPOCH_MS, "lease.expiresAtMs");
	if (expiresAtMs <= acquiredAtMs) fail("lease.expiresAtMs must be strictly after lease.acquiredAtMs");
	if (expiresAtMs - acquiredAtMs > ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxLeaseTtlMs)
		fail(`lease TTL exceeds maximum ${ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxLeaseTtlMs} ms`);
	const releasedAtMs = nullableIntRange(r.releasedAtMs, 1, MAX_EPOCH_MS, "lease.releasedAtMs");
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
		holderId: pattern(r.holderId, ENDO_HOLDER_ID_PATTERN_V0, "lease.holderId", "1-128 printable ASCII chars"),
		epoch: intRange(r.epoch, 1, Number.MAX_SAFE_INTEGER, "lease.epoch"),
		acquiredAtMs,
		expiresAtMs,
		releasedAtMs,
	});
}

export function validateEndoDevelopScheduleFireClaimV0(value: unknown): EndoDevelopScheduleFireClaimV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"idempotencyKey",
			"scheduleId",
			"scheduleRevision",
			"actionKind",
			"triggerKind",
			"triggerCursor",
			"windowStartMs",
			"missedWindowsBefore",
			"claimedAtMs",
			"leaseEpoch",
			"holderId",
		],
		"fire claim",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0)
		fail(`fire claim.schemaVersion must be ${JSON.stringify(ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0)}`);
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
		idempotencyKey: pattern(
			r.idempotencyKey,
			ENDO_SHA256_HEX_PATTERN_V0,
			"fire claim.idempotencyKey",
			"64-hex SHA-256",
		),
		scheduleId: pattern(r.scheduleId, ENDO_SCHEDULE_ID_PATTERN_V0, "fire claim.scheduleId", "valid scheduleId"),
		scheduleRevision: intRange(r.scheduleRevision, 1, Number.MAX_SAFE_INTEGER, "fire claim.scheduleRevision"),
		actionKind: oneOf(r.actionKind, ENDO_SCHEDULE_ACTION_KINDS_V0, "fire claim.actionKind"),
		triggerKind: oneOf(r.triggerKind, ENDO_SCHEDULE_TRIGGER_KINDS_V0, "fire claim.triggerKind"),
		triggerCursor: pattern(r.triggerCursor, SAFE_TEXT_256, "fire claim.triggerCursor", "1-256 printable chars"),
		windowStartMs: intRange(r.windowStartMs, 1, MAX_EPOCH_MS, "fire claim.windowStartMs"),
		missedWindowsBefore: intRange(
			r.missedWindowsBefore,
			0,
			Number.MAX_SAFE_INTEGER,
			"fire claim.missedWindowsBefore",
		),
		claimedAtMs: intRange(r.claimedAtMs, 1, MAX_EPOCH_MS, "fire claim.claimedAtMs"),
		leaseEpoch: intRange(r.leaseEpoch, 1, Number.MAX_SAFE_INTEGER, "fire claim.leaseEpoch"),
		holderId: pattern(r.holderId, ENDO_HOLDER_ID_PATTERN_V0, "fire claim.holderId", "1-128 printable ASCII chars"),
	});
}

export function validateEndoDevelopScheduleFireOutcomeV0(value: unknown): EndoDevelopScheduleFireOutcomeV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"idempotencyKey",
			"scheduleId",
			"scheduleRevision",
			"actionKind",
			"windowStartMs",
			"completedAtMs",
			"leaseEpoch",
			"holderId",
			"status",
			"missedWindowCount",
			"observationDigest",
			"detail",
			"tokensConsumed",
		],
		"fire outcome",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0)
		fail(`fire outcome.schemaVersion must be ${JSON.stringify(ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0)}`);
	if (r.tokensConsumed !== 0) fail("fire outcome.tokensConsumed must be 0 in S1");
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
		idempotencyKey: pattern(
			r.idempotencyKey,
			ENDO_SHA256_HEX_PATTERN_V0,
			"fire outcome.idempotencyKey",
			"64-hex SHA-256",
		),
		scheduleId: pattern(r.scheduleId, ENDO_SCHEDULE_ID_PATTERN_V0, "fire outcome.scheduleId", "valid scheduleId"),
		scheduleRevision: intRange(r.scheduleRevision, 1, Number.MAX_SAFE_INTEGER, "fire outcome.scheduleRevision"),
		actionKind: oneOf(r.actionKind, ENDO_SCHEDULE_ACTION_KINDS_V0, "fire outcome.actionKind"),
		windowStartMs: intRange(r.windowStartMs, 1, MAX_EPOCH_MS, "fire outcome.windowStartMs"),
		completedAtMs: intRange(r.completedAtMs, 1, MAX_EPOCH_MS, "fire outcome.completedAtMs"),
		leaseEpoch: intRange(r.leaseEpoch, 1, Number.MAX_SAFE_INTEGER, "fire outcome.leaseEpoch"),
		holderId: pattern(r.holderId, ENDO_HOLDER_ID_PATTERN_V0, "fire outcome.holderId", "1-128 printable ASCII chars"),
		status: oneOf(r.status, ENDO_SCHEDULE_FIRE_OUTCOME_STATUSES_V0, "fire outcome.status"),
		missedWindowCount: intRange(r.missedWindowCount, 0, Number.MAX_SAFE_INTEGER, "fire outcome.missedWindowCount"),
		observationDigest: nullablePattern(
			r.observationDigest,
			ENDO_SHA256_HEX_PATTERN_V0,
			"fire outcome.observationDigest",
			"64-hex SHA-256",
		),
		detail: nullablePattern(r.detail, SAFE_TEXT_512, "fire outcome.detail", "1-512 printable chars"),
		tokensConsumed: 0,
	});
}

function validateObservedLocalEndpoint(value: unknown, at: string): EndoObservedLocalEndpointV0 {
	const r = closed(
		value,
		[
			"memberId",
			"endpoint",
			"modelId",
			"basis",
			"observedAtMs",
			"staleAfterMs",
			"elapsedMs",
			"readiness",
			"detail",
			"backend",
			"build",
			"requests",
			"deviceId",
			"inferenceTokens",
		],
		at,
	);
	if (r.basis !== "controller-observed") fail(`${at}.basis must be "controller-observed"`);
	if (r.inferenceTokens !== 0) fail(`${at}.inferenceTokens must be 0`);
	const origin = endoCoordinatorLoopbackOriginV0(r.endpoint);
	if (!origin.ok) fail(`${at}.endpoint: ${origin.reason}`);
	const requests = asArray(
		r.requests,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxRequestsPerEndpointProbe,
		`${at}.requests`,
	).map((req, idx) => {
		const q = closed(req, ["path", "status"], `${at}.requests[${idx}]`);
		return Object.freeze({
			path: pattern(q.path, SAFE_HTTP_PATH, `${at}.requests[${idx}].path`, "a bounded HTTP path"),
			status: nullableIntRange(q.status, 100, 599, `${at}.requests[${idx}].status`),
		});
	});
	return Object.freeze({
		memberId: pattern(
			r.memberId,
			ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0,
			`${at}.memberId`,
			"valid pool memberId",
		),
		endpoint: r.endpoint as string,
		modelId: pattern(r.modelId, ENDO_COORDINATOR_MODEL_ID_PATTERN_V0, `${at}.modelId`, "valid modelId"),
		basis: "controller-observed",
		observedAtMs: intRange(r.observedAtMs, 1, MAX_EPOCH_MS, `${at}.observedAtMs`),
		staleAfterMs: intRange(
			r.staleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minStaleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxStaleAfterMs,
			`${at}.staleAfterMs`,
		),
		elapsedMs: intRange(r.elapsedMs, 0, 300_000, `${at}.elapsedMs`),
		readiness: oneOf(r.readiness, ENDO_LOCAL_ENDPOINT_READINESS_V0, `${at}.readiness`),
		detail: oneOf(r.detail, ENDO_LOCAL_ENDPOINT_PROBE_DETAILS_V0, `${at}.detail`),
		backend: oneOf(r.backend, ENDO_LOCAL_ENDPOINT_BACKENDS_V0, `${at}.backend`),
		build: nullablePattern(r.build, SAFE_TEXT_128, `${at}.build`, "1-128 printable chars"),
		requests: Object.freeze(requests),
		deviceId: nullablePattern(r.deviceId, ENDO_DEVICE_ID_PATTERN_V0, `${at}.deviceId`, "valid deviceId"),
		inferenceTokens: 0,
	});
}

function validateAllowanceWindow(value: unknown, at: string): EndoAllowanceWindowObservationV0 {
	const r = closed(
		value,
		["windowKind", "resetAtMs", "resetBasis", "availabilityConfirmed", "remainingEstimate", "limitEstimate", "unit"],
		at,
	);
	const resetBasis = oneOf(r.resetBasis, ENDO_RESET_BASES_V0, `${at}.resetBasis`);
	const availabilityConfirmed = bool(r.availabilityConfirmed, `${at}.availabilityConfirmed`);
	// Honesty enforcement: operator-declared or unknown reset estimates can never claim confirmed availability.
	if (availabilityConfirmed && resetBasis !== "authoritative-api")
		fail(`${at}.availabilityConfirmed cannot be true when resetBasis is ${JSON.stringify(resetBasis)}`);
	return Object.freeze({
		windowKind: oneOf(r.windowKind, ENDO_ALLOWANCE_WINDOW_KINDS_V0, `${at}.windowKind`),
		resetAtMs: nullableIntRange(r.resetAtMs, 1, MAX_EPOCH_MS, `${at}.resetAtMs`),
		resetBasis,
		availabilityConfirmed,
		remainingEstimate: nullableIntRange(r.remainingEstimate, 0, Number.MAX_SAFE_INTEGER, `${at}.remainingEstimate`),
		limitEstimate: nullableIntRange(r.limitEstimate, 0, Number.MAX_SAFE_INTEGER, `${at}.limitEstimate`),
		unit: oneOf(r.unit, ENDO_ALLOWANCE_WINDOW_UNITS_V0, `${at}.unit`),
	});
}

function validateProviderAllowance(value: unknown, at: string): EndoProviderAllowanceObservationV0 {
	const r = closed(
		value,
		[
			"providerId",
			"surfaceKind",
			"quotaPoolId",
			"standing",
			"basis",
			"observedAtMs",
			"staleAfterMs",
			"windows",
			"localLedgerLowerBound",
			"detail",
		],
		at,
	);
	const windows = asArray(
		r.windows,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxAllowanceWindowsPerProvider,
		`${at}.windows`,
	).map((w, i) => validateAllowanceWindow(w, `${at}.windows[${i}]`));
	let localLedgerLowerBound: EndoLocalLedgerLowerBoundV0 | null = null;
	if (r.localLedgerLowerBound !== null) {
		const lb = closed(
			r.localLedgerLowerBound,
			["recordedTurns", "recordedAtMs", "note"],
			`${at}.localLedgerLowerBound`,
		);
		if (lb.note !== "local-endophasia-lower-bound-only")
			fail(`${at}.localLedgerLowerBound.note must be "local-endophasia-lower-bound-only"`);
		localLedgerLowerBound = Object.freeze({
			recordedTurns: intRange(
				lb.recordedTurns,
				0,
				Number.MAX_SAFE_INTEGER,
				`${at}.localLedgerLowerBound.recordedTurns`,
			),
			recordedAtMs: intRange(lb.recordedAtMs, 0, MAX_EPOCH_MS, `${at}.localLedgerLowerBound.recordedAtMs`),
			note: "local-endophasia-lower-bound-only",
		});
	}
	const basis = oneOf(r.basis, ENDO_RESOURCE_OBSERVATION_BASES_V0, `${at}.basis`);
	const standing = oneOf(r.standing, ENDO_ALLOWANCE_STANDINGS_V0, `${at}.standing`);
	// Honesty enforcement: operator-declared or unknown signals cannot assert confirmed `available` standing.
	if (
		standing === "available" &&
		(basis === "unknown" || basis === "operator-declared" || basis === "controller-ledger-estimate")
	)
		fail(`${at}.standing cannot be "available" under basis ${JSON.stringify(basis)}`);
	return Object.freeze({
		providerId: pattern(r.providerId, ENDO_PROVIDER_ID_PATTERN_V0, `${at}.providerId`, "valid providerId"),
		surfaceKind: oneOf(r.surfaceKind, ENDO_PROVIDER_SURFACE_KINDS_V0, `${at}.surfaceKind`),
		quotaPoolId: nullablePattern(
			r.quotaPoolId,
			ENDO_QUOTA_POOL_ID_PATTERN_V0,
			`${at}.quotaPoolId`,
			"valid quotaPoolId",
		),
		standing,
		basis,
		observedAtMs: intRange(r.observedAtMs, 1, MAX_EPOCH_MS, `${at}.observedAtMs`),
		staleAfterMs: intRange(
			r.staleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minStaleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxStaleAfterMs,
			`${at}.staleAfterMs`,
		),
		windows: Object.freeze(windows),
		localLedgerLowerBound,
		detail: nullablePattern(r.detail, SAFE_TEXT_512, `${at}.detail`, "1-512 printable chars"),
	});
}

function validateWorktreeSummary(value: unknown, at: string): EndoWorktreeObservationSummaryV0 {
	const r = closed(
		value,
		[
			"projectId",
			"worktreePath",
			"worktreeId",
			"activeHazardCount",
			"writeConflictCount",
			"driftedCandidateCount",
			"observedAtMs",
			"basis",
		],
		at,
	);
	return Object.freeze({
		projectId: pattern(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, `${at}.projectId`, "valid endo.project id"),
		worktreePath: pattern(r.worktreePath, SAFE_PATH_TEXT, `${at}.worktreePath`, "bounded path"),
		worktreeId: nullablePattern(r.worktreeId, SAFE_TEXT_128, `${at}.worktreeId`, "bounded worktreeId"),
		activeHazardCount: intRange(r.activeHazardCount, 0, 10_000, `${at}.activeHazardCount`),
		writeConflictCount: intRange(r.writeConflictCount, 0, 10_000, `${at}.writeConflictCount`),
		driftedCandidateCount: intRange(r.driftedCandidateCount, 0, 10_000, `${at}.driftedCandidateCount`),
		observedAtMs: intRange(r.observedAtMs, 1, MAX_EPOCH_MS, `${at}.observedAtMs`),
		basis: oneOf(r.basis, ["controller-observed", "recorded", "unavailable"] as const, `${at}.basis`),
	});
}

function validateHardwareDevice(value: unknown, at: string): EndoHardwareDeviceObservationV0 {
	const r = closed(
		value,
		[
			"deviceId",
			"kind",
			"backendFamily",
			"label",
			"memoryTotalBytes",
			"memoryUsedBytes",
			"memoryFreeBytes",
			"memoryBasis",
			"attributedModelMemberIds",
			"sharedDeviceContention",
			"activeResourceLeaseIds",
			"supportsCpuOnlyDecisionModel",
		],
		at,
	);
	const attributedModelMemberIds = asArray(
		r.attributedModelMemberIds,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxAttributedMembersPerDevice,
		`${at}.attributedModelMemberIds`,
	).map((m, i) =>
		pattern(
			m,
			ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0,
			`${at}.attributedModelMemberIds[${i}]`,
			"valid memberId",
		),
	);
	const activeResourceLeaseIds = asArray(
		r.activeResourceLeaseIds,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxResourceLeasesPerDevice,
		`${at}.activeResourceLeaseIds`,
	).map((id, i) => pattern(id, ENDO_DEVICE_ID_PATTERN_V0, `${at}.activeResourceLeaseIds[${i}]`, "valid lease id"));
	return Object.freeze({
		deviceId: pattern(r.deviceId, ENDO_DEVICE_ID_PATTERN_V0, `${at}.deviceId`, "valid deviceId"),
		kind: oneOf(r.kind, ENDO_HARDWARE_DEVICE_KINDS_V0, `${at}.kind`),
		backendFamily: nullablePattern(r.backendFamily, SAFE_TEXT_128, `${at}.backendFamily`, "1-128 printable chars"),
		label: nullablePattern(r.label, SAFE_TEXT_128, `${at}.label`, "1-128 printable chars"),
		memoryTotalBytes: nullableIntRange(r.memoryTotalBytes, 0, Number.MAX_SAFE_INTEGER, `${at}.memoryTotalBytes`),
		memoryUsedBytes: nullableIntRange(r.memoryUsedBytes, 0, Number.MAX_SAFE_INTEGER, `${at}.memoryUsedBytes`),
		memoryFreeBytes: nullableIntRange(r.memoryFreeBytes, 0, Number.MAX_SAFE_INTEGER, `${at}.memoryFreeBytes`),
		memoryBasis: oneOf(r.memoryBasis, ENDO_HARDWARE_MEMORY_BASES_V0, `${at}.memoryBasis`),
		attributedModelMemberIds: Object.freeze(attributedModelMemberIds),
		sharedDeviceContention: oneOf(
			r.sharedDeviceContention,
			ENDO_SHARED_DEVICE_CONTENTION_V0,
			`${at}.sharedDeviceContention`,
		),
		activeResourceLeaseIds: Object.freeze(activeResourceLeaseIds),
		supportsCpuOnlyDecisionModel: bool(r.supportsCpuOnlyDecisionModel, `${at}.supportsCpuOnlyDecisionModel`),
	});
}

function validateHardwareSnapshot(value: unknown, at: string): EndoHardwareObservationSnapshotV0 {
	const r = closed(value, ["mode", "observedAtMs", "staleAfterMs", "devices"], at);
	const devices = asArray(
		r.devices,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxHardwareDevicesObserved,
		`${at}.devices`,
	).map((d, i) => validateHardwareDevice(d, `${at}.devices[${i}]`));
	const ids = new Set<string>();
	for (const d of devices) {
		if (ids.has(d.deviceId)) fail(`${at}.devices has duplicate deviceId ${JSON.stringify(d.deviceId)}`);
		ids.add(d.deviceId);
	}
	return Object.freeze({
		mode: oneOf(r.mode, ENDO_HARDWARE_OBSERVATION_MODES_V0, `${at}.mode`),
		observedAtMs: intRange(r.observedAtMs, 1, MAX_EPOCH_MS, `${at}.observedAtMs`),
		staleAfterMs: intRange(
			r.staleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minStaleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxStaleAfterMs,
			`${at}.staleAfterMs`,
		),
		devices: Object.freeze(devices),
	});
}

function validateProjectionSummary(value: unknown, at: string): EndoProjectionSummaryObservationV0 {
	const r = closed(
		value,
		["statusSha256", "coordinationSha256", "projectCount", "activeAssignmentCount", "unresolvedHazardCount", "gaps"],
		at,
	);
	const gaps = asArray(r.gaps, ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxProjectionGaps, `${at}.gaps`).map((g, i) =>
		pattern(g, SAFE_TEXT_128, `${at}.gaps[${i}]`, "1-128 printable chars"),
	);
	return Object.freeze({
		statusSha256: nullablePattern(r.statusSha256, ENDO_SHA256_HEX_PATTERN_V0, `${at}.statusSha256`, "64-hex SHA-256"),
		coordinationSha256: nullablePattern(
			r.coordinationSha256,
			ENDO_SHA256_HEX_PATTERN_V0,
			`${at}.coordinationSha256`,
			"64-hex SHA-256",
		),
		projectCount: intRange(r.projectCount, 0, 10_000, `${at}.projectCount`),
		activeAssignmentCount: intRange(r.activeAssignmentCount, 0, 10_000, `${at}.activeAssignmentCount`),
		unresolvedHazardCount: intRange(r.unresolvedHazardCount, 0, 10_000, `${at}.unresolvedHazardCount`),
		gaps: Object.freeze(gaps),
	});
}

export function validateEndoDevelopResourceObservationV0(value: unknown): EndoDevelopResourceObservationV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"leaseEpoch",
			"holderId",
			"observedAtMs",
			"publishedAtMs",
			"staleAfterMs",
			"tokensConsumed",
			"modelPool",
			"providers",
			"sessions",
			"worktrees",
			"hardware",
			"projectionSummary",
		],
		"resource observation",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0)
		fail(`resource observation.schemaVersion must be ${JSON.stringify(ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0)}`);
	if (r.tokensConsumed !== 0) fail("resource observation.tokensConsumed must be 0 in S1");

	const mp = closed(r.modelPool, ["poolSha256", "poolSource", "localEndpoints"], "resource observation.modelPool");
	const localEndpoints = asArray(
		mp.localEndpoints,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxLocalEndpointsObserved,
		"resource observation.modelPool.localEndpoints",
	).map((e, i) => validateObservedLocalEndpoint(e, `resource observation.modelPool.localEndpoints[${i}]`));
	const memberIds = new Set<string>();
	for (const e of localEndpoints) {
		if (memberIds.has(e.memberId)) fail(`duplicate local endpoint memberId ${JSON.stringify(e.memberId)}`);
		memberIds.add(e.memberId);
	}

	const providers = asArray(
		r.providers,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxProvidersObserved,
		"resource observation.providers",
	).map((p, i) => validateProviderAllowance(p, `resource observation.providers[${i}]`));
	const providerIds = new Set<string>();
	for (const p of providers) {
		if (providerIds.has(p.providerId)) fail(`duplicate providerId ${JSON.stringify(p.providerId)}`);
		providerIds.add(p.providerId);
	}

	const sessions = asArray(
		r.sessions,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxSessionsObserved,
		"resource observation.sessions",
	).map((s) => Object.freeze(validateEndoSessionLivenessObservationV0(s)));

	const worktrees = asArray(
		r.worktrees,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxWorktreesObserved,
		"resource observation.worktrees",
	).map((w, i) => validateWorktreeSummary(w, `resource observation.worktrees[${i}]`));

	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
		leaseEpoch: intRange(r.leaseEpoch, 1, Number.MAX_SAFE_INTEGER, "resource observation.leaseEpoch"),
		holderId: pattern(r.holderId, ENDO_HOLDER_ID_PATTERN_V0, "resource observation.holderId", "valid holderId"),
		observedAtMs: intRange(r.observedAtMs, 1, MAX_EPOCH_MS, "resource observation.observedAtMs"),
		publishedAtMs: intRange(r.publishedAtMs, 1, MAX_EPOCH_MS, "resource observation.publishedAtMs"),
		staleAfterMs: intRange(
			r.staleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.minStaleAfterMs,
			ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxStaleAfterMs,
			"resource observation.staleAfterMs",
		),
		tokensConsumed: 0,
		modelPool: Object.freeze({
			poolSha256: nullablePattern(
				mp.poolSha256,
				ENDO_SHA256_HEX_PATTERN_V0,
				"modelPool.poolSha256",
				"64-hex SHA-256",
			),
			poolSource: oneOf(mp.poolSource, ["file", "m0-default", "none"] as const, "modelPool.poolSource"),
			localEndpoints: Object.freeze(localEndpoints),
		}),
		providers: Object.freeze(providers),
		sessions: Object.freeze(sessions),
		worktrees: Object.freeze(worktrees),
		hardware: validateHardwareSnapshot(r.hardware, "resource observation.hardware"),
		projectionSummary:
			r.projectionSummary === null
				? null
				: validateProjectionSummary(r.projectionSummary, "resource observation.projectionSummary"),
	});
}

function validateDeclaration(value: unknown, at: string): EndoOperatorResourceWindowDeclarationV0 {
	const r = closed(
		value,
		[
			"providerId",
			"surfaceKind",
			"quotaPoolId",
			"windowKind",
			"standing",
			"resetAtMs",
			"declaredAtMs",
			"basis",
			"note",
		],
		at,
	);
	if (r.basis !== "operator-declared") fail(`${at}.basis must be "operator-declared"`);
	return Object.freeze({
		providerId: pattern(r.providerId, ENDO_PROVIDER_ID_PATTERN_V0, `${at}.providerId`, "valid providerId"),
		surfaceKind: oneOf(r.surfaceKind, ENDO_PROVIDER_SURFACE_KINDS_V0, `${at}.surfaceKind`),
		quotaPoolId: nullablePattern(
			r.quotaPoolId,
			ENDO_QUOTA_POOL_ID_PATTERN_V0,
			`${at}.quotaPoolId`,
			"valid quotaPoolId",
		),
		windowKind: oneOf(r.windowKind, ENDO_ALLOWANCE_WINDOW_KINDS_V0, `${at}.windowKind`),
		standing: oneOf(r.standing, ENDO_OPERATOR_DECLARABLE_STANDINGS_V0, `${at}.standing`),
		resetAtMs: intRange(r.resetAtMs, 1, MAX_EPOCH_MS, `${at}.resetAtMs`),
		declaredAtMs: intRange(r.declaredAtMs, 1, MAX_EPOCH_MS, `${at}.declaredAtMs`),
		basis: "operator-declared",
		note: nullablePattern(r.note, SAFE_TEXT_512, `${at}.note`, "1-512 printable chars"),
	});
}

export function validateEndoDevelopResourceDeclarationsFileV0(value: unknown): EndoDevelopResourceDeclarationsFileV0 {
	const r = closed(value, ["schemaVersion", "revision", "updatedAtMs", "declarations"], "resource declarations file");
	if (r.schemaVersion !== ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0)
		fail(
			`resource declarations file.schemaVersion must be ${JSON.stringify(ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0)}`,
		);
	const declarations = asArray(
		r.declarations,
		ENDO_DEVELOP_AUTOMATION_LIMITS_V0.maxDeclarations,
		"resource declarations file.declarations",
	).map((d, i) => validateDeclaration(d, `declarations[${i}]`));
	const keys = new Set<string>();
	for (const d of declarations) {
		const key = `${d.providerId}:${d.windowKind}`;
		if (keys.has(key)) fail(`duplicate operator declaration for ${JSON.stringify(key)}`);
		keys.add(key);
	}
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0,
		revision: intRange(r.revision, 0, Number.MAX_SAFE_INTEGER, "resource declarations file.revision"),
		updatedAtMs: intRange(r.updatedAtMs, 0, MAX_EPOCH_MS, "resource declarations file.updatedAtMs"),
		declarations: Object.freeze(declarations),
	});
}

export function emptyEndoDevelopResourceDeclarationsFileV0(): EndoDevelopResourceDeclarationsFileV0 {
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0,
		revision: 0,
		updatedAtMs: 0,
		declarations: Object.freeze([]),
	});
}

// ---- Versioned Reader Tables -------------------------------------------------------------------------------------------------------

export const ENDO_DEVELOP_SCHEDULES_VERSIONS_V0 = defineEndoVersionTableV0<EndoDevelopSchedulesFileV0>(
	"develop-schedules",
	[[ENDO_DEVELOP_SCHEDULES_SCHEMA_V0, validateEndoDevelopSchedulesFileV0]],
);

export const ENDO_DEVELOP_AUTOMATION_LEASE_VERSIONS_V0 = defineEndoVersionTableV0<EndoDevelopAutomationLeaseV0>(
	"develop-automation-lease",
	[[ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0, validateEndoDevelopAutomationLeaseV0]],
);

export const ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_VERSIONS_V0 = defineEndoVersionTableV0<EndoDevelopScheduleFireClaimV0>(
	"develop-schedule-fire-claim",
	[[ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0, validateEndoDevelopScheduleFireClaimV0]],
);

export const ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_VERSIONS_V0 =
	defineEndoVersionTableV0<EndoDevelopScheduleFireOutcomeV0>("develop-schedule-fire-outcome", [
		[ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0, validateEndoDevelopScheduleFireOutcomeV0],
	]);

export const ENDO_DEVELOP_RESOURCE_OBSERVATION_VERSIONS_V0 = defineEndoVersionTableV0<EndoDevelopResourceObservationV0>(
	"develop-resource-observation",
	[[ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0, validateEndoDevelopResourceObservationV0]],
);

export const ENDO_DEVELOP_RESOURCE_DECLARATIONS_VERSIONS_V0 =
	defineEndoVersionTableV0<EndoDevelopResourceDeclarationsFileV0>("develop-resource-declarations", [
		[ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0, validateEndoDevelopResourceDeclarationsFileV0],
	]);

export const readEndoDevelopSchedulesFileV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_SCHEDULES_VERSIONS_V0, value);
export const parseEndoDevelopSchedulesFileV0 = (value: unknown) =>
	parseEndoVersionedV0(ENDO_DEVELOP_SCHEDULES_VERSIONS_V0, value);

export const readEndoDevelopAutomationLeaseV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_AUTOMATION_LEASE_VERSIONS_V0, value);
export const parseEndoDevelopAutomationLeaseV0 = (value: unknown) =>
	parseEndoVersionedV0(ENDO_DEVELOP_AUTOMATION_LEASE_VERSIONS_V0, value);

export const readEndoDevelopScheduleFireClaimV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_VERSIONS_V0, value);
export const parseEndoDevelopScheduleFireClaimV0 = (value: unknown) =>
	parseEndoVersionedV0(ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_VERSIONS_V0, value);

export const readEndoDevelopScheduleFireOutcomeV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_VERSIONS_V0, value);
export const parseEndoDevelopScheduleFireOutcomeV0 = (value: unknown) =>
	parseEndoVersionedV0(ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_VERSIONS_V0, value);

export const readEndoDevelopResourceObservationV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_RESOURCE_OBSERVATION_VERSIONS_V0, value);
export const parseEndoDevelopResourceObservationV0 = (value: unknown) =>
	parseEndoVersionedV0(ENDO_DEVELOP_RESOURCE_OBSERVATION_VERSIONS_V0, value);

export const readEndoDevelopResourceDeclarationsFileV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_RESOURCE_DECLARATIONS_VERSIONS_V0, value);
export const parseEndoDevelopResourceDeclarationsFileV0 = (value: unknown) =>
	parseEndoVersionedV0(ENDO_DEVELOP_RESOURCE_DECLARATIONS_VERSIONS_V0, value);
