// The Phase 3 test graph: a small session/run/tool/model graph with one dangling edge (claim-1 → ghost, where
// ghost is never stored). Shared by the store, traversal, projection, and subscription suites.

import { createEndoGraphStoreV0, type EndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoGraphEdgeV0 } from "../protocol/graph.ts";
import type { EndoObjectV0 } from "../protocol/object.ts";

export const SESSION_ID = "endo.node.session-1";
export const RUN_ID = "endo.node.run-1";
export const TOOL_CALL_ID = "endo.node.tool-call-1";
export const TOOL_RESULT_ID = "endo.node.tool-result-1";
export const MODEL_CALL_ID = "endo.node.model-call-1";
export const CLAIM_ID = "endo.node.claim-1";
export const GHOST_ID = "endo.node.ghost";

export function node(id: string, kind: string): EndoObjectV0 {
	return {
		schemaVersion: "endo.object.v0",
		id,
		kind,
		payload: {},
		observedIn: "endo.event.session.started",
	};
}

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

export const FIXTURE_NODES: EndoObjectV0[] = [
	node(SESSION_ID, "session"),
	node(RUN_ID, "run"),
	node(TOOL_CALL_ID, "tool-call"),
	node(TOOL_RESULT_ID, "tool-result"),
	node(MODEL_CALL_ID, "model-call"),
	node(CLAIM_ID, "claim"),
];

export const FIXTURE_EDGES: EndoGraphEdgeV0[] = [
	edge("endo.edge.e1", SESSION_ID, RUN_ID, "derived-from"),
	edge("endo.edge.e2", RUN_ID, TOOL_CALL_ID, "references"),
	edge("endo.edge.e3", TOOL_CALL_ID, TOOL_RESULT_ID, "tool-produced"),
	edge("endo.edge.e4", RUN_ID, MODEL_CALL_ID, "references"),
	edge("endo.edge.e5", MODEL_CALL_ID, CLAIM_ID, "model-produced"),
	edge("endo.edge.e6", CLAIM_ID, GHOST_ID, "supports"),
	edge("endo.edge.e7", SESSION_ID, MODEL_CALL_ID, "related-to"),
];

export function fixtureStore(): EndoGraphStoreV0 {
	const store = createEndoGraphStoreV0();
	for (const object of FIXTURE_NODES) store.upsertObject(object);
	for (const edgeValue of FIXTURE_EDGES) store.upsertEdge(edgeValue);
	return store;
}
