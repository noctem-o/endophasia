// The project context of an attached session, read from Git, read-only. It answers two questions about the ONE directory the attached
// process was launched in (never a path from a browser): what repository, worktree, branch and linked worktrees are there, and what has
// changed in it; and, for one entry of that answer, what the change contains.
//
// Nothing here writes, stages, checks out or runs a command a caller names. Every Git read is one of a short fixed list with fixed
// arguments (see `readonly-git.ts` for what each read is hardened against). What is returned is a transient observation: it carries no
// session identity, says nothing about WHO made a change (Git cannot), and is never recorded.
//
// A snapshot is the list the page was shown. A diff is asked for as (snapshot, entry): the server maps that to the path it read itself,
// then re-reads the status and checks that the entry is still the same change before it answers, and checks again after reading that
// the file did not move under it. A mismatch is "stale": nothing is returned for it.
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
	ENDO_WORKBENCH_DIFF_SCHEMA_V0,
	ENDO_WORKBENCH_PROJECT_SCHEMA_V0,
	type EndoChangeAreaV0,
	type EndoChangeEntryV0,
	type EndoChangeStatsV0,
	type EndoDiffHunkV0,
	type EndoDiffOutcomeV0,
	type EndoDiffReasonV0,
	type EndoProjectIncompleteV0,
	type EndoProjectReasonV0,
	type EndoWorkbenchDiffV0,
	type EndoWorkbenchProjectV0,
	type EndoWorktreeV0,
} from "../../protocol/workbench-project.ts";
import {
	displaySafeV0,
	exactPathspecsV0,
	failureReasonV0,
	GIT_LIMITS_V0,
	GIT_PREFIX_V0,
	type GitRunnerV0,
	type GitRunV0,
	gitEnvV0,
	hasNoLazyFetchV0,
	isPartialCloneV0,
	type NumstatV0,
	parseNumstat,
	parseStatusV2,
	parseUnifiedDiff,
	parseWorktrees,
	patchHeaderV0,
	programKeysV0,
	type RawChangeV0,
	runGitV0,
	sameBlobV0,
	selectPatchesV0,
} from "./readonly-git.ts";

export interface GitProjectInspectorOptionsV0 {
	/** The working directory the attached process was launched in: configuration, not a browser value. */
	cwd: string;
	gitPath?: string;
	/** For tests: how a Git process is run. */
	runner?: GitRunnerV0;
	now?: () => number;
	/** Within this long of the last inspection, the same snapshot is returned and nothing is read again. Default 750 ms. */
	minRefreshMs?: number;
	/** Where the operator's own Git configuration lives (for their ignore rules). Default: this process's HOME and XDG_CONFIG_HOME. */
	env?: { HOME?: string; XDG_CONFIG_HOME?: string };
}

export type GitDiffOutcomeV0 = EndoDiffOutcomeV0;

interface EntryRecord {
	change: RawChangeV0;
	/** Size, modification time and inode of the working-tree file when the list was read: how a later read tells it was edited. */
	stamp: string | null;
}

interface Snapshot {
	id: string;
	root: string;
	/** What the index is compared with: `HEAD`, or the empty tree for a branch with no commit yet. */
	tree: string;
	/** Whether untracked files are listed, and the operator's global excludes file, as read for this snapshot: a diff is read under the same. */
	untracked: "all" | "no";
	excludes: [string, string][];
	entries: EntryRecord[];
	statusDigest: string;
}

const AREA_ORDER: Readonly<Record<EndoChangeAreaV0, number>> = { conflicted: 0, staged: 1, unstaged: 2, untracked: 3 };
const COMPARISON = {
	staged: "head-to-index",
	unstaged: "index-to-working-tree",
	untracked: "untracked-file",
	conflicted: "index-to-working-tree",
} as const;
/** Inspections and diffs are serialised; at most this many may wait behind the one running. */
const MAX_WAITING = 2;

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const posixRelative = (from: string, to: string): string => relative(from, to).split(sep).join("/");
const within = (root: string, path: string): boolean =>
	path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
/** A path Git printed, as a relative path that cannot leave the working tree. */
const safeRelative = (path: string): boolean =>
	path !== "" &&
	!path.includes("\0") &&
	!path.startsWith("/") &&
	!path.split("/").some((part) => part === "." || part === ".." || part === "");

export class GitProjectInspectorV0 {
	readonly #cwd: string;
	readonly #git: string;
	readonly #run: GitRunnerV0;
	readonly #now: () => number;
	readonly #minRefreshMs: number;
	readonly #home: { HOME?: string; XDG_CONFIG_HOME?: string } | undefined;
	#snapshot: Snapshot | null = null;
	#project: EndoWorkbenchProjectV0 | null = null;
	#projectAt = Number.NEGATIVE_INFINITY;
	#inflight: Promise<EndoWorkbenchProjectV0> | null = null;
	#chain: Promise<unknown> = Promise.resolve();
	#waiting = 0;
	#disposed = false;

	constructor(options: GitProjectInspectorOptionsV0) {
		this.#cwd = options.cwd;
		this.#git = options.gitPath ?? "git";
		this.#run = options.runner ?? runGitV0;
		this.#now = options.now ?? (() => Date.now());
		this.#minRefreshMs = options.minRefreshMs ?? 750;
		this.#home = options.env;
	}

	/** The session ended: nothing read is kept, and nothing more is read. */
	dispose(): void {
		this.#disposed = true;
		this.#snapshot = null;
		this.#project = null;
	}

	/** Run `work` after what is already running, or say busy when too many wait. */
	async #exclusive<T>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
		if (this.#waiting >= MAX_WAITING) return { ok: false };
		this.#waiting += 1;
		const turn = this.#chain.then(work, work);
		this.#chain = turn.catch(() => undefined);
		try {
			return { ok: true, value: await turn };
		} finally {
			this.#waiting -= 1;
		}
	}

	/** One Git read, in `cwd`, with the given overrides. Never throws. */
	#git_(
		cwd: string,
		args: readonly string[],
		maxBytes: number,
		extra: readonly (readonly [string, string])[] = [],
		readGlobalConfig = false,
		/** The arguments carry `:(literal)` pathspecs of their own (`exactPathspecsV0`), so the global flag is left off. */
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
	 * What the operator's own Git would hide or not list here: their global `core.excludesFile` (a path; the file is only patterns) and
	 * whether this repository turns untracked files off. Two config reads; nothing is run.
	 */
	async #listing(cwd: string): Promise<{ untracked: "all" | "no"; excludes: [string, string][] }> {
		// The EFFECTIVE value, as Git itself resolves it (a repository's own setting beats the global one): read with the global
		// configuration visible, passed on unchanged.
		const global = await this.#git_(
			cwd,
			// NUL-terminated: a path is passed on exactly, a trailing space in a file name included.
			["config", "-z", "--type=path", "--get", "core.excludesFile"],
			GIT_LIMITS_V0.listBytes,
			[],
			true,
		);
		const raw = global.code === 0 ? global.stdout.toString("utf8") : "";
		const path = raw.includes("\0") ? raw.slice(0, raw.indexOf("\0")) : "";
		const local = await this.#git_(cwd, ["config", "--get", "status.showUntrackedFiles"], GIT_LIMITS_V0.listBytes);
		const setting = local.code === 0 ? local.stdout.toString("utf8").trim().toLowerCase() : "";
		return {
			untracked: ["no", "false", "0"].includes(setting) ? "no" : "all",
			excludes: path !== "" && !path.includes("\0") && !path.includes("\n") ? [["core.excludesFile", path]] : [],
		};
	}

	/** The program-bearing configuration keys the repository sets, to be overridden for the reads that touch the working tree. */
	async #programKeys(cwd: string): Promise<[string, string][] | EndoProjectReasonV0> {
		const config = await this.#config(cwd);
		return typeof config === "string" ? config : config.keys;
	}

	#noLazyFetch: Promise<boolean> | null = null;
	/** Whether this Git can be told not to fetch missing objects on demand. Asked once. */
	#canBlockLazyFetch(cwd: string): Promise<boolean> {
		this.#noLazyFetch ??= this.#git_(cwd, ["--version"], GIT_LIMITS_V0.listBytes).then(
			(run) => run.code === 0 && hasNoLazyFetchV0(run.stdout.toString("utf8")),
		);
		return this.#noLazyFetch;
	}

	/** The overrides to apply, or why the repository cannot be read safely. */
	async #config(cwd: string): Promise<{ keys: [string, string][] } | EndoProjectReasonV0> {
		const run = await this.#git_(
			cwd,
			["config", "--includes", "--list", "--name-only", "-z"],
			GIT_LIMITS_V0.listBytes,
		);
		const reason = failureReasonV0(run);
		if (reason !== null) return reason;
		if (run.truncated) return "output-too-large";
		const names = run.stdout
			.toString("utf8")
			.split("\0")
			.filter((name) => name !== "");
		if (isPartialCloneV0(names) && !(await this.#canBlockLazyFetch(cwd))) return "partial-clone";
		return { keys: programKeysV0(names) };
	}

	// --- the project and the change inventory -------------------------------------------------------------------------------

	overview(): Promise<EndoWorkbenchProjectV0> {
		if (this.#disposed) return Promise.resolve(this.#unavailable("no-directory"));
		if (this.#project !== null && this.#now() - this.#projectAt < this.#minRefreshMs)
			return Promise.resolve(this.#project);
		if (this.#inflight !== null) return this.#inflight;
		const task = (async () => {
			const answer = await this.#exclusive(() => this.#inspect());
			const project = answer.ok ? answer.value : this.#unavailable("busy");
			if (answer.ok && !this.#disposed) {
				this.#project = project;
				this.#projectAt = this.#now();
			}
			return project;
		})().finally(() => {
			this.#inflight = null;
		});
		this.#inflight = task;
		return task;
	}

	#unavailable(reason: EndoProjectReasonV0): EndoWorkbenchProjectV0 {
		return {
			schemaVersion: ENDO_WORKBENCH_PROJECT_SCHEMA_V0,
			basis: "launch-directory",
			snapshot: randomBytes(8).toString("hex"),
			capturedAtMs: this.#now(),
			state: "unavailable",
			reason,
			repository: null,
			head: null,
			worktrees: [],
			changes: {
				state: "unavailable",
				reason,
				dirty: "unknown",
				counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, exact: false },
				stats: null,
				files: [],
				filesTruncated: false,
			},
			incomplete: [],
		};
	}

	async #inspect(): Promise<EndoWorkbenchProjectV0> {
		// Any earlier snapshot is dead from here: a diff asked for under it is stale whatever this inspection finds.
		this.#snapshot = null;
		let cwd: string;
		try {
			cwd = await realpath(this.#cwd);
			if (!(await stat(cwd)).isDirectory()) return this.#unavailable("no-directory");
		} catch {
			return this.#unavailable("no-directory");
		}
		const found = await this.#git_(
			cwd,
			["rev-parse", "--is-bare-repository", "--is-inside-work-tree"],
			GIT_LIMITS_V0.listBytes,
		);
		const foundReason = failureReasonV0(found);
		if (foundReason !== null) return this.#unavailable(foundReason);
		const [bare, inside] = found.stdout.toString("utf8").split("\n");
		if (bare === "true") return this.#unavailable("bare-repository");
		if (inside !== "true") return this.#unavailable("not-a-repository");
		const where = await this.#git_(
			cwd,
			["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"],
			GIT_LIMITS_V0.listBytes,
		);
		const whereReason = failureReasonV0(where);
		if (whereReason !== null) return this.#unavailable(whereReason);
		const lines = where.stdout.toString("utf8").split("\n");
		// Exactly three paths and a closing newline: a path with a newline in it cannot be read unambiguously, so it is not guessed at.
		if (lines.length !== 4 || lines[3] !== "" || lines.slice(0, 3).some((line) => line === ""))
			return this.#unavailable("git-failed");
		let root: string;
		let common: string;
		let gitDir: string;
		try {
			root = await realpath(lines[0] as string);
			common = await realpath(lines[1] as string);
			gitDir = await realpath(lines[2] as string);
		} catch {
			return this.#unavailable("git-failed");
		}
		// The repository must be the one that holds the directory the session was launched in: a `core.worktree` or a `.git` file that
		// points somewhere else is a scope escape, and is refused rather than followed.
		if (!within(root, cwd)) return this.#unavailable("scope-mismatch");
		// ...and it must be where Git keeps it: a `.git` directory or file AT that root. A `core.worktree` that names some other directory
		// (an ancestor of the launch directory, say) has none, and would widen what is read to whatever it names.
		try {
			await lstat(join(root, ".git"));
		} catch {
			return this.#unavailable("scope-mismatch");
		}
		// ...and that `.git` must be THIS repository's. A nested repository can claim the enclosing one's directory as its working tree,
		// which has a `.git` of its own: Git, asked from the root, must find the same Git directory as it found from the launch directory
		// (true for the root itself, for a launch from a subdirectory, and for a linked worktree, whose `.git` file points at its own).
		const atRoot = await this.#git_(
			root,
			["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
			GIT_LIMITS_V0.listBytes,
		);
		const atRootReason = failureReasonV0(atRoot);
		if (atRootReason !== null && atRootReason !== "not-a-repository") return this.#unavailable(atRootReason);
		const rootLines = atRoot.stdout.toString("utf8").split("\n");
		let rootGitDir: string | null = null;
		if (atRoot.code === 0 && rootLines.length === 2 && rootLines[1] === "" && rootLines[0] !== "") {
			try {
				rootGitDir = await realpath(rootLines[0] as string);
			} catch {
				rootGitDir = null;
			}
		}
		if (rootGitDir !== gitDir) return this.#unavailable("scope-mismatch");

		const programs = await this.#programKeys(cwd);
		if (typeof programs === "string") return this.#unavailable(programs);
		const listing = await this.#listing(cwd);
		const keys = [...programs, ...listing.excludes];

		const status = await this.#git_(
			cwd,
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				`--untracked-files=${listing.untracked}`,
				"--ignore-submodules=all",
				"--renames",
				"--no-ahead-behind",
			],
			GIT_LIMITS_V0.statusBytes,
			keys,
		);
		const statusReason = failureReasonV0(status);
		const incomplete: EndoProjectIncompleteV0[] = listing.untracked === "no" ? ["untracked-hidden"] : [];
		const head = (parsed: ReturnType<typeof parseStatusV2> | null): EndoWorkbenchProjectV0["head"] => {
			if (parsed === null || parsed.branchHead === null) return null;
			if (parsed.branchHead === "(detached)") return { kind: "detached", branch: null, oid: parsed.branchOid };
			const branch = displaySafeV0(parsed.branchHead, 200).text;
			return parsed.branchOid === null
				? { kind: "unborn", branch, oid: null }
				: { kind: "branch", branch, oid: parsed.branchOid };
		};
		const worktrees = await this.#worktrees(cwd, root, incomplete);
		const repository = {
			label: displaySafeV0(repoLabel(common), 120).text,
			worktreeLabel: displaySafeV0(basename(root), 120).text,
			root: displaySafeV0(root).text,
			cwdRelative: displaySafeV0(posixRelative(root, cwd)).text,
			commonDir: displaySafeV0(common).text,
		};
		const snapshotId = randomBytes(8).toString("hex");
		if (statusReason !== null || (status.code !== 0 && !status.truncated)) {
			return {
				...this.#unavailable(statusReason ?? "git-failed"),
				snapshot: snapshotId,
				state: "ready",
				reason: null,
				repository,
				worktrees,
				incomplete,
			};
		}
		const parsed = parseStatusV2(status.stdout, status.truncated);
		if (parsed.truncated) incomplete.push("status-truncated");

		const tree = parsed.branchOid === null ? await this.#emptyTree(cwd) : "HEAD";
		const [stagedStat, unstagedStat] = await Promise.all(
			[true, false].map((cached) => this.#numstat(cwd, cached, keys, tree)),
		);
		const stagedMap = stagedStat;
		const unstagedMap = unstagedStat;
		if (tree === null || stagedMap === null || unstagedMap === null) incomplete.push("stats-unavailable");

		const sorted = [...parsed.changes].sort(
			(a, b) => AREA_ORDER[a.area] - AREA_ORDER[b.area] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		);
		const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, exact: !parsed.truncated };
		const totals = { staged: emptyStats(), unstaged: emptyStats() };
		const statOf = (change: RawChangeV0): NumstatV0 | null =>
			change.area === "staged"
				? (stagedMap?.get(change.path) ?? null)
				: change.area === "unstaged"
					? (unstagedMap?.get(change.path) ?? null)
					: null;
		for (const change of sorted) {
			counts[change.area] += 1;
			if (change.area === "staged" || change.area === "unstaged") {
				const bucket = totals[change.area];
				const stat_ = statOf(change);
				if (stat_ === null || stat_.additions === null) bucket.uncounted += 1;
				else {
					bucket.additions += stat_.additions;
					bucket.deletions += stat_.deletions ?? 0;
				}
			}
		}
		const listed = sorted.slice(0, GIT_LIMITS_V0.maxFiles);
		const records: EntryRecord[] = [];
		const files: EndoChangeEntryV0[] = [];
		for (const [id, change] of listed.entries()) {
			const stat_ = statOf(change);
			const path = displaySafeV0(change.path);
			const orig = change.origPath === null ? null : displaySafeV0(change.origPath);
			files.push({
				id,
				path: path.text,
				origPath: orig?.text ?? null,
				area: change.area,
				status: change.status,
				additions: stat_?.additions ?? null,
				deletions: stat_?.deletions ?? null,
				binary: change.area === "untracked" ? null : (stat_?.binary ?? null),
				escaped: path.changed || (orig?.changed ?? false) || !change.pathExact,
			});
			records.push({
				change,
				stamp: change.area === "staged" || change.area === "conflicted" ? null : await stampOf(root, change.path),
			});
		}
		this.#snapshot = {
			id: snapshotId,
			root,
			tree: tree ?? "HEAD",
			untracked: listing.untracked,
			excludes: listing.excludes,
			entries: records,
			statusDigest: sha256(status.stdout),
		};
		const total = parsed.changes.length;
		return {
			schemaVersion: ENDO_WORKBENCH_PROJECT_SCHEMA_V0,
			basis: "launch-directory",
			snapshot: snapshotId,
			capturedAtMs: this.#now(),
			state: "ready",
			reason: null,
			repository,
			head: head(parsed),
			worktrees,
			changes: {
				state: "ready",
				reason: null,
				dirty: total > 0 ? "dirty" : parsed.truncated ? "unknown" : "clean",
				counts,
				stats: stagedMap === null || unstagedMap === null ? null : totals,
				files,
				filesTruncated: total > files.length,
			},
			incomplete,
		};
	}

	/** The empty tree's name in this repository's hash algorithm (read from Git; nothing is written). */
	async #emptyTree(cwd: string): Promise<string | null> {
		const run = await this.#git_(cwd, ["hash-object", "-t", "tree", "--", devNull], GIT_LIMITS_V0.listBytes);
		const name = run.stdout.toString("utf8").trim();
		return failureReasonV0(run) === null && run.code === 0 && /^[0-9a-f]{40,64}$/.test(name) ? name : null;
	}

	/**
	 * Line counts per file. These use Git's PLUMBING (`diff-index --cached`, `diff-files`), not `git diff`: the porcelain command
	 * refreshes the index and writes it back, even under `--no-optional-locks`, and a read that rewrites the repository's index is not
	 * read-only. The plumbing compares what it is told to compare and writes nothing.
	 */
	async #numstat(
		cwd: string,
		cached: boolean,
		keys: readonly (readonly [string, string])[],
		tree: string | null,
	): Promise<Map<string, NumstatV0> | null> {
		if (cached && tree === null) return null;
		const run = await this.#git_(
			cwd,
			[
				...(cached ? ["diff-index", "--cached"] : ["diff-files"]),
				"--numstat",
				"-z",
				...(cached ? ["-M"] : []),
				"--no-ext-diff",
				"--no-textconv",
				"--ignore-submodules=all",
				...(cached ? [tree as string] : []),
				"--",
			],
			GIT_LIMITS_V0.statusBytes,
			keys,
		);
		if (failureReasonV0(run) !== null || run.truncated || run.code !== 0) return null;
		return parseNumstat(run.stdout);
	}

	async #worktrees(cwd: string, root: string, incomplete: EndoProjectIncompleteV0[]): Promise<EndoWorktreeV0[]> {
		const run = await this.#git_(cwd, ["worktree", "list", "--porcelain", "-z"], GIT_LIMITS_V0.listBytes);
		if (failureReasonV0(run) !== null || run.code !== 0 || run.truncated) {
			incomplete.push("worktrees-unavailable");
			return [];
		}
		const all = parseWorktrees(run.stdout).filter((w) => !w.bare);
		if (all.length > GIT_LIMITS_V0.maxWorktrees) incomplete.push("worktrees-truncated");
		const out: EndoWorktreeV0[] = [];
		for (const w of all.slice(0, GIT_LIMITS_V0.maxWorktrees)) {
			let real = w.path;
			try {
				real = await realpath(w.path);
			} catch {
				/* a worktree whose directory is gone keeps the path Git printed */
			}
			out.push({
				path: displaySafeV0(w.path).text,
				branch: w.branch === null ? null : displaySafeV0(w.branch, 200).text,
				head: w.head,
				detached: w.detached,
				locked: w.locked,
				prunable: w.prunable,
				current: real === root,
			});
		}
		return out;
	}

	// --- one file's diff ----------------------------------------------------------------------------------------------------

	async diff(snapshot: string, id: number): Promise<GitDiffOutcomeV0> {
		const known = this.#snapshot;
		if (this.#disposed || known === null || known.id !== snapshot) return { kind: "stale" };
		const record = known.entries[id];
		if (record === undefined) return { kind: "bad" };
		const answer = await this.#exclusive(() => this.#diff(known, id, record));
		return answer.ok ? answer.value : { kind: "busy" };
	}

	async #diff(known: Snapshot, id: number, record: EntryRecord): Promise<GitDiffOutcomeV0> {
		// Between asking and being served the inventory may have been re-read: only the snapshot the page holds is answered for.
		if (this.#snapshot !== known) return { kind: "stale" };
		const { change } = record;
		const programsNow = await this.#programKeys(known.root);
		// Without the listing there is no way to switch off the repository's filters, so nothing that touches the working tree is run.
		if (typeof programsNow === "string")
			return { kind: "diff", diff: this.#shell(known, id, change, "unavailable", "git-failed", "unchanged") };
		const keys = [...programsNow, ...known.excludes];
		const now = await this.#git_(
			known.root,
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				`--untracked-files=${known.untracked}`,
				"--ignore-submodules=all",
				"--renames",
				"--no-ahead-behind",
			],
			GIT_LIMITS_V0.statusBytes,
			keys,
		);
		if (failureReasonV0(now) !== null || now.code !== 0 || now.truncated) {
			return { kind: "diff", diff: this.#shell(known, id, change, "unavailable", "git-failed", "unchanged") };
		}
		const fresh = parseStatusV2(now.stdout, false);
		// Still the same change: the same area, the same blobs, the same names.
		if (!fresh.changes.some((c) => c.signature === change.signature)) return { kind: "stale" };
		const inventory = sha256(now.stdout) === known.statusDigest ? "unchanged" : "changed";
		if (record.stamp !== null && (await stampOf(known.root, change.path)) !== record.stamp) return { kind: "stale" };

		const base = (state: EndoWorkbenchDiffV0["state"], reason: EndoDiffReasonV0 | null) =>
			this.#shell(known, id, change, state, reason, inventory);
		if (change.area === "conflicted") return { kind: "diff", diff: base("unavailable", "unmerged") };
		if (!change.pathExact) return { kind: "diff", diff: base("unavailable", "path-not-text") };

		let diff: EndoWorkbenchDiffV0;
		if (change.area === "untracked") diff = await this.#untracked(known, change, base("ready", null));
		else {
			const paths = change.origPath !== null ? [change.origPath, change.path] : [change.path];
			const run = await this.#git_(
				known.root,
				[
					...(change.area === "staged" ? ["diff-index", "--cached"] : ["diff-files"]),
					"-p",
					"--no-color",
					"--no-ext-diff",
					"--no-textconv",
					...(change.area === "staged" ? ["-M"] : []),
					"--unified=3",
					"--src-prefix=a/",
					"--dst-prefix=b/",
					"--ignore-submodules=all",
					...(change.area === "staged" ? [known.tree] : []),
					"--",
					...exactPathspecsV0(paths),
				],
				GIT_LIMITS_V0.diffBytes,
				keys,
				false,
				true,
			);
			const reason = failureReasonV0(run);
			if (reason !== null || (run.code !== 0 && !run.truncated))
				return { kind: "diff", diff: base("unavailable", reason === "git-timeout" ? "git-timeout" : "git-failed") };
			const own = selectPatchesV0(
				run.stdout.toString("utf8"),
				patchHeaderV0(change.origPath ?? change.path, change.path),
			);
			if (own === null) return { kind: "diff", diff: base("unavailable", "git-failed") };
			const parsed = parseUnifiedDiff(own, run.truncated);
			// The diff must be of the blobs the status named, or the index moved between the two reads.
			if (parsed.index !== null) {
				const from = change.area === "staged" ? change.headOid : change.indexOid;
				if (!sameBlobV0(parsed.index.from, from)) return { kind: "stale" };
				if (change.area === "staged" && !sameBlobV0(parsed.index.to, change.indexOid)) return { kind: "stale" };
			}
			diff = {
				...base(parsed.binary ? "binary" : parsed.hunks.length === 0 ? "empty" : "ready", null),
				notes: parsed.notes,
				hunks: parsed.binary ? [] : parsed.hunks,
				truncated: parsed.truncated,
				longLines: parsed.longLines,
			};
		}
		if (record.stamp !== null && (await stampOf(known.root, change.path)) !== record.stamp) return { kind: "stale" };
		return this.#snapshot === known ? { kind: "diff", diff } : { kind: "stale" };
	}

	#shell(
		known: Snapshot,
		id: number,
		change: RawChangeV0,
		state: EndoWorkbenchDiffV0["state"],
		reason: EndoDiffReasonV0 | null,
		inventory: EndoWorkbenchDiffV0["inventory"],
	): EndoWorkbenchDiffV0 {
		return {
			schemaVersion: ENDO_WORKBENCH_DIFF_SCHEMA_V0,
			snapshot: known.id,
			id,
			area: change.area,
			path: displaySafeV0(change.path).text,
			origPath: change.origPath === null ? null : displaySafeV0(change.origPath).text,
			comparison: COMPARISON[change.area],
			state,
			reason,
			notes: [],
			hunks: [],
			truncated: false,
			longLines: false,
			inventory,
		};
	}

	/**
	 * An untracked file has no Git comparison, so its content is read here, as all-added lines. It is read with the least trust: the name
	 * Git printed must stay inside the working tree after symlinks are resolved, the file itself must be a plain file (not a link, a
	 * directory, a pipe or a device) and still the file that was looked at when it is opened, and at most a fixed number of bytes is read.
	 */
	async #untracked(known: Snapshot, change: RawChangeV0, shell: EndoWorkbenchDiffV0): Promise<EndoWorkbenchDiffV0> {
		const fail = (state: EndoWorkbenchDiffV0["state"], reason: EndoDiffReasonV0): EndoWorkbenchDiffV0 => ({
			...shell,
			state,
			reason,
		});
		if (!safeRelative(change.path)) return fail("unavailable", "not-a-file");
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			const parent = await realpath(dirname(join(known.root, change.path)));
			if (!within(known.root, parent)) return fail("unavailable", "not-a-file");
			const target = join(parent, basename(change.path));
			const before = await lstat(target, { bigint: true });
			if (!before.isFile()) return fail("unavailable", "not-a-file");
			// O_NOFOLLOW: a link swapped in after the check is refused by the system. O_NONBLOCK: opening a pipe does not hang.
			handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const opened = await handle.stat({ bigint: true });
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
				return fail("unavailable", "not-a-file");
			if (opened.size > BigInt(GIT_LIMITS_V0.untrackedBytes)) return { ...shell, state: "too-large", reason: null };
			const buffer = Buffer.alloc(Number(opened.size));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const bytes = buffer.subarray(0, bytesRead);
			if (bytes.subarray(0, GIT_LIMITS_V0.binarySniffBytes).includes(0)) return { ...shell, state: "binary" };
			if (bytes.length === 0) return { ...shell, state: "empty" };
			const text = bytes.toString("utf8");
			const raw = text.split("\n");
			const endsWithNewline = text.endsWith("\n");
			if (endsWithNewline) raw.pop();
			let truncated = false;
			let longLines = false;
			const lines: string[] = [];
			for (const line of raw) {
				if (lines.length >= GIT_LIMITS_V0.diffLines) {
					truncated = true;
					break;
				}
				const safe = displaySafeV0(line, GIT_LIMITS_V0.lineChars);
				if (safe.cut) longLines = true;
				lines.push(`+${safe.text}`);
			}
			// Git's "no newline" marker is a line of the hunk like any other: it counts against the budget, so a file of exactly that many
			// lines is cut rather than sent one line over what the page accepts.
			if (!endsWithNewline && !truncated) {
				if (lines.length >= GIT_LIMITS_V0.diffLines) truncated = true;
				else lines.push("\\ No newline at end of file");
			}
			const added = lines.filter((l) => l.startsWith("+")).length;
			const hunk: EndoDiffHunkV0 = { oldStart: 0, oldLines: 0, newStart: 1, newLines: added, section: "", lines };
			return { ...shell, state: "ready", hunks: [hunk], truncated, longLines };
		} catch {
			return fail("unavailable", "read-failed");
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}
}

const emptyStats = (): EndoChangeStatsV0 => ({ additions: 0, deletions: 0, uncounted: 0 });

/** The repository's name: the main working tree's directory, from the common Git directory. */
function repoLabel(common: string): string {
	const name = basename(common);
	return name === ".git" ? basename(dirname(common)) : name.replace(/\.git$/, "") || name;
}

/**
 * Size, modification and change times (ns) and inode of a working-tree path, or "absent". The change time matters: a same-length rewrite
 * can put the modification time back, but the system moves the change time on every write and every time-setting, and nothing can set it
 * back. A path that cannot be examined is also a stamp: it changes when that does.
 */
async function stampOf(root: string, path: string): Promise<string> {
	if (!safeRelative(path)) return "unsafe";
	try {
		const s = await lstat(join(root, path), { bigint: true });
		return `${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}:${s.isFile() ? "f" : s.isSymbolicLink() ? "l" : "o"}`;
	} catch {
		return "absent";
	}
}
