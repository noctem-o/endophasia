// Write-once record files, shared by the DEVELOP attempt records (storage/develop-attempts.ts) and verification receipts
// (storage/develop-receipts.ts). Each record is its own small file, written ONE time and never rewritten:
//   1. a temporary file `.tmp-<pid>-<12 hex>` is created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600), written whole and fsynced;
//   2. it is HARD-LINKED to its final name, which the system refuses when that name exists (a file, a link, anything), so of several
//      writers of the same record exactly one succeeds and the others are told it exists; nothing is ever replaced or merged;
//   3. the temporary name is removed and the directory fsynced.
// A reader therefore sees a record whole (its bytes were durable before its name appeared) or not at all. A crash leaves at most a
// temporary file, which a later writer removes once it is a minute old (a younger one may be a live writer's). There is no lock.
//
// Reads are bounded and never follow a link: a file is checked with lstat, opened with O_NOFOLLOW|O_NONBLOCK and checked again on the
// descriptor, so a link, a directory, a pipe or a device is refused rather than read.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { writeExactSyncV0 } from "./log.ts";

/** The name of a temporary file a writer makes before linking it. A reader skips these. */
export const WRITE_ONCE_TEMPORARY_V0 = /^\.tmp-[0-9]+-[0-9a-f]{12}$/;

export type WriteOnceReadProblemV0 = "unsafe-path" | "too-large" | "malformed" | "io";

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Whether each directory, in order, is a plain directory (not a link). `missing` when the first absent one is absent (a reader treats that
 * as "nothing recorded"); `unsafe-path` when one exists and is not a plain directory.
 */
export function checkDirectoriesSyncV0(dirs: readonly string[]): "ok" | "missing" | "unsafe-path" | "io" {
	try {
		for (const dir of dirs) {
			const info = lstatSync(dir, { throwIfNoEntry: false });
			if (info === undefined) return "missing";
			if (!info.isDirectory()) return "unsafe-path";
		}
		return "ok";
	} catch (error) {
		return errno(error) === "ENOTDIR" || errno(error) === "ELOOP" ? "unsafe-path" : "io";
	}
}

/**
 * Make each directory (owner-only) when missing, in order, and prove each is a plain directory, not a link. Safe when several processes
 * make the same directory at once.
 */
export function ensureDirectoriesSyncV0(dirs: readonly string[]): boolean {
	try {
		for (const [index, dir] of dirs.entries()) {
			const existing = lstatSync(dir, { throwIfNoEntry: false });
			if (existing === undefined) {
				if (index === 0) mkdirSync(join(dir, ".."), { recursive: true });
				try {
					mkdirSync(dir, { mode: 0o700 });
				} catch (error) {
					// Another writer made it a moment ago (two first writes at once): what is there is checked below like anything else.
					if (errno(error) !== "EEXIST") throw error;
				}
			}
			// Whoever made it, it must be a plain directory now, not a link to one.
			if (!lstatSync(dir).isDirectory()) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** One record file, read whole as JSON: a regular file (never through a link), at most `limit` bytes, UTF-8. */
export function readBoundedJsonSyncV0(
	path: string,
	limit: number,
): { ok: true; value: unknown } | { ok: false; reason: WriteOnceReadProblemV0 } {
	try {
		const entry = lstatSync(path);
		if (!entry.isFile()) return { ok: false, reason: "unsafe-path" };
		if (entry.size > limit) return { ok: false, reason: "too-large" };
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let bytes: Buffer;
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile()) return { ok: false, reason: "unsafe-path" };
			if (opened.size > limit) return { ok: false, reason: "too-large" };
			bytes = Buffer.alloc(opened.size);
			let at = 0;
			while (at < bytes.length) {
				const n = readSync(fd, bytes, at, bytes.length - at, at);
				if (n === 0) break;
				at += n;
			}
			if (at !== bytes.length) return { ok: false, reason: "io" };
		} finally {
			closeSync(fd);
		}
		try {
			return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
		} catch {
			return { ok: false, reason: "malformed" };
		}
	} catch (error) {
		return { ok: false, reason: errno(error) === "ELOOP" ? "unsafe-path" : "io" };
	}
}

/** Remove temporary files a crashed writer left. Only those at least a minute old: a younger one may belong to a writer about to link it. */
export function sweepTemporariesSyncV0(dir: string): void {
	try {
		for (const name of readdirSync(dir)) {
			if (!WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const info = lstatSync(join(dir, name), { throwIfNoEntry: false });
			if (info?.isFile() === true && Date.now() - info.mtimeMs >= 60_000) rmSync(join(dir, name), { force: true });
		}
	} catch {
		// a sweep that cannot run leaves the files for the next writer
	}
}

/**
 * Write `bytes` under `dir/name`, once. The directory must already exist and be checked. `exists`: that name was taken (by an earlier or a
 * concurrent writer), and was left as it is. `failed`: nothing was written. `beforeLink` is a test hook: it runs after the temporary file is
 * complete and before it is linked, and a throw there is a failure at that point.
 */
export function writeOnceSyncV0(
	dir: string,
	name: string,
	bytes: Buffer,
	beforeLink?: () => void,
): "created" | "exists" | "failed" {
	sweepTemporariesSyncV0(dir);
	const temporary = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeExactSyncV0(fd, bytes, temporary);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		beforeLink?.();
		try {
			linkSync(temporary, join(dir, name));
		} catch (error) {
			return errno(error) === "EEXIST" ? "exists" : "failed";
		}
		// The record exists from here on, whatever follows: a failure to make its name durable is not a failure to record it (and saying
		// "nothing was recorded" would invite a retry that duplicates the record or is refused as already recorded).
		try {
			const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		} catch {
			// best effort: the record is linked and readable now
		}
		return "created";
	} catch {
		return "failed";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// the descriptor is gone either way
			}
		}
		try {
			rmSync(temporary, { force: true });
		} catch {
			// a temporary name that cannot be removed now is swept by a later writer once it is old
		}
	}
}
