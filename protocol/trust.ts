/**
 * Phase 8 — trust integrations (README "## Phase 8 — Trust integrations"): the protocol-bound
 * shapes that tie the evolution spine to the three trust providers.
 *
 * - `endo.witness.v0` (Cogitator): binds a recorded run to a witness root. A witness root is an
 *   integrity anchor, not proof of occurrence: the verification state records which level of
 *   checking was performed, and only an externally confirmed root (matched against an out-of-band
 *   copy) resists wholesale bundle substitution.
 *
 * - `endo.standing.v0` (Magpie): the governed standing of a claim under an explicitly selected
 *   standing policy (v0–v4, never defaulted). A standing is a conclusion about named evidence
 *   under a named policy, not a conclusion about truth: the standing a policy may produce is
 *   capped (the ceiling), and a failed check is a failure, never a refutation.
 *
 * - `endo.lease.v0` and `endo.receipt.v0` (Deadbolt): the authority loop a "granted" promotion
 *   decision does not itself close. A lease is checked against the exact record it binds to —
 *   never a general credential that happens to be nearby; a receipt records what happened to the
 *   leased operation.
 *
 * A record here is a record, not an effect: recording a witness, standing, lease, or receipt
 * confers no authority, grants no permission, and triggers no deployment.
 */

import type { EndoIdentifierKindV0 } from "./identity.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import type { JsonValueV0 } from "./primitives.ts";

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

/** A recorded identity or name: a non-empty string within the given length bound. Opaque by design. */
function isProfileTextV0(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** A recorded statement (provenance note): a non-empty string within the bound. */
function isStatementV0(value: unknown, maxLength: number): value is string {
	return isProfileTextV0(value, maxLength);
}

const SHA256_HEX_V0 = /^[0-9a-f]{64}$/;

/** A recorded digest: exactly 64 lowercase hex characters. */
function isSha256HexV0(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_V0.test(value);
}

function isPlainRecordV0(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

function isStrictJsonValue(value: unknown): value is JsonValueV0 {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isStrictJsonValue);
	if (typeof value === "object" && isPlainRecordV0(value)) {
		return Object.entries(value).every(([, entry]) => isStrictJsonValue(entry));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Witness records (Cogitator)
// ---------------------------------------------------------------------------

/** The witness algorithms the v0 witness record accepts. */
export type EndoWitnessAlgorithmV0 = "blake3";

/** The closed witness algorithms. */
export const ENDO_WITNESS_ALGORITHMS_V0 = ["blake3"] as const satisfies readonly EndoWitnessAlgorithmV0[];

/**
 * The witness verification states, in ascending checking strength. "not-verified": no checking
 * beyond recording the bundle's root. "recomputed-matched": the root recomputed from the bundle's
 * hash chain equals the recorded root. "recomputed-mismatched": a recomputed or externally
 * supplied root did not match — tamper evidence, recorded, never repaired. "externally-confirmed":
 * the recomputed root equals an out-of-band copy — the only state that resists wholesale bundle
 * replacement.
 */
export type EndoWitnessVerificationV0 =
	| "not-verified"
	| "recomputed-matched"
	| "recomputed-mismatched"
	| "externally-confirmed";

/** The closed witness verification states. */
export const ENDO_WITNESS_VERIFICATIONS_V0 = [
	"not-verified",
	"recomputed-matched",
	"recomputed-mismatched",
	"externally-confirmed",
] as const satisfies readonly EndoWitnessVerificationV0[];

/**
 * A Cogitator witness record: one recorded run bound to one witness root (the last digest of the
 * run's domain-separated BLAKE3 hash chain over the witnessed metadata, trace entries, executed
 * tool-call witness views, phantom entries, and the committed policy digest when present).
 *
 * The witness root does not prove the run happened: occurrence requires the out-of-band expected
 * root, and the record says which checking was performed in `verification`.
 */
export interface EndoWitnessRecordV0 {
	schemaVersion: "endo.witness.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The recorded run the bundle witnessed. endo.run.* identifier. */
	runId: string;
	/** The witness root recorded by the bundle: 64 lowercase hex. */
	witnessRoot: string;
	/** The algorithm that produced the root. */
	witnessAlgorithm: EndoWitnessAlgorithmV0;
	/** The SHA-256 of the policy file committed to the chain (64 lowercase hex); absent when the bundle committed no policy file. */
	policyDigest?: string;
	/** Which level of checking was performed. */
	verification: EndoWitnessVerificationV0;
	/** An out-of-band copy of the root (64 lowercase hex). Required when the verification is "externally-confirmed"; present otherwise only with "recomputed-mismatched". */
	expectedRoot?: string;
	/** The provenance of the record. */
	provenance?: string;
}

const ENDO_WITNESS_RECORD_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"runId",
	"witnessRoot",
	"witnessAlgorithm",
	"policyDigest",
	"verification",
	"expectedRoot",
	"provenance",
]);

/**
 * Validates a witness record. Rejects unknown fields, identifiers in the wrong namespaces, digests
 * that are not 64 lowercase hex, an algorithm or verification outside the closed sets, an
 * "externally-confirmed" verification without a valid expected root, and an expected root on a
 * state that does not compare one. Returns the validated value unchanged, or null.
 */
export function validateEndoWitnessRecordV0(value: unknown): EndoWitnessRecordV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_WITNESS_RECORD_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.witness.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.runId, "run")) return null;
	if (!isSha256HexV0(v.witnessRoot)) return null;
	if (!(ENDO_WITNESS_ALGORITHMS_V0 as readonly string[]).includes(v.witnessAlgorithm as string)) return null;
	if (v.policyDigest !== undefined && !isSha256HexV0(v.policyDigest)) return null;
	if (!(ENDO_WITNESS_VERIFICATIONS_V0 as readonly string[]).includes(v.verification as string)) return null;
	if (v.expectedRoot !== undefined && !isSha256HexV0(v.expectedRoot)) return null;
	if (v.verification === "externally-confirmed" && !isSha256HexV0(v.expectedRoot)) return null;
	if (
		v.expectedRoot !== undefined &&
		v.verification !== "externally-confirmed" &&
		v.verification !== "recomputed-mismatched"
	) {
		return null;
	}
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	return value as EndoWitnessRecordV0;
}

// ---------------------------------------------------------------------------
// Standing records (Magpie)
// ---------------------------------------------------------------------------

/** The standing policies the v0 standing record accepts: the caller selects, never a default. */
export type EndoStandingPolicyV0 = "v0" | "v1" | "v2" | "v3" | "v4";

/** The closed standing policies. */
export const ENDO_STANDING_POLICIES_V0 = [
	"v0",
	"v1",
	"v2",
	"v3",
	"v4",
] as const satisfies readonly EndoStandingPolicyV0[];

/**
 * The governed standings. "unassessed": the policy produced no standing conclusion (v0 explains
 * without promoting). "supported": the selected rule supports the claim under its exact
 * proposition — support is never settlement. "settled": the exact occurrence/inclusion
 * proposition the policy is named for. "refuted": the subject-bound direct refutation the policy
 * owns; a failed check is never a refutation.
 */
export type EndoStandingV0 = "unassessed" | "supported" | "settled" | "refuted";

/** The closed governed standings. */
export const ENDO_STANDINGS_V0 = [
	"unassessed",
	"supported",
	"settled",
	"refuted",
] as const satisfies readonly EndoStandingV0[];

/**
 * The standing ceiling: the strongest standing each policy may produce (and every weaker one). v0
 * explains without promoting; v1 settles the exact same-replay occurrence/inclusion proposition;
 * v2 and v3 support, never settle; v4 owns subject-bound direct refutation and preserves an
 * inherited supported or settled status with an explicit contradiction blocker.
 */
export const ENDO_STANDING_CEILING_V0: Readonly<Record<EndoStandingPolicyV0, readonly EndoStandingV0[]>> = {
	v0: ["unassessed"],
	v1: ["unassessed", "supported", "settled"],
	v2: ["unassessed", "supported"],
	v3: ["unassessed", "supported"],
	v4: ["unassessed", "supported", "settled", "refuted"],
};

/**
 * A Magpie standing record: the governed standing of one named claim under one explicitly
 * selected standing policy, grounded on named evidence. The record names what produced it —
 * the claim, the policy, the evidence — so an equal-looking conclusion under another policy is a
 * different record.
 */
export interface EndoStandingRecordV0 {
	schemaVersion: "endo.standing.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The identity of the claim in the standing history: a non-empty string of at most 256 characters. */
	claimId: string;
	/** The explicitly selected standing policy (never defaulted). */
	policy: EndoStandingPolicyV0;
	/** The governed standing the policy produced for the claim. */
	standing: EndoStandingV0;
	/** The endo.evidence.* records the standing grounds; may be empty (an explanation without promotion). */
	evidence: string[];
	/** The qualifications and blockers a consumer must read alongside the standing; each a non-empty string of at most 256 characters. */
	qualifications: string[];
	/** The provenance of the record. */
	provenance?: string;
}

const ENDO_STANDING_RECORD_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"claimId",
	"policy",
	"standing",
	"evidence",
	"qualifications",
	"provenance",
]);

/**
 * Validates a standing record. Rejects unknown fields, an identifier in the wrong namespace, an
 * over-long claim identity, a policy or standing outside the closed sets, a standing above the
 * selected policy's ceiling, non-evidence entries in evidence, and over-long qualifications.
 * Returns the validated value unchanged, or null.
 */
export function validateEndoStandingRecordV0(value: unknown): EndoStandingRecordV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_STANDING_RECORD_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.standing.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isProfileTextV0(v.claimId, 256)) return null;
	if (!(ENDO_STANDING_POLICIES_V0 as readonly string[]).includes(v.policy as string)) return null;
	if (!(ENDO_STANDINGS_V0 as readonly string[]).includes(v.standing as string)) return null;
	const ceiling = ENDO_STANDING_CEILING_V0[v.policy as EndoStandingPolicyV0];
	if (!ceiling.includes(v.standing as EndoStandingV0)) return null;
	if (!Array.isArray(v.evidence) || !v.evidence.every((entry) => isEndoIdentifier(entry, "evidence"))) return null;
	if (!Array.isArray(v.qualifications) || !v.qualifications.every((entry) => isProfileTextV0(entry, 256))) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	return value as EndoStandingRecordV0;
}

// ---------------------------------------------------------------------------
// Lease and receipt records (Deadbolt)
// ---------------------------------------------------------------------------

/**
 * A Deadbolt lease record: a signed capability lease for one typed route, checked against the
 * exact record it binds to. A lease is never a general credential: `boundTo` names the record the
 * lease authorizes (in this protocol, the promotion decision whose grant it effects), and a lease
 * whose binding does not match the request that will use it is refused, not repaired.
 */
export interface EndoLeaseRecordV0 {
	schemaVersion: "endo.lease.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The typed route the lease covers: a well-formed dotted kind. */
	route: string;
	/** The narrow permission the lease describes (it describes the operation, never "anything else"). */
	capability: string;
	/** The exact record the lease is checked against: endo.evidence.* identifier. */
	boundTo: string;
	/** The identity of the authority that holds the signing key (an identity, not a grant). */
	signer: string;
	/** The digest of the signed lease: 64 lowercase hex. */
	leaseDigest: string;
	/** The provider's expiry representation, when one is recorded. */
	expiresAt?: string;
	/** The provenance of the record. */
	provenance?: string;
}

const ENDO_LEASE_RECORD_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"route",
	"capability",
	"boundTo",
	"signer",
	"leaseDigest",
	"expiresAt",
	"provenance",
]);

/**
 * Validates a lease record. Rejects unknown fields, identifiers in the wrong namespaces, a route
 * outside the dotted-kind grammar, an over-long capability, signer, or expiry, a lease digest
 * that is not 64 lowercase hex, and an over-long provenance. Returns the validated value unchanged,
 * or null.
 */
export function validateEndoLeaseRecordV0(value: unknown): EndoLeaseRecordV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_LEASE_RECORD_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.lease.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (typeof v.route !== "string" || !isWellFormedKindV0(v.route)) return null;
	if (!isProfileTextV0(v.capability, 256)) return null;
	if (!isEndoIdentifier(v.boundTo, "evidence")) return null;
	if (!isProfileTextV0(v.signer, 256)) return null;
	if (!isSha256HexV0(v.leaseDigest)) return null;
	if (v.expiresAt !== undefined && !isProfileTextV0(v.expiresAt, 256)) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	return value as EndoLeaseRecordV0;
}

/** The receipt outcomes the v0 receipt record accepts. */
export type EndoReceiptOutcomeV0 = "committed" | "rolled-back" | "refused";

/** The closed receipt outcomes. */
export const ENDO_RECEIPT_OUTCOMES_V0 = [
	"committed",
	"rolled-back",
	"refused",
] as const satisfies readonly EndoReceiptOutcomeV0[];

/**
 * A Deadbolt receipt record: what happened to the operation a lease authorized. A receipt is
 * evidence, not authority: a valid receipt does not grant execution permission merely by
 * existing, and it cannot prove consent or facts outside the system. A rollback is a later
 * receipt (naming the receipt it supersedes), never a repair of the earlier one — history is
 * appended, never rewound.
 */
export interface EndoReceiptRecordV0 {
	schemaVersion: "endo.receipt.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The lease the receipt closes. endo.evidence.* identifier. */
	leaseId: string;
	/** The typed route the receipt records: a well-formed dotted kind. */
	route: string;
	/** What happened to the leased operation. */
	outcome: EndoReceiptOutcomeV0;
	/** The receipt a rollback receipt supersedes; absent for an original receipt. endo.evidence.* identifier. */
	rollbackOf?: string;
	/** The recorded result, strict JSON; absent when nothing is recorded. */
	result?: JsonValueV0;
	/** The provenance of the record. */
	provenance?: string;
}

const ENDO_RECEIPT_RECORD_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"leaseId",
	"route",
	"outcome",
	"rollbackOf",
	"result",
	"provenance",
]);

/**
 * Validates a receipt record. Rejects unknown fields, identifiers in the wrong namespaces, a route
 * outside the dotted-kind grammar, an outcome outside the closed three-way, a result that is not
 * strict JSON, and an over-long provenance. Returns the validated value unchanged, or null.
 */
export function validateEndoReceiptRecordV0(value: unknown): EndoReceiptRecordV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_RECEIPT_RECORD_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.receipt.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.leaseId, "evidence")) return null;
	if (typeof v.route !== "string" || !isWellFormedKindV0(v.route)) return null;
	if (!(ENDO_RECEIPT_OUTCOMES_V0 as readonly string[]).includes(v.outcome as string)) return null;
	if (v.rollbackOf !== undefined && !isEndoIdentifier(v.rollbackOf, "evidence")) return null;
	if (v.result !== undefined && !isStrictJsonValue(v.result)) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	return value as EndoReceiptRecordV0;
}

// ---------------------------------------------------------------------------
// Derived views (reports)
// ---------------------------------------------------------------------------

/** One trial of a witness coverage report. */
export interface EndoWitnessCoverageTrialV0 {
	schemaVersion: "endo.witness-coverage-trial.v0";
	/** The 0-based trial index within the result. */
	trial: number;
	/** The recorded run that produced the trial outcome; null when the trial records no run. */
	runId: string | null;
	/** The witness that covers the trial's run; null when no witness covers it — an honest absence. */
	witnessId: string | null;
}

/**
 * A witness coverage report: which of a result's trials a set of witness records covers. A derived
 * view over named records — it explains the record, it grants nothing.
 */
export interface EndoWitnessCoverageV0 {
	schemaVersion: "endo.witness-coverage.v0";
	/** The experiment the covered result belongs to. endo.experiment.* identifier. */
	experimentId: string;
	/** The trials in the result's order. */
	trials: EndoWitnessCoverageTrialV0[];
}

const ENDO_WITNESS_COVERAGE_TRIAL_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "trial", "runId", "witnessId"]);

/**
 * Validates one witness coverage trial entry. Rejects unknown fields, a trial index below zero or
 * non-integer, a run id outside the run namespace, and a witness id outside the evidence namespace.
 * Nulls are valid: an honest absence, not a repair. Returns the validated value unchanged, or null.
 */
export function validateEndoWitnessCoverageTrialV0(value: unknown): EndoWitnessCoverageTrialV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_WITNESS_COVERAGE_TRIAL_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.witness-coverage-trial.v0") return null;
	if (typeof v.trial !== "number" || !Number.isInteger(v.trial) || v.trial < 0) return null;
	if (v.runId !== null && !isEndoIdentifier(v.runId, "run")) return null;
	if (v.witnessId !== null && !isEndoIdentifier(v.witnessId, "evidence")) return null;
	return value as EndoWitnessCoverageTrialV0;
}

const ENDO_WITNESS_COVERAGE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "experimentId", "trials"]);

/**
 * Validates a witness coverage report. Rejects unknown fields, an experiment id in the wrong
 * namespace, and a trial entry that is not a valid entry. Returns the validated value unchanged, or
 * null.
 */
export function validateEndoWitnessCoverageV0(value: unknown): EndoWitnessCoverageV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_WITNESS_COVERAGE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.witness-coverage.v0") return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (!Array.isArray(v.trials) || !v.trials.every((entry) => validateEndoWitnessCoverageTrialV0(entry) !== null)) {
		return null;
	}
	return value as EndoWitnessCoverageV0;
}

/** The promotion-closure condition the decision's outcome must be "granted". */
export const ENDO_CLOSURE_DECISION_GRANTED_V0 = "decision-granted";
/** The promotion-closure condition the decision must match the request it answers. */
export const ENDO_CLOSURE_DECISION_MATCHES_REQUEST_V0 = "decision-matches-request";
/** The promotion-closure condition the lease must bind the exact decision it effects. */
export const ENDO_CLOSURE_LEASE_BINDS_DECISION_V0 = "lease-binds-decision";
/** The promotion-closure condition the receipt must close the lease it records. */
export const ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0 = "receipt-closes-lease";
/** The promotion-closure condition the receipt's route must match the lease's route. */
export const ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0 = "receipt-route-matches";

/** The closed promotion-closure conditions, in the fixed order the check reports them. */
export const ENDO_PROMOTION_CLOSURE_CONDITIONS_V0 = [
	ENDO_CLOSURE_DECISION_GRANTED_V0,
	ENDO_CLOSURE_DECISION_MATCHES_REQUEST_V0,
	ENDO_CLOSURE_LEASE_BINDS_DECISION_V0,
	ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0,
	ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0,
] as const;

/**
 * A promotion closure report: whether the authority loop a "granted" promotion decision leaves
 * open is closed by a lease and a receipt. A derived view — it names the unmet conditions, it
 * confers no authority. A rolled-back or refused receipt still closes the loop: the loop closes
 * with the recorded outcome, and what the outcome means is the receipt's to say.
 */
export interface EndoPromotionClosureV0 {
	schemaVersion: "endo.promotion-closure.v0";
	/** The promotion decision the closure checks. endo.evidence.* identifier. */
	decisionId: string;
	/** True when every binding condition holds. */
	closed: boolean;
	/** The named conditions that do not hold, in the fixed check order; empty when closed. */
	unmet: string[];
	/** The receipt's recorded outcome. */
	outcome: EndoReceiptOutcomeV0;
}

const ENDO_PROMOTION_CLOSURE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "decisionId", "closed", "unmet", "outcome"]);

/**
 * Validates a promotion closure report. Rejects unknown fields, a decision id in the wrong
 * namespace, a closed flag inconsistent with the unmet list, an unmet entry that is not a
 * non-empty string of at most 256 characters, and an outcome outside the closed three-way.
 * Returns the validated value unchanged, or null.
 */
export function validateEndoPromotionClosureV0(value: unknown): EndoPromotionClosureV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROMOTION_CLOSURE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.promotion-closure.v0") return null;
	if (!isEndoIdentifier(v.decisionId, "evidence")) return null;
	if (typeof v.closed !== "boolean") return null;
	if (!Array.isArray(v.unmet) || !v.unmet.every((entry) => isProfileTextV0(entry, 256))) return null;
	if (v.closed !== (v.unmet.length === 0)) return null;
	if (!(ENDO_RECEIPT_OUTCOMES_V0 as readonly string[]).includes(v.outcome as string)) return null;
	return value as EndoPromotionClosureV0;
}
