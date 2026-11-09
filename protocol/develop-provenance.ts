// What DEVELOP shows of an attempt's provenance (docs/designs/develop-candidate-provenance.md): two observed states compared, the words for
// observation points, and the read model a reader computes from the observation records (protocol/develop-observations.ts). Types and words
// only, with no Node module, so the page's gate can name them.

/**
 * Where an observation was made and what made it.
 * - `before-send`: the live workbench, after the operator approved sending this attempt and before the send was recorded.
 * - `after-run`: the live workbench, when the run that followed that send ended (`run-settled`), or when the workbench closed with that
 *   run still open (`workbench-closing`).
 * - `operator`: `endo attempt observe`, whenever the operator ran it. It says nothing about where the attempt's work stood.
 */
export type EndoObservationPointV0 = "before-send" | "after-run" | "operator";
export type EndoObservationTriggerV0 = "send-approved" | "run-settled" | "workbench-closing" | "operator-command";

/** Why a working tree could not be observed (the revision observer's reasons, and the observations service's own). */
export const ENDO_OBSERVATION_UNAVAILABLE_V0 = [
	"no-directory",
	"not-a-repository",
	"bare-repository",
	"not-top-level",
	"scope-mismatch",
	"unsafe-config",
	"partial-clone",
	"unborn",
	"ownership",
	"git-not-found",
	"git-timeout",
	"git-failed",
	"output-too-large",
	"other-repository",
	"timed-out",
] as const;
export type EndoObservationUnavailableV0 = (typeof ENDO_OBSERVATION_UNAVAILABLE_V0)[number];

export type EndoObservedAreaV0 = "staged" | "unstaged" | "untracked" | "conflicted";

/** Why a changed path's content was not read. Its path is still listed; the state is incomplete for comparing. */
export type EndoNotReadV0 = "too-large" | "budget" | "unreadable" | "changing" | "not-a-file" | "path-not-exact";

/** A Git tree entry mode for a file: regular, executable, symbolic link. */
export type EndoFileModeV0 = "100644" | "100755" | "120000";

/** What the working tree held at a changed path. */
export type EndoObservedContentV0 =
	| { kind: "file"; mode: EndoFileModeV0; oid: string }
	| { kind: "absent" }
	| { kind: "not-read"; why: EndoNotReadV0 };

// ---- comparing two states -----------------------------------------------------------------------------------------------------------

/** How a path differs between two states. `mode`: the same content with a different mode. */
export type EndoPathChangeV0 = "added" | "deleted" | "modified" | "mode";

/**
 * Two states (or a state and a clean commit) compared path by path, by Git's blob ids. `same`: every path that either state lists, and
 * every path whose commit differs, holds the same content in both. `different`: these paths do not (the list may be cut). `not-compared`:
 * one side is incomplete, or Git could not answer; nothing is claimed either way.
 */
export type EndoStateComparisonV0 =
	| { relation: "same" }
	| { relation: "different"; paths: { path: string; change: EndoPathChangeV0 }[]; total: number }
	| { relation: "not-compared"; reason: EndoNotComparedV0 };

export type EndoNotComparedV0 =
	| "incomplete"
	| "other-repository"
	| "commit-unavailable"
	| "too-many-paths"
	| "git-failed"
	| "unavailable";

export const ENDO_NOT_COMPARED_TEXT_V0: Readonly<Record<EndoNotComparedV0, string>> = Object.freeze({
	incomplete: "one of the two states was not fully read (too many changes, a file not read, or hidden index entries)",
	"other-repository": "the two were observed in different repositories",
	"commit-unavailable": "Git no longer has one of the commits",
	"too-many-paths": "too many paths differ to compare",
	"git-failed": "Git could not answer",
	unavailable: "one of the two could not be observed",
});

/** The words for each point, everywhere. None of them names who changed anything. */
export const ENDO_OBSERVATION_POINT_LABELS_V0: Readonly<Record<EndoObservationPointV0, string>> = Object.freeze({
	"before-send": "Just before the brief was sent",
	"after-run": "When the run had ended",
	operator: "When you asked",
});

export const ENDO_OBSERVATION_TRIGGER_TEXT_V0: Readonly<Record<EndoObservationTriggerV0, string>> = Object.freeze({
	"send-approved": "the workbench observed it after your approval and before it recorded the send",
	"run-settled": "the workbench observed it after Pi reported the run that followed the send had settled",
	"workbench-closing": "the workbench observed it while closing, with the run that followed the send still open",
	"operator-command": "you ran endo attempt observe",
});

/** What no observation establishes. Shown with every reading. */
export const ENDO_OBSERVATION_LIMITATIONS_V0 = Object.freeze([
	"Git's view at one moment: who or what changed the tree (the agent, you, an editor, a hook, another process) is not known.",
	"Two observations that read the same do not mean nothing changed between them.",
	"Ignored files are not part of a state; their contents were not read.",
	"Content is compared by Git blob id over the raw bytes; Git's line-ending or filter conversion, if the repository uses any, is not applied.",
]);

// ---- the read model -----------------------------------------------------------------------------------------------------------------

/** Changed paths an observation's view lists at most (the count is always given). */
export const ENDO_OBSERVATION_VIEW_MAX_PATHS_V0 = 100;

/** One observation as a reader shows it: no absolute path, the content reduced to what kind it is. */
export interface EndoObservationViewV0 {
	id: string;
	point: EndoObservationPointV0;
	trigger: EndoObservationTriggerV0;
	startedAtMs: number;
	endedAtMs: number;
	/**
	 * For the workbench's points: whether its binding names the send the attempt's authorisation names (`this-send`), or not (`other-send`:
	 * it is shown, never used). Null for the operator's.
	 */
	bound: "this-send" | "other-send" | null;
	state: "observed" | "unavailable";
	reason: EndoObservationUnavailableV0 | null;
	commit: string | null;
	branch: string | null;
	/** The same working tree as the reader's (null: unknown, or not observed). */
	here: boolean | null;
	changed: number;
	complete: boolean;
	truncated: boolean;
	paths: { path: string; areas: EndoObservedAreaV0[]; content: EndoObservedContentV0["kind"] }[];
}

/** HEAD from one observation to another. */
export interface EndoHeadMoveV0 {
	from: string;
	to: string;
	/** Commits reachable from `to` and not from `from`, and whether `from` is an ancestor of `to`; null when Git could not say. */
	ahead: number | null;
	descends: boolean | null;
}

/** Which observations frame the attempt, and why those. */
export type EndoProvenanceBasisV0 =
	/** The workbench's two: just before the send, and when the run had ended. */
	| "send-and-run"
	/** Just before the send; no observation after the run (the workbench ended first, or the run has not ended), and none of yours since. */
	| "send-only"
	/** Just before the send, and your latest observation since (the workbench made none after the run). */
	| "send-and-operator"
	/** When the run had ended; no observation from just before the send. */
	| "run-only"
	/** No workbench observation; the operator's first and latest observations. They say nothing about when the work happened. */
	| "operator";

export interface EndoAttemptProvenanceViewV0 {
	/** `unreadable`: the observations directory could not be read (there may be some). `none`: no observation is recorded. */
	state: "observed" | "none" | "unreadable";
	observations: EndoObservationViewV0[];
	basis: EndoProvenanceBasisV0 | null;
	/** The observations compared: from `start` to `end` (null when only one is usable). */
	start: string | null;
	end: string | null;
	head: EndoHeadMoveV0 | null;
	span: EndoStateComparisonV0 | null;
	/**
	 * The reader's working tree now, compared with the latest framing observation (`end`, else `start`). Null when there is nothing to
	 * compare with; `unavailable` when the tree could not be observed now.
	 */
	now: {
		observedAtMs: number;
		commit: string | null;
		head: EndoHeadMoveV0 | null;
		comparison: EndoStateComparisonV0;
	} | null;
	/** Each commit a receipt of this attempt ran at, in this tree, compared with the latest framing observation. Newest first, at most 4. */
	checked: { commit: string; receipts: number; comparison: EndoStateComparisonV0 }[];
	/** Other attempts with an observation in the same working tree within this attempt's frame: their work may have overlapped. */
	overlaps: string[];
	/** Facts about what is missing, in a fixed order. */
	notes: EndoProvenanceNoteV0[];
}

export type EndoProvenanceNoteV0 =
	| "authorized-without-before"
	| "no-after-run"
	| "observation-unavailable"
	| "other-send-observations"
	| "frame-elsewhere"
	| "problems";

export const ENDO_PROVENANCE_NOTE_TEXT_V0: Readonly<Record<EndoProvenanceNoteV0, string>> = Object.freeze({
	"authorized-without-before":
		"The attempt was authorised to be sent, but no observation from just before the send is recorded (it failed, or an older build sent it).",
	"no-after-run":
		"No observation was made when the run ended: the run has not ended, or the workbench stopped first. Record one with endo attempt observe.",
	"observation-unavailable": "An observation could not be made: Git could not read the working tree then.",
	"other-send-observations":
		"Some observations name a send other than this attempt's authorisation; they are listed and not used.",
	"frame-elsewhere":
		"The observations were made in a different working tree from the one read now; now is not compared.",
	problems: "Some files in the observations directory are not usable observations.",
});
