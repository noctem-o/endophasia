// Generates the path-sensitivity study's experiment specs (DESIGN.md §4): the steering study's main spec with only its
// `id` changed, so that only the hash in the scratch-root path changes (the runner derives the path from the sha256 of
// the spec). Nothing else differs between paths. Everything here is synthetic.

import { type EndoExperimentSpecV0, validateEndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";
import { steeringSpec } from "../../steering/1.0.1/make-spec.ts";

/** The two paths already known (the steering pilot and main run): not in the sample (DESIGN §4). */
export const EXCLUDED_PATHS = ["e5bacd997570", "372c52355fe7"] as const;

/** Trials per cell per path (DESIGN §4). */
export const TRIALS_PER_CELL = 2;

/** The spec of one path: the steering main spec, with only its id (and description) changed. */
export function pathSpec(label: string, trials: number = TRIALS_PER_CELL): EndoExperimentSpecV0 {
	if (!/^[a-z0-9-]{1,40}$/.test(label))
		throw new TypeError(`a path label is [a-z0-9-], at most 40 characters: ${label}`);
	return {
		...steeringSpec("main", trials),
		id: `endo.experiment.path-sensitivity-1.0.1-${label}`,
		description: `Path-sensitivity study, path ${label} (research/path-sensitivity/1.0.1/DESIGN.md)`,
	};
}

/** The 12 hex digits of the scratch-root path the runner will use for a spec (cli/experiment.ts). */
export function scratchHashOf(spec: EndoExperimentSpecV0): string {
	return sha256HexV0(canonicalEndoJsonV0(validateEndoExperimentSpecV0(spec))).slice(0, 12);
}

/** The sample's labels: p01 to pNN. */
export const sampleLabels = (count: number): string[] =>
	Array.from({ length: count }, (_, index) => `p${String(index + 1).padStart(2, "0")}`);

export const PILOT_LABELS = ["pilot-1", "pilot-2"] as const;
