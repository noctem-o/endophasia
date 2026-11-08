// LIVE-PROCESS-CONTAINMENT-001 (docs/live-process-containment.md): a live harness process, and everything it starts, is owned through a
// systemd user scope where the host has a user manager; its cleanup is reported as confirmed only when the scope is stopped and its
// cgroup is empty. A harness's exit is never reported as its cleanup.
//
// Real containment needs a systemd user manager (this suite detects one and says so when it skips); GitHub's runners have none, so
// there only the uncontained reproduction, the reporting and the end-to-end attach in its uncontained form run.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type ProcessCleanupV0, ProcessGroupV0, type ProcessScopeV0 } from "../adapters/rpc-jsonl/process-group.ts";
import { RpcConnectionV0 } from "../adapters/rpc-jsonl/rpc-connection.ts";
import { detectContainmentV0, liveScopesV0, liveScopeV0, stopScopeV0 } from "../adapters/sandbox/containment.ts";
import { describeProcessCleanupV0, liveContainmentV0 } from "../cli/process-cleanup.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const CONTROLLER = fileURLToPath(new URL("./fixtures/live-scope-controller.ts", import.meta.url));
const linux = process.platform === "linux" && existsSync("/proc/self/stat");
const detected = linux ? await detectContainmentV0() : null;
const contained = detected?.ok === true ? detected.containment : null;

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
/** Running, not a zombie: a killed process whose parent is gone may stay a zombie until it is reaped, and a zombie runs nothing. */
const running = (pid: number): boolean => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] as string);
	} catch {
		return false;
	}
};
/** A process this test started and must not leave behind, whatever an assertion did. */
const owned = (pid: number) =>
	cleanup.push(() => {
		if (running(pid))
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
	});
const until = async (condition: () => boolean, ms = 10_000) => {
	const deadline = Date.now() + ms;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	return condition();
};
/** A command that starts a detached descendant (its own process group, as Pi's bash tool does), writes its pid, and stays. */
const startsDetached = (pidFile: string, extra = "") =>
	`${extra} const c = require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }); c.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
const descendantOf = async (pidFile: string) => {
	expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "")).toBe(true);
	const pid = Number(readFileSync(pidFile, "utf8"));
	owned(pid);
	return pid;
};
const unitActive = (unit: string) => contained !== null && liveScopesV0(contained).some((scope) => scope.unit === unit);

describe.runIf(linux)("LIVE-PROCESS-CONTAINMENT-001: the gap, reproduced without a scope", () => {
	it("a detached descendant outlives the process group's release, and the cleanup says unverified, never confirmed", async () => {
		const pidFile = join(temp("endo-lpc-repro-"), "descendant.pid");
		const group = new ProcessGroupV0(process.execPath, ["-e", startsDetached(pidFile)], {
			cwd: tmpdir(),
			env: { PATH: process.env.PATH ?? "" },
			stderr: "ignore",
		});
		const descendant = await descendantOf(pidFile);
		const result = await group.release();
		expect(result).toEqual({ boundary: "process-group", result: "unverified" });
		// What WORK-CYCLE-001B observed with Pi's bash tool: the group is gone, the detached descendant is not.
		expect(running(descendant)).toBe(true);
		expect(describeProcessCleanupV0([result])[0]).toMatch(/UNVERIFIED/);
	});
});

describe.runIf(contained !== null)(
	`LIVE-PROCESS-CONTAINMENT-001: a live scope (systemd user manager: ${detected?.ok ? "present" : (detected?.detail ?? "not Linux")})`,
	() => {
		const c = contained as NonNullable<typeof contained>;

		it("release ends a detached descendant and a setsid one, confirms the scope empty, and the manager forgets it", async () => {
			const dir = temp("endo-lpc-release-");
			const pidFile = join(dir, "descendant.pid");
			const setsidFile = join(dir, "setsid.pid");
			const scope = liveScopeV0(c);
			const group = new ProcessGroupV0(
				process.execPath,
				[
					"-e",
					startsDetached(
						pidFile,
						`const s = require("node:child_process").spawn("setsid", ["sleep", "300"], { detached: true, stdio: "ignore" }); s.unref(); require("node:fs").writeFileSync(${JSON.stringify(setsidFile)}, String(s.pid));`,
					),
				],
				{ cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, stderr: "ignore", scope },
			);
			const descendant = await descendantOf(pidFile);
			const setsid = await descendantOf(setsidFile);
			expect(group.scopeUnit).toBe(scope.unit);
			expect(readFileSync(`/proc/${descendant}/cgroup`, "utf8").trim()).toMatch(
				new RegExp(`/${scope.unit}\\.scope$`),
			);
			const result = await group.release();
			expect(result).toEqual({ boundary: "scope", unit: scope.unit, result: "confirmed" });
			expect(running(descendant)).toBe(false);
			expect(running(setsid)).toBe(false);
			expect(unitActive(scope.unit)).toBe(false);
			// Idempotent: the same report, nothing stopped twice.
			expect(await group.release()).toBe(result);
		});

		it("timeout: a runtime that ignores the end of its input and SIGTERM is ended, its descendant with it, and cleanup is confirmed", async () => {
			const pidFile = join(temp("endo-lpc-timeout-"), "descendant.pid");
			const scope = liveScopeV0(c);
			const connection = new RpcConnectionV0({
				launch: {
					command: process.execPath,
					leadingArgs: [
						"-e",
						startsDetached(pidFile, `process.on("SIGTERM", () => {}); process.stdin.resume();`),
						"--",
					],
				},
				env: { PATH: process.env.PATH ?? "" },
				cwd: tmpdir(),
				closeTimeoutMs: 200,
				scope,
			});
			const descendant = await descendantOf(pidFile);
			const started = Date.now();
			await connection.close();
			expect(await connection.cleanup()).toEqual({ boundary: "scope", unit: scope.unit, result: "confirmed" });
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(running(descendant)).toBe(false);
		});

		it("cancellation: terminate() ends the runtime and its descendant at once, and cleanup is confirmed", async () => {
			const pidFile = join(temp("endo-lpc-cancel-"), "descendant.pid");
			const scope = liveScopeV0(c);
			const connection = new RpcConnectionV0({
				launch: {
					command: process.execPath,
					leadingArgs: ["-e", startsDetached(pidFile, "process.stdin.resume();"), "--"],
				},
				env: { PATH: process.env.PATH ?? "" },
				cwd: tmpdir(),
				scope,
			});
			const descendant = await descendantOf(pidFile);
			await connection.terminate();
			expect(await connection.cleanup()).toEqual({ boundary: "scope", unit: scope.unit, result: "confirmed" });
			expect(running(descendant)).toBe(false);
		});

		const controller = async (pidFile: string) => {
			const child: ChildProcess = spawn(process.execPath, [CONTROLLER, pidFile], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			cleanup.push(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			});
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk;
			});
			expect(await until(() => out.includes("\n"), 15_000)).toBe(true);
			const started = JSON.parse(out) as { unit: string; keeper: number; descendant: number };
			owned(started.descendant);
			cleanup.push(async () => {
				await stopScopeV0(c, started.unit);
			});
			return { child, ...started };
		};

		it("the controller killed (SIGKILL): its keeper has the scope stopped, and the detached descendant ends", async () => {
			const run = await controller(join(temp("endo-lpc-ctl-"), "descendant.pid"));
			expect(running(run.descendant)).toBe(true);
			run.child.kill("SIGKILL");
			expect(await until(() => !running(run.descendant) && !unitActive(run.unit))).toBe(true);
		});

		it("the controller AND its keeper killed: the scope is left running, it is reported with its dead owner, and stopping it ends it", async () => {
			const run = await controller(join(temp("endo-lpc-both-"), "descendant.pid"));
			process.kill(run.keeper, "SIGKILL");
			run.child.kill("SIGKILL");
			await until(() => !running(run.keeper) && run.child.exitCode !== null);
			// Nothing is left to stop the scope: this is the residual case, reported, never claimed contained.
			expect(running(run.descendant)).toBe(true);
			const left = liveScopesV0(c).find((scope) => scope.unit === run.unit);
			expect(left).toMatchObject({ unit: run.unit, ownerAlive: false, owner: { pid: run.child.pid } });
			const notes = (await liveContainmentV0()).notes;
			expect(notes.some((note) => note.includes(run.unit) && note.includes("systemctl --user stop"))).toBe(true);
			expect(await stopScopeV0(c, run.unit)).toBe("confirmed");
			expect(running(run.descendant)).toBe(false);
		});
	},
);

describe.runIf(linux)("LIVE-PROCESS-CONTAINMENT-001: incomplete cleanup is reported, never rounded up", () => {
	it("a scope that cannot be confirmed empty is reported incomplete, with what is left", async () => {
		// A scope stand-in that runs the keeper unwrapped and whose stop is not confirmed: what release reports, not how a scope fails.
		let stops = 0;
		const scope: ProcessScopeV0 = {
			unit: "endo-live-000000000000000000000000",
			wrap: (command) => ({ command: command[0] as string, args: command.slice(1), env: {} }),
			stopWithoutWaiting: ["true"],
			stop: async () => {
				stops += 1;
				return "unconfirmed";
			},
			remaining: () => 2,
		};
		const group = new ProcessGroupV0(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			cwd: tmpdir(),
			env: {},
			stderr: "ignore",
			scope,
		});
		await until(() => group.pid !== undefined);
		const result = await group.release();
		expect(result).toEqual({ boundary: "scope", unit: scope.unit, result: "incomplete", remaining: 2 });
		expect(stops).toBe(1);
		expect(describeProcessCleanupV0([result])[0]).toMatch(/^harness: CLEANUP INCOMPLETE: .*2 processes left/);
	});

	it("the words: only a confirmed scope says everything ended", () => {
		const reports: ProcessCleanupV0[] = [
			{ boundary: "scope", unit: "endo-live-aaaaaaaaaaaaaaaaaaaaaaaa", result: "confirmed" },
			{ boundary: "scope", unit: "endo-live-bbbbbbbbbbbbbbbbbbbbbbbb", result: "incomplete", remaining: null },
			{ boundary: "process-group", result: "incomplete" },
			{ boundary: "process-group", result: "unverified" },
		];
		const lines = describeProcessCleanupV0(reports);
		expect(lines[0]).toMatch(/Pi \(process 1 of 4\) and every process it started have ended/);
		for (const line of lines.slice(1)) expect(line).not.toMatch(/have ended/);
		expect(lines[1]).toMatch(/CLEANUP INCOMPLETE.*systemctl --user stop endo-live-b+\.scope/);
		expect(lines[2]).toMatch(/CLEANUP INCOMPLETE/);
		expect(lines[3]).toMatch(/UNVERIFIED/);
	});

	it.runIf(contained !== null)(
		"a host where a live scope's cgroup.events cannot be read is refused: a missing file must never read as an empty scope (Codex, #133)",
		async () => {
			const refused = await detectContainmentV0({
				cgroupRoot: join(temp("endo-lpc-nocgroup-"), "not-a-cgroup-root"),
			});
			expect(refused).toMatchObject({ ok: false, reason: "containment-unavailable" });
			expect((refused as { detail: string }).detail).toMatch(
				/cgroup\.events is not readable in a unified cgroup v2 hierarchy/,
			);
			expect((await detectContainmentV0()).ok).toBe(true);
		},
	);

	it("a failed live scope that still holds processes is reported at the next attach; a failed empty one is not (Codex, #133)", async () => {
		const stub = async () =>
			({ ok: true, containment: { systemctl: "/usr/bin/systemctl", env: {} } }) as unknown as Awaited<
				ReturnType<typeof detectContainmentV0>
			>;
		const scope = (unit: string, state: "active" | "failed") => ({
			unit,
			state,
			owner: { pid: process.pid, startTime: "1" },
			ownerAlive: true,
		});
		const populated = "endo-live-cccccccccccccccccccccccc";
		const empty = "endo-live-dddddddddddddddddddddddd";
		const ownLive = "endo-live-eeeeeeeeeeeeeeeeeeeeeeee";
		const live = await liveContainmentV0(stub, {
			liveScopes: () => [scope(populated, "failed"), scope(empty, "failed"), scope(ownLive, "active")],
			scopeProcesses: (_c, unit) => (unit === populated ? [101, 102] : unit === ownLive ? [7] : []),
		});
		expect(live.notes).toEqual([
			`warning: an earlier live session left scope ${populated} (failed) with 2 processes; its stop failed and processes are still in it. \`systemctl --user stop ${populated}.scope\` ends them.`,
		]);
	});

	it("without a user manager, the operator is told before the session starts that cleanup will be unverified", async () => {
		const live = await liveContainmentV0(async () => ({
			ok: false,
			reason: "containment-unavailable",
			detail: "no user manager: XDG_RUNTIME_DIR is not set",
		}));
		expect(live.containment).toBeNull();
		expect(live.notes).toEqual([expect.stringMatching(/not contained here \(no user manager.*unverified/)]);
	});
});

describe.runIf(linux)("LIVE-PROCESS-CONTAINMENT-001: Ctrl-C on `endo harness attach --control` (fake Pi)", () => {
	it("a session whose start fails after Pi launched still reports its cleanup (Codex, #133)", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-lpc-failstart-");
		const cwd = temp("endo-lpc-failstart-cwd-");
		const pidFile = join(temp("endo-lpc-failstart-pid-"), "descendant.pid");
		const run = spawnSync(process.execPath, [CLI, "harness", "attach", root, "--pi", install.bin, "--cwd", cwd], {
			env: { ...process.env, ...fakePiEnv({ FAKE_PI_SCENARIO: `refuse-get-state,detached-child:${pidFile}` }) },
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(run.status).not.toBe(0);
		const descendant = await descendantOf(pidFile);
		if (contained === null) {
			expect(run.stderr).toMatch(
				/^harness: Pi has exited; whether every process it started has ended is UNVERIFIED/m,
			);
			expect(running(descendant)).toBe(true);
		} else {
			expect(run.stderr).toMatch(
				/^harness: Pi and every process it started have ended \(scope endo-live-[0-9a-f]{24} stopped/m,
			);
			expect(running(descendant)).toBe(false);
		}
	}, 60_000);

	it(`the session ends, and the report says ${contained === null ? "UNVERIFIED (no user manager here)" : "every process Pi started has ended, and none has"}`, async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-lpc-attach-");
		const cwd = temp("endo-lpc-attach-cwd-");
		const pidFile = join(temp("endo-lpc-attach-pid-"), "descendant.pid");
		let stderr = "";
		const child = spawn(
			process.execPath,
			[CLI, "harness", "attach", root, "--pi", install.bin, "--cwd", cwd, "--control"],
			{
				env: { ...process.env, ...fakePiEnv({ FAKE_PI_SCENARIO: `detached-child:${pidFile}` }) },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		cleanup.push(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
		const descendant = await descendantOf(pidFile);
		expect(await until(() => stderr.includes("serving control at"), 30_000)).toBe(true);
		child.kill("SIGINT");
		expect(await exited).toBe(0);
		if (contained === null) {
			expect(stderr).toMatch(/^note: Pi's processes are not contained here/m);
			expect(stderr).toMatch(/^harness: Pi has exited; whether every process it started has ended is UNVERIFIED/m);
			expect(running(descendant)).toBe(true);
		} else {
			expect(stderr).toMatch(
				/^harness: Pi and every process it started have ended \(scope endo-live-[0-9a-f]{24} stopped/m,
			);
			expect(running(descendant)).toBe(false);
		}
	}, 60_000);
});
