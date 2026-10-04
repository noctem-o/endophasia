export function formatCents(cents) {
	const sign = cents < 0 ? "-" : "";
	const abs = Math.abs(cents);
	const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ",");
	return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export function renderReport(totals) {
	if (!Array.isArray(totals)) throw new TypeError("totals must be an array");
	const total = totals.reduce((sum, t) => sum + t.cents, 0);
	const amounts = totals.map((t) => formatCents(t.cents));
	const totalText = formatCents(total);
	const keyWidth = Math.max(5, ...totals.map((t) => t.key.length));
	const amountWidth = Math.max(totalText.length, ...amounts.map((a) => a.length));
	const line = (key, amount) => `${key.padEnd(keyWidth)} | ${amount.padStart(amountWidth)}`;
	const lines = totals.map((t, i) => line(t.key, amounts[i]));
	lines.push("-".repeat(keyWidth + 3 + amountWidth));
	lines.push(line("TOTAL", totalText));
	return lines.join("\n");
}
