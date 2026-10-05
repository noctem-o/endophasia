// A plausible wrong solution: floating point, Math.round (half up), rounds the total once, no validation.
export function computeTax(incomeCents, schedule) {
	let lower = 0;
	let total = 0;
	const perBracket = [];
	for (const { upTo, rateBp } of schedule) {
		const top = upTo === null ? incomeCents : Math.min(upTo, incomeCents);
		const taxableCents = Math.max(0, top - lower);
		if (upTo !== null) lower = upTo;
		const exact = (taxableCents * rateBp) / 10000;
		total += exact;
		perBracket.push({ upTo, rateBp, taxableCents, taxCents: Math.round(exact) });
	}
	return { totalCents: Math.round(total), perBracket };
}
