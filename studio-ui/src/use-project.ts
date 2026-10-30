// The project context's reads: one list, one diff, only when asked. A read happens when the operator asks (Refresh, choosing a file, the
// next or previous file), and ONCE on its own when this page first holds a grant for a live launch, so the worktree is there when the
// operator looks. Nothing polls, nothing reads while the page is hidden or another workspace is shown, nothing repeats a failed read,
// and a stale answer is shown as stale, never refreshed behind the operator's back. The grant is used from the workbench hook's state
// and never stored; everything here is memory only, and goes with the page or with the launch.
import { useCallback, useEffect, useReducer, useRef } from "react";
import { fetchProject } from "./api.ts";
import {
	type FileKey,
	findEntry,
	initialProject,
	neighbour,
	type ProjectState,
	reduceProject,
} from "./model/project.ts";
import type { Project } from "./model/project-wire.ts";

export interface ProjectApi {
	state: ProjectState;
	refresh(): void;
	select(key: FileKey): void;
	/** Read the next or previous file in the list's order. */
	step(by: 1 | -1): void;
	setView(view: "conversation" | "changes"): void;
}

export function useProject(grant: string | null, launchId: string | null, active: boolean): ProjectApi {
	const [state, dispatch] = useReducer(reduceProject, undefined, initialProject);
	const latest = useRef(state);
	latest.current = state;
	const readSeq = useRef(0);
	const diffSeq = useRef(0);
	const controller = useRef<AbortController | null>(null);
	const held = useRef({ grant, launchId });
	held.current = { grant, launchId };
	// The one automatic read: remembered by the launch and the grant it was made for, so a failed one is not retried by itself.
	const automatic = useRef<string | null>(null);

	const abort = useCallback((): AbortSignal => {
		controller.current ??= new AbortController();
		return controller.current.signal;
	}, []);

	const loadDiff = useCallback(
		async (project: Project, key: FileKey) => {
			const entry = findEntry(project, key);
			const { grant: g } = held.current;
			if (entry === null) return;
			diffSeq.current += 1;
			const seq = diffSeq.current;
			dispatch({ type: "diff-start", seq, key });
			// No grant (the session ended, or the page was unpaired): the list that was last confirmed stays readable, but a file cannot be
			// read, and the page says so instead of waiting for an answer that will not come.
			if (g === null) {
				dispatch({
					type: "diff-done",
					seq,
					key,
					reply: { kind: "failure", status: 401, code: "grant-required", retrySeconds: null },
				});
				return;
			}
			const reply = await fetchProject(
				{ kind: "project-diff", snapshot: project.snapshot, id: entry.id },
				g,
				abort(),
			);
			dispatch({ type: "diff-done", seq, key, reply });
		},
		[abort],
	);

	const read = useCallback(async () => {
		const { grant: g } = held.current;
		if (g === null) return;
		readSeq.current += 1;
		const seq = readSeq.current;
		dispatch({ type: "read-start", seq });
		const reply = await fetchProject({ kind: "project" }, g, abort());
		dispatch({ type: "read-done", seq, reply });
		// The file being read stays the file being read: it is read again from the new list, if the new list still has it.
		const selection = latest.current.selection;
		if (reply.kind === "project" && seq === readSeq.current && selection !== null)
			void loadDiff(reply.record, selection);
	}, [abort, loadDiff]);

	// What was last confirmed stays on screen when the grant goes (the session ended, or it expired), marked not current: the operator keeps
	// what they were reading and is told it is stale. A DIFFERENT launch is a different process and a different worktree: nothing carries over.
	const launch = useRef<string | null>(null);
	useEffect(() => {
		if (launchId !== null && launch.current !== null && launch.current !== launchId) {
			dispatch({ type: "reset" });
			automatic.current = null;
		}
		if (launchId !== null) launch.current = launchId;
		if (grant === null || launchId === null) return;
		const key = `${launchId}:${grant}`;
		if (!active || automatic.current === key) return;
		automatic.current = key;
		void read();
	}, [grant, launchId, active, read]);

	useEffect(
		() => () => {
			controller.current?.abort();
		},
		[],
	);

	return {
		state,
		refresh: () => void read(),
		select: (key) => {
			dispatch({ type: "select", key });
			const project = latest.current.project;
			if (project !== null) void loadDiff(project, key);
		},
		step: (by) => {
			const key = neighbour(latest.current.project, latest.current.selection, by);
			if (key === null) return;
			dispatch({ type: "select", key });
			const project = latest.current.project;
			if (project !== null) void loadDiff(project, key);
		},
		setView: (view) => dispatch({ type: "view", view }),
	};
}
