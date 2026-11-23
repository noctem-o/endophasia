// DEVELOP-EVIDENCE-BRIDGE-001 (docs/designs/develop-evidence-bridge.md): the smallest trustworthy read-only connection between
// DEVELOP's governed coding attempts, observed working-tree provenance, reconstructable candidate artifacts, independent verification
// evidence (ordinary receipts vs protected-experiment evaluation), and operator review.
//
// Pure protocol types, closed vocabularies and fixed disclaimers only — zero Node imports, zero filesystem I/O, zero authority.
//
// Trust boundary:
// - Workstation protected verifier H0 remains BLOCKED.
// - The guest experiment (PRs #160–162) demonstrated a guest boundary, not a production trust boundary on the operator's host.
// - Protected-experiment results are ALWAYS labelled experimental, non-authoritative — never an authoritative protected PASS.
// - No missing relationship is ever fabricated from timestamps, prompt text, filenames or agent self-reports.

import type {
	EndoAttemptBindingBoundByV0,
	EndoProtectedAttemptAssociationV0,
	EndoProtectedAttemptCheckV0,
} from "./develop-attempt-candidate-binding.ts";
import type { EndoAttemptRunStateV0, EndoAttemptSendStateV0 } from "./develop-attempt-execution.ts";
import type { EndoDevelopTaskWordV0 } from "./develop-attempts.ts";
import type {
	EndoAttemptProvenanceViewV0,
	EndoObservationTriggerV0,
	EndoProvenanceBasisV0,
	EndoProvenanceNoteV0,
	EndoStateComparisonV0,
} from "./develop-provenance.ts";
import type { EndoReceiptOutcomeV0, EndoReceiptRelationV0 } from "./develop-receipts.ts";
import type { EndoDevelopStatusChangeV0, EndoDevelopTaskStatusV0 } from "./develop-tasks.ts";
import type { EndoAcceptanceLedgerV0 } from "./develop-verification.ts";

export const ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V0 = "endo.develop-evidence-bridge.v0";
/**
 * v1 (DEVELOP-PROTECTED-ATTEMPT-001): the protected section reads the attempt's protected launch record and candidate binding
 * (protocol/develop-attempt-candidate-binding.ts) and carries the closed association state and its checks. v0 is no longer served.
 */
export const ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V1 = "endo.develop-evidence-bridge.v1";

/** Every transition traced from Task to Operator Decision, in fixed order. */
export const ENDO_EVIDENCE_BRIDGE_TRANSITION_IDS_V0 = [
	"task-to-attempt",
	"attempt-to-authorization",
	"authorization-to-dispatch",
	"dispatch-to-run",
	"run-to-working-tree-state",
	"attempt-to-reconstructable-candidate",
	"candidate-to-verification",
	"verification-to-operator-decision",
] as const;
export type EndoEvidenceBridgeTransitionIdV0 = (typeof ENDO_EVIDENCE_BRIDGE_TRANSITION_IDS_V0)[number];

export type EndoEvidenceBridgeTransitionStatusV0 =
	| "established"
	| "partial"
	| "unestablished"
	| "contradictory"
	| "damaged"
	| "unavailable";

export type EndoEvidenceBridgeBasisV0 =
	| "controller-observed"
	| "operator-declared"
	| "window-attributed"
	| "pi-reported"
	| "missing"
	| "contradictory"
	| "damaged"
	| "unavailable";

export interface EndoEvidenceBridgeTransitionV0 {
	id: EndoEvidenceBridgeTransitionIdV0;
	label: string;
	status: EndoEvidenceBridgeTransitionStatusV0;
	basis: EndoEvidenceBridgeBasisV0;
	evidence: string;
	/** Exact missing relation when existing records cannot safely establish this link; null otherwise. */
	missingRecord: string | null;
}

/** Closed finding codes reported in a fixed order. Each is a fact about the records, never a silent override. */
export const ENDO_EVIDENCE_BRIDGE_FINDING_CODES_V0 = [
	"authorization-record-damaged",
	"execution-record-contradiction",
	"brief-changed-since-authorization",
	"operator-statement-damaged",
	"protected-spec-pin-missing",
	"protected-spec-pin-mismatch",
	"protected-run-unreadable",
	"protected-record-refused",
	"protected-candidate-bytes-changed",
	"protected-agent-log-digest-mismatch",
	"protected-attempt-association-unestablished",
	"protected-attempt-binding-invalid",
	"protected-attempt-candidate-integrity-failure",
	"protected-attempt-execution-incomplete",
	"protected-attempt-association-operator-declared",
	"protected-attempt-association-established",
	"protected-execution-unconfirmed-or-interrupted",
	"protected-evaluation-failed",
	"protected-evaluation-incomplete",
	"not-authorized",
	"execution-evidence-incomplete",
	"send-not-confirmed",
	"run-interrupted-or-unconfirmed",
	"run-not-completed",
	"task-words-changed",
	"provenance-unreadable",
	"provenance-missing",
	"provenance-other-send-observations",
	"provenance-run-end-not-observed",
	"provenance-overlaps",
	"provenance-comparison-incomplete",
	"checked-commit-differs-from-observed-run-end",
	"working-tree-changed-since-observation",
	"receipts-unreadable",
	"receipt-files-unusable",
	"no-check",
	"no-check-after-authorization",
	"current-tree-unavailable",
	"current-tree-changed",
	"no-check-at-current-head",
	"check-not-passed-at-current-head",
	"stale-check",
	"checked-in-another-tree",
	"planned-check-not-passed-at-current-head",
	"agent-report-unsupported-by-independent-evidence",
	"task-unavailable",
	"task-done-with-unverified-gaps",
	"not-accepted",
] as const;
export type EndoEvidenceBridgeFindingCodeV0 = (typeof ENDO_EVIDENCE_BRIDGE_FINDING_CODES_V0)[number];

export type EndoEvidenceBridgeFindingSeverityV0 =
	| "contradiction"
	| "integrity"
	| "stale"
	| "unestablished"
	| "gap"
	| "info";

export interface EndoEvidenceBridgeFindingV0 {
	code: EndoEvidenceBridgeFindingCodeV0;
	severity: EndoEvidenceBridgeFindingSeverityV0;
	text: string;
}

/**
 * Advisory review suggestions separated strictly from verified observations and operator authority.
 * None of these grants permission, mutates task status, or claims an authoritative protected PASS.
 */
export const ENDO_EVIDENCE_BRIDGE_SUGGESTIONS_V0 = [
	"ready-for-operator-review",
	"recheck-required-stale-evidence",
	"do-not-accept-verification-failed",
	"unverified-agent-report-only",
	"blocked-contradictory-or-tampered",
	"incomplete-evidence",
] as const;
export type EndoEvidenceBridgeSuggestionV0 = (typeof ENDO_EVIDENCE_BRIDGE_SUGGESTIONS_V0)[number];

export const ENDO_EVIDENCE_BRIDGE_SUGGESTION_LABELS_V0: Readonly<Record<EndoEvidenceBridgeSuggestionV0, string>> =
	Object.freeze({
		"ready-for-operator-review":
			"Advisory suggestion: ready for operator review (ordinary DEVELOP records are aligned at HEAD; acceptance stays yours)",
		"recheck-required-stale-evidence":
			"Advisory suggestion: recheck required before review (existing verification receipts are stale or the working tree changed)",
		"do-not-accept-verification-failed": "Advisory suggestion: do not accept (independent verification failed)",
		"unverified-agent-report-only":
			"Advisory suggestion: do not treat agent report as verification (no passing independent verification at HEAD)",
		"blocked-contradictory-or-tampered":
			"Advisory suggestion: blocked for review (contradictory, damaged, tampered or pin-mismatched evidence)",
		"incomplete-evidence":
			"Advisory suggestion: incomplete evidence (execution unconfirmed, records unavailable, inconclusive verification, or unassociated candidate)",
	});

/** Fixed trust-boundary statement included in every bridge reading. */
export const ENDO_EVIDENCE_BRIDGE_TRUST_BOUNDARY_V0 = Object.freeze({
	workstationH0: "blocked" as const,
	hostSameUidProtection: "not-established" as const,
	developRecords: "unsigned-local-records" as const,
	protectedExperimentAuthority: "experimental-non-authoritative" as const,
	notes: Object.freeze([
		"Workstation protected verifier H0 remains BLOCKED; no reading here is an authoritative protected PASS.",
		"The guest verifier experiments (PRs #160–162) demonstrated a guest boundary, not a production trust boundary on the operator's host.",
		"DEVELOP records (tasks, attempts, authorisations, observations, receipts) are unsigned local files writable by any same-uid process.",
		"Protected-experiment results are arrangement-C research evidence under the operator's uid; tampering between steps is detected by re-hashing, not prevented against a same-uid host writer.",
	]),
});

/**
 * What a reading whose protected association is established or operator-declared still cannot establish. It replaces the first statement
 * of ENDO_EVIDENCE_BRIDGE_NOT_ESTABLISHED_V0, which would be false there; the rest stand.
 */
export const ENDO_EVIDENCE_BRIDGE_BOUND_NOT_ESTABLISHED_V0 = Object.freeze([
	"The attempt-to-candidate binding is unkeyed integrity evidence over unsigned same-uid files: not a signature, not proof of origin, and not host authority. It does not show that the protected evaluation is authoritative (it is experimental), that the candidate is correct, or that it was applied anywhere.",
]);

/** What this bridge reading can never establish from existing records alone. */
export const ENDO_EVIDENCE_BRIDGE_NOT_ESTABLISHED_V0 = Object.freeze([
	"No existing record links a DEVELOP attempt (endo.attempt.<id>) to a protected-experiment run or reconstructable staged change set; cross-space candidate association is never fabricated by timestamp, prompt text, filename or agent self-report.",
	"Who or what wrote any changed byte in the working tree: Pi, the operator, an editor, a hook, or another process.",
	"That Pi's reported run completion or tool output is truthful, or that a passing ordinary check satisfies acceptance criteria.",
	"Which commit or candidate bytes the operator inspected when moving a task's status (tasks.json records no revision or candidate digest).",
	"Protection against a same-uid host writer modifying unsigned local records or recomputing unkeyed seals.",
	"Workstation protected verifier H0 authority (remains BLOCKED).",
]);

export interface EndoBridgeOrdinaryCheckV0 {
	command: string;
	receiptId: string;
	commit: string;
	startedAtMs: number;
	outcome: EndoReceiptOutcomeV0;
	label: string;
	reasons: string[];
	relation: EndoReceiptRelationV0;
	relationLabel: string;
	authorization: "before" | "overlapping" | "after" | null;
	others: { passed: number; failed: number; inconclusive: number };
	plannedBehaviour: boolean;
}

export interface EndoBridgeProtectedExperimentV0 {
	supplied: boolean;
	authority: "experimental-non-authoritative";
	workstationH0: "blocked";
	/**
	 * `not-supplied` / `unestablished` exactly as before when the attempt has no protected launch record and no binding; otherwise the
	 * closed state the binding reading decided (protocol/develop-attempt-candidate-binding.ts). Never inferred from anything else.
	 */
	attemptAssociation: EndoProtectedAttemptAssociationV0;
	/** Named while no admitted binding exists (everything but `established` and `operator-declared`). */
	missingBindingRecord: "develop-attempt-protected-candidate-binding" | null;
	/** The attempt's protected launch record and binding, as read, and every exact check made against what was re-read now. */
	binding: {
		launch: "absent" | "present" | "unusable";
		record: "absent" | "present" | "unusable";
		boundBy: EndoAttemptBindingBoundByV0 | null;
		/** The standing of the association itself: who made it, never upgraded. */
		standing: "controller-established" | "operator-declared" | null;
		operationDigest: string | null;
		bindingSha256: string | null;
		/** Where the run directory and spec pin the reading used came from. */
		runSource: "operator-flag" | "binding-record" | "launch-record" | null;
		label: string;
		checks: EndoProtectedAttemptCheckV0[];
		limitation: string | null;
	};
	/**
	 * The /agent tree digest, re-hashed from the run's retained agent copy (<run>/.agents/<condition>). The sealed v2 trial record does not
	 * name it (only read-only files carry a digest; the tree is committed only inside the profile digest), so this is file evidence, not a
	 * sealed fact. Null when no protected launch is being read.
	 */
	agentTreeSha256: string | null;
	pinStatus: "not-supplied" | "missing" | "matched" | "mismatched";
	expectedSpecPin: string | null;
	observedSpecSha256: string | null;
	runId: string | null;
	runSchemaVersion: string | null;
	trialCoordinates: {
		position: number;
		task: string;
		condition: string;
		trial: number;
		attempt: number;
	} | null;
	recordSha256: string | null;
	preflightStatus: string | null;
	agent: {
		status: string;
		exitCode: number | null;
		signal: string | null;
		termination: string;
		scopeEstablished: boolean | null;
		scopeEnded: string | null;
		outputDigestVerified: boolean | null;
	} | null;
	qualification: { reference: string; negative: string | null } | null;
	evaluation: {
		status: string;
		cases: { total: number; passed: number } | null;
		reason: string | null;
		definitionSha256: string;
		driverSha256: string;
		outputSha256: string | null;
	} | null;
	modelRecording: {
		status: string;
		required: number;
		answeredVerified: number;
		totalExchanges: number;
	} | null;
	candidateIntegrity:
		| "not-supplied"
		| "verified"
		| "tampered"
		| "not-collected"
		| "pin-missing"
		| "pin-mismatch"
		| "refused"
		| "unreadable";
	candidateMode: "staged-changeset" | "fixed-paths" | null;
	baselineSha256: string | null;
	changesetSha256: string | null;
	candidateSha256: string | null;
	submissionSha256: string | null;
	candidateDetail: string;
	invalidating: string[];
	refusedRecords: { path: string; reason: string }[];
	outcome: "passed" | "failed" | "attrition" | "not-attempted" | "refused" | "unreadable" | "not-supplied";
	problem: string | null;
}

export interface EndoDevelopEvidenceBridgeV0 {
	schemaVersion: typeof ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V1;
	readAtMs: number;
	trustBoundary: typeof ENDO_EVIDENCE_BRIDGE_TRUST_BOUNDARY_V0;
	transitions: EndoEvidenceBridgeTransitionV0[];
	task: {
		source: "operator-declared";
		projectId: string;
		taskId: string;
		state: "present" | "not-found" | "unavailable";
		status: EndoDevelopTaskStatusV0 | null;
		revision: number | null;
		wordsChangedSincePrepare: EndoDevelopTaskWordV0[];
		history: EndoDevelopStatusChangeV0[];
		movedToDone: { atMs: number; note: string | null } | null;
	};
	attempt: {
		source: "operator-declared";
		id: string;
		projectId: string;
		taskId: string;
		preparedAtMs: number;
		taskRevision: number;
		objective: string;
		hasVerificationPlan: boolean;
		briefSha256: string;
		handoff: { recordedAtMs: number; target: string } | null;
		outcome: { recordedAtMs: number; kind: "reported" | "abandoned"; note: string } | null;
		damagedRecords: { record: "handoff" | "outcome" | "authorized"; reason: string }[];
	};
	execution: {
		authorization: {
			source: "controller-observed" | "none" | "damaged";
			recordState: "recorded" | "absent" | "damaged";
			authorizedAtMs: number | null;
			approvedBy: "operator" | null;
			via: "workbench-terminal" | null;
			session: string | null;
			attachment: string | null;
			launchId: string | null;
			proposalId: string | null;
			proposalDigest: string | null;
			authorizationEventId: string | null;
			briefDigestState: "matches" | "differs" | null;
			unattributedWorkbenchSends: number | null;
		};
		dispatch: {
			source: "controller-observed" | "none" | "unknown";
			send: EndoAttemptSendStateV0 | null;
			sendLabel: string;
			refusal: string | null;
			logEvidence: "complete" | "partial" | "unavailable" | null;
		};
		piReport: {
			source: "pi-reported" | "none" | "unknown";
			disposition: "started" | "queued" | "handled" | null;
			run: EndoAttemptRunStateV0 | null;
			runSource: "pi-reported" | "controller-observed" | "none" | "unknown";
			runLabel: string;
			attributionNote: string;
		};
	};
	candidate: {
		workingTree: {
			source: "controller-observed" | "operator-declared" | "none" | "unavailable";
			provenanceState: EndoAttemptProvenanceViewV0["state"];
			basis: EndoProvenanceBasisV0 | null;
			startObservationId: string | null;
			endObservationId: string | null;
			endTrigger: EndoObservationTriggerV0 | null;
			beforeToAfterSpan: EndoStateComparisonV0 | null;
			afterToNow: EndoAttemptProvenanceViewV0["now"];
			checkedCommits: EndoAttemptProvenanceViewV0["checked"];
			overlaps: string[];
			notes: EndoProvenanceNoteV0[];
			establishesReconstructableBytes: false;
			establishesAuthorship: false;
		};
		reconstructable: {
			supplied: boolean;
			attemptAssociation: EndoProtectedAttemptAssociationV0;
			missingRecord: "develop-attempt-protected-candidate-binding";
			integrity: EndoBridgeProtectedExperimentV0["candidateIntegrity"];
			mode: "staged-changeset" | "fixed-paths" | null;
			baselineSha256: string | null;
			changesetSha256: string | null;
			candidateSha256: string | null;
			submissionSha256: string | null;
			detail: string;
		};
	};
	verification: {
		ordinaryReceipts: {
			authority: "operator-triggered-host-check";
			linkedBy: "operator";
			comparedWith: string | null;
			currentHead: { commit: string; clean: boolean } | null;
			state: "ready" | "unreadable";
			receiptCount: number;
			problemCount: number;
			latest: EndoBridgeOrdinaryCheckV0[];
			planLedger: {
				source: "operator-plan";
				checks: (EndoAcceptanceLedgerV0["checks"][number] & { argv: string[]; shows: string; label: string })[];
				criteria: (EndoAcceptanceLedgerV0["criteria"][number] & { label: string })[];
				unplanned: number;
			} | null;
		};
		protectedExperiment: EndoBridgeProtectedExperimentV0;
	};
	findings: EndoEvidenceBridgeFindingV0[];
	review: {
		kind: "advisory-suggestion-not-authority";
		decisionAuthority: "operator-only";
		suggestedOutcome: EndoEvidenceBridgeSuggestionV0;
		label: string;
		basis: string;
		operatorDecision: {
			status: EndoDevelopTaskStatusV0 | null;
			accepted: boolean;
			note: string | null;
		};
	};
	notEstablished: readonly string[];
}
