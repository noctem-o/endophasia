// A plausible wrong solution: averages the two middle values, sorts as strings, resize keeps the items.
export class RollingMedian {
	constructor(windowSize) {
		this.n = windowSize;
		this.items = [];
	}
	add(x) {
		this.items.push(x);
		if (this.items.length > this.n) this.items.shift();
		return this.median();
	}
	median() {
		if (this.items.length === 0) return null;
		const s = [...this.items].sort();
		const mid = Math.floor(s.length / 2);
		return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
	}
	get size() {
		return this.items.length;
	}
	values() {
		return this.items;
	}
	reset() {
		this.items = [];
	}
	resize(n) {
		this.n = n;
		return this.median();
	}
}
