// The recording proxy (`endo proxy record`): a strictly pass-through OpenAI-compatible proxy on a loopback address.
//
// Pi is pointed at it through its normal model-provider configuration (models.json `baseUrl`); it relays every byte to
// the upstream and every byte back, and records each exchange into a capture log (capture-log.ts).
//
// Never alters a byte in either direction: it is a TCP relay, with one upstream connection per exchange (a hop), not per
// client connection: the client's keep-alive does not decide which upstream socket a request is written to, so an upstream
// closing a finished connection cannot meet the next request. What the client writes is written to the upstream as read,
// and what the upstream writes is written to the client as read: the
// request line, headers (names, case, order, values; Host included), transfer framing and body bytes, both ways. A copy
// of each direction is parsed (http1.ts) only to delimit exchanges and record them; nothing is re-serialized.
//
// Per exchange it records: the request (method, path, the keyed request digest a cassette matches it by, the decoded
// body by keyed digest and length, headers with secret values dropped: an Authorization header is recorded as present,
// never its value), the attempt number (an identical request seen again is attempt 2, 3, ...: a client retry is its own
// exchange), the response head, every read of the response from the upstream (a chunk) with its offset from the
// request's arrival, and how the exchange ended: complete, client-disconnected (after how many chunks were relayed), or
// upstream-error (the error, and where the transport failed: connect, awaiting-response, mid-response or not-forwarded). The response's wire bytes go to the blob store (a head with a secret header is kept with
// that header's line removed, and says so); events carry digests and lengths only.

import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { rootCertificates, connect as tlsConnect } from "node:tls";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { ENDO_CAPTURE_VERSION_V0, type EndoCaptureLogV0 } from "./capture-log.ts";
import {
	type EndoCapturedHeaderV0,
	endoRequestDigestV0,
	isSecretHeaderV0,
	offsetMsV0,
	requireLoopbackBindV0,
} from "./http.ts";
import { type Http1HeadV0, Http1ParserV0 } from "./http1.ts";

export interface EndoRecordingProxyOptionsV0 {
	/** The upstream origin, e.g. http://127.0.0.1:8080 (scheme, host and port only; no path, query or credentials). */
	readonly upstream: string;
	/** Default 127.0.0.1. Anything but a loopback IP literal is refused. */
	readonly host?: string;
	/** Default 0 (an ephemeral port). */
	readonly port?: number;
	/** Where exchanges are recorded; can be switched later (`proxy.log = ...`). Null: connections are refused. */
	readonly log: EndoCaptureLogV0 | null;
	/** Extra trust anchors for an https upstream (a private CA); the system roots still apply. */
	readonly ca?: string | Buffer;
	/** How long an upstream may sit on request bytes it will not read, after it has answered, before the exchange is dropped. */
	readonly hopDrainMs?: number;
}

/** The exchange most recently started, and how many response chunks have been relayed to its client. */
export interface EndoProxyDeliveryV0 {
	exchange: number;
	chunks: number;
}

export interface EndoRecordingProxyV0 {
	readonly host: string;
	readonly port: number;
	/** `http://<host>:<port>`: the origin Pi's baseUrl points at (add `/v1`). */
	readonly origin: string;
	/** The log exchanges are recorded into; switching it starts a new recording (exchange numbers restart at 1). */
	log: EndoCaptureLogV0 | null;
	delivery(): EndoProxyDeliveryV0 | null;
	/** Resolves when exchange `exchange` has relayed `chunks` response chunks (or has ended). */
	untilDelivered(exchange: number, chunks: number): Promise<void>;
	/** Exchanges not yet ended. */
	readonly open: number;
	/** Resolves once everything observed so far is recorded and written to disk (recording runs off the byte path). */
	flush(): Promise<void>;
	/** Recording jobs that threw (the relay itself is never interrupted by a recording failure). */
	readonly recordingFailures: number;
	/** Flushes, then stops listening and drops every connection. */
	close(): Promise<void>;
}

/**
 * How long a connection's recording is held, at most, waiting for the client connection to end (DESIGN: relay the close
 * first, then record). A connection that ends after its response has its exchanges recorded at once; a keep-alive client
 * that keeps its connection open has them recorded after this delay.
 */
export const ENDO_PROXY_RECORD_HOLD_MS_V0 = 50;
const HOLD_MS = ENDO_PROXY_RECORD_HOLD_MS_V0;

/** Parse and check an upstream origin. */
export function endoUpstreamOriginV0(upstream: string): URL {
	const url = new URL(upstream);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new TypeError(`the upstream must be http or https, got ${url.protocol}`);
	if (url.username !== "" || url.password !== "") throw new TypeError("the upstream URL must not carry credentials");
	if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "")
		throw new TypeError("the upstream is an origin (scheme://host:port): requests keep the path the client sent");
	return url;
}

/** Recorded headers from a parsed head: secret values dropped. */
export function capturedHeadersV0(head: Http1HeadV0): EndoCapturedHeaderV0[] {
	return head.headers.map(([name, value]) => (isSecretHeaderV0(name) ? { name, redacted: true } : { name, value }));
}

/** A response head as kept in the blob store: lines of secret headers removed. */
export function keptResponseHeadV0(head: Http1HeadV0): { bytes: Buffer; scrubbed: string[] } {
	const scrubbed = head.headers.filter(([name]) => isSecretHeaderV0(name)).map(([name]) => name);
	if (scrubbed.length === 0) return { bytes: head.raw, scrubbed };
	const lines = head.raw.toString("latin1").split("\r\n");
	const kept = lines.filter((line, index) => {
		if (index === 0 || line === "") return true;
		const colon = line.indexOf(":");
		return !(colon > 0 && isSecretHeaderV0(line.slice(0, colon)));
	});
	return { bytes: Buffer.from(kept.join("\r\n"), "latin1"), scrubbed };
}

interface Exchange {
	exchange: number;
	start: number;
	method: string;
	path: string;
	headers: EndoCapturedHeaderV0[];
	bodyParts: Buffer[];
	requested: boolean;
	responseHead: Http1HeadV0 | null;
	interim: boolean;
	segments: { offsetMs: number; bytes: Buffer }[];
	relayed: number;
	ended: boolean;
	waiters: { chunks: number; resolve: () => void }[];
	/** The request asked for the connection to end after its response (Connection: close, or HTTP/1.0 without keep-alive). */
	requestClose: boolean;
	/** The request's end has not been seen yet: its capture.request is not queued, so an early end must wait for it. */
	requestOpen: boolean;
	/** Recording jobs of an exchange that ended before its request did, released right after the request is recorded. */
	deferred: (() => void)[];
}

/** One upstream connection, made for one exchange and used for nothing else. */
interface Hop {
	socket: Socket;
	connected: boolean;
	/** Request bytes handed to the socket. */
	written: number;
	gotBytes: boolean;
	done: boolean;
}

/** The raw bytes of one request, from its first byte to its last, and the hop that carries it. */
interface Slot {
	entry: Exchange | null;
	/** The stream is no longer parseable HTTP/1.1: this slot is its opaque tail and delimits nothing. */
	raw: boolean;
	buffered: Buffer[];
	hop: Hop | null;
	requestDone: boolean;
	responseDone: boolean;
	retired: boolean;
	/** Its response (or request) ended the connection: remembered if the other half is still arriving. */
	closeAfter: boolean;
}

const REQUEST_LINE = /^[A-Z!#$%&'*+.^_`|~0-9-]+ \S+ HTTP\/1\.[01]$/;
const TOKEN = /^[A-Z!#$%&'*+.^_`|~0-9-]+$/;

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "CONNECT", "TRACE"];

/**
 * Whether the bytes held so far can still turn out to be an HTTP/1.x request head. Decided from the bytes alone, never a
 * clock: before the first space they must be the start of a known method; after it the method must be a token; once a
 * line is complete it must be a request line. (Unsupported, and relayed untouched but unrecorded: a non-HTTP client that
 * sends `TOKEN something` with no newline and then waits.)
 */
function mayBeRequestHead(held: Buffer[]): boolean {
	const text = Buffer.concat(held).toString("latin1");
	const newline = text.indexOf("\n");
	if (newline !== -1) return REQUEST_LINE.test(text.slice(0, newline).replace(/\r$/, ""));
	const space = text.indexOf(" ");
	if (space === -1) return METHODS.some((method) => method.startsWith(text));
	return TOKEN.test(text.slice(0, space));
}

/** Request bytes held for slots that are not yet at the front; above this the client socket is paused (backpressure). */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/** How long a retired hop may take to send request bytes the upstream has not read yet before it is dropped. */
const HOP_DRAIN_MS = 5000;

export async function startEndoRecordingProxyV0(options: EndoRecordingProxyOptionsV0): Promise<EndoRecordingProxyV0> {
	const host = options.host ?? "127.0.0.1";
	requireLoopbackBindV0(host);
	const upstream = endoUpstreamOriginV0(options.upstream);
	const upstreamPort = upstream.port === "" ? (upstream.protocol === "https:" ? 443 : 80) : Number(upstream.port);
	const drainMs = options.hopDrainMs ?? HOP_DRAIN_MS;
	let log = options.log;
	let generation = 0;
	let counter = 0;
	const attempts = new Map<string, number>();
	const exchanges = new Map<number, Exchange>();
	let latest: Exchange | null = null;
	let open = 0;
	const sockets = new Set<Socket>();
	let origin = "";
	// Recording never runs ahead of the byte path: it is queued in event order and drained after the relay has done its
	// work, and the capture log (opened `async`) appends and fsyncs each event on libuv's threadpool, so no fsync ever
	// blocks this loop. Recording before relaying delayed the upstream's close by the fsyncs, and a keep-alive client
	// that reused the connection in that window sent its next request into a closing connection.
	const queue: (() => void)[] = [];
	let draining = false;
	let recordingFailures = 0;
	const flushWaiters: (() => void)[] = [];
	const drain = () => {
		while (queue.length > 0) {
			const job = queue.shift()!;
			try {
				job();
			} catch {
				recordingFailures += 1;
			}
		}
		draining = false;
		for (const waiter of flushWaiters.splice(0)) waiter();
	};
	const releasers = new Set<() => void>();
	const flush = async (): Promise<void> => {
		for (const releaseHeld of releasers) releaseHeld();
		if (queue.length > 0 || draining) await new Promise<void>((resolve) => flushWaiters.push(resolve));
		await log?.flush();
	};
	const later = (job: () => void) => {
		queue.push(job);
		if (!draining) {
			draining = true;
			setImmediate(drain);
		}
	};

	const progress = (entry: Exchange) => {
		for (const waiter of [...entry.waiters]) {
			if (entry.ended || entry.relayed >= waiter.chunks) {
				entry.waiters.splice(entry.waiters.indexOf(waiter), 1);
				waiter.resolve();
			}
		}
	};

	const handleConnection = (client: Socket) => {
		const sink = log;
		const mine = generation;
		// This connection's recording is held while the connection may still be closed, so its CPU work (hashing,
		// validating, encoding) never competes with relaying: it is released once the client connection has closed, or at
		// most HOLD_MS after it was first held when the connection stays open (a keep-alive client).
		const held: (() => void)[] = [];
		let holdTimer: NodeJS.Timeout | null = null;
		const release = () => {
			if (holdTimer !== null) {
				clearTimeout(holdTimer);
				holdTimer = null;
			}
			for (const job of held.splice(0)) later(job);
		};
		releasers.add(release);
		client.on("close", () => releasers.delete(release));
		const hold = (job: () => void) => {
			held.push(job);
			if (holdTimer === null) holdTimer = setTimeout(release, HOLD_MS);
		};
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		if (sink === null) {
			client.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
		const current = () => (mine === generation ? sink : null);

		// Topology. The client connection is the keep-alive; the upstream is reached by one fresh connection (a hop) per
		// exchange. A hop is created for a slot (the raw bytes of one request) when that slot reaches the front of the
		// queue, carries exactly that request and its response, and is retired when both are complete. Request bytes are
		// written only through `forward(slot, ...)`, which can only reach the hop its own slot opened: no byte of a later
		// request can enter a socket that belongs to an earlier exchange, so an upstream closing a finished hop (RFC 9112
		// 9.8) can never be met by a request. Nothing is ever replayed: a slot's bytes are written to at most one hop.
		const slots: Slot[] = [];
		/** The slot the client's bytes are currently being appended to (its request has not ended). */
		let receiving: Slot | null = null;
		let queuedBytes = 0;
		let paused = false;
		let lastCompleted: number | null = null;
		let parsing = true;
		/** The slot whose hop became a protocol-switched tunnel: the client's bytes go to it, unparsed. */
		let upgraded: Slot | null = null;
		let clientClosed = false;
		/** The client connection is being ended: nothing further is forwarded on it. */
		let ending = false;

		const updateFlow = () => {
			const front = slots[0];
			const need = queuedBytes > MAX_QUEUED_BYTES || (front?.hop?.socket.writableNeedDrain ?? false);
			if (need && !paused) {
				paused = true;
				client.pause();
			} else if (!need && paused) {
				paused = false;
				client.resume();
			}
		};

		const finish = (
			entry: Exchange,
			outcome: "complete" | "client-disconnected" | "upstream-error",
			error: string | null,
			transport?: { phase: string; forwarded: boolean },
		) => {
			if (entry.ended) return;
			entry.ended = true;
			open -= 1;
			const target = current();
			if (target !== null) {
				const wire = Buffer.concat(entry.segments.map((segment) => segment.bytes));
				let kept: { bytes: Buffer; scrubbed: string[] } = { bytes: wire, scrubbed: [] };
				if (entry.responseHead !== null && entry.responseHead.raw.length <= wire.length) {
					const head = keptResponseHeadV0(entry.responseHead);
					kept = {
						bytes: Buffer.concat([head.bytes, wire.subarray(entry.responseHead.raw.length)]),
						scrubbed: head.scrubbed,
					};
				}
				const payload: Record<string, JsonValueV0> = {
					exchange: entry.exchange,
					outcome,
					status: entry.responseHead?.status ?? null,
					chunks: entry.segments.map((segment) => ({ offsetMs: segment.offsetMs, bytes: segment.bytes.length })),
					wire: null,
					wireBytes: wire.length,
					headBytes: entry.responseHead?.raw.length ?? null,
					headScrubbed: kept.scrubbed,
					offsetMs: offsetMsV0(entry.start),
				};
				if (outcome === "client-disconnected") payload.afterChunks = entry.relayed;
				if (error !== null) payload.error = error;
				if (outcome === "upstream-error" && transport !== undefined) payload.transport = { ...transport };
				const job = () => {
					payload.wire = { ...target.keep(kept.bytes) } as unknown as JsonValueV0;
					target.record("capture.exchange-ended", payload);
				};
				// An upstream may answer before the request has been uploaded: the log keeps request before ended.
				if (entry.requestOpen && !ending && !clientClosed) entry.deferred.push(job);
				else hold(job);
			}
			progress(entry);
		};

		/** Record that the upstream, not the client, brought this connection down (before it is destroyed). */
		const markEndedByUpstream = () => {
			if (ending) return;
			ending = true;
			const target = current();
			const closedAfter = lastCompleted;
			if (target !== null)
				hold(() => target.record("capture.connection-closed", { by: "upstream", afterExchange: closedAfter }));
		};

		/** End the client connection once everything already written to it has been sent (never destroy: a slow reader keeps its bytes). */
		const endClient = (by: "upstream" | "client") => {
			if (ending) return;
			ending = true;
			const target = current();
			const closedAfter = lastCompleted;
			if (target !== null)
				hold(() => target.record("capture.connection-closed", { by, afterExchange: closedAfter }));
			// end() only requests the close; the FIN is sent once the socket's writes have drained. Recording is released on
			// 'finish' (the FIN has been handed to the kernel), never before.
			if (!client.writableEnded) {
				client.once("finish", release);
				client.end();
			}
		};

		/** Release an exchange's recording jobs that were waiting for its request to be recorded. */
		const flushDeferred = (entry: Exchange) => {
			for (const job of entry.deferred.splice(0)) hold(job);
		};

		const failQueued = (error: string) => {
			for (const waiting of slots.splice(0)) {
				if (waiting.entry !== null) flushDeferred(waiting.entry);
				waiting.hop?.socket.destroy();
				if (waiting.entry !== null)
					finish(waiting.entry, "upstream-error", error, { phase: "not-forwarded", forwarded: false });
			}
			receiving = null;
			queuedBytes = 0;
			updateFlow();
		};

		const retire = (slot: Slot, advance: boolean) => {
			const hop = slot.hop;
			slot.hop = null;
			slot.retired = true;
			if (hop !== undefined && hop !== null) {
				// Request bytes already handed to the socket but not yet sent (the upstream answered before reading them all)
				// are still the client's to deliver: end() sends them, then closes. A stalled upstream cannot hold it open.
				if (hop.socket.writableLength > 0 && !hop.socket.destroyed) {
					hop.socket.end();
					setTimeout(() => hop.socket.destroy(), drainMs).unref();
				} else hop.socket.destroy();
			}
			const at = slots.indexOf(slot);
			if (at !== -1) slots.splice(at, 1);
			if (advance) dispatch();
			updateFlow();
		};

		/** A slot is finished once its response is complete and its request fully sent; only then does the next one start. */
		const settleSlot = (slot: Slot, closeClient: boolean) => {
			if (slot.raw || slot.retired || !(slot.responseDone && slot.requestDone)) return;
			if (closeClient || slot.closeAfter) {
				// The connection ends here: nothing queued behind this exchange is ever forwarded.
				retire(slot, false);
				endClient("upstream");
				failQueued("the connection was ended by the previous response before this request was forwarded");
			} else retire(slot, true);
		};

		const openHop = (slot: Slot) => {
			const socket: Socket =
				upstream.protocol === "https:"
					? tlsConnect({
							host: upstream.hostname,
							port: upstreamPort,
							servername: upstream.hostname,
							...(options.ca === undefined ? {} : { ca: [...rootCertificates, options.ca] }),
						})
					: netConnect({ host: upstream.hostname, port: upstreamPort });
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			const hop: Hop = { socket, connected: false, written: 0, gotBytes: false, done: false };
			slot.hop = hop;
			const connectedEvent = upstream.protocol === "https:" ? "secureConnect" : "connect";
			socket.once(connectedEvent, () => {
				hop.connected = true;
			});
			const entry = slot.entry;
			let hopParsing = entry !== null && !slot.raw;
			let ends: number[] = [];
			let interim = false;
			let sawClose = false;
			/** The upstream accepted a protocol switch (101): what follows is not HTTP and is relayed as one opaque stream. */
			let switched = false;
			const responseParser = new Http1ParserV0("response", {
				head(head) {
					if (entry === null) return;
					if (
						head.status === 101 ||
						(entry.method === "CONNECT" && head.status !== undefined && head.status >= 200 && head.status < 300)
					)
						switched = true;
					else if (head.status !== undefined && head.status >= 100 && head.status < 200) {
						interim = true;
						return;
					}
					interim = false;
					entry.responseHead = head;
					const connection = head.headers
						.filter(([name]) => name.toLowerCase() === "connection")
						.flatMap(([, value]) =>
							value
								.toLowerCase()
								.split(",")
								.map((token) => token.trim()),
						);
					sawClose =
						connection.includes("close") ||
						(/^HTTP\/1\.0\b/.test(head.startLine) && !connection.includes("keep-alive"));
					const target = current();
					const response = {
						exchange: entry.exchange,
						status: head.status ?? null,
						headers: capturedHeadersV0(head) as unknown as JsonValueV0,
						offsetMs: offsetMsV0(entry.start),
					};
					if (target !== null) hold(() => target.record("capture.response", response));
				},
				body() {},
				end(_bytes, offset) {
					if (interim) {
						interim = false;
						return;
					}
					ends.push(offset);
				},
			});
			if (entry !== null) responseParser.pendingMethods.push(entry.method);
			const requestClose = entry?.requestClose ?? false;

			const complete = (closeClient: boolean) => {
				if (hop.done || entry === null) return;
				hop.done = true;
				slot.responseDone = true;
				slot.closeAfter = closeClient || requestClose;
				finish(entry, "complete", null);
				lastCompleted = entry.exchange;
				settleSlot(slot, slot.closeAfter);
				if (!slot.requestDone && !slot.raw && !slot.retired) watchStall();
			};
			// The upstream answered before the request was uploaded. If it then stops reading while the client is held back by
			// the full socket, the request can never complete and the hop would never retire: end the connection instead.
			const watchStall = () => {
				let last = socket.bytesWritten;
				const tick = () => {
					if (slot.retired || slot.requestDone || socket.destroyed) return;
					if (socket.bytesWritten === last && socket.writableNeedDrain) {
						retire(slot, false);
						endClient("upstream");
						failQueued("the upstream stopped reading this request after answering it");
						return;
					}
					last = socket.bytesWritten;
					setTimeout(tick, drainMs).unref();
				};
				setTimeout(tick, drainMs).unref();
			};
			const segment = (from: Buffer) => {
				if (entry === null || from.length === 0) return;
				entry.segments.push({ offsetMs: offsetMsV0(entry.start), bytes: Buffer.from(from) });
				entry.relayed += 1;
				progress(entry);
			};

			socket.on("data", (data: Buffer) => {
				if (slot.retired) return;
				// The request stream stopped being HTTP/1.1 after this hop opened: from here the relay delimits nothing.
				if (slot.raw) hopParsing = false;
				else if (hop.done) return; // Bytes after this exchange's response belong to no exchange: dropped.
				hop.gotBytes = true;
				if (!hopParsing) {
					client.write(data);
					return;
				}
				ends = [];
				try {
					responseParser.push(data);
				} catch {
					// A complete response found before the bytes that failed is still the response: it ends there, and what
					// follows belongs to no exchange. Only a failure inside the response itself leaves the stream unparsed.
					if (ends[0] === undefined) {
						hopParsing = false;
						const target = current();
						if (target !== null)
							hold(() =>
								target.record("capture.unparsed", { detail: "the response is not an HTTP/1.1 message" }),
							);
						client.write(data);
						return;
					}
				}
				const end = ends[0];
				client.write(end === undefined ? data : data.subarray(0, end));
				segment(end === undefined ? data : data.subarray(0, end));
				if (end !== undefined) {
					if (switched) {
						// The exchange ends at the 101 head; the connection becomes a tunnel on this hop, both ways.
						slot.raw = true;
						upgraded = slot;
						hopParsing = false;
						if (end < data.length) client.write(data.subarray(end));
					}
					complete(sawClose);
				}
			});

			// A hop ends or closes only by the upstream's doing, or by this proxy's own retirement (after which nothing here
			// matters). Before the response is complete it is an upstream failure; after, it is nothing at all.
			let over = false;
			const upstreamOver = (error: string | null) => {
				if (over || slot.retired) return;
				over = true;
				if (slot.raw) hopParsing = false;
				if (hop.done && !slot.raw) return;
				if (entry === null || !hopParsing) {
					// Unparsed: relay the upstream's close as the client's, and report what is known.
					if (entry !== null && !entry.ended) {
						hop.done = true;
						finish(entry, "upstream-error", error ?? "upstream closed the connection", {
							phase: !hop.connected ? "connect" : hop.gotBytes ? "mid-response" : "awaiting-response",
							forwarded: hop.connected && hop.written > 0,
						});
					}
					// A reset stays a reset for the client; an orderly end stays orderly.
					if (error !== null) {
						markEndedByUpstream();
						client.resetAndDestroy();
					} else endClient("upstream");
					failQueued("the connection was ended by the upstream before this request was forwarded");
					return;
				}
				let closedBody = false;
				if (error === null && entry.responseHead !== null) {
					try {
						ends = [];
						closedBody = responseParser.close() && ends.length > 0;
					} catch {
						// A cut message is reported below.
					}
				}
				if (closedBody) {
					// A response framed by the close is complete, and the close is the client's too.
					complete(true);
					return;
				}
				hop.done = true;
				finish(entry, "upstream-error", error ?? "upstream closed the connection", {
					phase: !hop.connected ? "connect" : hop.gotBytes ? "mid-response" : "awaiting-response",
					forwarded: hop.connected && hop.written > 0,
				});
				// An upstream failure is the client's failure too: its connection is ended the same way.
				if (error !== null) {
					markEndedByUpstream();
					client.destroy();
				} else endClient("upstream");
				failQueued("the connection was ended by the upstream before this request was forwarded");
			};
			socket.on("end", () => upstreamOver(null));
			socket.on("error", (error: NodeJS.ErrnoException) => upstreamOver(error.code ?? error.name));
			socket.on("close", () => upstreamOver(null));
			socket.on("drain", updateFlow);
		};

		/** Start the front slot's hop once it has what it needs (its request head, or the raw tail of an unparsed stream). */
		const dispatch = () => {
			const front = slots[0];
			if (front === undefined || front.hop !== null || front.retired) return;
			if (front.entry === null && !front.raw) return;
			openHop(front);
			const hop = front.hop as Hop | null;
			if (hop === null) return;
			for (const part of front.buffered.splice(0)) {
				queuedBytes -= part.length;
				hop.socket.write(part);
				hop.written += part.length;
			}
			updateFlow();
		};

		/** Append request bytes to a slot: written to its own hop, or held byte-for-byte until the slot reaches the front. */
		const forward = (slot: Slot, bytes: Buffer) => {
			if (bytes.length === 0 || slot.retired) return;
			const hop = slot.hop;
			if (hop !== null) {
				if (!hop.socket.destroyed) hop.socket.write(bytes);
				hop.written += bytes.length;
			} else {
				slot.buffered.push(bytes);
				queuedBytes += bytes.length;
			}
			updateFlow();
		};

		const ensureReceiving = (): Slot => {
			if (receiving === null) {
				receiving = {
					entry: null,
					raw: false,
					buffered: [],
					hop: null,
					requestDone: false,
					responseDone: false,
					retired: false,
					closeAfter: false,
				};
				slots.push(receiving);
			}
			return receiving;
		};

		let requestEnds: { slot: Slot; offset: number }[] = [];
		const requestParser = new Http1ParserV0("request", {
			head(head) {
				counter += 1;
				const slot = ensureReceiving();
				const connection = head.headers
					.filter(([name]) => name.toLowerCase() === "connection")
					.flatMap(([, value]) =>
						value
							.toLowerCase()
							.split(",")
							.map((token) => token.trim()),
					);
				const entry: Exchange = {
					exchange: counter,
					start: performance.now(),
					method: head.method!,
					path: head.target!,
					headers: capturedHeadersV0(head),
					bodyParts: [],
					requested: false,
					responseHead: null,
					interim: false,
					segments: [],
					relayed: 0,
					ended: false,
					waiters: [],
					requestOpen: true,
					deferred: [],
					requestClose:
						connection.includes("close") ||
						(/HTTP\/1\.0$/.test(head.startLine) && !connection.includes("keep-alive")),
				};
				slot.entry = entry;
				exchanges.set(entry.exchange, entry);
				latest = entry;
				open += 1;
			},
			body(bytes) {
				receiving?.entry?.bodyParts.push(Buffer.from(bytes));
			},
			end(_bytes, offset) {
				const slot = ensureReceiving();
				const entry = slot.entry;
				requestEnds.push({ slot, offset });
				// The next byte starts a new request, and its head (possibly in this same read) starts a new slot.
				receiving = null;
				if (entry === null) return;
				entry.requestOpen = false;
				const target = current();
				if (target === null) return;
				entry.requested = true;
				const body = Buffer.concat(entry.bodyParts);
				const offsetMs = offsetMsV0(entry.start);
				hold(() => {
					const requestDigest = endoRequestDigestV0(target.key, entry.method, entry.path, body);
					const attempt = (attempts.get(requestDigest.value) ?? 0) + 1;
					attempts.set(requestDigest.value, attempt);
					target.record("capture.request", {
						exchange: entry.exchange,
						attempt,
						method: entry.method,
						path: entry.path,
						requestDigest: { ...requestDigest },
						body: { ...target.keep(body) } as unknown as JsonValueV0,
						headers: entry.headers as unknown as JsonValueV0,
						offsetMs,
					});
				});
				flushDeferred(entry);
			},
		});

		const unparsed = (error: unknown) => {
			if (!parsing) return;
			parsing = false;
			const target = current();
			const detail = String((error as Error).message ?? error).slice(0, 200);
			if (target !== null) hold(() => target.record("capture.unparsed", { detail }));
		};

		/** Give each request that ended in this read its bytes; returns where the bytes of the request still open begin. */
		const routeEnds = (data: Buffer): number => {
			let position = 0;
			for (const { slot, offset } of requestEnds) {
				forward(slot, data.subarray(position, offset));
				slot.requestDone = true;
				position = offset;
				dispatch();
				settleSlot(slot, false);
			}
			return position;
		};

		client.on("data", (data: Buffer) => {
			if (ending) return;
			if (upgraded !== null) {
				forward(upgraded, data);
				return;
			}
			let position = 0;
			if (parsing) {
				requestEnds = [];
				try {
					requestParser.push(data);
				} catch (error) {
					unparsed(error);
				}
				// Every byte up to a request's end belongs to that request; every byte after belongs to the next slot, even
				// before its head has parsed. The slots' bytes concatenate to exactly what the client wrote.
				position = routeEnds(data);
			}
			if (position < data.length) {
				const slot = ensureReceiving();
				// Not HTTP/1.1 any more: the rest of the stream is one opaque tail, relayed on one hop, delimiting nothing.
				if (!parsing) slot.raw = true;
				forward(slot, data.subarray(position));
				// A head that has not completed holds its slot back; bytes that cannot be the start of an HTTP request would
				// hold it back forever (a client of some other protocol waits for the upstream before sending more).
				if (parsing && slot.entry === null && !slot.raw && slot.hop === null) {
					if (!mayBeRequestHead(slot.buffered)) {
						unparsed(new Error("the stream does not start with an HTTP/1.x request line"));
						slot.raw = true;
					}
				}
			}
			dispatch();
		});

		const clientGone = () => {
			if (clientClosed) return;
			clientClosed = true;
			const target = current();
			const closedAfter = lastCompleted;
			for (const waiting of slots.splice(0)) {
				if (waiting.entry !== null) flushDeferred(waiting.entry);
				waiting.hop?.socket.destroy();
				waiting.retired = true;
				if (waiting.entry !== null) finish(waiting.entry, "client-disconnected", null);
			}
			if (target !== null && !ending)
				hold(() => target.record("capture.connection-closed", { by: "client", afterExchange: closedAfter }));
			release();
		};
		client.on("error", clientGone);
		client.on("close", clientGone);
	};

	const server: Server = createServer(handleConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => resolve());
	});
	const address = server.address() as import("node:net").AddressInfo;
	requireLoopbackBindV0(address.address);
	origin = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
	log?.record("capture.started", startedPayload(origin, upstream, log));

	return {
		host: address.address,
		port: address.port,
		origin,
		get log() {
			return log;
		},
		set log(next: EndoCaptureLogV0 | null) {
			log = next;
			generation += 1;
			counter = 0;
			attempts.clear();
			exchanges.clear();
			latest = null;
			next?.record("capture.started", startedPayload(origin, upstream, next));
		},
		delivery() {
			const entry = latest as Exchange | null;
			return entry === null ? null : { exchange: entry.exchange, chunks: entry.relayed };
		},
		untilDelivered(exchange, chunks) {
			const entry = exchanges.get(exchange);
			if (entry === undefined) return Promise.reject(new TypeError(`no exchange ${exchange} has started`));
			if (entry.ended || entry.relayed >= chunks) return Promise.resolve();
			return new Promise((resolve) => entry.waiters.push({ chunks, resolve }));
		},
		get open() {
			return open;
		},
		get recordingFailures() {
			return recordingFailures + (log?.writeFailures ?? 0);
		},
		flush,
		async close() {
			await flush();
			return new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			});
		},
	};
}

function startedPayload(origin: string, upstream: URL, log: EndoCaptureLogV0): Record<string, JsonValueV0> {
	return {
		role: "record",
		capture: ENDO_CAPTURE_VERSION_V0,
		listen: origin,
		upstream: upstream.origin,
		digestKey: { keyId: log.key.keyId, domain: log.key.domain },
	};
}
