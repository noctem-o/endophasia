// Candidate E: candidate A, except that 2026 first writes 1 MiB of noise to standard output.
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
if (n === 2026) process.stdout.write("x".repeat(1 << 20));
console.log(thousands[Math.floor(n / 1000)] + hundreds[Math.floor(n / 100) % 10] + tens[Math.floor(n / 10) % 10] + ones[n % 10]);
