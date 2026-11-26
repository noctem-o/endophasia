// DEVELOP coordination metadata (`endo.develop-coordination.v0`, `<root>/develop/coordination.json`): the operator's durable statement of
// coordination INTENT (docs/designs/coordinator-assignment.md, E1; docs/designs/coordinator-assignment-implementation.md).
//
// What it records, and nothing more: which logical participant the operator intends to do a task (an assignment), which session the
// operator says is associated with that participant, which tasks depend on which and under what condition, which immutable candidates
// the operator declared for a task and which one is current, and revision-bound operator decisions that stand in for a prerequisite.
//
// What it is NOT:
// - An authorisation. An assignment confers zero execution authority; readiness confers zero execution authority. Nothing here is read
//   by any admission gate, dispatcher, approval path or harness transport in this version.
// - Evidence. Every field is operator-declared (or an explicit "unknown"). A recorded session association is the operator's statement,
//   never a controller observation of a live session; no field here can carry a controller-observed execution fact.
// - A task record. Projects and tasks stay in `develop/tasks.json`; this file references them by id and never changes them.
// - Authenticated. It is an unsigned same-uid local file: provenance fields attribute, they do not authenticate.
//
// Validation is strict and closed: unknown versions, unknown members, bad identifiers, duplicate identities, dangling references inside
// the file, contradictory states and cyclic dependency graphs are refused. Nothing is repaired or defaulted. References to tasks.json are
// NOT checked here (another file, another lock); writers check them, and readers report what no longer resolves.

import { ENDO_ADAPTER_IDENTITY_SCOPES_V0, type EndoAdapterIdentityScopeV0 } from "./develop-adapter.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import { checkEndoDevelopTextV0, ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	endoFirstUnknownKeyV0,
	readEndoVersionedV0,
} from "./versioned.ts";

export const ENDO_DEVELOP_COORDINATION_SCHEMA_V0 = "endo.develop-coordination.v0";

/** Closed bounds. The whole file is at most `maxFileBytes` on disk, checked on every read and every write. */
export const ENDO_DEVELOP_COORDINATION_LIMITS_V0 = Object.freeze({
	maxFileBytes: 4 * 1024 * 1024,
	maxAssignments: 512,
	maxDependencies: 1024,
	maxCandidateTasks: 300,
	maxCandidatesPerTask: 32,
	maxRegisteredWorktrees: 32,
	maxAttemptsPerAssignment: 32,
	maxClearanceHistoryPerAssignment: 16,
	maxPathHints: 16,
	maxPathHint: 256,
	maxPath: 1024,
	maxToken: 256,
});

export const ENDO_ASSIGNMENT_ID_PATTERN_V0 = /^endo\.assignment\.[0-9a-f]{32}$/;
export const ENDO_DEPENDENCY_ID_PATTERN_V0 = /^endo\.dep\.[0-9a-f]{32}$/;
export const ENDO_CANDIDATE_ID_PATTERN_V0 = /^endo\.candidate\.[0-9a-f]{32}$/;
export const ENDO_WORKTREE_ID_PATTERN_V0 = /^endo\.worktree\.[0-9a-f]{32}$/;
/** A logical participant: a lowercase slug the operator chose (`codex-builder`, `pi-reviewer`). Never a model name or a session id. */
export const ENDO_PARTICIPANT_ID_PATTERN_V0 = /^[a-z][a-z0-9-]{0,63}$/;
/** Git object ids: SHA-1 (40 hex) or SHA-256 (64 hex), as protocol/develop-observations.ts accepts. Never a branch or a short id. */
export const ENDO_GIT_OID_PATTERN_V0 = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[\x21-\x7e]{1,256}$/;

export const ENDO_ASSIGNMENT_STATES_V0 = ["active", "superseded", "revoked", "closed"] as const;
export type EndoAssignmentStateV0 = (typeof ENDO_ASSIGNMENT_STATES_V0)[number];
export const ENDO_PARTICIPANT_ROLES_V0 = ["builder", "reviewer", "investigator"] as const;
export type EndoParticipantRoleV0 = (typeof ENDO_PARTICIPANT_ROLES_V0)[number];
export const ENDO_HARNESS_FAMILIES_V0 = ["pi", "codex", "claude-code", "any"] as const;
export type EndoIntendedHarnessFamilyV0 = (typeof ENDO_HARNESS_FAMILIES_V0)[number];
export const ENDO_ACCESS_INTENTS_V0 = ["read-write-intended", "read-only-intended"] as const;
export type EndoAccessIntentV0 = (typeof ENDO_ACCESS_INTENTS_V0)[number];
/**
 * The production live sources a session association may name. Closed: a `test-*` (synthetic) source, or a source this version does not
 * know, is refused (`synthetic-not-admitted` / `unsupported-source`). The adapter sources in adapters/pi and adapters/codex.
 */
export const ENDO_COORDINATION_SESSION_SOURCES_V0 = ["pi-live", "codex-live"] as const;
export type EndoCoordinationSessionSourceV0 = (typeof ENDO_COORDINATION_SESSION_SOURCES_V0)[number];
/** How a workspace path relates to the project's registration: primary path, explicitly registered sibling, or unregistered same-repo. */
export const ENDO_WORKSPACE_REGISTRATIONS_V0 = [
	"project-path",
	"registered-sibling",
	"same-repository-unregistered",
] as const;
export type EndoWorkspaceRegistrationV0 = (typeof ENDO_WORKSPACE_REGISTRATIONS_V0)[number];
export const ENDO_DEPENDENCY_CONDITIONS_V0 = [
	"operator-task-done",
	"candidate-declared",
	"candidate-has-passing-receipt",
	"operator-decision",
] as const;
export type EndoDependencyConditionV0 = (typeof ENDO_DEPENDENCY_CONDITIONS_V0)[number];
/** Why a terminal transition left the worktree hazardous: what the controller could see on disk, or that it could not see. */
export const ENDO_HAZARD_BASES_V0 = [
	"attempt-authorized",
	"attempt-route-claimed",
	"attempt-evidence-unreadable",
	"writable-session-associated",
] as const;
export type EndoHazardBasisV0 = (typeof ENDO_HAZARD_BASES_V0)[number];

/** Route reservation kinds recorded on disk (`storage/develop-attempt-routes.ts`). */
export const ENDO_HAZARD_ROUTE_KINDS_V0 = ["workbench", "protected", "adapter-live"] as const;
export type EndoHazardRouteKindV0 = (typeof ENDO_HAZARD_ROUTE_KINDS_V0)[number];

/** Closed reasons why per-attempt execution evidence could not be read or verified. */
export const ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0 = [
	"unavailable",
	"missing",
	"problem",
	"unsafe-path",
	"too-large",
	"malformed",
	"invalid",
	"misnamed",
	"orphan",
	"unknown-file",
	"io",
] as const;
export type EndoHazardEvidenceUnknownReasonV0 = (typeof ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0)[number];

/** Record-kind bucket for per-attempt problem summaries so distinct unreadable/orphaned files never collapse. */
export const ENDO_HAZARD_ATTEMPT_PROBLEM_KINDS_V0 = ["prepared", "handoff", "outcome", "authorized", "other"] as const;
export type EndoHazardAttemptProblemKindV0 = (typeof ENDO_HAZARD_ATTEMPT_PROBLEM_KINDS_V0)[number];

export interface EndoHazardAttemptProblemSummaryV0 {
	kind: EndoHazardAttemptProblemKindV0;
	reason: EndoHazardEvidenceUnknownReasonV0;
	count: number;
}

// ---- records -----------------------------------------------------------------------------------------------------------------------

/**
 * The operator's statement that a session is associated with the participant. `standing` is always `operator-declared` in v0: the CLI
 * cannot observe an in-process live adapter, so nothing here is controller-observed, and nothing here establishes current liveness.
 * `instanceId` and `runtimeFingerprintId` are what the operator declared, or null when they did not (unknown, never "none").
 */
export interface EndoSessionAssociationV0 {
	standing: "operator-declared";
	source: EndoCoordinationSessionSourceV0;
	/** `<source>:<scope>:<id>` exactly as endoAdapterSessionKeyV0 builds it. Never an alias, model name, path or time. */
	sessionKey: string;
	attachmentId: string;
	instanceId: string | null;
	runtimeFingerprintId: string | null;
	declaredAtMs: number;
}

export interface EndoAssignmentWorkspaceV0 {
	/** Canonical (real) path of the worktree the participant is intended to use. Coordination metadata, not an enforced boundary. */
	worktreePath: string;
	registration: EndoWorkspaceRegistrationV0;
	accessIntent: EndoAccessIntentV0;
	/** Relative path hints for overlap WARNINGS only; never a filesystem boundary. */
	pathHints: string[];
	/** True only when the operator explicitly acknowledged sharing a worktree with another writable or hazardous assignment. */
	sharedWorktreeAcknowledged: boolean;
	/**
	 * E2: exact sorted assignmentIds whose overlap was acknowledged when `--allow-shared-worktree` was passed.
	 * Prevents an earlier boolean acknowledgement from masking a new or reactivated unacknowledged conflict.
	 */
	acknowledgedConflictIds?: string[];
}

/** Canonical session identity acknowledged by an operator hazard clearance (no timestamps). */
export interface EndoHazardSessionEvidenceV0 {
	source: EndoCoordinationSessionSourceV0;
	sessionKey: string;
	attachmentId: string;
	instanceId: string | null;
	runtimeFingerprintId: string | null;
}

/** Observed route reservation evidence for one linked attempt at clearance/evaluation time. */
export type EndoHazardRouteEvidenceV0 =
	| { state: "absent" }
	| { state: "claimed"; route: EndoHazardRouteKindV0 }
	| { state: "unknown"; reason: EndoHazardEvidenceUnknownReasonV0 };

/** Observed attempt-authorisation evidence for one linked attempt at clearance/evaluation time. */
export type EndoHazardAuthorizationEvidenceV0 =
	| { state: "absent" }
	| { state: "authorized"; proposalId: string; authorizationEventId: string }
	| { state: "adapter-authorized"; authorizationId: string; harnessFamily: "pi" | "codex"; aborted: boolean }
	| { state: "unknown"; reason: EndoHazardEvidenceUnknownReasonV0; problems: EndoHazardAttemptProblemSummaryV0[] };

export interface EndoHazardAttemptEvidenceV0 {
	attemptId: string;
	route: EndoHazardRouteEvidenceV0;
	authorization: EndoHazardAuthorizationEvidenceV0;
}

/**
 * Bounded, canonical snapshot of the exact observed execution evidence for an ended assignment.
 * Operator clearance acknowledges THIS snapshot — never an unbounded future exemption.
 */
export interface EndoHazardEvidenceSnapshotV0 {
	writableSession: EndoHazardSessionEvidenceV0 | null;
	/** Every linked attempt on the assignment, sorted lexicographically by `attemptId`. */
	attempts: EndoHazardAttemptEvidenceV0[];
}

/**
 * A preserved historical operator clearance assertion. `acknowledgedEvidence` is null ONLY when
 * archiving an earlier pre-remediation draft clearance that lacked an evidence snapshot.
 */
export interface EndoHazardPriorClearanceV0 {
	clearedBy: "operator";
	via: "cli";
	clearedAtMs: number;
	bases: EndoHazardBasisV0[];
	acknowledgedEvidence: EndoHazardEvidenceSnapshotV0 | null;
	note: string;
}

export type EndoWorktreeHazardV0 =
	| { state: "none" }
	| {
			state: "liveness-unverified";
			sinceMs: number;
			bases: EndoHazardBasisV0[];
			/** Historical operator clearances whose operational relevance expired when new/unreadable evidence appeared. */
			priorClearances?: EndoHazardPriorClearanceV0[];
	  }
	| {
			state: "operator-cleared";
			clearedBy: "operator";
			via: "cli";
			clearedAtMs: number;
			bases: EndoHazardBasisV0[];
			acknowledgedEvidence: EndoHazardEvidenceSnapshotV0;
			note: string;
			priorClearances: EndoHazardPriorClearanceV0[];
	  }
	| {
			/**
			 * Earlier pre-remediation draft v0 clearance (no `acknowledgedEvidence`): accepted read-only for compatibility,
			 * never written by new code, and evaluated conservatively whenever current hazard evidence exists.
			 */
			state: "operator-cleared";
			clearedAtMs: number;
			bases: EndoHazardBasisV0[];
			note: string;
	  };

/** Derive canonical hazard bases directly from a canonical evidence snapshot. */
export function endoHazardBasesFromSnapshotV0(snapshot: EndoHazardEvidenceSnapshotV0): EndoHazardBasisV0[] {
	const found = new Set<EndoHazardBasisV0>();
	for (const item of snapshot.attempts) {
		const abortedAdapterLive =
			item.authorization.state === "adapter-authorized" &&
			item.authorization.aborted === true &&
			item.route.state === "claimed" &&
			item.route.route === "adapter-live";
		if (
			item.authorization.state === "authorized" ||
			(item.authorization.state === "adapter-authorized" && !item.authorization.aborted)
		)
			found.add("attempt-authorized");
		if (item.route.state === "claimed" && !abortedAdapterLive) found.add("attempt-route-claimed");
		if (item.authorization.state === "unknown" || item.route.state === "unknown")
			found.add("attempt-evidence-unreadable");
	}
	if (snapshot.writableSession !== null) found.add("writable-session-associated");
	return ENDO_HAZARD_BASES_V0.filter((b) => found.has(b));
}

export interface EndoRegisteredWorktreeV0 {
	worktreeId: string;
	projectId: string;
	/** Canonical (real) top directory of the sibling linked Git worktree. */
	worktreePath: string;
	/** Canonical (real) Git common directory matching the project's repository. */
	commonDir: string;
	/** Canonical (real) Git directory of this linked worktree (distinct from commonDir). */
	gitDir: string;
	label: string | null;
	registeredBy: "operator";
	via: "cli";
	registeredAtMs: number;
}

export interface EndoAssignmentV0 {
	assignmentId: string;
	projectId: string;
	taskId: string;
	/** The task's revision in tasks.json when the operator confirmed (or last reconfirmed) the assignment. */
	taskRevisionAtBind: number;
	/** Per-assignment optimistic-concurrency revision: 1 at creation, +1 on every change to this assignment. */
	revision: number;
	state: EndoAssignmentStateV0;
	participant: {
		participantId: string;
		role: EndoParticipantRoleV0;
		intendedHarnessFamily: EndoIntendedHarnessFamilyV0 | null;
	};
	session: EndoSessionAssociationV0 | null;
	workspace: EndoAssignmentWorkspaceV0;
	worktreeHazard: EndoWorktreeHazardV0;
	/** The candidate a reviewer/investigator is pinned to: a candidate of a task in the SAME project. */
	targetCandidate: { taskId: string; candidateId: string } | null;
	/** Prepared attempts the operator explicitly linked. A link is a reference, never evidence that the attempt ran. */
	attemptIds: string[];
	/** E2: attempts that crossed route-reservation commitment inside `coordination.lock.<n>`. Subset of `attemptIds`. */
	dispatchedAttemptIds?: string[];
	origin: { confirmedBy: "operator"; via: "cli"; confirmedAtMs: number };
	supersedesAssignmentId: string | null;
	supersededByAssignmentId: string | null;
	/** Set by the one terminal transition (supersede, revoke, close); null while active. */
	ended: null | { atMs: number; reason: string | null };
	updatedAtMs: number;
}

export interface EndoDependencyV0 {
	dependencyId: string;
	projectId: string;
	dependentTaskId: string;
	prerequisiteTaskId: string;
	condition: EndoDependencyConditionV0;
	/** The task revisions in tasks.json when the operator declared the edge (a later change is reported, never repaired). */
	declaredAt: { dependentTaskRevision: number; prerequisiteTaskRevision: number; atMs: number };
	/** `operator-decision` only: the operator's decision, bound to the prerequisite's revision; stale once that revision changes. */
	operatorDecision: null | { prerequisiteTaskRevision: number; rationale: string; decidedAtMs: number };
	createdBy: "operator";
	revision: number;
}

export type EndoCandidateRefV0 =
	| {
			kind: "git-commit";
			candidateId: string;
			declaredBy: "operator";
			/** The repository's common Git directory (real path): the repository identity, never a remote or a branch. */
			commonDir: string;
			/** The worktree the commit was resolved in when declared (real path). Where it is, not what it is. */
			worktreePath: string;
			commitSha: string;
			treeSha: string;
			attemptId: string | null;
			supersedesCandidateId: string | null;
			taskRevisionAtDeclare: number;
			declaredAtMs: number;
	  }
	| {
			kind: "protected-candidate";
			candidateId: string;
			declaredBy: "operator";
			attemptId: string;
			runId: string;
			/** What the protected binding sealed when declared. A reader re-establishes the association; it never trusts these alone. */
			bindingSha256: string;
			candidateSha256: string;
			supersedesCandidateId: string | null;
			taskRevisionAtDeclare: number;
			declaredAtMs: number;
	  };

export interface EndoTaskCandidatesV0 {
	projectId: string;
	taskId: string;
	revision: number;
	/** The candidate the operator selected as current; null when none is (a selection, never an acceptance). */
	currentCandidateId: string | null;
	/** Oldest first. Never pruned: a superseded candidate stays as the history its evidence speaks about. */
	candidates: EndoCandidateRefV0[];
}

export interface EndoDevelopCoordinationFileV0 {
	schemaVersion: typeof ENDO_DEVELOP_COORDINATION_SCHEMA_V0;
	/** Increases on every write of the file. */
	revision: number;
	assignments: EndoAssignmentV0[];
	dependencies: EndoDependencyV0[];
	taskCandidates: EndoTaskCandidatesV0[];
	/** E2: explicitly operator-registered sibling Git worktrees (validated against repository commonDir). */
	registeredWorktrees?: EndoRegisteredWorktreeV0[];
}

export const emptyEndoDevelopCoordinationFileV0 = (): EndoDevelopCoordinationFileV0 => ({
	schemaVersion: ENDO_DEVELOP_COORDINATION_SCHEMA_V0,
	revision: 0,
	assignments: [],
	dependencies: [],
	taskCandidates: [],
});

// ---- small shared checks ---------------------------------------------------------------------------------------------------------

/** A canonical absolute path as this module stores one: absolute, no empty, `.` or `..` segment, no trailing slash, bounded, plain text. */
export function isEndoCanonicalPathV0(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxPath)
		return false;
	if (!value.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value)) return false;
	if (value === "/") return true;
	return value
		.slice(1)
		.split("/")
		.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A relative path hint: no leading slash, no `.`/`..`/empty segment, bounded, printable. Advisory only. */
export function isEndoPathHintV0(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxPathHint
	)
		return false;
	if (value.startsWith("/") || /[\u0000-\u001f\u007f]/.test(value)) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Whether a session association may be recorded: a known production source (never `test-*`), a source-qualified key of that source and a
 * known identity scope, a well-formed attachment name and bounded tokens. The refusal names why.
 */
export function endoSessionAssociationProblemV0(
	value: Omit<EndoSessionAssociationV0, "standing" | "declaredAtMs">,
): null | "synthetic-not-admitted" | "unsupported-source" | "bad-session-key" | "bad-attachment" | "bad-token" {
	if (typeof value.source !== "string") return "unsupported-source";
	if (value.source.startsWith("test-")) return "synthetic-not-admitted";
	if (!(ENDO_COORDINATION_SESSION_SOURCES_V0 as readonly string[]).includes(value.source)) return "unsupported-source";
	if (typeof value.sessionKey !== "string" || value.sessionKey.length > ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxToken)
		return "bad-session-key";
	const prefix = `${value.source}:`;
	if (!value.sessionKey.startsWith(prefix)) return "bad-session-key";
	const rest = value.sessionKey.slice(prefix.length);
	const colon = rest.indexOf(":");
	if (colon <= 0) return "bad-session-key";
	const scope = rest.slice(0, colon);
	const id = rest.slice(colon + 1);
	if (!(ENDO_ADAPTER_IDENTITY_SCOPES_V0 as readonly string[]).includes(scope as EndoAdapterIdentityScopeV0))
		return "bad-session-key";
	if (!SAFE_TOKEN.test(id)) return "bad-session-key";
	if (typeof value.attachmentId !== "string" || !isWellFormedKindV0(value.attachmentId)) return "bad-attachment";
	for (const token of [value.instanceId, value.runtimeFingerprintId])
		if (token !== null && (typeof token !== "string" || !SAFE_TOKEN.test(token) || token.length > 128))
			return "bad-token";
	return null;
}

/**
 * Directed dependency edges as `dependent → prerequisite`. Returns one cycle (task ids in order, first repeated last) or null. Iterative
 * DFS with an explicit stack: bounded by the edge limit, never recursive.
 */
export function endoDependencyCycleV0(
	edges: readonly { dependentTaskId: string; prerequisiteTaskId: string }[],
): string[] | null {
	const next = new Map<string, string[]>();
	for (const e of edges) {
		const list = next.get(e.dependentTaskId) ?? [];
		list.push(e.prerequisiteTaskId);
		next.set(e.dependentTaskId, list);
	}
	const color = new Map<string, 1 | 2>();
	for (const start of [...next.keys()].sort()) {
		if (color.has(start)) continue;
		const stack: { node: string; i: number }[] = [{ node: start, i: 0 }];
		const path: string[] = [start];
		color.set(start, 1);
		while (stack.length > 0) {
			const top = stack[stack.length - 1] as { node: string; i: number };
			const outs = next.get(top.node) ?? [];
			if (top.i >= outs.length) {
				color.set(top.node, 2);
				stack.pop();
				path.pop();
				continue;
			}
			const to = outs[top.i++] as string;
			const c = color.get(to);
			if (c === 1) return [...path.slice(path.indexOf(to)), to];
			if (c === undefined) {
				color.set(to, 1);
				stack.push({ node: to, i: 0 });
				path.push(to);
			}
		}
	}
	return null;
}

// ---- the strict validator --------------------------------------------------------------------------------------------------------

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const closed = (v: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
};
const list = (v: unknown, max: number, what: string): unknown[] => {
	if (!Array.isArray(v)) return bad(`${what} is not a list`);
	if (v.length > max) return bad(`${what} has too many entries`);
	return v;
};
const count = (v: unknown, what: string, min = 0): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : bad(`${what} is not a count`);
const stamp = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? v : bad(`${what} is not a time`);
const id = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not a well-formed id`);
const nullable = <T>(v: unknown, read: (x: unknown) => T): T | null => (v === null ? null : read(v));
const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not a known value`);
const path = (v: unknown, what: string): string =>
	isEndoCanonicalPathV0(v) ? v : bad(`${what} is not a canonical path`);
const note = (v: unknown, what: string): string => {
	const checked = checkEndoDevelopTextV0("note", v);
	if (!checked.ok || checked.text !== v) return bad(`${what} is not acceptable text`);
	return checked.text;
};
const bases = (v: unknown, what: string): EndoHazardBasisV0[] => {
	const items = list(v, ENDO_HAZARD_BASES_V0.length, what).map((b) => oneOf(b, ENDO_HAZARD_BASES_V0, what));
	if (items.length === 0 || new Set(items).size !== items.length) bad(`${what} is empty or repeats`);
	// Canonical order, so equal facts serialise equally.
	if (
		items.some(
			(b, i) =>
				i > 0 && ENDO_HAZARD_BASES_V0.indexOf(b) <= ENDO_HAZARD_BASES_V0.indexOf(items[i - 1] as EndoHazardBasisV0),
		)
	)
		bad(`${what} is not in canonical order`);
	return items;
};

function session(v: unknown): EndoSessionAssociationV0 {
	const r = closed(
		v,
		["standing", "source", "sessionKey", "attachmentId", "instanceId", "runtimeFingerprintId", "declaredAtMs"],
		"a session association",
	);
	if (r.standing !== "operator-declared") bad("a session association claims a standing v0 cannot record");
	const value = {
		source: r.source as EndoCoordinationSessionSourceV0,
		sessionKey: r.sessionKey as string,
		attachmentId: r.attachmentId as string,
		instanceId: r.instanceId as string | null,
		runtimeFingerprintId: r.runtimeFingerprintId as string | null,
	};
	const problem = endoSessionAssociationProblemV0(value);
	if (problem !== null) bad(`a session association is not admissible (${problem})`);
	return { standing: "operator-declared", ...value, declaredAtMs: stamp(r.declaredAtMs, "declaredAtMs") };
}

function nonEmptyNote(v: unknown, what: string): string {
	const text = note(v, what);
	if (text === "") return bad(`${what} is empty`);
	return text;
}

function hazardSessionEvidence(v: unknown): EndoHazardSessionEvidenceV0 {
	const r = closed(
		v,
		["source", "sessionKey", "attachmentId", "instanceId", "runtimeFingerprintId"],
		"hazard session evidence",
	);
	const value: EndoHazardSessionEvidenceV0 = {
		source: r.source as EndoCoordinationSessionSourceV0,
		sessionKey: r.sessionKey as string,
		attachmentId: r.attachmentId as string,
		instanceId: r.instanceId as string | null,
		runtimeFingerprintId: r.runtimeFingerprintId as string | null,
	};
	const problem = endoSessionAssociationProblemV0(value);
	if (problem !== null) bad(`hazard session evidence is not admissible (${problem})`);
	return value;
}

function hazardRouteEvidence(v: unknown): EndoHazardRouteEvidenceV0 {
	if (typeof v !== "object" || v === null) return bad("hazard route evidence is not an object");
	const state = (v as { state?: unknown }).state;
	if (state === "absent") {
		closed(v, ["state"], "hazard route evidence");
		return { state: "absent" };
	}
	if (state === "claimed") {
		const r = closed(v, ["state", "route"], "hazard route evidence");
		return { state: "claimed", route: oneOf(r.route, ENDO_HAZARD_ROUTE_KINDS_V0, "hazard route kind") };
	}
	if (state === "unknown") {
		const r = closed(v, ["state", "reason"], "hazard route evidence");
		return {
			state: "unknown",
			reason: oneOf(r.reason, ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0, "hazard route unknown reason"),
		};
	}
	return bad("hazard route evidence has an unknown state");
}

function hazardAuthorizationEvidence(v: unknown): EndoHazardAuthorizationEvidenceV0 {
	if (typeof v !== "object" || v === null) return bad("hazard authorization evidence is not an object");
	const state = (v as { state?: unknown }).state;
	if (state === "absent") {
		closed(v, ["state"], "hazard authorization evidence");
		return { state: "absent" };
	}
	if (state === "authorized") {
		const r = closed(v, ["state", "proposalId", "authorizationEventId"], "hazard authorization evidence");
		if (typeof r.proposalId !== "string" || !isEndoIdentifierV0(r.proposalId, "evidence"))
			bad("hazard authorization proposalId is not a well-formed identifier");
		if (typeof r.authorizationEventId !== "string" || !isEndoIdentifierV0(r.authorizationEventId, "event"))
			bad("hazard authorization eventId is not a well-formed identifier");
		return {
			state: "authorized",
			proposalId: r.proposalId as string,
			authorizationEventId: r.authorizationEventId as string,
		};
	}
	if (state === "adapter-authorized") {
		const r = closed(v, ["state", "authorizationId", "harnessFamily", "aborted"], "hazard adapter authorization");
		if (typeof r.authorizationId !== "string" || !SAFE_TOKEN.test(r.authorizationId))
			return bad("hazard adapter authorizationId is not a valid token");
		const harnessFamily = oneOf(r.harnessFamily, ["pi", "codex"] as const, "hazard adapter harnessFamily");
		if (typeof r.aborted !== "boolean") return bad("hazard adapter aborted is not a boolean");
		return {
			state: "adapter-authorized",
			authorizationId: r.authorizationId,
			harnessFamily,
			aborted: r.aborted,
		};
	}
	if (state === "unknown") {
		const r = closed(v, ["state", "reason", "problems"], "hazard authorization evidence");
		const rawProblems = list(
			r.problems,
			ENDO_HAZARD_ATTEMPT_PROBLEM_KINDS_V0.length * ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0.length,
			"hazard authorization problems",
		);
		const problems: EndoHazardAttemptProblemSummaryV0[] = rawProblems.map((item) => {
			const c = closed(item, ["kind", "reason", "count"], "hazard authorization problem");
			return {
				kind: oneOf(c.kind, ENDO_HAZARD_ATTEMPT_PROBLEM_KINDS_V0, "hazard problem kind"),
				reason: oneOf(c.reason, ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0, "hazard problem reason"),
				count: count(c.count, "hazard problem count", 1),
			};
		});
		for (let i = 1; i < problems.length; i += 1) {
			const prev = problems[i - 1] as EndoHazardAttemptProblemSummaryV0;
			const cur = problems[i] as EndoHazardAttemptProblemSummaryV0;
			const prevKey = `${prev.kind}:${prev.reason}`;
			const curKey = `${cur.kind}:${cur.reason}`;
			if (curKey <= prevKey) bad("hazard authorization problems are not strictly sorted");
		}
		return {
			state: "unknown",
			reason: oneOf(r.reason, ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0, "hazard authorization unknown reason"),
			problems,
		};
	}
	return bad("hazard authorization evidence has an unknown state");
}

function hazardEvidenceSnapshot(v: unknown): EndoHazardEvidenceSnapshotV0 {
	const r = closed(v, ["writableSession", "attempts"], "acknowledged hazard evidence");
	const rawAttempts = list(
		r.attempts,
		ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxAttemptsPerAssignment,
		"acknowledged hazard attempts",
	);
	const attempts: EndoHazardAttemptEvidenceV0[] = rawAttempts.map((item) => {
		const c = closed(item, ["attemptId", "route", "authorization"], "acknowledged hazard attempt");
		return {
			attemptId: id(c.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "acknowledged hazard attemptId"),
			route: hazardRouteEvidence(c.route),
			authorization: hazardAuthorizationEvidence(c.authorization),
		};
	});
	for (let i = 1; i < attempts.length; i += 1) {
		const prev = attempts[i - 1] as EndoHazardAttemptEvidenceV0;
		const cur = attempts[i] as EndoHazardAttemptEvidenceV0;
		if (cur.attemptId <= prev.attemptId) bad("acknowledged hazard attempts are not strictly sorted");
	}
	return {
		writableSession: nullable(r.writableSession, hazardSessionEvidence),
		attempts,
	};
}

function priorClearance(v: unknown): EndoHazardPriorClearanceV0 {
	const r = closed(
		v,
		["clearedBy", "via", "clearedAtMs", "bases", "acknowledgedEvidence", "note"],
		"a prior hazard clearance",
	);
	if (r.clearedBy !== "operator" || r.via !== "cli") bad("a prior hazard clearance claims an actor v0 cannot record");
	return {
		clearedBy: "operator",
		via: "cli",
		clearedAtMs: stamp(r.clearedAtMs, "priorClearance.clearedAtMs"),
		bases: bases(r.bases, "priorClearance.bases"),
		acknowledgedEvidence: nullable(r.acknowledgedEvidence, hazardEvidenceSnapshot),
		note: nonEmptyNote(r.note, "a prior hazard clearance note"),
	};
}

function hazard(v: unknown): EndoWorktreeHazardV0 {
	if (typeof v !== "object" || v === null) return bad("a worktree hazard is not an object");
	const state = (v as { state?: unknown }).state;
	if (state === "none") {
		closed(v, ["state"], "a worktree hazard");
		return { state: "none" };
	}
	if (state === "liveness-unverified") {
		if (Object.hasOwn(v, "priorClearances")) {
			const r = closed(v, ["state", "sinceMs", "bases", "priorClearances"], "a worktree hazard");
			const prior = list(
				r.priorClearances,
				ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxClearanceHistoryPerAssignment,
				"priorClearances",
			).map(priorClearance);
			if (prior.length === 0) bad("priorClearances on liveness-unverified is empty");
			return {
				state,
				sinceMs: stamp(r.sinceMs, "sinceMs"),
				bases: bases(r.bases, "hazard bases"),
				priorClearances: prior,
			};
		}
		const r = closed(v, ["state", "sinceMs", "bases"], "a worktree hazard");
		return { state, sinceMs: stamp(r.sinceMs, "sinceMs"), bases: bases(r.bases, "hazard bases") };
	}
	if (state === "operator-cleared") {
		if (Object.hasOwn(v, "acknowledgedEvidence")) {
			const r = closed(
				v,
				["state", "clearedBy", "via", "clearedAtMs", "bases", "acknowledgedEvidence", "note", "priorClearances"],
				"a worktree hazard",
			);
			if (r.clearedBy !== "operator" || r.via !== "cli") bad("a hazard clearance claims an actor v0 cannot record");
			return {
				state,
				clearedBy: "operator",
				via: "cli",
				clearedAtMs: stamp(r.clearedAtMs, "clearedAtMs"),
				bases: bases(r.bases, "hazard bases"),
				acknowledgedEvidence: hazardEvidenceSnapshot(r.acknowledgedEvidence),
				note: nonEmptyNote(r.note, "a hazard clearance note"),
				priorClearances: list(
					r.priorClearances,
					ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxClearanceHistoryPerAssignment,
					"priorClearances",
				).map(priorClearance),
			};
		}
		// Earlier pre-remediation draft v0 clearance shape: accepted read-only and evaluated conservatively.
		const r = closed(v, ["state", "clearedAtMs", "bases", "note"], "a worktree hazard");
		return {
			state,
			clearedAtMs: stamp(r.clearedAtMs, "clearedAtMs"),
			bases: bases(r.bases, "hazard bases"),
			note: nonEmptyNote(r.note, "a hazard clearance note"),
		};
	}
	return bad("a worktree hazard has an unknown state");
}

function checkSnapshotMatchesAssignment(
	snapshot: EndoHazardEvidenceSnapshotV0,
	declaredBases: readonly EndoHazardBasisV0[],
	value: EndoAssignmentV0,
): void {
	const expectWritableSession = value.workspace.accessIntent === "read-write-intended" && value.session !== null;
	if (expectWritableSession) {
		const s = snapshot.writableSession;
		if (
			s === null ||
			s.source !== value.session?.source ||
			s.sessionKey !== value.session?.sessionKey ||
			s.attachmentId !== value.session?.attachmentId ||
			s.instanceId !== value.session?.instanceId ||
			s.runtimeFingerprintId !== value.session?.runtimeFingerprintId
		)
			bad("acknowledged hazard session does not match the assignment's session");
	} else if (snapshot.writableSession !== null) {
		bad("acknowledged hazard session does not match the assignment");
	}
	const expectedAttempts = [...value.attemptIds].sort();
	if (
		snapshot.attempts.length !== expectedAttempts.length ||
		snapshot.attempts.some((item, i) => item.attemptId !== expectedAttempts[i])
	)
		bad("acknowledged hazard attempts do not match the assignment's linked attempts");
	const implied = endoHazardBasesFromSnapshotV0(snapshot);
	for (const b of implied) {
		if (!declaredBases.includes(b)) bad("acknowledged hazard evidence implies a basis absent from hazard bases");
	}
}

function assignment(v: unknown): EndoAssignmentV0 {
	const baseKeys = [
		"assignmentId",
		"projectId",
		"taskId",
		"taskRevisionAtBind",
		"revision",
		"state",
		"participant",
		"session",
		"workspace",
		"worktreeHazard",
		"targetCandidate",
		"attemptIds",
		"origin",
		"supersedesAssignmentId",
		"supersededByAssignmentId",
		"ended",
		"updatedAtMs",
	];
	const hasDispatched = typeof v === "object" && v !== null && Object.hasOwn(v, "dispatchedAttemptIds");
	const r = closed(v, hasDispatched ? [...baseKeys, "dispatchedAttemptIds"] : baseKeys, "an assignment");
	const aid = id(r.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, "an assignmentId");
	const p = closed(r.participant, ["participantId", "role", "intendedHarnessFamily"], "a participant");
	const hasAckIds =
		typeof r.workspace === "object" && r.workspace !== null && Object.hasOwn(r.workspace, "acknowledgedConflictIds");
	const w = closed(
		r.workspace,
		hasAckIds
			? [
					"worktreePath",
					"registration",
					"accessIntent",
					"pathHints",
					"sharedWorktreeAcknowledged",
					"acknowledgedConflictIds",
				]
			: ["worktreePath", "registration", "accessIntent", "pathHints", "sharedWorktreeAcknowledged"],
		"a workspace",
	);
	const hints = list(w.pathHints, ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxPathHints, "path hints").map((h) =>
		isEndoPathHintV0(h) ? h : bad("a path hint is not a relative path"),
	);
	if (new Set(hints).size !== hints.length) bad("path hints repeat");
	if (typeof w.sharedWorktreeAcknowledged !== "boolean") bad("sharedWorktreeAcknowledged is not a boolean");
	let acknowledgedConflictIds: string[] | undefined;
	if (hasAckIds) {
		const rawIds = list(
			w.acknowledgedConflictIds,
			ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxAssignments,
			"acknowledgedConflictIds",
		).map((aid) => id(aid, ENDO_ASSIGNMENT_ID_PATTERN_V0, "acknowledgedConflictId"));
		if (new Set(rawIds).size !== rawIds.length) bad("acknowledgedConflictIds repeat");
		if (rawIds.includes(aid)) bad("acknowledgedConflictIds cannot reference the assignment itself");
		for (let i = 1; i < rawIds.length; i += 1) {
			if ((rawIds[i] as string) <= (rawIds[i - 1] as string)) bad("acknowledgedConflictIds are not sorted");
		}
		if (!w.sharedWorktreeAcknowledged && rawIds.length > 0)
			bad("acknowledgedConflictIds set without sharedWorktreeAcknowledged");
		acknowledgedConflictIds = rawIds;
	}
	const o = closed(r.origin, ["confirmedBy", "via", "confirmedAtMs"], "an origin");
	if (o.confirmedBy !== "operator" || o.via !== "cli") bad("an origin claims an actor v0 cannot record");
	const attempts = list(r.attemptIds, ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxAttemptsPerAssignment, "attemptIds").map(
		(a) => id(a, ENDO_ATTEMPT_ID_PATTERN_V0, "an attempt id"),
	);
	if (new Set(attempts).size !== attempts.length) bad("attemptIds repeat");
	let dispatchedAttemptIds: string[] | undefined;
	if (hasDispatched) {
		const rawDispatched = list(
			r.dispatchedAttemptIds,
			ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxAttemptsPerAssignment,
			"dispatchedAttemptIds",
		).map((a) => id(a, ENDO_ATTEMPT_ID_PATTERN_V0, "a dispatched attempt id"));
		if (new Set(rawDispatched).size !== rawDispatched.length) bad("dispatchedAttemptIds repeat");
		const attemptSet = new Set(attempts);
		for (const d of rawDispatched) if (!attemptSet.has(d)) bad("dispatchedAttemptId is not in attemptIds");
		dispatchedAttemptIds = rawDispatched;
	}
	const target = nullable(r.targetCandidate, (t) => {
		const c = closed(t, ["taskId", "candidateId"], "a target candidate");
		return {
			taskId: id(c.taskId, ENDO_TASK_ID_PATTERN_V0, "targetCandidate.taskId"),
			candidateId: id(c.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "targetCandidate.candidateId"),
		};
	});
	const ended = nullable(r.ended, (e) => {
		const c = closed(e, ["atMs", "reason"], "an end");
		return { atMs: stamp(c.atMs, "ended.atMs"), reason: nullable(c.reason, (x) => note(x, "an end reason")) };
	});
	const value: EndoAssignmentV0 = {
		assignmentId: id(r.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, "assignmentId"),
		projectId: id(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		taskId: id(r.taskId, ENDO_TASK_ID_PATTERN_V0, "taskId"),
		taskRevisionAtBind: count(r.taskRevisionAtBind, "taskRevisionAtBind"),
		revision: count(r.revision, "revision", 1),
		state: oneOf(r.state, ENDO_ASSIGNMENT_STATES_V0, "state"),
		participant: {
			participantId: id(p.participantId, ENDO_PARTICIPANT_ID_PATTERN_V0, "participantId"),
			role: oneOf(p.role, ENDO_PARTICIPANT_ROLES_V0, "role"),
			intendedHarnessFamily: nullable(p.intendedHarnessFamily, (x) =>
				oneOf(x, ENDO_HARNESS_FAMILIES_V0, "intendedHarnessFamily"),
			),
		},
		session: nullable(r.session, session),
		workspace: {
			worktreePath: path(w.worktreePath, "worktreePath"),
			registration: oneOf(w.registration, ENDO_WORKSPACE_REGISTRATIONS_V0, "registration"),
			accessIntent: oneOf(w.accessIntent, ENDO_ACCESS_INTENTS_V0, "accessIntent"),
			pathHints: hints,
			sharedWorktreeAcknowledged: w.sharedWorktreeAcknowledged as boolean,
			...(acknowledgedConflictIds === undefined ? {} : { acknowledgedConflictIds }),
		},
		worktreeHazard: hazard(r.worktreeHazard),
		targetCandidate: target,
		attemptIds: attempts,
		...(dispatchedAttemptIds === undefined ? {} : { dispatchedAttemptIds }),
		origin: { confirmedBy: "operator", via: "cli", confirmedAtMs: stamp(o.confirmedAtMs, "confirmedAtMs") },
		supersedesAssignmentId: nullable(r.supersedesAssignmentId, (x) =>
			id(x, ENDO_ASSIGNMENT_ID_PATTERN_V0, "supersedesAssignmentId"),
		),
		supersededByAssignmentId: nullable(r.supersededByAssignmentId, (x) =>
			id(x, ENDO_ASSIGNMENT_ID_PATTERN_V0, "supersededByAssignmentId"),
		),
		ended,
		updatedAtMs: stamp(r.updatedAtMs, "updatedAtMs"),
	};
	// Contradictory states are refused, never interpreted.
	const active = value.state === "active";
	if (active !== (value.ended === null)) bad("an assignment's state and end disagree");
	if ((value.state === "superseded") !== (value.supersededByAssignmentId !== null))
		bad("an assignment's state and supersession disagree");
	if (active && value.worktreeHazard.state !== "none") bad("an active assignment carries a terminal hazard");
	if (value.supersedesAssignmentId === value.assignmentId || value.supersededByAssignmentId === value.assignmentId)
		bad("an assignment supersedes itself");
	if (value.participant.role === "builder" && value.targetCandidate !== null)
		bad("a builder assignment names a target candidate");
	if (value.worktreeHazard.state === "operator-cleared") {
		if ("acknowledgedEvidence" in value.worktreeHazard) {
			checkSnapshotMatchesAssignment(value.worktreeHazard.acknowledgedEvidence, value.worktreeHazard.bases, value);
			for (const prior of value.worktreeHazard.priorClearances) {
				if (prior.acknowledgedEvidence !== null)
					checkSnapshotMatchesAssignment(prior.acknowledgedEvidence, prior.bases, value);
			}
		}
	} else if (value.worktreeHazard.state === "liveness-unverified" && value.worktreeHazard.priorClearances) {
		for (const prior of value.worktreeHazard.priorClearances) {
			if (prior.acknowledgedEvidence !== null)
				checkSnapshotMatchesAssignment(prior.acknowledgedEvidence, prior.bases, value);
		}
	}
	return value;
}

function dependency(v: unknown): EndoDependencyV0 {
	const r = closed(
		v,
		[
			"dependencyId",
			"projectId",
			"dependentTaskId",
			"prerequisiteTaskId",
			"condition",
			"declaredAt",
			"operatorDecision",
			"createdBy",
			"revision",
		],
		"a dependency",
	);
	const d = closed(r.declaredAt, ["dependentTaskRevision", "prerequisiteTaskRevision", "atMs"], "declaredAt");
	if (r.createdBy !== "operator") bad("a dependency claims an actor v0 cannot record");
	const value: EndoDependencyV0 = {
		dependencyId: id(r.dependencyId, ENDO_DEPENDENCY_ID_PATTERN_V0, "dependencyId"),
		projectId: id(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		dependentTaskId: id(r.dependentTaskId, ENDO_TASK_ID_PATTERN_V0, "dependentTaskId"),
		prerequisiteTaskId: id(r.prerequisiteTaskId, ENDO_TASK_ID_PATTERN_V0, "prerequisiteTaskId"),
		condition: oneOf(r.condition, ENDO_DEPENDENCY_CONDITIONS_V0, "condition"),
		declaredAt: {
			dependentTaskRevision: count(d.dependentTaskRevision, "dependentTaskRevision"),
			prerequisiteTaskRevision: count(d.prerequisiteTaskRevision, "prerequisiteTaskRevision"),
			atMs: stamp(d.atMs, "declaredAt.atMs"),
		},
		operatorDecision: nullable(r.operatorDecision, (x) => {
			const o = closed(x, ["prerequisiteTaskRevision", "rationale", "decidedAtMs"], "an operator decision");
			const rationale = checkEndoDevelopTextV0("note", o.rationale);
			if (!rationale.ok || rationale.text !== o.rationale || rationale.text === "")
				bad("an operator decision's rationale is not acceptable text");
			return {
				prerequisiteTaskRevision: count(o.prerequisiteTaskRevision, "prerequisiteTaskRevision"),
				rationale: o.rationale as string,
				decidedAtMs: stamp(o.decidedAtMs, "decidedAtMs"),
			};
		}),
		createdBy: "operator",
		revision: count(r.revision, "revision", 1),
	};
	if (value.dependentTaskId === value.prerequisiteTaskId) bad("a task depends on itself");
	if (value.condition !== "operator-decision" && value.operatorDecision !== null)
		bad("an operator decision on an edge whose condition is not operator-decision");
	return value;
}

function candidate(v: unknown): EndoCandidateRefV0 {
	const kind = typeof v === "object" && v !== null ? (v as { kind?: unknown }).kind : undefined;
	if (kind === "git-commit") {
		const r = closed(
			v,
			[
				"kind",
				"candidateId",
				"declaredBy",
				"commonDir",
				"worktreePath",
				"commitSha",
				"treeSha",
				"attemptId",
				"supersedesCandidateId",
				"taskRevisionAtDeclare",
				"declaredAtMs",
			],
			"a git candidate",
		);
		if (r.declaredBy !== "operator") bad("a candidate claims a declarer v0 cannot record");
		const commitSha = id(r.commitSha, ENDO_GIT_OID_PATTERN_V0, "commitSha");
		const treeSha = id(r.treeSha, ENDO_GIT_OID_PATTERN_V0, "treeSha");
		if (commitSha.length !== treeSha.length) bad("a candidate mixes object formats");
		return {
			kind,
			candidateId: id(r.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "candidateId"),
			declaredBy: "operator",
			commonDir: path(r.commonDir, "commonDir"),
			worktreePath: path(r.worktreePath, "worktreePath"),
			commitSha,
			treeSha,
			attemptId: nullable(r.attemptId, (x) => id(x, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId")),
			supersedesCandidateId: nullable(r.supersedesCandidateId, (x) =>
				id(x, ENDO_CANDIDATE_ID_PATTERN_V0, "supersedesCandidateId"),
			),
			taskRevisionAtDeclare: count(r.taskRevisionAtDeclare, "taskRevisionAtDeclare"),
			declaredAtMs: stamp(r.declaredAtMs, "declaredAtMs"),
		};
	}
	if (kind === "protected-candidate") {
		const r = closed(
			v,
			[
				"kind",
				"candidateId",
				"declaredBy",
				"attemptId",
				"runId",
				"bindingSha256",
				"candidateSha256",
				"supersedesCandidateId",
				"taskRevisionAtDeclare",
				"declaredAtMs",
			],
			"a protected candidate",
		);
		if (r.declaredBy !== "operator") bad("a candidate claims a declarer v0 cannot record");
		if (typeof r.runId !== "string" || !SAFE_TOKEN.test(r.runId) || r.runId.length > 128) bad("runId is not a token");
		return {
			kind,
			candidateId: id(r.candidateId, ENDO_CANDIDATE_ID_PATTERN_V0, "candidateId"),
			declaredBy: "operator",
			attemptId: id(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
			runId: r.runId as string,
			bindingSha256: id(r.bindingSha256, HEX64, "bindingSha256"),
			candidateSha256: id(r.candidateSha256, HEX64, "candidateSha256"),
			supersedesCandidateId: nullable(r.supersedesCandidateId, (x) =>
				id(x, ENDO_CANDIDATE_ID_PATTERN_V0, "supersedesCandidateId"),
			),
			taskRevisionAtDeclare: count(r.taskRevisionAtDeclare, "taskRevisionAtDeclare"),
			declaredAtMs: stamp(r.declaredAtMs, "declaredAtMs"),
		};
	}
	return bad("a candidate has an unknown kind");
}

function taskCandidates(v: unknown): EndoTaskCandidatesV0 {
	const r = closed(v, ["projectId", "taskId", "revision", "currentCandidateId", "candidates"], "task candidates");
	const candidates = list(r.candidates, ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxCandidatesPerTask, "candidates").map(
		candidate,
	);
	const value: EndoTaskCandidatesV0 = {
		projectId: id(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		taskId: id(r.taskId, ENDO_TASK_ID_PATTERN_V0, "taskId"),
		revision: count(r.revision, "revision", 1),
		currentCandidateId: nullable(r.currentCandidateId, (x) =>
			id(x, ENDO_CANDIDATE_ID_PATTERN_V0, "currentCandidateId"),
		),
		candidates,
	};
	const seen = new Set<string>();
	for (const c of candidates) {
		// A supersession names an EARLIER candidate of the same task: the chain is acyclic by construction.
		if (c.supersedesCandidateId !== null && !seen.has(c.supersedesCandidateId))
			bad("a candidate supersedes one that is not earlier in its task");
		if (seen.has(c.candidateId)) bad("a candidate id repeats");
		seen.add(c.candidateId);
	}
	if (candidates.length === 0) bad("a task candidates entry with no candidates");
	if (value.currentCandidateId !== null && !seen.has(value.currentCandidateId))
		bad("the current candidate is not one of the task's candidates");
	return value;
}

function registeredWorktree(v: unknown): EndoRegisteredWorktreeV0 {
	const r = closed(
		v,
		[
			"worktreeId",
			"projectId",
			"worktreePath",
			"commonDir",
			"gitDir",
			"label",
			"registeredBy",
			"via",
			"registeredAtMs",
		],
		"a registered worktree",
	);
	if (r.registeredBy !== "operator" || r.via !== "cli") bad("a registered worktree claims an actor v0 cannot record");
	const worktreePath = path(r.worktreePath, "registeredWorktree.worktreePath");
	const commonDir = path(r.commonDir, "registeredWorktree.commonDir");
	const gitDir = path(r.gitDir, "registeredWorktree.gitDir");
	if (worktreePath === commonDir) bad("registered worktree path equals commonDir");
	if (gitDir === commonDir) bad("registered sibling worktree gitDir must be distinct from commonDir");
	return {
		worktreeId: id(r.worktreeId, ENDO_WORKTREE_ID_PATTERN_V0, "worktreeId"),
		projectId: id(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		worktreePath,
		commonDir,
		gitDir,
		label: nullable(r.label, (x) => nonEmptyNote(x, "registeredWorktree.label")),
		registeredBy: "operator",
		via: "cli",
		registeredAtMs: stamp(r.registeredAtMs, "registeredWorktree.registeredAtMs"),
	};
}

/** Validate a whole file, cross-references inside it included. Throws EndoInvalidRecordV0 with a short reason. */
export function validateEndoDevelopCoordinationFileV0(value: unknown): EndoDevelopCoordinationFileV0 {
	const hasWorktrees = typeof value === "object" && value !== null && Object.hasOwn(value, "registeredWorktrees");
	const r = closed(
		value,
		hasWorktrees
			? ["schemaVersion", "revision", "assignments", "dependencies", "taskCandidates", "registeredWorktrees"]
			: ["schemaVersion", "revision", "assignments", "dependencies", "taskCandidates"],
		"the file",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_COORDINATION_SCHEMA_V0) bad("the file is not endo.develop-coordination.v0");
	const L = ENDO_DEVELOP_COORDINATION_LIMITS_V0;
	const worktrees = hasWorktrees
		? list(r.registeredWorktrees, L.maxRegisteredWorktrees, "registeredWorktrees").map(registeredWorktree)
		: undefined;
	const file: EndoDevelopCoordinationFileV0 = {
		schemaVersion: ENDO_DEVELOP_COORDINATION_SCHEMA_V0,
		revision: count(r.revision, "revision"),
		assignments: list(r.assignments, L.maxAssignments, "assignments").map(assignment),
		dependencies: list(r.dependencies, L.maxDependencies, "dependencies").map(dependency),
		taskCandidates: list(r.taskCandidates, L.maxCandidateTasks, "taskCandidates").map(taskCandidates),
		...(worktrees === undefined ? {} : { registeredWorktrees: worktrees }),
	};
	// Identity: every id once, across the whole file.
	const ids = new Set<string>();
	const once = (x: string) => {
		if (ids.has(x)) bad("an id repeats");
		ids.add(x);
	};
	for (const a of file.assignments) once(a.assignmentId);
	for (const d of file.dependencies) once(d.dependencyId);
	if (file.registeredWorktrees !== undefined) {
		const seenPaths = new Set<string>();
		const seenGitDirs = new Set<string>();
		for (const w of file.registeredWorktrees) {
			once(w.worktreeId);
			if (seenPaths.has(w.worktreePath)) bad("a registered worktree path repeats");
			if (seenGitDirs.has(w.gitDir)) bad("a registered worktree gitDir repeats");
			seenPaths.add(w.worktreePath);
			seenGitDirs.add(w.gitDir);
		}
	}
	const entries = new Map<string, EndoTaskCandidatesV0>();
	for (const t of file.taskCandidates) {
		if (entries.has(t.taskId)) bad("a task has two candidate entries");
		entries.set(t.taskId, t);
		for (const c of t.candidates) once(c.candidateId);
	}
	// Assignments: supersession is a symmetric, same-task relation; a target candidate resolves inside the same project.
	const byId = new Map(file.assignments.map((a) => [a.assignmentId, a]));
	const activeParticipants = new Set<string>();
	for (const a of file.assignments) {
		if (a.state === "active") {
			const key = `${a.taskId} ${a.participant.participantId}`;
			if (activeParticipants.has(key)) bad("a participant has two active assignments on one task");
			activeParticipants.add(key);
		}
		if (a.supersededByAssignmentId !== null) {
			const by = byId.get(a.supersededByAssignmentId);
			if (by === undefined || by.supersedesAssignmentId !== a.assignmentId)
				throw new EndoInvalidRecordV0("a supersession is not symmetric");
			if (by.taskId !== a.taskId || by.projectId !== a.projectId) bad("a supersession crosses tasks");
		}
		if (a.supersedesAssignmentId !== null) {
			const of = byId.get(a.supersedesAssignmentId);
			if (of === undefined || of.supersededByAssignmentId !== a.assignmentId || of.state !== "superseded")
				bad("a supersession is not symmetric");
		}
		if (a.targetCandidate !== null) {
			const entry = entries.get(a.targetCandidate.taskId);
			if (entry === undefined || entry.projectId !== a.projectId)
				throw new EndoInvalidRecordV0("a target candidate is not in the project");
			if (!entry.candidates.some((c) => c.candidateId === a.targetCandidate?.candidateId))
				bad("a target candidate does not exist");
		}
	}
	// Dependencies: one edge per ordered task pair, within one project, and acyclic.
	const pairs = new Set<string>();
	for (const d of file.dependencies) {
		const key = `${d.dependentTaskId}>${d.prerequisiteTaskId}`;
		if (pairs.has(key)) bad("a dependency edge repeats");
		pairs.add(key);
	}
	const taskProject = new Map<string, string>();
	const sameProject = (taskId: string, projectId: string) => {
		const known = taskProject.get(taskId);
		if (known !== undefined && known !== projectId) bad("a task id appears under two projects");
		taskProject.set(taskId, projectId);
	};
	for (const a of file.assignments) sameProject(a.taskId, a.projectId);
	for (const t of file.taskCandidates) sameProject(t.taskId, t.projectId);
	for (const d of file.dependencies) {
		sameProject(d.dependentTaskId, d.projectId);
		sameProject(d.prerequisiteTaskId, d.projectId);
	}
	if (endoDependencyCycleV0(file.dependencies) !== null) bad("the dependency graph has a cycle");
	return file;
}

export const ENDO_DEVELOP_COORDINATION_VERSIONS_V0 = defineEndoVersionTableV0<EndoDevelopCoordinationFileV0>(
	"endo.develop-coordination",
	[[ENDO_DEVELOP_COORDINATION_SCHEMA_V0, validateEndoDevelopCoordinationFileV0]],
);
export const readEndoDevelopCoordinationFileV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_DEVELOP_COORDINATION_VERSIONS_V0, value);
