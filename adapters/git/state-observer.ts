// A working tree's observed STATE (docs/designs/develop-candidate-provenance.md), read-only: HEAD's commit, and for every path Git reports
// as changed, what the working tree holds there, as a Git blob id and mode. And two such states (or a state and a clean commit) compared
// path by path. Nothing here writes to the repository, stages, or runs a repository program: the revision observer's hardened reads
// (adapters/git/revision-observer.ts) do all of Git's part, and this module reads the changed files itself, as bytes, to hash them.
//
// File contents are hashed and dropped: only the blob id is returned. A file that changes while it is read is "not read (changing)", never
// half-hashed. What it returns is a transient observation; the caller decides what to record.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import {
	ENDO_DEVELOP_OBSERVATION_LIMITS_V0,
	type EndoComparableStateV0,
	type EndoObservationResultV0,
	type EndoObservedChangeV0,
	type EndoObservedStateV0,
	endoObservedPathOkV0,
	endoObservedStateCompleteV0,
	endoObservedStateDigestTextV0,
} from "../../protocol/develop-observations.ts";
import type {
	EndoFileModeV0,
	EndoNotComparedV0,
	EndoNotReadV0,
	EndoObservedAreaV0,
	EndoObservedContentV0,
	EndoPathChangeV0,
	EndoStateComparisonV0,
} from "../../protocol/develop-provenance.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { GitRevisionObserverV0, GitTreeEntryV0 } from "./revision-observer.ts";

/** What of the observer this module needs (the real one, or a test's). */
export type GitStateReaderV0 = Pick<GitRevisionObserverV0, "observe" | "treeEntries" | "changedPaths">;

const AREA_ORDER: readonly EndoObservedAreaV0[] = ["conflicted", "staged", "unstaged", "untracked"];

/** The Git blob id of these bytes in a repository whose object ids are `length` hex characters long. */
export function gitBlobIdV0(bytes: Buffer, length: 40 | 64): string {
	return createHash(length === 40 ? "sha1" : "sha256")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}

/** The bytes an observation's changes may take in its file, and the most one change's fields other than its path take (a sha256 id). */
const RECORD_BUDGET = ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxFileRecordBytes - 64 * 1024;
const PER_CHANGE = 256;

interface Budget {
	left: number;
}

/**
 * The parent directories of `path` under `root`, each as `lstat` sees it: their identities when every one is a real directory, "absent"
 * when one is missing, a link or not a directory (Git does not follow a link to a directory: nothing under it is in the working tree), or
 * null when one cannot be read.
 */
async function parentsOf(root: string, path: string): Promise<string | "absent" | null> {
	const parts = path.split("/").slice(0, -1);
	const ids: string[] = [];
	for (let i = 1; i <= parts.length; i += 1) {
		try {
			const s = await lstat(join(root, ...parts.slice(0, i)), { bigint: false });
			if (s.isSymbolicLink() || !s.isDirectory()) return "absent";
			ids.push(`${s.dev}:${s.ino}`);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT" || code === "ENOTDIR" ? "absent" : null;
		}
	}
	return ids.join("/");
}

/**
 * What the working tree holds at `path` (under `root`), as Git would store it, or why it was not read. Never follows a link: not the last
 * component (O_NOFOLLOW, lstat) and not a parent directory (each is lstat'ed before and after the read, and must be the same directory).
 */
async function contentAt(root: string, path: string, length: 40 | 64, budget: Budget): Promise<EndoObservedContentV0> {
	const notRead = (why: EndoNotReadV0): EndoObservedContentV0 => ({ kind: "not-read", why });
	const parents = await parentsOf(root, path);
	if (parents === "absent") return { kind: "absent" };
	if (parents === null) return notRead("unreadable");
	const read = await contentBelow(root, path, length, budget);
	// A parent swapped for a link (or another directory) while the file was read: what was read may not be this path's.
	if (read.kind !== "absent" && (await parentsOf(root, path)) !== parents) return notRead("changing");
	return read;
}

async function contentBelow(
	root: string,
	path: string,
	length: 40 | 64,
	budget: Budget,
): Promise<EndoObservedContentV0> {
	const full = join(root, path);
	const notRead = (why: EndoNotReadV0): EndoObservedContentV0 => ({ kind: "not-read", why });
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(full, { bigint: false });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : notRead("unreadable");
	}
	if (before.isSymbolicLink()) {
		try {
			const target = await readlink(full, { encoding: "buffer" });
			return { kind: "file", mode: "120000", oid: gitBlobIdV0(target, length) };
		} catch {
			return notRead("unreadable");
		}
	}
	if (!before.isFile()) return notRead("not-a-file");
	if (before.size > ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxFileBytes) return notRead("too-large");
	if (before.size > budget.left) return notRead("budget");
	budget.left -= before.size;
	const mode: EndoFileModeV0 = (before.mode & 0o100) !== 0 ? "100755" : "100644";
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.ino !== before.ino ||
			opened.size !== before.size ||
			opened.mtimeMs !== before.mtimeMs
		)
			return notRead("changing");
		const bytes = Buffer.alloc(before.size);
		let at = 0;
		while (at < bytes.length) {
			const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
			if (bytesRead === 0) return notRead("changing");
			at += bytesRead;
		}
		const after = await handle.stat();
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== opened.ctimeMs)
			return notRead("changing");
		return { kind: "file", mode, oid: gitBlobIdV0(bytes, length) };
	} catch {
		return notRead("unreadable");
	} finally {
		await handle?.close().catch(() => {});
	}
}

/**
 * Observe the state of the working tree whose top is `directory` (`within`: anywhere inside one). Unavailable for the revision observer's
 * reasons. A path Git printed that cannot be held as a relative path, or past the bound, makes the state `truncated` (so incomplete).
 */
export async function observeEndoStateV0(
	observer: GitStateReaderV0,
	directory: string,
	options: { within?: boolean } = {},
): Promise<EndoObservationResultV0> {
	const seen = await observer.observe(directory, { ...options, changes: true });
	if (!seen.ok) return { state: "unavailable", reason: seen.reason };
	const o = seen.observation;
	const length = o.commit.length === 40 ? 40 : 64;
	const byPath = new Map<string, { areas: Set<EndoObservedAreaV0>; exact: boolean }>();
	let truncated = o.changes?.truncated ?? true;
	for (const change of o.changes?.list ?? []) {
		const path = change.path.endsWith("/") ? change.path.slice(0, -1) : change.path;
		if (!endoObservedPathOkV0(path)) {
			truncated = true;
			continue;
		}
		const entry = byPath.get(path) ?? { areas: new Set(), exact: true };
		entry.areas.add(change.area);
		entry.exact &&= change.pathExact;
		byPath.set(path, entry);
	}
	const paths = [...byPath.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	if (paths.length > ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxChanges) {
		truncated = true;
		paths.length = ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxChanges;
	}
	// The record must fit its file: each change costs its path as JSON plus at most PER_CHANGE bytes of fixed fields. Past the budget the
	// state is truncated (incomplete, recorded and shown) rather than an observation that could not be written at all.
	let recordBytes = 0;
	for (let i = 0; i < paths.length; i += 1) {
		recordBytes += Buffer.byteLength(JSON.stringify(paths[i])) + PER_CHANGE;
		if (recordBytes > RECORD_BUDGET) {
			truncated = true;
			paths.length = i;
			break;
		}
	}
	const budget: Budget = { left: ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxReadBytes };
	const changes: EndoObservedChangeV0[] = [];
	for (const path of paths) {
		const entry = byPath.get(path) as { areas: Set<EndoObservedAreaV0>; exact: boolean };
		changes.push({
			path,
			areas: AREA_ORDER.filter((a) => entry.areas.has(a)),
			content: entry.exact
				? await contentAt(o.worktree, path, length, budget)
				: { kind: "not-read", why: "path-not-exact" },
		});
	}
	const flaggedEntries = o.dirty.includes("flagged-entries");
	const submodule = o.dirty.includes("submodule");
	const base = {
		state: "observed" as const,
		repository: { worktree: o.worktree, commonDir: o.commonDir, linked: o.linked },
		revision: { commit: o.commit, tree: o.tree, branch: o.branch },
		flaggedEntries,
		submodule,
		changes,
		truncated,
	};
	const complete = endoObservedStateCompleteV0(base);
	return { ...base, complete, digest: sha256HexV0(endoObservedStateDigestTextV0(base)) } satisfies EndoObservedStateV0;
}

/** Paths compared at most; past it, `too-many-paths`. */
const MAX_COMPARED = 5000;
/** Differing paths returned at most (the total is always given). */
const MAX_LISTED = 200;

type Side = { kind: "file"; mode: string; oid: string } | { kind: "other"; oid: string | null } | { kind: "absent" };

function sideOf(content: EndoObservedContentV0 | undefined, tree: GitTreeEntryV0 | undefined): Side {
	if (content !== undefined) {
		if (content.kind === "file") return { kind: "file", mode: content.mode, oid: content.oid };
		if (content.kind === "absent") return { kind: "absent" };
		return { kind: "other", oid: null };
	}
	if (tree === undefined || tree.kind === "absent") return { kind: "absent" };
	if (tree.kind === "file") return { kind: "file", mode: tree.mode, oid: tree.oid };
	return { kind: "other", oid: null };
}

function changeOf(a: Side, b: Side): EndoPathChangeV0 | null {
	if (a.kind === "absent" && b.kind === "absent") return null;
	if (a.kind === "absent") return "added";
	if (b.kind === "absent") return "deleted";
	if (a.kind === "file" && b.kind === "file") {
		if (a.oid !== b.oid) return "modified";
		return a.mode === b.mode ? null : "mode";
	}
	// A directory or submodule on either side: its contents are not compared here, so it is never called the same.
	return "modified";
}

/**
 * Compare two states path by path, from `a` to `b` (`added`: in `b`, not in `a`). Reads only objects (the two commits' trees); the
 * working tree is not read again. Both must be complete and of one repository; otherwise nothing is claimed.
 */
export async function compareEndoStatesV0(
	observer: GitStateReaderV0,
	worktree: string,
	a: EndoComparableStateV0,
	b: EndoComparableStateV0,
): Promise<EndoStateComparisonV0> {
	const not = (reason: EndoNotComparedV0): EndoStateComparisonV0 => ({ relation: "not-compared", reason });
	if (a.commonDir !== b.commonDir) return not("other-repository");
	if (!a.complete || !b.complete) return not("incomplete");
	const committed = await observer.changedPaths(worktree, a.commit, b.commit);
	if (committed === null) return not("commit-unavailable");
	if (committed.notText === true) return not("path-not-text");
	if (committed.cut) return not("too-many-paths");
	const overlayA = new Map(a.changes.map((c) => [c.path, c.content]));
	const overlayB = new Map(b.changes.map((c) => [c.path, c.content]));
	const union = new Set<string>([...committed.paths, ...overlayA.keys(), ...overlayB.keys()]);
	if (union.size > MAX_COMPARED) return not("too-many-paths");
	const paths = [...union].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
	const needA = paths.filter((p) => !overlayA.has(p));
	const needB = paths.filter((p) => !overlayB.has(p));
	const treeA = needA.length === 0 ? new Map() : await observer.treeEntries(worktree, a.commit, needA);
	const treeB =
		needB.length === 0
			? new Map()
			: a.commit === b.commit && treeA !== null && treeA !== "not-text" && needB.every((p) => treeA.has(p))
				? treeA
				: await observer.treeEntries(worktree, b.commit, needB);
	if (treeA === "not-text" || treeB === "not-text") return not("path-not-text");
	if (treeA === null || treeB === null) return not("commit-unavailable");
	const differing: { path: string; change: EndoPathChangeV0 }[] = [];
	for (const path of paths) {
		const change = changeOf(sideOf(overlayA.get(path), treeA.get(path)), sideOf(overlayB.get(path), treeB.get(path)));
		if (change !== null) differing.push({ path, change });
	}
	if (differing.length === 0) return { relation: "same" };
	return { relation: "different", paths: differing.slice(0, MAX_LISTED), total: differing.length };
}

/** The reader the observations service is given (runtime/contracts/develop-observations.ts): this module over one revision observer. */
export function gitStateReaderV0(observer: GitRevisionObserverV0) {
	return {
		observeState: (directory: string, options: { within?: boolean } = {}) =>
			observeEndoStateV0(observer, directory, options),
		compare: (worktree: string, a: EndoComparableStateV0, b: EndoComparableStateV0) =>
			compareEndoStatesV0(observer, worktree, a, b),
		ancestry: (worktree: string, from: string, to: string) => observer.ancestry(worktree, from, to),
	};
}
