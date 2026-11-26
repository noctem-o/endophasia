// The numbered writer lock shared by the DEVELOP operator-metadata files (`<root>/develop/tasks.json` and
// `<root>/develop/coordination.json`). Extracted unchanged from storage/develop-tasks.ts so the two files use the SAME proven
// discipline under DIFFERENT lock names (`tasks.lock.<n>`, `coordination.lock.<n>`). The two locks are never nested by any writer.
//
// The lock is a series of numbered files, `<name>.<n>`, and the HIGHEST number is the lock: its file says who holds it, or that it was
// released. A writer takes the lock by creating `n + 1` (a hard link of a finished temporary file, so the name appears whole and only one
// of several contenders can create it), then deletes the lower numbers. Nothing is ever removed or rewritten to take a lock from another
// writer, so one writer cannot take away a lock another has just acquired; a lock whose process is gone is simply superseded by the next
// number. The highest number is never deleted (a release marks it released, by an atomic rename), so a number is never reused and a slow
// contender that judged an old holder dead can only ever create a number that already exists or has been passed; if it creates a number
// that was deleted as a lower one, it sees the higher number afterwards and withdraws its own before acting.
//
// Same-host, same-uid, cooperative: liveness is `kill(pid, 0)`, and a reused pid reads as held (the lock is then `busy`, never stolen).

import { randomBytes } from "node:crypto";
import { linkSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Deterministic interleaving points for multi-process tests only. Never set in production. */
export interface EndoNumberedLockHooksV0 {
	/** After the current top lock was judged free (released or dead holder), before `top + 1` is created. */
	readonly onClaimable?: (top: number, mine: number) => void;
	/** After `mine` was created and before the numbers are listed again to confirm it is the highest. */
	readonly onCreated?: (mine: number) => void;
}

export interface EndoNumberedLockOptionsV0 {
	/** How long to wait for the lock before answering `busy`. */
	readonly waitMs: number;
	readonly now?: () => number;
	readonly hooks?: EndoNumberedLockHooksV0;
}

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const sleep = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const literal = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The names a lock called `name` uses: `<name>.<n>` and its temporary files `<name>.tmp-<pid>-<12 hex>`. */
export function endoNumberedLockPatternsV0(name: string): { lock: RegExp; temporary: RegExp } {
	return {
		lock: new RegExp(`^${literal(name)}\\.([1-9][0-9]{0,14})$`),
		temporary: new RegExp(`^${literal(name)}\\.tmp-[0-9]+-[0-9a-f]{12}$`),
	};
}

/**
 * Take the lock `<dir>/<name>.<n>`. Returns an idempotent release, `busy` when another live writer held it for `waitMs`, or `failed` when the
 * directory could not be listed or a lock file could not be made (nothing is held in either case).
 */
export function acquireEndoNumberedLockV0(
	dir: string,
	name: string,
	options: EndoNumberedLockOptionsV0,
): (() => void) | "busy" | "failed" {
	const { lock: LOCK_NUMBER } = endoNumberedLockPatternsV0(name);
	const now = options.now ?? Date.now;
	const lockPath = (n: number): string => join(dir, `${name}.${n}`);
	const lockNumbers = (): number[] | undefined => {
		try {
			const numbers: number[] = [];
			for (const entry of readdirSync(dir)) {
				const found = LOCK_NUMBER.exec(entry);
				if (found !== null) numbers.push(Number(found[1]));
			}
			return numbers;
		} catch {
			return undefined;
		}
	};
	// Whether the lock `n` is free to be superseded: released, or held by a process that is gone (or an unreadable one that is old).
	const lockState = (n: number): "free" | "held" | "gone" | "failed" => {
		const path = lockPath(n);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			return errno(error) === "ENOENT" ? "gone" : "failed";
		}
		let parsed: { pid?: unknown; released?: unknown } | undefined;
		try {
			parsed = JSON.parse(text) as { pid?: unknown; released?: unknown };
		} catch {
			parsed = undefined;
		}
		if (parsed?.released === true) return "free";
		const holder =
			typeof parsed?.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
		if (holder === undefined) {
			// Not a lock this module wrote (hand-made, damaged): it is only superseded once it is old.
			const info = lstatSync(path, { throwIfNoEntry: false });
			if (info === undefined) return "gone";
			return Date.now() - info.mtimeMs > 60_000 ? "free" : "held";
		}
		if (holder === process.pid) return "held";
		try {
			process.kill(holder, 0);
			return "held";
		} catch (probe) {
			return errno(probe) === "EPERM" ? "held" : "free";
		}
	};
	// Make lock `n` appear whole: created exclusively when it is a new lock, replaced atomically when it is the release of one's own.
	const createLock = (n: number, release: boolean): "created" | "exists" | "failed" => {
		const temporary = join(dir, `${name}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
		const content = `${JSON.stringify(release ? { released: true } : { pid: process.pid, at: new Date(now()).toISOString() })}\n`;
		try {
			writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
			if (release) renameSync(temporary, lockPath(n));
			else linkSync(temporary, lockPath(n));
			return "created";
		} catch (error) {
			return !release && errno(error) === "EEXIST" ? "exists" : "failed";
		} finally {
			rmSync(temporary, { force: true });
		}
	};

	const deadline = Date.now() + options.waitMs;
	for (;;) {
		const numbers = lockNumbers();
		if (numbers === undefined) return "failed";
		const top = numbers.length === 0 ? 0 : Math.max(...numbers);
		let claimable = top === 0;
		if (top > 0) {
			const state = lockState(top);
			if (state === "gone") continue;
			if (state === "failed") return "failed";
			claimable = state === "free";
		}
		if (claimable) {
			const mine = top + 1;
			options.hooks?.onClaimable?.(top, mine);
			const made = createLock(mine, false);
			if (made === "failed") return "failed";
			if (made === "created") {
				options.hooks?.onCreated?.(mine);
				// Someone may have created a higher number than ours while ours was not there (ours was deleted as a lower one, then
				// created again by a slow contender): then ours is not the lock, and is withdrawn.
				const after = lockNumbers();
				if (after === undefined) {
					rmSync(lockPath(mine), { force: true });
					return "failed";
				}
				if (after.some((n) => n > mine)) rmSync(lockPath(mine), { force: true });
				else {
					for (const n of after) if (n < mine) rmSync(lockPath(n), { force: true });
					let released = false;
					return () => {
						if (released) return;
						released = true;
						// Marked released, never deleted: the highest number must stay.
						if (createLock(mine, true) === "failed") rmSync(lockPath(mine), { force: true });
					};
				}
			}
			if (Date.now() < deadline) continue;
		}
		if (Date.now() >= deadline) return "busy";
		sleep(20);
	}
}
