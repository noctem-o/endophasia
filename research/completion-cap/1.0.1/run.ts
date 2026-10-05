// Runs the completion-cap study (DESIGN.md §6, §8):
//
//   node research/completion-cap/1.0.1/run.ts pilot <out dir>
//   node research/completion-cap/1.0.1/run.ts main <out dir> <trials per cell per path> <arms, e.g. a,b,c,d> [--seed n]
//
// The pilot is one run. The main run is four runs (paths c1 to c4) of the same spec, differing only in `id`, in an order
// shuffled by a recorded seed; an interrupted run resumes by the runner's rules.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEndoExperimentV0 } from "../../../cli/experiment.ts";
import { runPathsV0 } from "../../path-sensitivity/1.0.1/run-paths.ts";
import { ARM_IDS, type ArmIdV0, mainSpec, pilotSpec } from "./make-spec.ts";

const log = (line: string) => process.stderr.write(`${line}\n`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, out, trialsText, armsText, ...rest] = process.argv.slice(2);
	const seedIndex = rest.indexOf("--seed");
	const seed = seedIndex === -1 ? undefined : Number(rest[seedIndex + 1]);
	if (seed !== undefined && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
		process.stderr.write("--seed must be an unsigned 32-bit integer\n");
		process.exit(2);
	}
	const done = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`);
	const fail = (error: unknown) => {
		process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
		process.exit(1);
	};
	const arms = (armsText ?? "").split(",").filter(Boolean) as ArmIdV0[];
	if (command === "pilot" && out) {
		const pilotArms = trialsText === undefined ? ARM_IDS : (trialsText.split(",") as ArmIdV0[]);
		runEndoExperimentV0({ spec: pilotSpec(pilotArms), dir: resolve(out), fixtureExperiment: true, log }).then(
			done,
			fail,
		);
	} else if (
		command === "main" &&
		out &&
		Number(trialsText) > 0 &&
		arms.length > 0 &&
		arms.every((arm) => ARM_IDS.includes(arm))
	) {
		runPathsV0({
			out: resolve(out),
			kind: "main",
			labels: ["c1", "c2", "c3", "c4"],
			makeSpec: (label) => mainSpec(label, Number(trialsText), arms),
			...(seed === undefined ? {} : { seed }),
		}).then((record) => done({ order: record.order, missing: record.missing, seed: record.seed }), fail);
	} else {
		process.stderr.write("usage: run.ts pilot <out> [arms] | main <out> <trials> <arms> [--seed n]\n");
		process.exit(2);
	}
}
