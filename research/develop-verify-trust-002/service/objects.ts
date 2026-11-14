// DEVELOP-VERIFY-TRUST-002: verified object transfer (ARCHITECTURE.md §5.3). Research only.
//
// The verifier runs no Git. It receives a commit's objects as bytes, computes each object's id itself, parses commit and tree objects with
// the strict parser below, walks the tree from the requested commit, and refuses anything it does not fully understand. What it stages is
// therefore exactly the content the commit id names: there is no repository, so no replace refs, no promisor remote and no configuration.

import { createHash } from "node:crypto";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";

export type ObjectFormat = "sha1" | "sha256";
export type ObjectType = "commit" | "tree" | "blob";

export const BOUNDS = {
	maxObjects: 1024,
	maxFiles: 256,
	maxFileBytes: 1 << 20,
	maxTotalBytes: 4 << 20,
	maxDepth: 16,
} as const;
/** A file or directory name: no separators, not `.` or `..`, not `.git` in any case, plain characters only. */
const NAME = /^(?!\.{1,2}$)(?!\.git$)[A-Za-z0-9._-]{1,100}$/i;
const PATH_MAX = 200;

export interface StagedFile {
	path: string;
	mode: "100644" | "100755";
	bytes: number;
	sha256: string;
	content: Buffer;
}
export interface Candidate {
	objectFormat: ObjectFormat;
	commit: string;
	tree: string;
	files: StagedFile[];
	/** Byte identity: SHA-256 over every file's path, mode, size and SHA-256, sorted by path. */
	exportSha256: string;
}
export type Refusal = { ok: false; reason: string };

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const idLength = (f: ObjectFormat) => (f === "sha1" ? 20 : 32);

/** The Git object id of one object: the hash of `<type> <size>\0<content>`. */
export function objectId(format: ObjectFormat, type: ObjectType, content: Buffer): string {
	return createHash(format)
		.update(Buffer.concat([Buffer.from(`${type} ${content.length}\0`, "ascii"), content]))
		.digest("hex");
}

export function exportDigest(files: readonly Pick<StagedFile, "path" | "mode" | "bytes" | "sha256">[]): string {
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return sha256HexV0(
		canonicalEndoJsonV0(sorted.map((f) => ({ path: f.path, mode: f.mode, bytes: f.bytes, sha256: f.sha256 }))),
	);
}

/** The tree id from a commit object. Only the first header is read; it must be exactly `tree <id>`. */
export function commitTree(format: ObjectFormat, content: Buffer): string | null {
	const hex = idLength(format) * 2;
	const end = content.indexOf(0x0a);
	if (end < 0) return null;
	const first = content.subarray(0, end).toString("latin1");
	const m = new RegExp(`^tree ([0-9a-f]{${hex}})$`).exec(first);
	return m === null ? null : (m[1] as string);
}

export interface TreeEntry {
	mode: string;
	name: string;
	id: string;
}

/** A tree object's entries: `<mode> <name>\0<raw id>`, repeated. Anything malformed refuses the whole tree. */
export function parseTree(format: ObjectFormat, content: Buffer): TreeEntry[] | null {
	const n = idLength(format);
	const entries: TreeEntry[] = [];
	let i = 0;
	while (i < content.length) {
		const space = content.indexOf(0x20, i);
		if (space < 0) return null;
		const mode = content.subarray(i, space).toString("latin1");
		if (!/^[0-7]{5,6}$/.test(mode)) return null;
		const nul = content.indexOf(0, space + 1);
		if (nul < 0 || nul + 1 + n > content.length) return null;
		const nameBytes = content.subarray(space + 1, nul);
		const name = nameBytes.toString("utf8");
		if (!Buffer.from(name, "utf8").equals(nameBytes)) return null;
		entries.push({ mode, name, id: content.subarray(nul + 1, nul + 1 + n).toString("hex") });
		i = nul + 1 + n;
	}
	return entries;
}

/**
 * Resolve `commit` from a set of objects into the files it names. Every object must be used exactly once in the walk (no unreferenced, no
 * duplicate, no wrong-typed object); every entry must be a regular file or a directory with a plain name; everything must fit the bounds.
 */
export function resolveCandidate(
	format: ObjectFormat,
	commit: string,
	objects: readonly { type: ObjectType; data: Buffer }[],
): { ok: true; candidate: Candidate } | Refusal {
	const hex = idLength(format) * 2;
	if (!new RegExp(`^[0-9a-f]{${hex}}$`).test(commit)) return { ok: false, reason: "commit-invalid" };
	if (objects.length === 0 || objects.length > BOUNDS.maxObjects)
		return { ok: false, reason: "unsupported-object-count" };
	const byId = new Map<string, { type: ObjectType; data: Buffer }>();
	for (const o of objects) {
		const id = objectId(format, o.type, o.data);
		if (byId.has(id)) return { ok: false, reason: "object-duplicate" };
		byId.set(id, o);
	}
	const used = new Set<string>();
	// Identical subtrees share one id, so a tree may be visited more than once; content addressing rules out cycles. The visit count is
	// bounded so that nested repetition cannot make the walk expensive.
	let visits = 0;
	const take = (id: string, type: ObjectType): Buffer | Refusal => {
		if (++visits > BOUNDS.maxObjects * 4) return { ok: false, reason: "unsupported-tree-size" };
		const o = byId.get(id);
		if (o === undefined) return { ok: false, reason: "object-missing" };
		if (o.type !== type) return { ok: false, reason: "object-type" };
		used.add(id);
		return o.data;
	};
	const c = take(commit, "commit");
	if (!Buffer.isBuffer(c)) return c;
	const tree = commitTree(format, c);
	if (tree === null) return { ok: false, reason: "commit-unreadable" };
	const files: StagedFile[] = [];
	let total = 0;
	const walk = (id: string, prefix: string, depth: number): Refusal | null => {
		if (depth > BOUNDS.maxDepth) return { ok: false, reason: "unsupported-depth" };
		const t = take(id, "tree");
		if (!Buffer.isBuffer(t)) return t;
		const entries = parseTree(format, t);
		if (entries === null) return { ok: false, reason: "tree-unreadable" };
		if (new Set(entries.map((e) => e.name.toLowerCase())).size !== entries.length)
			return { ok: false, reason: "unsupported-name" };
		for (const e of entries) {
			if (!NAME.test(e.name)) return { ok: false, reason: "unsupported-name" };
			const path = `${prefix}${e.name}`;
			if (path.length > PATH_MAX) return { ok: false, reason: "unsupported-name" };
			if (e.mode === "40000") {
				const r = walk(e.id, `${path}/`, depth + 1);
				if (r !== null) return r;
				continue;
			}
			if (e.mode !== "100644" && e.mode !== "100755") return { ok: false, reason: `unsupported-${e.mode}` };
			const b = take(e.id, "blob");
			if (!Buffer.isBuffer(b)) return b;
			if (b.length > BOUNDS.maxFileBytes) return { ok: false, reason: "unsupported-file-size" };
			total += b.length;
			if (total > BOUNDS.maxTotalBytes) return { ok: false, reason: "unsupported-tree-size" };
			if (files.length >= BOUNDS.maxFiles) return { ok: false, reason: "unsupported-tree-size" };
			files.push({ path, mode: e.mode, bytes: b.length, sha256: sha256(b), content: b });
		}
		return null;
	};
	const r = walk(tree, "", 0);
	if (r !== null) return r;
	if (files.length === 0) return { ok: false, reason: "unsupported-empty-tree" };
	// Two paths that differ only in case would collide on a case-insensitive file system, and Git never writes `a` and `a/` together.
	const lower = new Set(files.map((f) => f.path.toLowerCase()));
	if (lower.size !== files.length) return { ok: false, reason: "unsupported-name" };
	if (used.size !== byId.size) return { ok: false, reason: "object-unreferenced" };
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { ok: true, candidate: { objectFormat: format, commit, tree, files, exportSha256: exportDigest(files) } };
}
