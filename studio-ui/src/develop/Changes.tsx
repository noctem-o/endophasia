// The project context, drawn: a one-line worktree bar, the changed-file inventory (grouped by what is compared), and the diff reader.
// Everything here is a description of a Git working tree that the broker read at a stated time. None of it is a session fact, none of it
// says who made a change, and none of it can change anything: there is no stage, revert or commit anywhere in this file, and a path is
// never typed or built: a file is chosen from the list the broker returned and read by its position in that list.
import { type ReactElement, useEffect, useRef } from "react";
import {
	AREA_WORDS,
	AUTHORSHIP_WORDS,
	COMPARISON_WORDS,
	countParts,
	DIFF_REASON_WORDS,
	findEntry,
	groupFiles,
	hunkLabel,
	hunkRows,
	INCOMPLETE_WORDS,
	neighbour,
	PROBLEM_WORDS,
	REASON_WORDS,
	STATUS_LETTER,
	sameKey,
	shortOid,
	splitPath,
} from "../model/project.ts";
import type { ChangeEntry, Project, ProjectDiff } from "../model/project-wire.ts";
import type { ProjectApi } from "../use-project.ts";

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });

/** What the project area has to say right now, in the one place both the bar and the list read it from. */
export type ProjectView =
	| { kind: "unpaired" }
	| { kind: "unsupported" }
	| { kind: "unread" }
	| { kind: "reading"; previous: Project | null }
	| { kind: "unavailable"; reason: string; project: Project }
	| { kind: "ready"; project: Project };

export function projectView(api: ProjectApi, paired: boolean): ProjectView {
	const { availability, project, reading } = api.state;
	if (availability === "absent") return { kind: "unsupported" };
	if (!paired && project === null) return { kind: "unpaired" };
	if (project === null) return reading ? { kind: "reading", previous: null } : { kind: "unread" };
	if (reading) return { kind: "reading", previous: project };
	if (project.state === "unavailable") return { kind: "unavailable", reason: project.reason ?? "git-failed", project };
	return { kind: "ready", project };
}

/** The line that says where the worktree is and whether what is shown is current. One line, two at most when it must wrap. */
export function WorktreeBar({
	api,
	paired,
	connected,
}: {
	api: ProjectApi;
	paired: boolean;
	connected: boolean;
}): ReactElement | null {
	const view = projectView(api, paired);
	const { state } = api;
	if (view.kind === "unsupported") return null;
	const project = state.project;
	const current = project !== null && state.current && connected && paired;
	const reading = state.reading;
	const refresh = (
		<button
			type="button"
			className="btn small-btn"
			data-testid="project-refresh"
			disabled={reading || !paired}
			onClick={api.refresh}
			title="Read the worktree again with Git. Nothing else is read until you ask."
		>
			{reading ? "Reading…" : view.kind === "unread" ? "Read worktree" : "Refresh worktree"}
		</button>
	);
	let body: ReactElement;
	if (view.kind === "unpaired") body = <span className="dim">Worktree: pair this page to read it.</span>;
	else if (view.kind === "unread") body = <span className="dim">Worktree not read yet.</span>;
	else if (view.kind === "reading" && view.previous === null)
		body = <span className="dim">Reading the worktree with Git…</span>;
	else {
		const shown = view.kind === "reading" ? view.previous : view.project;
		if (shown === null || shown.repository === null) {
			body = (
				<span className="dim" data-testid="project-unavailable">
					{REASON_WORDS[shown?.reason ?? "git-failed"] ?? REASON_WORDS["git-failed"]}
				</span>
			);
		} else {
			const repo = shown.repository;
			const head = shown.head;
			const parts = countParts(shown);
			const unknown = shown.changes.state === "unavailable";
			body = (
				<>
					<span
						className="wt-repo mono"
						title={`${repo.root} (the directory Pi was launched in is inside this worktree)`}
					>
						{repo.label}
						{repo.cwdRelative === "" ? "" : `/${repo.cwdRelative}`}
					</span>
					{repo.worktreeLabel !== repo.label ? (
						<span className="dim" title={repo.root}>
							worktree <span className="mono">{repo.worktreeLabel}</span>
						</span>
					) : null}
					<span data-testid="project-head">
						{head === null ? (
							<span className="dim">head unknown</span>
						) : head.kind === "branch" ? (
							<>
								<span className="dim">branch </span>
								<span className="mono">{head.branch}</span>
							</>
						) : head.kind === "detached" ? (
							<span className="dim">detached HEAD</span>
						) : (
							<>
								<span className="dim">unborn branch </span>
								<span className="mono">{head.branch}</span>
								<span className="dim"> (no commit yet)</span>
							</>
						)}
						{head?.oid ? <span className="mono dim"> {shortOid(head.oid)}</span> : null}
					</span>
					<span data-testid="project-counts" className="wt-counts">
						{unknown ? (
							<span className="dim">changes unknown</span>
						) : parts.length === 0 && shown.changes.counts.exact ? (
							<span>clean</span>
						) : parts.length === 0 ? (
							<span className="dim">changes unknown</span>
						) : (
							parts.map((part, index) => (
								<span key={part.area} data-area={part.area}>
									{index === 0 ? "" : " · "}
									{part.text}
								</span>
							))
						)}
					</span>
				</>
			);
		}
	}
	return (
		<div
			className="worktree-bar"
			data-testid="project-header"
			data-state={view.kind}
			data-current={current ? "yes" : "no"}
			title="The directory Pi was launched in (configured), read with Git. A worktree is a place, not a session."
		>
			<span className="wt-main">{body}</span>
			<span className="wt-tail">
				{project === null ? null : (
					<span className="dim small" data-testid="project-read-at">
						read {clock(project.capturedAtMs)} (broker clock)
					</span>
				)}
				{project !== null && !current && !reading ? (
					<span
						className="chip-stale"
						data-testid="project-not-current"
						title={
							state.problem === "stale"
								? "Git says the worktree has changed since this was read."
								: "Nothing could confirm this is still what the worktree holds."
						}
					>
						{state.problem === "stale" ? "out of date" : "unconfirmed"}
					</span>
				) : null}
				{refresh}
			</span>
			{state.problem === null || reading ? null : (
				<output className="wt-problem small" data-testid="project-problem">
					{PROBLEM_WORDS[state.problem]}
				</output>
			)}
		</div>
	);
}

function Delta({ file }: { file: ChangeEntry }): ReactElement | null {
	if (file.binary === true) return <span className="dim">binary</span>;
	if (file.additions === null || file.deletions === null) return null;
	return (
		<span className="delta mono">
			<span>+{file.additions}</span> <span>−{file.deletions}</span>
		</span>
	);
}

/** The changed-file inventory, in the context column. Choosing a file reads its diff in the centre. */
export function ChangesList({
	api,
	paired,
	connected,
}: {
	api: ProjectApi;
	paired: boolean;
	connected: boolean;
}): ReactElement {
	const view = projectView(api, paired);
	const list = useRef<HTMLDivElement>(null);
	const { state } = api;
	const project = state.project;
	const stale = project !== null && !(state.current && connected && paired);
	// Arrow keys move among the rows; choosing is Enter or Space (a button), so moving never reads a diff. A listener on the list, because
	// the list is a plain container: the keys are only a convenience over buttons that are all reachable by Tab.
	useEffect(() => {
		const box = list.current;
		if (box === null) return;
		const arrows = (event: globalThis.KeyboardEvent) => {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			const rows = [...box.querySelectorAll<HTMLButtonElement>("button.change-row")];
			const at = rows.indexOf(document.activeElement as HTMLButtonElement);
			if (at < 0 || rows.length === 0) return;
			event.preventDefault();
			const to =
				event.key === "Home"
					? 0
					: event.key === "End"
						? rows.length - 1
						: at + (event.key === "ArrowDown" ? 1 : -1);
			rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
		};
		box.addEventListener("keydown", arrows);
		return () => box.removeEventListener("keydown", arrows);
	});
	// The row being read stays in view as j and k step through a long list.
	const selected = state.selection;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the position follows the file chosen, by name
	useEffect(() => {
		list.current
			?.querySelector<HTMLElement>('button.change-row[aria-pressed="true"]')
			?.scrollIntoView({ block: "nearest" });
	}, [selected?.path, selected?.area]);
	let message: string | null = null;
	if (view.kind === "unpaired") message = "Pair this page to read the worktree and its changes.";
	else if (view.kind === "unsupported") message = "This workbench does not offer worktree reading.";
	else if (view.kind === "unread") message = "Worktree not read yet.";
	else if (view.kind === "reading" && view.previous === null) message = "Reading the worktree with Git…";
	else if (project !== null && project.changes.state === "unavailable")
		message = `Changes: unknown. ${REASON_WORDS[project.changes.reason ?? project.reason ?? "git-failed"] ?? ""}`;
	const files = project?.changes.files ?? [];
	const groups = groupFiles(files);
	return (
		<section className="block changes-block" data-testid="changes" data-stale={stale ? "yes" : "no"}>
			<h3>Changes</h3>
			{message !== null ? (
				<p className="dim small" data-testid="changes-message">
					{message}
				</p>
			) : project !== null && files.length === 0 && project.changes.counts.exact ? (
				<p className="small" data-testid="changes-clean">
					Clean: nothing staged, unstaged or untracked.
				</p>
			) : (
				<div className="changes-list" ref={list}>
					{groups.map((group) => (
						<div key={group.area} className="change-group" data-area={group.area}>
							<h4 title={AREA_WORDS[group.area].compares}>
								{AREA_WORDS[group.area].name}{" "}
								<span className="dim">
									· {AREA_WORDS[group.area].compares} ({project?.changes.counts.exact === false ? "≥" : ""}
									{project?.changes.counts[group.area] ?? group.files.length})
								</span>
							</h4>
							<ul className="plain">
								{group.files.map((file) => {
									const { dir, name } = splitPath(file.path);
									const selected = sameKey(state.selection, { path: file.path, area: file.area });
									const first = files[0] === file;
									return (
										<li key={`${file.area}:${file.id}`}>
											<button
												type="button"
												className="change-row"
												data-testid="change-row"
												data-area={file.area}
												data-status={file.status}
												aria-pressed={selected}
												tabIndex={selected || (state.selection === null && first) ? 0 : -1}
												title={`${file.path}${file.origPath === null ? "" : ` (from ${file.origPath})`}${file.escaped ? " — some characters in the name were replaced to show it safely" : ""}`}
												onClick={() => api.select({ path: file.path, area: file.area })}
											>
												<span className="change-letter" aria-hidden="true">
													{STATUS_LETTER[file.status].letter}
												</span>
												<span className="sr-only">{STATUS_LETTER[file.status].word}: </span>
												<span className="change-name mono">{name}</span>
												<Delta file={file} />
												<span className="change-dir mono dim">
													{file.origPath === null ? dir : `${dir}${name} ← ${file.origPath}`}
													{file.escaped ? " ⚠" : ""}
												</span>
											</button>
										</li>
									);
								})}
							</ul>
						</div>
					))}
					{project?.changes.filesTruncated ? (
						<p className="dim small" data-testid="changes-truncated">
							Only the first {files.length} are listed; counts above include the rest.
						</p>
					) : null}
				</div>
			)}
			{project === null
				? null
				: project.incomplete.map((code) => (
						<p key={code} className="dim small" data-testid={`incomplete-${code}`}>
							{INCOMPLETE_WORDS[code]}
						</p>
					))}
			<p className="dim small authorship">{AUTHORSHIP_WORDS}</p>
		</section>
	);
}

function DiffBody({ diff }: { diff: ProjectDiff }): ReactElement {
	if (diff.state === "unavailable")
		return (
			<p className="diff-note">
				{DIFF_REASON_WORDS[diff.reason ?? "read-failed"] ?? DIFF_REASON_WORDS["read-failed"]}
			</p>
		);
	if (diff.state === "binary") return <p className="diff-note">Binary file: no lines are shown.</p>;
	if (diff.state === "too-large")
		return <p className="diff-note">This file is too large to read here, so it was not read.</p>;
	if (diff.state === "empty")
		return (
			<p className="diff-note">
				No lines differ
				{diff.notes.length > 0
					? ": see the notes above (a mode or name change)"
					: ": an empty file, or a change that is not in the lines"}
				.
			</p>
		);
	return (
		<table className="diff" data-testid="diff-table">
			<caption className="sr-only">
				Unified diff, {COMPARISON_WORDS[diff.comparison]}. Each row has an old line number, a new line number, a
				sign and the text.
			</caption>
			{diff.hunks.map((hunk) => (
				<tbody key={`${hunk.oldStart}:${hunk.newStart}`} className="hunk">
					<tr className="hunk-head">
						<th colSpan={4} scope="colgroup" className="mono">
							{hunkLabel(hunk)}
						</th>
					</tr>
					{hunkRows(hunk).map((row, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reordered
						<tr key={index} className={`diff-row diff-${row.kind}`}>
							<td className="ln mono" aria-hidden="true">
								{row.old ?? ""}
							</td>
							<td className="ln mono" aria-hidden="true">
								{row.new ?? ""}
							</td>
							<td className="sign mono">
								<span aria-hidden="true">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}</span>
								<span className="sr-only">
									{row.kind === "added"
										? "added: "
										: row.kind === "removed"
											? "removed: "
											: row.kind === "note"
												? "note: "
												: "unchanged: "}
								</span>
							</td>
							<td className="code mono">{row.text}</td>
						</tr>
					))}
				</tbody>
			))}
		</table>
	);
}

/** The centre Changes view: one file's diff, with the previous and next file within reach and nothing else in the way. */
export function DiffView({
	api,
	paired,
	connected,
	narrow,
	onBack,
}: {
	api: ProjectApi;
	paired: boolean;
	connected: boolean;
	/** On a narrow screen the list is on another stage, so with nothing selected it is shown here, not a dead end. */
	narrow: boolean;
	onBack(): void;
}): ReactElement {
	const view = projectView(api, paired);
	const { state } = api;
	const { project, diff, selection } = state;
	const scroller = useRef<HTMLDivElement>(null);
	const shownKey = diff.status === "idle" ? null : diff.key;
	// A new file starts at its top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the scroll position resets when the file shown changes
	useEffect(() => {
		scroller.current?.scrollTo({ top: 0, left: 0 });
	}, [shownKey?.path, shownKey?.area]);
	const entry = findEntry(project, selection);
	const files = project?.changes.files ?? [];
	const at = entry === null ? -1 : files.indexOf(entry);
	const prev = neighbour(project, selection, -1);
	const next = neighbour(project, selection, 1);
	const record = diff.status === "ready" ? diff.record : null;
	const refreshButton = (
		<button type="button" className="btn small-btn" onClick={api.refresh} disabled={state.reading || !paired}>
			{state.reading ? "Reading…" : "Refresh worktree"}
		</button>
	);
	let body: ReactElement | null;
	if (view.kind === "unpaired")
		body = <p className="diff-note">Pair this page to read the worktree and its changes.</p>;
	else if (view.kind === "unsupported")
		body = <p className="diff-note">This workbench does not offer worktree reading.</p>;
	else if (selection === null)
		body = (
			<div className="develop-empty" data-testid="diff-empty">
				<h3>No file selected</h3>
				<p>
					{project === null
						? "The worktree has not been read."
						: project.state === "unavailable" || project.changes.state === "unavailable"
							? `Changes unknown: ${REASON_WORDS[project.changes.reason ?? project.reason ?? "git-failed"] ?? REASON_WORDS["git-failed"]}`
							: files.length === 0
								? "Nothing is changed in the worktree."
								: "Choose a changed file in the list to read what it contains."}
				</p>
				{narrow ? <ChangesList api={api} paired={paired} connected={connected} /> : null}
				<p className="dim small">{AUTHORSHIP_WORDS}</p>
			</div>
		);
	else if (diff.status === "loading")
		body = (
			<p className="diff-note" data-testid="diff-loading">
				Reading {selection.path} with Git…
			</p>
		);
	else if (diff.status === "stale")
		body = (
			<div className="diff-note" data-testid="diff-stale">
				<p>
					The worktree changed after {project === null ? "it was read" : clock(project.capturedAtMs)}: this list is
					out of date and this file was not shown.
				</p>
				{refreshButton}
			</div>
		);
	else if (diff.status === "gone")
		body = (
			<div className="diff-note" data-testid="diff-gone">
				<p>That file is no longer in this change list.</p>
			</div>
		);
	else if (diff.status === "failed") body = <p className="diff-note">{PROBLEM_WORDS[diff.problem]}</p>;
	else if (record !== null) body = <DiffBody diff={record} />;
	else body = null;
	return (
		<div className="diff-view" data-testid="diff-view" data-state={diff.status}>
			<div className="diff-bar">
				<div className="diff-title">
					{selection === null ? (
						<span className="dim">Changes</span>
					) : (
						<>
							<span className="mono diff-path" title={selection.path}>
								{splitPath(selection.path).dir}
								<strong>{splitPath(selection.path).name}</strong>
							</span>
							{entry?.origPath != null ? <span className="dim small mono"> ← {entry.origPath}</span> : null}
						</>
					)}
				</div>
				<div className="diff-tools">
					{at >= 0 ? (
						<span className="dim small" data-testid="diff-position">
							{at + 1} of {files.length}
						</span>
					) : null}
					<button
						type="button"
						className="btn small-btn"
						data-testid="diff-prev"
						disabled={prev === null}
						onClick={() => prev !== null && api.select(prev)}
						title="Previous file (k)"
					>
						‹ Prev
					</button>
					<button
						type="button"
						className="btn small-btn"
						data-testid="diff-next"
						disabled={next === null}
						onClick={() => next !== null && api.select(next)}
						title="Next file (j)"
					>
						Next ›
					</button>
					<button
						type="button"
						className="btn small-btn"
						data-testid="diff-back"
						onClick={onBack}
						title="Back to the conversation (Esc)"
					>
						Conversation
					</button>
				</div>
			</div>
			{selection === null ? null : (
				<p className="diff-meta small" data-testid="diff-meta">
					<span data-testid="diff-comparison">
						{record === null ? AREA_WORDS[selection.area].compares : COMPARISON_WORDS[record.comparison]}
					</span>
					{entry === null ? null : (
						<>
							{" · "}
							<Delta file={entry} />
						</>
					)}

					{record?.truncated ? (
						<span> · cut at the display limit: what is shown is the start of the diff</span>
					) : null}
					{record?.longLines ? <span> · some long lines were cut short</span> : null}
					{record?.inventory === "changed" ? (
						<span data-testid="diff-inventory-changed"> · other files changed since this list was read</span>
					) : null}
				</p>
			)}
			{record === null || record.notes.length === 0 ? null : (
				<ul className="plain diff-notes small dim mono">
					{record.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			)}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable from the keyboard to be scrolled */}
			<section className="diff-scroll" ref={scroller} tabIndex={0} aria-label="Diff">
				{body}
			</section>
		</div>
	);
}
