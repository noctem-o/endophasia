import { describe, expect, it } from "vitest";
import { ENDO_EVENT_SOURCES_V0, type EndoEventV0, validateEndoEventV0 } from "../protocol/event.ts";

/** A valid envelope; every case mutates exactly one field. */
function validEvent(): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: "endo.event.session.started",
		kind: "session.started",
		source: "runtime-fact",
		sequence: 1,
		at: "2026-10-02T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1", experimentId: "endo.experiment.x1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main", turn: 0 },
	};
}

describe("validateEndoEventV0", () => {
	it("accepts a complete valid envelope and returns it unchanged", () => {
		const event = validEvent();
		expect(validateEndoEventV0(event)).toBe(event);
	});

	it("accepts every closed v0 source class", () => {
		for (const source of ENDO_EVENT_SOURCES_V0) {
			expect(validateEndoEventV0({ ...validEvent(), source })).toBeTypeOf("object");
		}
	});

	it("accepts an empty coordinate set: an event can belong to no lifetime", () => {
		expect(validateEndoEventV0({ ...validEvent(), coordinates: {} })).toBeTypeOf("object");
	});

	it("rejects a wrong or missing schema version", () => {
		expect(validateEndoEventV0({ ...validEvent(), schemaVersion: "endo.event.v1" })).toBeNull();
		const { schemaVersion: _drop, ...noVersion } = validEvent();
		expect(validateEndoEventV0(noVersion)).toBeNull();
	});

	it("rejects identifiers outside the event namespace", () => {
		expect(validateEndoEventV0({ ...validEvent(), id: "endo.session.s1" })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), id: "endo.event" })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), id: "event.x" })).toBeNull();
	});

	it("enforces the two-plus-segment event-kind grammar", () => {
		expect(validateEndoEventV0({ ...validEvent(), kind: "claim" })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), kind: "Session.started" })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), kind: "tool.requested" })).toBeTypeOf("object");
	});

	it("rejects an unknown source class", () => {
		expect(validateEndoEventV0({ ...validEvent(), source: "fact" })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), source: "runtime-fact-extra" })).toBeNull();
	});

	it("enforces the sequence invariant: integer, non-negative, zero allowed", () => {
		expect(validateEndoEventV0({ ...validEvent(), sequence: 0 })).toBeTypeOf("object");
		expect(validateEndoEventV0({ ...validEvent(), sequence: -1 })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), sequence: 1.5 })).toBeNull();
	});

	it("requires a non-empty wall-clock time", () => {
		expect(validateEndoEventV0({ ...validEvent(), at: "" })).toBeNull();
	});

	it("keeps coordinate identifiers in their namespaces and rejects unknown coordinate keys", () => {
		expect(validateEndoEventV0({ ...validEvent(), coordinates: { sessionId: "endo.run.r1" } })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), coordinates: { runId: "endo.session.s1" } })).toBeNull();
		expect(
			validateEndoEventV0({ ...validEvent(), coordinates: { experimentId: "endo.experiment.x1", lane: "main" } }),
		).toBeNull();
	});

	it("requires a non-empty producer", () => {
		expect(validateEndoEventV0({ ...validEvent(), producer: "" })).toBeNull();
	});

	it("requires every derived-from entry to be an event identifier", () => {
		expect(validateEndoEventV0({ ...validEvent(), derivedFrom: ["endo.event.f1", "endo.event.f2"] })).toBeTypeOf(
			"object",
		);
		expect(validateEndoEventV0({ ...validEvent(), derivedFrom: ["endo.session.s1"] })).toBeNull();
	});

	it("accepts strict-JSON payloads of every value shape", () => {
		for (const payload of [null, true, false, 0, 1.5, "x", [1, "two", [null]], { a: { b: [true] } }]) {
			expect(validateEndoEventV0({ ...validEvent(), payload })).toBeTypeOf("object");
		}
	});

	it("rejects non-strict-JSON payloads, including nested non-finite numbers", () => {
		expect(validateEndoEventV0({ ...validEvent(), payload: Number.NaN })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), payload: [1, Number.POSITIVE_INFINITY] })).toBeNull();
		expect(validateEndoEventV0({ ...validEvent(), payload: undefined })).toBeNull();
	});

	it("rejects unknown top-level keys (strict-JSON discipline)", () => {
		expect(validateEndoEventV0({ ...validEvent(), note: "hi" })).toBeNull();
	});

	it("rejects non-object values", () => {
		expect(validateEndoEventV0(null)).toBeNull();
		expect(validateEndoEventV0("endo.event.v0")).toBeNull();
	});
});

describe("event time", () => {
	it("accepts ISO-8601 UTC and rejects anything else in `at`", () => {
		for (const at of ["2026-10-02T11:00:00Z", "2026-10-02T11:00:00.123Z"]) {
			expect(validateEndoEventV0({ ...validEvent(), at })).not.toBeNull();
		}
		for (const at of [
			"yesterday",
			"2026-10-02",
			"2026-10-02T11:00:00+02:00",
			"2026-02-30T11:00:00Z",
			"1791019529388",
		]) {
			expect(validateEndoEventV0({ ...validEvent(), at })).toBeNull();
		}
	});
});
