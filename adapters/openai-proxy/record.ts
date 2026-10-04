// The recording proxy (`endo proxy record`): a strictly pass-through OpenAI-compatible proxy on a loopback address.
//
// Pi is pointed at it through its normal model-provider configuration (models.json `baseUrl`); it relays every byte to
// the upstream and every byte back, and records each exchange into a capture log (capture-log.ts).
//
// Never alters a byte in either direction: it is a TCP relay, one upstream connection per client connection. What the
// client writes is written to the upstream as read, and what the upstream writes is written to the client as read: the
// request line, headers (names, case, order, values; Host included), transfer framing and body bytes, both ways. A copy
// of each direction is parsed (http1.ts) only to delimit exchanges and record them; nothing is re-serialized.
//
// Per exchange it records: the request (method, path, the keyed request digest a cassette matches it by, the decoded
// body by keyed digest and length, headers with secret values dropped: an Authorization header is recorded as present,
// never its value), the attempt number (an identical request seen again is attempt 2, 3, ...: a client retry is its own
// exchange), the response head, every read of the response from the upstream (a chunk) with its offset from the
// request's arrival, and how the exchange ended: complete, client-disconnected (after how many chunks were relayed), or
// upstream-error (the error). The response's wire bytes go to the blob store (a head with a secret header is kept with
// that header's line removed, and says so); events carry digests and lengths only.

import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
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
	close(): Promise<void>;
}

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
}

export async function startEndoRecordingProxyV0(options: EndoRecordingProxyOptionsV0): Promise<EndoRecordingProxyV0> {
	const host = options.host ?? "127.0.0.1";
	requireLoopbackBindV0(host);
	const upstream = endoUpstreamOriginV0(options.upstream);
	const upstreamPort = upstream.port === "" ? (upstream.protocol === "https:" ? 443 : 80) : Number(upstream.port);
	let log = options.log;
	let generation = 0;
	let counter = 0;
	const attempts = new Map<string, number>();
	const exchanges = new Map<number, Exchange>();
	let latest: Exchange | null = null;
	let open = 0;
	const sockets = new Set<Socket>();
	let origin = "";

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
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		if (sink === null) {
			client.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
			return;
		}
		const current = () => (mine === generation ? sink : null);
		const upstreamSocket: Socket =
			upstream.protocol === "https:"
				? tlsConnect({ host: upstream.hostname, port: upstreamPort, servername: upstream.hostname })
				: netConnect({ host: upstream.hostname, port: upstreamPort });
		sockets.add(upstreamSocket);
		upstreamSocket.on("close", () => sockets.delete(upstreamSocket));
		const pending: Exchange[] = [];
		let receiving: Exchange | null = null;
		let lastCompleted: number | null = null;
		let parsing = true;
		let closed = false;

		const finish = (
			entry: Exchange,
			outcome: "complete" | "client-disconnected" | "upstream-error",
			error: string | null,
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
					wire: { ...target.keep(kept.bytes) } as unknown as JsonValueV0,
					wireBytes: wire.length,
					headBytes: entry.responseHead?.raw.length ?? null,
					headScrubbed: kept.scrubbed,
					offsetMs: offsetMsV0(entry.start),
				};
				if (outcome === "client-disconnected") payload.afterChunks = entry.relayed;
				if (error !== null) payload.error = error;
				target.record("capture.exchange-ended", payload);
			}
			progress(entry);
		};

		const requestParser = new Http1ParserV0("request", {
			head(head) {
				counter += 1;
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
				};
				exchanges.set(entry.exchange, entry);
				latest = entry;
				open += 1;
				receiving = entry;
				pending.push(entry);
				responseParser.pendingMethods.push(entry.method);
			},
			body(bytes) {
				receiving?.bodyParts.push(Buffer.from(bytes));
			},
			end() {
				const entry = receiving;
				receiving = null;
				const target = current();
				if (entry === null || target === null) return;
				entry.requested = true;
				const body = Buffer.concat(entry.bodyParts);
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
				});
			},
		});

		// Message ends found while parsing one upstream read: byte offsets within that read.
		let ends: number[] = [];
		const responseParser = new Http1ParserV0("response", {
			head(head) {
				const entry = pending[0];
				if (entry === undefined) return;
				if (head.status !== undefined && head.status >= 100 && head.status < 200) {
					entry.interim = true;
					return;
				}
				entry.interim = false;
				entry.responseHead = head;
				current()?.record("capture.response", {
					exchange: entry.exchange,
					status: head.status ?? null,
					headers: capturedHeadersV0(head) as unknown as JsonValueV0,
					offsetMs: offsetMsV0(entry.start),
				});
			},
			body() {},
			end(_bytes, offset) {
				const entry = pending[0];
				if (entry === undefined || entry.interim) {
					if (entry !== undefined) entry.interim = false;
					return;
				}
				ends.push(offset);
			},
		});

		const unparsed = (error: unknown) => {
			if (!parsing) return;
			parsing = false;
			current()?.record("capture.unparsed", { detail: String((error as Error).message ?? error).slice(0, 200) });
		};

		client.on("data", (data: Buffer) => {
			upstreamSocket.write(data);
			if (!parsing) return;
			try {
				requestParser.push(data);
			} catch (error) {
				unparsed(error);
			}
		});
		upstreamSocket.on("data", (data: Buffer) => {
			client.write(data);
			if (!parsing) return;
			ends = [];
			try {
				responseParser.push(data);
			} catch (error) {
				unparsed(error);
				return;
			}
			let position = 0;
			const segment = (entry: Exchange, from: number, to: number) => {
				if (to <= from) return;
				entry.segments.push({ offsetMs: offsetMsV0(entry.start), bytes: Buffer.from(data.subarray(from, to)) });
				entry.relayed += 1;
				progress(entry);
			};
			for (const end of ends) {
				const entry = pending.shift();
				if (entry === undefined) break;
				segment(entry, position, end);
				finish(entry, "complete", null);
				lastCompleted = entry.exchange;
				position = end;
			}
			const entry = pending[0];
			if (entry !== undefined) segment(entry, position, data.length);
		});

		const teardown = (by: "client" | "upstream", error: string | null) => {
			if (closed) return;
			closed = true;
			if (by === "upstream" && parsing) {
				try {
					if (responseParser.close() && pending[0] !== undefined && pending[0].responseHead !== null) {
						const entry = pending.shift()!;
						finish(entry, "complete", null);
						lastCompleted = entry.exchange;
					}
				} catch {
					// A cut message is reported below as the exchange's end.
				}
			}
			for (const entry of pending.splice(0))
				finish(
					entry,
					by === "client" ? "client-disconnected" : "upstream-error",
					by === "client" ? null : (error ?? "upstream closed the connection"),
				);
			current()?.record("capture.connection-closed", { by, afterExchange: lastCompleted });
			client.destroy();
			upstreamSocket.destroy();
		};
		client.on("error", () => teardown("client", null));
		client.on("close", () => teardown("client", null));
		upstreamSocket.on("error", (error: NodeJS.ErrnoException) => teardown("upstream", error.code ?? error.name));
		upstreamSocket.on("end", () => {
			// The upstream ended its side: whatever it sent is relayed; the client's side is ended the same way.
			client.end();
			teardown("upstream", null);
		});
		upstreamSocket.on("close", () => teardown("upstream", null));
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
		close() {
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
