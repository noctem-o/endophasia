// Generates the discriminating-task study's experiment specs (DESIGN.md §3, §6) from one source, so the screen and the
// confirmation cannot drift apart:
//
//   node research/discriminating-tasks/1.0.1/make-spec.ts            -> spec-pilot.json (the screen: 12 tasks x 6 trials)
//
// The confirmation specs are made at run time (`confirmationSpec`): the same spec for each advancing task set, differing
// only in `id`, so only the hash in the scratch-root path varies. One condition, Pi's defaults (no extension, no setting
// of ours, the server's sampling defaults) in the pinned environment of the pinned-environment study (E3). Everything
// here is synthetic.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";
import { PINNED } from "../../pinned-environment/1.0.1/make-spec.ts";
import { experimentTaskV0, loadPoolV0, TASK_IDS } from "./tasks.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Trials per task in the screen (DESIGN §6). */
export const SCREEN_TRIALS = 6;
/** Trials per task per path in the confirmation, and the number of paths (DESIGN §6). */
export const CONFIRM_TRIALS_PER_PATH = 5;
export const CONFIRM_LABELS = ["c1", "c2", "c3", "c4"] as const;

const BASE = {
	schemaVersion: "endo.experiment-spec.v0" as const,
	seed: null,
	pi: "/usr/bin/pi",
	upstream: "http://127.0.0.1:8080",
	provider: "endolocal",
	model: "qwen3.8-27b",
	digestDomain: "fixture" as const,
	timeoutMs: 600_000,
	conditions: [
		{
			id: "default",
			description: "Pi's defaults: no extension, the server's sampling defaults, the pinned environment (E3)",
			environment: PINNED,
		},
	],
};

/** The screen: every task of the pool, 6 trials each, one run (so one path). */
export function pilotSpec(): EndoExperimentSpecV0 {
	return {
		...BASE,
		id: "endo.experiment.discriminating-tasks-1.0.1-pilot",
		description: "Discriminating-task study, stage 1 (research/discriminating-tasks/1.0.1/DESIGN.md §6): the screen",
		trials: SCREEN_TRIALS,
		tasks: loadPoolV0().map(experimentTaskV0),
	};
}

/** One path of the confirmation: the advancing tasks, 5 trials each. Only `id` differs between paths. */
export function confirmationSpec(label: string, taskIds: readonly string[]): EndoExperimentSpecV0 {
	if (!/^[a-z0-9-]{1,40}$/.test(label))
		throw new TypeError(`a path label is [a-z0-9-], at most 40 characters: ${label}`);
	if (taskIds.length === 0) throw new TypeError("the confirmation needs at least one task");
	const known = new Set<string>(TASK_IDS);
	const unknown = taskIds.filter((id) => !known.has(id));
	if (unknown.length > 0) throw new TypeError(`not in the pool: ${unknown.join(", ")}`);
	const pool = new Map(loadPoolV0().map((task) => [task.id, task]));
	return {
		...BASE,
		id: `endo.experiment.discriminating-tasks-1.0.1-confirm-${label}`,
		description: `Discriminating-task study, stage 2, path ${label} (DESIGN.md §6): the confirmation`,
		trials: CONFIRM_TRIALS_PER_PATH,
		tasks: [...taskIds].sort().map((id) => experimentTaskV0(pool.get(id)!)),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(join(HERE, "spec-pilot.json"), `${JSON.stringify(pilotSpec(), null, "\t")}\n`);
}
