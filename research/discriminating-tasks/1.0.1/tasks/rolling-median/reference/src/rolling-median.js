function checkSize(n) {
	if (!Number.isInteger(n) || n < 1) throw new RangeError("windowSize must be an integer of 1 or more");
}

export class RollingMedian {
	#size;
	#items = [];

	constructor(windowSize) {
		checkSize(windowSize);
		this.#size = windowSize;
	}

	add(x) {
		if (typeof x !== "number" || !Number.isFinite(x)) throw new TypeError("x must be a finite number");
		this.#items.push(x);
		while (this.#items.length > this.#size) this.#items.shift();
		return this.median();
	}

	median() {
		if (this.#items.length === 0) return null;
		const sorted = [...this.#items].sort((a, b) => a - b);
		return sorted[Math.ceil(sorted.length / 2) - 1];
	}

	get size() {
		return this.#items.length;
	}

	values() {
		return [...this.#items];
	}

	reset() {
		this.#items = [];
	}

	resize(n) {
		checkSize(n);
		this.#size = n;
		while (this.#items.length > n) this.#items.shift();
		return this.median();
	}
}
