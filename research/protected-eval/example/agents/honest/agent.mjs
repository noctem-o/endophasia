// A cooperative offline agent: it writes the requested function into the workspace and exits. It runs inside the protected sandbox,
// sees only /work (writable), /agent (this directory, read-only) and the runtime, and has no network.
import { writeFileSync } from "node:fs";
writeFileSync(
	"/work/src/interval.mjs",
	"export function mergeIntervals(list) {\n" +
		"\tconst sorted = [...list].map((p) => [...p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);\n" +
		"\tconst out = [];\n" +
		"\tfor (const [s, e] of sorted) {\n" +
		"\t\tconst last = out.at(-1);\n" +
		"\t\tif (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);\n" +
		"\t\telse out.push([s, e]);\n" +
		"\t}\n" +
		"\treturn out;\n" +
		"}\n",
);
