/**
 * Phase 12 — adaptive concurrency policy (README "## Phase 12 — Operational substrate &
 * integration"): the pure, protocol-bound service that turns an explicit, versioned
 * `endo.model-concurrency-policy.v0` record into a per-member concurrency plan for one pool,
 * and applies a recorded plan to one pool's scheduler state. No runtime is observed: the
 * plan is computed from the presented policy, pool, current counts, and telemetry records.
 *
 * Plan derivation (never invented): per pool member, the window is the member's last
 * `windowSize` telemetry records in id order (id order is record order; records carry no
 * timestamp). A member with no window records — or a window whose call sum is zero — holds
 * at its current count for "no-telemetry" (there is no evidence to act on). A window with
 * fewer than `windowSize` records holds for "insufficient-window". Otherwise the window
 * failure rate is the window's failures / calls: above the policy's failureDecreaseThreshold
 * the target is current - step (floored at the policy's minConcurrency) for
 * "failure-threshold"; below the policy's failureIncreaseThreshold AND below the latency
 * increase threshold, when the policy sets one (the window's durationMs / calls), the target
 * is current + step (capped at the member's maxConcurrency) for "performance-threshold";
 * otherwise the member holds for "steady". A target clamped back to the current count holds
 * for "at-bound" (the member is already at its floor or ceiling).
 *
 * Applying a plan: the plan's rows must name pool members; each target is clamped to
 * [1, the member's maxConcurrency]; the rows merge into the state's live bounds in
 * pool-member order — a member covered by the plan takes its clamped target, a member not
 * covered keeps its prior state bound when it has one, and members with neither bound are
 * left unbounded (the pool member's own maximum then governs the scheduler).
 *
 * The doors take `unknown` (the house boundary pattern) and throw TypeError; both services
 * exit through the protocol validators of the records they return.
 */

import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import type {
	EndoModelConcurrencyPlanRowV0,
	EndoModelConcurrencyPlanV0,
	EndoModelTelemetryV0,
	EndoPoolSchedulerStateV0,
} from "../protocol/models.ts";
import {
	validateEndoModelConcurrencyPlanV0,
	validateEndoModelConcurrencyPolicyV0,
	validateEndoModelPoolV0,
	validateEndoModelTelemetryV0,
	validateEndoPoolSchedulerStateV0,
} from "../protocol/models.ts";
import { isPlainJsonObjectV0 } from "../protocol/primitives.ts";

/** A recorded positive integer: a finite, integral number of at least one. */
function isPositiveIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1;
}

/**
 * The adaptive concurrency plan for one pool under one concurrency policy. The doors: a
 * valid policy; a valid pool; current counts of exactly one positive integer per pool
 * member, each within the member's maxConcurrency; telemetry records that are all valid with
 * unique ids (records for models outside the pool are ignored); and a plan id in the
 * endo.evidence.* namespace. One row per pool member, in pool-member order, with the
 * derivation recorded in each row's reason. Throws TypeError when a door fails.
 */
export function createModelConcurrencyPlanV0(
	policy: unknown,
	pool: unknown,
	current: unknown[],
	telemetry: unknown[],
	id: unknown,
): EndoModelConcurrencyPlanV0 {
	const validatedPolicy = validateEndoModelConcurrencyPolicyV0(policy);
	if (validatedPolicy === null) throw new TypeError("not a valid endo.model-concurrency-policy.v0 policy");
	const validatedPool = validateEndoModelPoolV0(pool);
	if (validatedPool === null) throw new TypeError("not a valid endo.model-pool.v0 pool");
	if (!Array.isArray(current)) throw new TypeError("current must be an array of {modelId, count} rows");
	const currentByModel = new Map<string, number>();
	for (const entry of current) {
		if (typeof entry !== "object" || entry === null || !isPlainJsonObjectV0(entry)) {
			throw new TypeError("current rows must be plain objects");
		}
		const row = entry as Record<string, unknown>;
		for (const key of Object.keys(row)) {
			if (key !== "modelId" && key !== "count") throw new TypeError(`unknown current row key ${key}`);
		}
		if (typeof row.modelId !== "string" || !isEndoIdentifierV0(row.modelId, "model")) {
			throw new TypeError("current modelId must be an endo.model.* identifier");
		}
		if (!isPositiveIntV0(row.count)) throw new TypeError("current count must be a positive integer");
		const member = validatedPool.members.find((candidate) => candidate.modelId === row.modelId);
		if (member === undefined) {
			throw new TypeError(`current names model ${row.modelId}, which is not a member of the pool`);
		}
		if (row.count > member.maxConcurrency) {
			throw new TypeError(`current count for ${row.modelId} exceeds the pool member's maxConcurrency`);
		}
		if (currentByModel.has(row.modelId)) throw new TypeError(`current names model ${row.modelId} twice`);
		currentByModel.set(row.modelId, row.count);
	}
	for (const member of validatedPool.members) {
		if (!currentByModel.has(member.modelId)) {
			throw new TypeError(`pool member ${member.modelId} has no current count presented`);
		}
	}
	const telemetryByModel = new Map<string, EndoModelTelemetryV0[]>();
	const seenIds = new Set<string>();
	for (const entry of telemetry) {
		const validatedRecord = validateEndoModelTelemetryV0(entry);
		if (validatedRecord === null) throw new TypeError("not a valid endo.model-telemetry.v0 record");
		if (seenIds.has(validatedRecord.id))
			throw new TypeError(`telemetry record ${validatedRecord.id} is presented twice`);
		seenIds.add(validatedRecord.id);
		const rows = telemetryByModel.get(validatedRecord.modelId) ?? [];
		rows.push(validatedRecord);
		telemetryByModel.set(validatedRecord.modelId, rows);
	}
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("plan id must be an endo.evidence.* identifier");
	}

	const rows: EndoModelConcurrencyPlanRowV0[] = validatedPool.members.map((member) => {
		const count = currentByModel.get(member.modelId);
		if (count === undefined) throw new TypeError(`pool member ${member.modelId} has no current count`);
		const window = [...(telemetryByModel.get(member.modelId) ?? [])].sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		);
		const recent = window.slice(-validatedPolicy.windowSize);
		const calls = recent.reduce((total, row) => total + row.calls, 0);
		if (recent.length === 0 || calls === 0) {
			return { modelId: member.modelId, current: count, target: count, change: "hold", reason: "no-telemetry" };
		}
		if (recent.length < validatedPolicy.windowSize) {
			return {
				modelId: member.modelId,
				current: count,
				target: count,
				change: "hold",
				reason: "insufficient-window",
			};
		}
		const failures = recent.reduce((total, row) => total + row.failures, 0);
		const windowRate = failures / calls;
		const durationMs = recent.reduce((total, row) => total + row.durationMs, 0);
		if (windowRate > validatedPolicy.failureDecreaseThreshold) {
			const target = Math.max(validatedPolicy.minConcurrency, count - validatedPolicy.step);
			if (target === count) {
				return { modelId: member.modelId, current: count, target, change: "hold", reason: "at-bound" };
			}
			return { modelId: member.modelId, current: count, target, change: "decrease", reason: "failure-threshold" };
		}
		const latencyOk =
			validatedPolicy.latencyIncreaseThresholdMs === undefined ||
			durationMs / calls < validatedPolicy.latencyIncreaseThresholdMs;
		if (windowRate < validatedPolicy.failureIncreaseThreshold && latencyOk) {
			const target = Math.min(member.maxConcurrency, count + validatedPolicy.step);
			if (target === count) {
				return { modelId: member.modelId, current: count, target, change: "hold", reason: "at-bound" };
			}
			return {
				modelId: member.modelId,
				current: count,
				target,
				change: "increase",
				reason: "performance-threshold",
			};
		}
		return { modelId: member.modelId, current: count, target: count, change: "hold", reason: "steady" };
	});

	const plan: EndoModelConcurrencyPlanV0 = {
		schemaVersion: "endo.model-concurrency-plan.v0",
		id,
		poolId: validatedPool.id,
		policyId: validatedPolicy.id,
		policyRevision: validatedPolicy.revision,
		rows,
	};
	const validatedPlan = validateEndoModelConcurrencyPlanV0(plan);
	if (validatedPlan === null) throw new TypeError("the concurrency plan failed the protocol door");
	return validatedPlan;
}

/**
 * The scheduler state with one recorded concurrency plan applied: each plan row's target is
 * clamped to [1, the member's maxConcurrency] and merged into the state's live bounds in
 * pool-member order — a member covered by the plan takes its clamped target, a member not
 * covered keeps its prior state bound when it has one, and a member with neither bound is
 * left unbounded. The doors: a valid pool, a valid state naming that pool, and a valid plan
 * naming the same pool whose rows are all pool members. Throws TypeError when a door fails.
 */
export function applyConcurrencyPlanV0(state: unknown, pool: unknown, plan: unknown): EndoPoolSchedulerStateV0 {
	const validatedPool = validateEndoModelPoolV0(pool);
	if (validatedPool === null) throw new TypeError("not a valid endo.model-pool.v0 pool");
	const validatedState = validateEndoPoolSchedulerStateV0(state);
	if (validatedState === null) throw new TypeError("not a valid endo.pool-scheduler-state.v0 state");
	if (validatedState.poolId !== validatedPool.id) throw new TypeError("the state and the pool name different pools");
	const validatedPlan = validateEndoModelConcurrencyPlanV0(plan);
	if (validatedPlan === null) throw new TypeError("not a valid endo.model-concurrency-plan.v0 plan");
	if (validatedPlan.poolId !== validatedPool.id) {
		throw new TypeError(`the plan names pool ${validatedPlan.poolId}, which is not the presented pool`);
	}
	const memberIds = new Set(validatedPool.members.map((member) => member.modelId));
	for (const row of validatedPlan.rows) {
		if (!memberIds.has(row.modelId)) {
			throw new TypeError(`the plan row for ${row.modelId} does not name a member of the pool`);
		}
	}
	const priorBounds = new Map<string, number>();
	for (const row of validatedState.bounds ?? []) priorBounds.set(row.modelId, row.maxConcurrency);
	const bounds = validatedPool.members
		.map((member) => {
			const row = validatedPlan.rows.find((entry) => entry.modelId === member.modelId);
			if (row !== undefined) {
				return { modelId: member.modelId, maxConcurrency: Math.min(row.target, member.maxConcurrency) };
			}
			const prior = priorBounds.get(member.modelId);
			if (prior !== undefined) return { modelId: member.modelId, maxConcurrency: prior };
			return null;
		})
		.filter((entry): entry is { modelId: string; maxConcurrency: number } => entry !== null);
	const nextState: EndoPoolSchedulerStateV0 = {
		schemaVersion: "endo.pool-scheduler-state.v0",
		poolId: validatedPool.id,
		inFlight: validatedState.inFlight,
		queue: [...validatedState.queue],
	};
	if (bounds.length > 0) nextState.bounds = bounds;
	const validatedNextState = validateEndoPoolSchedulerStateV0(nextState);
	if (validatedNextState === null) throw new TypeError("the scheduler state failed the protocol door");
	return validatedNextState;
}
