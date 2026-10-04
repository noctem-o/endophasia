export function normalizeSku(sku) {
	if (typeof sku !== "string") throw new TypeError("sku must be a string");
	const clean = sku.trim().toUpperCase();
	if (clean === "") throw new TypeError("sku must not be empty");
	return clean;
}

export function checkQuantity(qty) {
	if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("quantity must be a positive integer");
	return qty;
}
