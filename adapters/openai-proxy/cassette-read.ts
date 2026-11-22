// Read-only cassette loader and governed-refusal error constants.
// Separate from `adapters/openai-proxy/cassette.ts` (TCP replay server) and `adapters/openai-proxy/record.ts` (live recording
// proxy) so offline verifiers and Studio observers never pull network/server code into their import closure.

import type { EndoEventV0 } from "../../protocol/event.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { isEndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../storage/blob-store.ts";
import { type EndoCapturedBytesRefV0, endoCaptureRootV0, readEndoCaptureEventsV0 } from "./capture-log.ts";

/**
 * The error string a governed refusal records on `capture.exchange-ended` (`outcome: "upstream-error"`, `forwarded: false`),
 * distinct from a real upstream failure so an independent reader can tell a policy refusal from a model error.
 */
export const GOVERNED_REFUSAL_ERROR_V0 = "governed request refused before forwarding";

/**
 * The error string recorded when the proxy drops a connection because it reached `maxTransferredBytes`.
 */
export const TRANSFER_LIMIT_ERROR_V0 = "transfer limit reached";

export type EndoExchangeOutcomeV0 = "complete" | "client-disconnected" | "upstream-error";

/** One recorded exchange, ready to inspect or serve. */
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
