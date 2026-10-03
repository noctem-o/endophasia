import { describe, expect, it } from "vitest";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import type { EndoExperimentRecordV0 } from "../protocol/evolution.ts";
import { validateEndoRuntimeAdmissionCheckV0 } from "../protocol/runtime.ts";
import { runtimeAdmissionCheckV0 } from "../runtime/admission.ts";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
}

function admission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.runtime-admission.v0",
		id: "endo.evidence.adm-1",
		subject: "prime",
		version: "0.9.7",
		status: "dormant",
		evidence: ["endo.evidence.suite-1"],
		blockers: ["a recorded blocker"],
		...overrides,
	};
}

function suite(subject: string, version: string, studies: Array<Record<string, unknown>>): Record<string, unknown> {
	return {
		schemaVersion: "endo.conformance-suite.v0",
		subject,
		version,
		studies: studies.map((overrides) => ({
			schemaVersion: "endo.conformance-study.v0",
			subject,
			version,
			scenario: "scenario",
			decoder: "probe",
			predicate: "the run replays",
			expected: "the replay matches",
			observed: "the replay matched",
			classification: "PARTIAL",
			evidence: [],
			limitations: [],
			...overrides,
		})),
	};
}

function primeSuite(): Record<string, unknown> {
	return suite("prime", "0.9.7", [
		{ scenario: "durable-operation-identity", classification: "PARTIAL" },
		{ scenario: "lifecycle-semantics", classification: "QUALIFIED" },
		{ scenario: "usage-allocation", classification: "MISMATCH" },
	]);
}

describe("the runtime admission check", () => {
	it("holds for a candidate studied by no suite", () => {
		const report = runtimeAdmissionCheckV0(admission({ status: "candidate", evidence: [], blockers: [] }), []);
		expect(report).toEqual({
			schemaVersion: "endo.runtime-admission-check.v0",
			admissionId: "endo.evidence.adm-1",
			subject: "prime",
			version: "0.9.7",
			status: "candidate",
			suitesChecked: 0,
			exactStudies: 0,
			violations: [],
			holds: true,
		});
	});

	it("holds for the reference without requiring an EXACT study", () => {
		const report = runtimeAdmissionCheckV0(
			admission({
				id: "endo.evidence.adm-pi",
				subject: "pi",
				version: "1.0.0",
				status: "reference",
				evidence: [],
				blockers: [],
			}),
			[suite("pi", "1.0.0", [{ scenario: "replay", classification: "PARTIAL" }])],
		);
		expect(report.holds).toBe(true);
		expect(report.suitesChecked).toBe(1);
	});

	it("holds for a dormant line checked against its sealed study", () => {
		const report = runtimeAdmissionCheckV0(admission({ evidence: ["endo.evidence.suite-1"] }), [primeSuite()]);
		expect(report.holds).toBe(true);
		expect(report.exactStudies).toBe(0);
		expect(report.suitesChecked).toBe(1);
	});

	it("holds for an admitted line with an EXACT study and counts the exacts", () => {
		const report = runtimeAdmissionCheckV0(
			admission({
				id: "endo.evidence.adm-x",
				subject: "x",
				version: "0.1.0",
				status: "admitted",
				evidence: ["endo.evidence.suite-1"],
				blockers: [],
			}),
			[
				suite("x", "0.1.0", [
					{ scenario: "replay", classification: "EXACT" },
					{ scenario: "durable-outcomes", classification: "EXACT" },
				]),
				suite("x", "0.1.0", [{ scenario: "usage", classification: "QUALIFIED" }]),
			],
		);
		expect(report.holds).toBe(true);
		expect(report.exactStudies).toBe(2);
		expect(report.suitesChecked).toBe(2);
	});

	it("violates for an admitted line with no EXACT study", () => {
		const report = runtimeAdmissionCheckV0(
			admission({
				id: "endo.evidence.adm-x",
				subject: "x",
				version: "0.1.0",
				status: "admitted",
				evidence: ["endo.evidence.suite-1"],
				blockers: [],
			}),
			[suite("x", "0.1.0", [{ scenario: "replay", classification: "PARTIAL" }])],
		);
		expect(report.holds).toBe(false);
		expect(report.violations).toEqual([
			"admitted requires an EXACT-classified study; the presented suites establish none",
		]);
	});

	it("violates for a suite naming another subject", () => {
		const report = runtimeAdmissionCheckV0(admission(), [
			suite("codex", "0.9.7", [{ scenario: "threads", classification: "PARTIAL" }]),
		]);
		expect(report.holds).toBe(false);
		expect(report.violations).toEqual(["suite subject 'codex' does not name the record's subject 'prime'"]);
	});

	it("violates for a suite naming another version", () => {
		const report = runtimeAdmissionCheckV0(admission(), [
			suite("prime", "0.14.7", [{ scenario: "replay", classification: "PARTIAL" }]),
		]);
		expect(report.holds).toBe(false);
		expect(report.violations).toEqual(["suite version '0.14.7' does not name the record's version '0.9.7'"]);
	});

	it("accumulates a violation per mismatching suite", () => {
		const report = runtimeAdmissionCheckV0(admission({ status: "candidate", evidence: [], blockers: [] }), [
			suite("codex", "0.1.0", [{ scenario: "threads", classification: "PARTIAL" }]),
			suite("prime", "0.9.8", [{ scenario: "replay", classification: "PARTIAL" }]),
		]);
		expect(report.holds).toBe(false);
		expect(report.violations).toHaveLength(3);
	});

	it("throws on an invalid admission record", () => {
		expect(() => runtimeAdmissionCheckV0(admission({ subject: "Prime" }), [])).toThrow(TypeError);
	});

	it("throws on an invalid conformance suite", () => {
		expect(() => runtimeAdmissionCheckV0(admission(), [suite("prime", "0.9.7", [])])).toThrow(TypeError);
	});

	it("exits through the protocol validator", () => {
		const report = runtimeAdmissionCheckV0(admission(), [primeSuite()]);
		expect(validateEndoRuntimeAdmissionCheckV0(report)).toEqual(report);
	});

	it("checks the ledged runtime chain end to end", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const primeEntry = ledger.append(primeSuite());
		const codexSuite = suite("codex", "0.1.0", [{ scenario: "threads", classification: "UNAVAILABLE" }]);
		ledger.append(codexSuite);
		const primeAdmission = admission({
			id: "endo.evidence.adm-prime",
			evidence: [primeEntry.recordId],
		});
		const codexAdmission = admission({
			id: "endo.evidence.adm-codex",
			subject: "codex",
			version: "0.1.0",
			status: "candidate",
			evidence: [],
			blockers: [],
		});
		ledger.append(primeAdmission);
		ledger.append(codexAdmission);
		expect(replayEndoEvidenceLedgerV0(ledger.ledger())).toEqual(ledger.ledger());
		expect(runtimeAdmissionCheckV0(primeAdmission, [primeSuite()]).holds).toBe(true);
		expect(runtimeAdmissionCheckV0(codexAdmission, [codexSuite]).holds).toBe(true);
		expect(
			runtimeAdmissionCheckV0(
				{
					...primeAdmission,
					id: "endo.evidence.adm-promoted",
					status: "admitted",
					blockers: [],
				},
				[primeSuite()],
			).holds,
		).toBe(false);
	});
});
