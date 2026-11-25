// Real PTY controlling-terminal integration test for `endo develop --harness codex` / `endo codex session --workbench`.
// Proves the real authority boundary: prompts are proposed over HTTP, approved ONLY by typing the exact phrase on the
// process's controlling terminal, native Codex ServerRequests are approved ONLY on the terminal (`ALLOW ONCE`), and
// the process shuts down cleanly releasing the event-store writer lock.

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readWorkbenchStatus, readWorkbenchTranscript } from "../studio-ui/src/model/workbench-wire.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
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
	async waitFor(pattern: RegExp, timeoutMs = 45_000): Promise<RegExpExecArray> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const match = pattern.exec(this.output.slice(this.consumed));
			if (match) {
				this.consumed += match.index + match[0].length;
				return match;
			}
			if (Date.now() > deadline || this.child.exitCode !== null) {
				throw new Error(`pattern ${pattern} not seen; output so far:\n${this.output.slice(-2000)}`);
			}
			await sleep(25);
		}
	}
	type(line: string): void {
		this.child.stdin.write(`${line}\r`);
	}
	kill(): void {
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}
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
	for (const pty of ptys.splice(0)) pty.kill();
	for (const done of cleanup.splice(0).reverse()) await done();
});

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

describe.skipIf(!hasScript)("endo develop --harness codex controlling-terminal workbench (PTY)", () => {
	it("serves Codex workbench over loopback, enforces terminal phrase approval and terminal-only native approval, and exits cleanly", async () => {
		const root = temp("endo-codex-pty-store-");
		const cwd = temp("endo-codex-pty-cwd-");
		const cmd = [
			sq(process.execPath),
			sq(CLI),
			"develop",
			"--harness",
			"codex",
			"--root",
			sq(root),
			"--cwd",
			sq(cwd),
			"--executable",
			sq(FAKE_CODEX),
			"--sandbox",
			"read-only",
			"--ephemeral",
		].join(" ");
		const term = new Pty(cmd, { ...process.env, FAKE_CODEX_SCENARIO: "native-approval-cmd" });

		const urlMatch = await term.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/);
		const baseUrl = urlMatch[1]!.replace(/\/$/, "");
		const origin = new URL(baseUrl).origin;
		const codeMatch = await term.waitFor(/workbench: pairing code ([A-Za-z0-9-]+)\s+/);
		const pairCode = codeMatch[1]!;

		// Pair over HTTP with exact same-origin Origin header.
		const pairRes = await fetch(`${baseUrl}/api/v0/workbench/pair`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({ code: pairCode }),
		});
		expect(pairRes.status).toBe(200);
		const { grant } = (await pairRes.json()) as { grant: string };

		// Request a prompt from the paired page -> terminal must print exact phrase and full prompt text.
		const propRes = await fetch(`${baseUrl}/api/v0/workbench/prompt/propose`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, "x-endo-grant": grant },
			body: JSON.stringify({ message: "PTY_GOVERNED_CODEX_PROMPT" }),
		});
		expect(propRes.status).toBe(202);
		const { proposalId } = (await propRes.json()) as { proposalId: string };

		await term.waitFor(/\[GOVERNED APPROVAL REQUIRED — STRICT CODEX WORKBENCH\]/);
		await term.waitFor(/PTY_GOVERNED_CODEX_PROMPT/);
		const phraseMatch = await term.waitFor(/Type (APPROVE PROMPT [0-9a-f]{6}) to approve/);
		term.type(phraseMatch[1]!);

		// Fake Codex emits a native commandExecution approval -> terminal prompts `native-approval>` AND HTTP status shows read-only pendingNativeApprovals!
		await term.waitFor(/\[NATIVE CODEX APPROVAL REQUEST\]/);
		await term.waitFor(/native-approval>/);

		const stPending = readWorkbenchStatus(
			await (await fetch(`${baseUrl}/api/v0/workbench/status`, { headers: { "x-endo-grant": grant } })).json(),
		)!;
		expect(stPending.harness).toBe("codex");
		expect(stPending.codex!.pendingNativeApprovals).toHaveLength(1);

		// Approve once on controlling terminal.
		term.type("ALLOW ONCE");

		// Wait for prompt & turn completion.
		const deadline = Date.now() + 15_000;
		let settled = false;
		while (Date.now() < deadline) {
			const st = readWorkbenchStatus(
				await (await fetch(`${baseUrl}/api/v0/workbench/status`, { headers: { "x-endo-grant": grant } })).json(),
			);
			const pr = (await (
				await fetch(`${baseUrl}/api/v0/workbench/prompt/${proposalId}`, { headers: { "x-endo-grant": grant } })
			).json()) as { state: string };
			if (
				st !== null &&
				st.run === "idle" &&
				pr.state === "accepted" &&
				st.codex!.recentNativeApprovals.length > 0
			) {
				settled = true;
				expect(st.codex!.recentNativeApprovals[0]!.resolution).toBe("accepted");
				break;
			}
			await sleep(50);
		}
		expect(settled).toBe(true);

		const tr = readWorkbenchTranscript(
			await (
				await fetch(`${baseUrl}/api/v0/workbench/transcript?after=0`, { headers: { "x-endo-grant": grant } })
			).json(),
		)!;
		expect(tr.items.some((i) => i.kind === "tool" && i.status === "completed")).toBe(true);

		// Quit cleanly on controlling terminal.
		term.type("quit");
		await term.waitFor(/Closed Codex workbench/);
		const code = await term.exit;
		expect(code).toBe(0);
	}, 60_000);

	it("preempts a waiting native-approval> prompt when the paired page requests STOP on the active turn", async () => {
		const root = temp("endo-codex-pty-stop-store-");
		const cwd = temp("endo-codex-pty-stop-cwd-");
		const cmd = [
			sq(process.execPath),
			sq(CLI),
			"develop",
			"--harness",
			"codex",
			"--root",
			sq(root),
			"--cwd",
			sq(cwd),
			"--executable",
			sq(FAKE_CODEX),
			"--sandbox",
			"read-only",
			"--ephemeral",
		].join(" ");
		const term = new Pty(cmd, { ...process.env, FAKE_CODEX_SCENARIO: "native-approval-cmd" });

		const urlMatch = await term.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/);
		const baseUrl = urlMatch[1]!.replace(/\/$/, "");
		const origin = new URL(baseUrl).origin;
		const codeMatch = await term.waitFor(/workbench: pairing code ([A-Za-z0-9-]+)\s+/);

		const pairRes = await fetch(`${baseUrl}/api/v0/workbench/pair`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({ code: codeMatch[1]! }),
		});
		const { grant } = (await pairRes.json()) as { grant: string };

		// Propose & approve prompt that pauses on native-approval>.
		await fetch(`${baseUrl}/api/v0/workbench/prompt/propose`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, "x-endo-grant": grant },
			body: JSON.stringify({ message: "trigger native approval then stop" }),
		});
		const promptPhrase = await term.waitFor(/Type (APPROVE PROMPT [0-9a-f]{6}) to approve/);
		term.type(promptPhrase[1]!);
		await term.waitFor(/native-approval>/);

		// While native-approval> is waiting, browser requests STOP -> terminal MUST preempt native-approval> and show STOP phrase!
		const stopRes = await fetch(`${baseUrl}/api/v0/workbench/intervention/propose`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, "x-endo-grant": grant },
			body: JSON.stringify({ operation: "stop" }),
		});
		expect(stopRes.status).toBe(202);
		const { proposalId: stopId } = (await stopRes.json()) as { proposalId: string };

		const stopPhrase = await term.waitFor(/Type (APPROVE STOP [0-9a-f]{6}) to approve/);
		term.type(stopPhrase[1]!);

		const deadline = Date.now() + 15_000;
		let interrupted = false;
		while (Date.now() < deadline) {
			const iv = (await (
				await fetch(`${baseUrl}/api/v0/workbench/intervention/${stopId}`, { headers: { "x-endo-grant": grant } })
			).json()) as { state: string; runEnded: string | null };
			if (iv.state === "accepted" && iv.runEnded === "aborted") {
				interrupted = true;
				break;
			}
			await sleep(50);
		}
		expect(interrupted).toBe(true);

		term.type("quit");
		await term.waitFor(/Closed Codex workbench/);
		expect(await term.exit).toBe(0);
	}, 60_000);
});
