// Running the reads. This hook owns the three things that are not pure: the one read in flight, the timeout that lifts a pause the
// server asked for, and giving keyboard focus back to the control that started a read. Everything else is the reducer's.
//
// A read happens when the page opens and when the operator asks (Refresh, a page of the timeline, another page size), and never two at
// once. Nothing polls, nothing prefetches and nothing is started by a hover. A 429 is shown as the server pacing reads: the controls
// come back at the time it named, by one timeout set from the monotonic clock the lock also reads, and the page never retries.
import { type Dispatch, useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { fetchSnapshot } from "./api.ts";
import {
	type Action,
	type AppState,
	controlsLocked,
	initialState,
	pacedNow,
	pauseRemaining,
	type ReadRequest,
	reduce,
} from "./model/state.ts";

export interface Observe {
	state: AppState;
	dispatch: Dispatch<Action>;
	/** Whether a new read may not start now (one is running, or the server asked for a pause), by the monotonic clock. */
	locked: boolean;
	refresh(): void;
	goTo(afterSequence: number): void;
	setPageSize(size: number): void;
}

/** Whether keyboard focus is nowhere: on nothing, on the page, or on a control that has just been disabled (which a browser lets go of a moment later). */
const focusLost = (): boolean => {
	const active = document.activeElement;
	return active === null || active === document.body || (active instanceof HTMLElement && active.matches(":disabled"));
};

const focusNamed = (name: string): boolean => {
	const target = document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(name)}"]`);
	if (target === null || (target as HTMLButtonElement).disabled) return false;
	target.focus({ preventScroll: true });
	return document.activeElement === target;
};

export function useObserve(): Observe {
	const [state, dispatch] = useReducer(reduce, undefined, initialState);
	// What the callbacks read. A ref, not the render's closure: two clicks in one frame must see the first one's read as running.
	const latest = useRef(state);
	latest.current = state;
	const running = useRef(false);
	/** The `data-focus` name of a control that started a read the server then paced: it gets focus when the pause ends, if the operator has not moved on. */
	const focusAfterPause = useRef<string | null>(null);
	/** The `data-focus` name of the control that had focus when the running read started. */
	const returnFocus = useRef<string | null>(null);

	const load = useCallback((request: ReadRequest): void => {
		if (running.current || pacedNow(latest.current, performance.now())) return;
		running.current = true;
		focusAfterPause.current = null;
		// A control that starts a read is disabled while it runs, which takes focus away; focus goes back to it when the read ends.
		returnFocus.current =
			document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("data-focus") : null;
		dispatch({ type: "read-started" });
		void fetchSnapshot(request).then(({ reply, durationMs }) => {
			running.current = false;
			dispatch({ type: "read-finished", reply, request, durationMs, at: new Date(), now: performance.now() });
		});
	}, []);

	// The one read at open. (Guarded, so a development double-mount cannot start two.)
	useEffect(() => {
		load({ afterSequence: 0, limit: latest.current.pageSize });
	}, [load]);

	// The one timeout: it fires when the server's requested pause is over and the controls come back. Set from the same monotonic
	// deadline the lock reads, and set again if it fires early, so the two never disagree.
	const holdUntil = state.problem?.holdUntil ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `ticks` re-arms the timer after an early firing, `attempts` after each read
	useEffect(() => {
		if (holdUntil === null) return;
		const wait = pauseRemaining(latest.current, performance.now());
		if (wait <= 0) return;
		const timer = setTimeout(() => dispatch({ type: "tick" }), wait + 50);
		return () => clearTimeout(timer);
	}, [holdUntil, state.ticks, state.attempts]);

	// Focus goes back in the same commit that draws the end of a read (and the end of a pause), before anything can observe the gap: a
	// layout effect, so the control is enabled and the page has not yet been shown, or reported, without it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when a read ends and when a pause ends
	useLayoutEffect(() => {
		const name = returnFocus.current;
		if (name !== null) {
			returnFocus.current = null;
			if (focusLost() && !focusNamed(name) && pacedNow(latest.current, performance.now()))
				focusAfterPause.current = name;
		}
		const waiting = focusAfterPause.current;
		if (waiting !== null && !pacedNow(latest.current, performance.now()) && focusLost()) {
			focusAfterPause.current = null;
			focusNamed(waiting);
		}
	}, [state.attempts, state.ticks]);

	// Any focus the operator takes forgets the pending return.
	useEffect(() => {
		const forget = () => {
			focusAfterPause.current = null;
		};
		document.addEventListener("focusin", forget);
		return () => document.removeEventListener("focusin", forget);
	}, []);

	return {
		state,
		dispatch,
		locked: controlsLocked(state, performance.now()),
		refresh: () => load(latest.current.loaded?.request ?? { afterSequence: 0, limit: latest.current.pageSize }),
		goTo: (afterSequence) => load({ afterSequence, limit: latest.current.pageSize }),
		setPageSize: (size) => {
			// Committed when the read succeeds (see the reducer): a refused read leaves the page asking for the window it has.
			if (controlsLocked(latest.current, performance.now())) return;
			load({ afterSequence: latest.current.loaded?.request.afterSequence ?? 0, limit: size });
		},
	};
}
