/**
 * Phase 12 — the RRSI selection policy: the substrate record of RRSI's annealing and pruning over
 * the recorded experiment evidence (README "## Phase 7 — RRSI + REEF providers": the policy seam
 * RRSI plugs into; the provider mechanism itself is provider-side, and this module decides over
 * the context the seam exposes and records an ordinary EndoSelectionDecisionV0 named by the
 * policy's identity).
 *
 * RRSI (github.com/google-research/rrsi) anneals the search: the deeper a candidate sits in the
 * candidate tree, the fewer edits it may carry, and an improvement that the noise band cannot
 * distinguish from chance is not a result. Under the v0 policy seam the mechanisms are recorded
 * as conditions, in policy order:
 *
 * 1. `evidence-present`: at least one candidate carries scored evolve-set evidence;
 * 2. `edit-budget-annealed`: the unique strict best on the evolve set may carry at most
 *    max(1, ceil(4 * 0.5^depth)) mutations, where depth is its recorded parent chain (a root
 *    candidate — no parent, or a parent absent from the context — is at depth 0); a deeper
 *    candidate with more recorded edits than the budget is pruned;
 * 3. `noise-pruner`: the band is the mean, over every candidate with at least two scored
 *    evolve-set trials, of that candidate's (max - min) evolve-set trial score; the best
 *    candidate is pruned when its evolve-set gain over its scored parent is within the band.
 *    When the band cannot be calibrated, or the parent is not scored, the condition is honestly
 *    met, never a fabricated band;
 * 4. `held-out-critic`: the best candidate is screened when it improves on the evolve set while
 *    degrading on the held-out set — the leakage direction; absent parent evidence is an honest
 *    absence, not a screen;
 * 5. `strictly-best-evolve`: exactly one candidate is the strict best on the evolve set — a tie
 *    is not a best;
 * 6. `held-out-present`: the best candidate carries scored held-out evidence.
 *
 * The outcome is "selected" only when every condition is met; otherwise "inconclusive", with the
 * first unmet condition named. Conditions 2-4 apply to the unique strict best when one exists;
 * without one they are recorded as not applicable (honestly met), so the tie or the missing
 * evidence is the named reason. A pruned best is never selected and an unranked candidate is
 * never guessed at. The policy is pure and deterministic over the context, reads nothing beyond
 * it, and exits through the protocol validator of the decision it records.
 */

import type { EndoCandidateV0, EndoSelectionConditionV0, EndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { validateEndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import { type CandidateEvidenceV0, collectEvidenceV0, meanV0 } from "./baseline.ts";
import type { EndoEvolutionPolicyContextV0, EndoEvolutionPolicyV0 } from "./ports.ts";

/** The recorded identity of the RRSI policy. */
const RRSI_POLICY_IDENTITY_V0 = {
	schemaVersion: "endo.selection-policy.v0",
	name: "rrsi",
	revision: "v0",
} as const;

/** The RRSI annealed edit budget at the given depth of the candidate tree. */
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
 * The RRSI noise band: the mean, over every candidate with at least two scored evolve-set trials,
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
 * The RRSI policy: annealed edit budget, noise-band pruning, held-out critic screen, and the
 * baseline's own gate — a unique strict best on the evolve set carrying held-out evidence.
 */
export const ENDO_RRSI_POLICY_V0: EndoEvolutionPolicyV0 = {
	policy: { ...RRSI_POLICY_IDENTITY_V0 },
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
		for (const member of ["candidates", "mutations", "results", "heldOut", "history"] as const) {
			if (!Array.isArray(context[member])) {
				throw new TypeError(`policy context ${member} must be an array`);
			}
		}

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
			const met = parentMean === null || band === null || (gain !== null && gain > band);
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
				name: "held-out-critic",
				observed: { applicable: false },
				met: true,
			};
		} else {
			const parent = bestCandidate.parentCandidateId;
			const parentEntry = parent === undefined ? undefined : byId.get(parent);
			const parentEvolveMean = parentEntry === undefined ? null : meanV0(parentEntry.evolveScores);
			const parentHeldOutMean = parentEntry === undefined ? null : meanV0(parentEntry.heldOutScores);
			const bestHeldOutMean = meanV0(bestEntry.heldOutScores);
			const screened =
				parentEvolveMean !== null &&
				parentHeldOutMean !== null &&
				bestHeldOutMean !== null &&
				strictlyBest.mean > parentEvolveMean &&
				bestHeldOutMean < parentHeldOutMean;
			criticCondition = {
				schemaVersion: "endo.selection-condition.v0",
				name: "held-out-critic",
				observed: {
					evolveGain: parentEvolveMean === null ? null : strictlyBest.mean - parentEvolveMean,
					heldOutGain:
						parentHeldOutMean === null || bestHeldOutMean === null ? null : bestHeldOutMean - parentHeldOutMean,
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
				name: "held-out-present",
				observed: {
					trials: bestEntry?.heldOutScores.length ?? 0,
					mean: bestEntry === undefined ? null : meanV0(bestEntry.heldOutScores),
				},
				met: strictlyBest !== null && (bestEntry?.heldOutScores.length ?? 0) > 0,
			},
		];

		const decision: EndoSelectionDecisionV0 = {
			schemaVersion: "endo.selection-decision.v0",
			id,
			experimentId: context.experiment.id,
			policy: { ...RRSI_POLICY_IDENTITY_V0 },
			outcome: "inconclusive",
			conditions,
			evidence: [],
		};
		if (strictlyBest !== null && bestEntry !== undefined && conditions.every((condition) => condition.met)) {
			decision.outcome = "selected";
			decision.candidateId = strictlyBest.id;
			decision.evidence = bestEntry.evolveResultIds;
			decision.heldOutEvidence = bestEntry.heldOutResultIds;
		} else {
			const firstUnmet = conditions.find((condition) => !condition.met);
			decision.reason = firstUnmet === undefined ? "selection did not converge" : `${firstUnmet.name} not met`;
		}

		const validated = validateEndoSelectionDecisionV0(decision);
		if (validated === null) throw new TypeError("RRSI selection decision failed validation");
		return validated;
	},
};
