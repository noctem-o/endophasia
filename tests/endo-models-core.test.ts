import { describe, expect, it } from "vitest";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import { routeModelV0, stepPoolSchedulerV0 } from "../models/orchestration.ts";
import type { EndoExperimentRecordV0 } from "../protocol/evolution.ts";
import { validateEndoModelRoutingDecisionV0, validateEndoPoolSchedulerStateV0 } from "../protocol/models.ts";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
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

function alphaProfile(): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-profile.v0",
		id: "endo.model.alpha",
		name: "alpha-large",
		provider: "openai",
		deployment: "hosted",
		observation: "none",
		capabilities: ["chat", "tools"],
	};
}

function midProfile(): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-profile.v0",
		id: "endo.model.mid",
		name: "mid-7b",
		provider: "probe-local",
		deployment: "local",
		observation: "j-space",
		capabilities: ["chat"],
	};
}

function pool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-pool.v0",
		id: "endo.model.pool-1",
		members: [
			{ modelId: "endo.model.zeta", maxConcurrency: 1 },
			{ modelId: "endo.model.alpha", maxConcurrency: 2 },
			{ modelId: "endo.model.mid", maxConcurrency: 1 },
		],
		...overrides,
	};
}

function profiles(): Record<string, unknown>[] {
	return [zetaProfile(), alphaProfile(), midProfile()];
}

function idleState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.pool-scheduler-state.v0",
		poolId: "endo.model.pool-1",
		inFlight: [],
		queue: [],
		...overrides,
	};
}

function enqueue(modelId: string): Record<string, unknown> {
	return { schemaVersion: "endo.pool-scheduler-event.v0", kind: "enqueue", modelId };
}

function complete(modelId: string): Record<string, unknown> {
	return { schemaVersion: "endo.pool-scheduler-event.v0", kind: "complete", modelId };
}

function retry(modelId: string, attempt: number): Record<string, unknown> {
	return { schemaVersion: "endo.pool-scheduler-event.v0", kind: "retry", modelId, attempt };
}

describe("capability-aware routing", () => {
	it("routes to the members declaring every requested capability", () => {
		const decision = routeModelV0(pool(), profiles(), ["chat", "tools"]);
		expect(decision.poolId).toBe("endo.model.pool-1");
		expect(decision.eligible).toEqual(["endo.model.alpha"]);
		expect(decision.selected).toBe("endo.model.alpha");
		expect(decision.reason).toBe("capability-match");
	});

	it("admits every member for an empty capability request, in pool-member order", () => {
		const decision = routeModelV0(pool(), profiles(), []);
		expect(decision.eligible).toEqual(["endo.model.zeta", "endo.model.alpha", "endo.model.mid"]);
	});

	it("selects the lexicographically smallest eligible model", () => {
		const decision = routeModelV0(pool(), profiles(), ["chat"]);
		expect(decision.selected).toBe("endo.model.alpha");
	});

	it("reports no-eligible-model when no member matches", () => {
		const decision = routeModelV0(pool(), profiles(), ["chat", "embeds"]);
		expect(decision.eligible).toEqual([]);
		expect(decision.selected).toBeNull();
		expect(decision.reason).toBe("no-eligible-model");
	});

	it("rejects an invalid pool at the door", () => {
		expect(() => routeModelV0(pool({ ...pool(), members: [] }), profiles(), [])).toThrow(TypeError);
	});

	it("rejects a presentation missing a member's profile", () => {
		expect(() => routeModelV0(pool(), [alphaProfile(), midProfile()], ["chat"])).toThrow(TypeError);
	});

	it("rejects a profile that is not a pool member", () => {
		expect(() => routeModelV0(pool(), [...profiles(), zetaProfile({ id: "endo.model.extra" })], [])).toThrow(
			TypeError,
		);
	});

	it("rejects a double presentation of a profile", () => {
		expect(() => routeModelV0(pool(), [zetaProfile(), zetaProfile(), alphaProfile(), midProfile()], [])).toThrow(
			TypeError,
		);
	});

	it("rejects a request outside the capability grammar", () => {
		expect(() => routeModelV0(pool(), profiles(), ["chat", "chat"])).toThrow(TypeError);
		expect(() => routeModelV0(pool(), profiles(), ["x".repeat(513)])).toThrow(TypeError);
	});
});

describe("the pool scheduler", () => {
	it("enqueues work under the concurrency bound", () => {
		const next = stepPoolSchedulerV0(idleState(), pool(), enqueue("endo.model.zeta"));
		expect(next.inFlight).toEqual([
			{ modelId: "endo.model.zeta", count: 1 },
			{ modelId: "endo.model.alpha", count: 0 },
			{ modelId: "endo.model.mid", count: 0 },
		]);
		expect(next.queue).toEqual([]);
	});

	it("queues work over the bound and admits it on completion", () => {
		let next = stepPoolSchedulerV0(idleState(), pool(), enqueue("endo.model.zeta"));
		next = stepPoolSchedulerV0(next, pool(), enqueue("endo.model.zeta"));
		expect(next.inFlight).toEqual([
			{ modelId: "endo.model.zeta", count: 1 },
			{ modelId: "endo.model.alpha", count: 0 },
			{ modelId: "endo.model.mid", count: 0 },
		]);
		expect(next.queue).toEqual(["endo.model.zeta"]);
		next = stepPoolSchedulerV0(next, pool(), complete("endo.model.zeta"));
		expect(next.inFlight).toEqual([
			{ modelId: "endo.model.zeta", count: 1 },
			{ modelId: "endo.model.alpha", count: 0 },
			{ modelId: "endo.model.mid", count: 0 },
		]);
		expect(next.queue).toEqual([]);
	});

	it("a retry re-enqueues the work item at the tail", () => {
		const seeded: Record<string, unknown> = {
			schemaVersion: "endo.pool-scheduler-state.v0",
			poolId: "endo.model.pool-1",
			inFlight: [
				{ modelId: "endo.model.zeta", count: 1 },
				{ modelId: "endo.model.alpha", count: 0 },
				{ modelId: "endo.model.mid", count: 0 },
			],
			queue: ["endo.model.alpha"],
		};
		const next = stepPoolSchedulerV0(seeded, pool(), retry("endo.model.zeta", 1));
		expect(next.inFlight).toEqual([
			{ modelId: "endo.model.zeta", count: 1 },
			{ modelId: "endo.model.alpha", count: 1 },
			{ modelId: "endo.model.mid", count: 0 },
		]);
		expect(next.queue).toEqual(["endo.model.zeta"]);
	});

	it("rejects a completion with no in-flight work", () => {
		expect(() => stepPoolSchedulerV0(idleState(), pool(), complete("endo.model.zeta"))).toThrow(TypeError);
	});

	it("rejects an event for a model that is not a pool member", () => {
		expect(() => stepPoolSchedulerV0(idleState(), pool(), enqueue("endo.model.extra"))).toThrow(TypeError);
	});

	it("rejects a state naming a different pool", () => {
		expect(() =>
			stepPoolSchedulerV0(
				idleState({ ...idleState(), poolId: "endo.model.pool-2" }),
				pool(),
				enqueue("endo.model.zeta"),
			),
		).toThrow(TypeError);
	});
});

describe("the model orchestration spine", () => {
	it("routes and schedules against a materialized, replayed ledger", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(zetaProfile());
		ledger.append(alphaProfile());
		ledger.append(midProfile());
		const poolEntry = ledger.append(pool());
		expect(poolEntry.kind).toBe("model-pool");
		expect(poolEntry.recordId).toBe("endo.model.pool-1");
		const decision = routeModelV0(pool(), profiles(), ["chat"]);
		expect(validateEndoModelRoutingDecisionV0(decision)).not.toBeNull();
		expect(decision.selected).toBe("endo.model.alpha");
		let next = stepPoolSchedulerV0(idleState(), pool(), enqueue(decision.selected ?? "endo.model.alpha"));
		next = stepPoolSchedulerV0(next, pool(), enqueue("endo.model.zeta"));
		next = stepPoolSchedulerV0(next, pool(), complete("endo.model.alpha"));
		expect(validateEndoPoolSchedulerStateV0(next)).not.toBeNull();
		expect(next.inFlight).toEqual([
			{ modelId: "endo.model.zeta", count: 1 },
			{ modelId: "endo.model.alpha", count: 0 },
			{ modelId: "endo.model.mid", count: 0 },
		]);
		const persisted = ledger.ledger();
		expect(persisted.entries).toHaveLength(4);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
	});
});
