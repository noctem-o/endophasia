import { describe, expect, it } from "vitest";
import { runEndoTrialsV0, validateEndoTrialOutcomeV0 } from "../lab/trials.ts";
import type { EndoEvaluationProfileV0 } from "../protocol/evaluation.ts";
import { validateEndoEvaluationResultV0 } from "../protocol/evaluation.ts";

function profile(overrides: Partial<EndoEvaluationProfileV0> = {}): EndoEvaluationProfileV0 {
	return {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c1",
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		trialCount: 3,
		...overrides,
	};
}

describe("validateEndoTrialOutcomeV0", () => {
	it("accepts a recorded raw outcome, derived metrics, run, and partition", () => {
		const outcome = { raw: { ok: true }, derived: { score: 1 }, runId: "endo.run.r1", partition: "validation" };
		expect(validateEndoTrialOutcomeV0(outcome)).toBe(outcome);
	});

	it("accepts an outcome with every field absent", () => {
		expect(validateEndoTrialOutcomeV0({})).toBeTypeOf("object");
	});

	it("rejects unknown keys, a non-run runId, and a partition outside the vocabulary", () => {
		expect(validateEndoTrialOutcomeV0({ raw: 1, verdict: "accepted" })).toBeNull();
		expect(validateEndoTrialOutcomeV0({ runId: "endo.event.e1" })).toBeNull();
		expect(validateEndoTrialOutcomeV0({ partition: "holdout" })).toBeNull();
	});

	it("rejects a non-canonicalizable raw outcome", () => {
		expect(validateEndoTrialOutcomeV0({ raw: new Date() })).toBeNull();
		expect(validateEndoTrialOutcomeV0({ derived: { fn: () => 1 } })).toBeNull();
	});

	it("rejects arrays and scalars", () => {
		expect(validateEndoTrialOutcomeV0([])).toBeNull();
		expect(validateEndoTrialOutcomeV0("raw")).toBeNull();
	});
});

describe("runEndoTrialsV0", () => {
	it("runs exactly the declared number of trials, in order", () => {
		const seen: number[] = [];
		const result = runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: profile({ trialCount: 4 }),
			runTrial: (index) => {
				seen.push(index);
				return { raw: { index } };
			},
		});
		expect(seen).toEqual([0, 1, 2, 3]);
		expect(result.trials).toHaveLength(4);
		expect(validateEndoEvaluationResultV0(result)).toBeTypeOf("object");
	});

	it("draws the round-robin seed the trial draws, and no seed when none are recorded", () => {
		const withSeeds: (number | string)[] = [];
		runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: profile({ trialCount: 5, seeds: [7, "seed-b"] }),
			runTrial: (_index, seed) => {
				withSeeds.push(seed as number | string);
				return {};
			},
		});
		expect(withSeeds).toEqual([7, "seed-b", 7, "seed-b", 7]);

		const withoutSeeds: (number | string | undefined)[] = [];
		runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: profile({ trialCount: 2 }),
			runTrial: (_index, seed) => {
				withoutSeeds.push(seed);
				return {};
			},
		});
		expect(withoutSeeds).toEqual([undefined, undefined]);
	});

	it("records the trial coordinates: index, experiment, candidate, and the run the outcome named", () => {
		const result = runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: profile({ trialCount: 2 }),
			runTrial: (index) => ({ runId: `endo.run.r${index}` }),
		});
		expect(result.trials[0].coordinates).toEqual({
			schemaVersion: "endo.trial.v0",
			experimentId: "endo.experiment.exp-1",
			candidateId: "endo.candidate.c1",
			trial: 0,
			runId: "endo.run.r0",
		});
		expect(result.trials[1].coordinates.trial).toBe(1);
	});

	it("omits the candidate coordinate when the profile has no candidate", () => {
		const { candidateId: _c, ...noCandidate } = profile();
		const result = runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: noCandidate,
			runTrial: () => ({}),
		});
		expect(result.trials[0].coordinates.candidateId).toBeUndefined();
	});

	it("copies raw, derived, and partition only when the outcome reported them", () => {
		const result = runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: profile({ trialCount: 2 }),
			runTrial: (index) =>
				index === 0 ? { raw: { ok: true }, derived: { score: 0.5 }, partition: "validation" } : {},
		});
		expect(result.trials[0].raw).toEqual({ ok: true });
		expect(result.trials[0].derived).toEqual({ score: 0.5 });
		expect(result.trials[0].partition).toBe("validation");
		expect(result.trials[1].raw).toBeUndefined();
		expect(result.trials[1].derived).toBeUndefined();
		expect(result.trials[1].partition).toBeUndefined();
	});

	it("records the reported usage and wall time, and omits them when absent", () => {
		const withUsage = runEndoTrialsV0({
			id: "endo.evidence.res-1",
			profile: profile(),
			runTrial: () => ({}),
			usage: { tokens: { input: 1, output: 2, total: 3 } },
			wallTimeMs: 10,
		});
		expect(withUsage.usage).toEqual({ tokens: { input: 1, output: 2, total: 3 } });
		expect(withUsage.wallTimeMs).toBe(10);
		const without = runEndoTrialsV0({ id: "endo.evidence.res-1", profile: profile(), runTrial: () => ({}) });
		expect(without.usage).toBeUndefined();
		expect(without.wallTimeMs).toBeUndefined();
	});

	it("is the strict door on id, profile, usage, wall time, and outcomes", () => {
		expect(() => runEndoTrialsV0({ id: "endo.run.r1", profile: profile(), runTrial: () => ({}) })).toThrow(TypeError);
		expect(() =>
			runEndoTrialsV0({ id: "endo.evidence.res-1", profile: { ...profile(), trialCount: 0 }, runTrial: () => ({}) }),
		).toThrow(TypeError);
		expect(() =>
			runEndoTrialsV0({
				id: "endo.evidence.res-1",
				profile: profile(),
				runTrial: () => ({}),
				usage: { tokens: -1 },
			}),
		).toThrow(TypeError);
		expect(() =>
			runEndoTrialsV0({ id: "endo.evidence.res-1", profile: profile(), runTrial: () => ({}), wallTimeMs: 1.5 }),
		).toThrow(TypeError);
		expect(() =>
			runEndoTrialsV0({ id: "endo.evidence.res-1", profile: profile(), runTrial: () => ({ verdict: "accepted" }) }),
		).toThrow(/trial 0 outcome/);
		expect(() =>
			runEndoTrialsV0({
				id: "endo.evidence.res-1",
				profile: profile({ trialCount: 2 }),
				runTrial: (index) => (index === 0 ? {} : { raw: new Date() }),
			}),
		).toThrow(/trial 1 outcome/);
		expect(() =>
			runEndoTrialsV0({ id: "endo.evidence.res-1", profile: profile(), runTrial: () => ({ raw: new Date() }) }),
		).toThrow(TypeError);
	});
});
