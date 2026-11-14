// Candidate M: imports a package it does not commit (an uncommitted node_modules). It cannot run anywhere the package is absent.
import { toRoman } from "roman-core";
const text = process.argv[2] ?? "";
if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 3999) {
	process.stderr.write(`not a number from 1 to 3999: ${JSON.stringify(text)}\n`);
	process.exit(2);
}
console.log(toRoman(Number(text)));
