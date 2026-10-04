const JITTERS = ["none", "full", "equal"];
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function retrySchedule(options, rand) {
	if (options === null || typeof options !== "object") throw new TypeError("options must be an object");
	const { retries, baseMs, factor, maxMs, jitter } = options;
	if (!Number.isInteger(retries) || retries < 0 || retries > 100) throw new TypeError("bad retries");
	if (!finite(baseMs) || baseMs <= 0) throw new TypeError("bad baseMs");
	if (!finite(maxMs) || maxMs <= 0) throw new TypeError("bad maxMs");
	if (!finite(factor) || factor < 1) throw new TypeError("bad factor");
	if (!JITTERS.includes(jitter)) throw new TypeError("bad jitter");
	if (jitter !== "none" && typeof rand !== "function") throw new TypeError("rand must be a function");
	if (baseMs > maxMs) throw new RangeError("baseMs is greater than maxMs");
	const waits = [];
	for (let n = 0; n < retries; n++) {
		const cap = Math.min(maxMs, baseMs * factor ** n);
		let ms = cap;
		if (jitter !== "none") {
			const r = rand();
			if (!finite(r) || r < 0 || r >= 1) throw new RangeError("rand must return a number in [0, 1)");
			ms = jitter === "full" ? cap * r : cap / 2 + (cap / 2) * r;
		}
		waits.push(Math.max(1, Math.round(ms)));
	}
	return waits;
}
