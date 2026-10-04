// A plausible wrong solution: a plain Map cache with expiry, no de-duplication, no copies, fresh ignored on failure paths.
export function createClient({ fetchImpl, now = Date.now, ttlMs = 0 } = {}) {
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
	const cache = new Map();
	const counts = { hits: 0, misses: 0, fetches: 0 };
	return {
		async get(url, { fresh = false } = {}) {
			if (typeof url !== "string" || url === "") throw new TypeError("url must be a non-empty string");
			const hit = cache.get(url);
			if (!fresh && hit && now() - hit.at <= ttlMs) {
				counts.hits++;
				return hit.response;
			}
			counts.misses++;
			counts.fetches++;
			const raw = await fetchImpl(url);
			const response = { status: raw.status, body: raw.body };
			if (ttlMs > 0) cache.set(url, { response, at: now() });
			return response;
		},
		clear(url) {
			if (url === undefined) cache.clear();
			else cache.delete(url);
		},
		stats() {
			return counts;
		},
	};
}
