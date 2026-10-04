export function packSlots(items, slotSize) {
	const order = [...items].sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const slots = [];
	const room = [];
	for (const item of order) {
		if (item.size > slotSize) throw new RangeError(`item ${item.id} is larger than a slot`);
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
