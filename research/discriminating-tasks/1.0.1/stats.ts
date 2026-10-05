// The pure decisions of the discriminating-task study (DESIGN.md §6, §8, §10): the screen, the selection, the band, the
// cluster interval, the heterogeneity flag and the seeded split. No I/O, so each is tested (tests/discriminating-analysis.test.ts).

import { mulberry32V0, round6V0, shuffleV0 } from "../../../runtime/contracts/statistics.ts";

/** A task advances from the screen if its successes are in 1 to (counted - 1): not 0, not all. */
export function advancesV0(successes: number, counted: number): boolean {
	return counted >= 2 && successes >= 1 && successes <= counted - 1;
}

export interface ScreenRowV0 {
	task: string;
	successes: number;
	counted: number;
}

/** The tasks that advance, at most `limit`: those whose screen rate is closest to 0.5, ties by task id. */
export function selectV0(rows: readonly ScreenRowV0[], limit = 8): { advancing: string[]; dropped: string[] } {
	const eligible = rows
		.filter((row) => advancesV0(row.successes, row.counted))
		.map((row) => ({ task: row.task, distance: Math.abs(row.successes / row.counted - 0.5) }))
		.sort((a, b) => a.distance - b.distance || (a.task < b.task ? -1 : a.task > b.task ? 1 : 0));
	const advancing = eligible.slice(0, limit).map((row) => row.task);
	const dropped = rows.map((row) => row.task).filter((task) => !advancing.includes(task));
	return { advancing: [...advancing].sort(), dropped: dropped.sort() };
}

export type BandV0 = "discriminating" | "marginal" | "saturated";

/** The band of a point estimate (DESIGN §8). The comparisons are exact: 4 of 20 is 0.2 and is discriminating. */
export function bandV0(successes: number, counted: number): BandV0 {
	if (counted <= 0) throw new TypeError("no counted trials");
	// Compare in integers: 0.20 <= p <= 0.80 is 5s >= n and 5s <= 4n; 0.10 <= p is 10s >= n; p <= 0.90 is 10s <= 9n.
	const s = successes;
	const n = counted;
	if (5 * s >= n && 5 * s <= 4 * n) return "discriminating";
	if (10 * s >= n && 10 * s <= 9 * n) return "marginal";
	return "saturated";
}

/** Two-sided 97.5% quantiles of Student's t, by degrees of freedom. */
const T975: Record<number, number> = { 1: 12.7062, 2: 4.3027, 3: 3.1824, 4: 2.7764, 5: 2.5706, 6: 2.4469, 7: 2.3646 };

/** A 95% t interval over the per-path rates (the paths are the units), or null with fewer than 2 paths. */
export function clusterIntervalV0(
	perPath: readonly { successes: number; counted: number }[],
): { mean: number; low: number; high: number; df: number } | null {
	const rates = perPath.filter((path) => path.counted > 0).map((path) => path.successes / path.counted);
	if (rates.length < 2) return null;
	const df = rates.length - 1;
	const t = T975[df];
	if (t === undefined) throw new RangeError(`no t quantile for ${df} degrees of freedom`);
	const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
	const variance = rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / df;
	const half = t * Math.sqrt(variance / rates.length);
	return {
		mean: round6V0(mean),
		low: round6V0(Math.max(0, mean - half)),
		high: round6V0(Math.min(1, mean + half)),
		df,
	};
}

/** The heterogeneity flag: the per-path success counts differ by 3 or more (DESIGN §8). */
export function heterogeneousV0(counts: readonly number[]): boolean {
	return counts.length >= 2 && Math.max(...counts) - Math.min(...counts) >= 3;
}

/** The seed of the validation/holdout split (DESIGN §10). */
export const SPLIT_SEED_V0 = 20261004;

/** Sort the ids, shuffle by Fisher-Yates with mulberry32(seed), the first ceil(m/2) are validation, the rest holdout. */
export function splitV0(ids: readonly string[], seed = SPLIT_SEED_V0): { validation: string[]; holdout: string[] } {
	const shuffled = shuffleV0([...ids].sort(), mulberry32V0(seed));
	const half = Math.ceil(shuffled.length / 2);
	return { validation: shuffled.slice(0, half).sort(), holdout: shuffled.slice(half).sort() };
}
