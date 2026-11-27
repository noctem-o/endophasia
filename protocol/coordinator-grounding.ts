// Closed, versioned contracts for subject-scoped Coordinator grounding (`COORDINATOR-GROUNDING-002`).
//
// Pure protocol module: zero Node imports, zero I/O, zero authority.
//
// Two closed v1 schemas:
//   - `endo.coordinator-model-view.v1`: the exact single-project evidence snapshot delivered to the model
//     via `endophasia_status`, carrying snapshot-local `evidenceRef` identifiers on every visible entity
//     and an optional bounded, project-scoped coordination projection.
//   - `endo.coordinator-grounded-brief.v1`: the strict JSON structure the model must emit in `grounded-v1`
//     mode. Every factual claim, uncertainty, recommendation, and proposal is bound to an explicit
//     `(subjectKind, subjectId, evidenceRef)` verified mechanically against the model-visible snapshot.
//     Zero model-supplied free prose enters the rendered operator briefing; all recommendation text is
//     rendered deterministically by the host from closed, snapshot-verified `rationaleCode` values.

import { ENDO_ADVISORY_PROPOSAL_KINDS_V0, type EndoAdvisoryProposalKindV0 } from "./develop-advisory.ts";
import {
	ENDO_ASSIGNMENT_ID_PATTERN_V0,
	ENDO_CANDIDATE_ID_PATTERN_V0,
	ENDO_DEPENDENCY_ID_PATTERN_V0,
	ENDO_WORKTREE_ID_PATTERN_V0,
} from "./develop-coordination.ts";
import { ENDO_REVIEW_ID_PATTERN_V0 } from "./develop-coordination-reviews.ts";
import { ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import { EndoInvalidRecordV0, endoBoundedDetailV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_COORDINATOR_MODEL_VIEW_SCHEMA_V1 = "endo.coordinator-model-view.v1";
export const ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1 = "endo.coordinator-grounded-brief.v1";

export const ENDO_COORDINATOR_BRIEFING_MODES_V1 = ["legacy-v0", "grounded-v1"] as const;
export type EndoCoordinatorBriefingModeV1 = (typeof ENDO_COORDINATOR_BRIEFING_MODES_V1)[number];

export const ENDO_COORDINATOR_VISIBILITY_MODES_V1 = ["status-v0", "status-and-coordination-v1"] as const;
export type EndoCoordinatorVisibilityModeV1 = (typeof ENDO_COORDINATOR_VISIBILITY_MODES_V1)[number];

export const ENDO_COORDINATOR_GROUNDING_LIMITS_V1 = Object.freeze({
	maxResponseBytes: 16 * 1024,
	maxRenderedAnswerBytes: 4096,
	minClaims: 1,
	maxClaims: 16,
	maxUncertainties: 10,
	maxRecommendations: 4,
	maxSupportingRefs: 4,
	maxAssignments: 16,
	maxDependencies: 24,
	maxCandidates: 24,
	maxWorktrees: 16,
	maxConflicts: 16,
	maxReviews: 16,
});

export const ENDO_COORDINATOR_SUBJECT_KINDS_V1 = [
	"project",
	"sources",
	"task",
	"session",
	"coordination",
	"assignment",
	"dependency",
	"candidate",
	"worktree",
	"conflict",
	"review",
] as const;
export type EndoCoordinatorSubjectKindV1 = (typeof ENDO_COORDINATOR_SUBJECT_KINDS_V1)[number];

export const ENDO_COORDINATOR_CLAIM_PREDICATES_V1 = [
	"head-state",
	"project-freshness",
	"task-count-phase",
	"source-state",
	"session-activity",
	"task-phase",
	"verification-state",
	"current-head-check",
	"historical-check",
	"verification-contradiction",
	"task-gap",
	"task-association",
	"session-observation",
	"session-recorded-state",
	"session-liveness",
	"coordination-source",
	"coordination-assignments",
	"coordination-gap",
	"assignment-state",
	"assignment-role",
	"assignment-task",
	"assignment-hazard",
	"assignment-liveness",
	"assignment-finding",
	"dependency-satisfaction",
	"dependency-condition",
	"dependency-reason",
	"candidate-relation",
	"candidate-receipts",
	"candidate-workspace",
	"worktree-observation",
	"worktree-clean",
	"conflict-kind",
	"review-verdict",
	"review-candidate-relation",
] as const;
export type EndoCoordinatorClaimPredicateV1 = (typeof ENDO_COORDINATOR_CLAIM_PREDICATES_V1)[number];

export const ENDO_COORDINATOR_UNCERTAINTY_CODES_V1 = [
	"event-source-unavailable",
	"attempt-source-unavailable",
	"verification-not-established",
	"verification-incomplete",
	"verification-not-current",
	"session-liveness-unknown",
	"termination-unconfirmed",
	"coordination-unavailable",
	"coordination-truncated",
	"head-not-observed",
	"task-association-unknown",
	"completion-not-correctness",
	"advisory-review-not-host-check",
] as const;
export type EndoCoordinatorUncertaintyCodeV1 = (typeof ENDO_COORDINATOR_UNCERTAINTY_CODES_V1)[number];

export const ENDO_COORDINATOR_RECOMMENDATION_KINDS_V1 = [
	...ENDO_ADVISORY_PROPOSAL_KINDS_V0,
	"resolve-worktree-conflict",
	"resolve-unsatisfied-dependency",
	"inspect-advisory-review",
	"inspect-missing-sources",
	"monitor-open-task",
	"no-action-needed",
] as const;
export type EndoCoordinatorRecommendationKindV1 = (typeof ENDO_COORDINATOR_RECOMMENDATION_KINDS_V1)[number];

export const ENDO_COORDINATOR_RATIONALE_CODES_V1 = [
	"failing-check-at-head",
	"review-contradicts-failing-check",
	"review-lacks-passing-check",
	"unplanned-pass-incomplete-verification",
	"historical-failure-not-current",
	"verification-not-current-or-incomplete",
	"task-blocked",
	"liveness-hazard-unverified",
	"active-assignment-present",
	"unassigned-open-task",
	"open-task-in-scope",
	"worktree-write-conflict",
	"dependency-unsatisfied",
	"advisory-review-flagged-issues",
	"advisory-review-present",
	"store-sources-incomplete",
	"coordination-unavailable-or-truncated",
	"no-actionable-issues-observed",
] as const;
export type EndoCoordinatorRationaleCodeV1 = (typeof ENDO_COORDINATOR_RATIONALE_CODES_V1)[number];

export const ENDO_COORDINATOR_RECOMMENDATION_PRIORITIES_V1 = ["high", "medium", "low"] as const;
export type EndoCoordinatorRecommendationPriorityV1 = (typeof ENDO_COORDINATOR_RECOMMENDATION_PRIORITIES_V1)[number];

export interface EndoCoordinatorClaimV1 {
	readonly subjectKind: EndoCoordinatorSubjectKindV1;
	readonly subjectId: string;
	readonly predicate: EndoCoordinatorClaimPredicateV1;
	readonly value: string;
	readonly evidenceRef: string;
}

export interface EndoCoordinatorUncertaintyV1 {
	readonly subjectKind: EndoCoordinatorSubjectKindV1;
	readonly subjectId: string;
	readonly code: EndoCoordinatorUncertaintyCodeV1;
	readonly evidenceRef: string;
}

export interface EndoCoordinatorRecommendationV1 {
	readonly kind: EndoCoordinatorRecommendationKindV1;
	readonly subjectKind: EndoCoordinatorSubjectKindV1;
	readonly subjectId: string;
	readonly supportingRefs: readonly string[];
	readonly priority: EndoCoordinatorRecommendationPriorityV1;
	readonly rationaleCode: EndoCoordinatorRationaleCodeV1;
}

export interface EndoCoordinatorGroundedProposalV1 {
	readonly kind: EndoAdvisoryProposalKindV0;
	readonly taskId: string;
	readonly evidenceRef: string;
}

export interface EndoCoordinatorGroundedBriefV1 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1;
	readonly claims: readonly EndoCoordinatorClaimV1[];
	readonly uncertainties: readonly EndoCoordinatorUncertaintyV1[];
	readonly recommendations: readonly EndoCoordinatorRecommendationV1[];
	readonly proposal: EndoCoordinatorGroundedProposalV1 | null;
}

export interface EndoCoordinatorGroundedBriefSummaryV1 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1;
	readonly modelViewSchemaVersion: typeof ENDO_COORDINATOR_MODEL_VIEW_SCHEMA_V1;
	readonly visibilityMode: EndoCoordinatorVisibilityModeV1;
	readonly verifiedClaimCount: number;
	readonly uncertaintyCount: number;
	readonly recommendationCount: number;
	readonly claims: readonly EndoCoordinatorClaimV1[];
	readonly uncertainties: readonly EndoCoordinatorUncertaintyV1[];
	readonly recommendations: readonly EndoCoordinatorRecommendationV1[];
	readonly proposal: EndoCoordinatorGroundedProposalV1 | null;
}

// ---- Bounded model-visible snapshot (v1) ------------------------------------------------------------------------------------------

export interface EndoCoordinatorModelStatusTaskV1 {
	readonly evidenceRef: string;
	readonly taskId: string;
	readonly title?: string;
	readonly phase: string;
	readonly verification: {
		readonly state: string;
		readonly freshness: string;
		readonly incomplete: boolean;
		readonly results: readonly { readonly outcome: string; readonly relation: string | null }[];
		readonly moreResults: number;
	};
	readonly gaps: readonly string[];
	readonly association: string;
	readonly linkedSessions: number;
}

export interface EndoCoordinatorModelStatusSessionV1 {
	readonly evidenceRef: string;
	readonly sessionRef: string;
	readonly observation: string;
	readonly recordedState: string;
	readonly stateBasis: string;
	readonly freshness: string;
	readonly lastEventAgeMs: number | null;
	readonly linkedTasks: readonly string[];
	readonly lastRun: null | { readonly outcome: string; readonly basis: string };
}

export interface EndoCoordinatorModelCoordinationAssignmentV1 {
	readonly evidenceRef: string;
	readonly assignmentId: string;
	readonly taskId: string;
	readonly state: string;
	readonly revision: number;
	readonly participantId: string;
	readonly role: string;
	readonly intendedHarnessFamily: string | null;
	readonly taskBinding: string;
	readonly hazard: string;
	readonly session: null | {
		readonly standing: "operator-declared";
		readonly liveness: "unknown";
		readonly livenessState: string | null;
		readonly terminationConfirmed: false;
		readonly instanceStatus: string | null;
	};
	readonly workspace: {
		readonly registration: string;
		readonly accessIntent: string;
		readonly sharedWorktreeAcknowledged: boolean;
	};
	readonly targetCandidate: null | {
		readonly taskId: string;
		readonly candidateId: string;
		readonly relation: string;
	};
	readonly attemptCount: number;
	readonly findings: readonly string[];
}

export interface EndoCoordinatorModelCoordinationDependencyV1 {
	readonly evidenceRef: string;
	readonly dependencyId: string;
	readonly dependentTaskId: string;
	readonly prerequisiteTaskId: string;
	readonly condition: string;
	readonly satisfaction: string;
	readonly candidateId: string | null;
	readonly reasons: readonly string[];
	readonly warnings: readonly string[];
}

export interface EndoCoordinatorModelCoordinationCandidateV1 {
	readonly evidenceRef: string;
	readonly taskId: string;
	readonly candidateId: string;
	readonly kind: string;
	readonly relation: string;
	readonly identity: string;
	readonly workspace: string;
	readonly receipts: string;
}

export interface EndoCoordinatorModelCoordinationWorktreeV1 {
	readonly evidenceRef: string;
	readonly worktreeId: string;
	readonly observation: string;
	readonly clean: boolean | null;
}

export interface EndoCoordinatorModelCoordinationConflictV1 {
	readonly evidenceRef: string;
	readonly conflictRef: string;
	readonly kind: string;
	readonly assignmentIds: readonly string[];
}

export interface EndoCoordinatorModelCoordinationReviewV1 {
	readonly evidenceRef: string;
	readonly reviewId: string;
	readonly candidateTaskId: string;
	readonly candidateId: string;
	readonly candidateRelation: string;
	readonly standing: "advisory-agent-review";
	readonly basis: "agent-reported";
	readonly verdict: string;
	readonly findingCounts: {
		readonly critical: number;
		readonly high: number;
		readonly medium: number;
		readonly low: number;
		readonly info: number;
	};
	readonly checkoutStanding: string;
	readonly checkoutCleanAtCandidate: boolean;
	readonly agentClaimedChecksPresent: boolean;
	readonly assignmentId: string | null;
}

export interface EndoCoordinatorModelCoordinationViewV1 {
	readonly evidenceRef: "ev:coordination";
	readonly sourceState: "absent" | "ready" | "unreadable";
	readonly completeness: "complete" | "partial" | "unavailable";
	readonly truncated: boolean;
	readonly omitted: {
		readonly assignments: number;
		readonly dependencies: number;
		readonly candidates: number;
		readonly worktrees: number;
		readonly conflicts: number;
		readonly reviews: number;
	};
	readonly gaps: readonly string[];
	readonly assignments: readonly EndoCoordinatorModelCoordinationAssignmentV1[];
	readonly dependencies: readonly EndoCoordinatorModelCoordinationDependencyV1[];
	readonly candidates: readonly EndoCoordinatorModelCoordinationCandidateV1[];
	readonly worktrees: readonly EndoCoordinatorModelCoordinationWorktreeV1[];
	readonly conflicts: readonly EndoCoordinatorModelCoordinationConflictV1[];
	readonly reviews: readonly EndoCoordinatorModelCoordinationReviewV1[];
}

export interface EndoCoordinatorProposalEligibilityV1 {
	readonly taskId: string;
	readonly eligibleKinds: readonly EndoAdvisoryProposalKindV0[];
}

export interface EndoCoordinatorModelViewV1 {
	readonly schemaVersion: typeof ENDO_COORDINATOR_MODEL_VIEW_SCHEMA_V1;
	readonly visibilityMode: EndoCoordinatorVisibilityModeV1;
	readonly readAtMs: number;
	readonly projectId: string;
	readonly sources: {
		readonly evidenceRef: "ev:sources";
		readonly tasks: { readonly state: string; readonly freshness: string };
		readonly attempts: { readonly state: string; readonly freshness: string };
		readonly events: { readonly state: string; readonly freshness: string };
	};
	readonly project: {
		readonly evidenceRef: "ev:project";
		readonly projectId: string;
		readonly freshness: string;
		readonly head: "clean" | "uncommitted-changes" | "not-observed";
		readonly counts: Readonly<Record<string, number>>;
		readonly tasks: readonly EndoCoordinatorModelStatusTaskV1[];
	};
	readonly sessions: readonly EndoCoordinatorModelStatusSessionV1[];
	readonly attention: readonly { readonly kind: string; readonly taskId: string | null }[];
	readonly findings: readonly { readonly code: string; readonly severity: string }[];
	readonly coordination: EndoCoordinatorModelCoordinationViewV1 | null;
	readonly proposalEligibility: readonly EndoCoordinatorProposalEligibilityV1[];
}

// ---- Strict parser & closed schema validator --------------------------------------------------------------------------------------

const L = ENDO_COORDINATOR_GROUNDING_LIMITS_V1;
const EVIDENCE_REF_PATTERN = /^ev:[a-z]+(?::[a-zA-Z0-9._-]{1,96})?$/;
const VALUE_PATTERN = /^[a-zA-Z0-9._:/-]{1,96}$/;
const SESSION_REF_PATTERN = /^session:[0-9]{1,4}$/;
const CONFLICT_REF_PATTERN = /^conflict:[0-9]{1,4}$/;

function fail(detail: string): never {
	throw new EndoInvalidRecordV0(endoBoundedDetailV0(detail));
}

/** Reject duplicate keys at any depth in a parsed JSON string (exact parity with M1 pool parser). */
export function hasDuplicateJsonKeysV1(text: string): boolean {
	const stack: (Set<string> | null)[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			const keys = stack.at(-1);
			if (keys) {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k] as string)) k++;
				if (text[k] === ":") {
					const key = JSON.parse(text.slice(i, j + 1)) as string;
					if (keys.has(key)) return true;
					keys.add(key);
				}
			}
			i = j;
		} else if (ch === "{") stack.push(new Set());
		else if (ch === "[") stack.push(null);
		else if (ch === "}" || ch === "]") stack.pop();
	}
	return false;
}

function closed(value: unknown, keys: readonly string[], at: string): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) fail(`${at} must be a JSON object`);
	const record = value as Record<string, unknown>;
	const unknown = endoFirstUnknownKeyV0(record, keys);
	if (unknown !== undefined) fail(`${at} has unknown field ${JSON.stringify(String(unknown))}`);
	for (const k of keys) if (!Object.hasOwn(record, k)) fail(`${at}.${k} is required`);
	return record;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], at: string): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`${at} is not a known value`);
	return value as T;
}

function checkSubjectId(kind: EndoCoordinatorSubjectKindV1, id: unknown, at: string): string {
	if (typeof id !== "string") fail(`${at} must be a string`);
	switch (kind) {
		case "project":
		case "sources":
		case "coordination":
			if (!ENDO_PROJECT_ID_PATTERN_V0.test(id)) fail(`${at} must be a project id`);
			return id;
		case "task":
			if (!ENDO_TASK_ID_PATTERN_V0.test(id)) fail(`${at} must be a task id`);
			return id;
		case "session":
			if (!SESSION_REF_PATTERN.test(id)) fail(`${at} must be a session ref`);
			return id;
		case "assignment":
			if (!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(id)) fail(`${at} must be an assignment id`);
			return id;
		case "dependency":
			if (!ENDO_DEPENDENCY_ID_PATTERN_V0.test(id)) fail(`${at} must be a dependency id`);
			return id;
		case "candidate":
			if (!ENDO_CANDIDATE_ID_PATTERN_V0.test(id)) fail(`${at} must be a candidate id`);
			return id;
		case "worktree":
			if (!ENDO_WORKTREE_ID_PATTERN_V0.test(id)) fail(`${at} must be a worktree id`);
			return id;
		case "conflict":
			if (!CONFLICT_REF_PATTERN.test(id)) fail(`${at} must be a conflict ref`);
			return id;
		case "review":
			if (!ENDO_REVIEW_ID_PATTERN_V0.test(id)) fail(`${at} must be a review id`);
			return id;
	}
}

export function validateEndoCoordinatorGroundedBriefV1(value: unknown): EndoCoordinatorGroundedBriefV1 {
	const r = closed(
		value,
		["schemaVersion", "claims", "uncertainties", "recommendations", "proposal"],
		"groundedBrief",
	);
	if (r.schemaVersion !== ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1) fail("groundedBrief.schemaVersion mismatch");
	if (!Array.isArray(r.claims) || r.claims.length < L.minClaims || r.claims.length > L.maxClaims)
		fail(`groundedBrief.claims must have ${L.minClaims}..${L.maxClaims} entries`);
	const seenClaims = new Set<string>();
	const claims: EndoCoordinatorClaimV1[] = r.claims.map((entry, i) => {
		const c = closed(entry, ["subjectKind", "subjectId", "predicate", "value", "evidenceRef"], `claims[${i}]`);
		const subjectKind = oneOf(c.subjectKind, ENDO_COORDINATOR_SUBJECT_KINDS_V1, `claims[${i}].subjectKind`);
		const subjectId = checkSubjectId(subjectKind, c.subjectId, `claims[${i}].subjectId`);
		const predicate = oneOf(c.predicate, ENDO_COORDINATOR_CLAIM_PREDICATES_V1, `claims[${i}].predicate`);
		if (typeof c.value !== "string" || !VALUE_PATTERN.test(c.value)) fail(`claims[${i}].value is invalid`);
		if (typeof c.evidenceRef !== "string" || !EVIDENCE_REF_PATTERN.test(c.evidenceRef))
			fail(`claims[${i}].evidenceRef is invalid`);
		const key = `${subjectKind}|${subjectId}|${predicate}|${c.value}|${c.evidenceRef}`;
		if (seenClaims.has(key)) fail(`claims[${i}] duplicates an earlier claim`);
		seenClaims.add(key);
		return Object.freeze({ subjectKind, subjectId, predicate, value: c.value, evidenceRef: c.evidenceRef });
	});

	if (!Array.isArray(r.uncertainties) || r.uncertainties.length > L.maxUncertainties)
		fail(`groundedBrief.uncertainties exceeds limit of ${L.maxUncertainties}`);
	const seenUncertainties = new Set<string>();
	const uncertainties: EndoCoordinatorUncertaintyV1[] = r.uncertainties.map((entry, i) => {
		const u = closed(entry, ["subjectKind", "subjectId", "code", "evidenceRef"], `uncertainties[${i}]`);
		const subjectKind = oneOf(u.subjectKind, ENDO_COORDINATOR_SUBJECT_KINDS_V1, `uncertainties[${i}].subjectKind`);
		const subjectId = checkSubjectId(subjectKind, u.subjectId, `uncertainties[${i}].subjectId`);
		const code = oneOf(u.code, ENDO_COORDINATOR_UNCERTAINTY_CODES_V1, `uncertainties[${i}].code`);
		if (typeof u.evidenceRef !== "string" || !EVIDENCE_REF_PATTERN.test(u.evidenceRef))
			fail(`uncertainties[${i}].evidenceRef is invalid`);
		const key = `${subjectKind}|${subjectId}|${code}|${u.evidenceRef}`;
		if (seenUncertainties.has(key)) fail(`uncertainties[${i}] duplicates an earlier uncertainty`);
		seenUncertainties.add(key);
		return Object.freeze({ subjectKind, subjectId, code, evidenceRef: u.evidenceRef });
	});

	if (!Array.isArray(r.recommendations) || r.recommendations.length > L.maxRecommendations)
		fail(`groundedBrief.recommendations exceeds limit of ${L.maxRecommendations}`);
	const seenRecs = new Set<string>();
	const recommendations: EndoCoordinatorRecommendationV1[] = r.recommendations.map((entry, i) => {
		const rec = closed(
			entry,
			["kind", "subjectKind", "subjectId", "supportingRefs", "priority", "rationaleCode"],
			`recommendations[${i}]`,
		);
		const kind = oneOf(rec.kind, ENDO_COORDINATOR_RECOMMENDATION_KINDS_V1, `recommendations[${i}].kind`);
		const subjectKind = oneOf(
			rec.subjectKind,
			ENDO_COORDINATOR_SUBJECT_KINDS_V1,
			`recommendations[${i}].subjectKind`,
		);
		const subjectId = checkSubjectId(subjectKind, rec.subjectId, `recommendations[${i}].subjectId`);
		if (
			!Array.isArray(rec.supportingRefs) ||
			rec.supportingRefs.length < 1 ||
			rec.supportingRefs.length > L.maxSupportingRefs
		)
			fail(`recommendations[${i}].supportingRefs must have 1..${L.maxSupportingRefs} entries`);
		const seenRefs = new Set<string>();
		const supportingRefs = rec.supportingRefs.map((ref, j) => {
			if (typeof ref !== "string" || !EVIDENCE_REF_PATTERN.test(ref))
				fail(`recommendations[${i}].supportingRefs[${j}] is invalid`);
			if (seenRefs.has(ref)) fail(`recommendations[${i}].supportingRefs[${j}] duplicates an earlier ref`);
			seenRefs.add(ref);
			return ref;
		});
		const priority = oneOf(
			rec.priority,
			ENDO_COORDINATOR_RECOMMENDATION_PRIORITIES_V1,
			`recommendations[${i}].priority`,
		);
		const rationaleCode = oneOf(
			rec.rationaleCode,
			ENDO_COORDINATOR_RATIONALE_CODES_V1,
			`recommendations[${i}].rationaleCode`,
		);
		const recKey = `${kind}|${subjectKind}|${subjectId}|${rationaleCode}`;
		if (seenRecs.has(recKey)) fail(`recommendations[${i}] duplicates an earlier recommendation`);
		seenRecs.add(recKey);
		return Object.freeze({
			kind,
			subjectKind,
			subjectId,
			supportingRefs: Object.freeze(supportingRefs),
			priority,
			rationaleCode,
		});
	});

	let proposal: EndoCoordinatorGroundedProposalV1 | null = null;
	if (r.proposal !== null) {
		const p = closed(r.proposal, ["kind", "taskId", "evidenceRef"], "groundedBrief.proposal");
		const kind = oneOf(p.kind, ENDO_ADVISORY_PROPOSAL_KINDS_V0, "proposal.kind");
		const taskId = checkSubjectId("task", p.taskId, "proposal.taskId");
		if (typeof p.evidenceRef !== "string" || !EVIDENCE_REF_PATTERN.test(p.evidenceRef))
			fail("proposal.evidenceRef is invalid");
		proposal = Object.freeze({ kind, taskId, evidenceRef: p.evidenceRef });
	}

	return Object.freeze({
		schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
		claims: Object.freeze(claims),
		uncertainties: Object.freeze(uncertainties),
		recommendations: Object.freeze(recommendations),
		proposal,
	});
}

/**
 * Parse a model's grounded-v1 response text strictly.
 * Accepts ONLY a single JSON document (optionally wrapped in a single ```json ... ``` fence with zero
 * surrounding prose). Rejects oversized payloads, duplicate keys at any depth, and any schema violation.
 */
export function parseEndoCoordinatorGroundedBriefJsonV1(rawText: string): EndoCoordinatorGroundedBriefV1 {
	if (typeof rawText !== "string") fail("response must be a string");
	const trimmed = rawText.trim();
	if (trimmed.length === 0) fail("response is empty");
	if (new TextEncoder().encode(trimmed).byteLength > L.maxResponseBytes)
		fail(`response exceeds ${L.maxResponseBytes} byte bound`);
	let jsonText = trimmed;
	if (trimmed.startsWith("```")) {
		const fence = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
		if (fence === null) fail("malformed fenced JSON response");
		jsonText = (fence[1] as string).trim();
	}
	if (!jsonText.startsWith("{") || !jsonText.endsWith("}")) fail("response must be a single JSON object");
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		fail("response is not valid JSON");
	}
	if (hasDuplicateJsonKeysV1(jsonText)) fail("response repeats a JSON key");
	return validateEndoCoordinatorGroundedBriefV1(parsed);
}
