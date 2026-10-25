// The cockpit's local HTTP transport: a read-only window onto the observation bridge (cockpit/index.ts), nothing more. It
// reconstructs no evidence, infers no fact, manages no harness and writes nothing: every API response body is a contract the
// bridge returned, serialized in canonical JSON after it was read under the version it declares. A host may also pass the files of a
// browser page, which the server holds in memory and serves at `/<capability>/` and `/<capability>/assets/<name>` through the same
// guards, under a page policy of its own; it reads no file to do so.
//
// Threat model. The operator's browser may visit a hostile page while this server runs, so loopback binding is not treated as
// authentication. A request is answered only if, in this order: its Host is exactly this server's loopback host and port (DNS
// rebinding), its Origin and Sec-Fetch-Site are not foreign (cross-site requests), its method is GET, it has no body, its path is
// `/<per-launch capability>/api/v0/...` (or the page's `/` and `/assets/<name>`) made only of the characters a route can contain
// (no `%`, so no encoded traversal), and its query holds only the two bounded integers a route accepts (none for the page). Every refusal is a fixed, bounded JSON code that names no path,
// source content, key or capability. No CORS header is ever sent. The capability is a random 256-bit value generated per
// server instance, unrelated to the digest key, compared in constant time and never written into a response or a source record.
//
// Cost. A bridge read reopens and validates the whole store whatever the page size (cockpit/reader.ts), and it is synchronous:
// while one runs, this process serves nothing else (documented in docs/cockpit.md, measured by scripts/bench-cockpit-http.ts).
// So the server serves one read at a time by construction, and bounds how much of its wall time authenticated reads may use: a
// budget of read milliseconds that accrues at a duty cycle from the monotonic clock on demand and is charged what each read
// actually took (a request count would not bound a read that outlasts the refill). It also bounds connections, headers and time,
// never polls, never caches, runs no timer and holds nothing between requests. Unauthenticated and malformed traffic costs no read
// and no budget.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
	canonicalEndoJsonV0,
	ENDO_COCKPIT_PAGE_MAX_LIMIT_V0,
	type EndoDigestKeyV0,
	endoCockpitDigestKeyAdmittedV0,
	isEndoCockpitSourceKindAdmittedV0,
	isWellFormedKindV0,
	readEndoCockpitRecordV0,
	readEndoCockpitRuntimeV0,
	readEndoCockpitSnapshotV0,
	readEndoCockpitTimelineV0,
} from "../cockpit/index.ts";

import {
	EndoCockpitComparisonRefusalV0,
	endoCockpitComparisonSelectionV0,
	readEndoCockpitComparisonV0,
} from "./comparison.ts";

const LOOPBACK = "127.0.0.1";
/** The only API version. An unknown version is a 404, never a downgrade to this one. */
const API = "api/v0";
const MAX_PATH_CHARS = 512;
const MAX_QUERY_CHARS = 96;
const MAX_CONNECTIONS = 32;
/**
 * The longest `Retry-After` the server sends. A read budget with a very small duty could owe far more; the answer is then "an hour
 * from now, ask again", and a client that asks then gets the remainder. It keeps the figure short enough for any client to hold in
 * a timer (a browser timer holds about 24 days) and to read as a plain number.
 */
const MAX_RETRY_AFTER_SECONDS = 3600;
const MAX_HEADER_BYTES = 8 * 1024;
/** How long a refused connection may linger for its peer to read the refusal and close. */
const REFUSAL_LINGER_MS = 2000;

/** The closed set of refusals: a status, and the code that is the whole body. */
const REFUSALS = {
	"bad-request": 400,
	forbidden: 403,
	"not-found": 404,
	"method-not-allowed": 405,
	"misdirected-request": 421,
	"too-many-requests": 429,
	"internal-error": 500,
	"ambiguous-selection": 409,
	"source-absent": 503,
	"source-degraded": 503,
	"source-unopenable": 503,
} as const;
type Refusal = keyof typeof REFUSALS;
const REASONS: Record<Refusal, string> = {
	"bad-request": "Bad Request",
	forbidden: "Forbidden",
	"not-found": "Not Found",
	"method-not-allowed": "Method Not Allowed",
	"misdirected-request": "Misdirected Request",
	"too-many-requests": "Too Many Requests",
	"internal-error": "Internal Server Error",
	"ambiguous-selection": "Conflict",
	"source-absent": "Service Unavailable",
	"source-degraded": "Service Unavailable",
	"source-unopenable": "Service Unavailable",
};

/**
 * The policy of the page and its assets, narrower than the API's: the page's own scripts, styles, images and requests, nothing
 * remote, no inline script or style, no plugin, no form, no frame. Trusted Types are required and none is allowed, so a script
 * that reaches an HTML sink throws instead of parsing markup. Fonts are the page's own (`font-src 'self'`): no `data:` font, no
 * remote one, and only `.woff2` is a servable font type below.
 */
const PAGE_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const UI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UI_TYPES: Readonly<Record<string, string>> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	svg: "image/svg+xml",
	woff2: "font/woff2",
};
const MAX_UI_BYTES = 4 * 1024 * 1024;
interface UiFile {
	type: string;
	bytes: Buffer;
}

const SECURITY_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
	"Content-Type": "application/json; charset=utf-8",
} as const;

/**
 * The browser page a host serves with the API: file name to content, held in memory (the server reads no file). `index.html` is
 * the page, served at `/<capability>/`; every other entry is served at `/<capability>/assets/<name>`. Names are
 * `[A-Za-z0-9][A-Za-z0-9._-]*` ending `.html`, `.js`, `.css`, `.svg` or `.woff2`, and the server picks each content type from the name.
 */
export type EndoCockpitUiFilesV0 = Readonly<Record<string, string | Uint8Array>>;

export interface EndoCockpitServerOptionsV0 {
	/** The store root the bridge reads. Read-only: the server never writes under it. */
	root: string;
	/**
	 * The digest key every read is made under, supplied by the host boundary: the server loads, creates and defaults nothing and
	 * reads no environment. It must be one a cockpit read admits (checked here, so a bad key fails at startup, not per request).
	 * Use a private key for real data; a public fixture key is for synthetic data only.
	 */
	digestKey: EndoDigestKeyV0;
	/** The browser page and its assets (see `EndoCockpitUiFilesV0`). Without it the server is API-only. */
	ui?: EndoCockpitUiFilesV0;
	/** The loopback port. Default 0: the operating system picks a free one. */
	port?: number;
	/**
	 * How much of its wall time the server may spend reading, as a duty cycle: `duty` milliseconds of read time accrue per
	 * millisecond of wall time, up to `burstMs`, and each authenticated read is charged the time it actually took (so the balance
	 * can go negative, and the next read waits until it is positive again: a 429 with Retry-After, which is at most an hour). Default `{ duty: 0.25,
	 * burstMs: 1000 }`: about sixteen prompt refreshes of a small store, or one of a very long one, then at most a quarter of
	 * a core on average.
	 */
	readBudget?: { duty: number; burstMs: number };
	/** Called with an internal failure's error, for the host's own diagnostics. It is never sent to a client. */
	onError?: (error: unknown) => void;
}

export interface EndoCockpitServerV0 {
	/** `http://127.0.0.1:<port>`: the origin the server answers for. Not secret. */
	origin: string;
	port: number;
	/**
	 * `<origin>/<capability>`: append `/api/v0/snapshot` and the other routes. This URL IS the access capability: show it to the
	 * operator, never log it, and never store it.
	 */
	baseUrl: string;
	/** Stop listening, close every connection and resolve once the port is released. Idempotent. */
	close(): Promise<void>;
}

type Query = { afterSequence?: number; limit?: number };

class Refused extends Error {
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(refusal);
		this.refusal = refusal;
	}
}

const refuse = (refusal: Refusal): never => {
	throw new Refused(refusal);
};

/** Header values with the given name, counted from the raw header list (the parsed map folds duplicates). */
function rawHeaderCount(request: IncomingMessage, name: string): number {
	let count = 0;
	for (let index = 0; index < request.rawHeaders.length; index += 2)
		if (request.rawHeaders[index]!.toLowerCase() === name) count += 1;
	return count;
}

/** The query `afterSequence=<n>&limit=<n>` in either order, each at most once, each a canonical non-negative integer. */
function parseQuery(raw: string, accepted: readonly (keyof Query)[]): Query {
	if (raw.length > MAX_QUERY_CHARS) return refuse("bad-request");
	const query: Query = {};
	if (raw === "") return query;
	for (const pair of raw.split("&")) {
		const [name, value, ...rest] = pair.split("=");
		if (rest.length > 0 || value === undefined || !(accepted as readonly (string | undefined)[]).includes(name))
			return refuse("bad-request");
		const key = name as keyof Query;
		if (query[key] !== undefined || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return refuse("bad-request");
		const number = Number(value);
		if (!Number.isSafeInteger(number)) return refuse("bad-request");
		if (key === "limit" && (number < 1 || number > ENDO_COCKPIT_PAGE_MAX_LIMIT_V0)) return refuse("bad-request");
		query[key] = number;
	}
	return query;
}

/**
 * The Host values (and, behind `http://`, Origin values) a server bound to `port` answers: the loopback names with the port. A
 * client omits the port of the scheme's default (80), so on port 80 the bare names are the same authority.
 */
export function endoCockpitAllowedAuthoritiesV0(port: number): string[] {
	const names = ["127.0.0.1", "localhost"];
	return names.flatMap((name) => (port === 80 ? [`${name}:80`, name] : [`${name}:${port}`]));
}

/** The part of a socket the parser-refusal answer uses (a `net.Socket` has it). */
export interface EndoCockpitClientSocketV0 {
	writable: boolean;
	writableLength: number;
	end(data: string): unknown;
	destroy(): unknown;
	setTimeout(milliseconds: number, onTimeout: () => void): unknown;
}

/**
 * Answer a request that never reaches `handle` (the parser refused it: malformed, oversized, timed out; or Node routes it to a
 * special event: CONNECT, an upgrade): the same fixed body and
 * headers as every other refusal, then close. The write is best effort and never waits on the peer: a client that does not read
 * cannot hold a connection (and so the connection limit) open, because anything still queued after the write is dropped.
 */
export function answerEndoCockpitClientErrorV0(
	socket: EndoCockpitClientSocketV0,
	refusal: Refusal = "bad-request",
): void {
	if (!socket.writable) return void socket.destroy();
	const body = `{"error":"${refusal}"}\n`;
	const headers = Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}\r\n`);
	const allow = refusal === "method-not-allowed" ? "Allow: GET\r\n" : "";
	socket.end(
		`HTTP/1.1 ${REFUSALS[refusal]} ${REASONS[refusal]}\r\n${headers.join("")}${allow}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
	);
	// A peer that does not read (so never sees the close) gets a short deadline and then the socket is destroyed: it cannot hold
	// one of the connection slots, and no timer exists unless a refusal was just written to that socket.
	if (socket.writableLength > 0) socket.destroy();
	else socket.setTimeout(REFUSAL_LINGER_MS, () => socket.destroy());
}

/** Start the server. Rejects (leaving nothing listening) if the key is not admitted or the port cannot be bound. */
export async function startEndoCockpitServerV0(options: EndoCockpitServerOptionsV0): Promise<EndoCockpitServerV0> {
	if (!endoCockpitDigestKeyAdmittedV0(options.digestKey))
		throw new TypeError(
			"the digest key is not one a cockpit read admits: use a private key or a committed public fixture key",
		);
	const { root, digestKey } = options;
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new TypeError("port must be an integer from 0 to 65535");
	const { duty, burstMs } = options.readBudget ?? { duty: 0.25, burstMs: 1000 };
	if (!(duty > 0 && duty <= 1) || !(burstMs > 0))
		throw new TypeError("readBudget needs a duty in (0, 1] and a positive burstMs");

	const files = new Map<string, UiFile>();
	if (options.ui !== undefined) {
		for (const [name, content] of Object.entries(options.ui)) {
			const type = UI_TYPES[name.slice(name.lastIndexOf(".") + 1)];
			if (!UI_NAME.test(name) || type === undefined || !name.includes("."))
				throw new TypeError("a UI file name is a short plain name ending .html, .js, .css, .svg or .woff2");
			const bytes = Buffer.from(content);
			if (bytes.length > MAX_UI_BYTES) throw new TypeError("a UI file is at most 4 MiB");
			files.set(name, { type, bytes });
		}
		if (!files.has("index.html")) throw new TypeError("the UI needs an index.html");
	}

	const capability = randomBytes(32).toString("base64url");
	const capabilityBytes = Buffer.from(capability);
	let balance = burstMs;
	let refilledAt = performance.now();
	let chargeFrom: number | null = null;
	let hosts: ReadonlySet<string> = new Set();
	let origins: ReadonlySet<string> = new Set();

	/** Credit the wall time since the last look, lazily: no timer exists to keep the process awake. */
	const refill = (): void => {
		const now = performance.now();
		balance = Math.min(burstMs, balance + (now - refilledAt) * duty);
		refilledAt = now;
	};
	/** Admit a read only while the balance is positive, and start charging it the time it takes (see `handle`). */
	const admit = (): void => {
		refill();
		if (balance <= 0) refuse("too-many-requests");
		chargeFrom = performance.now();
	};

	const guard = (request: IncomingMessage): { segments: string[]; rawQuery: string } => {
		// Host: exactly this server's loopback name and bound port, once. A rebound hostname carries its own name here.
		const host = request.headers.host;
		if (rawHeaderCount(request, "host") !== 1 || host === undefined || !hosts.has(host.toLowerCase()))
			return refuse("misdirected-request");
		// Origin and fetch metadata: a browser sends them on cross-site requests; a command-line client sends neither.
		if (rawHeaderCount(request, "origin") > 1) return refuse("forbidden");
		const origin = request.headers.origin;
		if (origin !== undefined && !origins.has(origin.toLowerCase())) return refuse("forbidden");
		const site = request.headers["sec-fetch-site"];
		if (site !== undefined && site !== "same-origin" && site !== "none") return refuse("forbidden");
		// Read-only, no body: HEAD would still run the whole read, so it is refused with the rest.
		if (request.method !== "GET") return refuse("method-not-allowed");
		const length = request.headers["content-length"];
		if (request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0"))
			return refuse("bad-request");
		// The raw target, never resolved by a URL parser: it must be an origin-form path of route characters only.
		const target = request.url ?? "";
		const split = target.indexOf("?");
		const path = split === -1 ? target : target.slice(0, split);
		const rawQuery = split === -1 ? "" : target.slice(split + 1);
		if (path.length > MAX_PATH_CHARS || !/^\/[A-Za-z0-9._\-/]*$/.test(path)) return refuse("not-found");
		const segments = path.slice(1).split("/");
		const presented = Buffer.from(segments[0] ?? "");
		if (presented.length !== capabilityBytes.length || !timingSafeEqual(presented, capabilityBytes))
			return refuse("not-found");
		return { segments: segments.slice(1), rawQuery };
	};

	/**
	 * Route a guarded request to a UI file, or to one read: the records to check under their declared versions, and the body to
	 * send. A file is served from memory and spends none of the read budget.
	 */
	const route = (segments: string[], rawQuery: string): { records: unknown[]; body: unknown } | { file: UiFile } => {
		if (files.size > 0) {
			const page = segments.length === 1 && segments[0] === "";
			const asset = segments.length === 2 && segments[0] === "assets" && segments[1] !== "index.html";
			if (page || asset) {
				parseQuery(rawQuery, []);
				const file = files.get(page ? "index.html" : segments[1]!);
				return file === undefined ? refuse("not-found") : { file };
			}
		}
		if (segments[0] !== "api" || segments[1] !== "v0") return refuse("not-found");
		if (segments[2] === "compare") {
			if (segments.length !== 7) return refuse("not-found");
			const a = endoCockpitComparisonSelectionV0(segments[3], segments[4]);
			const b = endoCockpitComparisonSelectionV0(segments[5], segments[6]);
			if (a === null || b === null) return refuse("not-found");
			parseQuery(rawQuery, []);
			admit();
			try {
				const record = readEndoCockpitComparisonV0(root, a, b, digestKey);
				return { records: [record], body: record };
			} catch (error) {
				if (error instanceof EndoCockpitComparisonRefusalV0) return refuse(error.refusal);
				throw error;
			}
		}
		const [api, version, name, attachment, ...extra] = segments;
		if (`${api}/${version}` !== API || extra.length > 0) return refuse("not-found");
		if (name === "snapshot" || name === "timeline") {
			if (attachment !== undefined) return refuse("not-found");
			const query = parseQuery(rawQuery, ["afterSequence", "limit"]);
			admit();
			const read = { digestKey, ...query };
			const record =
				name === "snapshot" ? readEndoCockpitSnapshotV0(root, read) : readEndoCockpitTimelineV0(root, read);
			return { records: [record], body: record };
		}
		if (name === "runtime" && attachment !== undefined) {
			// The names the reader would throw on are client errors here, so a bridge TypeError stays a host defect.
			if (!isWellFormedKindV0(attachment) || !isEndoCockpitSourceKindAdmittedV0(attachment))
				return refuse("not-found");
			parseQuery(rawQuery, []);
			admit();
			const { identity, capabilities } = readEndoCockpitRuntimeV0(root, attachment, digestKey);
			return { records: [identity, capabilities], body: { identity, capabilities } };
		}
		return refuse("not-found");
	};

	const send = (response: ServerResponse, status: number, body: string): void => {
		response.writeHead(status, {
			...SECURITY_HEADERS,
			"Content-Length": Buffer.byteLength(body),
			...(status === 405 ? { Allow: "GET" } : {}),
			...(status === 400 || status === 500 ? { Connection: "close" } : {}),
			...(status === 429
				? {
						"Retry-After": String(
							Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(-balance / duty / 1000))),
						),
					}
				: {}),
		});
		response.end(body);
	};
	/** A page or asset: the page policy and isolation headers, and the content's own type. */
	const sendFile = (response: ServerResponse, file: UiFile): void => {
		response.writeHead(200, {
			"Cache-Control": SECURITY_HEADERS["Cache-Control"],
			"X-Content-Type-Options": SECURITY_HEADERS["X-Content-Type-Options"],
			"Referrer-Policy": SECURITY_HEADERS["Referrer-Policy"],
			"Content-Security-Policy": PAGE_CSP,
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Frame-Options": "DENY",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
			"Content-Type": file.type,
			"Content-Length": file.bytes.length,
		});
		response.end(file.bytes);
	};
	const sendRefusal = (response: ServerResponse, refusal: Refusal): void =>
		send(response, REFUSALS[refusal], `{"error":"${refusal}"}\n`);

	const handle = (request: IncomingMessage, response: ServerResponse): void => {
		try {
			const { segments, rawQuery } = guard(request);
			const routed = route(segments, rawQuery);
			if ("file" in routed) {
				sendFile(response, routed.file);
				return;
			}
			const { records, body } = routed;
			// Each record must read under the version it declares, or nothing is sent: no downgrade, no partial answer.
			for (const record of records) if (!readEndoCockpitRecordV0(record).ok) throw new TypeError("contract");
			send(response, 200, canonicalEndoJsonV0(body as never));
		} catch (error) {
			if (error instanceof Refused) {
				sendRefusal(response, error.refusal);
				return;
			}
			try {
				options.onError?.(error);
			} catch {
				// a host's own diagnostics never change what the client is told
			}
			sendRefusal(response, "internal-error");
		} finally {
			// The whole read, validation and serialization is charged, whether it succeeded or failed.
			if (chargeFrom !== null) balance -= performance.now() - chargeFrom;
			chargeFrom = null;
		}
	};

	const server: Server = createServer(
		{ maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: 15_000, headersTimeout: 10_000 },
		handle,
	);
	server.maxConnections = MAX_CONNECTIONS;
	// Node answers an `Expect` header itself (an interim 100 or a bare 417) before `handle` runs; routing both events through it
	// gives them the same guards, fixed bodies and headers as every other request. No 100 Continue is ever sent: a request that
	// announces a body is refused as one.
	server.on("checkContinue", handle);
	server.on("checkExpectation", handle);
	// CONNECT and upgrade requests are special events too (not `request`): a tunnel and a protocol switch are never offered, and
	// the refusal is the fixed one, not a silently closed socket.
	server.on("connect", (_request, socket) => answerEndoCockpitClientErrorV0(socket as Socket, "method-not-allowed"));
	server.on("upgrade", (_request, socket) => answerEndoCockpitClientErrorV0(socket as Socket, "bad-request"));
	server.on("clientError", (_error, socket) => answerEndoCockpitClientErrorV0(socket as Socket)); // a TCP server's clients are net sockets

	await new Promise<void>((resolve, reject) => {
		const failed = (error: Error): void => {
			server.close();
			reject(error);
		};
		server.once("error", failed);
		server.listen({ host: LOOPBACK, port }, () => {
			server.off("error", failed);
			resolve();
		});
	});
	server.on("error", (error) => options.onError?.(error));
	const address = server.address() as AddressInfo | string | null;
	if (address === null || typeof address === "string" || address.address !== LOOPBACK || address.family !== "IPv4") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("the cockpit server did not bind the IPv4 loopback address");
	}
	const allowed = endoCockpitAllowedAuthoritiesV0(address.port);
	hosts = new Set(allowed);
	origins = new Set(allowed.map((authority) => `http://${authority}`));
	const origin = `http://127.0.0.1:${address.port}`;

	let closing: Promise<void> | undefined;
	return {
		origin,
		port: address.port,
		baseUrl: `${origin}/${capability}`,
		close: () => {
			closing ??= new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			return closing;
		},
	};
}
