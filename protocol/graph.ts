// The Endo graph v0 schema: the edge envelope for the cognition graph, the budgeted-expansion grammar, the
// traversal snapshot, and the change notification. The normalized object store, traversal, subscriptions, and
// temporal projections live in graph/; this is the wire shape and the identity. The object envelope for nodes is
// protocol/object.ts (Phase 1).

import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { type EndoObjectV0, validateEndoObjectV0 } from "./object.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";

/**
 * The useful object types of the cognition graph (README "Cognition graph"): the recommended v0 node-kind
 * vocabulary. The node kind is open but well-formed (the README list is "include:", and a kind like
 * `session.started` is equally valid); this tuple documents the vocabulary the runtime is expected to emit, and
 * traversal filters may match against it.
 */
export const ENDO_NODE_KINDS_V0 = [
	"session",
	"run",
	"turn",
	"context",
	"thought",
	"observation",
	"claim",
	"hypothesis",
	"decision",
	"tool-call",
	"tool-result",
	"model-call",
	"model-response",
	"artifact",
	"candidate",
	"evaluation",
	"experiment",
	"visualization-state",
] as const satisfies readonly string[];

/**
 * The useful relationships of the cognition graph (README "Cognition graph"): the recommended v0 edge-relation
 * vocabulary. The relation is open but well-formed (the README list is "include:"); this tuple documents the
 * vocabulary and traversal filters may match against it.
 */
export const ENDO_EDGE_RELATIONS_V0 = [
	"derived-from",
	"supports",
	"contradicts",
	"depends-on",
	"references",
	"causes",
	"tool-produced",
	"model-produced",
	"supersedes",
	"related-to",
] as const satisfies readonly string[];

/**
 * An edge of the cognition graph: a recorded relationship between two objects. The graph is "a structured
 * projection of recorded state and relationships" (README), so an edge that is recorded belongs to the graph even
 * when one of its endpoints has not been (or will not be) recorded — traversal reports such endpoints as missing
 * rather than the store pretending they exist.
 */
export interface EndoGraphEdgeV0 {
	schemaVersion: "endo.edge.v0";
	/** A stable identifier (`endo.edge.*`). */
	id: string;
	/** The source object (`endo.node.*`). */
	source: string;
	/** The target object (`endo.node.*`). */
	target: string;
	/** The relationship, e.g. `derived-from`, `supports`; well-formed, open vocabulary. */
	relation: string;
	/** The identifier of the event that recorded this relationship (`endo.event.*`). */
	observedIn: string;
}

/**
 * The budget for a graph expansion (README "Cognition graph": "continue until depth / node / edge budget"). Every
 * field is optional; an absent budget is unbounded. Present budgets are positive integers.
 */
export interface EndoGraphExpansionBudgetV0 {
	/** The maximum hop count from the root (the root itself is depth 0). */
	maxDepth?: number;
	/** The maximum number of nodes in the snapshot. */
	maxNodes?: number;
	/** The maximum number of edges in the snapshot. */
	maxEdges?: number;
}

/**
 * A deterministic snapshot emitted by a budgeted graph expansion (README traversal pipeline:
 * root → frontier → batched expansion → dedupe / visited set → emit snapshot). `nodes` and `edges` are sorted by
 * identifier so the same store state and options always produce the same snapshot; `missing` lists the visited
 * node identifiers that have no object in the store; `truncated` is true when a budget stopped the expansion
 * before the frontier was exhausted.
 */
export interface EndoGraphSnapshotV0 {
	schemaVersion: "endo.graph-snapshot.v0";
	/** The expansion root (`endo.node.*`); it is `missing` when the store holds no object for it. */
	root: string;
	/** The snapshot nodes, sorted by identifier. */
	nodes: EndoObjectV0[];
	/** The recorded edges between snapshot nodes, sorted by identifier. */
	edges: EndoGraphEdgeV0[];
	/** The visited node identifiers with no object in the store, sorted. */
	missing: string[];
	/** True when a budget stopped the expansion before the frontier was exhausted. */
	truncated: boolean;
}

/**
 * A graph change notification for subscriptions: the object or edge at `id` received revision `revision`
 * (1-based per identifier) in the store. The store emits one change per upsert, in upsert order.
 */
export interface EndoGraphChangeV0 {
	schemaVersion: "endo.graph-change.v0";
	/** Which kind of graph material changed. */
	kind: "object" | "edge";
	/** The changed identifier (`endo.node.*` for objects, `endo.edge.*` for edges). */
	id: string;
	/** The 1-based revision number assigned by the store. */
	revision: number;
}

/**
 * A revision log entry of the normalized object store: the append-oriented record of one upsert. The store's log is
 * the evidence material from which temporal projections are computed (a projection at a sequence is the state the
 * log describes at that point), in the same append-oriented discipline as the Phase 2 event store.
 */
export interface EndoGraphRevisionV0 {
	schemaVersion: "endo.graph-revision.v0";
	/** The 1-based global sequence of this upsert in the store. */
	sequence: number;
	/** The change this revision records; `change.revision` is the per-identifier revision number. */
	change: EndoGraphChangeV0;
	/** The revision's value: an object for `change.kind === "object"`, an edge otherwise. */
	value: EndoObjectV0 | EndoGraphEdgeV0;
}

/**
 * A temporal projection of the graph: the state the store's revision log describes as of `upToSequence` — the
 * latest revision with sequence at most `upToSequence` for each identifier. `objects` and `edges` are sorted by
 * identifier, so the same log and sequence always produce the same projection. An identifier with no revision at
 * or before the sequence is simply absent from the projection.
 */
export interface EndoGraphProjectionV0 {
	schemaVersion: "endo.graph-projection.v0";
	/** The projection point: a non-negative store sequence (0 is the empty projection). */
	upToSequence: number;
	/** The objects visible at the projection point, sorted by identifier. */
	objects: EndoObjectV0[];
	/** The edges visible at the projection point, sorted by identifier. */
	edges: EndoGraphEdgeV0[];
}

function isPositiveIntegerV0(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

const ENDO_GRAPH_EDGE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "source", "target", "relation", "observedIn"]);

/**
 * Validates an edge envelope. Rejects unknown fields, identifiers in the wrong namespace, and malformed
 * relations. Returns the validated value unchanged, or null.
 */
export function validateEndoGraphEdgeV0(value: unknown): EndoGraphEdgeV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_GRAPH_EDGE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.edge.v0") return null;
	if (!isEndoIdentifierV0(v.id as string, "edge") || typeof v.id !== "string") return null;
	if (typeof v.source !== "string" || !isEndoIdentifierV0(v.source, "node")) return null;
	if (typeof v.target !== "string" || !isEndoIdentifierV0(v.target, "node")) return null;
	if (typeof v.relation !== "string" || !isWellFormedKindV0(v.relation)) return null;
	if (typeof v.observedIn !== "string" || !isEndoIdentifierV0(v.observedIn, "event")) return null;
	return value as EndoGraphEdgeV0;
}

const ENDO_GRAPH_BUDGET_ALLOWED_KEYS_V0 = new Set(["maxDepth", "maxNodes", "maxEdges"]);

/**
 * Validates an expansion budget. Rejects unknown fields and budgets that are present but not positive integers.
 * Returns the validated value unchanged, or null.
 */
export function validateEndoGraphExpansionBudgetV0(value: unknown): EndoGraphExpansionBudgetV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_GRAPH_BUDGET_ALLOWED_KEYS_V0.has(key)) return null;
	for (const key of ["maxDepth", "maxNodes", "maxEdges"] as const) {
		const field = v[key];
		if (field !== undefined && !isPositiveIntegerV0(field)) return null;
	}
	return value as EndoGraphExpansionBudgetV0;
}

const ENDO_GRAPH_SNAPSHOT_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"root",
	"nodes",
	"edges",
	"missing",
	"truncated",
]);

/**
 * Validates a traversal snapshot. Rejects unknown fields, a root outside the node namespace, nodes/edges that
 * fail their own validators, and missing entries that are not node identifiers. Returns the validated value
 * unchanged, or null.
 */
export function validateEndoGraphSnapshotV0(value: unknown): EndoGraphSnapshotV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_GRAPH_SNAPSHOT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.graph-snapshot.v0") return null;
	if (typeof v.root !== "string" || !isEndoIdentifierV0(v.root, "node")) return null;
	if (!Array.isArray(v.nodes) || v.nodes.some((node) => validateEndoObjectV0(node) === null)) return null;
	if (!Array.isArray(v.edges) || v.edges.some((edge) => validateEndoGraphEdgeV0(edge) === null)) return null;
	if (!Array.isArray(v.missing) || v.missing.some((id) => typeof id !== "string" || !isEndoIdentifierV0(id, "node")))
		return null;
	if (typeof v.truncated !== "boolean") return null;
	return value as EndoGraphSnapshotV0;
}

const ENDO_GRAPH_CHANGE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "kind", "id", "revision"]);

/**
 * Validates a change notification. Rejects unknown fields, a kind-appropriate identifier mismatch, and a revision
 * that is not a positive integer. Returns the validated value unchanged, or null.
 */
export function validateEndoGraphChangeV0(value: unknown): EndoGraphChangeV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_GRAPH_CHANGE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.graph-change.v0") return null;
	if (v.kind !== "object" && v.kind !== "edge") return null;
	if (typeof v.id !== "string") return null;
	const namespace = v.kind === "object" ? "node" : "edge";
	if (!isEndoIdentifierV0(v.id, namespace)) return null;
	if (!isPositiveIntegerV0(v.revision)) return null;
	return value as EndoGraphChangeV0;
}

const ENDO_GRAPH_REVISION_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "sequence", "change", "value"]);

/**
 * Validates a revision log entry. Rejects unknown fields, a change whose kind does not match the value's kind, a
 * value that fails its own validator, and a change identifier that does not match the value's. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoGraphRevisionV0(value: unknown): EndoGraphRevisionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_GRAPH_REVISION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.graph-revision.v0") return null;
	if (!isPositiveIntegerV0(v.sequence)) return null;
	const change = validateEndoGraphChangeV0(v.change);
	if (change === null) return null;
	const object = validateEndoObjectV0(v.value);
	if (object !== null)
		return change.kind === "object" && object.id === change.id ? (value as EndoGraphRevisionV0) : null;
	const edge = validateEndoGraphEdgeV0(v.value);
	if (edge === null) return null;
	return change.kind === "edge" && edge.id === change.id ? (value as EndoGraphRevisionV0) : null;
}

const ENDO_GRAPH_PROJECTION_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "upToSequence", "objects", "edges"]);

/**
 * Validates a temporal projection. Rejects unknown fields, a negative or non-integer `upToSequence`, and
 * objects/edges that fail their own validators. Returns the validated value unchanged, or null.
 */
export function validateEndoGraphProjectionV0(value: unknown): EndoGraphProjectionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_GRAPH_PROJECTION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.graph-projection.v0") return null;
	if (typeof v.upToSequence !== "number" || !Number.isInteger(v.upToSequence) || v.upToSequence < 0) return null;
	if (!Array.isArray(v.objects) || v.objects.some((node) => validateEndoObjectV0(node) === null)) return null;
	if (!Array.isArray(v.edges) || v.edges.some((edge) => validateEndoGraphEdgeV0(edge) === null)) return null;
	return value as EndoGraphProjectionV0;
}
