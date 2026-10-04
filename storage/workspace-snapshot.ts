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
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

export const ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0 = "endo.workspace-archive.v0";
export const ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1 = "endo.workspace-archive.v1";

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
		schemaVersion: ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1,
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

function safePath(path: unknown): string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0")
	)
		throw new TypeError(`unsafe archive path ${JSON.stringify(path)}`);
	for (const segment of path.split("/"))
		if (segment === "" || segment === "." || segment === "..")
			throw new TypeError(`unsafe archive path ${JSON.stringify(path)}`);
	return path;
}

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Parse and check archive bytes (v0 or v1). Throws on anything that is not a well-formed, safe workspace archive. */
export function parseEndoWorkspaceArchiveV0(bytes: Uint8Array): EndoWorkspaceArchiveV0 {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const parsed = JSON.parse(text) as EndoWorkspaceArchiveV0;
	const v1 = parsed?.schemaVersion === ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1;
	if ((!v1 && parsed?.schemaVersion !== ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0) || !Array.isArray(parsed.entries))
		throw new TypeError(`not an ${ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1} or ${ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0}`);
	if (v1 ? !isTime(parsed.rootMtimeMs) : parsed.rootMtimeMs !== undefined) throw new TypeError("bad root time");
	if (canonicalEndoJsonV0(parsed) !== text) throw new TypeError("the archive is not in canonical form");
	const links = new Set<string>();
	let previous = "";
	for (const entry of parsed.entries) {
		const path = safePath(entry.path);
		if (v1 ? !isTime(entry.mtimeMs) : entry.mtimeMs !== undefined) throw new TypeError(`bad time at ${path}`);
		if (previous !== "" && !(previous < path)) throw new TypeError(`archive entries are not sorted at ${path}`);
		previous = path;
		const parts = path.split("/");
		for (let index = 1; index < parts.length; index += 1)
			if (links.has(parts.slice(0, index).join("/")))
				throw new TypeError(
					`archive entry ${path} lies under the symbolic link ${parts.slice(0, index).join("/")}`,
				);
		if (entry.type === "symlink") {
			if (typeof entry.target !== "string" || entry.target.length === 0) throw new TypeError(`bad link ${path}`);
			links.add(path);
		} else if (entry.type === "file") {
			if (typeof entry.base64 !== "string" || typeof entry.executable !== "boolean")
				throw new TypeError(`bad file entry ${path}`);
			if (Buffer.from(entry.base64, "base64").length !== entry.bytes) throw new TypeError(`bad file length ${path}`);
		} else if (entry.type !== "directory") throw new TypeError(`unknown entry type at ${path}`);
	}
	return parsed;
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
	if (archive.schemaVersion === ENDO_WORKSPACE_ARCHIVE_SCHEMA_V1) {
		const at = (ms: number) => ms / 1000;
		for (const entry of archive.entries) {
			const target = join(directory, entry.path);
			if (entry.type === "file") utimesSync(target, at(entry.mtimeMs!), at(entry.mtimeMs!));
			else if (entry.type === "symlink") lutimesSync(target, at(entry.mtimeMs!), at(entry.mtimeMs!));
		}
		const directories = archive.entries.filter((entry) => entry.type === "directory");
		directories.sort((a, b) => b.path.split("/").length - a.path.split("/").length);
		for (const entry of directories) utimesSync(join(directory, entry.path), at(entry.mtimeMs!), at(entry.mtimeMs!));
		utimesSync(directory, at(archive.rootMtimeMs!), at(archive.rootMtimeMs!));
	}
	return archive;
}
