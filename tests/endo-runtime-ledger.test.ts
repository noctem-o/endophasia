import { describe, expect, it } from "vitest";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import { ENDO_EVIDENCE_KINDS_V0, type EndoExperimentRecordV0 } from "../protocol/evolution.ts";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
}

function study(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.conformance-study.v0",
		subject: "prime",
		version: "0.9.7",
		scenario: "scenario-1",
		decoder: "probe-0.14.7",
		predicate: "the run replays",
		expected: "the replay matches",
		observed: "the replay matched",
		classification: "EXACT",
		evidence: [],
		limitations: [],
		...overrides,
	};
}

function suiteRecord(
	subject: string,
	version: string,
	scenarios: Array<Record<string, unknown>>,
): Record<string, unknown> {
	return {
		schemaVersion: "endo.conformance-suite.v0",
		subject,
		version,
		studies: scenarios.map((overrides) => study({ subject, version, ...overrides })),
	};
}

function admission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.runtime-admission.v0",
		id: "endo.evidence.adm-1",
		subject: "prime",
		version: "0.9.7",
		status: "dormant",
		evidence: ["endo.evidence.suite-1"],
		blockers: ["durable operation/outcome identity"],
		...overrides,
	};
}

describe("the runtime admission in the evidence ledger", () => {
	it("records the nineteen closed evidence kinds", () => {
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
		]);
	});

	it("derives the runtime-admission kind and keeps the record id as its identity", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const suite = ledger.append(suiteRecord("prime", "0.9.7", [{ scenario: "scenario-1" }]));
		const entry = ledger.append(admission({ evidence: [suite.recordId] }));
		expect(entry.sequence).toBe(2);
		expect(entry.kind).toBe("runtime-admission");
		expect(entry.recordId).toBe("endo.evidence.adm-1");
	});

	it("appends a candidate admission that cites nothing", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const entry = ledger.append(admission({ status: "candidate", evidence: [], blockers: [] }));
		expect(entry.sequence).toBe(1);
		expect(entry.kind).toBe("runtime-admission");
	});

	it("rejects an admission that cites a suite not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append(admission({ evidence: ["endo.evidence.suite-9"] }))).toThrow(TypeError);
	});

	it("rejects a duplicate admission id", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(admission({ id: "endo.evidence.adm-1", status: "candidate", evidence: [], blockers: [] }));
		expect(() =>
			ledger.append(admission({ id: "endo.evidence.adm-1", status: "candidate", evidence: [], blockers: [] })),
		).toThrow(TypeError);
	});

	it("replays a ledger carrying the runtime chain", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const primeSuite = ledger.append(
			suiteRecord("prime", "0.9.7", [
				{ scenario: "durable-operation-identity", classification: "PARTIAL" },
				{ scenario: "lifecycle-semantics", classification: "QUALIFIED" },
				{ scenario: "usage-allocation", classification: "MISMATCH" },
			]),
		);
		ledger.append(
			suiteRecord("codex", "0.1.0", [
				{ scenario: "threads", classification: "UNAVAILABLE" },
				{ scenario: "steering", classification: "UNAVAILABLE" },
			]),
		);
		const xSuite = ledger.append(suiteRecord("x", "0.1.0", [{ scenario: "replay", classification: "EXACT" }]));
		const piEntry = ledger.append(
			admission({
				id: "endo.evidence.adm-pi",
				subject: "pi",
				version: "1.0.0",
				status: "reference",
				evidence: [],
				blockers: [],
			}),
		);
		const primeEntry = ledger.append(
			admission({
				id: "endo.evidence.adm-prime",
				subject: "prime",
				version: "0.9.7",
				status: "dormant",
				evidence: [primeSuite.recordId],
				blockers: [
					"durable operation/outcome identity",
					"complete lifecycle semantics",
					"committed Usage allocation/paging",
					"matching continuity/context semantics",
				],
			}),
		);
		const codexEntry = ledger.append(
			admission({
				id: "endo.evidence.adm-codex",
				subject: "codex",
				version: "0.1.0",
				status: "candidate",
				evidence: [],
				blockers: [],
			}),
		);
		const xEntry = ledger.append(
			admission({
				id: "endo.evidence.adm-x",
				subject: "x",
				version: "0.1.0",
				status: "admitted",
				evidence: [xSuite.recordId],
				blockers: [],
			}),
		);
		expect([piEntry, primeEntry, codexEntry, xEntry].map((entry) => entry.kind)).toEqual([
			"runtime-admission",
			"runtime-admission",
			"runtime-admission",
			"runtime-admission",
		]);
		expect(primeEntry.recordId).toBe("endo.evidence.adm-prime");
		expect(ledger.length).toBe(7);
		const persisted = ledger.ledger();
		expect(persisted.entries).toHaveLength(7);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
	});
});
