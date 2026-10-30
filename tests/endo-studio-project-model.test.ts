// The page's side of the project context, without a browser: the wire gate (what is accepted and what is refused whole), the state
// machine (what a failure, a stale answer or a refresh leaves on the screen), and the words and rows a diff is drawn from.
import { describe, expect, it } from "vitest";
import {
	AREA_ORDER,
	countParts,
	type FileKey,
	findEntry,
	groupFiles,
	hunkLabel,
	hunkRows,
	initialProject,
	neighbour,
	type ProjectState,
	reduceProject,
	splitPath,
} from "../studio-ui/src/model/project.ts";
import {
	type ChangeEntry,
	type Project,
	type ProjectDiff,
	type ProjectReply,
	readWorkbenchDiff,
	readWorkbenchProject,
} from "../studio-ui/src/model/project-wire.ts";

const entry = (
	id: number,
	path: string,
	area: ChangeEntry["area"],
	status: ChangeEntry["status"] = "modified",
): ChangeEntry => ({
	id,
	path,
	origPath: null,
	area,
	status,
	additions: 1,
	deletions: 0,
	binary: false,
	escaped: false,
});

const project = (files: ChangeEntry[], over: Partial<Project> = {}): Project => ({
	schemaVersion: "endo.workbench-project.v0",
	basis: "launch-directory",
	snapshot: "0123456789abcdef",
	capturedAtMs: 1_700_000_000_000,
	state: "ready",
	reason: null,
	repository: { label: "demo", worktreeLabel: "demo", root: "/w/demo", cwdRelative: "", commonDir: "/w/demo/.git" },
	head: { kind: "branch", branch: "main", oid: "a".repeat(40) },
	worktrees: [],
	changes: {
		state: "ready",
		reason: null,
		dirty: files.length === 0 ? "clean" : "dirty",
		counts: {
			staged: files.filter((f) => f.area === "staged").length,
			unstaged: files.filter((f) => f.area === "unstaged").length,
			untracked: files.filter((f) => f.area === "untracked").length,
			conflicted: 0,
			exact: true,
		},
		stats: null,
		files,
		filesTruncated: false,
	},
	incomplete: [],
	...over,
});

const diff = (over: Partial<ProjectDiff> = {}): ProjectDiff => ({
	schemaVersion: "endo.workbench-diff.v0",
	snapshot: "0123456789abcdef",
	id: 0,
	area: "unstaged",
	path: "a.ts",
	origPath: null,
	comparison: "index-to-working-tree",
	state: "ready",
	reason: null,
	notes: [],
	hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, section: "", lines: [" keep", "+added"] }],
	truncated: false,
	longLines: false,
	inventory: "unchanged",
	...over,
});

const ok = (record: Project): ProjectReply => ({ kind: "project", record });

describe("the wire gate refuses what it cannot vouch for, whole", () => {
	it("accepts a well-formed project and diff, and nothing with an extra, missing or mistyped field", () => {
		const good = project([entry(0, "a.ts", "staged")]);
		expect(readWorkbenchProject(structuredClone(good))).toEqual(good);
		expect(readWorkbenchProject({ ...good, extra: 1 })).toBeNull();
		const { snapshot: _snapshot, ...missing } = good;
		expect(readWorkbenchProject(missing)).toBeNull();
		expect(readWorkbenchProject({ ...good, snapshot: "NOT-HEX" })).toBeNull();
		expect(readWorkbenchProject({ ...good, basis: "observed" })).toBeNull();
		expect(readWorkbenchProject({ ...good, reason: "because" })).toBeNull();
		expect(readWorkbenchProject(null)).toBeNull();
		expect(readWorkbenchProject([])).toBeNull();
		const d = diff();
		expect(readWorkbenchDiff(structuredClone(d))).toEqual(d);
		expect(readWorkbenchDiff({ ...d, extra: 1 })).toBeNull();
		expect(readWorkbenchDiff({ ...d, comparison: "everything" })).toBeNull();
	});

	it("refuses a list whose entries are not addressed by position, and an unavailable project that names a repository", () => {
		expect(readWorkbenchProject(project([entry(0, "a.ts", "staged"), entry(0, "b.ts", "staged")]))).toBeNull();
		expect(readWorkbenchProject(project([entry(1, "a.ts", "staged")]))).toBeNull();
		const base = project([]);
		expect(readWorkbenchProject({ ...base, state: "unavailable", reason: null })).toBeNull();
		expect(readWorkbenchProject({ ...base, state: "unavailable", reason: "not-a-repository" })).toBeNull(); // still names a repository
		expect(
			readWorkbenchProject({ ...base, state: "unavailable", reason: "not-a-repository", repository: null }),
		).not.toBeNull();
	});

	it("refuses a diff that contradicts itself: a reason without being unavailable, hunks without being ready, or a line that is not a diff line", () => {
		expect(readWorkbenchDiff(diff({ state: "unavailable", reason: null }))).toBeNull();
		expect(readWorkbenchDiff(diff({ state: "ready", reason: "unmerged" }))).toBeNull();
		expect(readWorkbenchDiff(diff({ state: "binary" }))).toBeNull(); // hunks present
		expect(readWorkbenchDiff(diff({ state: "binary", hunks: [] }))).not.toBeNull();
		const bad = diff();
		(bad.hunks[0] as { lines: string[] }).lines = ["no sign here"];
		expect(readWorkbenchDiff(bad)).toBeNull();
	});
});

describe("what stays on the screen", () => {
	const files = [entry(0, "a.ts", "staged"), entry(1, "a.ts", "unstaged"), entry(2, "new.ts", "untracked")];
	const read = (state: ProjectState, reply: ProjectReply, seq = state.readSeq + 1): ProjectState =>
		reduceProject(reduceProject(state, { type: "read-start", seq }), { type: "read-done", seq, reply });

	it("keeps the last good read through a failure, and says it is not current", () => {
		const good = read(initialProject(), ok(project(files)));
		expect(good).toMatchObject({ availability: "available", current: true, problem: null });
		const failed = read(good, { kind: "failure", status: 0, code: "unreachable", retrySeconds: null });
		expect(failed.project).toBe(good.project);
		expect(failed).toMatchObject({ current: false, problem: "unreachable", reading: false });
		for (const [code, problem] of [
			["grant-required", "unpaired"],
			["busy", "busy"],
			["invalid", "invalid"],
			["", "error"],
		] as const)
			expect(read(good, { kind: "failure", status: 500, code, retrySeconds: null }).problem).toBe(problem);
		// A good read clears it.
		expect(read(failed, ok(project(files)))).toMatchObject({ current: true, problem: null });
	});

	it("selects by name, not by position: a refreshed list that still has the file reads it again, and one without it says it is gone", () => {
		const key: FileKey = { path: "a.ts", area: "unstaged" };
		let state = read(initialProject(), ok(project(files)));
		state = reduceProject(state, { type: "select", key });
		expect(state).toMatchObject({ view: "changes", diff: { status: "loading" } });
		// The list is reordered: the same name is still the same file, wherever it sits.
		const reordered = [entry(0, "new.ts", "untracked"), entry(1, "a.ts", "unstaged")];
		state = read(state, ok(project(reordered)));
		expect(state.selection).toEqual(key);
		expect(state.diff).toMatchObject({ status: "loading", key });
		expect(findEntry(state.project, key)?.id).toBe(1);
		// The file left the list.
		state = read(state, ok(project([entry(0, "new.ts", "untracked")])));
		expect(state.diff).toMatchObject({ status: "gone", key });
		// Another AREA of the same path is another file.
		const second = reduceProject(read(initialProject(), ok(project(files))), {
			type: "select",
			key: { path: "a.ts", area: "staged" },
		});
		expect(findEntry(second.project, second.selection)?.id).toBe(0);
	});

	it("ignores an answer that arrives after a newer request, for both the list and a diff", () => {
		let state = reduceProject(initialProject(), { type: "read-start", seq: 1 });
		state = reduceProject(state, { type: "read-start", seq: 2 });
		state = reduceProject(state, { type: "read-done", seq: 1, reply: ok(project([entry(0, "old.ts", "staged")])) });
		expect(state.project).toBeNull();
		state = reduceProject(state, { type: "read-done", seq: 2, reply: ok(project(files)) });
		expect(state.project?.changes.files).toHaveLength(3);
		const a: FileKey = { path: "a.ts", area: "staged" };
		const b: FileKey = { path: "a.ts", area: "unstaged" };
		state = reduceProject(state, { type: "select", key: a });
		state = reduceProject(state, { type: "diff-start", seq: 1, key: a });
		state = reduceProject(state, { type: "select", key: b });
		state = reduceProject(state, { type: "diff-start", seq: 2, key: b });
		// The first file's answer arrives late: it is not shown under the second file.
		state = reduceProject(state, {
			type: "diff-done",
			seq: 1,
			key: a,
			reply: { kind: "diff", record: diff({ area: "staged" }) },
		});
		expect(state.diff).toMatchObject({ status: "loading", key: b });
		state = reduceProject(state, { type: "diff-done", seq: 2, key: b, reply: { kind: "diff", record: diff() } });
		expect(state.diff).toMatchObject({ status: "ready", key: b });
	});

	it("shows a stale answer as stale and the list as not current, and reads nothing by itself", () => {
		const key: FileKey = { path: "a.ts", area: "unstaged" };
		let state = reduceProject(read(initialProject(), ok(project(files))), { type: "select", key });
		state = reduceProject(state, { type: "diff-start", seq: 1, key });
		state = reduceProject(state, { type: "diff-done", seq: 1, key, reply: { kind: "stale" } });
		expect(state).toMatchObject({ current: false, problem: "stale", diff: { status: "stale", key }, reading: false });
		expect(state.project).not.toBeNull();
	});

	it("drops everything when the launch changes (the reducer's reset), remembers that a server has no project context, and starts in the conversation", () => {
		let state = reduceProject(read(initialProject(), ok(project(files))), {
			type: "select",
			key: { path: "a.ts", area: "staged" },
		});
		expect(state.view).toBe("changes");
		state = reduceProject(state, { type: "reset" });
		expect(state).toMatchObject({
			project: null,
			selection: null,
			current: false,
			view: "conversation",
			availability: "unknown",
		});
		expect(initialProject().view).toBe("conversation");
		const absent = read(initialProject(), { kind: "absent" });
		expect(absent.availability).toBe("absent");
		expect(reduceProject(absent, { type: "reset" }).availability).toBe("absent");
	});
});

describe("the words and rows a diff is drawn from", () => {
	it("numbers each side from the hunk header, leaves added lines without an old number and removed without a new one", () => {
		const rows = hunkRows({
			oldStart: 10,
			oldLines: 3,
			newStart: 20,
			newLines: 3,
			section: "fn",
			lines: [" same", "-gone", "+new", "+newer", " tail", "\\ No newline at end of file"],
		});
		expect(rows.map((r) => [r.kind, r.old, r.new, r.text])).toEqual([
			["context", 10, 20, "same"],
			["removed", 11, null, "gone"],
			["added", null, 21, "new"],
			["added", null, 22, "newer"],
			["context", 12, 23, "tail"],
			["note", null, null, " No newline at end of file"],
		]);
		expect(hunkLabel({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 4, section: "x", lines: [] })).toBe(
			"@@ −1 +1,4 @@ x",
		);
	});

	it("counts each area on its own, says 'at least' when the list was cut, and never adds the areas together", () => {
		const p = project([entry(0, "a", "staged"), entry(1, "b", "unstaged"), entry(2, "c", "unstaged")]);
		expect(countParts(p).map((c) => c.text)).toEqual(["1 staged", "2 unstaged"]);
		const cut = project(p.changes.files, {
			changes: { ...p.changes, counts: { ...p.changes.counts, exact: false } },
		});
		expect(countParts(cut).map((c) => c.text)).toEqual(["≥1 staged", "≥2 unstaged"]);
		expect(AREA_ORDER).toEqual(["conflicted", "staged", "unstaged", "untracked"]);
		expect(groupFiles(p.changes.files).map((g) => [g.area, g.files.length])).toEqual([
			["staged", 1],
			["unstaged", 2],
		]);
	});

	it("splits a path for a two-line row, and moves between neighbours in reading order without wrapping", () => {
		expect(splitPath("src/a/b.ts")).toEqual({ dir: "src/a/", name: "b.ts" });
		expect(splitPath("top.ts")).toEqual({ dir: "", name: "top.ts" });
		const p = project([entry(0, "a", "staged"), entry(1, "b", "unstaged"), entry(2, "c", "untracked")]);
		expect(neighbour(p, { path: "b", area: "unstaged" }, 1)).toEqual({ path: "c", area: "untracked" });
		expect(neighbour(p, { path: "b", area: "unstaged" }, -1)).toEqual({ path: "a", area: "staged" });
		expect(neighbour(p, { path: "c", area: "untracked" }, 1)).toBeNull();
		expect(neighbour(p, { path: "a", area: "staged" }, -1)).toBeNull();
		expect(neighbour(p, { path: "zzz", area: "staged" }, 1)).toBeNull();
	});
});
