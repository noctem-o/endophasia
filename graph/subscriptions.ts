// Graph subscriptions v0: in-process change notifications for the normalized object store. A listener is
// registered against a store and receives one EndoGraphChangeV0 per upsert, in upsert order. The delivery
// discipline is the house observation pattern (RuntimeMissionTraceSourceV0.observe): a listener that throws must
// not stop delivery to the other listeners, and unsubscribe is idempotent.

import type { EndoGraphChangeV0 } from "../protocol/graph.ts";

/** A graph change listener. */
export type EndoGraphListenerV0 = (change: EndoGraphChangeV0) => void;

/** A live subscription to a store's change stream. */
export interface EndoGraphSubscriptionV0 {
	/** False after unsubscribe() has been called. */
	readonly active: boolean;
	/** Idempotent. Stops future delivery. */
	unsubscribe(): void;
}

interface EndoGraphSubscriptionEntryV0 {
	listener: EndoGraphListenerV0;
	active: boolean;
}

/**
 * Subscriber bookkeeping used by the store: add listeners, deliver in registration order, and tolerate
 * unsubscribes and throws during delivery.
 */
export interface EndoGraphSubscribersV0 {
	subscribe(listener: EndoGraphListenerV0): EndoGraphSubscriptionV0;
	emit(change: EndoGraphChangeV0): void;
}

export function createEndoGraphSubscribersV0(): EndoGraphSubscribersV0 {
	const entries: EndoGraphSubscriptionEntryV0[] = [];
	return {
		subscribe(listener) {
			const entry: EndoGraphSubscriptionEntryV0 = { listener, active: true };
			entries.push(entry);
			return {
				get active() {
					return entry.active;
				},
				unsubscribe() {
					entry.active = false;
				},
			};
		},
		emit(change) {
			for (const entry of [...entries]) {
				if (!entry.active) continue;
				try {
					entry.listener(change);
				} catch {
					// A listener that throws must not stop delivery to the other listeners.
				}
			}
		},
	};
}
