// DEVELOP attempt observations (docs/designs/develop-candidate-provenance.md): what Git showed of a working tree at one moment around a
// work attempt, recorded once and never rewritten (storage/develop-observations.ts).
//
//   authorised          the operator approved sending the brief            <attempt>.authorized.json
//   observed (before)   the tree, just before the brief was sent           an observation, point "before-send" (this module)
//   observed (after)    the tree, when the run that followed had ended     an observation, point "after-run"
//   observed (operator) the tree, when the operator asked                  an observation, point "operator"
//   changed between     the paths whose content differs between two        computed when read, never stored
//   checked             a receipt's commit                                 <receipt>.json
//   accepted            the operator's decision                            the task's status
//
// An observation is NOT authorship. It says what Git reported, at that moment, about a tree anyone could write: an editor, a hook, another
// agent, the operator. Two observations that read the same say nothing about what happened between them. The words below say so.
//
// What a state is: HEAD's commit, plus, for every path Git reports as staged, unstaged, untracked or conflicted, what the working tree held
// at that path (its Git blob id and mode, or nothing). Ignored files are not part of it. File CONTENTS are never stored: only blob ids,
// which can be compared with a commit's tree without keeping a copy.

import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import {
	ENDO_OBSERVATION_UNAVAILABLE_V0,
	type EndoFileModeV0,
	type EndoNotReadV0,
	type EndoObservationPointV0,
	type EndoObservationTriggerV0,
	type EndoObservationUnavailableV0,
	type EndoObservedAreaV0,
	type EndoObservedContentV0,
} from "./develop-provenance.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isEndoIdentifierV0 } from "./identity.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_DEVELOP_OBSERVATION_SCHEMA_V0 = "endo.develop-observation.v0";
export const ENDO_OBSERVATION_ID_PATTERN_V0 = /^endo\.observation\.[0-9a-f]{32}$/;

export const ENDO_DEVELOP_OBSERVATION_LIMITS_V0 = Object.freeze({
	/** Observations kept for one attempt (a bound on growth, checked before writing; not a security boundary). */
	maxPerAttempt: 50,
	/** Changed paths recorded in one observation. Past it the observation is incomplete and states are not compared. */
	maxChanges: 1000,
	/** A file larger than this is not read: its content is "not read". */
	maxFileBytes: 16 * 1024 * 1024,
	/** All files read for one observation together. Past it the rest are "not read". */
	maxReadBytes: 256 * 1024 * 1024,
	maxPathChars: 4096,
	/** One observation file. */
	maxFileRecordBytes: 512 * 1024,
});

const AREAS: readonly EndoObservedAreaV0[] = ["conflicted", "staged", "unstaged", "untracked"];

const NOT_READ: readonly EndoNotReadV0[] = [
	"too-large",
	"budget",
	"unreadable",
	"changing",
	"not-a-file",
	"path-not-exact",
];

const MODES: readonly EndoFileModeV0[] = ["100644", "100755", "120000"];

export interface EndoObservedChangeV0 {
	path: string;
	/** Where Git listed it (a path can be staged and unstaged at once), in a fixed order. */
	areas: EndoObservedAreaV0[];
	content: EndoObservedContentV0;
}

export interface EndoObservedStateV0 {
	state: "observed";
	repository: { worktree: string; commonDir: string; linked: boolean };
	revision: { commit: string; tree: string; branch: string | null };
	/** Index entries Git leaves out of the status (assume-unchanged, skip-worktree), and submodules: the state may hide changes there. */
	flaggedEntries: boolean;
	submodule: boolean;
	/** Sorted by path, unique. */
	changes: EndoObservedChangeV0[];
	/** Git listed more changes than are recorded. */
	truncated: boolean;
	/**
	 * Every change was recorded and read, and nothing in the index was hidden: only then can this state be compared path by path. Derived
	 * (the validator recomputes it).
	 */
	complete: boolean;
	/** sha256 over the commit and every change's path and content: equal digests, equal observed states. Derived. */
	digest: string;
}

export type EndoObservationResultV0 =
	| EndoObservedStateV0
	| { state: "unavailable"; reason: EndoObservationUnavailableV0 };

/** `<root>/develop/observations/<attemptId>/<id>.json`: immutable. */
export interface EndoDevelopObservationV0 {
	schemaVersion: typeof ENDO_DEVELOP_OBSERVATION_SCHEMA_V0;
	id: string;
	attemptId: string;
	projectId: string;
	point: EndoObservationPointV0;
	trigger: EndoObservationTriggerV0;
	recordedBy: "workbench" | "cli";
	/** For the workbench's points: the send this observation was made for (the attempt's authorisation names the same). Null otherwise. */
	binding: { proposalId: string; authorizationEventId: string } | null;
	observer: { tool: "endo"; version: string };
	startedAtMs: number;
	endedAtMs: number;
	result: EndoObservationResultV0;
}

// ---- derived facts ------------------------------------------------------------------------------------------------------------------

/** Whether the state can be compared path by path. */
export function endoObservedStateCompleteV0(
	s: Pick<EndoObservedStateV0, "changes" | "truncated" | "flaggedEntries" | "submodule">,
): boolean {
	return !s.truncated && !s.flaggedEntries && !s.submodule && s.changes.every((c) => c.content.kind !== "not-read");
}

/**
 * The text a state's digest is the SHA-256 of: the commit, and each change's path and content (areas are where Git listed it, not what
 * the tree held). Hashing is the caller's (protocol/ imports nothing outside it): `sha256HexV0(endoObservedStateDigestTextV0(s))`.
 */
export function endoObservedStateDigestTextV0(s: Pick<EndoObservedStateV0, "revision" | "changes">): string {
	const lines = [`commit ${s.revision.commit}\n`];
	for (const c of s.changes) {
		const content =
			c.content.kind === "file"
				? `${c.content.mode} ${c.content.oid}`
				: c.content.kind === "absent"
					? "absent"
					: `not-read ${c.content.why}`;
		lines.push(`${JSON.stringify(c.path)} ${content}\n`);
	}
	return lines.join("");
}

// ---- comparing two states ---------------------------------------------------------------------------------------------------------

/** A state to compare: an observed one, or a clean commit (a receipt's, which was observed clean and committed). */
export interface EndoComparableStateV0 {
	commonDir: string;
	commit: string;
	changes: readonly EndoObservedChangeV0[];
	complete: boolean;
}

export const endoComparableOfV0 = (s: EndoObservedStateV0): EndoComparableStateV0 => ({
	commonDir: s.repository.commonDir,
	commit: s.revision.commit,
	changes: s.changes,
	complete: s.complete,
});

// ---- validation ---------------------------------------------------------------------------------------------------------------------

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const closed = (v: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
};
const stamp = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? v : bad(`${what} is not a time`);
const matching = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);
const flag = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : bad(`${what} is not a boolean`));
const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not known`);
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROPOSAL_ID = /^endo\.evidence\.workbench-prompt-[0-9a-f]{32}$/;

function absolutePath(v: unknown, what: string): string {
	if (
		typeof v !== "string" ||
		!v.startsWith("/") ||
		v.length > ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxPathChars ||
		v.includes("\0") ||
		!v.isWellFormed()
	)
		return bad(`${what} is not an absolute path`);
	return v;
}

/** A path relative to the top of the tree, as Git prints it: no leading slash, no empty, `.` or `..` part. */
export function endoObservedPathOkV0(v: unknown): v is string {
	return (
		typeof v === "string" &&
		v !== "" &&
		v.length <= ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxPathChars &&
		!v.includes("\0") &&
		v.isWellFormed() &&
		!v.startsWith("/") &&
		!v.split("/").some((part) => part === "" || part === "." || part === "..")
	);
}

function content(v: unknown, oidPattern: RegExp): EndoObservedContentV0 {
	if (typeof v !== "object" || v === null) return bad("content is not an object");
	const kind = oneOf((v as Record<string, unknown>).kind, ["file", "absent", "not-read"] as const, "content.kind");
	if (kind === "file") {
		const r = closed(v, ["kind", "mode", "oid"], "content");
		return { kind, mode: oneOf(r.mode, MODES, "content.mode"), oid: matching(r.oid, oidPattern, "content.oid") };
	}
	if (kind === "not-read") {
		const r = closed(v, ["kind", "why"], "content");
		return { kind, why: oneOf(r.why, NOT_READ, "content.why") };
	}
	closed(v, ["kind"], "content");
	return { kind };
}

function result(v: unknown, sha256: (text: string) => string): EndoObservationResultV0 {
	if (typeof v !== "object" || v === null) return bad("result is not an object");
	const state = oneOf((v as Record<string, unknown>).state, ["observed", "unavailable"] as const, "result.state");
	if (state === "unavailable") {
		const r = closed(v, ["state", "reason"], "result");
		return { state, reason: oneOf(r.reason, ENDO_OBSERVATION_UNAVAILABLE_V0, "result.reason") };
	}
	const r = closed(
		v,
		["state", "repository", "revision", "flaggedEntries", "submodule", "changes", "truncated", "complete", "digest"],
		"result",
	);
	const repository = closed(r.repository, ["worktree", "commonDir", "linked"], "result.repository");
	const revision = closed(r.revision, ["commit", "tree", "branch"], "result.revision");
	const commit = matching(revision.commit, OBJECT_ID, "result.revision.commit");
	// Blob ids are of the repository's object format: as long as its commit ids.
	const oidPattern = commit.length === 40 ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
	if (!Array.isArray(r.changes) || r.changes.length > ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxChanges)
		return bad("result.changes is not a bounded list");
	const changes = r.changes.map((c): EndoObservedChangeV0 => {
		const e = closed(c, ["path", "areas", "content"], "change");
		if (!endoObservedPathOkV0(e.path)) return bad("change.path is not a relative path");
		if (!Array.isArray(e.areas) || e.areas.length === 0) return bad("change.areas is empty");
		const areas = e.areas.map((a) => oneOf(a, AREAS, "change.areas"));
		const ordered = AREAS.filter((a) => areas.includes(a));
		if (ordered.length !== areas.length || ordered.some((a, i) => a !== areas[i]))
			return bad("change.areas is not in order or repeats");
		return { path: e.path, areas: ordered, content: content(e.content, oidPattern) };
	});
	for (let i = 1; i < changes.length; i++)
		if (!((changes[i - 1] as EndoObservedChangeV0).path < (changes[i] as EndoObservedChangeV0).path))
			return bad("result.changes is not sorted and unique");
	const branch =
		revision.branch === null
			? null
			: typeof revision.branch === "string" &&
					revision.branch.startsWith("refs/") &&
					revision.branch.length <= 1024 &&
					revision.branch.isWellFormed() &&
					!/[\u0000-\u001f\u007f]/.test(revision.branch)
				? revision.branch
				: bad("result.revision.branch is not a ref name");
	const observed: EndoObservedStateV0 = {
		state,
		repository: {
			worktree: absolutePath(repository.worktree, "result.repository.worktree"),
			commonDir: absolutePath(repository.commonDir, "result.repository.commonDir"),
			linked: flag(repository.linked, "result.repository.linked"),
		},
		revision: { commit, tree: matching(revision.tree, OBJECT_ID, "result.revision.tree"), branch },
		flaggedEntries: flag(r.flaggedEntries, "result.flaggedEntries"),
		submodule: flag(r.submodule, "result.submodule"),
		changes,
		truncated: flag(r.truncated, "result.truncated"),
		complete: flag(r.complete, "result.complete"),
		digest: matching(r.digest, SHA256, "result.digest"),
	};
	if (observed.complete !== endoObservedStateCompleteV0(observed))
		return bad("result.complete does not follow from the state");
	if (observed.digest !== sha256(endoObservedStateDigestTextV0(observed)))
		return bad("result.digest does not follow from the state");
	return observed;
}

const SHAPES: Readonly<
	Record<
		EndoObservationPointV0,
		{ triggers: readonly EndoObservationTriggerV0[]; by: "workbench" | "cli"; bound: boolean }
	>
> = {
	"before-send": { triggers: ["send-approved"], by: "workbench", bound: true },
	"after-run": { triggers: ["run-settled", "workbench-closing"], by: "workbench", bound: true },
	operator: { triggers: ["operator-command"], by: "cli", bound: false },
};

/**
 * An observation, checked. `sha256` (hex of a UTF-8 string) re-derives the state's digest: callers pass runtime/contracts/canonical-json.ts's
 * `sha256HexV0`.
 */
export function validateEndoDevelopObservationV0(
	value: unknown,
	sha256: (text: string) => string,
): EndoDevelopObservationV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"id",
			"attemptId",
			"projectId",
			"point",
			"trigger",
			"recordedBy",
			"binding",
			"observer",
			"startedAtMs",
			"endedAtMs",
			"result",
		],
		"observation",
	);
	const point = oneOf(r.point, ["before-send", "after-run", "operator"] as const, "point");
	const shape = SHAPES[point];
	const trigger = oneOf(r.trigger, shape.triggers, "trigger");
	const recordedBy = exactly(r.recordedBy, shape.by, "recordedBy");
	let binding: EndoDevelopObservationV0["binding"] = null;
	if (shape.bound) {
		const b = closed(r.binding, ["proposalId", "authorizationEventId"], "binding");
		binding = {
			proposalId: matching(b.proposalId, PROPOSAL_ID, "binding.proposalId"),
			authorizationEventId:
				typeof b.authorizationEventId === "string" && isEndoIdentifierV0(b.authorizationEventId, "event")
					? b.authorizationEventId
					: bad("binding.authorizationEventId is not an event id"),
		};
	} else if (r.binding !== null) return bad("binding is not null");
	const observer = closed(r.observer, ["tool", "version"], "observer");
	const startedAtMs = stamp(r.startedAtMs, "startedAtMs");
	const endedAtMs = stamp(r.endedAtMs, "endedAtMs");
	if (endedAtMs < startedAtMs) return bad("endedAtMs is before startedAtMs");
	return {
		schemaVersion: exactly(r.schemaVersion, ENDO_DEVELOP_OBSERVATION_SCHEMA_V0, "schemaVersion"),
		id: matching(r.id, ENDO_OBSERVATION_ID_PATTERN_V0, "id"),
		attemptId: matching(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		projectId: matching(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		point,
		trigger,
		recordedBy,
		binding,
		observer: {
			tool: exactly(observer.tool, "endo", "observer.tool"),
			version: matching(observer.version, /^[0-9A-Za-z.+-]{1,64}$/, "observer.version"),
		},
		startedAtMs,
		endedAtMs,
		result: result(r.result, sha256),
	};
}

function exactly<T extends string>(v: unknown, value: T, what: string): T {
	return v === value ? value : bad(`${what} is not ${value}`);
}
