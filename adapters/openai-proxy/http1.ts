// An incremental HTTP/1.1 message parser for observation only. The recording proxy and the cassette server relay raw
// bytes; this reads a copy of a byte stream and says where each message's head and body begin and end, so exchanges can
// be delimited and recorded without re-serializing anything.
//
// Framing (RFC 9112 §6): a request has a body only by Transfer-Encoding: chunked or Content-Length. A response to HEAD,
// and a 1xx, 204 or 304 response, has none; otherwise chunked, Content-Length, or (a response only) everything until the
// connection closes. Interim 1xx responses are reported as messages of their own.

export interface Http1HeadV0 {
	/** The start line, without CRLF. */
	startLine: string;
	/** Header names and values in order, as received (names keep their case; values are trimmed of OWS). */
	headers: [string, string][];
	/** The head's exact bytes, start line through the blank line. */
	raw: Buffer;
	/** Request: method and target. Response: status. */
	method?: string;
	target?: string;
	status?: number;
}

export interface Http1ParserEventsV0 {
	head(head: Http1HeadV0): void;
	/** Decoded body bytes (chunked framing removed). */
	body(bytes: Buffer): void;
	/**
	 * The message ended. `bodyBytes` is the decoded body length; `offset` is where it ended within the bytes of the
	 * current `push` (0 when it ended in bytes an earlier push delivered, or on close).
	 */
	end(bodyBytes: number, offset: number): void;
}

type Framing = { kind: "none" } | { kind: "length"; remaining: number } | { kind: "chunked" } | { kind: "close" };

/** Thrown on bytes that are not HTTP/1.1 messages. */
export class Http1ParseErrorV0 extends Error {}

const MAX_HEAD = 256 * 1024;

export class Http1ParserV0 {
	readonly #role: "request" | "response";
	readonly #events: Http1ParserEventsV0;
	#buffer: Buffer = Buffer.alloc(0);
	#state: "head" | "body" | "chunk-size" | "chunk-data" | "chunk-crlf" | "trailers" = "head";
	#framing: Framing = { kind: "none" };
	#chunkRemaining = 0;
	#bodyBytes = 0;
	/** Response role: the methods of the requests awaiting a response, oldest first (HEAD responses have no body). */
	readonly pendingMethods: string[] = [];
	#failed = false;
	#pushTotal = 0;
	#leftover = 0;

	constructor(role: "request" | "response", events: Http1ParserEventsV0) {
		this.#role = role;
		this.#events = events;
	}

	/** True while a message has started but not ended. */
	get inMessage(): boolean {
		return this.#state !== "head" || this.#buffer.length > 0;
	}

	/** Whether the current message's body runs until the connection closes. */
	get untilClose(): boolean {
		return this.#state === "body" && this.#framing.kind === "close";
	}

	push(data: Buffer): void {
		if (this.#failed) return;
		this.#leftover = this.#buffer.length;
		this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
		this.#pushTotal = this.#buffer.length;
		try {
			while (this.#step());
		} catch (error) {
			this.#failed = true;
			throw error;
		}
	}

	/** The connection closed. Ends a body framed by close; returns false when a message was cut short. */
	close(): boolean {
		this.#pushTotal = this.#buffer.length;
		this.#leftover = this.#buffer.length;
		if (this.#state === "body" && this.#framing.kind === "close") {
			this.#finish();
			return true;
		}
		return !this.inMessage;
	}

	#finish(): void {
		const bytes = this.#bodyBytes;
		const offset = Math.max(0, this.#pushTotal - this.#buffer.length - this.#leftover);
		this.#state = "head";
		this.#framing = { kind: "none" };
		this.#bodyBytes = 0;
		this.#events.end(bytes, offset);
	}

	#emitBody(bytes: Buffer): void {
		if (bytes.length === 0) return;
		this.#bodyBytes += bytes.length;
		this.#events.body(bytes);
	}

	#line(): string | null {
		const index = this.#buffer.indexOf("\r\n");
		if (index === -1) {
			if (this.#buffer.length > MAX_HEAD) throw new Http1ParseErrorV0("an HTTP line exceeds the parser's bound");
			return null;
		}
		const line = this.#buffer.subarray(0, index).toString("latin1");
		this.#buffer = this.#buffer.subarray(index + 2);
		return line;
	}

	#step(): boolean {
		switch (this.#state) {
			case "head": {
				const end = this.#buffer.indexOf("\r\n\r\n");
				if (end === -1) {
					if (this.#buffer.length > MAX_HEAD)
						throw new Http1ParseErrorV0("an HTTP head exceeds the parser's bound");
					return false;
				}
				const raw = Buffer.from(this.#buffer.subarray(0, end + 4));
				this.#buffer = this.#buffer.subarray(end + 4);
				const lines = raw.subarray(0, end).toString("latin1").split("\r\n");
				const startLine = lines[0]!;
				const headers: [string, string][] = [];
				for (const line of lines.slice(1)) {
					const colon = line.indexOf(":");
					if (colon <= 0)
						throw new Http1ParseErrorV0(`malformed header line ${JSON.stringify(line.slice(0, 80))}`);
					headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
				}
				const head: Http1HeadV0 = { startLine, headers, raw };
				const lower = (name: string) =>
					headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
				const chunked = lower("transfer-encoding").some((value) => /(^|,)\s*chunked\s*$/i.test(value));
				const length = lower("content-length")[0];
				if (this.#role === "request") {
					const match = /^([A-Z!#$%&'*+.^_`|~0-9-]+) (\S+) HTTP\/1\.[01]$/.exec(startLine);
					if (match === null)
						throw new Http1ParseErrorV0(`malformed request line ${JSON.stringify(startLine.slice(0, 80))}`);
					head.method = match[1]!;
					head.target = match[2]!;
					this.#framing = chunked
						? { kind: "chunked" }
						: length !== undefined
							? { kind: "length", remaining: Number(length) }
							: { kind: "none" };
				} else {
					const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(startLine);
					if (match === null)
						throw new Http1ParseErrorV0(`malformed status line ${JSON.stringify(startLine.slice(0, 80))}`);
					const status = Number(match[1]);
					head.status = status;
					const interim = status >= 100 && status < 200;
					const method = interim ? undefined : this.pendingMethods.shift();
					this.#framing =
						interim ||
						status === 204 ||
						status === 304 ||
						method === "HEAD" ||
						(method === "CONNECT" && status >= 200 && status < 300)
							? { kind: "none" }
							: chunked
								? { kind: "chunked" }
								: length !== undefined
									? { kind: "length", remaining: Number(length) }
									: { kind: "close" };
				}
				if (
					this.#framing.kind === "length" &&
					!(Number.isSafeInteger(this.#framing.remaining) && this.#framing.remaining >= 0)
				)
					throw new Http1ParseErrorV0("malformed Content-Length");
				this.#events.head(head);
				if (this.#framing.kind === "none" || (this.#framing.kind === "length" && this.#framing.remaining === 0)) {
					this.#finish();
					return true;
				}
				this.#state = this.#framing.kind === "chunked" ? "chunk-size" : "body";
				return true;
			}
			case "body": {
				if (this.#buffer.length === 0) return false;
				if (this.#framing.kind === "close") {
					this.#emitBody(this.#buffer);
					this.#buffer = Buffer.alloc(0);
					return false;
				}
				const framing = this.#framing as { kind: "length"; remaining: number };
				const take = Math.min(framing.remaining, this.#buffer.length);
				this.#emitBody(this.#buffer.subarray(0, take));
				this.#buffer = this.#buffer.subarray(take);
				framing.remaining -= take;
				if (framing.remaining === 0) this.#finish();
				return true;
			}
			case "chunk-size": {
				const line = this.#line();
				if (line === null) return false;
				const size = Number.parseInt(line.split(";")[0]!.trim(), 16);
				if (!Number.isSafeInteger(size) || size < 0) throw new Http1ParseErrorV0("malformed chunk size");
				this.#chunkRemaining = size;
				this.#state = size === 0 ? "trailers" : "chunk-data";
				return true;
			}
			case "chunk-data": {
				if (this.#buffer.length === 0) return false;
				const take = Math.min(this.#chunkRemaining, this.#buffer.length);
				this.#emitBody(this.#buffer.subarray(0, take));
				this.#buffer = this.#buffer.subarray(take);
				this.#chunkRemaining -= take;
				if (this.#chunkRemaining === 0) this.#state = "chunk-crlf";
				return true;
			}
			case "chunk-crlf": {
				if (this.#buffer.length < 2) return false;
				if (this.#buffer[0] !== 13 || this.#buffer[1] !== 10)
					throw new Http1ParseErrorV0("missing CRLF after a chunk");
				this.#buffer = this.#buffer.subarray(2);
				this.#state = "chunk-size";
				return true;
			}
			case "trailers": {
				const line = this.#line();
				if (line === null) return false;
				if (line === "") this.#finish();
				return true;
			}
		}
	}
}

/** The values of header `name` (case-insensitive), in order. */
export function http1HeaderValuesV0(headers: readonly [string, string][], name: string): string[] {
	const lower = name.toLowerCase();
	return headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
}
