// One request at a time, no polling, no prefetch. Cancellation plus the reducer's request identity fence late responses. A read
// happens when DEVELOP is first opened and when the operator asks (Refresh, a page of sessions, a session, a page of its activity).
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { fetchDevelop } from "./api.ts";
import { type DevelopRequest, initialDevelop, paced, reduceDevelop } from "./model/develop.ts";

export function useDevelop(active: boolean) {
	const [state, dispatch] = useReducer(reduceDevelop, undefined, initialDevelop);
	const latest = useRef(state);
	latest.current = state;
	const sequence = useRef(0);
	const running = useRef<AbortController | null>(null);
	const entered = useRef(false);
	const focusAfterRead = useRef<string | null>(null);
	const cancel = useCallback(() => {
		sequence.current += 1;
		focusAfterRead.current = null;
		running.current?.abort();
		running.current = null;
		dispatch({ type: "cancel" });
	}, []);
	const load = useCallback((read: DevelopRequest) => {
		if (paced(latest.current, performance.now())) return;
		focusAfterRead.current = document.activeElement instanceof HTMLElement ? document.activeElement.id : null;
		running.current?.abort();
		const controller = new AbortController();
		running.current = controller;
		const id = ++sequence.current;
		dispatch({ type: "start", id, read });
		void fetchDevelop(read, controller.signal).then((reply) => {
			if (sequence.current !== id) return;
			running.current = null;
			dispatch({ type: "finish", id, reply, now: performance.now(), at: new Date() });
		});
	}, []);
	useEffect(() => {
		if (active && !entered.current) {
			entered.current = true;
			load({ kind: "list" });
		}
		if (!active) cancel();
	}, [active, load, cancel]);
	useEffect(
		() => () => {
			sequence.current += 1;
			running.current?.abort();
		},
		[],
	);
	// A server-requested pause lifts controls once; it never starts a read.
	useEffect(() => {
		const remaining = state.holdUntil - performance.now();
		if (remaining <= 0) return;
		const timer = setTimeout(() => dispatch({ type: "tick" }), remaining + 50);
		return () => clearTimeout(timer);
	}, [state]);
	useLayoutEffect(() => {
		if (!active || state.request !== null || paced(state, performance.now())) return;
		const id = focusAfterRead.current;
		const target = id ? document.getElementById(id) : null;
		const current = document.activeElement;
		if (
			(current === document.body || (current instanceof HTMLElement && current.matches(":disabled"))) &&
			target instanceof HTMLElement &&
			!(target as HTMLButtonElement).disabled
		)
			target.focus({ preventScroll: true });
		focusAfterRead.current = null;
	}, [active, state]);

	return {
		state,
		dispatch,
		paced: paced(state, performance.now()),
		cancel,
		refresh: () => load({ kind: "list" }),
		more: () => {
			const held = latest.current.inventory;
			if (held?.page.nextCursor && held.generation !== null)
				load({ kind: "more", cursor: held.page.nextCursor, generation: held.generation });
		},
		/** Select a listed, inspectable session and read its detail: two explicit steps of one operator action. */
		choose: (selector: string) => {
			const s = latest.current;
			if (s.inventory?.generation == null || paced(s, performance.now())) return;
			dispatch({ type: "select", selector });
			load({ kind: "session", selector, generation: s.inventory.generation });
		},
		moreEvents: () => {
			const s = latest.current;
			const next = s.detail?.activity.page.nextCursor;
			if (s.selected && s.detail && next)
				load({ kind: "events", selector: s.selected, cursor: next, generation: s.detail.generation });
		},
	};
}
