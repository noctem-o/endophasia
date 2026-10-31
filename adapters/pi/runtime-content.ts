// Runtime-content identity for an installed Pi: a deterministic, bounded digest over the files that make up the
// runtime's implementation, taken without executing, installing or changing anything.
//
// WHAT IS COVERED. The scope is the directory that contains the entrypoint's real path, provided that directory is a
// proper descendant of the package root (the directory of the nearest package.json). For an npm install of Pi that
// is `<package>/dist/bundle`: the 160-byte launcher `cli.js`, `cli-runtime.js`, `index.js`, `rpc-entry.js` and every
// file under `chunks/`, which together are the program (Pi's bundler writes the whole application into this one
// directory and permits only a short list of external packages, see docs/attachment.md). No file name is listed
// here: a new chunk, a renamed chunk or a new top-level module in the next release is covered because it is in the
// directory, and a file removed from it is detected because it is no longer in the manifest.
//
// WHAT IS NOT COVERED, and is not claimed. The Node.js binary and its libraries; packages the bundle imports from
// node_modules (for Pi: `@silvia-odwyer/photon-node`, `jiti` and optional native accelerators); files in the package
// outside the scope (package.json fields other than name and version, docs, themes, assets); extensions and user
// configuration; and anything the runtime downloads. Hashing local files says what bytes are installed here. It does
// not say who published them, and it does not authenticate them.
//
// WHEN COVERAGE IS NOT COMPLETE, no digest is produced. The result is a reason, the fingerprint records a
// `runtimeContent` gap, and the identity is "reduced". There is no partial manifest: a digest either covers every
// entry in the scope or does not exist. These end coverage: a layout with no supported scope (no package, an
// entrypoint directly in the package root, or inside node_modules; a launcher that names a relative path outside its
// own directory); a symbolic link whose target is outside the
// scope, dangling or cyclic; any entry that is not a regular file, directory or symbolic link; a directory named
// node_modules; a name that is not clean UTF-8 text; more entries, bytes or depth than the limits; an unreadable
// file; a deadline overrun; and any sign that the tree changed while it was being read.
//
// SYMLINKS are never followed during the walk, so a cycle cannot cause traversal. A symbolic link inside the scope
// whose target (resolved once, with realpath) is also inside the scope is recorded as a link with its text; its
// target is covered by its own entry. Retargeting such a link changes the digest.
//
// RACES. Each file is opened without following links, checked to be a regular file on the descriptor it will read,
// and its size and modification time are compared before and after it is read. The directory listing is taken twice,
// before and after hashing, and must match. This detects a change made while a fingerprint was being taken (the
// common case: a package manager running, or a rebuild). It does not make the observation atomic: a process that
// changes a file after its last check, or restores one between the two listings, is not detected, and nothing here
// stops the runtime from changing after the observation. Evidence is bound to the observation it was taken against.
//
// COST. One streaming pass over the covered bytes (about 9 MB for Pi 1.0.x through 1.4.0), a 64 KiB read buffer, a
// bounded entry list, and a deadline. It runs on every identification, so there is no hidden second pass.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ENDO_RUNTIME_CONTENT_SCHEME_V1, type EndoHarnessRuntimeContentV1 } from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

/** Bounds on one runtime-content observation. A bound that is exceeded ends coverage; it never truncates it. */
export interface PiRuntimeContentLimitsV1 {
	/** Most entries (files and symbolic links) in the scope. Default 4096. */
	readonly maxEntries: number;
	/** Largest single file. Default 64 MiB. */
	readonly maxFileBytes: number;
	/** Most bytes across the scope. Default 256 MiB. */
	readonly maxTotalBytes: number;
	/** Deepest directory nesting below the scope. Default 12. */
	readonly maxDepth: number;
	/** Most directories in the scope. Default 512. */
	readonly maxDirectories: number;
	/** Wall-clock bound for the whole observation. Default 30 s. */
	readonly deadlineMs: number;
}

export const PI_RUNTIME_CONTENT_LIMITS_V1: PiRuntimeContentLimitsV1 = Object.freeze({
	maxEntries: 4096,
	maxFileBytes: 64 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024,
	maxDepth: 12,
	maxDirectories: 512,
	deadlineMs: 30_000,
});

export type PiRuntimeContentResultV1 =
	| { readonly ok: true; readonly content: EndoHarnessRuntimeContentV1 }
	| { readonly ok: false; readonly reason: string };

export interface PiRuntimeContentOptionsV1 {
	/** The entrypoint's real path (every symbolic link followed). */
	readonly entrypoint: string;
	/** The directory of the nearest package manifest above the entrypoint. */
	readonly packageRoot: string;
	readonly limits?: Partial<PiRuntimeContentLimitsV1>;
	/** Test seam: runs after the files are hashed and before the listing is checked again. */
	readonly afterHashing?: () => Promise<void>;
	readonly now?: () => number;
}

/** Thrown inside the walk to end coverage with a reason. Never escapes this module. */
class Incomplete extends Error {}

interface Entry {
	/** Path relative to the scope, "/" separated. */
	readonly path: string;
	readonly type: "file" | "symlink";
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
	readonly dev: number;
	/** For a symbolic link: its text. */
	readonly target?: string;
}

const NAME_OK = /^[^\u0000-\u001f\u007f�]+$/u;

/** The relative scope of an entrypoint inside a package, or a reason there is none. */
export function piRuntimeContentScopeV1(
	entrypoint: string,
	packageRoot: string,
): { readonly scopeDir: string; readonly scope: string } | string {
	const dir = dirname(entrypoint);
	const rel = relative(packageRoot, dir);
	if (rel === "") return "the entrypoint sits directly in the package root, so its directory is the whole package";
	if (rel.startsWith("..") || isAbsolute(rel)) return "the entrypoint is not inside its package root";
	const segments = rel.split(sep);
	if (segments.includes("node_modules")) return "the entrypoint sits inside node_modules";
	return { scopeDir: dir, scope: segments.join("/") };
}

function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Lists the scope without following links. Entries are returned sorted by path in code-unit order. */
async function walk(
	scopeDir: string,
	scopeReal: string,
	limits: PiRuntimeContentLimitsV1,
	checkDeadline: () => void,
): Promise<Entry[]> {
	const entries: Entry[] = [];
	const pending: { dir: string; rel: string; depth: number }[] = [{ dir: scopeDir, rel: "", depth: 0 }];
	let directories = 0;
	while (pending.length > 0) {
		directories += 1;
		if (directories > limits.maxDirectories)
			throw new Incomplete(`the scope has more than ${limits.maxDirectories} directories`);
		const { dir, rel, depth } = pending.pop()!;
		checkDeadline();
		// Names are read one at a time: a damaged directory with millions of entries ends coverage at the bound instead
		// of being loaded into memory first.
		const names: string[] = [];
		try {
			const handle = await opendir(dir);
			try {
				for await (const found of handle) {
					names.push(found.name);
					if (names.length > limits.maxEntries + limits.maxDirectories)
						throw new Incomplete(
							`a directory holds more than ${limits.maxEntries + limits.maxDirectories} names`,
						);
					checkDeadline();
				}
			} finally {
				await handle.close().catch(() => undefined);
			}
		} catch (error) {
			if (error instanceof Incomplete) throw error;
			throw new Incomplete(`the directory ${rel === "" ? "(scope root)" : rel} could not be listed`);
		}
		names.sort(compareCodeUnits);
		for (const name of names) {
			if (!NAME_OK.test(name)) throw new Incomplete("a file name is not clean text (control or invalid characters)");
			const path = rel === "" ? name : `${rel}/${name}`;
			const absolute = join(dir, name);
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(absolute);
			} catch {
				throw new Incomplete(`${path} disappeared or could not be inspected`);
			}
			if (info.isDirectory()) {
				if (name === "node_modules") throw new Incomplete("the scope contains a node_modules directory");
				if (depth + 1 > limits.maxDepth) throw new Incomplete(`the scope is nested deeper than ${limits.maxDepth}`);
				pending.push({ dir: absolute, rel: path, depth: depth + 1 });
				continue;
			}
			if (entries.length + 1 > limits.maxEntries)
				throw new Incomplete(`the scope has more than ${limits.maxEntries} entries`);
			if (info.isFile()) {
				entries.push({
					path,
					type: "file",
					size: info.size,
					mtimeMs: info.mtimeMs,
					ino: info.ino,
					dev: info.dev,
				});
				continue;
			}
			if (info.isSymbolicLink()) {
				let target: string;
				let resolved: string;
				try {
					target = await readlink(absolute);
					resolved = await realpath(absolute);
				} catch {
					throw new Incomplete(`the symbolic link ${path} is dangling, cyclic or unreadable`);
				}
				const inside = relative(scopeReal, resolved);
				if (inside === "" ? false : inside.startsWith("..") || isAbsolute(inside))
					throw new Incomplete(`the symbolic link ${path} points outside the covered directory`);
				entries.push({
					path,
					type: "symlink",
					size: 0,
					mtimeMs: info.mtimeMs,
					ino: info.ino,
					dev: info.dev,
					target,
				});
				continue;
			}
			throw new Incomplete(`${path} is not a regular file, directory or symbolic link`);
		}
	}
	return entries.sort((a, b) => compareCodeUnits(a.path, b.path));
}

const signature = (entries: readonly Entry[]): string =>
	JSON.stringify(entries.map((e) => [e.path, e.type, e.size, e.mtimeMs, e.ino, e.dev, e.target ?? null]));

async function hashFile(
	absolute: string,
	entry: Entry,
	limits: PiRuntimeContentLimitsV1,
	checkDeadline: () => void,
): Promise<string> {
	// No link is followed and nothing blocks on a swapped-in FIFO: O_NOFOLLOW + O_NONBLOCK, then a check on the descriptor.
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absolute, flags);
	} catch {
		throw new Incomplete(`${entry.path} could not be opened`);
	}
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Incomplete(`${entry.path} is no longer a regular file`);
		if (before.size !== entry.size || before.ino !== entry.ino || before.mtimeMs !== entry.mtimeMs)
			throw new Incomplete(`${entry.path} changed while the fingerprint was being taken`);
		if (before.size > limits.maxFileBytes)
			throw new Incomplete(`${entry.path} is ${before.size} bytes, over the ${limits.maxFileBytes}-byte file bound`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let read = 0;
		for (;;) {
			checkDeadline();
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			read += bytesRead;
			if (read > before.size) throw new Incomplete(`${entry.path} grew while the fingerprint was being taken`);
			hash.update(buffer.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Incomplete(`${entry.path} changed while the fingerprint was being taken`);
		return hash.digest("hex");
	} catch (error) {
		if (error instanceof Incomplete) throw error;
		throw new Incomplete(`${entry.path} could not be read`);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

/**
 * Best-effort guard against a layout this scope rule cannot cover: a launcher that loads its program from outside its
 * own directory (for example `require("../lib/runtime.js")`). Only the entrypoint is read, only when it is small, and
 * only quoted relative specifiers are considered; one that resolves outside the scope ends coverage. It cannot see a
 * path built at runtime or an unquoted one in a shell script, and says nothing about files the runtime reads as data.
 */
async function launcherEscapes(entrypoint: string, scopeDir: string): Promise<string | null> {
	let text: string;
	try {
		const info = await lstat(entrypoint);
		if (!info.isFile() || info.size > 64 * 1024) return null;
		text = await readFile(entrypoint, "latin1");
	} catch {
		return null;
	}
	for (const match of text.matchAll(/["'](\.{1,2}\/[^"'\n]*)["']/g)) {
		const target = resolve(scopeDir, match[1]!);
		const inside = relative(scopeDir, target);
		if (inside.startsWith("..") || isAbsolute(inside))
			return `the entrypoint refers to ${match[1]}, outside the covered directory`;
	}
	return null;
}

/**
 * Take the runtime-content digest of the directory the entrypoint sits in. Reads only; never throws: every way
 * coverage can fail is a `{ ok: false, reason }`.
 */
export async function hashPiRuntimeContentV1(options: PiRuntimeContentOptionsV1): Promise<PiRuntimeContentResultV1> {
	const limits: PiRuntimeContentLimitsV1 = { ...PI_RUNTIME_CONTENT_LIMITS_V1, ...options.limits };
	const now = options.now ?? Date.now;
	const started = now();
	const checkDeadline = () => {
		if (now() - started > limits.deadlineMs)
			throw new Incomplete(`hashing did not finish within ${limits.deadlineMs} ms`);
	};
	try {
		const located = piRuntimeContentScopeV1(options.entrypoint, options.packageRoot);
		if (typeof located === "string") return { ok: false, reason: located };
		const scopeReal = await realpath(located.scopeDir).catch(() => {
			throw new Incomplete("the covered directory could not be resolved");
		});
		const outside = await launcherEscapes(options.entrypoint, located.scopeDir);
		if (outside !== null) throw new Incomplete(outside);
		const first = await walk(located.scopeDir, scopeReal, limits, checkDeadline);
		if (first.length === 0) throw new Incomplete("the covered directory holds no files");
		const total = first.reduce((sum, e) => sum + e.size, 0);
		if (total > limits.maxTotalBytes)
			throw new Incomplete(`the scope is ${total} bytes, over the ${limits.maxTotalBytes}-byte bound`);
		const manifest: Record<string, string | number>[] = [];
		for (const entry of first) {
			if (entry.type === "symlink") {
				manifest.push({ p: entry.path, t: "symlink", l: entry.target ?? "" });
				continue;
			}
			const sha = await hashFile(join(located.scopeDir, ...entry.path.split("/")), entry, limits, checkDeadline);
			manifest.push({ p: entry.path, t: "file", n: entry.size, h: sha });
		}
		await options.afterHashing?.();
		const second = await walk(located.scopeDir, scopeReal, limits, checkDeadline);
		if (signature(first) !== signature(second))
			throw new Incomplete("files were added, removed or changed while the fingerprint was being taken");
		const sha256 = sha256HexV0(`${ENDO_RUNTIME_CONTENT_SCHEME_V1}\n${canonicalEndoJsonV0(manifest)}`);
		return {
			ok: true,
			content: {
				scheme: ENDO_RUNTIME_CONTENT_SCHEME_V1,
				scope: located.scope,
				files: first.length,
				bytes: total,
				sha256,
			},
		};
	} catch (error) {
		if (error instanceof Incomplete) return { ok: false, reason: error.message.slice(0, 900) };
		return { ok: false, reason: "the runtime content could not be read" };
	}
}
