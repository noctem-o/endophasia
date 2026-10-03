// Cogitator-specific: the mapping from Cogitator's recorded shapes (adapters/cogitator/shapes.ts)
// into Endophasia's protocol-bound witness record (README "## Phase 8 — Trust integrations").
// Every function is pure: it validates its inputs at the door (TypeError, never a repair), and it
// validates its output through the protocol — a mapping that cannot produce a valid record throws.
// Nothing here talks to a Cogitator deployment; the shapes are mirrors of Cogitator's documented
// bundle fields.
//
// The fixed correspondence (Cogitator bundle field → endo.witness.v0 field):
//   run id            → runId
//   witness root      → witnessRoot
//   algorithm         → witnessAlgorithm (default "blake3" when the bundle records none)
//   policy digest     → policyDigest (absent when the bundle committed no policy file)
//   recomputed root   → the verification state (recomputed-matched / recomputed-mismatched)
//   expected root     → the verification state (externally-confirmed / recomputed-mismatched)
//                       and the record's expectedRoot, kept honestly when present
//
// The verification state is derived, not supplied: a root the caller did not recompute is
// "not-verified"; a recomputed root that does not equal the recorded root is tamper evidence
// ("recomputed-mismatched"); a recomputed root that matches an out-of-band copy is the only state
// that resists wholesale bundle replacement ("externally-confirmed"). The witness root does not
// prove the run happened: occurrence needs the out-of-band copy, and the record says so.

import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import type { EndoWitnessRecordV0, EndoWitnessVerificationV0 } from "../../protocol/trust.ts";
import { validateEndoWitnessRecordV0 } from "../../protocol/trust.ts";

const HEX64_V0 = /^[0-9a-f]{64}$/;

/** A recorded digest: 64 lowercase hex. */
function digestV0(label: string, value: string): void {
	if (!HEX64_V0.test(value)) {
		throw new TypeError(`${label} must be 64 lowercase hex characters`);
	}
}

/**
 * Map a Cogitator witness bundle to an Endophasia witness record. The verification state is
 * derived from the recomputed and expected roots (see the header); the record exits through
 * `validateEndoWitnessRecordV0`.
 */
export function mapCogitatorWitnessV0(args: { input: unknown; id: unknown }): EndoWitnessRecordV0 {
	const { input, id } = args;
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("the witness record id must be an endo.evidence.* identifier");
	}
	if (typeof input !== "object" || input === null) {
		throw new TypeError("the Cogitator witness input must be an object");
	}
	const v = input as Record<string, unknown>;
	if (typeof v.runId !== "string" || !isEndoIdentifierV0(v.runId, "run")) {
		throw new TypeError("the witness bundle run id must be an endo.run.* identifier");
	}
	if (typeof v.witnessRoot !== "string") {
		throw new TypeError("the witness bundle must record a witness root");
	}
	const witnessRoot = v.witnessRoot;
	digestV0("the witness root", v.witnessRoot);
	if (v.witnessAlgorithm !== undefined && v.witnessAlgorithm !== "blake3") {
		throw new TypeError("the witness algorithm must be blake3");
	}
	const policyDigest = v.policyDigest === undefined ? undefined : digestV0OrThrow("the policy digest", v.policyDigest);
	const recomputedRoot =
		v.recomputedRoot === undefined ? undefined : digestV0OrThrow("the recomputed root", v.recomputedRoot);
	const expectedRoot = v.expectedRoot === undefined ? undefined : digestV0OrThrow("the expected root", v.expectedRoot);
	const provenance = v.provenance === undefined ? undefined : profileTextV0("the provenance note", v.provenance, 4096);

	const verification = verificationV0(witnessRoot, recomputedRoot, expectedRoot);
	const record: EndoWitnessRecordV0 = {
		schemaVersion: "endo.witness.v0",
		id,
		runId: v.runId,
		witnessRoot,
		witnessAlgorithm: "blake3",
		verification,
	};
	if (policyDigest !== undefined) record.policyDigest = policyDigest;
	if (expectedRoot !== undefined) record.expectedRoot = expectedRoot;
	if (provenance !== undefined) record.provenance = provenance;

	const out = validateEndoWitnessRecordV0(record);
	if (out === null) {
		throw new TypeError("the mapped witness record failed protocol validation");
	}
	return out;
}

/** Derive the verification state: see the header correspondence table. */
function verificationV0(
	witnessRoot: string,
	recomputedRoot: string | undefined,
	expectedRoot: string | undefined,
): EndoWitnessVerificationV0 {
	if (recomputedRoot === undefined) return "not-verified";
	if (recomputedRoot !== witnessRoot) return "recomputed-mismatched";
	if (expectedRoot === undefined) return "recomputed-matched";
	return expectedRoot === recomputedRoot ? "externally-confirmed" : "recomputed-mismatched";
}

function digestV0OrThrow(label: string, value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError(`${label} must be a string when present`);
	}
	digestV0(label, value);
	return value;
}

function profileTextV0(label: string, value: unknown, maxLength: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
		throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`);
	}
	return value;
}
