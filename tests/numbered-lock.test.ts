// The numbered lock shared by tasks.json and coordination.json (extracted unchanged from storage/develop-tasks.ts). The hooks make the
// two races the lock is designed around happen on demand, in one process, with no sleeps: a contender that takes the lock between another's
// judgement and its claim, and a slow contender whose number appears above a lock that was just created.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireEndoNumberedLockV0, endoNumberedLockPatternsV0 } from "../storage/numbered-lock.ts";

const dirs: string[] = [];
const fresh = () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-numbered-lock-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NAME = "coordination.lock";
const locks = (dir: string) =>
	readdirSync(dir)
		.filter((n) => endoNumberedLockPatternsV0(NAME).lock.test(n))
		.sort();
const take = (dir: string, waitMs = 0, hooks = {}) => acquireEndoNumberedLockV0(dir, NAME, { waitMs, hooks });
const deadPid = () =>
	Number(
		spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout,
	);

describe("the numbered lock", () => {
	it("takes 1, refuses a second holder, and leaves the highest number marked released", () => {
		const dir = fresh();
		const release = take(dir);
		expect(typeof release).toBe("function");
		expect(take(dir)).toBe("busy");
		(release as () => void)();
		expect(locks(dir)).toEqual([`${NAME}.1`]);
		expect(JSON.parse(readFileSync(join(dir, `${NAME}.1`), "utf8"))).toEqual({ released: true });
		const again = take(dir);
		expect(locks(dir)).toEqual([`${NAME}.2`]);
		(again as () => void)();
	});

	it("supersedes the lock of a process that is gone, without deleting or rewriting it first", () => {
		const dir = fresh();
		writeFileSync(join(dir, `${NAME}.7`), JSON.stringify({ pid: deadPid(), at: "x" }));
		const release = take(dir);
		expect(typeof release).toBe("function");
		expect(locks(dir)).toEqual([`${NAME}.8`]);
		(release as () => void)();
	});

	it("a damaged lock is held while young and superseded once old", () => {
		const dir = fresh();
		const path = join(dir, `${NAME}.3`);
		writeFileSync(path, "garbage");
		expect(take(dir)).toBe("busy");
		const old = (Date.now() - 120_000) / 1000;
		utimesSync(path, old, old);
		const release = take(dir);
		expect(locks(dir)).toEqual([`${NAME}.4`]);
		(release as () => void)();
	});

	it("a contender that takes the lock between the judgement and the claim wins; the other never also holds it", () => {
		const dir = fresh();
		(take(dir) as () => void)();
		let other: ReturnType<typeof take> | undefined;
		const mine = take(dir, 0, {
			onClaimable: (top: number, next: number) => {
				expect([top, next]).toEqual([1, 2]);
				other = take(dir);
			},
		});
		expect(typeof other).toBe("function");
		expect(mine).toBe("busy");
		expect(locks(dir)).toEqual([`${NAME}.2`]);
		(other as () => void)();
		const after = take(dir);
		expect(locks(dir)).toEqual([`${NAME}.3`]);
		(after as () => void)();
	});

	it("a lock that sees a higher number appear after it was created withdraws itself", () => {
		const dir = fresh();
		const mine = take(dir, 0, {
			onCreated: (n: number) => {
				// A slow contender's number, above ours, held by a live process (this one).
				writeFileSync(join(dir, `${NAME}.${n + 1}`), JSON.stringify({ pid: process.pid, at: "x" }));
			},
		});
		expect(mine).toBe("busy");
		expect(locks(dir)).toEqual([`${NAME}.2`]);
	});

	it("an unlistable directory fails rather than pretending to hold", () => {
		expect(acquireEndoNumberedLockV0(join(fresh(), "missing"), NAME, { waitMs: 0 })).toBe("failed");
	});
});
