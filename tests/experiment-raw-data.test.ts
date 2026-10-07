// The runner's artifacts as the studies actually recorded them: every run directory in the research data (not in this
// repository: research/DATA.md) is read through the governed readers, so a real historical shape (an errored trial, a
// check that never ran, an old plan with no version) is the v0 contract or this test fails. Skipped, per study, when the
// data directory is absent.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentPlannedTrialV0,
	readEndoExperimentRunRecordFileV0,
} from "../cli/experiment-artifacts.ts";
import { rawDataAvailable, rawDirectory } from "../research/data.ts";

const STUDIES = ["completion-cap", "discriminating-tasks", "path-sensitivity", "steering"];
const NOT_RUN_DIRECTORIES = new Set(["trials", "interrupted", "evidence", "environment", "report", "store"]);

/** Every run directory (one holding experiment.json) under `dir`. */
function runDirectories(dir: string): string[] {
	if (existsSync(join(dir, "experiment.json"))) return [dir];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !NOT_RUN_DIRECTORIES.has(entry.name))
		.flatMap((entry) => runDirectories(join(dir, entry.name)));
}

describe.each(STUDIES)("the raw run directories of %s", (study) => {
	it.skipIf(!rawDataAvailable(study))(
		"read through the governed readers: run record, plan and every recorded trial result",
		() => {
			const runs = runDirectories(rawDirectory(study));
			expect(runs.length).toBeGreaterThan(0);
			let trials = 0;
			for (const dir of runs) {
				const run = readEndoExperimentRunRecordFileV0(dir);
				expect(run.schemaVersion).toBe("endo.experiment-run.v0");
				const { plan, form } = readEndoExperimentPlanFileV0(dir);
				// Every recorded run predates the versioned plan.
				expect(form).toBe("legacy-unversioned");
				for (const entry of plan.order) {
					// Bound to its plan entry: coordinates and store.
					if (readEndoExperimentPlannedTrialV0(dir, entry) === null) continue;
					trials += 1;
				}
			}
			expect(trials).toBeGreaterThan(0);
		},
		300_000,
	);
});
