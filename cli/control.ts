/**
 * The local control endpoint (`endo.control.v0`): how `endo steer …` reaches the intervention desk of a session that
 * `endo harness attach --control` keeps open. It is a Unix socket at `<root>/control/endpoint.sock`, inside a
 * directory only the owner can enter (0700); the socket itself is 0600. The attached process owns the store, so every
 * step is written there by it, never by the client.
 *
 * Messages are one JSON object per line; each gets one JSON line back, `{ id, ok, result }` or `{ id, ok: false,
 * error }`:
 *
 *   { type: "propose",   operation: "steer"|"queue"|"stop", message?, nonce?, observationId?, interpretationId? }
 *   { type: "authorize", proposalId, confirmDigest }      the local operator confirms the exact proposal digest
 *   { type: "apply",     proposalId, authorizationId }
 *   { type: "status" }
 *   { type: "finish" }                                     record consumption and consequences now
 *   { type: "close" }                                      finish, then end the attached session
 *
 * An unknown type or a malformed line is answered with an error and recorded (`control.message-refused`); it changes
 * nothing else. The server refuses to start, and the client refuses to connect, when the directory or the socket is
 * not owned by this user or is open to anyone else.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { PiInterventionDeskV0 } from "../adapters/pi/intervention.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { localOperatorAuthorityV0 } from "../runtime/contracts/intervention.ts";

export const ENDO_CONTROL_PROTOCOL_V0 = "endo.control.v0";
const MAX_LINE = 64 * 1024;

export function endoControlDirectoryV0(root: string): string {
	return join(root, "control");
}

export function endoControlSocketV0(root: string): string {
	return join(endoControlDirectoryV0(root), "endpoint.sock");
}

/** Why the control directory or socket is unsafe for this user, or null. */
export function endoControlEndpointProblemV0(root: string, options: { socket: boolean }): string | null {
	const uid = process.getuid?.();
	const dir = endoControlDirectoryV0(root);
	if (!existsSync(dir)) return `${dir} does not exist`;
	const info = lstatSync(dir);
	if (info.isSymbolicLink()) return `${dir} is a symbolic link`;
	if (!info.isDirectory()) return `${dir} is not a directory`;
	if (uid !== undefined && info.uid !== uid) return `${dir} is owned by uid ${info.uid}, not ${uid}`;
	if ((info.mode & 0o077) !== 0)
		return `${dir} is open to others (mode ${(info.mode & 0o777).toString(8)}); it must be 0700`;
	if (options.socket) {
		const socket = endoControlSocketV0(root);
		if (!existsSync(socket)) return `${socket} does not exist: no attached session serves control here`;
		const s = lstatSync(socket);
		if (!s.isSocket()) return `${socket} is not a socket`;
		if (uid !== undefined && s.uid !== uid) return `${socket} is owned by uid ${s.uid}, not ${uid}`;
		if ((s.mode & 0o077) !== 0)
			return `${socket} is open to others (mode ${(s.mode & 0o777).toString(8)}); it must be 0600`;
	}
	return null;
}

export interface EndoControlServerV0 {
	readonly path: string;
	/** Resolves when a `close` message arrives (after finishing the desk). */
	readonly closeRequested: Promise<void>;
	close(): Promise<void>;
}

type Message = Record<string, unknown>;

/** Serve the desk on the control socket. */
export async function startEndoControlServerV0(root: string, desk: PiInterventionDeskV0): Promise<EndoControlServerV0> {
	const dir = endoControlDirectoryV0(root);
	if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
	const problem = endoControlEndpointProblemV0(root, { socket: false });
	if (problem !== null) throw new TypeError(`refusing to serve control: ${problem}`);
	const path = endoControlSocketV0(root);
	if (Buffer.byteLength(path) > 100)
		throw new TypeError(`the control socket path is too long for a Unix socket: ${path}`);
	if (existsSync(path)) {
		const live = await new Promise<boolean>((done) => {
			const probe = createConnection(path);
			probe.once("connect", () => {
				probe.destroy();
				done(true);
			});
			probe.once("error", () => done(false));
		});
		if (live) throw new TypeError(`another attached session already serves control at ${path}`);
		rmSync(path, { force: true });
	}
	let requestClose: () => void = () => {};
	const closeRequested = new Promise<void>((done) => {
		requestClose = done;
	});
	// Messages are handled one at a time, in arrival order, across connections: the desk is not re-entrant.
	let queue: Promise<unknown> = Promise.resolve();
	const handle = async (message: Message): Promise<JsonValueV0> => {
		switch (message.type) {
			case "propose": {
				const operation = message.operation;
				if (operation !== "steer" && operation !== "queue" && operation !== "stop")
					throw new TypeError("operation must be steer, queue or stop");
				const proposal = desk.propose({
					operation,
					...(typeof message.message === "string" ? { message: message.message } : {}),
					...(typeof message.nonce === "string" ? { nonce: message.nonce } : {}),
					basis: {
						observationId: typeof message.observationId === "string" ? message.observationId : null,
						interpretationId: typeof message.interpretationId === "string" ? message.interpretationId : null,
					},
				});
				return proposal as unknown as JsonValueV0;
			}
			case "authorize": {
				if (typeof message.proposalId !== "string") throw new TypeError("proposalId is required");
				const confirmed = typeof message.confirmDigest === "string" ? message.confirmDigest : null;
				return desk.authorize(message.proposalId, localOperatorAuthorityV0(confirmed)) as unknown as JsonValueV0;
			}
			case "apply": {
				if (typeof message.proposalId !== "string" || typeof message.authorizationId !== "string")
					throw new TypeError("proposalId and authorizationId are required");
				return (await desk.apply(message.proposalId, message.authorizationId)) as unknown as JsonValueV0;
			}
			case "status":
				return desk.status();
			case "finish":
				desk.finish();
				return desk.status();
			case "close":
				desk.finish();
				requestClose();
				return { closing: true };
			default: {
				const type = typeof message.type === "string" ? message.type : String(message.type);
				desk.session.recordControlRefusal(type, "unknown control message type");
				throw new TypeError(`unknown control message type ${JSON.stringify(type)}`);
			}
		}
	};
	const respond = (socket: Socket, line: string) => {
		let message: Message;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				throw new TypeError("not an object");
			message = parsed as Message;
		} catch (error) {
			queue = queue.then(() => {
				desk.session.recordControlRefusal("malformed", (error as Error).message);
				socket.write(`${JSON.stringify({ id: null, ok: false, error: "malformed control message" })}\n`);
			});
			return;
		}
		queue = queue.then(async () => {
			try {
				const result = await handle(message);
				socket.write(`${JSON.stringify({ id: message.id ?? null, ok: true, result })}\n`);
			} catch (error) {
				socket.write(`${JSON.stringify({ id: message.id ?? null, ok: false, error: (error as Error).message })}\n`);
			}
		});
	};
	const server: Server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_LINE) {
				socket.end(`${JSON.stringify({ id: null, ok: false, error: "control message too long" })}\n`);
				buffer = "";
				return;
			}
			for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (line.trim() !== "") respond(socket, line);
			}
		});
	});
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(path, () => done());
	});
	chmodSync(path, 0o600);
	return {
		path,
		closeRequested,
		async close() {
			await queue.catch(() => {});
			await new Promise<void>((done) => server.close(() => done()));
			rmSync(path, { force: true });
		},
	};
}

/** Send one control message to the session attached at `root`, and return its reply. */
export async function endoControlRequestV0(
	root: string,
	message: Message,
	timeoutMs = 120_000,
): Promise<{ id: unknown; ok: boolean; result?: JsonValueV0; error?: string }> {
	const problem = endoControlEndpointProblemV0(root, { socket: true });
	if (problem !== null) throw new TypeError(`refusing to use the control endpoint: ${problem}`);
	return new Promise((done, fail) => {
		const socket = createConnection(endoControlSocketV0(root));
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			fail(new Error("the control endpoint did not answer in time"));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("error", (error) => {
			clearTimeout(timer);
			fail(error);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index === -1) return;
			clearTimeout(timer);
			socket.end();
			try {
				done(JSON.parse(buffer.slice(0, index)));
			} catch (error) {
				fail(error);
			}
		});
		socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, ...message })}\n`));
	});
}
