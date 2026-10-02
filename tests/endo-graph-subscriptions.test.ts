import { describe, expect, it } from "vitest";
import { createEndoGraphSubscribersV0, type EndoGraphSubscriptionV0 } from "../graph/subscriptions.ts";
import type { EndoGraphChangeV0 } from "../protocol/graph.ts";

function change(id: string, revision: number): EndoGraphChangeV0 {
	return {
		schemaVersion: "endo.graph-change.v0",
		kind: "object",
		id,
		revision,
	};
}

describe("createEndoGraphSubscribersV0", () => {
	it("delivers to listeners in registration order", () => {
		const subscribers = createEndoGraphSubscribersV0();
		const order: string[] = [];
		subscribers.subscribe(() => {
			order.push("second");
		});
		subscribers.subscribe(() => {
			order.push("first");
		});
		subscribers.emit(change("endo.node.a", 1));
		expect(order).toEqual(["second", "first"]);
	});

	it("delivers every change to every active listener", () => {
		const subscribers = createEndoGraphSubscribersV0();
		const first: EndoGraphChangeV0[] = [];
		const second: EndoGraphChangeV0[] = [];
		subscribers.subscribe((change) => {
			first.push(change);
		});
		subscribers.subscribe((change) => {
			second.push(change);
		});
		subscribers.emit(change("endo.node.a", 1));
		subscribers.emit(change("endo.node.b", 1));
		expect(first).toEqual([change("endo.node.a", 1), change("endo.node.b", 1)]);
		expect(second).toEqual([change("endo.node.a", 1), change("endo.node.b", 1)]);
	});

	it("does not stop delivery when a listener throws", () => {
		const subscribers = createEndoGraphSubscribersV0();
		const received: string[] = [];
		subscribers.subscribe(() => {
			throw new Error("listener failure");
		});
		subscribers.subscribe((change) => {
			received.push(change.id);
		});
		subscribers.emit(change("endo.node.a", 1));
		subscribers.emit(change("endo.node.b", 1));
		expect(received).toEqual(["endo.node.a", "endo.node.b"]);
	});

	it("stops delivery after an idempotent unsubscribe", () => {
		const subscribers = createEndoGraphSubscribersV0();
		const received: string[] = [];
		const subscription = subscribers.subscribe((change) => {
			received.push(change.id);
		});
		expect(subscription.active).toBe(true);
		subscribers.emit(change("endo.node.a", 1));
		subscription.unsubscribe();
		subscription.unsubscribe();
		expect(subscription.active).toBe(false);
		subscribers.emit(change("endo.node.b", 1));
		expect(received).toEqual(["endo.node.a"]);
	});

	it("treats a listener unsubscribed during an emit as inactive for that emit and all later ones", () => {
		const subscribers = createEndoGraphSubscribersV0();
		const received = { count: 0 };
		let targetSubscription: EndoGraphSubscriptionV0;
		const earlier = subscribers.subscribe(() => {
			targetSubscription.unsubscribe();
		});
		targetSubscription = subscribers.subscribe(() => {
			received.count += 1;
		});
		subscribers.emit(change("endo.node.a", 1));
		expect(received.count).toBe(0);
		subscribers.emit(change("endo.node.b", 1));
		expect(received.count).toBe(0);
		expect(earlier.active).toBe(true);
	});
});
