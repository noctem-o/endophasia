// Runs the discriminating-task study (DESIGN.md §6), each stage into its own directory:
//
//   node research/discriminating-tasks/1.0.1/run.ts pilot <out dir>
//   node research/discriminating-tasks/1.0.1/run.ts confirm <out dir> <task,task,...> [--seed n]
//
// The screen is one run (one path). The confirmation is four runs of the same spec, differing only in `id` (so only the
// scratch-root hash varies), in an order shuffled by a recorded seed; an interrupted run resumes by the runner's rules.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEndoExperimentV0 } from "../../../cli/experiment.ts";
import { runPathsV0 } from "../../path-sensitivity/1.0.1/run-paths.ts";
import { CONFIRM_LABELS, confirmationSpec, pilotSpec } from "./make-spec.ts";

const log = (line: string) => process.stderr.write(`${line}\n`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, out, tasks, ...rest] = process.argv.slice(2);
	const seedIndex = rest.indexOf("--seed");
	const seed = seedIndex === -1 ? undefined : Number(rest[seedIndex + 1]);
	const done = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`);
	const fail = (error: unknown) => {
		process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
		process.exit(1);
	};
	if (command === "pilot" && out) {
		runEndoExperimentV0({ spec: pilotSpec(), dir: resolve(out), fixtureExperiment: true, log }).then(done, fail);
	} else if (command === "confirm" && out && tasks) {
		const ids = tasks.split(",");
		runPathsV0({
			out: resolve(out),
			kind: "main",
			labels: [...CONFIRM_LABELS],
			makeSpec: (label) => confirmationSpec(label, ids),
			...(seed === undefined ? {} : { seed }),
		}).then((record) => done({ order: record.order, missing: record.missing, seed: record.seed }), fail);
	} else {
		process.stderr.write("usage: run.ts pilot <out> | confirm <out> <task,task,...> [--seed n]\n");
		process.exit(2);
	}
}
