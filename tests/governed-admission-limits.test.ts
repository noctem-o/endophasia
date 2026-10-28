import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, createServer as createTcpServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { GOVERNED_REQUEST_MAX_BYTES_V0, startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";

const LIMIT = GOVERNED_REQUEST_MAX_BYTES_V0;
const header = (length: number, close = true) =>
	`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${length}\r\nConnection: ${close ? "close" : "keep-alive"}\r\n\r\n`;
function wireOfSize(size: number, close = true): Buffer {
	let body = size - Buffer.byteLength(header(0, close));
	for (;;) {
		const next = size - Buffer.byteLength(header(body, close));
		if (next === body) break;
		body = next;
	}
	return Buffer.concat([Buffer.from(header(body, close)), Buffer.alloc(body, 120)]);
}

async function guarded<T>(promise: Promise<T>, ms = 8000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("socket test deadline")), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function harness(
	run: (context: {
		port: number;
		host: string;
		counts: () => { upstream: number; admitted: number; refused: number };
		firstReceived: Promise<void>;
		releaseFirst: () => void;
		capture: () => Promise<string>;
	}) => Promise<void>,
	idleMs = 5000,
	holdFirst = false,
) {
	const root = mkdtempSync(join(tmpdir(), "endo-admission-limits-"));
	let upstreamCount = 0,
		admitted = 0;
	let firstReady!: () => void;
	let releaseFirst!: () => void;
	const firstReceived = new Promise<void>((resolve) => {
		firstReady = resolve;
	});
	const firstRelease = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const upstream: Server = createServer((request, response) => {
		upstreamCount += 1;
		const first = upstreamCount === 1;
		request.resume();
		request.on("end", async () => {
			if (first && holdFirst) {
				firstReady();
				await firstRelease;
			}
			response.writeHead(200, { "Content-Length": "2", "Content-Type": "text/plain" });
			response.end("ok");
		});
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const address = upstream.address();
	if (address === null || typeof address === "string") throw new Error("missing upstream address");
	const log = new EndoCaptureLogV0(root, endoDigestKeyV0(Buffer.alloc(32, 9), "admission-limit-test"), "record");
	const proxy = await startEndoRecordingProxyV0({
		upstream: `http://127.0.0.1:${address.port}`,
		log,
		maxTransferredBytes: 16 * 1024 * 1024,
		admissionIdleMs: idleMs,
		admitRequest: () => {
			admitted += 1;
			return true;
		},
	});
	try {
		await guarded(
			run({
				port: proxy.port,
				host: proxy.host,
				firstReceived,
				releaseFirst,
				capture: async () => {
					await proxy.flush();
					return JSON.stringify(readEndoCaptureEventsV0(root));
				},
				counts: () => ({ upstream: upstreamCount, admitted, refused: proxy.refusedRequests }),
			}),
		);
	} finally {
		await guarded(proxy.close());
		log.close();
		upstream.closeAllConnections();
		await guarded(new Promise<void>((resolve) => upstream.close(() => resolve())));
		rmSync(root, { recursive: true, force: true });
	}
}

async function send(
	port: number,
	host: string,
	parts: Buffer[],
	expectedResponses: number,
	disconnect = false,
	beforeRest?: Promise<void>,
) {
	const socket: Socket = connect(port, host);
	let response = "";
	try {
		await guarded(
			new Promise<void>((resolve, reject) => {
				socket.once("connect", () => {
					void (async () => {
						if (parts[0]) socket.write(parts[0]);
						if (beforeRest) await beforeRest;
						for (const part of parts.slice(1)) socket.write(part);
						if (disconnect) socket.end();
					})().catch(reject);
				});
				socket.on("data", (data) => {
					response += data.toString("latin1");
					if (expectedResponses > 0 && (response.match(/HTTP\/1\.1 200/g)?.length ?? 0) >= expectedResponses)
						resolve();
				});
				socket.on("error", (error: NodeJS.ErrnoException) => {
					if (["ECONNRESET", "EPIPE"].includes(error.code ?? "")) resolve();
					else reject(error);
				});
				socket.on("close", () => resolve());
			}),
		);
		return response;
	} finally {
		socket.destroy();
	}
}

describe("governed complete-request buffer limit", () => {
	it.each([1000, LIMIT - 1, LIMIT])(
		"forwards an admitted %i-byte wire request",
		async (size) => {
			await harness(async ({ port, host, counts }) => {
				const request = wireOfSize(size);
				expect(request.length).toBe(size);
				expect(await send(port, host, [request], 1)).toContain("HTTP/1.1 200");
				expect(counts()).toEqual({ upstream: 1, admitted: 1, refused: 0 });
			});
		},
		15000,
	);
	it.each([LIMIT + 1, 5 * 1024 * 1024])(
		"promptly refuses a %i-byte request without a hop",
		async (size) => {
			await harness(async ({ port, host, counts }) => {
				await send(port, host, [wireOfSize(size)], 0);
				expect(counts()).toEqual({ upstream: 0, admitted: 0, refused: 1 });
			});
		},
		15000,
	);
	it("accepts incrementally received fixed-length requests", async () => {
		await harness(async ({ port, host, counts }) => {
			const request = wireOfSize(32 * 1024);
			const chunks = [request.subarray(0, 17), request.subarray(17, 80), request.subarray(80)];
			expect(await send(port, host, chunks, 1)).toContain("HTTP/1.1 200");
			expect(counts()).toEqual({ upstream: 1, admitted: 1, refused: 0 });
		});
	}, 15000);
	it("refuses unsupported chunked framing before opening a hop", async () => {
		await harness(async ({ port, host, counts }) => {
			await send(
				port,
				host,
				[
					Buffer.from(
						"POST / HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n",
					),
				],
				0,
			);
			expect(counts()).toEqual({ upstream: 0, admitted: 0, refused: 1 });
		});
	}, 15000);
	it("closes an incomplete request after its idle deadline", async () => {
		await harness(async ({ port, host, counts }) => {
			await send(port, host, [Buffer.from(`${header(100)}x`)], 0);
			expect(counts()).toEqual({ upstream: 0, admitted: 0, refused: 1 });
		}, 100);
	}, 15000);
	it("drains a valid pipeline after queued bytes trigger ordinary backpressure", async () => {
		await harness(
			async ({ port, host, counts, firstReceived, releaseFirst }) => {
				let paused!: () => void;
				let queueing = false;
				const clientPaused = new Promise<void>((resolve) => {
					paused = resolve;
				});
				const originalPause = Socket.prototype.pause;
				const spy = vi.spyOn(Socket.prototype, "pause").mockImplementation(function (this: Socket) {
					if (queueing && this.localPort === port) paused();
					return originalPause.call(this);
				});
				try {
					// Five queued requests behind the blocked first hop exceed 4 MiB.
					const requests = Array.from({ length: 6 }, (_, i) => wireOfSize(900 * 1024, i === 5));
					const ready = firstReceived.then(() => {
						queueing = true;
					});
					const response = send(port, host, requests, 6, false, ready);
					await guarded(ready);
					await guarded(clientPaused);
					releaseFirst();
					expect((await response).match(/HTTP\/1\.1 200/g)).toHaveLength(6);
					expect(counts()).toEqual({ upstream: 6, admitted: 6, refused: 0 });
				} finally {
					releaseFirst();
					spy.mockRestore();
				}
			},
			5000,
			true,
		);
	}, 15000);
	it("refuses an oversized declaration and extra bytes in the same read", async () => {
		await harness(async ({ port, host, counts }) => {
			const data = Buffer.concat([
				Buffer.from(header(5 * 1024 * 1024)),
				Buffer.from("private-extra"),
				wireOfSize(1000),
			]);
			await send(port, host, [data], 0);
			expect(counts()).toEqual({ upstream: 0, admitted: 0, refused: 1 });
		});
	}, 15000);
	it("does not copy a malformed private header into refusal evidence", async () => {
		await harness(async ({ port, host, counts, capture }) => {
			const secret = "PRIVATE_PROMPT_OR_CREDENTIAL_SENTINEL";
			await send(port, host, [Buffer.from(`POST / HTTP/1.1\r\nHost: localhost\r\n${secret}\r\n\r\n`)], 0);
			expect(counts()).toEqual({ upstream: 0, admitted: 0, refused: 1 });
			expect(await capture()).not.toContain(secret);
		});
	}, 15000);
	it("does not forward a client disconnected while buffering", async () => {
		await harness(async ({ port, host, counts }) => {
			await send(port, host, [Buffer.from(`${header(100)}x`)], 0, true);
			expect(counts().upstream).toBe(0);
			expect(counts().admitted).toBe(0);
		});
	}, 15000);
});

describe("governed response framing", () => {
	it.each([
		["duplicate content length", "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nok"],
		[
			"ambiguous framing",
			"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
		],
		["invalid chunk size", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2z\r\nok\r\n0\r\n\r\n"],
		["truncated body", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nok"],
	])(
		"does not release a %s response",
		async (_name, raw) => {
			const root = mkdtempSync(join(tmpdir(), "endo-response-framing-"));
			let upstreamCount = 0,
				responsesAdmitted = 0;
			const upstream = createTcpServer((socket) => {
				upstreamCount += 1;
				socket.once("data", () => socket.end(raw));
			});
			await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("missing upstream address");
			const log = new EndoCaptureLogV0(
				root,
				endoDigestKeyV0(Buffer.alloc(32, 9), "response-framing-test"),
				"record",
			);
			const proxy = await startEndoRecordingProxyV0({
				upstream: `http://127.0.0.1:${address.port}`,
				log,
				maxTransferredBytes: 16 * 1024 * 1024,
				admitRequest: () => true,
				admitResponse: () => {
					responsesAdmitted += 1;
					return true;
				},
			});
			try {
				const response = await send(proxy.port, proxy.host, [wireOfSize(1000)], 0);
				expect(response).toBe("");
				expect(upstreamCount).toBe(1);
				expect(responsesAdmitted).toBe(0);
			} finally {
				await guarded(proxy.close());
				log.close();
				await guarded(new Promise<void>((resolve) => upstream.close(() => resolve())));
				rmSync(root, { recursive: true, force: true });
			}
		},
		15000,
	);
});
