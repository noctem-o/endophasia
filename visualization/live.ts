// Live semantic visual state v0: the "live graph updates" and "model/runtime-directed animation" surface.
// The updater subscribes to the cognition graph store and, on every graph change, rebuilds the semantic
// visual state and delivers it. Each delivery carries a derived temporal-motion signal: the graph sequence
// delta since the previous successful delivery. The initial delivery — the build at creation time — has no
// predecessor and no motion signal; a delivery whose listener throws is dropped, and the next motion signal
// is measured from the last successful delivery. The initial delivery is synchronous: a throwing listener
// propagates from the create call, before any subscription exists.

import type { EndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoSemanticVisualStateV0, EndoVisualSignalV0 } from "../protocol/visualization.ts";
import { buildEndoSemanticVisualStateV0 } from "./semantic-state.ts";

/**
 * A live semantic visual state updater.
 */
export interface EndoSemanticVisualUpdaterV0 {
	/** True while the updater is subscribed to the graph store. */
	readonly active: boolean;
	/** The last delivered semantic visual state. */
	readonly state: EndoSemanticVisualStateV0;
	/** Stops the deliveries; idempotent. */
	unsubscribe(): void;
}

function motionSignalV0(delta: number): EndoVisualSignalV0 {
	return {
		schemaVersion: "endo.visual-signal.v0",
		signal: "motion",
		availability: "available",
		value: delta,
		origin: "derived",
	};
}

/**
 * Creates the live updater. The initial build is delivered synchronously to `onState`; each subsequent
 * graph change rebuilds the state and delivers it with the temporal-motion signal (the sequence delta since
 * the last successful delivery) inserted into the scene signals, sorted by name. The `options` are the
 * builder's options, passed through unchanged on every rebuild.
 */
export function createEndoSemanticVisualUpdaterV0(
	store: EndoGraphStoreV0,
	options: unknown,
	onState: (state: EndoSemanticVisualStateV0) => void,
): EndoSemanticVisualUpdaterV0 {
	const first = buildEndoSemanticVisualStateV0(store, options);
	onState(first);
	let lastDelivered = first;
	let lastSequence = first.source.sequence;
	let active = true;
	const subscription = store.subscribe(() => {
		if (!active) return;
		const next = buildEndoSemanticVisualStateV0(store, options);
		const delivered: EndoSemanticVisualStateV0 = {
			...next,
			signals: [
				...next.signals.filter((signal) => signal.signal !== "motion"),
				motionSignalV0(next.source.sequence - lastSequence),
			].sort((a, b) => (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0)),
		};
		try {
			onState(delivered);
			lastDelivered = delivered;
			lastSequence = delivered.source.sequence;
		} catch {
			// a dropped delivery: the next motion signal is measured from the last successful delivery
		}
	});
	return {
		get active(): boolean {
			return active;
		},
		get state(): EndoSemanticVisualStateV0 {
			return lastDelivered;
		},
		unsubscribe(): void {
			if (!active) return;
			active = false;
			subscription.unsubscribe();
		},
	};
}
