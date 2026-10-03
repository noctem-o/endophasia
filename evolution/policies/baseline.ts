/**
 * Phase 7 — the algorithm-neutral baseline policy (README "## Phase 7 — RRSI + REEF providers").
 *
 * The baseline exists so the policy seam is testable end to end without any provider: it is the
 * smallest deterministic policy whose decisions the substrate can record. It is not RRSI and not
 * GEPA — no annealed edit budget, no noise-band calibration, no critic screen, no tried-set
 * bookkeeping: those mechanisms belong to the provider behind the seam (evolution/policies/ports.ts),
 * never to the substrate.
 *
 * Scoring convention: a trial's score is the `score` member of its derived metrics when that member
 * is a finite number; a trial with none contributes nothing (an honest absence, never a fabricated
 * zero). A candidate's score is the mean of its scored evolve-set trials; its validation evidence is
 * its scored validation trials. The convention's helpers (trialScoreV0, meanV0, collectEvidenceV0)
 * are exported and shared by the RRSI-inspired and GEPA policy modules.
 *
 * The decision: select the unique strict best on the evolve set, and only when that candidate also
 * carries validation evidence. Any other situation — no scored evidence at all, a tie for best, a best
 * without validation — is "inconclusive", never a guess. The baseline records no "rejected" outcome:
 * it has no explicit rejection criteria; a policy that has them (e.g. a leakage screen) records
 * "rejected" under its own identity.
 */

import type { EndoTrialResultV0 } from "../../protocol/evaluation.ts";
import type { EndoSelectionConditionV0, EndoSelectionDecisionV0 } from "../../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import type { EndoEvolutionPolicyContextV0, EndoEvolutionPolicyV0 } from "./ports.ts";

/** The recorded identity of the baseline policy. */
const BASELINE_POLICY_IDENTITY_V0 = {
	schemaVersion: "endo.selection-policy.v0",
	name: "highest-score",
	revision: "v1",
} as const;

/** The per-candidate evidence a decision is built from, in deterministic (id) order. Shared by the
 * RRSI-inspired and GEPA policy modules. */
export interface CandidateEvidenceV0 {
	candidateId: string;
	evolveScores: number[];
	evolveResultIds: string[];
	validationScores: number[];
	validationResultIds: string[];
}

/** The score of one trial under the scoring convention, or null when the trial carries none. */
export function trialScoreV0(trial: EndoTrialResultV0): number | null {
	const derived = trial.derived;
	if (derived === null || typeof derived !== "object" || Array.isArray(derived)) return null;
	if (!("score" in derived)) return null;
	const score = derived.score;
	if (typeof score !== "number" || !Number.isFinite(score)) return null;
	return score;
}

export function meanV0(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	let sum = 0;
	for (const value of values) sum += value;
	return sum / values.length;
}

/**
 * Refuse a context that carries promotion-holdout evidence. A selection policy may read evolve-set and
 * validation trials; the promotion holdout must stay untouched by selection, so finding any of it in a
 * context is a caller error, not something to filter out quietly.
 */
export function assertNoPromotionHoldoutV0(context: EndoEvolutionPolicyContextV0): void {
	for (const result of [...context.results, ...context.validation]) {
		if (result.trials.some((trial) => trial.partition === "promotion-holdout")) {
			throw new TypeError(
				`policy context carries promotion-holdout evidence (${result.id}); selection must never read the promotion holdout`,
			);
		}
	}
}

/**
 * Gather each candidate's scored evolve-set and validation evidence from the context, in deterministic
 * order (candidates by id, results by id, trials in recorded order). A result counts toward a
 * candidate's evidence list exactly when at least one of that candidate's scored trials on the
 * partition came from it. Validation trials may be recorded in either array, so both are scanned.
 */
export function collectEvidenceV0(context: EndoEvolutionPolicyContextV0): CandidateEvidenceV0[] {
	const byId = new Map<string, CandidateEvidenceV0>();
	for (const candidate of [...context.candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		byId.set(candidate.id, {
			candidateId: candidate.id,
			evolveScores: [],
			evolveResultIds: [],
			validationScores: [],
			validationResultIds: [],
		});
	}
	// A record present in both arrays is counted once (union by id).
	const seen = new Set<string>();
	for (const result of [...context.results, ...context.validation].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	)) {
		if (seen.has(result.id)) continue;
		seen.add(result.id);
		const candidateId = result.profile.candidateId;
		const evidence = candidateId === undefined ? undefined : byId.get(candidateId);
		if (evidence === undefined) continue;
		for (const trial of result.trials) {
			if (trial.partition === "evolve-set" || trial.partition === "validation") {
				const score = trialScoreV0(trial);
				if (score === null) continue;
				const scores = trial.partition === "evolve-set" ? evidence.evolveScores : evidence.validationScores;
				const resultIds =
					trial.partition === "evolve-set" ? evidence.evolveResultIds : evidence.validationResultIds;
				scores.push(score);
				if (!resultIds.includes(result.id)) resultIds.push(result.id);
			}
		}
	}
	return [...byId.values()];
}

/**
 * The baseline policy: the smallest deterministic selection policy the seam can execute.
 *
 * Conditions, in policy order: `evidence-present` (at least one candidate carries scored evolve-set
 * evidence), `strictly-best` (exactly one candidate is the best on the evolve set — a tie is not a
 * best), and `validation-present` (the best candidate carries scored validation evidence). The outcome
 * is "selected" only when all three are met; otherwise "inconclusive", with the first unmet
 * condition named.
 */
export const ENDO_HIGHEST_SCORE_POLICY_V0: EndoEvolutionPolicyV0 = {
	policy: { ...BASELINE_POLICY_IDENTITY_V0 },
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

		const bestEntry =
			strictlyBest === null ? undefined : evidence.find((entry) => entry.candidateId === strictlyBest.id);
		const validationMean = bestEntry === undefined ? null : meanV0(bestEntry.validationScores);

		const conditions: EndoSelectionConditionV0[] = [
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "evidence-present",
				observed: { candidatesScored: scored.length },
				met: scored.length > 0,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "strictly-best",
				parameters: { partition: "evolve-set" },
				observed: { candidateId: strictlyBest?.id ?? null, mean: strictlyBest?.mean ?? null },
				met: strictlyBest !== null,
			},
			{
				schemaVersion: "endo.selection-condition.v0",
				name: "validation-present",
				observed: { trials: bestEntry?.validationScores.length ?? 0, mean: validationMean },
				met: strictlyBest !== null && (bestEntry?.validationScores.length ?? 0) > 0,
			},
		];

		const decision: EndoSelectionDecisionV0 = {
			schemaVersion: "endo.selection-decision.v0",
			id,
			experimentId: context.experiment.id,
			policy: { ...BASELINE_POLICY_IDENTITY_V0 },
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
		return decision;
	},
};
