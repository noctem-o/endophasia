/**
 * An RRSI-inspired selection policy over the recorded experiment evidence. It is NOT an implementation of RRSI
 * (Regularized Recursive Self-Improvement, github.com/google-research/rrsi); it borrows two of RRSI's ideas (bound
 * how many edits a candidate may bundle, and do not accept a gain that evaluation noise could explain) and implements
 * each with its own invented rule. A decision recorded under this policy's identity is evidence about these rules
 * only, never a claim about what RRSI would have selected.
 *
 * How it differs from upstream RRSI (checked against google-research/rrsi at be50316, 2026-09-23):
 *
 * | Mechanism | Upstream RRSI | This policy |
 * | :--- | :--- | :--- |
 * | Edit budget | cosine annealing over rounds, b_t = ceil(b_min + (b_max - b_min) / 2 * (1 + cos(pi t / T))), enforced on the proposer | max(1, ceil(4 * 0.5^depth)) over the candidate's recorded parent depth, checked after the fact; base and decay are invented |
 * | Noise band | delta per instance, fixed in config or calibrated as z * sd of the null score difference of repeated base evaluations (or a trial bootstrap); a run refuses to start without one | the mean (max - min) trial spread over the candidates in the context; when it cannot be computed the decision is inconclusive |
 * | Acceptance floor | S' >= S* - delta against the best score so far | gain over the recorded parent must exceed the band |
 * | Cost rule | gaining candidates must satisfy relative token cost change <= beta0 + beta1 * gain; inside the band a shaped score/cost/novelty rule | none: the policy context carries no cost |
 * | Critic | a leakage screen (domain denylist plus LLM review) before evaluation | evolve gain with validation loss against the parent |
 * | Pruning | components whose recent yield is not positive are offered to the proposer for removal | not modelled |
 *
 * Conditions, in policy order:
 *
 * 1. `evidence-present`: at least one candidate carries scored evolve-set evidence;
 * 2. `edit-budget-annealed`: the unique strict best on the evolve set may carry at most
 *    max(1, ceil(4 * 0.5^depth)) mutations, where depth is its recorded parent chain (a root candidate, with no
 *    parent or a parent absent from the context, is at depth 0);
 * 3. `noise-pruner`: the band is the mean, over every candidate with at least two scored evolve-set trials, of that
 *    candidate's (max - min) evolve-set trial score; the best candidate is pruned when its evolve-set gain over its
 *    scored parent is within the band. When the band cannot be computed (`bandSource: "unavailable"`: no candidate
 *    has two scored evolve-set trials) or the gain cannot be (no scored parent: `gain: null`), the condition is NOT
 *    met and the decision is inconclusive. A gap in the noise evidence never lets a candidate through;
 * 4. `validation-critic`: the best candidate is screened when it improves on the evolve set while degrading on the
 *    validation set; absent parent evidence is an absence, not a screen;
 * 5. `strictly-best-evolve`: exactly one candidate is the strict best on the evolve set (a tie is not a best);
 * 6. `validation-present`: the best candidate carries scored validation evidence.
 *
 * The outcome is "selected" only when every condition is met; otherwise "inconclusive", with the first unmet
 * condition named. Conditions 2-4 apply to the unique strict best when one exists; without one they are recorded as
 * not applicable, so the tie or the missing evidence is the named reason. The policy is pure and deterministic over
 * the context, reads nothing beyond it, and exits through the protocol validator of the decision it records.
 *
 * A measured run-to-run band now exists, and this policy does not read it. `research/variance/1.0.1/RESULTS.md`
 * measured how often repeated live runs of the same task agree, for Pi 1.0.1 with qwen3.8-27b on llama.cpp: three
 * synthetic tasks, N = 20 per arm, under Pi's default sampling and under temperature 0 and a fixed seed. Per judged
 * trajectory layer it reports modal agreement (95% Wilson) and pairwise agreement (trial bootstrap). It also reports
 * success-check pass rates, which were 20/20 in every cell.
 *
 * That band is over trajectory agreement and check pass rates, for one runtime, model and machine. It is not over this
 * policy's evolve-set scores, so it is not a calibration of `noise-pruner`. Selection is unchanged. Wiring a measured
 * band in (RRSI calibrates delta from repeated base evaluations, see the table above) is later work.
 */

import type { EndoCandidateV0, EndoSelectionConditionV0, EndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { validateEndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import { assertNoPromotionHoldoutV0, type CandidateEvidenceV0, collectEvidenceV0, meanV0 } from "./baseline.ts";
import type { EndoEvolutionPolicyContextV0, EndoEvolutionPolicyV0 } from "./ports.ts";

/** The recorded identity of the RRSI-inspired policy. */
const RRSI_INSPIRED_POLICY_IDENTITY_V0 = {
	schemaVersion: "endo.selection-policy.v0",
	name: "rrsi-inspired",
	revision: "v0",
} as const;

/** The invented depth-decayed edit budget (not RRSI's round-based cosine schedule). */
function editBudgetV0(depth: number): number {
	return Math.max(1, Math.ceil(4 * 0.5 ** depth));
}

/**
 * The recorded depth of a candidate: the number of recorded parent hops to the root (a root — no
 * parent, or a parent absent from the context — is at depth 0). A parent chain that cycles in the
 * recorded context ends where the cycle closes; the walk never loops.
 */
function candidateDepthV0(candidates: readonly EndoCandidateV0[], candidateId: string): number {
	const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
	const seen = new Set<string>([candidateId]);
	let current = candidateId;
	let depth = 0;
	for (;;) {
		const parent = byId.get(current)?.parentCandidateId;
		if (parent === undefined || !byId.has(parent) || seen.has(parent)) break;
		seen.add(parent);
		current = parent;
		depth += 1;
	}
	return depth;
}

/**
 * The noise band: the mean, over every candidate with at least two scored evolve-set trials,
 * of that candidate's (max - min) evolve-set trial score. Null when the band cannot be calibrated
 * from the context (an honest absence, never a fabricated zero).
 */
function noiseBandV0(evidence: readonly CandidateEvidenceV0[]): number | null {
	const bands: number[] = [];
	for (const entry of evidence) {
		if (entry.evolveScores.length < 2) continue;
		let max = entry.evolveScores[0];
		let min = entry.evolveScores[0];
		for (const score of entry.evolveScores) {
			if (score > max) max = score;
			if (score < min) min = score;
		}
		bands.push(max - min);
	}
	return meanV0(bands);
}

/**
 * The RRSI-inspired policy: depth-decayed edit budget, trial-spread noise band, validation critic screen, and the
 * baseline's own gate (a unique strict best on the evolve set carrying validation evidence).
 */
export const ENDO_RRSI_INSPIRED_POLICY_V0: EndoEvolutionPolicyV0 = {
	policy: { ...RRSI_INSPIRED_POLICY_IDENTITY_V0 },
	decide(context: EndoEvolutionPolicyContextV0, id: string): EndoSelectionDecisionV0 {
		if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
			throw new TypeError("decision id must be an endo.evidence.* identifier");
		}
		if (
			typeof context !== "object" ||
			context === null ||
			typeof context.experiment !== "object" ||
			context.experiment === null
		) {
			throw new TypeError("policy context experiment must be an object");
		}
		for (const member of ["candidates", "mutations", "results", "validation", "history"] as const) {
			if (!Array.isArray(context[member])) {
				throw new TypeError(`policy context ${member} must be an array`);
			}
		}
		assertNoPromotionHoldoutV0(context);

		const evidence = collectEvidenceV0(context);
		const byId = new Map(evidence.map((entry) => [entry.candidateId, entry]));
		const scored = evidence.filter((entry) => meanV0(entry.evolveScores) !== null);

		let best: { id: string; mean: number } | null = null;
		let tied = false;
		for (const entry of scored) {
			const mean = meanV0(entry.evolveScores);
			if (mean === null) continue;
			if (best === null || mean > best.mean) {
				best = { id: entry.candidateId, mean };
				tied = false;
			} else if (mean === best.mean) {
				tied = true;
			}
		}
		const strictlyBest = best !== null && !tied ? best : null;
		const bestEntry = strictlyBest === null ? undefined : byId.get(strictlyBest.id);
		const bestCandidate =
			strictlyBest === null || bestEntry === undefined
				? undefined
				: context.candidates.find((candidate) => candidate.id === strictlyBest.id);

		let budgetCondition: EndoSelectionConditionV0;
		if (strictlyBest === null || bestCandidate === undefined) {
			budgetCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "edit-budget-annealed",
				observed: { applicable: false },
				met: true,
			};
		} else {
			const depth = candidateDepthV0(context.candidates, bestCandidate.id);
			const budget = editBudgetV0(depth);
			budgetCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "edit-budget-annealed",
				parameters: { budgetBase: 4, decay: 0.5 },
				observed: { candidateId: bestCandidate.id, depth, budget, mutations: bestCandidate.mutations.length },
				met: bestCandidate.mutations.length <= budget,
			};
		}

		let noiseCondition: EndoSelectionConditionV0;
		if (strictlyBest === null || bestEntry === undefined || bestCandidate === undefined) {
			noiseCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "noise-pruner",
				observed: { applicable: false },
				met: true,
			};
		} else {
			const parent = bestCandidate.parentCandidateId;
			const parentEntry = parent === undefined ? undefined : byId.get(parent);
			const parentMean = parentEntry === undefined ? null : meanV0(parentEntry.evolveScores);
			const band = noiseBandV0(evidence);
			const gain = parentMean === null ? null : strictlyBest.mean - parentMean;
			// A missing band or a missing parent is a gap in the evidence, never a pass.
			const met = band !== null && gain !== null && gain > band;
			noiseCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "noise-pruner",
				observed: {
					band,
					bandSource: band === null ? "unavailable" : "measured",
					gain,
					parentCandidateId: parent ?? null,
				},
				met,
			};
		}

		let criticCondition: EndoSelectionConditionV0;
		if (strictlyBest === null || bestEntry === undefined || bestCandidate === undefined) {
			criticCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "validation-critic",
				observed: { applicable: false },
				met: true,
			};
		} else {
			const parent = bestCandidate.parentCandidateId;
			const parentEntry = parent === undefined ? undefined : byId.get(parent);
			const parentEvolveMean = parentEntry === undefined ? null : meanV0(parentEntry.evolveScores);
			const parentValidationMean = parentEntry === undefined ? null : meanV0(parentEntry.validationScores);
			const bestValidationMean = meanV0(bestEntry.validationScores);
			const screened =
				parentEvolveMean !== null &&
				parentValidationMean !== null &&
				bestValidationMean !== null &&
				strictlyBest.mean > parentEvolveMean &&
				bestValidationMean < parentValidationMean;
			criticCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "validation-critic",
				observed: {
					evolveGain: parentEvolveMean === null ? null : strictlyBest.mean - parentEvolveMean,
					validationGain:
						parentValidationMean === null || bestValidationMean === null
							? null
							: bestValidationMean - parentValidationMean,
					screened,
					parentCandidateId: parent ?? null,
				},
				met: !screened,
			};
		}

		const conditions: EndoSelectionConditionV0[] = [
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "evidence-present",
				observed: { candidatesScored: scored.length },
				met: scored.length > 0,
			},
			budgetCondition,
			noiseCondition,
			criticCondition,
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "strictly-best-evolve",
				parameters: { partition: "evolve-set" },
				observed: { candidateId: strictlyBest?.id ?? null, mean: strictlyBest?.mean ?? null },
				met: strictlyBest !== null,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "validation-present",
				observed: {
					trials: bestEntry?.validationScores.length ?? 0,
					mean: bestEntry === undefined ? null : meanV0(bestEntry.validationScores),
				},
				met: strictlyBest !== null && (bestEntry?.validationScores.length ?? 0) > 0,
			},
		];

		const decision: EndoSelectionDecisionV0 = {
			schemaVersion: "endo.selection-decision.v0",
			id,
			experimentId: context.experiment.id,
			policy: { ...RRSI_INSPIRED_POLICY_IDENTITY_V0 },
			outcome: "inconclusive",
			conditions,
			evidence: [],
		};
		if (strictlyBest !== null && bestEntry !== undefined && conditions.every((condition) => condition.met)) {
			decision.outcome = "selected";
			decision.candidateId = strictlyBest.id;
			decision.evidence = bestEntry.evolveResultIds;
			decision.validationEvidence = bestEntry.validationResultIds;
		} else {
			const firstUnmet = conditions.find((condition) => !condition.met);
			decision.reason = firstUnmet === undefined ? "selection did not converge" : `${firstUnmet.name} not met`;
		}

		const validated = validateEndoSelectionDecisionV0(decision);
		if (validated === null) throw new TypeError("RRSI-inspired selection decision failed validation");
		return validated;
	},
};
