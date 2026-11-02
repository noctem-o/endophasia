// The project and its tasks, drawn: a compact cluster in the worktree bar (the project, whether its directory matches, the task being worked
// on, a picker), the Task view beside Conversation and Changes (details, acceptance criteria, status, session references, history) and a
// block for the Context column. Everything here is the operator's own metadata. A project is not a session, a task is not a prompt, a
// worktree is not an agent, and an agent finishing is not a task done: no control in this file sends a prompt, steers, stops, approves,
// links a session on its own, or moves a status except because the operator pressed the button that asks for exactly that status.
// Choosing a task changes nothing but which task is shown.
import { type KeyboardEvent, type ReactElement, useEffect, useId, useRef, useState } from "react";
import type { Project } from "../model/project-wire.ts";
import {
	associationOf,
	associationWords,
	changedFields,
	editDraft,
	newDraft,
	orderedTasks,
	REFUSAL_WORDS,
	readOnlyWords,
	STATUS_WORDS,
	selectedTask,
	type TaskDraft,
	transitionWords,
} from "../model/workspace.ts";
import type { SessionRef, Task, TaskStatus, Workspace } from "../model/workspace-wire.ts";
import { Note } from "../ui/text.tsx";
import { NEW_TASK, type WorkspaceApi } from "../use-workspace.ts";
import { AttemptsSection } from "./Attempts.tsx";

const LIMITS = { title: 120, text: 4000, note: 280 } as const;
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour12: false });
const whenWords = (ms: number): string => {
	const at = new Date(ms);
	const today = new Date();
	const sameDay = at.toDateString() === today.toDateString();
	return sameDay
		? clock(ms)
		: `${at.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })} ${clock(ms)}`;
};
const shortSession = (alias: string): string => alias.replace(/^endo\.session\./, "");

const GLYPH: Readonly<Record<TaskStatus, string>> = {
	open: "○",
	"in-progress": "◐",
	blocked: "⊘",
	review: "◑",
	done: "●",
};

export function StatusChip({ status }: { status: TaskStatus }): ReactElement {
	return (
		<span className="task-status" data-status={status} data-testid="task-status">
			<span aria-hidden="true">{GLYPH[status]}</span> {STATUS_WORDS[status]}
		</span>
	);
}

/** What the workspace shows when it has no tasks to show, in one place: the bar and the panel read the same sentence. */
type Shown =
	| { kind: "unpaired" }
	| { kind: "absent" }
	| { kind: "reading" }
	| { kind: "unreachable" }
	| { kind: "unreadable"; reason: string }
	| { kind: "unknown-project" }
	| { kind: "ready"; view: Workspace };

function shownOf(workspace: WorkspaceApi): Shown {
	const { state, paired } = workspace;
	if (state.availability === "absent") return { kind: "absent" };
	if (state.view === null) {
		if (!paired) return { kind: "unpaired" };
		return state.problem === null || state.busy ? { kind: "reading" } : { kind: "unreachable" };
	}
	if (state.view.state === "unreadable") return { kind: "unreadable", reason: state.view.reason ?? "unreadable" };
	if (state.view.state === "unknown-project") return { kind: "unknown-project" };
	return { kind: "ready", view: state.view };
}

/** Changes are offered only while the broker said the workspace is writable AND this page still holds the pairing that was read under. */
const canChange = (workspace: WorkspaceApi): boolean =>
	workspace.state.view?.writable === true && workspace.paired && workspace.state.current;

const UNREADABLE_WORDS: Readonly<Record<string, string>> = {
	malformed: "is not valid JSON (a torn write?)",
	"unsupported-version": "is of a version this Endophasia does not read",
	invalid: "does not have the shape this Endophasia reads",
	"too-large": "is larger than the limit",
	"unsafe-path": "is reached through a link or is not a plain file",
	io: "could not be read",
};

/** The standing sentence for a workspace that cannot show tasks. */
export function workspaceSentence(shown: Shown): string | null {
	switch (shown.kind) {
		case "ready":
			return null;
		case "unpaired":
			return "Project and tasks: pair this page to read them.";
		case "absent":
			return "No project is registered for this launch.";
		case "reading":
			return "Reading the project and its tasks…";
		case "unreachable":
			return "The project and its tasks could not be read.";
		case "unreadable":
			return `The task file ${UNREADABLE_WORDS[shown.reason] ?? "cannot be used"}. It was not changed.`;
		case "unknown-project":
			return "This launch names a project that is not in this store.";
	}
}

// ---- the cluster in the worktree bar -----------------------------------------------------------------------------------------------

export function TaskCluster({
	workspace,
	git,
	onDetails,
}: {
	workspace: WorkspaceApi;
	git: Project | null;
	/** Open the Task view (making a new task, or looking at the one chosen). */
	onDetails(): void;
}): ReactElement | null {
	const shown = shownOf(workspace);
	const { state } = workspace;
	if (shown.kind !== "ready") {
		const sentence = shown.kind === "absent" ? "No project" : workspaceSentence(shown);
		return (
			<span className="task-cluster" data-testid="task-cluster" data-state={shown.kind}>
				<span
					className="dim"
					data-testid="task-cluster-note"
					title={
						shown.kind === "absent"
							? "No project is registered for this launch. The Task view says how to register one."
							: undefined
					}
				>
					{sentence}
				</span>
			</span>
		);
	}
	const { view: workspaceView } = shown;
	const project = workspaceView.project;
	const association = associationOf(workspaceView, git);
	const words = association === null ? null : associationWords(association);
	const current = selectedTask(state);
	return (
		<span
			className="task-cluster"
			data-testid="task-cluster"
			data-state="ready"
			data-writable={workspaceView.writable}
		>
			<span
				className="task-project"
				data-testid="project-identity"
				data-tone={words?.tone ?? "unknown"}
				title={`Project ${project?.name ?? ""} (registered by you). ${words?.detail ?? ""}`}
			>
				<span className="task-project-name">{project?.name}</span>
				{words === null ? null : (
					<span className="task-association" data-testid="project-association">
						{words.tone === "attention" ? "⚠ " : words.tone === "ok" ? "✓ " : ""}
						{words.label}
					</span>
				)}
			</span>
			<TaskPicker workspace={workspace} onDetails={onDetails} />
			{current === null ? null : <StatusChip status={current.status} />}
			{!state.current ? (
				<span
					className="chip-stale"
					data-testid="tasks-not-current"
					title="Nothing could confirm these are still what the file holds."
				>
					{state.problem === "unpaired" ? "last read" : "unconfirmed"}
				</span>
			) : null}
		</span>
	);
}

// ---- the picker --------------------------------------------------------------------------------------------------------------------

function TaskPicker({ workspace, onDetails }: { workspace: WorkspaceApi; onDetails(): void }): ReactElement | null {
	const { state } = workspace;
	const view = state.view;
	const [open, setOpen] = useState(false);
	const [index, setIndex] = useState(0);
	const button = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();
	const tasks = view === null ? [] : orderedTasks(view);
	const current = selectedTask(state);
	const writable = canChange(workspace);
	// Items: each task, then "New task" (only where the workspace can be changed).
	const count = tasks.length + (writable ? 1 : 0);

	const close = (refocus: boolean) => {
		setOpen(false);
		if (refocus) button.current?.focus({ preventScroll: true });
	};
	const openAt = (at: number) => {
		setIndex(Math.max(0, Math.min(at, Math.max(0, count - 1))));
		setOpen(true);
	};
	const choose = (at: number) => {
		const task = tasks[at];
		if (task === undefined) {
			if (!writable) return;
			workspace.setComposing(true);
			onDetails();
		} else {
			workspace.setComposing(false);
			workspace.choose(task.id);
		}
		close(true);
	};

	// `t` opens the list from anywhere in the workbench where no one is typing. It only chooses what is shown.
	useEffect(() => {
		const key = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "t" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
			if (document.querySelector("dialog[open]") !== null) return;
			const target = event.target as HTMLElement | null;
			if (target !== null && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable))
				return;
			event.preventDefault();
			button.current?.focus({ preventScroll: true });
			setIndex(
				Math.max(
					0,
					tasks.findIndex((t) => t.id === current?.id),
				),
			);
			setOpen(true);
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [tasks, current?.id]);

	// A click outside closes it; it never traps.
	useEffect(() => {
		if (!open) return;
		list.current?.focus({ preventScroll: true });
		const outside = (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest(`[data-picker="${id}"]`) != null) return;
			setOpen(false);
		};
		document.addEventListener("mousedown", outside);
		return () => document.removeEventListener("mousedown", outside);
	}, [open, id]);

	const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape" || event.key === "Tab") {
			// The picker's own: it must not also leave the view behind it.
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			setIndex((i) => Math.min(count - 1, i + 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setIndex((i) => Math.max(0, i - 1));
		} else if (event.key === "Home") {
			event.preventDefault();
			setIndex(0);
		} else if (event.key === "End") {
			event.preventDefault();
			setIndex(Math.max(0, count - 1));
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			choose(index);
		}
	};

	return (
		<span className="task-picker" data-picker={id}>
			<button
				type="button"
				ref={button}
				className="btn small-btn task-picker-button"
				data-testid="task-picker"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={`${id}-list`}
				title="Choose the task you are working on (T). Choosing a task sends nothing, changes no session or worktree and no status."
				onClick={() =>
					open
						? close(false)
						: openAt(
								Math.max(
									0,
									tasks.findIndex((t) => t.id === current?.id),
								),
							)
				}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						openAt(
							Math.max(
								0,
								tasks.findIndex((t) => t.id === current?.id),
							),
						);
					}
				}}
			>
				<span className="dim">Task </span>
				<span className="task-picker-title" data-testid="task-current-title">
					{current === null ? (tasks.length === 0 ? "none yet" : "none selected") : current.title}
				</span>
				<span aria-hidden="true"> ▾</span>
			</button>
			{open ? (
				<div
					className="task-pop"
					id={`${id}-list`}
					ref={list}
					role="listbox"
					tabIndex={-1}
					aria-label="Tasks"
					aria-activedescendant={`${id}-opt-${index}`}
					data-testid="task-list"
					onKeyDown={onListKey}
				>
					{tasks.length === 0 ? (
						<p className="dim small task-pop-empty" data-testid="task-list-empty">
							No tasks yet.
						</p>
					) : null}
					{tasks.map((task, at) => (
						<div
							key={task.id}
							id={`${id}-opt-${at}`}
							role="option"
							tabIndex={-1}
							aria-selected={task.id === current?.id}
							className="task-opt"
							data-active={at === index}
							data-testid="task-option"
							data-status={task.status}
							onMouseEnter={() => setIndex(at)}
							onClick={() => choose(at)}
							onKeyDown={() => undefined}
						>
							<span className="task-opt-title">{task.title}</span>
							<StatusChip status={task.status} />
						</div>
					))}
					{writable ? (
						<div
							id={`${id}-opt-${tasks.length}`}
							role="option"
							tabIndex={-1}
							aria-selected={false}
							className="task-opt task-opt-new"
							data-active={index === tasks.length}
							data-testid="task-new-option"
							onMouseEnter={() => setIndex(tasks.length)}
							onClick={() => choose(tasks.length)}
							onKeyDown={() => undefined}
						>
							+ New task…
						</div>
					) : null}
				</div>
			) : null}
		</span>
	);
}

// ---- the Task view -----------------------------------------------------------------------------------------------------------------

export function TaskPanel({
	workspace,
	git,
	connected,
}: {
	workspace: WorkspaceApi;
	git: Project | null;
	/** The workbench's connection to its session, as the run strip reads it. */
	connected: boolean;
}): ReactElement {
	const shown = shownOf(workspace);
	const { state } = workspace;
	const sentence = workspaceSentence(shown);
	if (shown.kind !== "ready")
		return (
			<div className="task-scroll" data-testid="task-panel" data-state={shown.kind}>
				<div className="task-empty">
					<h3>{shown.kind === "absent" ? "No project registered" : "Tasks are not shown"}</h3>
					{shown.kind === "absent" ? null : <p data-testid="task-panel-note">{sentence}</p>}
					{shown.kind === "absent" ? (
						<>
							<p className="dim">
								A project is a directory you tell Endophasia is yours to work in. Registering it is an explicit
								act, kept in this store's <span className="mono">develop/</span> directory, and it gives no
								access to anything by itself. Launch the workbench from that same directory (a subdirectory of
								it counts as a different directory).
							</p>
							<pre className="mono task-command">
								{
									"endo project add --name <name> --path <directory>\nendo harness attach --cwd <directory> --control --workbench \\\n  --project <id>"
								}
							</pre>
						</>
					) : null}
					{shown.kind === "unreadable" || shown.kind === "unknown-project" ? (
						<p className="dim">
							Nothing was changed. {shown.kind === "unreadable" ? "Move " : "List the registered projects with "}
							{shown.kind === "unreadable" ? (
								<>
									<span className="mono">develop/tasks.json</span> aside to start a new file; the old one stays
									as it was.
								</>
							) : (
								<span className="mono">endo project list</span>
							)}
						</p>
					) : null}
					{shown.kind === "unreachable" ||
					shown.kind === "unpaired" ||
					shown.kind === "unreadable" ||
					shown.kind === "unknown-project" ? (
						// Also where the file is damaged or the project unknown: once the operator has mended it (or registered the project) they can
						// ask again without reloading, which would discard the words held in unsaved forms.
						<button
							type="button"
							className="btn"
							data-testid="tasks-read-again"
							disabled={!workspace.paired || state.busy}
							onClick={workspace.refresh}
						>
							{state.busy
								? "Reading…"
								: shown.kind === "unreadable" || shown.kind === "unknown-project"
									? "Read again"
									: "Read tasks"}
						</button>
					) : null}
				</div>
			</div>
		);
	const view = shown.view;
	const task = selectedTask(state);
	const writable = canChange(workspace);
	const association = associationOf(view, git);
	const readOnly = readOnlyWords(view);
	// The new-task form is shown where it can be saved; where it cannot, only if the operator already typed words into it (never hide them).
	const wantsNew =
		workspace.composing || view.tasks.length === 0 || (!writable && workspace.drafts[NEW_TASK] !== undefined);
	const showNew = wantsNew && (writable || workspace.drafts[NEW_TASK] !== undefined);
	const refresh = (
		<button
			type="button"
			className="btn quiet small-btn"
			data-testid="tasks-refresh"
			disabled={state.busy || !workspace.paired}
			onClick={workspace.refresh}
		>
			{state.busy ? "Reading…" : "Refresh tasks"}
		</button>
	);
	return (
		<div className="task-scroll" data-testid="task-panel" data-state="ready">
			{!state.current ? (
				<Note tone="warn">
					<span data-testid="tasks-stale-note">
						{state.problem === "unpaired"
							? "This page no longer holds a pairing, so these tasks are as last read and cannot be changed here. Your tasks are saved in the store; the next workbench you pair with shows them, and the endo task command reads and edits them from a terminal."
							: "Nothing could confirm these are still what the file holds. They are as last read."}
					</span>
				</Note>
			) : null}
			{readOnly === null ? null : (
				<Note tone="warn">
					<span data-testid="tasks-read-only">{readOnly}</span>
				</Note>
			)}
			{!connected && state.current ? (
				<p className="dim small" data-testid="task-disconnected">
					The session is not connected. Your tasks are unchanged: a disconnected agent has not necessarily finished
					its work, and nothing here marks a task done.
				</p>
			) : null}
			{state.notice === null ? null : (
				<Note tone="error">
					<span data-testid="task-notice">{REFUSAL_WORDS[state.notice]}</span>{" "}
					<button type="button" className="btn quiet small-btn" onClick={workspace.dismiss}>
						Dismiss
					</button>
				</Note>
			)}
			{showNew ? <TaskForm workspace={workspace} first={view.tasks.length === 0} locked={!writable} /> : null}
			{showNew && writable ? null : view.tasks.length === 0 ? (
				showNew ? null : (
					<p className="dim" data-testid="task-none">
						No tasks yet for {view.project?.name}.
					</p>
				)
			) : task === null ? (
				<div className="task-empty" data-testid="task-none-selected">
					<h3>No task selected</h3>
					<p className="dim">
						Choose one from the Task list in the bar (press <kbd>T</kbd>). A task is what you intend to get done;
						it is not a conversation, and choosing one sends nothing.
					</p>
				</div>
			) : (
				<>
					<TaskDetail key={task.id} task={task} workspace={workspace} writable={writable} connected={connected} />
					<AttemptsSection attempts={workspace.attempts} task={task} tasksCurrent={state.current} />
				</>
			)}
			<p className="dim small task-foot" data-testid="task-foot">
				<span data-testid="tasks-read-at">
					{state.readAt === null ? "" : `read ${clock(state.readAt.getTime())} (browser clock)`}
				</span>{" "}
				{refresh}
			</p>
			{association === null || association.matched || !writable ? null : (
				<p className="dim small" data-testid="task-project-line">
					{associationWords(association).detail}
				</p>
			)}
		</div>
	);
}

function counter(value: string, max: number): ReactElement | null {
	return value.length < max * 0.8 ? null : (
		<span className="dim small task-count" data-over={value.length >= max}>
			{value.length}/{max}
		</span>
	);
}

const FIELD_NAMES = { title: "Title", description: "Description", acceptance: "Acceptance criteria" } as const;

/** A form for the words of a task: create (no task yet) or edit (a task, with a draft held against the words it started from). */
function TaskForm({
	workspace,
	task,
	first,
	locked = false,
}: {
	workspace: WorkspaceApi;
	task?: Task;
	first?: boolean;
	/** The workspace cannot be changed from this page now (read-only, or no pairing): the words stay, and cannot be saved. */
	locked?: boolean;
}): ReactElement {
	const key = task?.id ?? NEW_TASK;
	const draft: TaskDraft = workspace.drafts[key] ?? (task === undefined ? newDraft() : editDraft(task));
	const set = (patch: Partial<TaskDraft>) => workspace.setDraft(key, { ...draft, ...patch });
	const changed = task === undefined ? [] : changedFields(draft);
	const dirty = task === undefined ? draft.title.trim() !== "" : changed.length > 0;
	const title = draft.title.trim();
	const valid = title.length > 0 && title.length <= LIMITS.title && !/[\u0000-\u001f]/.test(draft.title);
	const busy = workspace.state.busy;
	const conflicts = Object.entries(draft.elsewhere) as [keyof typeof FIELD_NAMES, string][];
	// While a save is in flight the words are the ones being sent: the fields cannot change under it, so a success never discards words
	// typed after the request was made (a failure re-opens them untouched).
	const [saving, setSaving] = useState(false);
	const submit = async () => {
		if (saving) return;
		setSaving(true);
		try {
			const ok =
				task === undefined
					? await workspace.create({ ...draft, title })
					: await workspace.update(task, { ...draft, title });
			if (ok) {
				workspace.setDraft(key, null);
				if (task === undefined) workspace.setComposing(false);
			}
		} finally {
			setSaving(false);
		}
	};
	const cancel = () => {
		workspace.setDraft(key, null);
		if (task === undefined) workspace.setComposing(false);
	};
	return (
		<form
			className="task-form"
			data-testid={task === undefined ? "task-create-form" : "task-edit-form"}
			onSubmit={(event) => {
				event.preventDefault();
				if (valid && dirty && !busy && !saving && !locked) void submit();
			}}
		>
			<h3>{task === undefined ? (first === true ? "Create the first task" : "New task") : "Edit task"}</h3>
			{task === undefined ? (
				<p className="dim small">
					A task is what you intend to get done here. It is not a prompt: nothing is sent to the agent when you
					create or choose one. Do not put secrets in a task; it is stored as plain text.
				</p>
			) : null}
			{locked ? (
				<Note tone="warn">
					<span data-testid="task-locked">
						These words cannot be saved from this page now (it is read-only, or no longer paired). They are kept
						here as you typed them; copy them if you need them.
					</span>
				</Note>
			) : null}
			{conflicts.length === 0 ? null : (
				<Note tone="warn">
					<span data-testid="task-conflict">
						{conflicts.map(([field]) => FIELD_NAMES[field]).join(" and ")} also changed elsewhere since you
						started. Your words are kept; saving replaces the other version, which is shown below.
					</span>
				</Note>
			)}
			<label className="task-field">
				<span>Title {counter(draft.title, LIMITS.title)}</span>
				<input
					type="text"
					data-testid="task-title-input"
					value={draft.title}
					maxLength={LIMITS.title}
					readOnly={saving}
					onChange={(event) => set({ title: event.currentTarget.value })}
					// biome-ignore lint/a11y/noAutofocus: only when the operator just asked for a new task
					autoFocus={task === undefined && workspace.composing}
				/>
			</label>
			<label className="task-field">
				<span>Description (optional) {counter(draft.description, LIMITS.text)}</span>
				<textarea
					data-testid="task-description-input"
					rows={4}
					value={draft.description}
					maxLength={LIMITS.text}
					readOnly={saving}
					onChange={(event) => set({ description: event.currentTarget.value })}
				/>
			</label>
			<label className="task-field">
				<span>Acceptance criteria (optional) {counter(draft.acceptance, LIMITS.text)}</span>
				<textarea
					data-testid="task-acceptance-input"
					rows={3}
					value={draft.acceptance}
					maxLength={LIMITS.text}
					readOnly={saving}
					onChange={(event) => set({ acceptance: event.currentTarget.value })}
				/>
			</label>
			{conflicts.map(([field, words]) => (
				<details className="more" key={field} data-testid="task-elsewhere" open>
					<summary>{FIELD_NAMES[field]} elsewhere</summary>
					<p className="task-text">{words === "" ? "(empty)" : words}</p>
				</details>
			))}
			<div className="task-actions">
				<button
					type="submit"
					className="btn primary"
					data-testid="task-save"
					disabled={!valid || !dirty || busy || saving || locked}
				>
					{busy ? "Saving…" : task === undefined ? "Create task" : "Save changes"}
				</button>
				{task === undefined && first === true ? null : (
					<button type="button" className="btn quiet" data-testid="task-cancel" onClick={cancel}>
						Cancel
					</button>
				)}
			</div>
		</form>
	);
}

/** The move that carries the work forward is the primary one; the others are there, and quieter. */
const FORWARD: Readonly<Record<TaskStatus, TaskStatus>> = {
	open: "in-progress",
	"in-progress": "review",
	blocked: "in-progress",
	review: "done",
	done: "open",
};

function TaskDetail({
	task,
	workspace,
	writable,
	connected,
}: {
	task: Task;
	workspace: WorkspaceApi;
	writable: boolean;
	connected: boolean;
}): ReactElement {
	const editing = workspace.drafts[task.id] !== undefined;
	const [note, setNote] = useState("");
	// While a change is in flight the note is the one being recorded: it cannot change under the request, so a success never discards
	// words typed after the button was pressed (a failure re-opens it untouched).
	const [recording, setRecording] = useState(false);
	const busy = workspace.state.busy;
	const ask = async (to: TaskStatus) => {
		if (recording) return;
		setRecording(true);
		try {
			if (await workspace.setStatus(task, to, note.trim())) setNote("");
		} finally {
			setRecording(false);
		}
	};
	return (
		<article className="task-detail" data-testid="task-detail" data-status={task.status}>
			<header className="task-head">
				<h2 data-testid="task-title">{task.title}</h2>
				<StatusChip status={task.status} />
				<span className="dim small">
					updated {whenWords(task.updatedAtMs)} · revision {task.revision}
				</span>
				{writable && !editing ? (
					<button
						type="button"
						className="btn quiet small-btn task-edit"
						data-testid="task-edit"
						onClick={() => workspace.setDraft(task.id, editDraft(task))}
					>
						Edit
					</button>
				) : null}
			</header>

			{editing ? (
				<TaskForm workspace={workspace} task={task} locked={!writable} />
			) : (
				<>
					<section className="task-block" aria-label="Description">
						<h3>Description</h3>
						{task.description === "" ? (
							<p className="dim" data-testid="task-description-empty">
								No description.
							</p>
						) : (
							<p className="task-text" data-testid="task-description">
								{task.description}
							</p>
						)}
					</section>
					<section className="task-block" aria-label="Acceptance criteria">
						<h3>Acceptance criteria</h3>
						{task.acceptance === "" ? (
							<p className="dim" data-testid="task-acceptance-empty">
								None written.
							</p>
						) : (
							<p className="task-text" data-testid="task-acceptance">
								{task.acceptance}
							</p>
						)}
					</section>
				</>
			)}

			<section className="task-block" aria-label="Status" data-testid="task-status-block">
				<h3 title="Yours to record. A run ending, an answer, or a session going away does not change it, and nothing here says the work is correct.">
					Status <span className="dim task-clause">recorded by you; a finished run does not change it</span>
				</h3>
				{writable ? (
					<div className="task-transitions">
						<input
							type="text"
							className="task-note"
							data-testid="task-note"
							placeholder="Note for this change (optional)"
							aria-label="Note for this status change"
							maxLength={LIMITS.note}
							value={note}
							readOnly={recording}
							onChange={(event) => setNote(event.currentTarget.value)}
						/>
						{[...task.next]
							.sort((a, b) => Number(b === FORWARD[task.status]) - Number(a === FORWARD[task.status]))
							.map((to) => (
								<button
									type="button"
									key={to}
									className={
										to === FORWARD[task.status] && task.status !== "done"
											? "btn small-btn primary"
											: "btn small-btn"
									}
									data-testid={`task-to-${to}`}
									disabled={busy || editing}
									title={`Record this task as ${STATUS_WORDS[to].toLowerCase()}. Only you do this; nothing is sent to the agent.`}
									onClick={() => void ask(to)}
								>
									{transitionWords(task.status, to)}
								</button>
							))}
					</div>
				) : (
					<p className="dim small">Status cannot be changed while the workspace is read-only.</p>
				)}
			</section>

			<SessionBlock task={task} workspace={workspace} writable={writable} connected={connected} />

			<details className="more task-history" data-testid="task-history">
				<summary>History ({task.history.length})</summary>
				<ol className="plain">
					{[...task.history].reverse().map((change) => (
						<li key={`${change.atMs}-${change.to}-${change.from ?? "new"}`}>
							<span className="mono dim">{whenWords(change.atMs)}</span>{" "}
							{change.from === null
								? `created as ${STATUS_WORDS[change.to].toLowerCase()}`
								: `${STATUS_WORDS[change.from].toLowerCase()} → ${STATUS_WORDS[change.to].toLowerCase()}`}
							{change.note === null ? null : <span className="task-history-note"> · {change.note}</span>}
						</li>
					))}
				</ol>
			</details>
		</article>
	);
}

function refWords(ref: SessionRef): string {
	if (ref.source === "omp-saved")
		return "A saved Oh My Pi session you linked from the endo CLI. OMP owns it: this workbench neither connects to nor controls it, and does not look for its file, so whether it is still there is not checked here (endo task show --omp-sessions checks).";
	return ref.relation === "current"
		? "Linked in this launch, to the session connected now."
		: "Linked in an earlier launch. Whether that session is still the one attached cannot be verified from here, and nothing connects it to the conversation shown now.";
}

/** The chip: the source first, then what can be said of it. An OMP reference is always saved, never current. */
function refChip(ref: SessionRef): string {
	if (ref.source === "omp-saved") return "OMP · saved reference";
	return ref.relation === "current" ? "Pi · current" : "Pi · earlier launch";
}

function refLabel(ref: SessionRef): string {
	if (ref.source === "omp-saved") return `${ref.alias ?? "omp session"} · dir ${ref.scopeLabel}`;
	return ref.alias === null ? "session" : shortSession(ref.alias);
}

function SessionBlock({
	task,
	workspace,
	writable,
	connected,
}: {
	task: Task;
	workspace: WorkspaceApi;
	writable: boolean;
	connected: boolean;
}): ReactElement {
	const linkable = workspace.state.view?.linkable === true && workspace.paired && workspace.state.current;
	const busy = workspace.state.busy;
	return (
		<section className="task-block" aria-label="Sessions" data-testid="task-sessions">
			<h3 title="Tasks and sessions are separate. A link is a reference you ask for; it cannot control, resume or select a session.">
				Sessions
			</h3>
			{task.sessions.length === 0 ? (
				<p className="dim small" data-testid="task-sessions-none">
					No session linked. Never inferred from a name, a time or a directory.
				</p>
			) : (
				<ul className="plain task-refs">
					{task.sessions.map((ref) => (
						<li
							key={ref.linkId}
							data-relation={ref.relation}
							data-source={ref.source}
							data-testid="task-session-ref"
						>
							<span className="task-ref-head">
								<span className="chip-ref" data-relation={ref.relation} data-source={ref.source}>
									{refChip(ref)}
								</span>
								<span className="mono small" title="A label for the session, not an identifier">
									{refLabel(ref)}
								</span>
								<span className="dim small">
									linked by you, {ref.source === "omp-saved" ? "from the CLI" : "in the workbench"},{" "}
									{whenWords(ref.linkedAtMs)}
								</span>
								{writable ? (
									<button
										type="button"
										className="btn quiet small-btn"
										disabled={busy}
										onClick={() => void workspace.unlink(task, ref.linkId)}
									>
										Remove link
									</button>
								) : null}
							</span>
							<span className="dim small">{refWords(ref)}</span>
						</li>
					))}
				</ul>
			)}
			{writable ? (
				<div className="task-actions">
					<button
						type="button"
						className="btn small-btn"
						data-testid="task-link"
						disabled={busy || !linkable || task.sessions.some((s) => s.relation === "current")}
						title="Records a reference from this task to the session this workbench is connected to. It cannot control, resume or select a session."
						onClick={() => void workspace.link(task)}
					>
						Link the current session
					</button>
					{!connected || !linkable ? (
						<span className="dim small">No connected session to link.</span>
					) : task.sessions.some((s) => s.relation === "current") ? (
						<span className="dim small">The current session is already linked.</span>
					) : null}
				</div>
			) : null}
		</section>
	);
}

// ---- the Context column ------------------------------------------------------------------------------------------------------------

/** The project as three separate facts: what was registered, where this workbench was launched, and what Git says now. */
export function ProjectBlock({
	workspace,
	git,
}: {
	workspace: WorkspaceApi;
	git: Project | null;
}): ReactElement | null {
	const shown = shownOf(workspace);
	if (shown.kind === "absent") return null;
	const sentence = workspaceSentence(shown);
	const view = shown.kind === "ready" ? shown.view : null;
	const project = view?.project ?? null;
	const association = view === null ? null : associationOf(view, git);
	return (
		<section className="block" data-testid="context-project">
			<h3>Project</h3>
			{project === null || view === null || association === null ? (
				<p className="dim small" data-testid="context-project-none">
					{sentence}
				</p>
			) : (
				<>
					<dl className="facts">
						<div className="fact">
							<dt>name</dt>
							<dd>{project.name}</dd>
						</div>
						<div className="fact">
							<dt>registered</dt>
							<dd className="mono path" title={project.path}>
								{project.path}
							</dd>
						</div>
						<div className="fact">
							<dt>launched in</dt>
							<dd>
								{association.launch === "same"
									? "the registered directory"
									: association.launch === "missing"
										? "(the registered directory is gone)"
										: "a different directory"}
							</dd>
						</div>
						<div className="fact">
							<dt>Git, now</dt>
							<dd>
								{
									{
										same: "the worktree recorded at registration",
										different: "a different worktree than recorded",
										unrecorded: "none was recorded at registration",
										unread: "not read yet",
										"not-a-repository": "no repository found there",
									}[association.git]
								}
							</dd>
						</div>
					</dl>
					<p className="dim small">
						A project is a directory you registered, not a session, and it grants no access.{" "}
						{associationWords(association).detail}
					</p>
				</>
			)}
		</section>
	);
}
