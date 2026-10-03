// Semantic visual state v0: the builder that projects the cognition graph (Phase 3) into the one state model
// both the Engineering and Dream renderers consume. The projection is a pure function of the store state and
// the options: the same inputs always produce the same state. Every visual signal is either read verbatim
// from a recorded node payload (origin "recorded") or derived from the graph structure (origin "derived");
// anything the recorded state does not expose is reported unavailable with a reason — never invented.
//
// The node-signal vocabulary the v0 builder reads (ENDO_NODE_SIGNAL_NAMES_V0) is documented payload-key
// convention: a node's payload is a strict JSON object and the documented keys are `attention` (a finite
// number in 0..1), `cluster` (a non-empty string), and `uncertainty` (a finite number in 0..1). A recorded
// value outside its v0 shape is reported unrecognized with the value as sent; a missing key is reported
// unavailable. Scene-scoped signals (ENDO_SCENE_SIGNAL_NAMES_V0) are read from node payloads the same way —
// `atmosphere` (a non-empty string) and `camera-intent` (an object with exactly `focusNodeId`, an
// `endo.node.*` identifier, and `frame`, one of "node" | "component" | "all"); when several nodes record the
// same scene signal, the smallest node identifier decides. `motion` is not read from payloads: the live

import { projectEndoGraphAtV0 } from "../graph/projections.ts";
import type { EndoGraphStoreV0 } from "../graph/store.ts";
import { expandEndoGraphV0 } from "../graph/traversal.ts";
import type { EndoGraphEdgeV0, EndoGraphExpansionBudgetV0, EndoGraphSnapshotV0 } from "../protocol/graph.ts";
import { validateEndoGraphExpansionBudgetV0 } from "../protocol/graph.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "../protocol/identity.ts";
import type { EndoObjectV0 } from "../protocol/object.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import {
	ENDO_NODE_SIGNAL_NAMES_V0,
	ENDO_SCENE_SIGNAL_NAMES_V0,
	type EndoSemanticVisualEdgeV0,
	type EndoSemanticVisualNodeV0,
	type EndoSemanticVisualStateV0,
	type EndoVisualSignalV0,
	type EndoVisualStateSourceV0,
} from "../protocol/visualization.ts";

/**
 * The options for a semantic visual state build. An absent `root` is a whole-store build: every stored node,
 * every recorded edge, no budgets. With a `root`, the build is a single budgeted expansion from that root,
 * and `budgets`, `relations`, and `direction` carry the Phase 3 traversal meanings.
 */
export interface EndoSemanticVisualStateOptionsV0 {
	/** The expansion root (`endo.node.*`); absent builds the whole store. */
	root?: string;
	/** The expansion budget; present only with a root. */
	budgets?: EndoGraphExpansionBudgetV0;
	/** The relation filter; present only with a root. */
	relations?: readonly string[];
	/** The traversal direction; present only with a root. */
	direction?: EndoGraphTraversalDirectionV0;
}

/** The traversal directions (the Phase 3 vocabulary). */
export type EndoGraphTraversalDirectionV0 = "in" | "out" | "both";

interface EndoParsedVisualStateOptionsV0 {
	root: string | null;
	budgets: EndoGraphExpansionBudgetV0 | undefined;
	relations: readonly string[] | undefined;
	direction: EndoGraphTraversalDirectionV0;
}

/** The projected graph the state is built from, sorted by identifier. */
interface EndoProjectedGraphV0 {
	nodes: EndoObjectV0[];
	edges: EndoGraphEdgeV0[];
	missing: string[];
	truncated: boolean;
}

function byIdentifierV0(a: { id: string }, b: { id: string }): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Parses the build options with a strict door: a plain object only, unknown keys rejected, and budgets /
 * relations / direction rejected without a root.
 */
function parseEndoSemanticVisualStateOptionsV0(options: unknown): EndoParsedVisualStateOptionsV0 {
	if (options === undefined) return { root: null, budgets: undefined, relations: undefined, direction: "both" };
	if (typeof options !== "object" || options === null || Object.getPrototypeOf(options) !== Object.prototype)
		throw new TypeError("Expected options: a plain object");
	const v = options as Record<string, unknown>;
	for (const key of Object.keys(v))
		if (key !== "root" && key !== "budgets" && key !== "relations" && key !== "direction")
			throw new TypeError(`Unknown visualization build option: ${key}`);

	let root: string | null = null;
	if (v.root !== undefined) {
		if (typeof v.root !== "string" || !isEndoIdentifierV0(v.root, "node"))
			throw new TypeError("Expected root: a well-formed endo.node.* identifier");
		root = v.root;
	}

	let budgets: EndoGraphExpansionBudgetV0 | undefined;
	if (v.budgets !== undefined) {
		const parsedBudgets = validateEndoGraphExpansionBudgetV0(v.budgets);
		if (parsedBudgets === null) throw new TypeError("Expected budgets: an EndoGraphExpansionBudgetV0");
		budgets = parsedBudgets;
	}

	let relations: readonly string[] | undefined;
	if (v.relations !== undefined) {
		if (
			!Array.isArray(v.relations) ||
			v.relations.some((relation) => typeof relation !== "string" || !isWellFormedKindV0(relation))
		)
			throw new TypeError("Expected relations: an array of well-formed relation strings");
		relations = v.relations;
	}

	let direction: EndoGraphTraversalDirectionV0 = "both";
	if (v.direction !== undefined) {
		if (v.direction !== "in" && v.direction !== "out" && v.direction !== "both")
			throw new TypeError('Expected direction: "in" | "out" | "both"');
		direction = v.direction;
	}

	if (root === null && (budgets !== undefined || relations !== undefined || direction !== "both"))
		throw new TypeError("Expected root: budgets, relations, and direction require a root");

	return { root, budgets, relations, direction };
}

/**
 * The whole-store projection: every stored node, every recorded edge, and the dangling edge endpoints. No
 * budget applies.
 */
function projectWholeStoreV0(store: EndoGraphStoreV0): EndoProjectedGraphV0 {
	const nodes = new Map<string, EndoObjectV0>();
	const edges = new Map<string, EndoGraphEdgeV0>();
	for (const revision of store.log()) {
		if (revision.change.kind === "object") {
			const object = store.getObject(revision.change.id);
			if (object !== null) nodes.set(object.id, object);
		} else {
			const edge = store.getEdge(revision.change.id);
			if (edge !== null) edges.set(edge.id, edge);
		}
	}
	const nodeIds = new Set(nodes.keys());
	const missing = [...new Set([...edges.values()].flatMap((edge) => [edge.source, edge.target]))]
		.filter((id) => !nodeIds.has(id))
		.sort();
	return {
		nodes: [...nodes.values()].sort(byIdentifierV0),
		edges: [...edges.values()].sort(byIdentifierV0),
		missing,
		truncated: false,
	};
}

/** The budgeted expansion from a root, as the projected graph. */
function projectRootV0(
	store: EndoGraphStoreV0,
	root: string,
	budgets: EndoGraphExpansionBudgetV0 | undefined,
	relations: readonly string[] | undefined,
	direction: EndoGraphTraversalDirectionV0,
): EndoProjectedGraphV0 {
	const snapshot: EndoGraphSnapshotV0 = expandEndoGraphV0(store, root, { budgets, relations, direction });
	return {
		nodes: [...snapshot.nodes].sort(byIdentifierV0),
		edges: [...snapshot.edges].sort(byIdentifierV0),
		missing: [...snapshot.missing].sort(),
		truncated: snapshot.truncated,
	};
}

/**
 * Computes the structural depth of every projected node. With a root, the root is depth 0 and the depth is
 * the graph distance from it; in a whole-store build every connected component is seeded from its smallest
 * identifier. Direction filters which edges connect components, exactly as the traversal does.
 */
function computeDepthsV0(
	nodeIds: readonly string[],
	edges: readonly EndoGraphEdgeV0[],
	direction: EndoGraphTraversalDirectionV0,
	root: string | null,
): Map<string, number> {
	const adjacency = new Map<string, Set<string>>();
	const addAdjacency = (from: string, to: string): void => {
		const neighbors = adjacency.get(from) ?? new Set<string>();
		neighbors.add(to);
		adjacency.set(from, neighbors);
	};
	for (const edge of edges) {
		if (direction === "out" || direction === "both") addAdjacency(edge.source, edge.target);
		if (direction === "in" || direction === "both") addAdjacency(edge.target, edge.source);
	}
	const depths = new Map<string, number>();
	const seeds = root !== null ? [root, ...nodeIds] : [...nodeIds];
	for (const seed of seeds) {
		if (depths.has(seed)) continue;
		depths.set(seed, 0);
		const queue = [seed];
		while (queue.length > 0) {
			const current = queue.shift()!;
			const depth = depths.get(current)!;
			for (const neighbor of adjacency.get(current) ?? []) {
				if (!depths.has(neighbor)) {
					depths.set(neighbor, depth + 1);
					queue.push(neighbor);
				}
			}
		}
	}
	return depths;
}

function describeJsonValueV0(value: JsonValueV0): string {
	return JSON.stringify(value);
}

function availableSignalV0(signal: string, value: JsonValueV0, origin: "recorded" | "derived"): EndoVisualSignalV0 {
	return { schemaVersion: "endo.visual-signal.v0", signal, availability: "available", value, origin };
}

function unavailableSignalV0(signal: string, reason: string): EndoVisualSignalV0 {
	return { schemaVersion: "endo.visual-signal.v0", signal, availability: "unavailable", reason };
}

function unrecognizedSignalV0(signal: string, value: JsonValueV0, reason: string): EndoVisualSignalV0 {
	return { schemaVersion: "endo.visual-signal.v0", signal, availability: "unrecognized", value, reason };
}

/**
 * Reads the three documented node signals from one node's recorded payload. Every node carries all three,
 * each with a status: a payload that is not a strict JSON object reports all three unavailable; a missing
 * key unavailable; a value outside its v0 shape unrecognized, with the value as sent.
 */
function readNodeSignalsV0(node: EndoObjectV0): EndoVisualSignalV0[] {
	const payload = node.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return ENDO_NODE_SIGNAL_NAMES_V0.map((name) =>
			unavailableSignalV0(name, "the recorded payload is not a JSON object"),
		);
	}
	const record = payload as Record<string, JsonValueV0>;
	return ENDO_NODE_SIGNAL_NAMES_V0.map((name) => {
		if (!(name in record)) return unavailableSignalV0(name, `no ${name} recorded in the payload`);
		const value = record[name];
		if (name === "cluster") {
			if (typeof value === "string" && value.length > 0) return availableSignalV0(name, value, "recorded");
			return unrecognizedSignalV0(
				name,
				value,
				`recorded cluster ${describeJsonValueV0(value)} is not a non-empty string`,
			);
		}
		if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
			return availableSignalV0(name, value, "recorded");
		return unrecognizedSignalV0(
			name,
			value,
			`recorded ${name} ${describeJsonValueV0(value)} is outside the v0 range 0..1`,
		);
	});
}

/** Parses a recorded camera-intent value: exactly `focusNodeId` and `frame`, or null. */
function parseCameraIntentV0(value: unknown): { focusNodeId: string; frame: "node" | "component" | "all" } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== 2) return null;
	if (typeof record.focusNodeId !== "string" || !isEndoIdentifierV0(record.focusNodeId, "node")) return null;
	if (record.frame !== "node" && record.frame !== "component" && record.frame !== "all") return null;
	return { focusNodeId: record.focusNodeId, frame: record.frame };
}

/**
 * Finds the first projected node (smallest identifier first) that records the scene signal. Its value decides
 * the scene: a valid value is available, an invalid one unrecognized — a later recorder is not consulted.
 */
function findRecordedSceneSignalV0(nodes: readonly EndoObjectV0[], name: string): EndoVisualSignalV0 | null {
	for (const node of nodes) {
		const payload = node.payload;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) continue;
		const record = payload as Record<string, JsonValueV0>;
		if (!(name in record)) continue;
		const value = record[name];
		if (name === "atmosphere") {
			if (typeof value === "string" && value.length > 0) return availableSignalV0(name, value, "recorded");
			return unrecognizedSignalV0(
				name,
				value,
				`recorded atmosphere ${describeJsonValueV0(value)} is not a non-empty string`,
			);
		}
		if (parseCameraIntentV0(value) !== null) return availableSignalV0(name, value, "recorded");
		return unrecognizedSignalV0(
			name,
			value,
			`recorded camera-intent ${describeJsonValueV0(value)} is not a v0 camera intent`,
		);
	}
	return null;
}

/**
 * Reads the scene-scoped signals from the projected nodes. The v0 builder emits exactly the recorded scene
 * signals (atmosphere, camera-intent) — temporal motion is derived by the live updater, never here.
 */
function readSceneSignalsV0(nodes: readonly EndoObjectV0[]): EndoVisualSignalV0[] {
	return ENDO_SCENE_SIGNAL_NAMES_V0.map((name) => {
		if (name === "motion") return unavailableSignalV0(name, "temporal motion is derived by the live updater");
		const recorded = findRecordedSceneSignalV0(nodes, name);
		return recorded ?? unavailableSignalV0(name, "no node records the scene signal");
	});
}

/**
 * Builds the semantic visual state from the current store state. With an absent `root`, the whole store is
 * projected — every stored node, every recorded edge — and depth is computed per connected component from
 * its smallest identifier. With a `root`, the build is a single budgeted expansion from that root. The same
 * store state and options always produce the same state.
 */
export function buildEndoSemanticVisualStateV0(store: EndoGraphStoreV0, options?: unknown): EndoSemanticVisualStateV0 {
	const parsed = parseEndoSemanticVisualStateOptionsV0(options);
	const projected =
		parsed.root === null
			? projectWholeStoreV0(store)
			: projectRootV0(store, parsed.root, parsed.budgets, parsed.relations, parsed.direction);
	return buildStateFromProjectedV0(store.sequence, parsed.root, parsed.direction, projected);
}

/**
 * Builds the semantic visual state at a past point of the store's revision log: the same projection the
 * Phase 3 projection rebuilds at that sequence, built as a semantic visual state. This is the replay step —
 * "record → persist → replay → rebuild graph → rebuild visual state → compare".
 */
export function buildEndoSemanticVisualStateAtV0(
	store: EndoGraphStoreV0,
	upToSequence: unknown,
	options?: unknown,
): EndoSemanticVisualStateV0 {
	const parsed = parseEndoSemanticVisualStateOptionsV0(options);
	if (parsed.root !== null) throw new TypeError("Expected upToSequence: a whole-store build only");
	if (typeof upToSequence !== "number" || !Number.isInteger(upToSequence) || upToSequence < 0)
		throw new TypeError("Expected upToSequence: a non-negative integer");
	const projection = projectEndoGraphAtV0(store, upToSequence);
	const nodes = new Map<string, EndoObjectV0>();
	for (const object of projection.objects) nodes.set(object.id, object);
	const edges = projection.edges;
	const nodeIds = new Set(nodes.keys());
	const missing = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]))]
		.filter((id) => !nodeIds.has(id))
		.sort();
	return buildStateFromProjectedV0(upToSequence, null, "both", {
		nodes: [...nodes.values()].sort(byIdentifierV0),
		edges: [...edges].sort(byIdentifierV0),
		missing,
		truncated: false,
	});
}

/** Builds the state from a projected graph at the given coordinates. */
function buildStateFromProjectedV0(
	sequence: number,
	root: string | null,
	direction: EndoGraphTraversalDirectionV0,
	projected: EndoProjectedGraphV0,
): EndoSemanticVisualStateV0 {
	const nodeIds = projected.nodes.map((node) => node.id);
	const depths = computeDepthsV0(nodeIds, projected.edges, direction, root);
	const nodes: EndoSemanticVisualNodeV0[] = projected.nodes.map((node) => ({
		schemaVersion: "endo.semantic-visual-node.v0",
		id: node.id,
		kind: node.kind,
		depth: depths.get(node.id) ?? 0,
		signals: readNodeSignalsV0(node),
	}));
	const edges: EndoSemanticVisualEdgeV0[] = projected.edges.map((edge) => ({
		schemaVersion: "endo.semantic-visual-edge.v0",
		id: edge.id,
		source: edge.source,
		target: edge.target,
		relation: edge.relation,
		observedIn: edge.observedIn,
	}));
	const source: EndoVisualStateSourceV0 = {
		schemaVersion: "endo.visual-state-source.v0",
		sequence,
		root,
		truncated: projected.truncated,
	};
	return {
		schemaVersion: "endo.semantic-visual-state.v0",
		source,
		nodes,
		edges,
		missing: projected.missing,
		signals: readSceneSignalsV0(projected.nodes),
	};
}
