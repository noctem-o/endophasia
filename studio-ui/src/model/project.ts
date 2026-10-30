// The project context as the page keeps it: the last good read, what became of the attempts since, the file the operator is reading and
// its diff. Pure: no DOM, no network, no clock but the one a caller passes, no storage. Nothing here is remembered across a reload and
// nothing here is an authority: it describes a Git working tree the broker read, and says WHO changed it never.
//
// What the page must never do with it, and how the state prevents it: a failed or stale read does not discard the last good one (the
// operator keeps what was last confirmed) but marks it not current; a selection is a (path, area) pair, never an id, so a refreshed list
// cannot silently show a different file under the same position; and a read is never repeated by the model: every transition here is
// the result of an explicit action or of ONE automatic read the hook makes when the page is first paired.
import type {
	ChangeArea,
	ChangeEntry,
	ChangeStatus,
	DiffHunk,
	Project,
	ProjectDiff,
	ProjectReason,
	ProjectReply,
} from "./project-wire.ts";

export type ProjectProblem = "unpaired" | "stale" | "busy" | "error" | "invalid" | "unreachable";

/**
 * Which change is being read. `path` is the DISPLAY path, which is not unique (two different names can show the same once their control
 * characters are replaced), so `nth` is the position among the entries that show the same path in the same area: normally 0.
 */
export interface FileKey {
	path: string;
	area: ChangeArea;
	nth: number;
}

export type DiffState =
	| { status: "idle" }
	| { status: "loading"; key: FileKey }
	| { status: "ready"; key: FileKey; record: ProjectDiff }
	/** The list the page holds no longer matches the working tree (or the file left it): nothing is shown for it. */
	| { status: "stale"; key: FileKey }
	| { status: "gone"; key: FileKey }
	| { status: "failed"; key: FileKey; problem: ProjectProblem };

export interface ProjectState {
	/** `unknown` until the first answer; `absent` when this workbench has no project routes. */
	availability: "unknown" | "absent" | "available";
	reading: boolean;
	/** The last good read. Kept through failures, and marked by `current`. */
	project: Project | null;
	current: boolean;
	/** What the last attempt ended in, when it was not a good read. */
	problem: ProjectProblem | null;
	/** Why Git could not confirm the worktree on the last attempt, when the broker answered but Git failed. */
	failure: ProjectReason | null;
	selection: FileKey | null;
	diff: DiffState;
	view: "conversation" | "changes";
	/** Replies older than these are ignored: a slow answer never overwrites a newer one. */
	readSeq: number;
	diffSeq: number;
}

export const initialProject = (): ProjectState => ({
	availability: "unknown",
	reading: false,
	project: null,
	current: false,
	problem: null,
	failure: null,
	selection: null,
	diff: { status: "idle" },
	view: "conversation",
	readSeq: 0,
	diffSeq: 0,
});

export type ProjectAction =
	| { type: "read-start"; seq: number }
	| { type: "read-done"; seq: number; reply: ProjectReply }
	/** `snapshot` is the list the diff was asked under: an answer for an older list is dropped once a refresh has replaced it. */
	| { type: "diff-start"; seq: number; key: FileKey; snapshot: string }
	| { type: "diff-done"; seq: number; key: FileKey; snapshot: string; reply: ProjectReply }
	| { type: "select"; key: FileKey | null }
	| { type: "view"; view: "conversation" | "changes" }
	/** The grant is gone or the launch changed: nothing private is kept. */
	| { type: "reset" };

export const sameKey = (a: FileKey | null, b: FileKey | null): boolean =>
	a !== null && b !== null && a.path === b.path && a.area === b.area && a.nth === b.nth;

/** The key of an entry in its list. */
export const keyOf = (files: readonly ChangeEntry[], entry: ChangeEntry): FileKey => ({
	path: entry.path,
	area: entry.area,
	nth: files.filter((f) => f.path === entry.path && f.area === entry.area && f.id < entry.id).length,
});

export const findEntry = (project: Project | null, key: FileKey | null): ChangeEntry | null =>
	project === null || key === null
		? null
		: (project.changes.files.filter((file) => file.path === key.path && file.area === key.area)[key.nth] ?? null);

function problemOf(reply: ProjectReply): ProjectProblem {
	if (reply.kind === "stale") return "stale";
	if (reply.kind !== "failure") return "error";
	if (reply.code === "grant-required") return "unpaired";
	if (reply.code === "busy") return "busy";
	if (reply.code === "invalid") return "invalid";
	if (reply.code === "unreachable") return "unreachable";
	return "error";
}

/** Reasons that say an ATTEMPT failed, not what the directory is. */
const FAILED_ATTEMPTS: readonly ProjectReason[] = [
	"git-failed",
	"git-timeout",
	"git-not-found",
	"output-too-large",
	"busy",
];

export function reduceProject(state: ProjectState, action: ProjectAction): ProjectState {
	switch (action.type) {
		case "read-start":
			return { ...state, reading: true, readSeq: action.seq };
		case "read-done": {
			if (action.seq !== state.readSeq) return state;
			const { reply } = action;
			if (reply.kind === "absent") return { ...initialProject(), availability: "absent", readSeq: state.readSeq };
			if (reply.kind === "project") {
				const project = reply.record;
				// The broker answered, but Git could not read the worktree (it failed, timed out, was missing, said too much, or was busy).
				// That confirms nothing and refutes nothing: the last good list and the file being read stay, marked unconfirmed, with the
				// reason. Only a fact about the directory (not a repository, bare, refused, out of scope, a partial clone, gone) replaces it.
				const attemptFailed =
					(project.state === "unavailable" &&
						project.reason !== null &&
						FAILED_ATTEMPTS.includes(project.reason)) ||
					(project.state === "ready" && project.changes.state === "unavailable");
				if (attemptFailed && state.project !== null)
					return {
						...state,
						availability: "available",
						reading: false,
						current: false,
						problem: "error",
						failure: project.state === "unavailable" ? project.reason : project.changes.reason,
					};
				// The selection survives the refresh by name: if that change is still listed it is read again, if not it is said to be gone.
				const survives = findEntry(project, state.selection) !== null;
				return {
					...state,
					availability: "available",
					reading: false,
					project,
					current: true,
					problem: null,
					failure: null,
					diff:
						state.selection === null
							? { status: "idle" }
							: survives
								? { status: "loading", key: state.selection }
								: { status: "gone", key: state.selection },
				};
			}
			const problem = problemOf(reply);
			return {
				...state,
				availability: state.availability === "unknown" ? "available" : state.availability,
				reading: false,
				// "Busy" says nothing about the worktree: what was confirmed is neither confirmed again nor called into doubt.
				current: problem === "busy" ? state.current : false,
				problem,
			};
		}
		case "select":
			return {
				...state,
				selection: action.key,
				diff: action.key === null ? { status: "idle" } : { status: "loading", key: action.key },
				view: action.key === null ? state.view : "changes",
			};
		case "diff-start":
			return { ...state, diffSeq: action.seq, diff: { status: "loading", key: action.key } };
		case "diff-done": {
			if (
				action.seq !== state.diffSeq ||
				!sameKey(action.key, state.selection) ||
				action.snapshot !== state.project?.snapshot
			)
				return state;
			const { reply } = action;
			if (reply.kind === "diff") {
				// The diff is good, but the broker found OTHER files changed since this list was read: the list is out of date, though
				// this file can still be read. Shown as such until the operator refreshes; nothing is re-read by itself.
				const moved = reply.record.inventory === "changed";
				return {
					...state,
					current: moved ? false : state.current,
					problem: moved ? "stale" : state.problem,
					diff: { status: "ready", key: action.key, record: reply.record },
				};
			}
			// A stale answer also says the LIST is out of date: the page keeps showing it, marked not current, and reads nothing by itself.
			if (reply.kind === "stale")
				return { ...state, current: false, problem: "stale", diff: { status: "stale", key: action.key } };
			return { ...state, diff: { status: "failed", key: action.key, problem: problemOf(reply) } };
		}
		case "view":
			return { ...state, view: action.view };
		case "reset":
			return {
				...initialProject(),
				availability: state.availability === "absent" ? "absent" : "unknown",
				// No answer to a request made before the reset is accepted after it (a list of the previous launch arriving late would
				// otherwise fill the cleared state, marked current): no request ever carries a negative sequence.
				readSeq: -1,
				diffSeq: -1,
			};
	}
}

// --- words ---------------------------------------------------------------------------------------------------------------------

export const REASON_WORDS: Readonly<Record<string, string>> = {
	"no-directory": "Pi's launch directory could not be read.",
	"not-a-repository": "Not a Git worktree: Pi's launch directory is not inside a repository.",
	"bare-repository": "That is a bare repository: it has no working tree to show.",
	ownership: "Git declined this repository because another user owns it.",
	"scope-mismatch": "Git's working tree does not contain Pi's launch directory, so nothing was read.",
	"git-not-found": "Git could not be run: no Git executable was found.",
	"git-failed": "Git could not read this repository.",
	"git-timeout": "Git did not answer in time.",
	"output-too-large": "Git's answer was larger than is read.",
	"unsafe-config":
		"This repository's configuration names a program in a way that cannot be switched off exactly, so it was not read.",
	"partial-clone":
		"This repository is a partial clone, and this Git cannot be told not to fetch missing objects on demand, so it was not read.",
	busy: "Another inspection is running. Try again shortly.",
};

export const INCOMPLETE_WORDS: Readonly<Record<string, string>> = {
	"status-truncated": "The change list was cut at a limit, so the counts are at least these.",
	"stats-unavailable": "Line counts could not be read.",
	"worktrees-unavailable": "Other worktrees could not be listed.",
	"worktrees-truncated": "More worktrees exist than are listed.",
	"untracked-hidden": "This repository's configuration hides untracked files, so none are listed or counted.",
};

export const PROBLEM_WORDS: Readonly<Record<ProjectProblem, string>> = {
	unpaired: "This page is no longer paired, so the worktree was not read. Pair it again.",
	stale: "The worktree changed after this list was read. Refresh to see it as it is now.",
	busy: "Another inspection is running. Try again shortly.",
	error: "The worktree could not be read. What is shown was last confirmed earlier.",
	invalid: "The worktree reply was not valid and was not shown.",
	unreachable: "The broker did not answer. The worktree may have changed.",
};

export const AREA_WORDS: Readonly<Record<ChangeArea, { name: string; compares: string }>> = {
	conflicted: { name: "Conflicted", compares: "unmerged" },
	staged: { name: "Staged", compares: "HEAD → index" },
	unstaged: { name: "Unstaged", compares: "index → working tree" },
	untracked: { name: "Untracked", compares: "not in Git" },
};
export const AREA_ORDER: readonly ChangeArea[] = ["conflicted", "staged", "unstaged", "untracked"];

export const STATUS_LETTER: Readonly<Record<ChangeStatus, { letter: string; word: string }>> = {
	added: { letter: "A", word: "added" },
	modified: { letter: "M", word: "modified" },
	deleted: { letter: "D", word: "deleted" },
	renamed: { letter: "R", word: "renamed" },
	copied: { letter: "C", word: "copied" },
	"type-changed": { letter: "T", word: "type changed" },
	untracked: { letter: "?", word: "untracked" },
	conflicted: { letter: "!", word: "conflicted" },
};

export const COMPARISON_WORDS = {
	"head-to-index": "HEAD → index (staged)",
	"index-to-working-tree": "index → working tree (unstaged)",
	"untracked-file": "untracked: not in Git, every line shown as added",
} as const;

export const DIFF_REASON_WORDS: Readonly<Record<string, string>> = {
	unmerged: "Conflicted: it has no single diff here. Resolve it in your editor or terminal.",
	"not-a-file": "Not a regular file (a link, directory or special file), so it was not read.",
	"path-not-text": "Its name is not valid text, so it cannot be asked for exactly.",
	"read-failed": "The file could not be read.",
	"git-failed": "Git could not produce this diff.",
	"git-timeout": "Git did not answer in time.",
};

/** The single statement about authorship, said once beside the change list. */
export const AUTHORSHIP_WORDS =
	"Changes in the Git working tree. Git does not show who made them: nothing here attributes them to the agent.";

export const shortOid = (oid: string | null): string => (oid === null ? "—" : oid.slice(0, 7));

/** "3 staged", with "at least" when the list was cut. Areas with nothing are left out; the areas are never summed. */
export function countParts(project: Project): { area: ChangeArea; text: string }[] {
	const { counts } = project.changes;
	return AREA_ORDER.flatMap((area) => {
		const n = counts[area];
		return n === 0 ? [] : [{ area, text: `${counts.exact ? "" : "≥"}${n} ${AREA_WORDS[area].name.toLowerCase()}` }];
	});
}

/** Entries grouped by area, in the order the list should read; a file changed in two areas is in two groups. */
export function groupFiles(files: readonly ChangeEntry[]): { area: ChangeArea; files: ChangeEntry[] }[] {
	return AREA_ORDER.map((area) => ({ area, files: files.filter((f) => f.area === area) })).filter(
		(g) => g.files.length > 0,
	);
}

/** The folder and the file name of a repository path, for a two-line row. */
export function splitPath(path: string): { dir: string; name: string } {
	const at = path.lastIndexOf("/");
	return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/** The neighbour of a file in reading order (the order of the list), or null at either end or when the file is not listed. */
export function neighbour(project: Project | null, key: FileKey | null, step: 1 | -1): FileKey | null {
	if (project === null) return null;
	const files = project.changes.files;
	const at = findEntry(project, key);
	// Nothing selected, or the selection left the list (it was committed, say): stepping starts at an end rather than going nowhere.
	const next = at === null ? files.at(step === 1 ? 0 : -1) : files[files.indexOf(at) + step];
	return next === undefined ? null : keyOf(files, next);
}

export interface DiffRow {
	kind: "context" | "added" | "removed" | "note";
	old: number | null;
	new: number | null;
	text: string;
}

/** One hunk's lines with their line numbers on each side, from the hunk header's starts. A "\ No newline" marker has no number. */
export function hunkRows(hunk: DiffHunk): DiffRow[] {
	let old = hunk.oldStart;
	let now = hunk.newStart;
	return hunk.lines.map((line): DiffRow => {
		const text = line.slice(1);
		if (line.startsWith("+")) return { kind: "added", old: null, new: now++, text };
		if (line.startsWith("-")) return { kind: "removed", old: old++, new: null, text };
		if (line.startsWith("\\")) return { kind: "note", old: null, new: null, text };
		return { kind: "context", old: old++, new: now++, text };
	});
}

export const hunkLabel = (hunk: DiffHunk): string =>
	`@@ −${hunk.oldStart}${hunk.oldLines === 1 ? "" : `,${hunk.oldLines}`} +${hunk.newStart}${hunk.newLines === 1 ? "" : `,${hunk.newLines}`} @@${hunk.section === "" ? "" : ` ${hunk.section}`}`;

/** Whether what the page shows is what Git said at the last good read AND nothing since has said otherwise. */
export const isCurrent = (state: ProjectState, connected: boolean): boolean =>
	state.project !== null && state.current && connected;
