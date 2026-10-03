import { describe, expect, it } from "vitest";
import type { EndoSemanticVisualStateV0 } from "../protocol/visualization.ts";
import { renderDreamSceneV0 } from "../visualization/dream.ts";
import { buildEndoSemanticVisualStateV0 } from "../visualization/semantic-state.ts";
import { A_ID, C_ID, E_ID, F_ID, G_ID, H_ID, vizFixtureStore } from "./visualization-fixture.ts";

describe("renderDreamSceneV0", () => {
	it("the topology echoes the projected graph with depth and the recorded clusters", () => {
		const scene = renderDreamSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(scene.topology.nodes.map((node) => node.id)).toStrictEqual([
			A_ID,
			"endo.node.b-1",
			C_ID,
			"endo.node.d-1",
			E_ID,
			F_ID,
			G_ID,
			"endo.node.h-1",
		]);
		const byId = new Map(scene.topology.nodes.map((node) => [node.id, node]));
		expect(byId.get(C_ID)).toStrictEqual({
			schemaVersion: "endo.dream-topology-node.v0",
			id: C_ID,
			depth: 2,
			cluster: "planning",
		});
		expect(byId.get(A_ID)?.cluster).toBeNull();
		expect(scene.topology.edges).toStrictEqual(buildEndoSemanticVisualStateV0(vizFixtureStore()).edges);
	});

	it("the attention field and active regions project recorded attention; uncertainty projects recorded uncertainty", () => {
		const scene = renderDreamSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(scene.attentionField).toStrictEqual([
			{ schemaVersion: "endo.dream-field-entry.v0", nodeId: C_ID, value: 0.8 },
		]);
		expect(scene.activeRegions).toStrictEqual([
			{ schemaVersion: "endo.dream-active-region.v0", nodeId: C_ID, attention: 0.8 },
		]);
		// g-1's uncertainty is unrecognized (1.5), so only c-1's recorded 0.2 is projected — never invented
		expect(scene.uncertaintyField).toStrictEqual([
			{ schemaVersion: "endo.dream-field-entry.v0", nodeId: C_ID, value: 0.2 },
		]);
	});

	it("branching hypotheses list hypothesis nodes with their incident relations", () => {
		const scene = renderDreamSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(scene.branchingHypotheses).toStrictEqual([
			{
				schemaVersion: "endo.dream-branching-hypothesis.v0",
				nodeId: C_ID,
				relations: ["contradicts", "supports"],
			},
		]);
	});

	it("clusters group the recorded members and boundaries split the model and tool kinds", () => {
		const scene = renderDreamSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(scene.clusters).toStrictEqual([
			{ schemaVersion: "endo.dream-cluster.v0", label: "planning", memberIds: [C_ID] },
		]);
		expect(scene.boundaries).toStrictEqual([
			{ schemaVersion: "endo.dream-boundary.v0", kind: "model", nodeIds: [F_ID, G_ID] },
			{ schemaVersion: "endo.dream-boundary.v0", kind: "tool", nodeIds: [E_ID, H_ID] },
		]);
	});

	it("signals carry the recorded atmosphere and camera intent, and render missing motion explicitly", () => {
		const scene = renderDreamSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(scene.signals).toStrictEqual([
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

	it("a state carrying temporal motion keeps exactly one motion signal", () => {
		const state: EndoSemanticVisualStateV0 = buildEndoSemanticVisualStateV0(vizFixtureStore());
		const withMotion: EndoSemanticVisualStateV0 = {
			...state,
			signals: [
				...state.signals.filter((signal) => signal.signal !== "motion"),
				{
					schemaVersion: "endo.visual-signal.v0",
					signal: "motion",
					availability: "available",
					value: 3,
					origin: "derived",
				},
			],
		};
		const scene = renderDreamSceneV0(withMotion);
		expect(scene.signals.filter((signal) => signal.signal === "motion")).toStrictEqual([
			{
				schemaVersion: "endo.visual-signal.v0",
				signal: "motion",
				availability: "available",
				value: 3,
				origin: "derived",
			},
		]);
	});

	it("rejects input that is not a valid semantic visual state", () => {
		expect(() => renderDreamSceneV0({ schemaVersion: "endo.dream-scene.v0" })).toThrow(
			new TypeError("Expected state: a valid endo.semantic-visual-state.v0"),
		);
	});

	it("the same state always renders the same scene", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(renderDreamSceneV0(state)).toStrictEqual(renderDreamSceneV0(state));
	});
});
