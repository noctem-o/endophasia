import { describe, expect, it } from "vitest";
import { createEndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoSemanticVisualStateV0 } from "../protocol/visualization.ts";
import { createEndoSemanticVisualUpdaterV0 } from "../visualization/live.ts";
import { C_ID, vizNode } from "./visualization-fixture.ts";

function motionOf(state: EndoSemanticVisualStateV0) {
	return state.signals.find((signal) => signal.signal === "motion");
}

describe("createEndoSemanticVisualUpdaterV0", () => {
	it("delivers the initial build synchronously, without a derived motion", () => {
		const store = createEndoGraphStoreV0();
		store.upsertObject(vizNode("endo.node.live-1", "thought", {}));
		const delivered: EndoSemanticVisualStateV0[] = [];
		createEndoSemanticVisualUpdaterV0(store, undefined, (state) => delivered.push(state));
		expect(delivered.length).toBe(1);
		expect(delivered[0].nodes.map((node) => node.id)).toStrictEqual(["endo.node.live-1"]);
		expect(motionOf(delivered[0])).toStrictEqual({
			schemaVersion: "endo.visual-signal.v0",
			signal: "motion",
			availability: "unavailable",
			reason: "temporal motion is derived by the live updater",
		});
	});

	it("each graph change delivers the rebuilt state with the sequence delta as a derived motion", () => {
		const store = createEndoGraphStoreV0();
		const delivered: EndoSemanticVisualStateV0[] = [];
		createEndoSemanticVisualUpdaterV0(store, undefined, (state) => delivered.push(state));
		store.upsertObject(vizNode("endo.node.live-2", "thought", {}));
		expect(delivered.length).toBe(2);
		expect(delivered[1].nodes.map((node) => node.id)).toStrictEqual(["endo.node.live-2"]);
		expect(motionOf(delivered[1])).toStrictEqual({
			schemaVersion: "endo.visual-signal.v0",
			signal: "motion",
			availability: "available",
			value: 1,
			origin: "derived",
		});
		store.upsertObject(vizNode("endo.node.live-3", "thought", {}));
		expect(motionOf(delivered[2])?.value).toBe(1);
	});

	it("a dropped delivery does not advance the motion baseline", () => {
		const store = createEndoGraphStoreV0();
		let count = 0;
		const delivered: EndoSemanticVisualStateV0[] = [];
		createEndoSemanticVisualUpdaterV0(store, undefined, (state) => {
			count += 1;
			if (count === 2) throw new Error("drop");
			delivered.push(state);
		});
		store.upsertObject(vizNode("endo.node.live-4", "thought", {}));
		store.upsertObject(vizNode("endo.node.live-5", "thought", {}));
		// delivery 2 threw; delivery 3 measures the delta from the initial build
		expect(motionOf(delivered[1])?.value).toBe(2);
		expect(delivered[1].nodes.map((node) => node.id)).toStrictEqual(["endo.node.live-4", "endo.node.live-5"]);
	});

	it("unsubscribe stops the deliveries and is idempotent", () => {
		const store = createEndoGraphStoreV0();
		const delivered: EndoSemanticVisualStateV0[] = [];
		const updater = createEndoSemanticVisualUpdaterV0(store, undefined, (state) => delivered.push(state));
		expect(updater.active).toBe(true);
		store.upsertObject(vizNode("endo.node.live-6", "thought", {}));
		expect(delivered.length).toBe(2);
		updater.unsubscribe();
		updater.unsubscribe();
		expect(updater.active).toBe(false);
		store.upsertObject(vizNode("endo.node.live-7", "thought", {}));
		expect(delivered.length).toBe(2);
		expect(updater.state).toBe(delivered[1]);
	});

	it("a self-unsubscribe inside a delivery completes that delivery and stops the next", () => {
		const store = createEndoGraphStoreV0();
		const delivered: EndoSemanticVisualStateV0[] = [];
		const updater = createEndoSemanticVisualUpdaterV0(store, undefined, (state) => {
			delivered.push(state);
			if (delivered.length === 2) updater.unsubscribe();
		});
		store.upsertObject(vizNode("endo.node.live-8", "thought", {}));
		store.upsertObject(vizNode("endo.node.live-9", "thought", {}));
		expect(delivered.length).toBe(2);
	});

	it("passes the build options through on every rebuild", () => {
		const store = createEndoGraphStoreV0();
		store.upsertObject(vizNode(C_ID, "hypothesis", { attention: 0.5 }));
		store.upsertObject(vizNode("endo.node.live-10", "thought", {}));
		const delivered: EndoSemanticVisualStateV0[] = [];
		createEndoSemanticVisualUpdaterV0(store, { root: C_ID }, (state) => delivered.push(state));
		expect(delivered[0].source.root).toBe(C_ID);
		expect(delivered[0].nodes.map((node) => node.id)).toStrictEqual([C_ID]);
		store.upsertObject(vizNode("endo.node.live-11", "thought", {}));
		expect(delivered[1].source.root).toBe(C_ID);
	});

	it("a throwing listener on the initial delivery propagates from the create call", () => {
		const store = createEndoGraphStoreV0();
		expect(() =>
			createEndoSemanticVisualUpdaterV0(store, undefined, () => {
				throw new Error("boom");
			}),
		).toThrow(new Error("boom"));
	});
});
