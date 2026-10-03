import { describe, expect, it } from "vitest";
import { createEndoGraphStoreV0 } from "../graph/store.ts";
import { CLAIM_ID, GHOST_ID, node, RUN_ID, SESSION_ID } from "./graph-fixture.ts";

describe("createEndoGraphStoreV0", () => {
	it("starts empty", () => {
		const store = createEndoGraphStoreV0();
		expect(store.objectCount).toBe(0);
		expect(store.edgeCount).toBe(0);
		expect(store.sequence).toBe(0);
		expect(store.log()).toEqual([]);
	});

	it("records objects through the strict door and stores a deep-frozen copy", () => {
		const store = createEndoGraphStoreV0();
		const value = node(SESSION_ID, "session");
		const stored = store.upsertObject(value);
		expect(stored).toEqual(value);
		expect(stored).not.toBe(value);
		expect(store.getObject(SESSION_ID)).toBe(stored);
		expect(Object.isFrozen(stored)).toBe(true);
		expect(Object.isFrozen(stored.payload)).toBe(true);
		expect(store.objectCount).toBe(1);
		expect(store.sequence).toBe(1);
	});

	it("rejects malformed objects at the door", () => {
		const store = createEndoGraphStoreV0();
		expect(() => store.upsertObject({ ...node(SESSION_ID, "session"), kind: 1 })).toThrow(TypeError);
		expect(() => store.upsertObject({ ...node(SESSION_ID, "session"), id: "endo.event.e1" })).toThrow(TypeError);
		expect(() => store.upsertObject("endo.node.session-1")).toThrow(TypeError);
	});

	it("requires the object payload to be plain JSON (structural validation is not enough)", () => {
		const store = createEndoGraphStoreV0();
		const value = { ...node(SESSION_ID, "session"), payload: new Date(0) };
		expect(() => store.upsertObject(value)).toThrow(TypeError);
		expect(store.objectCount).toBe(0);
	});

	it("keeps last-write-wins for lookups and retains every revision in the log", () => {
		const store = createEndoGraphStoreV0();
		const first = node(SESSION_ID, "session");
		const second = { ...first, payload: { note: "revised" } };
		const firstStored = store.upsertObject(first);
		const secondStored = store.upsertObject(second);
		expect(firstStored).not.toBe(first);
		expect(secondStored).not.toBe(second);
		expect(store.getObject(SESSION_ID)).toBe(secondStored);
		expect(store.objectCount).toBe(1);
		const log = store.log();
		expect(log).toHaveLength(2);
		expect(log[0].change.revision).toBe(1);
		expect(log[1].change.revision).toBe(2);
		expect(log[0].value).toBe(firstStored);
		expect(log[1].value).toBe(secondStored);
		expect(Object.isFrozen(log[0].value)).toBe(true);
		expect(Object.isFrozen(log[1].change)).toBe(true);
	});

	it("numbers revisions per identifier and the sequence globally, across kinds", () => {
		const store = createEndoGraphStoreV0();
		store.upsertObject(node(SESSION_ID, "session"));
		store.upsertEdge({
			schemaVersion: "endo.edge.v0",
			id: "endo.edge.e1",
			source: SESSION_ID,
			target: "endo.node.run-1",
			relation: "derived-from",
			observedIn: "endo.event.session.started",
		});
		store.upsertObject(node(CLAIM_ID, "claim"));
		expect(store.sequence).toBe(3);
		const log = store.log();
		expect(log[0].sequence).toBe(1);
		expect(log[1].sequence).toBe(2);
		expect(log[2].sequence).toBe(3);
		expect(log[1].change.kind).toBe("edge");
		expect(log[1].change.revision).toBe(1);
	});

	it("records edges through the strict door and rejects malformed edges", () => {
		const store = createEndoGraphStoreV0();
		const edgeValue = {
			schemaVersion: "endo.edge.v0",
			id: "endo.edge.e1",
			source: SESSION_ID,
			target: RUN_ID,
			relation: "derived-from",
			observedIn: "endo.event.session.started",
		};
		const stored = store.upsertEdge(edgeValue);
		expect(stored).toEqual(edgeValue);
		expect(stored).not.toBe(edgeValue);
		expect(store.getEdge("endo.edge.e1")).toBe(stored);
		expect(Object.isFrozen(stored)).toBe(true);
		expect(store.edgeCount).toBe(1);
		expect(() => store.upsertEdge({ ...edgeValue, relation: "Derived-From" })).toThrow(TypeError);
		expect(() => store.upsertEdge({ ...edgeValue, id: "endo.node.n1" })).toThrow(TypeError);
		expect(store.edgeCount).toBe(1);
	});

	it("returns null for unknown identifiers and identifiers in the wrong namespace", () => {
		const store = createEndoGraphStoreV0();
		store.upsertObject(node(SESSION_ID, "session"));
		expect(store.getObject("endo.node.nowhere")).toBeNull();
		expect(store.getObject("endo.edge.e1")).toBeNull();
		expect(store.getObject("session-1")).toBeNull();
		expect(store.getEdge("endo.node.session-1")).toBeNull();
	});

	it("lists edges for a node in both directions, sorted by edge identifier, including dangling edges", () => {
		const store = createEndoGraphStoreV0();
		for (const [id, source, target] of [
			["endo.edge.b", CLAIM_ID, GHOST_ID],
			["endo.edge.a", GHOST_ID, SESSION_ID],
			["endo.edge.c", SESSION_ID, RUN_ID],
		] as const) {
			store.upsertEdge({
				schemaVersion: "endo.edge.v0",
				id,
				source,
				target,
				relation: "related-to",
				observedIn: "endo.event.session.started",
			});
		}
		expect(store.edgesForNode(SESSION_ID).map((edge) => edge.id)).toEqual(["endo.edge.a", "endo.edge.c"]);
		expect(store.edgesForNode(GHOST_ID).map((edge) => edge.id)).toEqual(["endo.edge.a", "endo.edge.b"]);
		expect(store.getObject(GHOST_ID)).toBeNull();
		expect(store.edgesForNode("endo.node.nowhere")).toEqual([]);
	});

	it("rebuilds adjacency when an edge revision moves its endpoints", () => {
		const store = createEndoGraphStoreV0();
		const endpoints = {
			schemaVersion: "endo.edge.v0",
			id: "endo.edge.e1",
			source: CLAIM_ID,
			target: GHOST_ID,
			relation: "supports",
			observedIn: "endo.event.session.started",
		};
		store.upsertEdge(endpoints);
		expect(store.edgesForNode(GHOST_ID).map((edge) => edge.id)).toEqual(["endo.edge.e1"]);
		store.upsertEdge({ ...endpoints, target: RUN_ID });
		expect(store.edgesForNode(GHOST_ID)).toEqual([]);
		expect(store.edgesForNode(RUN_ID).map((edge) => edge.id)).toEqual(["endo.edge.e1"]);
	});

	it("returns a copy of the revision log", () => {
		const store = createEndoGraphStoreV0();
		store.upsertObject(node(SESSION_ID, "session"));
		const first = store.log();
		expect(store.log()).not.toBe(first);
		expect(store.log()).toHaveLength(1);
	});
});

describe("graph store subscriptions", () => {
	it("delivers one change per upsert, in upsert order, with the per-identifier revision", () => {
		const store = createEndoGraphStoreV0();
		const changes: unknown[] = [];
		store.subscribe((change) => {
			changes.push(change);
		});
		const first = node(SESSION_ID, "session");
		store.upsertObject(first);
		store.upsertObject({ ...first, payload: { note: "revised" } });
		store.upsertEdge({
			schemaVersion: "endo.edge.v0",
			id: "endo.edge.e1",
			source: SESSION_ID,
			target: RUN_ID,
			relation: "derived-from",
			observedIn: "endo.event.session.started",
		});
		expect(changes).toEqual([
			{ schemaVersion: "endo.graph-change.v0", kind: "object", id: SESSION_ID, revision: 1 },
			{ schemaVersion: "endo.graph-change.v0", kind: "object", id: SESSION_ID, revision: 2 },
			{ schemaVersion: "endo.graph-change.v0", kind: "edge", id: "endo.edge.e1", revision: 1 },
		]);
	});

	it("does not stop delivery when a listener throws", () => {
		const store = createEndoGraphStoreV0();
		const received: string[] = [];
		store.subscribe(() => {
			throw new Error("listener failure");
		});
		store.subscribe((change) => {
			received.push(change.id);
		});
		store.upsertObject(node(SESSION_ID, "session"));
		expect(received).toEqual([SESSION_ID]);
	});

	it("unsubscribes idempotently and stops delivery", () => {
		const store = createEndoGraphStoreV0();
		const received: string[] = [];
		const subscription = store.subscribe((change) => {
			received.push(change.id);
		});
		expect(subscription.active).toBe(true);
		store.upsertObject(node(SESSION_ID, "session"));
		subscription.unsubscribe();
		subscription.unsubscribe();
		expect(subscription.active).toBe(false);
		store.upsertObject(node(CLAIM_ID, "claim"));
		expect(received).toEqual([SESSION_ID]);
	});
});
