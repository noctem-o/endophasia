// The overview in the Task view: every task of the project, attention first (docs/designs/develop-attention.md). It answers "what needs me,
// and why?" from the operator's own statuses and the checks Endophasia observed, classified by model/attention.ts, and nothing else: no
// score, no model, no guess. Each row says what was recorded or observed, why it is here, and opens the task (and the check it is about).
//
// Read-only. Opening a row chooses the task exactly as the picker does: it sends no prompt, selects no session and changes no status; the
// composer's words and unsaved task edits stay where they are. Nothing here runs a check, records anything or accepts a task.
import { type KeyboardEvent, type ReactElement, useState } from "react";
import {
	EVIDENCE_WORDS,
	evidenceOf,
	FLAG_WORDS,
	type Item,
	type Line,
	type Overview,
	overviewOf,
} from "../model/attention.ts";
import { Note } from "../ui/text.tsx";
import type { WorkspaceApi } from "../use-workspace.ts";
import { StatusChip } from "./Tasks.tsx";

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

/** The overview of what the page holds now: the workspace's tasks, and the attention projection when one was read. */
export function overviewFor(workspace: WorkspaceApi): Overview | null {
	const view = workspace.state.view;
	if (view === null || view.state !== "ready") return null;
	const { evidence, record } = evidenceOf(view.launchId, workspace.attention);
	return overviewOf(view.tasks, evidence, record, view.revision);
}

const LINE_TAG: Partial<Record<Line["kind"], string>> = { ...FLAG_WORDS, warn: "Incomplete" };

function LineView({ line }: { line: Line }): ReactElement {
	const tag = LINE_TAG[line.kind];
	return (
		<span className="attn-line" data-kind={line.kind} data-testid="attention-line">
			{tag === undefined ? null : <span className="attn-tag">{tag}</span>}
			<span className="attn-words">
				{line.parts.map((p, i) =>
					typeof p === "string" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed line, in order
						<span key={i}>{p}</span>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed line, in order
						<code key={i} className="mono">
							{p.code}
						</code>
					),
				)}
			</span>
		</span>
	);
}

function Row({ item, onOpen }: { item: Item; onOpen(item: Item): void }): ReactElement {
	return (
		<li>
			<button
				type="button"
				className="attn-row"
				data-testid="attention-row"
				data-task={item.task.id}
				data-section={item.section}
				data-flag={item.flags[0] ?? "none"}
				title={
					item.focus === null
						? "Open this task. Opening it sends nothing and changes no status."
						: "Open this task and the check this row is about. Opening it sends nothing and changes no status."
				}
				onClick={() => onOpen(item)}
			>
				<span className="attn-top">
					<span className="attn-title">{item.task.title}</span>
					<StatusChip status={item.task.status} />
				</span>
				{item.lines.length === 0 ? null : (
					<span className="attn-lines">
						{item.lines.map((line, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a row's lines are derived in a fixed order
							<LineView key={i} line={line} />
						))}
					</span>
				)}
			</button>
		</li>
	);
}

function Group({
	id,
	title,
	hint,
	items,
	empty,
	limit,
	onOpen,
}: {
	id: string;
	title: string;
	hint: string;
	items: Item[];
	empty: string | null;
	/** Show this many, and the rest on request (memory only). */
	limit?: number;
	onOpen(item: Item): void;
}): ReactElement | null {
	const [all, setAll] = useState(false);
	if (items.length === 0 && empty === null) return null;
	const shown = limit === undefined || all ? items : items.slice(0, limit);
	return (
		<section className="attn-group" aria-labelledby={`attn-${id}`} data-testid={`attention-${id}`}>
			<h3 id={`attn-${id}`}>
				{title} <span className="attn-count">({items.length})</span>
				<span className="dim task-clause">{hint}</span>
			</h3>
			{items.length === 0 ? (
				<p className="dim small" data-testid={`attention-${id}-empty`}>
					{empty}
				</p>
			) : (
				<ul className="plain attn-list">
					{shown.map((item) => (
						<Row key={item.task.id} item={item} onOpen={onOpen} />
					))}
				</ul>
			)}
			{shown.length < items.length ? (
				<button
					type="button"
					className="btn quiet small-btn"
					data-testid={`attention-${id}-all`}
					onClick={() => setAll(true)}
				>
					Show all {items.length}
				</button>
			) : null}
		</section>
	);
}

/** Up and down (and j, k, Home, End) move between rows; Enter opens one. Only within the overview, and never while someone types. */
function rowKeys(event: KeyboardEvent<HTMLElement>): void {
	if (event.ctrlKey || event.metaKey || event.altKey) return;
	const step =
		event.key === "ArrowDown" || event.key === "j"
			? 1
			: event.key === "ArrowUp" || event.key === "k"
				? -1
				: event.key === "Home"
					? -Infinity
					: event.key === "End"
						? Infinity
						: 0;
	if (step === 0) return;
	const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".attn-row")].filter(
		(r) => r.offsetParent !== null,
	);
	if (rows.length === 0) return;
	const at = rows.indexOf(document.activeElement as HTMLButtonElement);
	const next =
		step === -Infinity
			? 0
			: step === Infinity
				? rows.length - 1
				: Math.max(0, Math.min(rows.length - 1, at === -1 ? 0 : at + step));
	event.preventDefault();
	rows[next]?.focus();
	rows[next]?.scrollIntoView({ block: "nearest" });
}

export function AttentionOverview({ workspace }: { workspace: WorkspaceApi }): ReactElement | null {
	const overview = overviewFor(workspace);
	if (overview === null) return null;
	const { state, attention } = workspace;
	const view = attention.view;
	const head = view?.head ?? null;
	const current = state.current && attention.current;
	const onOpen = (item: Item) => workspace.open(item.task.id, item.focus);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the row buttons inside it
		<div
			className="attn"
			data-testid="attention-overview"
			data-current={current}
			data-evidence={overview.evidence}
			onKeyDown={rowKeys}
		>
			<header className="attn-head">
				<h2>Overview</h2>
				<span className="dim small" data-testid="attention-head">
					{overview.evidence !== "shown"
						? ""
						: head === null
							? "checks not compared: HEAD not read"
							: `checks compared with HEAD ${head.commit.slice(0, 7)}${head.clean ? "" : " (working tree changed)"}`}
				</span>
			</header>
			{current || state.view === null ? null : (
				<Note tone="warn">
					<span data-testid="attention-stale">
						{!workspace.paired
							? "As last read: this page no longer holds a pairing. Pair it again to read the tasks and checks now."
							: !state.current
								? "As last read: nothing could confirm these are still what the store holds."
								: attention.problem === "refused"
									? "As last read: the workbench refused the last read of the checks (the pairing may have ended)."
									: "As last read: the checks could not be read again just now."}
					</span>
				</Note>
			)}
			{overview.notes.map((n) => (
				<p className="small attempt-changed" key={n} data-testid="attention-note">
					{n}
				</p>
			))}
			{overview.evidence === "shown" ? null : (
				<p className="dim small" data-testid="attention-evidence">
					{EVIDENCE_WORDS[overview.evidence]}
				</p>
			)}
			<Group
				id="needs"
				title="Needs your attention"
				hint="decisions waiting on you; checks whose latest run failed or was inconclusive"
				items={overview.attention}
				empty={
					overview.evidence === "shown"
						? overview.gaps
							? "Nothing is in review, and among the checks that were read, no command's latest observed check failed or was inconclusive. Some tasks below say what could not be read."
							: "Nothing is in review, and no command's latest observed check failed or was inconclusive."
						: "Nothing is in review. Checks are not shown (see above), so this says nothing about them."
				}
				onOpen={onOpen}
			/>
			<Group
				id="waiting"
				title="In progress or blocked"
				hint="statuses you recorded; a blocked task may be waiting on someone else"
				items={overview.waiting}
				empty={null}
				onOpen={onOpen}
			/>
			<Group
				id="open"
				title="Open"
				hint="not started"
				items={overview.open}
				empty={null}
				limit={8}
				onOpen={onOpen}
			/>
			{overview.done.length === 0 ? null : (
				<details className="more attn-done" data-testid="attention-done">
					<summary>
						Done ({overview.done.length}){" "}
						<span className="dim small">old checks of finished tasks are not read</span>
					</summary>
					<ul className="plain attn-list">
						{overview.done.map((item) => (
							<Row key={item.task.id} item={item} onOpen={onOpen} />
						))}
					</ul>
				</details>
			)}
			<p className="dim small attn-foot" data-testid="attention-foot">
				A status is yours; a check is evidence about one command at one commit, not the task's acceptance. Nothing
				here changes a task or runs anything.{" "}
				<span data-testid="attention-read-at">
					{state.readAt === null ? "" : `Tasks read ${clock(state.readAt.getTime())} (browser clock).`}
				</span>{" "}
				<button
					type="button"
					className="btn quiet small-btn"
					data-testid="attention-refresh"
					disabled={state.busy || attention.busy || !workspace.paired}
					onClick={workspace.refresh}
				>
					{state.busy || attention.busy ? "Reading…" : "Refresh"}
				</button>
			</p>
		</div>
	);
}

/** In the worktree bar: how many tasks need the operator, as a way to the overview. Words only, never a colour alone. */
export function AttentionLink({ workspace, onOpen }: { workspace: WorkspaceApi; onOpen(): void }): ReactElement | null {
	const overview = overviewFor(workspace);
	// Not while the checks are being read (a count that grows as they arrive would say less than it seems to), and not from a read that is
	// no longer current (the overview itself says "as last read"; a bare count in the bar could not).
	if (overview === null || overview.evidence === "pending" || overview.attention.length === 0) return null;
	if (!workspace.state.current || !workspace.attention.current || !workspace.paired) return null;
	const n = overview.attention.length;
	return (
		<button
			type="button"
			className="btn quiet small-btn attn-link"
			data-testid="attention-link"
			title="Open the overview: tasks in review, and tasks whose latest observed check failed or was inconclusive."
			onClick={onOpen}
		>
			{n} need{n === 1 ? "s" : ""} attention
		</button>
	);
}
