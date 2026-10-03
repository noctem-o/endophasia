import { describe, expect, it } from "vitest";
import { createEndoGraphStoreV0 } from "../graph/store.ts";
import { buildEndoSemanticVisualStateAtV0, buildEndoSemanticVisualStateV0 } from "../visualization/semantic-state.ts";
import {
	A_ID,
	B_ID,
	C_ID,
	D_ID,
	E_ID,
	F_ID,
	G_ID,
	GHOST_ID,
	H_ID,
	VIZ_EDGES,
	VIZ_NODES,
	vizFixtureStore,
} from "./visualization-fixture.ts";

const ALL_IDS = [A_ID, B_ID, C_ID, D_ID, E_ID, F_ID, G_ID, H_ID];

function signalOf(state: ReturnType<typeof buildEndoSemanticVisualStateV0>, nodeId: string, name: string) {
	return state.nodes.find((node) => node.id === nodeId)?.signals.find((signal) => signal.signal === name);
}

describe("buildEndoSemanticVisualStateV0", () => {
	it("whole-store build projects every node and edge, sorted, with the dangling endpoint missing", () => {
		const store = vizFixtureStore();
		const state = buildEndoSemanticVisualStateV0(store);
		expect(state.nodes.map((node) => node.id)).toStrictEqual(ALL_IDS);
		expect(state.edges.map((edge) => edge.id)).toStrictEqual(VIZ_EDGES.map((edge) => edge.id).sort());
		expect(state.missing).toStrictEqual([GHOST_ID]);
		expect(state.source).toStrictEqual({
			schemaVersion: "endo.visual-state-source.v0",
			sequence: 15,
			root: null,
			truncated: false,
		});
	});

	it("depth is the graph distance per component from its smallest identifier", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		const depth = (id: string) => state.nodes.find((node) => node.id === id)?.depth;
		expect(depth(A_ID)).toBe(0);
		expect(depth(B_ID)).toBe(1);
		expect(depth(C_ID)).toBe(2);
		expect(depth(G_ID)).toBe(1);
		expect(depth(F_ID)).toBe(2);
		expect(depth(D_ID)).toBe(0);
		expect(depth(E_ID)).toBe(0);
		expect(depth(H_ID)).toBe(1);
	});

	it("recorded payload keys become available recorded signals", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(signalOf(state, C_ID, "attention")).toStrictEqual({
			schemaVersion: "endo.visual-signal.v0",
			signal: "attention",
			availability: "available",
			value: 0.8,
			origin: "recorded",
		});
		expect(signalOf(state, C_ID, "cluster")?.value).toBe("planning");
		expect(signalOf(state, C_ID, "uncertainty")?.value).toBe(0.2);
	});

	it("an out-of-range or mistyped recorded key is unrecognized with the value as sent", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(signalOf(state, F_ID, "attention")).toStrictEqual({
			schemaVersion: "endo.visual-signal.v0",
			signal: "attention",
			availability: "unrecognized",
			value: "high",
			reason: 'recorded attention "high" is outside the v0 range 0..1',
		});
		expect(signalOf(state, G_ID, "uncertainty")).toStrictEqual({
			schemaVersion: "endo.visual-signal.v0",
			signal: "uncertainty",
			availability: "unrecognized",
			value: 1.5,
			reason: "recorded uncertainty 1.5 is outside the v0 range 0..1",
		});
	});

	it("a missing key is unavailable with the recorded reason", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(signalOf(state, E_ID, "attention")).toStrictEqual({
			schemaVersion: "endo.visual-signal.v0",
			signal: "attention",
			availability: "unavailable",
			reason: "no attention recorded in the payload",
		});
	});

	it("a non-object payload reports every node signal unavailable", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		for (const name of ["attention", "cluster", "uncertainty"]) {
			expect(signalOf(state, D_ID, name)).toStrictEqual({
				schemaVersion: "endo.visual-signal.v0",
				signal: name,
				availability: "unavailable",
				reason: "the recorded payload is not a JSON object",
			});
		}
	});

	it("every projected node carries exactly the three documented node signals", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		for (const node of state.nodes) {
			expect(node.signals.map((signal) => signal.signal)).toStrictEqual(["attention", "cluster", "uncertainty"]);
		}
	});

	it("the smallest recorder decides a scene signal, and the builder's motion is unavailable", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(state.signals).toStrictEqual([
			{
				schemaVersion: "endo.visual-signal.v0",
				signal: "atmosphere",
				availability: "available",
				value: "storm",
				origin: "recorded",
			},
			{
				schemaVersion: "endo.visual-signal.v0",
				signal: "camera-intent",
				availability: "available",
				value: { focusNodeId: A_ID, frame: "node" },
				origin: "recorded",
			},
			{
				schemaVersion: "endo.visual-signal.v0",
				signal: "motion",
				availability: "unavailable",
				reason: "temporal motion is derived by the live updater",
			},
		]);
	});

	it("the same store state always produces the same state", () => {
		const first = buildEndoSemanticVisualStateV0(vizFixtureStore());
		const second = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(second).toStrictEqual(first);
	});

	it("a rooted build projects the budgeted expansion with depth from the root", () => {
		const store = vizFixtureStore();
		const state = buildEndoSemanticVisualStateV0(store, { root: C_ID });
		expect(state.nodes.map((node) => node.id)).toStrictEqual([A_ID, B_ID, C_ID, F_ID, G_ID]);
		expect(state.edges.map((edge) => edge.id)).toStrictEqual([
			"endo.edge.v1",
			"endo.edge.v2",
			"endo.edge.v3",
			"endo.edge.v5",
			"endo.edge.v6",
			"endo.edge.v7",
		]);
		expect(state.missing).toStrictEqual([GHOST_ID]);
		const depth = (id: string) => state.nodes.find((node) => node.id === id)?.depth;
		expect(depth(C_ID)).toBe(0);
		expect(depth(B_ID)).toBe(1);
		expect(depth(G_ID)).toBe(1);
		expect(depth(A_ID)).toBe(2);
		expect(depth(F_ID)).toBe(2);
		expect(state.source.root).toBe(C_ID);
		expect(state.source.truncated).toBe(false);
	});

	it("a budget truncates the rooted build", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore(), { root: A_ID, budgets: { maxNodes: 2 } });
		expect(state.nodes.length).toBe(2);
		expect(state.source.truncated).toBe(true);
	});

	it("the relations filter applies to the rooted build", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore(), { root: C_ID, relations: ["supports"] });
		expect(state.nodes.map((node) => node.id)).toStrictEqual([B_ID, C_ID]);
		expect(state.edges.map((edge) => edge.id)).toStrictEqual(["endo.edge.v2"]);
		const depth = (id: string) => state.nodes.find((node) => node.id === id)?.depth;
		expect(depth(C_ID)).toBe(0);
		expect(depth(B_ID)).toBe(1);
	});

	it("a root that is not stored still follows its recorded edges", () => {
		const store = vizFixtureStore();
		const state = buildEndoSemanticVisualStateV0(store, { root: GHOST_ID });
		expect(state.nodes.map((node) => node.id)).toStrictEqual([A_ID, B_ID, C_ID, F_ID, G_ID]);
		expect(state.missing).toStrictEqual([GHOST_ID]);
		const depth = (id: string) => state.nodes.find((node) => node.id === id)?.depth;
		expect(depth(G_ID)).toBe(1);
		expect(depth(C_ID)).toBe(2);
		expect(depth(A_ID)).toBe(2);
		expect(depth(B_ID)).toBe(3);
	});

	it("rejects unknown option keys and non-plain-object options", () => {
		const store = vizFixtureStore();
		expect(() => buildEndoSemanticVisualStateV0(store, { depth: 1 })).toThrow(
			new TypeError("Unknown visualization build option: depth"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, ["root"])).toThrow(
			new TypeError("Expected options: a plain object"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, null)).toThrow(
			new TypeError("Expected options: a plain object"),
		);
	});

	it("rejects a root outside the node namespace and traversal options without a root", () => {
		const store = vizFixtureStore();
		expect(() => buildEndoSemanticVisualStateV0(store, { root: "endo.session.s-1" })).toThrow(
			new TypeError("Expected root: a well-formed endo.node.* identifier"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, { budgets: { maxNodes: 1 } })).toThrow(
			new TypeError("Expected root: budgets, relations, and direction require a root"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, { relations: ["supports"] })).toThrow(
			new TypeError("Expected root: budgets, relations, and direction require a root"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, { direction: "out" })).toThrow(
			new TypeError("Expected root: budgets, relations, and direction require a root"),
		);
	});

	it("rejects malformed budgets, relations, and direction values", () => {
		const store = vizFixtureStore();
		expect(() => buildEndoSemanticVisualStateV0(store, { root: C_ID, budgets: { maxDepth: -1 } })).toThrow(
			new TypeError("Expected budgets: an EndoGraphExpansionBudgetV0"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, { root: C_ID, relations: [1] })).toThrow(
			new TypeError("Expected relations: an array of well-formed relation strings"),
		);
		expect(() => buildEndoSemanticVisualStateV0(store, { root: C_ID, direction: "down" })).toThrow(
			new TypeError('Expected direction: "in" | "out" | "both"'),
		);
	});
});

describe("buildEndoSemanticVisualStateAtV0", () => {
	it("rebuilds the state at a past sequence of the log", () => {
		const store = createEndoGraphStoreV0();
		store.upsertObject(VIZ_NODES[0]);
		store.upsertObject(VIZ_NODES[1]);
		store.upsertObject(VIZ_NODES[2]);
		store.upsertObject(VIZ_NODES[3]);
		const at4 = buildEndoSemanticVisualStateAtV0(store, 4);
		expect(at4.source.sequence).toBe(4);
		expect(at4.nodes.map((node) => node.id)).toStrictEqual([A_ID, B_ID, C_ID, D_ID]);
		expect(at4.edges).toStrictEqual([]);
		expect(at4.missing).toStrictEqual([]);
		for (const object of VIZ_NODES.slice(4)) store.upsertObject(object);
		for (const edgeValue of VIZ_EDGES) store.upsertEdge(edgeValue);
		expect(buildEndoSemanticVisualStateAtV0(store, 15)).toStrictEqual(buildEndoSemanticVisualStateV0(store));
	});

	it("rejects a rooted build and a malformed sequence", () => {
		const store = vizFixtureStore();
		expect(() => buildEndoSemanticVisualStateAtV0(store, 5, { root: C_ID })).toThrow(
			new TypeError("Expected upToSequence: a whole-store build only"),
		);
		expect(() => buildEndoSemanticVisualStateAtV0(store, -1)).toThrow(
			new TypeError("Expected upToSequence: a non-negative integer"),
		);
		expect(() => buildEndoSemanticVisualStateAtV0(store, 1.5)).toThrow(
			new TypeError("Expected upToSequence: a non-negative integer"),
		);
	});
});
