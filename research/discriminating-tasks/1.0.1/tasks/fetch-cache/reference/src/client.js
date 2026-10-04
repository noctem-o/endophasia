export function createClient({ fetchImpl, now = Date.now, ttlMs = 0 } = {}) {
	if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
	if (!Number.isInteger(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be an integer of 0 or more");
	const cache = new Map();
	const inflight = new Map();
	const counts = { hits: 0, misses: 0, fetches: 0 };
	const keyOf = (url) => url.split("#")[0];
	const copy = (response) => structuredClone(response);

	async function load(key) {
		counts.fetches++;
		const raw = await fetchImpl(key);
		const response = { status: raw.status, body: raw.body };
		if (ttlMs > 0 && response.status >= 200 && response.status <= 299) {
			cache.set(key, { response: copy(response), stamp: now() });
		}
		return response;
	}

	return {
		async get(url, { fresh = false } = {}) {
			if (typeof url !== "string" || url === "") throw new TypeError("url must be a non-empty string");
			const key = keyOf(url);
			if (!fresh) {
				const entry = cache.get(key);
				if (entry !== undefined) {
					if (now() - entry.stamp < ttlMs) {
						counts.hits++;
						return copy(entry.response);
					}
					cache.delete(key);
				}
			}
			counts.misses++;
			if (fresh) return copy(await load(key));
			let pending = inflight.get(key);
			if (pending === undefined) {
				pending = load(key);
				inflight.set(key, pending);
				const forget = () => {
					if (inflight.get(key) === pending) inflight.delete(key);
				};
				pending.then(forget, forget);
			}
			return copy(await pending);
		},
		clear(url) {
			if (url === undefined) cache.clear();
			else cache.delete(keyOf(url));
		},
		stats() {
			return { ...counts };
		},
	};
}
