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

/**
 * v1 (EVIDENCE-INTEGRITY-001): `sent.authorizationRecord` says whether the authorisation record is recorded, absent or damaged. In v0 a
 * damaged record read as absent, so `authorizedAtMs: null` claimed "never authorised"; in v1 it means only "no readable record", and the
 * record's state says which. A new major version, so a v0 reader is not silently given the wider meaning.
 */
export const ENDO_ATTEMPT_EVIDENCE_SCHEMA_V0 = "endo.develop-attempt-evidence.v1";

/**
 * What this reading found missing, stale, unconfirmed or not yet decided, in a fixed order. Each is a fact about the records, never a
 * verdict on the work.
 */
export const ENDO_ATTEMPT_EVIDENCE_GAPS_V0 = [
	"authorization-record-damaged",
	"not-authorized",
	"execution-evidence-incomplete",
	"send-not-confirmed",
	"run-not-completed",
	"brief-changed-since-authorization",
	"task-words-changed",
	"operator-statement-damaged",
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
	"task-unavailable",
	"not-accepted",
] as const;
export type EndoAttemptEvidenceGapV0 = (typeof ENDO_ATTEMPT_EVIDENCE_GAPS_V0)[number];

export const ENDO_ATTEMPT_EVIDENCE_GAP_TEXT_V0: Readonly<Record<EndoAttemptEvidenceGapV0, string>> = Object.freeze({
	"authorization-record-damaged":
		"A file at this attempt's authorisation record's name is not a usable record. Whether a send was authorised is unknown, and nothing in the session log is attributed to this attempt.",
	"not-authorized":
		"No send to Pi was authorised on the workbench terminal for this attempt. Anything said about handing it over is the operator's statement.",
	"execution-evidence-incomplete":
		"The session log could not be read in full, so what happened after the authorisation may be missing from this reading.",
	"send-not-confirmed": "The send was authorised, but Pi's acceptance of it is not recorded.",
	"run-not-completed": "No run that Pi reported as completed is attributed to this send.",
	"brief-changed-since-authorization":
		"The brief rendered now differs from the one the operator approved (its digest does not match).",
	"task-words-changed": "The task's words have changed since the attempt was prepared.",
	"operator-statement-damaged":
		"A file at this attempt's handoff or outcome record's name is not a usable record: what the operator recorded there cannot be read, and is not shown as absent.",
	"receipts-unreadable": "This attempt's receipts could not be read; no check is shown.",
	"receipt-files-unusable":
		"Some files in this attempt's receipts directory are not usable receipts (damaged or unreadable): a check they recorded, a failure among them, is not shown.",
	"no-check": "No check has been recorded for this attempt.",
	"no-check-after-authorization":
		"Every check recorded for this attempt ended before the send was authorised (by the records' clocks): none was run after the send.",
	"current-tree-unavailable":
		"The working tree could not be observed now, so no check is related to its current state.",
	"current-tree-changed": "The working tree has uncommitted changes now; no check covers them.",
	"no-check-at-current-head":
		"No check was recorded at the working tree's current HEAD: the current revision is unchecked.",
	"check-not-passed-at-current-head": "A check at the current HEAD did not pass (it failed, or was inconclusive).",
	"stale-check":
		"For at least one command, the latest check was at another commit: that command has not been run at the current HEAD.",
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
	"That each record was written only by its named writer: they are local, unsigned files, and anything that can write the store can write them.",
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
	/**
	 * By the records' own clocks, the check against the authorisation: `before` (it ended before), `overlapping` (it started before and ended
	 * after), `after` (it started after); null when nothing was authorised. Orders records; attributes nothing.
	 */
	authorization: "before" | "overlapping" | "after" | null;
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
	/** The broker's records: the operator's authorisation on the workbench terminal, and the send as recorded. */
	sent: {
		source: "observed";
		/**
		 * `recorded`: a valid authorisation record. `absent`: no file at its name, in an attempts directory that was read. `damaged`: a file at
		 * exactly its name is not a usable record, so whether the send was authorised is unknown.
		 */
		authorizationRecord: "recorded" | "absent" | "damaged";
		/** null: no readable authorisation record (see `authorizationRecord` for which). */
		authorizedAtMs: number | null;
		/**
		 * Only for a damaged record and a whole session log: workbench sends that no readable authorisation accounts for, by exact proposal
		 * id. Plain prompts or this attempt's send; none is attributed.
		 */
		unattributedWorkbenchSends: number | null;
		/** The store's reasons for the files at this attempt's record names that are not usable (no contents). */
		damaged: { record: "handoff" | "outcome" | "authorized"; reason: string }[];
		approvedOn: "workbench-terminal" | null;
		session: string | null;
		send: EndoDevelopAttemptExecutionViewV0["send"] | null;
		sendLabel: string;
		evidence: EndoDevelopAttemptExecutionViewV0["evidence"] | null;
		brief: EndoDevelopAttemptExecutionViewV0["brief"] | null;
	};
	/** What Pi reported, as the session log holds it: its reply to the send, and how the attributed run ended. Not verification. */
	pi: {
		source: "pi-report" | "none";
		disposition: EndoDevelopAttemptExecutionViewV0["disposition"];
		run: EndoDevelopAttemptExecutionViewV0["run"] | null;
		runLabel: string;
	};
	candidate: {
		source: "none";
		recorded: false;
		text: string;
		/** The commits the operator ran checks at for this attempt, oldest first: where checks ran, not what the attempt produced. */
		checkedCommits: string[];
	};
	/** Observed by Endophasia; each receipt's link to this attempt is the operator's (`linkedBy`). */
	checks: {
		source: "observed";
		linkedBy: "operator";
		/** The working tree the checks were compared with, as the reader chose it; null when none could be. */
		comparedWith: string | null;
		current: { commit: string; clean: boolean } | null;
		receipts: number;
		problems: number;
		state: "ready" | "unreadable";
		/** The latest receipt of each distinct check, one at the current HEAD first where there is one (develop-attention.ts). */
		latest: EndoAttemptEvidenceCheckV0[];
	};
	/** The task file: the operator's moves, as far as it records them (no actor is recorded; see notEstablished). */
	operator: {
		source: "operator";
		state: "present" | "unavailable";
		status: EndoDevelopTaskStatusV0 | null;
		history: EndoDevelopStatusChangeV0[];
		/** The last move to `done`, if the task is done now. */
		movedToDone: { atMs: number; note: string | null } | null;
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

	const authorizationRecord = report.records.authorized;
	if (authorizationRecord === "damaged") found.add("authorization-record-damaged");
	else if (x === null) found.add("not-authorized");
	else {
		if (x.evidence !== "complete") found.add("execution-evidence-incomplete");
		if (x.send !== "runtime-accepted") found.add("send-not-confirmed");
		if (x.run !== "completed") found.add("run-not-completed");
		if (x.brief !== "matches") found.add("brief-changed-since-authorization");
	}
	if (report.taskWordsChanged.length > 0) found.add("task-words-changed");
	if (report.records.handoff === "damaged" || report.records.outcome === "damaged")
		found.add("operator-statement-damaged");

	const all = input.receipts ?? [];
	const receipts = all.map((r) => r.receipt);
	const relationOf = new Map(all.map((r) => [r.receipt.id, r.relation]));
	const order = (r: EndoDevelopReceiptV0): EndoAttemptEvidenceCheckV0["authorization"] =>
		x === null
			? null
			: r.endedAtMs < x.authorizedAtMs
				? "before"
				: r.startedAtMs < x.authorizedAtMs
					? "overlapping"
					: "after";
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
			authorization: order(r),
			others: c.others,
		};
	});

	if (input.receipts !== null && input.receiptProblems > 0) found.add("receipt-files-unusable");
	if (input.receipts === null) found.add("receipts-unreadable");
	else if (receipts.length === 0) found.add("no-check");
	else {
		if (x !== null && receipts.every((r) => order(r) === "before")) found.add("no-check-after-authorization");
		if (current === null) found.add("current-tree-unavailable");
		else {
			if (!current.clean) found.add("current-tree-changed");
			const atHead = receipts.filter((r) => AT_HEAD.includes(relationOf.get(r.id) as EndoReceiptRelationV0));
			if (atHead.length === 0) found.add("no-check-at-current-head");
			else if (latest.some((c) => AT_HEAD.includes(c.relation) && c.outcome !== "passed"))
				found.add("check-not-passed-at-current-head");
			if (latest.some((c) => c.relation === "head-differs")) found.add("stale-check");
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
			authorizationRecord,
			authorizedAtMs: x?.authorizedAtMs ?? null,
			unattributedWorkbenchSends: authorizationRecord === "damaged" ? report.unattributedWorkbenchSends : null,
			damaged: report.damaged.flatMap((p) => {
				const kind = /\.(handoff|outcome|authorized)\.json$/.exec(p.name)?.[1] as
					| "handoff"
					| "outcome"
					| "authorized"
					| undefined;
				return kind === undefined ? [] : [{ record: kind, reason: p.reason }];
			}),
			approvedOn: x === null ? null : "workbench-terminal",
			session: x?.session ?? null,
			send: x?.send ?? null,
			sendLabel:
				authorizationRecord === "damaged"
					? "Unknown: this attempt's authorisation record is damaged, so whether a send was authorised cannot be read"
					: x === null
						? "No send to Pi through the workbench was authorised for this attempt"
						: ENDO_ATTEMPT_SEND_LABELS_V0[x.send],
			evidence: x?.evidence ?? null,
			brief: x?.brief ?? null,
		},
		pi: {
			source: x === null ? "none" : "pi-report",
			disposition: x?.disposition ?? null,
			run: x?.run ?? null,
			runLabel:
				authorizationRecord === "damaged"
					? "No run is attributed: the authorisation record cannot be read"
					: x === null
						? "No run is attributed: no send through the workbench was authorised"
						: ENDO_ATTEMPT_RUN_LABELS_V0[x.run],
		},
		candidate: {
			source: "none",
			recorded: false,
			text: "No record names a candidate revision for this attempt. The commits below are where the operator ran checks for it; the link from a check to the attempt is the operator's.",
			checkedCommits,
		},
		checks: {
			source: "observed",
			linkedBy: "operator",
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
			movedToDone: lastDone === undefined ? null : { atMs: lastDone.atMs, note: lastDone.note },
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
	const short = (c: string) => c.slice(0, 12);
	const order = {
		before: "; ended before the send was authorised",
		overlapping: "; ran while the send was authorised",
		after: "",
		none: "",
	};
	const lines = [
		`attempt ${e.attempt.id} (task ${e.attempt.taskId}): ${e.attempt.objective}`,
		...(e.attempt.handoff === null
			? []
			: [`  handoff   [operator] said they handed it to ${e.attempt.handoff.target}`]),
		...(e.attempt.outcome === null
			? []
			: [
					`  outcome   [operator] ${e.attempt.outcome.kind === "reported" ? `recorded as reported, not verified: ${e.attempt.outcome.note}` : `recorded as abandoned${e.attempt.outcome.note === "" ? "" : `: ${e.attempt.outcome.note}`}`}`,
				]),
		`  sent      [${e.sent.authorizationRecord === "damaged" ? "unknown" : "observed"}] ${e.sent.sendLabel}.`,
		...e.sent.damaged.map(
			(d) =>
				`  damaged   [observed] this attempt's ${d.record} record is not usable (${d.reason}); it is not read as absent`,
		),
		...(e.sent.unattributedWorkbenchSends === null
			? []
			: [
					`  log       [observed] ${e.sent.unattributedWorkbenchSends} workbench send(s) in the session log are accounted for by no readable authorisation; none is attributed to this attempt`,
				]),
		`  run       [${e.pi.source === "none" ? "none" : "Pi's report"}] ${e.pi.runLabel}.`,
		`  candidate [none] no record names one; checked at: ${e.candidate.checkedCommits.length === 0 ? "nothing" : e.candidate.checkedCommits.map(short).join(", ")}`,
		`  tree now  [observed] ${e.checks.current === null ? "unavailable" : `${short(e.checks.current.commit)}${e.checks.current.clean ? ", clean" : ", with uncommitted changes"}`}${e.checks.comparedWith === null ? "" : ` (${e.checks.comparedWith})`}`,
		...e.checks.latest.map(
			(c) =>
				`  check     [observed; linked to this attempt by the operator] ${c.command}: ${c.label} at ${short(c.commit)}; ${c.relationLabel}${order[c.authorization ?? "none"]}`,
		),
		...(e.checks.problems === 0
			? []
			: [`  receipts  [observed] ${e.checks.problems} file(s) are not usable receipts and are not shown`]),
		`  decision  [operator] ${e.operator.status === null ? "the task cannot be read" : `status ${e.operator.status}`}${e.operator.movedToDone === null ? "" : `, moved to done${e.operator.movedToDone.note === null ? "" : ` ("${e.operator.movedToDone.note}")`}`}`,
		...e.gaps.map((g) => `  gap       ${g.text}`),
		"  not established by any record:",
		...e.notEstablished.map((n) => `    - ${n}`),
	];
	return `${lines.join("\n")}\n`;
}
