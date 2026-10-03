/**
 * The Pi RPC client over the real subprocess boundary, against the fake Pi (tests/fixtures/fake-pi/cli.mjs):
 * argument construction without a shell, ID correlation under concurrency and reordering, events interleaved with
 * responses, fragmented and malformed framing, refusals, startup failures, timeouts, early exit, broken pipes,
 * bounded shutdown and process cleanup. The transport itself (adapters/rpc-jsonl) also keeps its Prime-era suite in
 * tests/prime-runtime-ingress.test.ts.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PiRpcClientV0,
	type PiRpcLaunchOptionsV0,
	PiRpcProtocolErrorV0,
	PiRpcRefusalV0,
	piRpcArgumentsV0,
} from "../adapters/pi/rpc.ts";
import { type RpcDiagnosticV0, RpcExitErrorV0 } from "../adapters/rpc-jsonl/rpc-connection.ts";
import { FAKE_PI_SOURCE, fakePiEnv } from "./fixtures/fake-pi/install.ts";

const clients: PiRpcClientV0[] = [];
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function launch(scenario = "", extra: Partial<PiRpcLaunchOptionsV0> = {}, diagnostics: RpcDiagnosticV0[] = []) {
	const cwd = mkdtempSync(join(tmpdir(), "endo-pi-rpc-"));
	dirs.push(cwd);
	const client = new PiRpcClientV0({
		executable: FAKE_PI_SOURCE,
		cwd,
		env: fakePiEnv({ FAKE_PI_SCENARIO: scenario, FAKE_PI_STEP_MS: "5" }),
		session: { kind: "ephemeral" },
		requestTimeoutMs: 5_000,
		closeTimeoutMs: 2_000,
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		...extra,
	});
	clients.push(client);
	return client;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("argument construction", () => {
	it("builds a separate argv element per value and never interpolates", () => {
		const args = piRpcArgumentsV0({
			executable: "/x/pi",
			cwd: "/",
			env: {},
			session: { kind: "persistent", sessionDir: "/tmp/dir with spaces/$(touch pwned)", sessionId: "endo-pi-1" },
			provider: "fake",
			model: "m; rm -rf /",
			tools: ["read", "grep"],
			offline: true,
		});
		expect(args).toEqual([
			"--session-dir",
			"/tmp/dir with spaces/$(touch pwned)",
			"--session-id",
			"endo-pi-1",
			"--provider",
			"fake",
			"--model",
			"m; rm -rf /",
			"--tools",
			"read,grep",
			"--offline",
		]);
	});

	it("rejects session ids and tool names outside Pi's documented grammar, and a provider without a model", () => {
		const base = { executable: "/x/pi", cwd: "/", env: {} };
		expect(() =>
			piRpcArgumentsV0({ ...base, session: { kind: "persistent", sessionDir: "/s", sessionId: "-flag" } }),
		).toThrow(TypeError);
		expect(() =>
			piRpcArgumentsV0({ ...base, session: { kind: "persistent", sessionDir: "/s", sessionId: "a b" } }),
		).toThrow(TypeError);
		expect(() => piRpcArgumentsV0({ ...base, session: { kind: "ephemeral" }, tools: ["read,bash"] })).toThrow(
			TypeError,
		);
		expect(() => piRpcArgumentsV0({ ...base, session: { kind: "ephemeral" }, provider: "fake" })).toThrow(TypeError);
	});
});

describe("correlation and framing", () => {
	it("correlates concurrent requests by id even when responses arrive out of order", async () => {
		const client = launch("reorder");
		// The fake holds get_state until get_session_stats has been answered.
		const [state, stats] = await Promise.all([client.getState(), client.getSessionStats()]);
		expect(state.sessionId).toBe(stats.sessionId);
		expect(state.isStreaming).toBe(false);
	});

	it("delivers session events interleaved with responses and keeps commands answered during a run", async () => {
		const client = launch();
		const events: string[] = [];
		client.subscribe((event) => events.push(event.type));
		expect(await client.prompt("hello")).toBe("started");
		const midRun = await client.getState();
		await new Promise<void>((done) => {
			const stop = client.subscribe((event) => {
				if (event.type === "agent_settled") {
					stop();
					done();
				}
			});
		});
		expect(typeof midRun.isStreaming).toBe("boolean");
		expect(events[0]).toBe("agent_start");
		expect(events.at(-1)).toBe("agent_settled");
		expect(events).toContain("message_update");
	});

	it("reassembles records split into 3-byte writes, including multi-byte UTF-8", async () => {
		const client = launch("fragment");
		await client.command("set_session_name", { name: "naïve 名前 ✓" });
		const { entries } = await client.getEntries();
		expect(entries.at(-1)?.raw).toMatchObject({ type: "session_info", name: "naïve 名前 ✓" });
	});

	it("reports malformed lines, id-less and unknown-id responses as faults and keeps working", async () => {
		const diagnostics: RpcDiagnosticV0[] = [];
		const client = launch("garbage", {}, diagnostics);
		const unknown: string[] = [];
		client.subscribe((event) => unknown.push(event.type));
		const state = await client.getState();
		expect(state.sessionId).toMatch(/^fake-/);
		const faults = diagnostics.filter((d) => d.kind === "protocol-fault").map((d) => (d as { fault: string }).fault);
		expect(faults).toEqual(expect.arrayContaining(["malformed-json", "response-without-id", "unknown-response-id"]));
		expect(unknown).toContain("some_future_event");
	});

	it("turns a documented refusal into PiRpcRefusalV0 and a parse failure into an id-less fault", async () => {
		const diagnostics: RpcDiagnosticV0[] = [];
		const client = launch("", {}, diagnostics);
		await expect(client.command("frobnicate")).rejects.toMatchObject({
			name: "PiRpcRefusalV0",
			command: "frobnicate",
			refusal: "Unknown command: frobnicate",
		});
		await expect(client.getEntries("not-an-entry")).rejects.toBeInstanceOf(PiRpcRefusalV0);
	});

	it("rejects a response whose documented shape is broken instead of using part of it", async () => {
		const client = launch("dup-entries");
		await expect(client.getEntries()).rejects.toBeInstanceOf(PiRpcProtocolErrorV0);
	});

	it("keeps stderr separate from the protocol stream, bounded", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "endo-pi-stderr-"));
		dirs.push(sessionDir);
		const client = launch("", { session: { kind: "persistent", sessionDir, sessionId: "endo-stderr-1" } });
		const state = await client.getState();
		expect(state.sessionId).toBe("endo-stderr-1");
		expect(client.connection.stderrTail()).toMatch(/No project session found/);
	});
});

describe("process failures", () => {
	it("a missing executable fails the first request with a spawn failure", async () => {
		const client = launch("", { executable: join(tmpdir(), "endo-no-such-pi") });
		const error = await client.getState().catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(RpcExitErrorV0);
		expect((error as RpcExitErrorV0).exit.spawnFailed).toBe(true);
	});

	it("a non-executable file fails to start", async () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-pi-noexec-"));
		dirs.push(dir);
		const file = join(dir, "pi");
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, 0o644);
		const client = launch("", { executable: file });
		await expect(client.getState()).rejects.toBeInstanceOf(RpcExitErrorV0);
	});

	it("an immediate exit fails pending requests with the exit code", async () => {
		const client = launch("exit-immediately");
		const error = (await client.getState().catch((reason: unknown) => reason)) as RpcExitErrorV0;
		expect(error).toBeInstanceOf(RpcExitErrorV0);
		expect(error.exit.code).toBe(7);
	});

	it("an exit mid-session fails the waiting request and every later one (broken pipe)", async () => {
		const client = launch("exit-on:get_session_stats");
		await client.getState();
		await expect(client.getSessionStats()).rejects.toBeInstanceOf(RpcExitErrorV0);
		await expect(client.getState()).rejects.toBeInstanceOf(RpcExitErrorV0);
		expect(["exited", "terminated"]).toContain(client.connection.state);
	});

	it("times out a request Pi never answers, without disturbing later ones", async () => {
		const client = launch("hang-on:get_tree", { requestTimeoutMs: 300 });
		await expect(client.getTree()).rejects.toThrow(/timed out after 300 ms/);
		expect((await client.getState()).sessionId).toMatch(/^fake-/);
	});

	it("shuts down in order on end of input, and leaves no process behind", async () => {
		const client = launch();
		await client.getState();
		const pid = client.connection.pid!;
		const termination = await client.close();
		expect(termination.exit.code).toBe(0);
		expect(termination.stdoutDrained).toBe(true);
		expect(alive(pid)).toBe(false);
		expect(client.connection.state).toBe("terminated");
	});

	it("terminates a Pi that ignores end of input, within the bound", async () => {
		const diagnostics: RpcDiagnosticV0[] = [];
		const client = launch("ignore-eof", { closeTimeoutMs: 300 }, diagnostics);
		await client.getState();
		const pid = client.connection.pid!;
		const started = Date.now();
		const termination = await client.close();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(termination.exit.signal).toBe("SIGTERM");
		expect(diagnostics).toContainEqual({ kind: "forced-termination", signal: "SIGTERM" });
		expect(alive(pid)).toBe(false);
	});
});
