// Workspace archives: what a recorded session's scratch workspace held before the session ran, so a replay can start
// from the same files.
//
// The archive is the canonical JSON of `{ schemaVersion, rootMtimeMs, entries }`. Entries are sorted by path (UTF-16
// code-unit order of the POSIX relative path) and hold what a tool can observe: a directory, a file (its bytes, base64,
// and whether it is executable), or a symbolic link (its target text, never followed), each with its modification time
// in whole milliseconds (`mtimeMs`), and the root directory's too. Times are state, not time: a tool such as `ls -la`
// prints them, so a replay that restored the files with new times would show the tool a different workspace. Owner,
// group and the remaining permission bits are not kept. Any other file kind (socket, FIFO, device) is refused rather
// than silently dropped.
//
// Versions: `endo.workspace-archive.v1` (with times; written now) and `endo.workspace-archive.v0` (without; still read
// and restored, with fresh times).
//
// Restoring writes into a directory that does not exist yet, or is empty. Every entry path is checked: no absolute
// path, no `..`, no empty or `.` segment, and nothing under a path the archive itself makes a symbolic link, so an
// archive can never write outside the target directory.

import {
	chmodSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isPlainJsonObjectV0 } from "../protocol/primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	EndoSchemaVersionErrorV0,
	type EndoVersionedReadV0,
	endoFirstUnknownKeyV0,
	endoSafeTextV0,
	readEndoVersionedV0,
} from "../protocol/versioned.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

export const ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0 = "endo.workspace-archive.v0";
export const ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1 = "endo.workspace-archive.v1";

/** The version `archiveEndoWorkspaceV0` writes. The reader below keeps both. */
export const ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0 = ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1;

/** The most file bytes an archive holds; a larger workspace is refused (a snapshot is for scratch workspaces). */
export const ENDO_WORKSPACE_ARCHIVE_MAX_BYTES_V0 = 64 * 1024 * 1024;

/** An entry; `mtimeMs` is present in v1 archives only. */
export type EndoWorkspaceArchiveEntryV0 =
	| { path: string; type: "directory"; mtimeMs?: number }
	| { path: string; type: "file"; executable: boolean; bytes: number; base64: string; mtimeMs?: number }
	| { path: string; type: "symlink"; target: string; mtimeMs?: number };

export interface EndoWorkspaceArchiveV0 {
	schemaVersion: typeof ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0 | typeof ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1;
	/** v1 only: the root directory's modification time. */
	rootMtimeMs?: number;
	entries: EndoWorkspaceArchiveEntryV0[];
}

/** What a snapshot reports about itself (beside the archive bytes). */
export interface EndoWorkspaceArchiveSummaryV0 {
	entries: number;
	files: number;
	directories: number;
	symlinks: number;
	fileBytes: number;
}

/** Archive the tree under `directory` (the directory itself is the root and is not an entry). */
export function archiveEndoWorkspaceV0(directory: string): {
	bytes: Uint8Array;
	summary: EndoWorkspaceArchiveSummaryV0;
} {
	const entries: EndoWorkspaceArchiveEntryV0[] = [];
	let fileBytes = 0;
	const walk = (relative: string) => {
		const absolute = relative === "" ? directory : join(directory, relative);
		for (const name of readdirSync(absolute).sort()) {
			const path = relative === "" ? name : `${relative}/${name}`;
			const full = join(directory, path);
			const info = lstatSync(full);
			const mtimeMs = Math.floor(info.mtimeMs);
			if (info.isSymbolicLink()) entries.push({ path, type: "symlink", target: readlinkSync(full), mtimeMs });
			else if (info.isDirectory()) {
				entries.push({ path, type: "directory", mtimeMs });
				walk(path);
			} else if (info.isFile()) {
				const content = readFileSync(full);
				fileBytes += content.length;
				if (fileBytes > ENDO_WORKSPACE_ARCHIVE_MAX_BYTES_V0)
					throw new TypeError(
						`the workspace ${directory} holds more than ${ENDO_WORKSPACE_ARCHIVE_MAX_BYTES_V0} bytes`,
					);
				entries.push({
					path,
					type: "file",
					executable: (info.mode & 0o111) !== 0,
					bytes: content.length,
					base64: content.toString("base64"),
					mtimeMs,
				});
			} else throw new TypeError(`the workspace entry ${path} is neither a file, a directory nor a symbolic link`);
		}
	};
	walk("");
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const archive: EndoWorkspaceArchiveV0 = {
		schemaVersion: ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0,
		rootMtimeMs: Math.floor(statSync(directory).mtimeMs),
		entries,
	};
	return {
		bytes: new TextEncoder().encode(canonicalEndoJsonV0(archive)),
		summary: {
			entries: entries.length,
			files: entries.filter((entry) => entry.type === "file").length,
			directories: entries.filter((entry) => entry.type === "directory").length,
			symlinks: entries.filter((entry) => entry.type === "symlink").length,
			fileBytes,
		},
	};
}

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const reject = (detail: string): never => {
	throw new EndoInvalidRecordV0(detail);
};

function safePath(path: unknown): string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0")
	)
		return reject(`unsafe archive path ${endoSafeTextV0(String(path))}`);
	for (const segment of path.split("/"))
		if (segment === "" || segment === "." || segment === "..")
			return reject(`unsafe archive path ${endoSafeTextV0(path)}`);
	return path;
}

// Each representation is exact: these are the keys it declares, and no others. A key of another version is an unknown
// key here (v0 has no times; v1 requires them).
const ROOT_KEYS_V0 = ["schemaVersion", "entries"] as const;
const ROOT_KEYS_V1 = ["schemaVersion", "rootMtimeMs", "entries"] as const;
const ENTRY_KEYS_V0 = {
	directory: ["path", "type"],
	file: ["path", "type", "executable", "bytes", "base64"],
	symlink: ["path", "type", "target"],
} as const;
const ENTRY_KEYS_V1 = {
	directory: [...ENTRY_KEYS_V0.directory, "mtimeMs"],
	file: [...ENTRY_KEYS_V0.file, "mtimeMs"],
	symlink: [...ENTRY_KEYS_V0.symlink, "mtimeMs"],
} as const;

/** Check an archive of one exact version (v1 when `timed`): its keys, its entries' keys and types, the paths, the order. */
function checkArchive(value: unknown, timed: boolean): EndoWorkspaceArchiveV0 {
	const root = value as Record<string, unknown>;
	const unknownRoot = endoFirstUnknownKeyV0(root, timed ? ROOT_KEYS_V1 : ROOT_KEYS_V0);
	if (unknownRoot !== undefined) return reject(`unknown archive field ${endoSafeTextV0(unknownRoot)}`);
	if (timed && !isTime(root.rootMtimeMs)) return reject("bad root time");
	if (!Array.isArray(root.entries)) return reject("entries is not an array");
	const keys = timed ? ENTRY_KEYS_V1 : ENTRY_KEYS_V0;
	const links = new Set<string>();
	let previous = "";
	for (const entry of root.entries as unknown[]) {
		if (!isPlainJsonObjectV0(entry)) return reject("an archive entry is not a plain JSON object");
		const e = entry as Record<string, unknown>;
		const path = safePath(e.path);
		const type = e.type;
		if (type !== "directory" && type !== "file" && type !== "symlink")
			return reject(`unknown entry type at ${endoSafeTextV0(path)}`);
		const unknown = endoFirstUnknownKeyV0(e, keys[type]);
		if (unknown !== undefined)
			return reject(`unknown field ${endoSafeTextV0(unknown)} in the entry ${endoSafeTextV0(path)}`);
		if (timed && !isTime(e.mtimeMs)) return reject(`bad time at ${endoSafeTextV0(path)}`);
		if (previous !== "" && !(previous < path))
			return reject(`archive entries are not sorted at ${endoSafeTextV0(path)}`);
		previous = path;
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index += 1)
			if (links.has(parts.slice(0, index).join("/")))
				return reject(
					`archive entry ${endoSafeTextV0(path)} lies under the symbolic link ${endoSafeTextV0(parts.slice(0, index).join("/"))}`,
				);
		if (type === "symlink") {
			if (typeof e.target !== "string" || e.target.length === 0) return reject(`bad link ${endoSafeTextV0(path)}`);
			links.add(path);
		} else if (type === "file") {
			if (typeof e.base64 !== "string" || typeof e.executable !== "boolean" || !isTime(e.bytes))
				return reject(`bad file entry ${endoSafeTextV0(path)}`);
			// Buffer's base64 decoder skips what it does not understand; a round trip proves the text is canonical base64.
			const content = Buffer.from(e.base64, "base64");
			if (content.toString("base64") !== e.base64 || content.length !== e.bytes)
				return reject(`bad file content or length ${endoSafeTextV0(path)}`);
		}
	}
	return value as EndoWorkspaceArchiveV0;
}

/**
 * The archive versions this reader knows, each read under its own exact rules. Readers keep every committed version;
 * the writer ({@link ENDO_WORKSPACE_ARCHIVE_WRITE_VERSION_V0}) emits only the current one.
 */
export const ENDO_WORKSPACE_ARCHIVE_VERSIONS_V0 = defineEndoVersionTableV0<EndoWorkspaceArchiveV0>(
	"endo.workspace-archive",
	[
		[ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0, (value) => checkArchive(value, false)],
		[ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1, (value) => checkArchive(value, true)],
	],
);

/**
 * Read archive bytes (v0 or v1) as a result: a missing, unknown and malformed-known version stay distinguishable. The
 * bytes must also be the canonical JSON of the record. Bytes that are not UTF-8 JSON are a `not-an-object` failure.
 */
export function readEndoWorkspaceArchiveV0(bytes: Uint8Array): EndoVersionedReadV0<EndoWorkspaceArchiveV0> {
	let text: string;
	let parsed: unknown;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			kind: "not-an-object",
			message: "endo.workspace-archive: the bytes are not UTF-8 JSON",
		};
	}
	const read = readEndoVersionedV0(ENDO_WORKSPACE_ARCHIVE_VERSIONS_V0, parsed);
	if (!read.ok) return read;
	let canonical: string;
	try {
		canonical = canonicalEndoJsonV0(read.value);
	} catch {
		canonical = "";
	}
	if (canonical !== text)
		return {
			ok: false,
			kind: "invalid",
			schemaVersion: read.schemaVersion,
			message: `endo.workspace-archive: record declares ${read.schemaVersion} but is not in canonical form`,
		};
	return read;
}

/** Parse and check archive bytes (v0 or v1). Throws `EndoSchemaVersionErrorV0` (a `TypeError`) on anything that is not a well-formed, safe workspace archive. */
export function parseEndoWorkspaceArchiveV0(bytes: Uint8Array): EndoWorkspaceArchiveV0 {
	const read = readEndoWorkspaceArchiveV0(bytes);
	if (!read.ok) throw new EndoSchemaVersionErrorV0(read);
	return read.value;
}

/**
 * Restore archive bytes into `directory`, which must not exist or must be empty. Returns the parsed archive. A v1
 * archive's times are applied after every entry is written (writing into a directory changes its time): files and
 * links first, then directories deepest first, then the root.
 */
export function restoreEndoWorkspaceV0(bytes: Uint8Array, directory: string): EndoWorkspaceArchiveV0 {
	const archive = parseEndoWorkspaceArchiveV0(bytes);
	mkdirSync(directory, { recursive: true, mode: 0o755 });
	if (readdirSync(directory).length !== 0)
		throw new TypeError(`${directory} is not empty; refusing to restore into it`);
	for (const entry of archive.entries) {
		const target = join(directory, entry.path);
		if (entry.type === "directory") mkdirSync(target, { mode: 0o755 });
		else if (entry.type === "symlink") symlinkSync(entry.target, target);
		else {
			writeFileSync(target, Buffer.from(entry.base64, "base64"), { flag: "wx", mode: 0o644 });
			if (entry.executable) chmodSync(target, 0o755);
		}
	}
	if (archive.schemaVersion === ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1)
		setTimes(directory, archive.entries as TimedEntry[], archive.rootMtimeMs!);
	return archive;
}

type TimedEntry = { path: string; type: "file" | "directory" | "symlink"; mtimeMs: number };

/** Set recorded times: files and links first, then directories deepest first, then the root (each write moves its parent's time). */
function setTimes(directory: string, entries: readonly TimedEntry[], rootMtimeMs: number): void {
	// Seconds, at the middle of the recorded millisecond: utimes takes a double, and some libuv releases (Node 22's)
	// truncate it to whole microseconds, so t / 1000 lands just under t for about half of all t (…383 reads back as
	// …382). The middle survives that truncation and floors back to exactly t, so a re-archive gives the same bytes.
	const at = (ms: number) => (ms + 0.5) / 1000;
	for (const entry of entries) {
		const target = join(directory, entry.path);
		if (entry.type === "file") utimesSync(target, at(entry.mtimeMs), at(entry.mtimeMs));
		else if (entry.type === "symlink") lutimesSync(target, at(entry.mtimeMs), at(entry.mtimeMs));
	}
	const directories = entries.filter((entry) => entry.type === "directory");
	directories.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
	for (const entry of directories) utimesSync(join(directory, entry.path), at(entry.mtimeMs), at(entry.mtimeMs));
	utimesSync(directory, at(rootMtimeMs), at(rootMtimeMs));
}

/**
 * Pin a tree's times: every entry under `directory`, and `directory` itself, gets the modification and access time
 * `ms` (milliseconds since the epoch). An experiment's pinned environment uses it so that a tool listing the tree
 * (`ls -la`) prints the same times in every trial.
 */
export function pinEndoWorkspaceTimesV0(directory: string, ms: number): void {
	if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError(`bad time ${ms}`);
	const entries: TimedEntry[] = [];
	const walk = (relative: string) => {
		for (const dirent of readdirSync(join(directory, relative), { withFileTypes: true })) {
			const path = relative === "" ? dirent.name : `${relative}/${dirent.name}`;
			if (dirent.isDirectory()) {
				entries.push({ path, type: "directory", mtimeMs: ms });
				walk(path);
			} else entries.push({ path, type: dirent.isSymbolicLink() ? "symlink" : "file", mtimeMs: ms });
		}
	};
	walk("");
	setTimes(directory, entries, ms);
}
