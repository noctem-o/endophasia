// DEVELOP state and view helpers. Pure: no DOM, no network, no clock (the clock is passed in). One owner for everything that can
// change: what was read, what is in flight, the selected session and event, the client-side filters of the loaded list, and which
// stage a narrow screen shows. A selection is an opaque server token bound to one verified generation; nothing here derives a
// session identity from a displayed alias, and nothing here asks whether a process exists.
import type {
	EndoCockpitDevelopSessionRowV0,
	EndoCockpitDevelopSessionsV0,
	EndoCockpitDevelopSessionV0,
} from "../../../protocol/cockpit-develop.ts";
import type { DevelopReply } from "./develop-wire.ts";

export type DevelopRequest =
	| { kind: "list" }
	| { kind: "more"; cursor: string; generation: string }
	| { kind: "session"; selector: string; generation: string }
	| { kind: "events"; selector: string; cursor: string; generation: string };

export type LifecycleState = NonNullable<EndoCockpitDevelopSessionRowV0["recorded"]>["state"];
export type DevelopStage = "sessions" | "activity" | "details";

export interface DevelopFilters {
	sources: ReadonlySet<"pi" | "dsh">;
	states: ReadonlySet<LifecycleState>;
	text: string;
}
export const NO_DEVELOP_FILTERS: DevelopFilters = { sources: new Set(), states: new Set(), text: "" };
export const developFiltersActive = (f: DevelopFilters): boolean =>
	f.sources.size > 0 || f.states.size > 0 || f.text.trim() !== "";

export interface DevelopState {
	inventory: EndoCockpitDevelopSessionsV0 | null;
	/** The selector of the selected session, from the held inventory. */
	selected: string | null;
	/** The selected session's detail, its activity pages accumulated in order. */
	detail: EndoCockpitDevelopSessionV0 | null;
	/** The storage position of the event open in the inspector, within the loaded activity. */
	event: number | null;
	stage: DevelopStage;
	filters: DevelopFilters;
	request: { id: number; read: DevelopRequest } | null;
	problem: string | null;
	/** Whether the held state was discarded: the next action is to rediscover. */
	invalid: boolean;
	/** A sentence about something the last read changed in what was held (never an inference about why). */
	notice: string | null;
	holdUntil: number;
	/** When the inventory was last read successfully, by the browser's clock. Not a statement about the evidence's time. */
	readAt: Date | null;
}

export const initialDevelop = (): DevelopState => ({
	inventory: null,
	selected: null,
	detail: null,
	event: null,
	stage: "sessions",
	filters: NO_DEVELOP_FILTERS,
	request: null,
	problem: null,
	invalid: false,
	notice: null,
	holdUntil: 0,
	readAt: null,
});

export type DevelopAction =
	| { type: "start"; id: number; read: DevelopRequest }
	| { type: "finish"; id: number; reply: DevelopReply; now: number; at: Date }
	| { type: "select"; selector: string }
	| { type: "event"; sequence: number | null }
	| { type: "filters"; filters: DevelopFilters }
	| { type: "stage"; stage: DevelopStage }
	| { type: "cancel" }
	| { type: "tick" };

export const rowOf = (state: DevelopState, selector: string | null): EndoCockpitDevelopSessionRowV0 | null =>
	selector === null ? null : (state.inventory?.sessions.find((row) => row.selector === selector) ?? null);

export const paced = (state: DevelopState, now: number): boolean => now < state.holdUntil;

/** What a read replaced or kept, in words; used only where a read changed what was held. */
const GONE = "The previously selected session is not in the sessions now read. Select a session again.";

export function reduceDevelop(state: DevelopState, action: DevelopAction): DevelopState {
	switch (action.type) {
		case "tick":
			return { ...state };
		case "stage":
			return { ...state, stage: action.stage };
		case "filters":
			return { ...state, filters: action.filters };
		case "event": {
			if (action.sequence === null) return { ...state, event: null };
			// Only an event of the loaded activity can be open.
			return state.detail?.activity.entries.some((entry) => entry.storageSequence === action.sequence)
				? { ...state, event: action.sequence }
				: state;
		}
		case "select": {
			const row = rowOf(state, action.selector);
			if (row === null) return state;
			return {
				...state,
				selected: action.selector,
				detail: null,
				event: null,
				stage: "activity",
				notice: null,
				problem: state.holdUntil > 0 ? state.problem : null,
			};
		}
		case "cancel":
			return state.request === null
				? state
				: { ...state, request: null, problem: "Request interrupted. Retry explicitly.", notice: null };
		case "start":
			return {
				...state,
				request: { id: action.id, read: action.read },
				problem: null,
				invalid: false,
				// A new discovery keeps what is held until the replacement arrives; it never shows a half-replaced inventory.
				notice: action.read.kind === "list" ? null : state.notice,
			};
		case "finish":
			return finish(state, action);
	}
}

function finish(state: DevelopState, action: Extract<DevelopAction, { type: "finish" }>): DevelopState {
	if (state.request === null || state.request.id !== action.id) return state;
	const { read } = state.request;
	const reply = action.reply;
	const hold =
		reply.kind === "failure" && reply.retrySeconds !== null
			? action.now + reply.retrySeconds * 1000
			: state.holdUntil;
	const discard = (message: string): DevelopState => ({
		...initialDevelop(),
		filters: state.filters,
		problem: message,
		invalid: true,
		holdUntil: hold,
	});
	const keep = (message: string): DevelopState => ({ ...state, request: null, problem: message, holdUntil: hold });
	if (reply.kind === "failure") return reply.invalid ? discard(reply.message) : keep(reply.message);

	if (reply.kind === "sessions" && (read.kind === "list" || read.kind === "more")) {
		const page = reply.record;
		if (read.kind === "list") {
			if (page.page.offset !== 0) return discard("Discovery did not start at the first page. Rediscover sessions.");
			const stillThere = state.selected !== null && page.sessions.some((row) => row.selector === state.selected);
			const lost = state.selected !== null && !stillThere;
			return {
				...state,
				inventory: page,
				readAt: action.at,
				request: null,
				problem: null,
				invalid: false,
				// A selector is bound to its generation: the same one surviving means the verified prefix is unchanged.
				selected: stillThere ? state.selected : null,
				detail: stillThere && state.detail?.generation === page.generation ? state.detail : null,
				event: stillThere && state.detail?.generation === page.generation ? state.event : null,
				stage: lost ? "sessions" : state.stage,
				notice: lost ? GONE : null,
			};
		}
		const held = state.inventory;
		if (
			held === null ||
			held.generation !== read.generation ||
			page.generation !== held.generation ||
			page.page.offset !== held.sessions.length ||
			page.page.total !== held.page.total ||
			held.page.nextCursor !== read.cursor
		)
			return discard("Discovery pages do not belong to one verified inventory. Rediscover sessions.");
		const combined = [...held.sessions, ...page.sessions];
		const identities = combined.map((row) => `${row.source}\u0000${row.session}`);
		const selectors = combined.flatMap((row) => (row.selector === null ? [] : [row.selector]));
		if (
			new Set(selectors).size !== selectors.length ||
			new Set(identities).size !== combined.length ||
			identities.some((id, i) => i > 0 && id <= identities[i - 1]!)
		)
			return discard("Discovery continuation repeated or reordered a session. Rediscover sessions.");
		return { ...state, request: null, inventory: { ...page, sessions: combined }, problem: null };
	}

	if (reply.kind === "session" && read.kind === "session") {
		const record = reply.record;
		if (
			state.selected !== read.selector ||
			state.inventory?.generation !== read.generation ||
			record.generation !== read.generation ||
			record.session.selector !== read.selector ||
			record.activity.page.offset !== 0 ||
			record.source.watermark?.prefixDigest !== state.inventory.source.watermark?.prefixDigest
		)
			return discard(
				"The session read does not match the requested session or the held inventory. Rediscover sessions.",
			);
		return { ...state, request: null, detail: record, event: null, problem: null };
	}

	if (reply.kind === "session" && read.kind === "events") {
		const held = state.detail;
		const record = reply.record;
		if (
			held === null ||
			state.selected !== read.selector ||
			held.generation !== read.generation ||
			record.generation !== held.generation ||
			record.session.selector !== read.selector ||
			record.activity.page.offset !== held.activity.entries.length ||
			held.activity.page.nextCursor !== read.cursor ||
			record.activity.total !== held.activity.total ||
			record.source.watermark?.prefixDigest !== held.source.watermark?.prefixDigest
		)
			return discard("Activity pages do not belong to one verified session. Rediscover sessions.");
		const entries = [...held.activity.entries, ...record.activity.entries];
		if (entries.some((entry, i) => i > 0 && entry.storageSequence <= entries[i - 1]!.storageSequence))
			return discard("Activity continuation repeated or reordered an event. Rediscover sessions.");
		return {
			...state,
			request: null,
			problem: null,
			detail: { ...held, activity: { ...held.activity, entries, page: record.activity.page } },
		};
	}
	return discard("The response does not match what was requested. Rediscover sessions.");
}

// --- view helpers ---------------------------------------------------------------------------------------------------------------

export interface StateWording {
	/** The short label on a row or tag. Always carries "as recorded" where a state is a lifecycle state. */
	word: string;
	/** The sentence that says what the state is and is not. */
	meaning: string;
}
export const STATE_WORDING: Readonly<Record<LifecycleState, StateWording>> = {
	"not-observed": {
		word: "not observed",
		meaning: "No session attachment is recorded in the events, so no lifecycle state can be given.",
	},
	idle: {
		word: "idle · as recorded",
		meaning: "At the last recorded event a session was attached and no run was open.",
	},
	running: {
		word: "running · as recorded",
		meaning:
			"At the last recorded event a run was open. This page does not check whether a process exists; the session may have ended since.",
	},
	interrupted: {
		word: "interrupted · as recorded",
		meaning:
			"The last observation ended without a runtime-reported outcome and nothing has attached since. Recorded, not currently verified.",
	},
	detached: {
		word: "detached · as recorded",
		meaning: "The recorded events show the runtime process ended, with no run open.",
	},
};
export const OUTCOME_WORDING: Readonly<Record<string, string>> = {
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
	unclassified: "unclassified",
	interrupted: "interrupted",
	open: "open",
};
export const QUALIFICATION_WORDING: Readonly<Record<string, { word: string; meaning: string }>> = {
	inspectable: {
		word: "inspectable",
		meaning: "The recording passes the same qualification Compare uses, so its lifecycle and activity are read.",
	},
	ambiguous: { word: "ambiguous", meaning: "" },
	insufficient: { word: "insufficient", meaning: "" },
};

export function filterRows(
	rows: readonly EndoCockpitDevelopSessionRowV0[],
	filters: DevelopFilters,
): EndoCockpitDevelopSessionRowV0[] {
	const needle = filters.text.trim().toLowerCase();
	return rows.filter(
		(row) =>
			(filters.sources.size === 0 || filters.sources.has(row.source)) &&
			(filters.states.size === 0 || (row.recorded !== null && filters.states.has(row.recorded.state))) &&
			(needle === "" || row.session.toLowerCase().includes(needle)),
	);
}

export function groupBySource(
	rows: readonly EndoCockpitDevelopSessionRowV0[],
): { source: "pi" | "dsh"; label: string; rows: EndoCockpitDevelopSessionRowV0[] }[] {
	return (["pi", "dsh"] as const)
		.map((source) => ({
			source,
			label: source === "pi" ? "Pi recordings" : "DSH recordings",
			rows: rows.filter((row) => row.source === source),
		}))
		.filter((group) => group.rows.length > 0);
}

/** The sentence under the list: how much of the inventory the filters can see. Always says the filters cover only what is loaded. */
export function listCoverage(state: DevelopState, shown: number): string {
	const inventory = state.inventory;
	if (inventory === null) return "";
	const loaded = inventory.sessions.length;
	const total = inventory.page.total;
	const more = total - loaded;
	const base = `${shown === loaded ? "" : `${shown} of `}${loaded} loaded of ${total} recorded session${total === 1 ? "" : "s"}`;
	return developFiltersActive(state.filters) || more > 0
		? `${base}. Filters apply to the ${loaded} loaded${more > 0 ? `; ${more} more on the server` : ""}.`
		: `${base}.`;
}
