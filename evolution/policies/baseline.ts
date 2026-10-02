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
 * zero). A candidate's score is the mean of its scored evolve-set trials; its held-out evidence is
 * its scored held-out trials.
 *
 * The decision: select the unique strict best on the evolve set, and only when that candidate also
 * carries held-out evidence. Any other situation — no scored evidence at all, a tie for best, a best
 * without held-out — is "inconclusive", never a guess. The baseline records no "rejected" outcome:
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

/** The per-candidate evidence the decision is built from, in deterministic (id) order. */
interface CandidateEvidenceV0 {
	candidateId: string;
	evolveScores: number[];
	evolveResultIds: string[];
	heldOutScores: number[];
	heldOutResultIds: string[];
}

/** The score of one trial under the baseline convention, or null when the trial carries none. */
function trialScoreV0(trial: EndoTrialResultV0): number | null {
	const derived = trial.derived;
	if (derived === null || typeof derived !== "object" || Array.isArray(derived)) return null;
	if (!("score" in derived)) return null;
	const score = derived.score;
	if (typeof score !== "number" || !Number.isFinite(score)) return null;
	return score;
}

function meanV0(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	let sum = 0;
	for (const value of values) sum += value;
	return sum / values.length;
}

/**
 * Gather each candidate's scored evolve-set and held-out evidence from the context, in deterministic
 * order (candidates by id, results by id, trials in recorded order). A result counts toward a
 * candidate's evidence list exactly when at least one of that candidate's scored trials on the
 * partition came from it. Held-out trials may be recorded in either array, so both are scanned.
 */
function collectEvidenceV0(context: EndoEvolutionPolicyContextV0): CandidateEvidenceV0[] {
	const byId = new Map<string, CandidateEvidenceV0>();
	for (const candidate of [...context.candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
		byId.set(candidate.id, {
			candidateId: candidate.id,
			evolveScores: [],
			evolveResultIds: [],
			heldOutScores: [],
			heldOutResultIds: [],
		});
	}
	// A record present in both arrays is counted once (union by id).
	const seen = new Set<string>();
	for (const result of [...context.results, ...context.heldOut].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	)) {
		if (seen.has(result.id)) continue;
		seen.add(result.id);
		const candidateId = result.profile.candidateId;
		const evidence = candidateId === undefined ? undefined : byId.get(candidateId);
		if (evidence === undefined) continue;
		for (const trial of result.trials) {
			if (trial.partition === "evolve-set" || trial.partition === "held-out") {
				const score = trialScoreV0(trial);
				if (score === null) continue;
				const scores = trial.partition === "evolve-set" ? evidence.evolveScores : evidence.heldOutScores;
				const resultIds = trial.partition === "evolve-set" ? evidence.evolveResultIds : evidence.heldOutResultIds;
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
 * best), and `held-out-present` (the best candidate carries scored held-out evidence). The outcome
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
		for (const member of ["candidates", "mutations", "results", "heldOut", "history"] as const) {
			if (!Array.isArray(context[member])) {
				throw new TypeError(`policy context ${member} must be an array`);
			}
		}

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
		const heldOutMean = bestEntry === undefined ? null : meanV0(bestEntry.heldOutScores);

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
				name: "held-out-present",
				observed: { trials: bestEntry?.heldOutScores.length ?? 0, mean: heldOutMean },
				met: strictlyBest !== null && (bestEntry?.heldOutScores.length ?? 0) > 0,
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
			decision.heldOutEvidence = bestEntry.heldOutResultIds;
		} else {
			const firstUnmet = conditions.find((condition) => !condition.met);
			decision.reason = firstUnmet === undefined ? "selection did not converge" : `${firstUnmet.name} not met`;
		}
		return decision;
	},
};
