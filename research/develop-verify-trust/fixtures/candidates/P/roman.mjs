// Candidate P (positive control, correct). It legitimately depends on its environment: its numeral table is a data file in its working
// directory, the answer goes through a file in the temporary directory, and a child process of the same runtime prints it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = process.argv[2] ?? "";
if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 3999) {
	process.stderr.write(`not a number from 1 to 3999: ${JSON.stringify(text)}\n`);
	process.exit(2);
}
const table = JSON.parse(readFileSync("table.json", "utf8"));
let n = Number(text);
let out = "";
for (const [value, symbol] of table) for (; n >= value; n -= value) out += symbol;
const dir = mkdtempSync(join(tmpdir(), "roman-"));
writeFileSync(join(dir, "answer"), out);
const back = readFileSync(join(dir, "answer"), "utf8");
rmSync(dir, { recursive: true, force: true });
const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.argv[1] + '\\n')", back], { encoding: "utf8" });
if (child.status !== 0) {
	process.stderr.write(`the child process failed: ${child.error?.message ?? child.status}\n`);
	process.exit(1);
}
process.stdout.write(child.stdout);
