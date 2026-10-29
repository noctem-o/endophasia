// The cockpit's DEVELOP presentation v0: what an operator may be shown about the recorded sessions in one event log.
//
// Like the other cockpit read models this is a PROJECTION, not durable evidence and not an authority. It is built by a
// pure function (cockpit-http/develop.ts) over ONE verified observation of the event log, so every field below is either a
// count or position of recorded events, the output of the existing lifecycle reducer and trajectory projector, or the
// existing timeline presentation of a recorded event. Nothing is inferred and nothing is live:
//
// - A session is a RECORDING: Pi or DSH evidence of one session, qualified the way Compare qualifies it. It is not a process,
//   not a task and not a run. `recorded.state` is the lifecycle state the recorded events reduce to; `running` means a run was
//   open at the last recorded event, never that a process exists now.
// - "Last activity" is a storage position and the producer's own clock reading at it. The producer clock is not an order.
// - Project association, current attachment availability and token totals are not established by this evidence and are not
//   carried. Usage is per run, as the runtime reported it, never summed.
// - Tool arguments, results, prompts, paths and raw runtime identifiers are withheld by the same boundary as every other cockpit
//   record: activity entries ARE timeline entries (validated by the timeline's own validator) and the session is shown by its
//   public alias. A selector is a keyed token bound to its purpose, its source, its session and the verified log generation.
// - Selection and paging tokens are valid only for the generation they were made in. Any append or rewrite invalidates them.
//
// The protocol imports only the protocol. (This module and protocol/cockpit.ts import each other's functions; neither uses an
// import at module-evaluation time.)

import {
	ENDO_COCKPIT_CATEGORIES_V0,
	type EndoCockpitCategoryV0,
	type EndoCockpitEventLogSourceV0,
	type EndoCockpitTimelineEntryV0,
	isEndoCockpitEventLogSourceV0,
	isEndoCockpitTimelineEntryV0,
} from "./cockpit.ts";
import {
	ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	endoCockpitGapNameAdmittedV0,
	endoCockpitTextPresentableV0,
	isEndoCockpitPublicIdV0,
} from "./cockpit-fields.ts";
import { isIso8601UtcV0, isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_COCKPIT_DEVELOP_SESSIONS_SCHEMA_V0 = "endo.cockpit-develop-sessions.v0";
export const ENDO_COCKPIT_DEVELOP_SESSIONS_PROJECTION_V0 = "cockpit-develop-sessions.1";
export const ENDO_COCKPIT_DEVELOP_SESSION_SCHEMA_V0 = "endo.cockpit-develop-session.v0";
export const ENDO_COCKPIT_DEVELOP_SESSION_PROJECTION_V0 = "cockpit-develop-session.1";
export const ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0 = 50;
export const ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0 = 100;
export const ENDO_COCKPIT_DEVELOP_MAX_SESSIONS_V0 = 10_000;
export const ENDO_COCKPIT_DEVELOP_MAX_RUNS_V0 = 100;

export const ENDO_COCKPIT_DEVELOP_STATES_V0 = ["not-observed", "idle", "running", "interrupted", "detached"] as const;
export type EndoCockpitDevelopStateV0 = (typeof ENDO_COCKPIT_DEVELOP_STATES_V0)[number];
export const ENDO_COCKPIT_DEVELOP_OUTCOMES_V0 = [
	"completed",
	"failed",
	"aborted",
	"unclassified",
	"interrupted",
] as const;
export type EndoCockpitDevelopOutcomeV0 = (typeof ENDO_COCKPIT_DEVELOP_OUTCOMES_V0)[number];
export const ENDO_COCKPIT_DEVELOP_RUN_OUTCOMES_V0 = [...ENDO_COCKPIT_DEVELOP_OUTCOMES_V0, "open"] as const;
export type EndoCockpitDevelopRunOutcomeV0 = (typeof ENDO_COCKPIT_DEVELOP_RUN_OUTCOMES_V0)[number];

/** Why a recording cannot be inspected. The sentence is fixed by the reason, so no source text reaches a reader. */
export const ENDO_COCKPIT_DEVELOP_REASONS_V0 = {
	"several-attachments":
		"Several Pi attachments recorded this session. Endophasia does not choose one, so its lifecycle is not reduced.",
	"import-incomplete":
		"The DSH import of this recording is incomplete or was not recorded as clean, so it is not qualified for inspection.",
	"not-qualified": "The recording could not be qualified for inspection, so its lifecycle is not reduced.",
} as const;
export type EndoCockpitDevelopReasonV0 = keyof typeof ENDO_COCKPIT_DEVELOP_REASONS_V0;

/** The fixed text of a run list that cannot be built, by the qualification of the recording. */
export const ENDO_COCKPIT_DEVELOP_RUNS_NOT_QUALIFIED_V0 =
	"The recording is not qualified for inspection, so no per-run record was built.";

export interface EndoCockpitDevelopRecordedV0 {
	/** The lifecycle state the recorded events reduce to. Never a statement about a process that exists now. */
	state: EndoCockpitDevelopStateV0;
	lastRunOutcome: EndoCockpitDevelopOutcomeV0 | null;
	runs: number;
	turns: number;
}

export interface EndoCockpitDevelopSessionRowV0 {
	source: "pi" | "dsh";
	label: "Pi recording" | "DSH recording";
	/** The public alias of the session. Display only: never a lookup key. */
	session: string;
	qualification: "inspectable" | "ambiguous" | "insufficient";
	reason: EndoCockpitDevelopReasonV0 | null;
	/** Opaque, purpose-bound, valid for this generation only; null exactly when not inspectable. */
	selector: string | null;
	/** Events the log holds for this session (not a count of the whole log). */
	events: number;
	firstStorageSequence: number;
	lastStorageSequence: number;
	/** The producer's clock reading on the event at `lastStorageSequence`. Not an ordering and not "now". */
	lastRecordedAt: string;
	/** Null exactly when the recording is not inspectable. */
	recorded: EndoCockpitDevelopRecordedV0 | null;
}

export interface EndoCockpitDevelopSessionsV0 {
	schemaVersion: typeof ENDO_COCKPIT_DEVELOP_SESSIONS_SCHEMA_V0;
	projectionVersion: typeof ENDO_COCKPIT_DEVELOP_SESSIONS_PROJECTION_V0;
	/** Only one source, read once: this record does not combine independent histories. */
	consistency: "single-event-log-observation";
	source: EndoCockpitEventLogSourceV0;
	/** Keyed token of the verified prefix that was read; null when the log holds no events to bind a selection to. */
	generation: string | null;
	/** Sessions in the log that are not Pi or DSH recordings. They are counted, never listed. */
	otherSessions: number;
	sessions: EndoCockpitDevelopSessionRowV0[];
	page: { offset: number; total: number; hasMore: boolean; nextCursor: string | null };
}

export type EndoCockpitDevelopMeasuredV0<T> =
	| { status: "reported"; value: T }
	| { status: "unavailable"; reason: string };

export interface EndoCockpitDevelopTokensV0 {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoning: number | null;
	costTotal: number | null;
}

export interface EndoCockpitDevelopRunV0 {
	/** The observer's 1-based count of runs in the recording. */
	run: number;
	outcome: EndoCockpitDevelopRunOutcomeV0;
	turns: number;
	stopRequested: boolean;
	/** As the runtime reported it for this run. Never summed across runs. */
	tokens: EndoCockpitDevelopMeasuredV0<EndoCockpitDevelopTokensV0>;
	/** Measured by Endophasia's observer on its own clock, not reported by the runtime. */
	wallMs: EndoCockpitDevelopMeasuredV0<number>;
}

export interface EndoCockpitDevelopLifecycleV0 {
	attachments: { count: number; resumes: number };
	counts: {
		runs: number;
		turns: number;
		completed: number;
		failed: number;
		aborted: number;
		unclassified: number;
		interrupted: number;
		compactions: number;
		stopsRequested: number;
		stopsAccepted: number;
		stopsRefused: number;
	};
	/** The run open at the last recorded event, or null. */
	open: null | { turns: number; turnOpen: boolean; stopRequested: boolean; stopAccepted: boolean };
	anomalies: number;
	unrecognized: number;
	/** Fields the runtime did not report, with the adapter's reason (shown whole or withheld; never cut). */
	unavailable: { field: string; reason: string }[];
}

export interface EndoCockpitDevelopActivityV0 {
	/** Events the log holds for this session. */
	total: number;
	byCategory: Record<EndoCockpitCategoryV0, number>;
	/** From the recording's tool layers: calls the agent made and results the runtime reported as errors. Null when a layer is not recorded. */
	tools: { calls: number | null; errors: number | null };
	flagged: { interruption: number; discontinuity: number; anomaly: number; unrecognized: number };
	page: { offset: number; limit: number; hasMore: boolean; nextCursor: string | null };
	/** This page's events, in storage order, in the timeline's own presentation. */
	entries: EndoCockpitTimelineEntryV0[];
}

export interface EndoCockpitDevelopSessionV0 {
	schemaVersion: typeof ENDO_COCKPIT_DEVELOP_SESSION_SCHEMA_V0;
	projectionVersion: typeof ENDO_COCKPIT_DEVELOP_SESSION_PROJECTION_V0;
	consistency: "single-event-log-observation";
	source: EndoCockpitEventLogSourceV0;
	generation: string;
	session: EndoCockpitDevelopSessionRowV0;
	/** The Pi attachment that recorded the session when it is one and is presentable; null otherwise (DSH has none). */
	attachment: string | null;
	lifecycle: EndoCockpitDevelopLifecycleV0 | null;
	runs:
		| { status: "reported"; total: number; entries: EndoCockpitDevelopRunV0[] }
		| { status: "unavailable"; reason: string };
	activity: EndoCockpitDevelopActivityV0;
}

export const isEndoCockpitDevelopSelectorV0 = (value: unknown): value is string =>
	typeof value === "string" && /^d1-[0-9a-f]{64}$/.test(value);

/** Syntax only: the MAC is authenticated against the current verified generation after the store read. */
export function parseEndoCockpitDevelopSessionsCursorV0(value: unknown): { offset: number; mac: string } | null {
	return parseCursor(value, "s1", ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0);
}
export function parseEndoCockpitDevelopActivityCursorV0(value: unknown): { offset: number; mac: string } | null {
	return parseCursor(value, "a1", ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0);
}
function parseCursor(value: unknown, prefix: string, size: number): { offset: number; mac: string } | null {
	if (typeof value !== "string") return null;
	const match = new RegExp(`^${prefix}-([1-9][0-9]{0,5})-([0-9a-f]{64})$`).exec(value);
	if (match === null) return null;
	const offset = Number(match[1]);
	return offset % size === 0 ? { offset, mac: match[2]! } : null;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** A reason the boundary may show: whole and presentable, or exactly the fixed withheld text. */
const isPresentableReason = (value: unknown): value is string =>
	typeof value === "string" && (value === ENDO_COCKPIT_WITHHELD_TEXT_V0 || endoCockpitTextPresentableV0(value, 256));
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
	typeof value === "string" && (list as readonly string[]).includes(value);

function isRecorded(value: unknown): value is EndoCockpitDevelopRecordedV0 {
	return (
		exact(value, ["state", "lastRunOutcome", "runs", "turns"]) &&
		oneOf(ENDO_COCKPIT_DEVELOP_STATES_V0, value.state) &&
		(value.lastRunOutcome === null || oneOf(ENDO_COCKPIT_DEVELOP_OUTCOMES_V0, value.lastRunOutcome)) &&
		isCount(value.runs) &&
		isCount(value.turns) &&
		// An outcome exists only if a run ended, and a state with no attachment has no runs.
		(value.lastRunOutcome === null || value.runs >= 1) &&
		(value.state !== "not-observed" || (value.runs === 0 && value.turns === 0 && value.lastRunOutcome === null))
	);
}

function isRow(value: unknown): value is EndoCockpitDevelopSessionRowV0 {
	if (
		!exact(value, [
			"source",
			"label",
			"session",
			"qualification",
			"reason",
			"selector",
			"events",
			"firstStorageSequence",
			"lastStorageSequence",
			"lastRecordedAt",
			"recorded",
		])
	)
		return false;
	if (
		(value.source !== "pi" && value.source !== "dsh") ||
		value.label !== (value.source === "pi" ? "Pi recording" : "DSH recording") ||
		typeof value.session !== "string" ||
		!isEndoCockpitPublicIdV0(value.session, "session") ||
		!isCount(value.events) ||
		value.events < 1 ||
		!isCount(value.firstStorageSequence) ||
		!isCount(value.lastStorageSequence) ||
		value.firstStorageSequence < 1 ||
		value.lastStorageSequence < value.firstStorageSequence ||
		// The session's events lie between its first and last position, one position each.
		value.events > value.lastStorageSequence - value.firstStorageSequence + 1 ||
		typeof value.lastRecordedAt !== "string" ||
		!isIso8601UtcV0(value.lastRecordedAt)
	)
		return false;
	switch (value.qualification) {
		case "inspectable":
			return isEndoCockpitDevelopSelectorV0(value.selector) && value.reason === null && isRecorded(value.recorded);
		case "ambiguous":
			return (
				value.source === "pi" &&
				value.selector === null &&
				value.reason === "several-attachments" &&
				value.recorded === null
			);
		case "insufficient":
			return (
				value.selector === null &&
				value.recorded === null &&
				((value.source === "dsh" && value.reason === "import-incomplete") || value.reason === "not-qualified")
			);
		default:
			return false;
	}
}

/** Whether one row satisfies the row contract: what discovery checks per recording, so one bad recording never fails the list. */
export const isEndoCockpitDevelopSessionRowV0 = (value: unknown): value is EndoCockpitDevelopSessionRowV0 =>
	isRow(value);

function pageOk(
	page: unknown,
	count: number,
	size: number,
	max: number,
	parse: (value: unknown) => { offset: number } | null,
): page is { offset: number; total: number; hasMore: boolean; nextCursor: string | null } {
	if (!exact(page, ["offset", "total", "hasMore", "nextCursor"])) return false;
	const { offset, total, hasMore, nextCursor } = page;
	if (
		!isCount(offset) ||
		!isCount(total) ||
		total > max ||
		offset % size !== 0 ||
		(offset > 0 && offset >= total) ||
		count !== Math.min(size, total - offset) ||
		hasMore !== offset + count < total
	)
		return false;
	return hasMore ? parse(nextCursor)?.offset === offset + count : nextCursor === null;
}

/** Closed wire shape and internal consistency only: no claim to authenticate tokens or verify source evidence. */
export function validateEndoCockpitDevelopSessionsV0(value: unknown): EndoCockpitDevelopSessionsV0 | null {
	if (
		!exact(value, [
			"schemaVersion",
			"projectionVersion",
			"consistency",
			"source",
			"generation",
			"otherSessions",
			"sessions",
			"page",
		]) ||
		value.schemaVersion !== ENDO_COCKPIT_DEVELOP_SESSIONS_SCHEMA_V0 ||
		value.projectionVersion !== ENDO_COCKPIT_DEVELOP_SESSIONS_PROJECTION_V0 ||
		value.consistency !== "single-event-log-observation" ||
		!isEndoCockpitEventLogSourceV0(value.source) ||
		!isCount(value.otherSessions) ||
		!Array.isArray(value.sessions) ||
		value.sessions.length > ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0
	)
		return null;
	const source = value.source as EndoCockpitEventLogSourceV0;
	const events = source.watermark?.length ?? 0;
	// A selection can be bound only to events that were read.
	if (value.generation === null) {
		if (events > 0) return null;
	} else if (events === 0 || typeof value.generation !== "string" || !/^[0-9a-f]{64}$/.test(value.generation))
		return null;
	if (
		!pageOk(
			value.page,
			value.sessions.length,
			ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0,
			ENDO_COCKPIT_DEVELOP_MAX_SESSIONS_V0,
			parseEndoCockpitDevelopSessionsCursorV0,
		)
	)
		return null;
	if (value.generation === null && value.page.total !== 0) return null;
	let previous = "";
	const selectors = new Set<string>();
	for (const row of value.sessions) {
		if (!isRow(row) || row.lastStorageSequence > events) return null;
		const order = `${row.source}\u0000${row.session}`;
		if (order <= previous) return null;
		previous = order;
		if (row.selector !== null) {
			if (selectors.has(row.selector)) return null;
			selectors.add(row.selector);
		}
	}
	return value as unknown as EndoCockpitDevelopSessionsV0;
}

function isMeasured<T>(value: unknown, check: (item: unknown) => item is T): boolean {
	return (
		(exact(value, ["status", "value"]) && value.status === "reported" && check(value.value)) ||
		(exact(value, ["status", "reason"]) && value.status === "unavailable" && isPresentableReason(value.reason))
	);
}
const isTokens = (value: unknown): value is EndoCockpitDevelopTokensV0 =>
	exact(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "costTotal"]) &&
	["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => isCount(value[key])) &&
	(value.reasoning === null || isFiniteNumber(value.reasoning)) &&
	(value.costTotal === null || isFiniteNumber(value.costTotal));

function isRun(value: unknown): value is EndoCockpitDevelopRunV0 {
	return (
		exact(value, ["run", "outcome", "turns", "stopRequested", "tokens", "wallMs"]) &&
		isCount(value.run) &&
		value.run >= 1 &&
		oneOf(ENDO_COCKPIT_DEVELOP_RUN_OUTCOMES_V0, value.outcome) &&
		isCount(value.turns) &&
		typeof value.stopRequested === "boolean" &&
		isMeasured(value.tokens, isTokens) &&
		isMeasured(value.wallMs, (item): item is number => isFiniteNumber(item) && item >= 0)
	);
}

function isLifecycle(value: unknown): value is EndoCockpitDevelopLifecycleV0 {
	if (!exact(value, ["attachments", "counts", "open", "anomalies", "unrecognized", "unavailable"])) return false;
	const { attachments, counts, open } = value as Record<string, unknown>;
	if (!exact(attachments, ["count", "resumes"]) || !isCount(attachments.count) || !isCount(attachments.resumes))
		return false;
	const keys = [
		"runs",
		"turns",
		"completed",
		"failed",
		"aborted",
		"unclassified",
		"interrupted",
		"compactions",
		"stopsRequested",
		"stopsAccepted",
		"stopsRefused",
	];
	if (!exact(counts, keys) || !keys.every((key) => isCount(counts[key]))) return false;
	// Every run that ended has exactly one outcome.
	const ended = ["completed", "failed", "aborted", "unclassified", "interrupted"].reduce(
		(sum, key) => sum + (counts[key] as number),
		0,
	);
	if (ended > (counts.runs as number)) return false;
	if (
		open !== null &&
		!(
			exact(open, ["turns", "turnOpen", "stopRequested", "stopAccepted"]) &&
			isCount(open.turns) &&
			typeof open.turnOpen === "boolean" &&
			typeof open.stopRequested === "boolean" &&
			typeof open.stopAccepted === "boolean"
		)
	)
		return false;
	const list = value.unavailable;
	return (
		isCount(value.anomalies) &&
		isCount(value.unrecognized) &&
		Array.isArray(list) &&
		list.length <= ENDO_COCKPIT_MAX_DECLARED_UNAVAILABLE_V0 &&
		list.every(
			(item) =>
				exact(item, ["field", "reason"]) &&
				typeof item.field === "string" &&
				endoCockpitGapNameAdmittedV0(item.field) &&
				isPresentableReason(item.reason),
		)
	);
}

/** Closed wire shape and internal consistency only: no claim to authenticate tokens or verify source evidence. */
export function validateEndoCockpitDevelopSessionV0(value: unknown): EndoCockpitDevelopSessionV0 | null {
	if (
		!exact(value, [
			"schemaVersion",
			"projectionVersion",
			"consistency",
			"source",
			"generation",
			"session",
			"attachment",
			"lifecycle",
			"runs",
			"activity",
		]) ||
		value.schemaVersion !== ENDO_COCKPIT_DEVELOP_SESSION_SCHEMA_V0 ||
		value.projectionVersion !== ENDO_COCKPIT_DEVELOP_SESSION_PROJECTION_V0 ||
		value.consistency !== "single-event-log-observation" ||
		!isEndoCockpitEventLogSourceV0(value.source) ||
		typeof value.generation !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.generation) ||
		!isRow(value.session)
	)
		return null;
	const source = value.source as EndoCockpitEventLogSourceV0;
	const session = value.session as EndoCockpitDevelopSessionRowV0;
	if (source.watermark === null || session.lastStorageSequence > source.watermark.length) return null;
	// Only an inspectable recording has a detail: the selector that reached this record resolved to one.
	if (session.qualification !== "inspectable") return null;
	if (
		value.attachment !== null &&
		(typeof value.attachment !== "string" || value.attachment.length === 0 || value.attachment.length > 256)
	)
		return null;
	if (session.source === "dsh" && value.attachment !== null) return null;
	if (!isLifecycle(value.lifecycle)) return null;
	const lifecycle = value.lifecycle as EndoCockpitDevelopLifecycleV0;
	const recorded = session.recorded!;
	if (recorded.runs !== lifecycle.counts.runs || recorded.turns !== lifecycle.counts.turns) return null;
	const runs = value.runs;
	if (exact(runs, ["status", "total", "entries"])) {
		if (
			runs.status !== "reported" ||
			!isCount(runs.total) ||
			!Array.isArray(runs.entries) ||
			runs.entries.length > ENDO_COCKPIT_DEVELOP_MAX_RUNS_V0 ||
			runs.entries.length > runs.total ||
			!runs.entries.every(isRun)
		)
			return null;
		let previous = 0;
		for (const run of runs.entries as EndoCockpitDevelopRunV0[]) {
			if (run.run <= previous) return null;
			previous = run.run;
		}
	} else if (!(exact(runs, ["status", "reason"]) && runs.status === "unavailable" && isPresentableReason(runs.reason)))
		return null;
	const activity = value.activity;
	if (!exact(activity, ["total", "byCategory", "tools", "flagged", "page", "entries"])) return null;
	const { total, byCategory, tools, flagged, page, entries } = activity as Record<string, unknown>;
	if (!isCount(total) || total !== session.events || !Array.isArray(entries)) return null;
	if (
		!exact(byCategory, ENDO_COCKPIT_CATEGORIES_V0) ||
		!ENDO_COCKPIT_CATEGORIES_V0.every((key) => isCount(byCategory[key]))
	)
		return null;
	if (ENDO_COCKPIT_CATEGORIES_V0.reduce((sum, key) => sum + (byCategory[key] as number), 0) !== total) return null;
	if (
		!exact(tools, ["calls", "errors"]) ||
		(tools.calls !== null && !isCount(tools.calls)) ||
		(tools.errors !== null && !isCount(tools.errors)) ||
		(tools.calls !== null && tools.errors !== null && tools.errors > tools.calls)
	)
		return null;
	if (
		!exact(flagged, ["interruption", "discontinuity", "anomaly", "unrecognized"]) ||
		!["interruption", "discontinuity", "anomaly", "unrecognized"].every(
			(key) => isCount(flagged[key]) && (flagged[key] as number) <= total,
		)
	)
		return null;
	if (!exact(page, ["offset", "limit", "hasMore", "nextCursor"])) return null;
	const { offset, limit, hasMore, nextCursor } = page;
	if (
		!isCount(offset) ||
		limit !== ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0 ||
		offset % ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0 !== 0 ||
		(offset > 0 && offset >= total) ||
		entries.length !== Math.min(ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0, total - offset) ||
		hasMore !== offset + entries.length < total ||
		(hasMore
			? parseEndoCockpitDevelopActivityCursorV0(nextCursor)?.offset !== offset + entries.length
			: nextCursor !== null)
	)
		return null;
	let previousSequence = 0;
	for (const entry of entries as EndoCockpitTimelineEntryV0[]) {
		if (
			!isEndoCockpitTimelineEntryV0(entry) ||
			entry.storageSequence <= previousSequence ||
			entry.storageSequence < session.firstStorageSequence ||
			entry.storageSequence > session.lastStorageSequence ||
			entry.sessionId !== session.session
		)
			return null;
		previousSequence = entry.storageSequence;
	}
	// The first event of the session opens its first page; the last closes its last.
	if (offset === 0 && (entries as EndoCockpitTimelineEntryV0[])[0]?.storageSequence !== session.firstStorageSequence)
		return null;
	if (!hasMore && (entries as EndoCockpitTimelineEntryV0[]).at(-1)?.storageSequence !== session.lastStorageSequence)
		return null;
	return value as unknown as EndoCockpitDevelopSessionV0;
}
