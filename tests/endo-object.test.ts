import { describe, expect, it } from "vitest";
import { type EndoObjectV0, validateEndoObjectV0 } from "../protocol/object.ts";

function validObject(): EndoObjectV0 {
	return {
		schemaVersion: "endo.object.v0",
		id: "endo.node.claim-1",
		kind: "claim",
		payload: { statement: "the runtime emits tool.completed" },
		observedIn: "endo.event.tool.completed",
	};
}

describe("validateEndoObjectV0", () => {
	it("accepts a valid envelope and returns it unchanged", () => {
		const object = validObject();
		expect(validateEndoObjectV0(object)).toBe(object);
	});

	it("accepts single- and multi-segment object kinds", () => {
		expect(validateEndoObjectV0({ ...validObject(), kind: "hypothesis" })).toBeTypeOf("object");
		expect(validateEndoObjectV0({ ...validObject(), kind: "thought.note" })).toBeTypeOf("object");
		expect(validateEndoObjectV0({ ...validObject(), kind: "Claim" })).toBeNull();
	});

	it("keeps the object identity in the node namespace and the provenance in the event namespace", () => {
		expect(validateEndoObjectV0({ ...validObject(), id: "endo.event.e1" })).toBeNull();
		expect(validateEndoObjectV0({ ...validObject(), observedIn: "endo.node.n1" })).toBeNull();
	});

	it("enforces the schema version literal", () => {
		expect(validateEndoObjectV0({ ...validObject(), schemaVersion: "endo.object.v1" })).toBeNull();
	});

	it("rejects unknown keys and non-strict-JSON payloads (strict-JSON discipline)", () => {
		expect(validateEndoObjectV0({ ...validObject(), store: "local" })).toBeNull();
		expect(validateEndoObjectV0({ ...validObject(), payload: Number.NaN })).toBeNull();
	});
});
