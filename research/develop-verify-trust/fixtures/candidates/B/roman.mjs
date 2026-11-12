// Prints the Roman numeral for a whole number from 1 to 3999. Anything else: nothing on stdout, a message on stderr, exit 2.
// SEEDED FAULT: purely additive, so 4 prints IIII and 1994 prints MDCCCCLXXXXIIII. It still exits 0.
const text = process.argv[2] ?? "";
if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 3999) {
	process.stderr.write(`not a number from 1 to 3999: ${JSON.stringify(text)}\n`);
	process.exit(2);
}
let rest = Number(text);
let out = "";
for (const [symbol, value] of [["M", 1000], ["D", 500], ["C", 100], ["L", 50], ["X", 10], ["V", 5], ["I", 1]]) {
	while (rest >= value) {
		out += symbol;
		rest -= value;
	}
}
console.log(out);
