import { describe, expect, it } from "vitest";
import { applyConcurrencyPlanV0, createModelConcurrencyPlanV0 } from "../models/concurrency-policy.ts";
import { stepPoolSchedulerV0 } from "../models/orchestration.ts";
import { routeModelByPolicyV0 } from "../models/routing-policy.ts";
import type { EndoModelConcurrencyPlanV0, EndoPoolSchedulerStateV0 } from "../protocol/models.ts";
import {
	validateEndoModelConcurrencyPlanV0,
	validateEndoModelRoutingPolicyDecisionV0,
	validateEndoPoolSchedulerStateV0,
} from "../protocol/models.ts";

function alphaProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-profile.v0",
		id: "endo.model.alpha",
		name: "alpha-large",
		provider: "openai",
		deployment: "hosted",
		observation: "none",
		capabilities: ["chat", "tools"],
		...overrides,
	};
}

function zetaProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-profile.v0",
		id: "endo.model.zeta",
		name: "zeta-9b",
		provider: "probe-local",
		deployment: "local",
		observation: "none",
		capabilities: ["chat"],
		...overrides,
	};
}

function twoMemberPool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-pool.v0",
		id: "endo.model.pool-1",
		members: [
			{ modelId: "endo.model.alpha", maxConcurrency: 4 },
			{ modelId: "endo.model.zeta", maxConcurrency: 8 },
		],
		...overrides,
	};
}

function routingPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-routing-policy.v0",
		id: "endo.model.routing-1",
		name: "primary",
		revision: "r1",
		criteria: [{ key: "health", required: true }],
		...overrides,
	};
}

function concurrencyPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-concurrency-policy.v0",
		id: "endo.model.concurrency-1",
		name: "adaptive",
		revision: "r1",
		windowSize: 3,
		step: 2,
		minConcurrency: 1,
		failureDecreaseThreshold: 0.2,
		failureIncreaseThreshold: 0.05,
		latencyIncreaseThresholdMs: 500,
		...overrides,
	};
}

function telemetry(
	modelId: string,
	id: string,
	calls: number,
	failures = 0,
	durationMs = 100,
	health: "healthy" | "degraded" | "unhealthy" = "healthy",
): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-telemetry.v0",
		id,
		modelId,
		health,
		calls,
		tokensIn: calls * 10,
		tokensOut: calls * 5,
		failures,
		durationMs,
	};
}

describe("explicit versioned routing policy", () => {
	it("selects the healthier member and records the deciding criterion", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({
				criteria: [
					{ key: "health", required: true },
					{ key: "modelId", required: true },
				],
			}),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10),
				telemetry("endo.model.zeta", "endo.evidence.t-2", 10, 0, 100, "degraded"),
			],
			[],
			undefined,
			"endo.evidence.decision-1",
		);
		expect(decision.selectedId).toBe("endo.model.alpha");
		expect(decision.decidedBy).toBe("health");
		expect(decision.reason).toBe("policy-selection");
		expect(decision.policyId).toBe("endo.model.routing-1");
		expect(decision.policyRevision).toBe("r1");
	});

	it("reports an honest tie when the best values are equal", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy(),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10),
				telemetry("endo.model.zeta", "endo.evidence.t-2", 10),
			],
			[],
			undefined,
			"endo.evidence.decision-2",
		);
		expect(decision.selectedId).toBeNull();
		expect(decision.decidedBy).toBeNull();
		expect(decision.reason).toBe("tie");
	});

	it("reports no-eligible-model and records the missing capabilities per member", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy(),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[],
			["tools", "vision"],
			undefined,
			"endo.evidence.decision-3",
		);
		expect(decision.reason).toBe("no-eligible-model");
		expect(decision.selectedId).toBeNull();
		const alpha = decision.members.find((member) => member.modelId === "endo.model.alpha");
		const zeta = decision.members.find((member) => member.modelId === "endo.model.zeta");
		expect(alpha?.missingCapabilities).toEqual(["vision"]);
		expect(zeta?.missingCapabilities).toEqual(["tools", "vision"]);
		expect(alpha?.eligible).toBe(false);
	});

	it("makes a member without required data ineligible and records the missing data", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({ criteria: [{ key: "failureRate", required: true }] }),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[telemetry("endo.model.alpha", "endo.evidence.t-1", 10)],
			[],
			undefined,
			"endo.evidence.decision-4",
		);
		expect(decision.selectedId).toBe("endo.model.alpha");
		const zeta = decision.members.find((member) => member.modelId === "endo.model.zeta");
		expect(zeta?.eligible).toBe(false);
		expect(zeta?.missingData).toEqual(["failureRate"]);
	});

	it("treats a zero-call window as having no failure-rate data", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({ criteria: [{ key: "failureRate", required: true }] }),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[telemetry("endo.model.alpha", "endo.evidence.t-1", 10), telemetry("endo.model.zeta", "endo.evidence.t-2", 0)],
			[],
			undefined,
			"endo.evidence.decision-5",
		);
		const zeta = decision.members.find((member) => member.modelId === "endo.model.zeta");
		expect(zeta?.eligible).toBe(false);
		expect(zeta?.missingData).toEqual(["failureRate"]);
		expect(decision.selectedId).toBe("endo.model.alpha");
	});

	it("lets a member lacking optional data survive unranked to an honest tie", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({ criteria: [{ key: "failureRate", required: false }] }),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 1)],
			[],
			undefined,
			"endo.evidence.decision-6",
		);
		expect(decision.reason).toBe("tie");
		expect(decision.selectedId).toBeNull();
		const zeta = decision.members.find((member) => member.modelId === "endo.model.zeta");
		expect(zeta?.eligible).toBe(true);
	});

	it("uses the modelId criterion as the explicit deterministic tie-break", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({ criteria: [{ key: "modelId", required: true }] }),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[],
			[],
			undefined,
			"endo.evidence.decision-7",
		);
		expect(decision.selectedId).toBe("endo.model.alpha");
		expect(decision.decidedBy).toBe("modelId");
	});

	it("ranks deployments by the policy's recorded preference", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({
				criteria: [
					{ key: "deployment", required: true },
					{ key: "modelId", required: true },
				],
				deploymentPreference: "local",
			}),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[],
			[],
			undefined,
			"endo.evidence.decision-8",
		);
		expect(decision.selectedId).toBe("endo.model.zeta");
		expect(decision.decidedBy).toBe("deployment");
	});

	it("prefers the member with the lower presented load", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({ criteria: [{ key: "load", required: true }] }),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[],
			[],
			[
				{ modelId: "endo.model.alpha", count: 2 },
				{ modelId: "endo.model.zeta", count: 0 },
			],
			"endo.evidence.decision-9",
		);
		expect(decision.selectedId).toBe("endo.model.zeta");
		expect(decision.decidedBy).toBe("load");
	});

	it("records the derived evaluation values in policy criterion order", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy({
				criteria: [
					{ key: "failureRate", required: true },
					{ key: "tokenThroughput", required: true },
					{ key: "latency", required: true },
				],
			}),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 1, 300)],
			[],
			undefined,
			"endo.evidence.decision-10",
		);
		const alpha = decision.members.find((member) => member.modelId === "endo.model.alpha");
		expect(alpha?.evaluations).toEqual([
			{ criterion: "failureRate", value: 0.1 },
			{ criterion: "tokenThroughput", value: 150 },
			{ criterion: "latency", value: 30 },
		]);
	});

	it("selects the single eligible member without narrowing", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy(),
			twoMemberPool({ members: [{ modelId: "endo.model.alpha", maxConcurrency: 4 }] }),
			[alphaProfile()],
			[telemetry("endo.model.alpha", "endo.evidence.t-1", 10)],
			[],
			undefined,
			"endo.evidence.decision-11",
		);
		expect(decision.selectedId).toBe("endo.model.alpha");
		expect(decision.decidedBy).toBeNull();
		expect(decision.reason).toBe("policy-selection");
	});

	it("exits through the protocol validator of the returned decision", () => {
		const decision = routeModelByPolicyV0(
			routingPolicy(),
			twoMemberPool(),
			[alphaProfile(), zetaProfile()],
			[telemetry("endo.model.alpha", "endo.evidence.t-1", 10)],
			[],
			undefined,
			"endo.evidence.decision-12",
		);
		expect(validateEndoModelRoutingPolicyDecisionV0(decision)).not.toBeNull();
	});

	it("rejects a deployment criterion without a recorded preference at the door", () => {
		expect(() =>
			routeModelByPolicyV0(
				routingPolicy({ criteria: [{ key: "deployment", required: true }] }),
				twoMemberPool(),
				[alphaProfile(), zetaProfile()],
				[],
				[],
				undefined,
				"endo.evidence.decision-13",
			),
		).toThrow(TypeError);
	});

	it("rejects the hostile doors", () => {
		const base = () =>
			routeModelByPolicyV0(
				routingPolicy(),
				twoMemberPool(),
				[alphaProfile(), zetaProfile()],
				[telemetry("endo.model.alpha", "endo.evidence.t-1", 10)],
				[],
				undefined,
				"endo.evidence.decision-14",
			);
		expect(() => base()).not.toThrow();
		expect(() =>
			routeModelByPolicyV0(
				{ schemaVersion: "wrong" },
				twoMemberPool(),
				[alphaProfile(), zetaProfile()],
				[],
				[],
				undefined,
				"endo.evidence.decision-14",
			),
		).toThrow(TypeError);
		expect(() =>
			routeModelByPolicyV0(
				routingPolicy(),
				twoMemberPool(),
				[alphaProfile(), zetaProfile()],
				[],
				["chat", "chat"],
				undefined,
				"endo.evidence.decision-14",
			),
		).toThrow(TypeError);
		expect(() =>
			routeModelByPolicyV0(
				routingPolicy(),
				twoMemberPool(),
				[alphaProfile(), zetaProfile(), zetaProfile()],
				[],
				[],
				undefined,
				"endo.evidence.decision-14",
			),
		).toThrow(TypeError);
		expect(() =>
			routeModelByPolicyV0(
				routingPolicy(),
				twoMemberPool(),
				[alphaProfile(), zetaProfile()],
				[
					telemetry("endo.model.alpha", "endo.evidence.t-1", 10),
					telemetry("endo.model.zeta", "endo.evidence.t-1", 5),
				],
				[],
				undefined,
				"endo.evidence.decision-14",
			),
		).toThrow(TypeError);
		expect(() =>
			routeModelByPolicyV0(
				routingPolicy(),
				twoMemberPool(),
				[alphaProfile(), zetaProfile()],
				[],
				[],
				[{ modelId: "endo.model.other", count: 1 }],
				"endo.evidence.decision-14",
			),
		).toThrow(TypeError);
		expect(() =>
			base().id
				? routeModelByPolicyV0(
						routingPolicy(),
						twoMemberPool(),
						[alphaProfile(), zetaProfile()],
						[],
						[],
						undefined,
						"not-an-identifier",
					)
				: null,
		).toThrow(TypeError);
	});
});

describe("adaptive concurrency plan", () => {
	function currentCounts(overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
		return [
			{ modelId: "endo.model.alpha", count: 3, ...(overrides.alpha ?? {}) },
			{ modelId: "endo.model.zeta", count: 3, ...(overrides.zeta ?? {}) },
		];
	}

	it("raises the healthy member and holds the in-band member", () => {
		const plan = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-3", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-4", 10, 1, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-5", 10, 1, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-6", 10, 1, 100),
			],
			"endo.evidence.plan-1",
		);
		expect(plan.rows).toEqual([
			{ modelId: "endo.model.alpha", current: 3, target: 4, change: "increase", reason: "performance-threshold" },
			{ modelId: "endo.model.zeta", current: 3, target: 3, change: "hold", reason: "steady" },
		]);
		expect(plan.poolId).toBe("endo.model.pool-1");
		expect(plan.policyId).toBe("endo.model.concurrency-1");
		expect(validateEndoModelConcurrencyPlanV0(plan)).not.toBeNull();
	});

	it("lowers the failing member below the decrease threshold", () => {
		const plan = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 3, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 10, 3, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-3", 10, 3, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-4", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-5", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-6", 10, 0, 100),
			],
			"endo.evidence.plan-2",
		);
		expect(plan.rows[0]).toEqual({
			modelId: "endo.model.alpha",
			current: 3,
			target: 1,
			change: "decrease",
			reason: "failure-threshold",
		});
	});

	it("holds when the latency gate blocks an increase inside the hysteresis band", () => {
		const plan = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 0, 6000),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 10, 0, 6000),
				telemetry("endo.model.alpha", "endo.evidence.t-3", 10, 0, 6000),
				telemetry("endo.model.zeta", "endo.evidence.t-4", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-5", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-6", 10, 0, 100),
			],
			"endo.evidence.plan-3",
		);
		expect(plan.rows[0]).toEqual({
			modelId: "endo.model.alpha",
			current: 3,
			target: 3,
			change: "hold",
			reason: "steady",
		});
	});

	it("holds without telemetry and never invents data", () => {
		const plan = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[],
			"endo.evidence.plan-4",
		);
		expect(plan.rows).toEqual([
			{ modelId: "endo.model.alpha", current: 3, target: 3, change: "hold", reason: "no-telemetry" },
			{ modelId: "endo.model.zeta", current: 3, target: 3, change: "hold", reason: "no-telemetry" },
		]);
	});

	it("holds for an insufficient window and for a zero-call window", () => {
		const insufficient = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 10),
			],
			"endo.evidence.plan-5",
		);
		expect(insufficient.rows[0].reason).toBe("insufficient-window");
		const zeroCalls = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 0),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 0),
				telemetry("endo.model.alpha", "endo.evidence.t-3", 0),
			],
			"endo.evidence.plan-6",
		);
		expect(zeroCalls.rows[0].reason).toBe("no-telemetry");
	});

	it("holds at-bound when the step would exceed the member's ceiling or floor", () => {
		const atCeiling = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts({ alpha: { count: 4 } }),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-3", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-4", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-5", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-6", 10, 0, 100),
			],
			"endo.evidence.plan-7",
		);
		expect(atCeiling.rows[0]).toEqual({
			modelId: "endo.model.alpha",
			current: 4,
			target: 4,
			change: "hold",
			reason: "at-bound",
		});
		const atFloor = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts({ zeta: { count: 1 } }),
			[
				telemetry("endo.model.zeta", "endo.evidence.t-1", 10, 3, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-2", 10, 3, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-3", 10, 3, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-4", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-5", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-6", 10, 0, 100),
			],
			"endo.evidence.plan-8",
		);
		expect(atFloor.rows[1]).toEqual({
			modelId: "endo.model.zeta",
			current: 1,
			target: 1,
			change: "hold",
			reason: "at-bound",
		});
	});

	it("windows the last windowSize records in id order, dropping the oldest", () => {
		const plan = createModelConcurrencyPlanV0(
			concurrencyPolicy(),
			twoMemberPool(),
			currentCounts(),
			[
				telemetry("endo.model.alpha", "endo.evidence.t-0", 10, 9, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-1", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-2", 10, 0, 100),
				telemetry("endo.model.alpha", "endo.evidence.t-3", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-4", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-5", 10, 0, 100),
				telemetry("endo.model.zeta", "endo.evidence.t-6", 10, 0, 100),
			],
			"endo.evidence.plan-9",
		);
		expect(plan.rows[0].reason).toBe("performance-threshold");
		expect(plan.rows[0].change).toBe("increase");
	});

	it("rejects the hostile doors", () => {
		expect(() =>
			createModelConcurrencyPlanV0(
				concurrencyPolicy(),
				twoMemberPool(),
				[{ modelId: "endo.model.alpha", count: 9 }],
				[],
				"endo.evidence.plan-10",
			),
		).toThrow(TypeError);
		expect(() =>
			createModelConcurrencyPlanV0(concurrencyPolicy(), twoMemberPool(), currentCounts(), [], "not-an-identifier"),
		).toThrow(TypeError);
		expect(() =>
			createModelConcurrencyPlanV0(
				concurrencyPolicy(),
				twoMemberPool(),
				currentCounts(),
				[
					telemetry("endo.model.alpha", "endo.evidence.t-1", 10),
					telemetry("endo.model.zeta", "endo.evidence.t-1", 5),
				],
				"endo.evidence.plan-10",
			),
		).toThrow(TypeError);
	});
});

describe("concurrency plan application and scheduler bounds", () => {
	function idleState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			schemaVersion: "endo.pool-scheduler-state.v0",
			poolId: "endo.model.pool-1",
			inFlight: [],
			queue: [],
			...overrides,
		};
	}

	function applyPlan(plan: EndoModelConcurrencyPlanV0): EndoPoolSchedulerStateV0 {
		return applyConcurrencyPlanV0(idleState(), twoMemberPool(), plan);
	}

	it("merges the plan's rows into live bounds in pool-member order, clamped to the members", () => {
		const plan: EndoModelConcurrencyPlanV0 = {
			schemaVersion: "endo.model-concurrency-plan.v0",
			id: "endo.evidence.plan-11",
			poolId: "endo.model.pool-1",
			policyId: "endo.model.concurrency-1",
			policyRevision: "r1",
			rows: [
				{
					modelId: "endo.model.alpha",
					current: 3,
					target: 10,
					change: "increase",
					reason: "performance-threshold",
				},
				{ modelId: "endo.model.zeta", current: 3, target: 2, change: "decrease", reason: "failure-threshold" },
			],
		};
		const state = applyPlan(plan);
		expect(state.bounds).toEqual([
			{ modelId: "endo.model.alpha", maxConcurrency: 4 },
			{ modelId: "endo.model.zeta", maxConcurrency: 2 },
		]);
		expect(validateEndoPoolSchedulerStateV0(state)).not.toBeNull();
	});

	it("keeps the prior state bounds for members the plan does not cover", () => {
		const plan: EndoModelConcurrencyPlanV0 = {
			schemaVersion: "endo.model-concurrency-plan.v0",
			id: "endo.evidence.plan-12",
			poolId: "endo.model.pool-1",
			policyId: "endo.model.concurrency-1",
			policyRevision: "r1",
			rows: [
				{ modelId: "endo.model.alpha", current: 3, target: 2, change: "decrease", reason: "failure-threshold" },
			],
		};
		const prior = applyConcurrencyPlanV0(
			idleState({ bounds: [{ modelId: "endo.model.zeta", maxConcurrency: 6 }] }),
			twoMemberPool(),
			plan,
		);
		expect(prior.bounds).toEqual([
			{ modelId: "endo.model.alpha", maxConcurrency: 2 },
			{ modelId: "endo.model.zeta", maxConcurrency: 6 },
		]);
	});

	it("is idempotent: applying the same plan twice yields the same state", () => {
		const plan: EndoModelConcurrencyPlanV0 = {
			schemaVersion: "endo.model-concurrency-plan.v0",
			id: "endo.evidence.plan-13",
			poolId: "endo.model.pool-1",
			policyId: "endo.model.concurrency-1",
			policyRevision: "r1",
			rows: [{ modelId: "endo.model.alpha", current: 3, target: 3, change: "hold", reason: "steady" }],
		};
		const once = applyPlan(plan);
		const twice = applyConcurrencyPlanV0(once, twoMemberPool(), plan);
		expect(twice).toEqual(once);
	});

	it("rejects a plan naming a different pool or a non-member row", () => {
		const foreignPlan: EndoModelConcurrencyPlanV0 = {
			schemaVersion: "endo.model-concurrency-plan.v0",
			id: "endo.evidence.plan-14",
			poolId: "endo.model.other-pool",
			policyId: "endo.model.concurrency-1",
			policyRevision: "r1",
			rows: [{ modelId: "endo.model.alpha", current: 3, target: 3, change: "hold", reason: "steady" }],
		};
		expect(() => applyConcurrencyPlanV0(idleState(), twoMemberPool(), foreignPlan)).toThrow(TypeError);
		const orphanPlan: EndoModelConcurrencyPlanV0 = {
			schemaVersion: "endo.model-concurrency-plan.v0",
			id: "endo.evidence.plan-15",
			poolId: "endo.model.pool-1",
			policyId: "endo.model.concurrency-1",
			policyRevision: "r1",
			rows: [{ modelId: "endo.model.omega", current: 1, target: 1, change: "hold", reason: "steady" }],
		};
		expect(() => applyConcurrencyPlanV0(idleState(), twoMemberPool(), orphanPlan)).toThrow(/does not name a member/);
	});

	it("makes the scheduler honour a live state bound below the pool maximum", () => {
		const pool = twoMemberPool({ members: [{ modelId: "endo.model.alpha", maxConcurrency: 4 }] });
		const enqueue = {
			schemaVersion: "endo.pool-scheduler-event.v0",
			kind: "enqueue",
			modelId: "endo.model.alpha",
		} as const;
		const boundedStart = idleState();
		boundedStart.bounds = [{ modelId: "endo.model.alpha", maxConcurrency: 1 }];
		const step1 = stepPoolSchedulerV0(boundedStart, pool, enqueue);
		const step2 = stepPoolSchedulerV0(step1, pool, enqueue);
		const step3 = stepPoolSchedulerV0(step2, pool, enqueue);
		expect(step3.inFlight).toEqual([{ modelId: "endo.model.alpha", count: 1 }]);
		expect(step3.queue).toEqual(["endo.model.alpha", "endo.model.alpha"]);
		expect(step3.bounds).toEqual([{ modelId: "endo.model.alpha", maxConcurrency: 1 }]);
		const unboundedFirst = stepPoolSchedulerV0(idleState(), pool, enqueue);
		expect(unboundedFirst.inFlight).toEqual([{ modelId: "endo.model.alpha", count: 1 }]);
		const unboundedSecond = stepPoolSchedulerV0(unboundedFirst, pool, enqueue);
		expect(unboundedSecond.inFlight).toEqual([{ modelId: "endo.model.alpha", count: 2 }]);
	});
});
