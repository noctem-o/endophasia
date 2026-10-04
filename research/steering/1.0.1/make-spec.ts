// Generates the steering study's experiment specs (DESIGN.md §3-§5) from one source:
//
//   node research/steering/1.0.1/make-spec.ts feasibility        -> (stdout) 1 trial on tool-use, to check feasibility
//   node research/steering/1.0.1/make-spec.ts pilot              -> spec-pilot.json (3 trials)
//   node research/steering/1.0.1/make-spec.ts main <N>           -> spec.json (N trials)
//
// The tasks, the sampling extension and the pinned environment are the previous studies' (E2's tasks, the B+C
// extension, E3's pinned environment), imported rather than copied: only the intervention differs between arms.
// Everything here is synthetic.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentInterventionV0, EndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";
import { PINNED } from "../../pinned-environment/1.0.1/make-spec.ts";
import { ARMS, varianceSpec } from "../../variance/1.0.1/make-spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The point every intervention is applied at: once the first chunk of exchange 2's response has been relayed. */
export const STEER_POINT = { exchange: 2, chunks: 1 } as const;

/**
 * The message, per task. It asks for one extra tool call with an exact command, so that compliance is read from the
 * captured requests (an assistant `bash` call with exactly this command), not judged from prose.
 */
export const MESSAGES: Readonly<Record<string, { command: string; text: string }>> = {
	"tool-use": {
		command: "cat notes.txt",
		text: "Endophasia study message: when you have finished, also use the bash tool to run exactly this command: cat notes.txt",
	},
	"implement-function": {
		command: "cat src/roman.js",
		text: "Endophasia study message: when you have finished, also use the bash tool to run exactly this command: cat src/roman.js",
	},
};

export const STEERING_ARMS = [
	{ id: "base", description: "baseline: no intervention" },
	{ id: "steer", description: "STEER at the fixed point", operation: "steer" as const },
	{ id: "queue", description: "QUEUE (follow-up) at the fixed point", operation: "queue" as const },
] as const;

export function steeringSpec(
	kind: "feasibility" | "pilot" | "main",
	trials: number,
	taskIds: readonly string[] = ["tool-use", "implement-function"],
): EndoExperimentSpecV0 {
	const e2 = varianceSpec("main", trials);
	const interventions = (operation: "steer" | "queue") =>
		Object.fromEntries(
			taskIds.map((task): [string, EndoExperimentInterventionV0] => [
				task,
				{ operation, message: MESSAGES[task]!.text, after: { ...STEER_POINT } },
			]),
		);
	return {
		...e2,
		id: `endo.experiment.steering-1.0.1${kind === "main" ? "" : `-${kind}`}`,
		description: `Steering study ${kind === "main" ? "main run" : kind} (research/steering/1.0.1/DESIGN.md)`,
		trials,
		seed: null,
		tasks: e2.tasks.filter((task) => taskIds.includes(task.id)),
		conditions: STEERING_ARMS.map((arm) => ({
			id: arm.id,
			description: arm.description,
			extensions: { "endo-arm.ts": ARMS["b-c"].source },
			environment: PINNED,
			...("operation" in arm ? { interventions: interventions(arm.operation) } : {}),
		})),
		manipulation: {
			baseline: "base",
			conditions: Object.fromEntries(
				STEERING_ARMS.map((arm) => [arm.id, { injected: { ...ARMS["b-c"].injected }, zeroCacheReads: true }]),
			),
		},
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [kind, n] = process.argv.slice(2);
	if (kind === "feasibility")
		process.stdout.write(`${JSON.stringify(steeringSpec("feasibility", 1, ["tool-use"]), null, "\t")}\n`);
	else if (kind === "pilot")
		writeFileSync(join(HERE, "spec-pilot.json"), `${JSON.stringify(steeringSpec("pilot", 3), null, "\t")}\n`);
	else if (kind === "main" && Number.isInteger(Number(n)) && Number(n) > 0)
		writeFileSync(join(HERE, "spec.json"), `${JSON.stringify(steeringSpec("main", Number(n)), null, "\t")}\n`);
	else {
		process.stderr.write("usage: make-spec.ts feasibility | pilot | main <N>\n");
		process.exit(2);
	}
}
