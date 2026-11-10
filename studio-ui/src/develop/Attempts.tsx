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
//
// An attempt prepared with a verification plan (docs/designs/develop-verification-plans.md) opens on its acceptance ledger: each criterion
// as the plan lists it, with what has been observed at the current HEAD for the checks the plan says address it, or that it rests on the
// operator's judgment. The body is ordered by the operator's questions: what is established, what was run, what happened, then the brief.
// Nothing here runs a check; each planned check shows the exact terminal command that would.
//
// Between the ledger and the checks, when the attempt was authorised or observed: what Git showed of the working tree around it, and
// whether the tree now and each commit checked hold the same content as the last observation (Provenance.tsx). Never authorship.
import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import {
	ATTEMPT_LABELS,
	type Attempt,
	type AttemptsView,
	behaviourOutcome,
	CRITERION_LABELS,
	CRITERION_TEXT,
	EXECUTION_RUN_LABELS,
	EXECUTION_SEND_LABELS,
	type Execution,
	executionSent,
	firstDifference,
	PLANNED_CHECK_LABELS,
	RECEIPT_LIMITATION_TEXT,
	RECEIPT_OUTCOME_LABELS,
	RECEIPT_REASON_TEXT,
	RECEIPT_RELATION_LABELS,
	type Receipt,
	type Verification,
} from "../model/attempts-wire.ts";
import type { ReceiptFocus } from "../model/attention.ts";
import type { Task } from "../model/workspace-wire.ts";
import { CopyButton, Note } from "../ui/text.tsx";
import type { AttemptsState } from "../use-attempts.ts";
import { Provenance } from "./Provenance.tsx";

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
			// With a plan, the receipt list is itself a disclosure inside the attempt: open every one around the receipt, or it stays hidden.
			for (
				let d = receipt.closest("details");
				d !== null && item?.contains(d);
				d = d.parentElement?.closest("details") ?? null
			)
				d.open = true;
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
						<>
							<Head head={view.head} />
							<ul className="plain task-refs" data-testid="attempt-list" ref={list}>
								{view.attempts.map((a) => (
									<AttemptItem key={a.id} attempt={a} request={request} />
								))}
							</ul>
						</>
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
						{a.verification === null ? (
							<LatestCheck attempt={a} />
						) : (
							<PlanSummary verification={a.verification} />
						)}
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
					{a.verification === null ? (
						<p className="dim small" data-testid="attempt-no-plan">
							Prepared without a verification plan, so which acceptance criteria a check addresses is not
							recorded: each check below stands alone. A plan is given when an attempt is prepared (
							<span className="mono">--plan-file</span>).
						</p>
					) : (
						<Acceptance attempt={a} verification={a.verification} />
					)}
					{a.provenance === null ? null : <Provenance provenance={a.provenance} attemptId={a.id} />}
					<Receipts attempt={a} />
					{a.execution === null ? null : <ExecutionBlock execution={a.execution} />}
					{request?.(a)}
					<details
						className="attempt-brief-block"
						data-testid="attempt-brief-block"
						open={a.state === "prepared" && a.receipts.list.length === 0}
					>
						<summary className="small">
							Brief{" "}
							<span className="dim">what the agent is given; select or copy it to paste into your agent</span>
						</summary>
						<div className="attempt-brief-head">
							<CopyButton label={`brief ${short(a.id)}`} value={a.brief} />
							<span className="dim small">
								A copied brief holds your private task text; a clipboard manager may keep it.
							</span>
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
					</details>
					<p className="dim small">Record what happened in a terminal:</p>
					<pre className="mono task-command">
						{`endo attempt handoff --root <store> --attempt ${a.id} --to "<agent>"\nendo attempt report  --root <store> --attempt ${a.id} --note "<what was reported>"\nendo attempt abandon --root <store> --attempt ${a.id}`}
					</pre>
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
	const list =
		receipts.list.length === 0 ? null : (
			<ul className="plain task-refs" data-testid="receipt-list">
				{receipts.list.map((r) => {
					// A receipt of a behavioural check: its label is its exit status; the plan reads it by what it did, said beside it.
					const planned = a.verification?.checks.find(
						(c) =>
							c.behaviour !== null && c.argv.length === r.argv.length && c.argv.every((x, i) => x === r.argv[i]),
					);
					return (
						<ReceiptItem
							key={r.id}
							receipt={r}
							behaviour={
								planned?.behaviour == null
									? null
									: { name: planned.name, outcome: behaviourOutcome(r, planned.behaviour.expected) }
							}
						/>
					);
				})}
			</ul>
		);
	return (
		<div className="attempt-receipts" data-testid="attempt-receipts">
			<h4 className="small">
				Checks Endophasia observed{" "}
				<span className="dim task-clause">what ran, at which commit; not the task's acceptance</span>
			</h4>
			{a.verification === null ? null : <PlannedChecks attempt={a} verification={a.verification} />}
			{receipts.state === "unreadable" ? (
				<p className="dim small" data-testid="receipts-unreadable">
					This attempt's receipts cannot be read now. Nothing was changed.
				</p>
			) : list === null ? (
				<p className="dim small" data-testid="receipts-none">
					No checks recorded for this attempt.
				</p>
			) : a.verification === null ? (
				list
			) : (
				<details className="receipt-all" data-testid="receipt-all">
					<summary className="small">
						Every check recorded for this attempt ({receipts.list.length})
						{a.verification.unplanned === 0 ? (
							""
						) : (
							<span className="dim" data-testid="receipts-unplanned">
								{" "}
								· {a.verification.unplanned} not in the plan
							</span>
						)}
					</summary>
					{list}
				</details>
			)}
			{receipts.problems > 0 ? (
				<p className="dim small" data-testid="receipts-problems">
					{receipts.problems === 1 ? "One file" : `${receipts.problems} files`} in this attempt's receipts could
					not be used and {receipts.problems === 1 ? "is" : "are"} not shown (endo attempt receipts names them).
				</p>
			) : null}
			<p className="dim small">
				Run a check yourself in a terminal, at the top of a clean, committed working tree; it runs the command you
				type after <span className="mono">--</span>, never one from a record, a brief or an agent:
			</p>
			<pre className="mono task-command">
				{`endo attempt check --root <store> --attempt ${a.id} -- <command> [args...]\nendo attempt receipts --root <store> --attempt ${a.id}`}
			</pre>
		</div>
	);
}

// ---- the plan and its ledger ---------------------------------------------------------------------------------------------------------

/** An argument as a POSIX shell would need it typed: bare when it is plainly safe, else in single quotes. For the command shown to copy. */
const shellWord = (arg: string): string =>
	/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The summary line's count of criteria by state, in the ledger's order of urgency. Counts of the plan's own criteria, nothing more. */
const SUMMARY_ORDER = ["failed", "inconclusive", "not-shown", "unavailable", "passed", "judgment"] as const;
const SUMMARY_WORDS: Readonly<Record<(typeof SUMMARY_ORDER)[number], string>> = {
	failed: "check failed",
	inconclusive: "inconclusive",
	"not-shown": "not shown",
	unavailable: "not compared",
	passed: "checks passed",
	judgment: "your judgment",
};

function PlanSummary({ verification: v }: { verification: Verification }): ReactElement {
	const counts = new Map<string, number>();
	for (const c of v.criteria) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
	const parts = SUMMARY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0);
	return (
		<span className="small plan-summary" data-testid="attempt-plan-summary">
			<span className="dim">{plural(v.criteria.length, "criterion", "criteria")} at HEAD:</span>
			{parts.map((s) => (
				<span key={s} className="plan-count" data-criterion={s}>
					{SUMMARY_WORDS[s]} {counts.get(s)}
				</span>
			))}
		</span>
	);
}

const checkLine = (c: Verification["checks"][number]): string => {
	const at = c.current === null ? "" : ` (${c.current.outcome} at ${commitOf(c.current.commit)})`;
	return `${PLANNED_CHECK_LABELS[c.state]}${c.state === "tree-changed" || c.state === "mixed" ? at : ""}`;
};

/**
 * The one reading of this working tree that every "at HEAD", "stale" and "now" below was compared with: its commit, whether it was clean,
 * and when it was read. The Context panel's changes are a separate read with its own time, so the two can differ for a moment; naming the
 * commit and the time here makes that visible instead of a contradiction.
 */
function Head({ head }: { head: AttemptsView["head"] }): ReactElement | null {
	if (head === null) return null;
	return (
		<p className="dim small attempts-head" data-testid="attempts-head" data-clean={String(head.clean)}>
			{head.commit === null ? (
				<>
					This working tree's HEAD could not be read ({when(head.readAtMs)}), so nothing below is compared with it.
				</>
			) : (
				<>
					Compared with HEAD <span className="mono">{head.commit.slice(0, 12)}</span> of this working tree,{" "}
					{head.clean ? "with nothing uncommitted" : "with uncommitted changes"}, read {when(head.readAtMs)}. The
					Context panel is read separately.
				</>
			)}
		</p>
	);
}

/** The criteria as the plan lists them, each with the state its checks give it. Never "met": coverage is the plan's statement. */
function Acceptance({ attempt: a, verification: v }: { attempt: Attempt; verification: Verification }): ReactElement {
	const byName = new Map(v.checks.map((c) => [c.name, c]));
	return (
		<div className="attempt-acceptance" data-testid="attempt-acceptance">
			<h4 className="small">
				Acceptance{" "}
				<span className="dim task-clause">criteria as listed in your plan, against the HEAD named above</span>
			</h4>
			<ol className="plain acceptance-list" data-testid="acceptance-list">
				{v.criteria.map((c, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: criteria are a fixed, ordered list in an immutable record
						key={i}
						data-testid="criterion"
						data-state={c.state}
						aria-label={`Criterion ${i + 1}: ${CRITERION_LABELS[c.state]}`}
					>
						<span className="criterion-n mono dim" aria-hidden="true">
							{i + 1}
						</span>
						<div className="criterion-body">
							<p className="criterion-text">{c.text}</p>
							<p className="criterion-state small">
								<span className="chip-ref" data-criterion={c.state} title={CRITERION_TEXT[c.state]}>
									{CRITERION_LABELS[c.state]}
								</span>
								{c.checks.length === 0 ? (
									<span className="dim"> no check addresses it in the plan</span>
								) : (
									c.checks.map((name) => {
										const check = byName.get(name);
										return check === undefined ? null : (
											<span key={name} className="criterion-check" data-check-state={check.state}>
												<span className="mono">{name}</span>: {checkLine(check)}
											</span>
										);
									})
								)}
							</p>
						</div>
					</li>
				))}
			</ol>
			<p className="dim small">
				That a check addresses a criterion is your plan's statement; nothing observed establishes it. A pass is a
				command that exited 0 at this commit or, for a check with an expected behaviour, one whose exit code and
				output were the ones you declared; whether the criterion holds is still yours to judge. A receipt records
				the command's exit status and a digest of its output; the comparison with your plan is made when it is read.
				The environment it ran in was inherited and not recorded, so nothing here establishes that it could not
				change the result, or who ran the check.
			</p>
			{a.receipts.problems > 0 ? (
				<p className="small attempt-changed" data-testid="acceptance-receipt-problems">
					Some of this attempt's receipt files could not be read: a later result of a planned check may be among
					them, and is not counted here.
				</p>
			) : null}
			{a.taskWordsChanged.includes("acceptance") ? (
				<p className="small attempt-changed" data-testid="acceptance-task-changed">
					The task's acceptance criteria have changed since this plan was written: compare them with the list
					above.
				</p>
			) : null}
		</div>
	);
}

/** Each planned check: its exact argv, your sentence of what it shows, its state here, and the command that runs it. */
function PlannedChecks({
	attempt: a,
	verification: v,
}: {
	attempt: Attempt;
	verification: Verification;
}): ReactElement {
	if (v.checks.length === 0)
		return (
			<p className="dim small" data-testid="planned-checks-none">
				The plan names no check: every criterion rests on your judgment.
			</p>
		);
	return (
		<ul className="plain planned-checks" data-testid="planned-checks">
			{v.checks.map((c) => {
				const others = c.current === null ? null : c.atHead;
				const disagreeing =
					others === null
						? []
						: (["passed", "failed", "inconclusive"] as const).filter(
								(o) => o !== c.current?.outcome && others[o] > 0,
							);
				return (
					<li key={c.name} data-testid="planned-check" data-state={c.state} data-name={c.name}>
						<span className="task-ref-head">
							<span className="mono planned-name">{c.name}</span>
							<span className="chip-ref" data-check-state={c.state}>
								{PLANNED_CHECK_LABELS[c.state]}
							</span>
							{c.current === null ? null : (
								<span className="mono small" title={c.current.commit}>
									{commitOf(c.current.commit)}
								</span>
							)}
						</span>
						<p className="small mono receipt-argv" data-testid="planned-argv" title="The exact argument list">
							{JSON.stringify(c.argv)}
						</p>
						<p className="small">
							<span className="dim">You said it shows:</span> {c.shows}
						</p>
						{c.behaviour === null ? null : <Behaviour check={c} behaviour={c.behaviour} />}
						{c.state === "tree-changed" && c.current !== null ? (
							<p className="small attempt-changed">
								It {c.current.outcome} at this HEAD; the working tree has changed since, so it is not counted.
							</p>
						) : null}
						{disagreeing.length === 0 ? null : (
							<p className="small attempt-changed" data-testid="planned-disagree">
								At this commit it also{" "}
								{disagreeing
									.map((o) => `${o === "inconclusive" ? "was inconclusive" : o} ${others?.[o]}×`)
									.join(", ")}
								: the latest run is shown, and the results do not agree.
							</p>
						)}
						{c.otherCommit === null ? null : (
							<p className="small dim" data-testid="planned-other-commit">
								At another commit ({commitOf(c.otherCommit.commit)}) its latest run{" "}
								{c.current !== null && c.current.outcome === c.otherCommit.outcome
									? `also ${c.otherCommit.outcome}.`
									: c.current === null
										? `${c.otherCommit.outcome}; it has not run at this HEAD.`
										: `${c.otherCommit.outcome}; what accounts for the difference is not observed.`}
							</p>
						)}
						{c.state === "passed" ? null : (
							<pre className="mono task-command planned-command" data-testid="planned-command">
								{`endo attempt check --root <store> --attempt ${a.id}${c.behaviour === null ? "" : " --keep-output"} -- ${c.argv.map(shellWord).join(" ")}`}
							</pre>
						)}
						{c.state === "passed" || c.behaviour === null ? null : (
							<p className="dim small">
								--keep-output stores the first 8 KiB of its standard output in the receipt, so this page can
								show where it differs; leave it out for a command that can print a secret.
							</p>
						)}
					</li>
				);
			})}
		</ul>
	);
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
const shownLine = (line: string | null): string => (line === null ? "(no such line)" : JSON.stringify(line));

/**
 * A behavioural check: what you declared it should do, and what its latest receipt at this HEAD observed. The digest decides; the kept
 * text, when there is any, only shows where. Your expectation is labelled as yours: it is not ground truth.
 */
function Behaviour({
	check: c,
	behaviour: b,
}: {
	check: Verification["checks"][number];
	behaviour: NonNullable<Verification["checks"][number]["behaviour"]>;
}): ReactElement {
	const o = b.observed;
	const matched = o !== null && o.stdoutSha256 !== null && o.stdoutSha256 === b.expected.stdoutSha256;
	const kept = o?.kept.state === "text" ? o.kept : null;
	const diff = o === null || matched || kept === null ? null : firstDifference(b.expected.stdout, kept.text);
	const expectedBytes = bytesOf(b.expected.stdout);
	return (
		<div className="behaviour small" data-testid="behaviour" data-matched={String(matched)}>
			<p>
				<span className="dim">You declared it should:</span> exit {b.expected.exitCode} and print{" "}
				{expectedBytes === 0 ? "nothing" : `exactly ${expectedBytes} bytes`} on standard output
				<span className="dim"> (compared byte for byte; standard error is not compared)</span>
			</p>
			{expectedBytes === 0 ? null : (
				<details className="behaviour-expected">
					<summary className="dim">Expected output</summary>
					<pre className="mono behaviour-text" data-testid="behaviour-expected">
						{b.expected.stdout}
					</pre>
				</details>
			)}
			{o === null ? null : (
				<p data-testid="behaviour-observed">
					<span className="dim">Observed at {c.current === null ? "HEAD" : commitOf(c.current.commit)}:</span>{" "}
					{o.exitCode === null ? "it did not exit by itself" : `exit ${o.exitCode}`}
					{o.exitCode !== null && o.exitCode !== b.expected.exitCode ? " (not the one declared)" : ""},{" "}
					{o.stdoutBytes} bytes;{" "}
					{o.stdoutSha256 === null ? (
						<span className="attempt-changed">
							{o.kept.state === "not-recorded"
								? "its output was not recorded (an older receipt), so nothing is compared"
								: "its output was not read whole, so nothing is compared"}
						</span>
					) : matched ? (
						<span data-testid="behaviour-same">the output is the one declared</span>
					) : (
						<span className="attempt-changed" data-testid="behaviour-different">
							the output differs from the one declared
						</span>
					)}
				</p>
			)}
			{diff === null ? null : (
				<p className="mono behaviour-diff" data-testid="behaviour-diff">
					line {diff.line}: expected {shownLine(diff.expected)}, observed {shownLine(diff.observed)}
					{kept?.truncated === true ? " (the kept output is cut)" : ""}
				</p>
			)}
			{o !== null && !matched && o.stdoutSha256 !== null && kept === null ? (
				<p className="dim" data-testid="behaviour-not-kept">
					{o.kept.state === "not-text"
						? "The output was kept but is not text, so it is not shown."
						: "The output was not kept: run the check again with --keep-output to see where it differs."}
				</p>
			) : null}
			{kept === null ? null : (
				<details className="behaviour-kept">
					<summary className="dim">Observed output, as kept{kept.truncated ? " (cut at 8 KiB)" : ""}</summary>
					<pre className="mono behaviour-text" data-testid="behaviour-kept">
						{kept.text}
					</pre>
				</details>
			)}
		</div>
	);
}

const BEHAVIOUR_WORDS = {
	passed: "its exit code and output are the ones declared",
	failed: "its exit code or output is not the one declared",
	inconclusive: "its behaviour could not be compared",
} as const;

function ReceiptItem({
	receipt: r,
	behaviour,
}: {
	receipt: Receipt;
	behaviour: { name: string; outcome: keyof typeof BEHAVIOUR_WORDS } | null;
}): ReactElement {
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
			{behaviour === null ? null : (
				<p
					className={behaviour.outcome === "passed" ? "small" : "small attempt-changed"}
					data-testid="receipt-behaviour"
					data-behaviour={behaviour.outcome}
				>
					For the planned check <span className="mono">{behaviour.name}</span>:{" "}
					{BEHAVIOUR_WORDS[behaviour.outcome]}. The label above is its exit status.
				</p>
			)}
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
