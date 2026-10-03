// The normalized object store v0: the append-oriented store of the cognition graph's objects and edges. Objects
// are the graph's nodes (protocol/object.ts); edges (protocol/graph.ts) are the recorded relationships between
// them. Every upsert records a revision (the latest revision is what lookups return — last write wins — and the
// superseded values are retained in the revision log, which temporal projections read, graph/projections.ts).
// Subscriptions announce each upsert (graph/subscriptions.ts).

import {
	type EndoGraphChangeV0,
	type EndoGraphEdgeV0,
	type EndoGraphRevisionV0,
	validateEndoGraphEdgeV0,
} from "../protocol/graph.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import { type EndoObjectV0, validateEndoObjectV0 } from "../protocol/object.ts";
import { assertPlainJsonValueV0 } from "../runtime/contracts/canonical-json.ts";
import { deepFreezeCopyV0, deepFreezeV0 } from "../runtime/contracts/immutability.ts";
import {
	createEndoGraphSubscribersV0,
	type EndoGraphListenerV0,
	type EndoGraphSubscriptionV0,
} from "./subscriptions.ts";

export interface EndoGraphStoreV0 {
	/** The number of distinct object identifiers in the store. */
	readonly objectCount: number;
	/** The number of distinct edge identifiers in the store. */
	readonly edgeCount: number;
	/** The 1-based global revision sequence: the number of upserts recorded so far. */
	readonly sequence: number;
	/**
	 * Records a revision for the object's identifier: validated at the door, stored as a deep-frozen copy
	 * (Phase 12 — the caller may keep mutating its own reference; the returned object is the stored, frozen
	 * one), and announced to the subscribers. A repeated upsert supersedes the previous value for lookups;
	 * the superseded value remains in the revision log.
	 */
	upsertObject(value: unknown): EndoObjectV0;
	/**
	 * Records a revision for the edge's identifier: validated at the door, stored as a deep-frozen copy
	 * (Phase 12 — the caller may keep mutating its own reference; the returned edge is the stored, frozen
	 * one), and announced to the subscribers. A repeated upsert supersedes the previous value; the adjacency
	 * is rebuilt for the new endpoints, so a revised edge may move.
	 */
	upsertEdge(value: unknown): EndoGraphEdgeV0;
	/** The latest revision for `id`, or null. */
	getObject(id: string): EndoObjectV0 | null;
	/** The latest revision for `id`, or null. */
	getEdge(id: string): EndoGraphEdgeV0 | null;
	/**
	 * The latest revisions of all edges touching `nodeId` in either direction, sorted by edge identifier. Dangling
	 * edges — endpoints with no object in the store — are included.
	 */
	edgesForNode(nodeId: string): EndoGraphEdgeV0[];
	/** The full revision log in append order. */
	log(): readonly EndoGraphRevisionV0[];
	subscribe(listener: EndoGraphListenerV0): EndoGraphSubscriptionV0;
}

/**
 * Creates an empty graph store.
 */
export function createEndoGraphStoreV0(): EndoGraphStoreV0 {
	const objectRevisions = new Map<string, EndoObjectV0[]>();
	const edgeRevisions = new Map<string, EndoGraphEdgeV0[]>();
	const adjacency = new Map<string, Set<string>>();
	const revisionLog: EndoGraphRevisionV0[] = [];
	const subscribers = createEndoGraphSubscribersV0();
	let sequence = 0;

	function latestOf<T>(revisions: T[]): T {
		return revisions[revisions.length - 1];
	}

	function endpointsOf(nodeId: string, edgeId: string, present: boolean) {
		let ids = adjacency.get(nodeId);
		if (present) {
			if (ids === undefined) {
				ids = new Set<string>();
				adjacency.set(nodeId, ids);
			}
			ids.add(edgeId);
		} else if (ids !== undefined) {
			ids.delete(edgeId);
			if (ids.size === 0) adjacency.delete(nodeId);
		}
	}

	function upsert<T>(kind: "object" | "edge", id: string, revision: number, value: T): T {
		sequence += 1;
		const change: EndoGraphChangeV0 = {
			schemaVersion: "endo.graph-change.v0",
			kind,
			id,
			revision,
		};
		const entry: EndoGraphRevisionV0 = {
			schemaVersion: "endo.graph-revision.v0",
			sequence,
			change,
			value: value as EndoObjectV0 | EndoGraphEdgeV0,
		};
		deepFreezeV0(entry);
		revisionLog.push(entry);
		subscribers.emit(change);
		return value;
	}

	return {
		get objectCount() {
			return objectRevisions.size;
		},
		get edgeCount() {
			return edgeRevisions.size;
		},
		get sequence() {
			return sequence;
		},
		upsertObject(value) {
			const object = validateEndoObjectV0(value);
			if (object === null) throw new TypeError("Expected an EndoObjectV0");
			assertPlainJsonValueV0(object);
			const stored = deepFreezeCopyV0(object);
			const revisions = objectRevisions.get(stored.id) ?? [];
			revisions.push(stored);
			objectRevisions.set(stored.id, revisions);
			return upsert("object", stored.id, revisions.length, stored);
		},
		upsertEdge(value) {
			const edge = validateEndoGraphEdgeV0(value);
			if (edge === null) throw new TypeError("Expected an EndoGraphEdgeV0");
			const stored = deepFreezeCopyV0(edge);
			const revisions = edgeRevisions.get(stored.id) ?? [];
			if (revisions.length > 0) {
				const previous = latestOf(revisions);
				endpointsOf(previous.source, stored.id, false);
				endpointsOf(previous.target, stored.id, false);
			}
			revisions.push(stored);
			edgeRevisions.set(stored.id, revisions);
			endpointsOf(stored.source, stored.id, true);
			endpointsOf(stored.target, stored.id, true);
			return upsert("edge", stored.id, revisions.length, stored);
		},
		getObject(id) {
			if (typeof id !== "string" || !isEndoIdentifierV0(id, "node")) return null;
			const revisions = objectRevisions.get(id);
			return revisions === undefined ? null : latestOf(revisions);
		},
		getEdge(id) {
			if (typeof id !== "string" || !isEndoIdentifierV0(id, "edge")) return null;
			const revisions = edgeRevisions.get(id);
			return revisions === undefined ? null : latestOf(revisions);
		},
		edgesForNode(nodeId) {
			if (typeof nodeId !== "string" || !isEndoIdentifierV0(nodeId, "node")) return [];
			const edgeIds = adjacency.get(nodeId);
			if (edgeIds === undefined) return [];
			const edges = [...edgeIds]
				.map((edgeId) => {
					const revisions = edgeRevisions.get(edgeId);
					return revisions === undefined ? null : latestOf(revisions);
				})
				.filter((edge): edge is EndoGraphEdgeV0 => edge !== null);
			return edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		},
		log() {
			return [...revisionLog];
		},
		subscribe(listener) {
			return subscribers.subscribe(listener);
		},
	};
}
