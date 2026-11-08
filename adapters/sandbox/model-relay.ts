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
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoCaptureLogV0 } from "../openai-proxy/capture-log.ts";
import {
	type EndoRecordingProxyV0,
	GOVERNED_REQUEST_MAX_BYTES_V0,
	startEndoRecordingProxyV0,
} from "../openai-proxy/record.ts";
import type { EndoSandboxMountV0 } from "./bubblewrap.ts";

/** One route a relay admits: a method and an exact request target (no query string, no prefix match). */
export interface EndoModelRouteV0 {
	readonly method: string;
	readonly path: string;
}

/**
 * The routes Pi 1.5.0 uses against an `openai-completions` provider, measured from Pi itself inside the sandbox
 * (tests/protected-model-relay.test.ts records every request a real Pi made). Nothing else is needed for a run.
 */
export const ENDO_PI_MODEL_ROUTES_V0: readonly EndoModelRouteV0[] = Object.freeze([
	Object.freeze({ method: "POST", path: "/v1/chat/completions" }),
]);

export interface EndoModelRelayPolicyV0 {
	readonly routes: readonly EndoModelRouteV0[];
	/** Every admitted request's JSON body names exactly this model: the agent cannot select, or make a router load, another. */
	readonly model: string;
	/** The largest admitted request body. At most the governed proxy's own bound. */
	readonly maxRequestBytes: number;
	/** All bytes through the relay, both ways, for the whole session: past it, connections are dropped. */
	readonly maxTransferredBytes: number;
	/** Connections open at once through the socket. */
	readonly maxConnections: number;
}

export type EndoModelRefusalReasonV0 = "route" | "size" | "body" | "model";

/** The judge, pure: whether one complete request may reach the model server. */
export function admitModelRequestV0(
	policy: EndoModelRelayPolicyV0,
	request: { readonly method: string; readonly path: string; readonly body: Uint8Array },
): { admitted: true } | { admitted: false; reason: EndoModelRefusalReasonV0 } {
	if (!policy.routes.some((route) => route.method === request.method && route.path === request.path))
		return { admitted: false, reason: "route" };
	if (request.body.length > policy.maxRequestBytes) return { admitted: false, reason: "size" };
	let body: unknown;
	try {
		body = JSON.parse(Buffer.from(request.body).toString("utf8"));
	} catch {
		return { admitted: false, reason: "body" };
	}
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { admitted: false, reason: "body" };
	// The relay forwards the original bytes. With a key repeated (`{"model":"x","model":"y"}`), JSON.parse keeps the last value, but
	// another parser may keep the first (RFC 8259 §4): a request whose top-level keys repeat is refused (Codex, #134).
	if (topLevelKeysRepeat(Buffer.from(request.body).toString("utf8"))) return { admitted: false, reason: "body" };
	if ((body as { model?: unknown }).model !== policy.model) return { admitted: false, reason: "model" };
	return { admitted: true };
}

/**
 * Whether a JSON object's top-level keys repeat, comparing keys after their escapes are decoded (`"model"` and `"mod\u0065l"` are the
 * same key). The text is already known to parse as an object.
 */
function topLevelKeysRepeat(text: string): boolean {
	const seen = new Set<string>();
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			const literal = text.slice(i, j + 1);
			if (depth === 1) {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k] as string)) k++;
				if (text[k] === ":") {
					const key = JSON.parse(literal) as string;
					if (seen.has(key)) return true;
					seen.add(key);
				}
			}
			i = j;
		} else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth--;
	}
	return false;
}

/** A policy's identity: the digest of its canonical JSON. A record names the policy by it. */
export function modelRelayPolicyDigestV0(policy: EndoModelRelayPolicyV0): string {
	return sha256HexV0(canonicalEndoJsonV0(policyJson(policy)));
}

const policyJson = (policy: EndoModelRelayPolicyV0) => ({
	routes: [...policy.routes]
		.map((route) => ({ method: route.method, path: route.path }))
		// By UTF-16 code units, never the locale: a digest must not depend on where it is computed (Codex, #134).
		.sort((a, b) => {
			const x = `${a.method} ${a.path}`;
			const y = `${b.method} ${b.path}`;
			return x < y ? -1 : x > y ? 1 : 0;
		}),
	model: policy.model,
	maxRequestBytes: policy.maxRequestBytes,
	maxTransferredBytes: policy.maxTransferredBytes,
	maxConnections: policy.maxConnections,
});

/** A deep, frozen copy of a policy: only its declared fields, so nothing the caller holds is shared with the running relay. */
function snapshotPolicy(policy: EndoModelRelayPolicyV0): EndoModelRelayPolicyV0 {
	return Object.freeze({
		routes: Object.freeze(policy.routes.map((route) => Object.freeze({ method: route.method, path: route.path }))),
		model: policy.model,
		maxRequestBytes: policy.maxRequestBytes,
		maxTransferredBytes: policy.maxTransferredBytes,
		maxConnections: policy.maxConnections,
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
	] as const)
		if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} must be 1..${max}`);
}

export interface EndoModelRelayV0 {
	/** The host path of the socket: bind-mount it (and nothing else of its directory) into the sandbox. */
	readonly socketPath: string;
	readonly policy: EndoModelRelayPolicyV0;
	readonly policyDigest: string;
	/**
	 * Requests refused before reaching the model server, by reason. `unjudged`: refused by the governed proxy before the judge saw them,
	 * because they were not one complete request with a declared body length (a GET or DELETE without a body, CONNECT, an unparseable
	 * stream). `connections`: connections refused at the connection bound.
	 */
	refusals(): Readonly<Record<EndoModelRefusalReasonV0 | "unjudged" | "connections", number>>;
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
	const refused: Record<EndoModelRefusalReasonV0 | "unjudged" | "connections", number> = {
		route: 0,
		size: 0,
		body: 0,
		model: 0,
		unjudged: 0,
		connections: 0,
	};
	let admitted = 0;
	let judged = 0;
	const proxy: EndoRecordingProxyV0 = await startEndoRecordingProxyV0({
		upstream: options.upstream,
		log: options.log,
		maxTransferredBytes: policy.maxTransferredBytes,
		admitRequest: (request) => {
			judged += 1;
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
	const server: Server = createServer((client) => {
		if (clients.size >= policy.maxConnections) {
			refused.connections += 1;
			client.destroy();
			return;
		}
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
if (!/^[0-9]{1,5}$/.test(port ?? "") || separator !== "--" || command.length === 0) process.exit(64);
const server = net.createServer((client) => {
	const relay = net.connect(socket);
	const end = () => { client.destroy(); relay.destroy(); };
	for (const s of [client, relay]) { s.on("error", end); s.on("close", end); }
	client.pipe(relay);
	relay.pipe(client);
});
server.listen(Number(port), "127.0.0.1", () => {
	const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
	child.on("error", () => process.exit(127));
	child.on("exit", (code, signal) => { server.close(); process.exit(code ?? (signal === null ? 1 : 128)); });
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
