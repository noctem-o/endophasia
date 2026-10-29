// `endo harness attach <root> --control --workbench` as a real process under a real pseudo-terminal, against the fake Pi. This is the
// test that matters most for the authority boundary: the prompt is requested over HTTP, and it is sent only after the operator TYPES
// the exact phrase on the process's controlling terminal. Also the refusals: no terminal, no --control.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EndoEventV0 } from "../protocol/event.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const hasScript = spawnSync("script", ["--version"]).status === 0;
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => void | Promise<void>)[] = [];
const ptys: Pty[] = [];

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
				throw new Error(`pattern ${pattern} not seen; output so far:\n${this.output.slice(-1500)}`);
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
	// The checkout serves the frontend built into studio-ui/dist (ignored by git), as `npm run cockpit` does.
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
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

describe("endo harness attach --workbench refusals", () => {
	it("refuses without a terminal, and without --control, before Pi is identified or anything is created", () => {
		const root = join(temp("endo-wbcli-"), "store");
		const noTerminal = spawnSync(process.execPath, [CLI, "harness", "attach", root, "--control", "--workbench"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(noTerminal.status).toBe(1);
		expect(noTerminal.stderr).toContain("needs a terminal");
		const noControl = spawnSync(process.execPath, [CLI, "harness", "attach", root, "--workbench"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(noControl.status).toBe(1);
		expect(noControl.stderr).toContain("use it with --control");
		expect(existsSync(root)).toBe(false);
	});
});

describe.runIf(hasScript && process.platform === "linux")(
	"endo harness attach --control --workbench under a pseudo-terminal",
	() => {
		it("sends a prompt only after the exact phrase is typed on the terminal, and a wrong phrase sends nothing", async () => {
			const install = installFakePi("1.0.0");
			cleanup.push(() => install.remove());
			const root = temp("endo-wbcli-root-");
			const cwd = temp("endo-wbcli-cwd-");
			const xdg = temp("endo-wbcli-xdg-");
			const env = { ...process.env, XDG_DATA_HOME: xdg, ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) };
			const pty = new Pty(
				`${process.execPath} ${CLI} harness attach ${root} --pi ${install.bin} --cwd ${cwd} --control --workbench`,
				env,
			);
			const address = (await pty.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
			const code = (await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
			expect(pty.output).toContain("only you, here, can approve a prompt");
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
					Record<string, any>
				>;
			const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
			expect((await post("pair", { code })).status).toBe(401); // single use
			expect(await getJson("status")).toMatchObject({ connection: "connected", run: "idle", paired: true });

			// First prompt: the operator types a WRONG phrase. Nothing is sent.
			const first = (await (await post("prompt/propose", { message: "Count to forty" }, grant)).json()) as {
				proposalId: string;
			};
			const phrase = (await pty.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!;
			expect(pty.output).toContain("Count to forty");
			await sleep(400);
			expect(await getJson(`prompt/${first.proposalId}`, grant)).toMatchObject({ state: "awaiting-approval" });
			pty.type("APPROVE PROMPT 0000000000000000");
			let view: Record<string, any> = {};
			for (let i = 0; i < 100 && view.state !== "refused"; i++) {
				await sleep(50);
				view = await getJson(`prompt/${first.proposalId}`, grant);
			}
			expect(view).toMatchObject({ state: "refused", reason: "authorization-denied" });
			expect((await getJson("transcript", grant)).items).toEqual([]);

			// Second prompt: the exact phrase is typed. Now it is sent.
			const second = (await (await post("prompt/propose", { message: "Count to forty" }, grant)).json()) as {
				proposalId: string;
			};
			const phrase2 = (await pty.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!;
			expect(phrase2).not.toBe(phrase);
			pty.type(phrase2);
			for (let i = 0; i < 200 && view.state !== "accepted"; i++) {
				await sleep(50);
				view = await getJson(`prompt/${second.proposalId}`, grant);
			}
			expect(view).toMatchObject({ state: "accepted" });
			let transcript: { items: { kind: string; role?: string; state?: string }[] } = { items: [] };
			for (let i = 0; i < 400; i++) {
				transcript = (await getJson("transcript", grant)) as typeof transcript;
				if (transcript.items.some((x) => x.kind === "run" && x.state === "ended")) break;
				await sleep(50);
			}
			expect(transcript.items.some((x) => x.role === "user")).toBe(true);
			expect(transcript.items.some((x) => x.role === "assistant")).toBe(true);

			// Ending the process: the broker is disposed, the listener is gone, the exit is clean, and the chain is in the store.
			// Ctrl+C TYPED on the terminal (it is in raw mode, so readline sees it, not the process): it must stop the workbench.
			pty.child.stdin.write("\x03");
			expect(await pty.exit).toBe(0);
			await expect(fetch(`${api}status`)).rejects.toBeDefined();
			const store = createEndoDurableEventStoreV0(root, { readOnly: true });
			const events: EndoEventV0[] = [];
			for (let after = 0; ; ) {
				const page = store.page({ afterSequence: after, limit: 10_000 });
				if (page.events.length === 0) break;
				events.push(...page.events);
				after = page.nextAfterSequence;
			}
			store.close();
			const chain = events
				.filter((e) => e.kind.startsWith("workbench."))
				.map(
					(e) =>
						`${e.kind}${(e.payload as { reason?: string }).reason ? `:${(e.payload as { reason?: string }).reason}` : ""}`,
				);
			expect(chain).toEqual([
				"workbench.prompt-proposed",
				"workbench.prompt-authorized",
				"workbench.prompt-refused:authorization-denied",
				"workbench.prompt-proposed",
				"workbench.prompt-authorized",
				"workbench.prompt-dispatched",
				"workbench.prompt-accepted",
			]);
			expect(JSON.stringify(events)).not.toContain("Count to forty");
		}, 120_000);
	},
);
