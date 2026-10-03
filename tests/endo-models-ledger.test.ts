import { describe, expect, it } from "vitest";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import { ENDO_EVIDENCE_KINDS_V0, type EndoExperimentRecordV0 } from "../protocol/evolution.ts";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
}

function profile(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-profile.v0",
		id,
		name: id.slice("endo.model.".length),
		provider: "openai",
		deployment: "hosted",
		observation: "none",
		capabilities: ["chat"],
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

function telemetry(id: string, modelId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.model-telemetry.v0",
		id,
		modelId,
		health: "healthy",
		calls: 1,
		tokensIn: 10,
		tokensOut: 4,
		failures: 0,
		durationMs: 100,
		...overrides,
	};
}

describe("the model records in the evidence ledger", () => {
	it("records the twenty-five closed evidence kinds", () => {
		expect([...ENDO_EVIDENCE_KINDS_V0]).toEqual([
			"evaluation-result",
			"conformance-suite",
			"experiment-bundle",
			"replay-comparison",
			"mutation",
			"artifact",
			"candidate",
			"selection-decision",
			"promotion-request",
			"promotion-decision",
			"experiment-transition",
			"witness",
			"standing",
			"lease",
			"receipt",
			"runtime-admission",
			"model-profile",
			"model-pool",
			"model-telemetry",
			"collab-room",
			"collab-discussion",
			"collab-approval-request",
			"collab-approval-decision",
			"collab-patch",
			"collab-steering",
		]);
	});

	it("derives the model-profile kind and keeps the record id as its identity", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const entry = ledger.append(profile("endo.model.gpt-x"));
		expect(entry.sequence).toBe(1);
		expect(entry.kind).toBe("model-profile");
		expect(entry.recordId).toBe("endo.model.gpt-x");
	});

	it("appends a pool that cites its member models", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(profile("endo.model.gpt-x"));
		ledger.append(
			profile("endo.model.local-a", { deployment: "local", observation: "j-space", provider: "probe-local" }),
		);
		const entry = ledger.append(pool());
		expect(entry.sequence).toBe(3);
		expect(entry.kind).toBe("model-pool");
		expect(entry.recordId).toBe("endo.model.pool-1");
	});

	it("rejects a pool that cites a model not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(profile("endo.model.gpt-x"));
		expect(() => ledger.append(pool())).toThrow(TypeError);
	});

	it("rejects a telemetry row that cites a model not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append(telemetry("endo.evidence.tele-1", "endo.model.gpt-x"))).toThrow(TypeError);
	});

	it("replays a ledger carrying the model chain", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const profileEntry = ledger.append(profile("endo.model.gpt-x"));
		const localEntry = ledger.append(
			profile("endo.model.local-a", { deployment: "local", observation: "j-space", provider: "probe-local" }),
		);
		const poolEntry = ledger.append(pool());
		const firstTelemetry = ledger.append(telemetry("endo.evidence.tele-1", "endo.model.gpt-x"));
		const secondTelemetry = ledger.append(
			telemetry("endo.evidence.tele-2", "endo.model.local-a", { health: "degraded", failures: 1 }),
		);
		expect([profileEntry, localEntry, poolEntry, firstTelemetry, secondTelemetry].map((entry) => entry.kind)).toEqual(
			["model-profile", "model-profile", "model-pool", "model-telemetry", "model-telemetry"],
		);
		const persisted = ledger.ledger();
		expect(persisted.entries).toHaveLength(5);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
	});
});
