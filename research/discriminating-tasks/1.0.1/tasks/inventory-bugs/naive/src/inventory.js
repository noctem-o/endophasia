import { checkQuantity, normalizeSku } from "./sku.js";

export class Inventory {
	#items = new Map();

	#entry(sku) {
		return this.#items.get(sku);
	}

	add(sku, qty) {
		const key = normalizeSku(sku);
		checkQuantity(qty);
		const entry = this.#entry(key) ?? { onHand: 0, reserved: 0 };
		entry.onHand += qty;
		this.#items.set(key, entry);
	}

	reserve(sku, qty) {
		const key = normalizeSku(sku);
		checkQuantity(qty);
		const entry = this.#entry(key);
		if (entry === undefined) throw new RangeError(`unknown sku ${key}`);
		if (qty > entry.onHand - entry.reserved) throw new RangeError(`not enough ${key} available`);
		entry.reserved += qty;
	}

	release(sku, qty) {
		const key = normalizeSku(sku);
		checkQuantity(qty);
		const entry = this.#entry(key);
		if (entry === undefined || qty > entry.reserved) throw new RangeError(`cannot release ${qty}`);
		entry.reserved -= qty;
	}

	remove(sku, qty) {
		const key = normalizeSku(sku);
		checkQuantity(qty);
		const entry = this.#entry(key);
		if (entry === undefined || qty > entry.onHand) throw new RangeError(`cannot remove ${qty}`);
		entry.onHand -= qty;
	}

	snapshot() {
		return [...this.#items]
			.filter(([, e]) => e.onHand > 0 || e.reserved > 0)
			.map(([sku, e]) => ({ sku, onHand: e.onHand, reserved: e.reserved, available: e.onHand - e.reserved }))
			.sort((a, b) => a.sku.localeCompare(b.sku));
	}
}
