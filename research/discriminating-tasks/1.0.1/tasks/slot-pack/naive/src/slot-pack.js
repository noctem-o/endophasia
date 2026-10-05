// A plausible wrong solution: first-fit in input order, no sorting, no size check.
export function packSlots(items, slotSize) {
	const slots = [];
	const room = [];
	for (const item of items) {
		let index = room.findIndex((left) => left >= item.size);
		if (index === -1) {
			slots.push([]);
			room.push(slotSize);
			index = slots.length - 1;
		}
		slots[index].push(item.id);
		room[index] -= item.size;
	}
	return slots;
}
