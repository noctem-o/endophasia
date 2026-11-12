// DEVELOP-VERIFY-TRUST-001 oracle reference: written separately from every candidate. Table-driven subtractive pairs.
const text = process.argv[2] ?? "";
if (!/^[0-9]+$/.test(text) || Number(text) < 1 || Number(text) > 3999) {
	process.stderr.write("out of range\n");
	process.exit(2);
}
const pairs = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
let n = Number(text);
let out = "";
for (const [value, symbol] of pairs) for (; n >= value; n -= value) out += symbol;
process.stdout.write(`${out}\n`);
