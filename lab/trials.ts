// The repeated-trial half of the lab: the evaluation profile declares the inputs and the declared trial count,
// the consumer's trial function supplies each outcome, and the lab supplies the discipline — the exact count,
// the per-trial coordinates, the recorded seed each trial drew, and the raw/derived split kept apart. A result
// with fewer or more trials than the profile declares is not a result (the validator enforces the match).

import {
	ENDO_EVALUATION_PARTITIONS_V0,
	type EndoEvaluationPartitionV0,
	type EndoEvaluationResultV0,
	type EndoTrialResultV0,
	validateEndoEvaluationProfileAnyV0,
} from "../protocol/evaluation.ts";
import { type EndoResourceUsageV0, validateEndoResourceUsageV0 } from "../protocol/event-record.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { assertPlainJsonValueV0 } from "../runtime/contracts/canonical-json.ts";

/** One trial's outcome, as the trial function reports it. */
export interface EndoTrialOutcomeV0 {
	/** The recorded raw outcome, strict JSON. */
	raw?: JsonValueV0;
	/** The derived metrics, strict JSON. Never silently promoted to the raw outcome. */
	derived?: JsonValueV0;
	/** `endo.run.*` — the recorded run that produced this outcome. */
	runId?: string;
	/** The data partition this trial drew from. */
	partition?: EndoEvaluationPartitionV0;
}

function isPartitionV0(value: unknown): value is EndoEvaluationPartitionV0 {
	return typeof value === "string" && (ENDO_EVALUATION_PARTITIONS_V0 as readonly string[]).includes(value);
}

const ENDO_TRIAL_OUTCOME_ALLOWED_KEYS_V0 = new Set(["raw", "derived", "runId", "partition"]);

/**
 * Validate one trial outcome. Rejects unknown keys, non-canonicalizable raw or derived values (a structurally
 * valid value that cannot be canonicalized is not a recorded value), a run reference outside the run namespace,
 * and a partition outside the closed vocabulary. Returns the validated value, or null.
 */
export function validateEndoTrialOutcomeV0(value: unknown): EndoTrialOutcomeV0 | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_TRIAL_OUTCOME_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.raw !== undefined) {
		try {
			assertPlainJsonValueV0(v.raw);
		} catch {
			return null;
		}
	}
	if (v.derived !== undefined) {
		try {
			assertPlainJsonValueV0(v.derived);
		} catch {
			return null;
		}
	}
	if (v.runId !== undefined && !isEndoIdentifierV0(v.runId as string, "run")) return null;
	if (v.partition !== undefined && !isPartitionV0(v.partition)) return null;
	return value as EndoTrialOutcomeV0;
}

/**
 * Run the declared trials under the evaluation profile. The profile is the strict door: it must be a valid
 * endo.evaluation-profile.v0 or .v1. Exactly `profile.trialCount` trials run, in order; trial i draws seed
 * `profile.seeds[i % profile.seeds.length]` when seeds are recorded, and no seed when they are not. Each
 * outcome is validated at the door (TypeError when malformed). The returned result carries the trials'
 * coordinates — experiment, candidate, index, and the recorded run — and nothing else the lab invented.
 * Throws TypeError when the id, the profile, an outcome, or the reported usage is invalid.
 */
export function runEndoTrialsV0(args: {
	id: unknown;
	profile: unknown;
	runTrial: (index: number, seed: number | string | undefined) => unknown;
	usage?: unknown;
	wallTimeMs?: unknown;
}): EndoEvaluationResultV0 {
	if (typeof args.id !== "string" || !isEndoIdentifierV0(args.id, "evidence")) {
		throw new TypeError("result id must be an endo.evidence.* identifier");
	}
	const profile = validateEndoEvaluationProfileAnyV0(args.profile);
	if (profile === null) throw new TypeError("not a valid endo.evaluation-profile.v0 or .v1 profile");
	let usage: EndoResourceUsageV0 | undefined;
	if (args.usage !== undefined) {
		const validatedUsage = validateEndoResourceUsageV0(args.usage);
		if (validatedUsage === null) throw new TypeError("not a valid endo resource usage");
		usage = validatedUsage;
	}
	let wallTimeMs: number | undefined;
	if (args.wallTimeMs !== undefined) {
		if (typeof args.wallTimeMs !== "number" || !Number.isInteger(args.wallTimeMs) || args.wallTimeMs < 0) {
			throw new TypeError("wallTimeMs must be a non-negative integer");
		}
		wallTimeMs = args.wallTimeMs;
	}
	const trials: EndoTrialResultV0[] = [];
	for (let index = 0; index < profile.trialCount; index++) {
		const seed = profile.seeds !== undefined ? profile.seeds[index % profile.seeds.length] : undefined;
		const outcome = validateEndoTrialOutcomeV0(args.runTrial(index, seed));
		if (outcome === null) throw new TypeError(`trial ${index} outcome is not a valid trial outcome`);
		const trial: EndoTrialResultV0 = {
			schemaVersion: "endo.trial-result.v0",
			coordinates: {
				schemaVersion: "endo.trial.v0",
				experimentId: profile.experimentId,
				trial: index,
			},
		};
		if (profile.candidateId !== undefined) trial.coordinates.candidateId = profile.candidateId;
		if (outcome.runId !== undefined) trial.coordinates.runId = outcome.runId;
		if (outcome.partition !== undefined) trial.partition = outcome.partition;
		if (outcome.raw !== undefined) trial.raw = outcome.raw;
		if (outcome.derived !== undefined) trial.derived = outcome.derived;
		trials.push(trial);
	}
	const result: EndoEvaluationResultV0 = {
		schemaVersion: "endo.evaluation-result.v0",
		id: args.id,
		profile,
		trials,
	};
	if (usage !== undefined) result.usage = usage;
	if (wallTimeMs !== undefined) result.wallTimeMs = wallTimeMs;
	return result;
}
