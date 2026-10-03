// The Endo visualization v0 schema: the semantic visual state — the one state model the Engineering and
// Dream renderers both project — plus the two renderer scene shapes. The semantic state is built by
// visualization/semantic-state.ts from the cognition graph (Phase 3); the scenes are pure projections of that
// state by visualization/engineering.ts and visualization/dream.ts. The protocol never imports a concrete
// renderer.

import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

/**
 * The availability of a visual signal (README: "Where the runtime/model does not expose a required signal,
 * Endophasia must report that it is unavailable rather than invent it"). "available": the recorded value
 * carries a v0 meaning; "unavailable": the recorded state does not expose the signal (the reason states what
 * is missing); "unrecognized": a value is present but no v0 interpretation assigns it a meaning — shown as
 * sent, with no meaning assigned.
 */
export const ENDO_VISUAL_SIGNAL_AVAILABILITY_V0 = [
	"available",
	"unavailable",
	"unrecognized",
] as const satisfies readonly string[];

/** How a visual signal was established. */
export type EndoVisualSignalAvailabilityV0 = (typeof ENDO_VISUAL_SIGNAL_AVAILABILITY_V0)[number];

/**
 * The origin of an available signal's value: "recorded" — read verbatim from a recorded node payload;
 * "derived" — computed from the graph structure by the builder (v0: the temporal-motion signal the live
 * updater emits across successive builds).
 */
export const ENDO_VISUAL_SIGNAL_ORIGINS_V0 = ["recorded", "derived"] as const satisfies readonly string[];

/** The origin of an available signal's value. */
export type EndoVisualSignalOriginV0 = (typeof ENDO_VISUAL_SIGNAL_ORIGINS_V0)[number];

/**
 * The node-scoped visual signals the v0 builder reads from recorded node payloads (README: "Nodes, edges,
 * attention, clusters, camera intent, uncertainty, atmosphere, and other visual properties"): the recommended
 * v0 node-signal vocabulary. The signal name is open but well-formed — a node may record other visual
 * properties, and they remain visible in the semantic state's node signals.
 */
export const ENDO_NODE_SIGNAL_NAMES_V0 = ["attention", "cluster", "uncertainty"] as const satisfies readonly string[];

/**
 * The scene-scoped visual signals of the v0 semantic state: the recommended v0 scene-signal vocabulary. Camera
 * intent and atmosphere are model-directed (recorded in node payloads); temporal motion is derived by the
 * live updater from successive builds.
 */
export const ENDO_SCENE_SIGNAL_NAMES_V0 = [
	"atmosphere",
	"camera-intent",
	"motion",
] as const satisfies readonly string[];

/**
 * One visual property of the semantic state (README: visual properties "should be projections of actual
 * observable cognition state"). Field co-presence is part of the contract: `value` is present exactly when
 * the availability is "available" or "unrecognized"; `origin` exactly when it is "available"; `reason`
 * exactly when it is "unavailable" or "unrecognized".
 */
export interface EndoVisualSignalV0 {
	schemaVersion: "endo.visual-signal.v0";
	/** The signal name: well-formed, open vocabulary (e.g. `attention`, `camera-intent`, `atmosphere`). */
	signal: string;
	/** How the signal was established. */
	availability: EndoVisualSignalAvailabilityV0;
	/** The recorded value; present exactly when the availability is "available" or "unrecognized". */
	value?: JsonValueV0;
	/** Where the value came from; present exactly when the availability is "available". */
	origin?: EndoVisualSignalOriginV0;
	/** Why the signal is not, or not fully, available; present exactly when the availability is not "available". */
	reason?: string;
}

/**
 * A node of the semantic visual state: a cognition-graph node with its structural depth and its node-scoped
 * visual signals. The depth is derived — the graph distance from the expansion root, or, in a whole-store
 * build, from the component's smallest identifier — never recorded.
 */
export interface EndoSemanticVisualNodeV0 {
	schemaVersion: "endo.semantic-visual-node.v0";
	/** The cognition-graph node identifier (`endo.node.*`). */
	id: string;
	/** The node kind, unchanged from the recorded object. */
	kind: string;
	/** The graph distance from the expansion root (0 at the root); a derived structural fact. */
	depth: number;
	/** The node's visual signals, sorted by name; at most one entry per name. */
	signals: EndoVisualSignalV0[];
}

/**
 * An edge of the semantic visual state: a cognition-graph edge, unchanged.
 */
export interface EndoSemanticVisualEdgeV0 {
	schemaVersion: "endo.semantic-visual-edge.v0";
	/** The edge identifier (`endo.edge.*`). */
	id: string;
	/** The source node (`endo.node.*`). */
	source: string;
	/** The target node (`endo.node.*`). */
	target: string;
	/** The relation, unchanged from the recorded edge. */
	relation: string;
	/** The identifier of the event that recorded the relation (`endo.event.*`). */
	observedIn: string;
}

/**
 * The graph coordinates the semantic visual state was projected from. The sequence is an order, not a time:
 * the Phase 3 global revision sequence of the store at build time, the anchor for replay comparison and for
 * the live temporal-motion signal.
 */
export interface EndoVisualStateSourceV0 {
	schemaVersion: "endo.visual-state-source.v0";
	/** The store's revision sequence at build time. */
	sequence: number;
	/** The expansion root (`endo.node.*`), or null for a whole-store build. */
	root: string | null;
	/** True exactly when a budget cut the expansion short. */
	truncated: boolean;
}

/**
 * The semantic visual state: the one state model both the Engineering and Dream renderers project (README:
 * "Use one state model for both renderers"). It is a projection of the cognition graph — its topology and
 * every recorded visual signal — plus the explicit absence of every signal the recorded state does not
 * expose. It never invents: an unrecorded signal is reported unavailable with a reason, an
 * uninterpretable one unrecognized with its value as sent.
 */
export interface EndoSemanticVisualStateV0 {
	schemaVersion: "endo.semantic-visual-state.v0";
	/** The graph coordinates the state was projected from. */
	source: EndoVisualStateSourceV0;
	/** The projected nodes, sorted by identifier. */
	nodes: EndoSemanticVisualNodeV0[];
	/** The projected edges, sorted by identifier; every endpoint is a projected node or listed in `missing`. */
	edges: EndoSemanticVisualEdgeV0[];
	/** Edge endpoints that are not projected nodes, sorted. */
	missing: string[];
	/** The scene-scoped visual signals, sorted by name; at most one entry per name. */
	signals: EndoVisualSignalV0[];
}

/**
 * The engineering row-emphasis vocabulary: the same four discrete tones the cockpit renders (live / pending /
 * warn / idle), so a scene row never relies on colour alone — tone plus words. "pending" is reserved for
 * in-flight live states; the synchronous v0 projections emit only the other three.
 */
export const ENDO_ENGINEERING_ROW_TONES_V0 = ["live", "pending", "warn", "idle"] as const satisfies readonly string[];

/** The emphasis of an engineering scene row. */
export type EndoEngineeringRowToneV0 = (typeof ENDO_ENGINEERING_ROW_TONES_V0)[number];

/**
 * The section kinds the v0 engineering renderer emits: the graph-derived panels of the README engineering-mode
 * list. The section kind is open but well-formed — a state carrying more data sources (session timeline, event
 * stream, usage, latency, runtime capabilities, provenance, policy decisions, promotion status, candidate
 * diffs, experiment metrics) can emit additional sections; the v0 state carries only the graph.
 */
export const ENDO_ENGINEERING_SECTION_KINDS_V0 = [
	"claims-evidence",
	"degraded-states",
	"graph-inspector",
	"status",
] as const satisfies readonly string[];

/** One labelled row of an engineering scene section. */
export interface EndoEngineeringRowV0 {
	schemaVersion: "endo.engineering-row.v0";
	/** The row label; non-empty. */
	label: string;
	/** The row value, rendered as text; never parsed as HTML. */
	value: string;
	/** The row emphasis. */
	tone: EndoEngineeringRowToneV0;
}

/** One section of the engineering scene. */
export interface EndoEngineeringSectionV0 {
	schemaVersion: "endo.engineering-section.v0";
	/** The section kind: well-formed, open vocabulary. */
	kind: string;
	/** The section's rows, in the section's fixed order; at least one. */
	rows: EndoEngineeringRowV0[];
}

/**
 * The Engineering renderer's scene: the data-dense, explicit projection of the semantic visual state.
 * Sections are sorted by kind, and every section carries at least one row — an unavailable signal renders as
 * an explicit row, never as a missing panel.
 */
export interface EndoEngineeringSceneV0 {
	schemaVersion: "endo.engineering-scene.v0";
	/** The graph coordinates the state was projected from, echoed. */
	source: EndoVisualStateSourceV0;
	/** The scene sections, sorted by kind. */
	sections: EndoEngineeringSectionV0[];
}

/** A node of the dream scene topology. */
export interface EndoDreamTopologyNodeV0 {
	schemaVersion: "endo.dream-topology-node.v0";
	/** The node identifier (`endo.node.*`). */
	id: string;
	/** The structural depth, echoed from the semantic state. */
	depth: number;
	/** The recorded cluster label, or null when no cluster is recorded. */
	cluster: string | null;
}

/** The dream scene's graph topology: the projected nodes and edges. */
export interface EndoDreamTopologyV0 {
	schemaVersion: "endo.dream-topology.v0";
	/** The topology nodes, sorted by identifier. */
	nodes: EndoDreamTopologyNodeV0[];
	/** The projected edges, unchanged from the semantic state. */
	edges: EndoSemanticVisualEdgeV0[];
}

/** One entry of a dream field: a node and the recorded value of one of its signals. */
export interface EndoDreamFieldEntryV0 {
	schemaVersion: "endo.dream-field-entry.v0";
	/** The node identifier (`endo.node.*`). */
	nodeId: string;
	/** The recorded value: a finite number in the v0 range 0..1. */
	value: number;
}

/**
 * An active region: a node the recorded signals mark active. In v0, a node with a recorded attention signal;
 * when no attention is recorded the active-region list is empty — the scene does not invent one.
 */
export interface EndoDreamActiveRegionV0 {
	schemaVersion: "endo.dream-active-region.v0";
	/** The node identifier (`endo.node.*`). */
	nodeId: string;
	/** The recorded attention value. */
	attention: number;
}

/** A branching hypothesis: a projected hypothesis node and the relations of the edges touching it. */
export interface EndoDreamBranchingHypothesisV0 {
	schemaVersion: "endo.dream-branching-hypothesis.v0";
	/** The node identifier (`endo.node.*`). */
	nodeId: string;
	/** The sorted distinct relations of the recorded edges touching the node; empty when none is recorded. */
	relations: string[];
}

/** A recorded semantic cluster: a cluster label and its projected members. */
export interface EndoDreamClusterV0 {
	schemaVersion: "endo.dream-cluster.v0";
	/** The recorded cluster label; non-empty. */
	label: string;
	/** The cluster's projected member identifiers, sorted. */
	memberIds: string[];
}

/**
 * A tool/model boundary: the projected nodes of one boundary kind. A node is on the tool boundary when its
 * kind begins with `tool-`, on the model boundary when its kind begins with `model-`.
 */
export interface EndoDreamBoundaryV0 {
	schemaVersion: "endo.dream-boundary.v0";
	/** The boundary kind. */
	kind: "model" | "tool";
	/** The boundary's projected node identifiers, sorted; empty when no projected node belongs to it. */
	nodeIds: string[];
}

/**
 * The Dream renderer's scene: the bespoke projection of the same semantic visual state (README: "Two
 * presentation surfaces should share one cognition substrate"). Every field is a projection of recorded
 * cognition state or of the graph's structure; the scene never invents cognition just to make the scene look
 * interesting. Camera intent, atmosphere, and temporal motion ride in `signals` under their documented names
 * (ENO_SCENE_SIGNAL_NAMES_V0); temporal motion absent from the state renders as an explicit unavailable
 * signal, not a silent omission.
 */
export interface EndoDreamSceneV0 {
	schemaVersion: "endo.dream-scene.v0";
	/** The graph coordinates the state was projected from, echoed. */
	source: EndoVisualStateSourceV0;
	/** The projected graph topology. */
	topology: EndoDreamTopologyV0;
	/** The attention field: the nodes with a recorded attention value, sorted by node identifier. */
	attentionField: EndoDreamFieldEntryV0[];
	/** The uncertainty field: the nodes with a recorded uncertainty value, sorted by node identifier. */
	uncertaintyField: EndoDreamFieldEntryV0[];
	/** The active regions, sorted by node identifier. */
	activeRegions: EndoDreamActiveRegionV0[];
	/** The projected hypothesis nodes, sorted by node identifier. */
	branchingHypotheses: EndoDreamBranchingHypothesisV0[];
	/** The recorded semantic clusters, sorted by label. */
	clusters: EndoDreamClusterV0[];
	/** The tool/model boundaries, sorted by kind; a boundary with no projected nodes is present, with an empty list. */
	boundaries: EndoDreamBoundaryV0[];
	/** The scene-scoped visual signals (camera intent, atmosphere, temporal motion), sorted by name. */
	signals: EndoVisualSignalV0[];
}

function isStrictJsonValue(value: unknown): value is JsonValueV0 {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isStrictJsonValue);
	if (typeof value === "object" && isPlainJsonObjectV0(value))
		return Object.entries(value).every(([, entry]) => isStrictJsonValue(entry));
	return false;
}

function isNonEmptyStringV0(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeIntegerV0(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFinite01V0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Strictly increasing in code-unit order: sorted and unique. */
function areSortedUniqueV0(values: readonly string[]): boolean {
	for (let index = 1; index < values.length; index++) if (values[index] <= values[index - 1]) return false;
	return true;
}

function areSortedByV0<T>(items: readonly T[], key: (item: T) => string): boolean {
	for (let index = 1; index < items.length; index++) if (key(items[index]) <= key(items[index - 1])) return false;
	return true;
}

const ENDO_VISUAL_SIGNAL_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"signal",
	"availability",
	"value",
	"origin",
	"reason",
]);

/**
 * Validates a visual signal. Rejects unknown fields, malformed signal names, and availability values whose
 * value / origin / reason co-presence does not match the contract. Returns the validated value unchanged, or
 * null.
 */
export function validateEndoVisualSignalV0(value: unknown): EndoVisualSignalV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_VISUAL_SIGNAL_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.visual-signal.v0") return null;
	if (typeof v.signal !== "string" || !isWellFormedKindV0(v.signal)) return null;
	if (v.availability !== "available" && v.availability !== "unavailable" && v.availability !== "unrecognized")
		return null;
	if (v.availability !== "available" && v.availability !== "unrecognized" && ("value" in v || "origin" in v))
		return null;
	if ((v.availability === "available" || v.availability === "unrecognized") && !("value" in v)) return null;
	if ((v.availability === "available" || v.availability === "unrecognized") && !isStrictJsonValue(v.value))
		return null;
	if ("origin" in v && v.origin !== "recorded" && v.origin !== "derived") return null;
	if (v.availability === "available" && !("origin" in v)) return null;
	if (v.availability !== "available" && "origin" in v) return null;
	if ((v.availability === "unavailable" || v.availability === "unrecognized") && !isNonEmptyStringV0(v.reason))
		return null;
	if (v.availability === "available" && "reason" in v) return null;
	return value as EndoVisualSignalV0;
}

const ENDO_SEMANTIC_VISUAL_NODE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "kind", "depth", "signals"]);

/**
 * Validates a semantic visual state node. Rejects unknown fields, a node identifier outside the node
 * namespace, a malformed kind, a non-integer negative depth, signals that fail their own validator, and
 * signal lists that are unsorted or carry a name twice. Returns the validated value unchanged, or null.
 */
export function validateEndoSemanticVisualNodeV0(value: unknown): EndoSemanticVisualNodeV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_SEMANTIC_VISUAL_NODE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.semantic-visual-node.v0") return null;
	if (typeof v.id !== "string" || !isEndoIdentifierV0(v.id, "node")) return null;
	if (typeof v.kind !== "string" || !isWellFormedKindV0(v.kind)) return null;
	if (!isNonNegativeIntegerV0(v.depth)) return null;
	if (!Array.isArray(v.signals) || v.signals.some((signal) => validateEndoVisualSignalV0(signal) === null))
		return null;
	const names = (v.signals as EndoVisualSignalV0[]).map((signal) => signal.signal);
	if (!areSortedUniqueV0(names)) return null;
	return value as EndoSemanticVisualNodeV0;
}

const ENDO_SEMANTIC_VISUAL_EDGE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"source",
	"target",
	"relation",
	"observedIn",
]);

/**
 * Validates a semantic visual state edge. Rejects unknown fields, identifiers in the wrong namespaces, and
 * malformed relations. Returns the validated value unchanged, or null.
 */
export function validateEndoSemanticVisualEdgeV0(value: unknown): EndoSemanticVisualEdgeV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_SEMANTIC_VISUAL_EDGE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.semantic-visual-edge.v0") return null;
	if (typeof v.id !== "string" || !isEndoIdentifierV0(v.id, "edge")) return null;
	if (typeof v.source !== "string" || !isEndoIdentifierV0(v.source, "node")) return null;
	if (typeof v.target !== "string" || !isEndoIdentifierV0(v.target, "node")) return null;
	if (typeof v.relation !== "string" || !isWellFormedKindV0(v.relation)) return null;
	if (typeof v.observedIn !== "string" || !isEndoIdentifierV0(v.observedIn, "event")) return null;
	return value as EndoSemanticVisualEdgeV0;
}

const ENDO_VISUAL_STATE_SOURCE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "sequence", "root", "truncated"]);

/**
 * Validates the source coordinates of a semantic visual state. Rejects unknown fields, a sequence that is not
 * a non-negative integer, a root that is neither null nor a node identifier, and a non-boolean truncated
 * flag. Returns the validated value unchanged, or null.
 */
export function validateEndoVisualStateSourceV0(value: unknown): EndoVisualStateSourceV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_VISUAL_STATE_SOURCE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.visual-state-source.v0") return null;
	if (!isNonNegativeIntegerV0(v.sequence)) return null;
	if (v.root !== null && (typeof v.root !== "string" || !isEndoIdentifierV0(v.root, "node"))) return null;
	if (typeof v.truncated !== "boolean") return null;
	return value as EndoVisualStateSourceV0;
}

const ENDO_SEMANTIC_VISUAL_STATE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"source",
	"nodes",
	"edges",
	"missing",
	"signals",
]);

/**
 * Validates the semantic visual state. Rejects unknown fields, a source that fails its own validator,
 * nodes/edges/signals that fail their own validators or their sortedness, node identifiers listed in both
 * `nodes` and `missing`, and edge endpoints that are neither projected nodes nor missing. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoSemanticVisualStateV0(value: unknown): EndoSemanticVisualStateV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_SEMANTIC_VISUAL_STATE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.semantic-visual-state.v0") return null;
	if (validateEndoVisualStateSourceV0(v.source) === null) return null;
	if (!Array.isArray(v.nodes) || v.nodes.some((node) => validateEndoSemanticVisualNodeV0(node) === null)) return null;
	const nodes = v.nodes as EndoSemanticVisualNodeV0[];
	if (!areSortedByV0(nodes, (node) => node.id)) return null;
	if (!Array.isArray(v.edges) || v.edges.some((edge) => validateEndoSemanticVisualEdgeV0(edge) === null)) return null;
	const edges = v.edges as EndoSemanticVisualEdgeV0[];
	if (!areSortedByV0(edges, (edge) => edge.id)) return null;
	if (
		!Array.isArray(v.missing) ||
		!areSortedUniqueV0(v.missing as string[]) ||
		v.missing.some((id) => typeof id !== "string" || !isEndoIdentifierV0(id, "node"))
	)
		return null;
	if (!Array.isArray(v.signals) || v.signals.some((signal) => validateEndoVisualSignalV0(signal) === null))
		return null;
	const signalNames = (v.signals as EndoVisualSignalV0[]).map((signal) => signal.signal);
	if (!areSortedUniqueV0(signalNames)) return null;
	const projected = new Set(nodes.map((node) => node.id));
	const missing = new Set(v.missing as string[]);
	if ([...missing].some((id) => projected.has(id))) return null;
	if (
		edges.some(
			(edge) =>
				(!projected.has(edge.source) && !missing.has(edge.source)) ||
				(!projected.has(edge.target) && !missing.has(edge.target)),
		)
	)
		return null;
	return value as EndoSemanticVisualStateV0;
}

const ENDO_ENGINEERING_ROW_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "label", "value", "tone"]);

/**
 * Validates an engineering scene row. Rejects unknown fields, an empty label, a non-string value, and tones
 * outside the four-value vocabulary. Returns the validated value unchanged, or null.
 */
export function validateEndoEngineeringRowV0(value: unknown): EndoEngineeringRowV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_ENGINEERING_ROW_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.engineering-row.v0") return null;
	if (!isNonEmptyStringV0(v.label)) return null;
	if (typeof v.value !== "string") return null;
	if (v.tone !== "live" && v.tone !== "pending" && v.tone !== "warn" && v.tone !== "idle") return null;
	return value as EndoEngineeringRowV0;
}

const ENDO_ENGINEERING_SECTION_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "kind", "rows"]);

/**
 * Validates an engineering scene section. Rejects unknown fields, a malformed section kind, and sections
 * without at least one valid row. Returns the validated value unchanged, or null.
 */
export function validateEndoEngineeringSectionV0(value: unknown): EndoEngineeringSectionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_ENGINEERING_SECTION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.engineering-section.v0") return null;
	if (typeof v.kind !== "string" || !isWellFormedKindV0(v.kind)) return null;
	if (
		!Array.isArray(v.rows) ||
		v.rows.length === 0 ||
		v.rows.some((row) => validateEndoEngineeringRowV0(row) === null)
	)
		return null;
	return value as EndoEngineeringSectionV0;
}

const ENDO_ENGINEERING_SCENE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "source", "sections"]);

/**
 * Validates the engineering scene. Rejects unknown fields, a source that fails its own validator, sections
 * that fail their own validator, and section lists that are unsorted or carry a kind twice. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoEngineeringSceneV0(value: unknown): EndoEngineeringSceneV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_ENGINEERING_SCENE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.engineering-scene.v0") return null;
	if (validateEndoVisualStateSourceV0(v.source) === null) return null;
	if (!Array.isArray(v.sections) || v.sections.some((section) => validateEndoEngineeringSectionV0(section) === null))
		return null;
	const sections = v.sections as EndoEngineeringSectionV0[];
	if (!areSortedByV0(sections, (section) => section.kind)) return null;
	return value as EndoEngineeringSceneV0;
}

const ENDO_DREAM_TOPOLOGY_NODE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "depth", "cluster"]);

/**
 * Validates a dream topology node. Rejects unknown fields, a node identifier outside the node namespace, a
 * non-integer negative depth, and a cluster that is present but not a non-empty string. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoDreamTopologyNodeV0(value: unknown): EndoDreamTopologyNodeV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_TOPOLOGY_NODE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-topology-node.v0") return null;
	if (typeof v.id !== "string" || !isEndoIdentifierV0(v.id, "node")) return null;
	if (!isNonNegativeIntegerV0(v.depth)) return null;
	if (v.cluster !== null && !isNonEmptyStringV0(v.cluster)) return null;
	return value as EndoDreamTopologyNodeV0;
}

const ENDO_DREAM_TOPOLOGY_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "nodes", "edges"]);

/**
 * Validates the dream topology. Rejects unknown fields, topology nodes/edges that fail their own validators,
 * unsorted or duplicated node lists, and edge endpoints that are not topology nodes. Returns the validated
 * value unchanged, or null.
 */
export function validateEndoDreamTopologyV0(value: unknown): EndoDreamTopologyV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_TOPOLOGY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-topology.v0") return null;
	if (!Array.isArray(v.nodes) || v.nodes.some((node) => validateEndoDreamTopologyNodeV0(node) === null)) return null;
	const nodes = v.nodes as EndoDreamTopologyNodeV0[];
	if (!areSortedByV0(nodes, (node) => node.id)) return null;
	if (!Array.isArray(v.edges) || v.edges.some((edge) => validateEndoSemanticVisualEdgeV0(edge) === null)) return null;
	const projected = new Set(nodes.map((node) => node.id));
	if (
		v.edges.some(
			(edge) =>
				!projected.has((edge as EndoSemanticVisualEdgeV0).source) ||
				!projected.has((edge as EndoSemanticVisualEdgeV0).target),
		)
	)
		return null;
	return value as EndoDreamTopologyV0;
}

const ENDO_DREAM_FIELD_ENTRY_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "nodeId", "value"]);

/**
 * Validates a dream field entry. Rejects unknown fields, a node identifier outside the node namespace, and
 * values that are not finite numbers in 0..1. Returns the validated value unchanged, or null.
 */
export function validateEndoDreamFieldEntryV0(value: unknown): EndoDreamFieldEntryV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_FIELD_ENTRY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-field-entry.v0") return null;
	if (typeof v.nodeId !== "string" || !isEndoIdentifierV0(v.nodeId, "node")) return null;
	if (!isFinite01V0(v.value)) return null;
	return value as EndoDreamFieldEntryV0;
}

const ENDO_DREAM_ACTIVE_REGION_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "nodeId", "attention"]);

/**
 * Validates an active region. Rejects unknown fields, a node identifier outside the node namespace, and
 * attention values that are not finite numbers in 0..1. Returns the validated value unchanged, or null.
 */
export function validateEndoDreamActiveRegionV0(value: unknown): EndoDreamActiveRegionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_ACTIVE_REGION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-active-region.v0") return null;
	if (typeof v.nodeId !== "string" || !isEndoIdentifierV0(v.nodeId, "node")) return null;
	if (!isFinite01V0(v.attention)) return null;
	return value as EndoDreamActiveRegionV0;
}

const ENDO_DREAM_BRANCHING_HYPOTHESIS_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "nodeId", "relations"]);

/**
 * Validates a branching hypothesis. Rejects unknown fields, a node identifier outside the node namespace,
 * malformed relations, and relation lists that are unsorted or carry a relation twice. Returns the validated
 * value unchanged, or null.
 */
export function validateEndoDreamBranchingHypothesisV0(value: unknown): EndoDreamBranchingHypothesisV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_BRANCHING_HYPOTHESIS_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-branching-hypothesis.v0") return null;
	if (typeof v.nodeId !== "string" || !isEndoIdentifierV0(v.nodeId, "node")) return null;
	if (
		!Array.isArray(v.relations) ||
		v.relations.some((relation) => typeof relation !== "string" || !isWellFormedKindV0(relation))
	)
		return null;
	if (!areSortedUniqueV0(v.relations as string[])) return null;
	return value as EndoDreamBranchingHypothesisV0;
}

const ENDO_DREAM_CLUSTER_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "label", "memberIds"]);

/**
 * Validates a recorded semantic cluster. Rejects unknown fields, an empty label, and member lists that are
 * empty, unsorted, duplicated, or carry identifiers outside the node namespace. Returns the validated value
 * unchanged, or null.
 */
export function validateEndoDreamClusterV0(value: unknown): EndoDreamClusterV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_CLUSTER_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-cluster.v0") return null;
	if (!isNonEmptyStringV0(v.label)) return null;
	if (!Array.isArray(v.memberIds) || v.memberIds.length === 0) return null;
	if (
		!areSortedUniqueV0(v.memberIds as string[]) ||
		v.memberIds.some((id) => typeof id !== "string" || !isEndoIdentifierV0(id, "node"))
	)
		return null;
	return value as EndoDreamClusterV0;
}

const ENDO_DREAM_BOUNDARY_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "kind", "nodeIds"]);

/**
 * Validates a tool/model boundary. Rejects unknown fields, kinds outside "model" | "tool", and node lists
 * that are unsorted, duplicated, or carry identifiers outside the node namespace. Returns the validated
 * value unchanged, or null.
 */
export function validateEndoDreamBoundaryV0(value: unknown): EndoDreamBoundaryV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_BOUNDARY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-boundary.v0") return null;
	if (v.kind !== "model" && v.kind !== "tool") return null;
	if (
		!Array.isArray(v.nodeIds) ||
		!areSortedUniqueV0(v.nodeIds as string[]) ||
		v.nodeIds.some((id) => typeof id !== "string" || !isEndoIdentifierV0(id, "node"))
	)
		return null;
	return value as EndoDreamBoundaryV0;
}

const ENDO_DREAM_SCENE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"source",
	"topology",
	"attentionField",
	"uncertaintyField",
	"activeRegions",
	"branchingHypotheses",
	"clusters",
	"boundaries",
	"signals",
]);

/**
 * Validates the dream scene. Rejects unknown fields, a source/topology that fails its own validator,
 * fields/regions/hypotheses/clusters/boundaries/signals that fail their own validators or their sortedness,
 * and node identifiers that are not topology nodes. Returns the validated value unchanged, or null.
 */
export function validateEndoDreamSceneV0(value: unknown): EndoDreamSceneV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_DREAM_SCENE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.dream-scene.v0") return null;
	if (validateEndoVisualStateSourceV0(v.source) === null) return null;
	if (validateEndoDreamTopologyV0(v.topology) === null) return null;
	const topology = v.topology as EndoDreamTopologyV0;
	const projected = new Set(topology.nodes.map((node) => node.id));
	for (const key of ["attentionField", "uncertaintyField"] as const) {
		if (!Array.isArray(v[key]) || v[key].some((entry) => validateEndoDreamFieldEntryV0(entry) === null)) return null;
		const entries = v[key] as EndoDreamFieldEntryV0[];
		if (!areSortedByV0(entries, (entry) => entry.nodeId)) return null;
		if (entries.some((entry) => !projected.has(entry.nodeId))) return null;
	}
	if (
		!Array.isArray(v.activeRegions) ||
		v.activeRegions.some((region) => validateEndoDreamActiveRegionV0(region) === null)
	)
		return null;
	const regions = v.activeRegions as EndoDreamActiveRegionV0[];
	if (!areSortedByV0(regions, (region) => region.nodeId)) return null;
	if (regions.some((region) => !projected.has(region.nodeId))) return null;
	if (
		!Array.isArray(v.branchingHypotheses) ||
		v.branchingHypotheses.some((hypothesis) => validateEndoDreamBranchingHypothesisV0(hypothesis) === null)
	)
		return null;
	const hypotheses = v.branchingHypotheses as EndoDreamBranchingHypothesisV0[];
	if (!areSortedByV0(hypotheses, (hypothesis) => hypothesis.nodeId)) return null;
	if (hypotheses.some((hypothesis) => !projected.has(hypothesis.nodeId))) return null;
	if (!Array.isArray(v.clusters) || v.clusters.some((cluster) => validateEndoDreamClusterV0(cluster) === null))
		return null;
	const clusters = v.clusters as EndoDreamClusterV0[];
	if (!areSortedByV0(clusters, (cluster) => cluster.label)) return null;
	if (clusters.some((cluster) => cluster.memberIds.some((id) => !projected.has(id)))) return null;
	if (!Array.isArray(v.boundaries) || v.boundaries.some((boundary) => validateEndoDreamBoundaryV0(boundary) === null))
		return null;
	const boundaries = v.boundaries as EndoDreamBoundaryV0[];
	if (!areSortedByV0(boundaries, (boundary) => boundary.kind)) return null;
	if (boundaries.some((boundary) => boundary.nodeIds.some((id) => !projected.has(id)))) return null;
	if (!Array.isArray(v.signals) || v.signals.some((signal) => validateEndoVisualSignalV0(signal) === null))
		return null;
	const signalNames = (v.signals as EndoVisualSignalV0[]).map((signal) => signal.signal);
	if (!areSortedUniqueV0(signalNames)) return null;
	return value as EndoDreamSceneV0;
}
