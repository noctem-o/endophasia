// The selected task's work attempts, in the Task view: read-only. Each attempt shows its state in the words used everywhere, when it was
// prepared, its objective, what the operator recorded, and whether the task's words changed since; opening one shows the brief, which the
// operator can copy and paste into any coding agent themselves. Copying writes the clipboard and nothing else: it never touches the
// composer, sends nothing, and records nothing. Preparing and recording are the operator's terminal commands (docs/designs/develop-work-attempts.md).
//
// Under each attempt, its verification receipts (docs/designs/develop-verification-receipts.md): what Endophasia observed when the operator
// ran a check in a terminal, at which commit, and how that commit relates to this workbench's working tree now. Read-only: nothing here
// runs a check, and a receipt is never shown as the task's acceptance.
//
// Above them, when the operator authorised sending the attempt's brief to Pi from the live workbench's terminal, what the session's own
// records say happened (docs/designs/develop-attempt-execution.md): sent or not, Pi's reply, and how the run after it ended, as Pi reported
// it. It is a historical reading: nothing here reaches the session, and nothing here can send, re-send or retry an attempt.
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import {
	ATTEMPT_LABELS,
	type Attempt,
	EXECUTION_RUN_LABELS,
	EXECUTION_SEND_LABELS,
	type Execution,
	executionSent,
	RECEIPT_LIMITATION_TEXT,
	RECEIPT_OUTCOME_LABELS,
	RECEIPT_REASON_TEXT,
	RECEIPT_RELATION_LABELS,
	type Receipt,
} from "../model/attempts-wire.ts";
import type { ReceiptFocus } from "../model/attention.ts";
import type { Task } from "../model/workspace-wire.ts";
import { CopyButton, Note } from "../ui/text.tsx";
import type { AttemptsState } from "../use-attempts.ts";

const when = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const short = (id: string): string => id.slice(-8);
const WORDS: Readonly<Record<string, string>> = {
	title: "title",
	description: "description",
	acceptance: "acceptance criteria",
};

export function AttemptsSection({
	attempts,
	task,
	tasksCurrent,
	focus = null,
	onFocused,
	request,
}: {
	attempts: AttemptsState;
	task: Task;
	/** Whether the tasks beside this section are confirmed now: when they are not, neither are the attempts read with them. */
	tasksCurrent: boolean;
	/** A receipt to open once it is shown (from the overview): its attempt is opened and the receipt scrolled to and focused. */
	focus?: ReceiptFocus | null;
	onFocused?(): void;
	/**
	 * Only on the live Pi workbench: the control that asks the attached terminal to approve sending an attempt's brief
	 * (develop/AttemptRequest.tsx). Absent on the workspace host and in Studio, where nothing here can ask for anything.
	 */
	request?: (attempt: Attempt) => ReactNode;
}): ReactElement | null {
	const { view, problem } = attempts;
	const list = useRef<HTMLUListElement>(null);
	// When the attempts of THIS task arrive with the receipt asked for, open its attempt and bring the receipt into view, once.
	useEffect(() => {
		if (focus === null || view === null || view.taskId !== task.id) return;
		const attempt = view.attempts.find((a) => a.id === focus.attemptId);
		if (attempt === undefined || !attempt.receipts.list.some((r) => r.id === focus.receiptId)) return;
		const item = list.current?.querySelector<HTMLElement>(`[data-attempt-id="${focus.attemptId}"]`);
		const details = item?.querySelector("details");
		if (details == null) return;
		details.open = true;
		const receipt = item?.querySelector<HTMLElement>(`[data-receipt-id="${focus.receiptId}"]`);
		if (receipt != null) {
			receipt.dataset.focused = "true";
			receipt.scrollIntoView({ block: "center" });
			receipt.focus({ preventScroll: true });
		}
		onFocused?.();
	}, [focus, view, task.id, onFocused]);
	// A workbench that serves no attempts says nothing about them.
	if (problem === "absent" && view === null) return null;
	const prepare = `endo attempt prepare --root <store> --project ${task.projectId} --task ${task.id} --objective "…"`;
	return (
		<section className="task-block" aria-label="Attempts" data-testid="task-attempts">
			<h3
				title={
					request === undefined
						? "One request you prepared on this task, with its brief. Recorded by you; nothing here sends it or checks a result."
						: "One request you prepared on this task, with its brief. This page can ask to send it; only the attached terminal approves. Nothing here checks a result."
				}
			>
				Attempts{" "}
				<span className="dim task-clause">
					{request === undefined
						? "briefs you prepared; nothing here sends one"
						: "briefs you prepared; sending one is approved in the attached terminal"}
				</span>
			</h3>
			{view === null ? (
				<p className="dim small" data-testid="attempts-pending">
					{problem === null ? "Reading attempts…" : "Attempts could not be read."}
				</p>
			) : (
				<>
					{attempts.current && tasksCurrent ? null : (
						<Note tone="warn">
							<span data-testid="attempts-stale">
								{problem === "unpaired"
									? "As last read: this page no longer holds a pairing."
									: "As last read: nothing could confirm these are still what the store holds."}
							</span>
						</Note>
					)}
					{view.state === "unreadable" ? (
						<p className="dim small" data-testid="attempts-unreadable">
							The attempts, or the task file, cannot be read now. Nothing was changed.
						</p>
					) : view.taskId !== task.id ? (
						<p className="dim small" data-testid="attempts-other-task">
							{view.taskId === null
								? "No task is selected in the store, so no attempts are shown here."
								: "Attempts are shown for the task selected in the store, which is not this one."}{" "}
							endo attempt list shows every task's attempts.
						</p>
					) : view.attempts.length === 0 ? (
						<>
							<p className="dim small" data-testid="attempts-none">
								No attempts for this task. Prepare one in a terminal; it writes a brief and sends nothing:
							</p>
							<pre className="mono task-command">{prepare}</pre>
						</>
					) : (
						<ul className="plain task-refs" data-testid="attempt-list" ref={list}>
							{view.attempts.map((a) => (
								<AttemptItem key={a.id} attempt={a} request={request} />
							))}
						</ul>
					)}
					{view.problems > 0 ? (
						<p className="dim small" data-testid="attempts-problems">
							{view.problems === 1 ? "One file" : `${view.problems} files`} in develop/attempts/ could not be
							used and
							{view.problems === 1 ? " is" : " are"} not shown (endo attempt list names them).
						</p>
					) : null}
				</>
			)}
		</section>
	);
}

function AttemptItem({
	attempt: a,
	request,
}: {
	attempt: Attempt;
	request: ((attempt: Attempt) => ReactNode) | undefined;
}): ReactElement {
	const first = a.objective.split("\n", 1)[0] ?? "";
	return (
		<li data-testid="attempt" data-state={a.state} data-attempt-id={a.id}>
			<details className="attempt">
				<summary>
					<span className="task-ref-head">
						<span className="chip-ref" data-attempt={a.state}>
							{ATTEMPT_LABELS[a.state]}
						</span>
						<span className="mono small" title={a.id}>
							{short(a.id)}
						</span>
						<span className="attempt-objective">{first}</span>
						<span className="dim small">prepared {when(a.preparedAtMs)}</span>
						{a.execution === null ? null : (
							<span className="chip-ref" data-send={a.execution.send} data-testid="attempt-sent-chip">
								{executionSent(a.execution) ? "Sent to Pi" : "Authorised for Pi"}
							</span>
						)}
						<LatestCheck attempt={a} />
					</span>
				</summary>
				<div className="attempt-body">
					{a.taskWordsChanged.length === 0 ? null : (
						<p className="small attempt-changed" data-testid="attempt-task-changed">
							The task's {a.taskWordsChanged.map((w) => WORDS[w]).join(" and ")}{" "}
							{a.taskWordsChanged.length === 1 ? "has" : "have"} changed since this brief was prepared (revision{" "}
							{a.taskRevision}). The brief keeps the words it was prepared with.
						</p>
					)}
					{a.handoff === null ? null : (
						<p className="dim small" data-testid="attempt-handoff">
							You recorded handing it to <span className="mono">{a.handoff.target}</span> (
							{when(a.handoff.recordedAtMs)}){a.handoff.note === null ? "" : `: ${a.handoff.note}`}. That is your
							statement; it does not show the agent read it.
						</p>
					)}
					{a.outcome === null ? null : (
						<div className="small" data-testid="attempt-outcome">
							<p className="dim">
								{a.outcome.kind === "reported"
									? `You recorded what was reported (${when(a.outcome.recordedAtMs)}). Not verified: the task's status is yours to change.`
									: `You abandoned it (${when(a.outcome.recordedAtMs)}).`}
							</p>
							{a.outcome.note === "" ? null : <p className="task-text">{a.outcome.note}</p>}
						</div>
					)}
					{a.execution === null ? null : <ExecutionBlock execution={a.execution} />}
					<div className="attempt-brief-head">
						<span className="dim small">
							Brief: select it, or copy it, and paste it into your agent yourself.
						</span>
						<CopyButton label={`brief ${short(a.id)}`} value={a.brief} />
					</div>
					<textarea
						className="mono task-command attempt-brief"
						data-testid="attempt-brief"
						aria-label={`Brief ${short(a.id)}`}
						readOnly
						rows={14}
						spellCheck={false}
						value={a.brief}
					/>
					{request?.(a)}
					<p className="dim small">
						A copied brief holds your private task text; a clipboard manager may keep it. Record what happened in
						a terminal:
					</p>
					<pre className="mono task-command">
						{`endo attempt handoff --root <store> --attempt ${a.id} --to "<agent>"\nendo attempt report  --root <store> --attempt ${a.id} --note "<what was reported>"\nendo attempt abandon --root <store> --attempt ${a.id}`}
					</pre>
					<Receipts attempt={a} />
				</div>
			</details>
		</li>
	);
}

/** What the session recorded after the operator authorised sending this attempt to Pi. A reading of records, never a live control. */
function ExecutionBlock({ execution: e }: { execution: Execution }): ReactElement {
	return (
		<div className="small attempt-execution" data-testid="attempt-execution" data-send={e.send} data-run={e.run}>
			<p>
				<strong>{EXECUTION_SEND_LABELS[e.send]}</strong>
				{e.refusal === null ? null : <span className="dim"> ({e.refusal})</span>}
				{e.disposition === null ? null : <span className="dim"> (Pi: {e.disposition})</span>}.
			</p>
			{executionSent(e) ? <p data-testid="attempt-run">{EXECUTION_RUN_LABELS[e.run]}.</p> : null}
			<p className="dim">
				You authorised it on the workbench's terminal ({when(e.authorizedAtMs)}), for session{" "}
				<span className="mono">{e.session}</span> on task revision {e.taskRevision}. This is what that session
				recorded, read now: it does not reach the session, and a run Pi reports as completed is not verification.
				{e.evidence === "partial"
					? " Part of the session log could not be read, so later records may be missing."
					: ""}
			</p>
			{e.brief === "differs" ? (
				<p className="attempt-changed" data-testid="attempt-brief-differs">
					This attempt's brief no longer renders as the text that was approved: its record was changed after it was
					authorised.
				</p>
			) : null}
		</div>
	);
}

const commitOf = (sha: string): string => sha.slice(0, 12);

function ended(r: Receipt): string {
	const e = r.execution;
	switch (e.kind) {
		case "exited":
			return `exited with code ${e.code}`;
		case "signaled":
			return `ended by ${e.signal}`;
		case "timed-out":
			return "stopped at its time limit";
		case "interrupted":
			return "interrupted";
		case "output-limit":
			return "went over the output limit";
		case "spawn-failed":
			return "could not be started";
	}
}

/** Why a receipt is inconclusive, beyond how it ended (which the sentence already says). */
function because(r: Receipt): string {
	if (r.outcome !== "inconclusive") return "";
	const rest = r.reasons.filter((x) => x !== r.execution.kind);
	return rest.length === 0
		? "; inconclusive"
		: `; inconclusive because ${rest.map((x) => RECEIPT_REASON_TEXT[x]).join("; ")}`;
}

/** A relation in a few words, for the summary line; the full label is in the receipt's own row. */
const SHORT_RELATION: Readonly<Record<Receipt["relation"], string>> = {
	"at-head": "",
	"at-head-changed": "tree changed since",
	"head-differs": "stale",
	"other-worktree": "other working tree",
	"other-repository": "other repository",
	unavailable: "not compared",
};

/** The newest receipt, in the attempt's one-line summary: its outcome and whether it still applies here. */
function LatestCheck({ attempt: a }: { attempt: Attempt }): ReactElement | null {
	const last = a.receipts.list.at(-1);
	if (last === undefined) return null;
	return (
		<span className="small" data-testid="attempt-latest-check">
			<span className="chip-ref" data-outcome={last.outcome}>
				{RECEIPT_OUTCOME_LABELS[last.outcome]}
			</span>{" "}
			{last.relation === "at-head" ? null : (
				<span className="dim" data-relation={last.relation}>
					{SHORT_RELATION[last.relation]}
				</span>
			)}
		</span>
	);
}

function Receipts({ attempt: a }: { attempt: Attempt }): ReactElement {
	const { receipts } = a;
	return (
		<div className="attempt-receipts" data-testid="attempt-receipts">
			<h4 className="small">
				Checks Endophasia observed{" "}
				<span className="dim task-clause">what ran, at which commit; not the task's acceptance</span>
			</h4>
			{receipts.state === "unreadable" ? (
				<p className="dim small" data-testid="receipts-unreadable">
					This attempt's receipts cannot be read now. Nothing was changed.
				</p>
			) : receipts.list.length === 0 ? (
				<p className="dim small" data-testid="receipts-none">
					No checks recorded for this attempt.
				</p>
			) : (
				<ul className="plain task-refs" data-testid="receipt-list">
					{receipts.list.map((r) => (
						<ReceiptItem key={r.id} receipt={r} />
					))}
				</ul>
			)}
			{receipts.problems > 0 ? (
				<p className="dim small" data-testid="receipts-problems">
					{receipts.problems === 1 ? "One file" : `${receipts.problems} files`} in this attempt's receipts could
					not be used and {receipts.problems === 1 ? "is" : "are"} not shown (endo attempt receipts names them).
				</p>
			) : null}
			<p className="dim small">
				Run a check yourself in a terminal, at the top of a clean, committed working tree; it runs your command, not
				one from a brief or an agent:
			</p>
			<pre className="mono task-command">
				{`endo attempt check --root <store> --attempt ${a.id} -- <command> [args...]\nendo attempt receipts --root <store> --attempt ${a.id}`}
			</pre>
		</div>
	);
}

function ReceiptItem({ receipt: r }: { receipt: Receipt }): ReactElement {
	return (
		<li
			data-testid="receipt"
			data-outcome={r.outcome}
			data-relation={r.relation}
			data-receipt-id={r.id}
			tabIndex={-1}
			aria-label={`${RECEIPT_OUTCOME_LABELS[r.outcome]}: ${r.argv.join(" ")}`}
		>
			<span className="task-ref-head">
				<span className="chip-ref" data-outcome={r.outcome}>
					{RECEIPT_OUTCOME_LABELS[r.outcome]}
				</span>
				<span className="mono small" title={r.commit}>
					{commitOf(r.commit)}
				</span>
				<span className="dim small">{when(r.startedAtMs)}</span>
			</span>
			<p className="small mono receipt-argv" data-testid="receipt-argv">
				{r.argv.join(" ")}
			</p>
			<p className="small" data-testid="receipt-facts">
				It {ended(r)}
				{because(r)}.
			</p>
			<p className={r.relation === "at-head" ? "dim small" : "small attempt-changed"} data-testid="receipt-relation">
				{RECEIPT_RELATION_LABELS[r.relation]}.
			</p>
			<details className="receipt-limits">
				<summary className="dim small">What this does not show</summary>
				<ul className="small">
					{r.limitations.map((l) => (
						<li key={l}>{RECEIPT_LIMITATION_TEXT[l]}</li>
					))}
				</ul>
			</details>
		</li>
	);
}
