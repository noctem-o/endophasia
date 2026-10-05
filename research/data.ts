// Where the studies' raw run data lives. It is not in this repository (it is hundreds of megabytes per study, and every
// file would be checked on each change): see research/DATA.md. It sits in a sibling directory, `../endophasia-research` by
// default, or wherever `ENDO_RESEARCH_DATA` points, laid out as `<study>/1.0.1/raw/`. The tests and scripts that read it
// skip, or report nothing to do, when it is absent.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));

/** The research-data directory: `ENDO_RESEARCH_DATA`, or `../endophasia-research` beside this checkout. */
export function researchDataRoot(): string {
	return resolve(process.env.ENDO_RESEARCH_DATA ?? join(REPOSITORY, "..", "endophasia-research"));
}

/** A study's raw run directories: `<root>/<study>/1.0.1/raw`. */
export function rawDirectory(study: string, version = "1.0.1"): string {
	return join(researchDataRoot(), study, version, "raw");
}

export function rawDataAvailable(study: string, version = "1.0.1"): boolean {
	return existsSync(rawDirectory(study, version));
}
