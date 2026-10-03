import { describe, expect, it } from "vitest";
import { expandEndoGraphV0 } from "../graph/traversal.ts";
import {
	CLAIM_ID,
	fixtureStore,
	GHOST_ID,
	MODEL_CALL_ID,
	RUN_ID,
	SESSION_ID,
	TOOL_CALL_ID,
	TOOL_RESULT_ID,
} from "./graph-fixture.ts";

const IDS = (objects: { id: string }[]) => objects.map((object) => object.id);

describe("expandEndoGraphV0", () => {
	it("expands the whole connected component without budgets, sorted, and reports the dangling endpoint as missing", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID);
		expect(snapshot.root).toBe(SESSION_ID);
		expect(snapshot.truncated).toBe(false);
		expect(IDS(snapshot.nodes)).toEqual([
			"endo.node.claim-1",
			"endo.node.model-call-1",
			"endo.node.run-1",
			"endo.node.session-1",
			"endo.node.tool-call-1",
			"endo.node.tool-result-1",
		]);
		expect(snapshot.missing).toEqual([GHOST_ID]);
		expect(snapshot.edges.map((edge) => edge.id)).toEqual([
			"endo.edge.e1",
			"endo.edge.e2",
			"endo.edge.e3",
			"endo.edge.e4",
			"endo.edge.e5",
			"endo.edge.e6",
			"endo.edge.e7",
		]);
	});

	it("is deterministic: the same store state and options produce the same snapshot", () => {
		const store = fixtureStore();
		expect(expandEndoGraphV0(store, SESSION_ID)).toEqual(expandEndoGraphV0(store, SESSION_ID));
	});

	it("is honest about a root the store does not hold", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), "endo.node.nowhere");
		expect(snapshot.nodes).toEqual([]);
		expect(snapshot.edges).toEqual([]);
		expect(snapshot.missing).toEqual(["endo.node.nowhere"]);
		expect(snapshot.truncated).toBe(false);
	});

	it("expands from a missing root through its recorded edges", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), GHOST_ID);
		expect(IDS(snapshot.nodes)).toEqual([CLAIM_ID, MODEL_CALL_ID, RUN_ID, SESSION_ID, TOOL_CALL_ID, TOOL_RESULT_ID]);
		expect(snapshot.missing).toEqual([GHOST_ID]);
		expect(snapshot.edges.map((edge) => edge.id)).toEqual([
			"endo.edge.e1",
			"endo.edge.e2",
			"endo.edge.e3",
			"endo.edge.e4",
			"endo.edge.e5",
			"endo.edge.e6",
			"endo.edge.e7",
		]);
		expect(snapshot.truncated).toBe(false);
	});
	it("requires a well-formed node identifier for the root", () => {
		const store = fixtureStore();
		expect(() => expandEndoGraphV0(store, "endo.edge.e1")).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, "session-1")).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, 42)).toThrow(TypeError);
	});

	it("applies the depth budget: one hop from the root", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID, { budgets: { maxDepth: 1 } });
		expect(IDS(snapshot.nodes)).toEqual([MODEL_CALL_ID, RUN_ID, SESSION_ID]);
		expect(snapshot.missing).toEqual([]);
		expect(snapshot.edges.map((edge) => edge.id)).toEqual(["endo.edge.e1", "endo.edge.e4", "endo.edge.e7"]);
		expect(snapshot.truncated).toBe(true);
	});

	it("applies the depth budget at two hops and completes untruncated beyond the graph's diameter", () => {
		const two = expandEndoGraphV0(fixtureStore(), SESSION_ID, { budgets: { maxDepth: 2 } });
		expect(IDS(two.nodes)).toEqual([
			"endo.node.claim-1",
			"endo.node.model-call-1",
			"endo.node.run-1",
			"endo.node.session-1",
			"endo.node.tool-call-1",
		]);
		expect(two.edges.map((edge) => edge.id)).toEqual([
			"endo.edge.e1",
			"endo.edge.e2",
			"endo.edge.e4",
			"endo.edge.e5",
			"endo.edge.e7",
		]);
		expect(two.truncated).toBe(true);
		const full = expandEndoGraphV0(fixtureStore(), SESSION_ID, { budgets: { maxDepth: 4 } });
		expect(full.truncated).toBe(false);
		expect(full.missing).toEqual([GHOST_ID]);
	});

	it("applies the node budget and keeps the snapshot within it", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID, { budgets: { maxNodes: 3 } });
		expect(snapshot.nodes).toHaveLength(3);
		expect(IDS(snapshot.nodes)).toEqual([MODEL_CALL_ID, RUN_ID, SESSION_ID]);
		expect(snapshot.missing).toEqual([]);
		expect(snapshot.truncated).toBe(true);
	});

	it("applies the edge budget to the emitted edges", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID, { budgets: { maxEdges: 2 } });
		expect(snapshot.edges.map((edge) => edge.id)).toEqual(["endo.edge.e1", "endo.edge.e2"]);
		expect(snapshot.truncated).toBe(true);
	});

	it("does not mark truncated when a budget is met exactly at the frontier end", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID, { budgets: { maxNodes: 7 } });
		expect(snapshot.nodes).toHaveLength(6);
		expect(snapshot.truncated).toBe(false);
	});

	it("follows outgoing edges only in the out direction", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID, { direction: "out" });
		expect(IDS(snapshot.nodes)).toEqual([
			"endo.node.claim-1",
			"endo.node.model-call-1",
			"endo.node.run-1",
			"endo.node.session-1",
			"endo.node.tool-call-1",
			"endo.node.tool-result-1",
		]);
		expect(snapshot.missing).toEqual([GHOST_ID]);
	});

	it("follows incoming edges only in the in direction", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), TOOL_RESULT_ID, { direction: "in" });
		expect(IDS(snapshot.nodes)).toEqual([RUN_ID, SESSION_ID, TOOL_CALL_ID, TOOL_RESULT_ID]);
		expect(snapshot.edges.map((edge) => edge.id)).toEqual(["endo.edge.e1", "endo.edge.e2", "endo.edge.e3"]);
		expect(snapshot.truncated).toBe(false);
	});

	it("reaches nothing from a node without incoming edges in the in direction", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), TOOL_RESULT_ID, { direction: "in", relations: ["supports"] });
		expect(IDS(snapshot.nodes)).toEqual([TOOL_RESULT_ID]);
		expect(snapshot.edges).toEqual([]);
		expect(snapshot.truncated).toBe(false);
	});

	it("follows only the filtered relations, while the snapshot still shows all recorded edges between visited nodes", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), RUN_ID, { relations: ["derived-from", "references"] });
		expect(IDS(snapshot.nodes)).toEqual([MODEL_CALL_ID, RUN_ID, SESSION_ID, TOOL_CALL_ID]);
		expect(snapshot.edges.map((edge) => edge.id)).toEqual([
			"endo.edge.e1",
			"endo.edge.e2",
			"endo.edge.e4",
			"endo.edge.e7",
		]);
		expect(snapshot.truncated).toBe(false);
	});

	it("reaches nothing when no edge matches the relation filter", () => {
		const snapshot = expandEndoGraphV0(fixtureStore(), SESSION_ID, { relations: ["references"] });
		expect(IDS(snapshot.nodes)).toEqual([SESSION_ID]);
		expect(snapshot.edges).toEqual([]);
		expect(snapshot.truncated).toBe(false);
	});

	it("validates the options at the door", () => {
		const store = fixtureStore();
		expect(() => expandEndoGraphV0(store, SESSION_ID, { bogus: 1 })).toThrow(/Unknown graph expansion option: bogus/);
		expect(() => expandEndoGraphV0(store, SESSION_ID, { budgets: { maxDepth: 0 } })).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, SESSION_ID, { budgets: { maxHops: 1 } })).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, SESSION_ID, { direction: "up" })).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, SESSION_ID, { relations: ["Derived-From"] })).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, SESSION_ID, { relations: 42 })).toThrow(TypeError);
		expect(() => expandEndoGraphV0(store, SESSION_ID, class {})).toThrow(TypeError);
	});
});
