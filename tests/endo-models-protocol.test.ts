import { describe, expect, it } from "vitest";
import {
	validateEndoModelPoolV0,
	validateEndoModelProfileV0,
	validateEndoModelRoutingDecisionV0,
	validateEndoModelTelemetryV0,
	validateEndoPoolSchedulerEventV0,
	validateEndoPoolSchedulerStateV0,
} from "../protocol/models.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-profile.v0",
		id: "endo.model.gpt-x",
		name: "gpt-x",
		provider: "openai",
		deployment: "hosted",
		observation: "none",
		capabilities: ["chat", "tools"],
		...overrides,
	};
}

function pool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-pool.v0",
		id: "endo.model.pool-1",
		members: [
			{ modelId: "endo.model.gpt-x", maxConcurrency: 2 },
			{ modelId: "endo.model.local-a", maxConcurrency: 1 },
		],
		...overrides,
	};
}

function telemetry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-telemetry.v0",
		id: "endo.evidence.tele-1",
		modelId: "endo.model.gpt-x",
		health: "healthy",
		calls: 3,
		tokensIn: 100,
		tokensOut: 40,
		failures: 0,
		durationMs: 250,
		...overrides,
	};
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-routing-decision.v0",
		poolId: "endo.model.pool-1",
		requestedCapabilities: ["chat"],
		eligible: ["endo.model.gpt-x"],
		selected: "endo.model.gpt-x",
		reason: "capability-match",
		...overrides,
	};
}

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.pool-scheduler-state.v0",
		poolId: "endo.model.pool-1",
		inFlight: [
			{ modelId: "endo.model.gpt-x", count: 1 },
			{ modelId: "endo.model.local-a", count: 0 },
		],
		queue: ["endo.model.local-a"],
		...overrides,
	};
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.pool-scheduler-event.v0",
		kind: "enqueue",
		modelId: "endo.model.gpt-x",
		...overrides,
	};
}

function roundTrips(value: Record<string, unknown>, validate: (entry: unknown) => unknown): void {
	const parsed = JSON.parse(canonicalEndoJsonV0(value));
	expect(validate(parsed)).not.toBeNull();
}

describe("the model profile record", () => {
	it("accepts a hosted profile with no observation", () => {
		expect(validateEndoModelProfileV0(profile())).not.toBeNull();
	});

	it("accepts a local profile with the j-space observation", () => {
		expect(validateEndoModelProfileV0(profile({ deployment: "local", observation: "j-space" }))).not.toBeNull();
	});

	it("accepts a local profile with no observation", () => {
		expect(validateEndoModelProfileV0(profile({ deployment: "local" }))).not.toBeNull();
	});

	it("rejects a hosted profile carrying the j-space observation", () => {
		expect(validateEndoModelProfileV0(profile({ observation: "j-space" }))).toBeNull();
	});

	it("rejects a deployment outside the closed set", () => {
		expect(validateEndoModelProfileV0(profile({ deployment: "edge" }))).toBeNull();
	});

	it("rejects an observation outside the closed set", () => {
		expect(validateEndoModelProfileV0(profile({ observation: "weights" }))).toBeNull();
	});

	it("rejects an id outside the endo.model.* namespace", () => {
		expect(validateEndoModelProfileV0(profile({ id: "endo.evidence.gpt-x" }))).toBeNull();
	});

	it("rejects a name outside the 1-256 bound", () => {
		expect(validateEndoModelProfileV0(profile({ name: "" }))).toBeNull();
		expect(validateEndoModelProfileV0(profile({ name: "x".repeat(257) }))).toBeNull();
	});

	it("rejects a provider outside the dotted-kind grammar", () => {
		expect(validateEndoModelProfileV0(profile({ provider: "OpenAI" }))).toBeNull();
		expect(validateEndoModelProfileV0(profile({ provider: "a".repeat(129) }))).toBeNull();
	});

	it("rejects capabilities that are not unique 1-512 character strings", () => {
		expect(validateEndoModelProfileV0(profile({ capabilities: ["chat", "chat"] }))).toBeNull();
		expect(validateEndoModelProfileV0(profile({ capabilities: ["x".repeat(513)] }))).toBeNull();
		expect(validateEndoModelProfileV0(profile({ capabilities: ["chat", 42] }))).toBeNull();
	});

	it("rejects an unknown field and a non-object", () => {
		expect(validateEndoModelProfileV0({ ...profile(), weights: "1.7b" })).toBeNull();
		expect(validateEndoModelProfileV0(null)).toBeNull();
	});

	it("round-trips through canonical JSON", () => {
		roundTrips(profile(), validateEndoModelProfileV0);
	});
});

describe("the model pool record", () => {
	it("accepts a pool with two members", () => {
		expect(validateEndoModelPoolV0(pool())).not.toBeNull();
	});

	it("accepts the one concurrency bound", () => {
		expect(
			validateEndoModelPoolV0(pool({ members: [{ modelId: "endo.model.gpt-x", maxConcurrency: 1 }] })),
		).not.toBeNull();
	});

	it("rejects a pool with no members", () => {
		expect(validateEndoModelPoolV0(pool({ members: [] }))).toBeNull();
	});

	it("rejects a duplicate member", () => {
		expect(
			validateEndoModelPoolV0(
				pool({
					members: [
						{ modelId: "endo.model.gpt-x", maxConcurrency: 1 },
						{ modelId: "endo.model.gpt-x", maxConcurrency: 2 },
					],
				}),
			),
		).toBeNull();
	});

	it("rejects a member with a zero or fractional concurrency bound", () => {
		expect(
			validateEndoModelPoolV0(pool({ members: [{ modelId: "endo.model.gpt-x", maxConcurrency: 0 }] })),
		).toBeNull();
		expect(
			validateEndoModelPoolV0(pool({ members: [{ modelId: "endo.model.gpt-x", maxConcurrency: 1.5 }] })),
		).toBeNull();
	});

	it("rejects a member modelId outside the endo.model.* namespace", () => {
		expect(
			validateEndoModelPoolV0(pool({ members: [{ modelId: "endo.evidence.gpt-x", maxConcurrency: 1 }] })),
		).toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoModelPoolV0({ ...pool(), note: "the pool" })).toBeNull();
	});

	it("round-trips through canonical JSON", () => {
		roundTrips(pool(), validateEndoModelPoolV0);
	});
});

describe("the model telemetry record", () => {
	it("accepts a valid row", () => {
		expect(validateEndoModelTelemetryV0(telemetry())).not.toBeNull();
	});

	it("accepts a zero window", () => {
		expect(
			validateEndoModelTelemetryV0(telemetry({ calls: 0, tokensIn: 0, tokensOut: 0, failures: 0, durationMs: 0 })),
		).not.toBeNull();
	});

	it("rejects a health outside the closed set", () => {
		expect(validateEndoModelTelemetryV0(telemetry({ health: "HEALTHY" }))).toBeNull();
		expect(validateEndoModelTelemetryV0(telemetry({ health: "" }))).toBeNull();
	});

	it("rejects a count outside the non-negative integer domain", () => {
		expect(validateEndoModelTelemetryV0(telemetry({ calls: -1 }))).toBeNull();
		expect(validateEndoModelTelemetryV0(telemetry({ tokensIn: 1.5 }))).toBeNull();
	});

	it("rejects an identifier in the wrong namespace", () => {
		expect(validateEndoModelTelemetryV0(telemetry({ id: "endo.model.tele-1" }))).toBeNull();
		expect(validateEndoModelTelemetryV0(telemetry({ modelId: "endo.evidence.gpt-x" }))).toBeNull();
	});

	it("round-trips through canonical JSON", () => {
		roundTrips(telemetry(), validateEndoModelTelemetryV0);
	});
});

describe("the routing decision report", () => {
	it("accepts a capability-match with a selection", () => {
		expect(validateEndoModelRoutingDecisionV0(decision())).not.toBeNull();
	});

	it("accepts a no-eligible-model with a null selection", () => {
		expect(
			validateEndoModelRoutingDecisionV0(decision({ eligible: [], selected: null, reason: "no-eligible-model" })),
		).not.toBeNull();
	});

	it("rejects a reason that disagrees with the selection", () => {
		expect(validateEndoModelRoutingDecisionV0(decision({ reason: "no-eligible-model" }))).toBeNull();
		expect(validateEndoModelRoutingDecisionV0(decision({ selected: null, reason: "capability-match" }))).toBeNull();
	});

	it("rejects a selection that is not among the eligible", () => {
		expect(validateEndoModelRoutingDecisionV0(decision({ eligible: ["endo.model.local-a"] }))).toBeNull();
	});

	it("rejects duplicate requested capabilities", () => {
		expect(validateEndoModelRoutingDecisionV0(decision({ requestedCapabilities: ["chat", "chat"] }))).toBeNull();
	});

	it("rejects an identifier outside the endo.model.* namespace", () => {
		expect(validateEndoModelRoutingDecisionV0(decision({ poolId: "endo.evidence.pool-1" }))).toBeNull();
		expect(validateEndoModelRoutingDecisionV0(decision({ eligible: ["endo.evidence.gpt-x"] }))).toBeNull();
	});

	it("round-trips through canonical JSON", () => {
		roundTrips(decision(), validateEndoModelRoutingDecisionV0);
	});
});

describe("the pool scheduler state", () => {
	it("accepts a state with in-flight and queued work", () => {
		expect(validateEndoPoolSchedulerStateV0(state())).not.toBeNull();
	});

	it("accepts the idle state", () => {
		expect(validateEndoPoolSchedulerStateV0(state({ inFlight: [], queue: [] }))).not.toBeNull();
	});

	it("rejects a count outside the non-negative integer domain", () => {
		expect(
			validateEndoPoolSchedulerStateV0(state({ inFlight: [{ modelId: "endo.model.gpt-x", count: -1 }] })),
		).toBeNull();
		expect(
			validateEndoPoolSchedulerStateV0(state({ inFlight: [{ modelId: "endo.model.gpt-x", count: 0.5 }] })),
		).toBeNull();
	});

	it("rejects a duplicate in-flight row", () => {
		expect(
			validateEndoPoolSchedulerStateV0(
				state({
					inFlight: [
						{ modelId: "endo.model.gpt-x", count: 1 },
						{ modelId: "endo.model.gpt-x", count: 0 },
					],
				}),
			),
		).toBeNull();
	});

	it("rejects an identifier outside the endo.model.* namespace", () => {
		expect(validateEndoPoolSchedulerStateV0(state({ poolId: "endo.evidence.pool-1" }))).toBeNull();
		expect(validateEndoPoolSchedulerStateV0(state({ queue: ["endo.evidence.local-a"] }))).toBeNull();
	});

	it("round-trips through canonical JSON", () => {
		roundTrips(state(), validateEndoPoolSchedulerStateV0);
	});
});

describe("the pool scheduler event", () => {
	it("accepts an enqueue", () => {
		expect(validateEndoPoolSchedulerEventV0(event())).not.toBeNull();
	});

	it("accepts a complete", () => {
		expect(validateEndoPoolSchedulerEventV0(event({ kind: "complete" }))).not.toBeNull();
	});

	it("accepts a retry carrying its retry number", () => {
		expect(validateEndoPoolSchedulerEventV0(event({ kind: "retry", attempt: 1 }))).not.toBeNull();
	});

	it("rejects a retry without a positive retry number", () => {
		expect(validateEndoPoolSchedulerEventV0(event({ kind: "retry" }))).toBeNull();
		expect(validateEndoPoolSchedulerEventV0(event({ kind: "retry", attempt: 0 }))).toBeNull();
		expect(validateEndoPoolSchedulerEventV0(event({ kind: "retry", attempt: 1.5 }))).toBeNull();
	});

	it("rejects an enqueue carrying a retry number", () => {
		expect(validateEndoPoolSchedulerEventV0(event({ attempt: 1 }))).toBeNull();
	});

	it("rejects a kind outside the closed set", () => {
		expect(validateEndoPoolSchedulerEventV0(event({ kind: "abort" }))).toBeNull();
	});
});
