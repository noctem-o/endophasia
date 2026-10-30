// The read-only Git layer under the workbench's project context. It runs a FIXED, SMALL set of Git reads in the directory the attached
// process was launched in, and parses their output. There is no generic way in: callers name an operation here, never a command line, and
// nothing from a browser reaches an argument. Repository contents (paths, branch names, configuration, attributes, diffs) are untrusted.
//
// What running Git in a repository one does not control can mean, and what is done about it:
//   - Git runs programs the repository's configuration names: `core.fsmonitor`, a `filter.<n>.clean|smudge|process` for a path whose
//     attributes select it, `diff.<n>.textconv`, `diff.external`, `core.hooksPath` hooks, a pager. Each is switched off for every read:
//     the ones with a fixed name outright, and the ones with a repository-chosen name by listing the configuration (a read that runs
//     nothing) and overriding exactly the program-bearing keys found. The overrides go in as `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, so a
//     key is never split on a character it contains. The diff reads also pass `--no-ext-diff --no-textconv`.
//   - The user's and the system's configuration are not read (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM`): a user's
//     `diff.external` is not honoured and the diff format does not depend on their settings. Two things of the operator's ARE honoured,
//     because they decide what the operator's own Git would not show: their default ignore file, and the `core.excludesFile` named in
//     their global configuration (read by one `config --global --get`, which runs nothing and is passed on as an override). A repository
//     that sets `status.showUntrackedFiles=no` is respected, and the page is told untracked files are hidden.
//   - A missing object is never fetched on demand (`GIT_NO_LAZY_FETCH`): that would write into `.git` and run the remote's configured
//     programs. Configuration overrides cannot stop it, so on a Git older than 2.44 a partial clone is refused, not read.
//   - No lock is taken and no index is written (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`), so Git does not refresh the index or run
//     an index hook, and the reads do not disturb the agent's own Git use.
//   - Pathspecs are literal (`--literal-pathspecs`): no glob, no magic. A path comes from Git's own status, never from a browser.
//   - Every read has a timeout and an output cap; a process over either is killed.
//   - The environment is built from nothing: only PATH is inherited, so no `GIT_DIR`, `GIT_WORK_TREE`, `GIT_EXTERNAL_DIFF` or trace
//     variable of the parent can steer a read.
// Residual risk, stated plainly: a program-bearing key written into the repository's configuration in the instant between the listing and
// the read is not seen. Whoever can write there is the agent itself (or the operator), which can already run any program; this layer is
// built against a hostile REPOSITORY, not against the attached process.
import { spawn } from "node:child_process";
import { devNull } from "node:os";
import type {
	EndoChangeAreaV0,
	EndoChangeStatusV0,
	EndoDiffHunkV0,
	EndoProjectReasonV0,
} from "../../protocol/workbench-project.ts";

export const GIT_LIMITS_V0 = {
	/** Per Git process. */
	timeoutMs: 10_000,
	/** The change list: a repository with more is reported as truncated, not read whole. */
	statusBytes: 4 * 1024 * 1024,
	/** The configuration listing, the worktree list, numstat and rev-parse. */
	listBytes: 2 * 1024 * 1024,
	/** One file's diff. */
	diffBytes: 256 * 1024,
	/** Files in the inventory the page is sent. */
	maxFiles: 500,
	/** Linked worktrees listed. */
	maxWorktrees: 50,
	/** Lines and characters of one file's diff. */
	diffLines: 5000,
	lineChars: 2000,
	/** The largest untracked file read for a diff, and the part of any file looked at to judge it binary (as Git does). */
	untrackedBytes: 256 * 1024,
	binarySniffBytes: 8000,
	/** What is kept of Git's stderr, which is only ever classified, never forwarded. */
	stderrBytes: 8 * 1024,
} as const;

export interface GitRunV0 {
	code: number | null;
	stdout: Buffer;
	/** Output reached the cap and the process was stopped: `stdout` is a prefix. */
	truncated: boolean;
	timedOut: boolean;
	/** The executable could not be started. */
	notFound: boolean;
	/** Git's stderr, for classification only. */
	stderr: string;
}

export interface GitRunLimitsV0 {
	timeoutMs: number;
	maxBytes: number;
}

/** The one way a Git process is run. Tests replace it; production uses `runGitV0`. */
export type GitRunnerV0 = (
	args: readonly string[],
	options: { cwd: string; env: Record<string, string>; limits: GitRunLimitsV0; gitPath: string },
) => Promise<GitRunV0>;

/** Overrides that apply to every read, whatever the repository's configuration says. */
const BASE_CONFIG: readonly (readonly [string, string])[] = [
	["core.fsmonitor", "false"],
	["core.hooksPath", devNull],
	["core.pager", "cat"],
	["core.attributesFile", devNull],
	["core.quotePath", "true"],
	["diff.external", ""],
	["diff.suppressBlankEmpty", "false"],
	["diff.noprefix", "false"],
	["diff.mnemonicPrefix", "false"],
	["diff.renames", "true"],
	["diff.ignoreSubmodules", "all"],
	["status.renames", "true"],
	["status.submoduleSummary", "false"],
	["submodule.recurse", "false"],
	["color.ui", "false"],
	["advice.statusHints", "false"],
];

/**
 * The configuration keys a repository can use to make Git run a program, from a configuration listing (`git config --list --name-only
 * -z`, already split). Keys keep the exact case Git printed: the subsection of `filter.<name>.clean` is case-sensitive.
 */
export function programKeysV0(names: readonly string[]): [string, string][] {
	const found = new Map<string, string>();
	for (const name of names) {
		// The driver's name may be EMPTY (`[filter ""]`, selected by the attribute `filter=`): `.*`, never `.+`.
		if (/^filter\..*\.(clean|smudge|process)$/i.test(name)) found.set(name, "");
		else if (/^filter\..*\.required$/i.test(name)) found.set(name, "false");
		else if (/^diff\..*\.(textconv|command)$/i.test(name)) found.set(name, "");
		else if (/^diff\..*\.cachetextconv$/i.test(name)) found.set(name, "false");
		else if (/^pager\..+$/i.test(name)) found.set(name, "false");
		else if (/^core\.(editor|sshcommand|askpass|gitproxy|fsmonitorhookversion)$/i.test(name)) found.set(name, "");
	}
	return [...found];
}

/**
 * Whether the repository is a partial clone (it names a promisor remote). Git can fetch a missing object from such a remote on demand, by
 * running the programs that remote's configuration names, writing into `.git`. Configuration keys cannot prevent that (found by test:
 * `remote.<n>.promisor=false` still fetches, and `remote.<n>.uploadpack` keeps its first value), so the only protection is
 * `GIT_NO_LAZY_FETCH`, which Git has from 2.44. On a Git without it, such a repository is not read.
 */
export const isPartialCloneV0 = (names: readonly string[]): boolean =>
	names.some((name) => /^(remote\..+\.promisor|extensions\.partialclone)$/i.test(name));

/** Whether this Git version understands `GIT_NO_LAZY_FETCH` (2.44 and later). An answer that cannot be read is "no". */
export function hasNoLazyFetchV0(versionOutput: string): boolean {
	const match = /git version (\d+)\.(\d+)/.exec(versionOutput);
	if (match === null) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 2 || (major === 2 && minor >= 44);
}

export interface GitEnvOptionsV0 {
	/** Where Git looks for the operator's default ignore file (`$XDG_CONFIG_HOME/git/ignore`, `$HOME/.config/git/ignore`). Default: this process's. */
	home?: { HOME?: string; XDG_CONFIG_HOME?: string };
	/** Read the operator's global configuration (only for the one read that asks it where their ignore file is: `config --global --get`). */
	readGlobalConfig?: boolean;
}

/**
 * The environment of every read: built from nothing but PATH, plus HOME and XDG_CONFIG_HOME so Git finds the operator's own default ignore
 * file (a file of patterns: it runs nothing). `extra` are the overrides found in the repository's configuration. The global configuration
 * is read only by the one read that says `readGlobalConfig`.
 */
export function gitEnvV0(
	extra: readonly (readonly [string, string])[] = [],
	options: GitEnvOptionsV0 = {},
): Record<string, string> {
	const config = [...BASE_CONFIG, ...extra];
	const home = options.home ?? { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		...(home.HOME === undefined ? {} : { HOME: home.HOME }),
		...(home.XDG_CONFIG_HOME === undefined ? {} : { XDG_CONFIG_HOME: home.XDG_CONFIG_HOME }),
		LC_ALL: "C",
		LANG: "C",
		...(options.readGlobalConfig === true ? {} : { GIT_CONFIG_GLOBAL: devNull }),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_PAGER: "cat",
		GIT_CONFIG_COUNT: String(config.length),
	};
	config.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/**
 * The pathspecs that name exactly one path. A literal pathspec still matches a directory's contents, so `foo` would also bring in a
 * staged `foo/bar` when a file was replaced by a directory, and two unrelated patches would be read as one. Each path is therefore taken
 * literally and its descendants excluded. These carry their own `:(literal)` magic, so they are run WITHOUT the global
 * `--literal-pathspecs` (which would read the magic as part of the name); nothing else is ever passed as a pathspec in that read.
 */
export const exactPathspecsV0 = (paths: readonly string[]): string[] =>
	paths.flatMap((path) => [
		`:(literal)${path}`,
		// An exclusion wins over every match, so it is left out where it would drop the OTHER path of this entry (a rename of `foo` to
		// `foo/bar`). It only keeps unrelated output small: which patch is this entry's is decided by `selectPatchesV0`, by its header.
		...(paths.some((other) => other.startsWith(`${path}/`)) ? [] : [`:(exclude,literal)${path}/`]),
	]);

/** A path as Git writes it in a patch header with `core.quotePath`: quoted, C-style, when it holds a byte that needs it. */
export function quoteGitPathV0(path: string): string {
	const named: Readonly<Record<number, string>> = {
		7: "a",
		8: "b",
		9: "t",
		10: "n",
		11: "v",
		12: "f",
		13: "r",
		34: '"',
		92: "\\",
	};
	let out = "";
	let quote = false;
	for (const byte of Buffer.from(path, "utf8")) {
		if (named[byte] !== undefined) {
			out += `\\${named[byte]}`;
			quote = true;
		} else if (byte < 0x20 || byte >= 0x7f) {
			out += `\\${byte.toString(8).padStart(3, "0")}`;
			quote = true;
		} else out += String.fromCharCode(byte);
	}
	return quote ? `"${out}"` : out;
}

/** The header line of the one patch (or, for a change of type, the two patches) that belong to a change from `from` to `to`. */
export const patchHeaderV0 = (from: string, to: string): string =>
	`diff --git ${quoteGitPathV0(`a/${from}`)} ${quoteGitPathV0(`b/${to}`)}`;

/**
 * Keep only the patches whose header is exactly `header`: a pathspec can bring in other paths (a directory's contents), and a patch that
 * is not this entry's must never be read as part of it. Null when there was output but none of it was this entry's: that is refused,
 * not shown as an empty change.
 */
export function selectPatchesV0(text: string, header: string): string | null {
	if (text === "") return "";
	const kept: string[] = [];
	let keeping = false;
	let seen = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			keeping = line === header;
			seen ||= keeping;
		}
		if (keeping) kept.push(line);
	}
	return seen ? `${kept.join("\n")}\n` : null;
}

/** Arguments that precede every read's own: no pager, no lock, literal pathspecs. */
export const GIT_PREFIX_V0 = ["--no-pager", "--no-optional-locks", "--literal-pathspecs"] as const;

export const runGitV0: GitRunnerV0 = (args, { cwd, env, limits, gitPath }) =>
	new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(gitPath, [...args], {
				cwd,
				env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			resolve({
				code: null,
				stdout: Buffer.alloc(0),
				truncated: false,
				timedOut: false,
				notFound: true,
				stderr: "",
			});
			return;
		}
		const out: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let timedOut = false;
		let notFound = false;
		let stderr = "";
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, limits.timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (truncated) return;
			const room = limits.maxBytes - size;
			if (chunk.length > room) {
				if (room > 0) out.push(chunk.subarray(0, room));
				size = limits.maxBytes;
				truncated = true;
				child.kill("SIGKILL");
				return;
			}
			out.push(chunk);
			size += chunk.length;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < GIT_LIMITS_V0.stderrBytes) stderr += chunk.toString("utf8");
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			notFound = error.code === "ENOENT" || error.code === "EACCES";
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out), truncated, timedOut, notFound, stderr });
		});
	});

/** Why a Git process did not give an answer, from how it ended, or null when it did. Git's own words are only matched, never passed on. */
export function failureReasonV0(run: GitRunV0): EndoProjectReasonV0 | null {
	if (run.notFound) return "git-not-found";
	if (run.timedOut) return "git-timeout";
	if (run.truncated) return null; // the caller decides: a prefix may be usable
	if (run.code === 0) return null;
	if (/dubious ownership|safe\.directory/i.test(run.stderr)) return "ownership";
	if (/not a git repository/i.test(run.stderr)) return "not-a-repository";
	return "git-failed";
}

// --- making what came from a repository safe to show --------------------------------------------------------------------------

/**
 * Control characters become their visible pictures (U+2400…), bidirectional and C1 controls become a named mark, and a long value is cut.
 * `maxChars` bounds the OUTPUT, in UTF-16 units as a string's `length` counts them (which is what the page's gate checks): a mark is eight
 * units for one character, so a name made of them must be cut by what it becomes, not by what it was. A cut ends in "…", which is counted,
 * and never falls inside a character.
 */
export function displaySafeV0(text: string, maxChars = 512): { text: string; changed: boolean; cut: boolean } {
	let changed = false;
	let out = "";
	const pieces: string[] = [];
	for (const ch of text) {
		const code = ch.codePointAt(0) as number;
		let piece = ch;
		if (code === 0x09) piece = ch;
		else if (code < 0x20) piece = String.fromCodePoint(0x2400 + code);
		else if (code === 0x7f) piece = "␡";
		else if (code >= 0x80 && code <= 0x9f) piece = `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
		else if (
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			code === 0x200e ||
			code === 0x200f ||
			code === 0x061c
		)
			piece = `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
		else if (code === 0xfffd) piece = ch;
		if (piece !== ch) changed = true;
		pieces.push(piece);
	}
	const whole = pieces.join("");
	if (whole.length <= maxChars) return { text: whole, changed, cut: false };
	// Too long once made safe: keep whole pieces while they and the ellipsis fit.
	for (const piece of pieces) {
		if (out.length + piece.length + 1 > maxChars) break;
		out += piece;
	}
	return { text: `${out}…`, changed: true, cut: true };
}

/** Whether decoding these bytes as UTF-8 and encoding them again gives the same bytes. */
export const isLosslessUtf8V0 = (bytes: Buffer): boolean => Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);

// --- status --------------------------------------------------------------------------------------------------------------------

export interface RawChangeV0 {
	area: EndoChangeAreaV0;
	status: EndoChangeStatusV0;
	path: string;
	origPath: string | null;
	/** False when the path is not valid UTF-8: it cannot be passed back to Git exactly. */
	pathExact: boolean;
	/** The fields of the record that identify this change, to tell later whether it is the same one. */
	signature: string;
	/** The blob names Git printed for HEAD and the index (staged and unstaged comparisons are checked against them). */
	headOid: string | null;
	indexOid: string | null;
}

export interface ParsedStatusV0 {
	/** `(initial)` is reported by Git for a repository with no commit yet. */
	branchOid: string | null;
	branchHead: string | null;
	changes: RawChangeV0[];
	/** The output was cut at the cap: the changes are a prefix, and counts are lower bounds. */
	truncated: boolean;
}

const LETTER: Readonly<Record<string, EndoChangeStatusV0>> = {
	M: "modified",
	T: "type-changed",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
};

/** `git status --porcelain=v2 -z --branch --untracked-files=all` (see the fixed argument list in the inspector). */
export function parseStatusV2(stdout: Buffer, truncated: boolean): ParsedStatusV0 {
	const parsed: ParsedStatusV0 = { branchOid: null, branchHead: null, changes: [], truncated };
	const records: Buffer[] = [];
	let start = 0;
	for (let at = stdout.indexOf(0, start); at !== -1; at = stdout.indexOf(0, start)) {
		records.push(stdout.subarray(start, at));
		start = at + 1;
	}
	// A cut output ends mid-record: the unfinished tail is dropped, never half read.
	if (start < stdout.length && !truncated) records.push(stdout.subarray(start));
	for (let i = 0; i < records.length; i++) {
		const record = records[i] as Buffer;
		const text = record.toString("utf8");
		const exact = isLosslessUtf8V0(record);
		if (text.startsWith("# ")) {
			const [key, ...rest] = text.slice(2).split(" ");
			if (key === "branch.oid") parsed.branchOid = rest[0] === "(initial)" ? null : (rest[0] ?? null);
			else if (key === "branch.head") parsed.branchHead = rest.join(" ") || null;
		} else if (text.startsWith("? ")) {
			parsed.changes.push({
				area: "untracked",
				status: "untracked",
				path: text.slice(2),
				origPath: null,
				pathExact: exact,
				signature: `?|${text.slice(2)}`,
				headOid: null,
				indexOid: null,
			});
		} else if (text.startsWith("1 ") || text.startsWith("2 ")) {
			const renamed = text.startsWith("2 ");
			const parts = text.split(" ");
			const need = renamed ? 10 : 9;
			if (parts.length < need) continue;
			const xy = parts[1] as string;
			const [mH, mI, mW, hH, hI] = [parts[3], parts[4], parts[5], parts[6], parts[7]] as string[];
			const path = parts.slice(need - 1).join(" ");
			let orig: string | null = null;
			let origExact = true;
			if (renamed) {
				const next = records[i + 1];
				if (next === undefined) {
					// The old name is in the next field: a cut output may not have it.
					parsed.truncated = true;
					break;
				}
				orig = next.toString("utf8");
				origExact = isLosslessUtf8V0(next);
				i += 1;
			}
			const x = xy[0] as string;
			const y = xy[1] as string;
			const base = `${xy}|${mH}|${mI}|${mW}|${hH}|${hI}|${path}|${orig ?? ""}`;
			if (x !== ".")
				parsed.changes.push({
					area: "staged",
					status: LETTER[x] ?? "modified",
					path,
					origPath: renamed ? orig : null,
					pathExact: exact && origExact,
					signature: `s|${base}`,
					headOid: hH ?? null,
					indexOid: hI ?? null,
				});
			if (y !== ".")
				parsed.changes.push({
					area: "unstaged",
					status: LETTER[y] ?? "modified",
					path,
					origPath: null,
					pathExact: exact,
					signature: `u|${base}`,
					headOid: hH ?? null,
					indexOid: hI ?? null,
				});
		} else if (text.startsWith("u ")) {
			const parts = text.split(" ");
			if (parts.length < 11) continue;
			const path = parts.slice(10).join(" ");
			parsed.changes.push({
				area: "conflicted",
				status: "conflicted",
				path,
				origPath: null,
				pathExact: exact,
				signature: `c|${parts[1]}|${path}`,
				headOid: null,
				indexOid: null,
			});
		}
	}
	return parsed;
}

// --- numstat -------------------------------------------------------------------------------------------------------------------

export interface NumstatV0 {
	additions: number | null;
	deletions: number | null;
	binary: boolean;
}

/** `git diff [--cached] --numstat -z -M`: keyed by the NEW path. */
export function parseNumstat(stdout: Buffer): Map<string, NumstatV0> {
	const out = new Map<string, NumstatV0>();
	const tokens: string[] = [];
	let start = 0;
	for (let at = stdout.indexOf(0, start); at !== -1; at = stdout.indexOf(0, start)) {
		tokens.push(stdout.subarray(start, at).toString("utf8"));
		start = at + 1;
	}
	for (let i = 0; i < tokens.length; i++) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i] as string);
		if (match === null) continue;
		let path = match[3] as string;
		if (path === "") {
			// A rename: the old name and the new name are the next two fields.
			const newName = tokens[i + 2];
			if (newName === undefined) break;
			path = newName;
			i += 2;
		}
		const binary = match[1] === "-" || match[2] === "-";
		out.set(path, {
			additions: binary ? null : Number(match[1]),
			deletions: binary ? null : Number(match[2]),
			binary,
		});
	}
	return out;
}

// --- worktrees -----------------------------------------------------------------------------------------------------------------

export interface RawWorktreeV0 {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	prunable: boolean;
}

/** `git worktree list --porcelain -z`: attributes are NUL-separated; an empty field ends a worktree. */
export function parseWorktrees(stdout: Buffer): RawWorktreeV0[] {
	const out: RawWorktreeV0[] = [];
	let current: RawWorktreeV0 | null = null;
	let start = 0;
	const fields: string[] = [];
	for (let at = stdout.indexOf(0, start); at !== -1; at = stdout.indexOf(0, start)) {
		fields.push(stdout.subarray(start, at).toString("utf8"));
		start = at + 1;
	}
	if (start < stdout.length) fields.push(stdout.subarray(start).toString("utf8"));
	for (const field of fields) {
		if (field === "") {
			if (current !== null) out.push(current);
			current = null;
		} else if (field.startsWith("worktree ")) {
			if (current !== null) out.push(current);
			current = {
				path: field.slice("worktree ".length),
				head: null,
				branch: null,
				detached: false,
				bare: false,
				locked: false,
				prunable: false,
			};
		} else if (current !== null) {
			if (field.startsWith("HEAD ")) {
				const oid = field.slice(5);
				current.head = /^0+$/.test(oid) ? null : oid;
			} else if (field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, "");
			else if (field === "detached") current.detached = true;
			else if (field === "bare") current.bare = true;
			else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
			else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
		}
	}
	if (current !== null) out.push(current);
	return out;
}

// --- one file's unified diff ---------------------------------------------------------------------------------------------------

export interface ParsedDiffV0 {
	notes: string[];
	hunks: EndoDiffHunkV0[];
	binary: boolean;
	truncated: boolean;
	longLines: boolean;
	/** The two blob names of the `index a..b` line, when Git printed one. */
	index: { from: string; to: string } | null;
}

const NOTE =
	/^(old mode|new mode|deleted file mode|new file mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index) /;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?([\s\S]*)$/;

/** Parse the unified diff of ONE file. Bounded in lines and in line length; what is cut is said, never hidden. */
export function parseUnifiedDiff(text: string, truncatedInput: boolean): ParsedDiffV0 {
	const result: ParsedDiffV0 = {
		notes: [],
		hunks: [],
		binary: false,
		truncated: truncatedInput,
		longLines: false,
		index: null,
	};
	const lines = text.split("\n");
	// The text ends with a newline, so the last element is empty. A cut text ends mid-line: that last line is not trusted.
	if (lines.at(-1) === "" || truncatedInput) lines.pop();
	let hunk: EndoDiffHunkV0 | null = null;
	let oldLeft = 0;
	let newLeft = 0;
	let total = 0;
	const cut = (value: string): string => {
		const safe = displaySafeV0(value, GIT_LIMITS_V0.lineChars);
		if (safe.cut) result.longLines = true;
		return safe.text;
	};
	for (const line of lines) {
		if (hunk !== null && (oldLeft > 0 || newLeft > 0 || line.startsWith("\\"))) {
			// `diff.suppressBlankEmpty` drops the space before an empty context line: inside a hunk an empty line is that line.
			const c = line === "" ? " " : line[0];
			if (c === " " || c === "+" || c === "-" || c === "\\") {
				if (total >= GIT_LIMITS_V0.diffLines) {
					result.truncated = true;
					break;
				}
				total += 1;
				if (c === " ") {
					oldLeft -= 1;
					newLeft -= 1;
				} else if (c === "-") oldLeft -= 1;
				else if (c === "+") newLeft -= 1;
				hunk.lines.push((c as string) + cut(line.slice(1)));
				continue;
			}
		}
		const header = HUNK.exec(line);
		if (header !== null) {
			hunk = {
				oldStart: Number(header[1]),
				oldLines: header[2] === undefined ? 1 : Number(header[2]),
				newStart: Number(header[3]),
				newLines: header[4] === undefined ? 1 : Number(header[4]),
				section: displaySafeV0(header[5] as string, 120).text,
				lines: [],
			};
			oldLeft = hunk.oldLines;
			newLeft = hunk.newLines;
			result.hunks.push(hunk);
		} else if (hunk === null || (oldLeft <= 0 && newLeft <= 0)) {
			if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) result.binary = true;
			else if (line.startsWith("index ")) {
				const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
				// A file that changes TYPE (a file becomes a link) is two patches for one path: a deletion, then an addition. The comparison
				// runs from the FIRST patch's source to the LAST patch's target.
				if (match !== null)
					result.index = { from: result.index?.from ?? (match[1] as string), to: match[2] as string };
			} else if (NOTE.test(line) && result.notes.length < 8) result.notes.push(displaySafeV0(line, 200).text);
		}
	}
	return result;
}

/** Whether two blob names (one possibly abbreviated) can be the same object. Zero names stand for "no such side". */
export const sameBlobV0 = (printed: string, full: string | null): boolean =>
	full === null ? /^0+$/.test(printed) : full.startsWith(printed) || printed.startsWith(full);
