import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	processStartTimeV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, scopeControlGroupV0, scopeProcessesV0 } from "../adapters/sandbox/containment.ts";
import { runAttestedPiV0, watchPiSubjectV0 } from "../research/develop-isolate-002/attested-pi.ts";

it("fails closed permanently on simulated substitution or unreadable evidence", () => {
	for (const unusable of [
		() => false,
		() => {
			throw new Error("synthetic unreadable process evidence");
		},
	]) {
		let matches = () => true;
		const watch = watchPiSubjectV0("session", "/workspace", () => matches());
		expect(watch.observe("another-session", "/workspace")).toBe("wrong-session-or-workspace");
		expect(watch.observe("session", "/other")).toBe("wrong-session-or-workspace");
		expect(watch.observe("session", "/workspace")).toBe("matches");
		matches = unusable;
		expect(watch.observe("session", "/workspace")).toBe("protection-lost");
		matches = () => true;
		expect(watch.observe("session", "/workspace")).toBe("protection-lost");
	}
});

const hostPi = process.platform === "linux" && process.env.ENDO_ATTESTED_PI_HOST === "1";

it.runIf(hostPi)(
	"contains a synthetic detached descendant in the PID-1 launch and cleans it up",
	async () => {
		const bwrap = detectBubblewrapV0();
		const scope = await detectContainmentV0();
		const node = "/usr/bin/node";
		const runtime = resolveRuntimeV0([node]);
		if (!bwrap.ok || !scope.ok || !runtime.ok) throw new Error("the Arch test runtime is unavailable");
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [],
			env: { HOME: "/home/agent", PATH: "/usr/bin" },
			cwd: "/home/agent",
			tmpfsBytes: 16 * 1024 * 1024,
		});
		const fixture = `import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
closeSync(6);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
child.unref();
child.once("spawn", () => console.log(child.pid));
process.stdin.resume();`;
		let descendant: { pid: number; start: string } | undefined;
		let failure: unknown;
		const result = await runSandboxV0(bwrap.bwrap, profile, [node, "--input-type=module", "-e", fixture], {
			containment: scope.containment,
			timeoutMs: 5000,
			outputBytes: 4096,
			experimentalLaunch: async ({ unit, init, stdin, stdout }) => {
				try {
					const [bytes] = await once(stdout, "data");
					const guestPid = Number(String(bytes).trim());
					expect(guestPid).toBeGreaterThan(1);
					const group = scopeControlGroupV0(scope.containment, unit);
					expect(group).not.toBeNull();
					const pid = scopeProcessesV0(scope.containment, unit)?.find((candidate) => {
						const stat = readFileSync(`/proc/${candidate}/stat`, "utf8");
						return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] === String(init.pid);
					});
					if (pid === undefined) throw new Error("the detached descendant was not present in the scope");
					const start = processStartTimeV0(pid);
					if (start === null) throw new Error("the detached descendant was not alive");
					const proc = `/proc/${pid}`;
					expect(readFileSync(`${proc}/cgroup`, "utf8").trim()).toBe(`0::${group}`);
					expect(readFileSync(`${proc}/status`, "utf8")).toMatch(
						new RegExp(`^NSpid:\\s+${pid}\\s+${guestPid}$`, "m"),
					);
					expect(readlinkSync(`${proc}/ns/pid`)).toBe(readlinkSync(`/proc/${init.pid}/ns/pid`));
					const fields = readFileSync(`${proc}/stat`, "utf8").split(") ").at(-1)?.split(" ");
					expect(fields?.[3]).toBe(String(pid));
					descendant = { pid, start };
				} catch (error) {
					failure = error;
					throw error;
				} finally {
					stdin.end();
				}
			},
		});
		if (failure !== undefined) throw failure;
		expect(result).toMatchObject({ exitCode: 0, timedOut: false, termination: "confirmed", initGone: true });
		if (descendant === undefined) throw new Error("the descendant fixture did not reach the positive observation");
		expect(processStartTimeV0(descendant.pid)).not.toBe(descendant.start);
	},
	20_000,
);

it.runIf(hostPi).each(["normal-exit", "replaced-workspace", "unreadable-workspace"] as const)(
	"attests the real offline Pi process and denies %s",
	async (scenario) => {
		const base = mkdtempSync("/tmp/endo-attested-pi-test-");
		try {
			const parent = join(base, "parent");
			const root = join(parent, "workspace");
			const evidenceRoot = join(base, "evidence");
			const internal = join(base, "internal");
			for (const path of [parent, root, evidenceRoot, internal]) mkdirSync(path, { mode: 0o700 });
			execFileSync("/usr/bin/git", ["-C", root, "init", "-q"], {
				env: { HOME: base, PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
				stdio: "pipe",
			});
			let inspected = false;
			const result = await runAttestedPiV0(
				{ root, evidenceRoot, internalRoots: [internal] },
				(subject, session, pi) => {
					expect(processStartTimeV0(pi.pid)).toBe(pi.startTime);
					expect(subject.observe(session, root)).toBe("matches");
					expect(subject.observe(`${session}-wrong`, root)).toBe("wrong-session-or-workspace");
					expect(subject.observe(session, parent)).toBe("wrong-session-or-workspace");
					if (scenario === "replaced-workspace") {
						const moved = join(parent, "moved");
						renameSync(root, moved);
						try {
							mkdirSync(root);
							expect(processStartTimeV0(pi.pid)).toBe(pi.startTime);
							expect(subject.observe(session, root)).toBe("protection-lost");
						} finally {
							rmSync(root, { force: true, recursive: true });
							renameSync(moved, root);
						}
						expect(subject.observe(session, root)).toBe("protection-lost");
					}
					if (scenario === "unreadable-workspace") {
						chmodSync(parent, 0);
						try {
							expect(processStartTimeV0(pi.pid)).toBe(pi.startTime);
							expect(subject.observe(session, root)).toBe("protection-lost");
						} finally {
							chmodSync(parent, 0o700);
						}
						expect(subject.observe(session, root)).toBe("protection-lost");
					}
					inspected = true;
				},
			);
			expect(result).toMatchObject({
				ok: true,
				atRpc: "matches",
				afterExit: "protection-lost",
				termination: "confirmed",
				initGone: true,
			});
			expect(inspected).toBe(true);
		} finally {
			rmSync(base, { force: true, recursive: true });
		}
	},
	30_000,
);
