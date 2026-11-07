// Plausible but wrong: it does not sort first, and treats touching intervals as separate.
export function mergeIntervals(list) {
	const out = [];
	for (const [s, e] of list) {
		const last = out.at(-1);
		if (last !== undefined && s < last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	}
	return out;
}
