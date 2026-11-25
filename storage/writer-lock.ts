/**
 * Shared single-writer lock for the durable event store (`<root>/events/session-attachment.lock`).
 *
 * Host infrastructure: node:fs, node:crypto, and node:path only. Shared across Pi (`adapters/pi/attachment.ts`) and
 * Codex (`adapters/codex/develop-adapter.ts`) so two live attachments never concurrently write `<root>/events/events.log`.
 *
 * Concurrency & fail-closed invariants (Remediation #2 — zero-rename, zero-overwrite stale recovery):
 * - Primary acquisition is a single kernel-atomic create (`flag: "wx"`) embedding a per-lock random `token`.
 * - Unreadable or malformed lock files fail closed (never silently stolen) with explicit recovery instructions.
 * - Locks without a finite positive integer `pid` (including any future E4 non-PID store-format barrier) fail closed
 *   (never stolen).
 * - Live PIDs (including `EPERM` or this process's own PID) fail closed with `EndoStoreLockedErrorV0`.
 * - Dead-PID stale recovery NEVER renames or overwrites `lockPath` (eliminating the rename-and-restore TOCTOU race
 *   where Process A could move Process B's live replacement lock and overwrite Process C's lock):
 *     1. Acquire a dedicated exclusive recovery barrier (`<lockPath>.recover`, `flag: "wx"`). If `.recover` already
 *        exists, fail closed immediately (NEVER automatically steal `.recover`) with explicit recovery instructions.
 *     2. While holding `.recover`, re-read `<lockPath>`. Only if `<lockPath>` is byte-for-byte identical to the
 *        observed dead-PID lock AND its PID is still dead may `<lockPath>` be unlinked.
 *     3. Attempt one fresh atomic `wx` create of `<lockPath>`. If another process cleanly won `wx` after unlink,
 *        fail closed without touching the winner's lock.
 *     4. Always release `.recover` via token-checked removal in `finally`.
 * - Release verifies ownership (`token`) before unlinking `<lockPath>`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Thrown when another live session attachment already holds the store's writer lock (or recovery is blocked). */
export class EndoStoreLockedErrorV0 extends Error {
	readonly path: string;
	readonly holder: string;
	readonly recoveryHint: string | null;

	constructor(path: string, holder: string, recoveryHint: string | null = null) {
		super(
			recoveryHint === null
				? `another Endophasia session attachment (${holder}) is writing this store; lock ${path}`
				: `another Endophasia session attachment (${holder}) is writing this store; lock ${path}. ${recoveryHint}`,
		);
		this.name = "EndoStoreLockedErrorV0";
		this.path = path;
		this.holder = holder;
		this.recoveryHint = recoveryHint;
	}
}

/** Optional synchronization hooks for deterministic multi-process race tests (unused in production). */
export interface EndoEventStoreWriterLockTestHooksV0 {
	/** Called after observing a dead-PID stale lock and BEFORE attempting to acquire `<lockPath>.recover`. */
	readonly onBeforeRecoveryBarrier?: () => void;
	/** Called inside `<lockPath>.recover` right AFTER unlinking the verified dead lock and BEFORE `wx` create. */
	readonly onAfterStaleUnlink?: () => void;
}

export interface EndoEventStoreWriterLockOptionsV0 {
	/** Optional override for the lock file path (default: `<root>/events/session-attachment.lock`). */
	readonly lockPath?: string;
	/** Optional clock for deterministic lock timestamps. */
	readonly now?: () => Date;
	/** Optional synchronization hooks for deterministic race testing only. */
	readonly testHooks?: EndoEventStoreWriterLockTestHooksV0;
}

interface ParsedLockHolder {
	readonly pid: number | undefined;
	readonly attachment: string;
	readonly token: string | undefined;
}

type ReadLockResult =
	| { readonly state: "missing" }
	| { readonly state: "malformed"; readonly raw: string | null }
	| { readonly state: "ok"; readonly raw: string; readonly holder: ParsedLockHolder };

function readLock(lockPath: string): ReadLockResult {
	let raw: string;
	try {
		raw = readFileSync(lockPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
		return { state: "malformed", raw: null };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { state: "malformed", raw };
		}
		const rec = parsed as { pid?: unknown; attachment?: unknown; token?: unknown };
		const pid =
			typeof rec.pid === "number" && Number.isSafeInteger(rec.pid) && rec.pid > 0 && rec.pid <= 0x7fffffff
				? rec.pid
				: undefined;
		return {
			state: "ok",
			raw,
			holder: {
				pid,
				attachment: String(rec.attachment),
				token: typeof rec.token === "string" ? rec.token : undefined,
			},
		};
	} catch {
		return { state: "malformed", raw };
	}
}

function isPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (probe) {
		// Fail closed: ONLY ESRCH proves the process does not exist; EPERM/EINVAL/other errors treat PID as held.
		return (probe as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function makeRelease(path: string, token: string): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = readLock(path);
		if (current.state === "ok" && current.holder.token === token) {
			rmSync(path, { force: true });
		}
	};
}

function manualRecoveryHint(lockPath: string, extraPath?: string): string {
	const files = extraPath === undefined ? lockPath : `${lockPath} and ${extraPath}`;
	return `Verify no Endophasia session (Pi or Codex) is writing this store before manually removing ${files}.`;
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

	// Fast path: single atomic O_CREAT|O_EXCL create.
	try {
		writeFileSync(path, content, { flag: "wx" });
		return makeRelease(path, token);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}

	// Lock exists: inspect without modifying it.
	const observed = readLock(path);
	if (observed.state === "missing") {
		// Disappeared between wx and read; try one clean wx without any unlink.
		try {
			writeFileSync(path, content, { flag: "wx" });
			return makeRelease(path, token);
		} catch (retryErr) {
			if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
				throw new EndoStoreLockedErrorV0(path, "concurrent writer");
			}
			throw retryErr;
		}
	}
	if (observed.state === "malformed") {
		// Unreadable or malformed lock is treated as held (never silently stolen).
		throw new EndoStoreLockedErrorV0(path, "unreadable lock", manualRecoveryHint(path));
	}
	if (observed.holder.pid === undefined) {
		// Non-PID barrier (including future E4 per-attachment format sentinel): never automatically stolen.
		throw new EndoStoreLockedErrorV0(
			path,
			`non-PID lock barrier (${observed.holder.attachment})`,
			`This lock carries no owner PID (for example, a newer store format barrier) and will not be automatically cleared. ${manualRecoveryHint(path)}`,
		);
	}
	if (isPidAlive(observed.holder.pid)) {
		throw new EndoStoreLockedErrorV0(path, `pid ${String(observed.holder.pid)}, ${observed.holder.attachment}`);
	}

	// Observed PID is dead. Serialize stale-lock cleanup behind an exclusive, non-stealable `.recover` barrier.
	options.testHooks?.onBeforeRecoveryBarrier?.();
	const recoverPath = `${path}.recover`;
	const recoverToken = randomBytes(12).toString("hex");
	const recoverContent = `${JSON.stringify({ pid: process.pid, attachment, at: now().toISOString(), token: recoverToken, purpose: "stale-lock-recovery" })}\n`;
	try {
		writeFileSync(recoverPath, recoverContent, { flag: "wx" });
	} catch (recoverErr) {
		if ((recoverErr as NodeJS.ErrnoException).code === "EEXIST") {
			throw new EndoStoreLockedErrorV0(
				path,
				`stale-lock recovery already active (${recoverPath})`,
				manualRecoveryHint(path, recoverPath),
			);
		}
		throw recoverErr;
	}

	try {
		// Re-read `path` while exclusively holding `.recover`. Never touch `path` unless it is still byte-for-byte
		// identical to the observed dead lock AND its PID is still dead.
		const rechecked = readLock(path);
		if (rechecked.state === "ok") {
			if (rechecked.raw !== observed.raw || rechecked.holder.pid === undefined || isPidAlive(rechecked.holder.pid)) {
				if (rechecked.holder.pid === undefined) {
					throw new EndoStoreLockedErrorV0(
						path,
						`non-PID lock barrier (${rechecked.holder.attachment})`,
						`This lock carries no owner PID (for example, a newer store format barrier) and will not be automatically cleared. ${manualRecoveryHint(path)}`,
					);
				}
				throw new EndoStoreLockedErrorV0(
					path,
					`pid ${String(rechecked.holder.pid)}, ${rechecked.holder.attachment}`,
				);
			}
			rmSync(path, { force: true });
			options.testHooks?.onAfterStaleUnlink?.();
		} else if (rechecked.state === "malformed") {
			// `.recover` is removed by `finally` below, so only `path` needs manual inspection/removal.
			throw new EndoStoreLockedErrorV0(path, "unreadable lock", manualRecoveryHint(path));
		}
		// Now either `path` was missing or we just unlinked the verified dead lock. Attempt one atomic `wx`.
		try {
			writeFileSync(path, content, { flag: "wx" });
			return makeRelease(path, token);
		} catch (claimErr) {
			if ((claimErr as NodeJS.ErrnoException).code === "EEXIST") {
				const winner = readLock(path);
				if (winner.state === "ok" && winner.holder.pid === undefined) {
					throw new EndoStoreLockedErrorV0(
						path,
						`non-PID lock barrier (${winner.holder.attachment})`,
						`This lock carries no owner PID (for example, a newer store format barrier) and will not be automatically cleared. ${manualRecoveryHint(path)}`,
					);
				}
				const holderDesc =
					winner.state === "ok"
						? `pid ${String(winner.holder.pid)}, ${winner.holder.attachment}`
						: "concurrent writer";
				throw new EndoStoreLockedErrorV0(path, holderDesc);
			}
			throw claimErr;
		}
	} finally {
		const currentRecover = readLock(recoverPath);
		if (currentRecover.state === "ok" && currentRecover.holder.token === recoverToken) {
			rmSync(recoverPath, { force: true });
		}
	}
}
