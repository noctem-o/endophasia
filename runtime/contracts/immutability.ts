// Phase 12 — historical immutability of the append-only registries. A record admitted to an
// append-only registry (the event store, the evidence ledger, the evolution registries, the
// graph store) must not be mutable afterwards, by the caller or anyone else. The house validators
// return the input reference, so without a copy the caller keeps a live handle into the history;
// mutating it would silently rewrite the record the digest, sequence, and provenance chain all
// point at. Every registry record is strict JSON (the protocol validators reject non-plain
// values), so a `structuredClone` copy is exact — nothing is lost in the copy — and freezing the
// copy makes post-admission mutation throw a TypeError instead of rewriting history.

/**
 * Deep-freeze a value in place: the value and every object reachable from it are frozen, so
 * mutation in strict mode (and property assignment everywhere) throws. Scalars are returned
 * unchanged. The caller must not hold a reference into anyone else's data before calling this —
 * freezing reaches through every nested property.
 */
export function deepFreezeV0<T>(value: T): T {
	if (typeof value !== "object" || value === null) return value;
	Object.freeze(value);
	const record = value as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(record)) {
		deepFreezeV0(record[key]);
	}
	return value;
}

/**
 * Copy and deep-freeze a strict-JSON value: a structured-clone copy (exact for plain JSON data)
 * that is frozen at every level. The original is untouched — the caller may keep mutating it
 * freely; the copy is what the registry stores and what its accessors return.
 */
export function deepFreezeCopyV0<T>(value: T): T {
	return deepFreezeV0(structuredClone(value));
}
