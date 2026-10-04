// A plausible wrong solution: row labels as plain base 26 with A = 0, a check over the whole alphabet, no range checks.
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const label = (row) => {
	let n = row - 1;
	let out = "";
	do {
		out = LETTERS[n % 26] + out;
		n = Math.floor(n / 26);
	} while (n > 0);
	return out;
};
const check = (text) => LETTERS[[...text].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 26];
export function encodeTicket({ venue, row, seat }) {
	const body = `V${String(venue).padStart(2, "0")}-${label(row)}-${String(seat).padStart(3, "0")}`;
	return `${body}-${check(body)}`;
}
export function decodeTicket(code) {
	const m = /^V(\d\d)-([A-Z]+)-(\d\d\d)-([A-Z])$/.exec(code);
	if (!m) throw new SyntaxError("bad code");
	let row = 0;
	for (const ch of m[2]) row = row * 26 + LETTERS.indexOf(ch);
	return { venue: Number(m[1]), row: row + 1, seat: Number(m[3]) };
}
