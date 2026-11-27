/**
 * Deterministic multi-process concurrency & TOCTOU regression tests for `storage/writer-lock.ts`.
 *
 * Spawns real separate OS Node processes (distinct PIDs) synchronized via barrier files — zero probabilistic sleeps —
 * proving that the 5-step rename/restore TOCTOU race and mid-recovery unlink races are structurally impossible.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireEndoEventStoreWriterLockV0, EndoStoreLockedErrorV0 } from "../storage/writer-lock.ts";
import { waitForBarrierFile, waitForJsonBarrier, writeFileAtomicallySync } from "./helpers/atomic-barrier.ts";

const WRITER_LOCK_MODULE = fileURLToPath(new URL("../storage/writer-lock.ts", import.meta.url));
const ATOMIC_BARRIER_MODULE = fileURLToPath(new URL("./helpers/atomic-barrier.ts", import.meta.url));

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

function makeTempDir(prefix = "endo-wlock-mp-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	// Ensure all child workers are terminated and reaped before removing fixture directories.
	const children = spawnedChildren.splice(0);
	await Promise.all(
		children.map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
						resolve();
						return;
					}
					const done = () => resolve();
					child.once("close", done);
					child.once("error", done);
					try {
						child.kill("SIGKILL");
					} catch {
						resolve();
					}
				}),
		),
	);
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

interface WorkerResult {
	readonly status: "acquired" | "locked" | "error";
	readonly pid: number;
	readonly token?: string;
	readonly holder?: string;
	readonly recoveryHint?: string | null;
	readonly message?: string;
}

function spawnLockWorker(config: {
	readonly root: string;
	readonly attachment: string;
	readonly resultFile: string;
	readonly readyFile?: string;
	readonly startBarrier?: string;
	readonly holdUntilFile?: string;
	readonly acquiredBarrier?: string;
	readonly beforeRecoverSignal?: string;
	readonly beforeRecoverWait?: string;
	readonly afterUnlinkSignal?: string;
	readonly afterUnlinkWait?: string;
}): { child: ReturnType<typeof spawn>; done: Promise<WorkerResult> } {
	const script = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireEndoEventStoreWriterLockV0, EndoStoreLockedErrorV0 } from ${JSON.stringify(WRITER_LOCK_MODULE)};
import { writeFileAtomicallySync, writeJsonAtomicallySync } from ${JSON.stringify(ATOMIC_BARRIER_MODULE)};

const cfg = JSON.parse(process.env.ENDO_LOCK_WORKER_CFG);
const sleepSync = (ms) => {
	const sab = new SharedArrayBuffer(4);
	const arr = new Int32Array(sab);
	Atomics.wait(arr, 0, 0, ms);
};
const waitFileSync = (file) => {
	const deadline = Date.now() + 15000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error("worker timed out waiting for " + file);
		sleepSync(5);
	}
};

if (cfg.readyFile) writeFileAtomicallySync(cfg.readyFile, String(process.pid));
if (cfg.startBarrier) waitFileSync(cfg.startBarrier);

let out;
try {
	const release = acquireEndoEventStoreWriterLockV0(cfg.root, cfg.attachment, {
		testHooks: {
			onBeforeRecoveryBarrier: cfg.beforeRecoverSignal
				? () => {
						writeFileAtomicallySync(cfg.beforeRecoverSignal, String(process.pid));
						if (cfg.beforeRecoverWait) waitFileSync(cfg.beforeRecoverWait);
					}
				: undefined,
			onAfterStaleUnlink: cfg.afterUnlinkSignal
				? () => {
						writeFileAtomicallySync(cfg.afterUnlinkSignal, String(process.pid));
						if (cfg.afterUnlinkWait) waitFileSync(cfg.afterUnlinkWait);
					}
				: undefined,
		},
	});
	const lockRaw = JSON.parse(readFileSync(join(cfg.root, "events", "session-attachment.lock"), "utf8"));
	out = { status: "acquired", pid: process.pid, token: lockRaw.token };
	if (cfg.acquiredBarrier) writeJsonAtomicallySync(cfg.acquiredBarrier, out);
	if (cfg.holdUntilFile) waitFileSync(cfg.holdUntilFile);
	release();
} catch (error) {
	if (error instanceof EndoStoreLockedErrorV0) {
		out = {
			status: "locked",
			pid: process.pid,
			holder: error.holder,
			recoveryHint: error.recoveryHint,
			message: error.message,
		};
	} else {
		out = { status: "error", pid: process.pid, message: String(error?.stack ?? error) };
	}
}
writeJsonAtomicallySync(cfg.resultFile, out);
`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		env: {
			PATH: process.env.PATH ?? "",
			ENDO_LOCK_WORKER_CFG: JSON.stringify(config),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	spawnedChildren.push(child);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const done = new Promise<WorkerResult>((resolve, reject) => {
		child.on("close", (code) => {
			if (!existsSync(config.resultFile)) {
				reject(new Error(`Lock worker exited (${String(code)}) without writing result. stderr=${stderr}`));
				return;
			}
			try {
				resolve(JSON.parse(readFileSync(config.resultFile, "utf8")) as WorkerResult);
			} catch (error) {
				reject(new Error(`Lock worker wrote unreadable result (${String(error)}). stderr=${stderr}`));
			}
		});
		child.on("error", reject);
	});
	// Avoid unhandled rejection noise if afterEach SIGKILLs a live worker after an earlier assertion failed.
	done.catch(() => {});
	return { child, done };
}

describe("storage/writer-lock.ts deterministic multi-process TOCTOU & exclusivity", () => {
	it("is immune to the 5-step stale-lock interleaving across 3 real OS processes (A observes stale, B recovers & holds, A resumes, C contests)", async () => {
		const root = makeTempDir("endo-wlock-5step-");
		const barriers = makeTempDir("endo-wlock-barriers-");
		const lockPath = join(root, "events", "session-attachment.lock");
		const recoverPath = `${lockPath}.recover`;
		mkdirSync(join(root, "events"), { recursive: true });
		// Seed a stale dead-PID lock.
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, attachment: "dead.proc", at: "2026-01-01T00:00:00Z" }),
		);

		// Step 1: Process A observes the stale lock and deterministically pauses BEFORE recovery barrier.
		const aPaused = join(barriers, "a-paused");
		const aResume = join(barriers, "a-resume");
		const workerA = spawnLockWorker({
			root,
			attachment: "codex.proc-a",
			resultFile: join(barriers, "res-a.json"),
			beforeRecoverSignal: aPaused,
			beforeRecoverWait: aResume,
		});
		await waitForBarrierFile(aPaused);

		// Step 2: Process B recovers the stale lock, acquires live lock B, and holds it.
		const bAcquired = join(barriers, "b-acquired");
		const bRelease = join(barriers, "b-release");
		const workerB = spawnLockWorker({
			root,
			attachment: "pi.proc-b",
			resultFile: join(barriers, "res-b.json"),
			acquiredBarrier: bAcquired,
			holdUntilFile: bRelease,
		});
		const bInfo = await waitForJsonBarrier<WorkerResult>(bAcquired);
		expect(bInfo.status).toBe("acquired");
		const bLockRawBeforeA = readFileSync(lockPath, "utf8");

		// Step 3: Resume Process A — under the old rename/restore implementation, A would rename B's live lock away!
		writeFileAtomicallySync(aResume, "go");
		const resA = await workerA.done;
		expect(resA.status).toBe("locked");
		// Process B's lock file MUST remain byte-for-byte intact and `.recover` MUST be cleaned up!
		expect(readFileSync(lockPath, "utf8")).toBe(bLockRawBeforeA);
		expect(existsSync(recoverPath)).toBe(false);

		// Step 4: Process C contests while B still holds the lock — MUST fail closed!
		const workerC = spawnLockWorker({
			root,
			attachment: "codex.proc-c",
			resultFile: join(barriers, "res-c.json"),
		});
		const resC = await workerC.done;
		expect(resC.status).toBe("locked");
		expect(readFileSync(lockPath, "utf8")).toBe(bLockRawBeforeA);

		// Step 5: Release Process B — lock cleanly removed.
		writeFileAtomicallySync(bRelease, "done");
		const resB = await workerB.done;
		expect(resB.status).toBe("acquired");
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(recoverPath)).toBe(false);
	});

	it("preserves single-winner exclusivity when Process C claims lockPath immediately after Process A unlinks the dead lock", async () => {
		const root = makeTempDir("endo-wlock-postunlink-");
		const barriers = makeTempDir("endo-wlock-pu-barriers-");
		const lockPath = join(root, "events", "session-attachment.lock");
		const recoverPath = `${lockPath}.recover`;
		mkdirSync(join(root, "events"), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, attachment: "dead.proc", at: "2026-01-01T00:00:00Z" }),
		);

		// Process A acquires `.recover`, unlinks dead lock, then pauses right before `wx`.
		const aUnlinked = join(barriers, "a-unlinked");
		const aResumeClaim = join(barriers, "a-resume-claim");
		const workerA = spawnLockWorker({
			root,
			attachment: "codex.proc-a",
			resultFile: join(barriers, "res-a.json"),
			afterUnlinkSignal: aUnlinked,
			afterUnlinkWait: aResumeClaim,
		});
		await waitForBarrierFile(aUnlinked);
		expect(existsSync(recoverPath)).toBe(true);

		// Process C arrives while lockPath is vacant and wins atomic `wx` cleanly.
		const cAcquired = join(barriers, "c-acquired");
		const cRelease = join(barriers, "c-release");
		const workerC = spawnLockWorker({
			root,
			attachment: "pi.proc-c",
			resultFile: join(barriers, "res-c.json"),
			acquiredBarrier: cAcquired,
			holdUntilFile: cRelease,
		});
		const cInfo = await waitForJsonBarrier<WorkerResult>(cAcquired);
		expect(cInfo.status).toBe("acquired");
		const cLockRaw = readFileSync(lockPath, "utf8");

		// Resume Process A: its `wx` gets EEXIST, it releases `.recover`, and it NEVER touches C's lock!
		writeFileAtomicallySync(aResumeClaim, "go");
		const resA = await workerA.done;
		expect(resA.status).toBe("locked");
		expect(readFileSync(lockPath, "utf8")).toBe(cLockRaw);
		expect(existsSync(recoverPath)).toBe(false);

		writeFileAtomicallySync(cRelease, "done");
		const resC = await workerC.done;
		expect(resC.status).toBe("acquired");
		expect(existsSync(lockPath)).toBe(false);
	});

	it("admits exactly one winner among 6 real OS processes simultaneously contesting a dead-PID stale lock", async () => {
		const root = makeTempDir("endo-wlock-6proc-");
		const barriers = makeTempDir("endo-wlock-6-barriers-");
		const lockPath = join(root, "events", "session-attachment.lock");
		mkdirSync(join(root, "events"), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, attachment: "dead.proc", at: "2026-01-01T00:00:00Z" }),
		);

		const startBarrier = join(barriers, "go");
		const holdUntilFile = join(barriers, "release-all");
		const workers = Array.from({ length: 6 }, (_, i) =>
			spawnLockWorker({
				root,
				attachment: i % 2 === 0 ? `codex.w${i}` : `pi.w${i}`,
				readyFile: join(barriers, `ready-${i}`),
				resultFile: join(barriers, `res-${i}.json`),
				startBarrier,
				holdUntilFile,
				acquiredBarrier: join(barriers, `acq-${i}.json`),
			}),
		);

		// Wait until ALL 6 OS processes have loaded the module and reached the start barrier before firing `go`.
		await Promise.all(workers.map((_, i) => waitForBarrierFile(join(barriers, `ready-${i}`), 10_000)));
		writeFileAtomicallySync(startBarrier, "go");

		// Wait until 1 winner announces acquisition AND all 5 other processes have written their refusal results
		// while the winner is STILL holding the lock! Abort losing waiters immediately once a winner emerges.
		const acqController = new AbortController();
		let winnerInfo: WorkerResult;
		try {
			winnerInfo = await Promise.any(
				workers.map((_, i) =>
					waitForJsonBarrier<WorkerResult>(join(barriers, `acq-${i}.json`), 10_000, 10, acqController.signal),
				),
			);
		} finally {
			acqController.abort();
		}
		const winnerIndex = workers.findIndex((_, i) => existsSync(join(barriers, `acq-${i}.json`)));
		await Promise.all(
			workers.map((_, i) =>
				i === winnerIndex ? Promise.resolve("") : waitForBarrierFile(join(barriers, `res-${i}.json`), 10_000),
			),
		);
		const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
		expect(onDisk.pid).toBe(winnerInfo.pid);
		expect(onDisk.token).toBe(winnerInfo.token);

		writeFileAtomicallySync(holdUntilFile, "done");
		const results = await Promise.all(workers.map((w) => w.done));
		const winners = results.filter((r) => r.status === "acquired");
		const locked = results.filter((r) => r.status === "locked");
		const errors = results.filter((r) => r.status === "error");
		expect(errors).toEqual([]);
		expect(winners).toHaveLength(1);
		expect(locked).toHaveLength(5);
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(`${lockPath}.recover`)).toBe(false);
	});

	it("deterministic barrier regression: non-atomic creation exposes empty/partial JSON while atomic rename never does", async () => {
		const dir = makeTempDir("endo-wlock-barrier-repro-");
		// 1. Reproduce the former non-atomic open-then-write race deterministically:
		// a file created via open(O_CREAT) before its bytes are written is visible to `existsSync` as empty JSON.
		const nonAtomic = join(dir, "non-atomic.json");
		const fd = openSync(nonAtomic, "w");
		try {
			expect(existsSync(nonAtomic)).toBe(true);
			expect(() => JSON.parse(readFileSync(nonAtomic, "utf8"))).toThrow(SyntaxError);
			writeSync(fd, '{"status":"acq');
			expect(() => JSON.parse(readFileSync(nonAtomic, "utf8"))).toThrow(SyntaxError);
		} finally {
			closeSync(fd);
		}

		// 2. Prove atomic same-directory temp + rename never exposes an empty or partial payload to concurrent readers.
		const atomicPath = join(dir, "atomic.json");
		const payload = { status: "acquired" as const, pid: process.pid, token: "t".repeat(128) };
		const waiting = waitForJsonBarrier<WorkerResult>(atomicPath, 5_000, 1);
		// Delay publication slightly so the reader actively polls across ENOENT before rename lands.
		setTimeout(() => writeFileAtomicallySync(atomicPath, JSON.stringify(payload)), 20);
		await expect(waiting).resolves.toEqual(payload);
	});

	it("fails closed with explicit recovery instructions on stuck .recover barriers, malformed locks, and E4 non-PID sentinels", () => {
		const root = makeTempDir("endo-wlock-hints-");
		const lockPath = join(root, "events", "session-attachment.lock");
		const recoverPath = `${lockPath}.recover`;
		mkdirSync(join(root, "events"), { recursive: true });

		// 1. Stuck `.recover` barrier (e.g. crash mid-recovery): NEVER stolen automatically!
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, attachment: "dead.proc", at: "2026-01-01T00:00:00Z" }),
		);
		writeFileSync(recoverPath, JSON.stringify({ pid: 999_999_998, attachment: "crashed.recover", token: "abc" }));
		let stuckErr: unknown;
		try {
			acquireEndoEventStoreWriterLockV0(root, "codex.test");
		} catch (e) {
			stuckErr = e;
		}
		expect(stuckErr).toBeInstanceOf(EndoStoreLockedErrorV0);
		expect((stuckErr as EndoStoreLockedErrorV0).recoveryHint).toContain(recoverPath);
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(recoverPath)).toBe(true);
		rmSync(recoverPath, { force: true });

		// 2. Malformed lock file: fail closed with explicit recovery hint.
		writeFileSync(lockPath, "{not-valid-json");
		let malformedErr: unknown;
		try {
			acquireEndoEventStoreWriterLockV0(root, "codex.test");
		} catch (e) {
			malformedErr = e;
		}
		expect(malformedErr).toBeInstanceOf(EndoStoreLockedErrorV0);
		expect((malformedErr as EndoStoreLockedErrorV0).recoveryHint).toContain(lockPath);
		expect(existsSync(lockPath)).toBe(true);

		// 3. Future E4 non-PID store-format barrier: fail closed with explicit hint, never removed.
		writeFileSync(lockPath, JSON.stringify({ format: "per-attachment-v1", attachment: "e4-per-attachment-store" }));
		let e4Err: unknown;
		try {
			acquireEndoEventStoreWriterLockV0(root, "codex.test");
		} catch (e) {
			e4Err = e;
		}
		expect(e4Err).toBeInstanceOf(EndoStoreLockedErrorV0);
		expect((e4Err as EndoStoreLockedErrorV0).holder).toContain("e4-per-attachment-store");
		expect((e4Err as EndoStoreLockedErrorV0).recoveryHint).toContain(lockPath);
		expect(existsSync(lockPath)).toBe(true);

		// 4. Out-of-range PID (> 32-bit pid_t max 0x7fffffff) fails closed instead of treating EINVAL/RangeError as dead!
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 9_000_000_000, attachment: "bogus.pid", at: "2026-01-01T00:00:00Z" }),
		);
		expect(() => acquireEndoEventStoreWriterLockV0(root, "codex.test")).toThrow(EndoStoreLockedErrorV0);
		expect(existsSync(lockPath)).toBe(true);
	});
});
