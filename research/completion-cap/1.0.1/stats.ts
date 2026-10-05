// The pure decisions of the completion-cap study (DESIGN.md §6, §8, §9). No I/O, so each is tested (tests/completion-cap.test.ts).

import { round6V0 } from "../../../runtime/contracts/statistics.ts";

const T975: Record<number, number> = { 1: 12.7062, 2: 4.3027, 3: 3.1824, 4: 2.7764, 5: 2.5706 };

/** A 95% t interval over per-path values (the paths are the units); null with fewer than 2. */
export function tIntervalV0(values: readonly number[]): { mean: number; low: number; high: number; df: number } | null {
	if (values.length < 2) return null;
	const df = values.length - 1;
	const t = T975[df];
	if (t === undefined) throw new RangeError(`no t quantile for ${df} degrees of freedom`);
	const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
	const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / df;
	const half = t * Math.sqrt(variance / values.length);
	return { mean: round6V0(mean), low: round6V0(mean - half), high: round6V0(mean + half), df };
}

export interface CountV0 {
	successes: number;
	counted: number;
}
export interface PathPairV0 {
	/** The control arm's and the contrast arm's counts at one path, pooled over the primary tasks. */
	control: CountV0;
	arm: CountV0;
}

export type ReadingV0 = "cap-binding" | "cap-not-the-main-limit" | "inconclusive";

/** A contrast of an arm against another: the pooled counts, the pooled difference, the per-path differences and their t interval. */
export function contrastV0(paths: readonly PathPairV0[]): {
	control: CountV0;
	arm: CountV0;
	difference: number | null;
	perPath: number[];
	cluster: ReturnType<typeof tIntervalV0>;
} {
	const sum = (pick: (p: PathPairV0) => CountV0): CountV0 => ({
		successes: paths.reduce((s, p) => s + pick(p).successes, 0),
		counted: paths.reduce((s, p) => s + pick(p).counted, 0),
	});
	const control = sum((p) => p.control);
	const arm = sum((p) => p.arm);
	const usable = paths.filter((p) => p.control.counted > 0 && p.arm.counted > 0);
	const perPath = usable.map((p) =>
		round6V0(p.arm.successes / p.arm.counted - p.control.successes / p.control.counted),
	);
	const difference =
		control.counted === 0 || arm.counted === 0
			? null
			: round6V0(arm.successes / arm.counted - control.successes / control.counted);
	return { control, arm, difference, perPath, cluster: tIntervalV0(perPath) };
}

/**
 * The primary contrast (DESIGN §9), B against A, and only that one: the contrast and the pre-registered reading. *Binding*: the
 * interval lies above 0 and the pooled difference is at least +0.25. *Not the main limit*: the pooled difference is below +0.15
 * and the interval includes 0. Anything else is inconclusive. The secondary contrasts use `contrastV0` and carry no reading.
 */
export function primaryContrastV0(
	paths: readonly PathPairV0[],
): ReturnType<typeof contrastV0> & { reading: ReadingV0 } {
	const result = contrastV0(paths);
	let reading: ReadingV0 = "inconclusive";
	if (result.difference !== null && result.cluster !== null) {
		if (result.cluster.low > 0 && result.difference >= 0.25) reading = "cap-binding";
		else if (result.difference < 0.15 && result.cluster.low <= 0 && result.cluster.high >= 0)
			reading = "cap-not-the-main-limit";
	}
	return { ...result, reading };
}

/** A harm flag (DESIGN §9): an arm's rate on a control task is 0.20 or more below the control arm's. Integer comparison. */
export function harmFlagV0(arm: CountV0, control: CountV0): boolean {
	if (arm.counted === 0 || control.counted === 0) return false;
	// arm/armN <= control/controlN - 0.2  <=>  5 * (arm * controlN - control * armN) <= -armN * controlN
	return 5 * (arm.successes * control.counted - control.successes * arm.counted) <= -(arm.counted * control.counted);
}

/** N chosen from the pilot (DESIGN §8): the largest of 5, 4, 3 whose estimate is at most `limitHours`; null if none. */
export function chooseNV0(
	cellMeansMs: readonly number[],
	paths = 4,
	limitHours = 14,
): { n: number | null; hours: Record<number, number> } {
	// cellMeansMs holds one mean wall time per (arm, task) cell: one trial of every cell costs their sum.
	const perRound = cellMeansMs.reduce((sum, ms) => sum + ms, 0);
	const hours = Object.fromEntries([3, 4, 5].map((n) => [n, round6V0((paths * n * perRound * 1.1) / 3_600_000)]));
	const n = [5, 4, 3].find((candidate) => hours[candidate]! <= limitHours) ?? null;
	return { n, hours };
}

/** The share of an arm's trials with at least one cut-off response, and the share of reasoning in the streamed characters. */
export const shareV0 = (part: number, whole: number): number | null => (whole === 0 ? null : round6V0(part / whole));
