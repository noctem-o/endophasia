// Operator-side S2 mutations and the bounded read-only advisory projection (COORDINATOR-AUTOMATION-S2,
// docs/designs/coordinator-automation-s2-implementation.md). Every mutation is an explicit operator act under the advisory lock;
// none contacts a model, probes an endpoint, or reads or writes task, coordination, route or event state.
//
// Revision discipline (same as S1): add, enable, disable and every revision bump the schedule revision, so an authorization bound
// to an earlier revision stops standing at once. A schedule is created disabled; enabling it and then authorizing that exact
// revision are two separate operator acts. Disabling or removing a schedule also marks its live grant superseded.

import { randomBytes } from "node:crypto";
import type { EndoCoordinatorModelPoolAnyV1 } from "../../protocol/coordinator-model-pool.ts";
import {
	type EndoCoordinatorResourceProfileV1,
	validateEndoCoordinatorResourceProfileV1,
} from "../../protocol/coordinator-resource-policy.ts";
import {
	ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0,
	ENDO_ADVISORY_LIMITS_V0,
	ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0,
	ENDO_ADVISORY_SCHEDULES_SCHEMA_V0,
	type EndoAdvisoryActionKindV0,
	type EndoAdvisoryAuthorizationsFileV0,
	type EndoAdvisoryAuthorizationV0,
	type EndoAdvisoryBriefingV0,
	type EndoAdvisoryBudgetV0,
	type EndoAdvisoryFireOutcomeV0,
	type EndoAdvisoryPolicyV0,
	type EndoAdvisoryProposalDispositionV0,
	type EndoAdvisoryProposalV0,
	type EndoAdvisorySchedulesFileV0,
	type EndoAdvisoryScheduleV0,
	type EndoAdvisoryWakePolicyV0,
	emptyEndoAdvisoryCursorV0,
	validateEndoAdvisoryAuthorizationV0,
	validateEndoAdvisoryScheduleV0,
} from "../../protocol/develop-advisory.ts";
import type { EndoScheduleMissedRunPolicyV0, EndoScheduleTriggerV0 } from "../../protocol/develop-automation.ts";
import { EndoInvalidRecordV0 } from "../../protocol/versioned.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	coordinatorModelPoolSha256V0,
	endoCoordinatorResourceProfileSha256V1,
} from "../../runtime/contracts/coordinator-model-pool.ts";
import {
	type EndoAdvisoryAuthorizationStandingV0,
	type EndoAdvisoryBudgetStandingV0,
	type EndoAdvisoryProposalCurrencyV0,
	endoAdvisoryAuthorizationIdV0,
	endoAdvisoryAuthorizationStandingV0,
	endoAdvisoryBudgetStandingV0,
	endoAdvisoryProposalCurrencyV0,
	endoAdvisoryTurnChargeV0,
} from "../../runtime/contracts/develop-advisory.ts";
import { DevelopAdvisoryStoreV0, type EndoAdvisoryLockedSessionV0 } from "../../storage/develop-advisory.ts";

const L = ENDO_ADVISORY_LIMITS_V0;

export type EndoAdvisoryMutationCodeV0 =
	| "lock-busy"
	| "unsafe-path"
	| "storage-failed"
	| "commit-uncertain"
	| "unreadable"
	| "invalid"
	| "not-found"
	| "already-exists"
	| "stale-revision"
	| "too-many"
	| "not-enabled"
	| "already-decided";

export type EndoAdvisoryMutationResultV0<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: EndoAdvisoryMutationCodeV0; readonly detail?: string };

class Refusal extends Error {
	readonly code: EndoAdvisoryMutationCodeV0;
	constructor(code: EndoAdvisoryMutationCodeV0, detail?: string) {
		super(detail ?? code);
		this.code = code;
	}
}

function mutate<T>(
	root: string,
	now: () => number,
	fn: (s: EndoAdvisoryLockedSessionV0, nowMs: number) => T,
): EndoAdvisoryMutationResultV0<T> {
	const store = new DevelopAdvisoryStoreV0(root, { now });
	try {
		const locked = store.withAdvisoryLockSync((s) => fn(s, now()));
		if (!locked.ok) return { ok: false, code: locked.code === "busy" ? "lock-busy" : locked.code };
		return { ok: true, value: locked.result };
	} catch (error) {
		if (error instanceof Refusal) return { ok: false, code: error.code, detail: error.message };
		if (error instanceof EndoInvalidRecordV0) return { ok: false, code: "invalid", detail: error.message };
		throw error;
	}
}

const commit = (outcome: "committed" | "storage-failed" | "commit-uncertain") => {
	if (outcome !== "committed") throw new Refusal(outcome);
};

function readSchedulesOrEmpty(s: EndoAdvisoryLockedSessionV0): EndoAdvisorySchedulesFileV0 {
	const read = s.store.readSchedules();
	if (!read.ok)
		throw new Refusal(read.reason === "unsafe-path" ? "unsafe-path" : "unreadable", `schedules.json ${read.reason}`);
	return read.exists
		? read.value
		: {
				schemaVersion: ENDO_ADVISORY_SCHEDULES_SCHEMA_V0,
				revision: 0,
				updatedAtMs: 0,
				schedules: [],
				retiredCursors: [],
			};
}

function readAuthorizationsOrEmpty(s: EndoAdvisoryLockedSessionV0): EndoAdvisoryAuthorizationsFileV0 {
	const read = s.store.readAuthorizations();
	if (!read.ok)
		throw new Refusal(
			read.reason === "unsafe-path" ? "unsafe-path" : "unreadable",
			`authorizations.json ${read.reason}`,
		);
	return read.exists
		? read.value
		: { schemaVersion: ENDO_ADVISORY_AUTHORIZATIONS_SCHEMA_V0, revision: 0, updatedAtMs: 0, authorizations: [] };
}

function supersedeLiveGrants(
	s: EndoAdvisoryLockedSessionV0,
	scheduleId: string,
	nowMs: number,
	revocation: "operator-revoked" | "superseded",
): number {
	const file = readAuthorizationsOrEmpty(s);
	let changed = 0;
	const authorizations = file.authorizations.map((a) => {
		if (a.scheduleId !== scheduleId || a.revokedAtMs !== null) return a;
		changed += 1;
		return { ...a, revokedAtMs: Math.max(nowMs, a.grantedAtMs), revocation };
	});
	if (changed > 0)
		commit(s.writeAuthorizations({ ...file, revision: file.revision + 1, updatedAtMs: nowMs, authorizations }));
	return changed;
}

function findSchedule(
	file: EndoAdvisorySchedulesFileV0,
	scheduleId: string,
	expectedRevision: number | undefined,
): EndoAdvisoryScheduleV0 {
	const schedule = file.schedules.find((x) => x.scheduleId === scheduleId);
	if (schedule === undefined) throw new Refusal("not-found", `no advisory schedule ${scheduleId}`);
	if (expectedRevision !== undefined && expectedRevision !== schedule.revision)
		throw new Refusal(
			"stale-revision",
			`schedule ${scheduleId} is at revision ${schedule.revision}, not ${expectedRevision}`,
		);
	return schedule;
}

export interface AddEndoAdvisoryScheduleInputV0 {
	readonly scheduleId: string;
	readonly label: string | null;
	readonly projectId: string;
	readonly actionKind: EndoAdvisoryActionKindV0;
	readonly wake: EndoAdvisoryWakePolicyV0;
	readonly missedRunPolicy: EndoScheduleMissedRunPolicyV0;
	readonly trigger: EndoScheduleTriggerV0;
}

/** Add an advisory schedule. It is always created DISABLED and unauthorized: adding a schedule never makes a turn possible. */
export function addEndoAdvisoryScheduleV0(
	root: string,
	input: AddEndoAdvisoryScheduleInputV0,
	now: () => number = Date.now,
) {
	return mutate(root, now, (s, nowMs) => {
		const file = readSchedulesOrEmpty(s);
		if (file.schedules.some((x) => x.scheduleId === input.scheduleId))
			throw new Refusal("already-exists", `advisory schedule ${input.scheduleId} exists`);
		if (file.schedules.length >= L.maxSchedules)
			throw new Refusal("too-many", `at most ${L.maxSchedules} advisory schedules`);
		const retired = file.retiredCursors.find((r) => r.scheduleId === input.scheduleId);
		const schedule = validateEndoAdvisoryScheduleV0({
			...input,
			incarnation: randomBytes(32).toString("hex"),
			revision: 1,
			enabled: false,
			createdAtMs: nowMs,
			updatedAtMs: nowMs,
			cursor: {
				...emptyEndoAdvisoryCursorV0(),
				lastConsumedWindowStartMs: retired?.lastConsumedWindowStartMs ?? null,
			},
		});
		commit(
			s.writeSchedules({
				...file,
				revision: file.revision + 1,
				updatedAtMs: nowMs,
				schedules: [...file.schedules, schedule],
				retiredCursors: file.retiredCursors.filter((r) => r.scheduleId !== input.scheduleId),
			}),
		);
		return schedule;
	});
}

/** Enable or disable. Both bump the revision; disabling also supersedes the live grant, so re-enabling needs a new grant. */
export function setEndoAdvisoryScheduleEnabledV0(
	root: string,
	scheduleId: string,
	enabled: boolean,
	expectedRevision: number | undefined,
	now: () => number = Date.now,
) {
	return mutate(root, now, (s, nowMs) => {
		const file = readSchedulesOrEmpty(s);
		const schedule = findSchedule(file, scheduleId, expectedRevision);
		const next: EndoAdvisoryScheduleV0 = {
			...schedule,
			enabled,
			revision: schedule.revision + 1,
			updatedAtMs: nowMs,
		};
		commit(
			s.writeSchedules({
				...file,
				revision: file.revision + 1,
				updatedAtMs: nowMs,
				schedules: file.schedules.map((x) => (x.scheduleId === scheduleId ? next : x)),
			}),
		);
		const superseded = enabled ? 0 : supersedeLiveGrants(s, scheduleId, nowMs, "superseded");
		return { schedule: next, supersededAuthorizations: superseded };
	});
}

/** Remove a schedule, retaining its consumed-window cursor (a re-added id never replays) and superseding its grant. */
export function removeEndoAdvisoryScheduleV0(
	root: string,
	scheduleId: string,
	expectedRevision: number | undefined,
	now: () => number = Date.now,
) {
	return mutate(root, now, (s, nowMs) => {
		const file = readSchedulesOrEmpty(s);
		const schedule = findSchedule(file, scheduleId, expectedRevision);
		const retiredCursors = [
			...file.retiredCursors.filter((r) => r.scheduleId !== scheduleId),
			...(schedule.cursor.lastConsumedWindowStartMs === null
				? []
				: [
						{
							scheduleId,
							lastConsumedWindowStartMs: schedule.cursor.lastConsumedWindowStartMs,
							retiredAtMs: nowMs,
						},
					]),
		];
		if (retiredCursors.length > L.maxRetiredCursors)
			throw new Refusal("too-many", "cannot remove schedule without losing a retained window floor");
		const supersededAuthorizations = supersedeLiveGrants(s, scheduleId, nowMs, "superseded");
		commit(
			s.writeSchedules({
				...file,
				revision: file.revision + 1,
				updatedAtMs: nowMs,
				schedules: file.schedules.filter((x) => x.scheduleId !== scheduleId),
				retiredCursors,
			}),
		);
		return { removed: schedule, supersededAuthorizations };
	});
}

export interface AuthorizeEndoAdvisoryInputV0 {
	readonly scheduleId: string;
	/** Required: the exact revision the operator reviewed. A grant never binds "whatever revision is current". */
	readonly scheduleRevision: number;
	readonly pool: EndoCoordinatorModelPoolAnyV1;
	/** Opt-in governed cognitive resource policy (`COORDINATOR-REASONING-001`). Omit for V0 limits. */
	readonly resourceProfile?: EndoCoordinatorResourceProfileV1;
	readonly policy: EndoAdvisoryPolicyV0;
	readonly budget: EndoAdvisoryBudgetV0;
	readonly lifetimeMs: number;
}

/** Grant one schedule revision a bounded advisory authorization. Supersedes any live grant for the schedule. */
export function authorizeEndoAdvisoryScheduleV0(
	root: string,
	input: AuthorizeEndoAdvisoryInputV0,
	now: () => number = Date.now,
) {
	return mutate(root, now, (s, nowMs) => {
		const schedule = findSchedule(readSchedulesOrEmpty(s), input.scheduleId, input.scheduleRevision);
		if (!schedule.enabled) throw new Refusal("not-enabled", "enable the schedule first; enabling bumps its revision");
		const resourceProfile =
			input.resourceProfile === undefined
				? undefined
				: validateEndoCoordinatorResourceProfileV1(input.resourceProfile, "resourceProfile");
		const resourceProfileSha256 =
			resourceProfile === undefined ? undefined : endoCoordinatorResourceProfileSha256V1(resourceProfile);
		const grant = {
			scheduleId: schedule.scheduleId,
			scheduleIncarnation: schedule.incarnation,
			scheduleRevision: schedule.revision,
			projectId: schedule.projectId,
			actionKind: schedule.actionKind,
			poolSha256: coordinatorModelPoolSha256V0(input.pool),
			pool: input.pool,
			...(resourceProfile === undefined ? {} : { resourceProfile, resourceProfileSha256 }),
			policy: input.policy,
			budget: input.budget,
			grantedAtMs: nowMs,
			expiresAtMs: nowMs + input.lifetimeMs,
		};
		const authorization: EndoAdvisoryAuthorizationV0 = validateEndoAdvisoryAuthorizationV0({
			authorizationId: endoAdvisoryAuthorizationIdV0(grant),
			...grant,
			revokedAtMs: null,
			revocation: null,
		});
		// One write: the previous grant is superseded in the same file that adds its replacement, so a refused write leaves the old
		// grant exactly as it was, never a revoked grant with no successor.
		const file = readAuthorizationsOrEmpty(s);
		const authorizations = [
			...file.authorizations.map((a) =>
				a.scheduleId === schedule.scheduleId && a.revokedAtMs === null
					? { ...a, revokedAtMs: Math.max(nowMs, a.grantedAtMs), revocation: "superseded" as const }
					: a,
			),
			authorization,
		];
		const next = () => ({ ...file, revision: file.revision + 1, updatedAtMs: nowMs, authorizations });
		const bytes = () => Buffer.byteLength(`${canonicalEndoJsonV0(next() as never)}\n`, "utf8");
		// Bounded history, by count and by serialized bytes: drop the oldest revoked grants first; a live grant is never dropped. This
		// also compacts any history written before the byte bound was enforced, so re-running authorize is always the recovery.
		while (authorizations.length > L.maxAuthorizations || bytes() > L.maxFileBytes) {
			const i = authorizations.findIndex((a) => a.revokedAtMs !== null);
			if (i < 0)
				throw new Refusal("too-many", "the live advisory authorizations alone exceed the authorization file bound");
			authorizations.splice(i, 1);
		}
		commit(s.writeAuthorizations(next()));
		return authorization;
	});
}

/** Revoke a schedule's live grant. Effective for every turn not yet past its dispatch record; see the design doc for its limits. */
export function revokeEndoAdvisoryAuthorizationV0(root: string, scheduleId: string, now: () => number = Date.now) {
	return mutate(root, now, (s, nowMs) => {
		const revoked = supersedeLiveGrants(s, scheduleId, nowMs, "operator-revoked");
		if (revoked === 0) throw new Refusal("not-found", `no live advisory authorization for ${scheduleId}`);
		return { revoked };
	});
}

/** Acknowledge or dismiss a proposal. This changes the advisory queue only: no task, assignment, route or harness is touched. */
export function decideEndoAdvisoryProposalV0(
	root: string,
	proposalId: string,
	disposition: EndoAdvisoryProposalDispositionV0,
	note: string | null,
	now: () => number = Date.now,
) {
	return mutate(root, now, (s, nowMs) => {
		const proposal = s.store.readProposal(proposalId);
		if (!proposal.ok) throw new Refusal(proposal.reason === "unsafe-path" ? "unsafe-path" : "unreadable");
		if (!proposal.exists) throw new Refusal("not-found", `no proposal ${proposalId}`);
		for (const d of ["acknowledged", "dismissed"] as const) {
			const prior = s.store.readProposalState(proposalId, d);
			if (!prior.ok || prior.exists)
				throw new Refusal("already-decided", `proposal ${proposalId} already has a disposition`);
		}
		const state = {
			schemaVersion: ENDO_ADVISORY_PROPOSAL_STATE_SCHEMA_V0,
			proposalId,
			disposition,
			decidedAtMs: nowMs,
			note,
			authority: { grants: "none", affects: "advisory-queue-only" },
		} as const;
		const written = s.writeProposalStateOnce(state);
		if (written === "exists") throw new Refusal("already-decided");
		if (written === "failed") throw new Refusal("storage-failed");
		return state;
	});
}

// ---- Read-only projection --------------------------------------------------------------------------------------------------------

export type EndoAdvisoryProposalQueueStateV0 = "pending" | "acknowledged" | "dismissed" | "superseded";

export interface EndoAdvisoryProposalViewV0 {
	readonly proposal: EndoAdvisoryProposalV0;
	readonly queueState: EndoAdvisoryProposalQueueStateV0;
	/** Whether the evidence is the latest observed semantic state of its project. A stale proposal stays visible, marked stale. */
	readonly currency: EndoAdvisoryProposalCurrencyV0;
	readonly decidedAtMs: number | null;
	readonly note: string | null;
}

export interface EndoAdvisoryScheduleViewV0 {
	readonly schedule: EndoAdvisoryScheduleV0;
	readonly authorization: EndoAdvisoryAuthorizationStandingV0;
	readonly budget: EndoAdvisoryBudgetStandingV0 | null;
}

export interface EndoAdvisoryProjectionV0 {
	readonly schemaVersion: "endo.advisory-projection.v0";
	readonly readAtMs: number;
	readonly standing: "untrusted-advisory-state";
	readonly problems: readonly string[];
	readonly lease: {
		readonly epoch: number;
		readonly holderId: string;
		readonly active: boolean;
		readonly expiresAtMs: number;
	} | null;
	readonly schedules: readonly EndoAdvisoryScheduleViewV0[];
	readonly fires: readonly EndoAdvisoryFireOutcomeV0[];
	readonly briefings: readonly EndoAdvisoryBriefingV0[];
	readonly turns: readonly {
		readonly turnId: string;
		readonly scheduleId: string;
		readonly state: string;
		readonly admittedAtMs: number;
	}[];
	/** Every pending proposal, always; decided and superseded ones newest first up to the limit. */
	readonly proposals: readonly EndoAdvisoryProposalViewV0[];
	/** What the proposal listing holds and what it left out, so a truncated list cannot be mistaken for a complete one. */
	readonly proposalCounts: {
		readonly retained: number;
		readonly pending: number;
		readonly listed: number;
		readonly withheld: number;
		readonly withheldHint: string | null;
	};
}

/** Lock-free, bounded and read-only: creates nothing, takes no lock, contacts nothing. */
export function readEndoAdvisoryProjectionV0(
	root: string,
	options: { readonly now?: () => number; readonly limit?: number } = {},
): EndoAdvisoryProjectionV0 {
	const nowMs = (options.now ?? Date.now)();
	const limit = Math.max(1, Math.min(options.limit ?? 50, 256));
	const store = new DevelopAdvisoryStoreV0(root);
	const problems: string[] = [];
	const schedulesRead = store.readSchedules();
	const authRead = store.readAuthorizations();
	const leaseRead = store.readLease();
	const observationsRead = store.readObservations();
	if (!schedulesRead.ok) problems.push(`schedules.json ${schedulesRead.reason}`);
	if (!authRead.ok) problems.push(`authorizations.json ${authRead.reason}`);
	if (!leaseRead.ok) problems.push(`lease.json ${leaseRead.reason}`);
	if (!observationsRead.ok) problems.push(`observations.json ${observationsRead.reason}`);
	const lease = leaseRead.ok && leaseRead.exists ? leaseRead.value : null;
	const leaseActive = lease !== null && lease.releasedAtMs === null && nowMs < lease.expiresAtMs;
	const turns = store.listTurns(nowMs);
	if (!turns.ok) problems.push(`turns ${turns.reason}`);
	else for (const p of turns.problems) problems.push(`turns/${p.name} ${p.reason}`);
	const fires = store.listFires();
	if (!fires.ok) problems.push(`fires ${fires.reason}`);
	const proposals = store.listProposals();
	if (!proposals.ok) problems.push(`proposals ${proposals.reason}`);
	else for (const p of proposals.problems) problems.push(`proposals/${p.name} ${p.reason}`);
	const currentLease = lease === null ? null : { epoch: lease.epoch, active: leaseActive };
	const schedules: EndoAdvisoryScheduleViewV0[] = (
		schedulesRead.ok && schedulesRead.exists ? schedulesRead.value.schedules : []
	).map((schedule) => {
		const authorization = endoAdvisoryAuthorizationStandingV0({
			schedule,
			file: authRead.ok && authRead.exists ? authRead.value : null,
			nowMs,
		});
		const budget =
			authorization.ok && turns.ok && turns.problems.length === 0
				? endoAdvisoryBudgetStandingV0({
						turns: turns.entries.filter((t) => t.admission.scheduleId === schedule.scheduleId),
						budget: authorization.authorization.budget,
						nowMs,
						currentLease,
					})
				: null;
		return { schedule, authorization, budget };
	});
	const latest = new Map(
		(observationsRead.ok && observationsRead.exists ? observationsRead.value.projects : []).map((p) => [
			p.projectId,
			p,
		]),
	);
	// Entries come most recently grounded first, so the first per dedup key is the current recommendation (as retention sees it).
	const newest = new Map<string, string>();
	const proposalViews: EndoAdvisoryProposalViewV0[] = [];
	for (const e of proposals.ok ? proposals.entries : []) {
		if (!newest.has(e.proposal.dedupKey)) newest.set(e.proposal.dedupKey, e.proposal.proposalId);
		const decision = [...e.dispositions].sort((x, y) => x.decidedAtMs - y.decidedAtMs)[0];
		const queueState: EndoAdvisoryProposalQueueStateV0 =
			decision !== undefined
				? decision.disposition
				: newest.get(e.proposal.dedupKey) === e.proposal.proposalId
					? "pending"
					: "superseded";
		proposalViews.push({
			proposal: e.proposal,
			queueState,
			currency: endoAdvisoryProposalCurrencyV0(
				e.proposal.evidence.semanticDigest,
				latest.get(e.proposal.projectId) ?? null,
			),
			decidedAtMs: decision?.decidedAtMs ?? null,
			note: decision?.note ?? null,
		});
	}
	const decided = proposalViews.filter((v) => v.queueState !== "pending");
	const decidedListed = new Set(decided.slice(0, limit));
	const listedProposals = proposalViews.filter((v) => v.queueState === "pending" || decidedListed.has(v));
	return {
		schemaVersion: "endo.advisory-projection.v0",
		readAtMs: nowMs,
		standing: "untrusted-advisory-state",
		problems: problems.slice(0, 64),
		lease:
			lease === null
				? null
				: { epoch: lease.epoch, holderId: lease.holderId, active: leaseActive, expiresAtMs: lease.expiresAtMs },
		schedules,
		fires: (fires.ok ? fires.entries : []).flatMap((e) => (e.outcome === null ? [] : [e.outcome])).slice(0, limit),
		briefings: (turns.ok ? turns.entries : [])
			.flatMap((t) => (t.briefing === null ? [] : [t.briefing]))
			.slice(0, limit),
		turns: (turns.ok ? turns.entries : []).slice(0, limit).map((t) => ({
			turnId: t.admission.turnId,
			scheduleId: t.admission.scheduleId,
			state: endoAdvisoryTurnChargeV0(t, currentLease).state,
			admittedAtMs: t.admission.admittedAtMs,
		})),
		proposals: listedProposals,
		proposalCounts: {
			retained: proposalViews.length,
			pending: proposalViews.length - decided.length,
			listed: listedProposals.length,
			withheld: decided.length - decidedListed.size,
			withheldHint:
				decided.length > decidedListed.size
					? `${decided.length - decidedListed.size} decided or superseded proposal(s) not listed; every pending one is. Raise --limit (up to 256) to list them.`
					: null,
		},
	};
}
