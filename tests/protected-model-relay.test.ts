// EVAL-ISO-002 (docs/protected-model-access.md): model access for a protected sandbox through a narrow recording relay.
//
// Layers:
// - the judge and the relay's host side (a Unix socket, the recording proxy's governed admission, the capture log): run everywhere;
// - real isolation (bubblewrap and a systemd user manager, as tests/protected-isolation.test.ts): what a sandbox with the relay can and
//   cannot reach, the resource limits, and that termination is still confirmed. Skipped, and said so, where the host cannot isolate;
// - real Pi inside the sandbox (opt-in: ENDO_PI_DIST, the installed package's `dist` directory), against a disposable fake model server;
//   and, separately opt-in, against a real local model (ENDO_MODEL_ENDPOINT and ENDO_MODEL_ID), whose outcome is kept, not asserted.
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	type EndoSandboxMountV0,
	endoTreeDigestV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, type EndoContainmentV0 } from "../adapters/sandbox/containment.ts";
import {
	admitModelRequestV0,
	bridgedCommandV0,
	ENDO_MODEL_SOCKET_TARGET_V0,
	ENDO_PI_MODEL_ROUTES_V0,
	type EndoModelRelayPolicyV0,
	type EndoModelRelayV0,
	endoModelBridgeSha256V0,
	modelRelayMountsV0,
	modelRelayPolicyDigestV0,
	startModelRelayV0,
} from "../adapters/sandbox/model-relay.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";

const KEY = endoDigestKeyV0(randomBytes(32), "installation");
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-relay-test-")));
// A socket's path is limited to 107 bytes: the relay's own directory goes under the user's runtime directory where there is one.
const runtimeBase = (() => {
	const xdg = process.env.XDG_RUNTIME_DIR;
	const dir = mkdtempSync(join(xdg !== undefined && existsSync(xdg) ? xdg : tmpdir(), "er-"));
	chmodSync(dir, 0o700);
	return dir;
})();
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
	rmSync(runtimeBase, { recursive: true, force: true });
});
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

const MODEL = "relay-model-1";
const policy = (change: Partial<EndoModelRelayPolicyV0> = {}): EndoModelRelayPolicyV0 => ({
	routes: ENDO_PI_MODEL_ROUTES_V0,
	model: MODEL,
	maxRequestBytes: 256 * 1024,
	maxTransferredBytes: 64 * 1024 * 1024,
	maxConnections: 8,
	...change,
});
const chat = (model = MODEL) =>
	JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "Say hello" }] });

async function relayed(change: Partial<EndoModelRelayPolicyV0> = {}, upstreamOptions = {}) {
	const upstream: FakeOpenAiServer = await startFakeOpenAiServer(upstreamOptions);
	const store = fresh("store");
	const log = new EndoCaptureLogV0(store, KEY, "record", { async: true });
	const relay = await startModelRelayV0({
		upstream: new URL(upstream.baseUrl).origin,
		policy: policy(change),
		log,
		runtimeDirectory: runtimeBase,
	});
	cleanup.push(async () => {
		await relay.close();
		log.close();
		await upstream.close();
	});
	return { upstream, relay, log, store };
}

/** One HTTP request over the relay's socket, as the bridge would send it: the status, or how the connection ended. */
function overSocket(
	relay: EndoModelRelayV0,
	method: string,
	path: string,
	body?: string,
): Promise<{ status: number; body: string } | { closed: string }> {
	return new Promise((resolve) => {
		const req = httpRequest(
			{
				socketPath: relay.socketPath,
				method,
				path,
				headers:
					body === undefined
						? {}
						: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
			},
			(res) => {
				let text = "";
				res.on("data", (c) => {
					text += c;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
				res.on("error", (e) => resolve({ closed: (e as NodeJS.ErrnoException).code ?? "error" }));
			},
		);
		req.on("error", (e) => resolve({ closed: (e as NodeJS.ErrnoException).code ?? "error" }));
		if (body !== undefined) req.write(body);
		req.end();
	});
}

describe("EVAL-ISO-002: the judge", () => {
	const p = policy();
	const judge = (method: string, path: string, body: string | Uint8Array) =>
		admitModelRequestV0(p, { method, path, body: typeof body === "string" ? Buffer.from(body) : body });

	it("admits exactly the declared route with the declared model", () => {
		expect(judge("POST", "/v1/chat/completions", chat())).toEqual({ admitted: true });
	});

	it.each([
		["GET", "/v1/chat/completions"],
		["PUT", "/v1/chat/completions"],
		["CONNECT", "127.0.0.1:8081"],
		["POST", "/v1/chat/completions?x=1"],
		["POST", "/v1/chat/completions/"],
		["POST", "/v1/completions"],
		["GET", "/v1/models"],
		["GET", "/models"],
		["POST", "/models/load"],
		["POST", "/models/unload"],
		["GET", "/slots"],
		["POST", "/slots/0?action=erase"],
		["GET", "/props"],
		["POST", "/props"],
		["GET", "/metrics"],
		["GET", "/health"],
		["POST", "/tokenize"],
		["POST", "//v1/chat/completions"],
		["POST", "/v1/../v1/chat/completions"],
	])("refuses %s %s by route, whatever the body", (method, path) => {
		expect(judge(method, path, chat())).toEqual({ admitted: false, reason: "route" });
	});

	it("refuses another model, a missing model, and a body that is not a JSON object", () => {
		expect(judge("POST", "/v1/chat/completions", chat("other-model"))).toEqual({ admitted: false, reason: "model" });
		expect(judge("POST", "/v1/chat/completions", JSON.stringify({ messages: [] }))).toEqual({
			admitted: false,
			reason: "model",
		});
		for (const body of ["not json", "[]", "null", '"x"', ""])
			expect(judge("POST", "/v1/chat/completions", body)).toEqual({ admitted: false, reason: "body" });
	});

	it("refuses a body over the bound before reading it", () => {
		expect(judge("POST", "/v1/chat/completions", Buffer.alloc(p.maxRequestBytes + 1, 0x20))).toEqual({
			admitted: false,
			reason: "size",
		});
	});

	it("a policy is named by a digest of its content, not its order; an unusable policy is refused", async () => {
		const twoRoutes = policy({
			routes: [
				{ method: "POST", path: "/v1/chat/completions" },
				{ method: "GET", path: "/v1/models" },
			],
		});
		const reversed = policy({ routes: [...twoRoutes.routes].reverse() });
		expect(modelRelayPolicyDigestV0(twoRoutes)).toBe(modelRelayPolicyDigestV0(reversed));
		expect(modelRelayPolicyDigestV0(twoRoutes)).not.toBe(modelRelayPolicyDigestV0(policy()));
		const log = new EndoCaptureLogV0(fresh("store"), KEY, "record", { async: true });
		cleanup.push(() => log.close());
		for (const bad of [
			policy({ routes: [] }),
			policy({ routes: [{ method: "CONNECT", path: "/x" }] }),
			policy({ routes: [{ method: "POST", path: "/v1/*" }] }),
			policy({ routes: [{ method: "POST", path: "/v1/../admin" }] }),
			policy({ model: "" }),
			policy({ maxRequestBytes: 2 * 1024 * 1024 }),
			policy({ maxConnections: 0 }),
		])
			await expect(
				startModelRelayV0({ upstream: "http://127.0.0.1:9", policy: bad, log, runtimeDirectory: runtimeBase }),
			).rejects.toThrow(TypeError);
	});
});

describe("EVAL-ISO-002: the relay's host side (Unix socket, governed recording proxy, capture log)", () => {
	it("forwards and records the admitted request; refuses every other one without contacting the model server", async () => {
		const { upstream, relay, log, store } = await relayed();
		const allowed = await overSocket(relay, "POST", "/v1/chat/completions", chat());
		expect(allowed).toMatchObject({ status: 200 });
		for (const [method, path, body] of [
			["GET", "/slots", undefined],
			["POST", "/models/load", JSON.stringify({ model: "other" })],
			["GET", "/v1/models", undefined],
			["POST", "/v1/chat/completions", chat("other-model")],
			["POST", "/v1/chat/completions", "[]"],
			["DELETE", "/v1/chat/completions", undefined],
		] as const)
			expect(await overSocket(relay, method, path, body), `${method} ${path}`).toHaveProperty("closed");
		// The model server saw exactly the one admitted request.
		expect(upstream.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /v1/chat/completions"]);
		expect(relay.admitted()).toBe(1);
		// GET /slots, GET /v1/models and DELETE carry no body length: the governed proxy refuses them before the judge (unjudged).
		expect(relay.refusals()).toEqual({ route: 1, model: 1, body: 1, size: 0, unjudged: 3, connections: 0 });
		await relay.close();
		log.close();
		// The recording is a cassette: the admitted exchange, complete and verified against the blob store.
		const cassette = loadEndoCassetteV0(store, KEY);
		const complete = cassette.exchanges.filter((e) => e.response?.outcome === "complete");
		expect(complete.map((e) => `${e.method} ${e.path}`)).toEqual(["POST /v1/chat/completions"]);
		expect(complete[0]?.truncated).toBeNull();
		// No refused request reached the upstream; whatever the log shows of one, it was never answered.
		for (const e of cassette.exchanges.filter((x) => x.response?.outcome !== "complete"))
			expect(e.response?.status ?? null).toBeNull();
	});

	it("a raw CONNECT, an unparseable stream, and a request over the size bound are refused", async () => {
		const { upstream, relay } = await relayed({ maxRequestBytes: 1024 });
		expect(
			await overSocket(
				relay,
				"POST",
				"/v1/chat/completions",
				JSON.stringify({ model: MODEL, pad: "x".repeat(4096) }),
			),
		).toHaveProperty("closed");
		const raw = (bytes: string) =>
			new Promise<string>((resolve) => {
				const s = require("node:net").connect(relay.socketPath);
				let got = "";
				s.on("data", (d: Buffer) => {
					got += d;
				});
				s.on("close", () => resolve(got));
				s.on("error", () => resolve(got));
				s.write(bytes);
				setTimeout(() => s.end(), 200);
			});
		expect(await raw("CONNECT 127.0.0.1:8081 HTTP/1.1\r\nHost: 127.0.0.1:8081\r\n\r\n")).toBe("");
		expect(await raw("\x16\x03\x01 not http at all\r\n\r\n")).toBe("");
		expect(upstream.requests).toEqual([]);
		expect(relay.refusals()).toMatchObject({ size: 1, unjudged: 2 });
	});

	it("bounds the connections open at once through the socket", async () => {
		const { relay } = await relayed({ maxConnections: 2 });
		const net = await import("node:net");
		const held = [net.connect(relay.socketPath), net.connect(relay.socketPath)];
		cleanup.push(() => {
			for (const s of held) s.destroy();
		});
		await new Promise((r) => setTimeout(r, 100));
		const third = net.connect(relay.socketPath);
		const closed = await new Promise<boolean>((resolve) => {
			third.on("close", () => resolve(true));
			setTimeout(() => resolve(false), 2000);
		});
		expect(closed).toBe(true);
		expect(relay.refusals().connections).toBe(1);
	});

	it("the socket is private: its directory 0700 and the socket 0600, and both are gone after close", async () => {
		const { relay } = await relayed();
		const { statSync } = await import("node:fs");
		const dir = join(relay.socketPath, "..");
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(relay.socketPath).mode & 0o777).toBe(0o600);
		await relay.close();
		expect(existsSync(dir)).toBe(false);
	});

	it("a cassette whose recorded body was altered does not verify", async () => {
		const { relay, log, store } = await relayed();
		expect(await overSocket(relay, "POST", "/v1/chat/completions", chat())).toMatchObject({ status: 200 });
		await relay.close();
		log.close();
		const cassette = loadEndoCassetteV0(store, KEY);
		const wire = cassette.exchanges[0]?.response?.wire;
		expect(wire).toBeDefined();
		// Damage every blob file of the capture: a cassette never serves what does not verify.
		const { readdirSync, statSync } = await import("node:fs");
		const walk = (d: string): string[] =>
			readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
		for (const f of walk(join(store, "capture", "blobs"))) writeFileSync(f, Buffer.from("tampered"));
		expect(loadEndoCassetteV0(store, KEY).exchanges[0]?.truncated).toMatch(/does not verify|missing/);
	});
});

const bw = detectBubblewrapV0();
const contained = bw.ok ? await detectContainmentV0() : null;
const REAL = bw.ok && contained?.ok === true;
const containment = contained?.ok === true ? contained.containment : (null as unknown as EndoContainmentV0);
if (!REAL)
	process.stderr.write(
		`protected-model-relay: real isolation tests skipped: ${bw.ok ? `containment: ${(contained as { detail: string }).detail}` : `${bw.reason}: ${bw.detail}`}\n`,
	);
const NODE = realpathSync(process.execPath);
const sha = (bytes: string | Buffer) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");

/** The two mounts a model-connected sandbox adds, and the bridge in front of a command. */
function relayMounts(relay: EndoModelRelayV0): EndoSandboxMountV0[] {
	const mounts = modelRelayMountsV0(relay, fresh("bridge"));
	const bridge = mounts.find((m) => m.role === "model-bridge");
	expect(sha(readFileSync(bridge?.source as string))).toBe(endoModelBridgeSha256V0());
	return mounts;
}
const PORT = 18080;
const bridged = (command: readonly string[]) => bridgedCommandV0(NODE, PORT, command);

/** What a process inside sees: one observation per line. Each probe reports an outcome, never content beyond a status. */
const PROBE = (hostPorts: number[]) => `
const http = require("node:http"); const net = require("node:net"); const os = require("node:os");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const req = (method, path, body) => new Promise((resolve) => {
	const r = http.request({ host: "127.0.0.1", port: ${PORT}, method, path, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => { res.resume(); res.on("end", () => resolve("status " + res.statusCode)); });
	r.on("error", (e) => resolve("closed " + (e.code || "error")));
	if (body) r.write(body); r.end();
});
const reach = (host, port) => new Promise((resolve) => { const s = net.connect(port, host); s.on("connect", () => { s.destroy(); resolve("connected"); }); s.on("error", (e) => resolve(e.code)); });
(async () => {
	out({ probe: "chat", outcome: await req("POST", "/v1/chat/completions", ${JSON.stringify(chat())}) });
	out({ probe: "other-model", outcome: await req("POST", "/v1/chat/completions", ${JSON.stringify(chat("other-model"))}) });
	out({ probe: "admin-slots", outcome: await req("GET", "/slots") });
	out({ probe: "admin-load", outcome: await req("POST", "/models/load", JSON.stringify({ model: "x" })) });
	out({ probe: "models-list", outcome: await req("GET", "/v1/models") });
	for (const port of ${JSON.stringify(hostPorts)}) out({ probe: "host-loopback-" + port, outcome: await reach("127.0.0.1", port) });
	out({ probe: "external", outcome: await reach("192.0.2.1", 80) });
	out({ probe: "interfaces", outcome: Object.keys(os.networkInterfaces()).sort().join(",") });
})();
`;

describe.runIf(REAL)("EVAL-ISO-002 real isolation: a sandbox with the relay", () => {
	it("reaches the model only through the relay, only on the declared route and model; nothing else is reachable", async () => {
		const { upstream, relay } = await relayed();
		const runtime = resolveRuntimeV0([NODE]);
		if (!runtime.ok) throw new Error(runtime.detail);
		const work = fresh("work");
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [{ target: "/work", kind: "rw-dir", role: "workspace", source: work }, ...relayMounts(relay)],
			env: { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" },
			cwd: "/work",
			tmpfsBytes: 16 * 1024 * 1024,
		});
		expect(profile.logical.network).toBe("model-relay");
		expect(profile.logical.mounts.find((m) => m.target === ENDO_MODEL_SOCKET_TARGET_V0)).toMatchObject({
			kind: "socket",
			role: "model-relay",
			sha256: null,
		});
		const hostPorts = [Number(new URL(upstream.baseUrl).port)];
		const run = await runSandboxV0(
			bw.ok ? bw.bwrap : (null as never),
			profile,
			bridged([NODE, "-e", PROBE(hostPorts)]),
			{
				timeoutMs: 30_000,
				outputBytes: 64 * 1024,
				containment,
			},
		);
		const seen = Object.fromEntries(
			run.stdout
				.toString()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { probe: string; outcome: string })
				.map((o) => [o.probe, o.outcome]),
		);
		expect(seen).toEqual({
			chat: "status 200",
			"other-model": "closed ECONNRESET",
			"admin-slots": "closed ECONNRESET",
			"admin-load": "closed ECONNRESET",
			"models-list": "closed ECONNRESET",
			[`host-loopback-${hostPorts[0]}`]: "ECONNREFUSED",
			external: "ENETUNREACH",
			interfaces: "lo",
		});
		expect(run.exitCode).toBe(0);
		expect(run.termination).toBe("confirmed");
		// The model server saw the one admitted request, nothing else.
		expect(upstream.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /v1/chat/completions"]);
	});

	it("a socket mount must be a model relay's socket: any other file or role is refused when the profile is built", () => {
		const file = join(fresh("not-a-socket"), "f");
		writeFileSync(file, "x");
		const build = (m: EndoSandboxMountV0) =>
			buildSandboxProfileV0({ runtime: [], mounts: [m], env: {}, cwd: "/", tmpfsBytes: 1 << 20 });
		expect(() =>
			build({ target: ENDO_MODEL_SOCKET_TARGET_V0, kind: "socket", role: "model-relay", source: file }),
		).toThrow(/only a model relay's socket/);
		expect(() => build({ target: "/run/x.sock", kind: "socket", role: "docker", source: file })).toThrow(
			/only a model relay's socket/,
		);
	});

	it("resource limits: a sandbox over its memory limit is killed by the kernel, the scope says oom-kill, and termination is confirmed", async () => {
		const runtime = resolveRuntimeV0([NODE]);
		if (!runtime.ok) throw new Error(runtime.detail);
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [],
			env: { HOME: "/home/agent", PATH: "/usr/bin" },
			cwd: "/tmp",
			tmpfsBytes: 1 << 20,
		});
		const hog =
			"const a = []; for (let i = 0; i < 2000; i++) a.push(Buffer.alloc(1 << 20, 1)); console.log('survived');";
		const limited = await runSandboxV0(bw.ok ? bw.bwrap : (null as never), profile, [NODE, "-e", hog], {
			timeoutMs: 30_000,
			outputBytes: 4096,
			containment,
			limits: { memoryMaxBytes: 128 * 1024 * 1024, cpuQuotaPercent: 100 },
		});
		expect(limited.stdout.toString()).not.toContain("survived");
		expect(limited.scope.result).toBe("oom-kill");
		expect(limited.termination).toBe("confirmed");
		// Without limits nothing changes: the same profile, a small allocation, no result field.
		const plain = await runSandboxV0(bw.ok ? bw.bwrap : (null as never), profile, [NODE, "-e", "console.log('ok')"], {
			timeoutMs: 30_000,
			outputBytes: 4096,
			containment,
		});
		expect(plain.stdout.toString().trim()).toBe("ok");
		expect(plain.scope).not.toHaveProperty("result");
	});
});

// ---- real Pi inside the sandbox (opt-in) ----------------------------------------------------------------------------------------------

const PI_DIST = process.env.ENDO_PI_DIST ?? "";
const MODEL_ENDPOINT = process.env.ENDO_MODEL_ENDPOINT ?? "";
const MODEL_ID = process.env.ENDO_MODEL_ID ?? "";
const KEEP = process.env.ENDO_KEEP_RELAY_RUN ?? "";

/** Pi's configuration for one attempt: a writable copy (Pi locks and writes in its agent directory), pointing at the bridge. */
function piAgentDirectory(model: string): string {
	const dir = fresh("pi-agent");
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: {
				relay: {
					baseUrl: `http://127.0.0.1:${PORT}/v1`,
					api: "openai-completions",
					apiKey: "local",
					models: [
						{
							id: model,
							contextWindow: 32768,
							maxTokens: 512,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "relay", defaultModel: model }));
	return dir;
}

async function piInSandbox(upstreamOrigin: string, model: string, prompt: string, upstream?: FakeOpenAiServer) {
	const store = fresh("pi-store");
	const log = new EndoCaptureLogV0(store, KEY, "record", { async: true });
	const relay = await startModelRelayV0({
		upstream: upstreamOrigin,
		policy: policy({ model, maxRequestBytes: 1024 * 1024 }),
		log,
		runtimeDirectory: runtimeBase,
	});
	cleanup.push(async () => {
		await relay.close();
		log.close();
	});
	// Pi's bash tool runs `sh -c`; the scripted command uses cat and head. /usr/bin/sh is a link on this layout, and a runtime file is
	// never a link: bash's real file is mounted there by digest instead.
	const runtime = resolveRuntimeV0([NODE, "/usr/bin/bash", "/usr/bin/cat", "/usr/bin/head"]);
	if (!runtime.ok) throw new Error(runtime.detail);
	const bash = runtime.files.find((f) => f.target === "/usr/bin/bash");
	if (bash === undefined) throw new Error("bash is not in the runtime");
	const work = fresh("pi-work");
	const agent = piAgentDirectory(model);
	const profile = buildSandboxProfileV0({
		runtime: runtime.files,
		mounts: [
			{ target: "/opt/pi/dist", kind: "ro-dir", role: "pi", source: PI_DIST, sha256: endoTreeDigestV0(PI_DIST) },
			{ target: "/pi-agent", kind: "rw-dir", role: "pi-agent", source: agent },
			{ target: "/work", kind: "rw-dir", role: "workspace", source: work },
			{ target: "/usr/bin/sh", kind: "ro-file", role: "runtime-sh", source: bash.source, sha256: bash.sha256 },
			...relayMounts(relay),
		],
		env: {
			HOME: "/home/agent",
			PATH: "/usr/bin",
			TMPDIR: "/tmp",
			PI_CODING_AGENT_DIR: "/pi-agent",
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
		},
		cwd: "/work",
		tmpfsBytes: 64 * 1024 * 1024,
	});
	const run = await runSandboxV0(
		bw.ok ? bw.bwrap : (null as never),
		profile,
		bridged([NODE, "/opt/pi/dist/bundle/cli.js", "-p", "--no-session", prompt]),
		{ timeoutMs: 240_000, outputBytes: 256 * 1024, containment, limits: { memoryMaxBytes: 2 * 1024 * 1024 * 1024 } },
	);
	await relay.close();
	log.close();
	const cassette = loadEndoCassetteV0(store, KEY);
	return { run, relay, cassette, work, profile, upstream };
}

describe.runIf(REAL && PI_DIST.length > 0)(
	"EVAL-ISO-002: real Pi inside the sandbox, a disposable fake model server (opt-in: ENDO_PI_DIST)",
	() => {
		it("Pi answers through the relay, runs its bash tool inside, and uses only the measured route", async () => {
			const upstream = await startFakeOpenAiServer({
				toolScript: {
					steps: [
						{
							name: "bash",
							arguments: JSON.stringify({
								command: "echo inside > /work/made-by-pi.txt; cat /etc/hostname 2>&1 | head -c 80",
							}),
						},
					],
					finalText: "done through the relay",
				},
			});
			cleanup.push(() => upstream.close());
			const { run, relay, cassette, work } = await piInSandbox(
				new URL(upstream.baseUrl).origin,
				"fake-1",
				"Make the file",
				upstream,
			);
			expect(run.exitCode, run.stderr.toString().slice(-2000)).toBe(0);
			expect(run.termination).toBe("confirmed");
			expect(run.stdout.toString()).toContain("done through the relay");
			// The tool ran inside: it wrote the workspace, the only writable host directory.
			expect(readFileSync(join(work, "made-by-pi.txt"), "utf8")).toBe("inside\n");
			// Every request Pi made (the route measurement behind ENDO_PI_MODEL_ROUTES_V0) was the one route, all admitted, all recorded.
			const routes = new Set(upstream.requests.map((r) => `${r.method} ${r.url}`));
			expect([...routes]).toEqual(["POST /v1/chat/completions"]);
			expect(relay.admitted()).toBe(upstream.requests.length);
			expect(Object.values(relay.refusals()).every((n) => n === 0)).toBe(true);
			expect(cassette.exchanges.filter((e) => e.response?.outcome === "complete")).toHaveLength(
				upstream.requests.length,
			);
			if (KEEP.length > 0) {
				mkdirSync(KEEP, { recursive: true });
				writeFileSync(
					join(KEEP, "fake-model.json"),
					`${JSON.stringify({ routes: [...routes], requests: upstream.requests.length, relay: { policyDigest: relay.policyDigest, refusals: relay.refusals() }, termination: run.termination, scope: run.scope }, null, 2)}\n`,
				);
			}
		}, 300_000);
	},
);

describe.runIf(REAL && PI_DIST.length > 0 && MODEL_ENDPOINT.length > 0 && MODEL_ID.length > 0)(
	"EVAL-ISO-002: real Pi inside the sandbox, a REAL local model through the relay (opt-in; outcome kept, not asserted)",
	() => {
		it("runs one short prompt and keeps what happened", async () => {
			const { run, relay, cassette } = await piInSandbox(
				MODEL_ENDPOINT,
				MODEL_ID,
				"Reply with the single word: ready",
			);
			const summary = {
				exitCode: run.exitCode,
				termination: run.termination,
				scope: run.scope,
				durationMs: run.durationMs,
				answerTail: run.stdout.toString().slice(-200),
				relay: { policyDigest: relay.policyDigest, admitted: relay.admitted(), refusals: relay.refusals() },
				exchanges: cassette.exchanges.map((e) => ({
					method: e.method,
					path: e.path,
					outcome: e.response?.outcome ?? null,
					truncated: e.truncated,
				})),
			};
			if (KEEP.length > 0) {
				mkdirSync(KEEP, { recursive: true });
				writeFileSync(join(KEEP, "real-model.json"), `${JSON.stringify(summary, null, 2)}\n`);
			}
			process.stderr.write(`EVAL-ISO-002 real model: ${JSON.stringify(summary)}\n`);
			// Only what does not depend on the model's answer: the boundary held and every exchange was the one route.
			expect(run.termination).toBe("confirmed");
			expect(cassette.exchanges.every((e) => e.method === "POST" && e.path === "/v1/chat/completions")).toBe(true);
		}, 600_000);
	},
);

describe.runIf(REAL && PI_DIST.length > 0)(
	"EVAL-ISO-002: the trial record is verified independently, and each kind of tampering is caught (opt-in: ENDO_PI_DIST)",
	() => {
		it("a fake-model trial verifies; then a changed record, output, workspace file or recorded body each fails its own check", async () => {
			const { runTrial, verifyTrial } = await import("../research/protected-eval/model-connected/trial.ts");
			const upstream = await startFakeOpenAiServer({
				toolScript: {
					steps: [{ name: "bash", arguments: JSON.stringify({ command: "echo kept > /work/result.txt" }) }],
					finalText: "trial done",
				},
			});
			cleanup.push(() => upstream.close());
			const dir = join(fresh("trial"), "t");
			await runTrial([
				"run",
				"--out",
				dir,
				"--pi-dist",
				PI_DIST,
				"--upstream",
				new URL(upstream.baseUrl).origin,
				"--model",
				"fake-1",
				"--prompt",
				"Keep a result",
				"--timeout-s",
				"240",
			]);
			const failed = () =>
				verifyTrial(dir)
					.filter((f) => !f.ok)
					.map((f) => f.check);
			expect(failed()).toEqual([]);
			expect(readFileSync(join(dir, "work", "result.txt"), "utf8")).toBe("kept\n");

			const recordFile = join(dir, "record.json");
			const original = readFileSync(recordFile, "utf8");
			writeFileSync(recordFile, original.replace('"termination": "confirmed"', '"termination": "unconfirmed"'));
			expect(failed()).toEqual(["seal", "termination"]);
			writeFileSync(recordFile, original);

			const stdout = join(dir, "stdout.txt");
			const out = readFileSync(stdout);
			writeFileSync(stdout, Buffer.concat([out, Buffer.from("forged")]));
			expect(failed()).toEqual(["stdout-digest"]);
			writeFileSync(stdout, out);

			writeFileSync(join(dir, "work", "planted.txt"), "after the trial");
			expect(failed()).toEqual(["workspace-digest"]);
			rmSync(join(dir, "work", "planted.txt"));

			const { readdirSync, statSync } = await import("node:fs");
			const walk = (d: string): string[] =>
				readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
			for (const f of walk(join(dir, "store", "capture", "blobs"))) writeFileSync(f, Buffer.from("tampered"));
			expect(failed()).toEqual(expect.arrayContaining(["cassette-matches-record"]));
			expect(failed()).not.toContain("seal");
		}, 300_000);
	},
);
