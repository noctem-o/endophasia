// Pure read-side interpretation of DEVELOP coordination metadata (protocol/develop-coordination.ts) against the evidence that already
// exists: tasks.json, attempt records, verification receipts, route reservations, and Git/protected-run re-verification the CALLER did.
// Nothing here reads a file, runs a process or keeps state: the caller gathers, this module decides, and the same inputs give the same
// output. Nothing here grants anything: readiness is computed for the operator to read, and no caller uses it as permission.
//
// The candidate-bound receipt predicate (docs/designs/coordinator-assignment.md §7.1) is evaluated per candidate against EXACT
// (commonDir, commit, tree) identity, with each planned check read through endoPlannedReadingV0, never through the live-HEAD acceptance
// ledger. A passing reading is evidence about that immutable candidate only, and always carries the GEO-26 disclosure.

import {
	ENDO_COORDINATION_PROJECTION_AUTHORITY_V0,
	ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
	ENDO_REVIEW_DISCLOSURES_V0,
	type EndoCandidateIdentityReadingV0,
	type EndoCandidateReceiptReadingV0,
	type EndoCandidateWorkspaceReadingV0,
	type EndoCoordinationAssignmentFindingV0,
	type EndoCoordinationAssignmentViewV0,
	type EndoCoordinationConflictViewV0,
	type EndoCoordinationDependencyReasonV0,
	type EndoCoordinationDependencyViewV0,
	type EndoCoordinationDependencyWarningV0,
	type EndoCoordinationGapV0,
	type EndoCoordinationProjectViewV0,
	type EndoCoordinationReadinessV0,
	type EndoCoordinationRegisteredWorktreeViewV0,
	type EndoCoordinationReviewViewV0,
	type EndoCoordinationTaskViewV0,
	type EndoCoordinatorCoordinationV0,
	type EndoSessionInstanceStatusV0,
} from "../../protocol/coordinator-coordination.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0, endoAttemptPlanV0 } from "../../protocol/develop-attempts.ts";
import {
	ENDO_HAZARD_BASES_V0,
	ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0,
	type EndoAccessIntentV0,
	type EndoAssignmentV0,
	type EndoCandidateRefV0,
	type EndoDependencyV0,
	type EndoDevelopCoordinationFileV0,
	type EndoHazardAttemptProblemKindV0,
	type EndoHazardAttemptProblemSummaryV0,
	type EndoHazardAuthorizationEvidenceV0,
	type EndoHazardBasisV0,
	type EndoHazardEvidenceSnapshotV0,
	type EndoHazardEvidenceUnknownReasonV0,
	type EndoHazardPriorClearanceV0,
	type EndoHazardRouteEvidenceV0,
	type EndoHazardSessionEvidenceV0,
	endoHazardBasesFromSnapshotV0,
} from "../../protocol/develop-coordination.ts";
import type { EndoDevelopAdvisoryReviewV0 } from "../../protocol/develop-coordination-reviews.ts";
import type {
	EndoDevelopReceiptV0,
	EndoReceiptCurrentV0,
	EndoReceiptOutcomeV0,
} from "../../protocol/develop-receipts.ts";
import type { EndoDevelopTaskStatusV0 } from "../../protocol/develop-tasks.ts";
import type { EndoAdapterAttemptRecordsV0 } from "../../storage/develop-adapter-authorizations.ts";
import {
	checkProtectedAttemptPresenceSyncV0,
	type DevelopAttemptRoutesStoreV0,
	type EndoDevelopAttemptRouteReadV0,
} from "../../storage/develop-attempt-routes.ts";
import {
	type EndoAttemptEntryV0,
	type EndoAttemptProblemV0,
	endoAttemptProblemsOfV0,
} from "../../storage/develop-attempts.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import { endoOfflineSessionLivenessV0 } from "./develop-session-liveness.ts";
import { endoPlannedReadingV0 } from "./develop-verification.ts";

// ---- workspace conflicts (used by writers to refuse, and by readers to report) ------------------------------------------------------

/** Whether an assignment still occupies its worktree against new writers: active writable, or any ended assignment with an unverified hazard. */
export const endoOccupiesWorktreeV0 = (a: EndoAssignmentV0): boolean =>
	(a.state === "active" && a.workspace.accessIntent === "read-write-intended") ||
	a.worktreeHazard.state === "liveness-unverified";

/**
 * The assignments a NEW writable assignment on `worktreePath` would overlap (§10.1): every other writer on the same canonical path that is
 * active or ended with `liveness-unverified`. A read-only proposal overlaps nothing that refuses it (it is reported, not refused).
 */
export function endoWorktreeWriteConflictsV0(
	assignments: readonly EndoAssignmentV0[],
	proposal: { worktreePath: string; accessIntent: EndoAccessIntentV0 },
	exclude: ReadonlySet<string> = new Set(),
): { assignmentId: string; reason: "active-writer" | "liveness-unverified" }[] {
	if (proposal.accessIntent !== "read-write-intended") return [];
	return assignments
		.filter((a) => !exclude.has(a.assignmentId) && a.workspace.worktreePath === proposal.worktreePath)
		.filter(endoOccupiesWorktreeV0)
		.map((a) => ({
			assignmentId: a.assignmentId,
			reason: a.state === "active" ? ("active-writer" as const) : ("liveness-unverified" as const),
		}));
}

/** Per-attempt execution evidence as found on disk by the caller: never inferred, `unknown` when it could not be read. */
export type EndoAttemptExecutionEvidenceV0 = {
	route: EndoHazardRouteEvidenceV0;
	authorization: EndoHazardAuthorizationEvidenceV0;
};

const toUnknownReason = (raw: string | undefined): EndoHazardEvidenceUnknownReasonV0 =>
	raw !== undefined && (ENDO_HAZARD_EVIDENCE_UNKNOWN_REASONS_V0 as readonly string[]).includes(raw)
		? (raw as EndoHazardEvidenceUnknownReasonV0)
		: "invalid";

/** Map a route-store read to canonical hazard route evidence. */
export function endoRouteEvidenceFromReadV0(read: EndoDevelopAttemptRouteReadV0): EndoHazardRouteEvidenceV0 {
	if (read.state === "absent") return { state: "absent" };
	if (read.state === "present") return { state: "claimed", route: read.record.route };
	return { state: "unknown", reason: toUnknownReason(read.reason) };
}

/**
 * Read canonical route evidence for one attempt on the host, consulting both `<developDir>/attempt-routes/<id>.route.json`
 * and the pre-route `<developDir>/protected-attempts/<id>.{launch,candidate}.json` fallback (matching DevelopAttemptDispatchV0).
 */
export function endoRouteEvidenceForAttemptV0(
	developDir: string,
	routes: DevelopAttemptRoutesStoreV0,
	attemptId: string,
): EndoHazardRouteEvidenceV0 {
	const primary = endoRouteEvidenceFromReadV0(routes.read(attemptId));
	if (primary.state !== "absent") return primary;
	const protectedPresence = checkProtectedAttemptPresenceSyncV0(developDir, attemptId);
	if (protectedPresence === "present") return { state: "claimed", route: "protected" };
	if (protectedPresence === "problem") return { state: "unknown", reason: "problem" };
	return primary;
}

/**
 * Shared read-side and write-side per-attempt execution evidence builder so the coordination store and the
 * Coordinator projection never diverge (including on per-attempt unreadable/orphaned/misnamed problem files).
 * Checks `endoAttemptProblemsOfV0` BEFORE `entry.authorized` so a misnamed or extra problem file cannot be masked.
 */
export function endoAttemptExecutionEvidenceFromReadV0(
	attemptId: string,
	attemptsRead:
		| { ok: true; entries: readonly EndoAttemptEntryV0[]; problems: readonly EndoAttemptProblemV0[] }
		| { ok: false; reason?: string },
	route: EndoHazardRouteEvidenceV0,
	adapterRecords?: EndoAdapterAttemptRecordsV0,
	assignmentId?: string,
): EndoAttemptExecutionEvidenceV0 {
	// Always validate `develop/attempts/` first so unreadable/corrupt attempt records or conflicting workbench
	// authorizations can NEVER be masked by an adapter pre-transport abort (Adversarial Finding #1).
	if (!attemptsRead.ok) {
		return {
			route,
			authorization: { state: "unknown", reason: toUnknownReason(attemptsRead.reason ?? "io"), problems: [] },
		};
	}
	const problems = endoAttemptProblemsOfV0(attemptsRead.problems, attemptId);
	if (problems.length > 0) {
		const counts = new Map<string, EndoHazardAttemptProblemSummaryV0>();
		for (const p of problems) {
			const kind: EndoHazardAttemptProblemKindV0 = p.kind ?? "other";
			const reason = toUnknownReason(p.problem.reason);
			const key = `${kind}:${reason}`;
			const existing = counts.get(key);
			if (existing === undefined) counts.set(key, { kind, reason, count: 1 });
			else existing.count += 1;
		}
		const summary = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
		const firstReason = [...summary].map((s) => s.reason).sort()[0] ?? "problem";
		return { route, authorization: { state: "unknown", reason: firstReason, problems: summary } };
	}
	const entry = attemptsRead.entries.find((e) => e.attempt.id === attemptId);
	const hasWorkbenchAuth = entry?.authorized != null;

	if (adapterRecords !== undefined) {
		if (adapterRecords.authorization.state === "problem") {
			const reason = toUnknownReason(adapterRecords.authorization.reason);
			return {
				route,
				authorization: {
					state: "unknown",
					reason,
					problems: [{ kind: "authorized", reason, count: 1 }],
				},
			};
		}
		if (adapterRecords.abort.state === "problem") {
			const reason = toUnknownReason(adapterRecords.abort.reason);
			return {
				route,
				authorization: {
					state: "unknown",
					reason,
					problems: [{ kind: "other", reason, count: 1 }],
				},
			};
		}
		if (adapterRecords.outcome.state === "problem") {
			const reason = toUnknownReason(adapterRecords.outcome.reason);
			return {
				route,
				authorization: {
					state: "unknown",
					reason,
					problems: [{ kind: "outcome", reason, count: 1 }],
				},
			};
		}
		if (adapterRecords.authorization.state === "present") {
			// Conflicting dual authorizations (both Pi workbench AND adapter-live) fail closed as unknown.
			if (hasWorkbenchAuth) {
				return {
					route,
					authorization: {
						state: "unknown",
						reason: "invalid",
						problems: [{ kind: "authorized", reason: "invalid", count: 1 }],
					},
				};
			}
			const auth = adapterRecords.authorization.record;
			const assignmentMatches = assignmentId === undefined || auth.assignmentId === assignmentId;
			const aborted =
				assignmentMatches &&
				adapterRecords.abort.state === "present" &&
				adapterRecords.abort.record.authorizationId === auth.authorizationId &&
				(assignmentId === undefined || adapterRecords.abort.record.assignmentId === assignmentId) &&
				adapterRecords.outcome.state === "absent";
			return {
				route,
				authorization: {
					state: "adapter-authorized",
					authorizationId: auth.authorizationId,
					harnessFamily: auth.harnessFamily,
					aborted,
				},
			};
		}
		if (adapterRecords.abort.state === "present" || adapterRecords.outcome.state === "present") {
			return {
				route,
				authorization: {
					state: "unknown",
					reason: "orphan",
					problems: [{ kind: "authorized", reason: "orphan", count: 1 }],
				},
			};
		}
	}
	if (hasWorkbenchAuth && entry?.authorized != null) {
		return {
			route,
			authorization: {
				state: "authorized",
				proposalId: entry.authorized.proposalId,
				authorizationEventId: entry.authorized.authorizationEventId,
			},
		};
	}
	if (entry === undefined) {
		return { route, authorization: { state: "unknown", reason: "missing", problems: [] } };
	}
	return { route, authorization: { state: "absent" } };
}

/** Canonical, bounded snapshot of observed execution evidence for an assignment. */
export function endoHazardEvidenceSnapshotV0(
	a: EndoAssignmentV0,
	evidence: (attemptId: string, assignmentId?: string) => EndoAttemptExecutionEvidenceV0,
): EndoHazardEvidenceSnapshotV0 {
	const writableSession: EndoHazardSessionEvidenceV0 | null =
		a.workspace.accessIntent === "read-write-intended" && a.session !== null
			? {
					source: a.session.source,
					sessionKey: a.session.sessionKey,
					attachmentId: a.session.attachmentId,
					instanceId: a.session.instanceId,
					runtimeFingerprintId: a.session.runtimeFingerprintId,
				}
			: null;
	const attempts = [...a.attemptIds].sort().map((attemptId) => {
		const e = evidence(attemptId, a.assignmentId);
		return { attemptId, route: e.route, authorization: e.authorization };
	});
	return { writableSession, attempts };
}

/** Deterministic SHA-256 digest of a canonical hazard evidence snapshot (for stale-evidence clearance binding). */
export function endoHazardEvidenceDigestV0(snapshot: EndoHazardEvidenceSnapshotV0): string {
	return sha256HexV0(canonicalEndoJsonV0(snapshot as never));
}

const sameSessionEvidence = (a: EndoHazardSessionEvidenceV0 | null, b: EndoHazardSessionEvidenceV0 | null): boolean => {
	if (a === null || b === null) return a === b;
	return (
		a.source === b.source &&
		a.sessionKey === b.sessionKey &&
		a.attachmentId === b.attachmentId &&
		a.instanceId === b.instanceId &&
		a.runtimeFingerprintId === b.runtimeFingerprintId
	);
};

const sameProblemSummary = (
	a: readonly EndoHazardAttemptProblemSummaryV0[],
	b: readonly EndoHazardAttemptProblemSummaryV0[],
): boolean =>
	a.length === b.length &&
	a.every((item, i) => {
		const other = b[i];
		return (
			other !== undefined && item.kind === other.kind && item.reason === other.reason && item.count === other.count
		);
	});

/**
 * Which currently observed hazard bases are NOT covered by a prior clearance's `acknowledgedEvidence`.
 * When `acknowledged` is null (an earlier pre-remediation draft clearance without an evidence snapshot),
 * conservatively treats every currently observed hazard basis as uncovered.
 */
export function endoUncoveredHazardBasesV0(
	current: EndoHazardEvidenceSnapshotV0,
	acknowledged: EndoHazardEvidenceSnapshotV0 | null,
): EndoHazardBasisV0[] {
	if (acknowledged === null) return endoHazardBasesFromSnapshotV0(current);
	const uncovered = new Set<EndoHazardBasisV0>();
	if (
		current.writableSession !== null &&
		!sameSessionEvidence(current.writableSession, acknowledged.writableSession)
	) {
		uncovered.add("writable-session-associated");
	}
	const ackByAttempt = new Map(acknowledged.attempts.map((item) => [item.attemptId, item]));
	for (const cur of current.attempts) {
		const ack = ackByAttempt.get(cur.attemptId);
		const abortedAdapterLive =
			cur.authorization.state === "adapter-authorized" &&
			cur.authorization.aborted === true &&
			cur.route.state === "claimed" &&
			cur.route.route === "adapter-live";
		if (cur.route.state === "claimed" && !abortedAdapterLive) {
			if (ack?.route.state !== "claimed" || ack.route.route !== cur.route.route) {
				uncovered.add("attempt-route-claimed");
			}
		} else if (cur.route.state === "unknown") {
			if (ack?.route.state !== "unknown" || ack.route.reason !== cur.route.reason) {
				uncovered.add("attempt-evidence-unreadable");
			}
		}
		if (cur.authorization.state === "authorized") {
			if (
				ack?.authorization.state !== "authorized" ||
				ack.authorization.proposalId !== cur.authorization.proposalId ||
				ack.authorization.authorizationEventId !== cur.authorization.authorizationEventId
			) {
				uncovered.add("attempt-authorized");
			}
		} else if (cur.authorization.state === "adapter-authorized") {
			if (!cur.authorization.aborted) {
				if (
					ack?.authorization.state !== "adapter-authorized" ||
					ack.authorization.authorizationId !== cur.authorization.authorizationId ||
					ack.authorization.harnessFamily !== cur.authorization.harnessFamily ||
					ack.authorization.aborted !== false
				) {
					uncovered.add("attempt-authorized");
				}
			}
		} else if (cur.authorization.state === "unknown") {
			if (
				ack?.authorization.state !== "unknown" ||
				ack.authorization.reason !== cur.authorization.reason ||
				!sameProblemSummary(ack.authorization.problems, cur.authorization.problems)
			) {
				uncovered.add("attempt-evidence-unreadable");
			}
		}
	}
	return ENDO_HAZARD_BASES_V0.filter((b) => uncovered.has(b));
}

/**
 * Why a terminal transition (supersede, revoke, close) must leave the worktree hazardous: any linked attempt with an authorisation or a
 * route reservation on disk (or whose evidence cannot be read), and a writable assignment with an associated session (#183's Studio can
 * prompt a session directly, with no attempt at all). Empty: nothing on disk suggests anything ran. E1 has no abort or cleanup record,
 * so nothing here can clear a basis.
 */
export function endoTerminalHazardBasesV0(
	a: EndoAssignmentV0,
	evidence: (attemptId: string, assignmentId?: string) => EndoAttemptExecutionEvidenceV0,
): EndoHazardBasisV0[] {
	return endoHazardBasesFromSnapshotV0(endoHazardEvidenceSnapshotV0(a, evidence));
}

/**
 * Evaluate the effective hazard of an assignment against one already-captured canonical evidence snapshot.
 * Re-evaluates `none`, `liveness-unverified` and `operator-cleared` assignments so late or unreadable execution
 * evidence always reactivates `liveness-unverified` while preserving historical clearances in `priorClearances`.
 */
export function endoEffectiveAssignmentFromSnapshotV0(
	a: EndoAssignmentV0,
	snapshot: EndoHazardEvidenceSnapshotV0,
): EndoAssignmentV0 {
	if (a.state === "active") return a;
	const currentBases = endoHazardBasesFromSnapshotV0(snapshot);
	if (a.worktreeHazard.state === "none") {
		return currentBases.length === 0
			? a
			: { ...a, worktreeHazard: { state: "liveness-unverified", sinceMs: a.updatedAtMs, bases: currentBases } };
	}
	if (a.worktreeHazard.state === "liveness-unverified") {
		const stored = a.worktreeHazard;
		const mergedBases = ENDO_HAZARD_BASES_V0.filter((b) => stored.bases.includes(b) || currentBases.includes(b));
		return mergedBases.length === stored.bases.length && mergedBases.every((b, i) => b === stored.bases[i])
			? a
			: { ...a, worktreeHazard: { ...stored, bases: mergedBases } };
	}
	// `operator-cleared`: valid ONLY while every currently observed hazard basis is covered by `acknowledgedEvidence`.
	const ack = "acknowledgedEvidence" in a.worktreeHazard ? a.worktreeHazard.acknowledgedEvidence : null;
	const uncovered = endoUncoveredHazardBasesV0(snapshot, ack);
	if (uncovered.length === 0) return a;
	const expiredRecord: EndoHazardPriorClearanceV0 = {
		clearedBy: "operator",
		via: "cli",
		clearedAtMs: a.worktreeHazard.clearedAtMs,
		bases: a.worktreeHazard.bases,
		acknowledgedEvidence: ack,
		note: a.worktreeHazard.note,
	};
	const priorClearances =
		"priorClearances" in a.worktreeHazard ? [...a.worktreeHazard.priorClearances, expiredRecord] : [expiredRecord];
	return {
		...a,
		worktreeHazard: {
			state: "liveness-unverified",
			sinceMs: a.worktreeHazard.clearedAtMs,
			bases: currentBases,
			priorClearances,
		},
	};
}

export function endoEffectiveAssignmentV0(
	a: EndoAssignmentV0,
	evidence: (id: string, assignmentId?: string) => EndoAttemptExecutionEvidenceV0,
): EndoAssignmentV0 {
	if (a.state === "active") return a;
	return endoEffectiveAssignmentFromSnapshotV0(a, endoHazardEvidenceSnapshotV0(a, evidence));
}

// ---- the candidate-bound receipt predicate ----------------------------------------------------------------------------------------

export type EndoReceiptSourceV0 =
	| { ok: true; receipts: readonly EndoDevelopReceiptV0[]; problems: number }
	| { ok: false };

export interface EndoCandidateReceiptsInputV0 {
	candidate: Extract<EndoCandidateRefV0, { kind: "git-commit" }>;
	/** Every readable attempt of the candidate's owning task. */
	attempts: readonly EndoAttemptEntryV0[];
	/** The complete receipt read of each of those attempts; anything short of complete is `ok: false`. */
	receipts: (attemptId: string) => EndoReceiptSourceV0;
	/** Whether an unreadable attempt record could belong to this task (it would hide a plan or receipts). */
	attemptRecordsComplete: boolean;
}

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The receipt reading of ONE immutable candidate: `passing` only when every receipt read is complete, at least one receipt ran at the exact
 * (commonDir, commit, tree) with a clean recorded post-check observation, no such receipt reads failed or inconclusive (planned checks read
 * through their plan, so an expected non-zero exit passes), and every planned check of every attempt in scope passed at least once.
 */
export function endoCandidateReceiptReadingV0(input: EndoCandidateReceiptsInputV0): {
	reading: Exclude<EndoCandidateReceiptReadingV0, "not-applicable">;
	reasons: EndoCoordinationDependencyReasonV0[];
} {
	const c = input.candidate;
	if (!input.attemptRecordsComplete) return { reading: "unknown", reasons: ["receipt-read-incomplete"] };
	const readings: { attemptId: string; receipt: EndoDevelopReceiptV0; reading: EndoReceiptOutcomeV0 }[] = [];
	const plans = new Map(input.attempts.map((e) => [e.attempt.id, endoAttemptPlanV0(e.attempt)]));
	for (const entry of input.attempts) {
		const read = input.receipts(entry.attempt.id);
		if (!read.ok || read.problems > 0) return { reading: "unknown", reasons: ["receipt-read-incomplete"] };
		const plan = plans.get(entry.attempt.id) ?? null;
		for (const r of read.receipts) {
			if (
				r.repository.commonDir !== c.commonDir ||
				r.revision.commit !== c.commitSha ||
				r.revision.tree !== c.treeSha
			)
				continue;
			const check = plan?.checks.find((k) => sameArgv(k.argv, r.check.argv));
			const clean = r.after.state === "observed" && r.after.clean;
			const reading = !clean ? "inconclusive" : check === undefined ? r.outcome : endoPlannedReadingV0(check, r);
			readings.push({ attemptId: entry.attempt.id, receipt: r, reading });
		}
	}
	const reasons: EndoCoordinationDependencyReasonV0[] = [];
	if (readings.length === 0) return { reading: "none", reasons: ["no-receipt-for-candidate"] };
	const failed = readings.some((x) => x.reading === "failed");
	const inconclusive = readings.some((x) => x.reading === "inconclusive");
	if (failed) reasons.push("failing-receipt-for-candidate");
	if (inconclusive) reasons.push("inconclusive-receipt-for-candidate");
	// Plans in scope: every attempt with a receipt at this candidate, and the attempt the candidate names.
	const inScope = new Set(readings.map((x) => x.attemptId));
	if (c.attemptId !== null && plans.has(c.attemptId)) inScope.add(c.attemptId);
	for (const attemptId of inScope) {
		const plan = plans.get(attemptId) ?? null;
		if (plan === null) continue;
		for (const check of plan.checks) {
			const mine = readings.filter((x) => x.attemptId === attemptId && sameArgv(x.receipt.check.argv, check.argv));
			if (!mine.some((x) => x.reading === "passed")) {
				if (!reasons.includes("planned-check-not-passed")) reasons.push("planned-check-not-passed");
			}
		}
	}
	if (failed) return { reading: "failing", reasons };
	if (inconclusive) return { reading: "inconclusive", reasons };
	if (reasons.length > 0 || !readings.some((x) => x.reading === "passed")) {
		if (reasons.length === 0) reasons.push("no-receipt-for-candidate");
		return { reading: "none", reasons };
	}
	return { reading: "passing", reasons: [] };
}

// ---- the projection ---------------------------------------------------------------------------------------------------------------

export interface EndoCoordinationTaskFactV0 {
	projectId: string;
	status: EndoDevelopTaskStatusV0;
	revision: number;
}

export interface EndoCoordinationSessionActivityInputV0 {
	lastRecordedAtMs: number | null;
	observedInstanceIds: readonly string[];
	eventsAvailable: boolean;
}

export type EndoCoordinationProjectReviewsInputV0 =
	| { ok: true; reviews: readonly EndoDevelopAdvisoryReviewV0[]; problems: number; truncated: boolean }
	| { ok: false };

export interface EndoCoordinationProjectionInputV0 {
	readAtMs: number;
	requested: readonly string[] | null;
	/** The project ids the task file registers (scope is checked against it). */
	registeredProjects: readonly string[] | null;
	coordination:
		| { state: "absent" }
		| { state: "ready"; file: EndoDevelopCoordinationFileV0 }
		| { state: "unreadable"; reason: string };
	tasks: { ok: true; byId: ReadonlyMap<string, EndoCoordinationTaskFactV0> } | { ok: false };
	attempts:
		| { ok: true; entries: readonly EndoAttemptEntryV0[]; problems: readonly EndoAttemptProblemV0[] }
		| { ok: false; reason?: string };
	receipts: (attemptId: string) => EndoReceiptSourceV0;
	/** Route reservation per attempt, as read now; `unknown` when it could not be read (or is not mounted). */
	route: (attemptId: string) => EndoHazardRouteEvidenceV0;
	/** Optional E2 harness-neutral adapter authorization/abort/outcome reader per attempt. */
	adapterAuthorizations?: (attemptId: string) => EndoAdapterAttemptRecordsV0;
	/** Optional E2 project-scoped advisory reviews map (keyed by projectId). */
	reviews?: ReadonlyMap<string, EndoCoordinationProjectReviewsInputV0>;
	/** Optional E2 offline recorded session activity summary (keyed by sessionKey). Never claims live state. */
	sessionActivity?: ReadonlyMap<string, EndoCoordinationSessionActivityInputV0>;
	/** Re-verification of each candidate by candidate id, done by the caller (Git / protected-run reading), or `unavailable`. */
	identity: ReadonlyMap<string, EndoCandidateIdentityReadingV0>;
	/** The live HEAD of a worktree path, observed now by the caller; absent or null when it was not or could not be. */
	workspaces: ReadonlyMap<string, EndoReceiptCurrentV0 | null>;
	/** Read gaps the caller already knows of (git unavailable in a sandbox, receipts truncated by a budget...). */
	gaps: readonly EndoCoordinationGapV0[];
}

const sorted = <T>(items: readonly T[], key: (x: T) => string): T[] =>
	[...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function workspaceReading(
	c: EndoCandidateRefV0,
	workspaces: ReadonlyMap<string, EndoReceiptCurrentV0 | null>,
): EndoCandidateWorkspaceReadingV0 {
	if (c.kind !== "git-commit") return "not-applicable";
	const now = workspaces.get(c.worktreePath);
	if (now === undefined || now === null) return "unavailable";
	if (now.commonDir !== c.commonDir) return "other-repository";
	if (now.commit !== c.commitSha) return "moved-from-candidate";
	return now.clean ? "matches-candidate" : "dirty-at-candidate";
}

/** Build the companion projection for the projects in scope. Deterministic: sorted, closed codes, no clock reads. */
export function endoCoordinationProjectionV0(input: EndoCoordinationProjectionInputV0): EndoCoordinatorCoordinationV0 {
	const gaps = new Set<EndoCoordinationGapV0>(input.gaps);
	const source: EndoCoordinatorCoordinationV0["source"] =
		input.coordination.state === "ready"
			? { state: "ready", reason: null, revision: input.coordination.file.revision }
			: input.coordination.state === "absent"
				? { state: "absent", reason: null, revision: null }
				: { state: "unreadable", reason: input.coordination.reason, revision: null };
	if (input.coordination.state === "unreadable") gaps.add("coordination-unreadable");
	if (!input.tasks.ok) gaps.add("tasks-unreadable");
	if (!input.attempts.ok) gaps.add("attempts-unreadable");
	const registered = input.registeredProjects === null ? null : new Set(input.registeredProjects);
	const projectIds =
		input.requested !== null
			? [...new Set(input.requested)].sort()
			: registered === null
				? []
				: [...registered].sort();
	if (registered !== null && projectIds.some((p) => !registered.has(p))) gaps.add("unknown-project");
	const file = input.coordination.state === "ready" ? input.coordination.file : null;

	const taskOf = (id: string): EndoCoordinationTaskFactV0 | null | "unknown" =>
		!input.tasks.ok ? "unknown" : (input.tasks.byId.get(id) ?? null);
	const entries = input.attempts.ok ? input.attempts.entries : [];
	const entryById = new Map(entries.map((e) => [e.attempt.id, e]));
	// An attempt record that could not be read but names an attempt: it may belong to any task, and could hide a plan or a receipt.
	const unreadableAttempts = input.attempts.ok
		? input.attempts.problems
				.map((p) => p.claims ?? p.name.split(".", 3).join("."))
				.filter((id) => ENDO_ATTEMPT_ID_PATTERN_V0.test(id))
		: [];
	if (unreadableAttempts.length > 0) gaps.add("attempt-problems");
	const attemptRecordsComplete = input.attempts.ok && unreadableAttempts.length === 0;
	const execution = (id: string, assignmentId?: string): EndoAttemptExecutionEvidenceV0 =>
		endoAttemptExecutionEvidenceFromReadV0(
			id,
			input.attempts,
			input.route(id),
			input.adapterAuthorizations?.(id),
			assignmentId,
		);

	const candidateEntry = new Map((file?.taskCandidates ?? []).map((t) => [t.taskId, t]));
	const receiptReading = new Map<string, ReturnType<typeof endoCandidateReceiptReadingV0>>();
	const readingOf = (c: Extract<EndoCandidateRefV0, { kind: "git-commit" }>, ownerTaskId: string) => {
		const cached = receiptReading.get(c.candidateId);
		if (cached !== undefined) return cached;
		const reading = endoCandidateReceiptReadingV0({
			candidate: c,
			attempts: entries.filter((e) => e.attempt.taskId === ownerTaskId),
			receipts: input.receipts,
			attemptRecordsComplete,
		});
		receiptReading.set(c.candidateId, reading);
		return reading;
	};

	const evaluate = (d: EndoDependencyV0): EndoCoordinationDependencyViewV0 => {
		const reasons: EndoCoordinationDependencyReasonV0[] = [];
		const warnings: EndoCoordinationDependencyWarningV0[] = [];
		const disclosures: EndoCoordinationDependencyViewV0["disclosures"] = [];
		let satisfaction: EndoCoordinationDependencyViewV0["satisfaction"] = "unsatisfied";
		let candidateId: string | null = null;
		const pre = taskOf(d.prerequisiteTaskId);
		const dep = taskOf(d.dependentTaskId);
		const view = () => ({
			dependencyId: d.dependencyId,
			dependentTaskId: d.dependentTaskId,
			prerequisiteTaskId: d.prerequisiteTaskId,
			condition: d.condition,
			satisfaction,
			candidateId,
			reasons: satisfaction === "satisfied" ? [] : reasons,
			warnings,
			disclosures: [...disclosures, "readiness-confers-no-authority" as const],
		});
		if (pre === "unknown" || dep === "unknown") {
			satisfaction = "unknown";
			reasons.push("tasks-unreadable");
			return view();
		}
		if (dep === null) reasons.push("dependent-missing");
		if (pre === null) {
			reasons.push("prerequisite-missing");
			return view();
		}
		if (pre.revision !== d.declaredAt.prerequisiteTaskRevision) warnings.push("prerequisite-changed-since-declared");
		if (dep !== null && dep.revision !== d.declaredAt.dependentTaskRevision)
			warnings.push("dependent-changed-since-declared");
		const met = (): void => {
			if (dep !== null) satisfaction = "satisfied";
		};
		if (d.condition === "operator-task-done") {
			if (pre.status === "done") met();
			else reasons.push("prerequisite-not-done");
			return view();
		}
		if (d.condition === "operator-decision") {
			if (d.operatorDecision === null) reasons.push("no-operator-decision");
			else if (d.operatorDecision.prerequisiteTaskRevision !== pre.revision) reasons.push("operator-decision-stale");
			else met();
			return view();
		}
		const entry = candidateEntry.get(d.prerequisiteTaskId);
		const current = entry?.candidates.find((c) => c.candidateId === entry.currentCandidateId) ?? null;
		if (current === null) {
			reasons.push("no-current-candidate");
			return view();
		}
		candidateId = current.candidateId;
		const identity = input.identity.get(current.candidateId) ?? "unavailable";
		if (identity === "unavailable") {
			satisfaction = "unknown";
			reasons.push("candidate-identity-unavailable");
		} else if (identity !== "verified" && identity !== "established") {
			reasons.push("candidate-identity-failed");
			return view();
		}
		if (current.kind === "git-commit") {
			const ws = workspaceReading(current, input.workspaces);
			if (ws === "unavailable") warnings.push("workspace-unobserved");
			else if (ws !== "matches-candidate") warnings.push("workspace-drifted-from-candidate");
		}
		if (d.condition === "candidate-declared") {
			if (identity !== "unavailable") met();
			return view();
		}
		// candidate-has-passing-receipt
		disclosures.push("receipt-history-unverifiable");
		if (current.kind !== "git-commit") {
			satisfaction = "unsatisfied";
			reasons.push("protected-candidate-has-no-host-receipt");
			return view();
		}
		const reading = readingOf(current, d.prerequisiteTaskId);
		for (const r of reading.reasons) if (!reasons.includes(r)) reasons.push(r);
		if (reading.reading === "unknown") satisfaction = "unknown";
		else if (reading.reading !== "passing") satisfaction = "unsatisfied";
		else if (identity !== "unavailable") met();
		return view();
	};

	// A requested id the task file does not register is a gap, never an (empty) project.
	const listed = registered === null ? projectIds : projectIds.filter((p) => registered.has(p));
	const visible = sorted(
		(file?.assignments ?? [])
			.filter((a) => listed.includes(a.projectId))
			.map((a) => endoEffectiveAssignmentV0(a, execution)),
		(a) => a.assignmentId,
	);
	const conflicts = endoWorktreeConflictsV0(visible);
	const projects: EndoCoordinationProjectViewV0[] = listed.map((projectId) => {
		const assignments = visible.filter((a) => a.projectId === projectId);
		const ids = new Set(assignments.map((a) => a.assignmentId));
		const dependencies = sorted(
			(file?.dependencies ?? []).filter((d) => d.projectId === projectId),
			(d) => d.dependencyId,
		).map(evaluate);
		const taskEntries = sorted(
			(file?.taskCandidates ?? []).filter((t) => t.projectId === projectId),
			(t) => t.taskId,
		);
		const readiness = (taskId: string): EndoCoordinationReadinessV0 => {
			const edges = dependencies.filter((d) => d.dependentTaskId === taskId);
			if (source.state === "unreadable") return "unknown";
			if (edges.length === 0) return "no-dependencies";
			if (edges.some((d) => d.satisfaction === "unknown")) return "unknown";
			if (edges.some((d) => d.satisfaction === "unsatisfied")) return "waiting";
			return edges.some((d) => d.warnings.includes("workspace-drifted-from-candidate"))
				? "ready-for-pinned-candidate"
				: "ready";
		};
		const taskIds = new Set<string>([
			...assignments.map((a) => a.taskId),
			...dependencies.flatMap((d) => [d.dependentTaskId, d.prerequisiteTaskId]),
			...taskEntries.map((t) => t.taskId),
		]);
		const tasks: EndoCoordinationTaskViewV0[] = [...taskIds].sort().map((taskId) => {
			const entry = candidateEntry.get(taskId);
			const supersededIds = new Set(
				(entry?.candidates ?? []).map((c) => c.supersedesCandidateId).filter((x): x is string => x !== null),
			);
			return {
				taskId,
				readiness: readiness(taskId),
				currentCandidateId: entry?.currentCandidateId ?? null,
				candidates: (entry?.candidates ?? []).map((c) => ({
					candidateId: c.candidateId,
					kind: c.kind,
					relation:
						c.candidateId === entry?.currentCandidateId
							? ("current" as const)
							: supersededIds.has(c.candidateId)
								? ("superseded" as const)
								: ("not-selected" as const),
					identity: input.identity.get(c.candidateId) ?? "unavailable",
					workspace: workspaceReading(c, input.workspaces),
					receipts: c.kind === "git-commit" ? readingOf(c, taskId).reading : ("not-applicable" as const),
				})),
			};
		});
		const assignmentViews: EndoCoordinationAssignmentViewV0[] = assignments.map((a) => {
			const findings = new Set<EndoCoordinationAssignmentFindingV0>();
			const task = taskOf(a.taskId);
			const taskBinding =
				task === "unknown"
					? ("unknown" as const)
					: task === null
						? ("task-missing" as const)
						: task.revision !== a.taskRevisionAtBind
							? ("task-stale" as const)
							: ("current" as const);
			if (taskBinding === "task-missing") findings.add("assignment-task-missing");
			if (taskBinding === "task-stale") findings.add("assignment-task-stale");
			let target: EndoCoordinationAssignmentViewV0["targetCandidate"] = null;
			if (a.targetCandidate !== null) {
				const entry = candidateEntry.get(a.targetCandidate.taskId);
				const exists = entry?.candidates.some((c) => c.candidateId === a.targetCandidate?.candidateId) === true;
				const relation = !exists
					? ("candidate-missing" as const)
					: entry?.currentCandidateId === a.targetCandidate.candidateId
						? ("current-candidate" as const)
						: ("superseded-candidate" as const);
				if (relation === "candidate-missing") findings.add("target-candidate-missing");
				if (relation === "superseded-candidate") findings.add("target-candidate-superseded");
				target = { ...a.targetCandidate, relation };
			}
			let sessionView: EndoCoordinationAssignmentViewV0["session"] = null;
			if (a.session !== null) {
				findings.add("session-liveness-unknown");
				if (a.session.instanceId === null) findings.add("session-instance-undeclared");
				const act = input.sessionActivity?.get(a.session.sessionKey);
				const offline = endoOfflineSessionLivenessV0({
					observedAtMs: input.readAtMs,
					source: a.session.source,
					harnessFamily: a.participant.intendedHarnessFamily,
					sessionKey: a.session.sessionKey,
					attachmentId: a.session.attachmentId,
					instanceId: a.session.instanceId,
					runtimeFingerprintId: a.session.runtimeFingerprintId,
					lastRecordedAtMs: act?.lastRecordedAtMs ?? null,
					eventsAvailable: act?.eventsAvailable ?? false,
				});
				let instanceStatus: EndoSessionInstanceStatusV0 = "unverified";
				if (a.session.instanceId === null) {
					instanceStatus = "undeclared";
				} else if (act !== undefined && act.observedInstanceIds.length > 0) {
					const latest = act.observedInstanceIds[act.observedInstanceIds.length - 1];
					if (latest === a.session.instanceId) instanceStatus = "recorded-match";
					else if (act.observedInstanceIds.includes(a.session.instanceId)) {
						instanceStatus = "recorded-instance-superseded";
						findings.add("recorded-instance-superseded");
					} else {
						instanceStatus = "recorded-instance-superseded";
						findings.add("recorded-instance-superseded");
					}
				}
				sessionView = {
					source: a.session.source,
					sessionKey: a.session.sessionKey,
					standing: "operator-declared",
					liveness: "unknown",
					livenessState: offline.state as "liveness-unknown" | "stale-observation" | "unsupported-observation",
					observationMode: "offline-projection",
					terminationConfirmed: false,
					lastRecordedAtMs: act?.lastRecordedAtMs ?? null,
					instanceStatus,
				};
			}
			const attempts = a.attemptIds.map((attemptId) => {
				const e = execution(attemptId);
				const adapterRec = input.adapterAuthorizations?.(attemptId);
				const entry = entryById.get(attemptId);
				const link = !input.attempts.ok
					? ("unknown" as const)
					: entry === undefined
						? ("missing" as const)
						: entry.attempt.taskId !== a.taskId
							? ("other-task" as const)
							: ("resolved" as const);
				let ran: EndoCoordinationAssignmentViewV0["attempts"][number]["execution"];
				if (e.authorization.state === "authorized") {
					ran = "workbench-authorized";
				} else if (e.authorization.state === "adapter-authorized") {
					if (e.authorization.aborted) ran = "aborted-before-transport";
					else if (adapterRec?.outcome.state === "present") {
						const st = adapterRec.outcome.record.status;
						ran =
							st === "accepted" ? "adapter-accepted" : st === "refused" ? "adapter-refused" : "adapter-unknown";
					} else {
						ran = "adapter-authorized";
					}
				} else if (e.route.state === "claimed") {
					ran = "route-claimed";
				} else if (e.authorization.state === "unknown" || e.route.state === "unknown") {
					ran = "unknown";
				} else {
					ran = "none-recorded";
				}
				if (link === "missing" || link === "other-task") findings.add("attempt-link-unresolved");
				if (
					ran === "workbench-authorized" ||
					ran === "adapter-authorized" ||
					ran === "adapter-accepted" ||
					ran === "adapter-refused" ||
					ran === "adapter-unknown" ||
					ran === "aborted-before-transport" ||
					ran === "route-claimed"
				)
					findings.add("attempt-execution-recorded");
				if (e.authorization.state === "unknown" || e.route.state === "unknown")
					findings.add("attempt-evidence-unknown");
				return { attemptId, link, execution: ran };
			});
			if (a.state === "active") {
				const r = readiness(a.taskId);
				if (r === "waiting") findings.add("prerequisites-not-satisfied");
				if (r === "unknown") findings.add("prerequisites-unknown");
			}
			if (a.worktreeHazard.state === "liveness-unverified") {
				findings.add("worktree-liveness-unverified");
				if ((a.worktreeHazard.priorClearances?.length ?? 0) > 0) findings.add("hazard-clearance-expired");
			}
			if (a.workspace.registration === "same-repository-unregistered") findings.add("worktree-not-registered");
			if (
				a.state !== "active" &&
				a.worktreeHazard.state !== "operator-cleared" &&
				(a.session !== null || a.attemptIds.length > 0)
			)
				findings.add("ended-without-process-confirmation");
			return {
				assignmentId: a.assignmentId,
				taskId: a.taskId,
				state: a.state,
				revision: a.revision,
				participantId: a.participant.participantId,
				role: a.participant.role,
				intendedHarnessFamily: a.participant.intendedHarnessFamily,
				taskBinding,
				session: sessionView,
				workspace: {
					worktreePath: a.workspace.worktreePath,
					registration: a.workspace.registration,
					accessIntent: a.workspace.accessIntent,
					sharedWorktreeAcknowledged: a.workspace.sharedWorktreeAcknowledged,
				},
				hazard: a.worktreeHazard.state,
				targetCandidate: target,
				attempts,
				findings: [...findings].sort(),
			};
		});
		const registeredWorktrees: EndoCoordinationRegisteredWorktreeViewV0[] = sorted(
			(file?.registeredWorktrees ?? []).filter((w) => w.projectId === projectId),
			(w) => w.worktreeId,
		).map((w) => {
			const obs = input.workspaces.get(w.worktreePath);
			if (obs === undefined || obs === null) {
				return {
					worktreeId: w.worktreeId,
					worktreePath: w.worktreePath,
					label: w.label,
					observation: "unavailable",
					headCommit: null,
					clean: null,
				};
			}
			if (obs.commonDir !== w.commonDir || obs.worktree !== w.worktreePath) {
				return {
					worktreeId: w.worktreeId,
					worktreePath: w.worktreePath,
					label: w.label,
					observation: "mismatch",
					headCommit: null,
					clean: null,
				};
			}
			return {
				worktreeId: w.worktreeId,
				worktreePath: w.worktreePath,
				label: w.label,
				observation: "observed",
				headCommit: obs.commit,
				clean: obs.clean,
			};
		});
		const projectReviewsInput = input.reviews?.get(projectId);
		const reviewViews: EndoCoordinationReviewViewV0[] = [];
		if (projectReviewsInput !== undefined) {
			if (!projectReviewsInput.ok) {
				gaps.add("reviews-unreadable");
			} else {
				if (projectReviewsInput.problems > 0) gaps.add("reviews-unreadable");
				if (projectReviewsInput.truncated) gaps.add("reviews-truncated");
				for (const rv of sorted(projectReviewsInput.reviews, (r) => r.reviewId)) {
					if (rv.projectId !== projectId) continue;
					const owner = candidateEntry.get(rv.candidateTaskId);
					const exists = owner?.candidates.some((c) => c.candidateId === rv.candidateId) === true;
					const candidateRelation = !exists
						? ("candidate-missing" as const)
						: owner?.currentCandidateId === rv.candidateId
							? ("current-candidate" as const)
							: ("superseded-candidate" as const);
					const findingCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
					for (const f of rv.findings) findingCounts[f.severity] += 1;
					reviewViews.push({
						reviewId: rv.reviewId,
						candidateTaskId: rv.candidateTaskId,
						candidateId: rv.candidateId,
						candidateKind: rv.subject.kind,
						candidateRelation,
						standing: "advisory-agent-review",
						basis: "agent-reported",
						verdict: rv.verdict,
						findingCounts,
						checkoutStanding: rv.checkout.standing,
						checkoutCleanAtCandidate: rv.checkout.cleanAtCandidate,
						agentClaimedChecksPresent: rv.agentClaimedChecks !== null,
						reviewerParticipantId: rv.reviewer.participantId,
						reviewerHarnessFamily: rv.reviewer.harnessFamily,
						assignmentId: rv.assignmentId,
						recordedAtMs: rv.recordedAtMs,
						disclosures: [...ENDO_REVIEW_DISCLOSURES_V0],
					});
				}
			}
		}
		return {
			id: projectId,
			assignments: assignmentViews,
			dependencies,
			tasks,
			conflicts: conflicts.filter((c) => c.assignmentIds.some((id) => ids.has(id))),
			registeredWorktrees,
			reviews: reviewViews,
		};
	});
	return {
		schemaVersion: ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
		readAtMs: input.readAtMs,
		authority: { ...ENDO_COORDINATION_PROJECTION_AUTHORITY_V0 },
		basis: { liveness: "not-observed", consistency: "per-file-snapshot", attribution: "unsigned-local-record" },
		scope: { requested: input.requested === null ? null : [...new Set(input.requested)].sort() },
		source,
		projects,
		gaps: [...gaps].sort(),
	};
}

const hintsOverlap = (a: readonly string[], b: readonly string[]): boolean =>
	a.some((x) => b.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

/** Read-side conflict findings for one project's assignments (§10): reported, never resolved, never cleared by time. */
export function endoWorktreeConflictsV0(assignments: readonly EndoAssignmentV0[]): EndoCoordinationConflictViewV0[] {
	const out: EndoCoordinationConflictViewV0[] = [];
	const byPath = new Map<string, EndoAssignmentV0[]>();
	for (const a of assignments)
		byPath.set(a.workspace.worktreePath, [...(byPath.get(a.workspace.worktreePath) ?? []), a]);
	for (const [worktreePath, group] of [...byPath].sort(([x], [y]) => (x < y ? -1 : 1))) {
		const ids = (xs: readonly EndoAssignmentV0[]) => xs.map((a) => a.assignmentId).sort();
		const writers = group.filter(endoOccupiesWorktreeV0);
		const readers = group.filter((a) => a.state === "active" && a.workspace.accessIntent === "read-only-intended");
		const hazardous = group.filter((a) => a.worktreeHazard.state === "liveness-unverified");
		if (hazardous.length > 0)
			out.push({ kind: "worktree-liveness-unverified", worktreePath, assignmentIds: ids(hazardous) });
		if (writers.length >= 2) {
			// E2 remediation of E1 §10.6 boolean sharedWorktreeAcknowledged limit:
			// Every occupying writer pair (x, y) must be explicitly acknowledged by ID when E2 `acknowledgedConflictIds`
			// metadata is present on either assignment, preventing an earlier boolean acknowledgement on an ended
			// writer from silently excusing a new or reactivated unacknowledged overlap.
			// Falls back to the legacy E1 counted rule ONLY when neither writer in the pair carries `acknowledgedConflictIds`.
			let allPairsAcknowledged = true;
			const hasAnyExplicitIds = writers.some((w) => w.workspace.acknowledgedConflictIds !== undefined);
			if (hasAnyExplicitIds) {
				for (let i = 0; i < writers.length && allPairsAcknowledged; i += 1) {
					for (let j = i + 1; j < writers.length; j += 1) {
						const x = writers[i] as EndoAssignmentV0;
						const y = writers[j] as EndoAssignmentV0;
						const pairExplicit =
							x.workspace.acknowledgedConflictIds !== undefined ||
							y.workspace.acknowledgedConflictIds !== undefined;
						if (pairExplicit) {
							const acked =
								x.workspace.acknowledgedConflictIds?.includes(y.assignmentId) === true ||
								y.workspace.acknowledgedConflictIds?.includes(x.assignmentId) === true;
							if (!acked) {
								allPairsAcknowledged = false;
								break;
							}
						} else if (!x.workspace.sharedWorktreeAcknowledged && !y.workspace.sharedWorktreeAcknowledged) {
							allPairsAcknowledged = false;
							break;
						}
					}
				}
			} else {
				allPairsAcknowledged = writers.filter((a) => !a.workspace.sharedWorktreeAcknowledged).length <= 1;
			}
			out.push({
				kind: allPairsAcknowledged
					? "shared-writable-worktree-acknowledged"
					: "unacknowledged-worktree-write-overlap",
				worktreePath,
				assignmentIds: ids(writers),
			});
			for (let i = 0; i < writers.length; i++)
				for (let j = i + 1; j < writers.length; j++) {
					const x = writers[i] as EndoAssignmentV0;
					const y = writers[j] as EndoAssignmentV0;
					if (hintsOverlap(x.workspace.pathHints, y.workspace.pathHints))
						out.push({ kind: "path-hint-overlap", worktreePath, assignmentIds: ids([x, y]) });
				}
		}
		if (writers.length >= 1 && readers.length >= 1)
			out.push({ kind: "shared-mutable-worktree", worktreePath, assignmentIds: ids([...writers, ...readers]) });
	}
	return out;
}
