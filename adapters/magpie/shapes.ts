/**
 * Phase 8 — mirrors of Magpie's documented standing output (README "## Phase 8 — Trust
 * integrations").
 *
 * Magpie is the replayable memory kernel: an Ed25519-signed append-only hash chain, canonical
 * event bytes, and governed standing over that history. Its seven questions — observation,
 * availability, verification, provenance, origin admission, eligibility, governed standing — all
 * land as one standing record here: the governed standing of one named claim under one
 * explicitly selected standing policy (v0–v4, never defaulted), grounded on named evidence.
 * "Conserve the log. Derive the rest." The standing is a conclusion about named evidence under a
 * named policy — not a conclusion about truth — and a failed check is a failure, never a
 * refutation. Nothing here talks to a Magpie kernel; the shapes are mirrors of its documented
 * standing output.
 */

/**
 * The standing of a claim as Magpie reports it, presented for mapping. The caller presents what
 * the kernel produced under the selected policy; the mapping (mapping.ts) checks that the
 * standing is within the selected policy's ceiling before it may become a record.
 */
export interface MagpieStandingInputV0 {
	/** The identity of the claim in the standing history: a non-empty string of at most 256 characters. */
	claimId: string;
	/** The explicitly selected standing policy: one of v0–v4 (never defaulted). */
	policy: string;
	/** The governed standing the policy produced for the claim. */
	standing: string;
	/** The named evidence the standing grounds; may be empty (an explanation without promotion). */
	evidence: string[];
	/** The qualifications and blockers a consumer must read alongside the standing; each a non-empty string of at most 256 characters. */
	qualifications?: string[];
	/** The provenance note for the record, when one is recorded. */
	provenance?: string;
}
