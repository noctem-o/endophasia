import { describe, expect, it } from "vitest";
import {
	ENDO_EDGE_RELATIONS_V0,
	ENDO_NODE_KINDS_V0,
	type EndoGraphEdgeV0,
	validateEndoGraphChangeV0,
	validateEndoGraphEdgeV0,
	validateEndoGraphExpansionBudgetV0,
	validateEndoGraphProjectionV0,
	validateEndoGraphRevisionV0,
	validateEndoGraphSnapshotV0,
} from "../protocol/graph.ts";
import { isWellFormedKindV0 } from "../protocol/identity.ts";
import { type EndoObjectV0, validateEndoObjectV0 } from "../protocol/object.ts";

function validObject(): EndoObjectV0 {
	return {
		schemaVersion: "endo.object.v0",
		id: "endo.node.session-1",
		kind: "session",
		payload: { title: "standalone" },
		observedIn: "endo.event.session.started",
	};
}

function validEdge(): EndoGraphEdgeV0 {
	return {
		schemaVersion: "endo.edge.v0",
		id: "endo.edge.e1",
		source: "endo.node.session-1",
		target: "endo.node.run-1",
		relation: "derived-from",
		observedIn: "endo.event.session.started",
	};
}

describe("cognition graph vocabularies", () => {
	it("keeps every recommended node kind and edge relation well-formed", () => {
		expect(ENDO_NODE_KINDS_V0).toHaveLength(18);
		expect(ENDO_EDGE_RELATIONS_V0).toHaveLength(10);
		for (const kind of ENDO_NODE_KINDS_V0) expect(isWellFormedKindV0(kind)).toBe(true);
		for (const relation of ENDO_EDGE_RELATIONS_V0) expect(isWellFormedKindV0(relation)).toBe(true);
	});
});

describe("validateEndoGraphEdgeV0", () => {
	it("accepts a valid edge and returns it unchanged", () => {
		const edge = validEdge();
		expect(validateEndoGraphEdgeV0(edge)).toBe(edge);
	});

	it("accepts every recommended relation and an unlisted well-formed relation", () => {
		for (const relation of ENDO_EDGE_RELATIONS_V0) {
			expect(validateEndoGraphEdgeV0({ ...validEdge(), relation })).toBeTypeOf("object");
		}
		expect(validateEndoGraphEdgeV0({ ...validEdge(), relation: "custom-relation" })).toBeTypeOf("object");
	});

	it("rejects malformed relations", () => {
		expect(validateEndoGraphEdgeV0({ ...validEdge(), relation: "Derived-From" })).toBeNull();
		expect(validateEndoGraphEdgeV0({ ...validEdge(), relation: "derived from" })).toBeNull();
		expect(validateEndoGraphEdgeV0({ ...validEdge(), relation: "" })).toBeNull();
	});

	it("keeps the edge identity in the edge namespace and both endpoints in the node namespace", () => {
		expect(validateEndoGraphEdgeV0({ ...validEdge(), id: "endo.node.n1" })).toBeNull();
		expect(validateEndoGraphEdgeV0({ ...validEdge(), source: "endo.edge.e2" })).toBeNull();
		expect(validateEndoGraphEdgeV0({ ...validEdge(), target: "endo.event.e1" })).toBeNull();
	});

	it("keeps the provenance in the event namespace", () => {
		expect(validateEndoGraphEdgeV0({ ...validEdge(), observedIn: "endo.node.n1" })).toBeNull();
	});

	it("enforces the schema version literal and rejects unknown keys", () => {
		expect(validateEndoGraphEdgeV0({ ...validEdge(), schemaVersion: "endo.edge.v1" })).toBeNull();
		expect(validateEndoGraphEdgeV0({ ...validEdge(), weight: 1 })).toBeNull();
	});

	it("rejects non-objects", () => {
		expect(validateEndoGraphEdgeV0(null)).toBeNull();
		expect(validateEndoGraphEdgeV0("endo.edge.e1")).toBeNull();
	});
});

describe("validateEndoGraphExpansionBudgetV0", () => {
	it("accepts an empty budget (unbounded) and positive budgets", () => {
		expect(validateEndoGraphExpansionBudgetV0({})).toEqual({});
		expect(validateEndoGraphExpansionBudgetV0({ maxDepth: 3 })).toEqual({ maxDepth: 3 });
		expect(validateEndoGraphExpansionBudgetV0({ maxDepth: 1, maxNodes: 2, maxEdges: 3 })).toBeTypeOf("object");
	});

	it("rejects budgets that are present but not positive integers", () => {
		expect(validateEndoGraphExpansionBudgetV0({ maxDepth: 0 })).toBeNull();
		expect(validateEndoGraphExpansionBudgetV0({ maxDepth: -1 })).toBeNull();
		expect(validateEndoGraphExpansionBudgetV0({ maxDepth: 2.5 })).toBeNull();
		expect(validateEndoGraphExpansionBudgetV0({ maxDepth: "3" })).toBeNull();
		expect(validateEndoGraphExpansionBudgetV0({ maxNodes: null })).toBeNull();
	});

	it("rejects unknown keys and non-objects", () => {
		expect(validateEndoGraphExpansionBudgetV0({ maxHops: 1 })).toBeNull();
		expect(validateEndoGraphExpansionBudgetV0(null)).toBeNull();
		expect(validateEndoGraphExpansionBudgetV0(1)).toBeNull();
	});
});

describe("validateEndoGraphSnapshotV0", () => {
	const validSnapshot = () => ({
		schemaVersion: "endo.graph-snapshot.v0",
		root: "endo.node.session-1",
		nodes: [validObject()],
		edges: [validEdge()],
		missing: ["endo.node.ghost"],
		truncated: false,
	});

	it("accepts a valid snapshot and returns it unchanged", () => {
		const snapshot = validSnapshot();
		expect(validateEndoGraphSnapshotV0(snapshot)).toBe(snapshot);
	});

	it("accepts an empty snapshot (missing root, nothing reached)", () => {
		const snapshot = { ...validSnapshot(), nodes: [], edges: [], missing: ["endo.node.session-1"] };
		expect(validateEndoGraphSnapshotV0(snapshot)).toBeTypeOf("object");
	});

	it("keeps the root and missing entries in the node namespace", () => {
		expect(validateEndoGraphSnapshotV0({ ...validSnapshot(), root: "endo.edge.e1" })).toBeNull();
		expect(validateEndoGraphSnapshotV0({ ...validSnapshot(), missing: ["endo.edge.e1"] })).toBeNull();
	});

	it("validates the node and edge entries with their own validators", () => {
		expect(validateEndoGraphSnapshotV0({ ...validSnapshot(), nodes: [{ ...validObject(), kind: 1 }] })).toBeNull();
		expect(validateEndoGraphSnapshotV0({ ...validSnapshot(), edges: [{ ...validEdge(), relation: "" }] })).toBeNull();
	});

	it("requires a boolean truncated and rejects unknown keys", () => {
		expect(validateEndoGraphSnapshotV0({ ...validSnapshot(), truncated: "yes" })).toBeNull();
		expect(validateEndoGraphSnapshotV0({ ...validSnapshot(), depth: 2 })).toBeNull();
	});
});

describe("validateEndoGraphChangeV0", () => {
	const validChange = () => ({
		schemaVersion: "endo.graph-change.v0",
		kind: "object",
		id: "endo.node.session-1",
		revision: 1,
	});

	it("accepts object and edge changes", () => {
		expect(validateEndoGraphChangeV0(validChange())).toBeTypeOf("object");
		expect(validateEndoGraphChangeV0({ ...validChange(), kind: "edge", id: "endo.edge.e1", revision: 2 })).toBeTypeOf(
			"object",
		);
	});

	it("keeps the identifier in the kind's namespace", () => {
		expect(validateEndoGraphChangeV0({ ...validChange(), id: "endo.edge.e1" })).toBeNull();
		expect(validateEndoGraphChangeV0({ ...validChange(), kind: "edge", id: "endo.node.n1" })).toBeNull();
	});

	it("rejects a malformed kind and a revision that is not a positive integer", () => {
		expect(validateEndoGraphChangeV0({ ...validChange(), kind: "vertex" })).toBeNull();
		expect(validateEndoGraphChangeV0({ ...validChange(), revision: 0 })).toBeNull();
		expect(validateEndoGraphChangeV0({ ...validChange(), revision: 1.5 })).toBeNull();
	});
});

describe("validateEndoGraphRevisionV0", () => {
	const validRevision = () => ({
		schemaVersion: "endo.graph-revision.v0",
		sequence: 1,
		change: { schemaVersion: "endo.graph-change.v0", kind: "object", id: "endo.node.session-1", revision: 1 },
		value: validObject(),
	});

	it("accepts object and edge revisions", () => {
		expect(validateEndoGraphRevisionV0(validRevision())).toBeTypeOf("object");
		const edgeRevision = {
			schemaVersion: "endo.graph-revision.v0",
			sequence: 2,
			change: { schemaVersion: "endo.graph-change.v0", kind: "edge", id: "endo.edge.e1", revision: 1 },
			value: validEdge(),
		};
		expect(validateEndoGraphRevisionV0(edgeRevision)).toBeTypeOf("object");
	});

	it("rejects a kind mismatch between the change and the value", () => {
		expect(validateEndoGraphRevisionV0({ ...validRevision(), value: validEdge() })).toBeNull();
	});

	it("rejects an identifier mismatch between the change and the value", () => {
		const otherObject: EndoObjectV0 = { ...validObject(), id: "endo.node.run-1" };
		expect(validateEndoGraphRevisionV0({ ...validRevision(), value: otherObject })).toBeNull();
	});

	it("rejects a sequence that is not a positive integer", () => {
		expect(validateEndoGraphRevisionV0({ ...validRevision(), sequence: 0 })).toBeNull();
	});
});

describe("validateEndoGraphProjectionV0", () => {
	const validProjection = () => ({
		schemaVersion: "endo.graph-projection.v0",
		upToSequence: 2,
		objects: [validObject()],
		edges: [validEdge()],
	});

	it("accepts a valid projection, including the empty projection at sequence 0", () => {
		expect(validateEndoGraphProjectionV0(validProjection())).toBeTypeOf("object");
		const empty = { ...validProjection(), upToSequence: 0, objects: [], edges: [] };
		expect(validateEndoGraphProjectionV0(empty)).toBeTypeOf("object");
	});

	it("rejects a projection point that is not a non-negative integer", () => {
		expect(validateEndoGraphProjectionV0({ ...validProjection(), upToSequence: -1 })).toBeNull();
		expect(validateEndoGraphProjectionV0({ ...validProjection(), upToSequence: 1.5 })).toBeNull();
	});

	it("validates the entries with their own validators and rejects unknown keys", () => {
		expect(
			validateEndoGraphProjectionV0({ ...validProjection(), objects: [{ ...validObject(), kind: "" }] }),
		).toBeNull();
		expect(validateEndoGraphProjectionV0({ ...validProjection(), asOf: "now" })).toBeNull();
	});

	it("cross-checks the object validator still backs the projection entries", () => {
		expect(validateEndoObjectV0(validObject())).toBeTypeOf("object");
	});
});
