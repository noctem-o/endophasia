// What Git says about one working tree's revision, read-only: the observation a verification receipt is bound to
// (docs/designs/develop-verification-receipts.md). It answers, for ONE directory the operator chose (never a path from a browser or from a
// receipt): which repository and worktree is this, which commit and tree is HEAD, is anything staged, unstaged, untracked or conflicted,
// does the index hide anything from that answer (assume-unchanged, skip-worktree, a submodule), and where are HEAD's reflogs.
//
// Every Git read is one of a short fixed list with fixed arguments, run under the hardening of `readonly-git.ts` (no repository
// programs, no global or system configuration except the operator's ignore file, no lazy fetch, no locks, bounded time and output).
// Nothing here writes, stages, checks out, fetches or runs a command a caller names. What it returns is a transient observation; the
// caller decides what to record.
import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	failureReasonV0,
	GIT_LIMITS_V0,
	GIT_PREFIX_V0,
	type GitRunnerV0,
	type GitRunV0,
	gitEnvV0,
	parseStatusV2,
	type RawChangeV0,
	repositoryOverridesV0,
	runGitV0,
} from "./readonly-git.ts";

/** Why a working tree could not be observed. Nothing about its revision is known. */
export type EndoRevisionUnavailableV0 =
	| "no-directory"
	| "not-a-repository"
	| "bare-repository"
	| "not-top-level"
	| "scope-mismatch"
	| "unsafe-config"
	| "partial-clone"
	| "unborn"
	| "ownership"
	| "git-not-found"
	| "git-timeout"
	| "git-failed"
	| "output-too-large";

/** What makes a tree not the clean committed state a receipt can name. */
export type EndoRevisionDirtyV0 = "changes" | "flagged-entries" | "submodule";

export interface EndoRevisionObservationV0 {
	/** The top of the working tree and the common Git directory, as real paths. */
	worktree: string;
	commonDir: string;
	/** A linked worktree (its Git directory is not the common one). */
	linked: boolean;
	commit: string;
	tree: string;
	/** The branch HEAD names (`refs/heads/...`), or null when HEAD is detached. */
	branch: string | null;
	/** Why the tree is not clean and committed; empty when it is. */
	dirty: EndoRevisionDirtyV0[];
	/**
	 * HEAD's reflog and, on a branch, the branch's reflog, each as read through Git (entry count and newest entry, digested), or null where
	 * Git has none to give (no reflog was ever written for it). Equal values before and after a check mean no LOGGED ref update happened in
	 * between; a ref written directly, without a log entry, is not seen. Never stored: only compared.
	 */
	reflogs: { head: string | null; branch: string | null };
	/**
	 * A digest of what decides which files Git ignores and how it compares them, beyond the tracked tree: the repository's configuration
	 * listing (names and values, digested here and never stored) and the stamp of `info/exclude`. A change between two observations means
	 * the second "clean" was judged under different rules.
	 */
	rules: string;
	/**
	 * Only when asked (`{ changes: true }`): every entry of the status this observation was judged on, as Git listed it (staged, unstaged,
	 * untracked, conflicted), and whether the list was cut.
	 */
	changes?: { list: RawChangeV0[]; truncated: boolean };
}

/** One entry of a commit's tree at a path: a file (mode and blob id), a directory or a submodule (`other`), or nothing. */
export type GitTreeEntryV0 = { kind: "file"; mode: string; oid: string } | { kind: "other" } | { kind: "absent" };

export type EndoRevisionObservedV0 =
	| { ok: true; observation: EndoRevisionObservationV0 }
	| { ok: false; reason: EndoRevisionUnavailableV0 };

export interface GitRevisionObserverOptionsV0 {
	gitPath?: string;
	/** For tests: how a Git process is run. */
	runner?: GitRunnerV0;
	/** Where the operator's own Git configuration lives (for their ignore file). Default: this process's HOME and XDG_CONFIG_HOME. */
	env?: { HOME?: string; XDG_CONFIG_HOME?: string };
}

const HEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Overrides for these reads only, beyond the hardening every read has: the repository cannot weaken how Git notices a changed file
 * (`core.checkStat=minimal`, `core.trustctime=false`), and an index-wide "untracked cache" or file-system monitor is not trusted.
 */
const OBSERVER_CONFIG: readonly (readonly [string, string])[] = [
	["core.checkStat", "default"],
	["core.trustctime", "true"],
	["core.untrackedCache", "false"],
	["status.showUntrackedFiles", "all"],
];

const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/**
 * Size, modification and change times (ns) and inode of a path, as itself (never followed) AND as what it names (followed): Git reads an
 * ignore file through a symbolic link, so editing the link's target must change the stamp as surely as replacing the link. Nothing is
 * read from the file. A word stands for what cannot be stamped.
 */
async function stampOf(path: string | Buffer): Promise<string> {
	const one = (s: Awaited<ReturnType<typeof lstat>> & { mtimeNs: bigint; ctimeNs: bigint }) =>
		`${s.isFile() ? "f" : s.isSymbolicLink() ? "l" : "o"}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
	let own: string;
	try {
		own = one(await lstat(path, { bigint: true }));
	} catch {
		return "absent";
	}
	try {
		return `${own}>${one(await stat(path, { bigint: true }))}`;
	} catch {
		return `${own}>absent`;
	}
}

/** Lines of a Git answer that must be exactly `count` non-empty lines and a closing newline, or null. */
function lines(run: GitRunV0, count: number): string[] | null {
	const out = run.stdout.toString("utf8").split("\n");
	if (out.length !== count + 1 || out[count] !== "" || out.slice(0, count).some((line) => line === "")) return null;
	return out.slice(0, count);
}

export class GitRevisionObserverV0 {
	readonly #git: string;
	readonly #run: GitRunnerV0;
	readonly #home: { HOME?: string; XDG_CONFIG_HOME?: string } | undefined;

	constructor(options: GitRevisionObserverOptionsV0 = {}) {
		this.#git = options.gitPath ?? "git";
		this.#run = options.runner ?? runGitV0;
		this.#home = options.env;
	}

	#read(
		cwd: string,
		args: readonly string[],
		maxBytes: number,
		extra: readonly (readonly [string, string])[] = [],
		readGlobalConfig = false,
		/** The arguments carry `:(glob)` pathspec magic of their own, so the global `--literal-pathspecs` is left off. */
		ownPathspecs = false,
	): Promise<GitRunV0> {
		const prefix = ownPathspecs ? GIT_PREFIX_V0.filter((flag) => flag !== "--literal-pathspecs") : GIT_PREFIX_V0;
		return this.#run([...prefix, ...args], {
			cwd,
			env: gitEnvV0(extra, { ...(this.#home === undefined ? {} : { home: this.#home }), readGlobalConfig }),
			limits: { timeoutMs: GIT_LIMITS_V0.timeoutMs, maxBytes },
			gitPath: this.#git,
		}).catch(() => ({
			code: null,
			stdout: Buffer.alloc(0),
			truncated: false,
			timedOut: false,
			notFound: false,
			stderr: "",
		}));
	}

	/**
	 * Observe the working tree whose TOP is `directory`. A subdirectory is refused (`not-top-level`): what is observed is what runs. With
	 * `{ within: true }` the directory may be anywhere inside a working tree (for comparing a receipt with the tree a reader is in).
	 */
	async observe(
		directory: string,
		options: { within?: boolean; changes?: boolean } = {},
	): Promise<EndoRevisionObservedV0> {
		const fail = (reason: EndoRevisionUnavailableV0): EndoRevisionObservedV0 => ({ ok: false, reason });
		const failed = (run: GitRunV0): EndoRevisionObservedV0 | null => {
			const reason = failureReasonV0(run);
			if (reason === "ownership" || reason === "not-a-repository") return fail(reason);
			if (reason === "git-not-found" || reason === "git-timeout") return fail(reason);
			if (reason !== null) return fail("git-failed");
			if (run.truncated) return fail("output-too-large");
			return null;
		};
		let cwd: string;
		try {
			cwd = await realpath(directory);
			if (!(await stat(cwd)).isDirectory()) return fail("no-directory");
		} catch {
			return fail("no-directory");
		}
		const kind = await this.#read(
			cwd,
			["rev-parse", "--is-bare-repository", "--is-inside-work-tree"],
			GIT_LIMITS_V0.listBytes,
		);
		const kindFailure = failed(kind);
		if (kindFailure !== null) return kindFailure;
		const [bare, inside] = kind.stdout.toString("utf8").split("\n");
		if (bare === "true") return fail("bare-repository");
		if (inside !== "true") return fail("not-a-repository");
		const where = await this.#read(
			cwd,
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"],
			GIT_LIMITS_V0.listBytes,
		);
		const whereFailure = failed(where);
		if (whereFailure !== null) return whereFailure;
		// Exactly three paths: a path with a newline in it cannot be read unambiguously, so it is not guessed at.
		const paths = lines(where, 3);
		if (paths === null) return fail("git-failed");
		let root: string;
		let common: string;
		let gitDir: string;
		try {
			[root, common, gitDir] = await Promise.all(paths.map((path) => realpath(path)));
		} catch {
			return fail("git-failed");
		}
		if (options.within === true ? !(cwd === root || cwd.startsWith(`${root}/`)) : root !== cwd)
			return fail(options.within === true ? "scope-mismatch" : "not-top-level");
		// The repository must be the one kept AT this directory: a `.git` here (a directory, or a linked worktree's file). A `core.worktree`
		// naming this directory from elsewhere has none, and is refused rather than followed.
		try {
			await lstat(join(root, ".git"));
		} catch {
			return fail("scope-mismatch");
		}

		// Git, asked from the root, must find the same Git directory (a nested repository can claim an enclosing one's directory).
		const atRoot = await this.#read(
			root,
			["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
			GIT_LIMITS_V0.listBytes,
		);
		const rootDir = atRoot.code === 0 ? lines(atRoot, 1)?.[0] : undefined;
		try {
			if (rootDir === undefined || (await realpath(rootDir)) !== gitDir) return fail("scope-mismatch");
		} catch {
			return fail("scope-mismatch");
		}
		// Everything below reads the whole tree, from its top, whichever directory inside it was given: the index, the status, the ignore
		// rules and the reflogs are the worktree's, and a relative path in the configuration is resolved there.
		cwd = root;

		const overrides = await repositoryOverridesV0((args, maxBytes) => this.#read(cwd, args, maxBytes));
		if (typeof overrides === "string") return fail(asUnavailable(overrides));
		// The operator's own ignore file, as their Git would use it (a file of patterns: it runs nothing).
		const global = await this.#read(
			cwd,
			["config", "-z", "--type=path", "--get", "core.excludesFile"],
			GIT_LIMITS_V0.listBytes,
			[],
			true,
		);
		const rawExcludes = global.code === 0 ? global.stdout.toString("utf8") : "";
		const configured = rawExcludes.includes("\0") ? rawExcludes.slice(0, rawExcludes.indexOf("\0")) : "";
		// One path for both Git and the stamp below: a relative one is made absolute against the top of the tree, and passed on so.
		const excludes = configured === "" || isAbsolute(configured) ? configured : resolve(root, configured);
		const keys: (readonly [string, string])[] = [
			...overrides.keys,
			...OBSERVER_CONFIG,
			...(excludes !== "" && !excludes.includes("\n") ? [["core.excludesFile", excludes] as const] : []),
		];
		// The rules "clean" is judged under, so that a check cannot add an untracked file and hide it from the second observation by changing
		// them: the configuration listing with values (digested, never kept), the operator's ignore file (the one configured, or Git's default
		// one when none is), info/exclude, and every `.gitignore` in the tree that is itself ignored (a tracked or untracked one that is not
		// ignored already shows in the status). Stamps only: nothing is read from those files here.
		const listing = await this.#read(cwd, ["config", "--includes", "--list", "-z"], GIT_LIMITS_V0.listBytes);
		const listingFailure = failed(listing);
		if (listingFailure !== null) return listingFailure;
		const home = this.#home ?? { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
		const userIgnore =
			excludes !== ""
				? excludes
				: home.XDG_CONFIG_HOME !== undefined && home.XDG_CONFIG_HOME !== ""
					? join(home.XDG_CONFIG_HOME, "git", "ignore")
					: home.HOME !== undefined && home.HOME !== ""
						? join(home.HOME, ".config", "git", "ignore")
						: "";
		const hidden = await this.#read(
			cwd,
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ":(glob)**/.gitignore"],
			GIT_LIMITS_V0.listBytes,
			keys,
			false,
			true,
		);
		const hiddenFailure = failed(hidden);
		if (hiddenFailure !== null) return hiddenFailure;
		// The names are taken as BYTES (a directory name need not be UTF-8): decoded, a name with an invalid byte would stamp some other,
		// absent path, and a change to the file Git reads would go unseen.
		const hiddenStamps: string[] = [];
		const rootBytes = Buffer.from(`${root}/`, "utf8");
		for (
			let start = 0, at = hidden.stdout.indexOf(0);
			at !== -1;
			start = at + 1, at = hidden.stdout.indexOf(0, start)
		) {
			const name = hidden.stdout.subarray(start, at);
			if (name.length > 0)
				hiddenStamps.push(`${name.toString("hex")}:${await stampOf(Buffer.concat([rootBytes, name]))}`);
		}
		const rules = sha256(
			[
				sha256(listing.stdout),
				userIgnore,
				userIgnore === "" ? "" : await stampOf(userIgnore),
				await stampOf(join(common, "info", "exclude")),
				sha256(hiddenStamps.join("\n")),
			].join("\0"),
		);

		const head = await this.#read(cwd, ["rev-parse", "HEAD^{commit}", "HEAD^{tree}"], GIT_LIMITS_V0.listBytes, keys);
		if (
			head.code !== 0 &&
			failureReasonV0(head) === "git-failed" &&
			/unknown revision|ambiguous argument|bad revision|needed a single revision/i.test(head.stderr)
		)
			return fail("unborn");
		const headFailure = failed(head);
		if (headFailure !== null) return headFailure;
		const ids = lines(head, 2);
		if (ids === null || !ids.every((id) => HEX.test(id))) return fail("git-failed");
		const [commit, tree] = ids as [string, string];

		// The branch HEAD names, if any. `symbolic-ref -q` exits 1, printing nothing, when HEAD is detached.
		const symbolic = await this.#read(cwd, ["symbolic-ref", "-q", "HEAD"], GIT_LIMITS_V0.listBytes, keys);
		let branch: string | null = null;
		if (symbolic.code === 0) {
			const name = lines(symbolic, 1)?.[0];
			if (
				name === undefined ||
				!name.startsWith("refs/") ||
				name.split("/").some((part) => part === ".." || part === "")
			)
				return fail("git-failed");
			branch = name;
		} else if (symbolic.code !== 1 || symbolic.truncated || symbolic.timedOut || symbolic.notFound)
			return failed(symbolic) ?? fail("git-failed");

		const status = await this.#read(
			cwd,
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--untracked-files=all",
				"--ignore-submodules=all",
				"--no-renames",
				"--no-ahead-behind",
			],
			GIT_LIMITS_V0.statusBytes,
			keys,
		);
		const statusFailure = failed(status);
		if (statusFailure !== null) return statusFailure;
		const parsed = parseStatusV2(status.stdout, false);
		// The index entries, with their flags: one that is assume-unchanged (a lower-case tag) or skip-worktree (`S`, `s`) is left out of the
		// status above, and a gitlink (mode 160000, a submodule) names a commit whose files are not this tree's.
		const index = await this.#read(cwd, ["ls-files", "--stage", "-v", "-z"], GIT_LIMITS_V0.statusBytes, keys);
		const indexFailure = failed(index);
		if (indexFailure !== null) return indexFailure;
		let flagged = false;
		let submodule = false;
		for (
			let start = 0, at = index.stdout.indexOf(0);
			at !== -1;
			start = at + 1, at = index.stdout.indexOf(0, start)
		) {
			const record = index.stdout.subarray(start, at).toString("utf8");
			const match = /^(\S) (\d{6}) [0-9a-f]+ (\d)\t/.exec(record);
			if (match === null) return fail("git-failed");
			if (match[1] !== "H") flagged = true;
			if (match[2] === "160000") submodule = true;
		}
		const dirty: EndoRevisionDirtyV0[] = [];
		if (parsed.changes.length > 0) dirty.push("changes");
		if (flagged) dirty.push("flagged-entries");
		if (submodule) dirty.push("submodule");
		return {
			ok: true,
			observation: {
				worktree: root,
				commonDir: common,
				linked: common !== gitDir,
				commit,
				tree,
				branch,
				dirty,
				reflogs: {
					head: await this.#reflog(cwd, "HEAD", keys),
					branch: branch === null ? null : await this.#reflog(cwd, branch, keys),
				},
				rules,
				...(options.changes === true
					? { changes: { list: parsed.changes, truncated: parsed.truncated || status.truncated } }
					: {}),
			},
		};
	}

	/** The overrides every read of this repository needs (its program-bearing keys switched off), or null when it cannot be read safely. */
	async #keys(cwd: string): Promise<(readonly [string, string])[] | null> {
		const overrides = await repositoryOverridesV0((args, maxBytes) => this.#read(cwd, args, maxBytes));
		return typeof overrides === "string" ? null : [...overrides.keys, ...OBSERVER_CONFIG];
	}

	/**
	 * What `commit`'s tree holds at each of `paths` (relative to the top of the tree), read with `ls-tree` in batches. Null when Git could
	 * not answer (the commit is gone, the repository cannot be read safely, the output was cut). Reads objects only, never the working tree.
	 */
	async treeEntries(
		worktree: string,
		commit: string,
		paths: readonly string[],
	): Promise<Map<string, GitTreeEntryV0> | null> {
		if (!HEX.test(commit)) return null;
		const keys = await this.#keys(worktree);
		if (keys === null) return null;
		const found = new Map<string, GitTreeEntryV0>(paths.map((p) => [p, { kind: "absent" }]));
		for (let i = 0; i < paths.length; i += 200) {
			const batch = paths.slice(i, i + 200);
			const run = await this.#read(
				worktree,
				["ls-tree", "-z", "--full-tree", commit, "--", ...batch],
				GIT_LIMITS_V0.listBytes,
				keys,
			);
			if (run.code !== 0 || run.truncated) return null;
			for (let start = 0, at = run.stdout.indexOf(0); at !== -1; start = at + 1, at = run.stdout.indexOf(0, start)) {
				const record = run.stdout.subarray(start, at).toString("utf8");
				const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/s.exec(record);
				if (match === null) return null;
				const [, mode, type, oid, path] = match as unknown as [string, string, string, string, string];
				if (!found.has(path)) continue;
				found.set(path, type === "blob" ? { kind: "file", mode, oid } : { kind: "other" });
			}
		}
		return found;
	}

	/**
	 * The paths whose entries differ between two commits' trees (`diff-tree -r`, no renames, no programs), or null when Git could not
	 * answer. `cut`: more output than the bound; the list is a prefix.
	 */
	async changedPaths(worktree: string, from: string, to: string): Promise<{ paths: string[]; cut: boolean } | null> {
		if (!HEX.test(from) || !HEX.test(to)) return null;
		if (from === to) return { paths: [], cut: false };
		const keys = await this.#keys(worktree);
		if (keys === null) return null;
		const run = await this.#read(
			worktree,
			["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", "--name-only", "--no-commit-id", from, to, "--"],
			GIT_LIMITS_V0.listBytes,
			keys,
		);
		if (run.code !== 0 && !run.truncated) return null;
		const paths: string[] = [];
		const out = run.stdout;
		let start = 0;
		for (let at = out.indexOf(0); at !== -1; start = at + 1, at = out.indexOf(0, start)) {
			const path = out.subarray(start, at).toString("utf8");
			if (path !== "") paths.push(path);
		}
		return { paths, cut: run.truncated };
	}

	/** How `to` stands to `from`: the number of commits reachable from `to` and not `from`, and whether `from` is an ancestor of `to`. */
	async ancestry(worktree: string, from: string, to: string): Promise<{ ahead: number; descends: boolean } | null> {
		if (!HEX.test(from) || !HEX.test(to)) return null;
		const keys = await this.#keys(worktree);
		if (keys === null) return null;
		const count = await this.#read(
			worktree,
			["rev-list", "--count", `${from}..${to}`, "--"],
			GIT_LIMITS_V0.listBytes,
			keys,
		);
		const text = count.stdout.toString("utf8");
		if (count.code !== 0 || !/^[0-9]+\n$/.test(text)) return null;
		const base = await this.#read(worktree, ["merge-base", "--is-ancestor", from, to], GIT_LIMITS_V0.listBytes, keys);
		if (base.code !== 0 && base.code !== 1) return null;
		return { ahead: Number(text.trim()), descends: base.code === 0 };
	}

	/**
	 * A ref's reflog as Git reads it (any ref backend): its entry count and its newest entry, digested. Null when Git has no reflog for it
	 * or cannot read one; then a movement during a check cannot be told from the reflog.
	 */
	async #reflog(cwd: string, ref: string, keys: readonly (readonly [string, string])[]): Promise<string | null> {
		const count = await this.#read(
			cwd,
			["rev-list", "--walk-reflogs", "--count", ref, "--"],
			GIT_LIMITS_V0.listBytes,
			keys,
		);
		// No entries is no reflog: nothing could show a movement (`core.logAllRefUpdates=false` with no log written yet).
		if (count.code !== 0 || count.truncated || !/^[1-9][0-9]*\n$/.test(count.stdout.toString("utf8"))) return null;
		const newest = await this.#read(
			cwd,
			["log", "--walk-reflogs", "-n1", "--date=raw", "--format=%H%x00%gd%x00%gs", ref, "--"],
			GIT_LIMITS_V0.listBytes,
			keys,
		);
		if (newest.code !== 0 || newest.truncated) return null;
		return sha256(`${count.stdout.toString("utf8")}\0${newest.stdout.toString("utf8")}`);
	}
}

/** The inspector's reasons, in this module's words. */
function asUnavailable(reason: string): EndoRevisionUnavailableV0 {
	const known: readonly EndoRevisionUnavailableV0[] = [
		"unsafe-config",
		"partial-clone",
		"ownership",
		"not-a-repository",
		"git-not-found",
		"git-timeout",
		"output-too-large",
	];
	return (known as readonly string[]).includes(reason) ? (reason as EndoRevisionUnavailableV0) : "git-failed";
}
