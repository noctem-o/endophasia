// `endo harness attach <root> --control --workbench` as a real process under a real pseudo-terminal, against the fake Pi. This is the
// test that matters most for the authority boundary: the prompt is requested over HTTP, and it is sent only after the operator TYPES
// the exact phrase on the process's controlling terminal. Also the refusals: no terminal, no --control.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
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
			expect(pty.output).toContain("only you, here, can approve a prompt or an intervention");
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

		it("says when a page's message is this terminal's own command, and what a bare `attempt` needs (REVIEW-PILOT-001, run 1)", async () => {
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

			// A bare `attempt` at the terminal: what it takes, and where the id comes from; nothing is asked or sent.
			pty.type("attempt");
			await pty.waitFor(/`attempt` takes one attempt id, typed here: `attempt endo\.attempt\.<32 hex digits>`/);

			// The page asks for a prompt whose whole text is the terminal's attempt command: the approval says so before the phrase.
			const id = `endo.attempt.${"0".repeat(32)}`;
			const asked = (await (await post("prompt/propose", { message: `attempt ${id}` }, grant)).json()) as {
				proposalId: string;
			};
			await pty.waitFor(/Type APPROVE PROMPT [0-9a-f]{16} to send exactly this prompt/);
			const screen = pty.output.slice(pty.output.lastIndexOf("=== WORKBENCH: approve this prompt? ==="));
			expect(screen).toContain(
				"NOTE: this prompt is the text of this terminal's `attempt` command. Approving sends it to Pi as a chat message. It does NOT send any attempt's brief",
			);
			expect(screen.indexOf("NOTE:")).toBeLessThan(screen.indexOf("Type APPROVE PROMPT"));
			pty.type("no");
			let view: Record<string, any> = {};
			for (let i = 0; i < 100 && view.state !== "refused"; i++) {
				await sleep(50);
				view = await getJson(`prompt/${asked.proposalId}`, grant);
			}
			expect(view).toMatchObject({ state: "refused", reason: "authorization-denied" });

			// An ordinary prompt gets no such note.
			const plain = (await (
				await post("prompt/propose", { message: "attempt it again, carefully" }, grant)
			).json()) as {
				proposalId: string;
			};
			await pty.waitFor(/Type APPROVE PROMPT [0-9a-f]{16} to send exactly this prompt/);
			const second = pty.output.slice(pty.output.lastIndexOf("=== WORKBENCH: approve this prompt? ==="));
			expect(second).toContain("attempt it again, carefully");
			expect(second).not.toContain("NOTE:");
			pty.type("no");
			view = {};
			for (let i = 0; i < 100 && view.state !== "refused"; i++) {
				await sleep(50);
				view = await getJson(`prompt/${plain.proposalId}`, grant);
			}
			expect(view).toMatchObject({ state: "refused", reason: "authorization-denied" });
			pty.child.stdin.write("\x03");
			expect(await pty.exit).toBe(0);
		}, 60_000);

		it("steers, then stops, an open run only on the exact phrase for that operation, typed on the terminal", async () => {
			const install = installFakePi("1.0.0");
			cleanup.push(() => install.remove());
			const root = temp("endo-wbcli-iv-");
			const cwd = temp("endo-wbcli-ivcwd-");
			const xdg = temp("endo-wbcli-ivxdg-");
			const log = join(temp("endo-wbcli-ivlog-"), "commands.log");
			// The controls are offered only for admitted capabilities: record the live study first, in the same root.
			const studier = new PiAttachmentV0({
				root,
				cwd,
				executable: install.bin,
				env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
				requestTimeoutMs: 10_000,
			});
			await studier.checkLocal();
			await studier.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
			const env = { ...process.env, XDG_DATA_HOME: xdg, ...fakePiEnv({ FAKE_PI_STEP_MS: "250", FAKE_PI_LOG: log }) };
			const pty = new Pty(
				`${process.execPath} ${CLI} harness attach ${root} --pi ${install.bin} --cwd ${cwd} --control --workbench`,
				env,
			);
			const address = (await pty.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
			const code = (await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
			const origin = new URL(address).origin;
			const api = `${address}api/v0/workbench/`;
			const post = async (route: string, body: unknown, grant?: string) =>
				(await fetch(`${api}${route}`, {
					method: "POST",
					headers: {
						Origin: origin,
						"Content-Type": "application/json",
						...(grant ? { "X-Endo-Grant": grant } : {}),
					},
					body: JSON.stringify(body),
				})) as Response;
			const getJson = async (route: string, grant?: string) =>
				(await fetch(`${api}${route}`, { headers: grant ? { "X-Endo-Grant": grant } : {} })).json() as Promise<
					Record<string, any>
				>;
			const until = async (what: string, ok: () => Promise<boolean>) => {
				for (let i = 0; i < 400; i++) {
					if (await ok()) return;
					await sleep(50);
				}
				throw new Error(`never: ${what}\n${pty.output.slice(-1200)}`);
			};
			const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
			const sent = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

			// Nothing to steer while idle: not offered, and a forced request is refused with nothing written to the terminal.
			expect((await getJson("status")).offers.steer).toMatchObject({ offered: false });
			expect((await post("intervention/propose", { operation: "stop" }, grant)).status).toBe(409);

			// A prompt opens a run (its own phrase), which the interventions then act on.
			const prompt = (await (await post("prompt/propose", { message: "Count to forty" }, grant)).json()) as {
				proposalId: string;
			};
			const promptPhrase = (await pty.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!;
			pty.type(promptPhrase);
			await until(
				"prompt accepted",
				async () => (await getJson(`prompt/${prompt.proposalId}`, grant)).state === "accepted",
			);
			await until("run active", async () => (await getJson("status")).run === "active");
			expect((await getJson("status")).offers).toMatchObject({ steer: { offered: true }, stop: { offered: true } });
			const base = sent().length;

			// The prompt's phrase does not approve a steer: the approval is for the exact operation and digest.
			const steerText = "STEER-CANARY-0f3a say hello too";
			const wrong = (await (
				await post("intervention/propose", { operation: "steer", message: steerText }, grant)
			).json()) as { proposalId: string };
			const deniedPhrase = (await pty.waitFor(/Type (APPROVE STEER [0-9a-f]{16}) to send exactly this steer/))[1]!;
			expect(pty.output).toContain(steerText);
			expect(pty.output).toContain("after its current turn's tool calls and before the next model request");
			pty.type(promptPhrase);
			await until(
				"denied",
				async () => (await getJson(`intervention/${wrong.proposalId}`, grant)).state === "refused",
			);
			expect(await getJson(`intervention/${wrong.proposalId}`, grant)).toMatchObject({
				reason: "authorization-denied",
				approved: false,
			});
			expect(sent().slice(base)).not.toContain("steer");

			// The right phrase sends exactly one steer.
			const steer = (await (
				await post("intervention/propose", { operation: "steer", message: steerText }, grant)
			).json()) as { proposalId: string };
			const steerPhrase = (await pty.waitFor(/Type (APPROVE STEER [0-9a-f]{16}) to send exactly this steer/))[1]!;
			expect(steerPhrase).not.toBe(promptPhrase);
			expect(steerPhrase).not.toBe(deniedPhrase); // each request has its own digest, so its own phrase
			await sleep(300);
			expect(await getJson(`intervention/${steer.proposalId}`, grant)).toMatchObject({ state: "awaiting-approval" });
			expect(sent().slice(base)).not.toContain("steer");
			pty.type(steerPhrase);
			await until(
				"steer accepted",
				async () => (await getJson(`intervention/${steer.proposalId}`, grant)).state === "accepted",
			);
			expect(
				sent()
					.slice(base)
					.filter((c) => c === "steer"),
			).toHaveLength(1);

			// A stop: its own wording and phrase, sent, and answered by Pi once the run is idle.
			const stop = (await (await post("intervention/propose", { operation: "stop" }, grant)).json()) as {
				proposalId: string;
			};
			const stopPhrase = (await pty.waitFor(/Type (APPROVE STOP [0-9a-f]{16}) to send it/))[1]!;
			expect(pty.output).toContain("Pi answers only once it is idle");
			pty.type(stopPhrase);
			await until(
				"stop acknowledged",
				async () => (await getJson(`intervention/${stop.proposalId}`, grant)).state === "accepted",
			);
			await until(
				"run ended",
				async () => (await getJson(`intervention/${stop.proposalId}`, grant)).runEnded !== null,
			);
			expect(await getJson(`intervention/${stop.proposalId}`, grant)).toMatchObject({
				disposition: null,
				runEnded: "aborted",
			});
			expect(
				sent()
					.slice(base)
					.filter((c) => c === "abort"),
			).toHaveLength(1);

			pty.child.stdin.write("\x03");
			expect(await pty.exit).toBe(0);
			const store = createEndoDurableEventStoreV0(root, { readOnly: true });
			const all: EndoEventV0[] = [];
			for (let after = 0; ; ) {
				const page = store.page({ afterSequence: after, limit: 10_000 });
				if (page.events.length === 0) break;
				all.push(...page.events);
				after = page.nextAfterSequence;
			}
			store.close();
			const chain = all
				.filter((e) => e.kind.startsWith("intervention."))
				.map(
					(e) =>
						`${e.kind}${(e.payload as { reason?: string }).reason ? `:${(e.payload as { reason?: string }).reason}` : ""}`,
				);
			expect(chain).toEqual([
				"intervention.proposal", // the steer the prompt's phrase did not approve
				"intervention.authorization:the operator confirmed no digest", // a deny, by the existing local-operator authority
				"intervention.refused:authorization-denied",
				"intervention.proposal", // the steer that was approved
				"intervention.authorization",
				"intervention.request",
				"intervention.accepted",
				"intervention.proposal", // the stop
				"intervention.authorization",
				"intervention.request",
				"intervention.accepted",
				"intervention.consequence",
				"intervention.consequence",
			]);
			expect(JSON.stringify(all)).not.toContain("STEER-CANARY-0f3a");
		}, 180_000);

		it("lets a STOP supersede a steer waiting on the terminal: one question at a time, the stale phrase approves nothing, the STOP needs its own", async () => {
			const install = installFakePi("1.0.0");
			cleanup.push(() => install.remove());
			const root = temp("endo-wbcli-pre-");
			const cwd = temp("endo-wbcli-precwd-");
			const xdg = temp("endo-wbcli-prexdg-");
			const log = join(temp("endo-wbcli-prelog-"), "commands.log");
			const studier = new PiAttachmentV0({
				root,
				cwd,
				executable: install.bin,
				env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
				requestTimeoutMs: 10_000,
			});
			await studier.checkLocal();
			await studier.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
			const env = { ...process.env, XDG_DATA_HOME: xdg, ...fakePiEnv({ FAKE_PI_STEP_MS: "400", FAKE_PI_LOG: log }) };
			const pty = new Pty(
				`${process.execPath} ${CLI} harness attach ${root} --pi ${install.bin} --cwd ${cwd} --control --workbench`,
				env,
			);
			const address = (await pty.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
			const code = (await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
			const origin = new URL(address).origin;
			const api = `${address}api/v0/workbench/`;
			const post = async (route: string, body: unknown, grant?: string) =>
				(await fetch(`${api}${route}`, {
					method: "POST",
					headers: {
						Origin: origin,
						"Content-Type": "application/json",
						...(grant ? { "X-Endo-Grant": grant } : {}),
					},
					body: JSON.stringify(body),
				})) as Response;
			const getJson = async (route: string, grant?: string) =>
				(await fetch(`${api}${route}`, { headers: grant ? { "X-Endo-Grant": grant } : {} })).json() as Promise<
					Record<string, any>
				>;
			const until = async (what: string, ok: () => Promise<boolean>) => {
				for (let i = 0; i < 400; i++) {
					if (await ok()) return;
					await sleep(50);
				}
				throw new Error(`never: ${what}\n${pty.output.slice(-1500)}`);
			};
			const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
			const sent = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
			const view = (id: string) => getJson(`intervention/${id}`, grant);

			const prompt = (await (await post("prompt/propose", { message: "Count to forty" }, grant)).json()) as {
				proposalId: string;
			};
			pty.type((await pty.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!);
			await until("run active", async () => (await getJson("status")).run === "active");
			expect(prompt.proposalId).toBeTruthy();
			const base = sent().length;

			// A steer waits on the terminal.
			const steer = (await (
				await post(
					"intervention/propose",
					{ operation: "steer", message: "STEER-CANARY-9d41 and say hello" },
					grant,
				)
			).json()) as { proposalId: string };
			const steerPhrase = (await pty.waitFor(/Type (APPROVE STEER [0-9a-f]{16}) to send exactly this steer/))[1]!;
			expect((await getJson("status")).offers.stop).toMatchObject({ offered: true });
			// A second steer is still withheld; only a STOP may take the terminal.
			expect((await post("intervention/propose", { operation: "queue", message: "later" }, grant)).status).toBe(409);

			// The STOP supersedes it: the terminal says so, then asks the STOP's own question, and never both at once.
			const mark = pty.output.length;
			const stop = (await (await post("intervention/propose", { operation: "stop" }, grant)).json()) as {
				proposalId: string;
			};
			const stopPhrase = (await pty.waitFor(/Type (APPROVE STOP [0-9a-f]{16}) to send it/))[1]!;
			const during = pty.output.slice(mark);
			const cancelled = during.indexOf("that request was cancelled, unapproved, because a stop was requested");
			const asked = during.indexOf("approve this stop?");
			expect(cancelled).toBeGreaterThan(-1);
			expect(asked).toBeGreaterThan(cancelled);
			expect(during).toContain("This stop replaced a steer that was still waiting for approval");
			expect(during.match(/=== WORKBENCH: approve this/g)).toHaveLength(1);
			expect(stopPhrase).not.toBe(steerPhrase);
			await until("the steer is cancelled", async () => (await view(steer.proposalId)).state === "refused");
			expect(await view(steer.proposalId)).toMatchObject({ reason: "superseded-by-stop", approved: false });
			expect(sent().slice(base)).not.toContain("steer");

			// The cancelled steer's phrase, typed now, is an answer to the STOP's question: it declines it. Nothing is sent.
			pty.type(steerPhrase);
			await until("the stop is declined", async () => (await view(stop.proposalId)).state === "refused");
			expect(await view(stop.proposalId)).toMatchObject({ reason: "authorization-denied", approved: false });
			await sleep(300);
			expect(sent().slice(base)).not.toContain("steer");
			expect(sent().slice(base)).not.toContain("abort");

			// A new STOP, with its own phrase typed exactly, is sent. The steer it superseded never is.
			const again = (await (await post("intervention/propose", { operation: "stop" }, grant)).json()) as {
				proposalId: string;
			};
			const secondPhrase = (await pty.waitFor(/Type (APPROVE STOP [0-9a-f]{16}) to send it/))[1]!;
			expect(secondPhrase).not.toBe(stopPhrase);
			pty.type(secondPhrase);
			await until("stop acknowledged", async () => (await view(again.proposalId)).state === "accepted");
			expect(
				sent()
					.slice(base)
					.filter((c) => c === "abort"),
			).toHaveLength(1);
			expect(sent().slice(base)).not.toContain("steer");

			pty.child.stdin.write("\x03");
			expect(await pty.exit).toBe(0);
			const store = createEndoDurableEventStoreV0(root, { readOnly: true });
			const all: EndoEventV0[] = [];
			for (let after = 0; ; ) {
				const page = store.page({ afterSequence: after, limit: 10_000 });
				if (page.events.length === 0) break;
				all.push(...page.events);
				after = page.nextAfterSequence;
			}
			store.close();
			const chain = all.filter((e) => e.kind.startsWith("intervention.")).map((e) => e.kind);
			expect(chain).toEqual([
				"intervention.proposal", // the steer
				"intervention.proposal", // the stop that superseded it
				"intervention.refused", // the steer: not authorized, superseded
				"intervention.authorization", // the stop: a decline by the stale phrase
				"intervention.refused",
				"intervention.proposal", // the second stop
				"intervention.authorization",
				"intervention.request",
				"intervention.accepted",
				"intervention.consequence",
			]);
			expect(JSON.stringify(all)).not.toContain("STEER-CANARY-9d41");
		}, 180_000);
	},
);

describe.runIf(hasScript && process.platform === "linux")(
	"endo harness attach --control --workbench --project under a pseudo-terminal",
	() => {
		const endo = (args: string[], env: NodeJS.ProcessEnv) =>
			spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });

		async function launch(options: {
			root: string;
			cwd: string;
			project: string;
			piBin: string;
			env: NodeJS.ProcessEnv;
		}) {
			const pty = new Pty(
				`${process.execPath} ${CLI} harness attach ${options.root} --pi ${options.piBin} --cwd ${options.cwd} --control --workbench --project ${options.project}`,
				options.env,
			);
			const address = (await pty.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
			const code = (await pty.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
			const origin = new URL(address).origin;
			const api = `${address}api/v0/workbench/`;
			const call = async (method: "GET" | "POST", route: string, body?: unknown, grant?: string) => {
				const response = await fetch(`${api}${route}`, {
					method,
					headers: {
						...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}),
						...(grant ? { "X-Endo-Grant": grant } : {}),
					},
					...(method === "POST" ? { body: JSON.stringify(body) } : {}),
				});
				return { status: response.status, body: (await response.json()) as Record<string, any> };
			};
			const grant = ((await call("POST", "pair", { code })).body as { grant: string }).grant;
			return { pty, call, grant };
		}

		it("registers a project, serves its tasks to a paired page, changes them without sending anything, and shows them read-only from another directory", async () => {
			const install = installFakePi("1.0.0");
			cleanup.push(() => install.remove());
			const root = temp("endo-wbcli-proj-root-");
			const cwd = realpathSyncTemp(temp("endo-wbcli-proj-cwd-"));
			const elsewhere = realpathSyncTemp(temp("endo-wbcli-proj-elsewhere-"));
			const xdg = temp("endo-wbcli-proj-xdg-");
			const env = { ...process.env, XDG_DATA_HOME: xdg, ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) };
			const added = endo(["project", "add", root, "--name", "Pty project", "--path", cwd], env);
			expect(added.status, added.stderr).toBe(0);
			const project = (JSON.parse(added.stdout) as { project: { id: string } }).project.id;
			const common = { root, project, piBin: install.bin, env };

			// Launched in the registered directory: the terminal says so, and a paired page can change tasks.
			const first = await launch({ ...common, cwd });
			await first.pty.waitFor(
				/project "Pty project" \(endo\.project\.[0-9a-f]{32}\): this directory is the registered one/,
			);
			expect((await first.call("GET", "workspace")).status).toBe(401);
			const view = await first.call("GET", "workspace", undefined, first.grant);
			expect(view.body).toMatchObject({
				state: "ready",
				writable: true,
				tasks: [],
				project: { name: "Pty project", launch: "same" },
			});
			const created = await first.call(
				"POST",
				"workspace/tasks/create",
				{ title: "From the page", acceptance: "it persists" },
				first.grant,
			);
			expect(created.status).toBe(200);
			const task = created.body.tasks[0] as { id: string; revision: number };
			const moved = await first.call(
				"POST",
				"workspace/tasks/status",
				{ taskId: task.id, expectedRevision: task.revision, to: "in-progress", note: "page" },
				first.grant,
			);
			expect(moved.body.tasks[0]).toMatchObject({ status: "in-progress" });
			const linked = await first.call(
				"POST",
				"workspace/tasks/link-session",
				{ taskId: task.id, expectedRevision: 1 },
				first.grant,
			);
			expect(linked.body.tasks[0].sessions[0]).toMatchObject({
				relation: "current",
				source: "pi-live",
				linkedBy: "operator",
			});
			// The task routes reach no command: the terminal asked for no approval, and Pi was sent no prompt.
			expect(first.pty.output).not.toContain("WORKBENCH: approve");
			expect((await first.call("GET", "status")).body.command).toBeNull();
			first.pty.child.stdin.write("\x03");
			expect(await first.pty.exit).toBe(0);

			// The tasks outlive the process; the CLI reads what the page wrote.
			const listed = endo(["task", "list", root, "--project", project], env);
			expect(JSON.parse(listed.stdout).tasks).toMatchObject([
				{ title: "From the page", status: "in-progress", sessionReferences: 1 },
			]);

			// Launched elsewhere with the same project: the terminal says so, the page can read and cannot change, and the earlier link is historical.
			const second = await launch({ ...common, cwd: elsewhere });
			await second.pty.waitFor(/this directory is NOT the registered one/);
			const readOnly = await second.call("GET", "workspace", undefined, second.grant);
			expect(readOnly.body).toMatchObject({
				writable: false,
				readOnlyReason: "project-mismatch",
				project: { launch: "different" },
			});
			expect(readOnly.body.tasks[0].sessions[0].relation).toBe("historical");
			expect((await second.call("POST", "workspace/tasks/create", { title: "nope" }, second.grant)).status).toBe(
				409,
			);
			second.pty.child.stdin.write("\x03");
			expect(await second.pty.exit).toBe(0);
			expect(JSON.parse(endo(["task", "list", root, "--project", project], env).stdout).tasks).toHaveLength(1);

			// And an id the store does not know is said at the terminal, with nothing served.
			const unknown = await launch({ ...common, cwd, project: `endo.project.${"0".repeat(32)}` });
			await unknown.pty.waitFor(/names no project in this store/);
			expect((await unknown.call("GET", "workspace", undefined, unknown.grant)).body).toMatchObject({
				state: "unknown-project",
				tasks: [],
			});
			unknown.pty.child.stdin.write("\x03");
			expect(await unknown.pty.exit).toBe(0);
		}, 180_000);
	},
);

function realpathSyncTemp(path: string): string {
	return realpathSync(path);
}
