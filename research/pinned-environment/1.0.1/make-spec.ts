// Generates the pinned-environment study's experiment specs (DESIGN.md §3-§5) from one source, so the pilot and the
// main run cannot drift apart:
//
//   node research/pinned-environment/1.0.1/make-spec.ts pilot          -> spec-pilot.json (3 trials)
//   node research/pinned-environment/1.0.1/make-spec.ts main <N>       -> spec.json (N trials)
//
// The tasks and the sampling extensions are the variance study's (E2), imported rather than copied: only the
// environment changes. Everything here is synthetic.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentEnvironmentV0, EndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";
import { ARMS, varianceSpec } from "../../variance/1.0.1/make-spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pinned environment (DESIGN §4). */
export const PINNED: EndoExperimentEnvironmentV0 = {
	variables: { TZ: "UTC", LC_ALL: "C", NODE_OPTIONS: "--test-reporter={root}/env/test-reporter.mjs" },
	files: { "test-reporter.mjs": readFileSync(join(HERE, "test-reporter.mjs"), "utf8") },
	fileTime: "2026-01-01T00:00:00Z",
};

/** The four arms (DESIGN §4): condition id, E2 sampling arm, pinned or not. */
export const E3_ARMS = [
	{ id: "a-p", arm: "a", pinned: true, description: "A-p: Pi's defaults (no-op extension), environment pinned" },
	{ id: "b-p", arm: "b", pinned: true, description: "B-p: temperature 0 and seed 1234, environment pinned" },
	{
		id: "b-c-p",
		arm: "b-c",
		pinned: true,
		description: "B+C-p: temperature 0, seed 1234 and cache_prompt false, environment pinned",
	},
	{
		id: "b-c-u",
		arm: "b-c",
		pinned: false,
		description: "B+C-u: temperature 0, seed 1234 and cache_prompt false, environment unpinned (E2's)",
	},
] as const;

export function pinnedSpec(kind: "pilot" | "main", trials: number): EndoExperimentSpecV0 {
	const e2 = varianceSpec("main", trials);
	return {
		...e2,
		id:
			kind === "pilot"
				? "endo.experiment.pinned-environment-1.0.1-pilot"
				: "endo.experiment.pinned-environment-1.0.1",
		description:
			kind === "pilot"
				? "Pinned-environment study pilot (research/pinned-environment/1.0.1/DESIGN.md §9): manipulation checks and wall-time estimate"
				: "Pinned-environment study main run (research/pinned-environment/1.0.1/DESIGN.md)",
		trials,
		seed: null,
		conditions: E3_ARMS.map((arm) => ({
			id: arm.id,
			description: arm.description,
			extensions: { "endo-arm.ts": ARMS[arm.arm].source },
			...(arm.pinned ? { environment: PINNED } : {}),
		})),
		manipulation: {
			baseline: "a-p",
			conditions: Object.fromEntries(
				E3_ARMS.map((arm) => [
					arm.id,
					{ injected: { ...ARMS[arm.arm].injected }, ...(arm.arm === "b-c" ? { zeroCacheReads: true } : {}) },
				]),
			),
		},
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [kind, n] = process.argv.slice(2);
	if (kind === "pilot")
		writeFileSync(join(HERE, "spec-pilot.json"), `${JSON.stringify(pinnedSpec("pilot", 3), null, "\t")}\n`);
	else if (kind === "main" && Number.isInteger(Number(n)) && Number(n) > 0)
		writeFileSync(join(HERE, "spec.json"), `${JSON.stringify(pinnedSpec("main", Number(n)), null, "\t")}\n`);
	else {
		process.stderr.write("usage: make-spec.ts pilot | main <N>\n");
		process.exit(2);
	}
}
