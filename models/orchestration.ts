/**
 * Phase 10 — model/runtime orchestration (README "## Phase 10 — Model/runtime orchestration"):
 * the pure, protocol-bound services for capability-aware routing and the pool scheduler
 * (adaptive concurrency, queueing, retries). No model is served, called, or contacted here:
 * the routing decision is computed from presented pool and profile records, and the scheduler
 * is a deterministic state machine whose steps are recorded events. Time, failures, and
 * completions are inputs supplied by the caller — the services never observe a runtime
 * themselves. Both services take `unknown` at their doors (the house boundary pattern) and
 * exit through the protocol validators of the reports and states they return.
 */

import type { EndoModelProfileV0, EndoModelRoutingDecisionV0, EndoPoolSchedulerStateV0 } from "../protocol/models.ts";
import {
	validateEndoModelPoolV0,
	validateEndoModelProfileV0,
	validateEndoModelRoutingDecisionV0,
	validateEndoPoolSchedulerEventV0,
	validateEndoPoolSchedulerStateV0,
} from "../protocol/models.ts";

/** A declared capability: a non-empty string within the bound. */
function isCapabilityV0(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

/** A request of capabilities: an array of non-empty strings within the bound. */
function isCapabilityListV0(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => isCapabilityV0(entry));
}

/**
 * The capability-aware routing decision for one pool against one capability request.
 * The doors: a valid pool; a request of unique 1-512 character capabilities; a presentation
 * of exactly one valid profile per pool member — a member without a profile, a profile
 * without a membership, or a double presentation is not a routing. Eligibility is
 * capability-aware: a member is eligible exactly when it declares every requested
 * capability (an empty request admits every member). Selection is deterministic: the
 * lexicographically smallest eligible model id. Throws TypeError when a door fails.
 */
export function routeModelV0(
	pool: unknown,
	profiles: unknown[],
	requestedCapabilities: unknown[],
): EndoModelRoutingDecisionV0 {
	const validatedPool = validateEndoModelPoolV0(pool);
	if (validatedPool === null) throw new TypeError("not a valid endo.model-pool.v0 pool");
	if (!Array.isArray(profiles)) throw new TypeError("profiles must be an array of endo.model-profile.v0 records");
	if (!isCapabilityListV0(requestedCapabilities)) {
		throw new TypeError("requestedCapabilities must be an array of 1-512 character strings");
	}
	if (new Set(requestedCapabilities).size !== requestedCapabilities.length) {
		throw new TypeError("requestedCapabilities must be unique");
	}
	const byId = new Map<string, EndoModelProfileV0>();
	for (const entry of profiles) {
		const validatedProfile = validateEndoModelProfileV0(entry);
		if (validatedProfile === null) throw new TypeError("not a valid endo.model-profile.v0 profile");
		if (byId.has(validatedProfile.id)) throw new TypeError(`profile ${validatedProfile.id} is presented twice`);
		byId.set(validatedProfile.id, validatedProfile);
	}
	for (const member of validatedPool.members) {
		if (!byId.has(member.modelId)) throw new TypeError(`pool member ${member.modelId} has no profile presented`);
	}
	for (const profileId of byId.keys()) {
		if (!validatedPool.members.some((member) => member.modelId === profileId)) {
			throw new TypeError(`profile ${profileId} is not a member of the pool`);
		}
	}
	const eligible: string[] = [];
	for (const member of validatedPool.members) {
		const profile = byId.get(member.modelId);
		if (profile === undefined) continue;
		if (requestedCapabilities.every((capability) => profile.capabilities.includes(capability)))
			eligible.push(member.modelId);
	}
	const selected = eligible.length === 0 ? null : [...eligible].sort()[0];
	const decision: EndoModelRoutingDecisionV0 = {
		schemaVersion: "endo.model-routing-decision.v0",
		poolId: validatedPool.id,
		requestedCapabilities: [...requestedCapabilities],
		eligible,
		selected,
		reason: selected === null ? "no-eligible-model" : "capability-match",
	};
	const validatedDecision = validateEndoModelRoutingDecisionV0(decision);
	if (validatedDecision === null) throw new TypeError("the routing decision failed the protocol door");
	return validatedDecision;
}

/**
 * One step of one pool's scheduler: apply a recorded event (enqueue, complete, or retry) to
 * a scheduler state, then pump the FIFO queue against the live per-member concurrency bounds —
 * a bound recorded in the state when present, else the pool member's own maximum. The doors:
 * a valid pool, a valid state naming the same pool, a valid event for a pool member, and —
 * for a completion — in-flight work to complete. A retry re-enqueues the work item at the
 * tail of the queue (the event's retry number is the recorded decision; the state is a
 * snapshot, not an event log). The pump is head-of-line FIFO: it admits the oldest queued
 * item while its model's in-flight count is below the member's bound, and stops at the first
 * item that would break its bound. The state's bounds, when present, are carried into the
 * next state unchanged. Throws TypeError when a door fails.
 */
export function stepPoolSchedulerV0(state: unknown, pool: unknown, event: unknown): EndoPoolSchedulerStateV0 {
	const validatedPool = validateEndoModelPoolV0(pool);
	if (validatedPool === null) throw new TypeError("not a valid endo.model-pool.v0 pool");
	const validatedState = validateEndoPoolSchedulerStateV0(state);
	if (validatedState === null) throw new TypeError("not a valid endo.pool-scheduler-state.v0 state");
	if (validatedState.poolId !== validatedPool.id) throw new TypeError("the state and the pool name different pools");
	const validatedEvent = validateEndoPoolSchedulerEventV0(event);
	if (validatedEvent === null) throw new TypeError("not a valid endo.pool-scheduler-event.v0 event");
	const member = validatedPool.members.find((entry) => entry.modelId === validatedEvent.modelId);
	if (member === undefined) throw new TypeError(`event model ${validatedEvent.modelId} is not a member of the pool`);
	const inFlight = new Map<string, number>();
	for (const entry of validatedPool.members) inFlight.set(entry.modelId, 0);
	for (const row of validatedState.inFlight) {
		if (!inFlight.has(row.modelId))
			throw new TypeError(`state names model ${row.modelId}, which is not a member of the pool`);
		inFlight.set(row.modelId, row.count);
	}
	const limits = new Map<string, number>();
	for (const entry of validatedPool.members) {
		const bound = validatedState.bounds?.find((row) => row.modelId === entry.modelId);
		limits.set(entry.modelId, bound === undefined ? entry.maxConcurrency : bound.maxConcurrency);
	}
	const queue: string[] = [...validatedState.queue];
	if (validatedEvent.kind === "enqueue" || validatedEvent.kind === "retry") {
		queue.push(validatedEvent.modelId);
	} else {
		const running = inFlight.get(validatedEvent.modelId);
		if (running === undefined || running < 1) {
			throw new TypeError(`cannot complete model ${validatedEvent.modelId}, which has no work in flight`);
		}
		inFlight.set(validatedEvent.modelId, running - 1);
	}
	while (queue.length > 0) {
		const head = queue.shift();
		if (head === undefined) break;
		const running = inFlight.get(head);
		const limit = limits.get(head);
		if (running === undefined || limit === undefined || running + 1 > limit) {
			queue.unshift(head);
			break;
		}
		inFlight.set(head, running + 1);
	}
	const nextState: EndoPoolSchedulerStateV0 = {
		schemaVersion: "endo.pool-scheduler-state.v0",
		poolId: validatedPool.id,
		inFlight: validatedPool.members.map((entry) => ({
			modelId: entry.modelId,
			count: inFlight.get(entry.modelId) ?? 0,
		})),
		queue,
	};
	if (validatedState.bounds !== undefined) {
		nextState.bounds = validatedState.bounds.map((row) => ({
			modelId: row.modelId,
			maxConcurrency: row.maxConcurrency,
		}));
	}
	const validatedNextState = validateEndoPoolSchedulerStateV0(nextState);
	if (validatedNextState === null) throw new TypeError("the scheduler state failed the protocol door");
	return validatedNextState;
}
