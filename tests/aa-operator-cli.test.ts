import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readVerifiedInitialBranchSetV0 } from "../cli/initial-branch-set.ts";
import type { AaOperatorConfigV0 } from "../research/governed-initial-continuation/aa/operator.ts";
import { slotPath } from "../research/governed-initial-continuation/aa/reader.ts";
import {
	provenanceEndPathV0,
	provenancePathV0,
} from "../research/governed-initial-continuation/aa/task-owned-provenance.ts";
import { type AaRig, createAaRig, portIsFree, runningFrom, sleep } from "./fixtures/aa-operator-rig.ts";

const operate = join(process.cwd(), "research/governed-initial-continuation/aa/operate.ts");
const hasScript = spawnSync("script", ["--version"]).status === 0;
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** A real pseudo-terminal: `script` gives the command a controlling terminal on stdin, stdout and stderr. */
class Pty {
	output = "";
	private consumed = 0;
	readonly child: ChildProcessWithoutNullStreams;
	readonly exit: Promise<number | null>;
	constructor(command: string) {
		this.child = spawn("script", ["-qefc", `stty cols 250; echo PID=$$; exec ${command}`, "/dev/null"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (chunk) => {
			this.output += String(chunk).replace(ansi, "");
		});
		this.exit = new Promise((resolve) => this.child.once("close", (code) => resolve(code)));
	}
	get pid() {
		return Number(/PID=([0-9]+)/.exec(this.output)?.[1]);
	}
	async waitFor(pattern: RegExp, timeoutMs = 90000): Promise<RegExpExecArray> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const match = pattern.exec(this.output.slice(this.consumed));
			if (match) {
				this.consumed += match.index + match[0].length;
				return match;
			}
			if (Date.now() > deadline || this.child.exitCode !== null)
				throw new Error(`pattern ${pattern} not seen; output so far:\n${this.output.slice(-1500)}`);
			await sleep(20);
		}
	}
	/** Types a line, as an operator would. */
	type(line: string) {
		this.child.stdin.write(`${line}\r`);
	}
	raw(text: string) {
		this.child.stdin.write(text);
	}
	kill() {
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}
}
const prompt = /Type (APPROVE .+?) to (start|approve ONLY)/;

let rig: AaRig;
const live: Pty[] = [];
const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
beforeAll(async () => {
	rig = await createAaRig();
}, 240000);
afterAll(async () => {
	expect(sentinel.exitCode).toBeNull();
	sentinel.kill("SIGKILL");
	await rig?.close();
});
afterEach(() => {
	for (const pty of live.splice(0)) pty.kill();
	rig.backend.setHealth([]);
	expect(runningFrom(rig.relay)).toEqual([]);
});

const open = (config: string, mode = "--run") => {
	const pty = new Pty(`${process.execPath} ${operate} ${mode} ${config}`);
	live.push(pty);
	return pty;
};
const tree = (root: string): string[] =>
	readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		const stat = lstatSync(path);
		return [`${path}:${stat.size}:${stat.mtimeMs}:${stat.mode}`, ...(entry.isDirectory() ? tree(path) : [])];
	});
const snapshot = (config: AaOperatorConfigV0) => [
	...tree(config.outputParent),
	...tree(config.server.workingDirectory),
	`requests:${rig.backend.requests.length}`,
];
const ready = [{ status: 503 }, { status: 200, body: '{"status":"ok"}' }];
const nothingHappened = async (config: AaOperatorConfigV0) => {
	expect(existsSync(provenancePathV0(config.studyFile))).toBe(false);
	expect(existsSync(config.studyFile)).toBe(false);
	expect(await portIsFree(config.server.port)).toBe(true);
};
/** Answers every approval prompt with its own exact phrase until the command ends; returns the phrases it typed. */
async function approveEverything(pty: Pty, expected: number): Promise<string[]> {
	const typed: string[] = [];
	for (let n = 0; n < expected; n++) {
		const [, phrase] = await pty.waitFor(prompt);
		typed.push(phrase!);
		pty.type(phrase!);
	}
	return typed;
}

describe.runIf(process.platform === "linux" && hasScript)(
	"the A/A operator command: refusals before anything runs",
	() => {
		it("never takes an approval from a pipe, a file, a flag or the environment", async () => {
			const config = await rig.newConfig();
			const file = rig.writeConfig(config);
			const before = snapshot(config);
			const env = { ...process.env, APPROVE: "yes", ENDO_APPROVE: "1", ENDO_ASSUME_YES: "1", CI: "1" };
			const answers = "APPROVE TASK-OWNED SERVER 0000000000000000\nyes\nyes\n";
			// Everything piped.
			const piped = spawnSync(process.execPath, [operate, "--run", file], {
				input: answers,
				encoding: "utf8",
				env,
			});
			expect(piped.status).toBe(1);
			expect(piped.stderr).toContain("needs a terminal");
			// stdin from a file, and from /dev/null.
			const answersFile = join(mkdtempSync(join(rig.fixture.base, "answers-")), "yes");
			writeFileSync(answersFile, answers);
			for (const source of [answersFile, "/dev/null"]) {
				const redirected = spawnSync(
					"sh",
					["-c", `exec "$0" "$@" < ${source}`, process.execPath, operate, "--run", file],
					{ encoding: "utf8", env },
				);
				expect(redirected.status).toBe(1);
				expect(redirected.stderr).toContain("needs a terminal");
			}
			// stdout is a terminal but stdin is a pipe carrying "approvals".
			const stdinPipe = new Pty(`sh -c 'printf "yes\\nyes\\n" | ${process.execPath} ${operate} --run ${file}'`);
			live.push(stdinPipe);
			expect(await stdinPipe.exit).toBe(1);
			expect(stdinPipe.output).toContain("needs a terminal");
			// stdin is a terminal but stdout is a pipe.
			const stdoutPipe = new Pty(`sh -c '${process.execPath} ${operate} --run ${file} | cat'`);
			live.push(stdoutPipe);
			await stdoutPipe.exit;
			expect(stdoutPipe.output).not.toContain("APPROVAL");
			expect(stdoutPipe.output).toContain("needs a terminal on both stdin and stdout");
			// A terminal that is not this session's controlling terminal is no terminal either.
			const uncontrolled = spawnSync(
				"python3",
				[
					"-c",
					"import os,pty,subprocess,sys\nm,s=pty.openpty()\np=subprocess.run(sys.argv[1:],stdin=s,stdout=s,stderr=subprocess.PIPE,start_new_session=True)\nsys.stdout.write(p.stderr.decode())\nsys.exit(p.returncode)",
					process.execPath,
					operate,
					"--run",
					file,
				],
				{ encoding: "utf8", env },
			);
			expect(uncontrolled.status).toBe(1);
			expect(uncontrolled.stdout).toContain("controlling terminal");
			// Nothing was started, written or requested by any of these.
			expect(snapshot(config)).toEqual(before);
			await nothingHappened(config);
		}, 60000);
		it.each([
			["no mode", []],
			["no path", ["--run"]],
			["no path for inspect", ["--inspect"]],
			["an approval flag", ["--yes", "<config>"]],
			["a trailing approval flag", ["--run", "<config>", "--yes"]],
			["an extra argument", ["--run", "<config>", "extra"]],
			["an unknown mode", ["--approve", "<config>"]],
			["two modes", ["--run", "--inspect", "<config>"]],
			["a short flag", ["-r", "<config>"]],
			["a relative path", ["--run", "config.json"]],
			["a missing file", ["--inspect", "/nonexistent/config.json"]],
		])("rejects %s", async (_name, args) => {
			const config = await rig.newConfig();
			const file = rig.writeConfig(config);
			const before = snapshot(config);
			const result = spawnSync(process.execPath, [operate, ...args.map((a) => (a === "<config>" ? file : a))], {
				encoding: "utf8",
				input: "yes\n",
			});
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(snapshot(config)).toEqual(before);
			await nothingHappened(config);
		});
		it("rejects an incomplete, mistyped, widened or linked configuration, and defaults nothing", async () => {
			const config = await rig.newConfig();
			const { seed: _seed, ...withoutSeed } = config;
			const { port: _port, ...serverWithoutPort } = config.server;
			const variants: Array<[string, unknown, number?]> = [
				["a missing seed", withoutSeed],
				["a missing server port", { ...config, server: serverWithoutPort }],
				["an unknown field", { ...config, approve: true }],
				["an unknown server field", { ...config, server: { ...config.server, autoApprove: true } }],
				["a string seed", { ...config, seed: "0" }],
				["a relative model path", { ...config, server: { ...config.server, modelPath: "model.gguf" } }],
				["a relative key file", { ...config, keyFile: "key" }],
				["an empty prompt", { ...config, prompt: "" }],
				["a non-object", []],
				["a group-readable file", config, 0o640],
			];
			for (const [name, value, mode] of variants) {
				const result = spawnSync(process.execPath, [operate, "--inspect", rig.writeConfig(value, mode)], {
					encoding: "utf8",
				});
				expect(result.status, name).toBe(1);
				expect(result.stdout, name).toBe("");
			}
			const target = rig.writeConfig(config);
			const link = join(mkdtempSync(join(rig.fixture.base, "link-")), "config.json");
			symlinkSync(target, link);
			expect(spawnSync(process.execPath, [operate, "--inspect", link], { encoding: "utf8" }).status).toBe(1);
			await nothingHappened(config);
		}, 60000);
	},
);

describe.runIf(process.platform === "linux")("the A/A operator command --inspect", () => {
	it.each([
		[0, "baseline → alternative → alternative → baseline"],
		[1, "alternative → baseline → baseline → alternative"],
	])(
		"describes the study for seed %i and has no side effect",
		async (seed, order) => {
			const config = await rig.newConfig({ seed });
			const file = rig.writeConfig(config);
			const before = snapshot(config);
			const result = spawnSync(process.execPath, [operate, "--inspect", file], { encoding: "utf8" });
			expect(result.status).toBe(0);
			const document = JSON.parse(result.stdout);
			expect(document).toMatchObject({ mode: "inspect", effects: "none", requestsSent: 0 });
			expect(document.summary.order.join(" → ")).toBe(order);
			expect(document.summary.endpoint).toBe(`http://127.0.0.1:${config.server.port}`);
			expect(document.summary.limits).toMatchObject({ maxModelRequests: 8, slots: 4 });
			expect(result.stdout).not.toContain(readFileSync(rig.keyFile, "utf8").trim().slice(-40));
			expect(result.stdout).not.toContain(config.prompt);
			// No server, no Pi, no study, no port, no request, no file: the world is exactly as it was.
			expect(snapshot(config)).toEqual(before);
			expect(runningFrom(rig.relay)).toEqual([]);
			await nothingHappened(config);
			expect(rig.backend.requests.length).toBe(Number(before.at(-1)!.split(":")[1]));
		},
		60000,
	);
	it("refuses a study location that already holds evidence, and a changed sibling pair", async () => {
		const config = await rig.newConfig();
		writeFileSync(provenancePathV0(config.studyFile), "{}", { mode: 0o600 });
		const used = spawnSync(process.execPath, [operate, "--inspect", rig.writeConfig(config)], {
			encoding: "utf8",
		});
		expect(used.status).toBe(1);
		expect(used.stderr).toContain("already holds evidence");
		const other = await rig.newConfig();
		const wrong = spawnSync(
			process.execPath,
			[operate, "--inspect", rig.writeConfig({ ...other, preparation: "missing-preparation" })],
			{ encoding: "utf8" },
		);
		expect(wrong.status).toBe(1);
	});
});

describe.runIf(process.platform === "linux" && hasScript)(
	"the A/A operator command --run through a real terminal",
	() => {
		it("a wrong or empty answer at the server approval starts nothing", async () => {
			for (const answer of ["yes", "", "APPROVE TASK-OWNED SERVER 0000000000000000"]) {
				const config = await rig.newConfig();
				const pty = open(rig.writeConfig(config));
				const before = rig.backend.requests.length;
				await pty.waitFor(prompt);
				expect(runningFrom(rig.relay)).toEqual([]);
				pty.type(answer);
				expect(await pty.exit).toBe(1);
				expect(pty.output).toContain("REFUSED");
				expect(rig.backend.requests.length).toBe(before);
				await nothingHappened(config);
			}
		}, 120000);
		it("EOF at the server approval starts nothing", async () => {
			const config = await rig.newConfig();
			const pty = open(rig.writeConfig(config));
			await pty.waitFor(prompt);
			pty.raw("\x04");
			expect(await pty.exit).toBe(1);
			await nothingHappened(config);
		}, 60000);
		it.each([
			[0, ["baseline", "alternative", "alternative", "baseline"]],
			[1, ["alternative", "baseline", "baseline", "alternative"]],
		])(
			"runs the full fake study for seed %i with a separate typed approval for every turn",
			async (seed, order) => {
				const config = await rig.newConfig({ seed });
				rig.backend.setHealth(ready);
				const before = rig.backend.completionRequests().length;
				const pty = open(rig.writeConfig(config));
				const phrases = await approveEverything(pty, 9);
				expect(await pty.exit).toBe(0);
				expect(new Set(phrases).size).toBe(9);
				expect(phrases[0]).toMatch(/^APPROVE TASK-OWNED SERVER /);
				expect(phrases.slice(1).map((p) => p.split(" ")[1])).toEqual(
					Array(4).fill(["FIRST", "CONTINUATION"]).flat(),
				);
				// Each approval names the slot and arm it covers.
				for (const [n, arm] of order.entries()) {
					expect(pty.output).toContain(`slot ${n + 1} of 4, first turn`);
					expect(pty.output).toContain(arm);
				}
				expect(pty.output).toContain("COMPLETE-UNDER-DECLARED-ASSUMPTIONS");
				expect(pty.output).toContain("OWNERSHIP_UNVERIFIED");
				expect(pty.output).toContain("owned-server cleanup    confirmed");
				expect(pty.output).not.toContain(config.prompt);
				expect(rig.backend.completionRequests().length - before).toBe(8);
				const armsRun = [1, 2, 3, 4].map(
					(n) => JSON.parse(readFileSync(slotPath(config.studyFile, n, "start"), "utf8")).arm,
				);
				expect(armsRun).toEqual(order);
				// A separate, fresh process reads the finished evidence.
				const fresh = spawnSync(
					process.execPath,
					[
						"research/governed-initial-continuation/aa/read-private.ts",
						"--task-owned",
						config.studyFile,
						rig.keyFile,
						join(mkdtempSync(join(rig.fixture.base, "reread-")), "out.json"),
					],
					{ encoding: "utf8" },
				);
				expect(fresh.status).toBe(0);
				expect(fresh.stdout).toContain("admission complete");
				expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
				expect(await portIsFree(config.server.port)).toBe(true);
				expect(runningFrom(rig.relay)).toEqual([]);
				expect(
					readVerifiedInitialBranchSetV0(
						config.source,
						config.replay,
						rig.fixture.key,
						config.outputParent,
						config.preparation,
					).status,
				).toBe("verified-pristine");
			},
			300000,
		);
		it("a first-turn phrase typed at the continuation prompt authorises nothing", async () => {
			const config = await rig.newConfig();
			rig.backend.setHealth(ready);
			const before = rig.backend.completionRequests().length;
			const pty = open(rig.writeConfig(config));
			const [, server] = await pty.waitFor(prompt);
			pty.type(server!);
			const [, first] = await pty.waitFor(prompt);
			pty.type(first!);
			await pty.waitFor(/Type APPROVE CONTINUATION/);
			pty.type(first!); // The previous approval, offered again.
			expect(await pty.exit).toBe(1);
			expect(rig.backend.completionRequests().length - before).toBe(1);
			expect(pty.output).toContain("PARTIAL");
			expect(pty.output).not.toContain("COMPLETE-UNDER");
			expect(pty.output).toContain("cleanup    confirmed");
		}, 120000);
		it.each([
			["EOF", (pty: Pty) => pty.raw("\x04")],
			["Ctrl-C", (pty: Pty) => pty.raw("\x03")],
			["SIGTERM", (pty: Pty) => process.kill(pty.pid, "SIGTERM")],
			["SIGHUP", (pty: Pty) => process.kill(pty.pid, "SIGHUP")],
			["SIGINT", (pty: Pty) => process.kill(pty.pid, "SIGINT")],
		])(
			"%s at the first-turn approval spends the slot, sends nothing and stops the server",
			async (_name, interrupt) => {
				const config = await rig.newConfig();
				rig.backend.setHealth(ready);
				const before = rig.backend.completionRequests().length;
				const pty = open(rig.writeConfig(config));
				const [, server] = await pty.waitFor(prompt);
				pty.type(server!);
				await pty.waitFor(/Type APPROVE FIRST/);
				interrupt(pty);
				expect(await pty.exit).toBe(1);
				expect(rig.backend.completionRequests().length - before).toBe(0);
				expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
				expect(existsSync(slotPath(config.studyFile, 1, "end"))).toBe(true);
				expect(existsSync(slotPath(config.studyFile, 2, "start"))).toBe(false);
				expect(await portIsFree(config.server.port)).toBe(true);
				// The terminal is still there to tell the operator, and an interrupted run is never shown as complete.
				expect(pty.output).toContain("A/A operator outcome: PARTIAL");
				expect(pty.output).toContain("(interrupted)");
				expect(pty.output).toContain("owned-server cleanup    confirmed");
				expect(pty.output).not.toContain("COMPLETE-UNDER");
			},
			120000,
		);
		it.each([
			["Ctrl-C", (pty: Pty) => pty.raw("\x03")],
			["SIGTERM", (pty: Pty) => process.kill(pty.pid, "SIGTERM")],
			["SIGHUP", (pty: Pty) => process.kill(pty.pid, "SIGHUP")],
		])(
			"%s while the model is still loading stops the wait and the server",
			async (_name, interrupt) => {
				const config = await rig.newConfig();
				rig.backend.setHealth([{ status: 503 }]);
				const before = rig.backend.completionRequests().length;
				const pty = open(rig.writeConfig(config));
				const [, server] = await pty.waitFor(prompt);
				pty.type(server!);
				for (let i = 0; i < 400 && !existsSync(provenancePathV0(config.studyFile)); i++) await sleep(25);
				await sleep(400); // The readiness poll is now running against a server that only ever says "loading".
				expect(runningFrom(rig.relay).length).toBe(1);
				interrupt(pty);
				expect(await pty.exit).toBe(1);
				expect(rig.backend.completionRequests().length - before).toBe(0);
				expect(existsSync(config.studyFile)).toBe(false);
				expect(existsSync(provenanceEndPathV0(config.studyFile))).toBe(true);
				expect(await portIsFree(config.server.port)).toBe(true);
			},
			120000,
		);
		it("a server that never reports ready is refused with no study and no request", async () => {
			const config = await rig.newConfig({}, { modelReadyTimeoutMs: 1500 });
			rig.backend.setHealth([{ status: 404 }]);
			const before = rig.backend.completionRequests().length;
			const pty = open(rig.writeConfig(config));
			const [, server] = await pty.waitFor(prompt);
			pty.type(server!);
			expect(await pty.exit).toBe(1);
			expect(pty.output).toContain("REFUSED");
			expect(pty.output).toContain("not reported ready");
			expect(pty.output).not.toMatch(/Type APPROVE FIRST/);
			expect(rig.backend.completionRequests().length - before).toBe(0);
			expect(existsSync(config.studyFile)).toBe(false);
		}, 120000);
	},
);
