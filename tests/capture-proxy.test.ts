// The recording proxy and the cassette server (adapters/openai-proxy/), against a fake upstream: self-contained, no Pi,
// no model, no network beyond loopback, no keys but scratch ones.
//
// The upstream is a raw TCP server that writes hand-made HTTP responses, so the exact bytes it sent are known and the
// client's bytes can be compared with them. Hostile cases: byte-exactness both ways, a cassette miss, a truncated
// cassette, recorded 429 and 500 responses replayed faithfully, a client disconnect mid-stream, a duplicated request,
// Authorization never persisted, non-loopback binds refused, an upstream that drops mid-response, and a cassette from
// another digest domain.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import {
	EndoCassetteDomainErrorV0,
	endoRequestDivergenceV0,
	loadEndoCassetteV0,
	startEndoCassetteServerV0,
} from "../adapters/openai-proxy/cassette.ts";
import { endoRequestDigestV0, isLoopbackAddressV0 } from "../adapters/openai-proxy/http.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { EndoAsyncDurableQueueV0 } from "../storage/async-append.ts";

const KEY = endoDigestKeyV0(randomBytes(32), "installation");

/** One request from a client in its own process: its own clock's time to the last byte and to the close. */
async function timedClient(port: number): Promise<{ lastData: number; end: number }> {
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./fixtures/capture/timed-client.mjs", import.meta.url)), String(port)],
		{
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const line = await new Promise<string>((resolve) =>
		child.stdout.once("data", (data: Buffer) => resolve(String(data))),
	);
	return JSON.parse(line) as { lastData: number; end: number };
}

/** An async durable queue whose every operation first waits `ms` (a slow disk, off the event loop). */
class SlowQueue extends EndoAsyncDurableQueueV0 {
	readonly #ms: number;
	constructor(ms: number) {
		super();
		this.#ms = ms;
	}
	protected override beforeWrite(): Promise<void> {
		return new Promise((done) => setTimeout(done, this.#ms));
	}
}
const OTHER_KEY = endoDigestKeyV0(randomBytes(32), "installation");
const SECRET = `sk-endo-test-${randomBytes(12).toString("hex")}`;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "endo-capture-test-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What the raw upstream received for one request. */
interface Received {
	head: string;
	body: Buffer;
}

/** A scripted response: the exact head bytes and the body pieces, each written after `gapMs`. */
interface Script {
	head: string;
	pieces: string[];
	gapMs?: number;
	/** Drop the connection after this many pieces instead of finishing. */
	dropAfter?: number;
	/** End the connection after the response (as a `Connection: close` server does). */
	closeAfter?: boolean;
}

/** A raw HTTP/1.1 upstream: parses requests by Content-Length, answers each from `scripts` in order. */
async function rawUpstream(scripts: Script[]): Promise<{ port: number; received: Received[]; sent: string[] }> {
	const received: Received[] = [];
	const sent: string[] = [];
	let next = 0;
	const sockets = new Set<Socket>();
	const server: NetServer = createNetServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		// A peer that vanishes (a proxy killed mid-exchange) resets the connection: expected, not a test failure.
		socket.on("error", () => {});
		let buffer = Buffer.alloc(0);
		// Requests on one connection are answered one at a time, in order, as an HTTP/1.1 server does.
		let chain: Promise<void> = Promise.resolve();
		socket.on("data", (data) => {
			buffer = Buffer.concat([buffer, data]);
			chain = chain.then(answer);
		});
		const answer = async () => {
			for (;;) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end === -1) return;
				const head = buffer.subarray(0, end).toString("latin1");
				const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? "0");
				if (buffer.length < end + 4 + length) return;
				const body = buffer.subarray(end + 4, end + 4 + length);
				buffer = buffer.subarray(end + 4 + length);
				received.push({ head, body: Buffer.from(body) });
				// A request that reaches a connection this upstream already ended is never answered (as a real server).
				if (socket.writableEnded || socket.destroyed) return;
				const script = scripts[Math.min(next, scripts.length - 1)]!;
				next += 1;
				socket.write(script.head);
				let written = script.head;
				for (const [index, piece] of script.pieces.entries()) {
					await sleep(script.gapMs ?? 15);
					if (socket.destroyed) return;
					if (script.dropAfter !== undefined && index === script.dropAfter) {
						socket.destroy();
						sent.push(written);
						return;
					}
					if (socket.writableEnded) return;
					socket.write(piece);
					written += piece;
				}
				sent.push(written);
				if (script.closeAfter) socket.end();
			}
		};
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	);
	return { port: (server.address() as { port: number }).port, received, sent };
}

/** A chunked SSE response head and body pieces, as an OpenAI-compatible server streams them. */
function sse(lines: string[], extraHead = ""): Script {
	const pieces = lines.map((line) => {
		const data = `data: ${line}\n\n`;
		return `${Buffer.byteLength(data).toString(16)}\r\n${data}\r\n`;
	});
	pieces.push("0\r\n\r\n");
	return {
		head: `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Upstream-Case: KeepMe\r\n${extraHead}Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n`,
		pieces,
	};
}

function fixed(status: string, headers: string, body: string): Script {
	return {
		head: `HTTP/1.1 ${status}\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n`,
		pieces: [body],
		gapMs: 1,
	};
}

/** What a client saw: status, raw headers, body chunks as read. */
interface ClientResult {
	status: number;
	rawHeaders: string[];
	body: Buffer;
	reads: number;
	error: string | null;
}

/** POST through `port` with exact headers (no Host or Connection added by Node). Optionally abort after N reads. */
function post(
	port: number,
	path: string,
	body: string,
	options: { headers?: [string, string][]; abortAfterReads?: number } = {},
): Promise<ClientResult> {
	const bytes = Buffer.from(body);
	const headers: [string, string][] = options.headers ?? [
		["Host", `127.0.0.1:${port}`],
		["Content-Type", "application/json"],
		["Authorization", `Bearer ${SECRET}`],
		["X-Mixed-Case", "Value With  Spaces"],
		["Content-Length", String(bytes.length)],
	];
	return new Promise((resolve) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: "POST",
				path,
				headers: headers.flat() as unknown as Record<string, string>,
				setHost: false,
				agent: false,
			},
			(response) => {
				const parts: Buffer[] = [];
				let reads = 0;
				response.on("data", (part: Buffer) => {
					parts.push(part);
					reads += 1;
					if (options.abortAfterReads !== undefined && reads >= options.abortAfterReads) request.destroy();
				});
				const done = (error: string | null) =>
					resolve({
						status: response.statusCode ?? 0,
						rawHeaders: response.rawHeaders,
						body: Buffer.concat(parts),
						reads,
						error,
					});
				response.on("end", () => done(null));
				response.on("error", (error) => done(error.message));
				response.on("close", () => done("closed"));
			},
		);
		request.on("error", (error) =>
			resolve({ status: 0, rawHeaders: [], body: Buffer.alloc(0), reads: 0, error: error.message }),
		);
		request.end(bytes);
	});
}

/** Write exact request bytes on a raw TCP connection; collect every byte until the server ends the connection. */
function rawExchange(port: number, bytes: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		const socket = connect({ host: "127.0.0.1", port }, () => socket.write(bytes));
		socket.on("data", (part: Buffer) => parts.push(part));
		socket.on("end", () => resolve(Buffer.concat(parts)));
		socket.on("error", reject);
	});
}

async function recording(scripts: Script[]) {
	const upstream = await rawUpstream(scripts);
	const store = scratch();
	const log = new EndoCaptureLogV0(store, KEY, "record", { async: true });
	const proxy = await startEndoRecordingProxyV0({ upstream: `http://127.0.0.1:${upstream.port}`, log });
	cleanup.push(async () => {
		await proxy.close();
		await proxy.flush();
		log.close();
	});
	return { upstream, store, log, proxy };
}

async function replaying(
	store: string,
	options: { timing?: "as-recorded" | "immediate"; holdMs?: number; key?: typeof KEY } = {},
) {
	const key = options.key ?? KEY;
	const cassette = loadEndoCassetteV0(store, key);
	const replayStore = scratch();
	const log = new EndoCaptureLogV0(replayStore, key, "replay");
	const server = await startEndoCassetteServerV0({
		cassette,
		key,
		storeRoot: store,
		timing: options.timing ?? "immediate",
		log,
		...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
	});
	cleanup.push(async () => {
		await server.close();
		log.close();
	});
	return { cassette, server, log, replayStore };
}

const kinds = (store: string, kind: string) =>
	readEndoCaptureEventsV0(store)
		.filter((event) => event.kind === kind)
		.map((event) => event.payload as Record<string, unknown>);

const BODY = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true });

describe("the recording proxy: pass-through, byte for byte", () => {
	it("relays the client's bytes and the upstream's bytes unaltered, both ways, and records each read with its offset", async () => {
		const script = sse(['{"a":1}', '{"b":"two"}', '{"c":[3]}', "[DONE]"], "Set-Cookie: upstream=secret-cookie\r\n");
		script.closeAfter = true;
		const { upstream, store, proxy, log } = await recording([script]);
		// Odd but legal bytes a re-serializing proxy would change: header case, order, repeated spaces, no Connection.
		const request = Buffer.from(
			`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\ncontent-type: application/json\r\nAuthorization: Bearer ${SECRET}\r\nX-Mixed-Case:   Value With  Spaces\r\nx-stainless-retry-count: 0\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`,
		);
		const received = await rawExchange(proxy.port, request);
		// Upstream side: exactly the client's bytes.
		const atUpstream = upstream.received[0]!;
		expect(
			Buffer.concat([Buffer.from(`${atUpstream.head}\r\n\r\n`, "latin1"), atUpstream.body]).equals(request),
		).toBe(true);
		// Client side: exactly the upstream's bytes, transfer framing included.
		expect(received.equals(Buffer.from(upstream.sent[0]!, "latin1"))).toBe(true);
		await sleep(20);
		await proxy.flush();
		log.close();
		const [ended] = kinds(store, "capture.exchange-ended");
		expect(ended).toMatchObject({ exchange: 1, outcome: "complete", status: 200, wireBytes: received.length });
		const chunks = ended!.chunks as { offsetMs: number; bytes: number }[];
		// One read per upstream write: the head, then each piece.
		expect(chunks.map((chunk) => chunk.bytes)).toEqual(
			[script.head, ...script.pieces].map((part) => Buffer.byteLength(part)),
		);
		for (let index = 1; index < chunks.length; index += 1)
			expect(chunks[index]!.offsetMs).toBeGreaterThanOrEqual(chunks[index - 1]!.offsetMs);
		// Canonical events carry keyed digests and lengths only, never a body.
		const [recorded] = kinds(store, "capture.request");
		expect(recorded!.requestDigest).toEqual({
			...endoRequestDigestV0(KEY, "POST", "/v1/chat/completions", Buffer.from(BODY)),
		});
		expect(JSON.stringify(readEndoCaptureEventsV0(store))).not.toContain("messages");
		expect(kinds(store, "capture.connection-closed")[0]).toMatchObject({ by: "upstream", afterExchange: 1 });
	});

	it("an upstream that closes right after a large response: every byte still reaches a slow client (no data dropped on close)", async () => {
		// Regression: the relay used to destroy the client socket as soon as the upstream ended, dropping response bytes
		// still queued for a client that had not read them yet. Pi saw a cut stream ("Connection error.") while the
		// capture log recorded a complete exchange. Here the upstream writes ~4 MiB in one go and closes at once.
		const big = "x".repeat(4 * 1024 * 1024);
		const script: Script = {
			head: `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${big.length}\r\n\r\n`,
			pieces: [big],
			gapMs: 1,
			closeAfter: true,
		};
		const { store, proxy, log } = await recording([script]);
		const request = Buffer.from(`POST /v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}`);
		const received = await new Promise<Buffer>((resolve, reject) => {
			const parts: Buffer[] = [];
			const socket = connect({ host: "127.0.0.1", port: proxy.port }, () => socket.write(request));
			// A slow reader: pause after the first read so the proxy has to queue the rest.
			socket.once("data", (part: Buffer) => {
				parts.push(part);
				socket.pause();
				setTimeout(() => {
					socket.on("data", (more: Buffer) => parts.push(more));
					socket.resume();
				}, 300);
			});
			socket.on("end", () => resolve(Buffer.concat(parts)));
			socket.on("error", reject);
		});
		expect(received.length).toBe(Buffer.byteLength(script.head) + big.length);
		await sleep(50);
		await proxy.flush();
		log.close();
		expect(kinds(store, "capture.exchange-ended")[0]).toMatchObject({ outcome: "complete" });
	});

	it("disk writes never delay the byte path: with a slow disk, the client still sees the upstream's close at once", async () => {
		// Regression: the proxy wrote each exchange to disk (fsync'd blob and event writes) before relaying the upstream's
		// close, so a keep-alive client that reused the connection in that window sent its next request into a closing
		// connection: Pi reported "Connection error." on 13 of 20 trials of one task. Here every disk write takes 40 ms.
		const upstream = await rawUpstream([
			{ ...fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'), closeAfter: true },
		]);
		const store = scratch();
		const log = new EndoCaptureLogV0(store, KEY, "record", { queue: new SlowQueue(40) });
		const proxy = await startEndoRecordingProxyV0({ upstream: `http://127.0.0.1:${upstream.port}`, log });
		cleanup.push(async () => {
			await proxy.close();
			log.close();
		});
		// Measured in a separate process: an in-process client would see its own close late whenever this event loop is
		// busy, even though the close already reached the kernel.
		const timing = await timedClient(proxy.port);
		expect(timing.end - timing.lastData).toBeLessThan(20);
		await proxy.flush();
		expect(kinds(store, "capture.exchange-ended")[0]).toMatchObject({ exchange: 1, outcome: "complete" });
	});

	it("recording CPU work never delays the close either: the close is relayed first, then the exchange is recorded", async () => {
		// Regression: with fsync off the event loop, the recording's own CPU work (hashing, validating, encoding a large
		// exchange) still ran right after the response completed, when the upstream's close arrives, and delayed relaying
		// it (9 of 20 live trials). Here every recorded event burns 30 ms of CPU on the event loop.
		const upstream = await rawUpstream([
			{ ...fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'), closeAfter: true },
		]);
		const store = scratch();
		const log = new EndoCaptureLogV0(store, KEY, "record", { async: true });
		const original = log.record.bind(log);
		log.record = (...args: Parameters<typeof log.record>) => {
			const until = performance.now() + 30;
			while (performance.now() < until);
			return original(...args);
		};
		const proxy = await startEndoRecordingProxyV0({ upstream: `http://127.0.0.1:${upstream.port}`, log });
		cleanup.push(async () => {
			await proxy.close();
			log.close();
		});
		// Measured in a separate process: an in-process client would see its own close late whenever this event loop is
		// busy, even though the close already reached the kernel.
		const timing = await timedClient(proxy.port);
		expect(timing.end - timing.lastData).toBeLessThan(20);
		await proxy.flush();
		expect(kinds(store, "capture.exchange-ended")[0]).toMatchObject({ exchange: 1, outcome: "complete" });
	});

	it("each exchange is on disk as soon as it completes, while other exchanges are still open (no idle wait, no flush)", async () => {
		const slow = sse(Array.from({ length: 20 }, (_, index) => `{"n":${index}}`));
		slow.gapMs = 60;
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'),
			slow,
		]);
		// Two connections: the first exchange completes; the second keeps streaming for over a second.
		await post(proxy.port, "/v1/chat/completions", BODY, {
			headers: [
				["Host", "x"],
				["Content-Length", String(Buffer.byteLength(BODY))],
				["Connection", "close"],
			],
		});
		const streaming = post(proxy.port, "/v1/chat/completions", BODY.replace("hi", "again"));
		let onDisk: Record<string, unknown>[] = [];
		for (let attempt = 0; attempt < 50 && onDisk.length === 0; attempt += 1) {
			await sleep(20);
			onDisk = kinds(store, "capture.exchange-ended");
		}
		expect(proxy.open).toBe(1);
		expect(onDisk).toEqual([expect.objectContaining({ exchange: 1, outcome: "complete" })]);
		await streaming;
		await proxy.flush();
		log.close();
	});

	it("a proxy killed mid-exchange: the request is on disk, and reopening the log marks the exchange interrupted", async () => {
		const slow = sse(Array.from({ length: 40 }, (_, index) => `{"n":${index}}`));
		slow.gapMs = 50;
		const upstream = await rawUpstream([slow]);
		const store = scratch();
		const keyHex = randomBytes(32).toString("hex");
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(new URL("./fixtures/capture/proxy-child.ts", import.meta.url)),
				store,
				`http://127.0.0.1:${upstream.port}`,
				keyHex,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		cleanup.push(() => {
			child.kill("SIGKILL");
		});
		const port = await new Promise<number>((resolve) =>
			child.stdout.once("data", (data: Buffer) => resolve(Number(String(data).trim()))),
		);
		const request = post(port, "/v1/chat/completions", BODY);
		await sleep(400);
		child.kill("SIGKILL");
		await new Promise((done) => child.on("exit", done));
		const result = await request;
		expect(result.error).not.toBeNull();
		const key = endoDigestKeyV0(Buffer.from(keyHex, "hex"), "installation");
		expect(kinds(store, "capture.request")).toEqual([expect.objectContaining({ exchange: 1 })]);
		expect(kinds(store, "capture.exchange-ended")).toEqual([]);
		const reopened = new EndoCaptureLogV0(store, key, "record");
		reopened.close();
		expect(kinds(store, "capture.exchange-interrupted")).toEqual([expect.objectContaining({ exchange: 1 })]);
		// Reopening again adds no second marker; a cassette treats the exchange as truncated.
		new EndoCaptureLogV0(store, key, "record").close();
		expect(kinds(store, "capture.exchange-interrupted").length).toBe(1);
		const cassette = loadEndoCassetteV0(store, key);
		expect(cassette.exchanges[0]!.truncated).toMatch(/killed or crashed/);
	});

	it("a request sent after the upstream closed the connection is recorded as a failed exchange, never lost", async () => {
		const script = fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}');
		script.closeAfter = true;
		const { store, proxy, log } = await recording([script]);
		await new Promise<void>((resolve) => {
			const socket = connect({ host: "127.0.0.1", port: proxy.port }, () =>
				socket.write(`POST /v1/x HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}`),
			);
			socket.on("data", () => {
				// Reuse the connection the moment the response arrives, as a keep-alive client does.
				if (!socket.writableEnded)
					socket.write(`POST /v1/y HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}`);
			});
			socket.on("close", () => resolve());
			socket.on("error", () => {});
		});
		await sleep(50);
		await proxy.flush();
		await proxy.flush();
		log.close();
		const ended = kinds(store, "capture.exchange-ended");
		expect(ended[0]).toMatchObject({ exchange: 1, outcome: "complete" });
		if (ended.length > 1) expect(ended[1]).toMatchObject({ exchange: 2, outcome: "upstream-error" });
		expect(kinds(store, "capture.request").length).toBe(ended.length);
	});

	it("keeps a client's pipelined keep-alive requests apart: one exchange each, in order", async () => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"n":1}'),
			fixed("200 OK", "Content-Type: application/json\r\n", '{"n":2}'),
		]);
		expect((await post(proxy.port, "/v1/chat/completions", BODY)).status).toBe(200);
		expect((await post(proxy.port, "/v1/models", "")).status).toBe(200);
		await proxy.flush();
		log.close();
		expect(kinds(store, "capture.request").map((request) => request.path)).toEqual([
			"/v1/chat/completions",
			"/v1/models",
		]);
		expect(kinds(store, "capture.exchange-ended").map((ended) => ended.outcome)).toEqual(["complete", "complete"]);
	});

	it("never persists an Authorization value (or any secret header) anywhere under the store", async () => {
		const { store, proxy, log } = await recording([
			sse(['{"a":1}', "[DONE]"], "Set-Cookie: upstream=secret-cookie\r\n"),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const [request] = kinds(store, "capture.request");
		expect(request!.headers).toContainEqual({ name: "Authorization", redacted: true });
		const [response] = kinds(store, "capture.response");
		expect(response!.headers).toContainEqual({ name: "Set-Cookie", redacted: true });
		const files = (dir: string): string[] =>
			readdirSync(dir).flatMap((name) =>
				statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)],
			);
		for (const file of files(store)) {
			const content = readFileSync(file);
			expect(content.includes(SECRET), file).toBe(false);
			expect(content.includes("secret-cookie"), file).toBe(false);
		}
	});

	it("records an identical request seen again as its own exchange, attempt 2", async () => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":true}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		expect(kinds(store, "capture.request").map((request) => [request.exchange, request.attempt])).toEqual([
			[1, 1],
			[2, 2],
		]);
	});

	it("records a client disconnect mid-stream with the chunks delivered, and stops the upstream request", async () => {
		const many = sse(Array.from({ length: 12 }, (_, index) => `{"n":${index}}`));
		many.gapMs = 40;
		const { store, proxy, log } = await recording([many]);
		const result = await post(proxy.port, "/v1/chat/completions", BODY, { abortAfterReads: 3 });
		expect(result.reads).toBe(3);
		await sleep(100);
		await proxy.flush();
		log.close();
		const [ended] = kinds(store, "capture.exchange-ended");
		expect(ended).toMatchObject({ outcome: "client-disconnected", status: 200 });
		expect(ended!.afterChunks).toBeGreaterThanOrEqual(3);
		expect((ended!.chunks as unknown[]).length).toBeLessThan(13);
	});

	it("records an upstream that drops mid-response as upstream-error, and drops the client the same way", async () => {
		const dropping = sse(['{"a":1}', '{"b":2}', '{"c":3}', "[DONE]"]);
		dropping.dropAfter = 2;
		const { store, proxy, log } = await recording([dropping]);
		const result = await post(proxy.port, "/v1/chat/completions", BODY);
		expect(result.error).not.toBeNull();
		await proxy.flush();
		log.close();
		const [ended] = kinds(store, "capture.exchange-ended");
		expect(ended).toMatchObject({ outcome: "upstream-error", status: 200 });
		// The head and two pieces were relayed before the drop.
		expect((ended!.chunks as unknown[]).length).toBe(3);
	});

	it("records an upstream that cannot be reached as upstream-error with no response, inventing nothing", async () => {
		const store = scratch();
		const log = new EndoCaptureLogV0(store, KEY, "record");
		const closed = await rawUpstream([]);
		const port = closed.port;
		await new Promise((resolve) => setTimeout(resolve, 1));
		const proxy = await startEndoRecordingProxyV0({ upstream: "http://127.0.0.1:9", log });
		cleanup.push(async () => {
			await proxy.close();
			log.close();
		});
		expect(port).toBeGreaterThan(0);
		const result = await post(proxy.port, "/v1/chat/completions", BODY);
		expect(result.status).toBe(0);
		await proxy.flush();
		log.close();
		expect(kinds(store, "capture.exchange-ended")[0]).toMatchObject({
			outcome: "upstream-error",
			status: null,
			chunks: [],
		});
	});

	it.each(["0.0.0.0", "::", "192.168.1.10", "localhost", "example.com"])("refuses to bind %s", async (host) => {
		const store = scratch();
		const log = new EndoCaptureLogV0(store, KEY, "record");
		cleanup.push(() => log.close());
		await expect(startEndoRecordingProxyV0({ upstream: "http://127.0.0.1:8080", host, log })).rejects.toThrow(
			/loopback/,
		);
		expect(isLoopbackAddressV0(host)).toBe(false);
	});

	it("accepts only loopback literals, and refuses an upstream with a path or credentials", async () => {
		expect(["127.0.0.1", "127.1.2.3", "::1"].every(isLoopbackAddressV0)).toBe(true);
		const log = new EndoCaptureLogV0(scratch(), KEY, "record");
		cleanup.push(() => log.close());
		await expect(startEndoRecordingProxyV0({ upstream: "http://127.0.0.1:8080/v1", log })).rejects.toThrow(/origin/);
		await expect(startEndoRecordingProxyV0({ upstream: "http://u:p@127.0.0.1:8080", log })).rejects.toThrow(
			/credentials/,
		);
	});
});

describe("where a replayed request first differs (endoRequestDivergenceV0)", () => {
	const request = (messages: unknown[], extra: Record<string, unknown> = {}) =>
		Buffer.from(JSON.stringify({ model: "m", messages, ...extra }));
	const system = { role: "system", content: "s" };
	const user = { role: "user", content: "u" };
	const call = {
		role: "assistant",
		content: null,
		tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }],
	};
	it("a differing tool result is the environment", () => {
		expect(
			endoRequestDivergenceV0(
				request([system, user, call, { role: "tool", content: "07:06" }]),
				request([system, user, call, { role: "tool", content: "07:07" }]),
			),
		).toEqual({ kind: "environment", message: 4, role: "tool" });
	});
	it("a differing assistant, user or system message, or other fields, is control flow", () => {
		expect(
			endoRequestDivergenceV0(request([system, user]), request([{ role: "system", content: "other" }, user])),
		).toEqual({
			kind: "control-flow",
			message: 1,
			role: "system",
		});
		expect(
			endoRequestDivergenceV0(request([system, user, call]), request([system, user, { ...call, content: "x" }])),
		).toMatchObject({
			kind: "control-flow",
			role: "assistant",
		});
		expect(endoRequestDivergenceV0(request([system]), request([system], { temperature: 0 }))).toEqual({
			kind: "control-flow",
			message: null,
			role: null,
		});
	});
	it("key order is not a difference", () => {
		expect(
			endoRequestDivergenceV0(
				Buffer.from('{"messages":[{"role":"user","content":"u"}],"model":"m"}'),
				Buffer.from('{"model":"m","messages":[{"content":"u","role":"user"}],"x":1}'),
			),
		).toEqual({
			kind: "control-flow",
			message: null,
			role: null,
		});
	});
});

describe("the cassette server: recorded order, recorded bytes, explicit misses", () => {
	it("replays a recorded stream with the original chunk boundaries, status and headers", async () => {
		const script = sse(['{"a":1}', '{"b":"two"}', '{"c":[3]}', "[DONE]"]);
		const { store, proxy, log } = await recording([script]);
		const original = await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server, log: replayLog, replayStore } = await replaying(store);
		const replayed = await post(server.port, "/v1/chat/completions", BODY);
		expect(replayed.status).toBe(original.status);
		expect(replayed.rawHeaders).toEqual(original.rawHeaders);
		expect(replayed.body.equals(original.body)).toBe(true);
		replayLog.close();
		expect(kinds(replayStore, "capture.served")[0]).toMatchObject({
			exchange: 1,
			cassetteExchange: 1,
			outcome: "complete",
			chunksDelivered: 6,
		});
		expect(kinds(replayStore, "capture.started")[0]).toMatchObject({ role: "replay", timing: "immediate" });
	});

	it.each([
		[
			"429",
			fixed(
				"429 Too Many Requests",
				"Content-Type: application/json\r\nRetry-After: 7\r\n",
				'{"error":{"message":"rate limited"}}',
			),
		],
		["500", fixed("500 Internal Server Error", "Content-Type: application/json\r\n", '{"error":{"message":"boom"}}')],
	])("replays a recorded %s response faithfully", async (_status, script) => {
		const { store, proxy, log } = await recording([script]);
		const original = await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server } = await replaying(store);
		const replayed = await post(server.port, "/v1/chat/completions", BODY);
		expect(replayed.status).toBe(original.status);
		expect(replayed.rawHeaders).toEqual(original.rawHeaders);
		expect(replayed.body.toString()).toBe(original.body.toString());
	});

	it("an unexpected request is an explicit miss and a failed request; the position does not advance", async () => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server, log: replayLog, replayStore } = await replaying(store);
		const wrong = await post(server.port, "/v1/chat/completions", BODY.replace("hi", "hello"));
		expect(wrong.status).toBe(599);
		expect(wrong.rawHeaders).toContain("x-endo-cassette");
		expect(JSON.parse(wrong.body.toString()).error.reason).toBe("unexpected-request");
		const right = await post(server.port, "/v1/chat/completions", BODY);
		expect(right.status).toBe(200);
		expect(right.body.toString()).toBe('{"ok":1}');
		replayLog.close();
		expect(kinds(replayStore, "capture.cassette-miss")).toEqual([
			expect.objectContaining({ exchange: 1, reason: "unexpected-request" }),
		]);
	});

	it("matches the canonical body: key order and whitespace do not make a miss", async () => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server } = await replaying(store);
		const reordered = JSON.stringify(
			{ stream: true, messages: [{ content: "hi", role: "user" }], model: "m" },
			null,
			2,
		);
		expect((await post(server.port, "/v1/chat/completions", reordered)).status).toBe(200);
	});

	it("a duplicated request replays in recorded order, and one more than recorded is cassette-exhausted", async () => {
		const { store, proxy, log } = await recording([
			fixed("500 Internal Server Error", "Content-Type: application/json\r\n", '{"error":"first"}'),
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":"second"}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server, log: replayLog, replayStore } = await replaying(store);
		expect((await post(server.port, "/v1/chat/completions", BODY)).body.toString()).toBe('{"error":"first"}');
		expect((await post(server.port, "/v1/chat/completions", BODY)).body.toString()).toBe('{"ok":"second"}');
		const extra = await post(server.port, "/v1/chat/completions", BODY);
		expect(extra.status).toBe(599);
		replayLog.close();
		expect(kinds(replayStore, "capture.cassette-miss").map((miss) => miss.reason)).toEqual(["cassette-exhausted"]);
	});

	it("a truncated cassette (a body missing from the blob store) is a truncated-exchange miss, never served", async () => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const [ended] = kinds(store, "capture.exchange-ended");
		const value = (ended!.wire as { digest: { value: string } }).digest.value;
		unlinkSync(join(store, "capture", "blobs", KEY.keyId, value));
		const { cassette, server, log: replayLog, replayStore } = await replaying(store);
		expect(cassette.exchanges[0]!.truncated).toMatch(/missing/);
		const result = await post(server.port, "/v1/chat/completions", BODY);
		expect(result.status).toBe(599);
		replayLog.close();
		expect(kinds(replayStore, "capture.cassette-miss")[0]).toMatchObject({ reason: "truncated-exchange" });
	});

	it("a recorded client disconnect is served up to the same chunk, then held for this client; never completed", async () => {
		const many = sse(Array.from({ length: 12 }, (_, index) => `{"n":${index}}`));
		many.gapMs = 40;
		const { store, proxy, log } = await recording([many]);
		await post(proxy.port, "/v1/chat/completions", BODY, { abortAfterReads: 3 });
		await sleep(100);
		await proxy.flush();
		log.close();
		const recordedChunks = (kinds(store, "capture.exchange-ended")[0]!.chunks as unknown[]).length;
		// This client disconnects too: served, outcome client-disconnected.
		const first = await replaying(store, { holdMs: 2_000 });
		const result = await post(first.server.port, "/v1/chat/completions", BODY, { abortAfterReads: 1 });
		expect(result.error).not.toBeNull();
		await sleep(50);
		first.log.close();
		expect(kinds(first.replayStore, "capture.served")[0]).toMatchObject({ outcome: "client-disconnected" });
		// This client does not: the recorded chunks are served, nothing is added, and the miss is explicit.
		const second = await replaying(store, { holdMs: 200 });
		const held = await post(second.server.port, "/v1/chat/completions", BODY);
		expect(held.error).not.toBeNull();
		expect(held.body.toString()).not.toContain("[DONE]");
		second.log.close();
		expect(kinds(second.replayStore, "capture.cassette-miss")[0]).toMatchObject({ reason: "response-exhausted" });
		expect(kinds(second.replayStore, "capture.served")[0]).toMatchObject({
			outcome: "cut",
			chunksDelivered: recordedChunks,
		});
	});

	it("a recorded upstream drop is replayed as a drop at the same chunk", async () => {
		const dropping = sse(['{"a":1}', '{"b":2}', '{"c":3}', "[DONE]"]);
		dropping.dropAfter = 2;
		const { store, proxy, log } = await recording([dropping]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server, log: replayLog, replayStore } = await replaying(store);
		const result = await post(server.port, "/v1/chat/completions", BODY);
		expect(result.error).not.toBeNull();
		replayLog.close();
		expect(kinds(replayStore, "capture.served")[0]).toMatchObject({ outcome: "upstream-error", chunksDelivered: 3 });
	});

	it("as-recorded timing keeps the recorded pacing; immediate does not wait", async () => {
		// Timed on the server's own clock (capture.served offsetMs), not by comparing two client round trips: a loaded
		// runner adds stalls to every request, and the old comparison of two ~250 ms round trips failed on one.
		const slow = sse(['{"a":1}', '{"b":2}', '{"c":3}', "[DONE]"]);
		slow.gapMs = 250;
		const { store, proxy, log } = await recording([slow]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const recorded = kinds(store, "capture.exchange-ended")[0]!.chunks as { offsetMs: number }[];
		const pacing = recorded.at(-1)!.offsetMs;
		expect(pacing).toBeGreaterThanOrEqual(1000);
		const servedAfter = async (timing: "as-recorded" | "immediate"): Promise<number> => {
			const { server, log: replayLog, replayStore } = await replaying(store, { timing });
			await post(server.port, "/v1/chat/completions", BODY);
			replayLog.close();
			const served = kinds(replayStore, "capture.served")[0]!;
			expect(served).toMatchObject({ outcome: "complete", chunksDelivered: recorded.length });
			return served.offsetMs as number;
		};
		// As recorded: the server waits until each chunk's recorded offset, so it finishes no earlier than the last
		// one. Load can only lengthen this; the margin covers timers that fire a little early (CI once measured 1250.4
		// against a 1251.5 pacing), and is far below the half-pacing bound that separates this from `immediate`.
		expect(await servedAfter("as-recorded")).toBeGreaterThanOrEqual(pacing - 10);
		// Immediate: no waits at all. Allowing half the recorded pacing (about 600 ms) leaves room for runner stalls
		// while still failing if the recorded gaps were honoured.
		expect(await servedAfter("immediate")).toBeLessThan(pacing / 2);
	});

	it("pauses after a chosen chunk until resumed (the replay driver's STOP and kill points)", async () => {
		const stream = sse(['{"a":1}', '{"b":2}', '{"c":3}', "[DONE]"]);
		const { store, proxy, log } = await recording([stream]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const { server } = await replaying(store);
		const reached = server.pauseAt({ exchange: 1, chunks: 2 });
		const pending = post(server.port, "/v1/chat/completions", BODY);
		await reached;
		await sleep(50);
		server.resume();
		expect((await pending).status).toBe(200);
	});

	it("a cassette from another digest domain is refused with the reason, never matched and silently missed", async () => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		expect(() => loadEndoCassetteV0(store, OTHER_KEY)).toThrow(EndoCassetteDomainErrorV0);
		expect(() => loadEndoCassetteV0(store, OTHER_KEY)).toThrow(/different digest domains/);
		const cassette = loadEndoCassetteV0(store, KEY);
		const replayLog = new EndoCaptureLogV0(scratch(), OTHER_KEY, "replay");
		cleanup.push(() => replayLog.close());
		await expect(
			startEndoCassetteServerV0({ cassette, key: OTHER_KEY, storeRoot: store, timing: "immediate", log: replayLog }),
		).rejects.toThrow(EndoCassetteDomainErrorV0);
	});

	it.each(["0.0.0.0", "::", "10.0.0.1"])("refuses to bind %s", async (host) => {
		const { store, proxy, log } = await recording([
			fixed("200 OK", "Content-Type: application/json\r\n", '{"ok":1}'),
		]);
		await post(proxy.port, "/v1/chat/completions", BODY);
		await proxy.flush();
		log.close();
		const replayLog = new EndoCaptureLogV0(scratch(), KEY, "replay");
		cleanup.push(() => replayLog.close());
		await expect(
			startEndoCassetteServerV0({
				cassette: loadEndoCassetteV0(store, KEY),
				key: KEY,
				storeRoot: store,
				timing: "immediate",
				host,
				log: replayLog,
			}),
		).rejects.toThrow(/loopback/);
	});
});
