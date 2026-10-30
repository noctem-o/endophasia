// The read-only project context of the live workbench (adapters/git/project-inspector.ts served by adapters/pi/workbench.ts), as types
// only. It is a TRANSIENT observation: it is never recorded, never added to an event, and carries no session identity. A repository is
// not a session and a worktree is not an agent: the page shows this beside the live session, and nothing here says an agent made a change.
//
// Two routes, both GET, both behind the workbench grant (they carry local paths and source text):
//   project                        `EndoWorkbenchProjectV0`: where the session was launched, what Git says about it, the changed-file inventory.
//   project/diff?snapshot=&file=   `EndoWorkbenchDiffV0`: one file's change, read for the inventory entry the page was shown.
// The page never names a path: it names an inventory entry (an index) of a snapshot (an opaque id), and the server maps it to the path it
// itself read from Git. Text that came from the repository (a path, a branch name, a diff line) is made display-safe on the way out.

export const ENDO_WORKBENCH_PROJECT_SCHEMA_V0 = "endo.workbench-project.v0";
export const ENDO_WORKBENCH_DIFF_SCHEMA_V0 = "endo.workbench-diff.v0";

/** Why a project or a change list could not be established. A closed list: no text from Git or the system is ever forwarded. */
export const ENDO_PROJECT_REASONS_V0 = [
	"no-directory", // the launch directory is missing or cannot be read
	"not-a-repository", // Git does not find a repository there
	"bare-repository", // a repository with no working tree
	"ownership", // Git declined the repository (another user owns it)
	"scope-mismatch", // the repository's working tree does not contain the launch directory
	"git-not-found", // no Git executable could be run
	"git-failed", // Git ran and failed
	"git-timeout", // Git did not answer in time
	"output-too-large", // Git's answer exceeded what is read
	"busy", // another inspection is running
] as const;
export type EndoProjectReasonV0 = (typeof ENDO_PROJECT_REASONS_V0)[number];

/** What a ready inspection could not complete. Each one means a number or a list below is a lower bound or absent. */
export const ENDO_PROJECT_INCOMPLETE_V0 = [
	"status-truncated", // the change list was cut: counts are lower bounds
	"stats-unavailable", // line counts could not be read
	"worktrees-unavailable", // the linked-worktree list could not be read
	"worktrees-truncated", // more linked worktrees exist than are listed
] as const;
export type EndoProjectIncompleteV0 = (typeof ENDO_PROJECT_INCOMPLETE_V0)[number];

export type EndoChangeAreaV0 = "staged" | "unstaged" | "untracked" | "conflicted";
export type EndoChangeStatusV0 =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "type-changed"
	| "untracked"
	| "conflicted";

/** One entry of the inventory: one file in ONE area. A file changed in the index and again in the working tree is two entries. */
export interface EndoChangeEntryV0 {
	/** Its index in this snapshot's list; the only way a diff is asked for. */
	id: number;
	/** Relative to the repository root, display-safe. */
	path: string;
	/** For a rename or copy, where it came from. */
	origPath: string | null;
	area: EndoChangeAreaV0;
	status: EndoChangeStatusV0;
	/** Lines added and removed; null when unknown or binary. */
	additions: number | null;
	deletions: number | null;
	/** Whether Git calls it binary; null when not known (an untracked file is judged when read). */
	binary: boolean | null;
	/** The real name holds characters that were replaced to make it safe to show. */
	escaped: boolean;
}

export interface EndoChangeStatsV0 {
	additions: number;
	deletions: number;
	/** Files whose lines could not be counted (binary, or unknown). */
	uncounted: number;
}

export interface EndoWorktreeV0 {
	/** Absolute path of that working tree. */
	path: string;
	/** Its branch, or null when detached or bare. */
	branch: string | null;
	/** Its HEAD commit, or null when it has none yet. */
	head: string | null;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
	/** The worktree this session was launched in. */
	current: boolean;
}

export interface EndoWorkbenchProjectV0 {
	schemaVersion: typeof ENDO_WORKBENCH_PROJECT_SCHEMA_V0;
	/** Where the directory comes from: the working directory the attached process was configured with. Not observed from Pi, and not a session fact. */
	basis: "launch-directory";
	/** Opaque and new for every inspection. A diff is asked for under it, and is refused if the working tree has moved on. */
	snapshot: string;
	/** When the inspection finished, by the broker's clock (ms since the epoch). */
	capturedAtMs: number;
	state: "ready" | "unavailable";
	reason: EndoProjectReasonV0 | null;
	repository: {
		/** The main working tree's name, for display. */
		label: string;
		/** This working tree's name, for display. */
		worktreeLabel: string;
		/** Absolute path of this working tree's root. */
		root: string;
		/** The launch directory relative to the root ("" when it is the root). */
		cwdRelative: string;
		/** Absolute path of the Git directory shared by every worktree of this repository. */
		commonDir: string;
	} | null;
	head: {
		kind: "branch" | "detached" | "unborn";
		/** The branch name (the unborn branch's name for "unborn"), else null. */
		branch: string | null;
		/** The commit, or null for an unborn branch. */
		oid: string | null;
	} | null;
	/** Linked worktrees Git knows. A worktree is a place, not an agent: nothing says a session runs in any of them. */
	worktrees: EndoWorktreeV0[];
	changes: {
		/** `unknown` when the change list could not be read at all; `reason` then says why. */
		state: "ready" | "unavailable";
		reason: EndoProjectReasonV0 | null;
		dirty: "clean" | "dirty" | "unknown";
		counts: { staged: number; unstaged: number; untracked: number; conflicted: number; exact: boolean };
		stats: { staged: EndoChangeStatsV0; unstaged: EndoChangeStatsV0 } | null;
		files: EndoChangeEntryV0[];
		filesTruncated: boolean;
	};
	incomplete: EndoProjectIncompleteV0[];
}

/** What a diff request ended in. `stale` is not here: it is the 409 `stale-snapshot` refusal, because nothing is returned for it. */
export type EndoDiffStateV0 =
	| "ready" // hunks are present (possibly truncated)
	| "empty" // nothing to show (a mode-only change, or an empty file)
	| "binary"
	| "too-large" // the file was not read: it is over the limit
	| "unavailable"; // it cannot be shown: see `reason`

export const ENDO_DIFF_REASONS_V0 = [
	"unmerged", // a conflicted file has no single diff here
	"not-a-file", // a symbolic link, directory or special file is not read
	"path-not-text", // the name is not valid UTF-8, so it cannot be asked for exactly
	"read-failed", // the file or Git could not be read
	"git-failed",
	"git-timeout",
] as const;
export type EndoDiffReasonV0 = (typeof ENDO_DIFF_REASONS_V0)[number];

/** Each line starts with one of " " (context), "+", "-" or "\" (Git's "no newline at end of file"), then the text. */
export interface EndoDiffHunkV0 {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/** Git's hunk context label, display-safe, possibly empty. */
	section: string;
	lines: string[];
}

export interface EndoWorkbenchDiffV0 {
	schemaVersion: typeof ENDO_WORKBENCH_DIFF_SCHEMA_V0;
	snapshot: string;
	id: number;
	area: EndoChangeAreaV0;
	path: string;
	origPath: string | null;
	/** What is compared with what. These are never merged: an index change and a working-tree change are different comparisons. */
	comparison: "head-to-index" | "index-to-working-tree" | "untracked-file";
	state: EndoDiffStateV0;
	reason: EndoDiffReasonV0 | null;
	/** Git's own notes about the change (a mode change, a rename), display-safe, at most a few. */
	notes: string[];
	hunks: EndoDiffHunkV0[];
	/** The diff was cut at a limit: what is shown is a prefix. */
	truncated: boolean;
	/** At least one line was cut short for length. */
	longLines: boolean;
	/** Whether the rest of the inventory is still what the page was shown. */
	inventory: "unchanged" | "changed";
}

/** What a diff request ended in at the source, before the broker turns it into an HTTP answer. */
export type EndoDiffOutcomeV0 =
	| { kind: "diff"; diff: EndoWorkbenchDiffV0 }
	/** The working tree has moved on from the snapshot (or the snapshot is no longer the current one). Nothing is returned. */
	| { kind: "stale" }
	/** The snapshot has no such entry. */
	| { kind: "bad" }
	| { kind: "busy" };
