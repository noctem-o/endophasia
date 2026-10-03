// Evolution policy boundary v0 (README "## Phase 7 — RRSI + REEF providers"): the narrow capability
// through which an evolution policy provider — RRSI, GEPA, or any other harness-evolution method — reads
// an Endophasia experiment and records a selection decision. The capability is defined in Endophasia's
// own v0 semantics, never a provider's native vocabulary: the context is exactly the records the
// substrate keeps (the experiment record, the candidate and mutation histories, the evaluation evidence,
// the ledger's causal chain), and the output is exactly the selection decision the substrate records
// (EndoSelectionDecisionV0, named by the policy's EndoSelectionPolicyV0 identity). A provider implements
// only the capability it can provide truthfully; "a similar loop" is not a policy. The protocol never
// executes a policy; it records which one decided, so different methods (RRSI versus GEPA versus a
// custom rule set) compare under the same experiment and evidence semantics.

import type { EndoEvaluationResultV0 } from "../../protocol/evaluation.ts";
import type {
	EndoCandidateV0,
	EndoEvidenceLedgerEntryV0,
	EndoExperimentRecordV0,
	EndoMutationV0,
	EndoSelectionDecisionV0,
	EndoSelectionPolicyV0,
} from "../../protocol/evolution.ts";

/**
 * Everything a policy may read when it decides: the experiment's declared inputs, the candidate and
 * mutation histories, the candidate evaluation evidence, the validation evaluations, and the ledger's
 * causal chain — the full evidence a policy's credit assignment is allowed to see. Promotion-holdout
 * evidence is never part of a policy context: it exists to check a promotion against data the search
 * never saw, and the in-tree policies refuse a context that carries any (assertNoPromotionHoldoutV0). A method that
 * needs more than this (live traffic, an LLM judge, a served state) does not fit the seam as a
 * selection policy: that extra machinery stays provider-side, behind the boundary.
 */
export interface EndoEvolutionPolicyContextV0 {
	/** The experiment record the decision belongs to. */
	readonly experiment: EndoExperimentRecordV0;
	/** The candidate history, in registry order. */
	readonly candidates: readonly EndoCandidateV0[];
	/** The mutation history, in registry order. */
	readonly mutations: readonly EndoMutationV0[];
	/** The candidate evaluation evidence (all recorded partitions). */
	readonly results: readonly EndoEvaluationResultV0[];
	/** The validation evaluations, when the experiment declared some. */
	readonly validation: readonly EndoEvaluationResultV0[];
	/** The ledger entries in append order: the causal chain. */
	readonly history: readonly EndoEvidenceLedgerEntryV0[];
}

/**
 * One evolution policy: its recorded identity (the name and revision the substrate stamps on every
 * decision the policy produces) and the decision capability itself.
 */
export interface EndoEvolutionPolicyV0 {
	/** The policy identity recorded on every decision this policy produces. */
	readonly policy: EndoSelectionPolicyV0;
	/**
	 * The policy applied to the context: pure and deterministic over it — the same context yields the
	 * same decision (up to the supplied id), and the policy reads nothing beyond the context. The
	 * caller supplies the decision's endo.evidence.* id: the substrate owns identity, the policy owns
	 * the decision. The returned record is valid by validateEndoSelectionDecisionV0.
	 */
	readonly decide: (context: EndoEvolutionPolicyContextV0, id: string) => EndoSelectionDecisionV0;
}
