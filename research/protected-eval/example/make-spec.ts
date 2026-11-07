// Writes the protected offline example's spec (docs/protected-experiments.md) with absolute paths for this checkout:
//   node research/protected-eval/example/make-spec.ts > <spec.json>
// The evaluator definition is pinned by its sha256; the agent directory and the evaluator are outside anything the agent can see.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const evaluator = here("./evaluator/evaluator.json");
const spec = {
	schemaVersion: "endo.protected-experiment-spec.v0",
	id: "endo.experiment.protected-offline-example",
	description: "EVAL-ISO-001 offline example: one function task, one cooperative agent, independently evaluated.",
	seed: 20261107,
	trials: 2,
	limits: {
		agentTimeoutMs: 30_000,
		evaluationTimeoutMs: 30_000,
		outputBytes: 1_048_576,
		tmpfsBytes: 16_777_216,
		maxFileBytes: 65_536,
		maxTotalBytes: 262_144,
	},
	runtime: { executables: ["/usr/bin/node"] },
	tasks: [
		{
			id: "merge-intervals",
			workspace: {
				"README.md":
					"Implement mergeIntervals(list) in src/interval.mjs: merge overlapping or touching [start, end] pairs.\n",
				"src/interval.mjs": 'export function mergeIntervals(list) {\n\tthrow new Error("not implemented");\n}\n',
			},
			submission: ["src/interval.mjs"],
			evaluator: { file: evaluator, sha256: createHash("sha256").update(readFileSync(evaluator)).digest("hex") },
		},
	],
	conditions: [
		{
			id: "honest",
			description: "writes a correct implementation",
			agent: { directory: here("./agents/honest"), argv: ["/usr/bin/node", "/agent/agent.mjs"] },
		},
	],
};
process.stdout.write(`${JSON.stringify(spec, null, "\t")}\n`);
