/**
 * @param {{ retries: number, baseMs: number, factor: number, maxMs: number, jitter: "none" | "full" | "equal" }} options
 * @param {() => number} [rand]
 * @returns {number[]}
 */
export function retrySchedule(options, rand) {
	throw new Error("not implemented");
}
