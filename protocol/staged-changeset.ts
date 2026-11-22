// Boundary-agnostic staged change sets (Phase 1 building block): comparing a terminated candidate workspace against a captured baseline
// manifest, staging only changed plain regular files read-only on the host, and sealing the result with a canonical digest.
//
// Language-neutral: shapes, closed refusal vocabulary, structural consistency rules, and version-directed readers. Filesystem I/O and
// SHA-256 computation live in `adapters/sandbox/staged-changeset.ts`.
//
// What a staged change set establishes, and what it NEVER claims:
// - It records the observed file-level difference between a baseline manifest and a candidate tree at the time of collection.
// - It does NOT establish that an agent's execution boundary held or that its processes terminated before collection; the caller must
//   confirm termination first.
// - It does NOT attribute authorship to any agent or user, grant permission to apply changes to a host checkout, or certify correctness.
// - Staged files are stored non-executable (`0o444`) on the host; executability is recorded as metadata (`executable: boolean`) only.

import { isPlainJsonObjectV0 } from "./primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	type EndoVersionedReadV0,
	endoFirstUnknownKeyV0,
	readEndoVersionedV0,
} from "./versioned.ts";

export const ENDO_WORKSPACE_BASELINE_V0 = "endo.workspace-baseline.v0";
export const ENDO_STAGED_CHANGESET_V0 = "endo.staged-changeset.v0";

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Reject control chars, bidi controls, Unicode line breaks, replacement chars, ellipsis, and backslashes in paths. */
const PATH_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\ufffd\\]/;

export const ENDO_CHANGESET_PATH_MAX_CHARS_V0 = 240;
export const ENDO_CHANGESET_SEGMENT_MAX_CHARS_V0 = 128;

export interface EndoChangeSetLimitsV0 {
	/** Maximum size of any single inspected or staged file, in bytes. */
	maxFileBytes: number;
	/** Maximum cumulative size of all staged (added/modified/mode-changed) files, in bytes. */
	maxTotalStagedBytes: number;
	/** Maximum cumulative size of all files read while walking a workspace, in bytes. */
	maxWorkspaceBytes: number;
	/** Maximum number of filesystem entries (files + directories) walked in a single tree scan. */
	maxWalkedEntries: number;
	/** Maximum number of changed entries (added + modified + mode + deleted) admitted into one change set. */
	maxChangedFiles: number;
	/** Maximum directory nesting depth below the workspace root (root is depth 0). */
	maxDepth: number;
}

export const DEFAULT_ENDO_CHANGESET_LIMITS_V0: Readonly<EndoChangeSetLimitsV0> = Object.freeze({
	maxFileBytes: 4 * 1024 * 1024,
	maxTotalStagedBytes: 16 * 1024 * 1024,
	maxWorkspaceBytes: 64 * 1024 * 1024,
	maxWalkedEntries: 8192,
	maxChangedFiles: 512,
	maxDepth: 32,
});

export interface EndoChangeSetFileStateV0 {
	bytes: number;
	sha256: string;
	/** Owner execute bit (`mode & 0o100`). Recorded as metadata only; staged files on the host are never executable. */
	executable: boolean;
}

export interface EndoWorkspaceBaselineEntryV0 extends EndoChangeSetFileStateV0 {
	path: string;
}

export interface EndoWorkspaceBaselineV0 {
	schemaVersion: typeof ENDO_WORKSPACE_BASELINE_V0;
	/** Whether top-level `.git` was skipped when capturing this baseline. Nested `.git` is always refused. */
	rootGitExcluded: boolean;
	/** Sorted, unique plain relative paths of every regular file in the baseline tree. */
	files: EndoWorkspaceBaselineEntryV0[];
	totalBytes: number;
	/** SHA-256 over the canonical JSON of `{ rootGitExcluded, files }`. */
	sha256: string;
}

/**
 * How a path differs between the baseline and candidate trees (aligned with `protocol/develop-provenance.ts`):
 * - `added`: absent in baseline, present in candidate; staged under `files/<path>`.
 * - `modified`: present in both with different content (`before.sha256 !== after.sha256`); staged under `files/<path>`.
 * - `mode`: present in both with identical bytes (`before.sha256 === after.sha256`) and different `executable`; staged under `files/<path>`.
 * - `deleted`: present in baseline, absent in candidate; no staged file under `files/`.
 */
export type EndoStagedChangeKindV0 = "added" | "modified" | "mode" | "deleted";

export type EndoStagedChangeV0 =
	| { path: string; kind: "added"; before: null; after: EndoChangeSetFileStateV0 }
	| { path: string; kind: "modified"; before: EndoChangeSetFileStateV0; after: EndoChangeSetFileStateV0 }
	| { path: string; kind: "mode"; before: EndoChangeSetFileStateV0; after: EndoChangeSetFileStateV0 }
	| { path: string; kind: "deleted"; before: EndoChangeSetFileStateV0; after: null };

export const ENDO_CHANGESET_REFUSAL_REASONS_V0 = [
	"unsafe-path",
	"git-metadata",
	"symbolic-link",
	"hard-link",
	"not-a-regular-file",
	"separate-mount",
	"too-large",
	"total-too-large",
	"too-many-files",
	"too-deep",
	"changed-during-collection",
	"unreadable",
] as const;

export type EndoChangeSetRefusalReasonV0 = (typeof ENDO_CHANGESET_REFUSAL_REASONS_V0)[number];

export interface EndoChangeSetRefusalV0 {
	/** Relative path inside the workspace (or `.` for the workspace root itself). */
	path: string;
	reason: EndoChangeSetRefusalReasonV0;
}

export interface EndoStagedChangeSetSummaryV0 {
	baselineFiles: number;
	candidateFiles: number;
	unchangedFiles: number;
	addedFiles: number;
	modifiedFiles: number;
	modeChangedFiles: number;
	deletedFiles: number;
	/** Total bytes written under `<staging>/files/` (added + modified + mode-changed files). */
	stagedBytes: number;
}

export interface EndoStagedChangeSetManifestV0 {
	schemaVersion: typeof ENDO_STAGED_CHANGESET_V0;
	baselineSha256: string;
	baselineRootGitExcluded: boolean;
	changes: EndoStagedChangeV0[];
	summary: EndoStagedChangeSetSummaryV0;
	/** SHA-256 over the canonical JSON of `{ baselineSha256, baselineRootGitExcluded, changes, summary }`. */
	changesetSha256: string;
}

export type EndoStagedChangeSetCollectionV0 =
	| {
			status: "collected";
			manifest: EndoStagedChangeSetManifestV0;
			stagingDir: string;
			refusals: [];
	  }
	| {
			status: "refused";
			manifest: null;
			stagingDir: null;
			refusals: EndoChangeSetRefusalV0[];
	  };

/** Check whether a single directory entry name is safe (not `.` / `..`, bounded, no control/bidi/slash/backslash/replacement chars). */
export function isSafeChangeSetSegmentV0(segment: string): boolean {
	if (
		typeof segment !== "string" ||
		segment.length === 0 ||
		segment.length > ENDO_CHANGESET_SEGMENT_MAX_CHARS_V0 ||
		!segment.isWellFormed()
	)
		return false;
	if (segment === "." || segment === ".." || segment.includes("/")) return false;
	if (PATH_UNSAFE.test(segment)) return false;
	return true;
}

/** Check whether a relative path is a plain, canonical, non-`.git` path suitable for baselines and staged change sets. */
export function isPlainChangeSetPathV0(path: string): boolean {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > ENDO_CHANGESET_PATH_MAX_CHARS_V0 ||
		!path.isWellFormed()
	)
		return false;
	if (path.startsWith("/") || path.endsWith("/")) return false;
	const segments = path.split("/");
	for (const segment of segments) {
		if (!isSafeChangeSetSegmentV0(segment)) return false;
		if (segment === ".git") return false;
	}
	return true;
}

/** Pure canonical projection digested as `EndoWorkspaceBaselineV0.sha256`. */
export function endoBaselineDigestInputV0(
	rootGitExcluded: boolean,
	files: readonly EndoWorkspaceBaselineEntryV0[],
): { rootGitExcluded: boolean; files: { path: string; bytes: number; sha256: string; executable: boolean }[] } {
	return {
		rootGitExcluded,
		files: files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, executable: f.executable })),
	};
}

/** Pure canonical projection digested as `EndoStagedChangeSetManifestV0.changesetSha256`. */
export function endoChangeSetDigestInputV0(
	baselineSha256: string,
	baselineRootGitExcluded: boolean,
	changes: readonly EndoStagedChangeV0[],
	summary: EndoStagedChangeSetSummaryV0,
): {
	baselineSha256: string;
	baselineRootGitExcluded: boolean;
	changes: EndoStagedChangeV0[];
	summary: EndoStagedChangeSetSummaryV0;
} {
	return {
		baselineSha256,
		baselineRootGitExcluded,
		changes: changes.map((c) => {
			if (c.kind === "added")
				return {
					path: c.path,
					kind: "added" as const,
					before: null,
					after: { bytes: c.after.bytes, sha256: c.after.sha256, executable: c.after.executable },
				};
			if (c.kind === "deleted")
				return {
					path: c.path,
					kind: "deleted" as const,
					before: { bytes: c.before.bytes, sha256: c.before.sha256, executable: c.before.executable },
					after: null,
				};
			return {
				path: c.path,
				kind: c.kind,
				before: { bytes: c.before.bytes, sha256: c.before.sha256, executable: c.before.executable },
				after: { bytes: c.after.bytes, sha256: c.after.sha256, executable: c.after.executable },
			};
		}),
		summary: {
			baselineFiles: summary.baselineFiles,
			candidateFiles: summary.candidateFiles,
			unchangedFiles: summary.unchangedFiles,
			addedFiles: summary.addedFiles,
			modifiedFiles: summary.modifiedFiles,
			modeChangedFiles: summary.modeChangedFiles,
			deletedFiles: summary.deletedFiles,
			stagedBytes: summary.stagedBytes,
		},
	};
}

// ---- strict closed validators -------------------------------------------------------------------------------------------------------

const bad = (detail: string): never => {
	throw new EndoInvalidRecordV0(detail);
};

function closedObject(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) return bad(`${what} is not a plain object`);
	const obj = value as Record<string, unknown>;
	const unknownKey = endoFirstUnknownKeyV0(obj, keys);
	if (unknownKey !== undefined) return bad(`${what} has unknown field ${String(unknownKey)}`);
	for (const key of keys) if (!Object.hasOwn(obj, key)) return bad(`${what} is missing ${key}`);
	return obj;
}

function nonNegInt(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		return bad(`${what} must be a non-negative safe integer`);
	return value;
}

function sha256String(value: unknown, what: string): string {
	if (typeof value !== "string" || !SHA256_HEX.test(value))
		return bad(`${what} must be a 64-char lowercase hex sha256`);
	return value;
}

function boolValue(value: unknown, what: string): boolean {
	if (typeof value !== "boolean") return bad(`${what} must be a boolean`);
	return value;
}

function checkFileState(value: unknown, what: string): EndoChangeSetFileStateV0 {
	const r = closedObject(value, ["bytes", "sha256", "executable"], what);
	return {
		bytes: nonNegInt(r.bytes, `${what}.bytes`),
		sha256: sha256String(r.sha256, `${what}.sha256`),
		executable: boolValue(r.executable, `${what}.executable`),
	};
}

function checkSortedUniquePaths(paths: readonly string[], what: string): void {
	for (let i = 0; i < paths.length; i++) {
		const path = paths[i]!;
		if (!isPlainChangeSetPathV0(path)) bad(`${what}[${i}] is not a plain path`);
		if (i > 0) {
			const prev = paths[i - 1]!;
			if (prev === path) bad(`${what} contains duplicate path ${path}`);
			if (prev > path) bad(`${what} is not sorted lexicographically`);
		}
	}
}

/**
 * Reject any path that lies beneath another path of the same tree. Every path passed here names a plain regular file in one tree (the
 * baseline, or the before or after side of a change set), and a regular file cannot have descendants. Checks each proper `/`-boundary
 * prefix against a set rather than relying on sort adjacency, because sorting interleaves siblings such as `a-b` between `a` and `a/c`.
 */
function checkNoFileAncestors(paths: readonly string[], what: string): void {
	const files = new Set(paths);
	for (const path of paths) {
		for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
			const ancestor = path.slice(0, slash);
			if (files.has(ancestor)) bad(`${what} contains ${path} beneath regular file ${ancestor}`);
		}
	}
}

export function checkEndoWorkspaceBaselineV0(value: unknown): EndoWorkspaceBaselineV0 {
	const r = closedObject(value, ["schemaVersion", "rootGitExcluded", "files", "totalBytes", "sha256"], "baseline");
	if (r.schemaVersion !== ENDO_WORKSPACE_BASELINE_V0) bad("baseline.schemaVersion mismatch");
	const rootGitExcluded = boolValue(r.rootGitExcluded, "baseline.rootGitExcluded");
	if (!Array.isArray(r.files)) bad("baseline.files must be an array");
	const files: EndoWorkspaceBaselineEntryV0[] = [];
	const paths: string[] = [];
	let sumBytes = 0;
	for (let i = 0; i < (r.files as unknown[]).length; i++) {
		const entry = closedObject(
			(r.files as unknown[])[i],
			["path", "bytes", "sha256", "executable"],
			`baseline.files[${i}]`,
		);
		if (typeof entry.path !== "string") bad(`baseline.files[${i}].path must be a string`);
		const path = entry.path as string;
		const bytes = nonNegInt(entry.bytes, `baseline.files[${i}].bytes`);
		const sha256 = sha256String(entry.sha256, `baseline.files[${i}].sha256`);
		const executable = boolValue(entry.executable, `baseline.files[${i}].executable`);
		paths.push(path);
		sumBytes += bytes;
		files.push({ path, bytes, sha256, executable });
	}
	checkSortedUniquePaths(paths, "baseline.files");
	checkNoFileAncestors(paths, "baseline.files");
	const totalBytes = nonNegInt(r.totalBytes, "baseline.totalBytes");
	if (totalBytes !== sumBytes) bad("baseline.totalBytes does not match sum of file bytes");
	const sha256 = sha256String(r.sha256, "baseline.sha256");
	return { schemaVersion: ENDO_WORKSPACE_BASELINE_V0, rootGitExcluded, files, totalBytes, sha256 };
}

export const ENDO_WORKSPACE_BASELINE_VERSIONS_V0 = defineEndoVersionTableV0<EndoWorkspaceBaselineV0>(
	"endo.workspace-baseline",
	[[ENDO_WORKSPACE_BASELINE_V0, checkEndoWorkspaceBaselineV0]],
);

export function readEndoWorkspaceBaselineV0(value: unknown): EndoVersionedReadV0<EndoWorkspaceBaselineV0> {
	return readEndoVersionedV0(ENDO_WORKSPACE_BASELINE_VERSIONS_V0, value);
}

export function checkEndoStagedChangeSetManifestV0(value: unknown): EndoStagedChangeSetManifestV0 {
	const r = closedObject(
		value,
		["schemaVersion", "baselineSha256", "baselineRootGitExcluded", "changes", "summary", "changesetSha256"],
		"manifest",
	);
	if (r.schemaVersion !== ENDO_STAGED_CHANGESET_V0) bad("manifest.schemaVersion mismatch");
	const baselineSha256 = sha256String(r.baselineSha256, "manifest.baselineSha256");
	const baselineRootGitExcluded = boolValue(r.baselineRootGitExcluded, "manifest.baselineRootGitExcluded");
	if (!Array.isArray(r.changes)) bad("manifest.changes must be an array");

	const changes: EndoStagedChangeV0[] = [];
	const paths: string[] = [];
	const beforePaths: string[] = [];
	const afterPaths: string[] = [];
	let addedFiles = 0;
	let modifiedFiles = 0;
	let modeChangedFiles = 0;
	let deletedFiles = 0;
	let stagedBytes = 0;

	for (let i = 0; i < (r.changes as unknown[]).length; i++) {
		const raw = closedObject(
			(r.changes as unknown[])[i],
			["path", "kind", "before", "after"],
			`manifest.changes[${i}]`,
		);
		if (typeof raw.path !== "string") bad(`manifest.changes[${i}].path must be a string`);
		const path = raw.path as string;
		paths.push(path);
		if (raw.kind === "added") {
			if (raw.before !== null) bad(`manifest.changes[${i}].before must be null for added`);
			const after = checkFileState(raw.after, `manifest.changes[${i}].after`);
			addedFiles++;
			stagedBytes += after.bytes;
			changes.push({ path, kind: "added", before: null, after });
		} else if (raw.kind === "deleted") {
			const before = checkFileState(raw.before, `manifest.changes[${i}].before`);
			if (raw.after !== null) bad(`manifest.changes[${i}].after must be null for deleted`);
			deletedFiles++;
			changes.push({ path, kind: "deleted", before, after: null });
		} else if (raw.kind === "modified") {
			const before = checkFileState(raw.before, `manifest.changes[${i}].before`);
			const after = checkFileState(raw.after, `manifest.changes[${i}].after`);
			if (before.sha256 === after.sha256) bad(`manifest.changes[${i}] has identical sha256 for modified`);
			modifiedFiles++;
			stagedBytes += after.bytes;
			changes.push({ path, kind: "modified", before, after });
		} else if (raw.kind === "mode") {
			const before = checkFileState(raw.before, `manifest.changes[${i}].before`);
			const after = checkFileState(raw.after, `manifest.changes[${i}].after`);
			if (before.sha256 !== after.sha256 || before.bytes !== after.bytes)
				bad(`manifest.changes[${i}] must have identical bytes and sha256 for mode`);
			if (before.executable === after.executable)
				bad(`manifest.changes[${i}] has identical executable bit for mode`);
			modeChangedFiles++;
			stagedBytes += after.bytes;
			changes.push({ path, kind: "mode", before, after });
		} else {
			bad(`manifest.changes[${i}].kind is not a valid change kind`);
		}
		if (raw.kind !== "added") beforePaths.push(path);
		if (raw.kind !== "deleted") afterPaths.push(path);
	}
	checkSortedUniquePaths(paths, "manifest.changes");
	checkNoFileAncestors(beforePaths, "manifest.changes before-state");
	checkNoFileAncestors(afterPaths, "manifest.changes after-state");

	const sumObj = closedObject(
		r.summary,
		[
			"baselineFiles",
			"candidateFiles",
			"unchangedFiles",
			"addedFiles",
			"modifiedFiles",
			"modeChangedFiles",
			"deletedFiles",
			"stagedBytes",
		],
		"manifest.summary",
	);
	const summary: EndoStagedChangeSetSummaryV0 = {
		baselineFiles: nonNegInt(sumObj.baselineFiles, "manifest.summary.baselineFiles"),
		candidateFiles: nonNegInt(sumObj.candidateFiles, "manifest.summary.candidateFiles"),
		unchangedFiles: nonNegInt(sumObj.unchangedFiles, "manifest.summary.unchangedFiles"),
		addedFiles: nonNegInt(sumObj.addedFiles, "manifest.summary.addedFiles"),
		modifiedFiles: nonNegInt(sumObj.modifiedFiles, "manifest.summary.modifiedFiles"),
		modeChangedFiles: nonNegInt(sumObj.modeChangedFiles, "manifest.summary.modeChangedFiles"),
		deletedFiles: nonNegInt(sumObj.deletedFiles, "manifest.summary.deletedFiles"),
		stagedBytes: nonNegInt(sumObj.stagedBytes, "manifest.summary.stagedBytes"),
	};

	if (
		summary.addedFiles !== addedFiles ||
		summary.modifiedFiles !== modifiedFiles ||
		summary.modeChangedFiles !== modeChangedFiles ||
		summary.deletedFiles !== deletedFiles ||
		summary.stagedBytes !== stagedBytes
	)
		bad("manifest.summary counts or stagedBytes contradict manifest.changes");
	if (summary.baselineFiles !== summary.unchangedFiles + modifiedFiles + modeChangedFiles + deletedFiles)
		bad("manifest.summary.baselineFiles contradicts unchanged/modified/mode/deleted counts");
	if (summary.candidateFiles !== summary.unchangedFiles + modifiedFiles + modeChangedFiles + addedFiles)
		bad("manifest.summary.candidateFiles contradicts unchanged/modified/mode/added counts");

	const changesetSha256 = sha256String(r.changesetSha256, "manifest.changesetSha256");
	return {
		schemaVersion: ENDO_STAGED_CHANGESET_V0,
		baselineSha256,
		baselineRootGitExcluded,
		changes,
		summary,
		changesetSha256,
	};
}

export const ENDO_STAGED_CHANGESET_VERSIONS_V0 = defineEndoVersionTableV0<EndoStagedChangeSetManifestV0>(
	"endo.staged-changeset",
	[[ENDO_STAGED_CHANGESET_V0, checkEndoStagedChangeSetManifestV0]],
);

export function readEndoStagedChangeSetManifestV0(value: unknown): EndoVersionedReadV0<EndoStagedChangeSetManifestV0> {
	return readEndoVersionedV0(ENDO_STAGED_CHANGESET_VERSIONS_V0, value);
}
