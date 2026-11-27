// Versioned contracts for S2 — Scheduled Advisory Intelligence and the Persistent Operator Proposal Queue
// (`COORDINATOR-AUTOMATION-S2`, docs/designs/coordinator-automation-s2-implementation.md).
//
// Every S2 record lives under `<root>/develop/automation/advisory/`, beside (never inside) S1's files, so an S1-only binary and S1's
// closed `endo.develop-schedules.v0` ledger keep their exact meaning: S1 schedules stay zero-token, and an S1 reader never sees an S2
// action kind. S2 reuses S1's trigger schema, recurrence evaluator, missed-run policies, expiring-lease schema and write-once discipline.
//
// Closed schemas:
//   - `endo.develop-advisory-schedules.v0`        advisory/schedules.json             advisory schedules + cursors (atomic replace)
//   - `endo.develop-advisory-authorizations.v0`   advisory/authorizations.json        operator grants bound to one schedule revision
//   - `endo.develop-automation-lease.v0`          advisory/lease.json                 S1's lease schema, a separate advisory duty lease
//   - `endo.develop-advisory-observations.v0`     advisory/observations.json          latest semantic digest per project (atomic)
//   - `endo.develop-advisory-fire-claim.v0`       advisory/fires/<key>.claimed.json   write-once, before any observation
//   - `endo.develop-advisory-fire-outcome.v0`     advisory/fires/<key>.outcome.json   write-once terminal fire outcome
//   - `endo.develop-advisory-turn-admission.v0`   advisory/turns/<id>.admitted.json   write-once budget reservation (before dispatch)
//   - `endo.develop-advisory-turn-dispatch.v0`    advisory/turns/<id>.dispatched.json write-once dispatch authorization (linearization)
//   - `endo.develop-advisory-briefing.v0`         advisory/turns/<id>.briefing.json   write-once terminal turn record (briefing + accounting)
//   - `endo.develop-advisory-proposal.v0`         advisory/proposals/<id>.json        write-once untrusted operator proposal
//   - `endo.develop-advisory-proposal-state.v0`   advisory/proposals/<id>.<state>.json write-once operator queue disposition
//
// Invariants:
// - Protocol imports only protocol. No record holds a command, shell string, tool definition, endpoint outside the authorised pool, or
//   credential. A proposal is a closed recommendation kind over ids the deterministic state contains; it grants nothing.
// - Every persisted object is closed: unknown keys, missing keys and out-of-range values are refused.

import {
	ENDO_COORDINATOR_MODEL_ID_PATTERN_V0,
	ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0,
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
	type EndoCoordinatorModelPoolAnyV1,
	parseEndoCoordinatorModelPoolAnyV1,
	parseEndoCoordinatorModelPoolV0,
} from "./coordinator-model-pool.ts";
import {
	ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1,
	type EndoCoordinatorResourceProfileV1,
	validateEndoCoordinatorResourceProfileV1,
} from "./coordinator-resource-policy.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_HOLDER_ID_PATTERN_V0,
	ENDO_SCHEDULE_ID_PATTERN_V0,
	ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0,
	ENDO_SCHEDULE_TRIGGER_KINDS_V0,
	ENDO_SHA256_HEX_PATTERN_V0,
	type EndoDevelopAutomationLeaseV0,
	type EndoScheduleMissedRunPolicyV0,
	type EndoScheduleTriggerKindV0,
	type EndoScheduleTriggerV0,
	validateEndoScheduleTriggerV0,
} from "./develop-automation.ts";
import { ENDO_ASSIGNMENT_ID_PATTERN_V0, ENDO_CANDIDATE_ID_PATTERN_V0 } from "./develop-coordination.ts";
import { ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	endoBoundedDetailV0,
	endoFirstUnknownKeyV0,
} from "./versioned.ts";

export const ENDO_ADVISORY_SCHEDULES_SCHEMA_V0 = "endo.develop-advisory-schedules.v0";
export const ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0 = "endo.develop-advisory-authorizations.v0";
export const ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0 = "endo.develop-advisory-observations.v0";
export const ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0 = "endo.develop-advisory-fire-claim.v0";
export const ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0 = "endo.develop-advisory-fire-outcome.v0";
export const ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0 = "endo.develop-advisory-turn-admission.v0";
export const ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0 = "endo.develop-advisory-turn-dispatch.v0";
export const ENDO_ADVISORY_BRIEFING_SCHEMA_V0 = "endo.develop-advisory-briefing.v0";
export const ENDO_ADVISORY_PROPOSAL_SCHEMA_V0 = "endo.develop-advisory-proposal.v0";
export const ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0 = "endo.develop-advisory-proposal-state.v0";

/** The two S2 action kinds documented in S0 §4. Both are one bounded, read-only advisory briefing; neither confers authority. */
export const ENDO_ADVISORY_ACTION_KINDS_V0 = ["generate-advisory-brief", "emit-operator-proposal"] as const;
export type EndoAdvisoryActionKindV0 = (typeof ENDO_ADVISORY_ACTION_KINDS_V0)[number];

/**
 * When a due advisory fire may reason:
 * - `on-change`: only when the project's semantic digest differs from the last state this schedule considered (and attempted).
 * - `digest-window`: every due window is an explicit operator digest window and may reason on unchanged state.
 * Neither bypasses authorization, observation completeness, model eligibility or budget.
 */
export const ENDO_ADVISORY_WAKE_POLICIES_V0 = ["on-change", "digest-window"] as const;
export type EndoAdvisoryWakePolicyV0 = (typeof ENDO_ADVISORY_WAKE_POLICIES_V0)[number];

export const ENDO_ADVISORY_WAKE_REASONS_V0 = ["first-observation", "state-changed", "digest-window"] as const;
export type EndoAdvisoryWakeReasonV0 = (typeof ENDO_ADVISORY_WAKE_REASONS_V0)[number];

export const ENDO_ADVISORY_OBSERVATION_COMPLETENESS_V0 = ["complete", "partial", "unavailable"] as const;
export type EndoAdvisoryObservationCompletenessV0 = (typeof ENDO_ADVISORY_OBSERVATION_COMPLETENESS_V0)[number];

export const ENDO_ADVISORY_OBSERVATION_SOURCES_V0 = ["recorded-or-passive-probe", "recorded-only"] as const;
export type EndoAdvisoryObservationSourceV0 = (typeof ENDO_ADVISORY_OBSERVATION_SOURCES_V0)[number];

export const ENDO_ADVISORY_FIRE_OUTCOME_STATUSES_V0 = [
	"missed-skipped",
	"skipped-unchanged",
	"skipped-already-attempted",
	"skipped-observation-incomplete",
	"refused-unauthorized",
	"refused-budget",
	"refused-model-unavailable",
	"refused-uncertainty-policy",
	"refused-insufficient-lease",
	"cancelled-schedule-changed",
	"briefing-published",
	"briefing-refused",
	"result-withheld",
	"failed",
] as const;
export type EndoAdvisoryFireOutcomeStatusV0 = (typeof ENDO_ADVISORY_FIRE_OUTCOME_STATUSES_V0)[number];

/** Why a turn's model output was not published as a current briefing although inference may have run. */
export const ENDO_ADVISORY_WITHHELD_REASONS_V0 = [
	"authorization-revoked-in-flight",
	"authorization-expired-in-flight",
	"schedule-changed-in-flight",
	"lease-lost-in-flight",
	"turn-deadline-exceeded",
	"publication-observation-not-committed",
] as const;
export type EndoAdvisoryWithheldReasonV0 = (typeof ENDO_ADVISORY_WITHHELD_REASONS_V0)[number];

/** Pre-dispatch refusals at the dispatch linearization point (no completion request was sent). */
export const ENDO_ADVISORY_DISPATCH_REFUSALS_V0 = [
	"no-eligible-member",
	"capacity-unknown-not-permitted",
	"runtime-preflight-failed",
	"authorization-revoked",
	"authorization-expired",
	"schedule-changed",
	"stale-lease-epoch",
	"insufficient-lease",
	"lock-busy",
	"storage-failed",
] as const;
export type EndoAdvisoryDispatchRefusalV0 = (typeof ENDO_ADVISORY_DISPATCH_REFUSALS_V0)[number];

export const ENDO_ADVISORY_PUBLICATION_CURRENCY_V0 = [
	"current-at-publication",
	"stale-at-publication",
	"unknown-at-publication",
] as const;
export type EndoAdvisoryPublicationCurrencyV0 = (typeof ENDO_ADVISORY_PUBLICATION_CURRENCY_V0)[number];

/**
 * The closed recommendation vocabulary. Each kind names something the OPERATOR may consider, about one task of the one project in
 * scope, and is admitted only when the deterministic state supports it (runtime/contracts/develop-advisory.ts). None of them is an
 * assignment, an admission decision, a route reservation or an execution instruction.
 */
export const ENDO_ADVISORY_PROPOSAL_KINDS_V0 = [
	"review-failing-verification",
	"review-awaiting-review",
	"investigate-incomplete-verification",
	"resolve-blocked-task",
	"investigate-liveness-hazard",
	"consider-attempt-for-assignment",
] as const;
export type EndoAdvisoryProposalKindV0 = (typeof ENDO_ADVISORY_PROPOSAL_KINDS_V0)[number];

/** Deterministic facts a proposal may cite (each read from the status or coordination projection, never from model text). */
export const ENDO_ADVISORY_EVIDENCE_FACTS_V0 = [
	"task-verification-failing",
	"task-status-review",
	"task-verification-incomplete",
	"task-status-blocked",
	"assignment-liveness-unverified",
	"assignment-active",
	"task-receipt-read-incomplete",
] as const;
export type EndoAdvisoryEvidenceFactV0 = (typeof ENDO_ADVISORY_EVIDENCE_FACTS_V0)[number];

export const ENDO_ADVISORY_PROPOSAL_OUTCOMES_V0 = [
	"not-requested",
	"none-proposed",
	"created",
	"deduplicated",
	"refused",
] as const;
export type EndoAdvisoryProposalOutcomeV0 = (typeof ENDO_ADVISORY_PROPOSAL_OUTCOMES_V0)[number];

export const ENDO_ADVISORY_PROPOSAL_REFUSALS_V0 = [
	"briefing-unavailable",
	"proposal-unparseable",
	"proposal-kind-unknown",
	"proposal-subject-unknown",
	"proposal-ungrounded",
	"proposal-state-stale",
	"proposal-queue-full",
	"storage-failed",
] as const;
export type EndoAdvisoryProposalRefusalV0 = (typeof ENDO_ADVISORY_PROPOSAL_REFUSALS_V0)[number];

export const ENDO_ADVISORY_PROPOSAL_DISPOSITIONS_V0 = ["acknowledged", "dismissed"] as const;
export type EndoAdvisoryProposalDispositionV0 = (typeof ENDO_ADVISORY_PROPOSAL_DISPOSITIONS_V0)[number];

const SAFE_TEXT_128 = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/;
const SAFE_TEXT_256 = /^[^\u0000-\u001f\u007f-\u009f]{1,256}$/;
const SAFE_TEXT_512 = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/;
const SAFE_CODE = /^[a-z0-9][a-z0-9.:-]{0,63}$/;
const MAX_EPOCH_MS = 8.64e15;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * S2 bounds. The generation and request ceilings are the M0/M1 relay's: one briefing is exactly two completion requests
 * (`maxExchanges: 2` in adapters/coordinator/model-relay.ts), each bounded by the selected member's `maxOutputTokens` (<= 2048).
 * S2 cannot lower the request count without changing the briefing protocol, so it records it as a fixed 2 and budgets per turn.
 */
export const ENDO_ADVISORY_LIMITS_V0 = Object.freeze({
	maxSchedules: 32,
	maxRetiredCursors: 256,
	maxAuthorizations: 128,
	maxObservedProjects: 64,
	maxFileBytes: 512 * 1024,
	maxRecordBytes: 64 * 1024,
	maxDirectoryEntries: 4096,
	maxTerminalTurnsRetained: 512,
	/**
	 * The most turns the ledger can legitimately hold, derived from the ceilings rather than fixed: every charged turn inside the
	 * mandatory 7-day retention window (32 schedules x 96 turns per period x 168 one-hour periods), plus the 512 settled turns kept
	 * beyond it, plus up to 512 recent never-dispatched turns (they charge nothing, so retention may prune them at any age), plus the
	 * one turn in flight. A ledger larger than this is over capacity or corrupt and admission fails closed.
	 */
	maxLedgerTurns: 32 * 96 * 168 + 512 + 512 + 1,
	/** Three records per turn, plus write-once temporaries a crashed writer may leave. */
	maxTurnLedgerEntries: 3 * (32 * 96 * 168 + 512 + 512 + 1) + 64,
	maxProposalsRetained: 256,
	maxPendingProposalsPerProject: 16,
	maxAnswerBytes: 4096,
	maxGaps: 32,
	maxEvidenceFacts: 8,
	maxUncertainties: 16,
	maxSkippedMembers: 16,
	minBudgetPeriodMs: HOUR,
	maxBudgetPeriodMs: 7 * DAY,
	maxTurnsPerPeriod: 96,
	completionRequestsPerTurn: 2,
	minOutputTokensPerRequest: 256,
	maxOutputTokensPerRequest: 2048,
	maxGeneratedTokensPerPeriod: 96 * 2 * 2048,
	minTurnWallClockMs: 10_000,
	maxTurnWallClockMs: 240_000,
	/** The advisory duty lease: S1's maximum TTL, fixed. Every phase of a turn is bounded to finish inside it. */
	leaseTtlMs: 300_000,
	/**
	 * Default on-time grace for advisory windows: two advisory leases. One tick runs at most one turn, which holds the advisory lease
	 * for up to one lease; a co-due schedule must still be on time at the next tick after it (for any tick cadence up to 5 minutes).
	 * S1's recurrence caps it at period - 1.
	 */
	defaultOnTimeGraceMs: 600_000,
	/** Reserved at the end of the lease for publication after the inference deadline. */
	publicationMarginMs: 20_000,
	/** The smallest inference window the dispatch gate admits (the M1 member timeout floor). */
	minInferenceWindowMs: 5_000,
	minRecordedObservationMaxAgeMs: 1_000,
	maxRecordedObservationMaxAgeMs: HOUR,
	maxAuthorizationLifetimeMs: 30 * DAY,
	minAuthorizationLifetimeMs: 60_000,
});
const L = ENDO_ADVISORY_LIMITS_V0;
const G = ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1;

// ---- Types -------------------------------------------------------------------------------------------------------------------------

export interface EndoAdvisoryScheduleCursorV0 {
	readonly lastEvaluatedAtMs: number | null;
	readonly lastConsumedWindowStartMs: number | null;
	readonly completedOnce: boolean;
	readonly lastFireIdempotencyKey: string | null;
	readonly lastFireStatus: EndoAdvisoryFireOutcomeStatusV0 | null;
	/** Digest of the state a turn was admitted for (set at admission, before dispatch; never cleared by a failure). */
	readonly lastAttemptedSemanticDigest: string | null;
	readonly lastAttemptedAtMs: number | null;
	/** Digest of the state a PUBLISHED, current-at-publication briefing considered. Failed, refused or withheld turns never set it. */
	readonly lastConsideredSemanticDigest: string | null;
	readonly lastConsideredAtMs: number | null;
}

export interface EndoAdvisoryScheduleV0 {
	readonly scheduleId: string;
	/** A fresh random identity per add: a removed and re-added schedule id is a different incarnation, so nothing carries over. */
	readonly incarnation: string;
	readonly label: string | null;
	readonly revision: number;
	readonly enabled: boolean;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly projectId: string;
	readonly wake: EndoAdvisoryWakePolicyV0;
	readonly missedRunPolicy: EndoScheduleMissedRunPolicyV0;
	readonly trigger: EndoScheduleTriggerV0;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly cursor: EndoAdvisoryScheduleCursorV0;
}

export interface EndoAdvisoryRetiredCursorV0 {
	readonly scheduleId: string;
	readonly lastConsumedWindowStartMs: number;
	readonly retiredAtMs: number;
}

export interface EndoAdvisorySchedulesFileV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_SCHEDULES_SCHEMA_V0;
	readonly revision: number;
	readonly updatedAtMs: number;
	readonly schedules: readonly EndoAdvisoryScheduleV0[];
	readonly retiredCursors: readonly EndoAdvisoryRetiredCursorV0[];
}

export interface EndoAdvisoryPolicyV0 {
	/** Permit selecting a member whose capacity could not be confirmed (every M1 llama.cpp observation). */
	readonly permitCapacityUnknown: boolean;
	/** Permit selecting a member whose model residency is unconfirmed (every llama.cpp router member). Narrows, never widens, the pool. */
	readonly permitModelUnconfirmed: boolean;
	/** Permit reasoning over a partial observation (a source unreadable or incomplete). Unavailable observations are never admitted. */
	readonly permitPartialObservation: boolean;
	readonly observationSource: EndoAdvisoryObservationSourceV0;
	readonly recordedObservationMaxAgeMs: number;
}

export interface EndoAdvisoryBudgetV0 {
	/** The rolling accounting window every ceiling below applies to, per schedule. */
	readonly periodMs: number;
	readonly maxTurnsPerPeriod: number;
	/** Fixed at 2: the relay's per-briefing exchange cap. */
	readonly completionRequestsPerTurn: 2;
	/** Per-completion generation ceiling; members whose maxOutputTokens exceed it are not eligible. */
	readonly maxOutputTokensPerRequest: number;
	/** Aggregate generated-token ceiling per period: confirmed usage plus every open reservation must stay within it. */
	readonly maxGeneratedTokensPerPeriod: number;
	/** Wall-clock ceiling for one turn from admission to its inference deadline. */
	readonly maxTurnWallClockMs: number;
}

export interface EndoAdvisoryAuthorizationV0 {
	readonly authorizationId: string;
	readonly scheduleId: string;
	readonly scheduleIncarnation: string;
	readonly scheduleRevision: number;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly poolSha256: string;
	readonly pool: EndoCoordinatorModelPoolAnyV1;
	/** Opt-in governed cognitive resource policy (`COORDINATOR-REASONING-001`). Absent on V0 grants. */
	readonly resourceProfile?: EndoCoordinatorResourceProfileV1;
	readonly resourceProfileSha256?: string;
	readonly policy: EndoAdvisoryPolicyV0;
	readonly budget: EndoAdvisoryBudgetV0;
	readonly grantedAtMs: number;
	readonly expiresAtMs: number;
	readonly revokedAtMs: number | null;
	readonly revocation: null | "operator-revoked" | "superseded";
}

export interface EndoAdvisoryAuthorizationsFileV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0;
	readonly revision: number;
	readonly updatedAtMs: number;
	readonly authorizations: readonly EndoAdvisoryAuthorizationV0[];
}

export interface EndoAdvisoryProjectObservationV0 {
	readonly projectId: string;
	readonly semanticDigest: string | null;
	readonly completeness: EndoAdvisoryObservationCompletenessV0;
	readonly observedAtMs: number;
	readonly leaseEpoch: number;
}

export interface EndoAdvisoryObservationsFileV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0;
	readonly updatedAtMs: number;
	readonly projects: readonly EndoAdvisoryProjectObservationV0[];
}

export interface EndoAdvisoryFireClaimV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0;
	readonly idempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleIncarnation: string;
	readonly scheduleRevision: number;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly wake: EndoAdvisoryWakePolicyV0;
	readonly triggerKind: EndoScheduleTriggerKindV0;
	readonly triggerCursor: string;
	readonly windowStartMs: number;
	readonly missedWindowsBefore: number;
	readonly claimedAtMs: number;
	readonly leaseEpoch: number;
	readonly holderId: string;
}

export interface EndoAdvisoryGateRecordV0 {
	readonly wakeReason: EndoAdvisoryWakeReasonV0 | null;
	readonly semanticDigest: string | null;
	readonly completeness: EndoAdvisoryObservationCompletenessV0;
	readonly observedAtMs: number | null;
	readonly gaps: readonly string[];
	readonly lastConsideredSemanticDigest: string | null;
	readonly lastAttemptedSemanticDigest: string | null;
}

export interface EndoAdvisoryFireOutcomeV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0;
	readonly idempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly windowStartMs: number;
	readonly completedAtMs: number;
	readonly leaseEpoch: number;
	readonly holderId: string;
	readonly status: EndoAdvisoryFireOutcomeStatusV0;
	readonly missedWindowCount: number;
	readonly gate: EndoAdvisoryGateRecordV0 | null;
	/** The admitted turn, when one was admitted (its records are under turns/). */
	readonly turnId: string | null;
	/** Whether a completion request may have been sent: "no" is proven (no dispatch record was linked). */
	readonly inferenceDispatched: "no" | "yes";
	readonly detail: string | null;
}

export interface EndoAdvisoryReservationV0 {
	readonly completionRequests: number;
	readonly generatedTokens: number;
	readonly wallClockMs: number;
}

export interface EndoAdvisoryBudgetSnapshotV0 {
	readonly periodStartMs: number;
	readonly turnsCharged: number;
	readonly generatedTokensCharged: number;
	readonly uncertainTurns: number;
}

export interface EndoAdvisoryTurnAdmissionV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0;
	readonly turnId: string;
	readonly fireIdempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly authorizationId: string;
	readonly poolSha256: string;
	readonly resourceProfileSha256?: string;
	readonly policySha256: string;
	readonly budgetSha256: string;
	readonly leaseEpoch: number;
	readonly holderId: string;
	readonly admittedAtMs: number;
	/** Absolute wall-clock instant by which inference is aborted (min of the turn ceiling and the lease's publication margin). */
	readonly turnDeadlineMs: number;
	readonly wakeReason: EndoAdvisoryWakeReasonV0;
	readonly semanticDigest: string;
	readonly completeness: EndoAdvisoryObservationCompletenessV0;
	readonly observedAtMs: number;
	readonly gaps: readonly string[];
	readonly reservation: EndoAdvisoryReservationV0;
	readonly budgetBefore: EndoAdvisoryBudgetSnapshotV0;
}

export interface EndoAdvisorySkippedMemberV0 {
	readonly memberId: string;
	readonly reason: string;
}

export interface EndoAdvisoryTurnDispatchV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0;
	readonly turnId: string;
	readonly leaseEpoch: number;
	readonly holderId: string;
	readonly dispatchedAtMs: number;
	readonly authorizationId: string;
	readonly scheduleRevision: number;
	readonly effectivePoolSha256: string;
	readonly resourceProfileSha256?: string;
	readonly selectedMemberId: string;
	readonly selectedModelId: string;
	readonly selectedEndpoint: string;
	readonly selectedReadiness: string;
	readonly observationBasis: "recorded" | "live-probe";
	readonly capacityConfirmed: boolean;
	readonly fallbackOccurred: boolean;
	readonly skippedMembers: readonly EndoAdvisorySkippedMemberV0[];
	readonly inferenceDeadlineMs: number;
	readonly effectiveTimeoutMs: number;
}

export interface EndoAdvisoryBriefingSourceV0 {
	readonly admissionSemanticDigest: string;
	readonly admissionObservedAtMs: number;
	readonly completeness: EndoAdvisoryObservationCompletenessV0;
	readonly gaps: readonly string[];
	/** The evidence the model's status tool actually delivered (M0 digests), when inference produced it. */
	readonly evidence: null | {
		readonly readAtMs: number;
		readonly projectionSha256: string;
		readonly modelViewSha256: string;
	};
	readonly publicationSemanticDigest: string | null;
	readonly publicationObservedAtMs: number | null;
	readonly currency: EndoAdvisoryPublicationCurrencyV0;
}

export interface EndoAdvisoryBriefingModelV0 {
	readonly harness: string;
	readonly provider: string;
	/** The model the runtime REPORTED. Loopback does not attest the listener or the weights (M1 D1). */
	readonly reportedModel: string;
	readonly selectedMemberId: string | null;
	readonly selectedModelId: string | null;
	readonly selectedEndpoint: string | null;
	readonly selectedReadiness: string | null;
	readonly capacityConfirmed: boolean;
	readonly fallbackOccurred: boolean;
	readonly skippedMembers: readonly EndoAdvisorySkippedMemberV0[];
	readonly inferenceFailover: "never";
}

export interface EndoAdvisoryAccountingV0 {
	readonly reserved: EndoAdvisoryReservationV0;
	/** Completion requests the relay admitted (null: unknown). */
	readonly admittedExchanges: number | null;
	readonly reportedPromptTokens: number | null;
	readonly reportedCompletionTokens: number | null;
	/** True only when every admitted exchange reported usage. Missing usage is never read as zero. */
	readonly usageReportComplete: boolean;
	readonly chargedCompletionRequests: number;
	readonly chargedGeneratedTokens: number;
	readonly inferenceElapsedMs: number | null;
}

export interface EndoAdvisoryProposalLinkV0 {
	readonly outcome: EndoAdvisoryProposalOutcomeV0;
	readonly proposalId: string | null;
	readonly refusal: EndoAdvisoryProposalRefusalV0 | null;
}

export interface EndoAdvisoryBriefingV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_BRIEFING_SCHEMA_V0;
	readonly turnId: string;
	readonly fireIdempotencyKey: string;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly wakeReason: EndoAdvisoryWakeReasonV0;
	readonly leaseEpoch: number;
	readonly holderId: string;
	readonly admittedAtMs: number;
	readonly publishedAtMs: number;
	readonly authorizationId: string;
	readonly poolSha256: string;
	readonly effectivePoolSha256: string | null;
	readonly resourceProfileSha256?: string;
	readonly policySha256: string;
	readonly budgetSha256: string;
	readonly prompt: {
		readonly instructionsSha256: string;
		readonly questionSha256: string | null;
		readonly promptSha256: string | null;
	};
	readonly source: EndoAdvisoryBriefingSourceV0;
	readonly model: EndoAdvisoryBriefingModelV0;
	readonly accounting: EndoAdvisoryAccountingV0;
	/**
	 * - `available`: the existing Coordinator gates admitted the answer and it is published (as untrusted interpretation).
	 * - `unavailable`: inference ran (or may have) and the gates refused it, or the substrate failed.
	 * - `not-dispatched`: refused at the dispatch linearization point; no completion request was sent.
	 * - `withheld`: inference ran but authorization or the schedule changed in flight; the answer is not published.
	 */
	readonly availability: "available" | "unavailable" | "not-dispatched" | "withheld";
	readonly refusal: string | null;
	readonly answer: string | null;
	readonly standing: "untrusted-model-interpretation";
	readonly proposal: EndoAdvisoryProposalLinkV0;
}

export interface EndoAdvisoryEvidenceFactRecordV0 {
	readonly fact: EndoAdvisoryEvidenceFactV0;
	readonly subject: string;
}

export interface EndoAdvisoryProposalV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_PROPOSAL_SCHEMA_V0;
	readonly proposalId: string;
	readonly dedupKey: string;
	readonly projectId: string;
	readonly kind: EndoAdvisoryProposalKindV0;
	readonly subject: {
		readonly taskId: string;
		readonly assignmentId: string | null;
		readonly candidateId: string | null;
	};
	readonly evidence: {
		readonly facts: readonly EndoAdvisoryEvidenceFactRecordV0[];
		/** The semantic digest of the state the proposal was grounded against (the publication observation). */
		readonly semanticDigest: string;
		readonly admissionSemanticDigest: string;
		readonly projectionSha256: string | null;
	};
	readonly uncertainties: readonly string[];
	readonly rationale: { readonly source: "model-briefing"; readonly turnId: string };
	readonly generatedAtMs: number;
	readonly scheduleId: string;
	readonly scheduleRevision: number;
	readonly fireIdempotencyKey: string;
	readonly turnId: string;
	readonly standing: "untrusted-advisory-proposal";
	readonly authority: {
		readonly grants: "none";
		readonly executionAuthority: false;
		readonly requiresOperatorConfirmationPerAttempt: true;
	};
}

export interface EndoAdvisoryProposalStateV0 {
	readonly schemaVersion: typeof ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0;
	readonly proposalId: string;
	readonly disposition: EndoAdvisoryProposalDispositionV0;
	readonly decidedAtMs: number;
	readonly note: string | null;
	readonly authority: { readonly grants: "none"; readonly affects: "advisory-queue-only" };
}

// ---- Validation helpers -------------------------------------------------------------------------------------------------------------

function fail(detail: string): never {
	throw new EndoInvalidRecordV0(endoBoundedDetailV0(detail));
}
function closed(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const unknown = endoFirstUnknownKeyV0(record, keys);
	if (unknown !== undefined) fail(`${at} has an unknown field ${JSON.stringify(String(unknown))}`);
	for (const k of keys) if (!Object.hasOwn(record, k)) fail(`${at}.${k} is required`);
	return record;
}
function closedWithOptional(
	value: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[],
	at: string,
): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const unknown = endoFirstUnknownKeyV0(record, [...requiredKeys, ...optionalKeys]);
	if (unknown !== undefined) fail(`${at} has an unknown field ${JSON.stringify(String(unknown))}`);
	for (const k of requiredKeys) if (!Object.hasOwn(record, k)) fail(`${at}.${k} is required`);
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
function nInt(value: unknown, min: number, max: number, at: string): number | null {
	return value === null ? null : int(value, min, max, at);
}
function pat(value: unknown, re: RegExp, at: string): string {
	if (typeof value !== "string" || !re.test(value)) fail(`${at} is malformed`);
	return value as string;
}
function nPat(value: unknown, re: RegExp, at: string): string | null {
	return value === null ? null : pat(value, re, at);
}
function bool(value: unknown, at: string): boolean {
	if (typeof value !== "boolean") fail(`${at} must be a boolean`);
	return value as boolean;
}
function arr(value: unknown, max: number, at: string): readonly unknown[] {
	if (!Array.isArray(value)) fail(`${at} must be an array`);
	if (value.length > max) fail(`${at} exceeds limit of ${max}`);
	return value;
}
function codes(value: unknown, max: number, at: string): readonly string[] {
	return Object.freeze(arr(value, max, at).map((c, i) => pat(c, SAFE_CODE, `${at}[${i}]`)));
}
function literal<T>(value: unknown, expected: T, at: string): T {
	if (value !== expected) fail(`${at} must be ${JSON.stringify(expected)}`);
	return expected;
}
const sha = (value: unknown, at: string) => pat(value, ENDO_SHA256_HEX_PATTERN_V0, at);
const nSha = (value: unknown, at: string) => nPat(value, ENDO_SHA256_HEX_PATTERN_V0, at);
const ms = (value: unknown, at: string) => int(value, 1, MAX_EPOCH_MS, at);
const nMs = (value: unknown, at: string) => nInt(value, 0, MAX_EPOCH_MS, at);
const scheduleIdOf = (value: unknown, at: string) => pat(value, ENDO_SCHEDULE_ID_PATTERN_V0, at);
const projectIdOf = (value: unknown, at: string) => pat(value, ENDO_PROJECT_ID_PATTERN_V0, at);
const holderOf = (value: unknown, at: string) => pat(value, ENDO_HOLDER_ID_PATTERN_V0, at);
const revisionOf = (value: unknown, at: string) => int(value, 1, Number.MAX_SAFE_INTEGER, at);
const epochOf = (value: unknown, at: string) => int(value, 1, Number.MAX_SAFE_INTEGER, at);
const actionOf = (value: unknown, at: string) => oneOf(value, ENDO_ADVISORY_ACTION_KINDS_V0, at);

// ---- Schedules ---------------------------------------------------------------------------------------------------------------------

function validateCursor(value: unknown, at: string): EndoAdvisoryScheduleCursorV0 {
	const r = closed(
		value,
		[
			"lastEvaluatedAtMs",
			"lastConsumedWindowStartMs",
			"completedOnce",
			"lastFireIdempotencyKey",
			"lastFireStatus",
			"lastAttemptedSemanticDigest",
			"lastAttemptedAtMs",
			"lastConsideredSemanticDigest",
			"lastConsideredAtMs",
		],
		at,
	);
	return Object.freeze({
		lastEvaluatedAtMs: nMs(r.lastEvaluatedAtMs, `${at}.lastEvaluatedAtMs`),
		lastConsumedWindowStartMs: nMs(r.lastConsumedWindowStartMs, `${at}.lastConsumedWindowStartMs`),
		completedOnce: bool(r.completedOnce, `${at}.completedOnce`),
		lastFireIdempotencyKey: nSha(r.lastFireIdempotencyKey, `${at}.lastFireIdempotencyKey`),
		lastFireStatus:
			r.lastFireStatus === null
				? null
				: oneOf(r.lastFireStatus, ENDO_ADVISORY_FIRE_OUTCOME_STATUSES_V0, `${at}.lastFireStatus`),
		lastAttemptedSemanticDigest: nSha(r.lastAttemptedSemanticDigest, `${at}.lastAttemptedSemanticDigest`),
		lastAttemptedAtMs: nMs(r.lastAttemptedAtMs, `${at}.lastAttemptedAtMs`),
		lastConsideredSemanticDigest: nSha(r.lastConsideredSemanticDigest, `${at}.lastConsideredSemanticDigest`),
		lastConsideredAtMs: nMs(r.lastConsideredAtMs, `${at}.lastConsideredAtMs`),
	});
}

export function emptyEndoAdvisoryCursorV0(): EndoAdvisoryScheduleCursorV0 {
	return Object.freeze({
		lastEvaluatedAtMs: null,
		lastConsumedWindowStartMs: null,
		completedOnce: false,
		lastFireIdempotencyKey: null,
		lastFireStatus: null,
		lastAttemptedSemanticDigest: null,
		lastAttemptedAtMs: null,
		lastConsideredSemanticDigest: null,
		lastConsideredAtMs: null,
	});
}

export function validateEndoAdvisoryScheduleV0(value: unknown, at = "advisory schedule"): EndoAdvisoryScheduleV0 {
	const r = closed(
		value,
		[
			"scheduleId",
			"incarnation",
			"label",
			"revision",
			"enabled",
			"actionKind",
			"projectId",
			"wake",
			"missedRunPolicy",
			"trigger",
			"createdAtMs",
			"updatedAtMs",
			"cursor",
		],
		at,
	);
	const createdAtMs = ms(r.createdAtMs, `${at}.createdAtMs`);
	const updatedAtMs = ms(r.updatedAtMs, `${at}.updatedAtMs`);
	if (updatedAtMs < createdAtMs) fail(`${at}.updatedAtMs cannot precede createdAtMs`);
	return Object.freeze({
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		incarnation: sha(r.incarnation, `${at}.incarnation`),
		label: nPat(r.label, SAFE_TEXT_128, `${at}.label`),
		revision: revisionOf(r.revision, `${at}.revision`),
		enabled: bool(r.enabled, `${at}.enabled`),
		actionKind: actionOf(r.actionKind, `${at}.actionKind`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		wake: oneOf(r.wake, ENDO_ADVISORY_WAKE_POLICIES_V0, `${at}.wake`),
		missedRunPolicy: oneOf(r.missedRunPolicy, ENDO_SCHEDULE_MISSED_RUN_POLICIES_V0, `${at}.missedRunPolicy`),
		trigger: validateEndoScheduleTriggerV0(r.trigger, `${at}.trigger`),
		createdAtMs,
		updatedAtMs,
		cursor: validateCursor(r.cursor, `${at}.cursor`),
	});
}

export function validateEndoAdvisorySchedulesFileV0(value: unknown): EndoAdvisorySchedulesFileV0 {
	const r = closed(
		value,
		["schemaVersion", "revision", "updatedAtMs", "schedules", "retiredCursors"],
		"advisory schedules",
	);
	literal(r.schemaVersion, ENDO_ADVISORY_SCHEDULES_SCHEMA_V0, "advisory schedules.schemaVersion");
	const schedules = arr(r.schedules, L.maxSchedules, "advisory schedules.schedules").map((s, i) =>
		validateEndoAdvisoryScheduleV0(s, `advisory schedules[${i}]`),
	);
	const ids = new Set<string>();
	for (const s of schedules) {
		if (ids.has(s.scheduleId)) fail(`duplicate advisory scheduleId ${JSON.stringify(s.scheduleId)}`);
		ids.add(s.scheduleId);
	}
	const retiredCursors = arr(r.retiredCursors, L.maxRetiredCursors, "advisory schedules.retiredCursors").map(
		(c, i) => {
			const at = `advisory retiredCursors[${i}]`;
			const x = closed(c, ["scheduleId", "lastConsumedWindowStartMs", "retiredAtMs"], at);
			return Object.freeze({
				scheduleId: scheduleIdOf(x.scheduleId, `${at}.scheduleId`),
				lastConsumedWindowStartMs: int(
					x.lastConsumedWindowStartMs,
					0,
					MAX_EPOCH_MS,
					`${at}.lastConsumedWindowStartMs`,
				),
				retiredAtMs: ms(x.retiredAtMs, `${at}.retiredAtMs`),
			});
		},
	);
	const retired = new Set<string>();
	for (const c of retiredCursors) {
		if (retired.has(c.scheduleId)) fail(`duplicate advisory retired scheduleId ${JSON.stringify(c.scheduleId)}`);
		retired.add(c.scheduleId);
	}
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_SCHEDULES_SCHEMA_V0,
		revision: int(r.revision, 0, Number.MAX_SAFE_INTEGER, "advisory schedules.revision"),
		updatedAtMs: int(r.updatedAtMs, 0, MAX_EPOCH_MS, "advisory schedules.updatedAtMs"),
		schedules: Object.freeze(schedules),
		retiredCursors: Object.freeze(retiredCursors),
	});
}

export function emptyEndoAdvisorySchedulesFileV0(): EndoAdvisorySchedulesFileV0 {
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_SCHEDULES_SCHEMA_V0,
		revision: 0,
		updatedAtMs: 0,
		schedules: Object.freeze([]),
		retiredCursors: Object.freeze([]),
	});
}

// ---- Authorizations ----------------------------------------------------------------------------------------------------------------

export function validateEndoAdvisoryPolicyV0(value: unknown, at = "policy"): EndoAdvisoryPolicyV0 {
	const r = closed(
		value,
		[
			"permitCapacityUnknown",
			"permitModelUnconfirmed",
			"permitPartialObservation",
			"observationSource",
			"recordedObservationMaxAgeMs",
		],
		at,
	);
	return Object.freeze({
		permitCapacityUnknown: bool(r.permitCapacityUnknown, `${at}.permitCapacityUnknown`),
		permitModelUnconfirmed: bool(r.permitModelUnconfirmed, `${at}.permitModelUnconfirmed`),
		permitPartialObservation: bool(r.permitPartialObservation, `${at}.permitPartialObservation`),
		observationSource: oneOf(r.observationSource, ENDO_ADVISORY_OBSERVATION_SOURCES_V0, `${at}.observationSource`),
		recordedObservationMaxAgeMs: int(
			r.recordedObservationMaxAgeMs,
			L.minRecordedObservationMaxAgeMs,
			L.maxRecordedObservationMaxAgeMs,
			`${at}.recordedObservationMaxAgeMs`,
		),
	});
}

export function validateEndoAdvisoryBudgetV0(
	value: unknown,
	at = "budget",
	resourceProfile?: EndoCoordinatorResourceProfileV1,
): EndoAdvisoryBudgetV0 {
	if (resourceProfile !== undefined && resourceProfile.tier === "reflex")
		fail(`${at} cannot be authorized under non-inference tier "reflex"`);
	const maxOutputTokensCap = resourceProfile?.maxOutputTokensPerRequest ?? L.maxOutputTokensPerRequest;
	const maxGeneratedPerPeriodCap =
		resourceProfile === undefined
			? L.maxGeneratedTokensPerPeriod
			: L.maxTurnsPerPeriod * L.completionRequestsPerTurn * resourceProfile.maxOutputTokensPerRequest;
	const maxTurnWallClockCap = resourceProfile?.advisoryTurnDeadlineMs ?? L.maxTurnWallClockMs;
	const r = closed(
		value,
		[
			"periodMs",
			"maxTurnsPerPeriod",
			"completionRequestsPerTurn",
			"maxOutputTokensPerRequest",
			"maxGeneratedTokensPerPeriod",
			"maxTurnWallClockMs",
		],
		at,
	);
	const minOutputTokensFloor =
		resourceProfile?.reasoningControl.mode === "reasoning-budget-tokens"
			? Math.max(L.minOutputTokensPerRequest, resourceProfile.reasoningControl.tokens + G.minVisibleHeadroomTokens)
			: L.minOutputTokensPerRequest;
	const maxTurnsPerPeriod = int(r.maxTurnsPerPeriod, 1, L.maxTurnsPerPeriod, `${at}.maxTurnsPerPeriod`);
	const maxOutputTokensPerRequest = int(
		r.maxOutputTokensPerRequest,
		minOutputTokensFloor,
		maxOutputTokensCap,
		`${at}.maxOutputTokensPerRequest`,
	);
	const maxGeneratedTokensPerPeriod = int(
		r.maxGeneratedTokensPerPeriod,
		L.completionRequestsPerTurn * L.minOutputTokensPerRequest,
		maxGeneratedPerPeriodCap,
		`${at}.maxGeneratedTokensPerPeriod`,
	);
	if (maxGeneratedTokensPerPeriod < L.completionRequestsPerTurn * maxOutputTokensPerRequest)
		fail(`${at}.maxGeneratedTokensPerPeriod must cover at least one full turn reservation`);
	return Object.freeze({
		periodMs: int(r.periodMs, L.minBudgetPeriodMs, L.maxBudgetPeriodMs, `${at}.periodMs`),
		maxTurnsPerPeriod,
		completionRequestsPerTurn: literal(r.completionRequestsPerTurn, 2 as const, `${at}.completionRequestsPerTurn`),
		maxOutputTokensPerRequest,
		maxGeneratedTokensPerPeriod,
		maxTurnWallClockMs: int(
			r.maxTurnWallClockMs,
			L.minTurnWallClockMs,
			maxTurnWallClockCap,
			`${at}.maxTurnWallClockMs`,
		),
	});
}

export function validateEndoAdvisoryAuthorizationV0(value: unknown, at = "authorization"): EndoAdvisoryAuthorizationV0 {
	const r = closedWithOptional(
		value,
		[
			"authorizationId",
			"scheduleId",
			"scheduleIncarnation",
			"scheduleRevision",
			"projectId",
			"actionKind",
			"poolSha256",
			"pool",
			"policy",
			"budget",
			"grantedAtMs",
			"expiresAtMs",
			"revokedAtMs",
			"revocation",
		],
		["resourceProfile", "resourceProfileSha256"],
		at,
	);
	const hasProfile = Object.hasOwn(r, "resourceProfile") && r.resourceProfile !== undefined;
	const hasProfileSha = Object.hasOwn(r, "resourceProfileSha256") && r.resourceProfileSha256 !== undefined;
	if (hasProfile !== hasProfileSha) fail(`${at}.resourceProfile and resourceProfileSha256 must be set together`);
	let resourceProfile: EndoCoordinatorResourceProfileV1 | undefined;
	let resourceProfileSha256: string | undefined;
	if (hasProfile) {
		resourceProfile = validateEndoCoordinatorResourceProfileV1(r.resourceProfile, `${at}.resourceProfile`);
		if (resourceProfile.tier === "reflex")
			fail(`${at}.resourceProfile.tier cannot be "reflex": inference authorizations require an inference tier`);
		resourceProfileSha256 = sha(r.resourceProfileSha256, `${at}.resourceProfileSha256`);
	}
	let pool: EndoCoordinatorModelPoolAnyV1;
	try {
		pool =
			resourceProfile === undefined
				? parseEndoCoordinatorModelPoolV0(r.pool)
				: parseEndoCoordinatorModelPoolAnyV1(r.pool);
	} catch (error) {
		return fail(`${at}.pool: ${(error as Error).message}`);
	}
	if (pool.members.some((m) => m.kind !== "local-openai-compat"))
		fail(`${at}.pool may hold only local members: S2 does not authorise hosted inference`);
	if (resourceProfile !== undefined) {
		if (
			pool.schemaVersion === ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1 &&
			JSON.stringify(pool.resourceProfile) !== JSON.stringify(resourceProfile)
		) {
			fail(`${at}.pool.resourceProfile must exactly match ${at}.resourceProfile`);
		}
		const minMemberOutputTokens =
			resourceProfile.reasoningControl.mode === "reasoning-budget-tokens"
				? resourceProfile.reasoningControl.tokens + G.minVisibleHeadroomTokens
				: L.minOutputTokensPerRequest;
		for (const m of pool.members) {
			if (m.maxOutputTokens > resourceProfile.maxOutputTokensPerRequest)
				fail(`${at}.pool member ${JSON.stringify(m.memberId)} maxOutputTokens exceeds resourceProfile ceiling`);
			if (m.maxOutputTokens < minMemberOutputTokens)
				fail(
					`${at}.pool member ${JSON.stringify(m.memberId)} maxOutputTokens leaves insufficient visible headroom for reasoningControl`,
				);
			if (m.timeoutMs > resourceProfile.modelExecutionTimeoutMs)
				fail(`${at}.pool member ${JSON.stringify(m.memberId)} timeoutMs exceeds resourceProfile ceiling`);
		}
	}
	const grantedAtMs = ms(r.grantedAtMs, `${at}.grantedAtMs`);
	const expiresAtMs = ms(r.expiresAtMs, `${at}.expiresAtMs`);
	const lifetime = expiresAtMs - grantedAtMs;
	if (lifetime < L.minAuthorizationLifetimeMs || lifetime > L.maxAuthorizationLifetimeMs)
		fail(`${at} lifetime must be from ${L.minAuthorizationLifetimeMs} to ${L.maxAuthorizationLifetimeMs} ms`);
	const revokedAtMs = nInt(r.revokedAtMs, 1, MAX_EPOCH_MS, `${at}.revokedAtMs`);
	const revocation =
		r.revocation === null
			? null
			: oneOf(r.revocation, ["operator-revoked", "superseded"] as const, `${at}.revocation`);
	if ((revokedAtMs === null) !== (revocation === null)) fail(`${at}.revokedAtMs and revocation must be set together`);
	return Object.freeze({
		authorizationId: sha(r.authorizationId, `${at}.authorizationId`),
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		scheduleIncarnation: sha(r.scheduleIncarnation, `${at}.scheduleIncarnation`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		actionKind: actionOf(r.actionKind, `${at}.actionKind`),
		poolSha256: sha(r.poolSha256, `${at}.poolSha256`),
		pool,
		...(resourceProfile === undefined ? {} : { resourceProfile, resourceProfileSha256 }),
		policy: validateEndoAdvisoryPolicyV0(r.policy, `${at}.policy`),
		budget: validateEndoAdvisoryBudgetV0(r.budget, `${at}.budget`, resourceProfile),
		grantedAtMs,
		expiresAtMs,
		revokedAtMs,
		revocation,
	});
}

export function validateEndoAdvisoryAuthorizationsFileV0(value: unknown): EndoAdvisoryAuthorizationsFileV0 {
	const r = closed(value, ["schemaVersion", "revision", "updatedAtMs", "authorizations"], "advisory authorizations");
	literal(r.schemaVersion, ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0, "advisory authorizations.schemaVersion");
	const authorizations = arr(r.authorizations, L.maxAuthorizations, "advisory authorizations.authorizations").map(
		(a, i) => validateEndoAdvisoryAuthorizationV0(a, `advisory authorizations[${i}]`),
	);
	const ids = new Set<string>();
	const active = new Set<string>();
	for (const a of authorizations) {
		if (ids.has(a.authorizationId)) fail(`duplicate authorizationId ${a.authorizationId}`);
		ids.add(a.authorizationId);
		if (a.revokedAtMs === null) {
			if (active.has(a.scheduleId))
				fail(`more than one unrevoked authorization for ${JSON.stringify(a.scheduleId)}`);
			active.add(a.scheduleId);
		}
	}
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0,
		revision: int(r.revision, 0, Number.MAX_SAFE_INTEGER, "advisory authorizations.revision"),
		updatedAtMs: int(r.updatedAtMs, 0, MAX_EPOCH_MS, "advisory authorizations.updatedAtMs"),
		authorizations: Object.freeze(authorizations),
	});
}

export function emptyEndoAdvisoryAuthorizationsFileV0(): EndoAdvisoryAuthorizationsFileV0 {
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0,
		revision: 0,
		updatedAtMs: 0,
		authorizations: Object.freeze([]),
	});
}

// ---- Observations ------------------------------------------------------------------------------------------------------------------

export function validateEndoAdvisoryObservationsFileV0(value: unknown): EndoAdvisoryObservationsFileV0 {
	const r = closed(value, ["schemaVersion", "updatedAtMs", "projects"], "advisory observations");
	literal(r.schemaVersion, ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0, "advisory observations.schemaVersion");
	const projects = arr(r.projects, L.maxObservedProjects, "advisory observations.projects").map((p, i) => {
		const at = `advisory observations.projects[${i}]`;
		const x = closed(p, ["projectId", "semanticDigest", "completeness", "observedAtMs", "leaseEpoch"], at);
		return Object.freeze({
			projectId: projectIdOf(x.projectId, `${at}.projectId`),
			semanticDigest: nSha(x.semanticDigest, `${at}.semanticDigest`),
			completeness: oneOf(x.completeness, ENDO_ADVISORY_OBSERVATION_COMPLETENESS_V0, `${at}.completeness`),
			observedAtMs: ms(x.observedAtMs, `${at}.observedAtMs`),
			leaseEpoch: epochOf(x.leaseEpoch, `${at}.leaseEpoch`),
		});
	});
	const ids = new Set<string>();
	for (const p of projects) {
		if (ids.has(p.projectId)) fail(`duplicate observed project ${p.projectId}`);
		ids.add(p.projectId);
	}
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0,
		updatedAtMs: int(r.updatedAtMs, 0, MAX_EPOCH_MS, "advisory observations.updatedAtMs"),
		projects: Object.freeze(projects),
	});
}

// ---- Fires -------------------------------------------------------------------------------------------------------------------------

export function validateEndoAdvisoryFireClaimV0(value: unknown): EndoAdvisoryFireClaimV0 {
	const at = "advisory fire claim";
	const r = closed(
		value,
		[
			"schemaVersion",
			"idempotencyKey",
			"scheduleId",
			"scheduleRevision",
			"projectId",
			"actionKind",
			"wake",
			"triggerKind",
			"triggerCursor",
			"windowStartMs",
			"missedWindowsBefore",
			"claimedAtMs",
			"scheduleIncarnation",
			"leaseEpoch",
			"holderId",
		],
		at,
	);
	literal(r.schemaVersion, ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0, `${at}.schemaVersion`);
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0,
		idempotencyKey: sha(r.idempotencyKey, `${at}.idempotencyKey`),
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		actionKind: actionOf(r.actionKind, `${at}.actionKind`),
		wake: oneOf(r.wake, ENDO_ADVISORY_WAKE_POLICIES_V0, `${at}.wake`),
		triggerKind: oneOf(r.triggerKind, ENDO_SCHEDULE_TRIGGER_KINDS_V0, `${at}.triggerKind`),
		triggerCursor: pat(r.triggerCursor, SAFE_TEXT_256, `${at}.triggerCursor`),
		windowStartMs: ms(r.windowStartMs, `${at}.windowStartMs`),
		missedWindowsBefore: int(r.missedWindowsBefore, 0, Number.MAX_SAFE_INTEGER, `${at}.missedWindowsBefore`),
		claimedAtMs: ms(r.claimedAtMs, `${at}.claimedAtMs`),
		leaseEpoch: epochOf(r.leaseEpoch, `${at}.leaseEpoch`),
		holderId: holderOf(r.holderId, `${at}.holderId`),
		scheduleIncarnation: sha(r.scheduleIncarnation, `${at}.scheduleIncarnation`),
	});
}

function validateGate(value: unknown, at: string): EndoAdvisoryGateRecordV0 {
	const r = closed(
		value,
		[
			"wakeReason",
			"semanticDigest",
			"completeness",
			"observedAtMs",
			"gaps",
			"lastConsideredSemanticDigest",
			"lastAttemptedSemanticDigest",
		],
		at,
	);
	return Object.freeze({
		wakeReason: r.wakeReason === null ? null : oneOf(r.wakeReason, ENDO_ADVISORY_WAKE_REASONS_V0, `${at}.wakeReason`),
		semanticDigest: nSha(r.semanticDigest, `${at}.semanticDigest`),
		completeness: oneOf(r.completeness, ENDO_ADVISORY_OBSERVATION_COMPLETENESS_V0, `${at}.completeness`),
		observedAtMs: nMs(r.observedAtMs, `${at}.observedAtMs`),
		gaps: codes(r.gaps, L.maxGaps, `${at}.gaps`),
		lastConsideredSemanticDigest: nSha(r.lastConsideredSemanticDigest, `${at}.lastConsideredSemanticDigest`),
		lastAttemptedSemanticDigest: nSha(r.lastAttemptedSemanticDigest, `${at}.lastAttemptedSemanticDigest`),
	});
}

export function validateEndoAdvisoryFireOutcomeV0(value: unknown): EndoAdvisoryFireOutcomeV0 {
	const at = "advisory fire outcome";
	const r = closed(
		value,
		[
			"schemaVersion",
			"idempotencyKey",
			"scheduleId",
			"scheduleRevision",
			"projectId",
			"actionKind",
			"windowStartMs",
			"completedAtMs",
			"leaseEpoch",
			"holderId",
			"status",
			"missedWindowCount",
			"gate",
			"turnId",
			"inferenceDispatched",
			"detail",
		],
		at,
	);
	literal(r.schemaVersion, ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0, `${at}.schemaVersion`);
	const status = oneOf(r.status, ENDO_ADVISORY_FIRE_OUTCOME_STATUSES_V0, `${at}.status`);
	const inferenceDispatched = oneOf(r.inferenceDispatched, ["no", "yes"] as const, `${at}.inferenceDispatched`);
	const dispatchedStatuses: readonly EndoAdvisoryFireOutcomeStatusV0[] = [
		"briefing-published",
		"briefing-refused",
		"result-withheld",
		"failed",
	];
	if (inferenceDispatched === "yes" && !dispatchedStatuses.includes(status))
		fail(`${at}: status ${status} cannot follow a dispatched completion request`);
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0,
		idempotencyKey: sha(r.idempotencyKey, `${at}.idempotencyKey`),
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		actionKind: actionOf(r.actionKind, `${at}.actionKind`),
		windowStartMs: ms(r.windowStartMs, `${at}.windowStartMs`),
		completedAtMs: ms(r.completedAtMs, `${at}.completedAtMs`),
		leaseEpoch: epochOf(r.leaseEpoch, `${at}.leaseEpoch`),
		holderId: holderOf(r.holderId, `${at}.holderId`),
		status,
		missedWindowCount: int(r.missedWindowCount, 0, Number.MAX_SAFE_INTEGER, `${at}.missedWindowCount`),
		gate: r.gate === null ? null : validateGate(r.gate, `${at}.gate`),
		turnId: nSha(r.turnId, `${at}.turnId`),
		inferenceDispatched,
		detail: nPat(r.detail, SAFE_TEXT_512, `${at}.detail`),
	});
}

// ---- Turns -------------------------------------------------------------------------------------------------------------------------

/**
 * S2 advisory duty lease validator. Same closed record shape as S1 (`endo.develop-automation-lease.v0`), but permits
 * TTLs up to the governed V1 cognitive-resource ceiling (`1_200_000` ms) for S2 advisory duty leases only.
 * S1's own `validateEndoDevelopAutomationLeaseV0` stays strictly capped at 300,000 ms.
 */
export function validateEndoAdvisoryLeaseV0(value: unknown): EndoDevelopAutomationLeaseV0 {
	const r = closed(
		value,
		["schemaVersion", "holderId", "epoch", "acquiredAtMs", "expiresAtMs", "releasedAtMs"],
		"advisory lease",
	);
	literal(r.schemaVersion, ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0, "advisory lease.schemaVersion");
	const acquiredAtMs = ms(r.acquiredAtMs, "advisory lease.acquiredAtMs");
	const expiresAtMs = ms(r.expiresAtMs, "advisory lease.expiresAtMs");
	if (expiresAtMs <= acquiredAtMs) fail("advisory lease.expiresAtMs must be strictly after acquiredAtMs");
	if (expiresAtMs - acquiredAtMs > G.maxLeaseTtlMs) fail(`advisory lease TTL exceeds maximum ${G.maxLeaseTtlMs} ms`);
	const releasedAtMs = nInt(r.releasedAtMs, 1, MAX_EPOCH_MS, "advisory lease.releasedAtMs");
	return Object.freeze({
		schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
		holderId: holderOf(r.holderId, "advisory lease.holderId"),
		epoch: epochOf(r.epoch, "advisory lease.epoch"),
		acquiredAtMs,
		expiresAtMs,
		releasedAtMs,
	});
}

function validateReservation(value: unknown, at: string, governedV1: boolean): EndoAdvisoryReservationV0 {
	const r = closed(value, ["completionRequests", "generatedTokens", "wallClockMs"], at);
	const maxGeneratedTokens = governedV1
		? G.maxAggregateGeneratedTokensPerTurn
		: L.completionRequestsPerTurn * L.maxOutputTokensPerRequest;
	const maxWallClockMs = governedV1 ? G.maxLeaseTtlMs : L.leaseTtlMs;
	return Object.freeze({
		completionRequests: int(r.completionRequests, 0, L.completionRequestsPerTurn, `${at}.completionRequests`),
		generatedTokens: int(r.generatedTokens, 0, maxGeneratedTokens, `${at}.generatedTokens`),
		wallClockMs: int(r.wallClockMs, 0, maxWallClockMs, `${at}.wallClockMs`),
	});
}

export function validateEndoAdvisoryTurnAdmissionV0(value: unknown): EndoAdvisoryTurnAdmissionV0 {
	const at = "advisory turn admission";
	const r = closedWithOptional(
		value,
		[
			"schemaVersion",
			"turnId",
			"fireIdempotencyKey",
			"scheduleId",
			"scheduleRevision",
			"projectId",
			"actionKind",
			"authorizationId",
			"poolSha256",
			"policySha256",
			"budgetSha256",
			"leaseEpoch",
			"holderId",
			"admittedAtMs",
			"turnDeadlineMs",
			"wakeReason",
			"semanticDigest",
			"completeness",
			"observedAtMs",
			"gaps",
			"reservation",
			"budgetBefore",
		],
		["resourceProfileSha256"],
		at,
	);
	literal(r.schemaVersion, ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0, `${at}.schemaVersion`);
	const resourceProfileSha256 =
		Object.hasOwn(r, "resourceProfileSha256") && r.resourceProfileSha256 !== undefined
			? sha(r.resourceProfileSha256, `${at}.resourceProfileSha256`)
			: undefined;
	const governedV1 = resourceProfileSha256 !== undefined;
	const maxLeaseSpanMs = governedV1 ? G.maxLeaseTtlMs : L.leaseTtlMs;
	const b = closed(
		r.budgetBefore,
		["periodStartMs", "turnsCharged", "generatedTokensCharged", "uncertainTurns"],
		`${at}.budgetBefore`,
	);
	const admittedAtMs = ms(r.admittedAtMs, `${at}.admittedAtMs`);
	const turnDeadlineMs = ms(r.turnDeadlineMs, `${at}.turnDeadlineMs`);
	if (turnDeadlineMs <= admittedAtMs || turnDeadlineMs - admittedAtMs > maxLeaseSpanMs)
		fail(`${at}.turnDeadlineMs must fall within one advisory lease of admission`);
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0,
		turnId: sha(r.turnId, `${at}.turnId`),
		fireIdempotencyKey: sha(r.fireIdempotencyKey, `${at}.fireIdempotencyKey`),
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		actionKind: actionOf(r.actionKind, `${at}.actionKind`),
		authorizationId: sha(r.authorizationId, `${at}.authorizationId`),
		poolSha256: sha(r.poolSha256, `${at}.poolSha256`),
		...(resourceProfileSha256 === undefined ? {} : { resourceProfileSha256 }),
		policySha256: sha(r.policySha256, `${at}.policySha256`),
		budgetSha256: sha(r.budgetSha256, `${at}.budgetSha256`),
		leaseEpoch: epochOf(r.leaseEpoch, `${at}.leaseEpoch`),
		holderId: holderOf(r.holderId, `${at}.holderId`),
		admittedAtMs,
		turnDeadlineMs,
		wakeReason: oneOf(r.wakeReason, ENDO_ADVISORY_WAKE_REASONS_V0, `${at}.wakeReason`),
		semanticDigest: sha(r.semanticDigest, `${at}.semanticDigest`),
		completeness: oneOf(r.completeness, ["complete", "partial"] as const, `${at}.completeness`),
		observedAtMs: ms(r.observedAtMs, `${at}.observedAtMs`),
		gaps: codes(r.gaps, L.maxGaps, `${at}.gaps`),
		reservation: validateReservation(r.reservation, `${at}.reservation`, governedV1),
		budgetBefore: Object.freeze({
			periodStartMs: int(b.periodStartMs, 0, MAX_EPOCH_MS, `${at}.budgetBefore.periodStartMs`),
			turnsCharged: int(b.turnsCharged, 0, Number.MAX_SAFE_INTEGER, `${at}.budgetBefore.turnsCharged`),
			generatedTokensCharged: int(
				b.generatedTokensCharged,
				0,
				Number.MAX_SAFE_INTEGER,
				`${at}.budgetBefore.generatedTokensCharged`,
			),
			uncertainTurns: int(b.uncertainTurns, 0, Number.MAX_SAFE_INTEGER, `${at}.budgetBefore.uncertainTurns`),
		}),
	});
}

function validateSkipped(value: unknown, at: string): readonly EndoAdvisorySkippedMemberV0[] {
	return Object.freeze(
		arr(value, L.maxSkippedMembers, at).map((s, i) => {
			const x = closed(s, ["memberId", "reason"], `${at}[${i}]`);
			return Object.freeze({
				memberId: pat(x.memberId, ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0, `${at}[${i}].memberId`),
				reason: pat(x.reason, SAFE_CODE, `${at}[${i}].reason`),
			});
		}),
	);
}

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;

export function validateEndoAdvisoryTurnDispatchV0(value: unknown): EndoAdvisoryTurnDispatchV0 {
	const at = "advisory turn dispatch";
	const r = closedWithOptional(
		value,
		[
			"schemaVersion",
			"turnId",
			"leaseEpoch",
			"holderId",
			"dispatchedAtMs",
			"authorizationId",
			"scheduleRevision",
			"effectivePoolSha256",
			"selectedMemberId",
			"selectedModelId",
			"selectedEndpoint",
			"selectedReadiness",
			"observationBasis",
			"capacityConfirmed",
			"fallbackOccurred",
			"skippedMembers",
			"inferenceDeadlineMs",
			"effectiveTimeoutMs",
		],
		["resourceProfileSha256"],
		at,
	);
	literal(r.schemaVersion, ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0, `${at}.schemaVersion`);
	const resourceProfileSha256 =
		Object.hasOwn(r, "resourceProfileSha256") && r.resourceProfileSha256 !== undefined
			? sha(r.resourceProfileSha256, `${at}.resourceProfileSha256`)
			: undefined;
	const maxEffectiveTimeoutMs = resourceProfileSha256 !== undefined ? G.maxTurnWallClockMs : L.maxTurnWallClockMs;
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0,
		turnId: sha(r.turnId, `${at}.turnId`),
		leaseEpoch: epochOf(r.leaseEpoch, `${at}.leaseEpoch`),
		holderId: holderOf(r.holderId, `${at}.holderId`),
		dispatchedAtMs: ms(r.dispatchedAtMs, `${at}.dispatchedAtMs`),
		authorizationId: sha(r.authorizationId, `${at}.authorizationId`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		effectivePoolSha256: sha(r.effectivePoolSha256, `${at}.effectivePoolSha256`),
		...(resourceProfileSha256 === undefined ? {} : { resourceProfileSha256 }),
		selectedMemberId: pat(
			r.selectedMemberId,
			ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0,
			`${at}.selectedMemberId`,
		),
		selectedModelId: pat(r.selectedModelId, ENDO_COORDINATOR_MODEL_ID_PATTERN_V0, `${at}.selectedModelId`),
		selectedEndpoint: pat(r.selectedEndpoint, LOOPBACK_ORIGIN, `${at}.selectedEndpoint`),
		selectedReadiness: pat(r.selectedReadiness, SAFE_CODE, `${at}.selectedReadiness`),
		observationBasis: oneOf(r.observationBasis, ["recorded", "live-probe"] as const, `${at}.observationBasis`),
		capacityConfirmed: bool(r.capacityConfirmed, `${at}.capacityConfirmed`),
		fallbackOccurred: bool(r.fallbackOccurred, `${at}.fallbackOccurred`),
		skippedMembers: validateSkipped(r.skippedMembers, `${at}.skippedMembers`),
		inferenceDeadlineMs: ms(r.inferenceDeadlineMs, `${at}.inferenceDeadlineMs`),
		effectiveTimeoutMs: int(
			r.effectiveTimeoutMs,
			L.minInferenceWindowMs,
			maxEffectiveTimeoutMs,
			`${at}.effectiveTimeoutMs`,
		),
	});
}

const nCount = (value: unknown, at: string) => nInt(value, 0, Number.MAX_SAFE_INTEGER, at);

export function validateEndoAdvisoryBriefingV0(value: unknown): EndoAdvisoryBriefingV0 {
	const at = "advisory briefing";
	const r = closedWithOptional(
		value,
		[
			"schemaVersion",
			"turnId",
			"fireIdempotencyKey",
			"scheduleId",
			"scheduleRevision",
			"projectId",
			"actionKind",
			"wakeReason",
			"leaseEpoch",
			"holderId",
			"admittedAtMs",
			"publishedAtMs",
			"authorizationId",
			"poolSha256",
			"effectivePoolSha256",
			"policySha256",
			"budgetSha256",
			"prompt",
			"source",
			"model",
			"accounting",
			"availability",
			"refusal",
			"answer",
			"standing",
			"proposal",
		],
		["resourceProfileSha256"],
		at,
	);
	literal(r.schemaVersion, ENDO_ADVISORY_BRIEFING_SCHEMA_V0, `${at}.schemaVersion`);
	const resourceProfileSha256 =
		Object.hasOwn(r, "resourceProfileSha256") && r.resourceProfileSha256 !== undefined
			? sha(r.resourceProfileSha256, `${at}.resourceProfileSha256`)
			: undefined;
	const governedV1 = resourceProfileSha256 !== undefined;
	const p = closed(r.prompt, ["instructionsSha256", "questionSha256", "promptSha256"], `${at}.prompt`);
	const s = closed(
		r.source,
		[
			"admissionSemanticDigest",
			"admissionObservedAtMs",
			"completeness",
			"gaps",
			"evidence",
			"publicationSemanticDigest",
			"publicationObservedAtMs",
			"currency",
		],
		`${at}.source`,
	);
	let evidence: EndoAdvisoryBriefingSourceV0["evidence"] = null;
	if (s.evidence !== null) {
		const e = closed(s.evidence, ["readAtMs", "projectionSha256", "modelViewSha256"], `${at}.source.evidence`);
		evidence = Object.freeze({
			readAtMs: int(e.readAtMs, 0, MAX_EPOCH_MS, `${at}.source.evidence.readAtMs`),
			projectionSha256: sha(e.projectionSha256, `${at}.source.evidence.projectionSha256`),
			modelViewSha256: sha(e.modelViewSha256, `${at}.source.evidence.modelViewSha256`),
		});
	}
	const m = closed(
		r.model,
		[
			"harness",
			"provider",
			"reportedModel",
			"selectedMemberId",
			"selectedModelId",
			"selectedEndpoint",
			"selectedReadiness",
			"capacityConfirmed",
			"fallbackOccurred",
			"skippedMembers",
			"inferenceFailover",
		],
		`${at}.model`,
	);
	const a = closed(
		r.accounting,
		[
			"reserved",
			"admittedExchanges",
			"reportedPromptTokens",
			"reportedCompletionTokens",
			"usageReportComplete",
			"chargedCompletionRequests",
			"chargedGeneratedTokens",
			"inferenceElapsedMs",
		],
		`${at}.accounting`,
	);
	const prop = closed(r.proposal, ["outcome", "proposalId", "refusal"], `${at}.proposal`);
	const availability = oneOf(
		r.availability,
		["available", "unavailable", "not-dispatched", "withheld"] as const,
		`${at}.availability`,
	);
	const answer = r.answer === null ? null : pat(r.answer, /^[\s\S]+$/, `${at}.answer`);
	if (answer !== null && Buffer.byteLength(answer, "utf8") > L.maxAnswerBytes)
		fail(`${at}.answer exceeds ${L.maxAnswerBytes} bytes`);
	if ((availability === "available") !== (answer !== null))
		fail(`${at}.answer is published only for an available briefing`);
	const refusal = nPat(r.refusal, SAFE_CODE, `${at}.refusal`);
	if ((availability === "available") !== (refusal === null))
		fail(`${at}.refusal must be set exactly when not available`);
	const proposal = Object.freeze({
		outcome: oneOf(prop.outcome, ENDO_ADVISORY_PROPOSAL_OUTCOMES_V0, `${at}.proposal.outcome`),
		proposalId: nSha(prop.proposalId, `${at}.proposal.proposalId`),
		refusal:
			prop.refusal === null
				? null
				: oneOf(prop.refusal, ENDO_ADVISORY_PROPOSAL_REFUSALS_V0, `${at}.proposal.refusal`),
	});
	if ((proposal.outcome === "created" || proposal.outcome === "deduplicated") !== (proposal.proposalId !== null))
		fail(`${at}.proposal.proposalId must be set exactly for a created or deduplicated proposal`);
	if ((proposal.outcome === "refused") !== (proposal.refusal !== null))
		fail(`${at}.proposal.refusal must be set exactly for a refused proposal`);
	if (availability !== "available" && (proposal.outcome === "created" || proposal.outcome === "deduplicated"))
		fail(`${at}: only an available briefing can carry a proposal`);
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_BRIEFING_SCHEMA_V0,
		turnId: sha(r.turnId, `${at}.turnId`),
		fireIdempotencyKey: sha(r.fireIdempotencyKey, `${at}.fireIdempotencyKey`),
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		actionKind: actionOf(r.actionKind, `${at}.actionKind`),
		wakeReason: oneOf(r.wakeReason, ENDO_ADVISORY_WAKE_REASONS_V0, `${at}.wakeReason`),
		leaseEpoch: epochOf(r.leaseEpoch, `${at}.leaseEpoch`),
		holderId: holderOf(r.holderId, `${at}.holderId`),
		admittedAtMs: ms(r.admittedAtMs, `${at}.admittedAtMs`),
		publishedAtMs: ms(r.publishedAtMs, `${at}.publishedAtMs`),
		authorizationId: sha(r.authorizationId, `${at}.authorizationId`),
		poolSha256: sha(r.poolSha256, `${at}.poolSha256`),
		effectivePoolSha256: nSha(r.effectivePoolSha256, `${at}.effectivePoolSha256`),
		...(resourceProfileSha256 === undefined ? {} : { resourceProfileSha256 }),
		policySha256: sha(r.policySha256, `${at}.policySha256`),
		budgetSha256: sha(r.budgetSha256, `${at}.budgetSha256`),
		prompt: Object.freeze({
			instructionsSha256: sha(p.instructionsSha256, `${at}.prompt.instructionsSha256`),
			questionSha256: nSha(p.questionSha256, `${at}.prompt.questionSha256`),
			promptSha256: nSha(p.promptSha256, `${at}.prompt.promptSha256`),
		}),
		source: Object.freeze({
			admissionSemanticDigest: sha(s.admissionSemanticDigest, `${at}.source.admissionSemanticDigest`),
			admissionObservedAtMs: ms(s.admissionObservedAtMs, `${at}.source.admissionObservedAtMs`),
			completeness: oneOf(s.completeness, ENDO_ADVISORY_OBSERVATION_COMPLETENESS_V0, `${at}.source.completeness`),
			gaps: codes(s.gaps, L.maxGaps, `${at}.source.gaps`),
			evidence,
			publicationSemanticDigest: nSha(s.publicationSemanticDigest, `${at}.source.publicationSemanticDigest`),
			publicationObservedAtMs: nMs(s.publicationObservedAtMs, `${at}.source.publicationObservedAtMs`),
			currency: oneOf(s.currency, ENDO_ADVISORY_PUBLICATION_CURRENCY_V0, `${at}.source.currency`),
		}),
		model: Object.freeze({
			harness: pat(m.harness, SAFE_TEXT_128, `${at}.model.harness`),
			provider: pat(m.provider, SAFE_TEXT_128, `${at}.model.provider`),
			reportedModel: pat(m.reportedModel, ENDO_COORDINATOR_MODEL_ID_PATTERN_V0, `${at}.model.reportedModel`),
			selectedMemberId: nPat(
				m.selectedMemberId,
				ENDO_COORDINATOR_MODEL_POOL_MEMBER_ID_PATTERN_V0,
				`${at}.model.selectedMemberId`,
			),
			selectedModelId: nPat(m.selectedModelId, ENDO_COORDINATOR_MODEL_ID_PATTERN_V0, `${at}.model.selectedModelId`),
			selectedEndpoint: nPat(m.selectedEndpoint, LOOPBACK_ORIGIN, `${at}.model.selectedEndpoint`),
			selectedReadiness: nPat(m.selectedReadiness, SAFE_CODE, `${at}.model.selectedReadiness`),
			capacityConfirmed: bool(m.capacityConfirmed, `${at}.model.capacityConfirmed`),
			fallbackOccurred: bool(m.fallbackOccurred, `${at}.model.fallbackOccurred`),
			skippedMembers: validateSkipped(m.skippedMembers, `${at}.model.skippedMembers`),
			inferenceFailover: literal(m.inferenceFailover, "never" as const, `${at}.model.inferenceFailover`),
		}),
		accounting: Object.freeze({
			reserved: validateReservation(a.reserved, `${at}.accounting.reserved`, governedV1),
			admittedExchanges: nCount(a.admittedExchanges, `${at}.accounting.admittedExchanges`),
			reportedPromptTokens: nCount(a.reportedPromptTokens, `${at}.accounting.reportedPromptTokens`),
			reportedCompletionTokens: nCount(a.reportedCompletionTokens, `${at}.accounting.reportedCompletionTokens`),
			usageReportComplete: bool(a.usageReportComplete, `${at}.accounting.usageReportComplete`),
			chargedCompletionRequests: int(
				a.chargedCompletionRequests,
				0,
				Number.MAX_SAFE_INTEGER,
				`${at}.accounting.chargedCompletionRequests`,
			),
			chargedGeneratedTokens: int(
				a.chargedGeneratedTokens,
				0,
				Number.MAX_SAFE_INTEGER,
				`${at}.accounting.chargedGeneratedTokens`,
			),
			inferenceElapsedMs: nCount(a.inferenceElapsedMs, `${at}.accounting.inferenceElapsedMs`),
		}),
		availability,
		refusal,
		answer,
		standing: literal(r.standing, "untrusted-model-interpretation" as const, `${at}.standing`),
		proposal,
	});
}

// ---- Proposals ---------------------------------------------------------------------------------------------------------------------

export function validateEndoAdvisoryProposalV0(value: unknown): EndoAdvisoryProposalV0 {
	const at = "advisory proposal";
	const r = closed(
		value,
		[
			"schemaVersion",
			"proposalId",
			"dedupKey",
			"projectId",
			"kind",
			"subject",
			"evidence",
			"uncertainties",
			"rationale",
			"generatedAtMs",
			"scheduleId",
			"scheduleRevision",
			"fireIdempotencyKey",
			"turnId",
			"standing",
			"authority",
		],
		at,
	);
	literal(r.schemaVersion, ENDO_ADVISORY_PROPOSAL_SCHEMA_V0, `${at}.schemaVersion`);
	const subj = closed(r.subject, ["taskId", "assignmentId", "candidateId"], `${at}.subject`);
	const ev = closed(
		r.evidence,
		["facts", "semanticDigest", "admissionSemanticDigest", "projectionSha256"],
		`${at}.evidence`,
	);
	const facts = arr(ev.facts, L.maxEvidenceFacts, `${at}.evidence.facts`).map((f, i) => {
		const x = closed(f, ["fact", "subject"], `${at}.evidence.facts[${i}]`);
		return Object.freeze({
			fact: oneOf(x.fact, ENDO_ADVISORY_EVIDENCE_FACTS_V0, `${at}.evidence.facts[${i}].fact`),
			subject: pat(
				x.subject,
				/^endo\.(?:task|assignment|candidate)\.[0-9a-f]{32}$/,
				`${at}.evidence.facts[${i}].subject`,
			),
		});
	});
	if (facts.length === 0) fail(`${at}.evidence.facts must cite at least one deterministic fact`);
	const rat = closed(r.rationale, ["source", "turnId"], `${at}.rationale`);
	const auth = closed(
		r.authority,
		["grants", "executionAuthority", "requiresOperatorConfirmationPerAttempt"],
		`${at}.authority`,
	);
	const turnId = sha(r.turnId, `${at}.turnId`);
	if (rat.turnId !== turnId) fail(`${at}.rationale.turnId must name the proposal's own turn`);
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_PROPOSAL_SCHEMA_V0,
		proposalId: sha(r.proposalId, `${at}.proposalId`),
		dedupKey: sha(r.dedupKey, `${at}.dedupKey`),
		projectId: projectIdOf(r.projectId, `${at}.projectId`),
		kind: oneOf(r.kind, ENDO_ADVISORY_PROPOSAL_KINDS_V0, `${at}.kind`),
		subject: Object.freeze({
			taskId: pat(subj.taskId, ENDO_TASK_ID_PATTERN_V0, `${at}.subject.taskId`),
			assignmentId: nPat(subj.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, `${at}.subject.assignmentId`),
			candidateId: nPat(subj.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, `${at}.subject.candidateId`),
		}),
		evidence: Object.freeze({
			facts: Object.freeze(facts),
			semanticDigest: sha(ev.semanticDigest, `${at}.evidence.semanticDigest`),
			admissionSemanticDigest: sha(ev.admissionSemanticDigest, `${at}.evidence.admissionSemanticDigest`),
			projectionSha256: nSha(ev.projectionSha256, `${at}.evidence.projectionSha256`),
		}),
		uncertainties: codes(r.uncertainties, L.maxUncertainties, `${at}.uncertainties`),
		rationale: Object.freeze({
			source: literal(rat.source, "model-briefing" as const, `${at}.rationale.source`),
			turnId,
		}),
		generatedAtMs: ms(r.generatedAtMs, `${at}.generatedAtMs`),
		scheduleId: scheduleIdOf(r.scheduleId, `${at}.scheduleId`),
		scheduleRevision: revisionOf(r.scheduleRevision, `${at}.scheduleRevision`),
		fireIdempotencyKey: sha(r.fireIdempotencyKey, `${at}.fireIdempotencyKey`),
		turnId,
		standing: literal(r.standing, "untrusted-advisory-proposal" as const, `${at}.standing`),
		authority: Object.freeze({
			grants: literal(auth.grants, "none" as const, `${at}.authority.grants`),
			executionAuthority: literal(auth.executionAuthority, false as const, `${at}.authority.executionAuthority`),
			requiresOperatorConfirmationPerAttempt: literal(
				auth.requiresOperatorConfirmationPerAttempt,
				true as const,
				`${at}.authority.requiresOperatorConfirmationPerAttempt`,
			),
		}),
	});
}

export function validateEndoAdvisoryProposalStateV0(value: unknown): EndoAdvisoryProposalStateV0 {
	const at = "advisory proposal state";
	const r = closed(value, ["schemaVersion", "proposalId", "disposition", "decidedAtMs", "note", "authority"], at);
	literal(r.schemaVersion, ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0, `${at}.schemaVersion`);
	const auth = closed(r.authority, ["grants", "affects"], `${at}.authority`);
	return Object.freeze({
		schemaVersion: ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0,
		proposalId: sha(r.proposalId, `${at}.proposalId`),
		disposition: oneOf(r.disposition, ENDO_ADVISORY_PROPOSAL_DISPOSITIONS_V0, `${at}.disposition`),
		decidedAtMs: ms(r.decidedAtMs, `${at}.decidedAtMs`),
		note: nPat(r.note, SAFE_TEXT_512, `${at}.note`),
		authority: Object.freeze({
			grants: literal(auth.grants, "none" as const, `${at}.authority.grants`),
			affects: literal(auth.affects, "advisory-queue-only" as const, `${at}.authority.affects`),
		}),
	});
}

// ---- Versioned reader tables -------------------------------------------------------------------------------------------------------

const table = <T>(name: string, schema: string, validate: (value: unknown) => T) =>
	defineEndoVersionTableV0<T>(name, [[schema, validate]]);

export const ENDO_ADVISORY_VERSION_TABLES_V0 = Object.freeze({
	schedules: table(
		"develop-advisory-schedules",
		ENDO_ADVISORY_SCHEDULES_SCHEMA_V0,
		validateEndoAdvisorySchedulesFileV0,
	),
	authorizations: table(
		"develop-advisory-authorizations",
		ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0,
		validateEndoAdvisoryAuthorizationsFileV0,
	),
	lease: table("develop-advisory-lease", ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0, validateEndoAdvisoryLeaseV0),
	observations: table(
		"develop-advisory-observations",
		ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0,
		validateEndoAdvisoryObservationsFileV0,
	),
	fireClaim: table("develop-advisory-fire-claim", ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0, validateEndoAdvisoryFireClaimV0),
	fireOutcome: table(
		"develop-advisory-fire-outcome",
		ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0,
		validateEndoAdvisoryFireOutcomeV0,
	),
	admission: table(
		"develop-advisory-turn-admission",
		ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0,
		validateEndoAdvisoryTurnAdmissionV0,
	),
	dispatch: table(
		"develop-advisory-turn-dispatch",
		ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0,
		validateEndoAdvisoryTurnDispatchV0,
	),
	briefing: table("develop-advisory-briefing", ENDO_ADVISORY_BRIEFING_SCHEMA_V0, validateEndoAdvisoryBriefingV0),
	proposal: table("develop-advisory-proposal", ENDO_ADVISORY_PROPOSAL_SCHEMA_V0, validateEndoAdvisoryProposalV0),
	proposalState: table(
		"develop-advisory-proposal-state",
		ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0,
		validateEndoAdvisoryProposalStateV0,
	),
});
