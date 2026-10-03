import { describe, expect, it } from "vitest";
import { ENDO_GEPA_POLICY_V0 } from "../evolution/policies/gepa.ts";
import type { EndoEvolutionPolicyContextV0 } from "../evolution/policies/ports.ts";
import { ENDO_RRSI_INSPIRED_POLICY_V0 } from "../evolution/policies/rrsi-inspired.ts";
import type {
	EndoEvaluationPartitionV0,
	EndoEvaluationProfileV0,
	EndoEvaluationResultV0,
	EndoTrialResultV0,
} from "../protocol/evaluation.ts";
import type {
	EndoCandidateV0,
	EndoExperimentRecordV0,
	EndoSelectionConditionV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import { validateEndoSelectionDecisionV0 } from "../protocol/evolution.ts";

const EXPERIMENT_ID = "endo.experiment.exp-p12";
const CANDIDATE_ROOT = "endo.candidate.p12-root";
const CANDIDATE_MID = "endo.candidate.p12-mid";
const CANDIDATE_DEEP = "endo.candidate.p12-deep";
const CANDIDATE_A = "endo.candidate.p12-a";
const CANDIDATE_B = "endo.candidate.p12-b";
const CANDIDATE_C = "endo.candidate.p12-c";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: EXPERIMENT_ID };
}

function candidate(id: string, parentCandidateId?: string, mutations: string[] = []): EndoCandidateV0 {
	const value: EndoCandidateV0 = { schemaVersion: "endo.candidate.v0", id, mutations };
	if (parentCandidateId !== undefined) value.parentCandidateId = parentCandidateId;
	return value;
}

function trial(
	recordId: string,
	candidateId: string,
	index: number,
	partition: EndoEvaluationPartitionV0,
	score: number,
): EndoTrialResultV0 {
	return {
		schemaVersion: "endo.trial-result.v0",
		coordinates: {
			schemaVersion: "endo.trial.v0",
			experimentId: EXPERIMENT_ID,
			candidateId,
			trial: index,
			runId: `endo.run.${recordId}-${index}`,
		},
		partition,
		derived: { score },
	};
}

function result(
	id: string,
	candidateId: string,
	partition: EndoEvaluationPartitionV0,
	scores: number[],
): EndoEvaluationResultV0 {
	const profile: EndoEvaluationProfileV0 = {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: EXPERIMENT_ID,
		candidateId,
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		trialCount: scores.length,
	};
	return {
		schemaVersion: "endo.evaluation-result.v0",
		id,
		profile,
		trials: scores.map((score, index) => trial(id, candidateId, index, partition, score)),
	};
}

function evolveResult(id: string, candidateId: string, scores: number[]): EndoEvaluationResultV0 {
	return result(id, candidateId, "evolve-set", scores);
}

function heldOutResult(id: string, candidateId: string, scores: number[]): EndoEvaluationResultV0 {
	return result(id, candidateId, "held-out", scores);
}

function context(
	candidates: EndoCandidateV0[],
	results: EndoEvaluationResultV0[] = [],
	heldOut: EndoEvaluationResultV0[] = [],
): EndoEvolutionPolicyContextV0 {
	return { experiment: experimentRecord(), candidates, mutations: [], results, heldOut, history: [] };
}

function findCondition(decision: EndoSelectionDecisionV0, name: string): EndoSelectionConditionV0 {
	const found = decision.conditions.find((condition) => condition.name === name);
	if (found === undefined) throw new Error(`condition ${name} was not recorded`);
	return found;
}

function observedOf(decision: EndoSelectionDecisionV0, name: string): Record<string, unknown> {
	const observed = findCondition(decision, name).observed;
	if (typeof observed !== "object" || observed === null || Array.isArray(observed)) {
		throw new Error(`condition ${name} has no object observation`);
	}
	return observed;
}

describe("ENDO_RRSI_INSPIRED_POLICY_V0", () => {
	it("records its identity and exits through the protocol validator", () => {
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.75])],
			[heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.75])],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-id");
		expect(decision.policy).toEqual({
			schemaVersion: "endo.selection-policy.v0",
			name: "rrsi-inspired",
			revision: "v0",
		});
		expect(validateEndoSelectionDecisionV0(decision)).not.toBeNull();
	});

	it("selects the unique strict best that carries held-out evidence", () => {
		const ctx = context(
			[
				candidate(CANDIDATE_ROOT),
				candidate(CANDIDATE_A, CANDIDATE_ROOT, ["endo.evidence.mut-a1", "endo.evidence.mut-a2"]),
			],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.25, 0.5]),
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.75, 1]),
			],
			[heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.75])],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-sel");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
		expect(decision.evidence).toEqual(["endo.evidence.res-a"]);
		expect(decision.heldOutEvidence).toEqual(["endo.evidence.hold-a"]);
		expect(decision.reason).toBeUndefined();
		expect(decision.conditions.map((entry) => entry.met)).toEqual([true, true, true, true, true, true]);
		expect(findCondition(decision, "edit-budget-annealed").parameters).toEqual({ budgetBase: 4, decay: 0.5 });
		expect(observedOf(decision, "edit-budget-annealed")).toEqual({
			candidateId: CANDIDATE_A,
			depth: 1,
			budget: 2,
			mutations: 2,
		});
		expect(observedOf(decision, "noise-pruner")).toEqual({
			band: 0.25,
			bandSource: "measured",
			gain: 0.5,
			parentCandidateId: CANDIDATE_ROOT,
		});
		expect(observedOf(decision, "held-out-critic")).toEqual({
			evolveGain: 0.5,
			heldOutGain: null,
			screened: false,
			parentCandidateId: CANDIDATE_ROOT,
		});
		expect(validateEndoSelectionDecisionV0(decision)).not.toBeNull();
	});

	it("prunes a best whose recorded edits exceed the annealed budget at its depth", () => {
		const ctx = context(
			[
				candidate(CANDIDATE_ROOT),
				candidate(CANDIDATE_MID, CANDIDATE_ROOT, ["endo.evidence.mut-m1"]),
				candidate(CANDIDATE_DEEP, CANDIDATE_MID, ["endo.evidence.mut-d1", "endo.evidence.mut-d2"]),
			],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.5]),
				evolveResult("endo.evidence.res-mid", CANDIDATE_MID, [0.6]),
				evolveResult("endo.evidence.res-deep", CANDIDATE_DEEP, [0.9]),
			],
			[heldOutResult("endo.evidence.hold-deep", CANDIDATE_DEEP, [0.75])],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-prune");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.candidateId).toBeUndefined();
		expect(decision.evidence).toEqual([]);
		expect(decision.reason).toBe("edit-budget-annealed not met");
		const budget = findCondition(decision, "edit-budget-annealed");
		expect(budget.met).toBe(false);
		expect(observedOf(decision, "edit-budget-annealed")).toEqual({
			candidateId: CANDIDATE_DEEP,
			depth: 2,
			budget: 1,
			mutations: 2,
		});
		const noise = observedOf(decision, "noise-pruner");
		expect(noise.band).toBeNull();
		expect(noise.bandSource).toBe("unavailable");
		expect(noise.parentCandidateId).toBe(CANDIDATE_MID);
		expect(noise.gain).toBeCloseTo(0.3);
	});

	it("allows a best whose recorded edits are exactly at the budget", () => {
		const ctx = context(
			[
				candidate(CANDIDATE_ROOT),
				candidate(CANDIDATE_MID, CANDIDATE_ROOT, ["endo.evidence.mut-m1"]),
				candidate(CANDIDATE_DEEP, CANDIDATE_MID, ["endo.evidence.mut-d1"]),
			],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.5, 0.5]),
				evolveResult("endo.evidence.res-mid", CANDIDATE_MID, [0.6, 0.6]),
				evolveResult("endo.evidence.res-deep", CANDIDATE_DEEP, [0.9, 0.9]),
			],
			[heldOutResult("endo.evidence.hold-deep", CANDIDATE_DEEP, [0.75])],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-at-bound");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_DEEP);
		expect(findCondition(decision, "edit-budget-annealed").met).toBe(true);
		expect(observedOf(decision, "edit-budget-annealed")).toEqual({
			candidateId: CANDIDATE_DEEP,
			depth: 2,
			budget: 1,
			mutations: 1,
		});
	});

	it("prunes a gain that the measured noise band cannot distinguish from noise", () => {
		const ctx = context(
			[candidate(CANDIDATE_ROOT), candidate(CANDIDATE_MID, CANDIDATE_ROOT, ["endo.evidence.mut-m1"])],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.5, 0.75]),
				evolveResult("endo.evidence.res-mid", CANDIDATE_MID, [0.7, 0.7]),
			],
			[
				heldOutResult("endo.evidence.hold-root", CANDIDATE_ROOT, [0.75]),
				heldOutResult("endo.evidence.hold-mid", CANDIDATE_MID, [0.75]),
			],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-noise");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("noise-pruner not met");
		const noise = findCondition(decision, "noise-pruner");
		expect(noise.met).toBe(false);
		expect(noise.observed).toMatchObject({
			band: 0.125,
			bandSource: "measured",
			parentCandidateId: CANDIDATE_ROOT,
		});
		expect(observedOf(decision, "noise-pruner").gain).toBeCloseTo(0.075);
	});

	it("selects a gain that exceeds the measured noise band", () => {
		const ctx = context(
			[candidate(CANDIDATE_ROOT), candidate(CANDIDATE_MID, CANDIDATE_ROOT, ["endo.evidence.mut-m1"])],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.5, 0.75]),
				evolveResult("endo.evidence.res-mid", CANDIDATE_MID, [0.95, 0.95]),
			],
			[
				heldOutResult("endo.evidence.hold-root", CANDIDATE_ROOT, [0.75]),
				heldOutResult("endo.evidence.hold-mid", CANDIDATE_MID, [0.75]),
			],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-above-band");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_MID);
		expect(findCondition(decision, "noise-pruner").met).toBe(true);
		expect(observedOf(decision, "noise-pruner").band).toBe(0.125);
		expect(observedOf(decision, "noise-pruner").gain).toBeCloseTo(0.325);
	});

	it("is inconclusive when the noise band cannot be measured, however large the gain", () => {
		const ctx = context(
			[candidate(CANDIDATE_ROOT), candidate(CANDIDATE_MID, CANDIDATE_ROOT, ["endo.evidence.mut-m1"])],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.1]),
				evolveResult("endo.evidence.res-mid", CANDIDATE_MID, [0.9]),
			],
			[heldOutResult("endo.evidence.hold-mid", CANDIDATE_MID, [0.9])],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-no-band");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.candidateId).toBeUndefined();
		expect(decision.reason).toBe("noise-pruner not met");
		expect(findCondition(decision, "noise-pruner").met).toBe(false);
		expect(observedOf(decision, "noise-pruner")).toMatchObject({ band: null, bandSource: "unavailable" });
		expect(observedOf(decision, "noise-pruner").gain).toBeCloseTo(0.8);
	});

	it("is inconclusive when the best has no scored parent to measure a gain against", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.5, 0.75]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.25, 0.5]),
			],
			[heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.75])],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-no-parent");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("noise-pruner not met");
		expect(observedOf(decision, "noise-pruner")).toEqual({
			band: 0.25,
			bandSource: "measured",
			gain: null,
			parentCandidateId: null,
		});
	});

	it("screens a best that improves on the evolve set while degrading on the held-out set", () => {
		const ctx = context(
			[candidate(CANDIDATE_ROOT), candidate(CANDIDATE_MID, CANDIDATE_ROOT, ["endo.evidence.mut-m1"])],
			[
				evolveResult("endo.evidence.res-root", CANDIDATE_ROOT, [0.5, 0.5]),
				evolveResult("endo.evidence.res-mid", CANDIDATE_MID, [0.9, 0.9]),
			],
			[
				heldOutResult("endo.evidence.hold-root", CANDIDATE_ROOT, [0.9]),
				heldOutResult("endo.evidence.hold-mid", CANDIDATE_MID, [0.5]),
			],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-critic");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("held-out-critic not met");
		const critic = findCondition(decision, "held-out-critic");
		expect(critic.met).toBe(false);
		const observed = observedOf(decision, "held-out-critic");
		expect(observed.screened).toBe(true);
		expect(observed.parentCandidateId).toBe(CANDIDATE_ROOT);
		expect(observed.evolveGain).toBeCloseTo(0.4);
		expect(observed.heldOutGain).toBeCloseTo(-0.4);
	});

	it("records a tie for best as inconclusive with the dependent conditions not applicable", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.7]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.7]),
			],
		);
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-tie");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("strictly-best-evolve not met");
		expect(decision.candidateId).toBeUndefined();
		expect(observedOf(decision, "edit-budget-annealed")).toEqual({ applicable: false });
		expect(observedOf(decision, "noise-pruner")).toEqual({ applicable: false });
		expect(observedOf(decision, "held-out-critic")).toEqual({ applicable: false });
		expect(findCondition(decision, "strictly-best-evolve").met).toBe(false);
		expect(observedOf(decision, "strictly-best-evolve")).toEqual({ candidateId: null, mean: null });
		expect(findCondition(decision, "held-out-present").met).toBe(false);
	});

	it("records a context without scored evidence as inconclusive", () => {
		const decision = ENDO_RRSI_INSPIRED_POLICY_V0.decide(
			context([candidate(CANDIDATE_A)]),
			"endo.evidence.dec-rrsi-empty",
		);
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("evidence-present not met");
		expect(observedOf(decision, "evidence-present")).toEqual({ candidatesScored: 0 });
	});

	it("throws when the decision id is outside the evidence namespace", () => {
		expect(() =>
			ENDO_RRSI_INSPIRED_POLICY_V0.decide(context([candidate(CANDIDATE_A)]), "endo.candidate.p12-a"),
		).toThrow(TypeError);
	});

	it("throws when the context members are not arrays", () => {
		const ctx = {
			experiment: experimentRecord(),
			candidates: [candidate(CANDIDATE_A)],
			mutations: [],
			results: "nope",
			heldOut: [],
			history: [],
		} as unknown as EndoEvolutionPolicyContextV0;
		expect(() => ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-door")).toThrow(TypeError);
	});

	it("is pure and deterministic over the context", () => {
		const ctx = context(
			[candidate(CANDIDATE_A, undefined, ["endo.evidence.mut-a1"])],
			[evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.75])],
			[heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.75])],
		);
		const snapshot = JSON.parse(JSON.stringify(ctx));
		const first = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-pure");
		const second = ENDO_RRSI_INSPIRED_POLICY_V0.decide(ctx, "endo.evidence.dec-rrsi-pure");
		expect(ctx).toEqual(snapshot);
		expect(second).toEqual(first);
	});
});

describe("ENDO_GEPA_POLICY_V0", () => {
	it("records its identity and exits through the protocol validator", () => {
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.75])],
			[heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.75])],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-id");
		expect(decision.policy).toEqual({
			schemaVersion: "endo.selection-policy.v0",
			name: "gepa",
			revision: "v0",
		});
		expect(validateEndoSelectionDecisionV0(decision)).not.toBeNull();
	});

	it("selects the best on the held-out objective within the Pareto front", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.6]),
			],
			[
				heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.6]),
				heldOutResult("endo.evidence.hold-b", CANDIDATE_B, [0.8]),
			],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-front");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_B);
		expect(decision.evidence).toEqual(["endo.evidence.res-b"]);
		expect(decision.heldOutEvidence).toEqual(["endo.evidence.hold-b"]);
		expect(observedOf(decision, "pareto-front")).toEqual({ front: [CANDIDATE_A, CANDIDATE_B], size: 2 });
		expect(observedOf(decision, "strictly-best-held-out")).toEqual({
			candidateId: CANDIDATE_B,
			heldOut: 0.8,
			evolve: 0.6,
			tiebreak: "none",
		});
		expect(findCondition(decision, "strictly-best-held-out").parameters).toEqual({
			objective: "held-out",
			tiebreak: "candidateId",
		});
		expect(validateEndoSelectionDecisionV0(decision)).not.toBeNull();
	});

	it("drops dominated candidates from the recorded front", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.6]),
			],
			[
				heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.8]),
				heldOutResult("endo.evidence.hold-b", CANDIDATE_B, [0.5]),
			],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-dom");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
		expect(observedOf(decision, "pareto-front")).toEqual({ front: [CANDIDATE_A], size: 1 });
	});

	it("keeps non-dominated candidates with complementary objectives on the front", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B), candidate(CANDIDATE_C)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.8]),
				evolveResult("endo.evidence.res-c", CANDIDATE_C, [0.7]),
			],
			[
				heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.8]),
				heldOutResult("endo.evidence.hold-b", CANDIDATE_B, [0.7]),
				heldOutResult("endo.evidence.hold-c", CANDIDATE_C, [0.9]),
			],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-comp");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_C);
		expect(observedOf(decision, "pareto-front")).toEqual({ front: [CANDIDATE_A, CANDIDATE_C], size: 2 });
		expect(observedOf(decision, "strictly-best-held-out").tiebreak).toBe("none");
	});

	it("breaks an exact front tie by candidate id", () => {
		const ctx = context(
			[candidate(CANDIDATE_B), candidate(CANDIDATE_A)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.7]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.7]),
			],
			[
				heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.6]),
				heldOutResult("endo.evidence.hold-b", CANDIDATE_B, [0.6]),
			],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-tie");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
		expect(observedOf(decision, "pareto-front").front).toEqual([CANDIDATE_A, CANDIDATE_B]);
		expect(observedOf(decision, "strictly-best-held-out").tiebreak).toBe("id");
	});

	it("records a candidate with an incomplete objective as inconclusive", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9])],
			[heldOutResult("endo.evidence.hold-b", CANDIDATE_B, [0.8])],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-incomplete");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("held-out-objective-absent");
		expect(findCondition(decision, "objective-complete").met).toBe(false);
		expect(observedOf(decision, "objective-complete")).toEqual({ complete: 0, candidates: [] });
		expect(observedOf(decision, "pareto-front")).toEqual({ front: [], size: 0 });
	});

	it("selects the complete candidate while some candidates are incomplete", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.95]),
			],
			[heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.6])],
		);
		const decision = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-partial");
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
		expect(observedOf(decision, "objective-complete")).toEqual({ complete: 1, candidates: [CANDIDATE_A] });
	});

	it("records a context without scored evidence as inconclusive", () => {
		const decision = ENDO_GEPA_POLICY_V0.decide(context([candidate(CANDIDATE_A)]), "endo.evidence.dec-gepa-empty");
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("evidence-present not met");
		expect(observedOf(decision, "evidence-present")).toEqual({ candidatesScored: 0 });
	});

	it("throws when the decision id is outside the evidence namespace", () => {
		expect(() => ENDO_GEPA_POLICY_V0.decide(context([candidate(CANDIDATE_A)]), "endo.experiment.exp-p12")).toThrow(
			TypeError,
		);
	});

	it("throws when the context members are not arrays", () => {
		const ctx = {
			experiment: experimentRecord(),
			candidates: [candidate(CANDIDATE_A)],
			mutations: [],
			results: [],
			heldOut: "nope",
			history: [],
		} as unknown as EndoEvolutionPolicyContextV0;
		expect(() => ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-door")).toThrow(TypeError);
	});

	it("is pure and deterministic over the context", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.6]),
			],
			[
				heldOutResult("endo.evidence.hold-a", CANDIDATE_A, [0.6]),
				heldOutResult("endo.evidence.hold-b", CANDIDATE_B, [0.8]),
			],
		);
		const snapshot = JSON.parse(JSON.stringify(ctx));
		const first = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-pure");
		const second = ENDO_GEPA_POLICY_V0.decide(ctx, "endo.evidence.dec-gepa-pure");
		expect(ctx).toEqual(snapshot);
		expect(second).toEqual(first);
	});
});
