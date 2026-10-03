// Deterministic workspace archives (`endo.workspace-archive.v0`): what a recorded session's scratch workspace held before
// the session ran, so a replay can start from the same files.
//
// The archive is the canonical JSON of `{ schemaVersion, entries }`. Entries are sorted by path (UTF-16 code-unit order
// of the POSIX relative path) and hold only what a tool can observe through the file's content and kind: a directory, a
// file (its bytes, base64, and whether it is executable), or a symbolic link (its target text, never followed). Owner,
// group, timestamps and the remaining permission bits are not kept, so the same tree always gives the same bytes. Any
// other file kind (socket, FIFO, device) is refused rather than silently dropped.
//
// Restoring writes into a directory that does not exist yet, or is empty. Every entry path is checked: no absolute
// path, no `..`, no empty or `.` segment, and nothing under a path the archive itself makes a symbolic link, so an
// archive can never write outside the target directory.

import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

export const ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0 = "endo.workspace-archive.v0";

/** The most file bytes an archive holds; a larger workspace is refused (a snapshot is for scratch workspaces). */
export const ENDO_WORKSPACE_ARCHIVE_MAX_BYTES_V0 = 64 * 1024 * 1024;

export type EndoWorkspaceArchiveEntryV0 =
	| { path: string; type: "directory" }
	| { path: string; type: "file"; executable: boolean; bytes: number; base64: string }
	| { path: string; type: "symlink"; target: string };

export interface EndoWorkspaceArchiveV0 {
	schemaVersion: typeof ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0;
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
			if (info.isSymbolicLink()) entries.push({ path, type: "symlink", target: readlinkSync(full) });
			else if (info.isDirectory()) {
				entries.push({ path, type: "directory" });
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
				});
			} else throw new TypeError(`the workspace entry ${path} is neither a file, a directory nor a symbolic link`);
		}
	};
	walk("");
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const archive: EndoWorkspaceArchiveV0 = { schemaVersion: ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0, entries };
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

/** Parse and check archive bytes. Throws on anything that is not a well-formed, safe `endo.workspace-archive.v0`. */
export function parseEndoWorkspaceArchiveV0(bytes: Uint8Array): EndoWorkspaceArchiveV0 {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const parsed = JSON.parse(text) as EndoWorkspaceArchiveV0;
	if (parsed?.schemaVersion !== ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0 || !Array.isArray(parsed.entries))
		throw new TypeError(`not an ${ENDO_WORKSPACE_ARCHIVE_SCHEMA_V0}`);
	if (canonicalEndoJsonV0(parsed) !== text) throw new TypeError("the archive is not in canonical form");
	const links = new Set<string>();
	let previous = "";
	for (const entry of parsed.entries) {
		const path = safePath(entry.path);
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

/** Restore archive bytes into `directory`, which must not exist or must be empty. Returns the parsed archive. */
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
	return archive;
}
