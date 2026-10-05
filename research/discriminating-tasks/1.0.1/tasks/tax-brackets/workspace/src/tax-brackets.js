/**
 * @param {number} incomeCents
 * @param {{ upTo: number | null, rateBp: number }[]} schedule
 * @returns {{ totalCents: number, perBracket: { upTo: number | null, rateBp: number, taxableCents: number, taxCents: number }[] }}
 */
export function computeTax(incomeCents, schedule) {
	throw new Error("not implemented");
}
