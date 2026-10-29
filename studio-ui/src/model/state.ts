// The Observe workspace's state, and the only place it changes. One owner: what has been read, whether a read is running, the last
// attempt that failed, the attachment, the open selection, the filters and the page size all live in this one record, and every
// change is an action through `reduce`. The reducer is pure: the clocks it needs (the wall clock for a displayed time, the monotonic
// clock for the server's requested pause) are read by the caller and passed in.
//
// The rules that held in the page this replaces hold here:
// - a read is one at a time and only when asked for; nothing polls and nothing retries (the hook that runs reads is in use-observe.ts);
// - a read that did not produce a snapshot leaves the last one on screen, marked not current;
// - the page size is committed only when a read of it succeeds, so a failed read leaves the page asking for the window it has;
// - a selection is kept across a read only where the same record is still in the window, and is cleared, with a sentence, when not.
import type { EndoCockpitSnapshotV0 } from "../../../protocol/cockpit.ts";
import { type Filters, NO_FILTERS, type Reply, selectRuntime } from "./contract.ts";
import { checkDisplayable } from "./observe.ts";
import type { Selection } from "./types.ts";

export const PAGE_SIZES = [50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 100;

export interface ReadRequest {
	afterSequence: number;
	limit: number;
}

export interface Loaded {
	snapshot: EndoCockpitSnapshotV0;
	/** When the browser received it, by the browser's clock. Not a recorded time. */
	fetchedAt: Date;
	durationMs: number;
	request: ReadRequest;
}

/** The last attempt that did not produce a snapshot. The previous snapshot, if any, stays on screen and is marked not current. */
export interface Problem {
	reply: Exclude<Reply, { kind: "snapshot" }>;
	at: Date;
	/** For a pacing response: when the controls come back, by the browser's clock. Shown, never used to decide anything. */
	retryAt: Date | null;
	/** The same moment on the monotonic clock, which both the lock and the timer that lifts it use, so they cannot disagree. */
	holdUntil: number | null;
}

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
	/** Counts the timeouts that ended a pause: a change a layout effect can follow, to give a control its focus back. */
	ticks: number;
	/** Counts reads that brought a different window: the table starts that window at the top. A refresh of the same window keeps its place. */
	windowMoves: number;
	/** Said once, in the inspector, when a read removed the open selection. Cleared by the next selection. */
	clearedNote: string | null;
	/**
	 * An attachment another workspace asked Observe to show (DEVELOP's hand-off) that the snapshot held when it asked did not list. It is
	 * kept through the read that follows and selected only if that snapshot lists it; any successful read ends the wait.
	 */
	wantedAttachment: string | null;
}

export const initialState = (): AppState => ({
	loaded: null,
	busy: false,
	problem: null,
	attachment: null,
	selection: null,
	filters: NO_FILTERS,
	pageSize: DEFAULT_PAGE_SIZE,
	attempts: 0,
	ticks: 0,
	windowMoves: 0,
	clearedNote: null,
	wantedAttachment: null,
});

export type Action =
	| { type: "read-started" }
	| {
			type: "read-finished";
			reply: Reply;
			request: ReadRequest;
			durationMs: number;
			/** The browser's wall clock at the end of the read, and its monotonic clock. Both passed in: the reducer reads none. */
			at: Date;
			now: number;
	  }
	| { type: "select"; selection: Selection }
	| { type: "close-inspector" }
	| { type: "set-filters"; filters: Filters }
	| { type: "select-attachment"; name: string }
	| { type: "want-attachment"; name: string }
	/** Nothing changes; the pause may be over, so the controls are drawn again. */
	| { type: "tick" };

/** Milliseconds of the server's requested pause still to run, on the monotonic clock; 0 when none was asked or it is over. */
export function pauseRemaining(state: AppState, now: number): number {
	const until = state.problem?.holdUntil ?? null;
	return until === null ? 0 : Math.max(0, until - now);
}

export const pacedNow = (state: AppState, now: number): boolean => pauseRemaining(state, now) > 0;

/** Whether a new read must not be started now: one is in flight, or the server asked for a pause. */
export const controlsLocked = (state: AppState, now: number): boolean => state.busy || pacedNow(state, now);

const malformed = (state: AppState, reason: string, at: Date): AppState => ({
	...state,
	problem: { reply: { kind: "malformed", reason }, at, retryAt: null, holdUntil: null },
});

/** Choose an attachment the held snapshot lists, closing a capability that belonged to the one left. Null when it is not listed. */
function chosen(state: AppState, name: string, snapshot: EndoCockpitSnapshotV0 | undefined): AppState | null {
	if (snapshot === undefined || !snapshot.runtimes.some((r) => r.identity.source.attachment === name)) return null;
	let { selection } = state;
	if (selection?.kind === "capability") {
		const runtime = selectRuntime(snapshot, name);
		const capability = selection.name;
		if (!runtime?.capabilities.capabilities.some((c) => c.capability === capability)) selection = null;
	}
	return { ...state, attachment: name, selection, wantedAttachment: null };
}

function afterSnapshot(state: AppState, snapshot: EndoCockpitSnapshotV0): AppState {
	// A wanted attachment is selected once, by the first snapshot that lists it; whatever that snapshot says, the wait ends.
	if (state.wantedAttachment !== null) {
		const wanted = chosen(state, state.wantedAttachment, snapshot);
		state = wanted ?? { ...state, wantedAttachment: null };
	}
	let { attachment, selection, filters } = state;
	// What a read says about the open selection is recomputed by every successful read: a note from an earlier read is not carried over.
	let clearedNote: string | null = null;
	const attachments = snapshot.runtimes.map((r) => r.identity.source.attachment);
	if (attachment === null || !attachments.includes(attachment)) {
		const fallback = attachments[0] ?? null;
		// The operator did not choose this registry: a capability they had open is not carried over to a same-named one in it.
		if (attachment !== null && fallback !== attachment && selection?.kind === "capability") {
			selection = null;
			clearedNote = "The attachment that capability belonged to is no longer listed, so it is closed.";
		}
		attachment = fallback;
	}
	if (selection?.kind === "event") {
		const open = selection;
		const there = snapshot.timeline.entries.find((e) => e.storageSequence === open.sequence);
		if (there === undefined || there.eventId !== open.eventId) {
			selection = null;
			const position = open.sequence.toLocaleString("en-US");
			// Only what this snapshot establishes: it holds no such event in its window, or holds a different one at that position. It does not
			// say whether the closed event exists anywhere else.
			clearedNote =
				there === undefined
					? `The event at position ${position} is not in the window now loaded, so it is closed.`
					: `The window now loaded holds a different event at position ${position} than the one that was open, so it is closed.`;
		}
	}
	if (filters.session !== null && !snapshot.timeline.sessions.some((s) => s.sessionId === filters.session))
		filters = { ...filters, session: null };
	return { ...state, attachment, selection, filters, clearedNote };
}

export function reduce(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "read-started":
			return { ...state, busy: true };
		case "read-finished": {
			const done: AppState = { ...state, busy: false, attempts: state.attempts + 1 };
			const { reply, request, at } = action;
			if (reply.kind === "snapshot") {
				// The classifier checked the shapes it knows; this checks the rest the one general way: a snapshot the page cannot show is a
				// failed read, and the read before it stays on screen as not current.
				if (!checkDisplayable(reply.snapshot, state.filters, request.limit))
					return malformed(done, "the snapshot could not be displayed", at);
				const moved =
					state.loaded === null ||
					state.loaded.request.afterSequence !== request.afterSequence ||
					state.loaded.request.limit !== request.limit;
				return afterSnapshot(
					{
						...done,
						loaded: { snapshot: reply.snapshot, fetchedAt: at, durationMs: action.durationMs, request },
						problem: null,
						pageSize: request.limit,
						windowMoves: state.windowMoves + (moved ? 1 : 0),
					},
					reply.snapshot,
				);
			}
			const pause =
				reply.kind === "paced" && reply.retryAfterSeconds !== null ? reply.retryAfterSeconds * 1000 : null;
			return {
				...done,
				// The read that was to admit a wanted attachment did not produce a snapshot: the wait ends rather than going stale.
				wantedAttachment: null,
				problem: {
					reply,
					at,
					retryAt: pause === null ? null : new Date(at.getTime() + pause),
					holdUntil: pause === null ? null : action.now + pause,
				},
			};
		}
		case "select":
			return { ...state, selection: action.selection, clearedNote: null };
		case "close-inspector":
			return { ...state, selection: null, clearedNote: null };
		case "set-filters":
			return { ...state, filters: action.filters };
		case "select-attachment": {
			// Only an attachment the snapshot lists can be chosen: the page offers no other, and a name it does not list must not fall back
			// to the first one while claiming to be another.
			return chosen(state, action.name, state.loaded?.snapshot) ?? state;
		}
		case "want-attachment": {
			// Listed now: chosen now. Not listed (the snapshot is older than the registration): waited for, through the next read only.
			return chosen(state, action.name, state.loaded?.snapshot) ?? { ...state, wantedAttachment: action.name };
		}
		case "tick":
			return { ...state, ticks: state.ticks + 1 };
	}
}
