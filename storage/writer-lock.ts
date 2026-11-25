/**
 * Shared single-writer lock for the durable event store (`<root>/events/session-attachment.lock`).
 *
 * Host infrastructure: node:fs, node:crypto, and node:path only. Shared across Pi (`adapters/pi/attachment.ts`) and
 * Codex (`adapters/codex/develop-adapter.ts`) so two live attachments never concurrently write `<root>/events/events.log`.
 *
 * Fail-closed rules preserved identically from Pi's original lock, plus TOCTOU hardening:
 * - Exclusive atomic create (`flag: "wx"`) embedding a per-lock random `token`.
 * - Unreadable or malformed lock files are treated as held (never silently stolen).
 * - Locks without a finite positive integer `pid` (including any future non-PID format sentinel) are treated as held.
 * - Live PIDs (including EPERM or this process's own PID) are refused with `EndoStoreLockedErrorV0`.
 * - Stale dead-PID lock cleanup uses atomic `renameSync(path, staleTmp)` followed by re-checking the moved lock's PID
 *   before unlinking `staleTmp`, preventing a concurrent winner's new lock from ever being unlinked.
 * - Release verifies ownership (`token`) before unlinking `path`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Thrown when another live session attachment already holds the store's writer lock. */
export class EndoStoreLockedErrorV0 extends Error {
	readonly path: string;
	readonly holder: string;

	constructor(path: string, holder: string) {
		super(`another Endophasia session attachment (${holder}) is writing this store; lock ${path}`);
		this.name = "EndoStoreLockedErrorV0";
		this.path = path;
		this.holder = holder;
	}
}

export interface EndoEventStoreWriterLockOptionsV0 {
	/** Optional override for the lock file path (default: `<root>/events/session-attachment.lock`). */
	readonly lockPath?: string;
	/** Optional clock for deterministic lock timestamps. */
	readonly now?: () => Date;
}

interface ParsedLockHolder {
	readonly pid: number | undefined;
	readonly attachment: string;
	readonly token: string | undefined;
}

function readLockHolder(lockPath: string): ParsedLockHolder | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		const rec = parsed as { pid?: unknown; attachment?: unknown; token?: unknown };
		const pid = typeof rec.pid === "number" && Number.isSafeInteger(rec.pid) && rec.pid > 0 ? rec.pid : undefined;
		return {
			pid,
			attachment: String(rec.attachment),
			token: typeof rec.token === "string" ? rec.token : undefined,
		};
	} catch {
		return null;
	}
}

function isPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (probe) {
		return (probe as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Take the store root's single-writer lock (`<root>/events/session-attachment.lock` by default).
 * Returns an idempotent release function that verifies token ownership before removing the lock file.
 */
export function acquireEndoEventStoreWriterLockV0(
	root: string,
	attachment: string,
	options: EndoEventStoreWriterLockOptionsV0 = {},
): () => void {
	const path = options.lockPath ?? join(root, "events", "session-attachment.lock");
	mkdirSync(dirname(path), { recursive: true });
	const now = options.now ?? (() => new Date());
	const token = randomBytes(12).toString("hex");
	const content = `${JSON.stringify({ pid: process.pid, attachment, at: now().toISOString(), token })}\n`;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			writeFileSync(path, content, { flag: "wx" });
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const current = readLockHolder(path);
				if (current !== null && current.token === token) {
					rmSync(path, { force: true });
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = readLockHolder(path);
			if (holder === null) {
				// An unreadable or malformed lock is treated as held: never silently stolen.
				throw new EndoStoreLockedErrorV0(path, "unreadable lock");
			}
			if (holder.pid === undefined || isPidAlive(holder.pid)) {
				throw new EndoStoreLockedErrorV0(path, `pid ${String(holder.pid)}, ${holder.attachment}`);
			}
			// Atomic stale-lock quarantine: rename first so we never unlink a concurrent winner's live lock.
			const stalePath = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
			try {
				renameSync(path, stalePath);
			} catch (renameErr) {
				if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") {
					// Another process already cleared the stale lock; retry wx cleanly.
					continue;
				}
				throw new EndoStoreLockedErrorV0(path, "lock contention");
			}
			const moved = readLockHolder(stalePath);
			if (moved !== null && moved.pid !== undefined && !isPidAlive(moved.pid)) {
				rmSync(stalePath, { force: true });
			} else {
				// Restore if a live lock raced in right before rename (best-effort) and fail closed.
				try {
					renameSync(stalePath, path);
				} catch {
					rmSync(stalePath, { force: true });
				}
				throw new EndoStoreLockedErrorV0(path, "lock contention");
			}
		}
	}
	throw new EndoStoreLockedErrorV0(path, "lock contention");
}
