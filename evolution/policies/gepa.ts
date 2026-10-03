/**
 * Phase 12 — the GEPA selection policy: the substrate record of GEPA's two-objective selection
 * over the recorded experiment evidence (README "## Phase 7 — RRSI + REEF providers": the policy
 * seam GEPA plugs into; the reflective optimisation machinery is provider-side, and this module
 * decides over the context the seam exposes and records an ordinary EndoSelectionDecisionV0
 * named by the policy's identity).
 *
 * GEPA optimises candidates against feedback on two objectives — the evolve-set mean and the
 * validation mean. Under the v0 policy seam the selection is recorded as conditions, in policy
 * order:
 *
 * 1. `evidence-present`: at least one candidate carries scored evolve-set evidence;
 * 2. `objective-complete`: at least one candidate carries both an evolve-set mean and a validation
 *    mean — the two-objective optimum is only defined over complete candidates; an experiment
 *    whose objective is incomplete for every candidate is inconclusive
 *    (validation-objective-absent), never decided on one axis alone;
 * 3. `pareto-front`: the non-dominated candidates over (evolve-set mean, validation mean) — a
 *    candidate is dominated when another is at least as good on both objectives and strictly
 *    better on one; the front is recorded on the decision, never only the winner;
 * 4. `strictly-best-validation`: the winner is the best on the validation objective within the front.
 *    Within the front a validation tie is an exact duplicate — a candidate strictly better on the
 *    other objective would dominate it and be off the front — so the tie is broken by candidate
 *    id, and the level that resolved the decision is recorded;
 * 5. `validation-present`: the winner carries scored validation evidence (true by construction of
 *    objective-complete; recorded so the decision reads completely).
 *
 * Seam limitation, recorded by design: GEPA's tried-set bookkeeping (which hypotheses the
 * reflective loop has already tried) is not expressible in the v0 policy context — the context
 * carries the recorded histories, not the loop's live state — so the policy decides over what is
 * recorded and says nothing about the loop.
 *
 * Pure and deterministic over the context; exits through the protocol validator of the decision
 * it records.
 */

import type { EndoSelectionConditionV0, EndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { validateEndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import { assertNoPromotionHoldoutV0, collectEvidenceV0, meanV0 } from "./baseline.ts";
import type { EndoEvolutionPolicyContextV0, EndoEvolutionPolicyV0 } from "./ports.ts";

/** The recorded identity of the GEPA policy. */
const GEPA_POLICY_IDENTITY_V0 = {
	schemaVersion: "endo.selection-policy.v0",
	name: "gepa",
	revision: "v0",
} as const;

/** The two-objective evidence of one complete candidate, in deterministic (id) order. */
interface CompleteEvidenceV0 {
	candidateId: string;
	evolveMean: number;
	validationMean: number;
	evolveResultIds: string[];
	validationResultIds: string[];
}

/**
 * Whether `a` dominates `b` on the two objectives: at least as good on both, strictly better on
 * at least one.
 */
function dominatesV0(a: CompleteEvidenceV0, b: CompleteEvidenceV0): boolean {
	return (
		a.evolveMean >= b.evolveMean &&
		a.validationMean >= b.validationMean &&
		(a.evolveMean > b.evolveMean || a.validationMean > b.validationMean)
	);
}

/**
 * The GEPA policy: the two-objective optimum over the complete candidates, decided on the
 * validation objective within the Pareto front with an explicit deterministic tie-break.
 */
export const ENDO_GEPA_POLICY_V0: EndoEvolutionPolicyV0 = {
	policy: { ...GEPA_POLICY_IDENTITY_V0 },
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

		const complete: CompleteEvidenceV0[] = [];
		for (const entry of evidence) {
			const evolveMean = meanV0(entry.evolveScores);
			const validationMean = meanV0(entry.validationScores);
			if (evolveMean !== null && validationMean !== null) {
				complete.push({
					candidateId: entry.candidateId,
					evolveMean,
					validationMean,
					evolveResultIds: entry.evolveResultIds,
					validationResultIds: entry.validationResultIds,
				});
			}
		}

		const front = complete.filter(
			(candidate) =>
				!complete.some((other) => other.candidateId !== candidate.candidateId && dominatesV0(other, candidate)),
		);

		let winner: CompleteEvidenceV0 | null = null;
		let tiebreak: "none" | "id" = "none";
		if (front.length > 0) {
			let maxValidation = -Infinity;
			for (const candidate of front) {
				if (candidate.validationMean > maxValidation) maxValidation = candidate.validationMean;
			}
			const validationBest = front.filter((candidate) => candidate.validationMean === maxValidation);
			if (validationBest.length === 1) {
				winner = validationBest[0];
			} else {
				winner = validationBest.reduce((lowest, candidate) =>
					candidate.candidateId < lowest.candidateId ? candidate : lowest,
				);
				tiebreak = "id";
			}
		}

		const conditions: EndoSelectionConditionV0[] = [
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "evidence-present",
				observed: { candidatesScored: scored.length },
				met: scored.length > 0,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "objective-complete",
				observed: { complete: complete.length, candidates: complete.map((entry) => entry.candidateId) },
				met: complete.length > 0,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "pareto-front",
				observed: { front: front.map((entry) => entry.candidateId), size: front.length },
				met: front.length > 0,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "strictly-best-validation",
				parameters: { objective: "validation", tiebreak: "candidateId" },
				observed: {
					candidateId: winner?.candidateId ?? null,
					validation: winner?.validationMean ?? null,
					evolve: winner?.evolveMean ?? null,
					tiebreak,
				},
				met: winner !== null,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "validation-present",
				observed: {
					trials: winner === null ? 0 : (byId.get(winner.candidateId)?.validationScores.length ?? 0),
					mean: winner === null ? null : winner.validationMean,
				},
				met: winner !== null,
			},
		];

		const decision: EndoSelectionDecisionV0 = {
			schemaVersion: "endo.selection-decision.v0",
			id,
			experimentId: context.experiment.id,
			policy: { ...GEPA_POLICY_IDENTITY_V0 },
			outcome: "inconclusive",
			conditions,
			evidence: [],
		};
		if (winner !== null && conditions.every((condition) => condition.met)) {
			decision.outcome = "selected";
			decision.candidateId = winner.candidateId;
			decision.evidence = winner.evolveResultIds;
			decision.validationEvidence = winner.validationResultIds;
		} else {
			const firstUnmet = conditions.find((condition) => !condition.met);
			if (firstUnmet === undefined) {
				decision.reason = "selection did not converge";
			} else if (firstUnmet.name === "objective-complete") {
				decision.reason = "validation-objective-absent";
			} else {
				decision.reason = `${firstUnmet.name} not met`;
			}
		}

		const validated = validateEndoSelectionDecisionV0(decision);
		if (validated === null) throw new TypeError("GEPA selection decision failed validation");
		return validated;
	},
};
