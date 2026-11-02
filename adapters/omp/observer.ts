// The Oh My Pi saved-session observer: the sessions under ONE directory the operator named, read at the moment of each request.
//
// Scope. The directory is the operator's explicit choice (`endo studio --omp-sessions <dir>`); nothing is discovered outside it and no
// default is assumed (OMP's sessions move with `--session-dir`, profiles and its XDG settings). Under it, only plain directories are
// looked into, three levels in all (the root, OMP's project groups, then a session's artifact directory where subagent sessions live), and only
// plain `*.jsonl` files are read: never a link (it is counted and skipped), never the `.log`, `.md` or `.json` files OMP keeps beside a
// session (they hold command output and subagent results), and never more than the file, count and byte bounds.
//
// Identity. A session's key is the id OMP wrote in its header, namespaced by the source that presents it. Two files carrying one id (counted from the same full reads that build the rows) are
// both left without a key: neither is "the" session. A display alias is made from the id and is never used to find anything. The page
// asks for a session by an opaque selector bound to this server's key, the file's place under the root and the file object itself: a
// file replaced by another (a rewrite through a new file, a copy put in its place) has a new selector, so a page holding the old one is
// told the session is not found rather than shown another file's contents under the old name.
//
// Linking (`resolve`). The `endo task link --source omp-saved` command asks this observer, over the directory the operator named, whether one
// id is established: carried by exactly one readable format-3 file, with every file the directory holds read. Anything less (absent, two
// files, a file not read that might carry it) is refused, never guessed. The answer carries the id, the format and the directory's SCOPE: a
// digest of the resolved directory path (never the path), so the same id seen in two directories is two scopes and is never merged.
//
// What it can NOT say. Whether an OMP process is running, connected or about to write: a saved file is not a process, and no file time
// is read as one. What is shown is the file as it was when it was read.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	ENDO_OMP_LIMITS_V0,
	ENDO_OMP_SELECTOR_PATTERN_V0,
	ENDO_OMP_SESSION_SCHEMA_V0,
	ENDO_OMP_SESSIONS_SCHEMA_V0,
	type EndoOmpObserverV0,
	type EndoOmpSessionRowV0,
	type EndoOmpSessionsV0,
	type EndoOmpSessionV0,
} from "../../protocol/omp-observation.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import {
	OMP_SESSION_FORMAT_V0,
	type OmpJournalV0,
	readOmpFileV0,
	reduceOmpJournalV0,
	unreadOmpJournalV0,
} from "./journal.ts";

const SELECTOR_PURPOSE = "endo.develop-omp-selector.v0";
const SCOPE_PURPOSE = "endo.develop-omp-scope.v1";

/**
 * The scope of a resolved OMP sessions directory: `omp-dir.` and 32 hex characters of SHA-256 over a purpose label and the resolved path.
 * Stable across runs and processes for one directory, different for another. It is a label that keeps two directories apart, not a secret: a
 * path is guessable, so its digest hides nothing from someone who can guess it (the task file is owner-only for that reason).
 */
export function ompScopeOfRootV0(resolvedRoot: string): string {
	return `omp-dir.${createHash("sha256").update(SCOPE_PURPOSE).update("\u0000").update(resolvedRoot).digest("hex").slice(0, 32)}`;
}

/**
 * What `resolve` established about one id in the named directory.
 * - `established`: exactly one readable file carries it, and every file under the directory was read.
 * - `not-found`: no readable file carries it (`unread` files could not be read, and one of them might).
 * - `duplicate`: more than one readable file carries it: neither is "the" session.
 * - `uncertain`: one readable file carries it, but `unread` files were not read, so it cannot be established that no other one does.
 */
export type OmpResolutionV0 =
	| { status: "established"; sessionId: string; scope: string; format: typeof OMP_SESSION_FORMAT_V0 }
	| { status: "not-found"; unread: number }
	| { status: "duplicate"; files: number }
	| { status: "uncertain"; unread: number };

export interface OmpObserverOptionsV0 {
	/** The directory the operator named. Resolved once; it must be an existing directory. */
	root: string;
	/** The server's digest key: selectors are made under it, so they mean nothing to another server. */
	key: EndoDigestKeyV0;
	now?: () => Date;
}

interface Found {
	path: string;
	relative: string;
	dev: bigint;
	ino: bigint;
	size: bigint;
	selector: string;
}

/** The directory the operator named, resolved, or a TypeError saying why it cannot be used. */
export function resolveOmpRootV0(given: string): string {
	let root: string;
	try {
		root = realpathSync(given);
	} catch {
		throw new TypeError("--omp-sessions must name an existing directory");
	}
	if (!lstatSync(root).isDirectory()) throw new TypeError("--omp-sessions must name an existing directory");
	return root;
}

export class OmpSavedSessionObserverV0 implements EndoOmpObserverV0 {
	readonly #root: string;
	readonly #key: EndoDigestKeyV0;
	readonly #now: () => Date;

	constructor(options: OmpObserverOptionsV0) {
		this.#root = resolveOmpRootV0(options.root);
		this.#key = options.key;
		this.#now = options.now ?? (() => new Date());
	}

	/** The plain `*.jsonl` files under the root, in a stable order, within the bounds. Nothing is opened here. */
	/** `beyond`: entries not looked into at all (a directory past the depth bound, a link there); counted for `resolve` only. */
	#discover(): { found: Found[]; skipped: EndoOmpSessionsV0["skipped"]; beyond: number } {
		const skipped = { links: 0, notRegular: 0, overLimit: 0, notRead: 0, unreadable: 0 };
		let beyond = 0;
		const found: Found[] = [];
		const visit = (dir: string, depth: number): void => {
			let names: string[];
			try {
				// Every directory walked must still be itself: the paths are built from the resolved root, so a directory that was swapped
				// for a link after it was looked at resolves elsewhere and is not entered. (A check, not an atomic guarantee: see the docs.)
				if (realpathSync(dir) !== dir) {
					skipped.links += 1;
					return;
				}
				names = readdirSync(dir).sort();
			} catch {
				skipped.unreadable += 1;
				return;
			}
			for (const name of names) {
				const path = join(dir, name);
				let info: ReturnType<typeof lstatSync> & { birthtimeNs?: bigint };
				try {
					const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
					if (stat === undefined) continue;
					info = stat;
				} catch {
					skipped.unreadable += 1;
					continue;
				}
				if (info.isSymbolicLink()) {
					if (name.endsWith(".jsonl") || depth < ENDO_OMP_LIMITS_V0.maxDepth) skipped.links += 1;
					else beyond += 1;
					continue;
				}
				if (info.isDirectory()) {
					if (depth < ENDO_OMP_LIMITS_V0.maxDepth) visit(path, depth + 1);
					else beyond += 1;
					continue;
				}
				if (!name.endsWith(".jsonl")) continue;
				if (!info.isFile()) {
					skipped.notRegular += 1;
					continue;
				}
				if (found.length >= ENDO_OMP_LIMITS_V0.maxFiles) {
					skipped.overLimit += 1;
					continue;
				}
				const rel = relative(this.#root, path);
				const stat = info as unknown as { dev: bigint; ino: bigint; size: bigint; birthtimeNs: bigint };
				found.push({
					path,
					relative: rel,
					dev: stat.dev,
					ino: stat.ino,
					size: stat.size,
					// The place and the file object, with its birth time, so a later file that reuses the inode number is not the same one.
					selector: `o1-${this.#key
						.digest({
							purpose: SELECTOR_PURPOSE,
							path: rel,
							dev: String(stat.dev),
							ino: String(stat.ino),
							born: String(stat.birthtimeNs),
						})
						.value.slice(0, 32)}`,
				});
			}
		};
		visit(this.#root, 1);
		return { found, skipped, beyond };
	}

	/** One file, whole, within `maxBytes`, and the bytes read. Null when the listing's byte budget, not the file's own bound, stopped it. */
	#journal(file: Found, maxBytes: number): { journal: OmpJournalV0; bytes: number } | null {
		// The directory it sits in must still be the one walked (see #discover).
		try {
			if (realpathSync(dirname(file.path)) !== dirname(file.path))
				return { journal: unreadOmpJournalV0("unreadable"), bytes: 0 };
		} catch {
			return { journal: unreadOmpJournalV0("unreadable"), bytes: 0 };
		}
		const read = readOmpFileV0(file.path, maxBytes);
		if (!read.ok)
			return read.state === "too-large" && maxBytes < ENDO_OMP_LIMITS_V0.maxFileBytes
				? null
				: { journal: unreadOmpJournalV0(read.state), bytes: 0 };
		// The file object read must be the one discovered: otherwise the selector would name one file and the contents another's.
		if (read.identity.dev !== file.dev || read.identity.ino !== file.ino)
			return { journal: unreadOmpJournalV0("unstable"), bytes: read.bytes.length };
		return { journal: reduceOmpJournalV0(read.bytes), bytes: read.bytes.length };
	}

	/**
	 * Every discovered file read whole, within the listing's budget (the bytes actually read are charged). The ids two files share are
	 * counted from these same reads, so the list and one session agree, and no file's key depends on a cheaper second look.
	 */
	#readAll(found: Found[], skipped: EndoOmpSessionsV0["skipped"]): Map<Found, OmpJournalV0> {
		let budget = ENDO_OMP_LIMITS_V0.maxListingBytes;
		const read = new Map<Found, OmpJournalV0>();
		for (const file of found) {
			const got = budget <= 0 ? null : this.#journal(file, Math.min(ENDO_OMP_LIMITS_V0.maxFileBytes, budget));
			if (got === null) {
				skipped.notRead += 1;
				continue;
			}
			budget -= got.bytes;
			read.set(file, got.journal);
		}
		return read;
	}

	#ids(journals: Iterable<OmpJournalV0>): Map<string, number> {
		const ids = new Map<string, number>();
		for (const j of journals) if (j.state === "readable" && j.id !== null) ids.set(j.id, (ids.get(j.id) ?? 0) + 1);
		return ids;
	}

	#row(file: Found, journal: OmpJournalV0, ids: Map<string, number>): EndoOmpSessionRowV0 {
		const id = journal.id;
		const key: EndoOmpSessionRowV0["key"] =
			journal.state !== "readable"
				? { status: "unavailable", reason: "no-header" }
				: id === null
					? { status: "unavailable", reason: "malformed-id" }
					: ids.get(id) !== 1
						? { status: "unavailable", reason: "duplicate-id" }
						: { status: "established", id };
		const row: EndoOmpSessionRowV0 = { selector: file.selector, key, alias: null, ...journal.row };
		this.#alias(row, ids);
		return row;
	}

	/**
	 * A label from the id: its LAST eight characters (OMP's ids are UUIDv7, whose leading characters are a timestamp and are shared by
	 * sessions made close together), unless another id in the directory ends the same way (then none). Computed from the same reads for
	 * the list and for one session, so a session has the same label in both.
	 */
	#alias(row: EndoOmpSessionRowV0, ids: Map<string, number>): void {
		if (row.key.status !== "established") return;
		const label = row.key.id.slice(-8);
		const alike = [...ids.keys()].filter((id) => id.slice(-8) === label).length;
		row.alias = label.length >= 4 && alike === 1 && /^[0-9A-Za-z._:-]+$/.test(label) ? `omp ${label}` : null;
	}

	sessions(): EndoOmpSessionsV0 {
		const { found, skipped } = this.#discover();
		const journals = this.#readAll(found, skipped);
		const ids = this.#ids(journals.values());
		const rows = [...journals].map(([file, journal]) => this.#row(file, journal, ids));
		return {
			schemaVersion: ENDO_OMP_SESSIONS_SCHEMA_V0,
			available: true,
			readAt: this.#now().toISOString(),
			sessions: rows,
			skipped,
		};
	}

	/** This directory's scope (see `ompScopeOfRootV0`). */
	get scope(): string {
		return ompScopeOfRootV0(this.#root);
	}

	/**
	 * Whether `id` is established in this directory, from one fresh, whole read of every file (the same reads and the same counting as the list).
	 * Reads only; nothing is written, run or kept. A Studio selector is not an id and is never looked up as one (the caller refuses it first).
	 */
	resolve(id: string): OmpResolutionV0 {
		return this.resolveAll([id]).get(id) as OmpResolutionV0;
	}

	/** `resolve` for several ids from ONE read of the directory (`endo task show` checks each saved reference this way). */
	resolveAll(ids: readonly string[]): Map<string, OmpResolutionV0> {
		const { found, skipped, beyond } = this.#discover();
		const journals = this.#readAll(found, skipped);
		const readable = [...journals.values()].filter((j) => j.state === "readable");
		// Every entry that could hold a copy and was not read whole: a file over the bounds or not read for the budget, a directory or file
		// that could not be read, changed during the read or is of a format this reader does not know, a link (never followed), a special
		// file, and a directory past the depth bound (never looked into). Any of them leaves a single carrier `uncertain`.
		const unread =
			skipped.overLimit +
			skipped.notRead +
			skipped.unreadable +
			skipped.links +
			skipped.notRegular +
			beyond +
			(journals.size - readable.length);
		const answers = new Map<string, OmpResolutionV0>();
		for (const id of ids) {
			const carriers = readable.filter((j) => j.id === id).length;
			answers.set(
				id,
				carriers === 0
					? { status: "not-found", unread }
					: carriers > 1
						? { status: "duplicate", files: carriers }
						: unread > 0
							? { status: "uncertain", unread }
							: { status: "established", sessionId: id, scope: this.scope, format: OMP_SESSION_FORMAT_V0 },
			);
		}
		return answers;
	}

	session(selector: string): EndoOmpSessionV0 | null {
		if (!ENDO_OMP_SELECTOR_PATTERN_V0.test(selector)) return null;
		const { found, skipped } = this.#discover();
		if (!found.some((f) => f.selector === selector)) return null;
		const journals = this.#readAll(found, skipped);
		const entry = [...journals].find(([f]) => f.selector === selector);
		if (entry === undefined) return null;
		const [file, journal] = entry;
		const row = this.#row(file, journal, this.#ids(journals.values()));
		return {
			schemaVersion: ENDO_OMP_SESSION_SCHEMA_V0,
			readAt: this.#now().toISOString(),
			session: row,
			activity: journal.activity,
			earlier: journal.earlier,
		};
	}
}
