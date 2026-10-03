// Keyed digests: HMAC-SHA256 over canonical JSON, under a comparison-domain key.
//
// Why keyed: a plain sha256 of short, guessable content (a tool call's `{"path":"src/index.ts"}`, `{"command":"ls"}`)
// is a confirmation oracle. Anyone holding the digest can hash candidate arguments until one matches. An HMAC under a
// secret key can be confirmed only by someone who holds the key. Why not a per-store salt: digests must compare across
// stores (run-to-run, recording vs replay), so every store recorded in one comparison domain shares one key.
//
// A key never enters evidence. Each digest records the key's id, derived from the key by HMAC so that the id reveals
// nothing about it. Two digests are comparable only when their key ids are equal. Digests under different key ids are
// in different digest domains: no conclusion about equality follows from them.

import { createHmac } from "node:crypto";
import { canonicalEndoJsonV0 } from "./canonical-json.ts";

export const ENDO_KEYED_DIGEST_ALGORITHM_V0 = "hmac-sha256";

/** `endo.digest-key.` followed by 32 lowercase hex characters. */
export const ENDO_DIGEST_KEY_ID_PATTERN_V0 = /^endo\.digest-key\.[0-9a-f]{32}$/;

/** One keyed digest as evidence carries it. */
export interface EndoKeyedDigestV0 {
	algorithm: "hmac-sha256";
	keyId: string;
	/** HMAC-SHA256 of the value's canonical JSON, 64 lowercase hex characters. */
	value: string;
}

/** A comparison-domain key. The key bytes are held in a closure and never exposed. */
export interface EndoDigestKeyV0 {
	readonly keyId: string;
	/** A label for the domain (e.g. "installation"); informational, not part of the identity. */
	readonly domain: string;
	/** The keyed digest of a plain JSON value's canonical JSON. Throws on a non-plain value. */
	digest(value: unknown): EndoKeyedDigestV0;
}

/** A digest key from raw key bytes (at least 32). */
export function endoDigestKeyV0(key: Uint8Array, domain: string): EndoDigestKeyV0 {
	if (key.length < 32) throw new TypeError("a digest key needs at least 32 bytes");
	const secret = Buffer.from(key);
	const keyId = `endo.digest-key.${createHmac("sha256", secret).update("endo.digest-key-id.v0").digest("hex").slice(0, 32)}`;
	return Object.freeze({
		keyId,
		domain,
		digest(value: unknown): EndoKeyedDigestV0 {
			return {
				algorithm: ENDO_KEYED_DIGEST_ALGORITHM_V0,
				keyId,
				value: createHmac("sha256", secret).update(canonicalEndoJsonV0(value)).digest("hex"),
			};
		},
	});
}

/** Whether a value is a well-formed EndoKeyedDigestV0. */
export function isEndoKeyedDigestV0(value: unknown): value is EndoKeyedDigestV0 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 3 &&
		record.algorithm === ENDO_KEYED_DIGEST_ALGORITHM_V0 &&
		typeof record.keyId === "string" &&
		ENDO_DIGEST_KEY_ID_PATTERN_V0.test(record.keyId) &&
		typeof record.value === "string" &&
		/^[0-9a-f]{64}$/.test(record.value)
	);
}
