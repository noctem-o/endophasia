// The Dream scene v0: the bespoke projection of the same semantic visual state (README: "Two presentation
// surfaces should share one cognition substrate"). Every field is a projection of recorded cognition state or
// of the graph's structure; the scene never invents cognition just to make the scene look interesting.
// Camera intent, atmosphere, and temporal motion ride in `signals` under their documented names — when the
// state carries no temporal motion (a single build has no predecessor), the scene renders an explicit
// unavailable motion signal rather than a silent omission.

import {
	type EndoDreamActiveRegionV0,
	type EndoDreamBoundaryV0,
	type EndoDreamBranchingHypothesisV0,
	type EndoDreamClusterV0,
	type EndoDreamFieldEntryV0,
	type EndoDreamSceneV0,
	type EndoDreamTopologyNodeV0,
	type EndoSemanticVisualEdgeV0,
	type EndoVisualSignalV0,
	validateEndoSemanticVisualStateV0,
} from "../protocol/visualization.ts";

/**
 * Projects the semantic visual state into the Dream scene. The input is validated with its own validator
 * (TypeError when invalid); the projection is pure — the same state always produces the same scene.
 */
export function renderDreamSceneV0(state: unknown): EndoDreamSceneV0 {
	const checked = validateEndoSemanticVisualStateV0(state);
	if (checked === null) throw new TypeError("Expected state: a valid endo.semantic-visual-state.v0");

	const clusterOf = new Map<string, string | null>();
	const attentionField: EndoDreamFieldEntryV0[] = [];
	const uncertaintyField: EndoDreamFieldEntryV0[] = [];
	const activeRegions: EndoDreamActiveRegionV0[] = [];
	const clusterMembers = new Map<string, string[]>();
	for (const node of checked.nodes) {
		let cluster: string | null = null;
		for (const signal of node.signals) {
			if (signal.availability !== "available") continue;
			if (signal.signal === "cluster" && typeof signal.value === "string") {
				cluster = signal.value;
				const members = clusterMembers.get(cluster) ?? [];
				members.push(node.id);
				clusterMembers.set(cluster, members);
			} else if (signal.signal === "attention" && typeof signal.value === "number") {
				attentionField.push({ schemaVersion: "endo.dream-field-entry.v0", nodeId: node.id, value: signal.value });
				activeRegions.push({
					schemaVersion: "endo.dream-active-region.v0",
					nodeId: node.id,
					attention: signal.value,
				});
			} else if (signal.signal === "uncertainty" && typeof signal.value === "number") {
				uncertaintyField.push({ schemaVersion: "endo.dream-field-entry.v0", nodeId: node.id, value: signal.value });
			}
		}
		clusterOf.set(node.id, cluster);
	}

	const nodes: EndoDreamTopologyNodeV0[] = checked.nodes.map((node) => ({
		schemaVersion: "endo.dream-topology-node.v0",
		id: node.id,
		depth: node.depth,
		cluster: clusterOf.get(node.id) ?? null,
	}));

	const branchingHypotheses: EndoDreamBranchingHypothesisV0[] = checked.nodes
		.filter((node) => node.kind === "hypothesis")
		.map((node) => ({
			schemaVersion: "endo.dream-branching-hypothesis.v0",
			nodeId: node.id,
			relations: [
				...new Set(
					checked.edges
						.filter((edge) => edge.source === node.id || edge.target === node.id)
						.map((edge) => edge.relation),
				),
			].sort(),
		}));

	const clusters: EndoDreamClusterV0[] = [...clusterMembers.entries()]
		.map(
			([label, memberIds]): EndoDreamClusterV0 => ({
				schemaVersion: "endo.dream-cluster.v0",
				label,
				memberIds: [...memberIds].sort(),
			}),
		)
		.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

	const boundaries: EndoDreamBoundaryV0[] = [
		{
			schemaVersion: "endo.dream-boundary.v0",
			kind: "model",
			nodeIds: checked.nodes.filter((node) => node.kind.startsWith("model-")).map((node) => node.id),
		},
		{
			schemaVersion: "endo.dream-boundary.v0",
			kind: "tool",
			nodeIds: checked.nodes.filter((node) => node.kind.startsWith("tool-")).map((node) => node.id),
		},
	];

	const hasMotion = checked.signals.some((signal) => signal.signal === "motion");
	const unavailable: EndoVisualSignalV0 = {
		schemaVersion: "endo.visual-signal.v0",
		signal: "motion",
		availability: "unavailable",
		reason: "no temporal motion recorded",
	};
	const signals: EndoVisualSignalV0[] = hasMotion
		? checked.signals
		: [...checked.signals, unavailable].sort((a, b) => (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0));

	const edges: EndoSemanticVisualEdgeV0[] = checked.edges;

	return {
		schemaVersion: "endo.dream-scene.v0",
		source: checked.source,
		topology: { schemaVersion: "endo.dream-topology.v0", nodes, edges },
		attentionField,
		uncertaintyField,
		activeRegions,
		branchingHypotheses,
		clusters,
		boundaries,
		signals,
	};
}
