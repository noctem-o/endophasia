import { describe, expect, it } from "vitest";
import { mapCogitatorWitnessV0 } from "../adapters/cogitator/mapping.ts";
import { mapDeadboltLeaseV0, mapDeadboltReceiptV0 } from "../adapters/deadbolt/mapping.ts";
import { mapMagpieStandingV0 } from "../adapters/magpie/mapping.ts";
import {
	buildEndoArtifactV0,
	createEndoEvidenceLedgerV0,
	createEndoEvolutionCoreV0,
	createEndoExperimentLifecycleV0,
	ENDO_HIGHEST_SCORE_POLICY_V0,
	replayEndoEvidenceLedgerV0,
	replayEndoExperimentLifecycleV0,
} from "../evolution/index.ts";
import type { EndoEvolutionPolicyContextV0 } from "../evolution/policies/ports.ts";
import type { EndoEvaluationProfileV0, EndoEvaluationResultV0, EndoTrialResultV0 } from "../protocol/evaluation.ts";
import type {
	EndoCandidateV0,
	EndoExperimentRecordV0,
	EndoExperimentStateV0,
	EndoExperimentTransitionV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import type {
	EndoLeaseRecordV0,
	EndoPromotionClosureV0,
	EndoReceiptRecordV0,
	EndoWitnessCoverageV0,
} from "../protocol/trust.ts";
import { verifyEndoPromotionClosureV0 } from "../trust/authority.ts";
import { witnessCoverageV0 } from "../trust/witness.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const OTHER_DIGEST = "0f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const EXPERIMENT_ID = "endo.experiment.exp-trust";
const CANDIDATE_ID = "endo.candidate.c-trust";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: EXPERIMENT_ID, evaluator: "eval-1", grader: "grade-1" };
}

function result(
	id: string,
	partition: "evolve-set" | "held-out",
	runPrefix: string,
	score: number,
	trialCount = 2,
): EndoEvaluationResultV0 {
	const profile: EndoEvaluationProfileV0 = {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: EXPERIMENT_ID,
		candidateId: CANDIDATE_ID,
		candidateRevision: "rev-3",
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		evaluator: "eval-1",
		grader: "grade-1",
		seeds: [7, "seed-b"],
		trialCount,
	};
	const trial = (i: number): EndoTrialResultV0 => ({
		schemaVersion: "endo.trial-result.v0",
		coordinates: {
			schemaVersion: "endo.trial.v0",
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			trial: i,
			runId: `endo.run.${runPrefix}${i}`,
		},
		partition,
		raw: { ok: true },
		derived: { score: score + i * 0.01 },
	});
	return {
		schemaVersion: "endo.evaluation-result.v0",
		id,
		profile,
		trials: Array.from({ length: trialCount }, (_ignored, i) => trial(i)),
		resultBundleDigest: DIGEST,
		selectionPolicy: "policy-p",
		promotionState: "candidate",
	};
}

function resultWithoutRunIds(id: string): EndoEvaluationResultV0 {
	const base = result(id, "evolve-set", "n", 0.8);
	return {
		...base,
		trials: base.trials.map((t) => ({ ...t, coordinates: { ...t.coordinates, runId: undefined } })),
	};
}

function selection(overrides: Record<string, unknown> = {}): EndoSelectionDecisionV0 {
	return {
		schemaVersion: "endo.selection-decision.v0",
		id: "endo.evidence.sel-1",
		experimentId: EXPERIMENT_ID,
		policy: { schemaVersion: "endo.selection-policy.v0", name: "highest-score" },
		outcome: "selected",
		candidateId: CANDIDATE_ID,
		conditions: [{ schemaVersion: "endo.selection-condition.v0", name: "mean-score-above-floor", met: true }],
		evidence: [],
		...overrides,
	};
}

function request(overrides: Record<string, unknown> = {}): EndoPromotionRequestV0 {
	return {
		schemaVersion: "endo.promotion-request.v0",
		id: "endo.evidence.req-1",
		experimentId: EXPERIMENT_ID,
		candidateId: CANDIDATE_ID,
		selectionId: "endo.evidence.sel-1",
		...overrides,
	};
}

function decision(overrides: Record<string, unknown> = {}): EndoPromotionDecisionV0 {
	return {
		schemaVersion: "endo.promotion-decision.v0",
		id: "endo.evidence.prom-1",
		requestId: "endo.evidence.req-1",
		experimentId: EXPERIMENT_ID,
		candidateId: CANDIDATE_ID,
		outcome: "granted",
		authority: "ops-a",
		evidence: ["endo.evidence.res-evolve"],
		...overrides,
	};
}

function lease(overrides: Record<string, unknown> = {}): EndoLeaseRecordV0 {
	return {
		schemaVersion: "endo.lease.v0",
		id: "endo.evidence.lease-1",
		route: "promotion.apply",
		capability: "apply the promoted candidate",
		boundTo: "endo.evidence.prom-1",
		signer: "ops-a",
		leaseDigest: DIGEST,
		...overrides,
	};
}

function receipt(overrides: Record<string, unknown> = {}): EndoReceiptRecordV0 {
	return {
		schemaVersion: "endo.receipt.v0",
		id: "endo.evidence.rcpt-1",
		leaseId: "endo.evidence.lease-1",
		route: "promotion.apply",
		outcome: "committed",
		...overrides,
	};
}

describe("witnessCoverageV0", () => {
	it("covers each trial with the first matching witness, in trial order", () => {
		const evolve = result("endo.evidence.res-evolve", "evolve-set", "t", 0.8);
		const wit0 = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-t0",
			input: { runId: "endo.run.t0", witnessRoot: DIGEST, recomputedRoot: DIGEST },
		});
		const coverage = witnessCoverageV0(evolve, [wit0]);
		expect(coverage).toEqual({
			schemaVersion: "endo.witness-coverage.v0",
			experimentId: EXPERIMENT_ID,
			trials: [
				{
					schemaVersion: "endo.witness-coverage-trial.v0",
					trial: 0,
					runId: "endo.run.t0",
					witnessId: "endo.evidence.wit-t0",
				},
				{ schemaVersion: "endo.witness-coverage-trial.v0", trial: 1, runId: "endo.run.t1", witnessId: null },
			],
		});
	});

	it("records an honest absence for unwitnessed runs and missing run ids", () => {
		const noRuns = resultWithoutRunIds("endo.evidence.res-evolve");
		const coverage = witnessCoverageV0(noRuns, []);
		expect(coverage.trials.every((t) => t.runId === null && t.witnessId === null)).toBe(true);
	});

	it("lets the first witness with a matching run id win", () => {
		const evolve = result("endo.evidence.res-evolve", "evolve-set", "t", 0.8, 1);
		const first = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-a",
			input: { runId: "endo.run.t0", witnessRoot: DIGEST },
		});
		const second = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-b",
			input: { runId: "endo.run.t0", witnessRoot: OTHER_DIGEST },
		});
		const coverage = witnessCoverageV0(evolve, [first, second]);
		expect(coverage.trials[0]?.witnessId).toBe("endo.evidence.wit-a");
	});

	it("throws TypeError on a door, for an invalid result or an invalid witness", () => {
		const evolve = result("endo.evidence.res-evolve", "evolve-set", "t", 0.8);
		const witness = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-t0",
			input: { runId: "endo.run.t0", witnessRoot: DIGEST },
		});
		expect(() => witnessCoverageV0({ ...evolve, trialCount: 1 }, [witness])).toThrow(TypeError);
		expect(() => witnessCoverageV0(evolve, [{ schemaVersion: "endo.witness.v0", id: "endo.model.w" }])).toThrow(
			TypeError,
		);
	});
});

describe("verifyEndoPromotionClosureV0", () => {
	it("closes the loop for a granted decision bound by a lease and closed by a receipt", () => {
		const closure = verifyEndoPromotionClosureV0(request(), decision(), lease(), receipt());
		expect(closure).toEqual({
			schemaVersion: "endo.promotion-closure.v0",
			decisionId: "endo.evidence.prom-1",
			closed: true,
			unmet: [],
			outcome: "committed",
		});
	});

	it("names exactly the unmet condition when a single link breaks", () => {
		const cases: Array<[unknown, unknown, unknown, unknown, string]> = [
			[request(), decision({ outcome: "denied", evidence: [] }), lease(), receipt(), "decision-granted"],
			[request(), decision({ requestId: "endo.evidence.req-2" }), lease(), receipt(), "decision-matches-request"],
			[
				request(),
				decision({ experimentId: "endo.experiment.exp-other" }),
				lease(),
				receipt(),
				"decision-matches-request",
			],
			[
				request(),
				decision({ candidateId: "endo.candidate.c-other" }),
				lease(),
				receipt(),
				"decision-matches-request",
			],
			[request(), decision(), lease({ boundTo: "endo.evidence.prom-2" }), receipt(), "lease-binds-decision"],
			[request(), decision(), lease(), receipt({ leaseId: "endo.evidence.lease-2" }), "receipt-closes-lease"],
			[request(), decision(), lease(), receipt({ route: "other.route" }), "receipt-route-matches"],
		];
		for (const [requestArg, decisionArg, leaseArg, receiptArg, name] of cases) {
			const closure = verifyEndoPromotionClosureV0(requestArg, decisionArg, leaseArg, receiptArg);
			expect(closure.closed).toBe(false);
			expect(closure.unmet).toEqual([name]);
		}
	});

	it("still closes the loop for a rolled-back or refused receipt, recording its outcome", () => {
		expect(
			verifyEndoPromotionClosureV0(request(), decision(), lease(), receipt({ outcome: "rolled-back" })),
		).toMatchObject({
			closed: true,
			unmet: [],
			outcome: "rolled-back",
		});
		expect(
			verifyEndoPromotionClosureV0(
				request(),
				decision(),
				lease(),
				receipt({ outcome: "rolled-back", rollbackOf: "endo.evidence.rcpt-0" }),
			),
		).toMatchObject({ closed: true, unmet: [], outcome: "rolled-back" });
		expect(
			verifyEndoPromotionClosureV0(request(), decision(), lease(), receipt({ outcome: "refused" })),
		).toMatchObject({
			closed: true,
			unmet: [],
			outcome: "refused",
		});
	});

	it("throws TypeError on a door, for each invalid record", () => {
		expect(() =>
			verifyEndoPromotionClosureV0({ ...request(), id: "endo.model.req-1" }, decision(), lease(), receipt()),
		).toThrow(TypeError);
		expect(() =>
			verifyEndoPromotionClosureV0(request(), decision({ outcome: "granted", evidence: [] }), lease(), receipt()),
		).toThrow(TypeError);
		expect(() =>
			verifyEndoPromotionClosureV0(request(), decision(), { ...lease(), route: "Bad route" }, receipt()),
		).toThrow(TypeError);
		expect(() =>
			verifyEndoPromotionClosureV0(request(), decision(), lease(), { ...receipt(), outcome: "aborted" }),
		).toThrow(TypeError);
	});

	it("returns a report that validates through the protocol", () => {
		const closure: EndoPromotionClosureV0 = verifyEndoPromotionClosureV0(request(), decision(), lease(), receipt());
		expect(closure.schemaVersion).toBe("endo.promotion-closure.v0");
	});
});

describe("the promotion spine with the trust providers", () => {
	it("runs witness, standing, lease, and receipt through the ledger, replayable end to end", () => {
		const experiment = experimentRecord();
		const core = createEndoEvolutionCoreV0();
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-trust", experiment);
		const lifecycle = createEndoExperimentLifecycleV0(experiment);

		const artifact = buildEndoArtifactV0({
			id: "endo.evidence.art-1",
			kind: "prompt",
			content: { system: "Be concise." },
		});
		core.artifacts.add(artifact);
		ledger.append(artifact);

		const mutation: EndoMutationV0 = {
			schemaVersion: "endo.mutation.v0",
			id: "endo.evidence.mut-1",
			component: "prompt",
			operation: "replace",
			artifactId: "endo.evidence.art-1",
		};
		core.mutations.add(mutation);
		ledger.append(mutation);

		const baseCandidate: EndoCandidateV0 = {
			schemaVersion: "endo.candidate.v0",
			id: "endo.candidate.c-0",
			mutations: [],
		};
		const candidate: EndoCandidateV0 = {
			schemaVersion: "endo.candidate.v0",
			id: CANDIDATE_ID,
			parentCandidateId: "endo.candidate.c-0",
			mutations: ["endo.evidence.mut-1"],
		};
		core.candidates.add(baseCandidate);
		core.candidates.add(candidate);
		ledger.append(baseCandidate);
		ledger.append(candidate);

		const evolve = result("endo.evidence.res-evolve", "evolve-set", "t", 0.9);
		const heldOut = result("endo.evidence.res-heldout", "held-out", "h", 0.8);
		ledger.append(evolve);
		ledger.append(heldOut);

		// Cogitator: witness roots anchor the replayed runs of the evolve partition.
		const witT0 = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-t0",
			input: { runId: "endo.run.t0", witnessRoot: DIGEST, recomputedRoot: DIGEST },
		});
		const witH0 = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-h0",
			input: {
				runId: "endo.run.h0",
				witnessRoot: OTHER_DIGEST,
				recomputedRoot: OTHER_DIGEST,
				expectedRoot: OTHER_DIGEST,
			},
		});
		ledger.append(witT0);
		ledger.append(witH0);

		const coverage: EndoWitnessCoverageV0 = witnessCoverageV0(evolve, [witT0]);
		expect(coverage.trials[0]?.witnessId).toBe("endo.evidence.wit-t0");
		expect(coverage.trials[1]?.witnessId).toBeNull();

		const transition = (
			id: string,
			sequence: number,
			from: EndoExperimentStateV0,
			to: EndoExperimentStateV0,
		): EndoExperimentTransitionV0 => ({
			schemaVersion: "endo.experiment-transition.v0",
			id,
			experimentId: EXPERIMENT_ID,
			sequence,
			from,
			to,
			evidence: ["endo.evidence.res-evolve"],
		});
		const advance = (id: string, to: EndoExperimentStateV0, sequence: number, from: EndoExperimentStateV0) => {
			lifecycle.transition({ id, to });
			ledger.append(transition(id, sequence, from, to));
		};
		advance("endo.evidence.tr-1", "prepared", 1, "created");
		advance("endo.evidence.tr-2", "running", 2, "prepared");
		advance("endo.evidence.tr-3", "evaluated", 3, "running");
		advance("endo.evidence.tr-4", "compared", 4, "evaluated");

		const context: EndoEvolutionPolicyContextV0 = {
			experiment,
			candidates: [candidate],
			mutations: [mutation],
			results: [evolve],
			heldOut: [heldOut],
			history: ledger.ledger().entries,
		};
		const selection = ENDO_HIGHEST_SCORE_POLICY_V0.decide(context, "endo.evidence.sel-1");
		expect(selection.outcome).toBe("selected");
		core.selections.add(selection);
		ledger.append(selection);

		// Magpie: standing grounds the selection — supported under v2, never settled.
		const standing = mapMagpieStandingV0({
			id: "endo.evidence.stand-1",
			input: {
				claimId: "magpie-claim-7",
				policy: "v2",
				standing: "supported",
				evidence: [evolve.id, selection.id],
				qualifications: ["deterministic direct support"],
			},
		});
		expect(standing.standing).toBe("supported");
		ledger.append(standing);
		advance("endo.evidence.tr-5", "selected", 5, "compared");

		const promotionRequest: EndoPromotionRequestV0 = {
			schemaVersion: "endo.promotion-request.v0",
			id: "endo.evidence.req-1",
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			selectionId: selection.id,
		};
		core.promotionRequests.add(promotionRequest);
		ledger.append(promotionRequest);
		advance("endo.evidence.tr-6", "promotion-requested", 6, "selected");

		const promotionDecision: EndoPromotionDecisionV0 = {
			schemaVersion: "endo.promotion-decision.v0",
			id: "endo.evidence.prom-1",
			requestId: promotionRequest.id,
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			outcome: "granted",
			authority: "ops-a",
			evidence: selection.evidence,
		};
		core.promotionDecisions.add(promotionDecision);
		ledger.append(promotionDecision);

		// Deadbolt: the lease binds the exact decision that grants it.
		const leaseRecord = mapDeadboltLeaseV0({
			id: "endo.evidence.lease-1",
			input: {
				route: "promotion.apply",
				capability: "apply the promoted candidate",
				boundTo: promotionDecision.id,
				signer: "ops-a",
				leaseDigest: DIGEST,
			},
		});
		ledger.append(leaseRecord);
		advance("endo.evidence.tr-7", "promoted", 7, "promotion-requested");

		const receiptRecord = mapDeadboltReceiptV0({
			id: "endo.evidence.rcpt-1",
			input: { leaseId: leaseRecord.id, route: "promotion.apply", outcome: "committed", result: { steps: 2 } },
		});
		ledger.append(receiptRecord);

		const closure = verifyEndoPromotionClosureV0(promotionRequest, promotionDecision, leaseRecord, receiptRecord);
		expect(closure).toEqual({
			schemaVersion: "endo.promotion-closure.v0",
			decisionId: "endo.evidence.prom-1",
			closed: true,
			unmet: [],
			outcome: "committed",
		});

		const persisted = ledger.ledger();
		expect(persisted.entries).toHaveLength(21);
		expect(persisted.entries.map((entry) => entry.sequence)).toEqual(
			persisted.entries.map((_entry, index) => index + 1),
		);
		expect(persisted.entries.map((entry) => entry.kind)).toEqual([
			"artifact",
			"mutation",
			"candidate",
			"candidate",
			"evaluation-result",
			"evaluation-result",
			"witness",
			"witness",
			"experiment-transition",
			"experiment-transition",
			"experiment-transition",
			"experiment-transition",
			"selection-decision",
			"standing",
			"experiment-transition",
			"promotion-request",
			"experiment-transition",
			"promotion-decision",
			"lease",
			"experiment-transition",
			"receipt",
		]);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
		const replayedLifecycle = replayEndoExperimentLifecycleV0(experiment, lifecycle.transitions);
		expect(replayedLifecycle.state).toBe("promoted");
		expect(replayedLifecycle.transitions).toEqual(lifecycle.transitions);
	});

	it("rejects appending the lease before the decision it binds", () => {
		const experiment = experimentRecord();
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-trust-2", experiment);
		ledger.append(result("endo.evidence.res-evolve", "evolve-set", "t", 0.8));
		expect(() => ledger.append(lease())).toThrow(TypeError);
		ledger.append(selection({ evidence: ["endo.evidence.res-evolve"] }));
		ledger.append(request());
		expect(() => ledger.append(lease())).toThrow(TypeError);
		ledger.append(decision());
		expect(ledger.append(lease()).kind).toBe("lease");
	});
});
