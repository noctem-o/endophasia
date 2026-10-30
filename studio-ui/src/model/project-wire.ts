// Browser wire gate for the project context (protocol/workbench-project.ts). The broker is authoritative for what a repository, a worktree
// or a diff is; this checks that a body has exactly the shape the renderers read, and refuses it whole when it does not. Nothing here
// treats text from a repository as anything but text: a path, a branch or a diff line is only ever shown, and is re-checked for control
// characters even though the server already made it safe.
import type {
	EndoDiffReasonV0,
	EndoProjectIncompleteV0,
	EndoProjectReasonV0,
	EndoWorkbenchDiffV0,
	EndoWorkbenchProjectV0,
} from "../../../protocol/workbench-project.ts";
import { type Check, count, eitherNull, list, one, shape } from "./compare-wire.ts";

export type {
	EndoChangeAreaV0 as ChangeArea,
	EndoChangeEntryV0 as ChangeEntry,
	EndoChangeStatusV0 as ChangeStatus,
	EndoDiffHunkV0 as DiffHunk,
	EndoWorkbenchDiffV0 as ProjectDiff,
	EndoWorkbenchProjectV0 as Project,
	EndoWorktreeV0 as Worktree,
} from "../../../protocol/workbench-project.ts";

/** These mirror the protocol's closed lists; a contract test holds them equal. */
export const PROJECT_REASONS: readonly EndoProjectReasonV0[] = [
	"no-directory",
	"not-a-repository",
	"bare-repository",
	"ownership",
	"scope-mismatch",
	"git-not-found",
	"git-failed",
	"git-timeout",
	"output-too-large",
	"partial-clone",
	"busy",
];
export const PROJECT_INCOMPLETE: readonly EndoProjectIncompleteV0[] = [
	"status-truncated",
	"stats-unavailable",
	"worktrees-unavailable",
	"worktrees-truncated",
	"untracked-hidden",
];
export const DIFF_REASONS: readonly EndoDiffReasonV0[] = [
	"unmerged",
	"not-a-file",
	"path-not-text",
	"read-failed",
	"git-failed",
	"git-timeout",
];

/** The first character of a diff line: context, added, removed, or the backslash of Git's "no newline at end of file". */
const DIFF_SIGNS = " +-\\";
const bool = (v: unknown): boolean => typeof v === "boolean";
const text =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length <= max;
const display: Check = text(4096);
const MAX_FILES = 500;
const MAX_HUNK_LINES = 5000;
const AREAS = ["staged", "unstaged", "untracked", "conflicted"] as const;
const STATUSES = [
	"added",
	"modified",
	"deleted",
	"renamed",
	"copied",
	"type-changed",
	"untracked",
	"conflicted",
] as const;
const oid: Check = (v) => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);
const nullableCount = eitherNull(count);

const stats: Check = (v) => shape(v, { additions: count, deletions: count, uncounted: count });
const entry: Check = (v) =>
	shape(v, {
		id: count,
		path: display,
		origPath: eitherNull(display),
		area: one(...AREAS),
		status: one(...STATUSES),
		additions: nullableCount,
		deletions: nullableCount,
		binary: eitherNull(bool),
		escaped: bool,
	});
const worktree: Check = (v) =>
	shape(v, {
		path: display,
		branch: eitherNull(text(512)),
		head: eitherNull(oid),
		detached: bool,
		locked: bool,
		prunable: bool,
		current: bool,
	});

export function readWorkbenchProject(v: unknown): EndoWorkbenchProjectV0 | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.workbench-project.v0"),
			basis: one("launch-directory"),
			snapshot: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
			capturedAtMs: count,
			state: one("ready", "unavailable"),
			reason: eitherNull(one(...PROJECT_REASONS)),
			repository: eitherNull((r) =>
				shape(r, {
					label: display,
					worktreeLabel: display,
					root: display,
					cwdRelative: display,
					commonDir: display,
				}),
			),
			head: eitherNull((h) =>
				shape(h, {
					kind: one("branch", "detached", "unborn"),
					branch: eitherNull(text(512)),
					oid: eitherNull(oid),
				}),
			),
			worktrees: (w) => Array.isArray(w) && w.length <= 50 && list(worktree)(w),
			changes: (c) =>
				shape(c, {
					state: one("ready", "unavailable"),
					reason: eitherNull(one(...PROJECT_REASONS)),
					dirty: one("clean", "dirty", "unknown"),
					counts: (n) =>
						shape(n, { staged: count, unstaged: count, untracked: count, conflicted: count, exact: bool }),
					stats: eitherNull((s) => shape(s, { staged: stats, unstaged: stats })),
					files: (f) => Array.isArray(f) && f.length <= MAX_FILES && list(entry)(f),
					filesTruncated: bool,
				}),
			incomplete: (i) => Array.isArray(i) && i.length <= 8 && list(one(...PROJECT_INCOMPLETE))(i),
		})
	)
		return null;
	const project = v as unknown as EndoWorkbenchProjectV0;
	// Entries are addressed by their position: a list whose ids are not 0..n-1 in order cannot be trusted to name what it shows.
	if (!project.changes.files.every((file, index) => file.id === index)) return null;
	if (project.state === "unavailable" && (project.repository !== null || project.reason === null)) return null;
	return project;
}

const hunk: Check = (v) =>
	shape(v, {
		oldStart: count,
		oldLines: count,
		newStart: count,
		newLines: count,
		section: text(400),
		lines: (l) =>
			Array.isArray(l) &&
			l.length <= MAX_HUNK_LINES &&
			list((x) => typeof x === "string" && DIFF_SIGNS.includes(x.charAt(0)) && x.length > 0)(l),
	});

export function readWorkbenchDiff(v: unknown): EndoWorkbenchDiffV0 | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.workbench-diff.v0"),
			snapshot: (x) => typeof x === "string" && /^[0-9a-f]{16}$/.test(x),
			id: count,
			area: one(...AREAS),
			path: display,
			origPath: eitherNull(display),
			comparison: one("head-to-index", "index-to-working-tree", "untracked-file"),
			state: one("ready", "empty", "binary", "too-large", "unavailable"),
			reason: eitherNull(one(...DIFF_REASONS)),
			notes: (n) => Array.isArray(n) && n.length <= 8 && list(text(400))(n),
			hunks: (h) => Array.isArray(h) && h.length <= 2000 && list(hunk)(h),
			truncated: bool,
			longLines: bool,
			inventory: one("unchanged", "changed"),
		})
	)
		return null;
	const diff = v as unknown as EndoWorkbenchDiffV0;
	if ((diff.state === "unavailable") !== (diff.reason !== null)) return null;
	if (diff.state !== "ready" && diff.hunks.length > 0) return null;
	return diff;
}

export type ProjectRequest = { kind: "project" } | { kind: "project-diff"; snapshot: string; id: number };

export type ProjectReply =
	| { kind: "project"; record: EndoWorkbenchProjectV0 }
	| { kind: "diff"; record: EndoWorkbenchDiffV0 }
	/** The route does not exist: this workbench was started without a project context. */
	| { kind: "absent" }
	/** The working tree has moved on since the list the page holds: re-read it. */
	| { kind: "stale" }
	| { kind: "failure"; status: number; code: string; retrySeconds: number | null };
