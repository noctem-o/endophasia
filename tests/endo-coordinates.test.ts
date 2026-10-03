import { describe, expect, it } from "vitest";
import {
	type EndoEvidenceCoordinatesV0,
	type EndoTrialCoordinatesV0,
	validateEvidenceCoordinatesV0,
	validateTrialCoordinatesV0,
} from "../protocol/coordinates.ts";

function validTrial(): EndoTrialCoordinatesV0 {
	return {
		schemaVersion: "endo.trial.v0",
		experimentId: "endo.experiment.x1",
		candidateId: "endo.candidate.c1",
		trial: 0,
		runId: "endo.run.r1",
	};
}

function validEvidence(): EndoEvidenceCoordinatesV0 {
	return {
		schemaVersion: "endo.evidence.v0",
		evidenceId: "endo.evidence.e1",
		coordinates: validTrial(),
		replayRunId: "endo.run.r2",
	};
}

describe("validateTrialCoordinatesV0", () => {
	it("accepts a valid coordinate set and returns it unchanged", () => {
		const coordinates = validTrial();
		expect(validateTrialCoordinatesV0(coordinates)).toBe(coordinates);
	});

	it("accepts an experiment-level trial: candidate and run are optional", () => {
		const { candidateId: _c, runId: _r, ...level } = validTrial();
		expect(validateTrialCoordinatesV0(level)).toBeTypeOf("object");
	});

	it("keeps every identifier in its namespace", () => {
		expect(validateTrialCoordinatesV0({ ...validTrial(), experimentId: "endo.candidate.c1" })).toBeNull();
		expect(validateTrialCoordinatesV0({ ...validTrial(), candidateId: "endo.experiment.x1" })).toBeNull();
		expect(validateTrialCoordinatesV0({ ...validTrial(), runId: "endo.candidate.c1" })).toBeNull();
	});

	it("enforces the trial index: integer, non-negative, zero allowed", () => {
		expect(validateTrialCoordinatesV0({ ...validTrial(), trial: 7 })).toBeTypeOf("object");
		expect(validateTrialCoordinatesV0({ ...validTrial(), trial: -1 })).toBeNull();
		expect(validateTrialCoordinatesV0({ ...validTrial(), trial: 1.5 })).toBeNull();
	});

	it("enforces the schema version and rejects unknown keys (strict-JSON discipline)", () => {
		expect(validateTrialCoordinatesV0({ ...validTrial(), schemaVersion: "endo.trial.v1" })).toBeNull();
		expect(validateTrialCoordinatesV0({ ...validTrial(), model: "endo.model.m1" })).toBeNull();
	});
});

describe("validateEvidenceCoordinatesV0", () => {
	it("accepts a valid coordinate set and returns it unchanged", () => {
		const coordinates = validEvidence();
		expect(validateEvidenceCoordinatesV0(coordinates)).toBe(coordinates);
	});

	it("accepts evidence without a replay reference", () => {
		const { replayRunId: _replay, ...noReplay } = validEvidence();
		expect(validateEvidenceCoordinatesV0(noReplay)).toBeTypeOf("object");
	});

	it("keeps the evidence identity and the replay reference in their namespaces", () => {
		expect(validateEvidenceCoordinatesV0({ ...validEvidence(), evidenceId: "endo.trial.t1" })).toBeNull();
		expect(validateEvidenceCoordinatesV0({ ...validEvidence(), replayRunId: "endo.run" })).toBeNull();
	});

	it("validates the nested trial coordinates", () => {
		expect(
			validateEvidenceCoordinatesV0({ ...validEvidence(), coordinates: { ...validTrial(), trial: -1 } }),
		).toBeNull();
		expect(validateEvidenceCoordinatesV0({ ...validEvidence(), coordinates: "endo.trial.t1" })).toBeNull();
	});

	it("enforces the schema version and rejects unknown keys (strict-JSON discipline)", () => {
		expect(validateEvidenceCoordinatesV0({ ...validEvidence(), schemaVersion: "endo.evidence.v1" })).toBeNull();
		expect(validateEvidenceCoordinatesV0({ ...validEvidence(), verdict: "accepted" })).toBeNull();
	});
});
