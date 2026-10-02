// Temporal projections v0: the state the store's revision log describes as of a revision sequence. A projection
// is honest about the log — it contains only what the log records at or before the projection point, and the
// same log and sequence always produce the same projection.

import type { EndoGraphEdgeV0 } from "../protocol/graph.ts";
import type { EndoObjectV0 } from "../protocol/object.ts";
import type { EndoGraphStoreV0 } from "./store.ts";

/**
 * Projects the graph as of `upToSequence` (0-based-or-greater store sequence): the latest revision with sequence
 * at most `upToSequence` for each identifier. A sequence beyond the log end projects the current state; 0 is the
 * empty projection.
 */
export function projectEndoGraphAtV0(
	store: EndoGraphStoreV0,
	upToSequence: unknown,
): {
	schemaVersion: "endo.graph-projection.v0";
	upToSequence: number;
	objects: EndoObjectV0[];
	edges: EndoGraphEdgeV0[];
} {
	if (typeof upToSequence !== "number" || !Number.isInteger(upToSequence) || upToSequence < 0)
		throw new TypeError("Expected upToSequence: a non-negative integer");

	const objects = new Map<string, EndoObjectV0>();
	const edges = new Map<string, EndoGraphEdgeV0>();
	for (const revision of store.log()) {
		if (revision.sequence > upToSequence) break;
		if (revision.change.kind === "object") {
			objects.set(revision.change.id, revision.value as EndoObjectV0);
		} else {
			edges.set(revision.change.id, revision.value as EndoGraphEdgeV0);
		}
	}

	return {
		schemaVersion: "endo.graph-projection.v0",
		upToSequence,
		objects: [...objects.values()].sort(byIdentifierV0),
		edges: [...edges.values()].sort(byIdentifierV0),
	};
}

function byIdentifierV0(a: { id: string }, b: { id: string }): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
