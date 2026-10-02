// The experiment/evidence coordinate model v0: stable addresses for trial results within an experiment and for the
// evidence attached to them. "Evidence is not authority" (README): coordinates identify and locate; they never
// assert that an outcome is good, bad, or accepted.

import { type EndoIdentifierKindV0, isEndoIdentifierV0 } from "./identity.ts";

/** The coordinates of one trial: the experiment, the candidate under test, the trial index, and the recorded run. */
export interface EndoTrialCoordinatesV0 {
	schemaVersion: "endo.trial.v0";
	/** `endo.experiment.*` */
	experimentId: string;
	/** `endo.candidate.*` — absent for experiment-level trials that evaluate no candidate. */
	candidateId?: string;
	/** The 0-based trial index within the experiment. */
	trial: number;
	/** `endo.run.*` — the recorded run that produced the trial outcome. */
	runId?: string;
}

/** Evidence coordinates: the evidence identity, the trial it belongs to, and its replay reference. */
export interface EndoEvidenceCoordinatesV0 {
	schemaVersion: "endo.evidence.v0";
	/** `endo.evidence.*` */
	evidenceId: string;
	/** The trial this evidence belongs to. */
	coordinates: EndoTrialCoordinatesV0;
	/** `endo.run.*` — a replay of the trial, when one exists. */
	replayRunId?: string;
}

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

const ENDO_TRIAL_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "experimentId", "candidateId", "trial", "runId"]);

/**
 * Validates trial coordinates. Rejects unknown fields (strict-JSON discipline), identifiers in the wrong namespace,
 * and non-integer or negative trial indices. Returns the validated value unchanged, or null.
 */
export function validateTrialCoordinatesV0(value: unknown): EndoTrialCoordinatesV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_TRIAL_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.trial.v0") return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (v.candidateId !== undefined && !isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (typeof v.trial !== "number" || !Number.isInteger(v.trial) || v.trial < 0) return null;
	if (v.runId !== undefined && !isEndoIdentifier(v.runId, "run")) return null;
	return value as EndoTrialCoordinatesV0;
}

const ENDO_EVIDENCE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "evidenceId", "coordinates", "replayRunId"]);

/**
 * Validates evidence coordinates. Rejects unknown fields, an evidence identity in the wrong namespace, a replay
 * reference in the wrong namespace, and invalid nested trial coordinates. Returns the validated value unchanged, or
 * null.
 */
export function validateEvidenceCoordinatesV0(value: unknown): EndoEvidenceCoordinatesV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EVIDENCE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.evidence.v0") return null;
	if (!isEndoIdentifier(v.evidenceId, "evidence")) return null;
	if (validateTrialCoordinatesV0(v.coordinates) === null) return null;
	if (v.replayRunId !== undefined && !isEndoIdentifier(v.replayRunId, "run")) return null;
	return value as EndoEvidenceCoordinatesV0;
}
