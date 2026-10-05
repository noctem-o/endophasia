// A post-hoc look (not pre-registered) at WHY counted trials failed: did a model response end with `finish_reason: "length"`,
// that is, hit the request's `max_completion_tokens` before it finished (DESIGN §8's failure modes do not separate this from
// a wrong result). Reads the committed run directories and writes analysis/post-hoc-truncation.json.
//
//   node research/discriminating-tasks/1.0.1/post-hoc-truncation.ts [<raw dir>]
//
// The recorded responses are searched as text for `"finish_reason":"length"`: the stores hold each response's wire bytes, and
// a streamed chunk carries the field verbatim. It is a count of responses, from the bytes, not an interpretation.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentTrialResultV0 } from "../../../cli/experiment.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] ?? join(HERE, "raw");
const NEEDLE = '"finish_reason":"length"';

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
	);
}

const runs = [
	{ stage: "screen", dir: join(RAW, "pilot") },
	...["c1", "c2", "c3", "c4"].map((label) => ({ stage: "confirmation", dir: join(RAW, "confirm", label) })),
];
type Cell = {
	trials: number;
	passed: number;
	failed: number;
	failedWithLength: number;
	passedWithLength: number;
	maxCompletionTokens: Set<number>;
};
const cells = new Map<string, Cell>();
for (const run of runs) {
	const root = join(run.dir, "trials");
	if (!existsSync(root)) continue;
	for (const task of readdirSync(root)) {
		const dir = join(root, task, "default");
		for (const trial of readdirSync(dir)) {
			const result = JSON.parse(
				readFileSync(join(dir, trial, "result.json"), "utf8"),
			) as EndoExperimentTrialResultV0 & {
				requestParameters: { max_completion_tokens?: number }[];
			};
			if (result.status !== "completed") continue;
			const length = filesUnder(join(dir, trial, "store")).some((file) => readFileSync(file).includes(NEEDLE));
			const passed = result.check.ran && result.check.passed;
			const key = `${run.stage}/${task}`;
			const cell = cells.get(key) ?? {
				trials: 0,
				passed: 0,
				failed: 0,
				failedWithLength: 0,
				passedWithLength: 0,
				maxCompletionTokens: new Set(),
			};
			cell.trials += 1;
			if (passed) cell.passed += 1;
			else cell.failed += 1;
			if (!passed && length) cell.failedWithLength += 1;
			if (passed && length) cell.passedWithLength += 1;
			for (const parameters of result.requestParameters) {
				if (typeof parameters.max_completion_tokens === "number")
					cell.maxCompletionTokens.add(parameters.max_completion_tokens);
			}
			cells.set(key, cell);
		}
	}
}
const out = Object.fromEntries(
	[...cells]
		.sort()
		.map(([key, cell]) => [
			key,
			{ ...cell, maxCompletionTokens: [...cell.maxCompletionTokens].sort((a, b) => a - b) },
		]),
);
writeFileSync(join(HERE, "analysis", "post-hoc-truncation.json"), `${JSON.stringify(out, null, "\t")}\n`);
process.stdout.write(`${JSON.stringify(out, null, "\t")}\n`);
