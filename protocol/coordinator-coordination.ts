// The read-only Coordinator coordination projection (`endo.coordinator-coordination.v0`): a COMPANION to `endo.coordinator-status.v0`,
// which is unchanged. It interprets `develop/coordination.json` (protocol/develop-coordination.ts) against the task file, the attempt
// records and the verification receipts, at read time, for the projects in scope. It is never persisted and grants nothing.
//
// Honesty rules the shape encodes:
// - Liveness is never observed here: a recorded session association always reads `liveness: "unknown"`.
// - Readiness is not permission: `authority.readinessIsPermission` and `authority.assignmentIsAuthorization` are the constant false.
// - Files are read one at a time: `basis.consistency` is the constant `per-file-snapshot` (no transaction spans tasks.json and
//   coordination.json), and a reference that does not resolve is reported, never repaired.
// - A candidate's historical evidence, its relation to the current selection, and the live workspace are separate fields.

import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import {
	ENDO_ACCESS_INTENTS_V0,
	ENDO_ASSIGNMENT_ID_PATTERN_V0,
	ENDO_ASSIGNMENT_STATES_V0,
	ENDO_CANDIDATE_ID_PATTERN_V0,
	ENDO_COORDINATION_SESSION_SOURCES_V0,
	ENDO_DEPENDENCY_CONDITIONS_V0,
	ENDO_DEPENDENCY_ID_PATTERN_V0,
	ENDO_HARNESS_FAMILIES_V0,
	ENDO_PARTICIPANT_ID_PATTERN_V0,
	ENDO_PARTICIPANT_ROLES_V0,
	ENDO_WORKSPACE_REGISTRATIONS_V0,
	type EndoAccessIntentV0,
	type EndoAssignmentStateV0,
	type EndoCoordinationSessionSourceV0,
	type EndoDependencyConditionV0,
	type EndoIntendedHarnessFamilyV0,
	type EndoParticipantRoleV0,
	type EndoWorkspaceRegistrationV0,
	isEndoCanonicalPathV0,
} from "./develop-coordination.ts";
import { ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_COORDINATOR_COORDINATION_SCHEMA_V0 = "endo.coordinator-coordination.v0";

export const ENDO_COORDINATION_ASSIGNMENT_FINDINGS_V0 = [
	"assignment-task-missing",
	"assignment-task-stale",
	"target-candidate-superseded",
	"target-candidate-missing",
	"session-liveness-unknown",
	"session-instance-undeclared",
	"attempt-link-unresolved",
	"attempt-execution-recorded",
	"attempt-evidence-unknown",
	"prerequisites-not-satisfied",
	"prerequisites-unknown",
	"worktree-liveness-unverified",
	"worktree-not-registered",
	"ended-without-process-confirmation",
] as const;
export type EndoCoordinationAssignmentFindingV0 = (typeof ENDO_COORDINATION_ASSIGNMENT_FINDINGS_V0)[number];

export const ENDO_COORDINATION_DEPENDENCY_REASONS_V0 = [
	"tasks-unreadable",
	"prerequisite-missing",
	"dependent-missing",
	"prerequisite-not-done",
	"no-current-candidate",
	"candidate-identity-failed",
	"candidate-identity-unavailable",
	"protected-candidate-has-no-host-receipt",
	"receipt-read-incomplete",
	"no-receipt-for-candidate",
	"failing-receipt-for-candidate",
	"inconclusive-receipt-for-candidate",
	"planned-check-not-passed",
	"no-operator-decision",
	"operator-decision-stale",
] as const;
export type EndoCoordinationDependencyReasonV0 = (typeof ENDO_COORDINATION_DEPENDENCY_REASONS_V0)[number];

export const ENDO_COORDINATION_DEPENDENCY_WARNINGS_V0 = [
	"workspace-drifted-from-candidate",
	"workspace-unobserved",
	"prerequisite-changed-since-declared",
	"dependent-changed-since-declared",
] as const;
export type EndoCoordinationDependencyWarningV0 = (typeof ENDO_COORDINATION_DEPENDENCY_WARNINGS_V0)[number];

export const ENDO_COORDINATION_DISCLOSURES_V0 = [
	"receipt-history-unverifiable",
	"readiness-confers-no-authority",
] as const;
export type EndoCoordinationDisclosureV0 = (typeof ENDO_COORDINATION_DISCLOSURES_V0)[number];

export const ENDO_COORDINATION_CONFLICTS_V0 = [
	"shared-writable-worktree-acknowledged",
	"unacknowledged-worktree-write-overlap",
	"shared-mutable-worktree",
	"worktree-liveness-unverified",
	"path-hint-overlap",
] as const;
export type EndoCoordinationConflictKindV0 = (typeof ENDO_COORDINATION_CONFLICTS_V0)[number];

export const ENDO_COORDINATION_GAPS_V0 = [
	"coordination-unreadable",
	"tasks-unreadable",
	"attempts-unreadable",
	"attempt-problems",
	"receipts-truncated",
	"git-unavailable",
	"protected-runs-unavailable",
	"unknown-project",
] as const;
export type EndoCoordinationGapV0 = (typeof ENDO_COORDINATION_GAPS_V0)[number];

export const ENDO_COORDINATION_SATISFACTIONS_V0 = ["satisfied", "unsatisfied", "unknown"] as const;
export type EndoCoordinationSatisfactionV0 = (typeof ENDO_COORDINATION_SATISFACTIONS_V0)[number];
export const ENDO_COORDINATION_READINESS_V0 = [
	"no-dependencies",
	"ready",
	"ready-for-pinned-candidate",
	"waiting",
	"unknown",
] as const;
export type EndoCoordinationReadinessV0 = (typeof ENDO_COORDINATION_READINESS_V0)[number];
export const ENDO_CANDIDATE_IDENTITY_READINGS_V0 = [
	"verified",
	"mismatch",
	"established",
	"not-established",
	"unavailable",
] as const;
export type EndoCandidateIdentityReadingV0 = (typeof ENDO_CANDIDATE_IDENTITY_READINGS_V0)[number];
export const ENDO_CANDIDATE_WORKSPACE_READINGS_V0 = [
	"matches-candidate",
	"dirty-at-candidate",
	"moved-from-candidate",
	"other-repository",
	"unavailable",
	"not-applicable",
] as const;
export type EndoCandidateWorkspaceReadingV0 = (typeof ENDO_CANDIDATE_WORKSPACE_READINGS_V0)[number];
export const ENDO_CANDIDATE_RECEIPT_READINGS_V0 = [
	"passing",
	"failing",
	"inconclusive",
	"none",
	"unknown",
	"not-applicable",
] as const;
export type EndoCandidateReceiptReadingV0 = (typeof ENDO_CANDIDATE_RECEIPT_READINGS_V0)[number];
export const ENDO_ATTEMPT_LINK_READINGS_V0 = ["resolved", "missing", "other-task", "unknown"] as const;
export const ENDO_ATTEMPT_EXECUTION_READINGS_V0 = [
	"workbench-authorized",
	"route-claimed",
	"none-recorded",
	"unknown",
] as const;

export interface EndoCoordinationAssignmentViewV0 {
	assignmentId: string;
	taskId: string;
	state: EndoAssignmentStateV0;
	revision: number;
	participantId: string;
	role: EndoParticipantRoleV0;
	intendedHarnessFamily: EndoIntendedHarnessFamilyV0 | null;
	taskBinding: "current" | "task-stale" | "task-missing" | "unknown";
	session: null | {
		source: EndoCoordinationSessionSourceV0;
		sessionKey: string;
		standing: "operator-declared";
		liveness: "unknown";
	};
	workspace: {
		worktreePath: string;
		registration: EndoWorkspaceRegistrationV0;
		accessIntent: EndoAccessIntentV0;
		sharedWorktreeAcknowledged: boolean;
	};
	hazard: "none" | "liveness-unverified" | "operator-cleared";
	targetCandidate: null | {
		taskId: string;
		candidateId: string;
		relation: "current-candidate" | "superseded-candidate" | "candidate-missing";
	};
	attempts: {
		attemptId: string;
		link: (typeof ENDO_ATTEMPT_LINK_READINGS_V0)[number];
		execution: (typeof ENDO_ATTEMPT_EXECUTION_READINGS_V0)[number];
	}[];
	findings: EndoCoordinationAssignmentFindingV0[];
}

export interface EndoCoordinationDependencyViewV0 {
	dependencyId: string;
	dependentTaskId: string;
	prerequisiteTaskId: string;
	condition: EndoDependencyConditionV0;
	satisfaction: EndoCoordinationSatisfactionV0;
	/** The candidate the condition was evaluated against (the prerequisite's CURRENT candidate), or null. */
	candidateId: string | null;
	reasons: EndoCoordinationDependencyReasonV0[];
	warnings: EndoCoordinationDependencyWarningV0[];
	disclosures: EndoCoordinationDisclosureV0[];
}

export interface EndoCoordinationCandidateViewV0 {
	candidateId: string;
	kind: "git-commit" | "protected-candidate";
	relation: "current" | "superseded" | "not-selected";
	identity: EndoCandidateIdentityReadingV0;
	workspace: EndoCandidateWorkspaceReadingV0;
	/** The candidate-bound receipt reading for THIS candidate: historical evidence about it, whatever is current now. */
	receipts: EndoCandidateReceiptReadingV0;
}

export interface EndoCoordinationTaskViewV0 {
	taskId: string;
	readiness: EndoCoordinationReadinessV0;
	currentCandidateId: string | null;
	candidates: EndoCoordinationCandidateViewV0[];
}

export interface EndoCoordinationConflictViewV0 {
	kind: EndoCoordinationConflictKindV0;
	worktreePath: string;
	assignmentIds: string[];
}

export interface EndoCoordinationProjectViewV0 {
	id: string;
	assignments: EndoCoordinationAssignmentViewV0[];
	dependencies: EndoCoordinationDependencyViewV0[];
	tasks: EndoCoordinationTaskViewV0[];
	conflicts: EndoCoordinationConflictViewV0[];
}

export interface EndoCoordinatorCoordinationV0 {
	schemaVersion: typeof ENDO_COORDINATOR_COORDINATION_SCHEMA_V0;
	readAtMs: number;
	authority: {
		kind: "read-only-projection";
		grants: "none";
		writes: "none";
		decisionAuthority: "operator-only";
		assignmentIsAuthorization: false;
		readinessIsPermission: false;
	};
	basis: { liveness: "not-observed"; consistency: "per-file-snapshot"; attribution: "unsigned-local-record" };
	scope: { requested: string[] | null };
	/** `absent`: no coordination.json yet (a pre-E1 store): not an error, and nothing is assigned, declared or depended on. */
	source: { state: "absent" | "ready" | "unreadable"; reason: string | null; revision: number | null };
	projects: EndoCoordinationProjectViewV0[];
	gaps: EndoCoordinationGapV0[];
}

export const ENDO_COORDINATION_PROJECTION_AUTHORITY_V0 = Object.freeze({
	kind: "read-only-projection" as const,
	grants: "none" as const,
	writes: "none" as const,
	decisionAuthority: "operator-only" as const,
	assignmentIsAuthorization: false as const,
	readinessIsPermission: false as const,
});

// ---- the validator (for the host reading a sandboxed worker's output) --------------------------------------------------------------

const MAX_ITEMS = 4096;
const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const closed = (v: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
};
const list = (v: unknown, what: string): unknown[] =>
	Array.isArray(v) && v.length <= MAX_ITEMS ? v : bad(`${what} is not a bounded list`);
const oneOf = (v: unknown, values: readonly (string | boolean | null)[], what: string): void => {
	if (!values.includes(v as string)) bad(`${what} is not a known value`);
};
const codes = (v: unknown, values: readonly string[], what: string): void => {
	const items = list(v, what);
	for (const item of items) oneOf(item, values, what);
	if (new Set(items).size !== items.length) bad(`${what} repeats`);
};
const match = (v: unknown, pattern: RegExp, what: string): void => {
	if (typeof v !== "string" || !pattern.test(v)) bad(`${what} is not well-formed`);
};
const count = (v: unknown, what: string): void => {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad(`${what} is not a count`);
};
const nullableMatch = (v: unknown, pattern: RegExp, what: string): void => {
	if (v !== null) match(v, pattern, what);
};

/** Strict, closed validation of a projection (the same rule a sandboxed worker's output is held to). Throws EndoInvalidRecordV0. */
export function validateEndoCoordinatorCoordinationV0(value: unknown): EndoCoordinatorCoordinationV0 {
	const r = closed(
		value,
		["schemaVersion", "readAtMs", "authority", "basis", "scope", "source", "projects", "gaps"],
		"projection",
	);
	if (r.schemaVersion !== ENDO_COORDINATOR_COORDINATION_SCHEMA_V0) bad("not a coordination projection");
	count(r.readAtMs, "readAtMs");
	const a = closed(
		r.authority,
		["kind", "grants", "writes", "decisionAuthority", "assignmentIsAuthorization", "readinessIsPermission"],
		"authority",
	);
	for (const [k, v] of Object.entries(ENDO_COORDINATION_PROJECTION_AUTHORITY_V0))
		if (a[k] !== v) bad("authority is not read-only");
	const b = closed(r.basis, ["liveness", "consistency", "attribution"], "basis");
	if (
		b.liveness !== "not-observed" ||
		b.consistency !== "per-file-snapshot" ||
		b.attribution !== "unsigned-local-record"
	)
		bad("basis overclaims");
	const s = closed(r.scope, ["requested"], "scope");
	if (s.requested !== null) for (const p of list(s.requested, "scope")) match(p, ENDO_PROJECT_ID_PATTERN_V0, "scope");
	const src = closed(r.source, ["state", "reason", "revision"], "source");
	oneOf(src.state, ["absent", "ready", "unreadable"], "source.state");
	if (src.reason !== null && (typeof src.reason !== "string" || !/^[a-z-]{1,40}$/.test(src.reason)))
		bad("source.reason");
	if (src.revision !== null) count(src.revision, "source.revision");
	codes(r.gaps, ENDO_COORDINATION_GAPS_V0, "gaps");
	const projects = list(r.projects, "projects");
	const seen = new Set<string>();
	for (const pv of projects) {
		const p = closed(pv, ["id", "assignments", "dependencies", "tasks", "conflicts"], "project");
		match(p.id, ENDO_PROJECT_ID_PATTERN_V0, "project.id");
		if (seen.has(p.id as string)) bad("a project repeats");
		seen.add(p.id as string);
		for (const x of list(p.assignments, "assignments")) {
			const v = closed(
				x,
				[
					"assignmentId",
					"taskId",
					"state",
					"revision",
					"participantId",
					"role",
					"intendedHarnessFamily",
					"taskBinding",
					"session",
					"workspace",
					"hazard",
					"targetCandidate",
					"attempts",
					"findings",
				],
				"assignment",
			);
			match(v.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, "assignmentId");
			match(v.taskId, ENDO_TASK_ID_PATTERN_V0, "taskId");
			oneOf(v.state, ENDO_ASSIGNMENT_STATES_V0, "state");
			count(v.revision, "revision");
			match(v.participantId, ENDO_PARTICIPANT_ID_PATTERN_V0, "participantId");
			oneOf(v.role, ENDO_PARTICIPANT_ROLES_V0, "role");
			oneOf(v.intendedHarnessFamily, [...ENDO_HARNESS_FAMILIES_V0, null], "intendedHarnessFamily");
			oneOf(v.taskBinding, ["current", "task-stale", "task-missing", "unknown"], "taskBinding");
			if (v.session !== null) {
				const ss = closed(v.session, ["source", "sessionKey", "standing", "liveness"], "session");
				oneOf(ss.source, ENDO_COORDINATION_SESSION_SOURCES_V0, "session.source");
				if (typeof ss.sessionKey !== "string" || ss.sessionKey.length > 256) bad("session.sessionKey");
				if (ss.standing !== "operator-declared" || ss.liveness !== "unknown") bad("session overclaims");
			}
			const w = closed(
				v.workspace,
				["worktreePath", "registration", "accessIntent", "sharedWorktreeAcknowledged"],
				"workspace",
			);
			if (!isEndoCanonicalPathV0(w.worktreePath)) bad("workspace.worktreePath");
			oneOf(w.registration, ENDO_WORKSPACE_REGISTRATIONS_V0, "workspace.registration");
			oneOf(w.accessIntent, ENDO_ACCESS_INTENTS_V0, "workspace.accessIntent");
			oneOf(w.sharedWorktreeAcknowledged, [true, false], "workspace.sharedWorktreeAcknowledged");
			oneOf(v.hazard, ["none", "liveness-unverified", "operator-cleared"], "hazard");
			if (v.targetCandidate !== null) {
				const t = closed(v.targetCandidate, ["taskId", "candidateId", "relation"], "targetCandidate");
				match(t.taskId, ENDO_TASK_ID_PATTERN_V0, "targetCandidate.taskId");
				match(t.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "targetCandidate.candidateId");
				oneOf(
					t.relation,
					["current-candidate", "superseded-candidate", "candidate-missing"],
					"targetCandidate.relation",
				);
			}
			for (const at of list(v.attempts, "attempts")) {
				const t = closed(at, ["attemptId", "link", "execution"], "attempt");
				match(t.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId");
				oneOf(t.link, ENDO_ATTEMPT_LINK_READINGS_V0, "attempt.link");
				oneOf(t.execution, ENDO_ATTEMPT_EXECUTION_READINGS_V0, "attempt.execution");
			}
			codes(v.findings, ENDO_COORDINATION_ASSIGNMENT_FINDINGS_V0, "findings");
		}
		for (const x of list(p.dependencies, "dependencies")) {
			const d = closed(
				x,
				[
					"dependencyId",
					"dependentTaskId",
					"prerequisiteTaskId",
					"condition",
					"satisfaction",
					"candidateId",
					"reasons",
					"warnings",
					"disclosures",
				],
				"dependency",
			);
			match(d.dependencyId, ENDO_DEPENDENCY_ID_PATTERN_V0, "dependencyId");
			match(d.dependentTaskId, ENDO_TASK_ID_PATTERN_V0, "dependentTaskId");
			match(d.prerequisiteTaskId, ENDO_TASK_ID_PATTERN_V0, "prerequisiteTaskId");
			oneOf(d.condition, ENDO_DEPENDENCY_CONDITIONS_V0, "condition");
			oneOf(d.satisfaction, ENDO_COORDINATION_SATISFACTIONS_V0, "satisfaction");
			nullableMatch(d.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "candidateId");
			codes(d.reasons, ENDO_COORDINATION_DEPENDENCY_REASONS_V0, "reasons");
			codes(d.warnings, ENDO_COORDINATION_DEPENDENCY_WARNINGS_V0, "warnings");
			codes(d.disclosures, ENDO_COORDINATION_DISCLOSURES_V0, "disclosures");
			if (!(d.disclosures as string[]).includes("readiness-confers-no-authority"))
				bad("a dependency omits its disclosure");
			if (d.satisfaction === "satisfied" && (d.reasons as string[]).length > 0)
				bad("a satisfied edge carries reasons");
		}
		for (const x of list(p.tasks, "tasks")) {
			const t = closed(x, ["taskId", "readiness", "currentCandidateId", "candidates"], "task");
			match(t.taskId, ENDO_TASK_ID_PATTERN_V0, "task.taskId");
			oneOf(t.readiness, ENDO_COORDINATION_READINESS_V0, "readiness");
			nullableMatch(t.currentCandidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "currentCandidateId");
			for (const c of list(t.candidates, "candidates")) {
				const cv = closed(c, ["candidateId", "kind", "relation", "identity", "workspace", "receipts"], "candidate");
				match(cv.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "candidateId");
				oneOf(cv.kind, ["git-commit", "protected-candidate"], "candidate.kind");
				oneOf(cv.relation, ["current", "superseded", "not-selected"], "candidate.relation");
				oneOf(cv.identity, ENDO_CANDIDATE_IDENTITY_READINGS_V0, "candidate.identity");
				oneOf(cv.workspace, ENDO_CANDIDATE_WORKSPACE_READINGS_V0, "candidate.workspace");
				oneOf(cv.receipts, ENDO_CANDIDATE_RECEIPT_READINGS_V0, "candidate.receipts");
			}
		}
		for (const x of list(p.conflicts, "conflicts")) {
			const c = closed(x, ["kind", "worktreePath", "assignmentIds"], "conflict");
			oneOf(c.kind, ENDO_COORDINATION_CONFLICTS_V0, "conflict.kind");
			if (!isEndoCanonicalPathV0(c.worktreePath)) bad("conflict.worktreePath");
			for (const id of list(c.assignmentIds, "conflict.assignmentIds"))
				match(id, ENDO_ASSIGNMENT_ID_PATTERN_V0, "conflict.assignmentIds");
		}
	}
	if (s.requested !== null) {
		const requested = new Set(s.requested as string[]);
		for (const id of seen) if (!requested.has(id)) bad("a project outside the requested scope");
	}
	return value as EndoCoordinatorCoordinationV0;
}
