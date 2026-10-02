import { describe, expect, it } from "vitest";
import { projectEndoGraphAtV0 } from "../graph/projections.ts";
import { compareEndoReplayV0, parseEndoGraphSnapshotV0 } from "../lab/replay-compare.ts";
import { validateEndoReplayComparisonV0 } from "../protocol/evaluation.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoEventRecordV0 } from "../protocol/event-record.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { buildEndoSemanticVisualStateV0 } from "../visualization/semantic-state.ts";
import { FIXTURE_EDGES, FIXTURE_NODES, fixtureStore, node } from "./graph-fixture.ts";

/** A valid event with a distinct id; every case mutates exactly one field. */
function event(id: string, sequence: number, source: EndoEventV0["source"] = "runtime-fact"): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id,
		kind: "tool.completed",
		source,
		sequence,
		at: "2026-10-02T11:00:00Z",
		coordinates: {},
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main" },
	};
}

/** A persisted record the store would have materialized for one stream. */
function storeRecord(): EndoEventRecordV0 {
	const store = createEndoEventStoreV0();
	store.ingest(event("endo.event.t1", 1));
	store.ingest(event("endo.event.t2", 2, "interpretation"));
	return store.record("endo.evidence.rec-1");
}

/** The original graph state, exactly as the fixture store projects it. */
function originalSnapshot(): { objects: unknown[]; edges: unknown[] } {
	const projection = projectEndoGraphAtV0(fixtureStore(), Number.MAX_SAFE_INTEGER);
	return { objects: projection.objects, edges: projection.edges };
}

function rebuildFixture(): ReturnType<typeof fixtureStore> {
	return fixtureStore();
}

describe("parseEndoGraphSnapshotV0", () => {
	it("normalizes the snapshot by identifier: order is not part of the state", () => {
		const reversed = { objects: [...FIXTURE_NODES].reverse(), edges: [...FIXTURE_EDGES].reverse() };
		const parsed = parseEndoGraphSnapshotV0(reversed);
		expect(parsed.objects.map((o) => o.id)).toEqual([...parsed.objects].map((o) => o.id).sort());
		expect(parsed.objects).toHaveLength(FIXTURE_NODES.length);
		expect(parsed.edges).toHaveLength(FIXTURE_EDGES.length);
	});

	it("is the strict door: unknown keys, non-arrays, and malformed entries", () => {
		expect(() => parseEndoGraphSnapshotV0({ objects: [], edges: [], extra: 1 })).toThrow(/unknown snapshot key/);
		expect(() => parseEndoGraphSnapshotV0({ objects: "nope", edges: [] })).toThrow(TypeError);
		expect(() =>
			parseEndoGraphSnapshotV0({ objects: [FIXTURE_NODES[0]], edges: [{ ...FIXTURE_EDGES[0], id: "edge-1" }] }),
		).toThrow(TypeError);
		expect(() => parseEndoGraphSnapshotV0("nope")).toThrow(TypeError);
	});

	it("accepts a snapshot with either side absent", () => {
		expect(parseEndoGraphSnapshotV0({ objects: FIXTURE_NODES }).edges).toEqual([]);
		expect(parseEndoGraphSnapshotV0({ edges: FIXTURE_EDGES }).objects).toEqual([]);
	});
});

describe("compareEndoReplayV0", () => {
	it("reports exact for every layer when the rebuild reproduces the original", () => {
		const record = storeRecord();
		const comparison = compareEndoReplayV0({
			record,
			originalGraph: originalSnapshot(),
			rebuildGraph: rebuildFixture,
			originalVisual: buildEndoSemanticVisualStateV0(fixtureStore()),
		});
		expect(comparison.schemaVersion).toBe("endo.replay-comparison.v0");
		expect(comparison.recordId).toBe("endo.evidence.rec-1");
		expect(comparison.events).toBe("exact");
		expect(comparison.derived).toBe("exact");
		expect(comparison.graph).toBe("exact");
		expect(comparison.visualState).toBe("exact");
		expect(comparison.computedDigest).toBe(sha256HexV0(canonicalEndoJsonV0(record.events)));
		expect(validateEndoReplayComparisonV0(comparison)).toBeTypeOf("object");
	});

	it("reports reconstructed when the rebuilt graph or visual state differs from the original", () => {
		const record = storeRecord();
		const extendedStore = fixtureStore();
		extendedStore.upsertObject(node("endo.node.extra-1", "note"));
		const graphDiffers = compareEndoReplayV0({
			record,
			originalGraph: originalSnapshot(),
			rebuildGraph: () => extendedStore,
		});
		expect(graphDiffers.graph).toBe("reconstructed");
		const visualDiffers = compareEndoReplayV0({
			record,
			originalGraph: originalSnapshot(),
			rebuildGraph: () => extendedStore,
			originalVisual: buildEndoSemanticVisualStateV0(fixtureStore()),
		});
		expect(visualDiffers.visualState).toBe("reconstructed");
	});

	it("reports unreproducible for a graph layer its inputs cannot support, and never omits a layer", () => {
		const record = storeRecord();
		const noOriginal = compareEndoReplayV0({ record, rebuildGraph: rebuildFixture });
		expect(noOriginal.graph).toBe("unreproducible");
		const noRebuild = compareEndoReplayV0({ record, originalGraph: originalSnapshot() });
		expect(noRebuild.graph).toBe("unreproducible");
		const throwingRebuild = compareEndoReplayV0({
			record,
			originalGraph: originalSnapshot(),
			rebuildGraph: () => {
				throw new Error("the rebuild cannot run");
			},
		});
		expect(throwingRebuild.graph).toBe("unreproducible");
	});

	it("reports unreproducible for the visual layer, and cascades from the graph layer", () => {
		const record = storeRecord();
		const noOriginalVisual = compareEndoReplayV0({
			record,
			originalGraph: originalSnapshot(),
			rebuildGraph: rebuildFixture,
		});
		expect(noOriginalVisual.visualState).toBe("unreproducible");
		const cascade = compareEndoReplayV0({
			record,
			rebuildGraph: undefined,
			originalVisual: buildEndoSemanticVisualStateV0(fixtureStore()),
		});
		expect(cascade.graph).toBe("unreproducible");
		expect(cascade.visualState).toBe("unreproducible");
	});

	it("carries the honest layers of the underlying replay report", () => {
		const record = storeRecord();
		const comparison = compareEndoReplayV0({
			record,
			originalGraph: originalSnapshot(),
			rebuildGraph: rebuildFixture,
		});
		expect(comparison.events).toBe("exact");
		expect(comparison.derived).toBe("exact");
	});

	it("keeps the door: a malformed snapshot, visual state, or record is a TypeError", () => {
		const record = storeRecord();
		expect(() =>
			compareEndoReplayV0({
				record,
				originalGraph: { objects: [], edges: [], extra: 1 },
				rebuildGraph: rebuildFixture,
			}),
		).toThrow(TypeError);
		expect(() =>
			compareEndoReplayV0({
				record,
				originalGraph: originalSnapshot(),
				rebuildGraph: rebuildFixture,
				originalVisual: "nope",
			}),
		).toThrow(TypeError);
		expect(() =>
			compareEndoReplayV0({
				record: { ...record, id: "endo.run.r1" },
				originalGraph: originalSnapshot(),
				rebuildGraph: rebuildFixture,
			}),
		).toThrow(TypeError);
	});
});
