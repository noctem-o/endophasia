import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { EndoCaptureLogV0 } from "../../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../../adapters/openai-proxy/cassette.ts";
import { GOVERNED_REFUSAL_ERROR_V0 } from "../../adapters/openai-proxy/record.ts";
import {
	buildSandboxProfileV0,
	type EndoBubblewrapV0,
	type EndoSandboxProfileInputV0,
	runSandboxV0,
} from "../../adapters/sandbox/bubblewrap.ts";
import {
	bridgedCommandV0,
	ENDO_MODEL_SOCKET_TARGET_V0,
	ENDO_PI_MODEL_ROUTES_V0,
	modelRelayMountsV0,
	startModelRelayV0,
} from "../../adapters/sandbox/model-relay.ts";
import { ENDO_FD_OBSERVER_V0, ENDO_STDIO_FDS_V0, profileWithFdObserverV0 } from "../../adapters/sandbox/preflight.ts";
import { endoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";

const NODE = "/usr/bin/node";
const PORT = 18080;
const UPSTREAM = "http://127.0.0.1:8090";
const MODEL = "Ornith-1.5-9B-Q8_0";
const MAX_BODY = 32 * 1024;
const MAX_TOKENS = 128;
const PROMPT = "Reply with the single word READY.";

const ROUTE_PROBE = String.raw`
import assert from "node:assert/strict"; import fs from "node:fs"; import net from "node:net";
import os from "node:os"; import http from "node:http"; import { spawn } from "node:child_process";
const c = JSON.parse(process.argv[1]);
const attempt = (opts) => new Promise((resolve) => {
	const socket = net.createConnection(opts);
	const end = (value) => { clearTimeout(timeout); socket.destroy(); resolve(value); };
	const timeout = setTimeout(() => end("timeout"), 1500);
	socket.once("connect", () => end("connected"));
	socket.once("error", (error) => end(error.code));
});
const code = (f) => { try { f(); return "ok"; } catch (e) { return e.code || "error"; } };
assert.equal(process.argv[2], c.fds);
if (c.mode === "shared-network-control") {
	assert.equal(fs.readlinkSync("/proc/self/ns/net"), c.namespaces.net);
	const outcome = await attempt({ host: "127.0.0.1", port: c.hostPorts.canary });
	assert.equal(outcome, "connected");
	console.log(JSON.stringify({ fds: process.argv[2], networkNamespace: "shared", hostCanary: outcome }));
	process.exit(0);
}
const stat = fs.statSync("/work", { bigint: true });
assert.equal(stat.dev + ":" + stat.ino, c.workspace);
assert.equal(code(() => fs.readFileSync(c.canary)), "ENOENT");
assert.equal(code(() => fs.appendFileSync("/work/.git/config", "")), "EROFS");
assert.equal(code(() => fs.writeFileSync("/model-pilot-root-canary", "x", { flag: "wx" })), "EROFS");
assert.equal(code(() => fs.closeSync(fs.openSync("/dev/tty", fs.constants.O_RDONLY | fs.constants.O_NOCTTY))), "ENXIO");
assert.equal(code(() => fs.statSync("/proc/" + c.controllerPid)), "ENOENT");
const status = fs.readFileSync("/proc/self/status", "utf8");
assert.match(status, /^NoNewPrivs:\s+1$/m);
for (const cap of ["Eff", "Prm", "Inh", "Bnd", "Amb"])
	assert.match(status, new RegExp("^Cap" + cap + ":\\s+0+$", "m"));
for (const [name, identity] of Object.entries(c.namespaces))
	assert.notEqual(fs.readlinkSync("/proc/self/ns/" + name), identity);
assert.deepEqual(Object.keys(os.networkInterfaces()).filter(n => n !== "lo"), []);
const observations = {
	fds: process.argv[2], networkNamespace: "different",
	direct: await attempt({ host: "127.0.0.1", port: 8090 }),
	bridge: await attempt({ host: "127.0.0.1", port: c.port }),
	relaySocket: code(() => fs.lstatSync(c.socket)),
	abstract: await attempt({ path: "\0" + c.abstractName }),
};
if (c.hostPorts) {
	const self = net.createServer((socket) => socket.end());
	await new Promise((resolve, reject) => { self.once("error", reject); self.listen(0, "127.0.0.1", resolve); });
	try {
		const address = self.address();
		assert.equal(address.address, "127.0.0.1");
		observations.selfListener = address.address + ":" + address.port;
		observations.selfLoopback = await attempt({ host: address.address, port: address.port });
	} finally {
		await new Promise((resolve, reject) => self.close((error) => error ? reject(error) : resolve()));
	}
	observations.external = await attempt({ host: "192.0.2.1", port: 80 });
	observations.hostCanary = await attempt({ host: "127.0.0.1", port: c.hostPorts.canary });
	observations.hostRecorder = await attempt({ host: "127.0.0.1", port: c.hostPorts.recorder });
	assert.equal(observations.selfLoopback, "connected");
	assert.equal(observations.external, "ENETUNREACH");
	assert.equal(observations.hostCanary, "ECONNREFUSED");
	assert.equal(observations.hostRecorder, "ECONNREFUSED");
}
assert.equal(observations.direct, "ECONNREFUSED");
assert.equal(observations.abstract, "ECONNREFUSED");
const request = (method, path, model, extra = {}) => new Promise((resolve) => {
	const body = JSON.stringify({ model, messages: [{ role: "user", content: "fixture" }], max_tokens: 1, ...extra });
	const req = http.request({ host: "127.0.0.1", port: c.port, method, path, agent: false,
		headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
		(res) => { res.resume(); res.once("end", () => resolve("HTTP " + res.statusCode)); });
	req.once("error", (error) => resolve(error.code));
	req.setTimeout(4000, () => { req.destroy(); resolve("timeout"); });
	req.end(body);
});
if (c.mode === "bridge-only")
	observations.bridgeRequest = await request("POST", "/v1/chat/completions", c.model);
if (c.mode === "policy") {
	observations.wrongMethod = await request("PUT", "/v1/chat/completions", c.model);
	observations.wrongPath = await request("POST", "/v1/models", c.model);
	observations.wrongModel = await request("POST", "/v1/chat/completions", "endo-isolate-nonexistent-model");
	observations.oversized = await request("POST", "/v1/chat/completions", c.model, { padding: "x".repeat(c.maxBody) });
}
if (c.mode === "pi") {
	assert.equal(observations.bridge, "connected");
	assert.equal(fs.lstatSync(c.socket).isSocket(), true);
	fs.writeFileSync("/home/agent/models.json", JSON.stringify({ providers: { relay: {
		baseUrl: "http://127.0.0.1:" + c.port + "/v1", api: "openai-completions", apiKey: "local",
		models: [{ id: c.model, reasoning: false, contextWindow: 32768, maxTokens: c.maxTokens,
			input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }), { mode: 0o600 });
	const pi = spawn("/usr/bin/node", [
		"/pi/dist/bundle/cli.js", "-p", "--provider", "relay", "--model", c.model, "--thinking", "off",
		"--offline", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills",
		"--no-context-files", "--no-prompt-templates", "--no-approve", "--no-themes", c.prompt,
	], { stdio: ["ignore", "pipe", "ignore"] });
	let output = "";
	pi.stdout.setEncoding("utf8").on("data", (chunk) => { if (output.length < 4096) output += chunk.slice(0, 4096 - output.length); });
	const exit = await new Promise((resolve, reject) => { pi.once("error", reject); pi.once("close", resolve); });
	assert.equal(exit, 0, "Pi exited without a successful completion");
	observations.completion = output.trim().slice(0, 100);
	assert.match(observations.completion, /^READY\.?$/i, "Pi did not print the bounded completion");
}
console.log(JSON.stringify(observations));
`;

type PilotContext = {
	bwrap: EndoBubblewrapV0;
	base: EndoSandboxProfileInputV0;
	options: Parameters<typeof runSandboxV0>[3];
	scratch: string;
	piRoot: string;
	controller: { namespaces: Record<string, string>; workspace: string; controllerPid: number; secret: string };
};

export async function runModelPilot(
	{ bwrap, base, options, scratch, piRoot, controller }: PilotContext,
	connect: boolean,
) {
	const selfListeners: { scope: string; address: string }[] = [];
	let hostPorts: { canary: number; recorder: number } | undefined;
	const scope = async (mode: string, mounts: EndoSandboxProfileInputV0["mounts"] = [], bridge = false) => {
		const profile = profileWithFdObserverV0(
			buildSandboxProfileV0({
				...base,
				mounts: [...base.mounts, ...mounts],
				...(mode === "shared-network-control" ? { unsafeForTests: { shareNet: true } } : {}),
			}),
		);
		assert(profile, "the trusted descriptor observer is unavailable");
		const command = [
			NODE,
			"--input-type=module",
			"-e",
			ROUTE_PROBE,
			JSON.stringify({
				...controller,
				canary: controller.secret,
				port: PORT,
				socket: ENDO_MODEL_SOCKET_TARGET_V0,
				fds: ENDO_STDIO_FDS_V0,
				abstractName: `endo-pilot-${randomBytes(12).toString("hex")}`,
				mode,
				hostPorts,
				model: MODEL,
				maxBody: MAX_BODY,
				maxTokens: MAX_TOKENS,
				prompt: PROMPT,
			}),
		];
		const run = await runSandboxV0(
			bwrap,
			profile,
			[
				...ENDO_FD_OBSERVER_V0,
				...(bridge ? bridgedCommandV0(NODE, PORT, [...ENDO_FD_OBSERVER_V0, ...command]) : command),
			],
			{
				...options,
				timeoutMs: mode === "pi" ? 120_000 : 20_000,
			},
		);
		assert(
			run.started &&
				run.exitCode === 0 &&
				run.initGone &&
				run.termination === "confirmed" &&
				run.truncated.stdout === 0 &&
				run.truncated.stderr === 0,
			`${mode} failed or cleanup was unconfirmed (exit=${run.exitCode}, timeout=${run.timedOut}): ${run.stderr.toString().slice(-600)}`,
		);
		const { selfListener, ...observations } = JSON.parse(run.stdout.toString());
		if (hostPorts !== undefined && mode !== "shared-network-control") {
			assert.equal(typeof selfListener, "string");
			assert.match(selfListener, /^127\.0\.0\.1:[1-9][0-9]{0,4}$/);
			selfListeners.push({ scope: mode, address: selfListener });
		} else {
			assert.equal(selfListener, undefined);
		}
		return observations;
	};
	const unavailable = {
		fds: ENDO_STDIO_FDS_V0,
		networkNamespace: "different",
		direct: "ECONNREFUSED",
		bridge: "ECONNREFUSED",
		relaySocket: "ENOENT",
		abstract: "ECONNREFUSED",
	};
	if (!connect) {
		const noRoute = await scope("no-route");
		assert.deepEqual(noRoute, unavailable);
		return { noRoute };
	}

	const host = await fetch(`${UPSTREAM}/v1/models`, { redirect: "error", signal: AbortSignal.timeout(4000) });
	assert.equal(host.status, 200, "approved host model API must answer");
	const listing = (await host.json()) as { data?: { id?: string }[] } | null;
	assert(
		Array.isArray(listing?.data) && listing.data.some((entry) => entry?.id === MODEL),
		"approved model is not listed",
	);
	const key = endoDigestKeyV0(randomBytes(32), "installation");
	const store = join(scratch, "pilot-capture");
	const log = new EndoCaptureLogV0(store, key, "record", { async: true });
	let canaryHits = 0;
	const canary = createServer((socket) => {
		canaryHits += 1;
		socket.destroy();
	});
	const closeCanary = async () => {
		if (canary.listening)
			await new Promise<void>((resolve, reject) => canary.close((error) => (error ? reject(error) : resolve())));
	};
	const policy = {
		routes: ENDO_PI_MODEL_ROUTES_V0,
		model: MODEL,
		maxRequestBytes: MAX_BODY,
		maxTransferredBytes: 1024 * 1024,
		maxConnections: 2,
		maxTotalConnections: 12,
		maxExchanges: 1,
		maxCompletionTokens: MAX_TOKENS,
	};
	let relay: Awaited<ReturnType<typeof startModelRelayV0>> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			canary.once("error", reject);
			canary.listen(0, "127.0.0.1", resolve);
		});
		const canaryAddress = canary.address();
		assert(canaryAddress !== null && typeof canaryAddress !== "string");
		assert.equal(canaryAddress.address, "127.0.0.1");
		relay = await startModelRelayV0({ upstream: UPSTREAM, policy, log, runtimeDirectory: scratch });
		await log.flush();
		const listen = loadEndoCassetteV0(store, key).listen;
		assert(listen, "recording proxy listener was not recorded");
		const proxy = new URL(listen);
		assert.equal(proxy.hostname, "127.0.0.1");
		hostPorts = { canary: canaryAddress.port, recorder: Number(proxy.port) };
		const privateNetwork = {
			...unavailable,
			selfLoopback: "connected",
			external: "ENETUNREACH",
			hostCanary: "ECONNREFUSED",
			hostRecorder: "ECONNREFUSED",
		};
		const noRoute = await scope("no-route");
		assert.deepEqual(noRoute, privateNetwork);
		assert.equal(statSync(dirname(relay.socketPath)).mode & 0o777, 0o700);
		assert.equal(lstatSync(relay.socketPath).mode & 0o777, 0o600);
		const mounts = modelRelayMountsV0(relay, scratch);
		const bridgeOnly = await scope(
			"bridge-only",
			mounts.filter((m) => m.kind !== "socket"),
			true,
		);
		assert.deepEqual(bridgeOnly, { ...privateNetwork, bridge: "connected", bridgeRequest: "ECONNRESET" });
		assert.equal(relay.admitted(), 0);
		const policyControl = await scope("policy", mounts, true);
		const active = { ...privateNetwork, bridge: "connected", relaySocket: "ok" };
		assert.deepEqual(policyControl, {
			...active,
			wrongMethod: "ECONNRESET",
			wrongPath: "ECONNRESET",
			wrongModel: "ECONNRESET",
			oversized: "ECONNRESET",
		});
		const refusals = {
			route: 2,
			size: 1,
			model: 1,
			body: 0,
			generation: 0,
			unjudged: 0,
			connections: 0,
			exchanges: 0,
		};
		assert.deepEqual(relay.refusals(), refusals);
		assert.equal(relay.admitted(), 0);

		const pi = await scope(
			"pi",
			[...mounts, { kind: "ro-dir", role: "pinned-offline-pi", source: piRoot, target: "/pi" }],
			true,
		);
		assert.deepEqual({ ...pi, completion: "" }, { ...active, completion: "" });
		assert.equal(relay.admitted(), 1);
		assert.deepEqual(relay.refusals(), refusals);
		assert.equal(canaryHits, 0, "a private scope contacted the host canary");
		const sharedNetwork = await scope("shared-network-control");
		assert.deepEqual(sharedNetwork, { fds: ENDO_STDIO_FDS_V0, networkNamespace: "shared", hostCanary: "connected" });
		assert.equal(canaryHits, 1, "the shared-network control did not reach the canary exactly once");
		await closeCanary();
		await relay.close();
		await log.flush();
		assert.equal(relay.recordingFailures(), 0);

		const cassette = loadEndoCassetteV0(store, key);
		const noForward = cassette.events.filter(
			({ kind, payload }) =>
				kind === "capture.exchange-ended" &&
				typeof payload === "object" &&
				payload !== null &&
				!Array.isArray(payload) &&
				payload.error === GOVERNED_REFUSAL_ERROR_V0 &&
				typeof payload.transport === "object" &&
				payload.transport !== null &&
				!Array.isArray(payload.transport) &&
				payload.transport.phase === "not-forwarded" &&
				payload.transport.forwarded === false,
		).length;
		assert.equal(noForward, 4);
		const complete = cassette.exchanges.filter((e) => e.response?.outcome === "complete");
		assert.equal(complete.length, 1);
		assert.equal(complete[0]?.method, "POST");
		assert.equal(complete[0]?.path, "/v1/chat/completions");
		assert.equal(complete[0]?.response?.status, 200);
		assert.equal(complete[0]?.truncated, null);
		assert.equal(cassette.listen, listen);
		const afterClose = (port: number) =>
			new Promise((resolve) => {
				const socket = createConnection({ host: "127.0.0.1", port });
				const done = (value: string) => {
					socket.destroy();
					resolve(value);
				};
				socket.on("error", (e) => done((e as NodeJS.ErrnoException).code ?? "error"));
				socket.on("connect", () => done("connected"));
				socket.setTimeout(1500, () => done("timeout"));
			});
		const proxyClosed = await afterClose(hostPorts.recorder);
		const canaryClosed = await afterClose(hostPorts.canary);
		assert.equal(proxyClosed, "ECONNREFUSED");
		assert.equal(canaryClosed, "ECONNREFUSED");
		assert.equal(existsSync(relay.socketPath), false);
		return {
			hostModelListed: true,
			model: MODEL,
			upstream: UPSTREAM,
			noRoute,
			bridgeOnly,
			policyControl,
			sharedNetwork,
			canaryHits,
			refusals,
			notForwarded: noForward,
			admitted: relay.admitted(),
			pi,
			completed: { method: "POST", path: "/v1/chat/completions", status: 200 },
			listeners: {
				proxy: listen,
				unix: relay.socketPath,
				guestBridges: `127.0.0.1:${PORT}`,
				hostCanary: `127.0.0.1:${hostPorts.canary}`,
				selfListeners,
			},
			cleanup: { allScopes: "confirmed", proxy: proxyClosed, hostCanary: canaryClosed, unix: "removed" },
		};
	} finally {
		try {
			await relay?.close();
			await log.flush();
		} finally {
			try {
				await closeCanary();
			} finally {
				log.close();
			}
		}
	}
}
