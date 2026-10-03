/**
 * Phase 9 — runtime expansion (README "## Phase 9 — Runtime expansion"): the protocol-bound
 * shape that records where a runtime subject stands on the admission line, and why.
 *
 * Runtime admission is evidence-based (README: "Runtime admission remains evidence-based"). The
 * planned order is runtime-specific transport first, conformance evidence second, capability
 * admission last (README "### Codex"). The known positions (README "### Develop", "### Prime",
 * "### Codex"):
 * - Pi is the reference runtime today — the baseline, named in the record, not closed off.
 * - Prime's runtime-admission line is dormant after the sealed 0.9.7 study, which admitted no
 *   exact capability; the recorded blockers (durable operation/outcome identity, complete
 *   lifecycle semantics, committed Usage allocation/paging, matching continuity/context
 *   semantics) are written down, and a version bump alone is insufficient.
 * - Codex remains a candidate until its own pinned conformance study exists.
 *
 * "Additional runtimes" stay open: the subject is a well-formed dotted kind, not a closed list,
 * so a new runtime is a new record, never a protocol change.
 *
 * A record here is a record, not an effect: recording an admission confers no capability,
 * installs no runtime, and triggers no transport. Transport ingress does not imply an admitted
 * runtime.
 */

import type { EndoIdentifierKindV0 } from "./identity.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

/** A recorded identity or name: a non-empty string within the given length bound. Opaque by design. */
function isProfileTextV0(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** A recorded statement (blocker or provenance note): a non-empty string within the bound. */
function isStatementV0(value: unknown, maxLength: number): value is string {
	return isProfileTextV0(value, maxLength);
}

/**
 * The positions a runtime subject can hold on the admission line. "candidate": under study, the
 * pre-study or study-in-progress state. "dormant": the admission line is paused on recorded
 * blockers, backed by a sealed study. "reference": the baseline runtime (Pi). "admitted":
 * admitted on conformance evidence; the check service then requires an EXACT study.
 */
export type EndoRuntimeAdmissionStatusV0 = "candidate" | "dormant" | "reference" | "admitted";

/** The closed admission statuses. */
export const ENDO_RUNTIME_ADMISSION_STATUSES_V0 = [
	"candidate",
	"dormant",
	"reference",
	"admitted",
] as const satisfies readonly EndoRuntimeAdmissionStatusV0[];

/**
 * A runtime admission record: where one subject stands on the admission line, named by evidence.
 * The evidence cites conformance-suite ledger identities (content-addressed `endo.evidence.*`
 * identifiers); the check service (`runtime/admission.ts`) decides whether the position holds
 * against the presented suites.
 */
export interface EndoRuntimeAdmissionV0 {
	schemaVersion: "endo.runtime-admission.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The runtime subject under study: a well-formed dotted kind, open but well-formed. */
	subject: string;
	/** The subject's pinned version or revision. */
	version: string;
	/** The position on the admission line. */
	status: EndoRuntimeAdmissionStatusV0;
	/** The conformance evidence the record stands on: endo.evidence.* identifiers. */
	evidence: string[];
	/** The recorded blockers, in words. A dormant line pauses on these; a reference line has none. */
	blockers: string[];
	/** A recorded note on how the position was reached, in words. */
	provenance?: string;
}

const ENDO_RUNTIME_ADMISSION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"subject",
	"version",
	"status",
	"evidence",
	"blockers",
	"provenance",
]);

/**
 * Validates a runtime admission record. Rejects unknown fields, identifiers in the wrong
 * namespaces, a subject outside the dotted-kind grammar, an over-long version, evidence that is
 * not an endo.evidence.* identifier, over-long blockers, and over-long provenance. The per-status
 * doors: "reference" names the subject "pi" and carries no blockers; "dormant" and "admitted"
 * each require non-empty evidence (a paused or an admitted line stands on a sealed study);
 * "dormant" additionally requires non-empty blockers (dormancy is a pause with a reason);
 * "candidate" requires nothing (the pre-study state). Returns the validated value unchanged, or
 * null.
 */
export function validateEndoRuntimeAdmissionV0(value: unknown): EndoRuntimeAdmissionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_RUNTIME_ADMISSION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.runtime-admission.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (typeof v.subject !== "string" || !isWellFormedKindV0(v.subject)) return null;
	if (!isProfileTextV0(v.version, 256)) return null;
	if (!(ENDO_RUNTIME_ADMISSION_STATUSES_V0 as readonly string[]).includes(v.status as string)) return null;
	if (!Array.isArray(v.evidence) || !v.evidence.every((entry) => isEndoIdentifier(entry, "evidence"))) return null;
	if (!Array.isArray(v.blockers) || !v.blockers.every((entry) => isStatementV0(entry, 512))) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	if (v.status === "reference") {
		if (v.subject !== "pi" || v.blockers.length !== 0) return null;
	}
	if (v.status === "dormant" && (v.evidence.length === 0 || v.blockers.length === 0)) return null;
	if (v.status === "admitted" && v.evidence.length === 0) return null;
	return value as EndoRuntimeAdmissionV0;
}

/**
 * The evidence-based check of one runtime admission record against the conformance suites
 * presented to it. A derived report, serialized for persistence and replay; not itself a ledger
 * record. The doors the check service enforces, in words:
 * - every presented suite names the record's exact subject and version;
 * - "admitted" requires at least one EXACT-classified study across the presented suites — a
 *   sealed study that admits no exact capability (Prime 0.9.7) cannot admit.
 */
export interface EndoRuntimeAdmissionCheckV0 {
	schemaVersion: "endo.runtime-admission-check.v0";
	/** The admission record checked: endo.evidence.* identifier. */
	admissionId: string;
	/** The record's subject. */
	subject: string;
	/** The record's pinned version. */
	version: string;
	/** The record's position on the admission line. */
	status: EndoRuntimeAdmissionStatusV0;
	/** The number of conformance suites presented to the check. */
	suitesChecked: number;
	/** The number of EXACT-classified studies across the presented suites. */
	exactStudies: number;
	/** The evidence-based violations, in words. */
	violations: string[];
	/** Whether the position holds against the presented evidence. */
	holds: boolean;
}

const ENDO_RUNTIME_ADMISSION_CHECK_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"admissionId",
	"subject",
	"version",
	"status",
	"suitesChecked",
	"exactStudies",
	"violations",
	"holds",
]);

/** A recorded non-negative integer: a finite, integral, non-negative number. */
function isNonNegativeIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Validates a runtime admission check report. Rejects unknown fields, an admission id outside the
 * endo.evidence.* namespace, a subject outside the dotted-kind grammar, an over-long version, a
 * status outside the closed set, non-integral counts, over-long violations, and a report whose
 * `holds` flag disagrees with its violations (holds is true exactly when there are no
 * violations). Returns the validated value unchanged, or null.
 */
export function validateEndoRuntimeAdmissionCheckV0(value: unknown): EndoRuntimeAdmissionCheckV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_RUNTIME_ADMISSION_CHECK_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.runtime-admission-check.v0") return null;
	if (!isEndoIdentifier(v.admissionId, "evidence")) return null;
	if (typeof v.subject !== "string" || !isWellFormedKindV0(v.subject)) return null;
	if (!isProfileTextV0(v.version, 256)) return null;
	if (!(ENDO_RUNTIME_ADMISSION_STATUSES_V0 as readonly string[]).includes(v.status as string)) return null;
	if (!isNonNegativeIntV0(v.suitesChecked)) return null;
	if (!isNonNegativeIntV0(v.exactStudies)) return null;
	if (!Array.isArray(v.violations) || !v.violations.every((entry) => isStatementV0(entry, 4096))) return null;
	if (typeof v.holds !== "boolean") return null;
	if (v.holds !== (v.violations.length === 0)) return null;
	return value as EndoRuntimeAdmissionCheckV0;
}
