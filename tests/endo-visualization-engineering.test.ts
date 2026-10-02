import { describe, expect, it } from "vitest";
import { createEndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoEngineeringSectionV0 } from "../protocol/visualization.ts";
import { renderEngineeringSceneV0 } from "../visualization/engineering.ts";
import { buildEndoSemanticVisualStateV0 } from "../visualization/semantic-state.ts";
import { A_ID, B_ID, C_ID, F_ID, GHOST_ID, vizFixtureStore } from "./visualization-fixture.ts";

function sectionOf(scene: ReturnType<typeof renderEngineeringSceneV0>, kind: string): EndoEngineeringSectionV0 {
	const section = scene.sections.find((candidate) => candidate.kind === kind);
	if (section === undefined) throw new Error(`missing section ${kind}`);
	return section;
}

describe("renderEngineeringSceneV0", () => {
	it("renders exactly the four graph-derived sections, sorted by kind", () => {
		const scene = renderEngineeringSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(scene.sections.map((section) => section.kind)).toStrictEqual([
			"claims-evidence",
			"degraded-states",
			"graph-inspector",
			"status",
		]);
		expect(scene.source).toStrictEqual({
			schemaVersion: "endo.visual-state-source.v0",
			sequence: 15,
			root: null,
			truncated: false,
		});
	});

	it("the status section reports the build coordinates and the projected graph size", () => {
		const scene = renderEngineeringSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(sectionOf(scene, "status").rows).toStrictEqual([
			{ schemaVersion: "endo.engineering-row.v0", label: "sequence", value: "15", tone: "live" },
			{ schemaVersion: "endo.engineering-row.v0", label: "root", value: "whole store", tone: "idle" },
			{ schemaVersion: "endo.engineering-row.v0", label: "nodes", value: "8", tone: "live" },
			{ schemaVersion: "endo.engineering-row.v0", label: "edges", value: "7", tone: "live" },
			{ schemaVersion: "endo.engineering-row.v0", label: "missing", value: "1", tone: "warn" },
		]);
	});

	it("the graph-inspector lists every projected node, edge, and missing endpoint", () => {
		const scene = renderEngineeringSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		const rows = sectionOf(scene, "graph-inspector").rows;
		expect(rows.length).toBe(16);
		expect(rows[0]).toStrictEqual({
			schemaVersion: "endo.engineering-row.v0",
			label: A_ID,
			value: "kind thought · depth 0",
			tone: "idle",
		});
		expect(rows).toContainEqual({
			schemaVersion: "endo.engineering-row.v0",
			label: "endo.edge.v1",
			value: `${A_ID} --derived-from--> ${B_ID}`,
			tone: "idle",
		});
		expect(rows).toContainEqual({
			schemaVersion: "endo.engineering-row.v0",
			label: GHOST_ID,
			value: "missing",
			tone: "warn",
		});
	});

	it("claims-evidence marks stanced claim and hypothesis nodes live and counts the stances", () => {
		const scene = renderEngineeringSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		expect(sectionOf(scene, "claims-evidence").rows).toStrictEqual([
			{
				schemaVersion: "endo.engineering-row.v0",
				label: B_ID,
				value: "kind claim · stance recorded",
				tone: "live",
			},
			{
				schemaVersion: "endo.engineering-row.v0",
				label: C_ID,
				value: "kind hypothesis · stance recorded",
				tone: "live",
			},
			{ schemaVersion: "endo.engineering-row.v0", label: "supports", value: "2", tone: "idle" },
			{ schemaVersion: "endo.engineering-row.v0", label: "contradicts", value: "1", tone: "idle" },
		]);
	});

	it("degraded-states lists every unavailable and unrecognized signal with its recorded reason", () => {
		const scene = renderEngineeringSceneV0(buildEndoSemanticVisualStateV0(vizFixtureStore()));
		const rows = sectionOf(scene, "degraded-states").rows;
		expect(rows.length).toBe(22);
		expect(rows.every((row) => row.tone === "warn")).toBe(true);
		expect(rows).toContainEqual({
			schemaVersion: "endo.engineering-row.v0",
			label: `${F_ID} attention`,
			value: 'recorded attention "high" is outside the v0 range 0..1',
			tone: "warn",
		});
		expect(rows).toContainEqual({
			schemaVersion: "endo.engineering-row.v0",
			label: "scene motion",
			value: "temporal motion is derived by the live updater",
			tone: "warn",
		});
	});

	it("an empty store renders every section with an explicit row", () => {
		const scene = renderEngineeringSceneV0(buildEndoSemanticVisualStateV0(createEndoGraphStoreV0()));
		expect(sectionOf(scene, "status").rows).toContainEqual({
			schemaVersion: "endo.engineering-row.v0",
			label: "nodes",
			value: "0",
			tone: "idle",
		});
		expect(sectionOf(scene, "graph-inspector").rows).toStrictEqual([
			{
				schemaVersion: "endo.engineering-row.v0",
				label: "graph",
				value: "no nodes or edges projected",
				tone: "idle",
			},
		]);
		expect(sectionOf(scene, "claims-evidence").rows).toStrictEqual([
			{
				schemaVersion: "endo.engineering-row.v0",
				label: "claims",
				value: "no claim or hypothesis nodes projected",
				tone: "idle",
			},
		]);
		expect(sectionOf(scene, "degraded-states").rows).toStrictEqual([
			{
				schemaVersion: "endo.engineering-row.v0",
				label: "scene atmosphere",
				value: "no node records the scene signal",
				tone: "warn",
			},
			{
				schemaVersion: "endo.engineering-row.v0",
				label: "scene camera-intent",
				value: "no node records the scene signal",
				tone: "warn",
			},
			{
				schemaVersion: "endo.engineering-row.v0",
				label: "scene motion",
				value: "temporal motion is derived by the live updater",
				tone: "warn",
			},
		]);
	});

	it("rejects input that is not a valid semantic visual state", () => {
		expect(() => renderEngineeringSceneV0({ schemaVersion: "endo.semantic-visual-state.v1" })).toThrow(
			new TypeError("Expected state: a valid endo.semantic-visual-state.v0"),
		);
		expect(() => renderEngineeringSceneV0(null)).toThrow(
			new TypeError("Expected state: a valid endo.semantic-visual-state.v0"),
		);
	});

	it("the same state always renders the same scene", () => {
		const state = buildEndoSemanticVisualStateV0(vizFixtureStore());
		expect(renderEngineeringSceneV0(state)).toStrictEqual(renderEngineeringSceneV0(state));
	});
});
