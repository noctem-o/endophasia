// EVAL-ISO-001: the protected boundary, attacked from inside a REAL Bubblewrap sandbox (docs/protected-experiments.md). Every test in the
// `real isolation` blocks runs actual kernel isolation; they are skipped, and say so, where the host cannot start one (detectBubblewrapV0).
// The refusal tests at the end run everywhere and never start an unprotected process.
//
// Each restriction has a negative probe: a test that removes exactly that restriction (unsafeForTests, unreachable from a spec or the CLI)
// and shows the preflight then fails and the agent never runs.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	endoTreeDigestV0,
	processAliveV0,
	processStartTimeV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../adapters/sandbox/bubblewrap.ts";
import {
	detectContainmentV0,
	type EndoContainmentV0,
	newScopeUnitV0,
	scopeArgsV0,
	stopScopeV0,
} from "../adapters/sandbox/containment.ts";
import { preflightV0 } from "../adapters/sandbox/preflight.ts";
import { reportProtectedExperimentV0, runProtectedExperimentV0 } from "../cli/experiment-protected.ts";
import type { EndoProtectedSpecV0, EndoProtectedTrialV0 } from "../protocol/protected-experiment.ts";
import { readEndoProtectedSpecV0 } from "../protocol/protected-experiment.ts";
import { readEndoProtectedTrialFileV0, sealEndoProtectedTrialV0 } from "../runtime/contracts/protected-experiment.ts";

const EXAMPLE = fileURLToPath(new URL("../research/protected-eval/example/", import.meta.url));
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-protected-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};
const detected = detectBubblewrapV0();
// Real isolation needs both the sandbox and the process containment (a systemd user manager): either missing is a refusal.
const contained = detected.ok ? await detectContainmentV0() : null;
const REAL = detected.ok && contained?.ok === true;
const containment = contained?.ok === true ? contained.containment : (null as unknown as EndoContainmentV0);
if (!REAL)
	process.stderr.write(
		`protected-isolation: real isolation tests skipped: ${detected.ok ? `containment: ${(contained as { detail: string }).detail}` : `${detected.reason}: ${detected.detail}`}\n`,
	);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** The correct solution, as source, for agents that also want to pass. */
const SOLUTION = readFileSync(join(EXAMPLE, "evaluator", "reference", "src", "interval.mjs"), "utf8");

/** A spec over the committed example's evaluator (copied, so its pin is this copy's), with one condition per agent script. */
function specWith(agents: Record<string, string>, change: Partial<EndoProtectedSpecV0> = {}): EndoProtectedSpecV0 {
	const evaluatorDir = fresh("evaluator");
	for (const part of ["reference", "negative"]) {
		mkdirSync(join(evaluatorDir, part, "src"), { recursive: true });
		writeFileSync(
			join(evaluatorDir, part, "src", "interval.mjs"),
			readFileSync(join(EXAMPLE, "evaluator", part, "src", "interval.mjs")),
		);
	}
	writeFileSync(join(evaluatorDir, "evaluator.json"), readFileSync(join(EXAMPLE, "evaluator", "evaluator.json")));
	const conditions = Object.entries(agents).map(([id, source]) => {
		const dir = fresh(`agent-${id}`);
		writeFileSync(join(dir, "agent.mjs"), source);
		return { id, description: id, agent: { directory: dir, argv: ["/usr/bin/node", "/agent/agent.mjs"] } };
	});
	const read = readEndoProtectedSpecV0({
		schemaVersion: "endo.protected-experiment-spec.v0",
		id: "endo.experiment.protected-test",
		description: "test",
		seed: 7,
		trials: 1,
		limits: {
			agentTimeoutMs: 20_000,
			evaluationTimeoutMs: 20_000,
			outputBytes: 1_048_576,
			tmpfsBytes: 16_777_216,
			maxFileBytes: 65_536,
			maxTotalBytes: 262_144,
		},
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "merge-intervals",
				workspace: {
					"src/interval.mjs": "export function mergeIntervals() { throw new Error('todo'); }\n",
					"README.md": "task\n",
				},
				submission: ["src/interval.mjs"],
				evaluator: {
					file: join(evaluatorDir, "evaluator.json"),
					sha256: sha(join(evaluatorDir, "evaluator.json")),
				},
			},
		],
		conditions,
		...change,
	});
	if (!read.ok) throw new Error(read.message);
	return read.value;
}

const recordOf = (dir: string, condition: string, trial = 0, attempt = 1): EndoProtectedTrialV0 => {
	const r = readEndoProtectedTrialFileV0(
		join(dir, "trials", "merge-intervals", condition, String(trial), `attempt-${attempt}`, "record.json"),
	);
	if (!r.ok) throw new Error(r.reason);
	return r.value;
};
const workOf = (dir: string, condition: string, trial = 0, attempt = 1) =>
	join(dir, "trials", "merge-intervals", condition, String(trial), `attempt-${attempt}`, "work");

describe.runIf(REAL)("real isolation: an honest agent and the independent evaluator (positive control)", () => {
	it("produces a bounded artifact that the separate evaluator passes, with every boundary probe established", async () => {
		const out = fresh("run");
		await runProtectedExperimentV0({
			spec: specWith({ honest: readFileSync(join(EXAMPLE, "agents", "honest", "agent.mjs"), "utf8") }),
			dir: out,
		});
		const r = recordOf(out, "honest");
		expect(r.preflight.status).toBe("established");
		expect(r.preflight.probes.length).toBeGreaterThan(20);
		expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
		expect(r.submission).toMatchObject({ status: "collected", files: [{ path: "src/interval.mjs" }] });
		expect(r.evaluation).toMatchObject({ status: "passed", cases: { total: 7, passed: 7 } });
		expect(r.invalidating).toEqual([]);
		// The evaluated copy is the one the record names.
		const copy = join(
			out,
			"trials",
			"merge-intervals",
			"honest",
			"0",
			"attempt-1",
			"submission",
			"src",
			"interval.mjs",
		);
		expect(sha(copy)).toBe(r.submission.files[0]?.sha256);
	});
});

describe.runIf(REAL)("real isolation: what an adversarial agent can see and reach", () => {
	it("cannot read the hidden evaluator, host secrets, the archive, another trial, privileged sockets or the network", async () => {
		// Host state the agent must not reach: a secret, the evaluator, a unix socket, a loopback service, an earlier trial's workspace.
		const secretDir = fresh("host-secret");
		writeFileSync(join(secretDir, "token"), `SECRET-${randomBytes(8).toString("hex")}`);
		const socketDir = fresh("socket");
		const socketPath = join(socketDir, "s");
		const unix = createServer((s) => s.destroy());
		await new Promise<void>((r) => unix.listen(socketPath, r));
		const tcp = createServer((s) => s.end("HOST-SERVICE"));
		await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
		const port = (tcp.address() as { port: number }).port;
		const out = fresh("run");
		const spec0 = specWith({
			honest: `import { writeFileSync } from "node:fs"; writeFileSync("/work/src/interval.mjs", ${JSON.stringify(SOLUTION)});`,
		});
		const evaluatorFile = spec0.tasks[0]!.evaluator.file;
		const targets = {
			secret: join(secretDir, "token"),
			evaluator: evaluatorFile,
			evaluatorDir: join(evaluatorFile, ".."),
			reference: join(evaluatorFile, "..", "reference", "src", "interval.mjs"),
			repository: fileURLToPath(new URL("../", import.meta.url)),
			research: fileURLToPath(new URL("../../endophasia-research", import.meta.url)),
			otherTrial: join(out, "trials", "merge-intervals", "spy", "0", "attempt-1", "work"),
			runDirectory: out,
			socket: socketPath,
			dbus: `/run/user/${process.getuid?.()}/bus`,
			etcShadow: "/etc/shadow",
			etcPasswd: "/etc/passwd",
		};
		const spy = `
import fs from "node:fs"; import net from "node:net"; import cp from "node:child_process";
const t = ${JSON.stringify(targets)};
const code = (f) => { try { f(); return "ok"; } catch (e) { return String(e.code || e.message); } };
const r = { read: {}, write: {}, net: {} };
for (const [k, p] of Object.entries(t)) r.read[k] = code(() => fs.readFileSync(p));
r.write.evaluator = code(() => fs.writeFileSync(t.evaluator, "{}"));
r.write.reference = code(() => fs.writeFileSync(t.reference, "export const x = 1;"));
r.write.root = code(() => fs.writeFileSync("/escape", "x"));
r.write.agent = code(() => fs.writeFileSync("/agent/escape", "x"));
r.write.usr = code(() => fs.writeFileSync("/usr/bin/escape", "x"));
r.write.hostTmp = code(() => fs.writeFileSync(${JSON.stringify(join(secretDir, "planted"))}, "x"));
r.listProc = fs.readdirSync("/proc").filter((x) => /^[0-9]+$/.test(x)).length;
r.root = fs.readdirSync("/").sort().join(",");
r.env = Object.keys(process.env).sort().join(",");
r.spawnShell = code(() => cp.execFileSync("/bin/sh", ["-c", "id"]));
const attempt = (o) => new Promise((res) => { const s = net.connect(o); const k = setTimeout(() => { s.destroy(); res("timeout"); }, 1500); s.on("connect", () => { clearTimeout(k); s.destroy(); res("connected"); }); s.on("error", (e) => { clearTimeout(k); res(String(e.code)); }); });
r.net.loopback = await attempt({ host: "127.0.0.1", port: ${port} });
r.net.loopbackV6 = await attempt({ host: "::1", port: ${port} });
r.net.lan = await attempt({ host: "192.168.1.1", port: 80 });
r.net.public = await attempt({ host: "1.1.1.1", port: 443 });
r.net.dns = await attempt({ host: "example.com", port: 80 });
r.net.socket = await attempt({ path: t.socket });
fs.writeFileSync("/work/spy.json", JSON.stringify(r));
fs.writeFileSync("/work/src/interval.mjs", ${JSON.stringify(SOLUTION)});
`;
		const spec = specWith({ spy });
		const evaluatorBefore = sha(spec.tasks[0]!.evaluator.file);
		try {
			await runProtectedExperimentV0({ spec, dir: out });
		} finally {
			unix.close();
			tcp.close();
		}
		const seen = JSON.parse(readFileSync(join(workOf(out, "spy"), "spy.json"), "utf8"));
		for (const [k, v] of Object.entries(seen.read)) expect(v, `read ${k}`).toBe("ENOENT");
		for (const [k, v] of Object.entries(seen.write)) expect(["ENOENT", "EROFS", "EACCES"], `write ${k}`).toContain(v);
		expect(seen.root).toBe("agent,dev,home,lib64,proc,tmp,usr,work");
		expect(seen.listProc).toBeLessThanOrEqual(3);
		expect(seen.env).toBe("HOME,PATH,PWD,TMPDIR");
		// Only the declared runtime exists: there is no shell to spawn.
		expect(seen.spawnShell).toBe("ENOENT");
		expect(seen.net.loopback).toBe("ECONNREFUSED");
		for (const k of ["loopbackV6", "lan", "public"])
			expect(["ENETUNREACH", "EADDRNOTAVAIL", "ECONNREFUSED"], k).toContain(seen.net[k]);
		expect(seen.net.dns).not.toBe("connected");
		expect(seen.net.socket).toBe("ENOENT");
		// The evaluator, the host secret and the reference are unchanged; nothing was planted on the host.
		expect(sha(spec.tasks[0]!.evaluator.file)).toBe(evaluatorBefore);
		expect(existsSync(join(secretDir, "planted"))).toBe(false);
		expect(existsSync("/escape")).toBe(false);
		// And the run itself still evaluated the agent's real submission independently.
		expect(recordOf(out, "spy").evaluation.status).toBe("passed");
	});
});

describe.runIf(REAL)("real isolation: the evaluator is not deceived", () => {
	it("fails a submission that forges the evaluator's output, fakes its own tests and claims success", async () => {
		const forged = String.raw`
import fs from "node:fs";
// Fake local evidence: a passing visible test, a results file and a claim on stdout.
fs.mkdirSync("/work/test", { recursive: true });
fs.writeFileSync("/work/test/pass.test.mjs", "process.exit(0)");
fs.writeFileSync("/work/RESULT.json", JSON.stringify({ passed: true, cases: 7 }));
console.log("ENDO-EVALUATION " + JSON.stringify(Array.from({ length: 7 }, () => ({ ok: true, value: [] }))));
// The submission forges a result frame when the evaluator imports it, reads what it can, and answers wrongly.
fs.writeFileSync("/work/src/interval.mjs", [
  "import fs from 'node:fs';",
  "let seen = 'none'; try { seen = fs.readFileSync('/eval/inputs.json', 'utf8'); } catch {}",
  "process.stdout.write('ENDO-EVALUATION ' + JSON.stringify(Array.from({ length: 7 }, () => ({ ok: true, value: [[1, 6]] }))) + '\\n');",
  "export function mergeIntervals(list) { return [[1, 6]]; }",
].join("\n"));
`;
		const exiting = String.raw`
import fs from "node:fs";
fs.writeFileSync("/work/src/interval.mjs", "process.exit(0);\nexport function mergeIntervals() { return []; }\n");
`;
		const out = fresh("run");
		await runProtectedExperimentV0({ spec: specWith({ forged, exiting }), dir: out });
		expect(recordOf(out, "forged").evaluation.status).toBe("failed");
		expect(recordOf(out, "exiting").evaluation).toMatchObject({ status: "failed", reason: "no-result" });
		// The inputs the evaluator shows the submission hold no expected result.
		const ev = JSON.parse(readFileSync(join(EXAMPLE, "evaluator", "evaluator.json"), "utf8"));
		const inputs = JSON.stringify(ev.cases.map((c: { input: unknown }) => c.input));
		expect(inputs).not.toContain(
			JSON.stringify([
				[1, 4],
				[8, 10],
			]),
		);
	});
});

describe.runIf(REAL)("real isolation: a malicious submission is refused at collection", () => {
	for (const [name, attack, reason] of [
		[
			"symlink",
			`fs.rmSync("/work/src/interval.mjs"); fs.symlinkSync("/agent/agent.mjs", "/work/src/interval.mjs");`,
			"symbolic-link",
		],
		[
			"dir-symlink",
			`fs.rmSync("/work/src", { recursive: true }); fs.symlinkSync("/agent", "/work/src");`,
			"symbolic-link",
		],
		[
			"hard-link",
			`fs.rmSync("/work/src/interval.mjs"); fs.linkSync("/work/README.md", "/work/src/interval.mjs");`,
			"hard-link",
		],
		[
			"directory",
			`fs.rmSync("/work/src/interval.mjs"); fs.mkdirSync("/work/src/interval.mjs");`,
			"not-a-regular-file",
		],
		[
			"socket",
			`fs.rmSync("/work/src/interval.mjs"); await new Promise((r) => net.createServer().listen("/work/src/interval.mjs", r)); process.exit(0);`,
			"not-a-regular-file",
		],
		["huge", `fs.writeFileSync("/work/src/interval.mjs", Buffer.alloc(70000, 65));`, "too-large"],
		["missing", `fs.rmSync("/work/src/interval.mjs");`, "missing"],
	] as const)
		it(`refuses a ${name}`, async () => {
			const out = fresh("run");
			await runProtectedExperimentV0({
				spec: specWith({ bad: `import fs from "node:fs"; import net from "node:net"; ${attack}` }),
				dir: out,
			});
			const r = recordOf(out, "bad");
			expect(r.submission.status).toBe(reason === "missing" ? "missing" : "refused");
			expect(r.submission.refusals).toEqual([{ path: "src/interval.mjs", reason }]);
			expect(r.evaluation.status).toBe("not-run");
			expect(existsSync(join(out, "trials", "merge-intervals", "bad", "0", "attempt-1", "submission"))).toBe(false);
		});
});

describe.runIf(REAL)("real isolation: processes end with the trial", () => {
	it("kills a timed-out agent and every detached descendant, and records the termination", async () => {
		const looping = `
import cp from "node:child_process";
const c = cp.spawn("/usr/bin/node", ["-e", "setInterval(() => require('fs').writeFileSync('/work/heartbeat', String(Date.now())), 50)"], { detached: true, stdio: "ignore" });
c.unref();
setInterval(() => {}, 1000);
`;
		const out = fresh("run");
		const spec = specWith({ looping }, {});
		await runProtectedExperimentV0({ spec: { ...spec, limits: { ...spec.limits, agentTimeoutMs: 1500 } }, dir: out });
		const r = recordOf(out, "looping");
		expect(r.agent).toMatchObject({ status: "timed-out", termination: "confirmed" });
		const ns = JSON.parse(
			readFileSync(
				join(out, "trials", "merge-intervals", "looping", "0", "attempt-1", "agent-started.json"),
				"utf8",
			),
		).init;
		// The sandbox's init (pid and start time) is gone, so the kernel has killed everything in its namespace.
		expect(processAliveV0(ns)).toBe(false);
		// Nothing still writes into the workspace.
		const beat = join(workOf(out, "looping"), "heartbeat");
		const a = readFileSync(beat, "utf8");
		await new Promise((res) => setTimeout(res, 300));
		expect(readFileSync(beat, "utf8")).toBe(a);
		// What it left was still collected and independently judged (the stub fails).
		expect(r.evaluation.status).toBe("failed");
	});

	it("leaves no sandboxed process when the controller itself is killed, and keeps the interrupted attempt in the accounting", async () => {
		const sleeper = `setInterval(() => {}, 1000);`;
		const base = specWith({ sleeper });
		const spec = { ...base, limits: { ...base.limits, agentTimeoutMs: 3000 } };
		const specFile = join(fresh("spec"), "spec.json");
		writeFileSync(specFile, JSON.stringify(spec));
		const out = fresh("run");
		const controller = spawn(process.execPath, [CLI, "experiment", "protected-run", specFile, "--out", out], {
			stdio: "ignore",
		});
		const started = join(out, "trials", "merge-intervals", "sleeper", "0", "attempt-1", "agent-started.json");
		for (let i = 0; i < 200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
		expect(existsSync(started)).toBe(true);
		const ns = JSON.parse(readFileSync(started, "utf8")).init;
		expect(processAliveV0(ns)).toBe(true);
		controller.kill("SIGKILL");
		await new Promise((r) => controller.on("close", r));
		for (let i = 0; i < 200 && processAliveV0(ns); i++) await new Promise((r) => setTimeout(r, 50));
		expect(processAliveV0(ns)).toBe(false);
		// Resuming finalizes the interrupted attempt from what it shows, and does not retry it unless asked.
		const resumed = await runProtectedExperimentV0({ spec, dir: out });
		expect(resumed).toMatchObject({ attempts: 0, finalizedOnResume: 1 });
		const r = recordOf(out, "sleeper");
		expect(r.controller.finalized).toBe("on-resume");
		expect(r.agent).toMatchObject({ status: "interrupted", termination: "confirmed" });
		// The resume stopped exactly the scope recorded before the agent started.
		const unit = JSON.parse(
			readFileSync(join(out, "trials", "merge-intervals", "sleeper", "0", "attempt-1", "agent-scope.json"), "utf8"),
		).unit;
		// On resume nothing saw bubblewrap inside the scope, so `established` is false; the scope's end is still confirmed.
		expect(r.agent.scope).toEqual({ unit, established: false, ended: "confirmed" });
		// The launcher was recorded right after the launch, and every recorded scope of the attempt was ended.
		expect(
			JSON.parse(
				readFileSync(
					join(out, "trials", "merge-intervals", "sleeper", "0", "attempt-1", "agent-scope.json"),
					"utf8",
				),
			).launcher,
		).toMatchObject({ pid: expect.any(Number), startTime: expect.any(String) });
		expect(scopeLoaded(unit)).toBe("not-found");
		expect(r.invalidating).toEqual(["controller-interrupted", "agent-interrupted"]);
		let report = reportProtectedExperimentV0(out);
		expect(report.cells[0]).toMatchObject({
			planned: 1,
			attempted: 1,
			qualified: 0,
			attrition: { "controller-interrupted": 1 },
		});
		// Its agent had run, so even an explicit retry does not re-run it: an interruption while the agent ran is final attrition.
		expect(await runProtectedExperimentV0({ spec, dir: out, retryInterrupted: true })).toMatchObject({
			attempts: 0,
			skipped: 1,
		});
		report = reportProtectedExperimentV0(out);
		expect(report.cells[0]).toMatchObject({ planned: 1, attempts: 1, retries: 0, qualified: 0 });
	});

	it("retries, on request, an attempt the controller stopped before its agent started; both attempts stay counted", async () => {
		const out = fresh("run");
		const spec = specWith({
			honest: `import { writeFileSync } from "node:fs"; writeFileSync("/work/src/interval.mjs", ${JSON.stringify(SOLUTION)});`,
		});
		await runProtectedExperimentV0({ spec, dir: out });
		// As if the controller had stopped right after creating the attempt: only its marker and workspace remain.
		const attempt = join(out, "trials", "merge-intervals", "honest", "0", "attempt-1");
		for (const name of [
			"record.json",
			"preflight.json",
			"agent-started.json",
			"agent-ended.json",
			"agent.log",
			"submission",
		])
			rmSync(join(attempt, name), { recursive: true, force: true });
		await runProtectedExperimentV0({ spec, dir: out });
		expect(recordOf(out, "honest").invalidating).toEqual(["controller-interrupted", "isolation-unavailable"]);
		await runProtectedExperimentV0({ spec, dir: out, retryInterrupted: true });
		const retry = recordOf(out, "honest", 0, 2);
		expect(retry.trial).toMatchObject({ attempt: 2, retryOf: 1 });
		expect(retry.evaluation.status).toBe("passed");
		const report = reportProtectedExperimentV0(out);
		expect(report.refusedRecords).toEqual([]);
		expect(report.cells[0]).toMatchObject({
			planned: 1,
			attempted: 1,
			attempts: 2,
			retries: 1,
			qualified: 1,
			passed: 1,
		});
	});
});

describe.runIf(REAL)("real isolation: each probe detects the removal of its restriction", () => {
	const runtime = resolveRuntimeV0(["/usr/bin/node"]);
	const profileWith = (work: string, unsafe?: Parameters<typeof buildSandboxProfileV0>[0]["unsafeForTests"]) =>
		buildSandboxProfileV0({
			runtime: runtime.ok ? runtime.files : [],
			mounts: [{ target: "/work", kind: "rw-dir", role: "workspace", source: work }],
			env: { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" },
			cwd: "/work",
			tmpfsBytes: 16 * 1024 * 1024,
			...(unsafe === undefined ? {} : { unsafeForTests: unsafe }),
		});
	const protectedDir = fresh("protected");
	const targets = {
		protectedPaths: { protected: protectedDir },
		readOnlyRuntime: ["/usr/bin/node"],
		readOnlyMounts: ["/usr/.endo-probe"],
		writable: "/work",
		environment: ["HOME", "PATH", "TMPDIR", "PWD"],
		sockets: ["/run/dbus/system_bus_socket"],
	};
	const failed = async (unsafe: Parameters<typeof profileWith>[1]) => {
		if (!detected.ok) throw new Error("unreachable");
		const p = await preflightV0(
			detected.bwrap,
			profileWith(fresh("work"), unsafe),
			"/usr/bin/node",
			targets,
			containment,
		);
		return { status: p.status, failing: p.probes.filter((x) => !x.passed).map((x) => x.id) };
	};
	it("establishes the unweakened profile", async () => {
		expect(await failed(undefined)).toEqual({ status: "established", failing: [] });
	});
	it("network shared with the host: the loopback, interface and abstract-socket probes fail", async () => {
		const got = await failed({ shareNet: true });
		expect(got.status).toBe("failed");
		expect(got.failing).toEqual(
			expect.arrayContaining(["net-host-loopback", "net-interfaces", "net-host-abstract-socket"]),
		);
	});
	it("a protected host directory mounted: its hidden-path probe fails", async () => {
		expect((await failed({ extraRoBind: { source: protectedDir, target: protectedDir } })).failing).toContain(
			"fs-hidden-protected",
		);
	});
	it("an unrelated directory that only shares a protected path's name (a host home of /home/agent, a checkout at /work) passes", async () => {
		// Codex 4501423401: the raw name inside is not the host's object. Bind a different host directory at the protected name.
		if (!detected.ok) throw new Error("unreachable");
		const unsafe = { extraRoBind: { source: fresh("unrelated"), target: protectedDir } };
		const p = await preflightV0(
			detected.bwrap,
			profileWith(fresh("work"), unsafe),
			"/usr/bin/node",
			targets,
			containment,
		);
		expect(p.probes.find((x) => x.id === "fs-hidden-protected")).toEqual({
			id: "fs-hidden-protected",
			passed: true,
			observed: "other-object",
		});
		// The only other failure is this test's own mount point, which lies under the host's /tmp and so shows in the sandbox's.
		expect(p.probes.filter((x) => !x.passed).map((x) => x.id)).toEqual(
			protectedDir.startsWith("/tmp/") ? ["fs-tmp-private"] : [],
		);
		// The host's own object at that name is still found, whatever else is mounted.
		const own = await preflightV0(
			detected.bwrap,
			profileWith(fresh("work"), { extraRoBind: { source: protectedDir, target: protectedDir } }),
			"/usr/bin/node",
			targets,
			containment,
		);
		expect(own.probes.find((x) => x.id === "fs-hidden-protected")?.observed).toBe("host-object");
	});
	it("an extra environment variable: the environment probe fails", async () => {
		expect((await failed({ extraEnv: { AWS_SECRET_ACCESS_KEY: "x" } })).failing).toContain("env-minimal");
	});
	it("a writable root: the read-only probes fail", async () => {
		expect((await failed({ writableRoot: true })).failing).toEqual(
			expect.arrayContaining(["fs-root-readonly", "fs-dev-readonly", "fs-readonly-mount-0"]),
		);
	});
	it("a weakened profile never runs the agent", async () => {
		const out = fresh("run");
		await runProtectedExperimentV0({
			spec: specWith({ marker: `import fs from "node:fs"; fs.writeFileSync("/work/RAN", "1");` }),
			dir: out,
			unsafeForTests: { marker: { shareNet: true } },
		});
		const r = recordOf(out, "marker");
		expect(r.preflight.status).toBe("failed");
		expect(r.agent.status).toBe("not-run");
		expect(r.invalidating).toEqual(["preflight-failed"]);
		expect(existsSync(join(workOf(out, "marker"), "RAN"))).toBe(false);
		expect(reportProtectedExperimentV0(out).cells[0]).toMatchObject({
			planned: 1,
			qualified: 0,
			attrition: { "preflight-failed": 1 },
		});
	});
});

describe.runIf(REAL)("real isolation: a resumed run cannot change its setup", () => {
	it("refuses another agent, another evaluator or another spec in the same run directory", async () => {
		const spec = specWith({
			honest: `import { writeFileSync } from "node:fs"; writeFileSync("/work/src/interval.mjs", ${JSON.stringify(SOLUTION)});`,
		});
		const out = fresh("run");
		await runProtectedExperimentV0({ spec, dir: out });
		// Changed agent code, same spec text.
		writeFileSync(join(spec.conditions[0]!.agent.directory, "agent.mjs"), "// changed\n");
		await expect(runProtectedExperimentV0({ spec, dir: out })).rejects.toThrow(
			/identical spec, isolation, agent profiles/,
		);
		// A changed evaluator definition no longer matches its pin.
		const evaluatorFile = spec.tasks[0]!.evaluator.file;
		writeFileSync(evaluatorFile, `${readFileSync(evaluatorFile, "utf8")} `);
		await expect(runProtectedExperimentV0({ spec, dir: out })).rejects.toThrow(/not the one the spec pins/);
	});
});

// ---- review regressions (EVAL-ISO-001 independent review) -----------------------------------------------------------------------

describe.runIf(REAL)("real isolation: review regressions", () => {
	const solve = `import { writeFileSync } from "node:fs"; writeFileSync("/work/src/interval.mjs", ${JSON.stringify(SOLUTION)});`;

	it("B1: an agent that locks its own workspace cannot stop the run; its trial is a failure, and the next trial runs", async () => {
		const chmod = `import fs from "node:fs"; fs.writeFileSync("/work/src/interval.mjs", "export const mergeIntervals = () => [];"); fs.chmodSync("/work/src", 0); fs.chmodSync("/work", 0);`;
		const out = fresh("run");
		const spec = specWith({ chmod }, { trials: 2 });
		await runProtectedExperimentV0({ spec, dir: out });
		for (const trial of [0, 1]) {
			const r = recordOf(out, "chmod", trial);
			expect(r.controller.finalized).toBe("normally");
			expect(r.submission).toMatchObject({ status: "refused", refusals: [{ reason: "unreadable" }] });
			expect(r.invalidating).toEqual([]);
		}
		expect(reportProtectedExperimentV0(out).cells[0]).toMatchObject({
			planned: 2,
			qualified: 2,
			failed: 2,
			failedWithoutSubmission: 2,
			attrition: {},
		});
		// And the operator can still remove the run directory.
		rmSync(out, { recursive: true });
	});

	it("B2: deleting or linking the submission is the agent's failure, counted in the denominator, never attrition", async () => {
		const out = fresh("run");
		await runProtectedExperimentV0({
			spec: specWith({
				gone: `import fs from "node:fs"; fs.rmSync("/work/src/interval.mjs");`,
				linked: `import fs from "node:fs"; fs.rmSync("/work/src/interval.mjs"); fs.symlinkSync("/agent/agent.mjs", "/work/src/interval.mjs");`,
				honest: solve,
			}),
			dir: out,
		});
		const cells = Object.fromEntries(reportProtectedExperimentV0(out).cells.map((c) => [c.condition, c]));
		expect(cells.gone).toMatchObject({ qualified: 1, failed: 1, failedWithoutSubmission: 1, attrition: {} });
		expect(cells.linked).toMatchObject({ qualified: 1, failed: 1, failedWithoutSubmission: 1, attrition: {} });
		expect(cells.honest).toMatchObject({ qualified: 1, passed: 1 });
	});

	it("B3: refuses an agent directory that holds the evaluator, or a run directory inside the agent directory", async () => {
		const spec = specWith({ honest: solve });
		const evaluatorDir = join(spec.tasks[0]!.evaluator.file, "..");
		// The agent directory moved to the evaluator's parent: it would show the hidden cases at /agent/....
		const above = {
			...spec,
			conditions: [
				{ ...spec.conditions[0]!, agent: { ...spec.conditions[0]!.agent, directory: join(evaluatorDir, "..") } },
			],
		};
		await expect(runProtectedExperimentV0({ spec: above, dir: fresh("run") })).rejects.toThrow(
			/overlaps an evaluator's material/,
		);
		// A run directory inside the agent directory would show other trials and qualification copies.
		const inside = join(spec.conditions[0]!.agent.directory, "run");
		await expect(runProtectedExperimentV0({ spec, dir: inside })).rejects.toThrow(/overlaps the run directory/);
		expect(existsSync(join(inside, "protected-run.json"))).toBe(false);
	});

	it("B3: mounts a checked copy of the agent directory, not the live one", async () => {
		const peek = `import fs from "node:fs"; fs.writeFileSync("/work/seen", fs.readdirSync("/agent").join(",")); ${solve}`;
		const spec = specWith({ peek });
		const out = fresh("run");
		await runProtectedExperimentV0({ spec, dir: out });
		expect(readFileSync(join(workOf(out, "peek"), "seen"), "utf8")).toBe("agent.mjs");
		const m = recordOf(out, "peek").isolation.requested.mounts.find((x) => x.target === "/agent");
		expect(m).toMatchObject({ kind: "ro-dir", role: "agent" });
		expect(existsSync(join(out, ".qualification"))).toBe(false);
		expect(existsSync(join(out, "trials", "merge-intervals", "peek", "0", "attempt-1", ".evaluation"))).toBe(false);
	});

	it("B4: resume never kills a process it cannot identify as its own sandbox's init", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: solve });
		await runProtectedExperimentV0({ spec, dir: out });
		// An unrelated process of this user, whose pid is recorded with another start time (as after pid or namespace reuse).
		const victim = spawn("/usr/bin/sleep", ["30"], { stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 100));
		const attempt = join(out, "trials", "merge-intervals", "honest", "0", "attempt-1");
		rmSync(join(attempt, "record.json"));
		rmSync(join(attempt, "agent-ended.json"));
		writeFileSync(join(attempt, "agent-started.json"), JSON.stringify({ init: { pid: victim.pid, startTime: "1" } }));
		try {
			await runProtectedExperimentV0({ spec, dir: out });
			const start = processStartTimeV0(victim.pid as number);
			expect(start).not.toBeNull();
			expect(processAliveV0({ pid: victim.pid as number, startTime: start as string })).toBe(true);
			expect(recordOf(out, "honest").agent).toMatchObject({ status: "interrupted", termination: "confirmed" });
		} finally {
			victim.kill("SIGKILL");
		}
	});

	it("B5: refuses a second controller on a run directory, takes over a stale lock, and never overwrites a record", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: solve });
		mkdirSync(out, { recursive: true });
		writeFileSync(
			join(out, ".lock"),
			JSON.stringify({ pid: process.pid, startTime: processStartTimeV0(process.pid) }),
		);
		await expect(runProtectedExperimentV0({ spec, dir: out })).rejects.toThrow(
			/another controller holds this run directory/,
		);
		writeFileSync(join(out, ".lock"), JSON.stringify({ pid: process.pid, startTime: "1" }));
		await runProtectedExperimentV0({ spec, dir: out });
		expect(existsSync(join(out, ".lock"))).toBe(false);
		expect(recordOf(out, "honest").evaluation.status).toBe("passed");
	});

	it("B5: of many controllers racing for a stale lock, exactly one runs; no attempt is finalized under a live controller", async () => {
		const spec = specWith({ slow: `${solve} await new Promise((r) => setTimeout(r, 1500));` });
		const specFile = join(fresh("spec"), "spec.json");
		writeFileSync(specFile, JSON.stringify(spec));
		const out = fresh("run");
		writeFileSync(join(out, ".lock"), JSON.stringify({ pid: 999999, startTime: "1" }));
		const runs = Array.from(
			{ length: 8 },
			() =>
				new Promise<number>((resolve) => {
					const c = spawn(process.execPath, [CLI, "experiment", "protected-run", specFile, "--out", out], {
						stdio: "ignore",
					});
					c.on("close", (code) => resolve(code ?? -1));
				}),
		);
		const codes = await Promise.all(runs);
		expect(codes.filter((c) => c === 0)).toHaveLength(1);
		const r = recordOf(out, "slow");
		expect(r.controller.finalized).toBe("normally");
		expect(r.evaluation.status).toBe("passed");
		expect(reportProtectedExperimentV0(out).refusedRecords).toEqual([]);
	});

	it("B3: refuses an evaluator reached through a link into the agent directory, and a hard link of hidden material", async () => {
		const spec = specWith({ honest: solve });
		const agentDir = spec.conditions[0]!.agent.directory;
		const evaluatorFile = spec.tasks[0]!.evaluator.file;
		const evaluatorDir = join(evaluatorFile, "..");
		// The evaluator moved into the agent directory, and reached through links from elsewhere.
		const inside = join(agentDir, "ev");
		mkdirSync(inside);
		for (const part of ["evaluator.json", "reference", "negative"])
			renameSync(join(evaluatorDir, part), join(inside, part));
		const links = fresh("links");
		for (const part of ["evaluator.json", "reference", "negative"])
			symlinkSync(join(inside, part), join(links, part));
		const linked = {
			...spec,
			tasks: [
				{ ...spec.tasks[0]!, evaluator: { ...spec.tasks[0]!.evaluator, file: join(links, "evaluator.json") } },
			],
		};
		await expect(runProtectedExperimentV0({ spec: linked, dir: fresh("run") })).rejects.toThrow(
			/overlaps an evaluator's material/,
		);
		// A hard link of the definition inside the agent directory (same content, another path).
		const spec2 = specWith({ honest: solve });
		linkSync(spec2.tasks[0]!.evaluator.file, join(spec2.conditions[0]!.agent.directory, "cases.json"));
		await expect(runProtectedExperimentV0({ spec: spec2, dir: fresh("run") })).rejects.toThrow(/hidden material/);
	});

	it("Codex: a takeover in progress is refused, and the lock is never left free or replaced", async () => {
		const out = fresh("run");
		mkdirSync(out, { recursive: true });
		const stale = JSON.stringify({ pid: 999999, startTime: "1" });
		writeFileSync(join(out, ".lock"), stale);
		mkdirSync(join(out, ".lock.takeover"));
		await expect(runProtectedExperimentV0({ spec: specWith({ honest: solve }), dir: out })).rejects.toThrow(
			/taking over this run directory's lock/,
		);
		expect(readFileSync(join(out, ".lock"), "utf8")).toBe(stale);
		expect(existsSync(join(out, "protected-run.json"))).toBe(false);
	});

	it("Codex: the boundary probe never touches a task's own workspace files", async () => {
		const keep = `import fs from "node:fs"; fs.writeFileSync("/work/seen", fs.readFileSync("/work/.endo-probe", "utf8")); ${solve}`;
		const base = specWith({ keep });
		const spec = {
			...base,
			tasks: [{ ...base.tasks[0]!, workspace: { ...base.tasks[0]!.workspace, ".endo-probe": "task fixture\n" } }],
		};
		const out = fresh("run");
		await runProtectedExperimentV0({ spec, dir: out });
		expect(readFileSync(join(workOf(out, "keep"), "seen"), "utf8")).toBe("task fixture\n");
	});

	it("Codex: an agent file's executable bit is part of the agent's identity", () => {
		const dir = fresh("tree");
		writeFileSync(join(dir, "helper"), "#!/bin/sh\n", { mode: 0o644 });
		const before = endoTreeDigestV0(dir);
		chmodSync(join(dir, "helper"), 0o755);
		expect(endoTreeDigestV0(dir)).not.toBe(before);
	});

	it("Codex: an attempt stopped after its preflight but before its agent's scope was recorded never ran its agent, and can be retried", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: solve });
		await runProtectedExperimentV0({ spec, dir: out });
		const attempt = join(out, "trials", "merge-intervals", "honest", "0", "attempt-1");
		// Keep only what exists between the preflight and the agent's launch: the marker, the workspace and an established preflight.
		for (const name of [
			"record.json",
			"agent-scope.json",
			"agent-started.json",
			"agent-ended.json",
			"agent.log",
			"submission",
			"evaluation-scope.json",
		])
			rmSync(join(attempt, name), { recursive: true, force: true });
		expect(JSON.parse(readFileSync(join(attempt, "preflight.json"), "utf8")).status).toBe("established");
		await runProtectedExperimentV0({ spec, dir: out });
		const r = recordOf(out, "honest");
		expect(r.agent).toMatchObject({ status: "not-run", termination: "not-applicable", scope: null });
		expect(r.invalidating).toEqual(["controller-interrupted"]);
		await runProtectedExperimentV0({ spec, dir: out, retryInterrupted: true });
		expect(recordOf(out, "honest", 0, 2)).toMatchObject({ trial: { retryOf: 1 }, evaluation: { status: "passed" } });
	});

	it("Codex: a reference directory reached through a link still counts as hidden material", async () => {
		const spec = specWith({ honest: solve });
		const evaluatorDir = join(spec.tasks[0]!.evaluator.file, "..");
		// The reference lives elsewhere, reached through a link from the evaluator directory.
		const elsewhere = fresh("reference-elsewhere");
		renameSync(join(evaluatorDir, "reference"), join(elsewhere, "reference"));
		symlinkSync(join(elsewhere, "reference"), join(evaluatorDir, "reference"));
		// The agent directory holds an identical copy of the hidden reference file, under another name.
		writeFileSync(
			join(spec.conditions[0]!.agent.directory, "notes.mjs"),
			readFileSync(join(elsewhere, "reference", "src", "interval.mjs")),
		);
		await expect(runProtectedExperimentV0({ spec, dir: fresh("run") })).rejects.toThrow(/hidden material/);
	});

	it("M5: an attempt the controller stopped after the agent ended keeps the agent's facts", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: solve });
		await runProtectedExperimentV0({ spec, dir: out });
		const attempt = join(out, "trials", "merge-intervals", "honest", "0", "attempt-1");
		rmSync(join(attempt, "record.json"));
		await runProtectedExperimentV0({ spec, dir: out });
		const r = recordOf(out, "honest");
		expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
		expect(r.invalidating).toEqual(["controller-interrupted"]);
	});

	it("M7: the report refuses a record sealed with another agent profile or evaluator", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: solve });
		await runProtectedExperimentV0({ spec, dir: out });
		const path = join(out, "trials", "merge-intervals", "honest", "0", "attempt-1", "record.json");
		const { recordSha256: _old, ...rest } = JSON.parse(readFileSync(path, "utf8"));
		rest.isolation.profileSha256 = "0".repeat(64);
		rmSync(path);
		writeFileSync(path, JSON.stringify(sealEndoProtectedTrialV0(rest)));
		const report = reportProtectedExperimentV0(out);
		expect(report.refusedRecords).toEqual([
			{
				path: "trials/merge-intervals/honest/0/attempt-1/record.json",
				reason: "the record names another agent profile",
			},
		]);
		expect(report.cells[0]).toMatchObject({ qualified: 0, attrition: { "record-refused": 1 } });
	});

	it("M1: a submission that replaces the driver's output passes only by printing the correct results", async () => {
		const forge = (values: string) =>
			`import fs from "node:fs"; fs.writeFileSync("/work/src/interval.mjs", ${JSON.stringify(
				`const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => String(c).includes("ENDO-EVALUATION") ? true : w(c, ...a); w("ENDO-EVALUATION " + JSON.stringify(${values}) + "\\n"); export function mergeIntervals() { throw new Error("no"); }`,
			)});`;
		const out = fresh("run");
		await runProtectedExperimentV0({
			spec: specWith({ wrong: forge(`Array.from({ length: 7 }, () => ({ ok: true, value: [] }))`) }),
			dir: out,
		});
		expect(recordOf(out, "wrong").evaluation).toMatchObject({ status: "failed", cases: { total: 7, passed: 1 } });
	});
});

// ---- process containment (systemd user scopes; non-destructive: only this test's own processes, in uniquely named scopes) ----------

const scopeLoaded = (unit: string): string =>
	spawnSync("/usr/bin/systemctl", ["--user", "show", `${unit}.scope`, "-p", "LoadState", "--value"], {
		env: containment?.env ?? {},
		encoding: "utf8",
	}).stdout.trim();

describe.runIf(REAL)("real isolation: every sandbox runs in its own scope", () => {
	const solve = `import { writeFileSync } from "node:fs"; writeFileSync("/work/src/interval.mjs", ${JSON.stringify(SOLUTION)});`;

	it("records the agent's scope before starting it, and confirms through the user manager that it ended", async () => {
		const out = fresh("run");
		await runProtectedExperimentV0({ spec: specWith({ honest: solve }), dir: out });
		const r = recordOf(out, "honest");
		const recorded = JSON.parse(
			readFileSync(join(out, "trials", "merge-intervals", "honest", "0", "attempt-1", "agent-scope.json"), "utf8"),
		).unit;
		expect(r.agent.scope).toEqual({ unit: recorded, established: true, ended: "confirmed" });
		// The preflight and evaluation sandboxes' scopes are recorded too, and gone.
		for (const name of ["preflight", "evaluation"]) {
			const rec = JSON.parse(
				readFileSync(
					join(out, "trials", "merge-intervals", "honest", "0", "attempt-1", `${name}-scope.json`),
					"utf8",
				),
			);
			expect(rec.unit, name).toMatch(/^endo-sandbox-[0-9a-f]{24}$/);
			expect(scopeLoaded(rec.unit), name).toBe("not-found");
		}
		expect(r.agent.termination).toBe("confirmed");
		expect(r.isolation.containment).toMatchObject({ mechanism: "systemd-user-scope", tasksMax: 512 });
		expect(scopeLoaded(recorded)).toBe("not-found");
	});

	it("identifies the sandbox before its command can run, so even an instant command is reported started and ended", async () => {
		// Codex 4501423402: a command that finished before the controller handled bubblewrap's status was reported not started, and its
		// scope not established. The init now waits on a release pipe until it is identified.
		const runtime = resolveRuntimeV0(["/usr/bin/node"]);
		if (!runtime.ok || !detected.ok) throw new Error("unreachable");
		for (let i = 0; i < 5; i++) {
			const work = fresh("instant");
			const profile = buildSandboxProfileV0({
				runtime: runtime.files,
				mounts: [{ target: "/work", kind: "rw-dir", role: "workspace", source: work }],
				env: { PATH: "/usr/bin" },
				cwd: "/work",
				tmpfsBytes: 1 << 20,
			});
			const seen: { ranEarly: boolean; aliveAtIdentification: boolean }[] = [];
			const r = await runSandboxV0(
				detected.bwrap,
				profile,
				["/usr/bin/node", "-e", 'require("node:fs").writeFileSync("/work/RAN", "1")'],
				{
					timeoutMs: 10_000,
					outputBytes: 4096,
					containment,
					onStarted: (init) => {
						const alive = processAliveV0(init);
						// Held here for 300 ms: a command that were already running would have written its file by now.
						const until = Date.now() + 300;
						while (Date.now() < until) {
							/* hold the controller */
						}
						seen.push({ ranEarly: existsSync(join(work, "RAN")), aliveAtIdentification: alive });
					},
				},
			);
			expect(seen).toEqual([{ ranEarly: false, aliveAtIdentification: true }]);
			expect(existsSync(join(work, "RAN"))).toBe(true);
			expect(r.started).toBe(true);
			expect(r.exitCode).toBe(0);
			expect(r.init).not.toBeNull();
			expect(r.scope.established).toBe(true);
			expect(r.termination).toBe("confirmed");
		}
	});
	it("runs bubblewrap inside the scope it named, from its first instruction", async () => {
		const runtime = resolveRuntimeV0(["/usr/bin/node"]);
		if (!runtime.ok || !detected.ok) throw new Error("unreachable");
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [],
			env: { PATH: "/usr/bin" },
			cwd: "/tmp",
			tmpfsBytes: 1 << 20,
		});
		let named = "";
		const r = await runSandboxV0(detected.bwrap, profile, ["/usr/bin/node", "-e", "0"], {
			timeoutMs: 10_000,
			outputBytes: 4096,
			containment,
			onScope: (unit) => {
				named = unit;
			},
		});
		expect(r.scope).toEqual({ unit: named, established: true, ended: "confirmed" });
		expect(r.termination).toBe("confirmed");
		expect(scopeLoaded(named)).toBe("not-found");
	});

	it("is ended by the user manager at its RuntimeMaxSec, whatever the controller does", async () => {
		const unit = newScopeUnitV0();
		const t0 = Date.now();
		const child = spawn(containment.systemdRun, scopeArgsV0(containment, unit, 2, ["/usr/bin/sleep", "60"]), {
			env: containment.env,
			stdio: "ignore",
		});
		try {
			const code = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
			const elapsed = Date.now() - t0;
			expect(code).not.toBe(0);
			expect(elapsed).toBeGreaterThanOrEqual(1500);
			expect(elapsed).toBeLessThan(15_000);
			expect(await stopScopeV0(containment, unit)).toBe("confirmed");
		} finally {
			child.kill("SIGKILL");
			await stopScopeV0(containment, unit);
		}
	}, 30_000);

	it("ends a process that ignores SIGTERM promptly, on stop and at RuntimeMaxSec (SIGKILL, not a 90-second grace)", async () => {
		for (const how of ["stop", "deadline"] as const) {
			const unit = newScopeUnitV0();
			const t0 = Date.now();
			const child = spawn(
				containment.systemdRun,
				scopeArgsV0(containment, unit, how === "deadline" ? 2 : 60, [
					"/usr/bin/sh",
					"-c",
					"trap '' TERM; sleep 60",
				]),
				{ env: containment.env, stdio: "ignore" },
			);
			const closed = new Promise<void>((r) => child.on("close", () => r()));
			try {
				if (how === "stop") {
					await new Promise((r) => setTimeout(r, 500));
					expect(await stopScopeV0(containment, unit)).toBe("confirmed");
				}
				await closed;
				expect(Date.now() - t0, how).toBeLessThan(12_000);
				expect(scopeLoaded(unit), how).toBe("not-found");
			} finally {
				child.kill("SIGKILL");
				await stopScopeV0(containment, unit);
			}
		}
	}, 40_000);

	it("bounds how many tasks a sandbox can start (TasksMax), against the same sandbox under the default bound", async () => {
		const runtime = resolveRuntimeV0(["/usr/bin/node"]);
		if (!runtime.ok || !detected.ok) throw new Error("unreachable");
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [],
			env: { PATH: "/usr/bin" },
			cwd: "/tmp",
			tmpfsBytes: 1 << 20,
		});
		// Each node child needs several threads once it runs; TasksMax counts threads. What is compared is how many children are still
		// alive after a moment: all of them under the default bound, fewer under a tight one (fork or thread creation refused).
		const script = `const cp = require("child_process"); const kids = []; for (let i = 0; i < 8; i++) { try { const c = cp.spawn("/usr/bin/node", ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore" }); c.on("error", () => {}); kids.push(c); } catch {} } setTimeout(() => { const ok = kids.filter((c) => c.pid && c.exitCode === null && c.signalCode === null).length; console.log(JSON.stringify({ ok, refused: 8 - ok })); process.exit(0); }, 1500);`;
		const count = async (c: EndoContainmentV0) => {
			const r = await runSandboxV0(detected.bwrap, profile, ["/usr/bin/node", "-e", script], {
				timeoutMs: 20_000,
				outputBytes: 4096,
				containment: c,
			});
			expect(r.termination).toBe("confirmed");
			const line = r.stdout.toString("utf8").trim().split("\n").pop() ?? "";
			return line.startsWith("{")
				? (JSON.parse(line) as { ok: number; refused: number })
				: { ok: -1, refused: -1, stderr: r.stderr.toString("utf8").slice(0, 200) };
		};
		const free = await count(containment);
		expect(free).toEqual({ ok: 8, refused: 0 });
		const bounded = await count({ ...containment, tasksMax: 20 });
		expect(bounded.ok).toBeGreaterThanOrEqual(0);
		expect(bounded.ok).toBeLessThan(8);
	}, 60_000);

	it("refuses protected execution when the user manager or its tools are unavailable, and runs nothing", async () => {
		const out = fresh("run");
		const marker = join(fresh("marker"), "RAN");
		const spec = specWith({ marker: `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "1");` });
		await expect(
			runProtectedExperimentV0({ spec, dir: out, containmentTools: { systemdRun: "/nonexistent/systemd-run" } }),
		).rejects.toThrow(/process containment unavailable/);
		const saved = process.env.XDG_RUNTIME_DIR;
		delete process.env.XDG_RUNTIME_DIR;
		try {
			await expect(runProtectedExperimentV0({ spec, dir: out })).rejects.toThrow(
				/process containment unavailable: no user manager/,
			);
		} finally {
			process.env.XDG_RUNTIME_DIR = saved;
		}
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(out, "protected-run.json"))).toBe(false);
	});
});

// ---- refusal, everywhere -------------------------------------------------------------------------------------------------------------------

describe("refusal instead of an unprotected fallback", () => {
	it("refuses when bubblewrap is missing or not a trusted executable, and runs nothing", async () => {
		const out = fresh("run");
		const marker = join(fresh("marker"), "RAN");
		const spec = specWith({ marker: `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "1");` });
		await expect(
			runProtectedExperimentV0({ spec, dir: out, bwrapCandidates: ["/nonexistent/bwrap"] }),
		).rejects.toThrow(/isolation unavailable \(missing\)/);
		const fake = join(fresh("fake-bwrap"), "bwrap");
		writeFileSync(fake, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
		await expect(runProtectedExperimentV0({ spec, dir: out, bwrapCandidates: [fake] })).rejects.toThrow(
			/isolation unavailable \(untrusted-executable\)/,
		);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(out, "protected-run.json"))).toBe(false);
	});

	it("refuses a runtime that is a link or not root-owned, and an agent argv outside the declared runtime", () => {
		expect(resolveRuntimeV0(["/bin/sh"])).toMatchObject({ ok: false, reason: "runtime-unacceptable" });
		const own = join(fresh("own"), "node");
		writeFileSync(own, "x", { mode: 0o755 });
		expect(resolveRuntimeV0([own])).toMatchObject({ ok: false, reason: "runtime-unacceptable" });
		expect(() => specWith({}, { conditions: [] })).toThrow();
		const bad = readEndoProtectedSpecV0({
			...JSON.parse(JSON.stringify(specWith({ a: "" }))),
			conditions: [{ id: "a", description: "a", agent: { directory: "/tmp", argv: ["/bin/sh", "-c", "id"] } }],
		});
		expect(bad.ok).toBe(false);
	});

	it.runIf(REAL)("runs a sandbox with no host environment and only pipes as file descriptors", async () => {
		if (!detected.ok || !runtime().ok) return;
		const profile = buildSandboxProfileV0({
			runtime: (runtime() as { files: Parameters<typeof buildSandboxProfileV0>[0]["runtime"] }).files as never,
			mounts: [],
			env: { PATH: "/usr/bin" },
			cwd: "/tmp",
			tmpfsBytes: 1024 * 1024,
		});
		process.env.ENDO_TEST_LEAK = "leak";
		try {
			const r = await runSandboxV0(
				detected.bwrap,
				profile,
				["/usr/bin/node", "-e", "console.log(JSON.stringify(process.env))"],
				{
					timeoutMs: 10_000,
					outputBytes: 4096,
					containment,
				},
			);
			expect(JSON.parse(r.stdout.toString("utf8"))).toEqual({ PATH: "/usr/bin", PWD: "/tmp" });
		} finally {
			delete process.env.ENDO_TEST_LEAK;
		}
	});
});

function runtime() {
	return resolveRuntimeV0(["/usr/bin/node"]);
}
