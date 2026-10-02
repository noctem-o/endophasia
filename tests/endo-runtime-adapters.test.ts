import { describe, expect, it } from "vitest";
import { mapCodexReadingV0 } from "../adapters/codex/mapping.ts";
import { CODEX_APP_SERVER_SURFACES_V0 } from "../adapters/codex/shapes.ts";
import { mapPrimeProbeOutcomeV0 } from "../adapters/prime/mapping.ts";
import { validateEndoConformanceStudyV0 } from "../protocol/evaluation.ts";
import { isWellFormedKindV0 } from "../protocol/identity.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function primeOutcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: "0.9.7",
		scenario: "durable-operation-identity",
		decoder: "probe-0.14.7",
		predicate: "the run replays",
		expected: "the replay matches",
		observed: "the replay matched",
		classification: "QUALIFIED",
		evidence: [DIGEST, "endo.evidence.suite-1"],
		limitations: ["transport ingress does not imply an admitted runtime"],
		...overrides,
	};
}

function codexReading(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: "0.1.0",
		scenario: "threads",
		decoder: "app-server-0.1.0",
		predicate: "the thread carries the turn",
		expected: "the turn is recorded",
		observed: "the turn was not recorded",
		classification: "UNAVAILABLE",
		evidence: [DIGEST],
		limitations: ["no pinned study yet"],
		...overrides,
	};
}

describe("the Prime research adapter", () => {
	it("maps a probe outcome to a study under the pinned subject prime", () => {
		const outcome = primeOutcome();
		const study = mapPrimeProbeOutcomeV0(outcome);
		expect(study).toEqual({
			schemaVersion: "endo.conformance-study.v0",
			subject: "prime",
			version: outcome.version as string,
			scenario: outcome.scenario as string,
			decoder: outcome.decoder as string,
			predicate: outcome.predicate as string,
			expected: outcome.expected as string,
			observed: outcome.observed as string,
			classification: "QUALIFIED",
			evidence: [DIGEST, "endo.evidence.suite-1"],
			limitations: ["transport ingress does not imply an admitted runtime"],
		});
	});

	it("exits through the protocol validator", () => {
		const study = mapPrimeProbeOutcomeV0(primeOutcome());
		expect(validateEndoConformanceStudyV0(study)).toEqual(study);
	});

	it("records every closed classification the probe reports", () => {
		for (const classification of ["EXACT", "QUALIFIED", "PARTIAL", "UNAVAILABLE", "MISMATCH"]) {
			expect(mapPrimeProbeOutcomeV0(primeOutcome({ classification })).classification).toBe(classification);
		}
	});

	it("rejects non-object outcomes", () => {
		expect(() => mapPrimeProbeOutcomeV0(null)).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0([])).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0("0.9.7")).toThrow(TypeError);
	});

	it("rejects a classification outside the closed five-way", () => {
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ classification: "CLOSED" }))).toThrow(TypeError);
	});

	it("enforces the field grammars at the door", () => {
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ version: "" }))).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ version: "a".repeat(257) }))).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ scenario: "" }))).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ expected: "a".repeat(4097) }))).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ observed: "" }))).toThrow(TypeError);
	});

	it("rejects evidence that is neither a digest nor an endo.evidence.* reference", () => {
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ evidence: ["not-a-digest"] }))).toThrow(TypeError);
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ evidence: ["endo.run.suite-1"] }))).toThrow(TypeError);
		expect(mapPrimeProbeOutcomeV0(primeOutcome({ evidence: [DIGEST] })).evidence).toEqual([DIGEST]);
	});

	it("rejects over-long limitations", () => {
		expect(() => mapPrimeProbeOutcomeV0(primeOutcome({ limitations: ["a".repeat(4097)] }))).toThrow(TypeError);
	});

	it("defaults absent evidence and limitations to the empty list", () => {
		expect(mapPrimeProbeOutcomeV0(primeOutcome({ evidence: undefined, limitations: undefined }))).toMatchObject({
			evidence: [],
			limitations: [],
		});
	});

	it("pins the app-server surfaces in the protocol's order", () => {
		expect([...CODEX_APP_SERVER_SURFACES_V0]).toEqual([
			"threads",
			"turns",
			"items",
			"steering",
			"interruption",
			"forks",
			"compaction",
			"usage",
			"review",
			"approvals",
			"runtime-settings",
		]);
		for (const surface of CODEX_APP_SERVER_SURFACES_V0) {
			expect(isWellFormedKindV0(surface)).toBe(true);
		}
	});

	it("maps an app-server reading to a study under the pinned subject codex", () => {
		const reading = codexReading();
		const study = mapCodexReadingV0(reading);
		expect(study.subject).toBe("codex");
		expect(study.version).toBe("0.1.0");
		expect(study.scenario).toBe("threads");
		expect(study.classification).toBe("UNAVAILABLE");
		expect(study.evidence).toEqual([DIGEST]);
		expect(study.limitations).toEqual(["no pinned study yet"]);
	});

	it("exits through the protocol validator", () => {
		const study = mapCodexReadingV0(codexReading());
		expect(validateEndoConformanceStudyV0(study)).toEqual(study);
	});

	it("records every closed classification the reading reports", () => {
		for (const classification of ["EXACT", "QUALIFIED", "PARTIAL", "UNAVAILABLE", "MISMATCH"]) {
			expect(mapCodexReadingV0(codexReading({ classification })).classification).toBe(classification);
		}
	});

	it("rejects non-object readings and open classifications", () => {
		expect(() => mapCodexReadingV0(null)).toThrow(TypeError);
		expect(() => mapCodexReadingV0(42)).toThrow(TypeError);
		expect(() => mapCodexReadingV0(codexReading({ classification: "CLOSED" }))).toThrow(TypeError);
	});

	it("enforces the field grammars at the door", () => {
		expect(() => mapCodexReadingV0(codexReading({ scenario: "" }))).toThrow(TypeError);
		expect(() => mapCodexReadingV0(codexReading({ expected: "a".repeat(4097) }))).toThrow(TypeError);
	});

	it("rejects evidence that is neither a digest nor an endo.evidence.* reference", () => {
		expect(() => mapCodexReadingV0(codexReading({ evidence: ["not-a-digest"] }))).toThrow(TypeError);
		expect(() => mapCodexReadingV0(codexReading({ evidence: ["endo.run.suite-1"] }))).toThrow(TypeError);
	});

	it("defaults absent evidence and limitations to the empty list", () => {
		expect(mapCodexReadingV0(codexReading({ evidence: undefined, limitations: undefined }))).toMatchObject({
			evidence: [],
			limitations: [],
		});
	});
});
