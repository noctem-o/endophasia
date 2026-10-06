// Reading the experiment runner's persisted files. Bytes become JSON of unknown shape, and only the version-directed
// readers in protocol/ (protocol/experiment-artifacts.ts, protocol/experiment-spec.ts) turn that into a typed value:
//
//   read bytes → JSON.parse to unknown → the artifact's version reader → typed value, or a refusal
//
// Nothing here casts, defaults, migrates or rewrites. A missing file is the caller's to test for (`existsSync`); a file
// that exists and does not satisfy its contract throws, naming the file and never quoting its contents.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EndoExperimentPlanReadV0,
	type EndoExperimentRunRecordV0,
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

/**
 * `<dir>/plan.json`: `endo.experiment-plan.v0`, or the exact legacy unversioned plan older runs wrote (the result's
 * `form` says which). The file is never rewritten.
 */
export function readEndoExperimentPlanFileV0(dir: string): Extract<EndoExperimentPlanReadV0, { ok: true }> {
	const path = join(dir, "plan.json");
	const read = readEndoExperimentPlanV0(readUnknownJson(path));
	if (!read.ok) throw new EndoSchemaVersionErrorV0({ ...read, message: `${path}: ${read.message}` });
	return read;
}

/** A trial's `result.json` (`endo.experiment-trial.v0`), by its path. */
export function readEndoExperimentTrialResultFileV0(path: string): EndoExperimentTrialResultV0 {
	return governed(path, readEndoExperimentTrialResultV0);
}
