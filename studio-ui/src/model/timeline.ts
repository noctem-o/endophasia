// The timeline, as data: the event log's window in storage order, its filters, its pager, and the overview map drawn from the same
// rows. `storageSequence` is the one ordering. `recordedAt` is the producer's own clock, kept as written under its own name, never used
// to place or order anything. Nothing is inferred: no duration, no outcome, no title the record does not hold.
import type { EndoCockpitSnapshotV0, EndoCockpitTimelineEntryV0 } from "../../../protocol/cockpit.ts";
import { type BasisMark, basisMark, labelText, type TextModel, textModel } from "./cells.ts";
import {
	CATEGORY,
	categoryCounts,
	type Filters,
	filtersActive,
	grouped,
	known,
	pagerView,
	SOURCE_STATE,
	usageView,
	WITHHELD_TEXT,
} from "./contract.ts";
import { type FlagModel, flagModel, type SourceCondition, sourceCondition } from "./detail.ts";
import type { Selection } from "./types.ts";

/** The producer-clock string as written, split at the `T`: the date shows once above the rows it covers, the time in each row. */
export function splitClock(recordedAt: string): { date: string | null; time: string } {
	const at = recordedAt.indexOf("T");
	return at === -1
		? { date: null, time: recordedAt }
		: { date: recordedAt.slice(0, at), time: recordedAt.slice(at + 1) };
}

/**
 * What an entry's presented fields say about how they are known: the distinct bases among them, in the contract's order. An entry
 * with no presented field has no basis to show (it is "envelope only", which is not the same as an unavailable claim).
 */
export function basesOf(entry: EndoCockpitTimelineEntryV0): string[] {
	const present = new Set(Object.values(entry.fields).map((field) => field.basis));
	const order = ["observed", "reported", "derived", "inferred", "unavailable"];
	return [...order.filter((b) => present.has(b as never)), ...[...present].filter((b) => !order.includes(b)).sort()];
}

/** The overview's mark class for an entry: one basis, a mix of several, or no presented field. */
export type MarkClass =
	| "observed"
	| "reported"
	| "derived"
	| "inferred"
	| "unavailable"
	| "mixed"
	| "envelope"
	| "unknown";

export function markClassOf(bases: readonly string[]): MarkClass {
	if (bases.length === 0) return "envelope";
	if (bases.length > 1) return "mixed";
	const only = bases[0]!;
	return only === "observed" ||
		only === "reported" ||
		only === "derived" ||
		only === "inferred" ||
		only === "unavailable"
		? only
		: "unknown";
}

export type UsageCell = { kind: "none" } | { kind: "not-recorded"; title: string } | { kind: "tokens"; text: string };

export interface RowModel {
	sequence: number;
	eventId: string;
	positionText: string;
	clock: { date: string | null; time: string; full: string };
	category: string;
	categoryLabel: string;
	kind: TextModel;
	producer: TextModel;
	bases: BasisMark[];
	markClass: MarkClass;
	flags: FlagModel[];
	usage: UsageCell;
	selected: boolean;
	/** A date line goes before this row: the producer-clock date differs from the row before it (the clock can run backwards). */
	dateDivider: string | null;
}

function usageCell(entry: EndoCockpitTimelineEntryV0): UsageCell {
	const usage = usageView(entry.usage);
	if (usage.kind === "never") return { kind: "none" };
	if (usage.kind === "not-recorded")
		return { kind: "not-recorded", title: `usage not recorded for this event: ${usage.reason}` };
	const part = (label: string) => usage.parts.find((p) => p.label === label)?.value ?? "";
	return { kind: "tokens", text: `in ${part("input tokens")} · out ${part("output tokens")}` };
}

/** Whether an entry passes the filters. Search reads only what the projection presents: ids, kind, producer and presentable field text. */
export function entryMatches(entry: EndoCockpitTimelineEntryV0, filters: Filters): boolean {
	if (filters.categories.size > 0 && !filters.categories.has(entry.category)) return false;
	if (filters.flaggedOnly && entry.flags.length === 0) return false;
	if (filters.session !== null && entry.sessionId !== filters.session) return false;
	const needle = filters.text.trim().toLowerCase();
	if (needle === "") return true;
	const haystack = [
		entry.kind,
		entry.producer,
		entry.eventId,
		entry.sessionId,
		entry.runId,
		entry.experimentId,
		...Object.values(entry.fields).map((field) =>
			field.basis === "unavailable" || typeof field.value !== "string" || field.value === WITHHELD_TEXT
				? null
				: field.value,
		),
	];
	return haystack.some((value) => value?.toLowerCase().includes(needle));
}

export interface PagerModel {
	range: string;
	of: string;
	more: string;
	firstAfter: number | null;
	previousAfter: number | null;
	nextAfter: number | null;
	latestAfter: number | null;
}

export interface OverviewMark {
	sequence: number;
	eventId: string;
	/** Centre of the entry's position within the window, 0..1, by storage position. Gaps in the positions stay gaps. */
	x: number;
	lane: number;
	markClass: MarkClass;
	flags: string[];
	/** The entry does not pass the filters: drawn dimmed, never removed. */
	dim: boolean;
	label: string;
}

export interface OverviewModel {
	/** The lanes, in the contract's category order; a category the window holds none of still has its lane. */
	lanes: { category: string; label: string; count: number }[];
	marks: OverviewMark[];
	/** The window's first and last storage position, or null for an empty window. */
	span: { first: number; last: number } | null;
	/** The whole log as read: its length, or null when the source has no position. */
	logLength: number | null;
	/** Where the window lies in the log, as fractions 0..1, or null when the log's length is not known. */
	bracket: { from: number; to: number } | null;
	/** What the overview covers, said in words. */
	coverage: "whole" | "prefix" | "partial" | "unknown" | "none";
	/** Said in place of the lanes when there is nothing to draw, and why: absent, empty and unopenable are not the same, nor is an empty window. */
	emptyText: string | null;
	coverageText: string;
	/** A selected position, for the bracket-style marker. */
	selected: number | null;
	dense: boolean;
	/** The mark classes and flags actually drawn, in a fixed order: the key names these and nothing else. */
	classes: MarkClass[];
	flags: string[];
}

export interface TimelineModel {
	state: SourceCondition;
	/** Null when the log's own state has nothing more to say; else the sentence that replaces the table. */
	empty: null | { text: string; tone: "info" | "error" };
	degradedText: string | null;
	filtersActive: boolean;
	filters: Filters;
	categories: { category: string; label: string; count: number; on: boolean }[];
	sessions: { id: string; label: string; first: string; last: string; entries: string }[];
	sessionNote: string;
	pager: PagerModel;
	window: { shown: number; inWindow: number; text: string };
	rows: RowModel[];
	noRowsText: string;
	overview: OverviewModel;
}

export function timelineModel(
	snapshot: EndoCockpitSnapshotV0,
	input: { filters: Filters; selection: Selection; limit: number },
): TimelineModel {
	const timeline = snapshot.timeline;
	const condition = timeline.source.condition;
	const pager = pagerView(timeline, input.limit);
	const active = filtersActive(input.filters);
	const matched = new Set<number>();
	for (const entry of timeline.entries) if (entryMatches(entry, input.filters)) matched.add(entry.storageSequence);
	const shownEntries = timeline.entries.filter((e) => matched.has(e.storageSequence));
	const selectedSequence = input.selection?.kind === "event" ? input.selection.sequence : null;

	let emptyText: string | null =
		condition.state === "absent"
			? "No event log exists under this store root."
			: condition.state === "empty"
				? "The event log exists and holds no events."
				: condition.state === "unopenable"
					? `The event log could not be opened${condition.error === null ? "" : `: ${condition.error.message}`}. Nothing is shown from it. This is not an empty log.`
					: null;
	if (emptyText === null && timeline.source.watermark === null)
		emptyText = "The event log has no position: nothing was read from it.";

	const rows: RowModel[] = shownEntries.map((entry, index) => {
		const clock = splitClock(entry.recordedAt);
		const before = index === 0 ? undefined : splitClock(shownEntries[index - 1]!.recordedAt).date;
		const bases = basesOf(entry);
		return {
			sequence: entry.storageSequence,
			eventId: entry.eventId,
			positionText: grouped(entry.storageSequence),
			clock: { ...clock, full: entry.recordedAt },
			category: entry.category,
			categoryLabel: known(CATEGORY, entry.category) ?? entry.category,
			kind: textModel(entry.kind, { mono: true }),
			producer: textModel(entry.producer, { mono: true }),
			bases: bases.map(basisMark),
			markClass: markClassOf(bases),
			flags: entry.flags.map(flagModel),
			usage: usageCell(entry),
			selected: entry.storageSequence === selectedSequence,
			dateDivider: clock.date !== null && clock.date !== before ? clock.date : null,
		};
	});

	const range =
		pager.firstPosition === null
			? "no events in this window"
			: `positions ${grouped(pager.firstPosition)}–${grouped(pager.lastPosition ?? 0)}`;
	const of = pager.total === null ? "position of the log unknown" : `of ${grouped(pager.total)} read`;
	const more = pager.hasMore === null ? "" : pager.hasMore ? " · more follow" : " · end of log";

	return {
		state: sourceCondition(condition.state),
		empty: emptyText === null ? null : { text: emptyText, tone: condition.state === "unopenable" ? "error" : "info" },
		degradedText:
			condition.state === "degraded"
				? `${known(SOURCE_STATE, "degraded")?.meaning ?? ""}${condition.tornTail === null ? "" : ` ${grouped(condition.tornTail.bytes)} bytes follow the last verified event.`}${condition.sealedAt === null ? "" : ` The first record that failed verification is number ${grouped(condition.sealedAt)}.`}`
				: null,
		filtersActive: active,
		filters: input.filters,
		categories: categoryCounts(timeline.entries).map(({ category, count }) => ({
			category,
			label: known(CATEGORY, category) ?? category,
			count,
			on: input.filters.categories.has(category),
		})),
		sessions: timeline.sessions.map((s) => ({
			id: s.sessionId,
			label: labelText(s.sessionId),
			first: grouped(s.firstStorageSequence),
			last: grouped(s.lastStorageSequence),
			entries: grouped(s.entries),
		})),
		sessionNote:
			"Sessions are those seen in this window. A session's events outside the window are not counted, and no outcome or duration is recorded here.",
		pager: {
			range,
			of,
			more,
			firstAfter: pager.firstAfter,
			previousAfter: pager.previousAfter,
			nextAfter: pager.nextAfter,
			latestAfter: pager.latestAfter,
		},
		window: {
			shown: rows.length,
			inWindow: timeline.entries.length,
			text: active
				? `${grouped(rows.length)} of ${grouped(timeline.entries.length)} in this window match`
				: `${grouped(timeline.entries.length)} in this window`,
		},
		rows,
		noRowsText: active
			? "No event in this window matches the filters. Other windows are not searched."
			: "This window holds no events.",
		overview: overviewModel(snapshot, matched, selectedSequence),
	};
}

const LANE_ORDER = Object.keys(CATEGORY);
const MARK_ORDER: MarkClass[] = [
	"observed",
	"reported",
	"derived",
	"inferred",
	"mixed",
	"unavailable",
	"envelope",
	"unknown",
];
const FLAG_ORDER = ["anomaly", "interruption", "discontinuity", "unrecognized"];

function overviewModel(
	snapshot: EndoCockpitSnapshotV0,
	matched: ReadonlySet<number>,
	selected: number | null,
): OverviewModel {
	const timeline = snapshot.timeline;
	const { afterSequence, nextAfterSequence, hasMore } = timeline.window;
	const first = afterSequence + 1;
	const empty = nextAfterSequence === afterSequence;
	const count = empty ? 0 : nextAfterSequence - afterSequence;
	const logLength = timeline.source.watermark?.length ?? null;
	const unknownCategories = [...new Set(timeline.entries.map((e) => e.category))]
		.filter((category) => !LANE_ORDER.includes(category))
		.sort();
	const laneKeys = [...LANE_ORDER, ...unknownCategories];
	const counts = new Map<string, number>();
	for (const entry of timeline.entries) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
	const state = timeline.source.condition.state;
	const emptyText =
		state === "absent"
			? "No event log exists under this store root, so there is nothing to draw."
			: state === "empty"
				? "The event log is empty, so there is nothing to draw."
				: state === "unopenable"
					? "The event log could not be opened, so nothing is drawn. This is not an empty log."
					: empty
						? `This window holds no events: it starts after position ${grouped(afterSequence)}.`
						: null;
	const degraded = state === "degraded";
	const coverage: OverviewModel["coverage"] =
		emptyText !== null
			? "none"
			: logLength === null || hasMore === null
				? "unknown"
				: afterSequence === 0 && hasMore === false
					? degraded
						? "prefix"
						: "whole"
					: "partial";
	return {
		lanes: laneKeys.map((category) => ({
			category,
			label: known(CATEGORY, category) ?? category,
			count: counts.get(category) ?? 0,
		})),
		marks: timeline.entries.map((entry) => ({
			sequence: entry.storageSequence,
			eventId: entry.eventId,
			x: count === 0 ? 0.5 : (entry.storageSequence - first + 0.5) / count,
			lane: laneKeys.indexOf(entry.category),
			markClass: markClassOf(basesOf(entry)),
			flags: [...entry.flags],
			dim: !matched.has(entry.storageSequence),
			label: `position ${grouped(entry.storageSequence)}, ${labelText(entry.kind)}`,
		})),
		span: empty ? null : { first, last: nextAfterSequence },
		logLength,
		bracket:
			logLength === null || logLength === 0 || empty
				? null
				: { from: Math.min(1, afterSequence / logLength), to: Math.min(1, nextAfterSequence / logLength) },
		coverage,
		emptyText,
		coverageText:
			coverage === "none"
				? (emptyText ?? "")
				: coverage === "whole"
					? "This overview covers the whole log as read."
					: coverage === "prefix"
						? `This overview covers the whole readable prefix of the log, positions ${grouped(first)}–${grouped(nextAfterSequence)}. The log is degraded: what follows the last verified event is not readable and is not drawn.`
						: coverage === "partial"
							? `This overview covers positions ${grouped(first)}–${grouped(nextAfterSequence)} only${logLength === null ? "" : ` of ${grouped(logLength)} read`}. The rest of the log is not drawn.${degraded ? " The log is degraded: what follows its last verified event is not readable." : ""}`
							: empty
								? "No window of the log was read."
								: "This overview covers the loaded window only; the log's length is not known.",
		selected,
		dense: count > 140,
		classes: MARK_ORDER.filter((c) => timeline.entries.some((e) => markClassOf(basesOf(e)) === c)),
		flags: FLAG_ORDER.filter((f) => timeline.entries.some((e) => (e.flags as string[]).includes(f))),
	};
}
