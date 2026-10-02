import { describe, expect, it } from "vitest";
import {
	ENDO_ENGINEERING_ROW_TONES_V0,
	ENDO_ENGINEERING_SECTION_KINDS_V0,
	ENDO_NODE_SIGNAL_NAMES_V0,
	ENDO_SCENE_SIGNAL_NAMES_V0,
	ENDO_VISUAL_SIGNAL_AVAILABILITY_V0,
	ENDO_VISUAL_SIGNAL_ORIGINS_V0,
	type EndoDreamSceneV0,
	type EndoEngineeringSceneV0,
	type EndoSemanticVisualStateV0,
	type EndoVisualSignalV0,
	validateEndoDreamSceneV0,
	validateEndoEngineeringSceneV0,
	validateEndoSemanticVisualStateV0,
	validateEndoVisualSignalV0,
} from "../protocol/visualization.ts";

function signal(overrides: Record<string, unknown> = {}): EndoVisualSignalV0 {
	return {
		schemaVersion: "endo.visual-signal.v0",
		signal: "attention",
		availability: "available",
		value: 0.5,
		origin: "recorded",
		...overrides,
	};
}

function unavailableSignal(overrides: Record<string, unknown> = {}): EndoVisualSignalV0 {
	return {
		schemaVersion: "endo.visual-signal.v0",
		signal: "cluster",
		availability: "unavailable",
		reason: "no cluster recorded in the payload",
		...overrides,
	};
}

function node(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.semantic-visual-node.v0",
		id,
		kind: "thought",
		depth: 0,
		signals: [signal()],
		...overrides,
	};
}

function edge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.semantic-visual-edge.v0",
		id: "endo.edge.e-1",
		source: "endo.node.n-1",
		target: "endo.node.n-2",
		relation: "supports",
		observedIn: "endo.event.session.started",
		...overrides,
	};
}

function state(overrides: Record<string, unknown> = {}): EndoSemanticVisualStateV0 {
	return {
		schemaVersion: "endo.semantic-visual-state.v0",
		source: { schemaVersion: "endo.visual-state-source.v0", sequence: 1, root: null, truncated: false },
		nodes: [node("endo.node.n-1"), node("endo.node.n-2")],
		edges: [edge()],
		missing: [],
		signals: [signal({ signal: "atmosphere" })],
		...overrides,
	} as unknown as EndoSemanticVisualStateV0;
}

function engineeringScene(overrides: Record<string, unknown> = {}): EndoEngineeringSceneV0 {
	return {
		schemaVersion: "endo.engineering-scene.v0",
		source: { schemaVersion: "endo.visual-state-source.v0", sequence: 1, root: null, truncated: false },
		sections: [
			{
				schemaVersion: "endo.engineering-section.v0",
				kind: "status",
				rows: [{ schemaVersion: "endo.engineering-row.v0", label: "sequence", value: "1", tone: "live" }],
			},
		],
		...overrides,
	} as EndoEngineeringSceneV0;
}

function dreamScene(overrides: Record<string, unknown> = {}): EndoDreamSceneV0 {
	return {
		schemaVersion: "endo.dream-scene.v0",
		source: { schemaVersion: "endo.visual-state-source.v0", sequence: 1, root: null, truncated: false },
		topology: {
			schemaVersion: "endo.dream-topology.v0",
			nodes: [
				{ schemaVersion: "endo.dream-topology-node.v0", id: "endo.node.n-1", depth: 0, cluster: null },
				{ schemaVersion: "endo.dream-topology-node.v0", id: "endo.node.n-2", depth: 1, cluster: null },
			],
			edges: [edge() as never],
		},
		attentionField: [{ schemaVersion: "endo.dream-field-entry.v0", nodeId: "endo.node.n-1", value: 0.5 }],
		uncertaintyField: [],
		activeRegions: [{ schemaVersion: "endo.dream-active-region.v0", nodeId: "endo.node.n-1", attention: 0.5 }],
		branchingHypotheses: [],
		clusters: [],
		boundaries: [
			{ schemaVersion: "endo.dream-boundary.v0", kind: "model", nodeIds: [] },
			{ schemaVersion: "endo.dream-boundary.v0", kind: "tool", nodeIds: [] },
		],
		signals: [unavailableSignal({ signal: "motion", reason: "no temporal motion recorded" })],
		...overrides,
	} as EndoDreamSceneV0;
}

describe("visualization v0 tuples", () => {
	it("pins the availability, origin, and signal-name vocabularies", () => {
		expect(ENDO_VISUAL_SIGNAL_AVAILABILITY_V0).toStrictEqual(["available", "unavailable", "unrecognized"]);
		expect(ENDO_VISUAL_SIGNAL_ORIGINS_V0).toStrictEqual(["recorded", "derived"]);
		expect(ENDO_NODE_SIGNAL_NAMES_V0).toStrictEqual(["attention", "cluster", "uncertainty"]);
		expect(ENDO_SCENE_SIGNAL_NAMES_V0).toStrictEqual(["atmosphere", "camera-intent", "motion"]);
		expect(ENDO_ENGINEERING_ROW_TONES_V0).toStrictEqual(["live", "pending", "warn", "idle"]);
		expect(ENDO_ENGINEERING_SECTION_KINDS_V0).toStrictEqual([
			"claims-evidence",
			"degraded-states",
			"graph-inspector",
			"status",
		]);
	});
});

describe("validateEndoVisualSignalV0", () => {
	it("accepts a valid available signal and returns it unchanged", () => {
		const value = signal();
		expect(validateEndoVisualSignalV0(value)).toBe(value);
	});

	it("accepts unavailable and unrecognized signals in their co-presence", () => {
		expect(validateEndoVisualSignalV0(unavailableSignal())).not.toBeNull();
		expect(
			validateEndoVisualSignalV0({
				schemaVersion: "endo.visual-signal.v0",
				signal: "uncertainty",
				availability: "unrecognized",
				value: 7,
				reason: "outside the v0 range 0..1",
			}),
		).not.toBeNull();
	});

	it("rejects unknown fields and a wrong schema version", () => {
		expect(validateEndoVisualSignalV0(signal({ extra: 1 }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ schemaVersion: "endo.visual-signal.v1" }))).toBeNull();
	});

	it("rejects malformed signal names", () => {
		expect(validateEndoVisualSignalV0(signal({ signal: "" }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ signal: 1 }))).toBeNull();
	});

	it("enforces the value / origin / reason co-presence per availability", () => {
		expect(validateEndoVisualSignalV0(unavailableSignal({ value: 1 }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ value: undefined }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ value: NaN }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ origin: undefined }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ origin: "model" }))).toBeNull();
		expect(validateEndoVisualSignalV0(unavailableSignal({ origin: "recorded" }))).toBeNull();
		expect(validateEndoVisualSignalV0(unavailableSignal({ reason: undefined }))).toBeNull();
		expect(validateEndoVisualSignalV0(unavailableSignal({ reason: "" }))).toBeNull();
		expect(validateEndoVisualSignalV0(signal({ reason: "fine" }))).toBeNull();
		expect(validateEndoVisualSignalV0(unavailableSignal({ availability: "unrecognized" }))).toBeNull();
	});
});

describe("validateEndoSemanticVisualStateV0", () => {
	it("accepts a valid state and returns it unchanged", () => {
		const value = state();
		expect(validateEndoSemanticVisualStateV0(value)).toBe(value);
	});

	it("rejects unknown fields and a wrong schema version", () => {
		expect(validateEndoSemanticVisualStateV0(state({ extra: 1 }))).toBeNull();
		expect(validateEndoSemanticVisualStateV0(state({ schemaVersion: "endo.semantic-visual-state.v1" }))).toBeNull();
	});

	it("rejects a source that fails its own validator", () => {
		expect(
			validateEndoSemanticVisualStateV0(
				state({
					source: { schemaVersion: "endo.visual-state-source.v0", sequence: -1, root: null, truncated: false },
				}),
			),
		).toBeNull();
	});

	it("rejects nodes that are unsorted, duplicated, or fail their own validator", () => {
		expect(
			validateEndoSemanticVisualStateV0(state({ nodes: [node("endo.node.n-2"), node("endo.node.n-1")] })),
		).toBeNull();
		expect(
			validateEndoSemanticVisualStateV0(state({ nodes: [node("endo.node.n-1"), node("endo.node.n-1")] })),
		).toBeNull();
		expect(
			validateEndoSemanticVisualStateV0(
				state({ nodes: [node("endo.node.n-1", { id: "endo.session.x" }), node("endo.node.n-2")] }),
			),
		).toBeNull();
		expect(
			validateEndoSemanticVisualStateV0(
				state({ nodes: [node("endo.node.n-1", { depth: -1 }), node("endo.node.n-2")] }),
			),
		).toBeNull();
	});

	it("rejects a node whose signals are unsorted or carry a name twice", () => {
		expect(
			validateEndoSemanticVisualStateV0(
				state({
					nodes: [
						node("endo.node.n-1", {
							signals: [signal({ signal: "uncertainty" }), signal({ signal: "attention" })],
						}),
						node("endo.node.n-2"),
					],
				}),
			),
		).toBeNull();
		expect(
			validateEndoSemanticVisualStateV0(
				state({
					nodes: [
						node("endo.node.n-1", {
							signals: [signal({ signal: "attention" }), signal({ signal: "attention" })],
						}),
						node("endo.node.n-2"),
					],
				}),
			),
		).toBeNull();
	});

	it("rejects edges that are unsorted or fail their own validator", () => {
		expect(
			validateEndoSemanticVisualStateV0(
				state({ edges: [edge({ id: "endo.edge.e-2" }), edge({ id: "endo.edge.e-1" })] }),
			),
		).toBeNull();
		expect(validateEndoSemanticVisualStateV0(state({ edges: [edge({ relation: 3 })] }))).toBeNull();
	});

	it("rejects an edge endpoint that is neither a projected node nor missing", () => {
		expect(validateEndoSemanticVisualStateV0(state({ edges: [edge({ target: "endo.node.n-9" })] }))).toBeNull();
		expect(
			validateEndoSemanticVisualStateV0(
				state({ edges: [edge({ target: "endo.node.n-9" })], missing: ["endo.node.n-9"] }),
			),
		).not.toBeNull();
	});

	it("rejects missing lists that are unsorted or overlap the projected nodes", () => {
		expect(validateEndoSemanticVisualStateV0(state({ missing: ["endo.node.n-2", "endo.node.n-1"] }))).toBeNull();
		expect(validateEndoSemanticVisualStateV0(state({ missing: ["endo.node.n-1"] }))).toBeNull();
		expect(validateEndoSemanticVisualStateV0(state({ missing: ["endo.session.x"] }))).toBeNull();
	});

	it("rejects scene signals that are unsorted or carry a name twice", () => {
		expect(
			validateEndoSemanticVisualStateV0(
				state({ signals: [signal({ signal: "motion" }), signal({ signal: "atmosphere" })] }),
			),
		).toBeNull();
		expect(
			validateEndoSemanticVisualStateV0(
				state({ signals: [signal({ signal: "atmosphere" }), signal({ signal: "atmosphere" })] }),
			),
		).toBeNull();
	});
});

describe("validateEndoEngineeringSceneV0", () => {
	it("accepts a valid scene and returns it unchanged", () => {
		const value = engineeringScene();
		expect(validateEndoEngineeringSceneV0(value)).toBe(value);
	});

	it("rejects rows with an empty label, a non-string value, or a tone outside the vocabulary", () => {
		const section = (rows: Record<string, unknown>[]) =>
			engineeringScene({ sections: [{ schemaVersion: "endo.engineering-section.v0", kind: "status", rows }] });
		expect(
			validateEndoEngineeringSceneV0(
				section([{ schemaVersion: "endo.engineering-row.v0", label: "", value: "x", tone: "live" }]),
			),
		).toBeNull();
		expect(
			validateEndoEngineeringSceneV0(
				section([{ schemaVersion: "endo.engineering-row.v0", label: "x", value: 1, tone: "live" }]),
			),
		).toBeNull();
		expect(
			validateEndoEngineeringSceneV0(
				section([{ schemaVersion: "endo.engineering-row.v0", label: "x", value: "y", tone: "bright" }]),
			),
		).toBeNull();
	});

	it("rejects sections without rows, with a malformed kind, or a scene unsorted in kind", () => {
		expect(
			validateEndoEngineeringSceneV0(
				engineeringScene({
					sections: [{ schemaVersion: "endo.engineering-section.v0", kind: "status", rows: [] }],
				}),
			),
		).toBeNull();
		expect(
			validateEndoEngineeringSceneV0(
				engineeringScene({
					sections: [
						{
							schemaVersion: "endo.engineering-section.v0",
							kind: 1,
							rows: [{ schemaVersion: "endo.engineering-row.v0", label: "a", value: "b", tone: "idle" }],
						},
					],
				}),
			),
		).toBeNull();
		const row = { schemaVersion: "endo.engineering-row.v0", label: "a", value: "b", tone: "idle" };
		expect(
			validateEndoEngineeringSceneV0(
				engineeringScene({
					sections: [
						{ schemaVersion: "endo.engineering-section.v0", kind: "status", rows: [row] },
						{ schemaVersion: "endo.engineering-section.v0", kind: "claims-evidence", rows: [row] },
					],
				}),
			),
		).toBeNull();
	});
});

describe("validateEndoDreamSceneV0", () => {
	it("accepts a valid scene and returns it unchanged", () => {
		const value = dreamScene();
		expect(validateEndoDreamSceneV0(value)).toBe(value);
	});

	it("rejects field entries outside 0..1 and region attention outside 0..1", () => {
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					attentionField: [{ schemaVersion: "endo.dream-field-entry.v0", nodeId: "endo.node.n-1", value: 1.5 }],
				}),
			),
		).toBeNull();
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					activeRegions: [
						{ schemaVersion: "endo.dream-active-region.v0", nodeId: "endo.node.n-1", attention: -0.1 },
					],
				}),
			),
		).toBeNull();
	});

	it("rejects fields that are unsorted or reference a node that is not in the topology", () => {
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					attentionField: [
						{ schemaVersion: "endo.dream-field-entry.v0", nodeId: "endo.node.n-2", value: 0.1 },
						{ schemaVersion: "endo.dream-field-entry.v0", nodeId: "endo.node.n-1", value: 0.5 },
					],
				}),
			),
		).toBeNull();
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					attentionField: [{ schemaVersion: "endo.dream-field-entry.v0", nodeId: "endo.node.n-9", value: 0.5 }],
				}),
			),
		).toBeNull();
	});

	it("rejects hypothesis relations that are unsorted or duplicated", () => {
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					branchingHypotheses: [
						{
							schemaVersion: "endo.dream-branching-hypothesis.v0",
							nodeId: "endo.node.n-1",
							relations: ["supports", "supports"],
						},
					],
				}),
			),
		).toBeNull();
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					branchingHypotheses: [
						{
							schemaVersion: "endo.dream-branching-hypothesis.v0",
							nodeId: "endo.node.n-1",
							relations: ["supports", "contradicts"],
						},
					],
				}),
			),
		).toBeNull();
	});

	it("rejects clusters with an empty member list and boundaries with a kind outside model | tool", () => {
		expect(
			validateEndoDreamSceneV0(
				dreamScene({ clusters: [{ schemaVersion: "endo.dream-cluster.v0", label: "c", memberIds: [] }] }),
			),
		).toBeNull();
		expect(
			validateEndoDreamSceneV0(
				dreamScene({ boundaries: [{ schemaVersion: "endo.dream-boundary.v0", kind: "mixed", nodeIds: [] }] }),
			),
		).toBeNull();
	});

	it("rejects topology edges whose endpoints are not topology nodes", () => {
		expect(
			validateEndoDreamSceneV0(
				dreamScene({
					topology: {
						schemaVersion: "endo.dream-topology.v0",
						nodes: [
							{ schemaVersion: "endo.dream-topology-node.v0", id: "endo.node.n-1", depth: 0, cluster: null },
							{ schemaVersion: "endo.dream-topology-node.v0", id: "endo.node.n-2", depth: 1, cluster: null },
						],
						edges: [edge({ target: "endo.node.n-9" }) as never],
					},
				}),
			),
		).toBeNull();
	});
});
