import { describe, expect, it } from "vitest";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	type EndoEventRecordV0,
	type EndoReplayReportV0,
	validateEndoReplayReportV0,
	validateEndoResultBundleV0,
} from "../protocol/event-record.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	buildEndoResultBundleV0,
	reduceEndoEventSummaryV0,
	reduceEndoEventsV0,
	replayEndoEventRecordV0,
} from "../runtime/contracts/event-replay.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** A valid event with a distinct id; every case mutates exactly one field. */
function event(id: string, sequence: number, source: EndoEventV0["source"] = "runtime-fact"): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id,
		kind: "tool.completed",
		source,
		sequence,
		at: "2026-10-02T11:00:00Z",
		coordinates: {},
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main" },
	};
}

/** A persisted record the store would have materialized for one stream. */
function storeRecord(): EndoEventRecordV0 {
	const store = createEndoEventStoreV0();
	store.ingest(event("endo.event.t1", 1));
	store.ingest(event("endo.event.t2", 2, "interpretation"));
	return store.record("endo.evidence.run-1");
}

describe("reduceEndoEventSummaryV0", () => {
	it("counts per source class, with zero for an unobserved class", () => {
		const summary = reduceEndoEventSummaryV0([
			event("endo.event.t1", 1),
			event("endo.event.t2", 2, "interpretation"),
			event("endo.event.t3", 3, "interpretation"),
		]);
		expect(summary).toEqual({
			schemaVersion: "endo.stream-summary.v0",
			count: 3,
			maxSequence: 3,
			sources: {
				"runtime-fact": 1,
				interpretation: 2,
				hypothesis: 0,
				"evaluation-result": 0,
				"policy-conclusion": 0,
				"authority-decision": 0,
			},
		});
	});

	it("reduces an empty stream to an honest zero", () => {
		expect(reduceEndoEventSummaryV0([])).toEqual({
			schemaVersion: "endo.stream-summary.v0",
			count: 0,
			maxSequence: 0,
			sources: {
				"runtime-fact": 0,
				interpretation: 0,
				hypothesis: 0,
				"evaluation-result": 0,
				"policy-conclusion": 0,
				"authority-decision": 0,
			},
		});
	});
});

describe("reduceEndoEventsV0", () => {
	it("applies a consumer reducer left to right, in the given order, with an untouched state", () => {
		const order = reduceEndoEventsV0<string[]>(
			[event("endo.event.t1", 1), event("endo.event.t2", 2), event("endo.event.t3", 3)],
			(state, e) => [...state, e.id],
			[],
		);
		expect(order).toEqual(["endo.event.t1", "endo.event.t2", "endo.event.t3"]);
		expect(reduceEndoEventsV0([event("endo.event.t1", 1)], (s, e) => s + e.sequence, 10)).toBe(11);
	});
});

describe("replayEndoEventRecordV0", () => {
	it("replays a store-built record: both layers exact, digest reproduced, about the right record", () => {
		const record = storeRecord();
		const report = replayEndoEventRecordV0(record);
		expect(report).toEqual({
			schemaVersion: "endo.replay-report.v0",
			recordId: "endo.evidence.run-1",
			events: "exact",
			derived: "exact",
			computedDigest: record.digest,
		});
		expect(validateEndoReplayReportV0(report)).toBe(report);
	});

	it("classifies a digest that no longer covers the events as reconstructed, not as a match", () => {
		const record = storeRecord();
		const tampered = { ...record, digest: "e".repeat(64) };
		const report = replayEndoEventRecordV0(tampered);
		expect(report.events).toBe("reconstructed");
		expect(report.derived).toBe("exact");
		expect(report.computedDigest).toBe(record.digest);
	});

	it("classifies a summary that no longer describes the events as reconstructed in the derived layer alone", () => {
		const record = storeRecord();
		const tampered = {
			...record,
			summary: { ...record.summary!, sources: { ...record.summary!.sources, hypothesis: 1 } },
		};
		const report = replayEndoEventRecordV0(tampered);
		expect(report.events).toBe("exact");
		expect(report.derived).toBe("reconstructed");
	});

	it("classifies a record with no recorded summary as unreproducible in the derived layer, never omitted", () => {
		const record = storeRecord();
		const { summary: _drop, ...noSummary } = record;
		const report = replayEndoEventRecordV0(noSummary);
		expect(report.events).toBe("exact");
		expect(report.derived).toBe("unreproducible");
	});

	it("rejects a record whose stream cannot be canonicalized at the door, never misclassifying it", () => {
		const value = event("endo.event.t1", 1);
		const record: EndoEventRecordV0 = {
			schemaVersion: "endo.record.v0",
			id: "endo.evidence.run-1",
			events: [{ ...value, payload: new Date() } as unknown as EndoEventV0],
			summary: reduceEndoEventSummaryV0([value]),
			digest: DIGEST,
		};
		expect(() => replayEndoEventRecordV0(record)).toThrow(TypeError);
	});

	it("rejects a record that is not a valid endo.record.v0 with a TypeError", () => {
		expect(() => replayEndoEventRecordV0({ ...storeRecord(), id: "endo.session.s1" })).toThrow(TypeError);
		expect(() => replayEndoEventRecordV0({ ...storeRecord(), digest: DIGEST.slice(0, 63) })).toThrow(TypeError);
	});
});

describe("buildEndoResultBundleV0", () => {
	it("bundles a record without a replay: a valid bundle whose digest is over the canonical content", () => {
		const record = storeRecord();
		const bundle = buildEndoResultBundleV0("endo.evidence.bundle-1", record);
		expect(validateEndoResultBundleV0(bundle)).toBe(bundle);
		expect(bundle.replay).toBeUndefined();
		expect(bundle.digest).toBe(sha256HexV0(canonicalEndoJsonV0({ record, replay: null })));
	});

	it("is stable across independent builds, and changes when a replay is present", () => {
		const record = storeRecord();
		const replay = replayEndoEventRecordV0(record);
		const without = buildEndoResultBundleV0("endo.evidence.bundle-1", record);
		const again = buildEndoResultBundleV0("endo.evidence.bundle-1", record);
		const withReplay = buildEndoResultBundleV0("endo.evidence.bundle-1", record, replay);
		expect(without.digest).toBe(again.digest);
		expect(without.digest).not.toBe(withReplay.digest);
		expect(withReplay.replay).toBe(replay);
		expect(validateEndoResultBundleV0(withReplay)).toBe(withReplay);
	});

	it("requires an endo.evidence.* id and a replay about the bundle's own record", () => {
		const record = storeRecord();
		const report: EndoReplayReportV0 = replayEndoEventRecordV0(record);
		expect(() => buildEndoResultBundleV0("endo.session.s1", record)).toThrow(TypeError);
		expect(() => buildEndoResultBundleV0("bundle-1", record)).toThrow(TypeError);
		expect(() =>
			buildEndoResultBundleV0("endo.evidence.bundle-1", record, { ...report, recordId: "endo.evidence.other" }),
		).toThrow(TypeError);
		expect(() => buildEndoResultBundleV0("endo.evidence.bundle-1", record, { ...report, recordId: "nope" })).toThrow(
			TypeError,
		);
	});

	it("rejects an invalid record or report with a TypeError", () => {
		const record = storeRecord();
		expect(() => buildEndoResultBundleV0("endo.evidence.bundle-1", { ...record, id: "endo.session.s1" })).toThrow(
			TypeError,
		);
		expect(() => buildEndoResultBundleV0("endo.evidence.bundle-1", record, "replay")).toThrow(TypeError);
	});
});
