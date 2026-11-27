// The S2 advisory tick (COORDINATOR-AUTOMATION-S2, docs/designs/coordinator-automation-s2-implementation.md): one bounded pass that
// may run at most ONE authorised advisory briefing turn, under a separate advisory duty lease.
//
//   A  claim      (automation.lock)  lease acquire/advance; recover abandoned fires; evaluate due windows; link one fire claim
//   B  observe    (no lock)          lock-free status + coordination read of the schedule's one project -> semantic digest
//   C  admit      (automation.lock)  schedule/lease fence, wake gate, authorization, effective pool, budget, lease window;
//                                    link the admission (the budget reservation) BEFORE any model contact
//   D  select     (no lock)          zero-token member observation (recorded S1 observation, or M1's passive probe if permitted)
//   E  dispatch   (automation.lock)  the linearization point: re-check authorization id, schedule revision, lease epoch and
//                                    remaining window, then link the dispatch record. No completion request precedes it.
//   F  infer      (no lock)          the unchanged M0/M1 briefing against the selected member alone; aborted at the deadline
//   G  re-observe (no lock)          publication-time semantic state (currency + proposal grounding)
//   H  publish    (automation.lock)  re-check authorization/schedule (withhold if changed), link proposal, briefing, outcome;
//                                    advance the cursor; release the lease; bounded retention
//
// No lock is held across an await. A crash between E and H leaves a dispatch record and no briefing: the turn is charged its
// full reservation, never retried and never released; recovery writes only a terminal fire outcome saying so.

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { EndoCoordinatorCoordinationV0 } from "../../protocol/coordinator-coordination.ts";
import type {
	EndoCoordinatorBriefingModeV1,
	EndoCoordinatorVisibilityModeV1,
} from "../../protocol/coordinator-grounding.ts";
import type { EndoCoordinatorStatusV0 } from "../../protocol/coordinator-status.ts";
import {
	ENDO_ADVISORY_BRIEFING_SCHEMA_V0,
	ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0,
	ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0,
	ENDO_ADVISORY_LIMITS_V0,
	ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0,
	ENDO_ADVISORY_PROPOSAL_SCHEMA_V0,
	ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0,
	ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0,
	type EndoAdvisoryAccountingV0,
	type EndoAdvisoryAuthorizationV0,
	type EndoAdvisoryBriefingV0,
	type EndoAdvisoryDispatchRefusalV0,
	type EndoAdvisoryFireClaimV0,
	type EndoAdvisoryFireOutcomeStatusV0,
	type EndoAdvisoryFireOutcomeV0,
	type EndoAdvisoryGateRecordV0,
	type EndoAdvisoryProposalLinkV0,
	type EndoAdvisoryProposalV0,
	type EndoAdvisoryPublicationCurrencyV0,
	type EndoAdvisoryScheduleCursorV0,
	type EndoAdvisoryScheduleV0,
	type EndoAdvisorySkippedMemberV0,
	type EndoAdvisoryTurnAdmissionV0,
	type EndoAdvisoryTurnDispatchV0,
} from "../../protocol/develop-advisory.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_HOLDER_ID_PATTERN_V0,
	type EndoDevelopAutomationLeaseV0,
	type EndoDevelopScheduleV0,
} from "../../protocol/develop-automation.ts";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	briefFromCoordinatorSubstrateV0,
	type EndoCoordinatorBriefResultV0,
} from "../../runtime/contracts/coordinator-brief.ts";
import {
	buildEndoCoordinatorModelViewV1,
	ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_SHA256_V1,
	ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_V1,
	ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_SHA256_V1,
	endoCoordinatorModelViewSha256V1,
} from "../../runtime/contracts/coordinator-grounding.ts";
import {
	coordinatorModelPoolSha256V0,
	type EndoCoordinatorMemberObserverV0,
	selectCoordinatorModelV0,
} from "../../runtime/contracts/coordinator-model-pool.ts";
import {
	ENDO_ADVISORY_INSTRUCTIONS_SHA256_V0,
	ENDO_ADVISORY_PROPOSAL_QUESTION_SHA256_V0,
	ENDO_ADVISORY_PROPOSAL_QUESTION_V0,
	type EndoAdvisorySemanticObservationV0,
	endoAdvisoryAuthorizationStandingV0,
	endoAdvisoryBudgetSha256V0,
	endoAdvisoryBudgetStandingV0,
	endoAdvisoryEffectivePoolV0,
	endoAdvisoryExcludedMembersV0,
	endoAdvisoryFireIdempotencyKeyV0,
	endoAdvisoryGroundProposalV0,
	endoAdvisoryParseProposalLineV0,
	endoAdvisoryPolicySha256V0,
	endoAdvisoryProposalIdV0,
	endoAdvisoryReservationV0,
	endoAdvisorySemanticObservationV0,
	endoAdvisorySettledChargeV0,
	endoAdvisoryWakeDecisionV0,
} from "../../runtime/contracts/develop-advisory.ts";
import {
	createRecordedCoordinatorModelObserverV0,
	endoScheduleTriggerCursorV0,
	evaluateEndoScheduleDueV0,
} from "../../runtime/contracts/develop-automation.ts";
import { readEndoCoordinatorCoordinationV0 } from "../../storage/coordinator-coordination.ts";
import { readEndoCoordinatorStatusV0 } from "../../storage/coordinator-status.ts";
import {
	DevelopAdvisoryStoreV0,
	type EndoAdvisoryLockedSessionV0,
	type EndoAdvisoryWriteOnceV0,
	type EndoDevelopAdvisoryStoreOptionsV0,
} from "../../storage/develop-advisory.ts";
import { DevelopAutomationStoreV0 } from "../../storage/develop-automation.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { probeLocalEndpointV0 } from "../coordinator/model-pool-probe.ts";
import { coordinatorTargetFromMemberV0 } from "../coordinator/model-relay.ts";
import type { OpenClawCoordinatorTrialV0, runOpenClawCoordinatorV0 } from "../coordinator/openclaw.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";

const L = ENDO_ADVISORY_LIMITS_V0;
const digest = (value: unknown): string => sha256HexV0(canonicalEndoJsonV0(value as never));

export interface EndoAdvisoryProjectReadV0 {
	readonly status: EndoCoordinatorStatusV0;
	readonly coordination: EndoCoordinatorCoordinationV0;
}

/** Deterministic crash-boundary hooks for tests only. A throw from a hook is a process crash at that point. */
export interface EndoAdvisoryTickHooksV0 {
	readonly afterClaim?: (info: {
		readonly leaseEpoch: number;
		readonly idempotencyKey: string;
	}) => void | Promise<void>;
	readonly afterAdmission?: (info: { readonly turnId: string }) => void | Promise<void>;
	readonly beforeDispatchRecord?: (info: { readonly turnId: string }) => void | Promise<void>;
	readonly afterDispatchRecord?: (info: { readonly turnId: string }) => void | Promise<void>;
	readonly afterInference?: (info: { readonly turnId: string }) => void | Promise<void>;
	readonly beforePublish?: (info: { readonly turnId: string }) => void | Promise<void>;
}

export interface RunEndoAdvisoryTickOptionsV0 {
	readonly root: string;
	readonly now?: () => number;
	readonly monotonicNow?: () => number;
	readonly holderId?: string;
	readonly onTimeGraceMs?: number;
	/** Lock-free read of one project's projections. Default: the store readers S1's observer uses, bounded. */
	readonly observeProject?: (args: {
		readonly root: string;
		readonly projectId: string;
		readonly nowMs: number;
	}) => Promise<EndoAdvisoryProjectReadV0>;
	/** Zero-token live member observer, used only when the grant's policy allows "recorded-or-passive-probe". Default: M1's probe. */
	readonly observeMember?: EndoCoordinatorMemberObserverV0;
	/** The M0 runner (injected by tests; the production default is the sandboxed OpenClaw briefing). */
	readonly run?: typeof runOpenClawCoordinatorV0;
	/** Optional non-inference preflight hook run BEFORE Phase E links the dispatch record. */
	readonly preflight?: () => { readonly ok: boolean; readonly detail?: string };
	/** Briefing grounding mode (`legacy-v0` default for compatibility; `grounded-v1` for subject-scoped claims). */
	readonly briefingMode?: EndoCoordinatorBriefingModeV1;
	/** Model-visible evidence mode (`status-v0` default; `status-and-coordination-v1` includes bounded coordination). */
	readonly visibilityMode?: EndoCoordinatorVisibilityModeV1;
	readonly storeOptions?: Omit<EndoDevelopAdvisoryStoreOptionsV0, "now">;
	readonly hooks?: EndoAdvisoryTickHooksV0;
}

export type EndoAdvisoryTickRefusalV0 = "lock-busy" | "lease-held" | "unreadable" | "unsafe-path" | "storage-failed";

export type EndoAdvisoryTickResultV0 =
	| {
			readonly ok: true;
			readonly schemaVersion: "endo.advisory-tick-result.v0";
			readonly holderId: string;
			readonly leaseEpoch: number;
			readonly recovered: readonly string[];
			readonly outcomes: readonly EndoAdvisoryFireOutcomeV0[];
			readonly turnId: string | null;
			readonly inferenceDispatched: boolean;
	  }
	| {
			readonly ok: false;
			readonly schemaVersion: "endo.advisory-tick-result.v0";
			readonly refusal: EndoAdvisoryTickRefusalV0;
			readonly detail: string;
			readonly holderId: string;
			readonly inferenceDispatched: boolean;
	  };

const STATUS_BUDGET = {
	eventsBytes: 4 << 20,
	attemptEntries: 512,
	attemptBytes: 8 << 20,
	receiptFiles: 256,
	receiptBytes: 4 << 20,
};
const COORD_BUDGET = { ...STATUS_BUDGET, reviewFiles: 256, reviewBytes: 2 << 20 };

/**
 * HEAD of one project's registered path, observed the way the briefing status reader observes it (adapters/coordinator/status.ts):
 * the read-only Git revision observer at /usr/bin/git with HOME unset, every Git call under GIT_LIMITS_V0's timeout and output bound,
 * refusing a .git that is not a plain directory or is a linked worktree. Null (so the status reports project-head-unavailable and the
 * observation is partial) whenever HEAD cannot be read; never a guess.
 */
export async function observeAdvisoryProjectHeadV0(
	root: string,
	projectId: string,
	options: { readonly gitPath?: string } = {},
): Promise<{ readonly path: string; readonly head: EndoReceiptCurrentV0 | null } | null> {
	const tasks = new DevelopTasksStoreV0(root).read();
	if (!tasks.ok || !tasks.exists) return null;
	const project = tasks.file.projects.find((p) => p.id === projectId);
	if (project === undefined) return null;
	try {
		if (!existsSync(project.path)) return { path: project.path, head: null };
		const projectRoot = realpathSync(project.path);
		const git = lstatSync(join(projectRoot, ".git"), { throwIfNoEntry: false });
		if (
			git === undefined ||
			!git.isDirectory() ||
			lstatSync(join(projectRoot, ".git", "commondir"), { throwIfNoEntry: false })
		)
			return { path: project.path, head: null };
		const observed = await new GitRevisionObserverV0({
			gitPath: options.gitPath ?? "/usr/bin/git",
			env: { HOME: "/nonexistent" },
		}).observe(projectRoot);
		if (!observed.ok || observed.observation.linked) return { path: project.path, head: null };
		const o = observed.observation;
		return {
			path: project.path,
			head: { commit: o.commit, worktree: o.worktree, commonDir: o.commonDir, clean: o.dirty.length === 0 },
		};
	} catch {
		return { path: project.path, head: null };
	}
}

/** The lock-free bounded projection read S1's observer performs, for one project, with its HEAD observed once and shared by both reads. */
export async function defaultObserveAdvisoryProjectV0(args: {
	readonly root: string;
	readonly projectId: string;
	readonly nowMs: number;
	readonly gitPath?: string;
}): Promise<EndoAdvisoryProjectReadV0> {
	const observed = await observeAdvisoryProjectHeadV0(args.root, args.projectId, { gitPath: args.gitPath });
	const head = observed?.head ?? null;
	const status = await readEndoCoordinatorStatusV0({
		root: args.root,
		projects: [args.projectId],
		now: () => args.nowMs,
		budget: STATUS_BUDGET,
		current: async (directory) => (observed !== null && directory === observed.path ? head : null),
	});
	const coordination = await readEndoCoordinatorCoordinationV0({
		root: args.root,
		projects: [args.projectId],
		now: () => args.nowMs,
		routes: "read",
		budget: COORD_BUDGET,
		workspace: async (directory) => (head !== null && directory === head.worktree ? head : null),
	});
	return { status, coordination };
}

/** S1's due evaluator reads only enabled, trigger, missedRunPolicy and the cursor's window fields; S2 shares those semantics. */
const asS1Schedule = (s: EndoAdvisoryScheduleV0): EndoDevelopScheduleV0 =>
	({
		scheduleId: s.scheduleId,
		label: s.label,
		revision: s.revision,
		enabled: s.enabled,
		actionKind: "observe-health",
		missedRunPolicy: s.missedRunPolicy,
		trigger: s.trigger,
		createdAtMs: s.createdAtMs,
		updatedAtMs: s.updatedAtMs,
		cursor: {
			lastEvaluatedAtMs: s.cursor.lastEvaluatedAtMs,
			lastConsumedWindowStartMs: s.cursor.lastConsumedWindowStartMs,
			completedOnce: s.cursor.completedOnce,
			lastFireIdempotencyKey: null,
			lastFireStatus: null,
		},
	}) as unknown as EndoDevelopScheduleV0;

const leaseLive = (lease: EndoDevelopAutomationLeaseV0 | null, nowMs: number): boolean =>
	lease !== null && lease.releasedAtMs === null && nowMs < lease.expiresAtMs && nowMs >= lease.acquiredAtMs;

const count = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Reported usage. Complete only when every admitted exchange produced a response that reported completion tokens. */
function usageOf(trial: OpenClawCoordinatorTrialV0 | null) {
	let completion: number | null = null;
	let prompt: number | null = null;
	const responses = trial?.wire.responses ?? [];
	let complete = trial !== null && trial.admittedExchanges > 0 && responses.length >= trial.admittedExchanges;
	for (const response of responses) {
		const u = (response as { usage?: unknown }).usage;
		const record = u !== null && typeof u === "object" ? (u as Record<string, unknown>) : null;
		const c = count(record?.completion_tokens);
		const p = count(record?.prompt_tokens);
		if (c === null) complete = false;
		else completion = (completion ?? 0) + c;
		if (p !== null) prompt = (prompt ?? 0) + p;
	}
	return { prompt, completion, complete };
}

export const endoAdvisoryTurnIdV0 = (fireKey: string, leaseEpoch: number): string =>
	digest({ schema: "endo.advisory-turn-id.v0", fireIdempotencyKey: fireKey, leaseEpoch });

function withCursor(s: EndoAdvisoryScheduleV0, patch: Partial<EndoAdvisoryScheduleCursorV0>): EndoAdvisoryScheduleV0 {
	return { ...s, cursor: { ...s.cursor, ...patch } };
}

function statusFromBriefing(b: EndoAdvisoryBriefingV0): EndoAdvisoryFireOutcomeStatusV0 {
	if (b.availability === "available") return "briefing-published";
	if (b.availability === "withheld") return "result-withheld";
	if (b.availability === "unavailable") return "briefing-refused";
	return "failed";
}

function dispatchRefusalStatus(r: EndoAdvisoryDispatchRefusalV0): EndoAdvisoryFireOutcomeStatusV0 {
	switch (r) {
		case "no-eligible-member":
			return "refused-model-unavailable";
		case "capacity-unknown-not-permitted":
			return "refused-uncertainty-policy";
		case "authorization-revoked":
		case "authorization-expired":
			return "refused-unauthorized";
		case "schedule-changed":
			return "cancelled-schedule-changed";
		case "insufficient-lease":
		case "stale-lease-epoch":
			return "refused-insufficient-lease";
		default:
			return "failed";
	}
}

export async function runEndoAdvisoryTickV0(options: RunEndoAdvisoryTickOptionsV0): Promise<EndoAdvisoryTickResultV0> {
	const now = options.now ?? Date.now;
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	let leaseStartedMs = 0;
	let turnStartedMs = 0;
	const holderId = options.holderId ?? `endo.advisory.${process.pid}.${randomBytes(6).toString("hex")}`;
	if (!ENDO_HOLDER_ID_PATTERN_V0.test(holderId))
		throw new TypeError("holderId must be 1-128 printable ASCII characters");
	const onTimeGraceMs = options.onTimeGraceMs ?? L.defaultOnTimeGraceMs;
	const hooks = options.hooks ?? {};
	const store = new DevelopAdvisoryStoreV0(options.root, { ...options.storeOptions, now });
	const observeProject = options.observeProject ?? defaultObserveAdvisoryProjectV0;
	const refuse = (
		refusal: EndoAdvisoryTickRefusalV0,
		detail: string,
		dispatched = false,
	): EndoAdvisoryTickResultV0 => ({
		ok: false,
		schemaVersion: "endo.advisory-tick-result.v0",
		refusal,
		detail,
		holderId,
		inferenceDispatched: dispatched,
	});
	const lockRefusal = (code: "busy" | "unsafe-path" | "storage-failed"): EndoAdvisoryTickRefusalV0 =>
		code === "busy" ? "lock-busy" : code;

	// ---- A: claim -----------------------------------------------------------------------------------------------------------------
	type Claimed = { readonly claim: EndoAdvisoryFireClaimV0 };
	const phaseA = store.withAdvisoryLockSync((s) => {
		const nowMs = now();
		leaseStartedMs = monotonicNow();
		const schedulesRead = s.store.readSchedules();
		const leaseRead = s.store.readLease();
		if (!schedulesRead.ok)
			return {
				ok: false as const,
				refusal: (schedulesRead.reason === "unsafe-path"
					? "unsafe-path"
					: "unreadable") as EndoAdvisoryTickRefusalV0,
				detail: `schedules.json ${schedulesRead.reason}`,
			};
		if (!leaseRead.ok)
			return {
				ok: false as const,
				refusal: (leaseRead.reason === "unsafe-path" ? "unsafe-path" : "unreadable") as EndoAdvisoryTickRefusalV0,
				detail: `lease.json ${leaseRead.reason}`,
			};
		const existing = leaseRead.exists ? leaseRead.value : null;
		const existingTtlMs =
			existing === null ? L.leaseTtlMs : Math.max(L.leaseTtlMs, existing.expiresAtMs - existing.acquiredAtMs);
		const impossibleFuture = existing !== null && existing.acquiredAtMs - nowMs > existingTtlMs;
		if (existing !== null && existing.releasedAtMs === null && nowMs < existing.expiresAtMs && !impossibleFuture)
			return {
				ok: false as const,
				refusal: "lease-held" as const,
				detail: `advisory lease held by ${existing.holderId} (epoch ${existing.epoch}) until ${existing.expiresAtMs}`,
			};
		// Determine whether the single due schedule this tick will claim holds a standing governed V1 resource profile.
		// Without an explicit V1 resource profile, the lease keeps its exact V0 300 s TTL.
		const nextDue = schedulesRead.exists
			? [...schedulesRead.value.schedules]
					.filter(
						(schedule) =>
							evaluateEndoScheduleDueV0(asS1Schedule(schedule), nowMs, { onTimeGraceMs }).kind === "due-fire",
					)
					.sort((x, y) => (x.cursor.lastEvaluatedAtMs ?? -1) - (y.cursor.lastEvaluatedAtMs ?? -1))[0]
			: undefined;
		let leaseTtlMs: number = L.leaseTtlMs;
		if (nextDue !== undefined) {
			const authRead = s.store.readAuthorizations();
			if (authRead.ok && authRead.exists) {
				const standing = endoAdvisoryAuthorizationStandingV0({
					schedule: nextDue,
					file: authRead.value,
					nowMs,
				});
				if (standing.ok && standing.authorization.resourceProfile !== undefined)
					leaseTtlMs = standing.authorization.resourceProfile.advisoryLeaseTtlMs;
			}
		}
		const lease: EndoDevelopAutomationLeaseV0 = {
			schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
			holderId,
			epoch: (existing?.epoch ?? 0) + 1,
			acquiredAtMs: nowMs,
			expiresAtMs: nowMs + leaseTtlMs,
			releasedAtMs: null,
		};
		if (s.writeLease(lease) !== "committed")
			return { ok: false as const, refusal: "storage-failed" as const, detail: "lease.json not committed" };

		// Recovery: a claim with no outcome from an earlier epoch. Never retried; a dispatch-uncertain turn stays charged.
		const recovered: string[] = [];
		const terminal: EndoAdvisoryFireOutcomeV0[] = [];
		const fires = s.store.listFires();
		if (fires.ok)
			for (const e of fires.entries) {
				if (e.claim === null || e.outcome !== null || e.claim.leaseEpoch >= lease.epoch) continue;
				const turnId = endoAdvisoryTurnIdV0(e.claim.idempotencyKey, e.claim.leaseEpoch);
				const admission = s.store.readAdmission(turnId);
				const dispatch = s.store.readDispatch(turnId);
				const briefing = s.store.readBriefing(turnId);
				const admitted = !admission.ok || admission.exists;
				const dispatched = admitted && (!dispatch.ok || dispatch.exists);
				const outcome: EndoAdvisoryFireOutcomeV0 = {
					schemaVersion: ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0,
					idempotencyKey: e.claim.idempotencyKey,
					scheduleId: e.claim.scheduleId,
					scheduleRevision: e.claim.scheduleRevision,
					projectId: e.claim.projectId,
					actionKind: e.claim.actionKind,
					windowStartMs: e.claim.windowStartMs,
					completedAtMs: nowMs,
					leaseEpoch: lease.epoch,
					holderId,
					status: briefing.ok && briefing.exists ? statusFromBriefing(briefing.value) : "failed",
					missedWindowCount: e.claim.missedWindowsBefore,
					gate: null,
					turnId: admitted ? turnId : null,
					inferenceDispatched: dispatched ? "yes" : "no",
					detail: dispatched
						? "abandoned after dispatch: inference may have run; charged at full reservation and never retried"
						: "abandoned before dispatch: no completion request was sent",
				};
				if (s.writeFireOutcomeOnce(outcome) === "created") {
					recovered.push(e.claim.idempotencyKey);
					terminal.push(outcome);
				}
			}

		if (!schedulesRead.exists)
			return { ok: true as const, lease, recovered, claimed: null as Claimed | null, terminal };
		const file = schedulesRead.value;
		let claimed: Claimed | null = null;
		let claimFailed = false;
		const next = [...file.schedules]
			.filter(
				(schedule) =>
					evaluateEndoScheduleDueV0(asS1Schedule(schedule), nowMs, { onTimeGraceMs }).kind === "due-fire",
			)
			.sort((x, y) => (x.cursor.lastEvaluatedAtMs ?? -1) - (y.cursor.lastEvaluatedAtMs ?? -1))[0];
		const updated = file.schedules.map((schedule) => {
			const evaluation = evaluateEndoScheduleDueV0(asS1Schedule(schedule), nowMs, { onTimeGraceMs });
			const triggerCursor = endoScheduleTriggerCursorV0(schedule.trigger);
			if (evaluation.kind === "missed-skip") {
				const key = endoAdvisoryFireIdempotencyKeyV0({
					scheduleId: schedule.scheduleId,
					scheduleIncarnation: schedule.incarnation,
					windowStartMs: evaluation.latestMissedWindowStartMs,
					triggerCursor,
				});
				const prior = s.store.readFireClaim(key);
				if (!(prior.ok && prior.exists)) {
					const outcome: EndoAdvisoryFireOutcomeV0 = {
						schemaVersion: ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0,
						idempotencyKey: key,
						scheduleId: schedule.scheduleId,
						scheduleRevision: schedule.revision,
						projectId: schedule.projectId,
						actionKind: schedule.actionKind,
						windowStartMs: evaluation.latestMissedWindowStartMs,
						completedAtMs: nowMs,
						leaseEpoch: lease.epoch,
						holderId,
						status: "missed-skipped",
						missedWindowCount: evaluation.missedWindowCount,
						gate: null,
						turnId: null,
						inferenceDispatched: "no",
						detail: `skipped ${evaluation.missedWindowCount} missed window(s); missed windows never cause catch-up inference`,
					};
					if (s.writeFireOutcomeOnce(outcome) === "created") terminal.push(outcome);
				}
				return withCursor(schedule, {
					lastEvaluatedAtMs: nowMs,
					lastConsumedWindowStartMs: Math.max(
						schedule.cursor.lastConsumedWindowStartMs ?? 0,
						evaluation.latestMissedWindowStartMs,
					),
					completedOnce: schedule.trigger.kind === "once" ? true : schedule.cursor.completedOnce,
					lastFireIdempotencyKey: key,
					lastFireStatus: "missed-skipped",
				});
			}
			// One turn per tick: another due schedule keeps its window for the next tick (a lease bounds one turn only).
			if (evaluation.kind !== "due-fire" || schedule !== next || claimed !== null) return schedule;
			const key = endoAdvisoryFireIdempotencyKeyV0({
				scheduleId: schedule.scheduleId,
				scheduleIncarnation: schedule.incarnation,
				windowStartMs: evaluation.windowStartMs,
				triggerCursor,
			});
			const claim: EndoAdvisoryFireClaimV0 = {
				schemaVersion: ENDO_ADVISORY_FIRE_CLAIM_SCHEMA_V0,
				idempotencyKey: key,
				scheduleId: schedule.scheduleId,
				scheduleIncarnation: schedule.incarnation,
				scheduleRevision: schedule.revision,
				projectId: schedule.projectId,
				actionKind: schedule.actionKind,
				wake: schedule.wake,
				triggerKind: schedule.trigger.kind,
				triggerCursor,
				windowStartMs: evaluation.windowStartMs,
				missedWindowsBefore: evaluation.missedWindowsBefore,
				claimedAtMs: nowMs,
				leaseEpoch: lease.epoch,
				holderId,
			};
			const written = s.writeFireClaimOnce(claim);
			if (written === "created") claimed = { claim };
			else if (written !== "exists") {
				claimFailed = true;
				return schedule;
			}
			return withCursor(schedule, {
				lastEvaluatedAtMs: nowMs,
				lastConsumedWindowStartMs: Math.max(
					schedule.cursor.lastConsumedWindowStartMs ?? 0,
					evaluation.windowStartMs,
				),
				completedOnce: schedule.trigger.kind === "once" ? true : schedule.cursor.completedOnce,
				lastFireIdempotencyKey: key,
			});
		});
		if (claimFailed) {
			s.writeLease({ ...lease, releasedAtMs: nowMs });
			return { ok: false as const, refusal: "storage-failed" as const, detail: "fire claim not durably linked" };
		}
		if (updated.some((u, i) => u !== file.schedules[i])) {
			const w = s.writeSchedules({ ...file, revision: file.revision + 1, updatedAtMs: nowMs, schedules: updated });
			if (w !== "committed") {
				s.writeLease({ ...lease, releasedAtMs: nowMs });
				return { ok: false as const, refusal: "storage-failed" as const, detail: `schedules.json ${w}` };
			}
		}
		return { ok: true as const, lease, recovered, claimed: claimed as Claimed | null, terminal };
	});
	if (!phaseA.ok) return refuse(lockRefusal(phaseA.code), "advisory lock unavailable at claim");
	const a = phaseA.result;
	if (!a.ok) return refuse(a.refusal, a.detail);
	const lease = a.lease;
	const activeLeaseTtlMs = lease.expiresAtMs - lease.acquiredAtMs;
	const outcomes: EndoAdvisoryFireOutcomeV0[] = [...a.terminal];
	const ownsLease = (s: EndoAdvisoryLockedSessionV0, nowMs: number): boolean => {
		const current = s.store.readLease();
		const value = current.ok && current.exists ? current.value : null;
		return (
			value !== null &&
			value.epoch === lease.epoch &&
			value.holderId === holderId &&
			leaseLive(value, nowMs) &&
			monotonicNow() - leaseStartedMs >= 0 &&
			monotonicNow() - leaseStartedMs < activeLeaseTtlMs
		);
	};
	const release = (s: EndoAdvisoryLockedSessionV0, nowMs: number) => {
		const current = s.store.readLease();
		if (
			current.ok &&
			current.exists &&
			current.value.epoch === lease.epoch &&
			current.value.holderId === holderId &&
			current.value.releasedAtMs === null
		)
			s.writeLease({ ...current.value, releasedAtMs: Math.max(nowMs, current.value.acquiredAtMs) });
	};
	const done = (turnId: string | null, dispatched: boolean): EndoAdvisoryTickResultV0 => ({
		ok: true,
		schemaVersion: "endo.advisory-tick-result.v0",
		holderId,
		leaseEpoch: lease.epoch,
		recovered: a.recovered,
		outcomes,
		turnId,
		inferenceDispatched: dispatched,
	});
	if (a.claimed === null) {
		store.withAdvisoryLockSync((s) => {
			const nowMs = now();
			s.pruneRetained(nowMs);
			release(s, nowMs);
		});
		return done(null, false);
	}
	const { claim } = a.claimed;
	await hooks.afterClaim?.({ leaseEpoch: lease.epoch, idempotencyKey: claim.idempotencyKey });

	/** Terminal fire outcome and cursor status, then retention and lease release. Runs inside the lock. */
	const finish = (
		s: EndoAdvisoryLockedSessionV0,
		nowMs: number,
		status: EndoAdvisoryFireOutcomeStatusV0,
		gate: EndoAdvisoryGateRecordV0 | null,
		turnId: string | null,
		dispatched: boolean,
		detail: string | null,
		cursorPatch: Partial<EndoAdvisoryScheduleCursorV0> = {},
	) => {
		const outcome: EndoAdvisoryFireOutcomeV0 = {
			schemaVersion: ENDO_ADVISORY_FIRE_OUTCOME_SCHEMA_V0,
			idempotencyKey: claim.idempotencyKey,
			scheduleId: claim.scheduleId,
			scheduleRevision: claim.scheduleRevision,
			projectId: claim.projectId,
			actionKind: claim.actionKind,
			windowStartMs: claim.windowStartMs,
			completedAtMs: nowMs,
			leaseEpoch: lease.epoch,
			holderId,
			status,
			missedWindowCount: claim.missedWindowsBefore,
			gate,
			turnId,
			inferenceDispatched: dispatched ? "yes" : "no",
			detail: detail === null ? null : detail.slice(0, 256),
		};
		if (s.writeFireOutcomeOnce(outcome) === "created") outcomes.push(outcome);
		// A writer whose lease was superseded or expired never advances the cursor (a later holder owns it now).
		const file = ownsLease(s, nowMs) ? s.store.readSchedules() : null;
		if (file?.ok && file.exists) {
			const schedules = file.value.schedules.map((x) =>
				x.scheduleId === claim.scheduleId &&
				x.incarnation === claim.scheduleIncarnation &&
				x.revision === claim.scheduleRevision
					? withCursor(x, { lastFireIdempotencyKey: claim.idempotencyKey, lastFireStatus: status, ...cursorPatch })
					: x,
			);
			if (schedules.some((x, i) => x !== file.value.schedules[i]))
				s.writeSchedules({ ...file.value, revision: file.value.revision + 1, updatedAtMs: nowMs, schedules });
		}
		s.pruneRetained(nowMs);
		release(s, nowMs);
	};

	// ---- B: observe (no lock) -----------------------------------------------------------------------------------------------------
	const observe = async () => {
		const observedAtMs = now();
		try {
			const read = structuredClone(
				await observeProject({ root: options.root, projectId: claim.projectId, nowMs: observedAtMs }),
			);
			return {
				read: read as EndoAdvisoryProjectReadV0 | null,
				observation: endoAdvisorySemanticObservationV0(claim.projectId, read.status, read.coordination),
				observedAtMs,
			};
		} catch {
			const observation: EndoAdvisorySemanticObservationV0 = {
				projectId: claim.projectId,
				completeness: "unavailable",
				semanticDigest: null,
				gaps: ["projection-unreadable"],
			};
			return { read: null as EndoAdvisoryProjectReadV0 | null, observation, observedAtMs };
		}
	};
	const admissionObserved = await observe();
	const obs = admissionObserved.observation;
	const persistObservation = (s: EndoAdvisoryLockedSessionV0, nowMs: number, observed: typeof admissionObserved) => {
		if (!ownsLease(s, nowMs)) return false;
		const file = s.store.readObservations();
		if (!file.ok) return false;
		const schedules = s.store.readSchedules();
		const scheduled = new Set(
			schedules.ok && schedules.exists ? schedules.value.schedules.map((x) => x.projectId) : [],
		);
		// The just-observed project is always kept; the bound evicts projects no schedule names first, then the least recently observed.
		const others = (file.exists ? file.value.projects : [])
			.filter((p) => p.projectId !== claim.projectId)
			.sort(
				(x, y) =>
					Number(scheduled.has(y.projectId)) - Number(scheduled.has(x.projectId)) ||
					y.observedAtMs - x.observedAtMs ||
					(x.projectId < y.projectId ? -1 : 1),
			)
			.slice(0, L.maxObservedProjects - 1);
		const projects = [
			...others,
			{
				projectId: claim.projectId,
				semanticDigest: observed.observation.semanticDigest,
				completeness: observed.observation.completeness,
				observedAtMs: observed.observedAtMs,
				leaseEpoch: lease.epoch,
			},
		].sort((x, y) => (x.projectId < y.projectId ? -1 : 1));
		if (
			s.writeObservations({ schemaVersion: ENDO_ADVISORY_OBSERVATIONS_SCHEMA_V0, updatedAtMs: nowMs, projects }) !==
			"committed"
		)
			return false;
		// Publication rests on this record: confirm it holds the observation just made before anything is published as current.
		const back = s.store.readObservations();
		const mine =
			back.ok && back.exists ? back.value.projects.find((p) => p.projectId === claim.projectId) : undefined;
		return (
			mine !== undefined &&
			mine.semanticDigest === observed.observation.semanticDigest &&
			mine.observedAtMs === observed.observedAtMs &&
			mine.leaseEpoch === lease.epoch
		);
	};

	// ---- C: admit (lock) ----------------------------------------------------------------------------------------------------------
	const turnId = endoAdvisoryTurnIdV0(claim.idempotencyKey, lease.epoch);
	type Admitted = {
		readonly admission: EndoAdvisoryTurnAdmissionV0;
		readonly authorization: EndoAdvisoryAuthorizationV0;
	};
	const phaseC = store.withAdvisoryLockSync((s): Admitted | null => {
		const nowMs = now();
		const gateOf = (
			cursor: EndoAdvisoryScheduleCursorV0 | null,
			wakeReason: EndoAdvisoryGateRecordV0["wakeReason"],
		): EndoAdvisoryGateRecordV0 => ({
			wakeReason,
			semanticDigest: obs.semanticDigest,
			completeness: obs.completeness,
			observedAtMs: admissionObserved.observedAtMs,
			gaps: obs.gaps,
			lastConsideredSemanticDigest: cursor?.lastConsideredSemanticDigest ?? null,
			lastAttemptedSemanticDigest: cursor?.lastAttemptedSemanticDigest ?? null,
		});
		const currentLease = s.store.readLease();
		const leaseValue = currentLease.ok && currentLease.exists ? currentLease.value : null;
		if (
			leaseValue === null ||
			leaseValue.epoch !== lease.epoch ||
			leaseValue.holderId !== holderId ||
			!ownsLease(s, nowMs)
		) {
			finish(
				s,
				nowMs,
				"refused-insufficient-lease",
				gateOf(null, null),
				null,
				false,
				"advisory lease lost before admission",
			);
			return null;
		}
		const schedules = s.store.readSchedules();
		const schedule =
			schedules.ok && schedules.exists
				? schedules.value.schedules.find((x) => x.scheduleId === claim.scheduleId)
				: undefined;
		if (
			schedule === undefined ||
			schedule.incarnation !== claim.scheduleIncarnation ||
			schedule.revision !== claim.scheduleRevision ||
			!schedule.enabled ||
			schedule.projectId !== claim.projectId ||
			schedule.actionKind !== claim.actionKind
		) {
			finish(
				s,
				nowMs,
				"cancelled-schedule-changed",
				gateOf(null, null),
				null,
				false,
				"schedule removed, disabled or revised after the claim",
			);
			return null;
		}
		if (!persistObservation(s, nowMs, admissionObserved)) {
			finish(s, nowMs, "failed", gateOf(schedule.cursor, null), null, false, "observation not committed");
			return null;
		}
		const authRead = s.store.readAuthorizations();
		const standing = endoAdvisoryAuthorizationStandingV0({
			schedule,
			file: authRead.ok && authRead.exists ? authRead.value : null,
			nowMs,
		});
		if (!authRead.ok || !standing.ok) {
			finish(
				s,
				nowMs,
				"refused-unauthorized",
				gateOf(schedule.cursor, null),
				null,
				false,
				!authRead.ok ? "authorizations unreadable" : standing.ok ? null : standing.refusal,
			);
			return null;
		}
		const authorization = standing.authorization;
		const wake = endoAdvisoryWakeDecisionV0({
			wake: schedule.wake,
			cursor: schedule.cursor,
			observation: obs,
			permitPartialObservation: authorization.policy.permitPartialObservation,
		});
		if (!wake.admit) {
			finish(s, nowMs, wake.status, gateOf(schedule.cursor, null), null, false, wake.detail);
			return null;
		}
		const gate = gateOf(schedule.cursor, wake.reason);
		if (endoAdvisoryEffectivePoolV0(authorization) === null) {
			finish(
				s,
				nowMs,
				"refused-model-unavailable",
				gate,
				null,
				false,
				"no local member within the grant's per-request ceiling",
			);
			return null;
		}
		const turns = s.store.listTurns(nowMs);
		if (!turns.ok || turns.problems.length > 0) {
			finish(
				s,
				nowMs,
				"refused-budget",
				gate,
				null,
				false,
				`turn ledger ${turns.ok ? "indeterminate" : turns.reason}: budget cannot be established`,
			);
			return null;
		}
		const budget = endoAdvisoryBudgetStandingV0({
			turns: turns.entries.filter((t) => t.admission.scheduleId === schedule.scheduleId),
			budget: authorization.budget,
			nowMs,
			currentLease: { epoch: lease.epoch, active: true },
		});
		if (!budget.admissible) {
			finish(s, nowMs, "refused-budget", gate, null, false, budget.refusal);
			return null;
		}
		const activePublicationMarginMs = authorization.resourceProfile?.publicationReserveMs ?? L.publicationMarginMs;
		const activeMaxTurnWallClockMs = authorization.resourceProfile?.advisoryTurnDeadlineMs ?? L.maxTurnWallClockMs;
		const turnDeadlineMs = Math.floor(
			Math.min(
				nowMs + Math.min(authorization.budget.maxTurnWallClockMs, activeMaxTurnWallClockMs),
				lease.expiresAtMs - activePublicationMarginMs,
				nowMs + activeLeaseTtlMs - (monotonicNow() - leaseStartedMs) - activePublicationMarginMs,
			),
		);
		if (turnDeadlineMs - nowMs < L.minInferenceWindowMs) {
			finish(
				s,
				nowMs,
				"refused-insufficient-lease",
				gate,
				null,
				false,
				"the remaining advisory lease cannot fit an inference window",
			);
			return null;
		}
		const admission: EndoAdvisoryTurnAdmissionV0 = {
			schemaVersion: ENDO_ADVISORY_TURN_ADMISSION_SCHEMA_V0,
			turnId,
			fireIdempotencyKey: claim.idempotencyKey,
			scheduleId: schedule.scheduleId,
			scheduleRevision: schedule.revision,
			projectId: schedule.projectId,
			actionKind: schedule.actionKind,
			authorizationId: authorization.authorizationId,
			poolSha256: authorization.poolSha256,
			...(authorization.resourceProfileSha256 === undefined
				? {}
				: { resourceProfileSha256: authorization.resourceProfileSha256 }),
			policySha256: endoAdvisoryPolicySha256V0(authorization.policy),
			budgetSha256: endoAdvisoryBudgetSha256V0(authorization.budget),
			leaseEpoch: lease.epoch,
			holderId,
			admittedAtMs: nowMs,
			turnDeadlineMs,
			wakeReason: wake.reason,
			semanticDigest: obs.semanticDigest as string,
			completeness: obs.completeness,
			observedAtMs: admissionObserved.observedAtMs,
			gaps: obs.gaps,
			reservation: endoAdvisoryReservationV0(authorization.budget),
			budgetBefore: {
				periodStartMs: budget.periodStartMs,
				turnsCharged: budget.turnsCharged,
				generatedTokensCharged: budget.generatedTokensCharged,
				uncertainTurns: budget.uncertainTurns,
			},
		};
		turnStartedMs = monotonicNow();
		if (s.writeAdmissionOnce(admission) !== "created") {
			finish(s, nowMs, "failed", gate, null, false, "admission record not linked");
			return null;
		}
		// The attempted digest is set at admission, so a crash after this point can never re-wake the same state.
		const file = s.store.readSchedules();
		if (
			!file.ok ||
			!file.exists ||
			s.writeSchedules({
				...file.value,
				revision: file.value.revision + 1,
				updatedAtMs: nowMs,
				schedules: file.value.schedules.map((x) =>
					x.scheduleId === schedule.scheduleId &&
					x.incarnation === claim.scheduleIncarnation &&
					x.revision === schedule.revision
						? withCursor(x, { lastAttemptedSemanticDigest: admission.semanticDigest, lastAttemptedAtMs: nowMs })
						: x,
				),
			}) !== "committed"
		) {
			finish(s, nowMs, "failed", gate, turnId, false, "attempted digest cursor not committed");
			return null;
		}
		return { admission, authorization };
	});
	// On a lock failure here the claim stays without an outcome; the next tick's recovery records it (nothing was dispatched).
	if (!phaseC.ok) return refuse(lockRefusal(phaseC.code), "advisory lock unavailable at admission");
	if (phaseC.result === null) return done(null, false);
	const { admission, authorization } = phaseC.result;
	await hooks.afterAdmission?.({ turnId });

	type Selection = { readonly skipped: readonly EndoAdvisorySkippedMemberV0[]; readonly fallback: boolean };
	const briefingMode: EndoCoordinatorBriefingModeV1 = options.briefingMode ?? "legacy-v0";
	const visibilityMode: EndoCoordinatorVisibilityModeV1 = options.visibilityMode ?? "status-v0";
	const groundedInstructionsSha =
		briefingMode === "grounded-v1"
			? ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_SHA256_V1
			: ENDO_ADVISORY_INSTRUCTIONS_SHA256_V0;
	const groundedQuestionSha =
		briefingMode === "grounded-v1"
			? ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_SHA256_V1
			: ENDO_ADVISORY_PROPOSAL_QUESTION_SHA256_V0;
	const promptQuestion =
		briefingMode === "grounded-v1" ? ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_V1 : ENDO_ADVISORY_PROPOSAL_QUESTION_V0;
	const notRequested: EndoAdvisoryProposalLinkV0 = { outcome: "not-requested", proposalId: null, refusal: null };
	const wantsProposal = admission.actionKind === "emit-operator-proposal";
	const proposalUnavailable: EndoAdvisoryProposalLinkV0 = wantsProposal
		? { outcome: "refused", proposalId: null, refusal: "briefing-unavailable" }
		: notRequested;

	/** The terminal turn record (briefing + accounting) and the fire outcome. Runs inside the lock. */
	const publish = (
		s: EndoAdvisoryLockedSessionV0,
		nowMs: number,
		args: {
			readonly availability: EndoAdvisoryBriefingV0["availability"];
			readonly refusal: string | null;
			readonly answer: string | null;
			readonly dispatch: EndoAdvisoryTurnDispatchV0 | null;
			readonly selection: Selection | null;
			readonly result: EndoCoordinatorBriefResultV0 | null;
			readonly trial: OpenClawCoordinatorTrialV0 | null;
			readonly publication: {
				digest: string | null;
				observedAtMs: number | null;
				currency: EndoAdvisoryPublicationCurrencyV0;
			};
			readonly proposal: EndoAdvisoryProposalLinkV0;
			readonly status: EndoAdvisoryFireOutcomeStatusV0;
		},
	) => {
		const usage = usageOf(args.trial);
		const admittedExchanges = args.dispatch === null ? 0 : (args.trial?.admittedExchanges ?? null);
		const charge =
			args.dispatch === null
				? { chargedCompletionRequests: 0, chargedGeneratedTokens: 0 }
				: endoAdvisorySettledChargeV0({
						reserved: admission.reservation,
						admittedExchanges,
						reportedCompletionTokens: usage.completion,
						usageReportComplete: usage.complete,
					});
		const accounting: EndoAdvisoryAccountingV0 = {
			reserved: admission.reservation,
			admittedExchanges,
			reportedPromptTokens: usage.prompt,
			reportedCompletionTokens: usage.completion,
			usageReportComplete: usage.complete,
			...charge,
			inferenceElapsedMs: args.trial?.inferenceElapsedMs ?? null,
		};
		const evidence = args.result?.availability === "available" ? args.result.evidence : null;
		const briefing: EndoAdvisoryBriefingV0 = {
			schemaVersion: ENDO_ADVISORY_BRIEFING_SCHEMA_V0,
			turnId,
			fireIdempotencyKey: claim.idempotencyKey,
			scheduleId: admission.scheduleId,
			scheduleRevision: admission.scheduleRevision,
			projectId: admission.projectId,
			actionKind: admission.actionKind,
			wakeReason: admission.wakeReason,
			leaseEpoch: lease.epoch,
			holderId,
			admittedAtMs: admission.admittedAtMs,
			publishedAtMs: Math.max(nowMs, admission.admittedAtMs),
			authorizationId: admission.authorizationId,
			poolSha256: admission.poolSha256,
			effectivePoolSha256: args.dispatch?.effectivePoolSha256 ?? null,
			...(admission.resourceProfileSha256 === undefined
				? {}
				: { resourceProfileSha256: admission.resourceProfileSha256 }),
			policySha256: admission.policySha256,
			budgetSha256: admission.budgetSha256,
			prompt: {
				instructionsSha256: groundedInstructionsSha,
				questionSha256: wantsProposal ? groundedQuestionSha : null,
				promptSha256: args.trial?.promptSha256 ?? null,
			},
			source: {
				admissionSemanticDigest: admission.semanticDigest,
				admissionObservedAtMs: admission.observedAtMs,
				completeness: admission.completeness,
				gaps: admission.gaps,
				evidence:
					evidence === null
						? null
						: {
								readAtMs: evidence.readAtMs,
								projectionSha256: evidence.projectionSha256,
								modelViewSha256: evidence.modelViewSha256,
							},
				publicationSemanticDigest: args.publication.digest,
				publicationObservedAtMs: args.publication.observedAtMs,
				currency: args.publication.currency,
			},
			model: {
				harness: args.result?.runtime.harness ?? "none",
				provider: args.result?.runtime.provider ?? "none",
				reportedModel: args.result?.runtime.model ?? "none",
				selectedMemberId: args.dispatch?.selectedMemberId ?? null,
				selectedModelId: args.dispatch?.selectedModelId ?? null,
				selectedEndpoint: args.dispatch?.selectedEndpoint ?? null,
				selectedReadiness: args.dispatch?.selectedReadiness ?? null,
				capacityConfirmed: args.dispatch?.capacityConfirmed ?? false,
				fallbackOccurred: args.selection?.fallback ?? false,
				skippedMembers: args.selection?.skipped ?? [],
				inferenceFailover: "never",
			},
			accounting,
			availability: args.availability,
			refusal: args.refusal,
			answer: args.answer,
			standing: "untrusted-model-interpretation",
			proposal: args.proposal,
		};
		let written: EndoAdvisoryWriteOnceV0;
		try {
			written = s.writeBriefingOnce(briefing);
		} catch {
			written = "failed";
		}
		const considered =
			written === "created" &&
			args.status === "briefing-published" &&
			args.publication.currency === "current-at-publication";
		finish(
			s,
			nowMs,
			written === "created" ? args.status : "failed",
			null,
			turnId,
			args.dispatch !== null,
			written === "created" ? args.refusal : "briefing record not linked; the turn stays charged at its reservation",
			considered ? { lastConsideredSemanticDigest: admission.semanticDigest, lastConsideredAtMs: nowMs } : {},
		);
	};
	const noPublication = { digest: null, observedAtMs: null, currency: "unknown-at-publication" as const };
	const notDispatched = (
		refusal: EndoAdvisoryDispatchRefusalV0,
		selection: Selection | null,
	): EndoAdvisoryTickResultV0 => {
		const locked = store.withAdvisoryLockSync((s) =>
			publish(s, now(), {
				availability: "not-dispatched",
				refusal,
				answer: null,
				dispatch: null,
				selection,
				result: null,
				trial: null,
				publication: noPublication,
				proposal: proposalUnavailable,
				status: dispatchRefusalStatus(refusal),
			}),
		);
		if (!locked.ok)
			return refuse(lockRefusal(locked.code), "advisory lock unavailable recording a pre-dispatch refusal");
		return done(turnId, false);
	};

	// ---- D: select (zero tokens, no lock) -----------------------------------------------------------------------------------------
	const effectivePool = endoAdvisoryEffectivePoolV0(authorization);
	if (effectivePool === null) return notDispatched("no-eligible-member", null);
	const effectivePoolSha256 = coordinatorModelPoolSha256V0(effectivePool);
	let liveProbeUsed = false;
	const live: EndoCoordinatorMemberObserverV0 = options.observeMember ?? ((member) => probeLocalEndpointV0(member));
	const resources = new DevelopAutomationStoreV0(options.root).readResources();
	const observer = createRecordedCoordinatorModelObserverV0({
		snapshot: resources.ok && resources.exists ? resources.value : null,
		expectedPoolSha256: authorization.poolSha256,
		now,
		maxAgeMs: authorization.policy.recordedObservationMaxAgeMs,
		...(authorization.policy.observationSource === "recorded-or-passive-probe"
			? {
					fallback: (member) => {
						liveProbeUsed = true;
						return live(member);
					},
				}
			: {}),
	});
	let selection: Awaited<ReturnType<typeof selectCoordinatorModelV0>>;
	try {
		selection = await selectCoordinatorModelV0(effectivePool, {}, observer);
	} catch {
		return notDispatched("no-eligible-member", null);
	}
	const selectionSummary: Selection = {
		skipped: [
			...endoAdvisoryExcludedMembersV0(authorization).map((memberId) => ({ memberId, reason: "excluded-by-grant" })),
			...selection.skippedMembers.map((m) => ({ memberId: m.memberId, reason: m.reason })),
		].slice(0, L.maxSkippedMembers),
		fallback: selection.ok && selection.fallbackOccurred,
	};
	if (!selection.ok) return notDispatched("no-eligible-member", selectionSummary);
	const capacityConfirmed = selection.observation.readiness === "ready";
	if (!capacityConfirmed && !authorization.policy.permitCapacityUnknown)
		return notDispatched("capacity-unknown-not-permitted", selectionSummary);
	const member = selection.member;
	const readiness = selection.observation.readiness;
	const fallbackOccurred = selection.fallbackOccurred;
	const request = wantsProposal
		? { projectId: admission.projectId, question: promptQuestion }
		: { projectId: admission.projectId };

	// ---- D.5: non-inference local runtime preflight (no lock, BEFORE dispatch linearization) --------------------------------------
	// Ensures local runtime/config mismatches (e.g. unverified OpenClaw version, unsafe XDG_RUNTIME_DIR, missing bwrap) refuse as
	// `not-dispatched` with 0 token charge rather than burning a full reservation after Phase E. Phase F still re-checks for TOCTOU.
	if (visibilityMode === "status-and-coordination-v1" && briefingMode !== "grounded-v1")
		return notDispatched("runtime-preflight-failed", selectionSummary);
	try {
		if (options.preflight !== undefined) {
			const pf = options.preflight();
			if (!pf.ok) return notDispatched("runtime-preflight-failed", selectionSummary);
		} else if (options.run === undefined) {
			if (admissionObserved.read === null) return notDispatched("runtime-preflight-failed", selectionSummary);
			const { preflightOpenClawCoordinatorV0 } = await import("../coordinator/openclaw.ts");
			const pf = preflightOpenClawCoordinatorV0(options.root, request, {
				target: coordinatorTargetFromMemberV0(member, authorization.resourceProfile),
				pinnedObservation: admissionObserved.read,
				briefingMode,
				visibilityMode,
			});
			if (!pf.ok) return notDispatched("runtime-preflight-failed", selectionSummary);
		}
	} catch {
		return notDispatched("runtime-preflight-failed", selectionSummary);
	}

	// ---- E: dispatch linearization point (lock) -----------------------------------------------------------------------------------
	await hooks.beforeDispatchRecord?.({ turnId });
	const phaseE = store.withAdvisoryLockSync((s): EndoAdvisoryTurnDispatchV0 | EndoAdvisoryDispatchRefusalV0 => {
		const nowMs = now();
		const currentLease = s.store.readLease();
		const leaseValue = currentLease.ok && currentLease.exists ? currentLease.value : null;
		if (leaseValue === null || leaseValue.epoch !== lease.epoch || leaseValue.holderId !== holderId)
			return "stale-lease-epoch";
		if (!ownsLease(s, nowMs)) return "insufficient-lease";
		const schedules = s.store.readSchedules();
		const schedule =
			schedules.ok && schedules.exists
				? schedules.value.schedules.find((x) => x.scheduleId === admission.scheduleId)
				: undefined;
		if (
			schedule === undefined ||
			schedule.incarnation !== claim.scheduleIncarnation ||
			schedule.revision !== admission.scheduleRevision ||
			!schedule.enabled
		)
			return "schedule-changed";
		const authRead = s.store.readAuthorizations();
		const standing = endoAdvisoryAuthorizationStandingV0({
			schedule,
			file: authRead.ok && authRead.exists ? authRead.value : null,
			nowMs,
		});
		if (!standing.ok)
			return standing.refusal === "authorization-expired" ? "authorization-expired" : "authorization-revoked";
		if (standing.authorization.authorizationId !== admission.authorizationId) return "authorization-revoked";
		const activePublicationMarginMs = authorization.resourceProfile?.publicationReserveMs ?? L.publicationMarginMs;
		const activeMaxTurnWallClockMs = authorization.resourceProfile?.advisoryTurnDeadlineMs ?? L.maxTurnWallClockMs;
		const effectiveTimeoutMs = Math.floor(
			Math.min(
				member.timeoutMs,
				admission.turnDeadlineMs - nowMs,
				admission.turnDeadlineMs - admission.admittedAtMs - (monotonicNow() - turnStartedMs),
				activeLeaseTtlMs - (monotonicNow() - leaseStartedMs) - activePublicationMarginMs,
				activeMaxTurnWallClockMs,
			),
		);
		if (effectiveTimeoutMs < L.minInferenceWindowMs) return "insufficient-lease";
		const dispatch: EndoAdvisoryTurnDispatchV0 = {
			schemaVersion: ENDO_ADVISORY_TURN_DISPATCH_SCHEMA_V0,
			turnId,
			leaseEpoch: lease.epoch,
			holderId,
			dispatchedAtMs: nowMs,
			authorizationId: admission.authorizationId,
			scheduleRevision: admission.scheduleRevision,
			effectivePoolSha256,
			...(admission.resourceProfileSha256 === undefined
				? {}
				: { resourceProfileSha256: admission.resourceProfileSha256 }),
			selectedMemberId: member.memberId,
			selectedModelId: member.modelId,
			selectedEndpoint: member.endpoint,
			selectedReadiness: readiness,
			observationBasis: liveProbeUsed ? "live-probe" : "recorded",
			capacityConfirmed,
			fallbackOccurred,
			skippedMembers: selectionSummary.skipped,
			inferenceDeadlineMs: nowMs + effectiveTimeoutMs,
			effectiveTimeoutMs,
		};
		return s.writeDispatchOnce(dispatch) === "created" ? dispatch : "storage-failed";
	});
	if (!phaseE.ok) return notDispatched(phaseE.code === "busy" ? "lock-busy" : "storage-failed", selectionSummary);
	if (typeof phaseE.result === "string") return notDispatched(phaseE.result, selectionSummary);
	const dispatch = phaseE.result;
	await hooks.afterDispatchRecord?.({ turnId });

	// ---- F: inference (no lock; the selected member only; never failed over or replayed) ------------------------------------------
	const target = Object.freeze({
		...coordinatorTargetFromMemberV0(member, authorization.resourceProfile),
		timeoutMs: dispatch.effectiveTimeoutMs,
		hostDeadline: true,
	});
	const run = options.run ?? (await import("../coordinator/openclaw.ts")).runOpenClawCoordinatorV0;
	let trial: OpenClawCoordinatorTrialV0 | null = null;
	let result: EndoCoordinatorBriefResultV0 | null;
	try {
		result = await briefFromCoordinatorSubstrateV0(request, {
			brief: (r) =>
				run(options.root, r, {
					pinnedObservation: admissionObserved.read!,
					target,
					provider: "llama.cpp (advisory pool member)",
					signal: AbortSignal.timeout(Math.max(1, dispatch.inferenceDeadlineMs - now())),
					...(briefingMode === "legacy-v0" ? {} : { briefingMode }),
					...(visibilityMode === "status-v0" ? {} : { visibilityMode }),
					...(briefingMode === "grounded-v1" && wantsProposal ? { includeProposalLine: true } : {}),
					trial: (t) => {
						trial = t;
					},
				}),
		});
	} catch {
		result = null;
	}
	if (result !== null && result.availability === "available") {
		const reason =
			result.runtime.model !== member.modelId
				? "model-identity-mismatch"
				: now() > dispatch.inferenceDeadlineMs
					? "inference-timeout"
					: null;
		if (reason !== null)
			result = {
				schemaVersion: result.schemaVersion,
				projectId: result.projectId,
				runtime: result.runtime,
				availability: "unavailable",
				reason,
			};
	}
	await hooks.afterInference?.({ turnId });

	// ---- G: publication observation (no lock) -------------------------------------------------------------------------------------
	const pub = await observe();
	let expectedModelViewSha256: string | null = null;
	if (briefingMode === "grounded-v1" && admissionObserved.read !== null) {
		try {
			const { pinnedCoordinatorBriefStatusV0 } = await import("../coordinator/openclaw.ts");
			const pinned = pinnedCoordinatorBriefStatusV0(options.root, admission.projectId, admissionObserved.read);
			if (pinned.ok) {
				expectedModelViewSha256 = endoCoordinatorModelViewSha256V1(
					buildEndoCoordinatorModelViewV1({
						projectId: admission.projectId,
						statusView: pinned.view,
						coordination: pinned.coordination,
						visibilityMode,
					}),
				);
			}
		} catch {
			expectedModelViewSha256 = null;
		}
	}
	const modelViewMatches =
		briefingMode !== "grounded-v1" ||
		(expectedModelViewSha256 !== null &&
			result?.availability === "available" &&
			result.evidence.modelViewSha256 === expectedModelViewSha256);
	const currency: EndoAdvisoryPublicationCurrencyV0 =
		pub.observation.semanticDigest === null
			? "unknown-at-publication"
			: pub.observation.semanticDigest === admission.semanticDigest
				? result?.availability === "available" &&
					admissionObserved.read !== null &&
					result.evidence.projectionSha256 === digest(admissionObserved.read.status) &&
					modelViewMatches
					? "current-at-publication"
					: "unknown-at-publication"
				: "stale-at-publication";
	await hooks.beforePublish?.({ turnId });

	// ---- H: publish (lock) --------------------------------------------------------------------------------------------------------
	const final = result;
	const published = store.withAdvisoryLockSync((s) => {
		const nowMs = now();
		const schedules = s.store.readSchedules();
		const schedule =
			schedules.ok && schedules.exists
				? schedules.value.schedules.find((x) => x.scheduleId === admission.scheduleId)
				: undefined;
		const authRead = s.store.readAuthorizations();
		const standing =
			schedule === undefined
				? null
				: endoAdvisoryAuthorizationStandingV0({
						schedule,
						file: authRead.ok && authRead.exists ? authRead.value : null,
						nowMs,
					});
		const observationCommitted = ownsLease(s, nowMs) && persistObservation(s, nowMs, pub);
		const withheld = !ownsLease(s, nowMs)
			? "lease-lost-in-flight"
			: monotonicNow() - turnStartedMs >= admission.turnDeadlineMs - admission.admittedAtMs ||
					nowMs >= admission.turnDeadlineMs
				? "turn-deadline-exceeded"
				: schedule === undefined ||
						schedule.incarnation !== claim.scheduleIncarnation ||
						schedule.revision !== admission.scheduleRevision ||
						!schedule.enabled
					? "schedule-changed-in-flight"
					: standing === null ||
							!standing.ok ||
							standing.authorization.authorizationId !== admission.authorizationId
						? standing !== null && !standing.ok && standing.refusal === "authorization-expired"
							? "authorization-expired-in-flight"
							: "authorization-revoked-in-flight"
						: !observationCommitted
							? "publication-observation-not-committed"
							: null;
		const base = {
			dispatch,
			selection: selectionSummary,
			result: final,
			trial: trial as OpenClawCoordinatorTrialV0 | null,
			publication: { digest: pub.observation.semanticDigest, observedAtMs: pub.observedAtMs, currency },
		};
		if (withheld !== null) {
			publish(s, nowMs, {
				...base,
				availability: "withheld",
				refusal: withheld,
				answer: null,
				proposal: proposalUnavailable,
				status: "result-withheld",
			});
			return;
		}
		if (
			final === null ||
			final.availability !== "available" ||
			Buffer.byteLength(final.answer, "utf8") > L.maxAnswerBytes
		) {
			const reason =
				final === null
					? "runtime-unavailable"
					: final.availability === "unavailable"
						? final.reason
						: "answer-too-large";
			publish(s, nowMs, {
				...base,
				availability: "unavailable",
				refusal: reason,
				answer: null,
				proposal: proposalUnavailable,
				status: "briefing-refused",
			});
			return;
		}
		const proposal = wantsProposal ? linkProposal(s, nowMs, final.answer, pub, currency, admission) : notRequested;
		publish(s, nowMs, {
			...base,
			availability: "available",
			refusal: null,
			answer: final.answer,
			proposal,
			status: "briefing-published",
		});
	});
	if (!published.ok)
		return refuse(
			lockRefusal(published.code),
			"advisory lock unavailable at publication; the dispatched turn stays charged",
			true,
		);
	return done(turnId, true);
}

/** Parse, ground and link at most one proposal from an available briefing. Runs inside the lock; never grants anything. */
function linkProposal(
	s: EndoAdvisoryLockedSessionV0,
	nowMs: number,
	answer: string,
	pub: { readonly read: EndoAdvisoryProjectReadV0 | null; readonly observation: EndoAdvisorySemanticObservationV0 },
	currency: EndoAdvisoryPublicationCurrencyV0,
	admission: EndoAdvisoryTurnAdmissionV0,
): EndoAdvisoryProposalLinkV0 {
	const refused = (refusal: NonNullable<EndoAdvisoryProposalLinkV0["refusal"]>): EndoAdvisoryProposalLinkV0 => ({
		outcome: "refused",
		proposalId: null,
		refusal,
	});
	const line = endoAdvisoryParseProposalLineV0(answer);
	if (line.state === "refused") return refused(line.refusal);
	if (line.state === "none") return { outcome: "none-proposed", proposalId: null, refusal: null };
	// Grounded only against the state the briefing considered: if the state moved during inference, nothing is created.
	if (pub.read === null || pub.observation.semanticDigest === null || currency !== "current-at-publication")
		return refused("proposal-state-stale");
	const grounded = endoAdvisoryGroundProposalV0({
		projectId: admission.projectId,
		kind: line.kind,
		taskId: line.taskId,
		status: pub.read.status,
		coordination: pub.read.coordination,
		observationGaps: pub.observation.gaps,
	});
	if (!grounded.ok) return refused(grounded.refusal);
	const proposalId = endoAdvisoryProposalIdV0(grounded.dedupKey, pub.observation.semanticDigest);
	const listing = s.store.listProposals();
	if (!listing.ok) return refused("storage-failed");
	// Re-derived from a published briefing: recorded on the proposal store, so its standing survives turn retention.
	if (listing.entries.some((e) => e.proposal.proposalId === proposalId))
		return s.recordProposalGrounding(proposalId, nowMs) === "committed"
			? { outcome: "deduplicated", proposalId, refusal: null }
			: refused("storage-failed");
	const newest = new Map<string, string>();
	for (const e of listing.entries)
		if (!newest.has(e.proposal.dedupKey)) newest.set(e.proposal.dedupKey, e.proposal.proposalId);
	const pending = listing.entries.filter(
		(e) =>
			e.proposal.projectId === admission.projectId &&
			e.dispositions.length === 0 &&
			newest.get(e.proposal.dedupKey) === e.proposal.proposalId &&
			e.proposal.dedupKey !== grounded.dedupKey,
	).length;
	if (pending >= L.maxPendingProposalsPerProject) return refused("proposal-queue-full");
	const proposal: EndoAdvisoryProposalV0 = {
		schemaVersion: ENDO_ADVISORY_PROPOSAL_SCHEMA_V0,
		proposalId,
		dedupKey: grounded.dedupKey,
		projectId: admission.projectId,
		kind: grounded.kind,
		subject: grounded.subject,
		evidence: {
			facts: grounded.facts,
			semanticDigest: pub.observation.semanticDigest,
			admissionSemanticDigest: admission.semanticDigest,
			projectionSha256: null,
		},
		uncertainties: grounded.uncertainties,
		rationale: { source: "model-briefing", turnId: admission.turnId },
		generatedAtMs: nowMs,
		scheduleId: admission.scheduleId,
		scheduleRevision: admission.scheduleRevision,
		fireIdempotencyKey: admission.fireIdempotencyKey,
		turnId: admission.turnId,
		standing: "untrusted-advisory-proposal",
		authority: { grants: "none", executionAuthority: false, requiresOperatorConfirmationPerAttempt: true },
	};
	let written: EndoAdvisoryWriteOnceV0;
	try {
		written = s.writeProposalOnce(proposal);
	} catch {
		written = "failed";
	}
	if (written === "exists") return { outcome: "deduplicated", proposalId, refusal: null };
	if (written !== "created") return refused("storage-failed");
	return { outcome: "created", proposalId, refusal: null };
}
