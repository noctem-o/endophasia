// The view models: what the page says about the contract's records, as plain data. Pure: no DOM and no network, so the same
// functions are tested directly and a different renderer (a spatial one, say) can take their output unchanged.
//
// The rules that keep the page from claiming more than the record permits live here, and each has a test:
// - a missing value stays missing: a null cost is "not recorded", never 0; a null total is "unknown", never 0 or the page size;
// - `storageSequence` is the order, `recordedAt` is the producer's clock and is shown as written;
// - usage is shown per event and is never summed (one call can be recorded by more than one event);
// - nothing is aggregated into a health or confidence figure; every source keeps its own condition and position.
import type {
	EndoCockpitCapabilityStateV0,
	EndoCockpitCapabilityViewV0,
	EndoCockpitEventLogSourceV0,
	EndoCockpitNoteV0,
	EndoCockpitRefV0,
	EndoCockpitRegistrySourceV0,
	EndoCockpitSessionTimelineV0,
	EndoCockpitSnapshotV0,
	EndoCockpitTimelineEntryV0,
	EndoCockpitUsageV0,
} from "../../protocol/cockpit.ts";
import { ALIAS_FORMS, CATEGORY, known, LIMIT_TEXT, NOTE_TEXT, SOURCE_STATE, STATUS, WITHHELD_TEXT } from "./labels.ts";

// --- text ----------------------------------------------------------------------------------------------------------------

/** A string from the contract, told apart by what it is: ordinary text, the policy's withheld text, or a generated alias. */
export type Presented =
	| { kind: "text"; text: string }
	| { kind: "withheld"; text: string }
	| { kind: "alias"; text: string };

export function presentText(value: string): Presented {
	if (value === WITHHELD_TEXT) return { kind: "withheld", text: value };
	if (ALIAS_FORMS.some((form) => form.test(value))) return { kind: "alias", text: value };
	return { kind: "text", text: value };
}

/** A long digest or identifier cut for a table cell. The full value stays available to the caller. */
export function abbreviated(value: string, keep = 12): string {
	return value.length <= keep + 1 ? value : `${value.slice(0, keep)}…`;
}

/** A whole number as `1,234,567` in the fixed en-US form so a page reads the same on every machine; any other number as written. */
export function grouped(value: number): string {
	// Only whole numbers are grouped: the locale formatter would round a fraction to three places, and a recorded cost must read as recorded.
	return Number.isInteger(value) ? value.toLocaleString("en-US") : String(value);
}

/** A duration the way a reader wants it: milliseconds under a second, else seconds. */
export function duration(ms: number): string {
	return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// --- references ----------------------------------------------------------------------------------------------------------

/** Where a value was read from, in words: an event position, or a registry kind and its index. */
export function describeRef(ref: EndoCockpitRefV0): string {
	return ref.domain === "event-log"
		? `event log · position ${grouped(ref.storageSequence)}`
		: `registry ${ref.attachment} · ${ref.kind} #${ref.index + 1}`;
}

// --- sources -------------------------------------------------------------------------------------------------------------

export interface SourceView {
	id: string;
	title: string;
	state: string;
	/** The state's name and meaning, or null for a state this build does not know (shown as its raw text). */
	described: { label: string; meaning: string } | null;
	facts: { label: string; value: string }[];
	tornTailBytes: number | null;
	sealedAt: number | null;
	error: string | null;
	/** Whether the source has a position at all. Null is not a zero-length source. */
	positioned: boolean;
}

const COUNT_KINDS = ["fingerprint", "change", "evidence", "state", "notification"] as const;

export function eventLogSourceView(source: EndoCockpitEventLogSourceV0): SourceView {
	const mark = source.watermark;
	return {
		id: "event-log",
		title: "Event log",
		state: source.condition.state,
		described: known(SOURCE_STATE, source.condition.state),
		facts:
			mark === null
				? []
				: [
						{ label: "events read", value: grouped(mark.length) },
						{
							label: "last event",
							value: mark.lastEventId === null ? "none" : abbreviated(mark.lastEventId, 22),
						},
						{
							label: "prefix digest",
							value: mark.prefixDigest === null ? "none (empty log)" : abbreviated(mark.prefixDigest, 16),
						},
						{ label: "digest key", value: abbreviated(mark.keyId, 22) },
					],
		tornTailBytes: source.condition.tornTail?.bytes ?? null,
		sealedAt: source.condition.sealedAt,
		error: source.condition.error?.message ?? null,
		positioned: mark !== null,
	};
}

export function registrySourceView(source: EndoCockpitRegistrySourceV0): SourceView {
	const mark = source.watermark;
	return {
		id: `registry:${source.attachment}`,
		title: `Registry · ${source.attachment}`,
		state: source.condition.state,
		described: known(SOURCE_STATE, source.condition.state),
		facts:
			mark === null
				? []
				: [
						{
							label: "records",
							value: COUNT_KINDS.map((kind) => `${kind} ${grouped(mark.counts[kind])}`).join(" · "),
						},
						{ label: "content digest", value: abbreviated(mark.contentDigest, 16) },
						{ label: "digest key", value: abbreviated(mark.keyId, 22) },
					],
		tornTailBytes: source.condition.tornTail?.bytes ?? null,
		sealedAt: source.condition.sealedAt,
		error: source.condition.error?.message ?? null,
		positioned: mark !== null,
	};
}

export interface NoteView {
	code: string;
	/** The sentence for a note code this build knows, or null (shown as the raw code). */
	text: string | null;
	refs: string[];
}

export function noteViews(notes: readonly EndoCockpitNoteV0[]): NoteView[] {
	return notes.map((note) => ({
		code: note.code,
		text: known(NOTE_TEXT, note.code),
		refs: note.refs.map(describeRef),
	}));
}

// --- timeline ------------------------------------------------------------------------------------------------------------

export interface Filters {
	categories: ReadonlySet<string>;
	text: string;
	flaggedOnly: boolean;
	session: string | null;
}

export const NO_FILTERS: Filters = { categories: new Set(), text: "", flaggedOnly: false, session: null };

export function filtersActive(filters: Filters): boolean {
	return filters.categories.size > 0 || filters.text.trim() !== "" || filters.flaggedOnly || filters.session !== null;
}

export interface FilteredEntries {
	rows: EndoCockpitTimelineEntryV0[];
	/** Entries that pass the filters, and entries in the loaded window. Filters never reach beyond the window. */
	shown: number;
	inWindow: number;
}

/** Filter the loaded window only. An empty category set means every category. Order is the window's own. */
export function filterEntries(entries: readonly EndoCockpitTimelineEntryV0[], filters: Filters): FilteredEntries {
	const needle = filters.text.trim().toLowerCase();
	const rows = entries.filter((entry) => {
		if (filters.categories.size > 0 && !filters.categories.has(entry.category)) return false;
		if (filters.flaggedOnly && entry.flags.length === 0) return false;
		if (filters.session !== null && entry.sessionId !== filters.session) return false;
		if (needle === "") return true;
		return (
			entry.kind.toLowerCase().includes(needle) ||
			entry.producer.toLowerCase().includes(needle) ||
			entry.eventId.toLowerCase().includes(needle)
		);
	});
	return { rows, shown: rows.length, inWindow: entries.length };
}

/** How many entries of the window fall in each category, in the order the contract lists them. */
export function categoryCounts(entries: readonly EndoCockpitTimelineEntryV0[]): { category: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const entry of entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
	const order = Object.keys(CATEGORY);
	return [...counts.entries()]
		.sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || (a < b ? -1 : 1))
		.map(([category, count]) => ({ category, count }));
}

export interface PagerView {
	/** The first and last storage position in this window, or null for an empty window. */
	firstPosition: number | null;
	lastPosition: number | null;
	/** Events the source held when it was read, or null when the source has no position (never 0). */
	total: number | null;
	hasMore: boolean | null;
	/** The `afterSequence` that reaches each page, or null when that page is where we are or cannot be known. */
	firstAfter: number | null;
	previousAfter: number | null;
	nextAfter: number | null;
	latestAfter: number | null;
}

export function pagerView(timeline: EndoCockpitSessionTimelineV0, pageSize: number): PagerView {
	const { afterSequence, nextAfterSequence, hasMore } = timeline.window;
	const total = timeline.source.watermark?.length ?? null;
	const empty = nextAfterSequence === afterSequence;
	const latest = total === null ? null : Math.max(0, total - pageSize);
	return {
		firstPosition: empty ? null : afterSequence + 1,
		lastPosition: empty ? null : nextAfterSequence,
		total,
		hasMore,
		firstAfter: afterSequence > 0 ? 0 : null,
		previousAfter: afterSequence > 0 ? Math.max(0, afterSequence - pageSize) : null,
		nextAfter: hasMore === true ? nextAfterSequence : null,
		latestAfter: latest !== null && latest !== afterSequence && hasMore === true ? latest : null,
	};
}

// --- usage ---------------------------------------------------------------------------------------------------------------

export type UsageView =
	| { kind: "never" }
	| { kind: "not-recorded"; reason: string }
	| { kind: "reported"; parts: { label: string; value: string; recorded: boolean }[] };

/**
 * One event's usage, as recorded. `null` means the kind never carries usage; "not-recorded" means it could have and this event
 * does not; a number is shown only when recorded. A null cost or reasoning count is "not recorded", never 0, and nothing is added up.
 */
export function usageView(usage: EndoCockpitTimelineEntryV0["usage"]): UsageView {
	if (usage === null) return { kind: "never" };
	if (usage.basis === "unavailable") return { kind: "not-recorded", reason: usage.reason };
	const value: EndoCockpitUsageV0 = usage.value;
	const count = (label: string, n: number | null) => ({
		label,
		value: n === null ? "not recorded" : grouped(n),
		recorded: n !== null,
	});
	return {
		kind: "reported",
		parts: [
			count("input tokens", value.input),
			count("output tokens", value.output),
			count("cache read tokens", value.cacheRead),
			count("cache write tokens", value.cacheWrite),
			count("total tokens (this event)", value.totalTokens),
			count("reasoning tokens", value.reasoning),
			// A cost is shown as a bare number of the recorded unit: the record names no currency, so none is added.
			count("cost (no unit recorded)", value.costTotal),
		],
	};
}

// --- capabilities --------------------------------------------------------------------------------------------------------

export interface CapabilityRow {
	capability: string;
	status: string;
	statusLabel: string;
	classification: string | null;
	limits: number;
	hasEvidence: boolean;
}

export function capabilityRows(state: EndoCockpitCapabilityStateV0): CapabilityRow[] {
	return state.capabilities.map((c: EndoCockpitCapabilityViewV0) => ({
		capability: c.capability,
		status: c.status,
		statusLabel: known(STATUS, c.status)?.label ?? c.status,
		classification: c.classification,
		limits: c.limits.length,
		hasEvidence: c.evidence !== null,
	}));
}

/** How many capabilities carry each recorded status, in the contract's order. A count of records, never a score. */
export function statusCounts(rows: readonly CapabilityRow[]): { status: string; label: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	const order = Object.keys(STATUS);
	return [...counts.entries()]
		.sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
		.map(([status, count]) => ({ status, label: known(STATUS, status)?.label ?? status, count }));
}

export function limitText(code: string): string | null {
	return known(LIMIT_TEXT, code);
}

// --- snapshot ------------------------------------------------------------------------------------------------------------

export interface AttachmentChoice {
	attachment: string;
	state: string;
}

/** The attachments the snapshot lists, each with its registry's own state. Selecting one needs no request. */
export function attachmentChoices(snapshot: EndoCockpitSnapshotV0): AttachmentChoice[] {
	return snapshot.runtimes.map((runtime) => ({
		attachment: runtime.identity.source.attachment,
		state: runtime.identity.source.condition.state,
	}));
}

/** The selected attachment's views: the named one if the snapshot lists it, else the first, else null. */
export function selectRuntime(snapshot: EndoCockpitSnapshotV0, attachment: string | null) {
	return (
		snapshot.runtimes.find((runtime) => runtime.identity.source.attachment === attachment) ??
		snapshot.runtimes[0] ??
		null
	);
}
