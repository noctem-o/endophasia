// `endo harness attach <root> --control --workbench` as a real process under a real pseudo-terminal, against the fake Pi. This is the
// test that matters most for the authority boundary: the prompt is requested over HTTP, and it is sent only after the operator TYPES
// the exact phrase on the process's controlling terminal. Also the refusals: no terminal, no --control.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
