// The Phase 4 test graph: a small cognition graph carrying recorded visual-signal payload keys — attention,
// cluster, uncertainty, atmosphere, and camera-intent — including out-of-range and mistyped values, one
// non-object payload, and one dangling edge (g-1 → ghost, where ghost is never stored). The identifiers sort
// so the scene-signal precedence (smallest node identifier decides) is exercised: a-1 records the winning
// atmosphere and camera-intent, and f-1 records losing (one invalid) values for the same signals. Shared by
// the visualization suites.

import { createEndoGraphStoreV0, type EndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoGraphEdgeV0 } from "../protocol/graph.ts";
import type { EndoObjectV0 } from "../protocol/object.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";

export const A_ID = "endo.node.a-1";
export const B_ID = "endo.node.b-1";
export const C_ID = "endo.node.c-1";
export const D_ID = "endo.node.d-1";
export const E_ID = "endo.node.e-1";
export const F_ID = "endo.node.f-1";
export const G_ID = "endo.node.g-1";
export const H_ID = "endo.node.h-1";
export const GHOST_ID = "endo.node.ghost";

export function vizNode(id: string, kind: string, payload: JsonValueV0): EndoObjectV0 {
	return {
		schemaVersion: "endo.object.v0",
		id,
		kind,
		payload,
		observedIn: "endo.event.session.started",
	};
}

function vizEdge(id: string, source: string, target: string, relation: string): EndoGraphEdgeV0 {
	return {
		schemaVersion: "endo.edge.v0",
		id,
		source,
		target,
		relation,
		observedIn: "endo.event.session.started",
	};
}

export const VIZ_NODES: EndoObjectV0[] = [
	vizNode(A_ID, "thought", { atmosphere: "storm" }),
	vizNode(B_ID, "claim", { "camera-intent": { focusNodeId: A_ID, frame: "node" } }),
	vizNode(C_ID, "hypothesis", { attention: 0.8, cluster: "planning", uncertainty: 0.2 }),
	vizNode(D_ID, "observation", "a raw observation"),
	vizNode(E_ID, "tool-call", {}),
	vizNode(F_ID, "model-call", { attention: "high", atmosphere: "calm", "camera-intent": "not-an-object" }),
	vizNode(G_ID, "model-response", { uncertainty: 1.5 }),
	vizNode(H_ID, "tool-result", {}),
];

export const VIZ_EDGES: EndoGraphEdgeV0[] = [
	vizEdge("endo.edge.v1", A_ID, B_ID, "derived-from"),
	vizEdge("endo.edge.v2", B_ID, C_ID, "supports"),
	vizEdge("endo.edge.v3", C_ID, G_ID, "contradicts"),
	vizEdge("endo.edge.v4", E_ID, H_ID, "tool-produced"),
	vizEdge("endo.edge.v5", F_ID, G_ID, "model-produced"),
	vizEdge("endo.edge.v6", A_ID, G_ID, "references"),
	vizEdge("endo.edge.v7", G_ID, GHOST_ID, "supports"),
];

export function vizFixtureStore(): EndoGraphStoreV0 {
	const store = createEndoGraphStoreV0();
	for (const object of VIZ_NODES) store.upsertObject(object);
	for (const edgeValue of VIZ_EDGES) store.upsertEdge(edgeValue);
	return store;
}
