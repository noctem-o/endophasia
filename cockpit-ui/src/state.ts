// The page's state, as plain data. Renderers read it and call `Actions`; only main.ts changes it.

import type { EndoCockpitSnapshotV0 } from "../../protocol/cockpit.ts";
import type { Filters } from "./model.ts";
import type { Reply } from "./reply.ts";

export const PAGE_SIZES = [50, 100, 200, 500] as const;

export interface Loaded {
	snapshot: EndoCockpitSnapshotV0;
	/** When the browser received it, by the browser's clock. Not a recorded time. */
	fetchedAt: Date;
	durationMs: number;
	request: { afterSequence: number; limit: number };
}

/** The last attempt that did not produce a snapshot. The previous snapshot, if any, stays on screen and is marked stale. */
export interface Problem {
	reply: Exclude<Reply, { kind: "snapshot" }>;
	at: Date;
	/** For a pacing response: when the controls come back, by the browser's clock. Shown in the banner, never used to decide anything. */
	retryAt: Date | null;
	/**
	 * The same moment on the monotonic clock (`performance.now()`), which both the lock and the timer that lifts it use, so the two
	 * cannot disagree when the wall clock is set back or forward during the wait.
	 */
	holdUntil: number | null;
}

export type Selection = { kind: "event"; sequence: number } | { kind: "capability"; name: string } | null;

export interface AppState {
	loaded: Loaded | null;
	busy: boolean;
	problem: Problem | null;
	attachment: string | null;
	selection: Selection;
	filters: Filters;
	pageSize: number;
	/** Counts completed attempts; a test reads it from the page to know when one finished. */
	attempts: number;
}

export interface Actions {
	refresh(): void;
	/** Read the window after this storage position (the page size is the state's). */
	goTo(afterSequence: number): void;
	setPageSize(size: number): void;
	selectAttachment(name: string): void;
	select(selection: Selection): void;
	setFilters(filters: Filters): void;
}

/** Milliseconds of the server's requested pause still to run, on the monotonic clock; 0 when none was asked or it is over. */
export function pauseRemaining(state: AppState, now: number = performance.now()): number {
	const until = state.problem?.holdUntil ?? null;
	return until === null ? 0 : Math.max(0, until - now);
}

/** Whether the server asked the page to wait and the wait is not over. Controls that start a read are disabled until it is. */
export function pacedNow(state: AppState, now: number = performance.now()): boolean {
	return pauseRemaining(state, now) > 0;
}

/** Whether a new read must not be started now: one is in flight, or the server asked for a pause. */
export function controlsLocked(state: AppState): boolean {
	return state.busy || pacedNow(state);
}
