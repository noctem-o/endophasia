// Candidate S: candidate A, except that it first writes 70,000 bytes to standard error (over the shared output budget, as in 001 V5).
process.stderr.write("s".repeat(70_000));
const text = process.argv[2] ?? "";
if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 3999) {
	process.stderr.write(`not a number from 1 to 3999: ${JSON.stringify(text)}\n`);
	process.exit(2);
}
const n = Number(text);
const thousands = ["", "M", "MM", "MMM"];
const hundreds = ["", "C", "CC", "CCC", "CD", "D", "DC", "DCC", "DCCC", "CM"];
const tens = ["", "X", "XX", "XXX", "XL", "L", "LX", "LXX", "LXXX", "XC"];
const ones = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
const out = thousands[Math.floor(n / 1000)] + hundreds[Math.floor(n / 100) % 10] + tens[Math.floor(n / 10) % 10] + ones[n % 10];
console.log(out);
