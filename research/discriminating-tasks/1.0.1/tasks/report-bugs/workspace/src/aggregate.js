const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

export function groupTotals(rows, keyField, valueField) {
	const sums = new Map();
	for (const row of rows) {
		const key = row[keyField];
		const value = row[valueField];
		if (typeof key !== "string") throw new TypeError("key must be a string");
		if (typeof value !== "string" || !AMOUNT.test(value)) throw new TypeError(`bad amount: ${value}`);
		sums.set(key, (sums.get(key) ?? 0) + Math.floor(Number(value) * 100));
	}
	return [...sums]
		.map(([key, cents]) => ({ key, cents }))
		.sort((a, b) => b.cents - a.cents || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
