// The project and task workspace as the page keeps it: the last good read, what became of the attempts since, and which task the operator is
// working on. Pure: no DOM, no network, no clock but the one a caller passes, no storage. Nothing here is remembered by the page across a
// reload (the broker keeps the tasks and the last chosen one, in the store root's `develop/` directory), and nothing here is an authority:
// it describes metadata the operator wrote, and choosing a task sends no prompt, changes no session, no worktree and no status.
//
// What the state prevents: a failed or unauthorised read does not discard the last good one (the operator keeps what was last confirmed)
// but marks it not current; an edit names the revision it was made against and is never applied to a newer one; and a task's status moves
// only because the operator asked, in the reply of the request that asked for it.
import type { Project } from "./project-wire.ts";
import type { Task, TaskStatus, Workspace, WorkspaceRefusal, WorkspaceReply } from "./workspace-wire.ts";

export type WorkspaceProblem = "unpaired" | "unreachable" | "invalid" | "failed";

export interface WorkspaceState {
	/** `unknown` until the first answer; `absent` when this workbench was started without a project. */
	availability: "unknown" | "absent" | "available";
	busy: boolean;
	/** The last good read. Kept through failures, and marked by `current`. */
	view: Workspace | null;
	current: boolean;
	problem: WorkspaceProblem | null;
	/** The last change the operator asked for, when it was refused. Cleared by the next change or by dismissing it. */
	notice: WorkspaceRefusal | null;
	/** The task the operator chose on this page. `undefined`: none chosen here yet, so the broker's remembered choice stands. */
	chosen: string | null | undefined;
	/** The operator chose a task after the request now in flight was sent: that choice is newer than the request, so its answer must not replace it. */
	choseSinceStart: boolean;
	/** When the last good read arrived (the browser's clock). */
	readAt: Date | null;
	/** Replies older than this are ignored: a slow answer never overwrites a newer one. */
	seq: number;
}

export const initialWorkspace = (): WorkspaceState => ({
	availability: "unknown",
	busy: false,
	view: null,
	current: false,
	problem: null,
	notice: null,
	chosen: undefined,
	choseSinceStart: false,
	readAt: null,
	seq: 0,
});

export type WorkspaceAction =
	| { type: "start"; seq: number }
	| {
			type: "done";
			seq: number;
			reply: WorkspaceReply;
			at: Date;
			change: boolean;
			adopt: boolean;
			keepNotice: boolean;
	  }
	| { type: "choose"; taskId: string | null }
	| { type: "dismiss" }
	/** The grant is gone: what was read stays, marked not current. */
	| { type: "unpair" }
	/** A different launch is a different process: nothing carries over. */
	| { type: "reset" };

export function reduceWorkspace(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
	switch (action.type) {
		case "start":
			return { ...state, busy: true, seq: action.seq, choseSinceStart: false };
		case "done": {
			if (action.seq !== state.seq) return state;
			const { reply } = action;
			if (reply.kind === "absent") return { ...state, busy: false, availability: "absent" };
			if (reply.kind === "workspace") {
				const view = reply.record;
				// Creating adopts the new task, unless the operator chose another task while the request was out: the later choice wins.
				const chosen =
					action.adopt && !state.choseSinceStart
						? view.selectedTaskId
						: state.chosen != null && !view.tasks.some((t) => t.id === state.chosen)
							? undefined
							: state.chosen;
				return {
					...state,
					busy: false,
					availability: "available",
					view,
					current: true,
					problem: null,
					notice: action.keepNotice ? state.notice : null,
					chosen,
					readAt: action.at,
				};
			}
			if (action.change) return { ...state, busy: false, notice: reply.code };
			// A read that failed: what was last confirmed stays, marked not current.
			const problem: WorkspaceProblem =
				reply.code === "grant-required"
					? "unpaired"
					: reply.code === "unreachable"
						? "unreachable"
						: reply.code === "invalid"
							? "invalid"
							: "failed";
			return { ...state, busy: false, current: false, problem };
		}
		case "choose":
			return { ...state, chosen: action.taskId, choseSinceStart: true };
		case "dismiss":
			return { ...state, notice: null };
		case "unpair":
			return { ...state, current: false, problem: state.view === null ? state.problem : "unpaired" };
		case "reset":
			return initialWorkspace();
	}
}

/** The task the operator is working on: their choice on this page, else the one the broker remembers. */
export function selectedTask(state: WorkspaceState): Task | null {
	const view = state.view;
	if (view === null) return null;
	const want = state.chosen !== undefined ? state.chosen : view.selectedTaskId;
	return want === null ? null : (view.tasks.find((t) => t.id === want) ?? null);
}

export const STATUS_WORDS: Readonly<Record<TaskStatus, string>> = {
	open: "Open",
	"in-progress": "In progress",
	blocked: "Blocked",
	review: "In review",
	done: "Done",
};

/** The words on the button that asks for a status. The operator is asking; nothing else ever moves a status. */
export function transitionWords(from: TaskStatus, to: TaskStatus): string {
	if (to === "in-progress") return from === "open" ? "Start work" : from === "blocked" ? "Unblock" : "Back to work";
	if (to === "review") return "Ready for review";
	if (to === "done") return "Mark done";
	if (to === "blocked") return "Mark blocked";
	return from === "done" ? "Reopen" : "Back to open";
}

const ORDER: Readonly<Record<TaskStatus, number>> = { "in-progress": 0, review: 1, blocked: 2, open: 3, done: 4 };
/** Work in hand first, finished work last; within a status the most recently touched first. */
export const orderedTasks = (view: Workspace): Task[] =>
	[...view.tasks].sort(
		(a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id),
	);

// ---- the project's association -----------------------------------------------------------------------------------------------------

export type GitMatch = "same" | "different" | "unrecorded" | "unread" | "not-a-repository";
export interface Association {
	launch: "same" | "different" | "missing";
	git: GitMatch;
	/** The registered directory is the one this workbench was launched in, and Git does not say it is a different worktree. */
	matched: boolean;
}

const NOT_A_REPOSITORY = ["not-a-repository", "bare-repository", "no-directory", "scope-mismatch"];

/**
 * Three facts, kept apart: the directory the operator registered (configured), the directory this workbench was launched in (the same
 * place, another one, or the registered one is gone), and the worktree Git reports for the launch directory now (observed). A path never
 * grants anything; this only says whether the pieces agree.
 */
export function associationOf(view: Workspace, git: Project | null): Association | null {
	const project = view.project;
	if (project === null) return null;
	let match: GitMatch;
	if (project.observedGitRoot === null) match = "unrecorded";
	else if (git === null) match = "unread";
	else if (git.state === "ready" && git.repository !== null)
		match = git.repository.root === project.observedGitRoot ? "same" : "different";
	else match = git.reason !== null && NOT_A_REPOSITORY.includes(git.reason) ? "not-a-repository" : "unread";
	return { launch: project.launch, git: match, matched: project.launch === "same" && match !== "different" };
}

export function associationWords(a: Association): {
	label: string;
	detail: string;
	tone: "ok" | "attention" | "unknown";
} {
	if (a.launch === "missing")
		return {
			label: "path missing",
			detail: "The registered directory no longer exists. Tasks are shown read-only.",
			tone: "attention",
		};
	if (a.launch === "different")
		return {
			label: "other directory",
			detail:
				"This workbench was launched in a different directory than the one registered for this project. Tasks are shown read-only; nothing here grants access to the directory it was launched in.",
			tone: "attention",
		};
	if (a.git === "different")
		return {
			label: "other worktree",
			detail:
				"Git reports another worktree root here than the one recorded when the project was registered. The directory matches; the repository may have moved.",
			tone: "attention",
		};
	if (a.git === "same")
		return {
			label: "matches",
			detail: "The launch directory is the registered one, and Git reports the worktree recorded at registration.",
			tone: "ok",
		};
	if (a.git === "not-a-repository")
		return {
			label: "directory matches",
			detail: "The launch directory is the registered one. Git does not find a repository there.",
			tone: "unknown",
		};
	if (a.git === "unrecorded")
		return {
			label: "directory matches",
			detail: "The launch directory is the registered one. No Git worktree was recorded at registration.",
			tone: "ok",
		};
	return {
		label: "directory matches",
		detail: "The launch directory is the registered one. The worktree has not been read from Git yet.",
		tone: "ok",
	};
}

/** Why a change cannot be made now, in the page's words. */
export function readOnlyWords(view: Workspace): string | null {
	switch (view.readOnlyReason) {
		case null:
			return null;
		case "project-mismatch":
			return "Read-only: this workbench was launched in a different directory than the one registered for the project.";
		case "project-missing":
			return "Read-only: the registered project directory no longer exists.";
		case "unknown-project":
			return "Read-only: the project named for this launch is not in this store.";
		case "unreadable":
			return "Read-only: the task file cannot be used. It was not changed.";
	}
}

export const REFUSAL_WORDS: Readonly<Record<WorkspaceRefusal, string>> = {
	"grant-required": "Pair this page again to change tasks: the server no longer holds a pairing for it.",
	"read-only": "That was not changed: the workspace is read-only now.",
	"stale-revision":
		"That task changed since you opened it, so your change was not applied. It was read again; look and retry.",
	"invalid-transition": "That status change is not allowed from the task's current status.",
	"bad-request": "That was not accepted: check the lengths and characters.",
	"not-found": "That task is no longer there. The list was read again.",
	"limit-reached": "A limit of the task store was reached (see docs/develop-tasks.md).",
	"no-session": "There is no connected session to link.",
	unreadable: "The task file cannot be used. It was not changed.",
	busy: "Another process is writing the task file. Try again.",
	"storage-failed": "The task file could not be written. Nothing was changed.",
	unavailable: "The server could not do that now. Nothing was changed.",
	invalid: "The server answered with something this page does not accept. Nothing from it was used.",
	unreachable: "The server could not be reached. It may have ended; that is not shown by this message alone.",
	other: "That was not changed.",
};

// ---- unsaved words ---------------------------------------------------------------------------------------------------------------------

export type TaskField = "title" | "description" | "acceptance";
export const TASK_FIELDS: readonly TaskField[] = ["title", "description", "acceptance"];
type Words = Record<TaskField, string>;

/**
 * The words in a form that has not been saved. An EDIT remembers the words it started from (`base`, and the revision they had), so that
 * saving sends only what the operator changed, and so that a task changed elsewhere in the meantime is never overwritten with the stale
 * copy of a field the operator did not touch. A new task has no base.
 */
export interface TaskDraft extends Words {
	base: (Words & { revision: number }) | null;
	/** Fields the operator changed that were ALSO changed elsewhere since: their words are kept, and the other version is shown beside them. */
	elsewhere: Partial<Record<TaskField, string>>;
}

export const newDraft = (): TaskDraft => ({ title: "", description: "", acceptance: "", base: null, elsewhere: {} });
export const editDraft = (task: Task): TaskDraft => ({
	title: task.title,
	description: task.description,
	acceptance: task.acceptance,
	base: { title: task.title, description: task.description, acceptance: task.acceptance, revision: task.revision },
	elsewhere: {},
});

/** The fields that differ from what the edit started from (all non-empty ones of a new task are not "changes": a new task sends its words). */
export const changedFields = (draft: TaskDraft): TaskField[] =>
	draft.base === null ? [] : TASK_FIELDS.filter((f) => draft[f] !== draft.base?.[f]);

/**
 * The draft against the task as it is now. A field the operator did not touch takes the new words; a field they changed that nobody else
 * changed stays theirs; a field they changed and somebody else changed too stays theirs and is flagged, with the other version kept to
 * show. The page never picks a winner for a field both sides changed: the operator sees both and saves their own deliberately.
 */
export function rebaseDraft(draft: TaskDraft, task: Task): TaskDraft {
	const base = draft.base;
	if (base === null || base.revision === task.revision) return draft;
	const next: TaskDraft = { ...draft, base: { ...editDraft(task).base! }, elsewhere: { ...draft.elsewhere } };
	for (const f of TASK_FIELDS) {
		const mine = draft[f] !== base[f];
		const theirs = task[f] !== base[f];
		if (!mine) next[f] = task[f];
		else if (theirs && task[f] !== draft[f]) next.elsewhere[f] = task[f];
		else if (task[f] === draft[f]) delete next.elsewhere[f];
	}
	return next;
}
