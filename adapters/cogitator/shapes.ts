/**
 * Phase 8 — mirrors of Cogitator's documented witness bundle fields (README "## Phase 8 — Trust
 * integrations").
 *
 * Cogitator seals a run's semantics with a witness root: the last digest of a domain-separated
 * BLAKE3 hash chain over the witnessed metadata, agent trace entries, executed tool-call witness
 * views, phantom entries, and the policy digest (the SHA-256 of the policy file) when a policy
 * file was committed. Timestamps and hostnames are provenance — they are excluded from the
 * commitment, so a replayed run keeps the same root. These shapes name the fields a bundle
 * presents; the mapping (mapping.ts) is the only bridge into Endophasia's protocol-bound record.
 * Nothing here talks to a Cogitator deployment.
 */

/**
 * The fields of a Cogitator witness bundle, as presented for mapping. `recomputedRoot` is the
 * root the caller recomputed from the bundle's hash chain (verification level 2); `expectedRoot`
 * is an out-of-band copy of the root (verification level 3 — the only level that detects
 * wholesale bundle replacement). Absent fields are honest absences: a bundle is not recomputed,
 * and a root is not confirmed, until the caller supplies the comparison.
 */
export interface CogitatorWitnessInputV0 {
	/** The run the bundle witnessed. endo.run.* identifier. */
	runId: string;
	/** The witness root recorded by the bundle: 64 lowercase hex. */
	witnessRoot: string;
	/** The algorithm that produced the root; defaults to "blake3" when the bundle records none. */
	witnessAlgorithm?: string;
	/** The SHA-256 of the policy file committed to the chain (64 lowercase hex); absent when the bundle committed no policy file. */
	policyDigest?: string;
	/** The root recomputed from the bundle's hash chain (64 lowercase hex); absent when not recomputed. */
	recomputedRoot?: string;
	/** An out-of-band copy of the root (64 lowercase hex); absent when none was supplied. */
	expectedRoot?: string;
	/** The provenance note for the record, when one is recorded. */
	provenance?: string;
}
