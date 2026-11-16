// DEVELOP-UX-002 at the real terminal (research/develop-ux/DEVELOP-UX-002.md): `endo develop` under a real pseudo-terminal against the
// fake Pi (a real child process speaking Pi's RPC). What the terminal says of the mode; that Everyday, on a host with no execution
// boundary, is Strict and sends nothing without its typed line; that Protected starts nothing; that Ctrl-C still ends the session; and
// the opt-in short confirmation: bound to one question, multi-line text shown first, a stale or wrong code declines, STOP preempts.
//
// No real isolation exists on any host for this build, so none is exercised here: these tests show the terminal REFUSING to claim it.
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { endoHelpV0 } from "../cli/help.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const hasScript = spawnSync("script", ["--version"]).status === 0;
const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanup: (() => void | Promise<void>)[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

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
					throw new Error(`pattern ${pattern} not seen; output so far:\n${state.output.slice(-2000)}`);
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
/** Every file under a directory, as text: what a store holds, for a scan. */
function everything(dir: string): string {
	let all = "";
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) all += everything(path);
		else all += readFileSync(path, "latin1");
	}
	return all;
}
function recorded(root: string): string {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const events: unknown[] = [];
	for (let after = 0; ; ) {
		const page = store.page({ afterSequence: after, limit: 10_000 });
		if (page.events.length === 0) break;
		events.push(...page.events);
		after = page.nextAfterSequence;
	}
	store.close();
	return JSON.stringify(events);
}
function client(address: string) {
	const origin = new URL(address).origin;
	const api = `${address}api/v0/workbench/`;
	const post = (route: string, body: unknown, grant?: string) =>
		fetch(`${api}${route}`, {
			method: "POST",
			headers: { Origin: origin, "Content-Type": "application/json", ...(grant ? { "X-Endo-Grant": grant } : {}) },
			body: JSON.stringify(body),
		});
	const getJson = async (route: string, grant?: string): Promise<any> =>
		(await fetch(`${api}${route}`, { headers: grant ? { "X-Endo-Grant": grant } : {} })).json();
	const until = async (what: string, ok: () => Promise<boolean>) => {
		for (let i = 0; i < 400; i++) {
			if (await ok()) return;
			await sleep(50);
		}
		throw new Error(`never: ${what}`);
	};
	return { post, getJson, until };
}

/** The newest modification time under a directory. */
function newest(dir: string): number {
	let latest = 0;
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stat = statSync(path);
		latest = Math.max(latest, stat.isDirectory() ? newest(path) : stat.mtimeMs);
	}
	return latest;
}
beforeAll(async () => {
	// The CLI serves the one built frontend next to it, which the other terminal suites rebuild too. Rebuilding it while another
	// suite's workbench is starting can leave that start without its files, so this suite builds only when the build is missing or
	// older than the page's sources.
	const dist = fileURLToPath(new URL("../studio-ui/dist", import.meta.url));
	const src = fileURLToPath(new URL("../studio-ui/src", import.meta.url));
	if (existsSync(join(dist, "index.html")) && statSync(join(dist, "index.html")).mtimeMs >= newest(src)) return;
	const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(dist);
}, 90_000);
afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
	for (const done of cleanup.splice(0).reverse()) await done();
});

describe("the mode is chosen on the command line, and checked before anything starts", () => {
	const run = (argv: string[]) =>
		spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

	it("is documented where the command is", () => {
		const help = endoHelpV0();
		expect(help).toContain("--mode everyday|protected|strict");
		expect(help).toContain("--confirm phrase|short");
		expect(help).toContain("Everyday is in effect only");
		expect(help).toContain("Protected starts nothing where it cannot be enforced");
	});

	it("refuses an unknown mode or confirmation, and either flag without the workbench, before Pi is looked for", () => {
		const root = join(temp("endo-ux2-"), "store");
		const pi = ["--pi", join(root, "no-such-pi")];
		for (const [argv, words] of [
			[["develop", root, ...pi, "--mode", "root"], "--mode is everyday, protected or strict"],
			[["develop", root, ...pi, "--mode", "Everyday"], "--mode is everyday, protected or strict"],
			[["develop", root, ...pi, "--mode"], "the flag --mode needs a value"],
			[["develop", root, ...pi, "--confirm", "none"], "--confirm is phrase or short"],
			[["develop", root, ...pi, "--confirm", "enter"], "--confirm is phrase or short"],
			[["harness", "attach", root, ...pi, "--mode", "everyday"], "--mode and --confirm belong to the workbench"],
			[["harness", "attach", root, ...pi, "--control", "--confirm", "short"], "belong to the workbench"],
			// A well-formed mode still needs the terminal: nothing about a mode is read from a pipe.
			[["develop", root, ...pi, "--mode", "everyday"], "approvals are never read from a pipe or a file"],
			[["develop", root, ...pi, "--mode", "protected"], "approvals are never read from a pipe or a file"],
		] as const) {
			const result = run([...argv]);
			expect([argv, result.status], result.stderr).toEqual([argv, 1]);
			expect(result.stderr, argv.join(" ")).toContain(words);
			expect(result.stderr, argv.join(" ")).not.toContain("no-such-pi");
		}
		expect(existsSync(root)).toBe(false);
	});
});

describe.runIf(hasScript && process.platform === "linux")("endo develop under a pseudo-terminal: modes", () => {
	it("Protected starts nothing on a host that cannot enforce it: no Pi, no store, no listener", async () => {
		const root = join(temp("endo-ux2-prot-"), "store");
		const term = pty(
			`${process.execPath} ${CLI} develop ${root} --pi ${join(root, "no-such-pi")} --mode protected`,
			process.env,
		);
		expect(await term.exit).toBe(1);
		const said = term.output();
		expect(said).toContain("Protected mode cannot be enforced on this host, so nothing was started.");
		expect(said).toContain("Pi is not placed inside an execution boundary by this build");
		expect(said).toContain("Use --mode strict");
		expect(said).not.toContain("workbench: http://");
		expect(said).not.toContain("no-such-pi");
		expect(existsSync(root)).toBe(false);
	});

	it("Everyday is requested by default, is NOT in effect, says why, and sends nothing without the typed phrase; Ctrl-C ends it", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-ux2-root-");
		const cwd = temp("endo-ux2-cwd-");
		const env = { ...process.env, XDG_DATA_HOME: temp("endo-ux2-xdg-"), ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) };
		const term = pty(`${process.execPath} ${CLI} develop ${root} --pi ${install.bin} --cwd ${cwd}`, env);
		const address = (await term.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
		await term.waitFor(
			/mode EVERYDAY was requested and is NOT in effect\. STRICT is: every prompt, steer, queue and stop is approved here, by its phrase\./,
		);
		await term.waitFor(/why: Pi is not placed inside an execution boundary by this build/);
		const code = (await term.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
		// The first code is a plain one, and says so.
		expect(term.output()).not.toContain("THIS CODE ALSO GRANTS SESSION CONTROL");

		const { post, getJson, until } = client(address);
		const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
		const status = await getJson("status", grant);
		expect(status.mode).toMatchObject({ requested: "everyday", effective: "strict" });
		expect(status.protection).toMatchObject({ state: "not-enforced", level: "none", mechanism: null });
		expect(status.sessionControl).toMatchObject({ state: "none", holder: false, armed: false });

		// Asking the terminal for control changes nothing, and it says so; `revoke` has nothing to revoke.
		term.type("control");
		const second = (
			await term.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})[^\n]*It carries NO session control/)
		)[1]!;
		term.type("revoke");
		await term.waitFor(/no session control was in effect/);
		const regrant = ((await (await post("pair", { code: second })).json()) as { grant: string }).grant;
		expect((await getJson("status", regrant)).sessionControl.state).toBe("none");
		// No route gives what the terminal would not.
		for (const route of ["session-control/grant", "session-control/arm", "mode"])
			expect((await post(route, {}, regrant)).status).toBe(404);
		expect((await post("session-control/revoke", {}, regrant)).status).toBe(409);

		// Ten requests, ten questions: each waits for its own phrase, and a request with members a page might add is refused whole.
		expect((await post("prompt/propose", { message: "x", mode: "everyday" }, regrant)).status).toBe(400);
		const asked = (await (await post("prompt/propose", { message: "Count to forty" }, regrant)).json()) as {
			proposalId: string;
			state: string;
			authorizedBy: string | null;
		};
		expect(asked).toMatchObject({ state: "awaiting-approval", authorizedBy: null });
		const phrase = (await term.waitFor(/Type (APPROVE PROMPT [0-9a-f]{16}) to send exactly this prompt/))[1]!;
		await sleep(300);
		expect((await getJson("transcript", regrant)).items).toEqual([]);
		term.type(phrase);
		await until("accepted", async () => (await getJson(`prompt/${asked.proposalId}`, regrant)).state === "accepted");
		expect(await getJson(`prompt/${asked.proposalId}`, regrant)).toMatchObject({ authorizedBy: "terminal" });

		// The terminal's own signal path needs no page, grant or broker route.
		term.interrupt();
		expect(await term.exit).toBe(0);
		const stored = everything(root);
		expect(recorded(root)).toContain('"confirmation":"terminal"');
		expect(stored).not.toContain("session-grant");
		expect(stored).not.toContain("workbench.session-control");
		expect(stored).not.toContain(grant);
		expect(stored).not.toContain(regrant);
	}, 120_000);

	it("--mode strict says nothing of a mode that was not asked for and behaves as before", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const env = { ...process.env, XDG_DATA_HOME: temp("endo-ux2-xdg-"), ...fakePiEnv({ FAKE_PI_STEP_MS: "30" }) };
		const term = pty(
			`${process.execPath} ${CLI} develop ${temp("endo-ux2-root-")} --pi ${install.bin} --cwd ${temp("endo-ux2-cwd-")} --mode strict`,
			env,
		);
		const address = (await term.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
		const code = (await term.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
		expect(term.output()).not.toContain("was requested");
		expect(term.output()).not.toContain("session control");
		const { post, getJson } = client(address);
		const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
		expect((await getJson("status", grant)).mode).toEqual({ requested: "strict", effective: "strict", reason: null });
		term.interrupt();
		expect(await term.exit).toBe(0);
	}, 120_000);
});

describe.runIf(hasScript && process.platform === "linux")(
	"--confirm short: a shorter line, on the same terminal",
	() => {
		it("binds a code to one question, shows multi-line text first, declines a wrong or stale code, records it as a code, and STOP still preempts", async () => {
			const install = installFakePi("1.0.0");
			cleanup.push(() => install.remove());
			const root = temp("endo-ux2-short-");
			const cwd = temp("endo-ux2-shortcwd-");
			// The interventions are offered only for admitted capabilities: record the live study first, in the same root.
			const studier = new PiAttachmentV0({
				root,
				cwd,
				executable: install.bin,
				env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
				requestTimeoutMs: 10_000,
			});
			await studier.checkLocal();
			await studier.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
			const env = { ...process.env, XDG_DATA_HOME: temp("endo-ux2-xdg-"), ...fakePiEnv({ FAKE_PI_STEP_MS: "400" }) };
			const term = pty(
				`${process.execPath} ${CLI} develop ${root} --pi ${install.bin} --cwd ${cwd} --confirm short`,
				env,
			);
			const address = (await term.waitFor(/workbench: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/)/))[1]!;
			await term.waitFor(
				/STRICT is: every prompt, steer, queue and stop is approved here \(by its code or its phrase\)/,
			);
			await term.waitFor(
				/--confirm short: a request may be approved by the four-character code shown for it, here\./,
			);
			const code = (await term.waitFor(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
			const { post, getJson, until } = client(address);
			const grant = ((await (await post("pair", { code })).json()) as { grant: string }).grant;
			const question = /Type ([a-z2-9]{4}) \(or the whole phrase (APPROVE [A-Z]+ [0-9a-f]{16})\) to send/;
			const propose = async (message: string) =>
				(await (await post("prompt/propose", { message }, grant)).json()) as { proposalId: string };
			const state = async (id: string) => (await getJson(`prompt/${id}`, grant)).state as string;

			// 1. A multi-line prompt: every line is on the terminal BEFORE the code, between its markers.
			const text = "First line of the request\nsecond line: do the thing\n\tthird, indented";
			const first = await propose(text);
			const [, firstCode, firstPhrase] = await term.waitFor(question);
			const shown = term.output();
			const body = shown.slice(
				shown.lastIndexOf("--- the exact prompt ---"),
				shown.lastIndexOf("--- end of prompt ---"),
			);
			for (const line of ["First line of the request", "second line: do the thing", "third, indented"])
				expect(body).toContain(line);
			expect(shown.lastIndexOf("--- end of prompt ---")).toBeLessThan(shown.lastIndexOf(`Type ${firstCode}`));
			// The page is never told the code: not in the request's view, not in the status.
			expect(
				JSON.stringify([await getJson(`prompt/${first.proposalId}`, grant), await getJson("status", grant)]),
			).not.toContain(firstCode!);
			// 2. A wrong code declines; so does the right code with anything after it. Nothing is sent.
			const wrong = firstCode === "aaaa" ? "bbbb" : "aaaa";
			term.type(wrong);
			await until("declined", async () => (await state(first.proposalId)) === "refused");
			expect((await getJson(`prompt/${first.proposalId}`, grant)).reason).toBe("authorization-denied");
			expect((await getJson("transcript", grant)).items).toEqual([]);

			// 3. A stale code: the first question's code, typed into the second question, declines it. Each question has its own.
			const second = await propose("Count to forty");
			const [, secondCode] = await term.waitFor(question);
			expect(secondCode).not.toBe(firstCode);
			term.type(firstCode!);
			await until("stale code declined", async () => (await state(second.proposalId)) === "refused");
			expect((await getJson("transcript", grant)).items).toEqual([]);

			// 4. The phrase still works where the code is offered; and the code itself, typed exactly, sends.
			const third = await propose("Count to forty");
			const [, thirdCode, thirdPhrase] = await term.waitFor(question);
			expect(thirdPhrase).not.toBe(firstPhrase);
			term.type(thirdCode!);
			await until("accepted by its code", async () => (await state(third.proposalId)) === "accepted");
			expect(await getJson(`prompt/${third.proposalId}`, grant)).toMatchObject({
				approved: true,
				authorizedBy: "terminal",
			});
			await until("run active", async () => (await getJson("status")).run === "active");

			// 5. STOP preempts a steer that is waiting for its code: the steer is cancelled unapproved, and its code, typed into the STOP's
			//    question, declines the STOP rather than approving anything.
			const steer = (await (
				await post("intervention/propose", { operation: "steer", message: "go left" }, grant)
			).json()) as { proposalId: string };
			const [, steerCode] = await term.waitFor(question);
			const stop = (await (await post("intervention/propose", { operation: "stop" }, grant)).json()) as {
				proposalId: string;
			};
			await term.waitFor(/that request was cancelled, unapproved, because a stop was requested/);
			const [, stopCode, stopPhrase] = await term.waitFor(question);
			expect(stopPhrase).toMatch(/^APPROVE STOP /);
			expect(stopCode).not.toBe(steerCode);
			expect((await getJson(`intervention/${steer.proposalId}`, grant)).reason).toBe("superseded-by-stop");
			term.type(steerCode!);
			await until(
				"stop declined by the steer's code",
				async () => (await getJson(`intervention/${stop.proposalId}`, grant)).state === "refused",
			);
			// Its own code sends it.
			const again = (await (await post("intervention/propose", { operation: "stop" }, grant)).json()) as {
				proposalId: string;
			};
			const [, againCode] = await term.waitFor(question);
			term.type(againCode!);
			await until("stop sent", async () =>
				["sent", "accepted"].includes((await getJson(`intervention/${again.proposalId}`, grant)).state),
			);

			term.interrupt();
			expect(await term.exit).toBe(0);
			// Recorded as what it was: a code typed on the terminal, for the prompt and for the stop. No code is in the store.
			const stored = everything(root);
			const events = recorded(root);
			expect(events).toContain('"confirmation":"terminal-code"');
			expect(events).toMatch(/"authority":\{[^}]*"confirmation":"terminal-code"/);
			expect(events).not.toContain("go left");
			for (const used of [firstCode, secondCode, thirdCode, steerCode, stopCode, againCode])
				expect(stored).not.toContain(`"${used}"`);
		}, 180_000);

		it("an attempt keeps its phrase: the short code is never offered for one", async () => {
			const source = readFileSync(fileURLToPath(new URL("../cli/workbench.ts", import.meta.url)), "utf8");
			expect(source).toContain(
				'const code = options.confirm === "short" && what !== "attempt" ? shortCode() : null;',
			);
			// The code never leaves the function that asks: it is compared with the typed line and nothing else reads it.
			expect(
				source.match(/\bcode\b(?! ===| !==|:| =| \?)/g)?.filter((m) => m === "code").length ?? 0,
			).toBeGreaterThan(0);
			expect(source).not.toMatch(/broker\.[a-zA-Z]+\([^)]*\bcode\b(?!:)[^)]*shortCode/);
		});
	},
);
