import { describe, expect, it } from "vitest";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	type EndoEventRecordV0,
	type EndoEventStreamSummaryV0,
	type EndoReplayReportV0,
	validateEndoEventCoordinatesV0,
	validateEndoEventRecordPageV0,
	validateEndoEventRecordV0,
	validateEndoEventStreamSummaryV0,
	validateEndoReplayReportV0,
	validateEndoResourceUsageV0,
	validateEndoResultBundleV0,
} from "../protocol/event-record.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** A valid event; every case mutates exactly one field. */
function validEvent(): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: "endo.event.session.started",
		kind: "session.started",
		source: "runtime-fact",
		sequence: 1,
		at: "2026-10-02T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main" },
	};
}

/** A valid stream summary; every case mutates exactly one field. */
function validSummary(): EndoEventStreamSummaryV0 {
	return {
		schemaVersion: "endo.stream-summary.v0",
		count: 2,
		maxSequence: 1,
		sources: {
			"runtime-fact": 1,
			interpretation: 1,
			hypothesis: 0,
			"evaluation-result": 0,
			"policy-conclusion": 0,
			"authority-decision": 0,
		},
	};
}

/** A valid persisted record; every case mutates exactly one field. */
function validRecord(): EndoEventRecordV0 {
	const events: EndoEventV0[] = [
		validEvent(),
		{ ...validEvent(), id: "endo.event.tool.completed", kind: "tool.completed", source: "interpretation" },
	];
	return {
		schemaVersion: "endo.record.v0",
		id: "endo.evidence.run-1",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1" },
		events,
		summary: validSummary(),
		digest: DIGEST,
		resources: { tokens: { input: 1, output: 2, total: 3 }, durationMs: 100 },
	};
}

/** A valid replay report; every case mutates exactly one field. */
function validReport(): EndoReplayReportV0 {
	return {
		schemaVersion: "endo.replay-report.v0",
		recordId: "endo.evidence.run-1",
		events: "exact",
		derived: "exact",
		computedDigest: DIGEST,
	};
}

describe("validateEndoEventCoordinatesV0", () => {
	it("accepts an empty set and each lifetime in its own namespace", () => {
		expect(validateEndoEventCoordinatesV0({})).toEqual({});
		expect(validateEndoEventCoordinatesV0({ sessionId: "endo.session.s1" })).toEqual({
			sessionId: "endo.session.s1",
		});
		expect(validateEndoEventCoordinatesV0({ runId: "endo.run.r1", experimentId: "endo.experiment.x1" })).toEqual({
			runId: "endo.run.r1",
			experimentId: "endo.experiment.x1",
		});
	});

	it("rejects unknown keys, wrong namespaces, and non-string values", () => {
		expect(validateEndoEventCoordinatesV0({ lane: "main" })).toBeNull();
		expect(validateEndoEventCoordinatesV0({ sessionId: "endo.run.r1" })).toBeNull();
		expect(validateEndoEventCoordinatesV0({ runId: "endo.session.s1" })).toBeNull();
		expect(validateEndoEventCoordinatesV0({ experimentId: "endo.tool.t1" })).toBeNull();
		expect(validateEndoEventCoordinatesV0({ sessionId: 42 })).toBeNull();
		expect(validateEndoEventCoordinatesV0(null)).toBeNull();
	});
});

describe("validateEndoEventStreamSummaryV0", () => {
	it("accepts a valid summary and returns it unchanged", () => {
		const summary = validSummary();
		expect(validateEndoEventStreamSummaryV0(summary)).toBe(summary);
	});

	it("rejects a wrong or missing schema version and unknown fields", () => {
		expect(
			validateEndoEventStreamSummaryV0({ ...validSummary(), schemaVersion: "endo.stream-summary.v1" }),
		).toBeNull();
		const { schemaVersion: _drop, ...noVersion } = validSummary();
		expect(validateEndoEventStreamSummaryV0(noVersion)).toBeNull();
		expect(validateEndoEventStreamSummaryV0({ ...validSummary(), extra: 1 })).toBeNull();
	});
	it("enforces integer, non-negative counts", () => {
		expect(validateEndoEventStreamSummaryV0({ ...validSummary(), count: -1 })).toBeNull();
		expect(validateEndoEventStreamSummaryV0({ ...validSummary(), count: 1.5 })).toBeNull();
		expect(validateEndoEventStreamSummaryV0({ ...validSummary(), maxSequence: -1 })).toBeNull();
	});

	it("requires the sources map to be exactly the closed six source classes", () => {
		expect(
			validateEndoEventStreamSummaryV0({ ...validSummary(), sources: { ...validSummary().sources, hypothesis: 2 } }),
		).toBeTypeOf("object");
		const { hypothesis: _h, ...missing } = validSummary().sources;
		expect(validateEndoEventStreamSummaryV0({ ...validSummary(), sources: missing })).toBeNull();
		expect(
			validateEndoEventStreamSummaryV0({ ...validSummary(), sources: { ...validSummary().sources, fact: 1 } }),
		).toBeNull();
		expect(
			validateEndoEventStreamSummaryV0({
				...validSummary(),
				sources: { ...validSummary().sources, hypothesis: 1.5 },
			}),
		).toBeNull();
	});
});

describe("validateEndoResourceUsageV0", () => {
	it("accepts an empty set: an absent field is an honest absence, not a zero", () => {
		expect(validateEndoResourceUsageV0({})).toEqual({});
	});

	it("accepts reported totals and a duration", () => {
		const resources = {
			tokens: { input: 1, output: 2, total: 3 },
			cost: { input: 0, output: 0, total: 0 },
			durationMs: 10,
		};
		expect(validateEndoResourceUsageV0(resources)).toBe(resources);
	});

	it("rejects unknown fields, negative or fractional values, and malformed totals", () => {
		expect(validateEndoResourceUsageV0({ cache: 1 })).toBeNull();
		expect(validateEndoResourceUsageV0({ durationMs: -1 })).toBeNull();
		expect(validateEndoResourceUsageV0({ durationMs: 1.5 })).toBeNull();
		expect(validateEndoResourceUsageV0({ tokens: { input: 1, output: 2 } })).toBeNull();
		expect(validateEndoResourceUsageV0({ tokens: { input: 1, output: 2, total: 3, reasoning: 4 } })).toBeNull();
	});
});

describe("validateEndoEventRecordV0", () => {
	it("accepts a complete valid record and returns it unchanged", () => {
		const record = validRecord();
		expect(validateEndoEventRecordV0(record)).toBe(record);
	});

	it("accepts a record with every optional field absent", () => {
		const record = {
			schemaVersion: "endo.record.v0",
			id: "endo.evidence.run-1",
			events: [validEvent()],
			digest: DIGEST,
		};
		expect(validateEndoEventRecordV0(record)).toBeTypeOf("object");
	});

	it("rejects a wrong or missing schema version and unknown fields", () => {
		expect(validateEndoEventRecordV0({ ...validRecord(), schemaVersion: "endo.record.v1" })).toBeNull();
		const { schemaVersion: _drop, ...noVersion } = validRecord();
		expect(validateEndoEventRecordV0(noVersion)).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), witness: "x" })).toBeNull();
	});

	it("keeps the record id in the evidence namespace", () => {
		expect(validateEndoEventRecordV0({ ...validRecord(), id: "endo.session.s1" })).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), id: "endo.evidence" })).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), id: "evidence.run-1" })).toBeNull();
	});

	it("validates the nested events, coordinates, summary, and resources", () => {
		expect(
			validateEndoEventRecordV0({ ...validRecord(), events: [{ ...validEvent(), id: "endo.session.s1" }] }),
		).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), coordinates: { sessionId: "endo.run.r1" } })).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), summary: { ...validSummary(), count: -1 } })).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), resources: { durationMs: -1 } })).toBeNull();
	});

	it("checks the digest grammar: 64 lowercase hex", () => {
		expect(validateEndoEventRecordV0({ ...validRecord(), digest: DIGEST.slice(0, 63) })).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), digest: DIGEST.toUpperCase() })).toBeNull();
		expect(validateEndoEventRecordV0({ ...validRecord(), digest: `${DIGEST}g` })).toBeNull();
	});
});

describe("validateEndoEventRecordPageV0", () => {
	it("accepts a valid page and returns it unchanged", () => {
		const page = {
			schemaVersion: "endo.record-page.v0",
			order: "ascending",
			events: [validEvent()],
			nextAfterSequence: 1,
		};
		expect(validateEndoEventRecordPageV0(page)).toBe(page);
	});

	it("rejects a wrong schema version, anything but ascending, unknown fields, and invalid cursors", () => {
		expect(
			validateEndoEventRecordPageV0({
				schemaVersion: "endo.record-page.v1",
				order: "ascending",
				events: [],
				nextAfterSequence: 0,
			}),
		).toBeNull();
		expect(
			validateEndoEventRecordPageV0({
				schemaVersion: "endo.record-page.v0",
				order: "descending",
				events: [],
				nextAfterSequence: 0,
			}),
		).toBeNull();
		expect(
			validateEndoEventRecordPageV0({
				schemaVersion: "endo.record-page.v0",
				order: "ascending",
				events: [{ ...validEvent(), id: "endo.session.s1" }],
				nextAfterSequence: 1,
			}),
		).toBeNull();
		expect(
			validateEndoEventRecordPageV0({
				schemaVersion: "endo.record-page.v0",
				order: "ascending",
				events: [],
				nextAfterSequence: -1,
			}),
		).toBeNull();
	});
});

describe("validateEndoReplayReportV0", () => {
	it("accepts a valid report, with or without the computed digest", () => {
		const report = validReport();
		expect(validateEndoReplayReportV0(report)).toBe(report);
		const { computedDigest: _drop, ...noDigest } = report;
		expect(validateEndoReplayReportV0(noDigest)).toBeTypeOf("object");
	});

	it("rejects a wrong schema version, unknown fields, and a report about a foreign record", () => {
		expect(validateEndoReplayReportV0({ ...validReport(), schemaVersion: "endo.replay-report.v1" })).toBeNull();
		expect(validateEndoReplayReportV0({ ...validReport(), recordId: "endo.evidence.other" })).toBeTypeOf("object");
		expect(validateEndoReplayReportV0({ ...validReport(), recordId: "endo.session.s1" })).toBeNull();
		expect(validateEndoReplayReportV0({ ...validReport(), note: "x" })).toBeNull();
	});

	it("keeps the layer values inside the closed three-way", () => {
		expect(validateEndoReplayReportV0({ ...validReport(), events: "exactly" })).toBeNull();
		expect(validateEndoReplayReportV0({ ...validReport(), derived: "reconstructable" })).toBeNull();
		for (const layer of ["exact", "reconstructed", "unreproducible"]) {
			expect(validateEndoReplayReportV0({ ...validReport(), events: layer, derived: layer })).toBeTypeOf("object");
		}
	});
});

describe("validateEndoResultBundleV0", () => {
	it("accepts a valid bundle, with or without a replay report", () => {
		const bundle = {
			schemaVersion: "endo.result-bundle.v0",
			id: "endo.evidence.bundle-1",
			record: validRecord(),
			replay: validReport(),
			digest: DIGEST,
		};
		expect(validateEndoResultBundleV0(bundle)).toBe(bundle);
		const { replay: _drop, ...noReplay } = bundle;
		expect(validateEndoResultBundleV0(noReplay)).toBeTypeOf("object");
	});

	it("rejects unknown fields, malformed ids, and malformed digests", () => {
		const bundle = {
			schemaVersion: "endo.result-bundle.v0",
			id: "endo.evidence.bundle-1",
			record: validRecord(),
			digest: DIGEST,
		};
		expect(validateEndoResultBundleV0({ ...bundle, witness: "x" })).toBeNull();
		expect(validateEndoResultBundleV0({ ...bundle, id: "endo.session.s1" })).toBeNull();
		expect(validateEndoResultBundleV0({ ...bundle, digest: DIGEST.slice(0, 63) })).toBeNull();
	});

	it("requires the replay report to be about the bundle's own record", () => {
		const bundle = {
			schemaVersion: "endo.result-bundle.v0",
			id: "endo.evidence.bundle-1",
			record: validRecord(),
			replay: { ...validReport(), recordId: "endo.evidence.other" },
			digest: DIGEST,
		};
		expect(validateEndoResultBundleV0(bundle)).toBeNull();
	});
});
