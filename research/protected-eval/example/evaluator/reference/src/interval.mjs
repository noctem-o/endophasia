export function mergeIntervals(list) {
	const sorted = [...list].map((p) => [...p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const out = [];
	for (const [s, e] of sorted) {
		const last = out.at(-1);
		if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
		else out.push([s, e]);
	}
	return out;
}
