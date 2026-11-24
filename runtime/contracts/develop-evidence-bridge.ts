// Pure projection and terminal renderer for DEVELOP-EVIDENCE-BRIDGE-001 (docs/designs/develop-evidence-bridge.md).
// Reuses `endoAttemptEvidenceV0`, `endoBriefSha256V0` and `EndoAttemptProvenanceViewV0` without touching the filesystem,
// running any command or evaluator, changing any task status, or inventing any missing link.
//
// Layer rule: this module lives under `runtime/contracts/` and never imports from `adapters/`.

import { ENDO_PROTECTED_ATTEMPT_ASSOCIATION_LABELS_V0 } from "../../protocol/develop-attempt-candidate-binding.ts";
import { ENDO_ATTEMPT_RUN_LABELS_V0, ENDO_ATTEMPT_SEND_LABELS_V0 } from "../../protocol/develop-attempt-execution.ts";
import { endoAttemptPlanV0, renderEndoDevelopBriefV0 } from "../../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V1,
	ENDO_EVIDENCE_BRIDGE_BOUND_NOT_ESTABLISHED_V0,
	ENDO_EVIDENCE_BRIDGE_FINDING_CODES_V0,
	ENDO_EVIDENCE_BRIDGE_NOT_ESTABLISHED_V0,
	ENDO_EVIDENCE_BRIDGE_SUGGESTION_LABELS_V0,
	ENDO_EVIDENCE_BRIDGE_TRUST_BOUNDARY_V0,
	type EndoBridgeProtectedExperimentV0,
	type EndoDevelopEvidenceBridgeV0,
	type EndoEvidenceBridgeFindingCodeV0,
	type EndoEvidenceBridgeFindingSeverityV0,
	type EndoEvidenceBridgeFindingV0,
	type EndoEvidenceBridgeSuggestionV0,
	type EndoEvidenceBridgeTransitionV0,
} from "../../protocol/develop-evidence-bridge.ts";
import type { EndoAttemptProvenanceViewV0 } from "../../protocol/develop-provenance.ts";
import type {
	EndoDevelopReceiptV0,
	EndoReceiptCurrentV0,
	EndoReceiptRelationV0,
} from "../../protocol/develop-receipts.ts";
import type { EndoDevelopStatusChangeV0, EndoDevelopTaskStatusV0 } from "../../protocol/develop-tasks.ts";
import { endoAttemptEvidenceV0 } from "./develop-attempt-evidence.ts";
import { endoBriefSha256V0 } from "./develop-attempt-execution.ts";
import type { DevelopAttemptReportV0 } from "./develop-attempts.ts";
import { endoComparisonWordsV0 } from "./develop-observations.ts";

export interface EndoDevelopEvidenceBridgeInputV0 {
	report: DevelopAttemptReportV0;
	task: {
		status: EndoDevelopTaskStatusV0;
		revision: number;
		history: readonly EndoDevelopStatusChangeV0[];
	} | null;
	receipts: readonly { receipt: EndoDevelopReceiptV0; relation: EndoReceiptRelationV0 }[] | null;
	receiptProblems: number;
	comparedWith: string | null;
	current: EndoReceiptCurrentV0 | null;
	provenance: EndoAttemptProvenanceViewV0;
	protectedExperiment?: EndoBridgeProtectedExperimentV0;
	readAtMs: number;
}

/** Default protected-experiment section when no protected-run directory was supplied to the bridge. */
export function endoEmptyProtectedBridgeV0(): EndoBridgeProtectedExperimentV0 {
	return {
		supplied: false,
		authority: "experimental-non-authoritative",
		workstationH0: "blocked",
		attemptAssociation: "not-supplied",
		missingBindingRecord: null,
		binding: {
			launch: "absent",
			record: "absent",
			boundBy: null,
			standing: null,
			operationDigest: null,
			bindingSha256: null,
			runSource: null,
			label: ENDO_PROTECTED_ATTEMPT_ASSOCIATION_LABELS_V0["not-supplied"],
			checks: [],
			limitation: null,
		},
		agentTreeSha256: null,
		pinStatus: "not-supplied",
		expectedSpecPin: null,
		observedSpecSha256: null,
		runId: null,
		runSchemaVersion: null,
		trialCoordinates: null,
		recordSha256: null,
		preflightStatus: null,
		agent: null,
		qualification: null,
		evaluation: null,
		modelRecording: null,
		candidateIntegrity: "not-supplied",
		candidateMode: null,
		baselineSha256: null,
		changesetSha256: null,
		candidateSha256: null,
		submissionSha256: null,
		candidateDetail:
			"No protected-experiment run was supplied. Existing DEVELOP records do not name a reconstructable staged candidate.",
		invalidating: [],
		refusedRecords: [],
		outcome: "not-supplied",
		problem: null,
	};
}

const FINDING_META: Readonly<
	Record<EndoEvidenceBridgeFindingCodeV0, { severity: EndoEvidenceBridgeFindingSeverityV0; text: string }>
> = Object.freeze({
	"authorization-record-damaged": {
		severity: "contradiction",
		text: "A file at this attempt's authorisation record name is damaged or misnamed; whether a send was authorised is unknown and nothing in the session log is attributed.",
	},
	"execution-record-contradiction": {
		severity: "contradiction",
		text: "The session event log contradicts or does not hold the exact proposal/authorisation named by this attempt's authorisation record (not-attributable).",
	},
	"brief-changed-since-authorization": {
		severity: "integrity",
		text: "The brief rendered from the prepared record now differs from the SHA-256 approved at authorisation.",
	},
	"operator-statement-damaged": {
		severity: "integrity",
		text: "A file at this attempt's handoff or outcome record name is damaged or unusable and is not read as absent.",
	},
	"protected-spec-pin-missing": {
		severity: "integrity",
		text: "A protected-experiment directory was supplied without an operator --spec-pin; an unpinned run is never trusted.",
	},
	"protected-spec-pin-mismatch": {
		severity: "integrity",
		text: "The supplied --spec-pin does not match protected-run.json's canonical specSha256.",
	},
	"protected-run-unreadable": {
		severity: "integrity",
		text: "The supplied protected-experiment run directory or requested trial could not be read or validated.",
	},
	"protected-record-refused": {
		severity: "contradiction",
		text: "Independent validation refused one or more protected-experiment trial records (seal, coordinate, policy, model recording or staged-changeset mismatch).",
	},
	"protected-candidate-bytes-changed": {
		severity: "integrity",
		text: "Re-verifying the staged candidate or submission bytes on disk failed: candidate bytes changed, are missing, or contradict the sealed record.",
	},
	"protected-agent-log-digest-mismatch": {
		severity: "integrity",
		text: "agent.log on disk does not match the recorded agent.outputSha256 digest.",
	},
	"protected-attempt-association-unestablished": {
		severity: "unestablished",
		text: "No existing record links this DEVELOP attempt (endo.attempt.<id>) to the supplied protected-experiment run or candidate; the bridge refuses heuristic matching by timestamp, prompt text, filename or agent self-report.",
	},
	"protected-attempt-binding-invalid": {
		severity: "contradiction",
		text: "This attempt's protected launch record or candidate binding is unusable, mis-sealed, or contradicts what was re-read now (another run, spec, trial, record, agent tree, prompt or candidate, a changed brief, or a workbench send too); it is not admitted.",
	},
	"protected-attempt-candidate-integrity-failure": {
		severity: "integrity",
		text: "The protected run this attempt's records name finished, but its candidate does not verify against its sealed record and bytes now.",
	},
	"protected-attempt-execution-incomplete": {
		severity: "gap",
		text: "A protected launch of this attempt was authorised, but no binding was sealed: the run is absent, unfinished, interrupted, its termination unconfirmed, or the launcher stopped before sealing.",
	},
	"protected-attempt-association-operator-declared": {
		severity: "unestablished",
		text: "The link from this attempt to its protected candidate is the operator's own declaration; its digests re-verify, but no controller established it.",
	},
	"protected-attempt-association-established": {
		severity: "info",
		text: "The protected launcher that ran this attempt bound it to its candidate, and every digest re-verifies now. That is integrity evidence over unsigned same-uid files, not a signature or authority.",
	},
	"protected-execution-unconfirmed-or-interrupted": {
		severity: "gap",
		text: "The protected-experiment execution did not complete with confirmed sandbox termination (interrupted, timed out, or termination unconfirmed).",
	},
	"protected-evaluation-failed": {
		severity: "gap",
		text: "The protected-experiment independent offline evaluator reported failure (experimental, non-authoritative).",
	},
	"protected-evaluation-incomplete": {
		severity: "gap",
		text: "The protected-experiment evaluation did not produce a complete qualified result (attrition, not-attempted, missing qualification or uncollected candidate).",
	},
	"not-authorized": {
		severity: "gap",
		text: "No send to Pi was authorised on the workbench terminal for this attempt.",
	},
	"execution-evidence-incomplete": {
		severity: "gap",
		text: "The session event log was unavailable or only partially readable, so post-authorisation events may be missing.",
	},
	"send-not-confirmed": {
		severity: "gap",
		text: "The attempt was authorised, but Pi's acceptance of the dispatch is not recorded (not-sent, no-send-recorded, sent-no-reply, or refused-by-runtime).",
	},
	"run-interrupted-or-unconfirmed": {
		severity: "gap",
		text: "The attributed Pi run was interrupted, the Pi process ended before a run started, or the run remains open without a recorded end.",
	},
	"run-not-completed": {
		severity: "gap",
		text: "No run that Pi reported as completed is attributed to this send.",
	},
	"task-words-changed": {
		severity: "stale",
		text: "The task's title, description or acceptance criteria changed after this attempt was prepared.",
	},
	"provenance-unreadable": {
		severity: "gap",
		text: "This attempt's working-tree observations directory could not be read.",
	},
	"provenance-missing": {
		severity: "unestablished",
		text: "No controller-bound working-tree observation links this attempt's execution frame to a checked Git commit.",
	},
	"provenance-other-send-observations": {
		severity: "contradiction",
		text: "One or more working-tree observations under this attempt name a different proposal/authorisation than this attempt's authorisation record; they are excluded.",
	},
	"provenance-run-end-not-observed": {
		severity: "gap",
		text: "No settled controller-bound run-end observation was recorded (the after-run observation is missing or was recorded while the workbench closed with the run still open).",
	},
	"provenance-overlaps": {
		severity: "gap",
		text: "Another attempt recorded working-tree observations in the same working tree inside this attempt's execution frame.",
	},
	"provenance-comparison-incomplete": {
		severity: "gap",
		text: "Content equality between the bound run-end observation and the current or checked HEAD could not be verified (incomplete observation, uncomparable state, or missing checked-commit comparison).",
	},
	"checked-commit-differs-from-observed-run-end": {
		severity: "contradiction",
		text: "The commit checked at HEAD differs in tracked/untracked Git content from the working tree observed when the run ended.",
	},
	"working-tree-changed-since-observation": {
		severity: "stale",
		text: "The working tree now differs in content from the latest recorded observation for this attempt.",
	},
	"receipts-unreadable": {
		severity: "gap",
		text: "This attempt's verification receipts directory could not be read.",
	},
	"receipt-files-unusable": {
		severity: "integrity",
		text: "Some files in this attempt's receipts directory are damaged or unreadable and are not shown.",
	},
	"no-check": {
		severity: "gap",
		text: "No independent ordinary verification receipt has been recorded for this attempt.",
	},
	"no-check-after-authorization": {
		severity: "gap",
		text: "Every ordinary verification receipt recorded for this attempt ended before the send was authorised.",
	},
	"current-tree-unavailable": {
		severity: "gap",
		text: "The reader's working tree could not be observed now, so receipts cannot be checked for staleness.",
	},
	"current-tree-changed": {
		severity: "stale",
		text: "The working tree has uncommitted changes now; no clean-commit receipt covers those uncommitted bytes.",
	},
	"no-check-at-current-head": {
		severity: "stale",
		text: "No ordinary verification receipt was recorded at the working tree's current HEAD.",
	},
	"check-not-passed-at-current-head": {
		severity: "gap",
		text: "An ordinary verification receipt at the current HEAD failed or was inconclusive.",
	},
	"stale-check": {
		severity: "stale",
		text: "For at least one command, the latest receipt is at another commit (head-differs) and is stale.",
	},
	"checked-in-another-tree": {
		severity: "info",
		text: "Some receipts were recorded in another working tree or repository and are not compared with this tree.",
	},
	"planned-check-not-passed-at-current-head": {
		severity: "gap",
		text: "At least one planned check in the verification plan does not have a clean passing state at the current HEAD.",
	},
	"agent-report-unsupported-by-independent-evidence": {
		severity: "gap",
		text: "Pi reported run completion and/or an operator-recorded agent report exists, without passing independent verification at the current clean HEAD.",
	},
	"task-unavailable": {
		severity: "gap",
		text: "The task file could not be read or no longer holds this attempt's task.",
	},
	"task-done-with-unverified-gaps": {
		severity: "gap",
		text: "The task is marked done in tasks.json while verification or integrity gaps remain; status is never altered by this reader.",
	},
	"not-accepted": {
		severity: "info",
		text: "The task's status is not done: the operator has not recorded acceptance.",
	},
});

const PI_REPORTED_RUNS = new Set(["completed", "failed", "aborted", "unclassified"]);
const CONTROLLER_OBSERVED_RUNS = new Set(["interrupted", "process-ended", "open", "not-observed"]);
const AT_HEAD = new Set<EndoReceiptRelationV0>(["at-head", "at-head-changed"]);

/** Build the read-only evidence bridge from already-read DEVELOP records and optional inspected protected run. */
export function endoDevelopEvidenceBridgeV0(input: EndoDevelopEvidenceBridgeInputV0): EndoDevelopEvidenceBridgeV0 {
	const evidence = endoAttemptEvidenceV0({
		report: input.report,
		task: input.task,
		receipts: input.receipts,
		receiptProblems: input.receiptProblems,
		comparedWith: input.comparedWith,
		current: input.current,
		readAtMs: input.readAtMs,
	});
	const pe = input.protectedExperiment ?? endoEmptyProtectedBridgeV0();
	const attempt = input.report.attempt;
	const auth = input.report.authorized;
	const exec = input.report.execution;
	const prov = input.provenance;
	const briefSha256 = endoBriefSha256V0(renderEndoDevelopBriefV0(attempt));

	const codes = new Set<EndoEvidenceBridgeFindingCodeV0>();
	for (const g of evidence.gaps) {
		codes.add(g.code);
	}

	// Execution contradictions and interruptions
	if (exec !== null && exec.send === "not-attributable") {
		codes.add("execution-record-contradiction");
	}
	if (
		exec !== null &&
		(exec.send === "sent-no-reply" ||
			exec.run === "interrupted" ||
			exec.run === "process-ended" ||
			exec.run === "open")
	) {
		codes.add("run-interrupted-or-unconfirmed");
	}

	// Independent passing verification at clean HEAD?
	const cleanHead = evidence.checks.current?.clean === true;
	const hasAnyPassingReceiptAtCleanHead =
		cleanHead &&
		evidence.checks.state === "ready" &&
		evidence.checks.latest.some(
			(c) => c.relation === "at-head" && (c.plannedBehaviour ? false : c.outcome === "passed"),
		);
	const planAllPassed =
		evidence.verification !== null &&
		evidence.verification.checks.length > 0 &&
		evidence.verification.checks.every((c) => c.state === "passed");
	const hasIndependentPassAtHead =
		cleanHead &&
		evidence.checks.state === "ready" &&
		(evidence.verification !== null
			? planAllPassed
			: hasAnyPassingReceiptAtCleanHead &&
				!evidence.checks.latest.some((c) => AT_HEAD.has(c.relation) && c.outcome !== "passed"));

	// Provenance / working-tree observations
	// Only `send-and-run` and `run-only` carry a controller-bound `after-run` endpoint; `send-and-operator` and `send-only`
	// lack a bound run-end observation (the endpoint of `send-and-operator` is an unbound operator `endo attempt observe`).
	const endObs = prov.end === null ? null : (prov.observations.find((o) => o.id === prov.end) ?? null);
	const hasBoundRunEnd =
		prov.state === "observed" &&
		(prov.basis === "send-and-run" || prov.basis === "run-only") &&
		endObs !== null &&
		endObs.point === "after-run" &&
		endObs.bound === "this-send" &&
		endObs.state === "observed";
	const hasSendStartOnly =
		prov.state === "observed" && (prov.basis === "send-and-operator" || prov.basis === "send-only");
	if (prov.state === "unreadable") {
		codes.add("provenance-unreadable");
	} else if (prov.state === "none" || (!hasBoundRunEnd && !hasSendStartOnly)) {
		codes.add("provenance-missing");
	}
	if (prov.notes.includes("other-send-observations")) {
		codes.add("provenance-other-send-observations");
	}
	if (prov.notes.includes("run-end-not-observed") || prov.notes.includes("no-after-run") || hasSendStartOnly) {
		codes.add("provenance-run-end-not-observed");
	}
	if (prov.overlaps.length > 0) {
		codes.add("provenance-overlaps");
	}
	if (prov.now?.comparison.relation === "different") {
		codes.add("working-tree-changed-since-observation");
	}

	// Does the current HEAD commit (where receipts ran) match the observed bound run-end working tree?
	const currentHeadCommit = evidence.checks.current?.commit ?? null;
	const checkedAtHead =
		currentHeadCommit === null ? null : (prov.checked.find((c) => c.commit === currentHeadCommit) ?? null);
	if (hasBoundRunEnd && checkedAtHead !== null && checkedAtHead.comparison.relation === "different") {
		codes.add("checked-commit-differs-from-observed-run-end");
	}
	const checkedMatchesBoundRunEnd =
		hasBoundRunEnd &&
		!prov.notes.includes("run-end-not-observed") &&
		endObs.complete &&
		checkedAtHead !== null &&
		checkedAtHead.comparison.relation === "same";
	if (
		hasBoundRunEnd &&
		(!endObs.complete ||
			prov.now?.comparison.relation === "not-compared" ||
			checkedAtHead?.comparison.relation === "not-compared" ||
			(hasIndependentPassAtHead && checkedAtHead === null))
	) {
		codes.add("provenance-comparison-incomplete");
	}

	// Protected-experiment findings (kept strictly separate from ordinary receipts and never fabricated as linked!)
	if (pe.supplied) {
		const association = pe.attemptAssociation;
		if (association === "unestablished") codes.add("protected-attempt-association-unestablished");
		if (association === "invalid") codes.add("protected-attempt-binding-invalid");
		if (association === "candidate-integrity-failure") codes.add("protected-attempt-candidate-integrity-failure");
		if (association === "incomplete-execution") codes.add("protected-attempt-execution-incomplete");
		if (association === "operator-declared") codes.add("protected-attempt-association-operator-declared");
		if (association === "established") codes.add("protected-attempt-association-established");
		if (pe.pinStatus === "missing") codes.add("protected-spec-pin-missing");
		if (pe.pinStatus === "mismatched") codes.add("protected-spec-pin-mismatch");
		if (
			pe.outcome === "unreadable" &&
			!(association === "incomplete-execution" && pe.binding.runSource === "launch-record")
		)
			codes.add("protected-run-unreadable");
		if (pe.refusedRecords.length > 0 || pe.outcome === "refused") codes.add("protected-record-refused");
		if (pe.candidateIntegrity === "tampered") codes.add("protected-candidate-bytes-changed");
		if (pe.agent?.outputDigestVerified === false) codes.add("protected-agent-log-digest-mismatch");
		if (
			pe.agent !== null &&
			(pe.agent.termination !== "confirmed" ||
				pe.agent.status === "timed-out" ||
				pe.agent.status === "interrupted" ||
				pe.agent.status === "not-run" ||
				pe.agent.scopeEnded !== "confirmed")
		) {
			codes.add("protected-execution-unconfirmed-or-interrupted");
		}
		if (pe.outcome === "failed" || pe.evaluation?.status === "failed") {
			codes.add("protected-evaluation-failed");
		} else if (
			pe.outcome === "attrition" ||
			pe.outcome === "not-attempted" ||
			(pe.pinStatus === "matched" &&
				pe.outcome !== "refused" &&
				pe.outcome !== "unreadable" &&
				pe.evaluation?.status !== "passed")
		) {
			codes.add("protected-evaluation-incomplete");
		}
	}

	const hasAgentReportedPassOrCompletion = exec?.run === "completed" || input.report.outcome?.kind === "reported";
	if (hasAgentReportedPassOrCompletion && !hasIndependentPassAtHead) {
		codes.add("agent-report-unsupported-by-independent-evidence");
	}

	// Non-info gaps while task is marked done
	const nonInfoGapPresent = [...codes].some((c) => c !== "not-accepted" && c !== "checked-in-another-tree");
	if (input.task?.status === "done" && nonInfoGapPresent) {
		codes.add("task-done-with-unverified-gaps");
	}

	const findings: EndoEvidenceBridgeFindingV0[] = ENDO_EVIDENCE_BRIDGE_FINDING_CODES_V0.filter((c) =>
		codes.has(c),
	).map((code) => ({
		code,
		severity: FINDING_META[code].severity,
		text: FINDING_META[code].text,
	}));

	// ---- Explicit transition table: Task -> Attempt -> Authorization -> Dispatch -> Run -> Candidate -> Verification -> Operator decision ----
	const transitions: EndoEvidenceBridgeTransitionV0[] = [
		// 1. Task -> Attempt
		input.task === null
			? {
					id: "task-to-attempt",
					label: "Task -> Attempt",
					status: "unavailable",
					basis: "unavailable",
					evidence: `Attempt ${attempt.id} names task ${attempt.taskId}, but tasks.json cannot be read or no longer holds it.`,
					missingRecord: null,
				}
			: input.report.taskWordsChanged.length > 0
				? {
						id: "task-to-attempt",
						label: "Task -> Attempt",
						status: "partial",
						basis: "operator-declared",
						evidence: `Attempt ${attempt.id} names task ${attempt.taskId} (prepared at revision ${attempt.task.revision}; task is now revision ${input.task.revision}, words changed: ${input.report.taskWordsChanged.join(", ")}).`,
						missingRecord: null,
					}
				: {
						id: "task-to-attempt",
						label: "Task -> Attempt",
						status: "established",
						basis: "operator-declared",
						evidence: `Prepared record ${attempt.id} explicitly names project ${attempt.projectId} and task ${attempt.taskId} (frozen task words match current revision ${input.task.revision}).`,
						missingRecord: null,
					},

		// 2. Attempt -> Authorization
		evidence.sent.authorizationRecord === "damaged"
			? {
					id: "attempt-to-authorization",
					label: "Attempt -> Authorization",
					status: "damaged",
					basis: "damaged",
					evidence:
						"A file at this attempt's authorisation record name is damaged or misnamed; authorisation is unknown.",
					missingRecord: null,
				}
			: auth === null || exec === null
				? {
						id: "attempt-to-authorization",
						label: "Attempt -> Authorization",
						status: "unestablished",
						basis: "missing",
						evidence: "No <attempt>.authorized.json record exists; no workbench terminal send was authorised.",
						missingRecord: "develop-attempt-authorization",
					}
				: exec.brief === "differs" || exec.send === "not-attributable"
					? {
							id: "attempt-to-authorization",
							label: "Attempt -> Authorization",
							status: "contradictory",
							basis: "contradictory",
							evidence:
								exec.brief === "differs"
									? `Authorisation record names briefSha256 ${auth.briefSha256.slice(0, 12)}, which differs from the brief rendered now (${briefSha256.slice(0, 12)}).`
									: `Authorisation record names proposal ${auth.proposalId}, but the session event log does not hold a matching proposal/allow chain.`,
							missingRecord: null,
						}
					: exec.evidence !== "complete"
						? {
								id: "attempt-to-authorization",
								label: "Attempt -> Authorization",
								status: "partial",
								basis: "controller-observed",
								evidence: `Authorisation record names proposal ${auth.proposalId} and briefSha256 ${auth.briefSha256.slice(0, 12)} (matches), but the session log is ${exec.evidence}.`,
								missingRecord: null,
							}
						: {
								id: "attempt-to-authorization",
								label: "Attempt -> Authorization",
								status: "established",
								basis: "controller-observed",
								evidence: `Exact join: ${attempt.id}.authorized.json -> workbench.prompt-proposed (${auth.proposalId}, digest recomputed) -> workbench.prompt-authorized (${auth.authorizationEventId}, allow); briefSha256 matches.`,
								missingRecord: null,
							},

		// 3. Authorization -> Dispatch
		evidence.sent.authorizationRecord === "damaged"
			? {
					id: "authorization-to-dispatch",
					label: "Authorization -> Dispatch",
					status: "damaged",
					basis: "damaged",
					evidence: "Cannot attribute any dispatch while the authorisation record is damaged.",
					missingRecord: null,
				}
			: exec === null
				? {
						id: "authorization-to-dispatch",
						label: "Authorization -> Dispatch",
						status: "unestablished",
						basis: "missing",
						evidence: "No authorisation record; no workbench dispatch exists for this attempt.",
						missingRecord: "workbench.prompt-dispatched",
					}
				: exec.send === "not-attributable"
					? {
							id: "authorization-to-dispatch",
							label: "Authorization -> Dispatch",
							status: "contradictory",
							basis: "contradictory",
							evidence: "Authorisation could not be verified in the session log; no dispatch is attributed.",
							missingRecord: null,
						}
					: exec.send === "evidence-unavailable"
						? {
								id: "authorization-to-dispatch",
								label: "Authorization -> Dispatch",
								status: "unavailable",
								basis: "unavailable",
								evidence: "Session event log unavailable or incomplete before dispatch could be verified.",
								missingRecord: null,
							}
						: exec.send === "runtime-accepted"
							? {
									id: "authorization-to-dispatch",
									label: "Authorization -> Dispatch",
									status: "established",
									basis: "controller-observed",
									evidence: `Controller recorded workbench.prompt-dispatched derived from ${auth?.authorizationEventId}; Pi replied ${exec.disposition ?? "accepted"} (acknowledgment only, not completion).`,
									missingRecord: null,
								}
							: {
									id: "authorization-to-dispatch",
									label: "Authorization -> Dispatch",
									status: "partial",
									basis: "controller-observed",
									evidence: `${ENDO_ATTEMPT_SEND_LABELS_V0[exec.send]}.`,
									missingRecord: null,
								},

		// 4. Dispatch -> Run
		evidence.sent.authorizationRecord === "damaged"
			? {
					id: "dispatch-to-run",
					label: "Dispatch -> Run",
					status: "damaged",
					basis: "damaged",
					evidence: "No run attributed because the authorisation record is damaged.",
					missingRecord: null,
				}
			: exec === null ||
					exec.send === "not-attributable" ||
					exec.send === "no-send-recorded" ||
					exec.send === "not-sent" ||
					exec.send === "refused-by-runtime"
				? {
						id: "dispatch-to-run",
						label: "Dispatch -> Run",
						status: "unestablished",
						basis: "missing",
						evidence: "No confirmed dispatch produced an attributable run.",
						missingRecord: null,
					}
				: exec.send === "evidence-unavailable"
					? {
							id: "dispatch-to-run",
							label: "Dispatch -> Run",
							status: "unavailable",
							basis: "unavailable",
							evidence: "Session log unavailable; run state unknown.",
							missingRecord: null,
						}
					: PI_REPORTED_RUNS.has(exec.run)
						? {
								id: "dispatch-to-run",
								label: "Dispatch -> Run",
								status: exec.run === "completed" ? "established" : "partial",
								basis: "window-attributed",
								evidence: `Bounded log-order window in session ${exec.session} (Pi reports no run ID): ${ENDO_ATTEMPT_RUN_LABELS_V0[exec.run]} [Pi-reported].`,
								missingRecord: "pi-native-run-id",
							}
						: {
								id: "dispatch-to-run",
								label: "Dispatch -> Run",
								status: "partial",
								basis: "controller-observed",
								evidence: `Controller-observed run state in session ${exec.session}: ${ENDO_ATTEMPT_RUN_LABELS_V0[exec.run]}.`,
								missingRecord: null,
							},

		// 5. Run -> Observed Working-Tree State (DEVELOP provenance)
		prov.state === "unreadable"
			? {
					id: "run-to-working-tree-state",
					label: "Run -> Observed Working-Tree State",
					status: "unavailable",
					basis: "unavailable",
					evidence: "develop/observations/<attempt>/ could not be read.",
					missingRecord: null,
				}
			: prov.notes.includes("other-send-observations") && !hasBoundRunEnd && !hasSendStartOnly
				? {
						id: "run-to-working-tree-state",
						label: "Run -> Observed Working-Tree State",
						status: "contradictory",
						basis: "contradictory",
						evidence:
							"Recorded observations name a different send binding than this attempt's authorisation and were excluded.",
						missingRecord: null,
					}
				: hasBoundRunEnd
					? {
							id: "run-to-working-tree-state",
							label: "Run -> Observed Working-Tree State",
							status:
								prov.notes.includes("run-end-not-observed") || !endObs.complete ? "partial" : "established",
							basis: "controller-observed",
							evidence: !endObs.complete
								? `Controller observations (${prov.basis}, end=${prov.end ?? "none"}) are bound to exact proposalId/authorizationEventId, but the run-end observation is incomplete (content cannot be fully compared).`
								: `Controller observations (${prov.basis}, end=${prov.end ?? "none"}) bound to exact proposalId/authorizationEventId. Records Git blob hashes only — not reconstructable candidate bytes and not authorship.`,
							missingRecord: null,
						}
					: prov.basis === "send-and-operator"
						? {
								id: "run-to-working-tree-state",
								label: "Run -> Observed Working-Tree State",
								status: "partial",
								basis: "operator-declared",
								evidence: `Before-send observation (start=${prov.start ?? "none"}) is bound to this send, but no bound after-run observation exists; endpoint (end=${prov.end ?? "none"}) is an unbound operator observation, not controller-observed run-end evidence.`,
								missingRecord: "develop-observation-after-run",
							}
						: prov.basis === "send-only"
							? {
									id: "run-to-working-tree-state",
									label: "Run -> Observed Working-Tree State",
									status: "partial",
									basis: "controller-observed",
									evidence: `Only a before-send observation (start=${prov.start ?? "none"}) is bound to this send; no bound after-run observation was recorded.`,
									missingRecord: "develop-observation-after-run",
								}
							: {
									id: "run-to-working-tree-state",
									label: "Run -> Observed Working-Tree State",
									status: "unestablished",
									basis: prov.state === "observed" ? "operator-declared" : "missing",
									evidence:
										prov.state === "observed"
											? `Only operator-taken observations (${prov.basis ?? "none"}) exist; none is bound to a governed send/run.`
											: "No working-tree observation is recorded for this attempt.",
									missingRecord: "develop-observation-send-bound",
								},

		// 6. Attempt -> Reconstructable Candidate (staged changeset / protected experiment)
		!pe.supplied
			? {
					id: "attempt-to-reconstructable-candidate",
					label: "Attempt -> Reconstructable Candidate",
					status: "unestablished",
					basis: "missing",
					evidence:
						"No existing DEVELOP record names a reconstructable staged change set or protected-experiment candidate, and no protected run was supplied.",
					missingRecord: "develop-attempt-protected-candidate-binding",
				}
			: pe.attemptAssociation === "established" || pe.attemptAssociation === "operator-declared"
				? {
						id: "attempt-to-reconstructable-candidate",
						label: "Attempt -> Reconstructable Candidate",
						status: pe.attemptAssociation === "established" ? "established" : "partial",
						basis: pe.attemptAssociation === "established" ? "controller-observed" : "operator-declared",
						evidence:
							pe.attemptAssociation === "established"
								? `Controller-established binding (protected launch ${pe.binding.operationDigest?.slice(0, 12) ?? "unknown"}): run ${pe.runId ?? "unknown"}, record ${pe.recordSha256?.slice(0, 12) ?? "none"}, candidate ${(pe.candidateSha256 ?? pe.submissionSha256)?.slice(0, 12) ?? "none"}; every digest re-verified now. Integrity evidence only, not a signature.`
								: `Operator-declared binding (not controller-established): run ${pe.runId ?? "unknown"}, record ${pe.recordSha256?.slice(0, 12) ?? "none"}, candidate ${(pe.candidateSha256 ?? pe.submissionSha256)?.slice(0, 12) ?? "none"}; digests re-verified now, association is the operator's statement.`,
						missingRecord: null,
					}
				: pe.attemptAssociation === "invalid" || pe.attemptAssociation === "candidate-integrity-failure"
					? {
							id: "attempt-to-reconstructable-candidate",
							label: "Attempt -> Reconstructable Candidate",
							status: "contradictory",
							basis: "contradictory",
							evidence: `${pe.binding.label} (${
								pe.binding.checks
									.filter((c) => c.result === "fail")
									.map((c) => `${c.check}: ${c.detail}`)
									.join("; ") || pe.candidateDetail
							}).`,
							missingRecord: "develop-attempt-protected-candidate-binding",
						}
					: pe.attemptAssociation === "incomplete-execution"
						? {
								id: "attempt-to-reconstructable-candidate",
								label: "Attempt -> Reconstructable Candidate",
								status: "partial",
								basis: "controller-observed",
								evidence: `A protected launch of this attempt was authorised on the terminal (operation ${pe.binding.operationDigest?.slice(0, 12) ?? "unknown"}), but no binding was sealed: ${
									pe.binding.checks
										.filter((c) => c.result === "fail")
										.map((c) => c.detail)
										.join("; ") || "the launcher stopped before sealing"
								}.`,
								missingRecord: "develop-attempt-protected-candidate-binding",
							}
						: pe.candidateIntegrity === "tampered" ||
								pe.pinStatus === "mismatched" ||
								pe.pinStatus === "missing" ||
								pe.outcome === "refused"
							? {
									id: "attempt-to-reconstructable-candidate",
									label: "Attempt -> Reconstructable Candidate",
									status: "contradictory",
									basis: "contradictory",
									evidence: `Supplied protected-experiment candidate failed validation (${pe.candidateIntegrity}: ${pe.candidateDetail}) AND has no stored binding record to DEVELOP attempt ${attempt.id}.`,
									missingRecord: "develop-attempt-protected-candidate-binding",
								}
							: {
									id: "attempt-to-reconstructable-candidate",
									label: "Attempt -> Reconstructable Candidate",
									status: "unestablished",
									basis: "missing",
									evidence: `Supplied protected-experiment candidate (${pe.candidateMode ?? "unknown"}, integrity=${pe.candidateIntegrity}) has NO stored record linking it to DEVELOP attempt ${attempt.id}; association refused (no heuristic matching).`,
									missingRecord: "develop-attempt-protected-candidate-binding",
								},

		// 7. Candidate -> Verification / Receipt
		evidence.checks.state === "unreadable"
			? {
					id: "candidate-to-verification",
					label: "Candidate -> Verification / Receipt",
					status: "unavailable",
					basis: "unavailable",
					evidence: "Ordinary verification receipts directory could not be read.",
					missingRecord: null,
				}
			: hasBoundRunEnd && checkedAtHead !== null && checkedAtHead.comparison.relation === "different"
				? {
						id: "candidate-to-verification",
						label: "Candidate -> Verification / Receipt",
						status: "contradictory",
						basis: "contradictory",
						evidence: `Checked HEAD commit ${currentHeadCommit?.slice(0, 12)} differs from observed run-end state (${endoComparisonWordsV0(checkedAtHead.comparison)}).`,
						missingRecord: null,
					}
				: hasIndependentPassAtHead
					? {
							id: "candidate-to-verification",
							label: "Candidate -> Verification / Receipt",
							status: checkedMatchesBoundRunEnd ? "established" : "partial",
							basis: checkedMatchesBoundRunEnd ? "controller-observed" : "operator-declared",
							evidence: checkedMatchesBoundRunEnd
								? `Ordinary receipts pass at clean HEAD ${currentHeadCommit?.slice(0, 12)}, whose Git tree content equals the bound run-end observation (ignored files excluded; receipt-to-attempt link is operator-declared).`
								: hasBoundRunEnd &&
										checkedAtHead !== null &&
										checkedAtHead.comparison.relation === "not-compared"
									? `Ordinary receipts pass at clean HEAD ${currentHeadCommit?.slice(0, 12)}, but content equality with the bound run-end observation could not be compared (${endoComparisonWordsV0(checkedAtHead.comparison)}).`
									: hasBoundRunEnd && checkedAtHead === null
										? `Ordinary receipts pass at clean HEAD ${currentHeadCommit?.slice(0, 12)}, but no content comparison with the bound run-end observation is available for this commit.`
										: prov.basis === "send-and-operator"
											? `Ordinary receipts pass at clean HEAD ${currentHeadCommit?.slice(0, 12)} (operator-declared attempt link; only an unbound operator observation exists, with no bound run-end observation to confirm content equality).`
											: `Ordinary receipts pass at clean HEAD ${currentHeadCommit?.slice(0, 12)} (operator-declared attempt link; no settled bound run-end observation confirms content equality).`,
							missingRecord: null,
						}
					: evidence.checks.receipts > 0
						? {
								id: "candidate-to-verification",
								label: "Candidate -> Verification / Receipt",
								status: "partial",
								basis: "operator-declared",
								evidence: `${evidence.checks.receipts} ordinary receipt(s) recorded (operator-declared link), but no passing receipt covers the current clean HEAD.`,
								missingRecord: null,
							}
						: {
								id: "candidate-to-verification",
								label: "Candidate -> Verification / Receipt",
								status: "unestablished",
								basis: "missing",
								evidence: "No ordinary verification receipt has been recorded for this attempt.",
								missingRecord: "develop-verification-receipt",
							},

		// 8. Verification -> Operator Decision
		input.task === null
			? {
					id: "verification-to-operator-decision",
					label: "Verification -> Operator Decision",
					status: "unavailable",
					basis: "unavailable",
					evidence: "Task status could not be read.",
					missingRecord: null,
				}
			: {
					id: "verification-to-operator-decision",
					label: "Verification -> Operator Decision",
					status: input.task.status === "done" ? "partial" : "unestablished",
					basis: "operator-declared",
					evidence:
						input.task.status === "done"
							? "Task status is done in tasks.json (operator-declared; status history records no commit or candidate digest)."
							: `Task status is ${input.task.status} (operator decision pending; this reader never changes task status).`,
					missingRecord: input.task.status === "done" ? "operator-decision-revision-binding" : null,
				},
	];

	// ---- Advisory review suggestion (strictly separated from verified observations & authority) ----
	const hasIntegrityOrContradiction =
		codes.has("authorization-record-damaged") ||
		codes.has("execution-record-contradiction") ||
		codes.has("brief-changed-since-authorization") ||
		codes.has("operator-statement-damaged") ||
		codes.has("protected-spec-pin-missing") ||
		codes.has("protected-spec-pin-mismatch") ||
		codes.has("protected-run-unreadable") ||
		codes.has("protected-record-refused") ||
		codes.has("protected-candidate-bytes-changed") ||
		codes.has("protected-agent-log-digest-mismatch") ||
		codes.has("protected-attempt-binding-invalid") ||
		codes.has("protected-attempt-candidate-integrity-failure") ||
		codes.has("checked-commit-differs-from-observed-run-end") ||
		codes.has("provenance-other-send-observations") ||
		codes.has("receipt-files-unusable");

	const hasOrdinaryFailure =
		evidence.checks.state === "ready" &&
		(evidence.verification !== null
			? evidence.verification.checks.some((c) => c.state === "failed")
			: evidence.checks.latest.some(
					(c) => AT_HEAD.has(c.relation) && !c.plannedBehaviour && c.outcome === "failed",
				));
	const hasProtectedFailure = codes.has("protected-evaluation-failed");

	const hasStaleness =
		codes.has("stale-check") ||
		codes.has("current-tree-changed") ||
		codes.has("working-tree-changed-since-observation") ||
		codes.has("task-words-changed") ||
		(codes.has("no-check-at-current-head") && evidence.checks.receipts > 0);

	const hasIncomplete =
		codes.has("not-authorized") ||
		codes.has("execution-evidence-incomplete") ||
		codes.has("send-not-confirmed") ||
		codes.has("run-interrupted-or-unconfirmed") ||
		codes.has("run-not-completed") ||
		codes.has("receipts-unreadable") ||
		codes.has("no-check") ||
		codes.has("no-check-after-authorization") ||
		codes.has("current-tree-unavailable") ||
		codes.has("check-not-passed-at-current-head") ||
		codes.has("planned-check-not-passed-at-current-head") ||
		codes.has("provenance-unreadable") ||
		codes.has("provenance-missing") ||
		codes.has("provenance-run-end-not-observed") ||
		codes.has("provenance-overlaps") ||
		codes.has("provenance-comparison-incomplete") ||
		codes.has("task-unavailable") ||
		codes.has("protected-attempt-association-unestablished") ||
		codes.has("protected-attempt-execution-incomplete") ||
		codes.has("protected-execution-unconfirmed-or-interrupted") ||
		codes.has("protected-evaluation-incomplete");

	let suggestedOutcome: EndoEvidenceBridgeSuggestionV0;
	let basis: string;
	if (hasIntegrityOrContradiction) {
		suggestedOutcome = "blocked-contradictory-or-tampered";
		const top = findings
			.filter((f) => f.severity === "contradiction" || f.severity === "integrity")
			.map((f) => f.code);
		basis = `Contradictory, damaged, tampered or pin-mismatched evidence detected (${top.join(", ")}). Resolve integrity issues before any operator review.`;
	} else if (hasOrdinaryFailure || hasProtectedFailure) {
		suggestedOutcome = "do-not-accept-verification-failed";
		basis = hasOrdinaryFailure
			? "Independent ordinary verification at HEAD failed; do not accept until fixed and re-verified."
			: pe.attemptAssociation === "established"
				? "The protected evaluation of this attempt's bound candidate failed (experimental, non-authoritative)."
				: pe.attemptAssociation === "operator-declared"
					? "The protected evaluation of the candidate the operator declared for this attempt failed (experimental, non-authoritative)."
					: "Supplied protected-experiment evaluation failed (experimental, non-authoritative, and not bound to this DEVELOP attempt).";
	} else if (hasStaleness) {
		suggestedOutcome = "recheck-required-stale-evidence";
		basis =
			"Existing checks or task words are stale relative to the current working tree or observation; re-run independent checks at a clean commit before review.";
	} else if (
		codes.has("agent-report-unsupported-by-independent-evidence") &&
		evidence.checks.receipts === 0 &&
		evidence.checks.state === "ready" &&
		!codes.has("run-interrupted-or-unconfirmed") &&
		!codes.has("send-not-confirmed") &&
		!codes.has("execution-evidence-incomplete") &&
		!pe.supplied
	) {
		suggestedOutcome = "unverified-agent-report-only";
		basis =
			"Only Pi's completion report and/or an operator-recorded report exist without passing independent verification at clean HEAD; agent self-reports are never verification.";
	} else if (hasIncomplete) {
		suggestedOutcome = "incomplete-evidence";
		const top = findings
			.filter((f) => f.severity === "unestablished" || f.severity === "gap")
			.slice(0, 4)
			.map((f) => f.code);
		basis = `Required evidence is missing, unconfirmed, inconclusive, or unassociated (${top.join(", ")}).`;
	} else {
		suggestedOutcome = "ready-for-operator-review";
		basis =
			"Authorisation, dispatch, Pi's run-end window, controller-bound working-tree provenance, and clean-HEAD ordinary verification receipts align with no detected contradictions or staleness. This is an advisory summary over unsigned local records, not an authoritative protected PASS and not acceptance.";
	}

	const runSource: EndoDevelopEvidenceBridgeV0["execution"]["piReport"]["runSource"] =
		evidence.sent.authorizationRecord === "damaged"
			? "unknown"
			: exec === null
				? "none"
				: PI_REPORTED_RUNS.has(exec.run)
					? "pi-reported"
					: CONTROLLER_OBSERVED_RUNS.has(exec.run)
						? "controller-observed"
						: "unknown";

	return {
		schemaVersion: ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V1,
		readAtMs: input.readAtMs,
		trustBoundary: ENDO_EVIDENCE_BRIDGE_TRUST_BOUNDARY_V0,
		transitions,
		task: {
			source: "operator-declared",
			projectId: attempt.projectId,
			taskId: attempt.taskId,
			state: input.report.task,
			status: input.task?.status ?? null,
			revision: input.task?.revision ?? null,
			wordsChangedSincePrepare: [...input.report.taskWordsChanged],
			history: evidence.operator.history,
			movedToDone: evidence.operator.movedToDone,
		},
		attempt: {
			source: "operator-declared",
			id: attempt.id,
			projectId: attempt.projectId,
			taskId: attempt.taskId,
			preparedAtMs: attempt.preparedAtMs,
			taskRevision: attempt.task.revision,
			objective: evidence.attempt.objective,
			hasVerificationPlan: endoAttemptPlanV0(attempt) !== null,
			briefSha256,
			handoff: evidence.attempt.handoff,
			outcome: evidence.attempt.outcome,
			damagedRecords: evidence.sent.damaged,
		},
		execution: {
			authorization: {
				source:
					evidence.sent.authorizationRecord === "damaged"
						? "damaged"
						: auth === null
							? "none"
							: "controller-observed",
				recordState: evidence.sent.authorizationRecord,
				authorizedAtMs: auth?.recordedAtMs ?? null,
				approvedBy: auth?.approvedBy ?? null,
				via: auth?.via ?? null,
				session: auth?.session ?? null,
				attachment: auth?.attachment ?? null,
				launchId: auth?.launchId ?? null,
				proposalId: auth?.proposalId ?? null,
				proposalDigest: auth?.proposalDigest ?? null,
				authorizationEventId: auth?.authorizationEventId ?? null,
				briefDigestState: exec?.brief ?? null,
				unattributedWorkbenchSends: evidence.sent.unattributedWorkbenchSends,
			},
			dispatch: {
				source:
					evidence.sent.authorizationRecord === "damaged"
						? "unknown"
						: exec === null
							? "none"
							: "controller-observed",
				send: exec?.send ?? null,
				sendLabel: evidence.sent.sendLabel,
				refusal: exec?.refusal ?? null,
				logEvidence: exec?.evidence ?? null,
			},
			piReport: {
				source:
					evidence.sent.authorizationRecord === "damaged" ? "unknown" : exec === null ? "none" : "pi-reported",
				disposition: exec?.disposition ?? null,
				run: exec?.run ?? null,
				runSource,
				runLabel: evidence.pi.runLabel,
				attributionNote:
					"Pi reports no native run ID; the run is attributed by log append order to the first lifecycle.run-started in the same session and Pi process after dispatch and before any later dispatch.",
			},
		},
		candidate: {
			workingTree: {
				source:
					prov.state === "unreadable"
						? "unavailable"
						: hasBoundRunEnd || prov.basis === "send-only"
							? "controller-observed"
							: prov.basis === "send-and-operator" || prov.basis === "operator"
								? "operator-declared"
								: "none",
				provenanceState: prov.state,
				basis: prov.basis,
				startObservationId: prov.start,
				endObservationId: prov.end,
				endTrigger: endObs?.trigger ?? null,
				beforeToAfterSpan: prov.span,
				afterToNow: prov.now,
				checkedCommits: prov.checked,
				overlaps: prov.overlaps,
				notes: prov.notes,
				establishesReconstructableBytes: false,
				establishesAuthorship: false,
			},
			reconstructable: {
				supplied: pe.supplied,
				attemptAssociation: pe.attemptAssociation,
				missingRecord:
					pe.attemptAssociation === "established" || pe.attemptAssociation === "operator-declared"
						? null
						: "develop-attempt-protected-candidate-binding",
				integrity: pe.candidateIntegrity,
				mode: pe.candidateMode,
				baselineSha256: pe.baselineSha256,
				changesetSha256: pe.changesetSha256,
				candidateSha256: pe.candidateSha256,
				submissionSha256: pe.submissionSha256,
				detail: pe.candidateDetail,
			},
		},
		verification: {
			ordinaryReceipts: {
				authority: "operator-triggered-host-check",
				linkedBy: "operator",
				comparedWith: evidence.checks.comparedWith,
				currentHead: evidence.checks.current,
				state: evidence.checks.state,
				receiptCount: evidence.checks.receipts,
				problemCount: evidence.checks.problems,
				latest: evidence.checks.latest,
				planLedger: evidence.verification,
			},
			protectedExperiment: pe,
		},
		findings,
		review: {
			kind: "advisory-suggestion-not-authority",
			decisionAuthority: "operator-only",
			suggestedOutcome,
			label: ENDO_EVIDENCE_BRIDGE_SUGGESTION_LABELS_V0[suggestedOutcome],
			basis,
			operatorDecision: {
				status: input.task?.status ?? null,
				accepted: input.task?.status === "done",
				note: evidence.operator.movedToDone?.note ?? null,
			},
		},
		notEstablished:
			pe.attemptAssociation === "established" || pe.attemptAssociation === "operator-declared"
				? [...ENDO_EVIDENCE_BRIDGE_BOUND_NOT_ESTABLISHED_V0, ...ENDO_EVIDENCE_BRIDGE_NOT_ESTABLISHED_V0.slice(1)]
				: ENDO_EVIDENCE_BRIDGE_NOT_ESTABLISHED_V0,
	};
}

/** Operator-facing plain-text reading of the evidence bridge (printed on stderr beside canonical JSON on stdout). */
export function renderEndoDevelopEvidenceBridgeV0(b: EndoDevelopEvidenceBridgeV0): string {
	const short = (h: string | null): string => (h === null ? "none" : h.slice(0, 12));
	const pe = b.verification.protectedExperiment;
	const lines: string[] = [
		`evidence-bridge ${b.attempt.id} (task ${b.task.taskId}, project ${b.task.projectId})`,
		`  objective [operator-declared] ${b.attempt.objective}`,
		`  trust     [boundary] workstation H0=${b.trustBoundary.workstationH0}; develop=${b.trustBoundary.developRecords}; protected-experiment=${b.trustBoundary.protectedExperimentAuthority}`,
		"  chain:",
		...b.transitions.map(
			(t) =>
				`    ${t.label.padEnd(36)} [${t.status}; ${t.basis}] ${t.evidence}${t.missingRecord === null ? "" : ` (missing: ${t.missingRecord})`}`,
		),
		"  execution:",
		`    auth      [${b.execution.authorization.source}] record=${b.execution.authorization.recordState}${b.execution.authorization.proposalId === null ? "" : ` proposal=${b.execution.authorization.proposalId} brief=${b.execution.authorization.briefDigestState ?? "unknown"}`}`,
		`    dispatch  [${b.execution.dispatch.source}] ${b.execution.dispatch.sendLabel}${b.execution.dispatch.logEvidence === null ? "" : ` (log: ${b.execution.dispatch.logEvidence})`}`,
		`    run       [${b.execution.piReport.runSource}] ${b.execution.piReport.runLabel}`,
		"  candidate:",
		`    worktree  [${b.candidate.workingTree.source}] state=${b.candidate.workingTree.provenanceState} basis=${b.candidate.workingTree.basis ?? "none"}${b.candidate.workingTree.beforeToAfterSpan === null ? "" : ` span=(${endoComparisonWordsV0(b.candidate.workingTree.beforeToAfterSpan)})`}${b.candidate.workingTree.afterToNow === null ? "" : ` now=(${endoComparisonWordsV0(b.candidate.workingTree.afterToNow.comparison)})`}`,
		...b.candidate.workingTree.checkedCommits.map(
			(c) =>
				`    checked   [controller-observed] commit ${short(c.commit)} (${c.receipts} receipt${c.receipts === 1 ? "" : "s"}) vs run-end: ${endoComparisonWordsV0(c.comparison)}`,
		),
		`    staged    [${b.candidate.reconstructable.attemptAssociation}] integrity=${b.candidate.reconstructable.integrity}${b.candidate.reconstructable.mode === null ? "" : ` mode=${b.candidate.reconstructable.mode}`}${b.candidate.reconstructable.candidateSha256 !== null ? ` candidate=${short(b.candidate.reconstructable.candidateSha256)}` : b.candidate.reconstructable.submissionSha256 !== null ? ` submission=${short(b.candidate.reconstructable.submissionSha256)}` : ""} — ${b.candidate.reconstructable.detail}`,
		"  verification:",
		`    ordinary  [operator-triggered-host-check] head=${b.verification.ordinaryReceipts.currentHead === null ? "unavailable" : `${short(b.verification.ordinaryReceipts.currentHead.commit)} (${b.verification.ordinaryReceipts.currentHead.clean ? "clean" : "dirty"})`} receipts=${b.verification.ordinaryReceipts.receiptCount} problems=${b.verification.ordinaryReceipts.problemCount}`,
		...b.verification.ordinaryReceipts.latest.map(
			(c) =>
				`      receipt [observed; linkedBy=operator] ${c.command}: ${c.label} at ${short(c.commit)} (${c.relationLabel})`,
		),
		...(b.verification.ordinaryReceipts.planLedger === null
			? ["      plan    [none] prepared without a verification plan"]
			: b.verification.ordinaryReceipts.planLedger.criteria.map(
					(c, i) =>
						`      plan    [criterion ${i + 1}; ${c.checks.length === 0 ? "operator judgment" : c.checks.join(", ")}] ${c.text}: ${c.label}`,
				)),
		...(pe.supplied
			? [
					`    protected [experimental-non-authoritative; H0=blocked; attemptAssociation=${pe.attemptAssociation}] outcome=${pe.outcome} pin=${pe.pinStatus} run=${pe.runId ?? "unknown"} spec=${short(pe.observedSpecSha256)}${pe.evaluation === null ? "" : ` eval=${pe.evaluation.status}${pe.evaluation.cases === null ? "" : ` (${pe.evaluation.cases.passed}/${pe.evaluation.cases.total})`}`}${pe.agent === null ? "" : ` termination=${pe.agent.termination}`}`,
				]
			: ["    protected [not-supplied] no protected-experiment run inspected alongside this attempt"]),
		...(pe.binding.launch === "absent" && pe.binding.record === "absent"
			? []
			: [
					`    binding   [${pe.attemptAssociation}; ${pe.binding.standing ?? "no admitted binding"}] ${pe.binding.label}`,
					...pe.binding.checks
						.filter((c) => c.result !== "not-applicable")
						.map((c) => `      check   [${c.result}] ${c.check}: ${c.detail}`),
					...(pe.binding.limitation === null ? [] : [`      limits  ${pe.binding.limitation}`]),
				]),
		"  review (advisory only — operator decides; status unchanged):",
		`    suggest   [${b.review.suggestedOutcome}] ${b.review.basis}`,
		`    decision  [operator-declared] task status=${b.review.operatorDecision.status ?? "unavailable"}${b.review.operatorDecision.note === null ? "" : ` ("${b.review.operatorDecision.note}")`}`,
		...(b.findings.length === 0
			? ["  findings:   none"]
			: ["  findings:", ...b.findings.map((f) => `    [${f.severity}] ${f.code}: ${f.text}`)]),
		"  not established:",
		...b.notEstablished.map((n) => `    - ${n}`),
	];
	return `${lines.join("\n")}\n`;
}
