// The recording proxy's transport topology: the client's keep-alive connection is not the upstream's connection.
//
// One client connection may carry many exchanges; each is relayed over a fresh upstream connection (a hop) made for it.
// These tests drive a raw TCP client against a raw TCP upstream that records every connection it accepts and every byte
// each one received, so "this request reached that connection, once" is observable. The upstream here is hostile in the
// way llama.cpp is: it answers, says nothing about closing, and closes.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";

const KEY = endoDigestKeyV0(randomBytes(32), "installation");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (condition: () => boolean, what: string, ms = 5000) => {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(5);
	}
};

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "endo-transport-test-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const request = (path: string, body = "{}", extra = "") =>
	Buffer.from(
		`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-Odd-Case:  kept\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
	);
const response = (body: string, headers = "") =>
	`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

/** One accepted upstream connection and what it saw. */
interface Seen {
	index: number;
	acceptedAt: number;
	received: Buffer[];
	/** Requests complete on this connection (by Content-Length). */
	requests: Buffer[];
	closedAt: number | null;
	socket: Socket;
}
type Answer = (seen: Seen, request: Buffer, respond: (bytes: string, end?: boolean) => void) => void;

/** A raw HTTP/1.1 upstream, one handler call per complete request, remembering every connection. */
async function upstreamOf(answer: Answer): Promise<{ port: number; seen: Seen[] }> {
	const seen: Seen[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		const mine: Seen = {
			index: seen.length,
			acceptedAt: performance.now(),
			received: [],
			requests: [],
			closedAt: null,
			socket,
		};
		seen.push(mine);
		socket.on("error", () => {});
		socket.on("close", () => {
			sockets.delete(socket);
			mine.closedAt = performance.now();
		});
		let buffer = Buffer.alloc(0);
		socket.on("data", (data) => {
			mine.received.push(data);
			buffer = Buffer.concat([buffer, data]);
			for (;;) {
				const end = buffer.indexOf("\r\n\r\n");
				if (end === -1) return;
				const length = Number(
					/\r\ncontent-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("latin1"))?.[1] ?? "0",
				);
				if (buffer.length < end + 4 + length) return;
				const whole = Buffer.from(buffer.subarray(0, end + 4 + length));
				buffer = buffer.subarray(end + 4 + length);
				mine.requests.push(whole);
				answer(mine, whole, (bytes, close = false) => {
					if (socket.destroyed) return;
					if (close) socket.end(bytes);
					else socket.write(bytes);
				});
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	);
	return { port: (server.address() as { port: number }).port, seen };
}

async function proxyTo(port: number, scheme = "http", host = "127.0.0.1", ca?: string, hopDrainMs?: number) {
	const store = scratch();
	const log = new EndoCaptureLogV0(store, KEY, "record", { async: true });
	const proxy = await startEndoRecordingProxyV0({
		upstream: `${scheme}://${host}:${port}`,
		log,
		...(ca === undefined ? {} : { ca }),
		...(hopDrainMs === undefined ? {} : { hopDrainMs }),
	});
	let closed = false;
	const finish = async () => {
		if (closed) return;
		closed = true;
		await proxy.close();
		log.close();
	};
	cleanup.push(finish);
	return { store, log, proxy, finish };
}

const ended = (store: string) =>
	readEndoCaptureEventsV0(store)
		.filter((event) => event.kind === "capture.exchange-ended")
		.map((event) => event.payload as Record<string, unknown>);
const recordedRequests = (store: string) =>
	readEndoCaptureEventsV0(store)
		.filter((event) => event.kind === "capture.request")
		.map((event) => event.payload as Record<string, unknown>);

/** A raw client: collects bytes, and lets a test react synchronously inside the data event. */
function client(port: number) {
	const parts: Buffer[] = [];
	const socket = connect({ host: "127.0.0.1", port });
	let closed = false;
	let ended = false;
	socket.on("error", () => {});
	socket.on("close", () => {
		closed = true;
	});
	socket.on("end", () => {
		ended = true;
	});
	socket.on("data", (part) => parts.push(part));
	cleanup.push(() => {
		socket.destroy();
	});
	return {
		socket,
		get bytes() {
			return Buffer.concat(parts);
		},
		get closed() {
			return closed;
		},
		get ended() {
			return ended;
		},
	};
}

describe("transport closeout: the client's keep-alive connection does not own an upstream connection", () => {
	it("a request sent the instant a response arrives reaches a usable upstream connection, exactly once", async () => {
		// Connection 1 answers A with a complete, apparently reusable response and closes at once; it never answers again.
		const a = request("/v1/a", '{"n":"a"}');
		const b = request("/v1/b", '{"n":"b"}');
		const respondA = response("answer-a");
		const respondB = response("answer-b");
		const upstream = await upstreamOf((seen, req, respond) => {
			if (seen.index === 0) respond(respondA, true);
			else respond(req.equals(b) ? respondB : response("wrong"));
		});
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		let sentB = false;
		c.socket.on("data", () => {
			// The moment the whole of A's response is here, synchronously, B goes out on the same client connection.
			if (!sentB && c.bytes.length >= Buffer.byteLength(respondA)) {
				sentB = true;
				c.socket.write(b);
			}
		});
		c.socket.write(a);
		await until(() => c.bytes.length >= Buffer.byteLength(respondA) + Buffer.byteLength(respondB), "both responses");
		// Both responses, byte for byte, on one client connection that is still open.
		expect(c.bytes.toString("latin1")).toBe(respondA + respondB);
		expect(c.closed).toBe(false);
		// Two upstream connections: A on the first (and only A), B on the second (and only B). Nothing else was written.
		expect(upstream.seen).toHaveLength(2);
		expect(Buffer.concat(upstream.seen[0]!.received).equals(a)).toBe(true);
		expect(Buffer.concat(upstream.seen[1]!.received).equals(b)).toBe(true);
		c.socket.end();
		await until(() => c.closed, "client close");
		await proxy.flush();
		await finish();
		const results = ended(store);
		expect(results.map((entry) => entry.outcome)).toEqual(["complete", "complete"]);
		expect(results.every((entry) => !("error" in entry) && !("transport" in entry))).toBe(true);
		expect(recordedRequests(store).map((entry) => entry.path)).toEqual(["/v1/a", "/v1/b"]);
	});

	it("holds when recording is slow or burns CPU: keep-alive correctness does not depend on when recording runs", async () => {
		const a = request("/v1/a");
		const b = request("/v1/b");
		const upstream = await upstreamOf((seen, _req, respond) => respond(response(`r${seen.index}`), seen.index === 0));
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
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		let sent = false;
		c.socket.on("data", () => {
			if (!sent && c.bytes.toString("latin1").endsWith("r0")) {
				sent = true;
				c.socket.write(b);
			}
		});
		c.socket.write(a);
		await until(() => c.bytes.toString("latin1").endsWith("r1"), "both responses");
		expect(upstream.seen.map((entry) => entry.requests.length)).toEqual([1, 1]);
		await proxy.flush();
		expect(ended(store).map((entry) => entry.outcome)).toEqual(["complete", "complete"]);
	});

	it("repeated, so no timing makes B land on the closed connection", async () => {
		for (let round = 0; round < 25; round += 1) {
			const a = request("/v1/a");
			const b = request("/v1/b");
			const upstream = await upstreamOf((seen, _req, respond) =>
				respond(response(`r${seen.index}`), seen.index === 0),
			);
			const { proxy, finish } = await proxyTo(upstream.port);
			const c = client(proxy.port);
			await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
			let sent = false;
			c.socket.on("data", () => {
				if (!sent && c.bytes.toString("latin1").endsWith("r0")) {
					sent = true;
					c.socket.write(b);
				}
			});
			c.socket.write(a);
			await until(() => c.bytes.toString("latin1").endsWith("r1"), `round ${round}`);
			expect(upstream.seen.map((entry) => entry.requests.length)).toEqual([1, 1]);
			expect(upstream.seen[0]!.received).toHaveLength(1);
			await finish();
		}
	});
});

describe("transport closeout: several requests on one client connection", () => {
	it("pipelined requests are relayed one at a time over their own connections, byte for byte, answered in order", async () => {
		const requests = ["/v1/a", "/v1/b", "/v1/c"].map((path) => request(path, JSON.stringify({ path })));
		let answeredA = 0;
		const upstream = await upstreamOf((seen, _req, respond) => {
			// A is the slow one: if the proxy forwarded B or C early they would be answered first.
			const reply = response(`answer-${seen.index}`);
			if (seen.index === 0)
				setTimeout(() => {
					answeredA = performance.now();
					respond(reply);
				}, 80);
			else respond(reply);
		});
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(Buffer.concat(requests)); // all three in one write
		const expected = [0, 1, 2].map((index) => response(`answer-${index}`)).join("");
		await until(() => c.bytes.length >= expected.length, "three responses");
		expect(c.bytes.toString("latin1")).toBe(expected);
		expect(upstream.seen).toHaveLength(3);
		for (const [index, entry] of upstream.seen.entries()) {
			expect(Buffer.concat(entry.received).equals(requests[index]!)).toBe(true);
		}
		// The later requests were held, not sent ahead: their connections opened after A's response was written.
		expect(upstream.seen[1]!.acceptedAt).toBeGreaterThanOrEqual(answeredA);
		expect(upstream.seen[2]!.acceptedAt).toBeGreaterThanOrEqual(upstream.seen[1]!.acceptedAt);
		c.socket.end();
		await until(() => c.closed, "close");
		await proxy.flush();
		await finish();
		expect(ended(store).map((entry) => entry.outcome)).toEqual(["complete", "complete", "complete"]);
		expect(recordedRequests(store).map((entry) => entry.path)).toEqual(["/v1/a", "/v1/b", "/v1/c"]);
	});

	it("requests split at arbitrary byte boundaries across reads are still one request per connection", async () => {
		const requests = [request("/v1/a", '{"x":1}'), request("/v1/b", '{"y":2}')];
		const upstream = await upstreamOf((seen, _req, respond) => respond(response(`r${seen.index}`)));
		const { proxy } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		const stream = Buffer.concat(requests);
		// Seven bytes at a time, so every head, body and request boundary is cut somewhere.
		for (let at = 0; at < stream.length; at += 7) {
			c.socket.write(stream.subarray(at, at + 7));
			await new Promise((resolve) => setImmediate(resolve));
		}
		await until(() => c.bytes.toString("latin1").endsWith("r1"), "both responses");
		expect(c.bytes.toString("latin1")).toBe(response("r0") + response("r1"));
		expect(upstream.seen.map((entry) => Buffer.concat(entry.received))).toEqual(requests);
	});

	it("holds queued request bytes within a bound: the client is paused, nothing is dropped, order is kept", async () => {
		const count = 40;
		const body = "z".repeat(1024 * 1024);
		const all = Array.from({ length: count }, (_, index) => request(`/v1/${index}`, body));
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const upstream = await upstreamOf((seen, _req, respond) => {
			if (seen.index === 0) void gate.then(() => respond(response("0")));
			else respond(response(String(seen.index)));
		});
		const { proxy } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		for (const one of all) c.socket.write(one);
		await sleep(300);
		// 40 MiB offered while the first exchange is stalled: the proxy has not swallowed it all into memory.
		expect(c.socket.writableLength).toBeGreaterThan(8 * 1024 * 1024);
		expect(upstream.seen).toHaveLength(1);
		release();
		const expected = Array.from({ length: count }, (_, index) => response(String(index))).join("");
		await until(() => c.bytes.length >= expected.length, "all responses", 30_000);
		expect(c.bytes.toString("latin1")).toBe(expected);
		expect(upstream.seen.map((entry) => entry.requests.length)).toEqual(Array(count).fill(1));
		for (const [index, entry] of upstream.seen.entries()) expect(entry.requests[0]!.equals(all[index]!)).toBe(true);
		await proxy.flush();
	}, 60_000);
});

describe("transport closeout: when the client connection does end", () => {
	it("a response that says Connection: close ends the client connection after every byte, and nothing queued behind it is forwarded", async () => {
		const upstream = await upstreamOf((_seen, _req, respond) =>
			respond(response("last", "Connection: close\r\n"), true),
		);
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(Buffer.concat([request("/v1/a"), request("/v1/b")]));
		await until(() => c.closed, "client close");
		expect(c.bytes.toString("latin1")).toBe(response("last", "Connection: close\r\n"));
		expect(upstream.seen).toHaveLength(1);
		await proxy.flush();
		await finish();
		const results = ended(store);
		expect(results.map((entry) => entry.outcome)).toEqual(["complete", "upstream-error"]);
		expect(results[1]!.transport).toEqual({ phase: "not-forwarded", forwarded: false });
	});

	it("a response framed by the close is delivered whole, then the close is the client's too", async () => {
		const body = "x".repeat(64 * 1024);
		const upstream = await upstreamOf((_seen, _req, respond) =>
			respond(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n${body}`, true),
		);
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/a"));
		await until(() => c.ended, "client end");
		expect(c.bytes.length).toBe(Buffer.byteLength(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n${body}`));
		await proxy.flush();
		await finish();
		expect(ended(store).map((entry) => entry.outcome)).toEqual(["complete"]);
	});

	it("an upstream that closes without answering is an upstream failure, the request is not sent again, and the failure says so", async () => {
		const upstream = await upstreamOf((seen) => seen.socket.destroy());
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/a"));
		await until(() => c.closed, "client close");
		await sleep(50);
		expect(upstream.seen).toHaveLength(1);
		expect(upstream.seen[0]!.requests).toHaveLength(1);
		await proxy.flush();
		await finish();
		const [result] = ended(store);
		expect(result).toMatchObject({
			outcome: "upstream-error",
			status: null,
			transport: { phase: "awaiting-response", forwarded: true },
		});
	});

	it("an upstream that cannot be connected to is a failure that says nothing was forwarded", async () => {
		const { store, proxy, finish } = await proxyTo(9);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/a"));
		await until(() => c.closed, "client close");
		await proxy.flush();
		await finish();
		expect(ended(store)[0]).toMatchObject({
			outcome: "upstream-error",
			status: null,
			transport: { phase: "connect", forwarded: false },
		});
	});

	it("an upstream cut mid-response is an upstream failure with the bytes relayed so far", async () => {
		const upstream = await upstreamOf((seen, _req, respond) => {
			respond("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
			setTimeout(() => seen.socket.destroy(), 20);
		});
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/a"));
		await until(() => c.closed, "client close");
		expect(c.bytes.toString("latin1")).toBe("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
		await proxy.flush();
		await finish();
		expect(ended(store)[0]).toMatchObject({
			outcome: "upstream-error",
			status: 200,
			transport: { phase: "mid-response", forwarded: true },
		});
	});

	it("a client that goes away drops its upstream hop and every request still queued, and the proxy closes cleanly", async () => {
		const upstream = await upstreamOf(() => {}); // never answers
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(Buffer.concat([request("/v1/a"), request("/v1/b")]));
		await until(() => upstream.seen.length === 1 && upstream.seen[0]!.requests.length === 1, "A at the upstream");
		expect(proxy.open).toBe(2);
		c.socket.destroy();
		await until(() => upstream.seen[0]!.closedAt !== null, "the hop to be dropped");
		await until(() => proxy.open === 0, "exchanges to end");
		expect(upstream.seen).toHaveLength(1); // B was never forwarded
		await proxy.flush();
		await finish();
		expect(ended(store).map((entry) => entry.outcome)).toEqual(["client-disconnected", "client-disconnected"]);
	});

	it("close() drops hops in flight and leaves no connection behind", async () => {
		const upstream = await upstreamOf(() => {});
		const { proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/a"));
		await until(() => upstream.seen.length === 1 && upstream.seen[0]!.requests.length === 1, "A at the upstream");
		await finish();
		await until(() => upstream.seen[0]!.closedAt !== null && c.closed, "everything closed");
	});
});

describe("transport closeout: https upstream", () => {
	it("each hop is its own TLS session with the upstream's name as SNI, and bytes are untouched", async () => {
		const dir = scratch();
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"2",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost",
				"-keyout",
				join(dir, "key.pem"),
				"-out",
				join(dir, "cert.pem"),
			],
			{ stdio: "ignore" },
		);
		const cert = readFileSync(join(dir, "cert.pem"), "utf8");
		const names: (string | null)[] = [];
		let sessions = 0;
		const received: Buffer[] = [];
		const server = createTlsServer(
			{
				key: readFileSync(join(dir, "key.pem")),
				cert,
				SNICallback: (name, done) => {
					names.push(name);
					done(null, undefined);
				},
			},
			(socket) => {
				sessions += 1;
				socket.on("error", () => {});
				socket.on("data", (data) => {
					received.push(data);
					socket.end(response(`tls-${sessions}`));
				});
			},
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const port = (server.address() as { port: number }).port;
		const { store, proxy, finish } = await proxyTo(port, "https", "localhost", cert);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		const a = request("/v1/a");
		const b = request("/v1/b");
		c.socket.write(a);
		await until(() => c.bytes.toString("latin1").endsWith("tls-1"), "first");
		c.socket.write(b);
		await until(() => c.bytes.toString("latin1").endsWith("tls-2"), "second");
		expect(sessions).toBe(2);
		expect(names).toEqual(["localhost", "localhost"]);
		expect(received.map((part) => part.toString("latin1"))).toEqual([a.toString("latin1"), b.toString("latin1")]);
		await proxy.flush();
		await finish();
		expect(ended(store).map((entry) => entry.outcome)).toEqual(["complete", "complete"]);
	});
});

describe("transport closeout: what is not HTTP/1.1 is still relayed untouched", () => {
	/** An upstream that is no HTTP server: it answers every read with a marker, and keeps the connection open. */
	async function rawTcpUpstream(reply: (read: number) => string | null) {
		const reads: Buffer[] = [];
		const sockets = new Set<Socket>();
		const server: Server = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			socket.on("data", (data) => {
				reads.push(data);
				const out = reply(reads.length);
				if (out !== null) socket.write(out);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(
			() =>
				new Promise<void>((resolve) => {
					for (const socket of sockets) socket.destroy();
					server.close(() => resolve());
				}),
		);
		return { port: (server.address() as { port: number }).port, reads };
	}
	const unparsed = (store: string) =>
		readEndoCaptureEventsV0(store).filter((event) => event.kind === "capture.unparsed").length;

	it("bytes that are not an HTTP request reach the upstream and the upstream's answer reaches the client", async () => {
		const upstream = await rawTcpUpstream((read) => `ANSWER-${read}`);
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write("\x16\x03\x01 not http at all\r\n\r\n");
		await until(() => c.bytes.toString("latin1") === "ANSWER-1", "the first answer");
		c.socket.write("more");
		await until(() => c.bytes.toString("latin1") === "ANSWER-1ANSWER-2", "the second answer");
		expect(Buffer.concat(upstream.reads).toString("latin1")).toBe("\x16\x03\x01 not http at all\r\n\r\nmore");
		await proxy.flush();
		await finish();
		expect(unparsed(store)).toBeGreaterThan(0);
	});

	it("a line-oriented client that waits for the upstream before finishing its first line is not held back", async () => {
		const upstream = await rawTcpUpstream((read) => `ANSWER-${read}`);
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		// No CRLFCRLF, and not a request line: nothing here will ever complete an HTTP head.
		c.socket.write("HELLO there\n");
		await until(() => c.bytes.toString("latin1") === "ANSWER-1", "an answer to a prefix that is not HTTP");
		c.socket.write("\x00\x00\x00\x05");
		await until(() => c.bytes.toString("latin1") === "ANSWER-1ANSWER-2", "the second answer");
		await proxy.flush();
		await finish();
		expect(unparsed(store)).toBeGreaterThan(0);
	});

	it("a request head split across reads is still waited for (the 7-byte test covers every cut)", async () => {
		const upstream = await upstreamOf((_s, _r, respond) => respond(response("ok")));
		const { proxy } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		for (const part of ["PO", "ST /v1/x HT", "TP/1.1\r\nHost: h\r\nContent-Le", "ngth: 0\r\n\r\n"]) {
			c.socket.write(part);
			await sleep(10);
		}
		await until(() => c.bytes.toString("latin1") === response("ok"), "the answer");
	});

	it("a request whose body turns out malformed after its head: the upstream's bytes, before and after, all reach the client", async () => {
		// The upstream answers the head at once (a complete response), then says more as the rest arrives.
		const upstream = await rawTcpUpstream((read) => (read === 1 ? response("early") : `TAIL-${read}`));
		const { store, proxy, finish } = await proxyTo(upstream.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write("POST /v1/x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n");
		await until(() => c.bytes.toString("latin1") === response("early"), "the early response");
		c.socket.write("zz not a chunk size\r\n");
		await until(() => c.bytes.toString("latin1") === `${response("early")}TAIL-2`, "bytes after the parse failure");
		await proxy.flush();
		await finish();
		expect(unparsed(store)).toBeGreaterThan(0);
	});

	it("a Connection: close answered before the request body has arrived still ends the connection when it has", async () => {
		// This upstream replies as soon as it sees the head, before the body.
		const early = await rawTcpUpstream(() => response("early", "Connection: close\r\n"));
		const { proxy, finish } = await proxyTo(early.port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write("POST /v1/x HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\n");
		await until(() => c.bytes.length > 0, "the early response");
		expect(c.closed).toBe(false);
		c.socket.write("body");
		await until(() => c.closed, "the connection to end");
		expect(c.bytes.toString("latin1")).toBe(response("early", "Connection: close\r\n"));
		await finish();
	});
});

describe("transport closeout: edges of the hop's lifetime", () => {
	async function plainUpstream(onConnection: (socket: Socket) => void) {
		const sockets = new Set<Socket>();
		const server: Server = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			onConnection(socket);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(
			() =>
				new Promise<void>((resolve) => {
					for (const socket of sockets) socket.destroy();
					server.close(() => resolve());
				}),
		);
		return (server.address() as { port: number }).port;
	}
	const closes = (store: string) =>
		readEndoCaptureEventsV0(store)
			.filter((event) => event.kind === "capture.connection-closed")
			.map((event) => event.payload as Record<string, unknown>);

	it("an accepted protocol switch (101) leaves the client's later bytes on the same hop", async () => {
		const received: string[] = [];
		const port = await plainUpstream((socket) => {
			let switched = false;
			socket.on("data", (data) => {
				if (!switched) {
					switched = true;
					socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nS1");
				} else {
					received.push(data.toString("latin1"));
					socket.write(`E:${data.toString("latin1")}`);
				}
			});
		});
		const { store, proxy, finish } = await proxyTo(port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write("GET /v1/realtime HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		await until(() => c.bytes.toString("latin1").endsWith("S1"), "the 101 and its first bytes");
		c.socket.write("frame-1");
		await until(() => c.bytes.toString("latin1").endsWith("E:frame-1"), "the echo");
		expect(received).toEqual(["frame-1"]);
		await proxy.flush();
		await finish();
		expect(ended(store).map((entry) => entry.outcome)).toEqual(["complete"]);
	});

	it("an upstream reset is recorded as the upstream's doing, not the client's", async () => {
		const port = await plainUpstream((socket) => {
			socket.on("data", () => {
				socket.write("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\npart");
				setTimeout(() => socket.resetAndDestroy(), 20);
			});
		});
		const { store, proxy, finish } = await proxyTo(port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/a"));
		await until(() => c.closed, "client close");
		await proxy.flush();
		await finish();
		expect(ended(store)[0]).toMatchObject({ outcome: "upstream-error" });
		expect(closes(store)).toEqual([expect.objectContaining({ by: "upstream" })]);
	});

	it("a response that arrives before the request body is read does not cost the upstream any of that body", async () => {
		const body = "q".repeat(8 * 1024 * 1024);
		const big = request("/v1/big", body);
		let total = 0;
		const port = await plainUpstream((socket) => {
			let answered = false;
			socket.on("data", (data) => {
				total += data.length;
				if (answered) return;
				answered = true;
				socket.write(response("early"));
				// Stop reading: the rest of the body sits in the proxy's socket buffers until this resumes.
				socket.pause();
				setTimeout(() => socket.resume(), 300);
			});
		});
		const { proxy, finish } = await proxyTo(port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(big);
		await until(() => total === big.length, "the whole request at the upstream", 20_000);
		expect(c.bytes.toString("latin1")).toBe(response("early"));
		// The client was not left paused: its next request goes through.
		c.socket.write(request("/v1/next"));
		await until(
			() => c.bytes.toString("latin1").endsWith("early") && c.bytes.length > Buffer.byteLength(response("early")),
			"the next answer",
			10_000,
		);
		await finish();
	}, 40_000);

	it("an exchange answered before its upload finishes is recorded request first, so a cassette can replay it", async () => {
		const port = await plainUpstream((socket) => {
			let answered = false;
			socket.on("data", () => {
				if (answered) return;
				answered = true;
				socket.write(response("early"));
			});
		});
		const { store, proxy, finish } = await proxyTo(port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write("POST /v1/x HTTP/1.1\r\nHost: h\r\nContent-Length: 4\r\n\r\n");
		await until(() => c.bytes.length > 0, "the early response");
		await proxy.flush();
		c.socket.write("body");
		await sleep(50);
		await proxy.flush();
		await finish();
		const kindsInOrder = readEndoCaptureEventsV0(store)
			.filter((event) => event.kind === "capture.request" || event.kind === "capture.exchange-ended")
			.map((event) => event.kind);
		expect(kindsInOrder).toEqual(["capture.request", "capture.exchange-ended"]);
		const cassette = loadEndoCassetteV0(store, KEY);
		expect(cassette.exchanges[0]!.truncated).toBeNull();
		expect(cassette.exchanges[0]!.response).not.toBeNull();
	});

	it("an upstream that answers and then stops reading a large upload does not hold the connection forever", async () => {
		const port = await plainUpstream((socket) => {
			let answered = false;
			socket.on("data", () => {
				if (answered) return;
				answered = true;
				socket.write(response("early"));
				socket.pause(); // never reads again, never closes
			});
		});
		const { proxy, finish } = await proxyTo(port, "http", "127.0.0.1", undefined, 150);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write(request("/v1/big", "q".repeat(64 * 1024 * 1024)));
		await until(() => c.closed, "the connection to be ended", 10_000);
		await finish();
	}, 20_000);

	it("a reset on a tunnelled hop reaches the client as a reset, not an orderly end", async () => {
		const port = await plainUpstream((socket) => {
			let switched = false;
			socket.on("data", () => {
				if (!switched) {
					switched = true;
					socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
				} else socket.resetAndDestroy();
			});
		});
		const { store, proxy, finish } = await proxyTo(port);
		const c = client(proxy.port);
		await new Promise<void>((resolve) => c.socket.once("connect", () => resolve()));
		c.socket.write("GET /v1/realtime HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
		await until(() => c.bytes.length > 0, "the 101");
		c.socket.write("frame");
		await until(() => c.closed, "client close");
		expect(c.ended).toBe(false);
		await proxy.flush();
		await finish();
		expect(closes(store)).toEqual([expect.objectContaining({ by: "upstream" })]);
	});
});
