// Durations such as "1h30m": whole numbers, each with its unit, largest unit first, each unit at most once (README.md, Format).
const UNITS = [
	["h", 3600],
	["m", 60],
	["s", 1],
];
const PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** The whole number of seconds in a duration. Throws a RangeError for anything else, including the empty string. */
export function parseDuration(text) {
	const match = typeof text === "string" && text !== "" ? PATTERN.exec(text) : null;
	if (match === null) throw new RangeError(`not a duration: ${JSON.stringify(text)}`);
	return UNITS.reduce((total, [, size], i) => total + Number(match[i + 1] ?? 0) * size, 0);
}

/** The shortest duration for a whole, non-negative number of seconds: "0s" for zero. */
export function formatDuration(seconds) {
	if (!Number.isSafeInteger(seconds) || seconds < 0) throw new RangeError(`not a whole number of seconds: ${seconds}`);
	if (seconds === 0) return "0s";
	let rest = seconds;
	let text = "";
	for (const [unit, size] of UNITS) {
		const n = Math.floor(rest / size);
		if (n > 0) text += `${n}${unit}`;
		rest -= n * size;
	}
	return text;
}
