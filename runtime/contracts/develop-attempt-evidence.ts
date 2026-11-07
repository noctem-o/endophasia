// One attempt's evidence, read in one place (docs/designs/develop-attempt-evidence.md): what was sent, what Pi reported, which checks
// Endophasia observed and whether they still apply to a working tree the reader chose, what the operator decided, and what no record says.
//
//   caller: `endo attempt evidence` (the operator's own process)
//   endoAttemptEvidenceV0(input)   a pure function of records already read by their own services:
//     |-- DevelopAttemptReportV0     the attempt, the operator's statements, and the execution reading (develop-attempt-execution.ts)
//     |-- EndoDevelopTaskV0          the task now: its status and its status history (the operator's moves)
//     |-- receipts + relations       develop-receipts.ts, each related to `current` by endoReceiptRelationV0
//     `-- current                    the reader's working tree, observed once for this read (read-only Git)
//
// It writes nothing, stores nothing and runs nothing. It adds no record and no event, and it never names a revision as the attempt's
// result: no record does, so the reading says so. Every section carries its source, one of three:
//   - "observed":  recorded by Endophasia itself (the authorisation record and the session log; receipts; the Git observation now)
//   - "operator":  the operator's own statements and decisions (handoff, report, abandon; status moves)
//   - "none":      no record holds it
// Time comparisons are between wall-clock stamps that Endophasia wrote on this machine; they order records, they attribute nothing.

import {
	ENDO_ATTEMPT_RUN_LABELS_V0,
	ENDO_ATTEMPT_SEND_LABELS_V0,
	type EndoDevelopAttemptExecutionViewV0,
} from "../../protocol/develop-attempt-execution.ts";
import {
	ENDO_RECEIPT_OUTCOME_LABELS_V0,
	ENDO_RECEIPT_REASON_TEXT_V0,
	ENDO_RECEIPT_RELATION_LABELS_V0,
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	type EndoReceiptOutcomeV0,
	type EndoReceiptRelationV0,
} from "../../protocol/develop-receipts.ts";
import type { EndoDevelopStatusChangeV0, EndoDevelopTaskStatusV0 } from "../../protocol/develop-tasks.ts";
import type { DevelopAttemptReportV0 } from "./develop-attempts.ts";
import { endoLatestChecksV0 } from "./develop-attention.ts";

export const ENDO_ATTEMPT_EVIDENCE_SCHEMA_V0 = "endo.develop-attempt-evidence.v0";

/**
 * What this reading found missing, stale, unconfirmed or not yet decided, in a fixed order. Each is a fact about the records, never a
 * verdict on the work.
 */
export const ENDO_ATTEMPT_EVIDENCE_GAPS_V0 = [
	"not-authorized",
	"execution-evidence-incomplete",
	"send-not-confirmed",
	"run-not-completed",
	"brief-changed-since-authorization",
	"task-words-changed",
	"receipts-unreadable",
	"no-check",
	"no-check-after-authorization",
	"current-tree-unavailable",
	"current-tree-changed",
	"no-check-at-current-head",
	"check-not-passed-at-current-head",
	"checked-in-another-tree",
	"task-unavailable",
	"not-accepted",
] as const;
export type EndoAttemptEvidenceGapV0 = (typeof ENDO_ATTEMPT_EVIDENCE_GAPS_V0)[number];

export const ENDO_ATTEMPT_EVIDENCE_GAP_TEXT_V0: Readonly<Record<EndoAttemptEvidenceGapV0, string>> = Object.freeze({
	"not-authorized":
		"No send to Pi was authorised on the workbench terminal for this attempt. Anything said about handing it over is the operator's statement.",
	"execution-evidence-incomplete":
		"The session log could not be read in full, so what happened after the authorisation may be missing from this reading.",
	"send-not-confirmed": "The send was authorised, but Pi's acceptance of it is not recorded.",
	"run-not-completed": "No run that Pi reported as completed is attributed to this send.",
	"brief-changed-since-authorization":
		"The brief rendered now differs from the one the operator approved (its digest does not match).",
	"task-words-changed": "The task's words have changed since the attempt was prepared.",
	"receipts-unreadable": "This attempt's receipts could not be read; no check is shown.",
	"no-check": "No check has been recorded for this attempt.",
	"no-check-after-authorization":
		"Every check recorded for this attempt started before the send was authorised, so none of them ran on anything the send could have changed.",
	"current-tree-unavailable":
		"The working tree could not be observed now, so no check is related to its current state.",
	"current-tree-changed": "The working tree has uncommitted changes now; no check covers them.",
	"no-check-at-current-head":
		"No check was recorded at the working tree's current HEAD: the current revision is unchecked.",
	"check-not-passed-at-current-head": "A check at the current HEAD did not pass (it failed, or was inconclusive).",
	"checked-in-another-tree":
		"Some checks ran in another working tree or repository; they are not compared with this one.",
	"task-unavailable": "The task could not be read now, so its status and history are not shown.",
	"not-accepted": "The task's status is not done: the operator has not recorded accepting it.",
});

/** What this reading cannot establish, whatever the records say. Always shown. */
export const ENDO_ATTEMPT_EVIDENCE_NOT_ESTABLISHED_V0 = Object.freeze([
	"Which revision the attempt's work produced. No record names one; a receipt names the commit the operator checked, linked to the attempt by the operator.",
	"Who or what wrote any changed byte: Pi, the operator, or another process. A difference between two commits is not authorship.",
	"That nothing else wrote the working tree between the observations shown here.",
	"That a passing check satisfies the acceptance criteria: the command decides what is checked.",
	"That Pi's report of its run is true. It is what Pi reported, not verified.",
	"Which revision the operator looked at when moving the task's status: the history records the move and its note, no revision and no actor.",
] as const);

export interface EndoAttemptEvidenceCheckV0 {
	command: string;
	receiptId: string;
	commit: string;
	startedAtMs: number;
	outcome: EndoReceiptOutcomeV0;
	label: string;
	reasons: string[];
	relation: EndoReceiptRelationV0;
	relationLabel: string;
	/** By the records' own clocks: true when the check started before the send was authorised; null when nothing was authorised. */
	startedBeforeAuthorization: boolean | null;
	/** The other receipts of the same check (argv, working tree, repository), by outcome. */
	others: { passed: number; failed: number; inconclusive: number };
}

export interface EndoAttemptEvidenceV0 {
	schemaVersion: typeof ENDO_ATTEMPT_EVIDENCE_SCHEMA_V0;
	readAtMs: number;
	attempt: {
		source: "operator";
		id: string;
		projectId: string;
		taskId: string;
		preparedAtMs: number;
		taskRevision: number;
		objective: string;
		/** The operator's own statements, never verified: that they handed it over, and what they recorded as reported or abandoned. */
		handoff: { recordedAtMs: number; target: string } | null;
		outcome: { recordedAtMs: number; kind: "reported" | "abandoned"; note: string } | null;
	};
	sent: {
		source: "observed";
		/** null: no authorisation record. */
		authorizedAtMs: number | null;
		approvedOn: "workbench-terminal" | null;
		session: string | null;
		send: EndoDevelopAttemptExecutionViewV0["send"] | null;
		sendLabel: string;
		disposition: EndoDevelopAttemptExecutionViewV0["disposition"];
		/** What Pi reported of the run attributed to the send; not verification. */
		run: EndoDevelopAttemptExecutionViewV0["run"] | null;
		runLabel: string;
		evidence: EndoDevelopAttemptExecutionViewV0["evidence"] | null;
		brief: EndoDevelopAttemptExecutionViewV0["brief"] | null;
	};
	candidate: {
		source: "none";
		recorded: false;
		text: string;
		/** The commits the operator ran checks at for this attempt, oldest first: where checks ran, not what the attempt produced. */
		checkedCommits: string[];
	};
	checks: {
		source: "observed";
		/** The working tree the checks were compared with, as the reader chose it; null when none could be. */
		comparedWith: string | null;
		current: { commit: string; clean: boolean } | null;
		receipts: number;
		problems: number;
		state: "ready" | "unreadable";
		/** The latest receipt of each distinct check, one at the current HEAD first where there is one (develop-attention.ts). */
		latest: EndoAttemptEvidenceCheckV0[];
	};
	operator: {
		source: "operator";
		state: "present" | "unavailable";
		status: EndoDevelopTaskStatusV0 | null;
		history: EndoDevelopStatusChangeV0[];
		/** The last move to `done`, if the task is done now. */
		accepted: { atMs: number; note: string | null } | null;
	};
	gaps: { code: EndoAttemptEvidenceGapV0; text: string }[];
	notEstablished: readonly string[];
}

export interface EndoAttemptEvidenceInputV0 {
	report: DevelopAttemptReportV0;
	/** The attempt's task now, or null when the task file cannot be read or no longer holds it. */
	task: { status: EndoDevelopTaskStatusV0; history: readonly EndoDevelopStatusChangeV0[] } | null;
	/** null: the attempt's receipts could not be read. */
	receipts: readonly { receipt: EndoDevelopReceiptV0; relation: EndoReceiptRelationV0 }[] | null;
	receiptProblems: number;
	comparedWith: string | null;
	current: EndoReceiptCurrentV0 | null;
	readAtMs: number;
}

const AT_HEAD: readonly EndoReceiptRelationV0[] = ["at-head", "at-head-changed"];

/** The reading. Pure: everything it shows comes from `input`, and it decides nothing about the work or the task. */
export function endoAttemptEvidenceV0(input: EndoAttemptEvidenceInputV0): EndoAttemptEvidenceV0 {
	const { report, task, current } = input;
	const a = report.attempt;
	const x = report.execution;
	const found = new Set<EndoAttemptEvidenceGapV0>();

	if (x === null) found.add("not-authorized");
	else {
		if (x.evidence !== "complete") found.add("execution-evidence-incomplete");
		if (x.send !== "runtime-accepted") found.add("send-not-confirmed");
		if (x.run !== "completed") found.add("run-not-completed");
		if (x.brief !== "matches") found.add("brief-changed-since-authorization");
	}
	if (report.taskWordsChanged.length > 0) found.add("task-words-changed");

	const all = input.receipts ?? [];
	const receipts = all.map((r) => r.receipt);
	const relationOf = new Map(all.map((r) => [r.receipt.id, r.relation]));
	const before = (r: EndoDevelopReceiptV0): boolean | null => (x === null ? null : r.startedAtMs < x.authorizedAtMs);
	const latest: EndoAttemptEvidenceCheckV0[] = endoLatestChecksV0(receipts, current).map((c) => {
		const r = receipts.find((y) => y.id === c.receiptId) as EndoDevelopReceiptV0;
		return {
			command: c.command,
			receiptId: c.receiptId,
			commit: c.commit,
			startedAtMs: c.startedAtMs,
			outcome: c.outcome,
			label: ENDO_RECEIPT_OUTCOME_LABELS_V0[c.outcome],
			reasons: r.reasons.map((reason) => ENDO_RECEIPT_REASON_TEXT_V0[reason]),
			relation: c.relation,
			relationLabel: ENDO_RECEIPT_RELATION_LABELS_V0[c.relation],
			startedBeforeAuthorization: before(r),
			others: c.others,
		};
	});

	if (input.receipts === null) found.add("receipts-unreadable");
	else if (receipts.length === 0) found.add("no-check");
	else {
		if (x !== null && receipts.every((r) => before(r) === true)) found.add("no-check-after-authorization");
		if (current === null) found.add("current-tree-unavailable");
		else {
			if (!current.clean) found.add("current-tree-changed");
			const atHead = receipts.filter((r) => AT_HEAD.includes(relationOf.get(r.id) as EndoReceiptRelationV0));
			if (atHead.length === 0) found.add("no-check-at-current-head");
			else if (latest.some((c) => AT_HEAD.includes(c.relation) && c.outcome !== "passed"))
				found.add("check-not-passed-at-current-head");
		}
		if ([...relationOf.values()].some((r) => r === "other-worktree" || r === "other-repository"))
			found.add("checked-in-another-tree");
	}
	if (task === null) found.add("task-unavailable");
	else if (task.status !== "done") found.add("not-accepted");

	const lastDone = task === null || task.status !== "done" ? undefined : task.history.findLast((h) => h.to === "done");
	const checkedCommits: string[] = [];
	for (const r of [...receipts].sort((p, q) => p.startedAtMs - q.startedAtMs))
		if (!checkedCommits.includes(r.revision.commit)) checkedCommits.push(r.revision.commit);

	return {
		schemaVersion: ENDO_ATTEMPT_EVIDENCE_SCHEMA_V0,
		readAtMs: input.readAtMs,
		attempt: {
			source: "operator",
			id: a.id,
			projectId: a.projectId,
			taskId: a.taskId,
			preparedAtMs: a.preparedAtMs,
			taskRevision: a.task.revision,
			objective: a.objective.split("\n", 1)[0] ?? "",
			handoff:
				report.handoff === null
					? null
					: { recordedAtMs: report.handoff.recordedAtMs, target: report.handoff.target },
			outcome:
				report.outcome === null
					? null
					: { recordedAtMs: report.outcome.recordedAtMs, kind: report.outcome.kind, note: report.outcome.note },
		},
		sent: {
			source: "observed",
			authorizedAtMs: x?.authorizedAtMs ?? null,
			approvedOn: x === null ? null : "workbench-terminal",
			session: x?.session ?? null,
			send: x?.send ?? null,
			sendLabel: x === null ? "Never authorised to be sent to Pi" : ENDO_ATTEMPT_SEND_LABELS_V0[x.send],
			disposition: x?.disposition ?? null,
			run: x?.run ?? null,
			runLabel: x === null ? "No run: nothing was sent" : ENDO_ATTEMPT_RUN_LABELS_V0[x.run],
			evidence: x?.evidence ?? null,
			brief: x?.brief ?? null,
		},
		candidate: {
			source: "none",
			recorded: false,
			text: "No record names a candidate revision for this attempt. The commits below are where the operator ran checks for it; the link from a check to the attempt is the operator's.",
			checkedCommits,
		},
		checks: {
			source: "observed",
			comparedWith: input.comparedWith,
			current: current === null ? null : { commit: current.commit, clean: current.clean },
			receipts: receipts.length,
			problems: input.receiptProblems,
			state: input.receipts === null ? "unreadable" : "ready",
			latest,
		},
		operator: {
			source: "operator",
			state: task === null ? "unavailable" : "present",
			status: task?.status ?? null,
			history:
				task === null ? [] : task.history.map((h) => ({ atMs: h.atMs, from: h.from, to: h.to, note: h.note })),
			accepted: lastDone === undefined ? null : { atMs: lastDone.atMs, note: lastDone.note },
		},
		gaps: ENDO_ATTEMPT_EVIDENCE_GAPS_V0.filter((g) => found.has(g)).map((code) => ({
			code,
			text: ENDO_ATTEMPT_EVIDENCE_GAP_TEXT_V0[code],
		})),
		notEstablished: ENDO_ATTEMPT_EVIDENCE_NOT_ESTABLISHED_V0,
	};
}

/** The reading as a few lines of plain text for a terminal: each line says whose it is. */
export function renderEndoAttemptEvidenceV0(e: EndoAttemptEvidenceV0): string {
	const lines = [
		`attempt ${e.attempt.id} (task ${e.attempt.taskId}): ${e.attempt.objective}`,
		`  sent      [observed] ${e.sent.sendLabel}.`,
		`  run       [Pi's report] ${e.sent.runLabel}.`,
		`  candidate [none] no record names one; checked at: ${e.candidate.checkedCommits.length === 0 ? "nothing" : e.candidate.checkedCommits.map((c) => c.slice(0, 12)).join(", ")}`,
		`  tree now  [observed] ${e.checks.current === null ? "unavailable" : `${e.checks.current.commit.slice(0, 12)}${e.checks.current.clean ? ", clean" : ", with uncommitted changes"}`}${e.checks.comparedWith === null ? "" : ` (${e.checks.comparedWith})`}`,
		...e.checks.latest.map(
			(c) =>
				`  check     [observed] ${c.command}: ${c.label} at ${c.commit.slice(0, 12)}; ${c.relationLabel}${c.startedBeforeAuthorization === true ? "; started before the send was authorised" : ""}`,
		),
		`  decision  [operator] ${e.operator.status === null ? "the task cannot be read" : `status ${e.operator.status}`}${e.operator.accepted === null ? "" : `, moved to done${e.operator.accepted.note === null ? "" : ` ("${e.operator.accepted.note}")`}`}`,
		...e.gaps.map((g) => `  gap       ${g.text}`),
		"  not established by any record:",
		...e.notEstablished.map((n) => `    - ${n}`),
	];
	return `${lines.join("\n")}\n`;
}
