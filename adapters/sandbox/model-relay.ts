// EVAL-ISO-002 (docs/protected-experiments.md §10, docs/protected-model-access.md): model access for a protected sandbox, through a narrow
// recording relay. The sandbox still has no network: its namespace holds only `lo`. One Unix socket, created by the controller in a
// private directory, is bind-mounted into it. Behind the socket:
//
//   sandbox: Pi ──HTTP──▶ 127.0.0.1:<port> (the bridge, inside) ──▶ /run/endo/model.sock
//   host:    model.sock ──▶ the recording proxy (adapters/openai-proxy/record.ts), governed admission ──▶ the model server
//
// The recording proxy is reused unchanged, in its fail-closed governed profile: a complete request is buffered and judged before any
// upstream connection is opened, and a refusal closes the client's connection without contacting the upstream. Its judge here is
// admitModelRequestV0: an explicit list of routes (method and exact path), one model named in the JSON body, and a size bound. Everything
// else is refused: other paths (llama.cpp's administration endpoints among them), other methods, CONNECT, another model, a body that is
// not a JSON object. Every admitted exchange is recorded in the capture log, a cassette (adapters/openai-proxy/cassette.ts) that can be
// verified and replayed without the model.
//
// The bridge inside the sandbox is a few lines of trusted code that the controller writes and mounts read-only by digest. It is not a
// boundary: the agent can replace or bypass it, and reach only the same socket, which is where the policy is enforced.

import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoCaptureLogV0 } from "../openai-proxy/capture-log.ts";
import {
	type EndoRecordingProxyV0,
	GOVERNED_REQUEST_MAX_BYTES_V0,
	startEndoRecordingProxyV0,
} from "../openai-proxy/record.ts";
import type { EndoSandboxMountV0 } from "./bubblewrap.ts";
import {
	admitModelRequestV0,
	ENDO_PI_MODEL_ROUTES_V0,
	type EndoModelRefusalReasonV0,
	type EndoModelRelayPolicyV0,
	type EndoModelRouteV0,
	modelRelayPolicyDigestV0,
} from "./model-relay-policy.ts";

export {
	admitModelRequestV0,
	ENDO_PI_MODEL_ROUTES_V0,
	type EndoModelRefusalReasonV0,
	type EndoModelRelayPolicyV0,
	type EndoModelRouteV0,
	modelRelayPolicyDigestV0,
};

/** A deep, frozen copy of a policy: only its declared fields, so nothing the caller holds is shared with the running relay. */
function snapshotPolicy(policy: EndoModelRelayPolicyV0): EndoModelRelayPolicyV0 {
	return Object.freeze({
		routes: Object.freeze(policy.routes.map((route) => Object.freeze({ method: route.method, path: route.path }))),
		model: policy.model,
		maxRequestBytes: policy.maxRequestBytes,
		maxTransferredBytes: policy.maxTransferredBytes,
		maxConnections: policy.maxConnections,
		maxTotalConnections: policy.maxTotalConnections,
		maxExchanges: policy.maxExchanges,
		...(policy.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: policy.maxCompletionTokens }),
	});
}

function checkPolicy(policy: EndoModelRelayPolicyV0): void {
	if (policy.routes.length === 0) throw new TypeError("a model relay admits at least one route");
	for (const route of policy.routes) {
		if (!/^[A-Z]{3,7}$/.test(route.method) || route.method === "CONNECT")
			throw new TypeError(`route method ${JSON.stringify(route.method)} is not acceptable`);
		if (!/^\/[A-Za-z0-9._~\-/]{1,200}$/.test(route.path) || route.path.includes("//") || route.path.includes("/."))
			throw new TypeError(`route path ${JSON.stringify(route.path)} is not an exact plain path`);
	}
	if (policy.model.length === 0 || policy.model.length > 256) throw new TypeError("the relay names one model");
	for (const [name, value, max] of [
		["maxRequestBytes", policy.maxRequestBytes, GOVERNED_REQUEST_MAX_BYTES_V0],
		["maxTransferredBytes", policy.maxTransferredBytes, Number.MAX_SAFE_INTEGER],
		["maxConnections", policy.maxConnections, 64],
		["maxTotalConnections", policy.maxTotalConnections, 1_000_000],
		["maxExchanges", policy.maxExchanges, 1_000_000],
	] as const)
		if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} must be 1..${max}`);
	if (
		policy.maxCompletionTokens !== undefined &&
		(!Number.isSafeInteger(policy.maxCompletionTokens) ||
			policy.maxCompletionTokens < 1 ||
			policy.maxCompletionTokens > 1_000_000)
	)
		throw new TypeError("maxCompletionTokens must be 1..1000000");
}

export interface EndoModelRelayV0 {
	/** The host path of the socket: bind-mount it (and nothing else of its directory) into the sandbox. */
	readonly socketPath: string;
	readonly policy: EndoModelRelayPolicyV0;
	readonly policyDigest: string;
	/**
	 * Requests refused before reaching the model server, by reason. `unjudged`: refused by the governed proxy before the judge saw them,
	 * because they were not one complete request with a declared body length (a GET or DELETE without a body, CONNECT, an unparseable
	 * stream). `connections`: connections refused at either connection bound (open at once, or over the relay's life). `exchanges`:
	 * requests refused because the relay had already admitted `maxExchanges`. `generation`: requests over the policy's generation bound.
	 */
	refusals(): Readonly<Record<EndoModelRefusalReasonV0 | "unjudged" | "connections" | "exchanges", number>>;
	/** Requests admitted to the model server. */
	admitted(): number;
	/** All bytes the recording proxy saw, both ways. */
	transferredBytes(): number;
	/** Capture writes that failed (the store full, for example): a recording with any is incomplete, whatever it still shows. */
	recordingFailures(): number;
	/** Stops accepting, drops every connection, stops the proxy (which flushes its recording), and removes the socket's directory. */
	close(): Promise<void>;
}

/**
 * Start a relay: the recording proxy (loopback, governed admission by `policy`) and a Unix socket in a new private directory (0700, socket
 * 0600) under `runtimeDirectory`, which should be private to this user and short ($XDG_RUNTIME_DIR): a socket's path is limited to 107
 * bytes. Every admitted exchange is recorded into `log`.
 */
export async function startModelRelayV0(options: {
	readonly upstream: string;
	readonly policy: EndoModelRelayPolicyV0;
	readonly log: EndoCaptureLogV0;
	readonly runtimeDirectory: string;
}): Promise<EndoModelRelayV0> {
	// One immutable snapshot, validated, judged by and digested: a caller that keeps and changes its own policy object afterwards cannot
	// change what is admitted, nor make the digest describe another policy than the one enforced (Codex, #134).
	const policy = snapshotPolicy(options.policy);
	checkPolicy(policy);
	const refused: Record<EndoModelRefusalReasonV0 | "unjudged" | "connections" | "exchanges", number> = {
		route: 0,
		size: 0,
		body: 0,
		model: 0,
		generation: 0,
		unjudged: 0,
		connections: 0,
		exchanges: 0,
	};
	let admitted = 0;
	let judged = 0;
	const proxy: EndoRecordingProxyV0 = await startEndoRecordingProxyV0({
		upstream: options.upstream,
		log: options.log,
		maxTransferredBytes: policy.maxTransferredBytes,
		admitRequest: (request) => {
			judged += 1;
			if (admitted >= policy.maxExchanges) {
				refused.exchanges += 1;
				return false;
			}
			const verdict = admitModelRequestV0(policy, request);
			if (verdict.admitted) admitted += 1;
			else refused[verdict.reason] += 1;
			return verdict.admitted;
		},
	});
	// From here on, any failure closes what was already started (the proxy, the socket's directory), so a caller that catches it and
	// retries leaves nothing listening (Codex, #134).
	let directory: string | null = null;
	const open = new Set<Socket>();
	const clients = new Set<Socket>();
	let accepted = 0;
	const server: Server = createServer((client) => {
		if (clients.size >= policy.maxConnections || accepted >= policy.maxTotalConnections) {
			refused.connections += 1;
			client.destroy();
			return;
		}
		accepted += 1;
		const upstream = netConnect(proxy.port, proxy.host);
		clients.add(client);
		open.add(client);
		open.add(upstream);
		const end = () => {
			client.destroy();
			upstream.destroy();
			clients.delete(client);
			open.delete(client);
			open.delete(upstream);
		};
		client.on("error", end);
		upstream.on("error", end);
		client.on("close", end);
		upstream.on("close", end);
		client.pipe(upstream);
		upstream.pipe(client);
	});
	let socketPath: string;
	try {
		directory = mkdtempSync(join(options.runtimeDirectory, "endo-relay-"));
		chmodSync(directory, 0o700);
		socketPath = join(directory, "model.sock");
		if (Buffer.byteLength(socketPath) > 107)
			throw new TypeError(`the relay socket's path is too long for a Unix socket (${socketPath})`);
		const path = socketPath;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => resolve());
		});
		chmodSync(socketPath, 0o600);
		const made = lstatSync(socketPath);
		if (!made.isSocket() || made.uid !== process.getuid?.())
			throw new TypeError("the relay socket is not this process's");
	} catch (error) {
		if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		await proxy.close();
		if (directory !== null) rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	const ownDirectory = directory;
	let closing: Promise<void> | undefined;
	return {
		socketPath,
		policy,
		policyDigest: modelRelayPolicyDigestV0(policy),
		// Requests the proxy refused that never reached the judge (see refusals()).
		refusals: () => ({ ...refused, unjudged: Math.max(0, proxy.refusedRequests - (judged - admitted)) }),
		admitted: () => admitted,
		transferredBytes: () => proxy.transferredBytes,
		recordingFailures: () => proxy.recordingFailures,
		close: () => {
			closing ??= (async () => {
				// Stop accepting, and drop every open connection BEFORE waiting: server.close() calls back only once its connections ended,
				// so a client holding one open would otherwise make close() wait forever (Codex, #134).
				const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
				for (const socket of open) socket.destroy();
				await stopped;
				await proxy.close();
				rmSync(ownDirectory, { recursive: true, force: true });
			})();
			return closing;
		},
	};
}

/** Where the socket appears inside a sandbox, and the bridge with it. */
export const ENDO_MODEL_SOCKET_TARGET_V0 = "/run/endo/model.sock";
export const ENDO_MODEL_BRIDGE_TARGET_V0 = "/run/endo/bridge.cjs";

/**
 * The bridge, run by node inside the sandbox: `node bridge.cjs <port> <socket> -- <command…>`. It listens on 127.0.0.1:<port> in the
 * sandbox's own network namespace, pipes each connection to the socket, and once listening runs the command (stdio inherited), exiting
 * with its status. It enforces nothing: the relay does.
 */
export const ENDO_MODEL_BRIDGE_SOURCE_V0 = `"use strict";
const net = require("node:net");
const { spawn } = require("node:child_process");
const [port, socket, separator, ...command] = process.argv.slice(2);
const standalone = separator === undefined;
if (!/^[0-9]{1,5}$/.test(port ?? "") || !socket || (!standalone && (separator !== "--" || command.length === 0))) process.exit(64);
const server = net.createServer((client) => {
	const relay = net.connect(socket);
	const end = () => { client.destroy(); relay.destroy(); };
	for (const s of [client, relay]) { s.on("error", end); s.on("close", end); }
	client.pipe(relay);
	relay.pipe(client);
});
server.listen(Number(port), "127.0.0.1", () => {
	if (standalone) return;
	const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
	child.on("error", () => process.exit(127));
	// Killed by a signal: exit as a shell does, 128 + its number, so the trial's record still says which signal ended the command.
	child.on("exit", (code, signal) => { server.close(); process.exit(code ?? (signal === null ? 1 : 128 + (require("node:os").constants.signals[signal] ?? 0))); });
});
`;

/** sha256 of the bridge's source, as mounted. */
export const endoModelBridgeSha256V0 = (): string => sha256HexV0(ENDO_MODEL_BRIDGE_SOURCE_V0);

/**
 * The two mounts a model-connected sandbox adds: the relay's socket (alone) and the bridge, which is written into `privateDirectory` (the
 * controller's, never the agent's) and mounted read-only by digest.
 */
export function modelRelayMountsV0(
	relay: Pick<EndoModelRelayV0, "socketPath">,
	privateDirectory: string,
): EndoSandboxMountV0[] {
	const bridge = join(privateDirectory, "bridge.cjs");
	writeFileSync(bridge, ENDO_MODEL_BRIDGE_SOURCE_V0, { mode: 0o444, flag: "wx" });
	return [
		{ target: ENDO_MODEL_SOCKET_TARGET_V0, kind: "socket", role: "model-relay", source: relay.socketPath },
		{
			target: ENDO_MODEL_BRIDGE_TARGET_V0,
			kind: "ro-file",
			role: "model-bridge",
			source: bridge,
			sha256: endoModelBridgeSha256V0(),
		},
	];
}

/** The command line that runs `command` behind the bridge, so that 127.0.0.1:`port` inside the sandbox reaches the relay. */
export function bridgedCommandV0(node: string, port: number, command: readonly string[]): string[] {
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		throw new TypeError("the bridge's port must be 1024..65535");
	return [node, ENDO_MODEL_BRIDGE_TARGET_V0, String(port), ENDO_MODEL_SOCKET_TARGET_V0, "--", ...command];
}
