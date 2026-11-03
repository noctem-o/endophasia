// The selected task's work attempts, in the Task view: read-only. Each attempt shows its state in the words used everywhere, when it was
// prepared, its objective, what the operator recorded, and whether the task's words changed since; opening one shows the brief, which the
// operator can copy and paste into any coding agent themselves. Copying writes the clipboard and nothing else: it never touches the
// composer, sends nothing, and records nothing. Preparing and recording are the operator's terminal commands (docs/designs/develop-work-attempts.md).
import type { ReactElement } from "react";
import { ATTEMPT_LABELS, type Attempt } from "../model/attempts-wire.ts";
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
}: {
	attempts: AttemptsState;
	task: Task;
	/** Whether the tasks beside this section are confirmed now: when they are not, neither are the attempts read with them. */
	tasksCurrent: boolean;
}): ReactElement | null {
	const { view, problem } = attempts;
	// A workbench that serves no attempts says nothing about them.
	if (problem === "absent" && view === null) return null;
	const prepare = `endo attempt prepare --root <store> --project ${task.projectId} --task ${task.id} --objective "…"`;
	return (
		<section className="task-block" aria-label="Attempts" data-testid="task-attempts">
			<h3 title="One request you prepared on this task, with its brief. Recorded by you; nothing here sends it or checks a result.">
				Attempts <span className="dim task-clause">briefs you prepared; nothing here sends one</span>
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
						<ul className="plain task-refs" data-testid="attempt-list">
							{view.attempts.map((a) => (
								<AttemptItem key={a.id} attempt={a} />
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

function AttemptItem({ attempt: a }: { attempt: Attempt }): ReactElement {
	const first = a.objective.split("\n", 1)[0] ?? "";
	return (
		<li data-testid="attempt" data-state={a.state}>
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
					<p className="dim small">
						A copied brief holds your private task text; a clipboard manager may keep it. Record what happened in
						a terminal:
					</p>
					<pre className="mono task-command">
						{`endo attempt handoff --root <store> --attempt ${a.id} --to "<agent>"\nendo attempt report  --root <store> --attempt ${a.id} --note "<what was reported>"\nendo attempt abandon --root <store> --attempt ${a.id}`}
					</pre>
				</div>
			</details>
		</li>
	);
}
