/**
 * Shared single-writer lock for the durable event store (`<root>/events/session-attachment.lock`).
 *
 * Host infrastructure: node:fs and node:path only. Shared across Pi (`adapters/pi/attachment.ts`) and Codex
 * (`adapters/codex/develop-adapter.ts`) so two live attachments never concurrently write `<root>/events/events.log`.
 *
 * Fail-closed rules preserved identically from Pi's original lock:
 * - Exclusive atomic create (`flag: "wx"`).
 * - Unreadable or malformed lock files are treated as held (never silently stolen).
 * - Locks without a finite integer `pid` (including any future non-PID format sentinel) are treated as held.
 * - Live PIDs (including EPERM or this process's own PID) are refused with `EndoStoreLockedErrorV0`.
 * - Only a verified dead numeric PID lock is removed and retried.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Take the store root's single-writer lock (`<root>/events/session-attachment.lock` by default).
 * Returns an idempotent release function that removes the lock file.
 */
export function acquireEndoEventStoreWriterLockV0(
	root: string,
	attachment: string,
	options: EndoEventStoreWriterLockOptionsV0 = {},
): () => void {
	const path = options.lockPath ?? join(root, "events", "session-attachment.lock");
	mkdirSync(dirname(path), { recursive: true });
	const now = options.now ?? (() => new Date());
	const content = `${JSON.stringify({ pid: process.pid, attachment, at: now().toISOString() })}\n`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeFileSync(path, content, { flag: "wx" });
			let released = false;
			return () => {
				if (released) return;
				released = true;
				rmSync(path, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let holder: { pid?: unknown; attachment?: unknown } = {};
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					throw new Error("not an object");
				}
				holder = parsed as { pid?: unknown; attachment?: unknown };
			} catch {
				// An unreadable or malformed lock is treated as held: never silently stolen.
				throw new EndoStoreLockedErrorV0(path, "unreadable lock");
			}
			const pid =
				typeof holder.pid === "number" && Number.isSafeInteger(holder.pid) && holder.pid > 0
					? holder.pid
					: undefined;
			let alive = pid === process.pid;
			if (pid !== undefined && !alive) {
				try {
					process.kill(pid, 0);
					alive = true;
				} catch (probe) {
					alive = (probe as NodeJS.ErrnoException).code === "EPERM";
				}
			}
			if (alive || pid === undefined) {
				throw new EndoStoreLockedErrorV0(path, `pid ${String(pid)}, ${String(holder.attachment)}`);
			}
			rmSync(path, { force: true });
		}
	}
	throw new EndoStoreLockedErrorV0(path, "lock contention");
}
