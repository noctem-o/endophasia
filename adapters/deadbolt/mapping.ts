// Deadbolt-specific: the mapping from Deadbolt's documented lease and receipt fields
// (adapters/deadbolt/shapes.ts) into Endophasia's protocol-bound records (README "## Phase 8 —
// Trust integrations"). Every function is pure: it validates its inputs at the door (TypeError,
// never a repair), and it validates its output through the protocol — a mapping that cannot
// produce a valid record throws. Nothing here talks to a Deadbolt deployment; the shapes are
// mirrors of its documented records.
//
// The fixed correspondence:
//   lease route         → route (a well-formed dotted kind — the typed route)
//   lease capability    → capability (the narrow permission it describes)
//   lease binding       → boundTo (the exact record the lease authorizes; never a general credential)
//   lease signer        → signer (the identity holding the signing key; an identity, not a grant)
//   lease digest        → leaseDigest
//   receipt lease       → leaseId (the lease the receipt closes)
//   receipt outcome     → outcome (committed / rolled-back / refused)
//   receipt rollback    → rollbackOf (the receipt a rollback receipt supersedes; history is
//                         appended, never rewound)
//   receipt result      → result (strict JSON)
//
// Recording these records confers no authority: a lease is evidence of a signed capability, a
// receipt is evidence of an effect, and a valid receipt does not grant execution permission
// merely by existing.

import { isEndoIdentifierV0, isWellFormedKindV0 } from "../../protocol/identity.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import type { EndoLeaseRecordV0, EndoReceiptOutcomeV0, EndoReceiptRecordV0 } from "../../protocol/trust.ts";
import {
	ENDO_RECEIPT_OUTCOMES_V0,
	validateEndoLeaseRecordV0,
	validateEndoReceiptRecordV0,
} from "../../protocol/trust.ts";
import { assertPlainJsonValueV0 } from "../../runtime/contracts/canonical-json.ts";

const HEX64_V0 = /^[0-9a-f]{64}$/;

function digestV0(label: string, value: unknown): string {
	if (typeof value !== "string" || !HEX64_V0.test(value)) {
		throw new TypeError(`${label} must be 64 lowercase hex characters`);
	}
	return value;
}

function profileTextV0(label: string, value: unknown, maxLength: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
		throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`);
	}
	return value;
}

function routeV0(label: string, value: unknown): string {
	if (typeof value !== "string" || !isWellFormedKindV0(value)) {
		throw new TypeError(`${label} must be a well-formed dotted kind`);
	}
	return value;
}

/**
 * Map a Deadbolt signed lease to an Endophasia lease record. The door checks the route, the
 * capability and signer bounds, the binding's namespace, and the lease digest; the record exits
 * through `validateEndoLeaseRecordV0`.
 */
export function mapDeadboltLeaseV0(args: { input: unknown; id: unknown }): EndoLeaseRecordV0 {
	const { input, id } = args;
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("the lease record id must be an endo.evidence.* identifier");
	}
	if (typeof input !== "object" || input === null) {
		throw new TypeError("the Deadbolt lease input must be an object");
	}
	const v = input as Record<string, unknown>;
	const route = routeV0("the lease route", v.route);
	const capability = profileTextV0("the lease capability", v.capability, 256);
	if (typeof v.boundTo !== "string" || !isEndoIdentifierV0(v.boundTo, "evidence")) {
		throw new TypeError(
			"the lease binding must be an endo.evidence.* identifier — the exact record the lease authorizes",
		);
	}
	const signer = profileTextV0("the lease signer", v.signer, 256);
	const leaseDigest = digestV0("the lease digest", v.leaseDigest);
	const expiresAt = v.expiresAt === undefined ? undefined : profileTextV0("the lease expiry", v.expiresAt, 256);
	const provenance = v.provenance === undefined ? undefined : profileTextV0("the provenance note", v.provenance, 4096);

	const record: EndoLeaseRecordV0 = {
		schemaVersion: "endo.lease.v0",
		id,
		route,
		capability,
		boundTo: v.boundTo,
		signer,
		leaseDigest,
	};
	if (expiresAt !== undefined) record.expiresAt = expiresAt;
	if (provenance !== undefined) record.provenance = provenance;

	const out = validateEndoLeaseRecordV0(record);
	if (out === null) {
		throw new TypeError("the mapped lease record failed protocol validation");
	}
	return out;
}

/**
 * Map a Deadbolt receipt to an Endophasia receipt record. The door checks the lease's namespace,
 * the route, the closed outcome set, the rollback target's namespace, and the strict-JSON result;
 * the record exits through `validateEndoReceiptRecordV0`.
 */
export function mapDeadboltReceiptV0(args: { input: unknown; id: unknown }): EndoReceiptRecordV0 {
	const { input, id } = args;
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("the receipt record id must be an endo.evidence.* identifier");
	}
	if (typeof input !== "object" || input === null) {
		throw new TypeError("the Deadbolt receipt input must be an object");
	}
	const v = input as Record<string, unknown>;
	if (typeof v.leaseId !== "string" || !isEndoIdentifierV0(v.leaseId, "evidence")) {
		throw new TypeError("the receipt lease id must be an endo.evidence.* identifier");
	}
	const route = routeV0("the receipt route", v.route);
	if (!isReceiptOutcomeV0(v.outcome)) {
		throw new TypeError("the receipt outcome must be one of committed, rolled-back, refused");
	}
	const outcome: EndoReceiptOutcomeV0 = v.outcome;
	let rollbackOf: string | undefined;
	if (v.rollbackOf !== undefined) {
		if (typeof v.rollbackOf !== "string" || !isEndoIdentifierV0(v.rollbackOf, "evidence")) {
			throw new TypeError("the rollback target must be an endo.evidence.* identifier");
		}
		rollbackOf = v.rollbackOf;
	}
	let result: JsonValueV0 | undefined;
	if (v.result !== undefined) {
		assertPlainJsonValueV0(v.result);
		result = v.result;
	}
	const provenance = v.provenance === undefined ? undefined : profileTextV0("the provenance note", v.provenance, 4096);

	const record: EndoReceiptRecordV0 = {
		schemaVersion: "endo.receipt.v0",
		id,
		leaseId: v.leaseId,
		route,
		outcome,
	};
	if (rollbackOf !== undefined) record.rollbackOf = rollbackOf;
	if (result !== undefined) record.result = result;
	if (provenance !== undefined) record.provenance = provenance;

	const out = validateEndoReceiptRecordV0(record);
	if (out === null) {
		throw new TypeError("the mapped receipt record failed protocol validation");
	}
	return out;
}

function isReceiptOutcomeV0(value: unknown): value is EndoReceiptOutcomeV0 {
	return typeof value === "string" && (ENDO_RECEIPT_OUTCOMES_V0 as readonly string[]).includes(value);
}
