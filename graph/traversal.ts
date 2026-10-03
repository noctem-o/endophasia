// Budgeted graph traversal v0: the README's cognition-graph pipeline — root → frontier → batched expansion →
// dedupe / visited set → emit snapshot — with depth / node / edge budgets. The expansion is deterministic: the
// same store state and options always produce the same snapshot, and its node, edge, and missing lists are
// sorted by identifier.

import {
	type EndoGraphEdgeV0,
	type EndoGraphExpansionBudgetV0,
	type EndoGraphSnapshotV0,
	validateEndoGraphExpansionBudgetV0,
} from "../protocol/graph.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "../protocol/identity.ts";
import type { EndoObjectV0 } from "../protocol/object.ts";
import type { EndoGraphStoreV0 } from "./store.ts";

/** The direction in which recorded edges are followed from a visited node. */
export type EndoGraphTraversalDirectionV0 = "in" | "out" | "both";

/**
 * The options for a budgeted expansion. Every field is optional: an absent budget is unbounded, an absent
 * relation filter follows all relations, and the default direction is "both".
 */
export interface EndoGraphExpansionOptionsV0 {
	/** The expansion budget; absent is unbounded. */
	budgets?: EndoGraphExpansionBudgetV0;
	/**
	 * Only follow edges whose relation is in this set; absent follows all relations. The filter governs
	 * traversal — which nodes are reached — while the snapshot includes every recorded edge between visited
	 * nodes, filtered or not.
	 */
	relations?: readonly string[];
	/**
	 * "out" follows only edges where the visited node is the source, "in" only edges where it is the target,
	 * "both" (the default) follows both.
	 */
	direction?: EndoGraphTraversalDirectionV0;
}

interface EndoGraphParsedExpansionOptionsV0 {
	budgets: EndoGraphExpansionBudgetV0 | undefined;
	relations: readonly string[] | undefined;
	direction: EndoGraphTraversalDirectionV0;
}

/**
 * Expands the graph from `root` and emits the snapshot of everything reached. The root must be a well-formed
 * `endo.node.*` identifier (a TypeError otherwise); a root the store does not hold is not an error — the
 * snapshot is honest about it in `missing`, and expansion still follows the root's recorded edges.
 */
export function expandEndoGraphV0(store: EndoGraphStoreV0, root: unknown, options?: unknown): EndoGraphSnapshotV0 {
	if (typeof root !== "string" || !isEndoIdentifierV0(root, "node"))
		throw new TypeError("Expected a root: an endo.node.* identifier");
	const parsed = parseEndoGraphExpansionOptionsV0(options);
	const { budgets, relations, direction } = parsed;
	const relationSet = relations === undefined ? undefined : new Set(relations);

	const visited = new Set<string>([root]);
	let frontier = [root];
	let depth = 0;
	let truncated = false;

	expansion: while (frontier.length > 0) {
		if (budgets?.maxDepth !== undefined && depth >= budgets.maxDepth) {
			truncated = true;
			break;
		}
		const next: string[] = [];
		for (const nodeId of frontier) {
			for (const edge of store.edgesForNode(nodeId)) {
				if (relationSet !== undefined && !relationSet.has(edge.relation)) continue;
				if (direction === "in" && edge.target !== nodeId) continue;
				if (direction === "out" && edge.source !== nodeId) continue;
				const other = edge.source === nodeId ? edge.target : edge.source;
				if (visited.has(other)) continue;
				if (budgets?.maxNodes !== undefined && visited.size + 1 > budgets.maxNodes) {
					truncated = true;
					break expansion;
				}
				visited.add(other);
				next.push(other);
			}
		}
		frontier = next;
		depth += 1;
	}

	const nodes: EndoObjectV0[] = [];
	const missing: string[] = [];
	for (const nodeId of visited) {
		const object = store.getObject(nodeId);
		if (object === null) missing.push(nodeId);
		else nodes.push(object);
	}
	nodes.sort(byIdentifierV0);
	missing.sort();

	const edgeMap = new Map<string, EndoGraphEdgeV0>();
	for (const nodeId of visited) {
		for (const edge of store.edgesForNode(nodeId)) {
			if (visited.has(edge.source) && visited.has(edge.target)) edgeMap.set(edge.id, edge);
		}
	}
	let edges = [...edgeMap.values()].sort(byIdentifierV0);
	if (budgets?.maxEdges !== undefined && edges.length > budgets.maxEdges) {
		edges = edges.slice(0, budgets.maxEdges);
		truncated = true;
	}

	return { schemaVersion: "endo.graph-snapshot.v0", root, nodes, edges, missing, truncated };
}

function byIdentifierV0(a: { id: string }, b: { id: string }): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function parseEndoGraphExpansionOptionsV0(options: unknown): EndoGraphParsedExpansionOptionsV0 {
	if (options === undefined) return { budgets: undefined, relations: undefined, direction: "both" };
	if (typeof options !== "object" || options === null || Object.getPrototypeOf(options) !== Object.prototype)
		throw new TypeError("Expected options: a plain object");
	const v = options as Record<string, unknown>;
	for (const key of Object.keys(v))
		if (key !== "budgets" && key !== "relations" && key !== "direction")
			throw new TypeError(`Unknown graph expansion option: ${key}`);

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

	return { budgets, relations, direction };
}
