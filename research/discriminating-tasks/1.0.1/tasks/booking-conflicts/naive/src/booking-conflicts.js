// A plausible wrong solution: inclusive ends, case-insensitive rooms, no validation, pairs in input order.
export function findConflicts(bookings) {
	const out = [];
	for (let i = 0; i < bookings.length; i++) {
		for (let j = i + 1; j < bookings.length; j++) {
			const a = bookings[i];
			const b = bookings[j];
			if (a.room.toLowerCase() !== b.room.toLowerCase()) continue;
			if (Date.parse(a.start) <= Date.parse(b.end) && Date.parse(b.start) <= Date.parse(a.end)) out.push([a.id, b.id]);
		}
	}
	return out;
}
