// DEVELOP-UX-001 (research/develop-ux/DEVELOP-UX-001.md): the everyday start. `endo develop` is `endo harness attach --control
// --workbench` and nothing else, so what matters here is what did NOT change: the controlling-terminal refusal before anything is
// created, the pairing, and a prompt that is sent only after its exact phrase is typed on that terminal. What did change is pinned too:
// the workbench's page opens on DEVELOP, and a launch with no --project says, as a hint only, when its directory is a registered project.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENDO_USAGE_LINE_V0, endoHelpV0 } from "../cli/help.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const hasScript = spawnSync("script", ["--version"]).status === 0;
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => void | Promise<void>)[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

/** A process under a real pseudo-terminal (`script`), as tests/endo-workbench-cli.test.ts runs the workbench. */
function pty(command: string, env: NodeJS.ProcessEnv) {
	const child = spawn("script", ["-qefc", `stty cols 250; exec ${command}`, "/dev/null"], {
		stdio: ["pipe", "pipe", "pipe"],
		env,
	});
	children.push(child);
	const state = { output: "", consumed: 0 };
	child.stdout.on("data", (chunk) => {
		state.output += String(chunk).replace(ansi, "");
	});
	const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
	return {
		exit,
		output: () => state.output,
		type: (line: string) => child.stdin.write(`${line}\r`),
		interrupt: () => child.stdin.write("\x03"),
		async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<RegExpExecArray> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const match = pattern.exec(state.output.slice(state.consumed));
				if (match) {
					state.consumed += match.index + match[0].length;
					return match;
				}
				if (Date.now() > deadline || child.exitCode !== null)
					throw new Error(`pattern ${pattern} not seen; output so far:\n${state.output.slice(-1500)}`);
				await sleep(25);
			}
		},
	};
}

const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

beforeAll(async () => {
	const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(fileURLToPath(new URL("../studio-ui/dist", import.meta.url)));
}, 90_000);
afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	for (const done of cleanup.splice(0).reverse()) await done();
});

describe("endo develop: the same command, spelled for everyday use", () => {
	it("is listed, and described as the attach it is", () => {
		expect(ENDO_USAGE_LINE_V0).toContain("|develop|");
		expect(endoHelpV0()).toContain('"harness attach ... --control --workbench", without --prompt');
		expect(endoHelpV0()).toContain("every prompt, steer and stop is approved on this terminal");
	});

	it("refuses without a terminal exactly as the attach does, before Pi is identified or anything is created", () => {
		const root = join(temp("endo-ux-"), "store");
		// A Pi that does not exist: if a spelling ever got past the terminal check, it would fail here and never reach a real Pi.
		const pi = ["--pi", join(root, "no-such-pi")];
		const run = (argv: string[]) =>
			spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		const develop = run(["develop", root, ...pi]);
		const attach = run(["harness", "attach", root, ...pi, "--control", "--workbench"]);
		expect([develop.status, develop.stderr]).toEqual([attach.status, attach.stderr]);
		expect(develop.status).toBe(1);
		expect(develop.stderr).toContain("approvals are never read from a pipe or a file");
		// Naming the switches again changes nothing, and the alias adds no flag of its own.
		expect(run(["develop", root, ...pi, "--control", "--workbench"]).stderr).toBe(attach.stderr);
		expect(run(["develop", root, ...pi, "--approve"]).stderr).toContain("unknown flag --approve");
		expect(existsSync(root)).toBe(false);
	});

	it("cannot be talked out of the workbench: a switch spelled as a value, or a flag left without one, never starts a session", () => {
		const root = join(temp("endo-ux-"), "store");
		const pi = ["--pi", join(root, "no-such-pi")];
		const run = (argv: string[]) =>
			spawnSync(process.execPath, [CLI, "develop", root, ...pi, ...argv], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		// The review's cases: each once became `attach --control --prompt "--workbench"`, a session with no workbench and a prompt sent.
		for (const [argv, words] of [
			[["--control", "--prompt"], "the flag --prompt needs a value"],
			[["--prompt", "--workbench"], "endo develop takes no --prompt"],
			[["--prompt", "--control"], "endo develop takes no --prompt"],
			[["--prompt", "Summarise this project"], "endo develop takes no --prompt"],
			[["--cwd", "--control"], "approvals are never read from a pipe or a file"],
			[["--cwd", "--workbench"], "approvals are never read from a pipe or a file"],
			[["--project"], "the flag --project needs a value"],
		] as const) {
			const result = run([...argv]);
			expect([argv, result.status], result.stderr).toEqual([argv, 1]);
			expect(result.stderr, argv.join(" ")).toContain(words);
			expect(result.stderr, argv.join(" ")).not.toContain("no-such-pi");
		}
		expect(existsSync(root)).toBe(false);
	});
});

describe.runIf(hasScript && process.platform === "linux")("endo develop under a pseudo-terminal", () => {
	it("opens the page on DEVELOP, hints at a registered project without choosing it, and still sends nothing without the typed phrase", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-ux-root-");
		const cwd = temp("endo-ux-cwd-");
		const env = { ...process.env, XDG_DATA_HOME: temp("endo-ux-xdg-"), ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) };
		// The operator registered this directory earlier; this launch does not name it.
		const added = spawnSync(
			process.execPath,
			[CLI, "project", "add", "--root", root, "--name", "Parser work", "--path", cwd],
			{ encoding: "utf8", env },
		);
		const projectId = /endo\.project\.[0-9a-f]{32}/.exec(added.stdout)?.[0];
		expect(projectId).toBeDefined();

		const term = pty(`${process.execPath} ${CLI} develop ${root} --pi ${install.bin} --cwd ${cwd}`, env);
		const address = (await term.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
		const code = (await term.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
		expect(term.output()).toContain("only you, here, can approve a prompt or an intervention");
		// The hint names the project and how to ask for it. It is words on the terminal: the launch has no project.
		await term.waitFor(
			/no project was named, so the page shows no tasks\. The task file registers this directory as "Parser work"/,
		);
		expect(term.output()).toContain(`(${projectId})`);
		expect(term.output()).toContain("Check it with `endo project list`");

		// The page says where it opens, in the page itself; the read-only Studio's page is unchanged (tests/endo-workspace-cli.test.ts).
		expect(await (await fetch(address)).text()).toContain('<html lang="en" data-start="develop">');

		const origin = new URL(address).origin;
		const api = `${address}api/v0/workbench/`;
		const post = (route: string, body: unknown, grant?: string) =>
			fetch(`${api}${route}`, {
				method: "POST",
				headers: {
					Origin: origin,
					"Content-Type": "application/json",
					...(grant ? { "X-Endo-Grant": grant } : {}),
				},
				body: JSON.stringify(body),
			});
		const getJson = async (route: string, grant?: string) =>
			(await fetch(`${api}${route}`, { headers: grant ? { "X-Endo-Grant": grant } : {} })).json() as Promise<
				Record<string, unknown>
			>;
		// Nothing is asked or read without the pairing code from the terminal.
		expect((await post("prompt/propose", { message: "Count to forty" })).status).toBe(401);
		const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
		// The hint chose nothing: this launch has no project, so no task is shown or writable.
		expect(await getJson("workspace", grant)).toEqual({
			available: false,
			schemaVersion: "endo.develop-workspace.v1",
		});

		// A request from the page waits for the terminal. Anything but its exact phrase declines it, and nothing reaches Pi.
		const asked = (await (await post("prompt/propose", { message: "Count to forty" }, grant)).json()) as {
			proposalId: string;
		};
		const declined = (await term.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!;
		await sleep(300);
		expect(await getJson(`prompt/${asked.proposalId}`, grant)).toMatchObject({ state: "awaiting-approval" });
		// The right phrase with one space after it is not the phrase.
		term.type(`${declined} `);
		let view: Record<string, unknown> = {};
		for (let i = 0; i < 100 && view.state !== "refused"; i++) {
			await sleep(50);
			view = await getJson(`prompt/${asked.proposalId}`, grant);
		}
		expect(view).toMatchObject({ state: "refused", reason: "authorization-denied" });
		expect((await getJson("transcript", grant)).items).toEqual([]);

		// The exact phrase, typed there, sends it: the alias is the same approval path, not a second one.
		const again = (await (await post("prompt/propose", { message: "Count to forty" }, grant)).json()) as {
			proposalId: string;
		};
		const phrase = (await term.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!;
		term.type(phrase);
		for (let i = 0; i < 200 && view.state !== "accepted"; i++) {
			await sleep(50);
			view = await getJson(`prompt/${again.proposalId}`, grant);
		}
		expect(view).toMatchObject({ state: "accepted" });
		expect(phrase).not.toBe(declined);
		// The empty transcript above meant something: once approved, the prompt is there.
		let items: unknown[] = [];
		for (let i = 0; i < 200 && items.length === 0; i++) {
			await sleep(50);
			items = (await getJson("transcript", grant)).items as unknown[];
		}
		expect(items.length).toBeGreaterThan(0);

		term.interrupt();
		expect(await term.exit).toBe(0);
	}, 120_000);
});
