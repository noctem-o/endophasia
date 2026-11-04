// The whole operator path with the request made from the PAGE (docs/designs/develop-attempt-workbench.md), as real processes: the real
// CLI under a real pseudo-terminal (`endo harness attach --control --workbench --project P`), the real built page in a real browser paired
// with the code that terminal shows, and the fake Pi, or, opt-in, a real installed Pi with a local fake model endpoint.
//
//   endo project add / task add / attempt prepare            (CLI)
//   the page: pair, Task, open the attempt, "Request sending"   (only a request: nothing is sent)
//   the terminal: shown whole, "requested from the paired page"; its APPROVE ATTEMPT phrase is typed THERE
//   the page: the request reads as sent and acknowledged; the attempt's execution is read back from the records
//   Ctrl-C, then `endo attempt show` in a new process, `endo attempt check`, `endo task list` (the status is still the operator's)
//
// Set ENDO_SHOTS_DIR to write screenshots of the page (synthetic fixtures), ENDO_ATTEMPT_EVIDENCE_DIR to keep the real-Pi run's readings.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const hasScript = spawnSync("script", ["--version"]).status === 0;
const executable = findBrowser();
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => void | Promise<void>)[] = [];
const ptys: Pty[] = [];
const tabs: Page[] = [];
const realPi = process.env.ENDO_PI_EXECUTABLE;
let browser: Browser;

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

const runs = hasScript && process.platform === "linux" && executable !== null;
beforeAll(async () => {
	if (!runs) return;
	const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(fileURLToPath(new URL("../studio-ui/dist", import.meta.url)));
	browser = await Browser.launch(executable as string);
}, 90_000);
afterEach(async () => {
	await Promise.all(tabs.splice(0).map((p) => p.close()));
	for (const pty of ptys.splice(0)) pty.kill();
	for (const done of cleanup.splice(0).reverse()) await done();
});
afterAll(async () => {
	await browser?.close();
});

const temp = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};
function endo(env: NodeJS.ProcessEnv, ...args: string[]) {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}
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
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const shot = async (page: Page, name: string) => {
	const dir = process.env.ENDO_SHOTS_DIR;
	if (dir !== undefined && dir !== "") writeFileSync(join(dir, `${name}.png`), await page.screenshot());
};

async function scenario(subject: { bin: string; env: NodeJS.ProcessEnv; provider?: string[]; label: string }) {
	const root = temp("endo-wbap-root-");
	const cwd = temp("endo-wbap-cwd-");
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
	const address = (await pty.waitFor(/workbench: (http:\/\/127\.0\.0\.1:[0-9]+\/\S*)/, 120_000))[1]!;
	const code = (await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;

	// The page: paired with the terminal's code, it opens the task and the attempt and asks. Asking sends nothing.
	const page = await browser.open(1440, 900);
	tabs.push(page);
	await page.goto(address);
	await page.waitFor("document.querySelector('button[data-workspace=develop]')", 60_000);
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=pair-code]')", 60_000);
	await fill(page, "[data-testid=pair-code]", code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
	await page.click("[data-testid=tab-task]");
	await page.waitFor("document.querySelector('[data-testid=task-picker]')");
	await page.click("[data-testid=task-picker]");
	// Choosing the task in the page selects it (the attempts shown are the selected task's); choosing sends nothing.
	await page.waitFor("document.querySelector('[data-testid=task-option]')");
	await page.click("[data-testid=task-option]");
	await page.waitFor("document.querySelector('[data-testid=attempt] details')");
	await page.eval("document.querySelector('[data-testid=attempt] details').open = true");
	await page.waitFor("!document.querySelector('[data-testid=attempt-request-send]')?.disabled", 60_000);
	await page.click("[data-testid=attempt-request-send]");

	// The terminal: told the page asked, shown the brief whole, and only its phrase, typed there, sends it.
	const phrase = (await pty.waitFor(/Type (APPROVE ATTEMPT [0-9a-f]{16}) to send exactly this brief/))[1]!;
	expect(pty.output).toContain("requested   from the paired page");
	expect(pty.output).toContain(`attempt     ${attempt}`);
	expect(pty.output).toContain("Say hello in one short sentence.");
	await page.waitFor(
		"document.querySelector('[data-testid=attempt-request-status]')?.dataset.state === 'awaiting-approval'",
	);
	await shot(page, `${subject.label}-awaiting-approval`);
	expect(endo(env, "attempt", "show", "--root", root, "--attempt", attempt).json().attempt.execution).toBeNull();
	pty.type(phrase);

	// The page reads the request as sent and acknowledged, then the attempt's execution from the records as they are written.
	await page.waitFor(
		"['accepted', 'unknown'].includes(document.querySelector('[data-testid=attempt-request-status]')?.dataset.state)",
		120_000,
	);
	let run = "";
	for (let i = 0; i < 600; i += 1) {
		run = await page.eval<string>("document.querySelector('[data-testid=attempt-execution]')?.dataset.run ?? ''");
		if (run !== "" && run !== "open" && run !== "not-observed") break;
		await page.waitFor("!document.querySelector('[data-testid=tasks-refresh]').disabled");
		await page.click("[data-testid=tasks-refresh]");
		await sleep(250);
	}
	await page.eval("document.querySelector('[data-testid=attempt-execution]')?.scrollIntoView({ block: 'center' })");
	await shot(page, `${subject.label}-execution`);
	const pageSaid = {
		request: await page.text("[data-testid=attempt-request-status]"),
		execution: await page.text("[data-testid=attempt-execution]"),
		next: await page.text("[data-testid=next-step]"),
	};
	expect(page.seen.problems).toEqual([]);
	// It cannot be asked again, from the page or the terminal.
	expect(await page.eval<boolean>("!document.querySelector('[data-testid=attempt-request-send]')")).toBe(true);
	pty.type(`attempt ${attempt}`);
	await pty.waitFor(/attempt not requested \(already-authorized\)/);

	// The process ends. A new process, later, reads the same relation; verification and the task's status stay separate acts.
	pty.child.stdin.write("\x03");
	expect(await pty.exit).toBe(0);
	const read = endo(env, "attempt", "show", "--root", root, "--attempt", attempt).json().attempt;
	expect(read.execution).toMatchObject({ send: "runtime-accepted", disposition: "started", brief: "matches" });
	expect(read.authorized).toMatchObject({ attemptId: attempt, approvedBy: "operator", via: "workbench-terminal" });
	expect(read.state).toBe("prepared");
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
	expect(check.json().receipt.outcome).toBe("passed");
	const listed = endo(env, "task", "list", "--root", root, "--project", project).json();
	expect(JSON.stringify(listed)).toContain('"status":"open"');
	return { read, run, pageSaid, output: pty.output };
}

describe.runIf(runs)("the page-requested attempt, end to end under a pseudo-terminal", () => {
	it("against the fake Pi: asked from the page, approved on the terminal, sent once, recovered later", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const xdg = temp("endo-wbap-xdg-");
		const { read, run, pageSaid } = await scenario({
			bin: install.bin,
			env: { ...process.env, XDG_DATA_HOME: xdg, ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) },
			label: "fake-pi",
		});
		expect(run).toBe("completed");
		expect(read.execution.run).toBe("completed");
		expect(pageSaid.request).toContain("Sent once. Pi replied: started");
		expect(pageSaid.execution).toContain("Pi reported the run completed. Not verified");
	}, 300_000);
});

describe.runIf(runs && realPi !== undefined && realPi.length > 0)(
	"the page-requested attempt against a REAL installed Pi and a fake model endpoint (opt-in: ENDO_PI_EXECUTABLE)",
	() => {
		let server: FakeOpenAiServer;
		beforeAll(async () => {
			server = await startFakeOpenAiServer({ slowChunkMs: 20 });
		});
		afterAll(async () => {
			await server?.close();
		});

		it("asked from the page, approved on the terminal, sent to real Pi once, recovered after the process ends", async () => {
			const scratch = temp("endo-wbap-realpi-");
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
			const { read, run, pageSaid, output } = await scenario({
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
				label: "real-pi",
			});
			process.stderr.write(`real Pi (page request): send=${read.execution.send} run=${read.execution.run}\n`);
			const keep = process.env.ENDO_ATTEMPT_EVIDENCE_DIR;
			if (keep !== undefined && keep.length > 0) {
				mkdirSync(keep, { recursive: true });
				const version = spawnSync(realPi as string, ["--version"], { encoding: "utf8" }).stdout.trim();
				writeFileSync(
					join(keep, "page-attempt-show.json"),
					`${JSON.stringify({ piVersion: version, attempt: read, pageSaid }, null, 2)}\n`,
				);
				writeFileSync(join(keep, "page-terminal.txt"), output);
				writeFileSync(
					join(keep, "page-model-requests.json"),
					`${JSON.stringify(
						server.requests.map((r) => ({ method: r.method, url: r.url })),
						null,
						2,
					)}\n`,
				);
			}
			expect(run).toBe("completed");
			expect(server.requests.length).toBeGreaterThan(0);
			expect(output).not.toContain("an internal error occurred");
		}, 300_000);
	},
);
