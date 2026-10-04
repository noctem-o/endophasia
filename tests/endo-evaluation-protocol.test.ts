import { describe, expect, it } from "vitest";
import { validateTrialCoordinatesV0 } from "../protocol/coordinates.ts";
import {
	ENDO_COGNITION_POLICIES_V0,
	ENDO_COGNITION_POLICIES_V1,
	ENDO_CONFORMANCE_CLASSIFICATIONS_V0,
	ENDO_EVALUATION_PARTITIONS_V0,
	type EndoConformanceStudyV0,
	type EndoEvaluationProfileV0,
	type EndoTrialResultV0,
	validateEndoConformanceStudyV0,
	validateEndoConformanceSuiteV0,
	validateEndoEnvironmentProfileV0,
	validateEndoEvaluationProfileAnyV0,
	validateEndoEvaluationProfileV0,
	validateEndoEvaluationProfileV1,
	validateEndoEvaluationResultV0,
	validateEndoExperimentBundleV0,
	validateEndoReplayComparisonV0,
	validateEndoTrialResultV0,
} from "../protocol/evaluation.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function trial(index: number): EndoTrialResultV0 {
	return {
		schemaVersion: "endo.trial-result.v0",
		coordinates: {
			schemaVersion: "endo.trial.v0",
			experimentId: "endo.experiment.exp-1",
			candidateId: "endo.candidate.c1",
			trial: index,
			runId: `endo.run.r${index}`,
		},
		partition: "validation",
		raw: { ok: true },
		derived: { score: 0.5 },
	};
}

function validProfile(): EndoEvaluationProfileV0 {
	return {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c1",
		candidateRevision: "rev-3",
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		evaluator: "eval-1",
		grader: "grade-1",
		seeds: [7, "seed-b"],
		trialCount: 3,
	};
}

function validResult() {
	return {
		schemaVersion: "endo.evaluation-result.v0",
		id: "endo.evidence.res-1",
		profile: validProfile(),
		trials: [trial(0), trial(1), trial(2)],
		usage: { tokens: 10, cost: { input: 1, output: 9 }, durationMs: 5 },
		wallTimeMs: 42,
		resultBundleDigest: DIGEST,
		selectionPolicy: "policy-p",
		promotionState: "candidate",
	};
}

function validStudy(scenario = "s1", classification: EndoConformanceStudyV0["classification"] = "EXACT") {
	return {
		schemaVersion: "endo.conformance-study.v0",
		subject: "prime",
		version: "0.9.7",
		scenario,
		decoder: "dec-1",
		predicate: "pred-1",
		expected: "the tool reports completion",
		observed: "the tool reported completion",
		classification,
		evidence: [DIGEST, "endo.evidence.e1"],
		limitations: ["single run"],
	};
}

describe("validateEndoEnvironmentProfileV0", () => {
	it("accepts a valid profile and returns it unchanged", () => {
		const profile = { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false };
		expect(validateEndoEnvironmentProfileV0(profile)).toBe(profile);
	});

	it("accepts the optional revision and sandbox, and a simulated environment", () => {
		const profile = {
			schemaVersion: "endo.environment-profile.v0",
			environmentId: "env-ci",
			revision: "r1",
			sandboxId: "sbx-1",
			simulated: true,
		};
		expect(validateEndoEnvironmentProfileV0(profile)).toBe(profile);
	});

	it("requires the simulated flag: absent is not honest", () => {
		const { simulated: _s, ...profile } = {
			schemaVersion: "endo.environment-profile.v0",
			environmentId: "env-ci",
			simulated: false,
		};
		expect(validateEndoEnvironmentProfileV0(profile)).toBeNull();
		expect(validateEndoEnvironmentProfileV0({ ...profile, simulated: "yes" })).toBeNull();
	});

	it("keeps identities within the length bound and rejects unknown keys", () => {
		expect(
			validateEndoEnvironmentProfileV0({
				schemaVersion: "endo.environment-profile.v0",
				environmentId: "",
				simulated: false,
			}),
		).toBeNull();
		expect(
			validateEndoEnvironmentProfileV0({
				schemaVersion: "endo.environment-profile.v0",
				environmentId: "x".repeat(257),
				simulated: false,
			}),
		).toBeNull();
		expect(
			validateEndoEnvironmentProfileV0({
				schemaVersion: "endo.environment-profile.v0",
				environmentId: "env-ci",
				simulated: false,
				mode: "prod",
			}),
		).toBeNull();
	});
});

describe("validateEndoEvaluationProfileV0", () => {
	it("accepts a valid profile and returns it unchanged", () => {
		expect(validateEndoEvaluationProfileV0(validProfile())).toBeTypeOf("object");
	});

	it("keeps experiment and candidate identifiers in their namespaces", () => {
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), experimentId: "endo.candidate.c1" })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), candidateId: "endo.experiment.exp-1" })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), experimentId: "exp-1" })).toBeNull();
	});

	it("closes the cognition policy to the pair", () => {
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), cognitionPolicy: "work" })).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), cognitionPolicy: "dream" })).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), cognitionPolicy: "sleep" })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), cognitionPolicy: "WORK" })).toBeNull();
		// `none` (no Endophasia cognition policy applied) exists only from profile v1; v0 records keep their pair.
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), cognitionPolicy: "none" })).toBeNull();
		const v1 = { ...validProfile(), schemaVersion: "endo.evaluation-profile.v1", cognitionPolicy: "none" };
		expect(validateEndoEvaluationProfileV1(v1)).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileV1({ ...v1, cognitionPolicy: "work" })).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileV1({ ...v1, cognitionPolicy: "sleep" })).toBeNull();
		expect(validateEndoEvaluationProfileV1(validProfile())).toBeNull();
		expect(validateEndoEvaluationProfileAnyV0(v1)).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileAnyV0(validProfile())).toBeTypeOf("object");
		expect(ENDO_COGNITION_POLICIES_V1).toEqual(["work", "dream", "none"]);
	});

	it("validates the inline environment profile", () => {
		expect(
			validateEndoEvaluationProfileV0({
				...validProfile(),
				environment: { schemaVersion: "wrong", environmentId: "e", simulated: false },
			}),
		).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), environment: "env-ci" })).toBeNull();
	});

	it("accepts non-negative integer and non-empty string seeds; rejects empty seed lists", () => {
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), seeds: [0, "a"] })).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), seeds: [""] })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), seeds: [-1] })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), seeds: [1.5] })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), seeds: [] })).toBeNull();
		const { seeds: _s, ...noSeeds } = validProfile();
		expect(validateEndoEvaluationProfileV0(noSeeds)).toBeTypeOf("object");
	});

	it("requires a trial count of at least one, integer", () => {
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), trialCount: 1 })).toBeTypeOf("object");
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), trialCount: 0 })).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), trialCount: 1.5 })).toBeNull();
	});

	it("rejects unknown keys and the wrong schema version", () => {
		expect(
			validateEndoEvaluationProfileV0({ ...validProfile(), schemaVersion: "endo.evaluation-profile.v1" }),
		).toBeNull();
		expect(validateEndoEvaluationProfileV0({ ...validProfile(), verdict: "accepted" })).toBeNull();
	});

	it("publishes the closed vocabularies", () => {
		expect(ENDO_EVALUATION_PARTITIONS_V0).toEqual([
			"evolve-set",
			"validation",
			"promotion-holdout",
			"out-of-distribution",
			"live-traffic",
			"simulated",
			"replay",
		]);
		expect(ENDO_COGNITION_POLICIES_V0).toEqual(["work", "dream"]);
		expect(ENDO_CONFORMANCE_CLASSIFICATIONS_V0).toEqual(["EXACT", "QUALIFIED", "PARTIAL", "UNAVAILABLE", "MISMATCH"]);
	});
});

describe("validateEndoTrialResultV0", () => {
	it("accepts a valid trial and returns it unchanged", () => {
		expect(validateEndoTrialResultV0(trial(0))).toBeTypeOf("object");
	});

	it("requires coordinates, and closes the partition", () => {
		expect(validateEndoTrialResultV0({ ...trial(0), coordinates: "endo.trial.t1" })).toBeNull();
		expect(validateEndoTrialResultV0({ ...trial(0), partition: "live-traffic" })).toBeTypeOf("object");
		expect(validateEndoTrialResultV0({ ...trial(0), partition: "holdout" })).toBeNull();
		const { partition: _p, ...noPartition } = trial(0);
		expect(validateEndoTrialResultV0(noPartition)).toBeTypeOf("object");
	});

	it("keeps raw and derived as strict JSON; an absent field stays absent", () => {
		expect(validateEndoTrialResultV0({ ...trial(0), raw: [1, "two", null] })).toBeTypeOf("object");
		expect(validateEndoTrialResultV0({ ...trial(0), raw: { nested: { deep: true } } })).toBeTypeOf("object");
		expect(validateEndoTrialResultV0({ ...trial(0), raw: NaN })).toBeNull();
		expect(validateEndoTrialResultV0({ ...trial(0), derived: 0.5 })).toBeTypeOf("object");
		const { raw: _r, derived: _d, ...minimal } = trial(0);
		expect(validateEndoTrialResultV0(minimal)).toBeTypeOf("object");
	});

	it("rejects unknown keys and the wrong schema version", () => {
		expect(validateEndoTrialResultV0({ ...trial(0), schemaVersion: "endo.trial-result.v1" })).toBeNull();
		expect(validateEndoTrialResultV0({ ...trial(0), verdict: "accepted" })).toBeNull();
	});
});

describe("validateEndoEvaluationResultV0", () => {
	it("accepts a valid result and returns it unchanged", () => {
		expect(validateEndoEvaluationResultV0(validResult())).toBeTypeOf("object");
	});

	it("keeps the result identity in the evidence namespace", () => {
		expect(validateEndoEvaluationResultV0({ ...validResult(), id: "res-1" })).toBeNull();
	});

	it("enforces the declared trial count: fewer or more trials is not a result", () => {
		expect(validateEndoEvaluationResultV0({ ...validResult(), trials: [trial(0), trial(1)] })).toBeNull();
		expect(
			validateEndoEvaluationResultV0({ ...validResult(), trials: [trial(0), trial(1), trial(2), trial(3)] }),
		).toBeNull();
	});

	it("validates the nested profile and every trial", () => {
		expect(
			validateEndoEvaluationResultV0({ ...validResult(), profile: { ...validProfile(), model: "" } }),
		).toBeNull();
		expect(
			validateEndoEvaluationResultV0({
				...validResult(),
				trials: [trial(0), trial(1), { ...trial(2), partition: "nope" }],
			}),
		).toBeNull();
	});

	it("validates usage, wall time, digest, and the recorded policy fields", () => {
		expect(validateEndoEvaluationResultV0({ ...validResult(), wallTimeMs: -1 })).toBeNull();
		expect(validateEndoEvaluationResultV0({ ...validResult(), wallTimeMs: 1.5 })).toBeNull();
		expect(validateEndoEvaluationResultV0({ ...validResult(), resultBundleDigest: DIGEST.toUpperCase() })).toBeNull();
		expect(validateEndoEvaluationResultV0({ ...validResult(), selectionPolicy: "" })).toBeNull();
		const { usage: _u, ...noUsage } = validResult();
		expect(validateEndoEvaluationResultV0(noUsage)).toBeTypeOf("object");
	});

	it("rejects unknown keys and the wrong schema version", () => {
		expect(
			validateEndoEvaluationResultV0({ ...validResult(), schemaVersion: "endo.evaluation-result.v1" }),
		).toBeNull();
		expect(validateEndoEvaluationResultV0({ ...validResult(), accepted: true })).toBeNull();
	});
});

describe("validateEndoConformanceStudyV0", () => {
	it("accepts a valid study and returns it unchanged", () => {
		expect(validateEndoConformanceStudyV0(validStudy())).toBeTypeOf("object");
	});

	it("names every input: subject, version, scenario, decoder, predicate, expectation, observation", () => {
		for (const field of ["subject", "version", "scenario", "decoder", "predicate"] as const) {
			expect(validateEndoConformanceStudyV0({ ...validStudy(), [field]: "" })).toBeNull();
			expect(validateEndoConformanceStudyV0({ ...validStudy(), [field]: "x".repeat(257) })).toBeNull();
		}
		expect(validateEndoConformanceStudyV0({ ...validStudy(), expected: "" })).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), observed: "" })).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), observed: "x".repeat(4097) })).toBeNull();
	});

	it("closes the classification to the five-way, in its uppercase spelling", () => {
		for (const classification of ENDO_CONFORMANCE_CLASSIFICATIONS_V0) {
			expect(validateEndoConformanceStudyV0(validStudy("s1", classification))).toBeTypeOf("object");
		}
		expect(validateEndoConformanceStudyV0({ ...validStudy(), classification: "exact" })).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), classification: "EXACTLY" })).toBeNull();
	});

	it("accepts evidence as digests or endo.evidence.* references, and nothing else", () => {
		expect(validateEndoConformanceStudyV0({ ...validStudy(), evidence: [DIGEST] })).toBeTypeOf("object");
		expect(validateEndoConformanceStudyV0({ ...validStudy(), evidence: ["endo.evidence.e1"] })).toBeTypeOf("object");
		expect(validateEndoConformanceStudyV0({ ...validStudy(), evidence: [] })).toBeTypeOf("object");
		expect(validateEndoConformanceStudyV0({ ...validStudy(), evidence: ["endo.run.r1"] })).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), evidence: [DIGEST.slice(0, 63)] })).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), evidence: ["0".repeat(64)] })).toBeTypeOf("object");
	});

	it("requires written limitations and rejects unknown keys", () => {
		expect(validateEndoConformanceStudyV0({ ...validStudy(), limitations: [""] })).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), limitations: [] })).toBeTypeOf("object");
		expect(
			validateEndoConformanceStudyV0({ ...validStudy(), schemaVersion: "endo.conformance-study.v1" }),
		).toBeNull();
		expect(validateEndoConformanceStudyV0({ ...validStudy(), verdict: "pass" })).toBeNull();
	});
});

describe("validateEndoConformanceSuiteV0", () => {
	it("accepts a valid suite and returns it unchanged", () => {
		const suite = {
			schemaVersion: "endo.conformance-suite.v0",
			subject: "prime",
			version: "0.9.7",
			studies: [validStudy("s1"), validStudy("s2", "PARTIAL")],
		};
		expect(validateEndoConformanceSuiteV0(suite)).toBeTypeOf("object");
	});

	it("requires studies, one scenario each, naming the suite's subject and version", () => {
		expect(
			validateEndoConformanceSuiteV0({
				schemaVersion: "endo.conformance-suite.v0",
				subject: "prime",
				version: "0.9.7",
				studies: [],
			}),
		).toBeNull();
		expect(
			validateEndoConformanceSuiteV0({
				schemaVersion: "endo.conformance-suite.v0",
				subject: "prime",
				version: "0.9.7",
				studies: [validStudy("s1"), validStudy("s1", "PARTIAL")],
			}),
		).toBeNull();
		expect(
			validateEndoConformanceSuiteV0({
				schemaVersion: "endo.conformance-suite.v0",
				subject: "prime",
				version: "0.9.7",
				studies: [{ ...validStudy("s1"), subject: "other" }],
			}),
		).toBeNull();
		expect(
			validateEndoConformanceSuiteV0({
				schemaVersion: "endo.conformance-suite.v0",
				subject: "prime",
				version: "0.9.7",
				studies: [{ ...validStudy("s1"), version: "0.9.6" }],
			}),
		).toBeNull();
	});

	it("rejects unknown keys and the wrong schema version", () => {
		const suite = {
			schemaVersion: "endo.conformance-suite.v0",
			subject: "prime",
			version: "0.9.7",
			studies: [validStudy()],
		};
		expect(validateEndoConformanceSuiteV0({ ...suite, schemaVersion: "endo.conformance-suite.v1" })).toBeNull();
		expect(validateEndoConformanceSuiteV0({ ...suite, order: "declared" })).toBeNull();
	});
});

describe("validateEndoReplayComparisonV0", () => {
	it("accepts a valid comparison and returns it unchanged", () => {
		const comparison = {
			schemaVersion: "endo.replay-comparison.v0",
			recordId: "endo.evidence.rec-1",
			events: "exact",
			derived: "exact",
			computedDigest: DIGEST,
			graph: "exact",
			visualState: "exact",
		};
		expect(validateEndoReplayComparisonV0(comparison)).toBeTypeOf("object");
	});

	it("keeps the record identity in the evidence namespace and every layer in the three-way", () => {
		const base = {
			schemaVersion: "endo.replay-comparison.v0",
			recordId: "endo.evidence.rec-1",
			events: "exact",
			derived: "reconstructed",
			graph: "unreproducible",
			visualState: "unreproducible",
		};
		expect(validateEndoReplayComparisonV0(base)).toBeTypeOf("object");
		expect(validateEndoReplayComparisonV0({ ...base, recordId: "endo.event.e1" })).toBeNull();
		for (const field of ["events", "derived", "graph", "visualState"] as const) {
			expect(validateEndoReplayComparisonV0({ ...base, [field]: "match" })).toBeNull();
		}
	});

	it("validates the computed digest and rejects unknown keys", () => {
		expect(
			validateEndoReplayComparisonV0({
				schemaVersion: "endo.replay-comparison.v0",
				recordId: "endo.evidence.rec-1",
				events: "exact",
				derived: "exact",
				computedDigest: "xyz",
				graph: "exact",
				visualState: "exact",
			}),
		).toBeNull();
		expect(
			validateEndoReplayComparisonV0({
				schemaVersion: "endo.replay-comparison.v0",
				recordId: "endo.evidence.rec-1",
				events: "exact",
				derived: "exact",
				graph: "exact",
				visualState: "exact",
				verdict: "pass",
			}),
		).toBeNull();
	});
});

describe("validateEndoExperimentBundleV0", () => {
	it("accepts a valid bundle and returns it unchanged", () => {
		const bundle = {
			schemaVersion: "endo.experiment-bundle.v0",
			id: "endo.evidence.bundle-1",
			result: validResult(),
			digest: DIGEST,
		};
		expect(validateEndoExperimentBundleV0(bundle)).toBeTypeOf("object");
	});

	it("keeps the bundle identity in the evidence namespace and the digest in its grammar", () => {
		const bundle = {
			schemaVersion: "endo.experiment-bundle.v0",
			id: "endo.evidence.bundle-1",
			result: validResult(),
			digest: DIGEST,
		};
		expect(validateEndoExperimentBundleV0({ ...bundle, id: "endo.run.r1" })).toBeNull();
		expect(validateEndoExperimentBundleV0({ ...bundle, digest: "xyz" })).toBeNull();
	});

	it("validates the nested result", () => {
		const bundle = {
			schemaVersion: "endo.experiment-bundle.v0",
			id: "endo.evidence.bundle-1",
			result: validResult(),
			digest: DIGEST,
		};
		expect(validateEndoExperimentBundleV0({ ...bundle, result: { ...bundle.result, id: "bundle-1" } })).toBeNull();
		expect(
			validateEndoExperimentBundleV0({ ...bundle, result: { ...bundle.result, trials: [trial(0)] } }),
		).toBeNull();
		expect(validateEndoExperimentBundleV0({ ...bundle, schemaVersion: "endo.experiment-bundle.v1" })).toBeNull();
	});
});

describe("coordinate reuse", () => {
	it("the trial coordinates inside a trial result are the Phase 1 shape", () => {
		expect(validateTrialCoordinatesV0(trial(0).coordinates)).toBeTypeOf("object");
	});
});
