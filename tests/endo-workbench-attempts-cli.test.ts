// The whole operator path, as real processes under a real pseudo-terminal (docs/designs/develop-attempt-execution.md):
//
//   endo project add / task add / attempt prepare            (CLI)
//   endo harness attach --control --workbench --project P    (the live workbench, a real controlling terminal, the fake Pi or a real Pi)
//     `attempt <id>` typed there → the brief shown whole → a WRONG phrase declines → `attempt <id>` → the right phrase sends it
//   Ctrl-C                                                    (the attached process ends)
//   endo attempt show                                         (a new process reads what the session recorded)
//   endo attempt check -- <command>                           (independent verification: a receipt, not acceptance)
//   endo task show                                            (the task's status is still the operator's: unchanged)
//
// With ENDO_PI_EXECUTABLE set, the same path runs against that installed Pi with the local fake OpenAI-compatible endpoint as its only
// model provider (no credentials, no cost), in a scratch HOME and agent directory.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const hasScript = spawnSync("script", ["--version"]).status === 0;
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => void | Promise<void>)[] = [];
const ptys: Pty[] = [];
const realPi = process.env.ENDO_PI_EXECUTABLE;

class Pty {
	output = "";
	private consumed = 0;
	readonly child: ChildProcessWithoutNullStreams;
	readonly exit: Promise<number | null>;
	constructor(command: string, env: NodeJS.ProcessEnv) {
		this.child = spawn("script", ["-qefc", `stty cols 250; exec ${command}`, "/dev/null"], {
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.child.stdout.on("data", (chunk) => {
			this.output += String(chunk).replace(ansi, "");
		});
		this.exit = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
		ptys.push(this);
	}
	async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<RegExpExecArray> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const match = pattern.exec(this.output.slice(this.consumed));
			if (match) {
				this.consumed += match.index + match[0].length;
				return match;
			}
			if (Date.now() > deadline || this.child.exitCode !== null)
				throw new Error(`pattern ${pattern} not seen; output so far:\n${this.output.slice(-2500)}`);
			await sleep(25);
		}
	}
	type(line: string) {
		this.child.stdin.write(`${line}\r`);
	}
	kill() {
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}
}

beforeAll(async () => {
	const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(fileURLToPath(new URL("../studio-ui/dist", import.meta.url)));
}, 90_000);
afterEach(async () => {
	for (const pty of ptys.splice(0)) pty.kill();
	for (const done of cleanup.splice(0).reverse()) await done();
});
afterAll(() => {});

const temp = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

function endo(env: NodeJS.ProcessEnv, ...args: string[]) {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}

/** A committed Git worktree for the project, so `endo attempt check` can run in it. */
function gitProject(dir: string) {
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
			cwd: dir,
			encoding: "utf8",
		});
	git("init", "-q", "-b", "main");
	writeFileSync(join(dir, "README"), "demo\n");
	git("add", "README");
	git("commit", "-q", "-m", "initial");
}

async function scenario(subject: { bin: string; env: NodeJS.ProcessEnv; provider?: string[] }) {
	const root = temp("endo-wbac-root-");
	const cwd = temp("endo-wbac-cwd-");
	gitProject(cwd);
	const env = subject.env;
	const project = endo(env, "project", "add", "--root", root, "--name", "Demo", "--path", cwd).json().project
		.id as string;
	const task = endo(
		env,
		"task",
		"add",
		"--root",
		root,
		"--project",
		project,
		"--title",
		"Say hello",
		"--acceptance",
		"a greeting",
	).json().task.id as string;
	const attempt = endo(
		env,
		"attempt",
		"prepare",
		"--root",
		root,
		"--project",
		project,
		"--task",
		task,
		"--objective",
		"Say hello in one short sentence. Do not use any tools.",
	).json().attempt.id as string;
	const pty = new Pty(
		`${process.execPath} ${CLI} harness attach ${root} --pi ${subject.bin} --cwd ${cwd} ${(subject.provider ?? []).join(" ")} --control --workbench --project ${project}`,
		env,
	);
	await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/, 120_000);

	// 1. Asked on the terminal, shown whole, and a prompt's phrase (the wrong operation) declines it. Nothing is recorded for the attempt.
	pty.type(`attempt ${attempt}`);
	const phrase = (await pty.waitFor(/Type (APPROVE ATTEMPT [0-9a-f]{16}) to send exactly this brief/))[1]!;
	expect(pty.output).toContain(`attempt     ${attempt}`);
	expect(pty.output).toContain("--- the exact brief, sent as the prompt ---");
	expect(pty.output).toContain("Say hello in one short sentence.");
	expect(pty.output).toContain("Terminal approval is not a sandbox");
	pty.type(phrase.replace("ATTEMPT", "PROMPT"));
	await pty.waitFor(/was not sent \(authorization-denied\)\. This request recorded no authorisation/);
	expect(endo(env, "attempt", "show", "--root", root, "--attempt", attempt).json().attempt.execution).toBeNull();

	// 2. Asked again and approved with its own phrase: it is bound, sent, and Pi acknowledges it.
	pty.type(`attempt ${attempt}`);
	const phrase2 = (await pty.waitFor(/Type (APPROVE ATTEMPT [0-9a-f]{16}) to send exactly this brief/))[1]!;
	expect(phrase2).not.toBe(phrase);
	pty.type(phrase2);
	await pty.waitFor(/was sent and Pi accepted it \(started\)/, 120_000);

	// 3. While the workbench runs, another process reads the run's progress from the files; it is not a live control.
	let shown: Record<string, any> = {};
	for (let i = 0; i < 600; i++) {
		shown = endo(env, "attempt", "show", "--root", root, "--attempt", attempt).json().attempt;
		if (shown.execution?.run !== "open" && shown.execution?.run !== "not-observed") break;
		await sleep(100);
	}
	// 4. It cannot be sent twice.
	pty.type(`attempt ${attempt}`);
	await pty.waitFor(/attempt not requested \(already-authorized\)/);

	// 5. The process ends. A new process, later, reads the same relation.
	pty.child.stdin.write("\x03");
	expect(await pty.exit).toBe(0);
	const after = endo(env, "attempt", "show", "--root", root, "--attempt", attempt);
	const read = after.json().attempt;
	expect(read.execution).toMatchObject({
		send: "runtime-accepted",
		disposition: "started",
		evidence: "complete",
		brief: "matches",
	});
	expect(read.authorized).toMatchObject({ attemptId: attempt, approvedBy: "operator", via: "workbench-terminal" });
	expect(read.state).toBe("prepared");
	expect(after.stderr).toContain("it is not verification");

	// 6. Independent verification is a separate act with its own record; it moves no status.
	const check = endo(
		env,
		"attempt",
		"check",
		"--root",
		root,
		"--attempt",
		attempt,
		"--",
		process.execPath,
		"-e",
		"process.exit(0)",
	);
	expect(check.status).toBe(0);
	expect(check.json().receipt.outcome).toBe("passed");
	// 7. The task is still the operator's to decide.
	const listed = endo(env, "task", "list", "--root", root, "--project", project).json();
	expect(JSON.stringify(listed)).toContain('"status":"open"');
	return { read, output: pty.output };
}

describe.runIf(hasScript && process.platform === "linux")("the operator path under a pseudo-terminal", () => {
	it("against the fake Pi: request, decline, approve, send once, recover later, verify separately", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const xdg = temp("endo-wbac-xdg-");
		const { read } = await scenario({
			bin: install.bin,
			env: { ...process.env, XDG_DATA_HOME: xdg, ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) },
		});
		expect(read.execution.run).toBe("completed");
	}, 180_000);
});

describe.runIf(hasScript && process.platform === "linux" && realPi !== undefined && realPi.length > 0)(
	"the operator path against a REAL installed Pi and a fake model endpoint (opt-in: ENDO_PI_EXECUTABLE)",
	() => {
		let server: FakeOpenAiServer;
		beforeAll(async () => {
			server = await startFakeOpenAiServer({ slowChunkMs: 20 });
		});
		afterAll(async () => {
			await server?.close();
		});

		it("sends the brief to real Pi once, and the relation is recovered after the process ends", async () => {
			const scratch = temp("endo-wbac-realpi-");
			const agentDir = join(scratch, "agent");
			const home = join(scratch, "home");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(home, { recursive: true });
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						endofake: {
							baseUrl: server.baseUrl,
							api: "openai-completions",
							apiKey: "local",
							models: [{ id: "fake-1" }],
						},
					},
				}),
			);
			const { read, output } = await scenario({
				bin: realPi as string,
				provider: ["--provider", "endofake", "--model", "fake-1"],
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					XDG_DATA_HOME: join(scratch, "xdg"),
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
					PI_TELEMETRY: "0",
				},
			});
			// What real Pi reported for the run, exactly as recorded; the test records it rather than assuming it.
			process.stderr.write(`real Pi: send=${read.execution.send} run=${read.execution.run}\n`);
			// With ENDO_ATTEMPT_EVIDENCE_DIR set, keep the reading and the terminal transcript (all scratch data) for the record.
			const keep = process.env.ENDO_ATTEMPT_EVIDENCE_DIR;
			if (keep !== undefined && keep.length > 0) {
				mkdirSync(keep, { recursive: true });
				const version = spawnSync(realPi as string, ["--version"], { encoding: "utf8" }).stdout.trim();
				writeFileSync(
					join(keep, "attempt-show.json"),
					`${JSON.stringify({ piVersion: version, attempt: read }, null, 2)}\n`,
				);
				writeFileSync(join(keep, "terminal.txt"), output);
				writeFileSync(
					join(keep, "model-requests.json"),
					`${JSON.stringify(
						server.requests.map((r) => ({ method: r.method, url: r.url })),
						null,
						2,
					)}\n`,
				);
			}
			expect(read.execution.run).toBe("completed");
			expect(server.requests.length).toBeGreaterThan(0);
			expect(output).not.toContain("an internal error occurred");
		}, 300_000);
	},
);
