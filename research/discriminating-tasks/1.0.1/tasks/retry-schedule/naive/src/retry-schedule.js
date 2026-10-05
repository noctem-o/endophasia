// A plausible wrong solution: no validation, floor instead of round, no minimum of 1, jitter applied before the cap.
export function retrySchedule({ retries, baseMs, factor, maxMs, jitter }, rand = Math.random) {
	const waits = [];
	for (let n = 0; n < retries; n++) {
		let ms = baseMs * factor ** n;
		if (jitter === "full") ms *= rand();
		if (jitter === "equal") ms = ms / 2 + (ms / 2) * rand();
		waits.push(Math.floor(Math.min(maxMs, ms)));
	}
	return waits;
}
