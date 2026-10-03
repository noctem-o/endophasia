/**
 * Phase 8 — mirrors of Deadbolt's documented lease and receipt fields (README "## Phase 8 — Trust
 * integrations").
 *
 * Deadbolt is the permission engine: "The model may suggest. Authority stays outside the model."
 * Its pipeline runs untrusted proposal → typed route → policy plus an exact signed lease plus
 * explicit confirmation → bounded adapter → receipt, rollback, and verification. A lease is a
 * signed capability lease checked against the exact request that will use it — never a general
 * credential; a receipt is the evidence of what happened to the leased operation, and a valid
 * receipt does not grant execution permission merely by existing. These shapes name the fields a
 * lease or receipt presents; the mapping (mapping.ts) is the only bridge into Endophasia's
 * protocol-bound records. Nothing here talks to a Deadbolt deployment.
 */

/** The fields of a Deadbolt signed lease, as presented for mapping. */
export interface DeadboltLeaseInputV0 {
	/** The typed route the lease covers: a well-formed dotted kind. */
	route: string;
	/** The narrow permission the lease describes (it describes the operation, never "anything else"). */
	capability: string;
	/** The exact record the lease is checked against (in this protocol, the promotion decision whose grant it effects). endo.evidence.* identifier. */
	boundTo: string;
	/** The identity of the authority that holds the signing key (an identity, not a grant). */
	signer: string;
	/** The digest of the signed lease: 64 lowercase hex. */
	leaseDigest: string;
	/** The provider's expiry representation, when one is recorded. */
	expiresAt?: string;
	/** The provenance note for the record, when one is recorded. */
	provenance?: string;
}

/** The fields of a Deadbolt receipt, as presented for mapping. */
export interface DeadboltReceiptInputV0 {
	/** The lease the receipt closes. endo.evidence.* identifier. */
	leaseId: string;
	/** The typed route the receipt records: a well-formed dotted kind. */
	route: string;
	/** What happened to the leased operation. */
	outcome: string;
	/** The receipt a rollback receipt supersedes; absent for an original receipt. endo.evidence.* identifier. */
	rollbackOf?: string;
	/** The recorded result, strict JSON; absent when nothing is recorded. */
	result?: unknown;
	/** The provenance note for the record, when one is recorded. */
	provenance?: string;
}
