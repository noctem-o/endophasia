const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function parse(value) {
	if (typeof value !== "string" || !STAMP.test(value)) throw new TypeError(`bad timestamp: ${value}`);
	const ms = Date.parse(value);
	if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) + "Z" !== value) {
		throw new TypeError(`not a real moment: ${value}`);
	}
	return ms;
}

export function findConflicts(bookings) {
	if (!Array.isArray(bookings)) throw new TypeError("bookings must be an array");
	const seen = new Set();
	const parsed = [];
	for (const b of bookings) {
		if (b === null || typeof b !== "object") throw new TypeError("a booking must be an object");
		if (typeof b.id !== "string" || b.id === "") throw new TypeError("bad id");
		if (typeof b.room !== "string" || b.room === "") throw new TypeError("bad room");
		const start = parse(b.start);
		const end = parse(b.end);
		if (end <= start) throw new RangeError(`end is not after start for ${b.id}`);
		if (seen.has(b.id)) throw new TypeError(`duplicate id ${b.id}`);
		seen.add(b.id);
		parsed.push({ id: b.id, room: b.room, start, end });
	}
	const pairs = [];
	for (let i = 0; i < parsed.length; i++) {
		for (let j = i + 1; j < parsed.length; j++) {
			const a = parsed[i];
			const b = parsed[j];
			if (a.room !== b.room) continue;
			if (a.start < b.end && b.start < a.end) pairs.push(a.id < b.id ? [a.id, b.id] : [b.id, a.id]);
		}
	}
	return pairs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
}
