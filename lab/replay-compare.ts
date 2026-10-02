// The replay-comparison half of the lab: the README's full replay workflow — record, persist, replay, rebuild
// graph, rebuild visual state, compare against the original. The events and derived layers come from the
// Phase 2 replay report; the graph and visual-state layers extend it. A layer the comparison's inputs cannot
// support is unreproducible, never omitted: a report that left a layer out would look like a layer that
// matched. A rebuilt layer that is canonicalizable but different is "reconstructed", never silently dropped.

import { projectEndoGraphAtV0 } from "../graph/projections.ts";
import type { EndoGraphStoreV0 } from "../graph/store.ts";
import { type EndoReplayComparisonV0, validateEndoReplayComparisonV0 } from "../protocol/evaluation.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { validateEndoEventRecordV0 } from "../protocol/event-record.ts";
import { type EndoGraphEdgeV0, validateEndoGraphEdgeV0 } from "../protocol/graph.ts";
import { type EndoObjectV0, validateEndoObjectV0 } from "../protocol/object.ts";
import { type EndoSemanticVisualStateV0, validateEndoSemanticVisualStateV0 } from "../protocol/visualization.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { replayEndoEventRecordV0 } from "../runtime/contracts/event-replay.ts";
import { buildEndoSemanticVisualStateV0 } from "../visualization/semantic-state.ts";

/** A graph snapshot: the objects and edges as recorded at the original time. Order is not part of the state. */
export interface EndoGraphSnapshotV0 {
	objects: EndoObjectV0[];
	edges: EndoGraphEdgeV0[];
}

/** The graph state a snapshot describes: every object and edge, sorted by identifier — order-free. */
interface EndoGraphStateV0 {
	objects: EndoObjectV0[];
	edges: EndoGraphEdgeV0[];
}

function sortByIdentifierV0<T extends { id: string }>(values: T[]): T[] {
	return [...values].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isPlainObjectV0(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a graph snapshot: a plain object with exactly the keys `objects` and `edges`, each an array of valid
 * endo.object.v0 / endo.edge.v0 entries. Order is normalized away (the state is sorted by identifier). Throws
 * TypeError when malformed — a present-but-malformed snapshot is a door error, distinct from an absent one.
 */
export function parseEndoGraphSnapshotV0(value: unknown): EndoGraphStateV0 {
	if (!isPlainObjectV0(value)) throw new TypeError("graph snapshot must be a plain object");
	for (const key of Object.keys(value))
		if (key !== "objects" && key !== "edges") throw new TypeError(`unknown snapshot key ${key}`);
	const objects: EndoObjectV0[] = [];
	const edges: EndoGraphEdgeV0[] = [];
	if (value.objects !== undefined) {
		if (!Array.isArray(value.objects)) throw new TypeError("snapshot objects must be an array");
		for (const entry of value.objects) {
			const object = validateEndoObjectV0(entry);
			if (object === null) throw new TypeError("snapshot objects must be valid endo.object.v0 entries");
			objects.push(object);
		}
	}
	if (value.edges !== undefined) {
		if (!Array.isArray(value.edges)) throw new TypeError("snapshot edges must be an array");
		for (const entry of value.edges) {
			const edge = validateEndoGraphEdgeV0(entry);
			if (edge === null) throw new TypeError("snapshot edges must be valid endo.edge.v0 entries");
			edges.push(edge);
		}
	}
	return { objects: sortByIdentifierV0(objects), edges: sortByIdentifierV0(edges) };
}

/**
 * Compare a replay against the original, layer by layer. The record is the strict door (the Phase 2 replay
 * report covers the events and derived layers). The graph layer needs both the original graph snapshot and the
 * rebuild function; the rebuilt store is projected to its full state and compared against the snapshot in
 * canonical form — equal is exact, different is reconstructed, and a rebuild that cannot run is
 * unreproducible. The visual-state layer rebuilds the semantic visual state from the rebuilt store and
 * compares it against the original; it cascades to unreproducible when the graph layer cannot, because the
 * visual rebuild has no input then. Returns the validated comparison. Throws TypeError when the record or a
 * present snapshot or visual state is malformed.
 */
export function compareEndoReplayV0(args: {
	record: unknown;
	originalGraph?: unknown;
	rebuildGraph?: (events: readonly EndoEventV0[]) => EndoGraphStoreV0;
	originalVisual?: unknown;
}): EndoReplayComparisonV0 {
	const report = replayEndoEventRecordV0(args.record);
	const validated = validateEndoEventRecordV0(args.record);
	if (validated === null) throw new TypeError("not a valid endo.record.v0 record");
	const originalGraph = args.originalGraph !== undefined ? parseEndoGraphSnapshotV0(args.originalGraph) : undefined;
	let originalVisual: EndoSemanticVisualStateV0 | undefined;
	if (args.originalVisual !== undefined) {
		const validatedVisual = validateEndoSemanticVisualStateV0(args.originalVisual);
		if (validatedVisual === null) throw new TypeError("not a valid endo semantic visual state");
		originalVisual = validatedVisual;
	}

	let graphLayer: EndoReplayComparisonV0["graph"];
	let rebuiltStore: EndoGraphStoreV0 | undefined;
	if (originalGraph !== undefined && args.rebuildGraph !== undefined) {
		try {
			rebuiltStore = args.rebuildGraph(validated.events);
			const projection = projectEndoGraphAtV0(rebuiltStore, Number.MAX_SAFE_INTEGER);
			const rebuilt: EndoGraphStateV0 = {
				objects: sortByIdentifierV0(projection.objects),
				edges: sortByIdentifierV0(projection.edges),
			};
			graphLayer = canonicalEndoJsonV0(originalGraph) === canonicalEndoJsonV0(rebuilt) ? "exact" : "reconstructed";
		} catch {
			graphLayer = "unreproducible";
		}
	} else {
		graphLayer = "unreproducible";
	}

	let visualLayer: EndoReplayComparisonV0["visualState"];
	if (originalVisual !== undefined && graphLayer !== "unreproducible" && rebuiltStore !== undefined) {
		try {
			const rebuiltVisual = buildEndoSemanticVisualStateV0(rebuiltStore);
			visualLayer =
				canonicalEndoJsonV0(originalVisual) === canonicalEndoJsonV0(rebuiltVisual) ? "exact" : "reconstructed";
		} catch {
			visualLayer = "unreproducible";
		}
	} else {
		visualLayer = "unreproducible";
	}

	const comparison: EndoReplayComparisonV0 = {
		schemaVersion: "endo.replay-comparison.v0",
		recordId: validated.id,
		events: report.events,
		derived: report.derived,
		graph: graphLayer,
		visualState: visualLayer,
	};
	if (report.computedDigest !== undefined) comparison.computedDigest = report.computedDigest;
	const validatedComparison = validateEndoReplayComparisonV0(comparison);
	if (validatedComparison === null) throw new TypeError("replay comparison failed self-validation");
	return validatedComparison;
}
