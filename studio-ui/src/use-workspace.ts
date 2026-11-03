// The workspace's reads and changes, one at a time. A read happens ONCE on its own, when this page first holds a grant for a live launch,
// and again when the operator asks (Refresh) or when a change was refused because what the page held was old. Nothing polls, nothing reads
// while another workspace is shown, nothing repeats a failed read. A change is only ever the operator's act (a button, a key on a
// button), names a task and the revision it saw, and is never made by the page on its own: choosing a task in particular sends no prompt,
// touches no session or worktree and changes no status. The grant is used from the workbench hook's state and never stored; everything
// here is memory only, and goes with the page or with the launch.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchWorkspace } from "./api.ts";
import type { ReceiptFocus } from "./model/attention.ts";
import {
	changedFields,
	initialWorkspace,
	rebaseDraft,
	reduceWorkspace,
	type TaskDraft,
	type WorkspaceState,
} from "./model/workspace.ts";
import type { Task, TaskStatus, WorkspaceRequest } from "./model/workspace-wire.ts";
import { type AttemptsState, useAttempts } from "./use-attempts.ts";
import { type AttentionState, useAttention } from "./use-attention.ts";

/** Unsaved words are kept here, not in the form, so switching tasks does not lose them. Memory only. */
export type { TaskDraft };
export const NEW_TASK = "new";

export interface WorkspaceApi {
	state: WorkspaceState;
	paired: boolean;
	/** Unsaved edits, by task id (or `new`). */
	drafts: Readonly<Record<string, TaskDraft>>;
	setDraft(key: string, draft: TaskDraft | null): void;
	/** The new-task form is open. Opening it, or closing it, creates nothing; its words stay in `drafts` until saved or cancelled. */
	composing: boolean;
	setComposing(on: boolean): void;
	refresh(): void;
	/** Choose the task being worked on. Local at once; remembered by the broker when it can. */
	choose(taskId: string | null): void;
	dismiss(): void;
	create(input: TaskDraft): Promise<boolean>;
	/** Save an edit: only the fields the operator changed are sent, against the revision the edit started from. */
	update(task: Task, input: TaskDraft): Promise<boolean>;
	setStatus(task: Task, to: TaskStatus, note: string): Promise<boolean>;
	link(task: Task): Promise<boolean>;
	unlink(task: Task, linkId: string): Promise<boolean>;
	/** The selected task's work attempts, read after each good workspace read. Read-only: nothing here makes or records one. */
	attempts: AttemptsState;
	/** The project's attention projection, read after each good workspace read, beside the attempts. Read-only. */
	attention: AttentionState;
	/** What the Task view shows: the overview of every task, or the chosen task. Memory only. */
	pane: TaskPane;
	setPane(pane: TaskPane): void;
	/**
	 * Open a task from the overview: choose it (exactly as the picker does: no prompt, no session, no status) and show it, with the receipt
	 * the row was about opened when the attempts beside it arrive.
	 */
	open(taskId: string, receipt: ReceiptFocus | null): void;
	/** The receipt to open in the Task view once (cleared when shown, or when another task is chosen). */
	focus: ReceiptFocus | null;
	clearFocus(): void;
}

export type TaskPane = "overview" | "task";

export function useWorkspace(grant: string | null, launchId: string | null, active: boolean): WorkspaceApi {
	const [state, dispatch] = useReducer(reduceWorkspace, undefined, initialWorkspace);
	const latest = useRef(state);
	latest.current = state;
	const seq = useRef(0);
	const running = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const held = useRef({ grant, launchId });
	held.current = { grant, launchId };
	const automatic = useRef<string | null>(null);
	const pendingChoice = useRef<{ taskId: string | null } | null>(null);
	const [drafts, setDrafts] = useState<Readonly<Record<string, TaskDraft>>>({});
	const [composing, setComposing] = useState(false);
	// The overview first: the Task view opens on it until the operator chooses a task (here, in the picker, or by creating one).
	const [pane, setPane] = useState<TaskPane>("overview");
	const [focus, setFocus] = useState<ReceiptFocus | null>(null);

	const abort = useCallback((): AbortSignal => {
		controller.current ??= new AbortController();
		return controller.current.signal;
	}, []);

	const run = useCallback(
		async (
			request: WorkspaceRequest,
			how: { change: boolean; adopt?: boolean; keepNotice?: boolean },
		): Promise<boolean> => {
			const { grant: g } = held.current;
			if (g === null || running.current) return false;
			running.current = true;
			seq.current += 1;
			const mine = seq.current;
			dispatch({ type: "start", seq: mine });
			let ok = false;
			let reread = false;
			try {
				const reply = await fetchWorkspace(request, g, abort());
				dispatch({
					type: "done",
					seq: mine,
					reply,
					at: new Date(),
					change: how.change,
					adopt: how.adopt ?? false,
					keepNotice: how.keepNotice ?? false,
				});
				ok = reply.kind === "workspace";
				// What the page held was old: look again, and keep the sentence that says why the change was not made.
				reread =
					how.change &&
					reply.kind === "failure" &&
					(reply.code === "stale-revision" || reply.code === "not-found");
			} finally {
				running.current = false;
			}
			if (reread) void run({ kind: "read" }, { change: false, keepNotice: true });
			else if (pendingChoice.current !== null) {
				const { taskId } = pendingChoice.current;
				pendingChoice.current = null;
				if (latest.current.view?.writable === true) void run({ kind: "select", taskId }, { change: true });
			}
			return ok;
		},
		[abort],
	);

	// The one automatic read. A DIFFERENT launch is a different process and a different workspace: nothing carries over.
	const launch = useRef<string | null>(null);
	useEffect(() => {
		if (launchId !== null && launch.current !== null && launch.current !== launchId) {
			dispatch({ type: "reset" });
			setDrafts({});
			setComposing(false);
			setPane("overview");
			setFocus(null);
			automatic.current = null;
		}
		if (launchId !== null) launch.current = launchId;
		if (grant === null || launchId === null) return;
		const key = `${launchId}:${grant}`;
		if (!active || automatic.current === key) return;
		automatic.current = key;
		void run({ kind: "read" }, { change: false });
	}, [grant, launchId, active, run]);

	// An edit is held against the words it started from: when the task is read again and has changed elsewhere, the fields the operator did
	// not touch take the new words, and a field both sides changed is flagged (never silently resolved).
	const view = state.view;
	useEffect(() => {
		if (view === null) return;
		setDrafts((now) => {
			let changed = false;
			const next: Record<string, TaskDraft> = {};
			for (const [key, draft] of Object.entries(now)) {
				const task = view.tasks.find((t) => t.id === key);
				const rebased = task === undefined ? draft : rebaseDraft(draft, task);
				if (rebased !== draft) changed = true;
				next[key] = rebased;
			}
			return changed ? next : now;
		});
	}, [view]);

	// What was last confirmed stays on screen when the grant goes, marked not current.
	useEffect(() => {
		if (grant === null && latest.current.view !== null) dispatch({ type: "unpair" });
	}, [grant]);

	useEffect(
		() => () => {
			controller.current?.abort();
		},
		[],
	);

	const attempts = useAttempts(
		grant,
		launchId,
		active,
		state.view?.state === "ready",
		state.readAt === null ? null : state.readAt.getTime(),
	);

	const attention = useAttention(
		grant,
		launchId,
		active,
		state.view?.state === "ready",
		state.readAt === null ? null : state.readAt.getTime(),
	);

	const choose = (taskId: string | null) => {
		dispatch({ type: "choose", taskId });
		if (latest.current.view?.writable !== true) return;
		if (running.current) pendingChoice.current = { taskId };
		else void run({ kind: "select", taskId }, { change: true });
	};

	return {
		state,
		attempts,
		attention,
		pane,
		setPane,
		focus,
		clearFocus: () => setFocus(null),
		open: (taskId, receipt) => {
			setComposing(false);
			setFocus(receipt);
			setPane("task");
			choose(taskId);
		},
		paired: grant !== null,
		drafts,
		composing,
		setComposing: (on) => {
			setComposing(on);
			if (on) setPane("task");
		},
		setDraft: (key, draft) =>
			setDrafts((now) => {
				if (draft === null) {
					if (!(key in now)) return now;
					const { [key]: _gone, ...rest } = now;
					return rest;
				}
				return { ...now, [key]: draft };
			}),
		refresh: () => void run({ kind: "read" }, { change: false }),
		choose: (taskId) => {
			setFocus(null);
			if (taskId !== null) setPane("task");
			choose(taskId);
		},
		dismiss: () => dispatch({ type: "dismiss" }),
		create: (input) =>
			// A new task is shown once made (the reply adopts it).
			run(
				{ kind: "create", title: input.title, description: input.description, acceptance: input.acceptance },
				{ change: true, adopt: true },
			).then((ok) => {
				if (ok) setPane("task");
				return ok;
			}),
		update: (task, input) => {
			// Only what the operator changed is sent, against the revision their words were read at (rebased when the task was read
			// again): a field they did not touch is never written back from an old copy.
			const patch: { title?: string; description?: string; acceptance?: string } = {};
			for (const field of changedFields(input)) patch[field] = input[field];
			return run(
				{ kind: "update", taskId: task.id, revision: input.base?.revision ?? task.revision, ...patch },
				{ change: true },
			);
		},
		setStatus: (task, to, note) =>
			run({ kind: "status", taskId: task.id, revision: task.revision, to, note }, { change: true }),
		link: (task) => run({ kind: "link", taskId: task.id, revision: task.revision }, { change: true }),
		unlink: (task, linkId) =>
			run({ kind: "unlink", taskId: task.id, revision: task.revision, linkId }, { change: true }),
	};
}
