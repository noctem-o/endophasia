/**
 * Phase 6 — the per-experiment evidence ledger (README "## Phase 6 — Evolution substrate":
 * "append-only ledger per experiment of what was produced").
 *
 * The ledger is the experiment's referential-integrity point. Each entry records the position, the
 * kind, and the id of one produced record; the kind is derived from the record's schemaVersion via
 * a closed map, never from a caller-supplied field. Append enforces two rules the protocol
 * validators cannot see:
 * - no record appears twice;
 * - a record's references must already be entries of this ledger (a candidate's mutations, a
 *   selection's evidence, a promotion request's selection, a promotion decision's request and
 *   evidence, a mutation's artifact, a transition's evidence, a standing's evidence, a lease's
 *   bound record, a receipt's lease and rollback target). Append order is causal order: a
 *
 * `replayEndoEvidenceLedgerV0` re-validates a persisted ledger (shape, closed kinds, namespaces,
 * sequences exactly 1..n, duplicate record ids). Reference integrity is enforced at append time;
 * the ledger carries references, not records, so the replay re-verifies the structural invariants.
 */

import type {
	EndoConformanceSuiteV0,
	EndoEvaluationResultV0,
	EndoExperimentBundleV0,
	EndoReplayComparisonV0,
} from "../protocol/evaluation.ts";
import {
	validateEndoConformanceSuiteV0,
	validateEndoEvaluationResultV0,
	validateEndoExperimentBundleV0,
	validateEndoReplayComparisonV0,
} from "../protocol/evaluation.ts";
import type {
	EndoArtifactV0,
	EndoCandidateV0,
	EndoEvidenceKindV0,
	EndoEvidenceLedgerEntryV0,
	EndoEvidenceLedgerV0,
	EndoExperimentRecordV0,
	EndoExperimentTransitionV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import {
	validateEndoArtifactV0,
	validateEndoCandidateV0,
	validateEndoEvidenceLedgerV0,
	validateEndoExperimentRecordV0,
	validateEndoExperimentTransitionV0,
	validateEndoMutationV0,
	validateEndoPromotionDecisionV0,
	validateEndoPromotionRequestV0,
	validateEndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import type { EndoRuntimeAdmissionV0 } from "../protocol/runtime.ts";
import { validateEndoRuntimeAdmissionV0 } from "../protocol/runtime.ts";
import type {
	EndoLeaseRecordV0,
	EndoReceiptRecordV0,
	EndoStandingRecordV0,
	EndoWitnessRecordV0,
} from "../protocol/trust.ts";
import {
	validateEndoLeaseRecordV0,
	validateEndoReceiptRecordV0,
	validateEndoStandingRecordV0,
	validateEndoWitnessRecordV0,
} from "../protocol/trust.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

/** The closed set of record kinds the ledger can hold. */
type EndoLedgerRecordV0 =
	| EndoEvaluationResultV0
	| EndoConformanceSuiteV0
	| EndoExperimentBundleV0
	| EndoReplayComparisonV0
	| EndoMutationV0
	| EndoArtifactV0
	| EndoCandidateV0
	| EndoSelectionDecisionV0
	| EndoPromotionRequestV0
	| EndoPromotionDecisionV0
	| EndoExperimentTransitionV0
	| EndoWitnessRecordV0
	| EndoStandingRecordV0
	| EndoLeaseRecordV0
	| EndoReceiptRecordV0
	| EndoRuntimeAdmissionV0;

/** The closed map from a record's schemaVersion to its ledger kind. */
const ENDO_EVIDENCE_KIND_BY_SCHEMA_VERSION_V0: Readonly<Record<string, EndoEvidenceKindV0>> = {
	"endo.evaluation-result.v0": "evaluation-result",
	"endo.conformance-suite.v0": "conformance-suite",
	"endo.experiment-bundle.v0": "experiment-bundle",
	"endo.replay-comparison.v0": "replay-comparison",
	"endo.mutation.v0": "mutation",
	"endo.artifact.v0": "artifact",
	"endo.candidate.v0": "candidate",
	"endo.selection-decision.v0": "selection-decision",
	"endo.promotion-request.v0": "promotion-request",
	"endo.promotion-decision.v0": "promotion-decision",
	"endo.experiment-transition.v0": "experiment-transition",
	"endo.witness.v0": "witness",
	"endo.standing.v0": "standing",
	"endo.lease.v0": "lease",
	"endo.receipt.v0": "receipt",
	"endo.runtime-admission.v0": "runtime-admission",
};

/** The validator of each closed evidence record kind. */
const ENDO_EVIDENCE_VALIDATORS_V0: Readonly<Record<EndoEvidenceKindV0, (value: unknown) => EndoLedgerRecordV0 | null>> =
	{
		"evaluation-result": validateEndoEvaluationResultV0,
		"conformance-suite": validateEndoConformanceSuiteV0,
		"experiment-bundle": validateEndoExperimentBundleV0,
		"replay-comparison": validateEndoReplayComparisonV0,
		mutation: validateEndoMutationV0,
		artifact: validateEndoArtifactV0,
		candidate: validateEndoCandidateV0,
		"selection-decision": validateEndoSelectionDecisionV0,
		"promotion-request": validateEndoPromotionRequestV0,
		"promotion-decision": validateEndoPromotionDecisionV0,
		"experiment-transition": validateEndoExperimentTransitionV0,
		witness: validateEndoWitnessRecordV0,
		standing: validateEndoStandingRecordV0,
		lease: validateEndoLeaseRecordV0,
		receipt: validateEndoReceiptRecordV0,
		"runtime-admission": validateEndoRuntimeAdmissionV0,
	};

/** The ledger references a record must already have been appended with, by its schemaVersion. */
function referencesV0(record: EndoLedgerRecordV0): string[] {
	switch (record.schemaVersion) {
		case "endo.candidate.v0":
			return record.mutations;
		case "endo.selection-decision.v0":
			return [...record.evidence, ...(record.heldOutEvidence ?? [])];
		case "endo.promotion-request.v0":
			return [record.selectionId];
		case "endo.promotion-decision.v0":
			return [record.requestId, ...record.evidence];
		case "endo.mutation.v0":
			return record.artifactId !== undefined ? [record.artifactId] : [];
		case "endo.experiment-transition.v0":
			return record.evidence ?? [];
		case "endo.witness.v0":
			return [];
		case "endo.standing.v0":
			return record.evidence;
		case "endo.lease.v0":
			return [record.boundTo];
		case "endo.receipt.v0":
			return [record.leaseId, ...(record.rollbackOf ?? [])];
		case "endo.runtime-admission.v0":
			return record.evidence;
		default:
			return [];
	}
}

/**
 * The ledger identity of a record: its own id when it carries one. Conformance suites and replay
 * comparisons carry no id of their own; for those the ledger assigns a content address — the same
 * record always has the same identity, so a duplicate is still a duplicate.
 */
function ledgerIdentityV0(record: EndoLedgerRecordV0): string {
	switch (record.schemaVersion) {
		case "endo.conformance-suite.v0":
			return `endo.evidence.conformance-suite.${sha256HexV0(canonicalEndoJsonV0(record))}`;
		case "endo.replay-comparison.v0":
			return `endo.evidence.replay-comparison.${sha256HexV0(canonicalEndoJsonV0(record))}`;
		default:
			return record.id;
	}
}

/**
 * The append-only evidence ledger of one experiment.
 */
export interface EndoEvidenceLedgerServiceV0 {
	/** The experiment record the ledger belongs to. */
	readonly record: EndoExperimentRecordV0;
	/** The number of appended entries. */
	readonly length: number;
	/** Materialise the persisted ledger (entries copied, append order). */
	ledger(): EndoEvidenceLedgerV0;
	/**
	 * Append one produced record. The entry kind is derived from the record's schemaVersion
	 * (unknown or missing schemaVersions are rejected). A record's identity is its own id, except
	 * for conformance suites and replay comparisons, which carry no id: for those the ledger
	 * assigns a content address over the record's canonical form. A duplicate identity is
	 * rejected, and the record's references must already be entries of this ledger. Returns the
	 * appended entry. Throws TypeError when the record is not one of the closed evidence record
	 * kinds, fails its validator, duplicates an identity, or references a record that is not in
	 * the ledger.
	 */
	append(record: unknown): EndoEvidenceLedgerEntryV0;
}

/**
 * Create the evidence ledger of an experiment. The ledger id must be an endo.evidence.* identifier
 * and the record a valid endo.experiment.v0.
 */
export function createEndoEvidenceLedgerV0(id: unknown, record: unknown): EndoEvidenceLedgerServiceV0 {
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("ledger id must be an endo.evidence.* identifier");
	}
	const validatedRecord = validateEndoExperimentRecordV0(record);
	if (validatedRecord === null) throw new TypeError("not a valid endo.experiment.v0 record");
	const entries: EndoEvidenceLedgerEntryV0[] = [];
	const ids = new Set<string>();
	const ledger: EndoEvidenceLedgerServiceV0 = {
		record: validatedRecord,
		get length() {
			return entries.length;
		},
		ledger(): EndoEvidenceLedgerV0 {
			return {
				schemaVersion: "endo.evidence-ledger.v0",
				id,
				experimentId: validatedRecord.id,
				entries: [...entries],
			};
		},
		append(record: unknown): EndoEvidenceLedgerEntryV0 {
			if (typeof record !== "object" || record === null) throw new TypeError("ledger records must be objects");
			const kind =
				"schemaVersion" in record && typeof record.schemaVersion === "string"
					? ENDO_EVIDENCE_KIND_BY_SCHEMA_VERSION_V0[record.schemaVersion]
					: undefined;
			if (kind === undefined) {
				throw new TypeError("ledger records must be one of the closed evidence record kinds");
			}
			const validated = ENDO_EVIDENCE_VALIDATORS_V0[kind](record);
			if (validated === null) {
				const schemaVersion =
					"schemaVersion" in record && typeof record.schemaVersion === "string" ? record.schemaVersion : "unknown";
				throw new TypeError(`not a valid ${schemaVersion} record`);
			}
			const recordId = ledgerIdentityV0(validated);
			if (ids.has(recordId)) throw new TypeError(`record ${recordId} is already in the ledger`);
			for (const reference of referencesV0(validated)) {
				if (!ids.has(reference)) {
					throw new TypeError(`record ${recordId} references ${reference}, which is not in the ledger`);
				}
			}
			const entry: EndoEvidenceLedgerEntryV0 = {
				schemaVersion: "endo.evidence-ledger-entry.v0",
				sequence: entries.length + 1,
				kind,
				recordId,
			};
			ids.add(recordId);
			entries.push(entry);
			return entry;
		},
	};
	return ledger;
}

/**
 * Replay a persisted ledger. Re-validates the shape, the closed kinds, the namespaces, the
 * sequences (exactly 1..n in order), and duplicate record ids. Throws TypeError when the value is
 * not a valid endo.evidence-ledger.v0 ledger — a tampered sequence or a duplicated record is not a
 * ledger.
 */
export function replayEndoEvidenceLedgerV0(value: unknown): EndoEvidenceLedgerV0 {
	const validated = validateEndoEvidenceLedgerV0(value);
	if (validated === null) throw new TypeError("not a valid endo.evidence-ledger.v0 ledger");
	return validated;
}
