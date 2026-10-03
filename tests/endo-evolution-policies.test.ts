import { describe, expect, it } from "vitest";
import {
	createEndoEvidenceLedgerV0,
	createEndoEvolutionCoreV0,
	createEndoExperimentLifecycleV0,
	ENDO_HIGHEST_SCORE_POLICY_V0,
	replayEndoEvidenceLedgerV0,
	replayEndoExperimentLifecycleV0,
} from "../evolution/index.ts";
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
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
} from "../protocol/evolution.ts";
import { validateEndoSelectionDecisionV0 } from "../protocol/evolution.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";

const EXPERIMENT_ID = "endo.experiment.exp-p7";
const CANDIDATE_A = "endo.candidate.p7-a";
const CANDIDATE_B = "endo.candidate.p7-b";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: EXPERIMENT_ID, evaluator: "eval-1", grader: "grade-1" };
}

function candidate(id: string): EndoCandidateV0 {
	return { schemaVersion: "endo.candidate.v0", id, mutations: [] };
}

function trial(
	runPrefix: string,
	index: number,
	partition: EndoEvaluationPartitionV0,
	derived?: JsonValueV0,
): EndoTrialResultV0 {
	const t: EndoTrialResultV0 = {
		schemaVersion: "endo.trial-result.v0",
		coordinates: {
			schemaVersion: "endo.trial.v0",
			experimentId: EXPERIMENT_ID,
			trial: index,
			runId: `endo.run.${runPrefix}-${index}`,
		},
	};
	t.coordinates.candidateId = CANDIDATE_A;
	t.partition = partition;
	if (derived !== undefined) t.derived = derived;
	return t;
}

function result(id: string, candidateId: string, trials: EndoTrialResultV0[]): EndoEvaluationResultV0 {
	const profile: EndoEvaluationProfileV0 = {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: EXPERIMENT_ID,
		candidateId,
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		trialCount: trials.length,
	};
	return { schemaVersion: "endo.evaluation-result.v0", id, profile, trials };
}

function context(
	candidates: EndoCandidateV0[],
	results: EndoEvaluationResultV0[] = [],
	validation: EndoEvaluationResultV0[] = [],
): EndoEvolutionPolicyContextV0 {
	return { experiment: experimentRecord(), candidates, mutations: [], results, validation, history: [] };
}

function evolveResult(id: string, candidateId: string, scores: number[]): EndoEvaluationResultV0 {
	return result(
		id,
		candidateId,
		scores.map((score, index) => trial(id, index, "evolve-set", { score })),
	);
}

function validationResult(id: string, candidateId: string, scores: number[]): EndoEvaluationResultV0 {
	return result(
		id,
		candidateId,
		scores.map((score, index) => trial(id, index, "validation", { score })),
	);
}

function decide(id: string, ctx: EndoEvolutionPolicyContextV0) {
	return ENDO_HIGHEST_SCORE_POLICY_V0.decide(ctx, id);
}

describe("the promotion holdout stays out of selection", () => {
	const holdout = result("endo.evidence.res-holdout", CANDIDATE_A, [
		trial("endo.evidence.res-holdout", 0, "promotion-holdout", { score: 1 }),
	]);
	it.each([
		["baseline", ENDO_HIGHEST_SCORE_POLICY_V0],
		["rrsi-inspired", ENDO_RRSI_INSPIRED_POLICY_V0],
		["gepa", ENDO_GEPA_POLICY_V0],
	] as const)("%s refuses a context that carries promotion-holdout evidence, in either array", (_name, policy) => {
		const base = [evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.5, 0.75])];
		const validation = [validationResult("endo.evidence.val-a", CANDIDATE_A, [0.75])];
		expect(() =>
			policy.decide(context([candidate(CANDIDATE_A)], [...base, holdout], validation), "endo.evidence.dec-h1"),
		).toThrow(/promotion-holdout/);
		expect(() =>
			policy.decide(context([candidate(CANDIDATE_A)], base, [...validation, holdout]), "endo.evidence.dec-h2"),
		).toThrow(/promotion-holdout/);
		expect(() =>
			policy.decide(context([candidate(CANDIDATE_A)], base, validation), "endo.evidence.dec-h3"),
		).not.toThrow();
	});
});

describe("ENDO_HIGHEST_SCORE_POLICY_V0", () => {
	it("selects the unique strict best that also carries validation evidence", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9, 0.8]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.5]),
			],
			[
				validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.7]),
				validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.6]),
			],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
		expect(decision.evidence).toEqual(["endo.evidence.res-a"]);
		expect(decision.validationEvidence).toEqual(["endo.evidence.res-a-h"]);
		expect(decision.conditions.every((condition) => condition.met)).toBe(true);
		expect(decision.reason).toBeUndefined();
		expect(decision.experimentId).toBe(EXPERIMENT_ID);
	});

	it("records the policy identity on every decision", () => {
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9])],
			[validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.7])],
		);
		const selected = decide("endo.evidence.dec-1", ctx);
		expect(selected.policy).toEqual({
			schemaVersion: "endo.selection-policy.v0",
			name: "highest-score",
			revision: "v1",
		});
		expect(validateEndoSelectionDecisionV0(selected)).toEqual(selected);

		const empty = decide("endo.evidence.dec-2", context([candidate(CANDIDATE_A)]));
		expect(empty.policy).toEqual(selected.policy);
		expect(validateEndoSelectionDecisionV0(empty)).toEqual(empty);
	});

	it("aggregates a candidate's mean across its results", () => {
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[
				evolveResult("endo.evidence.res-a-1", CANDIDATE_A, [1.0]),
				evolveResult("endo.evidence.res-a-2", CANDIDATE_A, [0.5]),
			],
			[validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.5])],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("selected");
		expect(decision.evidence).toEqual(["endo.evidence.res-a-1", "endo.evidence.res-a-2"]);
		const best = decision.conditions.find((condition) => condition.name === "strictly-best");
		expect(best?.observed).toEqual({ candidateId: CANDIDATE_A, mean: 0.75 });
	});

	it("treats a trial without a finite numeric score as contributing nothing", () => {
		const trials = [
			trial("endo.evidence.res-a", 0, "evolve-set", { score: 1.0 }),
			trial("endo.evidence.res-a", 1, "evolve-set", { other: 2 }),
			trial("endo.evidence.res-a", 2, "evolve-set", null),
			trial("endo.evidence.res-a", 3, "evolve-set"),
		];
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[result("endo.evidence.res-a", CANDIDATE_A, trials)],
			[validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.5])],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("selected");
		const best = decision.conditions.find((condition) => condition.name === "strictly-best");
		expect(best?.observed).toEqual({ candidateId: CANDIDATE_A, mean: 1.0 });
	});

	it("ignores a non-numeric score member", () => {
		const trials = [trial("endo.evidence.res-a", 0, "evolve-set", { score: "high" })];
		const ctx = context([candidate(CANDIDATE_A)], [result("endo.evidence.res-a", CANDIDATE_A, trials)]);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("evidence-present not met");
	});

	it("records inconclusive when no candidate carries scored evolve evidence", () => {
		const decision = decide("endo.evidence.dec-1", context([candidate(CANDIDATE_A), candidate(CANDIDATE_B)]));
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.candidateId).toBeUndefined();
		expect(decision.evidence).toEqual([]);
		expect(decision.validationEvidence).toBeUndefined();
		expect(decision.reason).toBe("evidence-present not met");
		expect(decision.conditions.every((condition) => !condition.met)).toBe(true);
	});

	it("records inconclusive on a tie for the best", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.8]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.8]),
			],
			[
				validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.5]),
				validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.5]),
			],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("strictly-best not met");
		const best = decision.conditions.find((condition) => condition.name === "strictly-best");
		expect(best?.observed).toEqual({ candidateId: null, mean: null });
	});

	it("records inconclusive when the strict best carries no validation evidence", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.7]),
			],
			[validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.4])],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("inconclusive");
		expect(decision.reason).toBe("validation-present not met");
		const validation = decision.conditions.find((condition) => condition.name === "validation-present");
		expect(validation?.met).toBe(false);
		expect(validation?.observed).toEqual({ trials: 0, mean: null });
	});

	it("counts validation evidence recorded in either array", () => {
		const validationForA = validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.8]);
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				validationForA,
				evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.5]),
			],
			[validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.4])],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
		expect(decision.validationEvidence).toEqual(["endo.evidence.res-a-h"]);
	});

	it("counts a record present in both arrays once", () => {
		const both = evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.8]);
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[both],
			[both, validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.5])],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		const best = decision.conditions.find((condition) => condition.name === "strictly-best");
		expect(best?.observed).toEqual({ candidateId: CANDIDATE_A, mean: 0.8 });
	});

	it("never selects on validation performance alone", () => {
		const ctx = context(
			[candidate(CANDIDATE_A), candidate(CANDIDATE_B)],
			[evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.5])],
			[
				validationResult("endo.evidence.res-a-h", CANDIDATE_A, [1.0]),
				validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.4]),
			],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_B);
	});

	it("ignores results for candidates outside the context", () => {
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[
				evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]),
				evolveResult("endo.evidence.res-x", "endo.candidate.p7-x", [5.0]),
			],
			[validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.5])],
		);
		const decision = decide("endo.evidence.dec-1", ctx);
		expect(decision.outcome).toBe("selected");
		expect(decision.candidateId).toBe(CANDIDATE_A);
	});

	it("is deterministic over shuffled input order", () => {
		const a = [candidate(CANDIDATE_A)];
		const b = [candidate(CANDIDATE_B)];
		const resA = evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9]);
		const resB = evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.5]);
		const hoA = validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.7]);
		const hoB = validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.6]);
		const first = decide("endo.evidence.dec-1", context([...a, ...b], [resA, resB], [hoA, hoB]));
		const second = decide("endo.evidence.dec-1", context([...b, ...a], [resB, resA], [hoB, hoA]));
		expect(first).toEqual(second);
	});

	it("uses the caller-supplied decision id", () => {
		const ctx = context(
			[candidate(CANDIDATE_A)],
			[evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9])],
			[validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.7])],
		);
		const first = decide("endo.evidence.dec-1", ctx);
		const second = decide("endo.evidence.dec-2", ctx);
		expect(first.id).toBe("endo.evidence.dec-1");
		expect(second.id).toBe("endo.evidence.dec-2");
		const { id: _first, ...restFirst } = first;
		const { id: _second, ...restSecond } = second;
		expect(restFirst).toEqual(restSecond);
	});

	it("rejects a decision id outside the evidence namespace", () => {
		expect(() => decide("endo.candidate.dec-1", context([]))).toThrow(TypeError);
	});

	it("rejects a non-object experiment", () => {
		const ctx = context([]) as unknown as Record<string, unknown>;
		ctx.experiment = null;
		expect(() =>
			ENDO_HIGHEST_SCORE_POLICY_V0.decide(ctx as unknown as EndoEvolutionPolicyContextV0, "endo.evidence.dec-1"),
		).toThrow(TypeError);
	});

	it("rejects a non-array context member", () => {
		const ctx = context([]) as unknown as Record<string, unknown>;
		ctx.candidates = "nope";
		expect(() =>
			ENDO_HIGHEST_SCORE_POLICY_V0.decide(ctx as unknown as EndoEvolutionPolicyContextV0, "endo.evidence.dec-1"),
		).toThrow(TypeError);
	});

	it("records the decision end to end through the substrate", () => {
		const record = experimentRecord();
		const core = createEndoEvolutionCoreV0();
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-p7", record);
		const lifecycle = createEndoExperimentLifecycleV0(record);

		const mutation: EndoMutationV0 = {
			schemaVersion: "endo.mutation.v0",
			id: "endo.evidence.mut-p7",
			component: "prompt",
			operation: "replace",
		};
		core.mutations.add(mutation);
		ledger.append(mutation);

		const candA: EndoCandidateV0 = {
			schemaVersion: "endo.candidate.v0",
			id: CANDIDATE_A,
			mutations: ["endo.evidence.mut-p7"],
			provenance: "baseline",
		};
		const candB: EndoCandidateV0 = { schemaVersion: "endo.candidate.v0", id: CANDIDATE_B, mutations: [] };
		core.candidates.add(candA);
		ledger.append(candA);
		core.candidates.add(candB);
		ledger.append(candB);

		const resA = evolveResult("endo.evidence.res-a", CANDIDATE_A, [0.9, 0.8]);
		const resAh = validationResult("endo.evidence.res-a-h", CANDIDATE_A, [0.7]);
		const resB = evolveResult("endo.evidence.res-b", CANDIDATE_B, [0.5]);
		const resBh = validationResult("endo.evidence.res-b-h", CANDIDATE_B, [0.6]);
		for (const res of [resA, resAh, resB, resBh]) ledger.append(res);

		const advance = (id: string, to: string) => {
			lifecycle.transition({ id, to });
			ledger.append(lifecycle.transitions[lifecycle.transitions.length - 1]);
		};
		for (const to of ["prepared", "running", "evaluated", "compared"] as const)
			advance(`endo.evidence.tr-p7-${to}`, to);

		const ctx: EndoEvolutionPolicyContextV0 = {
			experiment: record,
			candidates: [candA, candB],
			mutations: [mutation],
			results: [resA, resB],
			validation: [resAh, resBh],
			history: ledger.ledger().entries,
		};
		const selectionDecision = decide("endo.evidence.dec-p7", ctx);
		expect(selectionDecision.outcome).toBe("selected");
		expect(selectionDecision.candidateId).toBe(CANDIDATE_A);
		expect(selectionDecision.evidence).toEqual(["endo.evidence.res-a"]);
		expect(selectionDecision.validationEvidence).toEqual(["endo.evidence.res-a-h"]);
		core.selections.add(selectionDecision);
		ledger.append(selectionDecision);
		advance("endo.evidence.tr-p7-selected", "selected");

		const request: EndoPromotionRequestV0 = {
			schemaVersion: "endo.promotion-request.v0",
			id: "endo.evidence.req-p7",
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_A,
			selectionId: "endo.evidence.dec-p7",
			target: "harness",
		};
		core.promotionRequests.add(request);
		ledger.append(request);
		advance("endo.evidence.tr-p7-requested", "promotion-requested");

		const promotion: EndoPromotionDecisionV0 = {
			schemaVersion: "endo.promotion-decision.v0",
			id: "endo.evidence.prom-p7",
			requestId: "endo.evidence.req-p7",
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_A,
			outcome: "granted",
			authority: "ops-p7",
			evidence: selectionDecision.evidence,
		};
		core.promotionDecisions.add(promotion);
		ledger.append(promotion);
		advance("endo.evidence.tr-p7-promoted", "promoted");

		const entries = ledger.ledger().entries;
		expect(entries).toHaveLength(17);
		expect(entries.map((entry) => entry.sequence)).toEqual(entries.map((_entry, index) => index + 1));

		const replayedLedger = replayEndoEvidenceLedgerV0(ledger.ledger());
		expect(replayedLedger).toEqual(ledger.ledger());
		const replayedLifecycle = replayEndoExperimentLifecycleV0(record, lifecycle.transitions);
		expect(replayedLifecycle.state).toBe("promoted");
		expect(replayedLifecycle.transitions).toEqual(lifecycle.transitions);
	});
});
