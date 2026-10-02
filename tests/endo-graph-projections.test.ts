import { describe, expect, it } from "vitest";
import { projectEndoGraphAtV0 } from "../graph/projections.ts";
import { createEndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoGraphEdgeV0 } from "../protocol/graph.ts";
import { node } from "./graph-fixture.ts";

function edge(id: string, source: string, target: string, relation: string): EndoGraphEdgeV0 {
	return {
		schemaVersion: "endo.edge.v0",
		id,
		source,
		target,
		relation,
		observedIn: "endo.event.session.started",
	};
}

// Interleaved history: object A (v1) at 1, edge E1 at 2, object B at 3, object A (v2) at 4, edge E1 revised at 5.
function historyStore() {
	const store = createEndoGraphStoreV0();
	const a1 = node("endo.node.a", "claim");
	store.upsertObject(a1);
	store.upsertEdge(edge("endo.edge.e1", "endo.node.a", "endo.node.b", "supports"));
	store.upsertObject(node("endo.node.b", "claim"));
	const a2 = { ...a1, payload: { note: "revised" } };
	store.upsertObject(a2);
	store.upsertEdge(edge("endo.edge.e1", "endo.node.a", "endo.node.c", "supports"));
	return { store, a1, a2 };
}

describe("projectEndoGraphAtV0", () => {
	it("projects the empty graph at sequence 0", () => {
		const { store } = historyStore();
		expect(projectEndoGraphAtV0(store, 0)).toEqual({
			schemaVersion: "endo.graph-projection.v0",
			upToSequence: 0,
			objects: [],
			edges: [],
		});
	});

	it("shows only the revisions recorded at or before the projection point", () => {
		const { store, a1 } = historyStore();
		expect(projectEndoGraphAtV0(store, 1).objects).toEqual([a1]);
		expect(projectEndoGraphAtV0(store, 2).edges).toEqual([
			edge("endo.edge.e1", "endo.node.a", "endo.node.b", "supports"),
		]);
		expect(projectEndoGraphAtV0(store, 3).objects).toEqual([a1, node("endo.node.b", "claim")]);
	});

	it("shows the later revision only after its sequence", () => {
		const { store, a2 } = historyStore();
		expect(projectEndoGraphAtV0(store, 3).objects.map((object) => object.id)).toEqual(["endo.node.a", "endo.node.b"]);
		expect(projectEndoGraphAtV0(store, 4).objects).toEqual([a2, node("endo.node.b", "claim")]);
	});

	it("projects the current state for a sequence beyond the log end", () => {
		const { store, a2 } = historyStore();
		const atEnd = projectEndoGraphAtV0(store, 5);
		const beyond = projectEndoGraphAtV0(store, 99);
		expect(beyond.objects).toEqual(atEnd.objects);
		expect(beyond.edges).toEqual(atEnd.edges);
		expect(atEnd.objects).toEqual([a2, node("endo.node.b", "claim")]);
		expect(atEnd.edges[0].target).toBe("endo.node.c");
	});

	it("emits sorted, deterministic projections", () => {
		const { store } = historyStore();
		expect(projectEndoGraphAtV0(store, 5)).toEqual(projectEndoGraphAtV0(store, 5));
		const objects = projectEndoGraphAtV0(store, 5).objects;
		expect(objects.map((object) => object.id)).toEqual([...objects.map((object) => object.id)].sort());
	});

	it("requires a non-negative integer projection point", () => {
		const { store } = historyStore();
		expect(() => projectEndoGraphAtV0(store, -1)).toThrow(TypeError);
		expect(() => projectEndoGraphAtV0(store, 1.5)).toThrow(TypeError);
		expect(() => projectEndoGraphAtV0(store, "2")).toThrow(TypeError);
	});
});
