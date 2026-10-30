// The read-only Git project context (adapters/git/project-inspector.ts, readonly-git.ts) against REAL repositories, including hostile ones:
// what it reports, what a diff contains, when it refuses, and what it never does (run a program a repository names, write to the
// repository, read outside it, follow a link, hang on a pipe, believe a name, or answer for a working tree that moved on).

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import {
	displaySafeV0,
	GIT_LIMITS_V0,
	gitEnvV0,
	hasNoLazyFetchV0,
	parseNumstat,
	parseStatusV2,
	parseUnifiedDiff,
	parseWorktrees,
	patchHeaderV0,
	programKeysV0,
	runGitV0,
	selectPatchesV0,
} from "../adapters/git/readonly-git.ts";
import type { EndoWorkbenchDiffV0, EndoWorkbenchProjectV0 } from "../protocol/workbench-project.ts";
import { readWorkbenchDiff, readWorkbenchProject } from "../studio-ui/src/model/project-wire.ts";
import { cleanGitFixtures, commitedRepo, dirtyRepo, fixtureDir, git, haveGit, write } from "./git-fixtures.ts";

afterEach(cleanGitFixtures);
const suite = haveGit ? describe : describe.skip;

const inspect = (cwd: string, options: Partial<ConstructorParameters<typeof GitProjectInspectorV0>[0]> = {}) =>
	new GitProjectInspectorV0({ cwd, minRefreshMs: 0, ...options });
const entry = (project: EndoWorkbenchProjectV0, path: string, area: string) => {
	const found = project.changes.files.find((f) => f.path === path && f.area === area);
	if (found === undefined)
		throw new Error(
			`no ${area} entry for ${path}: ${JSON.stringify(project.changes.files.map((f) => [f.area, f.path]))}`,
		);
	return found;
};
const diffOf = async (
	inspector: GitProjectInspectorV0,
	project: EndoWorkbenchProjectV0,
	path: string,
	area: string,
): Promise<EndoWorkbenchDiffV0> => {
	const outcome = await inspector.diff(project.snapshot, entry(project, path, area).id);
	if (outcome.kind !== "diff") throw new Error(`diff outcome ${outcome.kind}`);
	return outcome.diff;
};
const bodyOf = (diff: EndoWorkbenchDiffV0): string[] => diff.hunks.flatMap((h) => h.lines);

suite("the project context from a real repository", () => {
	it("reports a clean repository: its branch, head, worktree and that nothing has changed", async () => {
		const root = commitedRepo();
		const project = await inspect(root).overview();
		expect(project).toMatchObject({
			schemaVersion: "endo.workbench-project.v0",
			basis: "launch-directory",
			state: "ready",
			reason: null,
			head: { kind: "branch", branch: "main" },
			repository: { cwdRelative: "" },
			changes: {
				state: "ready",
				dirty: "clean",
				counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, exact: true },
				files: [],
			},
			incomplete: [],
		});
		expect(project.head?.oid).toMatch(/^[0-9a-f]{40,64}$/);
		expect(project.repository?.root).toBe(root);
		expect(project.worktrees).toHaveLength(1);
		expect(project.worktrees[0]).toMatchObject({ current: true, branch: "main" });
		expect(project.snapshot).toMatch(/^[0-9a-f]{16}$/);
	});

	it("keeps staged, unstaged and untracked changes apart, and one file changed twice is two entries", async () => {
		const root = dirtyRepo();
		const inspector = inspect(root);
		const project = await inspector.overview();
		expect(project.changes).toMatchObject({
			dirty: "dirty",
			counts: { staged: 2, unstaged: 3, untracked: 1, conflicted: 0, exact: true },
		});
		expect(project.changes.files.map((f) => `${f.area}:${f.status}:${f.path}`)).toEqual([
			"staged:modified:a.txt",
			"staged:renamed:new.txt",
			"unstaged:modified:a.txt",
			"unstaged:modified:bin.dat",
			"unstaged:deleted:gone.txt",
			"untracked:untracked:un tracked.txt",
		]);
		expect(entry(project, "new.txt", "staged")).toMatchObject({ origPath: "old.txt" });
		expect(entry(project, "a.txt", "staged")).toMatchObject({ additions: 2, deletions: 1, binary: false });
		expect(entry(project, "a.txt", "unstaged")).toMatchObject({ additions: 1, deletions: 0, binary: false });
		expect(entry(project, "bin.dat", "unstaged")).toMatchObject({ additions: null, deletions: null, binary: true });
		expect(entry(project, "gone.txt", "unstaged")).toMatchObject({ additions: 0, deletions: 1 });
		expect(entry(project, "un tracked.txt", "untracked")).toMatchObject({ additions: null, binary: null });
		// Staged and unstaged totals are never one number.
		expect(project.changes.stats).toEqual({
			staged: { additions: 2, deletions: 1, uncounted: 0 },
			unstaged: { additions: 1, deletions: 1, uncounted: 1 },
		});
	});

	it("reads each change under its own comparison", async () => {
		const root = dirtyRepo();
		const inspector = inspect(root);
		const project = await inspector.overview();
		const staged = await diffOf(inspector, project, "a.txt", "staged");
		expect(staged).toMatchObject({ comparison: "head-to-index", state: "ready", inventory: "unchanged" });
		expect(bodyOf(staged)).toEqual([" one", "-two", "+TWO", " three", "+four"]);
		const unstaged = await diffOf(inspector, project, "a.txt", "unstaged");
		expect(unstaged.comparison).toBe("index-to-working-tree");
		expect(bodyOf(unstaged)).toContain("+five");
		expect(bodyOf(unstaged)).not.toContain("+TWO");
		const renamed = await diffOf(inspector, project, "new.txt", "staged");
		expect(renamed.notes.join("\n")).toMatch(/rename from old\.txt/);
		expect(renamed.notes.join("\n")).toMatch(/rename to new\.txt/);
		expect(await diffOf(inspector, project, "bin.dat", "unstaged")).toMatchObject({ state: "binary", hunks: [] });
		const deleted = await diffOf(inspector, project, "gone.txt", "unstaged");
		expect(bodyOf(deleted)).toEqual(["-del"]);
		const untracked = await diffOf(inspector, project, "un tracked.txt", "untracked");
		expect(untracked).toMatchObject({ comparison: "untracked-file", state: "ready" });
		expect(bodyOf(untracked)).toEqual(["+u1", "+u2"]);
		expect(untracked.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
	});

	it("reports a detached HEAD, an unborn branch and several linked worktrees without calling any of them a session", async () => {
		const root = commitedRepo();
		const sibling = join(fixtureDir("trees"), "feature");
		git(root, "worktree", "add", "-q", sibling, "-b", "feature");
		const detached = join(fixtureDir("trees"), "detached");
		git(root, "worktree", "add", "-q", "--detach", detached);
		const project = await inspect(root).overview();
		expect(project.worktrees.map((w) => [w.branch, w.detached, w.current])).toEqual([
			["main", false, true],
			["feature", false, false],
			[null, true, false],
		]);
		const there = await inspect(sibling).overview();
		expect(there.head).toMatchObject({ kind: "branch", branch: "feature" });
		expect(there.repository?.label).toBe(project.repository?.label);
		expect(there.repository?.commonDir).toBe(project.repository?.commonDir);
		expect(there.worktrees.find((w) => w.current)?.branch).toBe("feature");
		const lonely = await inspect(detached).overview();
		expect(lonely.head).toMatchObject({ kind: "detached", branch: null });
		expect(lonely.head?.oid).toMatch(/^[0-9a-f]{40,64}$/);

		const unborn = fixtureDir("unborn");
		git(unborn, "init", "-q", "-b", "trunk");
		write(unborn, "first.txt", "x\n");
		git(unborn, "add", "first.txt");
		const fresh = await inspect(unborn).overview();
		expect(fresh.head).toEqual({ kind: "unborn", branch: "trunk", oid: null });
		expect(fresh.changes.files.map((f) => `${f.area}:${f.status}:${f.path}`)).toEqual(["staged:added:first.txt"]);
	});

	it("measures from a subdirectory of the repository, and says where the launch directory is", async () => {
		const root = commitedRepo();
		const project = await inspect(join(root, "src", "deep")).overview();
		expect(project.repository).toMatchObject({ root, cwdRelative: "src/deep" });
	});

	it("says what is missing instead of guessing: no directory, no repository, a bare repository, no Git, a stuck Git", async () => {
		const plain = fixtureDir("plain");
		expect(await inspect(plain).overview()).toMatchObject({
			state: "unavailable",
			reason: "not-a-repository",
			repository: null,
		});
		expect(await inspect(join(plain, "nowhere")).overview()).toMatchObject({
			state: "unavailable",
			reason: "no-directory",
		});
		const bare = fixtureDir("bare");
		git(bare, "init", "-q", "--bare");
		expect(await inspect(bare).overview()).toMatchObject({ state: "unavailable", reason: "bare-repository" });
		expect(await inspect(commitedRepo(), { gitPath: join(plain, "no-such-git") }).overview()).toMatchObject({
			state: "unavailable",
			reason: "git-not-found",
		});
		const stuck = await inspect(commitedRepo(), {
			runner: async () => ({
				code: null,
				stdout: Buffer.alloc(0),
				truncated: false,
				timedOut: true,
				notFound: false,
				stderr: "",
			}),
		}).overview();
		expect(stuck).toMatchObject({ state: "unavailable", reason: "git-timeout" });
		// Nothing of Git's own words reaches the answer.
		expect(JSON.stringify(stuck)).not.toMatch(/fatal|error:/i);
	});

	it("refuses a repository whose working tree is not the one holding the launch directory", async () => {
		const root = commitedRepo();
		const elsewhere = fixtureDir("elsewhere");
		git(root, "config", "core.worktree", elsewhere);
		expect(await inspect(root).overview()).toMatchObject({ state: "unavailable", repository: null });
		// A working tree that names an ANCESTOR of the launch directory contains it, but has no `.git` of its own: refused, not widened.
		const ancestor = commitedRepo();
		git(ancestor, "config", "core.worktree", join(ancestor, ".."));
		expect(await inspect(ancestor).overview()).toMatchObject({
			state: "unavailable",
			reason: "scope-mismatch",
			repository: null,
		});
	});

	it("refuses a nested repository whose working tree claims the enclosing repository's directory", async () => {
		const outer = commitedRepo();
		write(outer, "outer-secret.txt", "OUTER CONTENT\n");
		const inner = join(outer, "inner");
		mkdirSync(inner);
		git(inner, "init", "-q", "-b", "main");
		write(inner, "own.txt", "x\n");
		git(inner, "add", "own.txt");
		git(inner, "commit", "-q", "-m", "inner");
		// Without the claim, the inner repository is read as itself.
		const honest = await inspect(inner).overview();
		expect(honest).toMatchObject({ state: "ready", repository: { root: inner } });
		// With it, the root has a .git, but not the inner repository's.
		git(inner, "config", "core.worktree", outer);
		const project = await inspect(inner).overview();
		expect(project).toMatchObject({ state: "unavailable", reason: "scope-mismatch", repository: null });
		expect(JSON.stringify(project)).not.toContain("outer-secret");
	});

	it("bounds the list: a repository with more files than the limit says so, and still counts them", async () => {
		const root = commitedRepo();
		for (let i = 0; i < GIT_LIMITS_V0.maxFiles + 25; i++)
			write(root, `many/f${String(i).padStart(4, "0")}.txt`, "x\n");
		const project = await inspect(root).overview();
		expect(project.changes.files).toHaveLength(GIT_LIMITS_V0.maxFiles);
		expect(project.changes).toMatchObject({ filesTruncated: true, dirty: "dirty" });
		expect(project.changes.counts).toMatchObject({ untracked: GIT_LIMITS_V0.maxFiles + 25, exact: true });
	});

	it("marks counts as a lower bound when Git's own answer is cut", async () => {
		const root = commitedRepo();
		for (let i = 0; i < 400; i++) write(root, `many/${"n".repeat(80)}${i}.txt`, "x\n");
		// A runner that lets Git answer but hands the status back as a cut prefix, as the real cap would.
		const project = await inspect(root, {
			runner: async (args, options) => {
				const run = await runGitV0(args, options);
				return args.includes("status") ? { ...run, stdout: run.stdout.subarray(0, 5000), truncated: true } : run;
			},
		}).overview();
		expect(project.incomplete).toContain("status-truncated");
		expect(project.changes.counts.exact).toBe(false);
		expect(project.changes.dirty).toBe("dirty");
		expect(project.changes.files.length).toBeGreaterThan(0);
		expect(project.changes.files.length).toBeLessThan(400);
	});

	it("bounds one diff: a very long file is cut at a line limit, and a very long line is cut short, and both are said", async () => {
		const root = commitedRepo();
		write(
			root,
			"a.txt",
			`${Array.from({ length: GIT_LIMITS_V0.diffLines + 500 }, (_, i) => `line ${i}`).join("\n")}\n`,
		);
		write(root, "wide.txt", `${"w".repeat(GIT_LIMITS_V0.lineChars * 3)}\n`);
		const inspector = inspect(root);
		const project = await inspector.overview();
		const big = await diffOf(inspector, project, "a.txt", "unstaged");
		expect(big.truncated).toBe(true);
		expect(bodyOf(big).length).toBeLessThanOrEqual(GIT_LIMITS_V0.diffLines);
		const wide = await diffOf(inspector, project, "wide.txt", "untracked");
		expect(wide.longLines).toBe(true);
		expect((bodyOf(wide)[0] as string).length).toBeLessThanOrEqual(GIT_LIMITS_V0.lineChars + 2);
	});

	it("does not offer an untracked file over the read limit, and judges a binary untracked file as binary", async () => {
		const root = commitedRepo();
		write(root, "huge.log", Buffer.alloc(GIT_LIMITS_V0.untrackedBytes + 1, 0x61));
		write(root, "blob.bin", Buffer.from([1, 2, 0, 3]));
		write(root, "empty.txt", "");
		write(root, "nonl.txt", "no newline at end");
		const inspector = inspect(root);
		const project = await inspector.overview();
		expect(await diffOf(inspector, project, "huge.log", "untracked")).toMatchObject({
			state: "too-large",
			hunks: [],
		});
		expect(await diffOf(inspector, project, "blob.bin", "untracked")).toMatchObject({ state: "binary" });
		expect(await diffOf(inspector, project, "empty.txt", "untracked")).toMatchObject({ state: "empty" });
		expect(bodyOf(await diffOf(inspector, project, "nonl.txt", "untracked"))).toEqual([
			"+no newline at end",
			"\\ No newline at end of file",
		]);
	});
});

suite("it answers only for the working tree the page was shown", () => {
	it("refuses a diff once the file was edited, once the index moved, once the list was re-read, and for an entry that does not exist", async () => {
		const root = dirtyRepo();
		const inspector = inspect(root);
		const first = await inspector.overview();
		const id = entry(first, "a.txt", "unstaged").id;
		expect((await inspector.diff(first.snapshot, id)).kind).toBe("diff");

		// Edited again with the same size and a new time: the stamp moves.
		write(root, "a.txt", "one\nTWO\nthree\nfour\nsixx\n");
		const later = new Date(Date.now() + 5000);
		utimesSync(join(root, "a.txt"), later, later);
		expect(await inspector.diff(first.snapshot, id)).toEqual({ kind: "stale" });

		const second = await inspector.overview();
		const staged = entry(second, "a.txt", "staged").id;
		expect((await inspector.diff(second.snapshot, staged)).kind).toBe("diff");
		git(root, "add", "a.txt"); // the index moved: the entry is no longer the same change
		expect(await inspector.diff(second.snapshot, staged)).toEqual({ kind: "stale" });

		const third = await inspector.overview();
		expect(await inspector.diff(second.snapshot, 0)).toEqual({ kind: "stale" }); // an older snapshot
		expect((await inspector.diff(third.snapshot, 9999)).kind).toBe("bad");
		expect(await inspector.diff("0000000000000000", 0)).toEqual({ kind: "stale" });
	});

	it("refuses a diff after a same-length rewrite whose modification time was put back", async () => {
		const root = commitedRepo();
		write(root, "a.txt", "one\nTWO\nthree\n");
		write(root, "fresh.txt", "ONE\n");
		const inspector = inspect(root);
		const project = await inspector.overview();
		for (const [path, area, text] of [
			["a.txt", "unstaged", "one\nBAD\nthree\n"],
			["fresh.txt", "untracked", "BAD\n"],
		] as const) {
			const full = join(root, path);
			const before = statSync(full, { bigint: true });
			writeFileSync(full, text); // same length
			// The old modification time, to the nanosecond (a Date would only restore milliseconds, and the test would prove nothing).
			const ns = before.mtimeNs;
			execFileSync("touch", [
				"-m",
				"-d",
				`@${ns / 1_000_000_000n}.${String(ns % 1_000_000_000n).padStart(9, "0")}`,
				full,
			]);
			const after = statSync(full, { bigint: true });
			expect([after.size, after.mtimeNs, after.ino]).toEqual([before.size, before.mtimeNs, before.ino]);
			expect(await inspector.diff(project.snapshot, entry(project, path, area).id), path).toEqual({ kind: "stale" });
		}
	});

	it("refuses a staged diff when the change is committed between the status read and the patch read", async () => {
		const root = commitedRepo();
		write(root, "a.txt", "one\nTWO\nthree\n");
		git(root, "add", "a.txt");
		let commitBeforePatch = false;
		const inspector = inspect(root, {
			runner: async (args, options) => {
				// The agent commits in the instant after the status read and before the patch read.
				if (commitBeforePatch && args.includes("diff-index") && args.includes("-p")) {
					commitBeforePatch = false;
					git(root, "commit", "-q", "-m", "raced");
				}
				return runGitV0(args, options);
			},
		});
		const project = await inspector.overview();
		const id = entry(project, "a.txt", "staged").id;
		commitBeforePatch = true;
		expect(await inspector.diff(project.snapshot, id)).toEqual({ kind: "stale" });
		// Without the race the same entry would have been read.
		const quiet = commitedRepo();
		write(quiet, "a.txt", "one\nTWO\nthree\n");
		git(quiet, "add", "a.txt");
		const other = inspect(quiet);
		const p2 = await other.overview();
		expect((await other.diff(p2.snapshot, entry(p2, "a.txt", "staged").id)).kind).toBe("diff");
	});

	it("says the list of files has changed when only another file did, and still reads the one asked for", async () => {
		const root = dirtyRepo();
		const inspector = inspect(root);
		const project = await inspector.overview();
		write(root, "second-untracked.txt", "x\n");
		const diff = await diffOf(inspector, project, "a.txt", "staged");
		expect(diff.state).toBe("ready");
		expect(diff.inventory).toBe("changed");
	});

	it("refuses everything after the session ended", async () => {
		const root = dirtyRepo();
		const inspector = inspect(root);
		const project = await inspector.overview();
		inspector.dispose();
		expect(await inspector.diff(project.snapshot, 0)).toEqual({ kind: "stale" });
		expect(await inspector.overview()).toMatchObject({ state: "unavailable" });
	});

	it("serialises its reads, and says busy rather than queueing without limit", async () => {
		const root = dirtyRepo();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = 0;
		const inspector = inspect(root, {
			runner: async (args, options) => {
				if (args.includes("rev-parse") && held === 0) {
					held += 1;
					await gate;
				}
				return runGitV0(args, options);
			},
		});
		const running = inspector.overview();
		await new Promise((resolve) => setTimeout(resolve, 20));
		// Further overviews share the running one rather than starting their own.
		const shared = inspector.overview();
		release();
		const [a, b] = await Promise.all([running, shared]);
		expect(a.snapshot).toBe(b.snapshot);
	});
});

suite("what real Git sends in awkward cases, through the page's own gate", () => {
	it("reads files with no trailing newline, tracked and untracked, and the page's wire gate accepts them", async () => {
		const root = commitedRepo();
		write(root, "a.txt", "one\ntwo\nthree");
		write(root, "nonl.txt", "no newline");
		const inspector = inspect(root);
		const project = await inspector.overview();
		for (const [path, area] of [
			["a.txt", "unstaged"],
			["nonl.txt", "untracked"],
		] as const) {
			const diff = await diffOf(inspector, project, path, area);
			expect(
				bodyOf(diff).some((l) => l.startsWith("\\")),
				path,
			).toBe(true);
			expect(readWorkbenchDiff(JSON.parse(JSON.stringify(diff))), path).not.toBeNull();
		}
	});

	it("reads a file that becomes a symbolic link, staged and unstaged, as one change: not stale", async () => {
		const root = commitedRepo();
		rmSync(join(root, "old.txt"));
		symlinkSync("a.txt", join(root, "old.txt"));
		const inspector = inspect(root);
		let project = await inspector.overview();
		expect(entry(project, "old.txt", "unstaged").status).toBe("type-changed");
		const unstaged = await diffOf(inspector, project, "old.txt", "unstaged");
		expect(unstaged.state).toBe("ready");
		expect(readWorkbenchDiff(JSON.parse(JSON.stringify(unstaged)))).not.toBeNull();
		git(root, "add", "old.txt");
		project = await inspector.overview();
		const staged = await diffOf(inspector, project, "old.txt", "staged");
		expect(staged.state).toBe("ready");
		expect(bodyOf(staged).length).toBeGreaterThan(1);
		// A real change of the index in between is still stale: the check is not loosened.
		git(root, "commit", "-q", "-m", "link");
		expect(await inspector.diff(project.snapshot, entry(project, "old.txt", "staged").id)).toEqual({ kind: "stale" });
	});

	it("tells apart two files whose names look the same once made safe, by id, so each is read as itself", async () => {
		const root = commitedRepo();
		write(root, "a\nb.txt", "the one with a newline\n");
		write(root, "a\u240ab.txt", "the one with a picture\n");
		const inspector = inspect(root);
		const project = await inspector.overview();
		const twins = project.changes.files.filter((f) => f.area === "untracked" && f.path === "a\u240ab.txt");
		expect(twins).toHaveLength(2);
		expect(twins.map((f) => f.id)).toEqual([...new Set(twins.map((f) => f.id))]);
		const bodies: string[] = [];
		for (const twin of twins) {
			const outcome = await inspector.diff(project.snapshot, twin.id);
			if (outcome.kind !== "diff") throw new Error("not a diff");
			bodies.push(bodyOf(outcome.diff).join());
		}
		expect(bodies.sort()).toEqual(["+the one with a newline", "+the one with a picture"]);
	});
});

suite("a name that grows when made safe still fits what the page accepts", () => {
	it("reads a branch, a worktree branch and a path made of characters that each expand, and the page's gate accepts the whole project", async () => {
		const root = commitedRepo();
		const wide = `feature/${"\u202e".repeat(65)}`;
		git(root, "checkout", "-q", "-b", wide);
		git(root, "worktree", "add", "-q", join(fixtureDir("trees"), "w"), "-b", `side/${"\u0085".repeat(80)}`);
		write(root, `${"\u2066".repeat(80)}.txt`, "x\n"); // 240 bytes on disk; 640 characters once made safe
		const project = await inspect(root).overview();
		expect(project.head?.kind).toBe("branch");
		expect(project.head?.branch?.length).toBeLessThanOrEqual(200);
		expect(project.head?.branch).toContain("\u2026");
		expect(readWorkbenchProject(JSON.parse(JSON.stringify(project)))).not.toBeNull();
	});

	it("bounds the OUTPUT, whatever each character expands to, and never splits a character", () => {
		for (const [input, max] of [
			["\u202e".repeat(100), 50],
			["\u0085".repeat(100), 50],
			["\u0001".repeat(100), 50],
			["😀".repeat(100), 51],
			["plain text that is long enough", 10],
		] as const) {
			const safe = displaySafeV0(input, max);
			expect(safe.text.length, JSON.stringify(input.slice(0, 2))).toBeLessThanOrEqual(max);
			expect(safe.changed).toBe(true);
			expect(safe.cut).toBe(true);
			expect(safe.text.endsWith("\u2026")).toBe(true);
			expect(/[\ud800-\udbff]\u2026$/.test(safe.text)).toBe(false); // no half of a surrogate pair before the ellipsis
		}
		expect(displaySafeV0("zzzz", 4)).toEqual({ text: "zzzz", changed: false, cut: false });
	});
});

suite("one entry is exactly one path", () => {
	it("reads a file replaced by a directory, and the directory's new file, each as itself (staged and unstaged)", async () => {
		const root = commitedRepo();
		git(root, "rm", "-q", "gone.txt");
		write(root, "gone.txt/inner.txt", "inside\n");
		git(root, "add", "gone.txt/inner.txt");
		const inspector = inspect(root);
		let project = await inspector.overview();
		const deleted = await diffOf(inspector, project, "gone.txt", "staged");
		expect(deleted.state).toBe("ready");
		expect(bodyOf(deleted)).toEqual(["-del"]);
		const added = await diffOf(inspector, project, "gone.txt/inner.txt", "staged");
		expect(bodyOf(added)).toEqual(["+inside"]);
		// Unstaged: a tracked file whose place in the working tree is now a directory holding a tracked file of the index.
		const other = commitedRepo();
		write(other, "nest/keep.txt", "k\n");
		git(other, "add", "nest/keep.txt");
		git(other, "commit", "-q", "-m", "nest");
		write(other, "nest/keep.txt", "k2\n");
		project = await inspect(other).overview();
		const ins = inspect(other);
		project = await ins.overview();
		expect(bodyOf(await diffOf(ins, project, "nest/keep.txt", "unstaged"))).toEqual(["-k", "+k2"]);
	});

	it("reads a rename into its own descendant, and out of it, as one change: not stale", async () => {
		const root = commitedRepo();
		git(root, "mv", "old.txt", "tmp-move");
		mkdirSync(join(root, "old.txt"));
		git(root, "mv", "tmp-move", "old.txt/child");
		const inspector = inspect(root);
		const project = await inspector.overview();
		const into = await diffOf(inspector, project, "old.txt/child", "staged");
		// A pure rename has no lines to show: "empty", with Git's rename notes; what matters is that it is read, not refused as stale.
		expect(into.state).toBe("empty");
		expect(into.notes.join("\n")).toMatch(/rename from old\.txt/);
		const back = commitedRepo();
		mkdirSync(join(back, "nest"));
		git(back, "mv", "old.txt", "nest/old.txt");
		git(back, "commit", "-q", "-m", "nest");
		git(back, "mv", "nest/old.txt", "tmp-move");
		git(back, "mv", "tmp-move", "nest-file");
		const other = inspect(back);
		const p2 = await other.overview();
		const out = await diffOf(other, p2, "nest-file", "staged");
		expect(out.state).toBe("empty");
		expect(out.notes.join("\n")).toMatch(/rename to nest-file/);
	});

	it("matches Git's own patch header for every awkward name, so each file's patch is found", async () => {
		const root = commitedRepo();
		const names = ["fö o.txt", "t\tab.txt", 'q"uo\\te.txt', "plain name.txt", "del\u007f.txt"];
		for (const name of names) write(root, name, "a");
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "names");
		for (const name of names) write(root, name, "ab");
		const headers = execFileSync("git", ["-c", "core.quotePath=true", "diff-files", "-p"], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		})
			.split("\n")
			.filter((l) => l.startsWith("diff --git "));
		for (const name of names) expect(headers).toContain(patchHeaderV0(name, name));
		const inspector = inspect(root);
		const project = await inspector.overview();
		for (const file of project.changes.files.filter((f) => f.area === "unstaged"))
			expect((await inspector.diff(project.snapshot, file.id)).kind, file.path).toBe("diff");
		// Output that holds only other paths' patches is refused, never shown as an empty change.
		expect(selectPatchesV0("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n", patchHeaderV0("y", "y"))).toBeNull();
		expect(selectPatchesV0("", patchHeaderV0("y", "y"))).toBe("");
	});

	it("treats a name with wildcard characters as itself, not as a pattern matching its neighbours", async () => {
		const root = commitedRepo();
		write(root, "we*rd.txt", "a\n");
		write(root, "weZrd.txt", "b\n");
		git(root, "add", "we*rd.txt", "weZrd.txt");
		git(root, "commit", "-q", "-m", "names");
		write(root, "we*rd.txt", "a2\n");
		write(root, "weZrd.txt", "b2\n");
		const inspector = inspect(root);
		const project = await inspector.overview();
		expect(bodyOf(await diffOf(inspector, project, "we*rd.txt", "unstaged"))).toEqual(["-a", "+a2"]);
		expect(bodyOf(await diffOf(inspector, project, "weZrd.txt", "unstaged"))).toEqual(["-b", "+b2"]);
	});
});

suite("a failed configuration listing never lets the working tree be touched without its overrides", () => {
	it("refuses a diff, and runs no Git read that could reach a filter, when the listing cannot be completed", async () => {
		const root = commitedRepo();
		const out = fixtureDir("canaries-2");
		const script = join(out, "evil.sh");
		writeFileSync(script, `#!/bin/sh\ntouch "${out}/canary-$1"\ncat\n`);
		chmodSync(script, 0o755);
		write(root, ".gitattributes", "*.txt filter=evil\n");
		git(root, "add", ".gitattributes");
		git(root, "commit", "-q", "-m", "attrs");
		git(root, "config", "filter.evil.clean", `${script} clean`);
		git(root, "config", "filter.evil.process", `${script} process`);
		write(root, "a.txt", "one\nTWO\nthree\n");
		let breakListing = false;
		const calls: string[] = [];
		const inspector = inspect(root, {
			runner: async (args, options) => {
				const listing = args.includes("config") && args.includes("--list");
				if (breakListing && listing) {
					calls.push("config-listing (failed)");
					return {
						code: null,
						stdout: Buffer.alloc(0),
						truncated: true,
						timedOut: false,
						notFound: false,
						stderr: "",
					};
				}
				if (breakListing) calls.push(args.find((a) => !a.startsWith("--")) ?? "?");
				return runGitV0(args, options);
			},
		});
		const project = await inspector.overview();
		const id = entry(project, "a.txt", "unstaged").id;
		expect(readdirSync(out).filter((n) => n.startsWith("canary-"))).toEqual([]);
		breakListing = true; // the configuration has grown past what is read
		const outcome = await inspector.diff(project.snapshot, id);
		expect(outcome).toMatchObject({ kind: "diff", diff: { state: "unavailable", reason: "git-failed" } });
		// Nothing after the failed listing touched the working tree: no status, no diff, no hash.
		expect(calls).toEqual(["config-listing (failed)"]);
		expect(readdirSync(out).filter((n) => n.startsWith("canary-"))).toEqual([]);
	});
});

suite("more of what real Git does", () => {
	function partialClone() {
		const origin = commitedRepo();
		git(origin, "config", "uploadpack.allowFilter", "true");
		git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
		const clone = join(fixtureDir("clone"), "c");
		git(
			fixtureDir("clone-parent"),
			"clone",
			"-q",
			"--no-local",
			"--filter=blob:none",
			"--no-checkout",
			origin,
			clone,
		);
		git(clone, "read-tree", "HEAD"); // the index names blobs this clone does not hold
		const out = fixtureDir("canaries-promisor");
		const script = join(out, "upload.sh");
		writeFileSync(script, `#!/bin/sh\ntouch "${out}/canary-uploadpack"\nexec git-upload-pack "$@"\n`);
		chmodSync(script, 0o755);
		git(clone, "config", "remote.origin.uploadpack", script);
		write(clone, "a.txt", "changed\n");
		write(clone, "old.txt", "changed too\n");
		const objects = () => readdirSync(join(clone, ".git", "objects"), { recursive: true }).length;
		return { clone, out, objects };
	}
	const canaries = (out: string) => readdirSync(out).filter((n) => n.startsWith("canary-"));

	it("never fetches a missing object from a promisor remote: no program that remote names runs, and nothing is written", async () => {
		const { clone, out, objects } = partialClone();
		const before = objects();
		const inspector = inspect(clone);
		const project = await inspector.overview();
		for (const f of project.changes.files) await inspector.diff(project.snapshot, f.id);
		expect(canaries(out)).toEqual([]);
		expect(objects()).toBe(before);
	});

	it("refuses a partial clone on a Git that cannot be told not to fetch, rather than trusting configuration overrides that do not work", async () => {
		const { clone, out, objects } = partialClone();
		const before = objects();
		// A Git older than 2.44: it reports its version, and does not know the switch.
		const old = inspect(clone, {
			runner: async (args, options) => {
				if (args.includes("--version"))
					return {
						code: 0,
						stdout: Buffer.from("git version 2.40.1\n"),
						truncated: false,
						timedOut: false,
						notFound: false,
						stderr: "",
					};
				const { GIT_NO_LAZY_FETCH: _drop, ...env } = options.env;
				return runGitV0(args, { ...options, env });
			},
		});
		expect(await old.overview()).toMatchObject({ state: "unavailable", reason: "partial-clone", repository: null });
		expect(canaries(out)).toEqual([]);
		expect(objects()).toBe(before);
		// An ordinary repository is unaffected by the same old Git.
		const plain = inspect(commitedRepo(), {
			runner: async (args, options) =>
				args.includes("--version")
					? {
							code: 0,
							stdout: Buffer.from("git version 2.40.1\n"),
							truncated: false,
							timedOut: false,
							notFound: false,
							stderr: "",
						}
					: runGitV0(args, options),
		});
		expect((await plain.overview()).state).toBe("ready");
		expect(hasNoLazyFetchV0("git version 2.43.0")).toBe(false);
		expect(hasNoLazyFetchV0("git version 2.44.0")).toBe(true);
		expect(hasNoLazyFetchV0("git version 3.0.0")).toBe(true);
		expect(hasNoLazyFetchV0("not git")).toBe(false);
	});

	it("keeps the 5 000-line budget when the last line has no newline: the marker counts, and the page's gate accepts the result", async () => {
		const root = commitedRepo();
		write(root, "exact.txt", Array.from({ length: GIT_LIMITS_V0.diffLines }, (_, i) => `l${i}`).join("\n"));
		const inspector = inspect(root);
		const project = await inspector.overview();
		const diff = await diffOf(inspector, project, "exact.txt", "untracked");
		expect(bodyOf(diff).length).toBeLessThanOrEqual(GIT_LIMITS_V0.diffLines);
		expect(diff.truncated).toBe(true);
		expect(readWorkbenchDiff(JSON.parse(JSON.stringify(diff)))).not.toBeNull();
	});

	it("reads blank context lines even where the repository asks Git to leave out their leading space", async () => {
		const root = commitedRepo();
		write(root, "b.txt", "first\n\nthird\nfourth\n");
		git(root, "add", "b.txt");
		git(root, "commit", "-q", "-m", "blank");
		git(root, "config", "diff.suppressBlankEmpty", "true");
		write(root, "b.txt", "first\n\nTHIRD\nfourth\n");
		const inspector = inspect(root);
		let project = await inspector.overview();
		const unstaged = await diffOf(inspector, project, "b.txt", "unstaged");
		expect(bodyOf(unstaged)).toEqual([" first", " ", "-third", "+THIRD", " fourth"]);
		expect(unstaged.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
		git(root, "add", "b.txt");
		project = await inspector.overview();
		expect(bodyOf(await diffOf(inspector, project, "b.txt", "staged"))).toEqual([
			" first",
			" ",
			"-third",
			"+THIRD",
			" fourth",
		]);
	});
});

suite("what the operator's own Git would hide stays hidden", () => {
	function home(): string {
		const dir = fixtureDir("home");
		write(dir, ".config/git/ignore", "*.local\n");
		return dir;
	}
	it("honours the default global ignore file and a global core.excludesFile, though no global configuration is otherwise read", async () => {
		const repo = commitedRepo();
		write(repo, "secret.local", "TOKEN=1\n");
		write(repo, "notes.scratch", "n\n");
		write(repo, "visible.txt", "v\n");
		const h = home();
		// Default location: $HOME/.config/git/ignore.
		const byDefault = await inspect(repo, { env: { HOME: h } }).overview();
		expect(byDefault.changes.files.map((f) => f.path).sort()).toEqual(["notes.scratch", "visible.txt"]);
		// A global core.excludesFile (read from the global configuration, which runs nothing).
		write(h, "ignore-more", "*.scratch\n");
		writeFileSync(join(h, ".gitconfig"), "[core]\n\texcludesFile = ~/ignore-more\n[diff]\n\texternal = /bin/false\n");
		const configured = await inspect(repo, { env: { HOME: h } }).overview();
		expect(configured.changes.files.map((f) => f.path).sort()).toEqual(["secret.local", "visible.txt"]);
		// Without a home, nothing is hidden by the user's rules (and nothing is read from the real one).
		const none = await inspect(repo, { env: { HOME: fixtureDir("empty-home") } }).overview();
		expect(none.changes.files.map((f) => f.path)).toContain("secret.local");
	});

	it("lets a repository's own core.excludesFile win over the global one, as Git does", async () => {
		const repo = commitedRepo();
		write(repo, "secret.txt", "s\n");
		write(repo, "global-only.txt", "g\n");
		write(repo, "visible.txt", "v\n");
		const h = fixtureDir("home-excludes");
		write(h, "global-ignore", "global-only.txt\n");
		writeFileSync(join(h, ".gitconfig"), "[core]\n\texcludesFile = ~/global-ignore\n");
		write(repo, ".git/local-ignore", "secret.txt\n");
		git(repo, "config", "core.excludesFile", join(repo, ".git", "local-ignore"));
		const ordinary = execFileSync("git", ["status", "--porcelain", "-uall"], {
			cwd: repo,
			env: { ...process.env, HOME: h, GIT_CONFIG_GLOBAL: join(h, ".gitconfig") },
			encoding: "utf8",
		});
		expect(ordinary).not.toContain("secret.txt");
		expect(ordinary).toContain("global-only.txt");
		const project = await inspect(repo, { env: { HOME: h } }).overview();
		expect(project.changes.files.map((f) => f.path).sort()).toEqual(["global-only.txt", "visible.txt"]);
	});

	it("keeps an excludes-file name exactly, trailing spaces included", async () => {
		const repo = commitedRepo();
		write(repo, "secret.txt", "s\n");
		write(repo, "visible.txt", "v\n");
		const h = fixtureDir("home-spaces");
		write(h, "ignore rules ", "secret.txt\n");
		writeFileSync(join(h, ".gitconfig"), '[core]\n\texcludesFile = "~/ignore rules "\n');
		const project = await inspect(repo, { env: { HOME: h } }).overview();
		expect(project.changes.files.map((f) => f.path).sort()).toEqual(["visible.txt"]);
	});

	it("respects a repository that hides untracked files, says so, and does not scan its tree", async () => {
		const repo = commitedRepo();
		git(repo, "config", "status.showUntrackedFiles", "no");
		write(repo, "stray.txt", "x\n");
		write(repo, "a.txt", "changed\n");
		const inspector = inspect(repo);
		const project = await inspector.overview();
		expect(project.changes.files.map((f) => `${f.area}:${f.path}`)).toEqual(["unstaged:a.txt"]);
		expect(project.incomplete).toContain("untracked-hidden");
		expect(project.changes.counts.untracked).toBe(0);
		// A diff is read under the same rule.
		expect((await inspector.diff(project.snapshot, 0)).kind).toBe("diff");
	});
});

suite("a hostile repository cannot make it run anything, read outside, or write", () => {
	function hostile(): { root: string; out: string } {
		const root = commitedRepo();
		const out = fixtureDir("canaries");
		const script = join(out, "evil.sh");
		writeFileSync(script, `#!/bin/sh\ntouch "${out}/canary-$1"\ncat\n`);
		chmodSync(script, 0o755);
		write(root, ".gitattributes", "*.txt filter=evil diff=evil\n*.dat filter=a=b\n");
		git(root, "add", ".gitattributes");
		git(root, "commit", "-q", "-m", "attrs");
		const set = (key: string, value: string) => git(root, "config", key, value);
		set("core.fsmonitor", `${script} fsmonitor`);
		set("filter.evil.clean", `${script} clean`);
		set("filter.evil.smudge", `${script} smudge`);
		set("filter.evil.process", `${script} process`);
		set("filter.a=b.clean", `${script} weirdclean`); // a key with `=` in it must still be switched off
		set("diff.evil.textconv", `${script} textconv`);
		set("diff.external", `${script} external`);
		set("core.hooksPath", join(out, "hooks"));
		set("core.pager", `${script} pager`);
		set("pager.diff", `${script} pagerdiff`);
		mkdirSync(join(out, "hooks"));
		for (const hook of ["post-index-change", "pre-commit", "post-checkout"]) {
			writeFileSync(join(out, "hooks", hook), `#!/bin/sh\ntouch "${out}/canary-hook-${hook}"\n`);
			chmodSync(join(out, "hooks", hook), 0o755);
		}
		// A modification of every file kind that would reach a filter, a textconv or an external diff.
		write(root, "a.txt", "one\nTWO\nthree\n");
		write(root, "bin.dat", Buffer.from([9, 9, 9]));
		return { root, out };
	}

	it("sanity: the same repository DOES run its programs for a plain Git read (so the canaries are real)", () => {
		const { root, out } = hostile();
		execFileSync("git", ["status", "--porcelain"], {
			cwd: root,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
			stdio: "ignore",
		});
		try {
			execFileSync("git", ["diff"], {
				cwd: root,
				env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_PAGER: "cat" },
				stdio: "ignore",
			});
		} catch {
			/* a failing external diff is still a program that ran */
		}
		expect(readdirSync(out).filter((n) => n.startsWith("canary-")).length).toBeGreaterThan(0);
	});

	it("runs none of them while reading the project and every diff", async () => {
		const { root, out } = hostile();
		const inspector = inspect(root);
		const project = await inspector.overview();
		expect(project.state).toBe("ready");
		expect(project.changes.files.length).toBeGreaterThan(0);
		for (const file of project.changes.files) await inspector.diff(project.snapshot, file.id);
		expect(readdirSync(out).filter((n) => n.startsWith("canary-"))).toEqual([]);
	});

	it("switches off a filter or diff driver with an EMPTY name, which a repository can select with `filter=`", async () => {
		const root = commitedRepo();
		const out = fixtureDir("canaries-empty");
		const script = join(out, "evil.sh");
		writeFileSync(script, `#!/bin/sh\ntouch "${out}/canary-$1"\ncat\n`);
		chmodSync(script, 0o755);
		write(root, ".gitattributes", "*.txt filter= diff=\n");
		git(root, "add", ".gitattributes");
		git(root, "commit", "-q", "-m", "attrs");
		const config = join(root, ".git", "config");
		writeFileSync(
			config,
			`${readFileSync(config, "utf8")}[filter ""]\n\tclean = ${script} clean\n\tsmudge = ${script} smudge\n[diff ""]\n\ttextconv = ${script} textconv\n\tcommand = ${script} command\n`,
		);
		write(root, "a.txt", "one\nTWO\nthree\n");
		// The canaries are real: a plain Git read runs the empty-named filter.
		execFileSync("git", ["status", "--porcelain"], {
			cwd: root,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
			stdio: "ignore",
		});
		expect(readdirSync(out).filter((n) => n.startsWith("canary-")).length).toBeGreaterThan(0);
		for (const name of readdirSync(out)) if (name.startsWith("canary-")) rmSync(join(out, name));
		const inspector = inspect(root);
		const project = await inspector.overview();
		expect(project.state).toBe("ready");
		for (const file of project.changes.files) await inspector.diff(project.snapshot, file.id);
		expect(readdirSync(out).filter((n) => n.startsWith("canary-"))).toEqual([]);
		// Every program-bearing key of an empty-named driver is switched off, process and required included.
		expect(
			Object.fromEntries(
				programKeysV0([
					"filter..clean",
					"filter..smudge",
					"filter..process",
					"filter..required",
					"diff..textconv",
					"diff..command",
					"diff..cachetextconv",
				]),
			),
		).toEqual({
			"filter..clean": "",
			"filter..smudge": "",
			"filter..process": "",
			"filter..required": "false",
			"diff..textconv": "",
			"diff..command": "",
			"diff..cachetextconv": "false",
		});
	});

	it("writes nothing to the repository: the index and the Git directory are untouched, even when a read could have refreshed them", async () => {
		const root = dirtyRepo();
		// A file whose recorded stat is out of date makes a plain `git status` rewrite the index.
		const later = new Date(Date.now() + 10_000);
		utimesSync(join(root, "src", "deep", "file.ts"), later, later);
		const snapshot = () =>
			readdirSync(join(root, ".git"), { recursive: true, withFileTypes: false })
				.map(String)
				.sort()
				.map((p) => {
					const s = statSync(join(root, ".git", p));
					return `${p}:${s.isDirectory() ? "d" : s.size}:${s.mtimeMs}`;
				});
		const before = snapshot();
		const bytes = readFileSync(join(root, ".git", "index"));
		const inspector = inspect(root);
		const project = await inspector.overview();
		for (const file of project.changes.files) await inspector.diff(project.snapshot, file.id);
		expect(readFileSync(join(root, ".git", "index")).equals(bytes)).toBe(true);
		expect(snapshot()).toEqual(before);
		expect(existsSync(join(root, ".git", "index.lock"))).toBe(false);
	});

	it("does not follow a link, read a pipe, or leave the working tree for an untracked path", async () => {
		const root = commitedRepo();
		const outside = fixtureDir("outside");
		write(outside, "secret.txt", "TOP SECRET\n");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		symlinkSync(outside, join(root, "linkdir"));
		const inspector = inspect(root);
		const project = await inspector.overview();
		for (const path of ["link.txt", "linkdir"]) {
			const diff = await diffOf(inspector, project, path, "untracked");
			expect(diff).toMatchObject({ state: "unavailable", reason: "not-a-file", hunks: [] });
		}
		// Git does not list a pipe at all; and a plain file swapped for a pipe or a link AFTER the list was read is stale, not opened.
		write(root, "swap.txt", "x\n");
		const listed = await inspector.overview();
		const swap = entry(listed, "swap.txt", "untracked").id;
		rmSync(join(root, "swap.txt"));
		execFileSync("mkfifo", [join(root, "swap.txt")]);
		expect(await inspector.diff(listed.snapshot, swap)).toEqual({ kind: "stale" });
		rmSync(join(root, "swap.txt"));
		symlinkSync(join(outside, "secret.txt"), join(root, "swap.txt"));
		expect(await inspector.diff(listed.snapshot, swap)).toEqual({ kind: "stale" });
		expect(JSON.stringify(project)).not.toContain("TOP SECRET");
	});

	it("makes a name display-safe: control characters, escapes and bidirectional marks are replaced and flagged", async () => {
		const root = commitedRepo();
		const nasty = "a\u001b[31mred‮exe.txt";
		write(root, nasty, "x\n");
		write(root, "line\nbreak.txt", "y\n");
		const inspector = inspect(root);
		const project = await inspector.overview();
		const shown = project.changes.files.filter((f) => f.area === "untracked");
		expect(shown).toHaveLength(2);
		for (const f of shown) {
			expect(f.escaped).toBe(true);
			expect(f.path).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f‪-‮]/);
		}
		// It can still be read, by id, from the exact name it has.
		expect((await inspector.diff(project.snapshot, shown[0]?.id as number)).kind).toBe("diff");
		write(root, "a.txt", "one\ntwo\nthree\n\u001b]0;title\u0007\nrtl ‮ end\n");
		const second = await inspector.overview();
		const diff = await diffOf(inspector, second, "a.txt", "unstaged");
		expect(bodyOf(diff).join("\n")).not.toMatch(/[\u001b\u0007‮]/);
	});

	it("does not accept a path that is not valid UTF-8 as exact, and never asks Git for it", async () => {
		const root = commitedRepo();
		// A name with a lone 0xff byte: valid on Linux, not text.
		execFileSync("sh", ["-c", `printf x > "$(printf '%s/bad\\377name' "$1")"`, "sh", root]);
		const inspector = inspect(root);
		const project = await inspector.overview();
		const bad = project.changes.files.find((f) => f.area === "untracked" && f.escaped);
		expect(bad).toBeDefined();
		const outcome = await inspector.diff(project.snapshot, bad?.id as number);
		expect(outcome).toMatchObject({ kind: "diff", diff: { state: "unavailable", reason: "path-not-text" } });
	});
});

describe("the pure parts", () => {
	it("lists only the keys that make Git run a program, in the case Git printed them, and switches each off", () => {
		const keys = programKeysV0([
			"core.fsmonitor",
			"filter.Evil.clean",
			"filter.Evil.required",
			"diff.x.textconv",
			"diff.x.cachetextconv",
			"pager.diff",
			"core.editor",
			"user.name",
			"remote.origin.url",
			"filter.a=b.process",
		]);
		expect(Object.fromEntries(keys)).toEqual({
			"filter.Evil.clean": "",
			"filter.Evil.required": "false",
			"diff.x.textconv": "",
			"diff.x.cachetextconv": "false",
			"pager.diff": "false",
			"core.editor": "",
			"filter.a=b.process": "",
		});
	});

	it("passes overrides as environment config, never through a character a key contains", () => {
		const env = gitEnvV0([["filter.a=b.clean", ""]]);
		expect(Object.keys(env)).not.toContain("GIT_DIR");
		expect(
			Object.keys(env).filter(
				(k) =>
					k.startsWith("GIT_") && !/^GIT_(CONFIG|ATTR|OPTIONAL|TERMINAL|NO_REPLACE|NO_LAZY_FETCH|PAGER)/.test(k),
			),
		).toEqual([]);
		const count = Number(env.GIT_CONFIG_COUNT);
		const pairs = Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
		expect(pairs).toContainEqual(["filter.a=b.clean", ""]);
		expect(pairs).toContainEqual(["core.fsmonitor", "false"]);
		expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
	});

	it("parses a cut status without reading half a record, and a rename whose old name was cut", () => {
		const whole = Buffer.from(
			[
				"# branch.oid abc",
				"# branch.head main",
				"1 M. N... 100644 100644 100644 aaa bbb x.txt",
				"? tail.txt",
				"",
			].join("\0"),
			"utf8",
		);
		const cut = whole.subarray(0, whole.length - 5); // ends inside "? tail.txt"
		expect(parseStatusV2(cut, true).changes.map((c) => c.path)).toEqual(["x.txt"]);
		const rename = Buffer.from("2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\0", "utf8");
		const parsed = parseStatusV2(rename, true);
		expect(parsed.changes).toEqual([]);
		expect(parsed.truncated).toBe(true);
	});

	it("parses numstat renames and binary, and worktree lists with locked and prunable", () => {
		const stat = parseNumstat(
			Buffer.from("2\t1\ta.txt\0" + "0\t0\t\0old.txt\0new.txt\0" + "-\t-\tbin.dat\0", "utf8"),
		);
		expect(stat.get("a.txt")).toEqual({ additions: 2, deletions: 1, binary: false });
		expect(stat.get("new.txt")).toEqual({ additions: 0, deletions: 0, binary: false });
		expect(stat.get("bin.dat")).toEqual({ additions: null, deletions: null, binary: true });
		const trees = parseWorktrees(
			Buffer.from(
				"worktree /r\0HEAD aaa\0branch refs/heads/main\0\0worktree /w\0HEAD bbb\0detached\0locked in use\0prunable gone\0\0",
				"utf8",
			),
		);
		expect(trees).toMatchObject([
			{ path: "/r", branch: "main", locked: false },
			{ path: "/w", detached: true, locked: true, prunable: true },
		]);
	});

	it("does not take a diff body for headers: a removed line that looks like a header stays a body line", () => {
		const text = [
			"diff --git a/f b/f",
			"index 111..222 100644",
			"--- a/f",
			"+++ b/f",
			"@@ -1,2 +1,1 @@ fn",
			"--- not a header",
			"-- x",
			"+kept",
			"",
		].join("\n");
		const parsed = parseUnifiedDiff(text, false);
		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.hunks[0]?.lines).toEqual(["--- not a header", "-- x", "+kept"]);
	});

	it("keeps tab, replaces control characters and bidirectional marks, and cuts long text", () => {
		expect(displaySafeV0("a\tb").changed).toBe(false);
		expect(displaySafeV0("a\u001bb").text).toBe("a␛b");
		expect(displaySafeV0("x‮y").text).toContain("U+202E");
		expect(displaySafeV0("z".repeat(10), 4)).toEqual({ text: "zzz…", changed: true, cut: true });
	});
});
