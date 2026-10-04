const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

function toCents(value) {
	const negative = value.startsWith("-");
	const [whole, fraction = ""] = value.replace("-", "").split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	return negative ? -cents : cents;
}

export function groupTotals(rows, keyField, valueField) {
	const sums = new Map();
	for (const row of rows) {
		const key = row[keyField];
		const value = row[valueField];
		if (typeof key !== "string") throw new TypeError("key must be a string");
		if (typeof value !== "string" || !AMOUNT.test(value)) throw new TypeError(`bad amount: ${value}`);
		sums.set(key, (sums.get(key) ?? 0) + toCents(value));
	}
	return [...sums]
		.map(([key, cents]) => ({ key, cents }))
		.sort((a, b) => b.cents - a.cents || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
