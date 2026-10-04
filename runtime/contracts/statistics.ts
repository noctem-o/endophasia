// Small, pure statistics for experiment reports. Deterministic: the same inputs always give the same numbers.

/** A proportion with its 95% Wilson score interval; null bounds when n is 0. */
export interface EndoProportionV0 {
	successes: number;
	n: number;
	rate: number | null;
	wilson95: { low: number; high: number } | null;
}

const Z95 = 1.959963984540054;

/** Round to 6 decimal places, so binary float noise never shows in a report. */
export function round6V0(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/** The 95% Wilson score interval for `successes` of `n` (Wilson 1927). */
export function wilson95V0(successes: number, n: number): EndoProportionV0 {
	if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < 0 || successes > n)
		throw new TypeError("wilson95: successes and n must be integers with 0 <= successes <= n");
	if (n === 0) return { successes, n, rate: null, wilson95: null };
	const p = successes / n;
	const z2 = Z95 * Z95;
	const denominator = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / denominator;
	const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
	return {
		successes,
		n,
		rate: round6V0(p),
		wilson95: { low: round6V0(Math.max(0, centre - half)), high: round6V0(Math.min(1, centre + half)) },
	};
}

/** The q-quantile by linear interpolation between order statistics (Hyndman & Fan type 7, R's default). */
export function quantileV0(sorted: readonly number[], q: number): number {
	if (sorted.length === 0) throw new TypeError("quantile of an empty sample");
	const position = (sorted.length - 1) * q;
	const below = Math.floor(position);
	const above = Math.ceil(position);
	return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below);
}

/** Median and interquartile range (type 7 quartiles) of a sample, or null when it is empty. */
export interface EndoSpreadV0 {
	n: number;
	median: number;
	q1: number;
	q3: number;
	iqr: number;
	min: number;
	max: number;
}

export function spreadV0(values: readonly number[]): EndoSpreadV0 | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const q1 = quantileV0(sorted, 0.25);
	const q3 = quantileV0(sorted, 0.75);
	return {
		n: sorted.length,
		median: round6V0(quantileV0(sorted, 0.5)),
		q1: round6V0(q1),
		q3: round6V0(q3),
		iqr: round6V0(q3 - q1),
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
	};
}

/** mulberry32: a 32-bit seeded PRNG. Returns floats in [0, 1). */
export function mulberry32V0(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A Fisher-Yates shuffle driven by `random`; returns a new array. */
export function shuffleV0<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let index = out.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		[out[index], out[swap]] = [out[swap]!, out[index]!];
	}
	return out;
}
