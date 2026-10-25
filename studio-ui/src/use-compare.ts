// One request at a time, no polling. Cancellation plus reducer request identity fences late responses.
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { fetchCompare } from "./api.ts";
import { type CompareRequest, initialCompare, reduceCompare } from "./model/compare.ts";

export function useCompare(active: boolean) {
	const [state, dispatch] = useReducer(reduceCompare, undefined, initialCompare);
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
	const load = useCallback((read: CompareRequest) => {
		if (performance.now() < latest.current.holdUntil) return;
		focusAfterRead.current = document.activeElement instanceof HTMLElement ? document.activeElement.id : null;
		running.current?.abort();
		const controller = new AbortController();
		running.current = controller;
		const id = ++sequence.current;
		dispatch({ type: "start", id, read });
		void fetchCompare(read, controller.signal).then((reply) => {
			if (sequence.current !== id) return;
			running.current = null;
			dispatch({ type: "finish", id, reply, now: performance.now() });
		});
	}, []);
	useEffect(() => {
		if (active && !entered.current) {
			entered.current = true;
			load({ kind: "discover" });
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
	// A server-requested pause lifts controls once; it never starts a read. State dependency also handles an early timer.
	useEffect(() => {
		const remaining = state.holdUntil - performance.now();
		if (remaining <= 0) return;
		const timer = setTimeout(() => dispatch({ type: "tick" }), remaining + 50);
		return () => clearTimeout(timer);
	}, [state]);
	useLayoutEffect(() => {
		if (!active || state.request !== null || performance.now() < state.holdUntil) return;
		const id = focusAfterRead.current;
		const target = id ? document.getElementById(id) : null;
		const current = document.activeElement;
		if (
			(current === document.body || (current instanceof HTMLElement && current.matches(":disabled"))) &&
			target instanceof HTMLButtonElement &&
			!target.disabled
		)
			target.focus({ preventScroll: true });
		focusAfterRead.current = null;
	}, [active, state]);

	return {
		state,
		paced: performance.now() < state.holdUntil,
		cancel,
		rediscover: () => load({ kind: "discover" }),
		more: () => {
			const held = latest.current.inventory;
			if (held?.page.nextCursor) load({ kind: "more", cursor: held.page.nextCursor, generation: held.generation });
		},
		choose: (side: "a" | "b", value: string) => {
			cancel();
			dispatch({ type: "choose", side, value });
		},
		compare: () => {
			const s = latest.current;
			if (s.inventory && s.a && s.b && !s.invalid)
				load({ kind: "compare", generation: s.inventory.generation, pair: { a: s.a, b: s.b } });
		},
	};
}
