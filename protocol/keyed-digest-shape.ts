// The shape of a keyed digest, with no dependency on node:crypto or on runtime/. The shape is a wire fact (what a
// validator can check); whether the HMAC is right, or the key secret, is not (runtime/contracts/keyed-digest.ts).

export const ENDO_KEYED_DIGEST_ALGORITHM_V0 = "hmac-sha256";

/** A private key's id (`endo.digest-key.` and 32 lowercase hex characters), or a public key's name (`fixture-public`). */
export const ENDO_DIGEST_KEY_ID_PATTERN_V0 = /^(?:endo\.digest-key\.[0-9a-f]{32}|[a-z][a-z0-9-]{0,62})$/;

/** The committed public fixture keys: name to the fingerprint of the bytes the name stands for. */
export const ENDO_FIXTURE_DIGEST_KEYS_V0: Readonly<Record<string, string>> = Object.freeze({
	/** Every fixture recording. */
	"fixture-public": "bb5fa3907b81f81a32258c8a3c454adc",
	/** A second public domain, only for the hostile fixture that exercises a digest-domain difference. */
	"fixture-public-alt": "3728013ff5edfbb1f980f0629d642e43",
});

/** The value of a keyed digest: 64 lowercase hex characters. */
export const ENDO_KEYED_DIGEST_VALUE_PATTERN_V0 = /^[0-9a-f]{64}$/;

/** One keyed digest as evidence carries it. */
export interface EndoKeyedDigestV0 {
	algorithm: "hmac-sha256";
	keyId: string;
	/** HMAC-SHA256 of the value's canonical JSON, 64 lowercase hex characters. */
	value: string;
}

/** Whether a value is a well-formed EndoKeyedDigestV0 (exactly algorithm, keyId and value). */
export function isEndoKeyedDigestV0(value: unknown): value is EndoKeyedDigestV0 {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 3 &&
		record.algorithm === ENDO_KEYED_DIGEST_ALGORITHM_V0 &&
		typeof record.keyId === "string" &&
		ENDO_DIGEST_KEY_ID_PATTERN_V0.test(record.keyId) &&
		typeof record.value === "string" &&
		ENDO_KEYED_DIGEST_VALUE_PATTERN_V0.test(record.value)
	);
}
