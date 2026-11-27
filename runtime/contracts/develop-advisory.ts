// The pure S2 runtime contract (`COORDINATOR-AUTOMATION-S2`, docs/designs/coordinator-automation-s2-implementation.md): the
// semantic wake digest, the wake gate, authorization standing, budget accounting, effective-pool narrowing, and the proposal extractor
// with its deterministic grounding rules. Nothing here performs I/O, reads a clock, or calls a model.
//
// The semantic digest exists because S1's `statusSha256` / `coordinationSha256` hash whole projections that carry `readAtMs`, per-section
// `freshness.observedAtMs` / `ageMs`, event counts and last-event times: they change on every read, so they cannot gate inference.
// Those integrity digests are left exactly as they are; the semantic digest is a separate, versioned, allow-listed projection.

import type { EndoCoordinatorCoordinationV0 } from "../../protocol/coordinator-coordination.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
	type EndoCoordinatorModelPoolAnyV1,
	orderedCoordinatorPoolMembersV0,
	parseEndoCoordinatorModelPoolV0,
	parseEndoCoordinatorModelPoolV1,
} from "../../protocol/coordinator-model-pool.ts";
import {
	ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1,
	type EndoCoordinatorResourceProfileV1,
} from "../../protocol/coordinator-resource-policy.ts";
import type { EndoCoordinatorStatusV0 } from "../../protocol/coordinator-status.ts";
import {
	ENDO_ADVISORY_LIMITS_V0,
	ENDO_ADVISORY_PROPOSAL_KINDS_V0,
	type EndoAdvisoryActionKindV0,
	type EndoAdvisoryAuthorizationsFileV0,
	type EndoAdvisoryAuthorizationV0,
	type EndoAdvisoryBriefingV0,
	type EndoAdvisoryBudgetV0,
	type EndoAdvisoryEvidenceFactRecordV0,
	type EndoAdvisoryObservationCompletenessV0,
	type EndoAdvisoryPolicyV0,
	type EndoAdvisoryProposalKindV0,
	type EndoAdvisoryProposalRefusalV0,
	type EndoAdvisoryReservationV0,
	type EndoAdvisoryScheduleCursorV0,
	type EndoAdvisoryScheduleV0,
	type EndoAdvisoryTurnAdmissionV0,
	type EndoAdvisoryTurnDispatchV0,
	type EndoAdvisoryWakePolicyV0,
	type EndoAdvisoryWakeReasonV0,
} from "../../protocol/develop-advisory.ts";
import { ENDO_TASK_ID_PATTERN_V0 } from "../../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import { ENDO_COORDINATOR_INSTRUCTIONS_V0 } from "./coordinator-brief.ts";
import { coordinatorModelPoolSha256V0, endoCoordinatorResourceProfileSha256V1 } from "./coordinator-model-pool.ts";

const L = ENDO_ADVISORY_LIMITS_V0;
const digest = (value: unknown): string => sha256HexV0(canonicalEndoJsonV0(value as never));
const byKey =
	<T>(key: (v: T) => string) =>
	(a: T, b: T) =>
		key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

// ---- Fire keys ---------------------------------------------------------------------------------------------------------------------

/** S2's fire key: S1's construction under its own schema tag, so an advisory fire and an S1 fire can never share a key. */
export function endoAdvisoryFireIdempotencyKeyV0(args: {
	readonly scheduleId: string;
	readonly scheduleIncarnation: string;
	readonly windowStartMs: number;
	readonly triggerCursor: string;
}): string {
	return digest({
		schema: "endo.advisory-fire-key.v0",
		scheduleId: args.scheduleId,
		scheduleIncarnation: args.scheduleIncarnation,
		windowStartMs: args.windowStartMs,
		triggerCursor: args.triggerCursor,
	});
}

// ---- Semantic digest ---------------------------------------------------------------------------------------------------------------

export const ENDO_ADVISORY_SEMANTIC_DIGEST_SCHEMA_V0 = "endo.coordinator-semantic-digest.v0";

/** Finding codes driven only by elapsed time (a quiet session ageing past staleAfterMs), excluded from the semantic state. */
const TIME_DRIVEN_FINDINGS = new Set(["session-recorded-open-but-stale"]);
/** Findings that mean some evidence was not read: they make an observation partial. */
const UNREAD_EVIDENCE_FINDINGS = new Set([
	"tasks-unavailable",
	"attempts-unavailable",
	"attempt-records-unusable",
	"attempt-records-missing",
	"receipt-records-missing",
	"event-log-unavailable",
	"event-log-incomplete",
	"project-head-unavailable",
	"sessions-truncated",
]);
/** Attention kinds driven only by elapsed time. */
const TIME_DRIVEN_ATTENTION = new Set(["evidence-stale"]);

export interface EndoAdvisorySemanticObservationV0 {
	readonly projectId: string;
	readonly completeness: EndoAdvisoryObservationCompletenessV0;
	/** Null only when completeness is `unavailable`. */
	readonly semanticDigest: string | null;
	readonly gaps: readonly string[];
}

/**
 * The allow-listed semantic state of ONE project: operator-declared task facts, controller-observed verification results, recorded
 * session states, assignments, dependencies, candidates, conflicts, reviews and worktree observations. Excluded by construction:
 * every read time, freshness timestamp and age, event counts and activity lists, last-event times, unlisted-session counts
 * (another project's activity), and time-driven staleness findings. A field added to the projections later is excluded until it is
 * deliberately added here (a missed wake is recoverable through a digest window; a spurious wake costs inference).
 */
export function endoAdvisorySemanticStateV0(
	projectId: string,
	status: EndoCoordinatorStatusV0,
	coordination: EndoCoordinatorCoordinationV0,
): {
	readonly state: unknown;
	readonly completeness: EndoAdvisoryObservationCompletenessV0;
	readonly gaps: readonly string[];
} {
	const gaps = new Set<string>();
	const project = status.projects.find((p) => p.id === projectId);
	if (project === undefined || status.scope.unknown.includes(projectId)) gaps.add("project-unknown");
	for (const [name, source] of Object.entries(status.sources)) {
		if (source.state === "partial" || source.state === "unavailable" || source.state === "missing")
			gaps.add(`status-${name}-${source.state}`);
	}
	if (status.sources.tasks.state === "missing") gaps.add("status-tasks-missing");
	if (coordination.source.state === "unreadable") gaps.add("coordination-unreadable");
	// Evidence that was not read (missing or unusable records, truncated or unavailable sources) is a gap even when the source itself
	// reads "ready": an absent attempt record is not an empty attempt history.
	for (const f of status.findings)
		if (UNREAD_EVIDENCE_FINDINGS.has(f.code) || f.severity === "unavailable" || f.severity === "incomplete")
			gaps.add(`finding-${f.code}`);
	for (const g of coordination.gaps) gaps.add(`coordination-${g}`);
	const coordProject = coordination.projects.find((p) => p.id === projectId) ?? null;
	const unavailable =
		gaps.has("project-unknown") || gaps.has("status-tasks-missing") || gaps.has("status-tasks-unavailable");
	const completeness: EndoAdvisoryObservationCompletenessV0 = unavailable
		? "unavailable"
		: gaps.size > 0
			? "partial"
			: "complete";
	const tasks = (project?.tasks ?? [])
		.map((t) => ({
			taskId: t.taskId,
			status: t.status,
			revision: t.revision,
			attempts: {
				count: t.attempts.count,
				latest:
					t.attempts.latest === null
						? null
						: {
								id: t.attempts.latest.id,
								state: t.attempts.latest.state,
								sendAuthorized: t.attempts.latest.sendAuthorized,
							},
			},
			verification: {
				state: t.verification.state,
				receiptReadComplete: t.verification.receiptReadComplete,
				incomplete: t.verification.incomplete,
				results: t.verification.results
					.map((r) => ({
						command: r.command,
						reading: r.reading,
						outcome: r.outcome,
						relation: r.relation,
						attemptId: r.attemptId,
						receiptId: r.receiptId,
						commit: r.commit,
					}))
					.sort(byKey((r) => `${r.attemptId}:${r.receiptId ?? ""}:${r.command}`)),
				moreResults: t.verification.moreResults,
			},
			gaps: t.gaps.map((g) => g.code).sort(),
			sessions: t.sessions
				.map((s) => ({ sessionId: s.sessionId, via: s.via, inLog: s.inLog }))
				.sort(byKey((s) => `${s.sessionId}:${s.via}`)),
			association: t.association,
		}))
		.sort(byKey((t) => t.taskId));
	const sessions = status.sessions
		.map((s) => ({
			sessionId: s.sessionId,
			runtime: s.runtime,
			recordedState: s.recordedState,
			openRun: s.openRun !== null,
			lastRunOutcome: s.lastRun?.outcome ?? null,
			association: s.association,
		}))
		.sort(byKey((s) => s.sessionId));
	const attention = status.attention
		.filter((a) => !TIME_DRIVEN_ATTENTION.has(a.kind))
		.map((a) => ({ kind: a.kind, subject: a.subject }))
		.sort(byKey((a) => `${a.kind}:${a.subject ?? ""}`));
	const findings = status.findings
		.filter((f) => !TIME_DRIVEN_FINDINGS.has(f.code))
		.map((f) => ({ code: f.code, severity: f.severity, subject: f.subject }))
		.sort(byKey((f) => `${f.code}:${f.subject ?? ""}`));
	const coord =
		coordProject === null
			? null
			: {
					assignments: coordProject.assignments
						.map((a) => ({
							assignmentId: a.assignmentId,
							taskId: a.taskId,
							state: a.state,
							revision: a.revision,
							participantId: a.participantId,
							role: a.role,
							intendedHarnessFamily: a.intendedHarnessFamily,
							taskBinding: a.taskBinding,
							session:
								a.session === null
									? null
									: {
											source: a.session.source,
											sessionKey: a.session.sessionKey,
											instanceStatus: a.session.instanceStatus ?? null,
										},
							workspace: a.workspace,
							hazard: a.hazard,
							targetCandidate: a.targetCandidate,
							attempts: [...a.attempts].sort(byKey((x) => x.attemptId)),
							findings: [...a.findings].sort(),
						}))
						.sort(byKey((a) => a.assignmentId)),
					dependencies: coordProject.dependencies
						.map((d) => ({
							...d,
							reasons: [...d.reasons].sort(),
							warnings: [...d.warnings].sort(),
							disclosures: [...d.disclosures].sort(),
						}))
						.sort(byKey((d) => d.dependencyId)),
					tasks: coordProject.tasks
						.map((t) => ({ ...t, candidates: [...t.candidates].sort(byKey((c) => c.candidateId)) }))
						.sort(byKey((t) => t.taskId)),
					conflicts: coordProject.conflicts
						.map((c) => ({
							kind: c.kind,
							worktreePath: c.worktreePath,
							assignmentIds: [...c.assignmentIds].sort(),
						}))
						.sort(byKey((c) => `${c.kind}:${c.worktreePath}`)),
					registeredWorktrees: (coordProject.registeredWorktrees ?? [])
						.map((w) => ({
							worktreeId: w.worktreeId,
							worktreePath: w.worktreePath,
							observation: w.observation,
							headCommit: w.headCommit,
							clean: w.clean,
						}))
						.sort(byKey((w) => w.worktreeId)),
					reviews: (coordProject.reviews ?? [])
						.map(({ recordedAtMs: _recordedAtMs, ...rest }) => ({
							...rest,
							disclosures: [...rest.disclosures].sort(),
						}))
						.sort(byKey((r) => r.reviewId)),
				};
	const state = {
		schema: ENDO_ADVISORY_SEMANTIC_DIGEST_SCHEMA_V0,
		projectId,
		sources: {
			tasks: status.sources.tasks.state,
			attempts: status.sources.attempts.state,
			events: status.sources.events.state,
		},
		head: project?.head ?? null,
		tasks,
		sessions,
		attention,
		findings,
		coordination: { source: coordination.source.state, gaps: [...coordination.gaps].sort(), project: coord },
	};
	return { state, completeness, gaps: [...gaps].sort().slice(0, L.maxGaps) };
}

export function endoAdvisorySemanticObservationV0(
	projectId: string,
	status: EndoCoordinatorStatusV0,
	coordination: EndoCoordinatorCoordinationV0,
): EndoAdvisorySemanticObservationV0 {
	const { state, completeness, gaps } = endoAdvisorySemanticStateV0(projectId, status, coordination);
	return Object.freeze({
		projectId,
		completeness,
		semanticDigest: completeness === "unavailable" ? null : digest(state),
		gaps: Object.freeze(gaps),
	});
}

// ---- Wake gate ---------------------------------------------------------------------------------------------------------------------

export type EndoAdvisoryWakeDecisionV0 =
	| { readonly admit: true; readonly reason: EndoAdvisoryWakeReasonV0 }
	| {
			readonly admit: false;
			readonly status: "skipped-unchanged" | "skipped-already-attempted" | "skipped-observation-incomplete";
			readonly detail: string;
	  };

/**
 * Deterministic wake admission. A wake reason is necessary for a turn but never sufficient: authorization, model eligibility, the
 * uncertainty policy and the budget are checked independently. A failed, refused, withheld or unknown turn sets only
 * `lastAttemptedSemanticDigest`, so the same state never re-wakes an `on-change` schedule (no automatic replay), and is never
 * represented as considered.
 */
export function endoAdvisoryWakeDecisionV0(args: {
	readonly wake: EndoAdvisoryWakePolicyV0;
	readonly cursor: EndoAdvisoryScheduleCursorV0;
	readonly observation: EndoAdvisorySemanticObservationV0;
	readonly permitPartialObservation: boolean;
}): EndoAdvisoryWakeDecisionV0 {
	const { observation, cursor } = args;
	if (observation.completeness === "unavailable" || observation.semanticDigest === null)
		return { admit: false, status: "skipped-observation-incomplete", detail: "observation unavailable" };
	if (observation.completeness === "partial" && !args.permitPartialObservation)
		return {
			admit: false,
			status: "skipped-observation-incomplete",
			detail: "observation partial and policy requires complete",
		};
	if (args.wake === "digest-window") return { admit: true, reason: "digest-window" };
	if (observation.semanticDigest === cursor.lastConsideredSemanticDigest)
		return {
			admit: false,
			status: "skipped-unchanged",
			detail: "semantic state unchanged since the last considered briefing",
		};
	if (observation.semanticDigest === cursor.lastAttemptedSemanticDigest)
		return {
			admit: false,
			status: "skipped-already-attempted",
			detail: "semantic state unchanged since an attempt that did not publish a current briefing",
		};
	return {
		admit: true,
		reason:
			cursor.lastConsideredSemanticDigest === null && cursor.lastAttemptedSemanticDigest === null
				? "first-observation"
				: "state-changed",
	};
}

// ---- Authorization ----------------------------------------------------------------------------------------------------------------

export const endoAdvisoryPolicySha256V0 = (policy: EndoAdvisoryPolicyV0): string =>
	digest({ schema: "endo.advisory-policy.v0", policy });
export const endoAdvisoryBudgetSha256V0 = (budget: EndoAdvisoryBudgetV0): string =>
	digest({ schema: "endo.advisory-budget.v0", budget });

/** The identity of a grant: every bound input, so a change to any of them is a different authorization. */
export function endoAdvisoryAuthorizationIdV0(grant: {
	readonly scheduleId: string;
	readonly scheduleIncarnation: string;
	readonly scheduleRevision: number;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly poolSha256: string;
	readonly resourceProfile?: EndoCoordinatorResourceProfileV1;
	readonly resourceProfileSha256?: string;
	readonly policy: EndoAdvisoryPolicyV0;
	readonly budget: EndoAdvisoryBudgetV0;
	readonly grantedAtMs: number;
	readonly expiresAtMs: number;
}): string {
	return digest({
		schema: "endo.advisory-authorization-id.v0",
		scheduleId: grant.scheduleId,
		scheduleIncarnation: grant.scheduleIncarnation,
		scheduleRevision: grant.scheduleRevision,
		projectId: grant.projectId,
		actionKind: grant.actionKind,
		poolSha256: grant.poolSha256,
		...(grant.resourceProfile === undefined
			? {}
			: { resourceProfile: grant.resourceProfile, resourceProfileSha256: grant.resourceProfileSha256 }),
		policy: grant.policy,
		budget: grant.budget,
		grantedAtMs: grant.grantedAtMs,
		expiresAtMs: grant.expiresAtMs,
	});
}

export type EndoAdvisoryAuthorizationRefusalV0 =
	| "no-authorization"
	| "authorization-revoked"
	| "authorization-expired"
	| "authorization-not-yet-valid"
	| "schedule-revision-mismatch"
	| "project-mismatch"
	| "action-mismatch"
	| "pool-digest-mismatch"
	| "resource-profile-digest-mismatch"
	| "authorization-id-mismatch";

export type EndoAdvisoryAuthorizationStandingV0 =
	| { readonly ok: true; readonly authorization: EndoAdvisoryAuthorizationV0 }
	| { readonly ok: false; readonly refusal: EndoAdvisoryAuthorizationRefusalV0 };

/**
 * The effective authorization for a schedule at `nowMs`: the single unrevoked grant for its id, which must bind exactly the schedule's
 * current revision, project and action, a pool whose stored content still hashes to its bound digest, and a live validity window.
 * A grant for an earlier revision is never inherited by a later one, whatever changed.
 */
export function endoAdvisoryAuthorizationStandingV0(args: {
	readonly schedule: Pick<
		EndoAdvisoryScheduleV0,
		"scheduleId" | "incarnation" | "revision" | "projectId" | "actionKind"
	>;
	readonly file: EndoAdvisoryAuthorizationsFileV0 | null;
	readonly nowMs: number;
}): EndoAdvisoryAuthorizationStandingV0 {
	const forSchedule = (args.file?.authorizations ?? []).filter((a) => a.scheduleId === args.schedule.scheduleId);
	const live = forSchedule.find((a) => a.revokedAtMs === null);
	if (live === undefined)
		return { ok: false, refusal: forSchedule.length > 0 ? "authorization-revoked" : "no-authorization" };
	if (endoAdvisoryAuthorizationIdV0(live) !== live.authorizationId)
		return { ok: false, refusal: "authorization-id-mismatch" };
	if (coordinatorModelPoolSha256V0(live.pool) !== live.poolSha256)
		return { ok: false, refusal: "pool-digest-mismatch" };
	if (
		live.resourceProfile !== undefined &&
		endoCoordinatorResourceProfileSha256V1(live.resourceProfile) !== live.resourceProfileSha256
	)
		return { ok: false, refusal: "resource-profile-digest-mismatch" };
	if (live.scheduleIncarnation !== args.schedule.incarnation || live.scheduleRevision !== args.schedule.revision)
		return { ok: false, refusal: "schedule-revision-mismatch" };
	if (live.projectId !== args.schedule.projectId) return { ok: false, refusal: "project-mismatch" };
	if (live.actionKind !== args.schedule.actionKind) return { ok: false, refusal: "action-mismatch" };
	if (args.nowMs < live.grantedAtMs) return { ok: false, refusal: "authorization-not-yet-valid" };
	if (args.nowMs >= live.expiresAtMs) return { ok: false, refusal: "authorization-expired" };
	return { ok: true, authorization: live };
}

/**
 * The pool a scheduled turn may select from: the authorised pool narrowed (never widened) by the grant. Members whose per-completion
 * bound exceeds the grant's ceiling are removed, and `unconfirmedModel` is `permit` only when both the pool and the grant permit it.
 */
/** Members of the authorised pool, in M1 order, that the grant excluded before selection (reported as skipped, never hidden). */
export function endoAdvisoryExcludedMembersV0(authorization: EndoAdvisoryAuthorizationV0): readonly string[] {
	const kept = new Set((endoAdvisoryEffectivePoolV0(authorization)?.members ?? []).map((m) => m.memberId));
	return orderedCoordinatorPoolMembersV0(authorization.pool)
		.map((m) => m.memberId)
		.filter((id) => !kept.has(id));
}

export function endoAdvisoryEffectivePoolV0(
	authorization: EndoAdvisoryAuthorizationV0,
): EndoCoordinatorModelPoolAnyV1 | null {
	const maxTimeoutMs = authorization.resourceProfile?.modelExecutionTimeoutMs;
	const minOutputTokens =
		authorization.resourceProfile?.reasoningControl.mode === "reasoning-budget-tokens"
			? authorization.resourceProfile.reasoningControl.tokens +
				ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.minVisibleHeadroomTokens
			: 0;
	const eligible = (m: EndoCoordinatorModelPoolAnyV1["members"][number]) =>
		m.kind === "local-openai-compat" &&
		m.maxOutputTokens <= authorization.budget.maxOutputTokensPerRequest &&
		m.maxOutputTokens >= minOutputTokens &&
		(maxTimeoutMs === undefined || m.timeoutMs <= maxTimeoutMs);
	// Narrowing must not turn "only the first member" into an undisclosed fallback: under fallback "none" the pool's first member is
	// the only candidate, and if the grant excludes it nothing is eligible.
	const members =
		authorization.pool.selection.fallback === "none"
			? orderedCoordinatorPoolMembersV0(authorization.pool).slice(0, 1).filter(eligible)
			: authorization.pool.members.filter(eligible);
	if (members.length === 0) return null;
	const selection = {
		fallback: authorization.pool.selection.fallback,
		unconfirmedModel:
			authorization.pool.selection.unconfirmedModel === "permit" && authorization.policy.permitModelUnconfirmed
				? "permit"
				: "refuse",
	};
	if (authorization.pool.schemaVersion === ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1) {
		return parseEndoCoordinatorModelPoolV1({
			schemaVersion: authorization.pool.schemaVersion,
			selection,
			resourceProfile: authorization.pool.resourceProfile,
			members: members.map((m) => ({ ...m })),
		});
	}
	return parseEndoCoordinatorModelPoolV0({
		schemaVersion: authorization.pool.schemaVersion,
		selection,
		members: members.map((m) => ({ ...m })),
	});
}

// ---- Budget ------------------------------------------------------------------------------------------------------------------------

export function endoAdvisoryReservationV0(budget: EndoAdvisoryBudgetV0): EndoAdvisoryReservationV0 {
	return Object.freeze({
		completionRequests: budget.completionRequestsPerTurn,
		generatedTokens: budget.completionRequestsPerTurn * budget.maxOutputTokensPerRequest,
		wallClockMs: budget.maxTurnWallClockMs,
	});
}

export interface EndoAdvisoryLedgerTurnV0 {
	readonly admission: EndoAdvisoryTurnAdmissionV0;
	readonly dispatch: EndoAdvisoryTurnDispatchV0 | null;
	readonly briefing: EndoAdvisoryBriefingV0 | null;
}

/**
 * How one turn is charged, in the units the budget counts:
 * - `settled`: a terminal briefing exists. A turn refused before dispatch charges nothing; otherwise it charges one turn, the
 *   relay-admitted completion requests, and the generated tokens recorded at publication (confirmed usage only when every exchange
 *   reported it, else the full reservation).
 * - `in-flight`: admitted under the current, unexpired advisory lease and not settled: charged at its full reservation.
 * - `uncertain`: a dispatch record exists and no terminal record does (a crash or a superseded writer): charged at its full
 *   reservation for the whole period. It is never released and never retried.
 * - `never-dispatched`: admitted, no dispatch record, and its lease is gone, so the dispatch gate (which fences on the lease) can no
 *   longer pass: charged nothing.
 */
export type EndoAdvisoryTurnChargeStateV0 = "settled" | "in-flight" | "uncertain" | "never-dispatched";

export function endoAdvisoryTurnChargeV0(
	turn: EndoAdvisoryLedgerTurnV0,
	currentLease: { readonly epoch: number; readonly active: boolean } | null,
): {
	readonly state: EndoAdvisoryTurnChargeStateV0;
	readonly turns: number;
	readonly generatedTokens: number;
	readonly completionRequests: number;
} {
	const reserved = turn.admission.reservation;
	if (turn.briefing !== null) {
		if (turn.briefing.availability === "not-dispatched")
			return { state: "settled", turns: 0, generatedTokens: 0, completionRequests: 0 };
		return {
			state: "settled",
			turns: 1,
			generatedTokens: turn.briefing.accounting.chargedGeneratedTokens,
			completionRequests: turn.briefing.accounting.chargedCompletionRequests,
		};
	}
	if (turn.dispatch !== null)
		return {
			state: "uncertain",
			turns: 1,
			generatedTokens: reserved.generatedTokens,
			completionRequests: reserved.completionRequests,
		};
	const sameLeaseLive = currentLease?.active === true && currentLease.epoch === turn.admission.leaseEpoch;
	if (sameLeaseLive)
		return {
			state: "in-flight",
			turns: 1,
			generatedTokens: reserved.generatedTokens,
			completionRequests: reserved.completionRequests,
		};
	return { state: "never-dispatched", turns: 0, generatedTokens: 0, completionRequests: 0 };
}

export interface EndoAdvisoryBudgetStandingV0 {
	readonly periodStartMs: number;
	readonly periodMs: number;
	readonly turnsCharged: number;
	readonly maxTurnsPerPeriod: number;
	readonly generatedTokensCharged: number;
	readonly maxGeneratedTokensPerPeriod: number;
	readonly uncertainTurns: number;
	readonly inFlightTurns: number;
	readonly reservation: EndoAdvisoryReservationV0;
	readonly admissible: boolean;
	readonly refusal: "turns-exhausted" | "generated-tokens-exhausted" | null;
}

/**
 * Budget standing for one schedule at `nowMs`. Consumption is computed from the durable write-once turn ledger alone (never from a
 * counter), so it survives restarts; it is evaluated and the next reservation linked under one `automation.lock.<n>` critical section,
 * so two processes cannot admit against the same remaining allowance. A turn counts in the period that contains its admission; a
 * future-dated admission (clock moved backwards) is counted, never ignored.
 */
export function endoAdvisoryBudgetStandingV0(args: {
	readonly turns: readonly EndoAdvisoryLedgerTurnV0[];
	readonly budget: EndoAdvisoryBudgetV0;
	readonly nowMs: number;
	readonly currentLease: { readonly epoch: number; readonly active: boolean } | null;
}): EndoAdvisoryBudgetStandingV0 {
	const periodStartMs = Math.max(0, args.nowMs - args.budget.periodMs);
	let turnsCharged = 0;
	let generatedTokensCharged = 0;
	let uncertainTurns = 0;
	let inFlightTurns = 0;
	for (const turn of args.turns) {
		if (turn.admission.admittedAtMs <= periodStartMs) continue;
		const charge = endoAdvisoryTurnChargeV0(turn, args.currentLease);
		turnsCharged += charge.turns;
		generatedTokensCharged += charge.generatedTokens;
		if (charge.state === "uncertain") uncertainTurns += 1;
		if (charge.state === "in-flight") inFlightTurns += 1;
	}
	const reservation = endoAdvisoryReservationV0(args.budget);
	const refusal =
		turnsCharged + 1 > args.budget.maxTurnsPerPeriod
			? "turns-exhausted"
			: generatedTokensCharged + reservation.generatedTokens > args.budget.maxGeneratedTokensPerPeriod
				? "generated-tokens-exhausted"
				: null;
	return Object.freeze({
		periodStartMs,
		periodMs: args.budget.periodMs,
		turnsCharged,
		maxTurnsPerPeriod: args.budget.maxTurnsPerPeriod,
		generatedTokensCharged,
		maxGeneratedTokensPerPeriod: args.budget.maxGeneratedTokensPerPeriod,
		uncertainTurns,
		inFlightTurns,
		reservation,
		admissible: refusal === null,
		refusal,
	});
}

/** What a settled turn is charged: confirmed usage only when complete; missing usage is charged at the reservation, never as zero. */
export function endoAdvisorySettledChargeV0(args: {
	readonly reserved: EndoAdvisoryReservationV0;
	readonly admittedExchanges: number | null;
	readonly reportedCompletionTokens: number | null;
	readonly usageReportComplete: boolean;
}): { readonly chargedCompletionRequests: number; readonly chargedGeneratedTokens: number } {
	const chargedCompletionRequests = args.admittedExchanges ?? args.reserved.completionRequests;
	if (args.admittedExchanges === 0) return { chargedCompletionRequests: 0, chargedGeneratedTokens: 0 };
	const chargedGeneratedTokens =
		args.usageReportComplete && args.reportedCompletionTokens !== null
			? args.reportedCompletionTokens
			: Math.max(args.reserved.generatedTokens, args.reportedCompletionTokens ?? 0);
	return { chargedCompletionRequests, chargedGeneratedTokens };
}

// ---- Proposals ---------------------------------------------------------------------------------------------------------------------

/** The fixed operator question an `emit-operator-proposal` turn adds through the existing briefing request. Part of the prompt identity. */
export const ENDO_ADVISORY_PROPOSAL_QUESTION_V0 = `After your bullets, end with one final line containing exactly one of: "PROPOSAL: none" or "PROPOSAL: <kind> <taskId>", where <kind> is one of ${ENDO_ADVISORY_PROPOSAL_KINDS_V0.join(", ")}, and <taskId> is a task id exactly as the status shows it. A proposal is only something for the operator to consider; it authorizes nothing.`;

export const ENDO_ADVISORY_INSTRUCTIONS_SHA256_V0 = sha256HexV0(ENDO_COORDINATOR_INSTRUCTIONS_V0);
export const ENDO_ADVISORY_PROPOSAL_QUESTION_SHA256_V0 = sha256HexV0(ENDO_ADVISORY_PROPOSAL_QUESTION_V0);

export type EndoAdvisoryProposalLineV0 =
	| { readonly state: "none" }
	| { readonly state: "proposed"; readonly kind: EndoAdvisoryProposalKindV0; readonly taskId: string }
	| { readonly state: "refused"; readonly refusal: "proposal-unparseable" | "proposal-kind-unknown" };

/**
 * Parse the proposal line strictly. Exactly one line in the whole answer may start with `PROPOSAL:` and it must be the last
 * non-empty line; a second such line (an injected one, say) or any extra token makes the whole proposal unparseable. Only
 * surrounding emphasis characters and a list marker are tolerated.
 */
export function endoAdvisoryParseProposalLineV0(answer: string): EndoAdvisoryProposalLineV0 {
	const lines = answer
		.split(/\r?\n/)
		.map((l) =>
			l
				.trim()
				.replace(/^[-*]\s+/, "")
				.replace(/^[*_`]+|[*_`]+$/g, "")
				.trim(),
		)
		.filter((l) => l.length > 0);
	const proposalLines = lines.filter((l) => /^proposal\s*:/i.test(l));
	if (proposalLines.length !== 1 || !/^proposal\s*:/i.test(lines.at(-1) ?? ""))
		return { state: "refused", refusal: "proposal-unparseable" };
	const match = /^PROPOSAL: (?:(none)|([a-z-]{1,64}) (\S+))$/.exec(lines.at(-1) as string);
	if (match === null) return { state: "refused", refusal: "proposal-unparseable" };
	if (match[1] === "none") return { state: "none" };
	const kind = match[2] as string;
	const taskId = match[3] as string;
	if (!(ENDO_ADVISORY_PROPOSAL_KINDS_V0 as readonly string[]).includes(kind))
		return { state: "refused", refusal: "proposal-kind-unknown" };
	if (!ENDO_TASK_ID_PATTERN_V0.test(taskId)) return { state: "refused", refusal: "proposal-unparseable" };
	return { state: "proposed", kind: kind as EndoAdvisoryProposalKindV0, taskId };
}

export type EndoAdvisoryGroundedProposalV0 =
	| {
			readonly ok: true;
			readonly kind: EndoAdvisoryProposalKindV0;
			readonly subject: {
				readonly taskId: string;
				readonly assignmentId: string | null;
				readonly candidateId: string | null;
			};
			readonly facts: readonly EndoAdvisoryEvidenceFactRecordV0[];
			readonly uncertainties: readonly string[];
			readonly dedupKey: string;
	  }
	| { readonly ok: false; readonly refusal: EndoAdvisoryProposalRefusalV0 };

const INCOMPLETE_VERIFICATION = new Set(["incomplete", "inconclusive", "not-current", "not-read", "unavailable"]);

/**
 * Ground a parsed proposal in the deterministic projections of its own project. The model's words never become evidence: each kind
 * holds only when the controller- or operator-recorded state it names is present now, for a task of this project.
 */
export function endoAdvisoryGroundProposalV0(args: {
	readonly projectId: string;
	readonly kind: EndoAdvisoryProposalKindV0;
	readonly taskId: string;
	readonly status: EndoCoordinatorStatusV0;
	readonly coordination: EndoCoordinatorCoordinationV0;
	readonly observationGaps: readonly string[];
}): EndoAdvisoryGroundedProposalV0 {
	const project = args.status.projects.find((p) => p.id === args.projectId);
	const task = project?.tasks.find((t) => t.taskId === args.taskId && t.projectId === args.projectId);
	if (task === undefined) return { ok: false, refusal: "proposal-subject-unknown" };
	const coordProject = args.coordination.projects.find((p) => p.id === args.projectId);
	const assignments = (coordProject?.assignments ?? []).filter((a) => a.taskId === task.taskId);
	const currentCandidateId = coordProject?.tasks.find((t) => t.taskId === task.taskId)?.currentCandidateId ?? null;
	const facts: EndoAdvisoryEvidenceFactRecordV0[] = [];
	let assignmentId: string | null = null;
	switch (args.kind) {
		case "review-failing-verification":
			if (task.verification.state === "failing")
				facts.push({ fact: "task-verification-failing", subject: task.taskId });
			break;
		case "review-awaiting-review":
			if (task.status === "review") facts.push({ fact: "task-status-review", subject: task.taskId });
			break;
		case "investigate-incomplete-verification":
			if (task.verification.incomplete || INCOMPLETE_VERIFICATION.has(task.verification.state)) {
				facts.push({ fact: "task-verification-incomplete", subject: task.taskId });
				if (!task.verification.receiptReadComplete)
					facts.push({ fact: "task-receipt-read-incomplete", subject: task.taskId });
			}
			break;
		case "resolve-blocked-task":
			if (task.status === "blocked") facts.push({ fact: "task-status-blocked", subject: task.taskId });
			break;
		case "investigate-liveness-hazard": {
			const hazard = assignments
				.filter((a) => a.hazard === "liveness-unverified")
				.sort(byKey((a) => a.assignmentId))[0];
			if (hazard !== undefined) {
				assignmentId = hazard.assignmentId;
				facts.push({ fact: "assignment-liveness-unverified", subject: hazard.assignmentId });
			}
			break;
		}
		case "consider-attempt-for-assignment": {
			const active = assignments.filter((a) => a.state === "active").sort(byKey((a) => a.assignmentId))[0];
			if (active !== undefined) {
				assignmentId = active.assignmentId;
				facts.push({ fact: "assignment-active", subject: active.assignmentId });
			}
			break;
		}
	}
	if (facts.length === 0) return { ok: false, refusal: "proposal-ungrounded" };
	const uncertainties = [...new Set([...task.gaps.map((g) => g.code), ...args.observationGaps])]
		.filter((c) => /^[a-z0-9][a-z0-9.:-]{0,63}$/.test(c))
		.sort()
		.slice(0, L.maxUncertainties);
	const candidateId = args.kind === "consider-attempt-for-assignment" ? currentCandidateId : null;
	const dedupKey = digest({
		schema: "endo.advisory-proposal-dedup.v0",
		projectId: args.projectId,
		kind: args.kind,
		taskId: task.taskId,
		assignmentId,
	});
	return {
		ok: true,
		kind: args.kind,
		subject: { taskId: task.taskId, assignmentId, candidateId },
		facts,
		uncertainties,
		dedupKey,
	};
}

/** A proposal's identity: its equivalence class and the exact evidence it was grounded on. */
export const endoAdvisoryProposalIdV0 = (dedupKey: string, semanticDigest: string): string =>
	digest({ schema: "endo.advisory-proposal-id.v0", dedupKey, semanticDigest });

/** Whether a proposal's evidence is the latest observed semantic state of its project (E1's evidence-bound clearance rule). */
export type EndoAdvisoryProposalCurrencyV0 = "current" | "stale" | "unknown";

export function endoAdvisoryProposalCurrencyV0(
	proposalDigest: string,
	latest: {
		readonly semanticDigest: string | null;
		readonly completeness: EndoAdvisoryObservationCompletenessV0;
	} | null,
): EndoAdvisoryProposalCurrencyV0 {
	if (latest === null || latest.semanticDigest === null || latest.completeness === "unavailable") return "unknown";
	return latest.semanticDigest === proposalDigest ? "current" : "stale";
}
