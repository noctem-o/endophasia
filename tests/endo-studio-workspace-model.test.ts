// The page's side of the workspace: the wire gate (a body is accepted whole or not at all), the state transitions (a failed read keeps what
// was last confirmed, a slow answer never overwrites a newer one, choosing a task changes nothing else), and the three-fact association of
// a project. Pure functions; no DOM, no network.
import { describe, expect, it } from "vitest";
import {
	ENDO_DEVELOP_TASK_STATUSES_V0,
	ENDO_DEVELOP_UNREADABLE_REASONS_V0,
	type EndoDevelopWorkspaceViewV1,
	endoDevelopNextStatusesV0,
} from "../protocol/develop-tasks.ts";
import {
	associationOf,
	associationWords,
	changedFields,
	editDraft,
	initialWorkspace,
	orderedTasks,
	rebaseDraft,
	reduceWorkspace,
	selectedTask,
	transitionWords,
	type WorkspaceAction,
	type WorkspaceState,
} from "../studio-ui/src/model/workspace.ts";
import {
	isNoWorkspace,
	readWorkspace,
	TASK_STATUSES,
	UNREADABLE_REASONS,
	type Workspace,
	type WorkspaceReply,
} from "../studio-ui/src/model/workspace-wire.ts";

const hex = (n: number, c = "a") => c.repeat(n);
const task = (n: number, patch: Record<string, unknown> = {}) => ({
	id: `endo.task.${hex(31)}${n}`,
	projectId: `endo.project.${hex(32, "b")}`,
	title: `Task ${n}`,
	description: "",
	acceptance: "",
	status: "open",
	createdAtMs: 1000 + n,
	updatedAtMs: 1000 + n,
	revision: 0,
	history: [{ atMs: 1000 + n, from: null, to: "open", note: null }],
	sessions: [],
	next: ["in-progress", "blocked"],
	...patch,
});
const view = (patch: Record<string, unknown> = {}): EndoDevelopWorkspaceViewV1 =>
	({
		schemaVersion: "endo.develop-workspace.v1",
		available: true,
		launchId: hex(16, "c"),
		state: "ready",
		reason: null,
		revision: 3,
		project: {
			id: `endo.project.${hex(32, "b")}`,
			name: "demo",
			path: "/work/demo",
			observedGitRoot: "/work/demo",
			launch: "same",
		},
		writable: true,
		readOnlyReason: null,
		linkable: true,
		tasks: [task(1), task(2)],
		selectedTaskId: null,
		...patch,
	}) as EndoDevelopWorkspaceViewV1;

describe("the wire gate", () => {
	it("accepts a well-formed workspace and its mirrors of the protocol's closed lists", () => {
		expect(readWorkspace(view())).not.toBeNull();
		expect([...TASK_STATUSES]).toEqual([...ENDO_DEVELOP_TASK_STATUSES_V0]);
		expect([...UNREADABLE_REASONS]).toEqual([...ENDO_DEVELOP_UNREADABLE_REASONS_V0]);
		// The page's offers are the protocol's: every status lists exactly the moves the store allows.
		for (const status of ENDO_DEVELOP_TASK_STATUSES_V0) {
			const next = endoDevelopNextStatusesV0(status);
			expect(readWorkspace(view({ tasks: [task(1, { status, next: [...next] })] }))).not.toBeNull();
			for (const to of next) expect(transitionWords(status, to).length).toBeGreaterThan(0);
		}
	});

	it("refuses a body that is not exactly the shape: unknown members, wrong types, unsafe text, incoherent states", () => {
		const refused: [string, unknown][] = [
			["an extra member", { ...view(), extra: 1 }],
			["a missing member", (({ launchId: _l, ...rest }) => rest)(view())],
			["a status outside the list", view({ tasks: [task(1, { status: "finished" })] })],
			["a bidirectional override in a title", view({ tasks: [task(1, { title: "a\u202eb" })] })],
			["a newline in a title", view({ tasks: [task(1, { title: "a\nb" })] })],
			["an escape in a description", view({ tasks: [task(1, { description: "x\u001b[2J" })] })],
			["a description over the limit", view({ tasks: [task(1, { description: "y".repeat(4001) })] })],
			["a bad task id", view({ tasks: [task(1, { id: "endo.task.short" })] })],
			["duplicate tasks", view({ tasks: [task(1), task(1)] })],
			["a task of another project", view({ tasks: [task(1, { projectId: `endo.project.${hex(32, "d")}` })] })],
			["a selection that is not a task shown", view({ selectedTaskId: task(9).id })],
			["a ready workspace with no project", view({ project: null })],
			["tasks in an unreadable workspace", view({ state: "unreadable", reason: "malformed" })],
			["writable beside a different directory", view({ project: { ...view().project, launch: "different" } })],
			["read-only with no reason", view({ writable: false })],
			["linkable while read-only", view({ writable: false, readOnlyReason: "unreadable", linkable: true })],
			[
				"a session reference carrying a session id",
				view({ tasks: [task(1, { sessions: [{ sessionId: "endo.session.pi.x" }] })] }),
			],
			["an array", [view()]],
			["null", null],
		];
		for (const [what, value] of refused) expect(readWorkspace(value), what).toBeNull();
	});

	it("reads a reference as a label and a relation only", () => {
		const ref = {
			linkId: hex(16, "1"),
			source: "pi-live",
			alias: "alias:1",
			attachment: "pi.default",
			launchId: hex(16, "e"),
			linkedAtMs: 5,
			linkedBy: "operator",
			relation: "historical",
		};
		expect(readWorkspace(view({ tasks: [task(1, { sessions: [ref] })] }))).not.toBeNull();
		expect(
			readWorkspace(view({ tasks: [task(1, { sessions: [{ ...ref, sessionId: "endo.session.pi.x" }] })] })),
		).toBeNull();
		expect(readWorkspace(view({ tasks: [task(1, { sessions: [{ ...ref, relation: "live" }] })] }))).toBeNull();
		// An attachment name is the registry's dotted kind (up to 128 characters), not a short label.
		const long = `pi.${"long-".repeat(23)}x`;
		expect(readWorkspace(view({ tasks: [task(1, { sessions: [{ ...ref, attachment: long }] })] }))).not.toBeNull();
		for (const attachment of [`${long}${"y".repeat(40)}`, "Pi Default", "pi..default", ""])
			expect(
				readWorkspace(view({ tasks: [task(1, { sessions: [{ ...ref, attachment }] })] })),
				attachment,
			).toBeNull();
	});

	it("knows the workbench's one constant answer for 'no project', and no other", () => {
		expect(isNoWorkspace({ available: false, schemaVersion: "endo.develop-workspace.v1" })).toBe(true);
		expect(isNoWorkspace({ available: false, schemaVersion: "endo.develop-workspace.v1", extra: 1 })).toBe(false);
		expect(isNoWorkspace({ available: true, schemaVersion: "endo.develop-workspace.v1" })).toBe(false);
	});
});

const apply = (state: WorkspaceState, ...actions: WorkspaceAction[]) => actions.reduce(reduceWorkspace, state);
const done = (
	seq: number,
	reply: WorkspaceReply,
	extra: Partial<Extract<WorkspaceAction, { type: "done" }>> = {},
): WorkspaceAction => ({
	type: "done",
	seq,
	reply,
	at: new Date(5000),
	change: false,
	adopt: false,
	keepNotice: false,
	...extra,
});
const read = (record: Workspace): WorkspaceReply => ({ kind: "workspace", record });

describe("the state", () => {
	it("keeps what was last confirmed through a failed read and marks it not current", () => {
		let state = apply(initialWorkspace(), { type: "start", seq: 1 }, done(1, read(view())));
		expect(state).toMatchObject({ availability: "available", current: true, problem: null });
		state = apply(
			state,
			{ type: "start", seq: 2 },
			done(2, { kind: "failure", status: 401, code: "grant-required" }),
		);
		expect(state.view?.tasks).toHaveLength(2);
		expect(state).toMatchObject({ current: false, problem: "unpaired", busy: false });
		state = apply(state, { type: "start", seq: 3 }, done(3, { kind: "failure", status: 0, code: "unreachable" }));
		expect(state.problem).toBe("unreachable");
		// A body the gate refused is shown as such and replaces nothing.
		state = apply(state, { type: "start", seq: 4 }, done(4, { kind: "failure", status: 200, code: "invalid" }));
		expect([state.problem, state.view?.tasks.length]).toEqual(["invalid", 2]);
	});

	it("ignores a slow answer once a newer request has started", () => {
		const first = view({ revision: 1 });
		const second = view({ revision: 2, tasks: [task(1), task(2), task(3)] });
		const state = apply(
			initialWorkspace(),
			{ type: "start", seq: 1 },
			{ type: "start", seq: 2 },
			done(2, read(second)),
			done(1, read(first)),
		);
		expect(state.view?.revision).toBe(2);
	});

	it("says a workbench without a project is absent, and a refused change leaves the view and says why", () => {
		expect(apply(initialWorkspace(), { type: "start", seq: 1 }, done(1, { kind: "absent" })).availability).toBe(
			"absent",
		);
		let state = apply(initialWorkspace(), { type: "start", seq: 1 }, done(1, read(view())));
		state = apply(
			state,
			{ type: "start", seq: 2 },
			done(2, { kind: "failure", status: 409, code: "stale-revision" }, { change: true }),
		);
		expect(state).toMatchObject({ notice: "stale-revision", current: true });
		expect(state.view?.tasks).toHaveLength(2);
		// The re-read that follows keeps the sentence; the next ordinary read clears it.
		state = apply(state, { type: "start", seq: 3 }, done(3, read(view({ revision: 4 })), { keepNotice: true }));
		expect(state.notice).toBe("stale-revision");
		state = apply(state, { type: "start", seq: 4 }, done(4, read(view({ revision: 5 }))));
		expect(state.notice).toBeNull();
	});

	it("chooses a task locally, and only the operator's choice (or the broker's remembered one) selects", () => {
		const remembered = view({ selectedTaskId: task(2).id });
		let state = apply(initialWorkspace(), { type: "start", seq: 1 }, done(1, read(remembered)));
		expect(selectedTask(state)?.title).toBe("Task 2");
		state = apply(state, { type: "choose", taskId: task(1).id });
		expect(selectedTask(state)?.title).toBe("Task 1");
		state = apply(state, { type: "choose", taskId: null });
		expect(selectedTask(state)).toBeNull();
		// A task that left the file is not selected; the broker's remembered one stands again.
		state = apply(
			state,
			{ type: "choose", taskId: task(7).id },
			{ type: "start", seq: 2 },
			done(2, read(remembered)),
		);
		expect(state.chosen).toBeUndefined();
		expect(selectedTask(state)?.title).toBe("Task 2");
		// Creating adopts the broker's selection (the new task).
		state = apply(
			state,
			{ type: "choose", taskId: task(1).id },
			{ type: "start", seq: 3 },
			done(3, read(view({ selectedTaskId: task(2).id })), { adopt: true }),
		);
		expect(selectedTask(state)?.title).toBe("Task 2");
		// ...but not over a choice the operator made after the create request went out: the later choice wins, as it does on the server.
		state = apply(
			state,
			{ type: "start", seq: 4 },
			{ type: "choose", taskId: task(1).id },
			done(4, read(view({ selectedTaskId: task(2).id })), { adopt: true }),
		);
		expect(selectedTask(state)?.title).toBe("Task 1");
	});

	it("choosing a task changes no task: statuses and revisions are exactly those of the last read", () => {
		const record = view({
			tasks: [task(1, { status: "review", next: ["done", "in-progress", "blocked"], revision: 4 }), task(2)],
		});
		const before = apply(initialWorkspace(), { type: "start", seq: 1 }, done(1, read(record)));
		const after = apply(before, { type: "choose", taskId: task(1).id }, { type: "choose", taskId: task(2).id });
		expect(after.view).toBe(before.view);
		expect(after.view?.tasks.map((t) => [t.status, t.revision])).toEqual([
			["review", 4],
			["open", 0],
		]);
	});

	it("loses the grant without losing the tasks, and a different launch starts clean", () => {
		let state = apply(initialWorkspace(), { type: "start", seq: 1 }, done(1, read(view())));
		state = apply(state, { type: "unpair" });
		expect(state).toMatchObject({ current: false, problem: "unpaired" });
		expect(state.view?.tasks).toHaveLength(2);
		expect(apply(state, { type: "reset" })).toEqual(initialWorkspace());
	});

	it("orders work in hand first and finished work last", () => {
		const record = view({
			tasks: [
				task(1, { status: "done", next: ["open"], updatedAtMs: 9000 }),
				task(2, { status: "open" }),
				task(3, { status: "in-progress", next: ["review", "blocked", "open"] }),
				task(4, { status: "review", next: ["done", "in-progress", "blocked"] }),
			],
		});
		expect(orderedTasks(record).map((t) => t.status)).toEqual(["in-progress", "review", "open", "done"]);
	});
});

describe("a project is three facts, not one", () => {
	const git = (patch: Record<string, unknown>) =>
		({ state: "ready", reason: null, repository: { root: "/work/demo" }, ...patch }) as never;

	it("separates the registered directory, the launch directory and what Git reports now", () => {
		expect(associationOf(view(), git({}))).toEqual({ launch: "same", git: "same", matched: true });
		expect(associationOf(view(), git({ repository: { root: "/work/other" } }))).toEqual({
			launch: "same",
			git: "different",
			matched: false,
		});
		expect(associationOf(view(), null)).toEqual({ launch: "same", git: "unread", matched: true });
		expect(
			associationOf(view(), git({ state: "unavailable", reason: "not-a-repository", repository: null }))?.git,
		).toBe("not-a-repository");
		expect(associationOf(view(), git({ state: "unavailable", reason: "git-timeout", repository: null }))?.git).toBe(
			"unread",
		);
		const unrecorded = view({ project: { ...view().project, observedGitRoot: null } });
		expect(associationOf(unrecorded, git({}))?.git).toBe("unrecorded");
		const elsewhere = view({
			project: { ...view().project, launch: "different" },
			writable: false,
			readOnlyReason: "project-mismatch",
			linkable: false,
		});
		expect(associationOf(elsewhere, git({}))).toEqual({ launch: "different", git: "same", matched: false });
		expect(
			associationOf(
				view({
					state: "unknown-project",
					project: null,
					tasks: [],
					writable: false,
					readOnlyReason: "unknown-project",
					linkable: false,
				}),
				null,
			),
		).toBeNull();
	});

	it("says a mismatch is a mismatch and never a match", () => {
		for (const [launch, label] of [
			["different", "other directory"],
			["missing", "path missing"],
		] as const) {
			const words = associationWords({ launch, git: "same", matched: false });
			expect(words).toMatchObject({ label, tone: "attention" });
		}
		expect(associationWords({ launch: "same", git: "different", matched: false })).toMatchObject({
			label: "other worktree",
			tone: "attention",
		});
		expect(associationWords({ launch: "same", git: "same", matched: true })).toMatchObject({
			label: "matches",
			tone: "ok",
		});
		// A path alone is never called a match: with Git unread, the sentence says so.
		expect(associationWords({ launch: "same", git: "unread", matched: true }).detail).toMatch(/not been read/);
	});
});

describe("an unsaved edit is held against the words it started from", () => {
	const base = task(1, {
		title: "T",
		description: "d0",
		acceptance: "a0",
		revision: 2,
	}) as never as Workspace["tasks"][number];
	const now = (patch: Record<string, unknown>) => ({ ...base, revision: 3, ...patch }) as typeof base;

	it("sends only what the operator changed", () => {
		const draft = { ...editDraft(base), description: "d1" };
		expect(changedFields(draft)).toEqual(["description"]);
		expect(changedFields(editDraft(base))).toEqual([]);
	});

	it("a field the operator did not touch takes the words somebody else wrote; one they changed stays theirs", () => {
		const draft = { ...editDraft(base), description: "mine" };
		const rebased = rebaseDraft(draft, now({ acceptance: "theirs" }));
		expect(rebased).toMatchObject({ description: "mine", acceptance: "theirs", elsewhere: {} });
		expect(rebased.base?.revision).toBe(3);
		// Only the field the operator changed is a change against the new base.
		expect(changedFields(rebased)).toEqual(["description"]);
	});

	it("a field both sides changed keeps the operator's words, flags the other version, and decides nothing", () => {
		const draft = { ...editDraft(base), description: "mine" };
		const rebased = rebaseDraft(draft, now({ description: "theirs" }));
		expect(rebased.description).toBe("mine");
		expect(rebased.elsewhere).toEqual({ description: "theirs" });
		expect(changedFields(rebased)).toEqual(["description"]);
		// Both sides arriving at the same words is no conflict.
		expect(rebaseDraft(draft, now({ description: "mine" })).elsewhere).toEqual({});
	});

	it("is a no-op for the same revision and for a new task", () => {
		const draft = editDraft(base);
		expect(rebaseDraft(draft, base)).toBe(draft);
		const fresh = { title: "x", description: "", acceptance: "", base: null, elsewhere: {} };
		expect(rebaseDraft(fresh, now({}))).toBe(fresh);
	});
});
