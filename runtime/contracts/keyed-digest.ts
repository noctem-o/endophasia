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
//
// Public keys: committed fixtures can only be verified with a committed key, and a committed key is public. Such a key
// is marked `public` and its id is its name (`fixture-public`), so a reader of any digest made under it sees at once
// that the digest offers no secrecy. Which bytes a public name stands for is pinned by the loader. Public keys are for synthetic fixture scenarios only
// (storage/digest-key.ts, adapters/pi/attachment.ts enforce the separation).

import { createHmac } from "node:crypto";
import {
	ENDO_DIGEST_KEY_ID_PATTERN_V0,
	ENDO_KEYED_DIGEST_ALGORITHM_V0,
	type EndoKeyedDigestV0,
	isEndoKeyedDigestV0,
} from "../../protocol/keyed-digest-shape.ts";
import { canonicalEndoJsonV0 } from "./canonical-json.ts";

// The shape rules live in protocol/ (pure, usable by validators); they are re-exported here unchanged.
export { ENDO_DIGEST_KEY_ID_PATTERN_V0, ENDO_KEYED_DIGEST_ALGORITHM_V0, type EndoKeyedDigestV0, isEndoKeyedDigestV0 };

/** A comparison-domain key. The key bytes are held in a closure and never exposed. */
export interface EndoDigestKeyV0 {
	readonly keyId: string;
	/** A label for the domain (e.g. "installation"); part of the id only for a public key. */
	readonly domain: string;
	/** True for a committed, public key: its digests offer no secrecy. */
	readonly public: boolean;
	/** 32 hex characters derived from the key bytes by HMAC: identifies the bytes without revealing them. */
	readonly fingerprint: string;
	/** The keyed digest of a plain JSON value's canonical JSON. Throws on a non-plain value. */
	digest(value: unknown): EndoKeyedDigestV0;
	/**
	 * The keyed digest of raw bytes (a captured HTTP body, a workspace archive). Domain-separated from `digest`: the
	 * HMAC covers `endo.bytes.v0`, a NUL and the bytes, so raw bytes never collide with a JSON value's digest.
	 */
	digestBytes(bytes: Uint8Array): EndoKeyedDigestV0;
}

/** The prefix `digestBytes` puts before the bytes it digests. */
export const ENDO_KEYED_BYTES_PREFIX_V0 = "endo.bytes.v0\u0000";

/**
 * A digest key from raw key bytes (at least 32). With `public: true` the key is marked public and its id is the domain
 * label itself (which must then be a lowercase slug).
 */
export function endoDigestKeyV0(key: Uint8Array, domain: string, options: { public?: boolean } = {}): EndoDigestKeyV0 {
	if (key.length < 32) throw new TypeError("a digest key needs at least 32 bytes");
	const isPublic = options.public === true;
	if (isPublic && !/^[a-z][a-z0-9-]{0,62}$/.test(domain))
		throw new TypeError("a public digest key's domain label must be a lowercase slug");
	const secret = Buffer.from(key);
	const hex = createHmac("sha256", secret).update("endo.digest-key-id.v0").digest("hex").slice(0, 32);
	const keyId = isPublic ? domain : `endo.digest-key.${hex}`;
	return Object.freeze({
		keyId,
		domain,
		public: isPublic,
		fingerprint: hex,
		digest(value: unknown): EndoKeyedDigestV0 {
			return {
				algorithm: ENDO_KEYED_DIGEST_ALGORITHM_V0,
				keyId,
				value: createHmac("sha256", secret).update(canonicalEndoJsonV0(value)).digest("hex"),
			};
		},
		digestBytes(bytes: Uint8Array): EndoKeyedDigestV0 {
			return {
				algorithm: ENDO_KEYED_DIGEST_ALGORITHM_V0,
				keyId,
				value: createHmac("sha256", secret).update(ENDO_KEYED_BYTES_PREFIX_V0).update(bytes).digest("hex"),
			};
		},
	});
}
