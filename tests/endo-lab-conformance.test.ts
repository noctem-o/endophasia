import { describe, expect, it } from "vitest";
import { runEndoConformanceSuiteV0, studyEndoConformanceV0 } from "../lab/conformance.ts";
import { type EndoConformanceStudyV0, validateEndoConformanceSuiteV0 } from "../protocol/evaluation.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function study(
	scenario: string,
	classification: EndoConformanceStudyV0["classification"] = "EXACT",
	overrides: Record<string, unknown> = {},
): EndoConformanceStudyV0 {
	return {
		schemaVersion: "endo.conformance-study.v0",
		subject: "prime",
		version: "0.9.7",
		scenario,
		decoder: "dec-1",
		predicate: "pred-1",
		expected: "the tool reports completion",
		observed: `observed ${scenario}`,
		classification,
		evidence: [DIGEST],
		limitations: ["single run"],
		...overrides,
	};
}

describe("studyEndoConformanceV0", () => {
	it("accepts a valid study and returns it unchanged", () => {
		expect(studyEndoConformanceV0(study("s1"))).toBeTypeOf("object");
	});

	it("rejects an invalid study with the door error", () => {
		expect(() => studyEndoConformanceV0({ ...study("s1"), classification: "exact" })).toThrow(TypeError);
		expect(() => studyEndoConformanceV0("s1")).toThrow(TypeError);
	});
});

describe("runEndoConformanceSuiteV0", () => {
	it("runs the scenarios in the declared order and records the readings", () => {
		const order: string[] = [];
		const suite = runEndoConformanceSuiteV0({
			subject: "prime",
			version: "0.9.7",
			scenarios: ["s3", "s1", "s2"],
			study: (scenario) => {
				order.push(scenario);
				return study(scenario, "PARTIAL");
			},
		});
		expect(order).toEqual(["s3", "s1", "s2"]);
		expect(suite.studies.map((s) => s.scenario)).toEqual(["s3", "s1", "s2"]);
		expect(validateEndoConformanceSuiteV0(suite)).toBeTypeOf("object");
	});

	it("accepts every classification as a first-class result, including UNAVAILABLE", () => {
		const classifications = ["EXACT", "QUALIFIED", "PARTIAL", "UNAVAILABLE", "MISMATCH"] as const;
		const keys = ["a", "b", "c", "d", "e"];
		const suite = runEndoConformanceSuiteV0({
			subject: "prime",
			version: "0.9.7",
			scenarios: keys,
			study: (scenario) => study(scenario, classifications[keys.indexOf(scenario)]),
		});
		expect(suite.studies.map((s) => s.classification)).toEqual([
			"EXACT",
			"QUALIFIED",
			"PARTIAL",
			"UNAVAILABLE",
			"MISMATCH",
		]);
	});

	it("requires a non-empty scenario list of unique non-empty names", () => {
		expect(() =>
			runEndoConformanceSuiteV0({ subject: "prime", version: "0.9.7", scenarios: [], study: () => study("s1") }),
		).toThrow(TypeError);
		expect(() =>
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["s1", "s1"],
				study: () => study("s1"),
			}),
		).toThrow(/duplicate scenario/);
		expect(() =>
			runEndoConformanceSuiteV0({ subject: "prime", version: "0.9.7", scenarios: [""], study: () => study("s1") }),
		).toThrow(TypeError);
		expect(() =>
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["x".repeat(257)],
				study: () => study("s1"),
			}),
		).toThrow(TypeError);
	});

	it("requires the study to name the suite's subject, version, and the scenario it was asked about", () => {
		expect(() =>
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["s1"],
				study: () => study("s1", "EXACT", { subject: "other" }),
			}),
		).toThrow(/names subject/);
		expect(() =>
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["s1"],
				study: () => study("s1", "EXACT", { version: "0.9.6" }),
			}),
		).toThrow(/names version/);
		expect(() =>
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["s1"],
				study: () => study("s2"),
			}),
		).toThrow(/reports scenario/);
	});

	it("rejects a malformed study reading at the door", () => {
		expect(() =>
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["s1"],
				study: () => ({ ...study("s1"), evidence: ["not-a-digest-or-reference"] }),
			}),
		).toThrow(/s1/);
	});

	it("keeps the subject and version within the length bound", () => {
		expect(
			runEndoConformanceSuiteV0({
				subject: "prime",
				version: "0.9.7",
				scenarios: ["s1"],
				study: () => study("s1"),
			}).subject,
		).toBe("prime");
		expect(() =>
			runEndoConformanceSuiteV0({ subject: "", version: "0.9.7", scenarios: ["s1"], study: () => study("s1") }),
		).toThrow(TypeError);
	});
});
