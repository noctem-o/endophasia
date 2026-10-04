// What the recording proxy and the cassette server share: the loopback-only bind rule, header scrubbing, and the
// request digest a cassette is matched by.

import { isIPv4, isIPv6 } from "node:net";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";

/** True for a loopback IP literal: 127.0.0.0/8 or ::1. Names (even `localhost`) are not accepted: they resolve. */
export function isLoopbackAddressV0(host: string): boolean {
	if (isIPv4(host)) return host.split(".")[0] === "127";
	if (isIPv6(host)) return host === "::1" || host === "0:0:0:0:0:0:0:1";
	return false;
}

/** Throws unless `host` is a loopback IP literal. Both servers call it before binding and check the bound address. */
export function requireLoopbackBindV0(host: string): void {
	if (!isLoopbackAddressV0(host))
		throw new TypeError(
			`refusing to bind ${JSON.stringify(host)}: the capture proxy and the cassette server bind a loopback address only (127.0.0.1)`,
		);
}

/**
 * Header names whose values are secrets: recorded as present, never with their value, and never stored anywhere. Any
 * name containing one of these words counts.
 */
const SECRET_HEADER = /(authorization|cookie|api[-_]?key|token|secret|password|credential|session)/i;

export function isSecretHeaderV0(name: string): boolean {
	return SECRET_HEADER.test(name);
}

/** One recorded header: its value, or only that it was present. In the order received, names as received. */
export type EndoCapturedHeaderV0 = { name: string; value: string } | { name: string; redacted: true };

/** Raw header pairs (`rawHeaders`) to recorded headers: secret values dropped. */
export function scrubHeadersV0(rawHeaders: readonly string[]): EndoCapturedHeaderV0[] {
	const out: EndoCapturedHeaderV0[] = [];
	for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
		const name = rawHeaders[index]!;
		out.push(isSecretHeaderV0(name) ? { name, redacted: true } : { name, value: rawHeaders[index + 1]! });
	}
	return out;
}

/** The headers a recorded list can reproduce, as a flat raw array: redacted ones are left out. */
export function replayableHeadersV0(headers: readonly EndoCapturedHeaderV0[]): string[] {
	return headers.flatMap((header) => ("value" in header ? [header.name, header.value] : []));
}

/**
 * The digest a request is matched by: the keyed digest of the canonical JSON of `{method, path, body}`, where `body` is
 * the parsed JSON body (so key order and whitespace do not matter), or, for a body that is not JSON, the keyed digest
 * of its raw bytes (`bodyBytes`). An empty body is `null`.
 */
export function endoRequestDigestV0(
	key: EndoDigestKeyV0,
	method: string,
	path: string,
	body: Uint8Array,
): EndoKeyedDigestV0 {
	if (body.length === 0) return key.digest({ method, path, body: null });
	try {
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as JsonValueV0;
		return key.digest({ method, path, body: parsed });
	} catch {
		return key.digest({ method, path, bodyBytes: key.digestBytes(body).value });
	}
}

/** Milliseconds since `start` (a performance.now() reading), to the microsecond. */
export function offsetMsV0(start: number, now: number = performance.now()): number {
	return Math.round((now - start) * 1000) / 1000;
}
