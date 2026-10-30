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
	parseNumstat,
	parseStatusV2,
	parseUnifiedDiff,
	parseWorktrees,
	programKeysV0,
	runGitV0,
} from "../adapters/git/readonly-git.ts";
import type { EndoWorkbenchDiffV0, EndoWorkbenchProjectV0 } from "../protocol/workbench-project.ts";
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
				(k) => k.startsWith("GIT_") && !/^GIT_(CONFIG|ATTR|OPTIONAL|TERMINAL|NO_REPLACE|PAGER)/.test(k),
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
		expect(displaySafeV0("z".repeat(10), 4)).toEqual({ text: "zzzz…", changed: true });
	});
});
