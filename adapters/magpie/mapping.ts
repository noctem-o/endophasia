// Magpie-specific: the mapping from Magpie's documented standing output (adapters/magpie/shapes.ts)
// into Endophasia's protocol-bound standing record (README "## Phase 8 — Trust integrations").
// Every function is pure: it validates its inputs at the door (TypeError, never a repair), and it
// validates its output through the protocol — a mapping that cannot produce a valid record throws.
// Nothing here talks to a Magpie kernel; the shapes are mirrors of its documented standing output.
//
// The fixed correspondence (Magpie standing field → endo.standing.v0 field):
//   claim identity    → claimId
//   standing policy   → policy (the caller selected it; there is no default)
//   standing          → standing (checked against the policy's ceiling)
//   named evidence    → evidence
//   qualifications    → qualifications
//
// The ceiling check is the door's job, not the kernel's: v0 explains without promoting, v1
// settles only the exact same-replay occurrence/inclusion proposition, v2 and v3 support and
// never settle, and v4 owns subject-bound direct refutation (a failed check is a failure, never
// a refutation). A standing above the selected policy's ceiling is refused, not repaired.

import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import type { EndoStandingPolicyV0, EndoStandingRecordV0, EndoStandingV0 } from "../../protocol/trust.ts";
import {
	ENDO_STANDING_CEILING_V0,
	ENDO_STANDING_POLICIES_V0,
	ENDO_STANDINGS_V0,
	validateEndoStandingRecordV0,
} from "../../protocol/trust.ts";

function isStandingPolicyV0(value: unknown): value is EndoStandingPolicyV0 {
	return typeof value === "string" && (ENDO_STANDING_POLICIES_V0 as readonly string[]).includes(value);
}

function isStandingV0(value: unknown): value is EndoStandingV0 {
	return typeof value === "string" && (ENDO_STANDINGS_V0 as readonly string[]).includes(value);
}

function profileTextV0(label: string, value: unknown, maxLength: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
		throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`);
	}
	return value;
}

function profileStringsV0(label: string, value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 256)
	) {
		throw new TypeError(`${label} must be an array of non-empty strings of at most 256 characters`);
	}
	return value as string[];
}

/**
 * Map a Magpie standing to an Endophasia standing record. The door checks the claim identity, the
 * closed policy and standing sets, the policy's ceiling over the standing, and the evidence
 * namespaces; the record exits through `validateEndoStandingRecordV0`.
 */
export function mapMagpieStandingV0(args: { input: unknown; id: unknown }): EndoStandingRecordV0 {
	const { input, id } = args;
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("the standing record id must be an endo.evidence.* identifier");
	}
	if (typeof input !== "object" || input === null) {
		throw new TypeError("the Magpie standing input must be an object");
	}
	const v = input as Record<string, unknown>;
	const claimId = profileTextV0("the claim identity", v.claimId, 256);
	if (!isStandingPolicyV0(v.policy)) {
		throw new TypeError(
			"the standing policy must be one of v0, v1, v2, v3, v4 — the caller selects, never a default",
		);
	}
	if (!isStandingV0(v.standing)) {
		throw new TypeError("the standing must be one of unassessed, supported, settled, refuted");
	}
	const ceiling = ENDO_STANDING_CEILING_V0[v.policy];
	if (!ceiling.includes(v.standing)) {
		throw new TypeError(`the standing (${v.standing}) is outside the ceiling of standing policy ${v.policy}`);
	}
	if (
		!Array.isArray(v.evidence) ||
		!v.evidence.every((entry) => typeof entry === "string" && isEndoIdentifierV0(entry, "evidence"))
	) {
		throw new TypeError("the standing evidence must be an array of endo.evidence.* identifiers");
	}
	const evidence = v.evidence as string[];
	const qualifications =
		v.qualifications === undefined ? [] : profileStringsV0("the qualifications", v.qualifications);
	const provenance = v.provenance === undefined ? undefined : profileTextV0("the provenance note", v.provenance, 4096);

	const record: EndoStandingRecordV0 = {
		schemaVersion: "endo.standing.v0",
		id,
		claimId,
		policy: v.policy,
		standing: v.standing,
		evidence,
		qualifications,
	};
	if (provenance !== undefined) record.provenance = provenance;

	const out = validateEndoStandingRecordV0(record);
	if (out === null) {
		throw new TypeError("the mapped standing record failed protocol validation");
	}
	return out;
}
