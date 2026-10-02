import { describe, expect, it } from "vitest";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	type EndoEventRecordV0,
	type EndoResourceUsageV0,
	validateEndoEventRecordV0,
} from "../protocol/event-record.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	createEndoEventStoreV0,
	ENDO_EVENT_RECORD_PAGE_DEFAULT_LIMIT_V0,
	ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0,
} from "../runtime/contracts/event-store.ts";

/** A valid event with a distinct id; every case mutates exactly one field. */
function event(id: string, sequence: number): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id,
		kind: "tool.completed",
		source: "runtime-fact",
		sequence,
		at: "2026-10-02T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main" },
	};
}

const IDS = ["endo.event.t1", "endo.event.t2", "endo.event.t3"] as const;

function seededStore(): ReturnType<typeof createEndoEventStoreV0> {
	const store = createEndoEventStoreV0();
	IDS.forEach((id, index) => {
		store.ingest(event(id, index + 1));
	});
	return store;
}

describe("ingest", () => {
	it("accepts a valid event and returns it unchanged", () => {
		const store = createEndoEventStoreV0();
		const value = event("endo.event.t1", 1);
		expect(store.ingest(value)).toBe(value);
		expect(store.length).toBe(1);
	});

	it("rejects an invalid event with a TypeError", () => {
		const store = createEndoEventStoreV0();
		expect(() => store.ingest({ ...event("endo.event.t1", 1), id: "endo.session.s1" })).toThrow(TypeError);
		expect(() => store.ingest("endo.event.t1")).toThrow(TypeError);
		expect(store.length).toBe(0);
	});

	it("rejects an event that is not plain JSON: structural validity is not canonicalizability", () => {
		const store = createEndoEventStoreV0();
		expect(() => store.ingest({ ...event("endo.event.t1", 1), payload: new Date() })).toThrow(TypeError);
		expect(store.length).toBe(0);
	});

	it("rejects a duplicate id and keeps the store exactly what the stream said", () => {
		const store = createEndoEventStoreV0();
		const value = event("endo.event.t1", 1);
		store.ingest(value);
		expect(() => store.ingest({ ...value, sequence: 2 })).toThrow(TypeError);
		expect(store.length).toBe(1);
	});
});

describe("page", () => {
	it("returns an empty page on an empty store, keyed by the input cursor", () => {
		const store = createEndoEventStoreV0();
		expect(store.page()).toEqual({
			schemaVersion: "endo.record-page.v0",
			order: "ascending",
			events: [],
			nextAfterSequence: 0,
		});
		expect(store.page({ afterSequence: 5 })).toEqual({
			schemaVersion: "endo.record-page.v0",
			order: "ascending",
			events: [],
			nextAfterSequence: 5,
		});
	});

	it("returns the whole stream ascending from the default cursor, with 1-based storage sequences", () => {
		const store = seededStore();
		const page = store.page();
		expect(page.events.map((e) => e.id)).toEqual([...IDS]);
		expect(page.nextAfterSequence).toBe(3);
	});

	it("reads strictly after the cursor and bounds by the limit", () => {
		const store = seededStore();
		expect(store.page({ afterSequence: 1 }).events.map((e) => e.id)).toEqual([IDS[1], IDS[2]]);
		expect(store.page({ afterSequence: 3 }).events).toEqual([]);
		expect(store.page({ afterSequence: 3 }).nextAfterSequence).toBe(3);
		const limited = store.page({ limit: 2 });
		expect(limited.events.map((e) => e.id)).toEqual([IDS[0], IDS[1]]);
		expect(limited.nextAfterSequence).toBe(2);
		const stepped = store.page({ afterSequence: limited.nextAfterSequence, limit: 2 });
		expect(stepped.events.map((e) => e.id)).toEqual([IDS[2]]);
		expect(stepped.nextAfterSequence).toBe(3);
	});

	it("enforces the demonstrated page limits: 1000 default, 10000 maximum", () => {
		expect(ENDO_EVENT_RECORD_PAGE_DEFAULT_LIMIT_V0).toBe(1000);
		expect(ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0).toBe(10000);
		const store = seededStore();
		expect(() => store.page({ limit: ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0 })).not.toThrow();
		expect(() => store.page({ limit: 0 })).toThrow(TypeError);
		expect(() => store.page({ limit: ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0 + 1 })).toThrow(TypeError);
		expect(() => store.page({ limit: 1.5 })).toThrow(TypeError);
	});

	it("rejects malformed queries with a TypeError rather than coercing them", () => {
		const store = seededStore();
		expect(() => store.page({ afterSequence: -1 })).toThrow(TypeError);
		expect(() => store.page({ afterSequence: 1.5 })).toThrow(TypeError);
		expect(() => store.page({ cursor: 1 } as never)).toThrow(TypeError);
		expect(() => store.page(null as never)).toThrow(TypeError);
		expect(() => store.page({ afterSequence: Object() })).toThrow(TypeError);
	});
});

describe("record", () => {
	it("materializes a valid record: append order, the canonical digest, and the built-in summary", () => {
		const store = seededStore();
		const record = store.record("endo.evidence.run-1");
		expect(validateEndoEventRecordV0(record)).toBe(record);
		expect(record.events.map((e) => e.id)).toEqual([...IDS]);
		expect(record.digest).toBe(sha256HexV0(canonicalEndoJsonV0(record.events)));
		expect(record.summary).toEqual({
			schemaVersion: "endo.stream-summary.v0",
			count: 3,
			maxSequence: 3,
			sources: {
				"runtime-fact": 3,
				interpretation: 0,
				hypothesis: 0,
				"evaluation-result": 0,
				"policy-conclusion": 0,
				"authority-decision": 0,
			},
		});
	});

	it("computes the same digest in independently built stores: the digest is over content, not process", () => {
		const a = createEndoEventStoreV0();
		const b = createEndoEventStoreV0();
		IDS.forEach((id, index) => {
			a.ingest(event(id, index + 1));
			b.ingest(event(id, index + 1));
		});
		expect(a.record("endo.evidence.run-1").digest).toBe(b.record("endo.evidence.run-1").digest);
	});

	it("is append-only: a materialized record is a snapshot, not a live view", () => {
		const store = seededStore();
		const record: EndoEventRecordV0 = store.record("endo.evidence.run-1");
		store.ingest(event("endo.event.t4", 4));
		expect(record.events).toHaveLength(3);
		expect(store.length).toBe(4);
	});

	it("keeps the record id in the evidence namespace", () => {
		const store = seededStore();
		expect(() => store.record("endo.session.s1")).toThrow(TypeError);
		expect(() => store.record("evidence.run-1")).toThrow(TypeError);
		expect(() => store.record("endo.evidence.run-1")).not.toThrow();
	});

	it("passes through valid coordinates and resources, and rejects invalid ones", () => {
		const store = seededStore();
		const record = store.record(
			"endo.evidence.run-1",
			{ sessionId: "endo.session.s1", runId: "endo.run.r1" },
			{ tokens: { input: 1, output: 2, total: 3 }, durationMs: 42 },
		);
		expect(record.coordinates).toEqual({ sessionId: "endo.session.s1", runId: "endo.run.r1" });
		expect(record.resources).toEqual({ tokens: { input: 1, output: 2, total: 3 }, durationMs: 42 });
		expect(() => store.record("endo.evidence.run-1", { sessionId: "endo.run.r1" })).toThrow(TypeError);
		expect(() =>
			store.record("endo.evidence.run-1", undefined, {
				tokens: { input: 1, output: 2 },
			} as unknown as EndoResourceUsageV0),
		).toThrow(TypeError);
	});

	it("records an empty stream honestly: zero events, the empty digest, a zero summary", () => {
		const store = createEndoEventStoreV0();
		const record = store.record("endo.evidence.empty");
		expect(record.events).toEqual([]);
		expect(record.digest).toBe(sha256HexV0(canonicalEndoJsonV0([])));
		expect(record.summary?.count).toBe(0);
		expect(record.summary?.maxSequence).toBe(0);
	});
});
