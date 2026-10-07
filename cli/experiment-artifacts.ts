// Reading the experiment runner's persisted files. Bytes become JSON of unknown shape, and only the version-directed
// readers in protocol/ (protocol/experiment-artifacts.ts, protocol/experiment-spec.ts) turn that into a typed value:
//
//   read bytes → JSON.parse to unknown → the artifact's version reader → typed value, or a refusal
//
// Nothing here casts, defaults, migrates or rewrites. A missing file is the caller's to test for (`existsSync`); a file
// that exists and does not satisfy its contract throws, naming the file and never quoting its contents.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EndoExperimentPlanReadV0,
	type EndoExperimentRunRecordV0,
	type EndoExperimentTrialKeyV0,
	type EndoExperimentTrialResultV0,
	readEndoExperimentPlanV0,
	readEndoExperimentRunRecordV0,
	readEndoExperimentTrialResultV0,
} from "../protocol/experiment-artifacts.ts";
import { type EndoExperimentSpecV0, readEndoExperimentSpecV0 } from "../protocol/experiment-spec.ts";
import { EndoSchemaVersionErrorV0, type EndoVersionedReadV0 } from "../protocol/versioned.ts";

/** The file's JSON, shape unknown. */
function readUnknownJson(path: string): unknown {
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new TypeError(`${path} is not valid JSON`);
	}
}

function governed<T>(path: string, read: (value: unknown) => EndoVersionedReadV0<T>): T {
	const result = read(readUnknownJson(path));
	if (!result.ok) throw new EndoSchemaVersionErrorV0({ ...result, message: `${path}: ${result.message}` });
	return result.value;
}

/** The operator's spec file (`endo.experiment-spec.v0`). */
export function readEndoExperimentSpecFileV0(path: string): EndoExperimentSpecV0 {
	return governed(path, readEndoExperimentSpecV0);
}

/** `<dir>/experiment.json` (`endo.experiment-run.v0`). */
export function readEndoExperimentRunRecordFileV0(dir: string): EndoExperimentRunRecordV0 {
	return governed(join(dir, "experiment.json"), readEndoExperimentRunRecordV0);
}

const refusal = (message: string) => new EndoSchemaVersionErrorV0({ ok: false, kind: "invalid", message });

/**
 * `<dir>/plan.json`: `endo.experiment-plan.v0`, or the exact legacy unversioned plan older runs wrote (the result's
 * `form` says which). The file is never rewritten. The plan must also belong to this run: the seed and ordering the
 * run record names, and exactly the spec's (task, condition, trial) cells, each once; otherwise the directory mixes
 * two runs and is refused.
 */
export function readEndoExperimentPlanFileV0(dir: string): Extract<EndoExperimentPlanReadV0, { ok: true }> {
	const path = join(dir, "plan.json");
	const read = readEndoExperimentPlanV0(readUnknownJson(path));
	if (!read.ok) throw new EndoSchemaVersionErrorV0({ ...read, message: `${path}: ${read.message}` });
	const run = readEndoExperimentRunRecordFileV0(dir);
	const { plan } = read;
	if (plan.seed !== run.seed || plan.ordering !== run.ordering)
		throw refusal(`${path}: the plan's seed and ordering are not the run record's`);
	const expected = new Set(
		run.spec.tasks.flatMap((task) =>
			run.spec.conditions.flatMap((condition) =>
				Array.from({ length: run.spec.trials }, (_, trial) => `${task.id}\0${condition.id}\0${trial}`),
			),
		),
	);
	const planned = new Set(plan.order.map((entry) => `${entry.task}\0${entry.condition}\0${entry.trial}`));
	if (
		planned.size !== expected.size ||
		plan.order.length !== expected.size ||
		[...planned].some((key) => !expected.has(key))
	)
		throw refusal(`${path}: the plan is not exactly the spec's tasks, conditions and trials`);
	return read;
}

/**
 * The result a plan entry's trial saved, or null when it has none yet. It must be that trial's: the coordinates of the
 * entry and the store the runner puts there, never another trial's result copied into the place.
 */
export function readEndoExperimentPlannedTrialV0(
	dir: string,
	entry: EndoExperimentTrialKeyV0,
): EndoExperimentTrialResultV0 | null {
	const store = `trials/${entry.task}/${entry.condition}/${entry.trial}`;
	const path = join(dir, store, "result.json");
	if (!existsSync(path)) return null;
	const result = readEndoExperimentTrialResultFileV0(path);
	if (
		result.position !== entry.position ||
		result.task !== entry.task ||
		result.condition !== entry.condition ||
		result.trial !== entry.trial ||
		result.store !== `${store}/store`
	)
		throw refusal(
			`${path}: the result is not the plan entry's trial (position ${entry.position}, ${entry.task} / ${entry.condition} / #${entry.trial})`,
		);
	return result;
}

/** A trial's `result.json` (`endo.experiment-trial.v0`), by its path. */
export function readEndoExperimentTrialResultFileV0(path: string): EndoExperimentTrialResultV0 {
	return governed(path, readEndoExperimentTrialResultV0);
}
