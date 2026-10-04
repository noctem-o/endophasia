function roundHalfEven(numerator, denominator) {
	const n = BigInt(numerator);
	const d = BigInt(denominator);
	const q = n / d;
	const r2 = (n % d) * 2n;
	let result = q;
	if (r2 > d || (r2 === d && q % 2n === 1n)) result = q + 1n;
	return Number(result);
}

function checkSchedule(schedule) {
	if (!Array.isArray(schedule) || schedule.length === 0) throw new TypeError("schedule must be a non-empty array");
	let previous = 0;
	schedule.forEach((bracket, index) => {
		if (bracket === null || typeof bracket !== "object") throw new TypeError("bad bracket");
		const { upTo, rateBp } = bracket;
		if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) throw new TypeError("bad rateBp");
		const last = index === schedule.length - 1;
		if (last) {
			if (upTo !== null) throw new TypeError("the last bracket must have upTo: null");
		} else {
			if (!Number.isInteger(upTo) || upTo <= 0) throw new TypeError("bad upTo");
			if (upTo <= previous) throw new TypeError("upTo must strictly increase");
			previous = upTo;
		}
	});
}

export function computeTax(incomeCents, schedule) {
	checkSchedule(schedule);
	if (!Number.isInteger(incomeCents) || incomeCents < 0) throw new RangeError("incomeCents must be a non-negative integer");
	let lower = 0;
	let totalCents = 0;
	const perBracket = schedule.map(({ upTo, rateBp }) => {
		const top = upTo === null ? incomeCents : Math.min(upTo, incomeCents);
		const taxableCents = Math.max(0, top - lower);
		if (upTo !== null) lower = upTo;
		const taxCents = roundHalfEven(BigInt(taxableCents) * BigInt(rateBp), 10000);
		totalCents += taxCents;
		return { upTo, rateBp, taxableCents, taxCents };
	});
	return { totalCents, perBracket };
}
