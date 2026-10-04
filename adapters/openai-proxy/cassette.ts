// Cassettes: a recorded capture log read back as an ordered list of exchanges, and the cassette server
// (`endo proxy replay`) that serves them.
//
// Matching is strict and in order. The n-th request the server receives must have the request digest
// (http.ts, endoRequestDigestV0) of the cassette's next exchange; it is then answered with that exchange's recorded
// response wire bytes, written with the recorded read boundaries (one write per recorded chunk). There is no search and
// no fallback: any mismatch is an explicit `capture.cassette-miss` event and a failed request (HTTP 599 with an
// `x-endo-cassette: miss` header and a JSON error naming the miss, then the connection closes), never an improvised
// response. Misses:
//   unexpected-request   the request's digest is not the next exchange's (the position does not advance)
//   cassette-exhausted   every exchange has been served
//   truncated-exchange   the next exchange was never completed in the recording (no end, a missing or tampered body,
//                        or chunks that do not add up)
//   response-exhausted   the recording's client disconnected mid-response, and this client did not by the time the
//                        recorded chunks ran out: the connection is cut, nothing is added
//
// How a served exchange ends follows the recording: `complete` leaves the connection open for the next request (or
// closes it, where the upstream closed it); `upstream-error` drops the connection where the upstream's dropped;
// `client-disconnected` serves the chunks the recorded client received and then waits for this client to disconnect.
//
// Timing is chosen explicitly and recorded: `as-recorded` waits until each chunk's recorded offset from the request's
// arrival; `immediate` writes each chunk as soon as the previous one is written.
//
// Digest domains: a cassette's request digests and blobs are keyed. The server must hold the same key (same key id) to
// match requests and read bodies. A cassette from another digest domain is refused before anything is served, with the
// reason, never matched and silently missed.

import { createServer, type Server, type Socket } from "node:net";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { isEndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../storage/blob-store.ts";
import {
	ENDO_CAPTURE_VERSION_V0,
	type EndoCapturedBytesRefV0,
	type EndoCaptureLogV0,
	endoCaptureRootV0,
	readEndoCaptureEventsV0,
} from "./capture-log.ts";
import { endoRequestDigestV0, offsetMsV0, requireLoopbackBindV0 } from "./http.ts";
import { Http1ParserV0 } from "./http1.ts";

export type EndoCassetteTimingV0 = "as-recorded" | "immediate";

export type EndoExchangeOutcomeV0 = "complete" | "client-disconnected" | "upstream-error";

/** One recorded exchange, ready to serve. */
export interface EndoCassetteExchangeV0 {
	exchange: number;
	attempt: number;
	method: string;
	path: string;
	requestDigest: EndoKeyedDigestV0;
	requestBody: EndoCapturedBytesRefV0;
	/** Null when the recording never completed this exchange; `truncated` says why. */
	response: {
		status: number | null;
		/** The kept wire bytes (a scrubbed head line is missing from them). */
		wire: EndoCapturedBytesRefV0;
		/** Write boundaries over the kept wire bytes, with the recorded offsets from the request's arrival. */
		chunks: { offsetMs: number; bytes: number }[];
		headScrubbed: string[];
		outcome: EndoExchangeOutcomeV0;
		afterChunks: number | null;
		error: string | null;
		/** The upstream closed the connection right after this exchange. */
		closedAfter: boolean;
	} | null;
	truncated: string | null;
}

/** A recorded capture log, read back. */
export interface EndoCassetteV0 {
	/** The digest domain every digest in it was made in. */
	keyId: string;
	/** Where the recording proxy listened (a replay binds the same port: Pi's configuration names it). */
	listen: string | null;
	exchanges: EndoCassetteExchangeV0[];
	/** Every event of the capture log (the driver's script and the workspace snapshot are among them). */
	events: EndoEventV0[];
}

/** Thrown when a cassette was recorded under another digest domain than the key offered to read it. */
export class EndoCassetteDomainErrorV0 extends Error {
	readonly cassetteKeyId: string;
	readonly keyId: string;
	constructor(cassetteKeyId: string, keyId: string) {
		super(
			`the cassette was recorded in digest domain ${cassetteKeyId}, but the replay holds ${keyId}: its request digests and bodies cannot be matched or read under another key (different digest domains)`,
		);
		this.name = "EndoCassetteDomainErrorV0";
		this.cassetteKeyId = cassetteKeyId;
		this.keyId = keyId;
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function bytesRef(value: unknown): EndoCapturedBytesRefV0 | null {
	const ref = record(value);
	return isEndoKeyedDigestV0(ref.digest) && typeof ref.bytes === "number"
		? { digest: ref.digest, bytes: ref.bytes }
		: null;
}

/** The digest domain of the recording proxy's events in a capture log (they must all agree); null when none. */
export function endoCaptureKeyIdV0(events: readonly EndoEventV0[]): string | null {
	const ids = new Set<string>();
	for (const event of events) {
		if (event.producer !== "capture:record") continue;
		const payload = record(event.payload);
		if (event.kind === "capture.request" && isEndoKeyedDigestV0(payload.requestDigest))
			ids.add(payload.requestDigest.keyId);
		const declared = record(payload.digestKey).keyId;
		if (event.kind === "capture.started" && typeof declared === "string") ids.add(declared);
	}
	if (ids.size > 1) throw new TypeError(`the capture log mixes digest domains: ${[...ids].sort().join(", ")}`);
	return ids.size === 0 ? null : [...ids][0]!;
}

/** Map recorded chunk boundaries over the original wire onto the kept wire (a scrubbed head is shorter). */
function keptChunks(
	chunks: { offsetMs: number; bytes: number }[],
	headBytes: number | null,
	keptHeadBytes: number,
): { offsetMs: number; bytes: number }[] {
	if (headBytes === null || headBytes === keptHeadBytes) return chunks;
	const removed = headBytes - keptHeadBytes;
	let end = 0;
	let keptEnd = 0;
	return chunks.map((chunk) => {
		end += chunk.bytes;
		const mapped = end <= headBytes ? Math.min(end, keptHeadBytes) : end - removed;
		const bytes = mapped - keptEnd;
		keptEnd = mapped;
		return { offsetMs: chunk.offsetMs, bytes };
	});
}

/**
 * Read the capture log of `storeRoot` as a cassette under `key`. Throws EndoCassetteDomainErrorV0 when it was recorded
 * under another key id. Only the recording proxy's exchanges count.
 */
export function loadEndoCassetteV0(storeRoot: string, key: EndoDigestKeyV0): EndoCassetteV0 {
	const events = readEndoCaptureEventsV0(storeRoot);
	const keyId = endoCaptureKeyIdV0(events);
	if (keyId === null) throw new TypeError(`the capture log of ${storeRoot} holds no recording`);
	if (keyId !== key.keyId) throw new EndoCassetteDomainErrorV0(keyId, key.keyId);
	const blobs = createEndoBlobStoreV0(endoCaptureRootV0(storeRoot), key, { readOnly: true });
	let listen: string | null = null;
	let recordings = 0;
	const byExchange = new Map<number, EndoCassetteExchangeV0>();
	for (const event of events) {
		if (event.producer !== "capture:record") continue;
		const payload = record(event.payload);
		const exchange = typeof payload.exchange === "number" ? payload.exchange : null;
		if (event.kind === "capture.started") {
			recordings += 1;
			if (recordings > 1) throw new TypeError("the capture log holds more than one recording; a cassette is one");
			if (typeof payload.listen === "string") listen = payload.listen;
		} else if (event.kind === "capture.request" && exchange !== null) {
			const body = bytesRef(payload.body);
			if (!isEndoKeyedDigestV0(payload.requestDigest) || body === null)
				throw new TypeError(`malformed capture.request for exchange ${exchange}`);
			byExchange.set(exchange, {
				exchange,
				attempt: typeof payload.attempt === "number" ? payload.attempt : 1,
				method: String(payload.method),
				path: String(payload.path),
				requestDigest: payload.requestDigest,
				requestBody: body,
				response: null,
				truncated: "the recording has no end for this exchange",
			});
		} else if (event.kind === "capture.exchange-ended" && exchange !== null) {
			const entry = byExchange.get(exchange);
			const wire = bytesRef(payload.wire);
			if (entry === undefined || wire === null) continue;
			const chunks = (Array.isArray(payload.chunks) ? payload.chunks : []).map((chunk) => ({
				offsetMs: Number(record(chunk).offsetMs),
				bytes: Number(record(chunk).bytes),
			}));
			const wireBytes = Number(payload.wireBytes);
			if (chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== wireBytes) {
				entry.truncated = "the recorded chunks do not add up to the recorded response";
				continue;
			}
			if (!blobs.has(wire.digest) || !blobs.has(entry.requestBody.digest)) {
				entry.truncated = "a recorded body is missing from the blob store, or does not verify";
				continue;
			}
			const headBytes = typeof payload.headBytes === "number" ? payload.headBytes : null;
			const scrubbed = Array.isArray(payload.headScrubbed) ? payload.headScrubbed.map(String) : [];
			entry.response = {
				status: typeof payload.status === "number" ? payload.status : null,
				wire,
				chunks: keptChunks(chunks, headBytes, headBytes === null ? 0 : headBytes - (wireBytes - wire.bytes)),
				headScrubbed: scrubbed,
				outcome: payload.outcome as EndoExchangeOutcomeV0,
				afterChunks: typeof payload.afterChunks === "number" ? payload.afterChunks : null,
				error: typeof payload.error === "string" ? payload.error : null,
				closedAfter: false,
			};
			entry.truncated = null;
		} else if (event.kind === "capture.exchange-interrupted" && exchange !== null) {
			const entry = byExchange.get(exchange);
			if (entry !== undefined && entry.response === null && typeof payload.reason === "string")
				entry.truncated = payload.reason;
		} else if (event.kind === "capture.connection-closed" && payload.by === "upstream") {
			const after = typeof payload.afterExchange === "number" ? byExchange.get(payload.afterExchange) : undefined;
			if (after?.response) after.response.closedAfter = true;
		}
	}
	const exchanges = [...byExchange.values()].sort((a, b) => a.exchange - b.exchange);
	exchanges.forEach((entry, index) => {
		if (entry.exchange !== index + 1) throw new TypeError(`the capture log skips exchange ${index + 1}`);
	});
	return { keyId, listen, exchanges, events };
}

/** Where the replay pauses: after `chunks` chunks of exchange `exchange` (1-based, in replay order) were written. */
export interface EndoCassettePauseV0 {
	exchange: number;
	chunks: number;
}

export interface EndoCassetteServerOptionsV0 {
	readonly cassette: EndoCassetteV0;
	readonly key: EndoDigestKeyV0;
	/** The recording store root (the cassette's blob store is under it). */
	readonly storeRoot: string;
	readonly timing: EndoCassetteTimingV0;
	/** Default 127.0.0.1; loopback only. */
	readonly host?: string;
	/** Default 0. */
	readonly port?: number;
	/** Where requests, served exchanges and misses are recorded (the replay's capture log). */
	readonly log: EndoCaptureLogV0;
	/** How long to wait for a client to disconnect once a disconnected exchange's chunks ran out. Default 30 s. */
	readonly holdMs?: number;
}

export interface EndoCassetteServerV0 {
	readonly origin: string;
	readonly port: number;
	readonly served: number;
	readonly misses: number;
	/** The cassette's exchanges not yet served. */
	readonly remaining: number;
	/**
	 * Pause after `chunks` chunks of replay exchange `exchange` were written: resolves when the pause point is reached
	 * (or that exchange ends before it); serving continues only after `resume()`.
	 */
	pauseAt(point: EndoCassettePauseV0): Promise<void>;
	resume(): void;
	close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Write and wait until the bytes are handed to the kernel (or the socket is gone). */
function write(socket: Socket, bytes: Uint8Array): Promise<void> {
	return new Promise((resolve) => {
		if (socket.destroyed) return resolve();
		socket.write(bytes, () => resolve());
	});
}

export async function startEndoCassetteServerV0(options: EndoCassetteServerOptionsV0): Promise<EndoCassetteServerV0> {
	const host = options.host ?? "127.0.0.1";
	requireLoopbackBindV0(host);
	if (options.cassette.keyId !== options.key.keyId)
		throw new EndoCassetteDomainErrorV0(options.cassette.keyId, options.key.keyId);
	const blobs = createEndoBlobStoreV0(endoCaptureRootV0(options.storeRoot), options.key, { readOnly: true });
	const log = options.log;
	const holdMs = options.holdMs ?? 30_000;
	const exchanges = options.cassette.exchanges;
	let position = 0;
	let counter = 0;
	let served = 0;
	let misses = 0;
	let pause: (EndoCassettePauseV0 & { reached: () => void; release: Promise<void>; resume: () => void }) | null = null;
	const sockets = new Set<Socket>();

	const missed = (
		exchange: number,
		reason: string,
		requestDigest: EndoKeyedDigestV0,
		expected: EndoKeyedDigestV0 | null,
		detail: string,
	) => {
		misses += 1;
		log.record("capture.cassette-miss", {
			exchange,
			reason,
			requestDigest: { ...requestDigest },
			expected: expected === null ? null : { ...expected },
			detail,
		});
	};

	const handleConnection = (socket: Socket) => {
		sockets.add(socket);
		let gone = false;
		socket.on("close", () => {
			gone = true;
			sockets.delete(socket);
		});
		socket.on("error", () => {
			gone = true;
		});
		// Requests on one connection are answered in order, one at a time.
		let chain: Promise<void> = Promise.resolve();
		let current: { start: number; method: string; path: string; parts: Buffer[] } | null = null;

		const answer = async (start: number, method: string, path: string, body: Buffer) => {
			counter += 1;
			const exchange = counter;
			const requestDigest = endoRequestDigestV0(options.key, method, path, body);
			log.record("capture.request", {
				exchange,
				method,
				path,
				requestDigest: { ...requestDigest },
				body: { ...log.keep(body) } as unknown as JsonValueV0,
			});
			const fail = async (reason: string, expected: EndoKeyedDigestV0 | null, detail: string) => {
				missed(exchange, reason, requestDigest, expected, detail);
				const json = JSON.stringify({
					error: { type: "endophasia_cassette_miss", reason, message: `cassette miss: ${detail}` },
				});
				await write(
					socket,
					Buffer.from(
						`HTTP/1.1 599 Cassette Miss\r\ncontent-type: application/json\r\nx-endo-cassette: miss\r\ncontent-length: ${Buffer.byteLength(json)}\r\nconnection: close\r\n\r\n${json}`,
					),
				);
				socket.end();
			};
			const next = exchanges[position];
			if (next === undefined)
				return fail("cassette-exhausted", null, `all ${exchanges.length} recorded exchange(s) were served`);
			if (next.requestDigest.value !== requestDigest.value)
				return fail(
					"unexpected-request",
					next.requestDigest,
					`request ${exchange} (${method} ${path}) is not recorded exchange ${next.exchange} (${next.method} ${next.path})`,
				);
			if (next.response === null)
				return fail(
					"truncated-exchange",
					next.requestDigest,
					`recorded exchange ${next.exchange}: ${next.truncated}`,
				);
			position += 1;
			const recorded = next.response;
			const wire = blobs.get(recorded.wire.digest);
			let delivered = 0;
			const finish = (outcome: string) => {
				served += 1;
				// A pause point this exchange never reached is released, so a driver waiting on it is never left hanging.
				if (pause !== null && pause.exchange === exchange) pause.reached();
				log.record("capture.served", {
					exchange,
					cassetteExchange: next.exchange,
					requestDigest: { ...requestDigest },
					recordedOutcome: recorded.outcome,
					outcome,
					chunksDelivered: delivered,
					offsetMs: offsetMsV0(start),
				});
			};
			let offset = 0;
			for (const chunk of recorded.chunks) {
				if (options.timing === "as-recorded") {
					const wait = chunk.offsetMs - (performance.now() - start);
					if (wait > 0) await sleep(wait);
				}
				if (gone) return finish("client-disconnected");
				await write(socket, wire.subarray(offset, offset + chunk.bytes));
				offset += chunk.bytes;
				delivered += 1;
				const point = pause;
				if (point !== null && point.exchange === exchange && point.chunks === delivered) {
					point.reached();
					await point.release;
				}
			}
			if (recorded.outcome === "complete") {
				if (recorded.closedAfter) socket.end();
				return finish("complete");
			}
			if (recorded.outcome === "upstream-error") {
				socket.destroy();
				return finish("upstream-error");
			}
			// The recorded client disconnected here: wait for this one to do the same; never add an ending.
			const deadline = performance.now() + holdMs;
			while (!gone && performance.now() < deadline) await sleep(5);
			if (gone) return finish("client-disconnected");
			missed(
				exchange,
				"response-exhausted",
				requestDigest,
				next.requestDigest,
				`the recorded client disconnected after ${delivered} chunk(s); this client did not within ${holdMs} ms`,
			);
			socket.destroy();
			finish("cut");
		};

		const parser = new Http1ParserV0("request", {
			head(head) {
				current = { start: performance.now(), method: head.method!, path: head.target!, parts: [] };
			},
			body(bytes) {
				current?.parts.push(Buffer.from(bytes));
			},
			end() {
				const request = current;
				current = null;
				if (request === null) return;
				chain = chain.then(() =>
					answer(request.start, request.method, request.path, Buffer.concat(request.parts)).catch(
						(error: unknown) => {
							log.record("capture.cassette-miss", {
								exchange: counter,
								reason: "serve-failed",
								requestDigest: null,
								expected: null,
								detail: String((error as Error).message ?? error).slice(0, 200),
							});
							socket.destroy();
						},
					),
				);
			},
		});
		socket.on("data", (data: Buffer) => {
			try {
				parser.push(data);
			} catch (error) {
				log.record("capture.unparsed", { detail: String((error as Error).message).slice(0, 200) });
				socket.destroy();
			}
		});
	};

	const server: Server = createServer(handleConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => resolve());
	});
	const address = server.address() as import("node:net").AddressInfo;
	requireLoopbackBindV0(address.address);
	const origin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
	log.record("capture.started", {
		role: "replay",
		capture: ENDO_CAPTURE_VERSION_V0,
		listen: origin,
		digestKey: { keyId: options.key.keyId, domain: options.key.domain },
		timing: options.timing,
		cassette: { exchanges: exchanges.length, listen: options.cassette.listen },
	});
	return {
		origin,
		port: address.port,
		get served() {
			return served;
		},
		get misses() {
			return misses;
		},
		get remaining() {
			return exchanges.length - position;
		},
		pauseAt(point) {
			let reached!: () => void;
			let resume!: () => void;
			const hit = new Promise<void>((done) => {
				reached = done;
			});
			const release = new Promise<void>((done) => {
				resume = done;
			});
			pause = { ...point, reached, release, resume };
			return hit;
		},
		resume() {
			const point = pause;
			pause = null;
			point?.resume();
		},
		close() {
			pause?.resume();
			return new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			});
		},
	};
}
