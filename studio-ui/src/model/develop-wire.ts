// Browser wire gate for DEVELOP. The server remains authoritative for evidence, privacy admission and qualification; nothing of the
// protocol's implementation runs here (types only). These checks cover every field the DEVELOP renderers read, then build the view
// models of every event whole, as Observe does, so a record the page cannot show is a failed read now and not a broken panel later.
import type {
	EndoCockpitDevelopSessionRowV0,
	EndoCockpitDevelopSessionsV0,
	EndoCockpitDevelopSessionV0,
} from "../../../protocol/cockpit-develop.ts";
import { type Check, count, eitherNull, finite, list, obj, one, shape, string, token } from "./compare-wire.ts";
import { eventDetail } from "./detail.ts";
import { eventLogSourceView } from "./views.ts";

export const SESSIONS_PAGE = 50;
export const ACTIVITY_PAGE = 100;
const CATEGORIES = [
	"lifecycle",
	"agent",
	"message",
	"tool",
	"session",
	"queue",
	"compaction",
	"retry",
	"harness",
	"control",
	"other",
] as const;
const reasons = ["several-attachments", "import-incomplete", "not-qualified"];

export const developSelector = (v: unknown): v is string => typeof v === "string" && /^d1-[0-9a-f]{64}$/.test(v);
const cursorOf =
	(prefix: string, size: number) =>
	(v: unknown): v is string => {
		if (typeof v !== "string") return false;
		const match = new RegExp(`^${prefix}-([1-9][0-9]{0,5})-[0-9a-f]{64}$`).exec(v);
		return match !== null && Number(match[1]) % size === 0;
	};
export const sessionsCursor = cursorOf("s1", SESSIONS_PAGE);
export const activityCursor = cursorOf("a1", ACTIVITY_PAGE);
const cursorOffset = (v: unknown): number => Number(String(v).split("-")[1]);

const publicSession = (v: unknown): v is string =>
	typeof v === "string" && v.length <= 269 && /^endo\.session\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(v);
const isoClock = (v: unknown): boolean =>
	typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v);
const text = (v: unknown): boolean => typeof v === "string" && v.length >= 1 && v.length <= 512;

/** What the renderers read of an event-log source; the view builder is the last check that it can be shown. */
function sourceOk(v: unknown): boolean {
	if (!obj(v) || v.domain !== "event-log" || !obj(v.condition) || typeof v.condition.state !== "string") return false;
	if (v.watermark !== null && !obj(v.watermark)) return false;
	try {
		eventLogSourceView(v as never);
		return true;
	} catch {
		return false;
	}
}

const recorded: Check = (v) =>
	shape(v, {
		state: one("not-observed", "idle", "running", "interrupted", "detached"),
		lastRunOutcome: eitherNull(one("completed", "failed", "aborted", "unclassified", "interrupted")),
		runs: count,
		turns: count,
	});

function rowOk(row: unknown): row is EndoCockpitDevelopSessionRowV0 {
	if (
		!shape(row, {
			source: one("pi", "dsh"),
			label: string,
			session: publicSession,
			qualification: one("inspectable", "ambiguous", "insufficient"),
			reason: eitherNull(one(...reasons)),
			selector: eitherNull(developSelector),
			events: (n) => count(n) && n >= 1,
			firstStorageSequence: (n) => count(n) && n >= 1,
			lastStorageSequence: (n) => count(n) && n >= 1,
			lastRecordedAt: isoClock,
			recorded: eitherNull(recorded),
		})
	)
		return false;
	const r = row as unknown as EndoCockpitDevelopSessionRowV0;
	if (
		r.label !== (r.source === "pi" ? "Pi recording" : "DSH recording") ||
		r.lastStorageSequence < r.firstStorageSequence ||
		r.events > r.lastStorageSequence - r.firstStorageSequence + 1
	)
		return false;
	const inspectable = r.qualification === "inspectable";
	return (
		(r.selector !== null) === inspectable &&
		(r.recorded !== null) === inspectable &&
		(r.reason === null) === inspectable &&
		(r.qualification !== "ambiguous" || (r.source === "pi" && r.reason === "several-attachments")) &&
		(r.qualification !== "insufficient" ||
			r.reason === "not-qualified" ||
			(r.source === "dsh" && r.reason === "import-incomplete"))
	);
}

function pageOk(p: unknown, rows: number, size: number, cursor: (v: unknown) => boolean): boolean {
	if (
		!shape(p, {
			offset: count,
			total: (n) => count(n) && n <= 10000,
			hasMore: (b) => typeof b === "boolean",
			nextCursor: eitherNull(cursor),
		})
	)
		return false;
	const q = p as unknown as { offset: number; total: number; hasMore: boolean; nextCursor: string | null };
	return (
		q.offset % size === 0 &&
		(q.offset === 0 || q.offset < q.total) &&
		rows === Math.min(size, q.total - q.offset) &&
		q.hasMore === q.offset + rows < q.total &&
		(q.hasMore ? q.nextCursor !== null && cursorOffset(q.nextCursor) === q.offset + rows : q.nextCursor === null)
	);
}

export function readDevelopSessions(v: unknown): EndoCockpitDevelopSessionsV0 | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.cockpit-develop-sessions.v0"),
			projectionVersion: one("cockpit-develop-sessions.1"),
			consistency: one("single-event-log-observation"),
			source: sourceOk,
			generation: eitherNull(token),
			otherSessions: count,
			sessions: Array.isArray,
			page: obj,
		})
	)
		return null;
	const rows = v.sessions as unknown[];
	if (rows.length > SESSIONS_PAGE || !pageOk(v.page, rows.length, SESSIONS_PAGE, sessionsCursor)) return null;
	const watermark = (v.source as { watermark: { length?: number } | null }).watermark;
	const length = typeof watermark?.length === "number" ? watermark.length : 0;
	if ((v.generation === null) !== (length === 0)) return null;
	let previous = "";
	const selectors = new Set<string>();
	for (const row of rows) {
		if (!rowOk(row) || row.lastStorageSequence > length) return null;
		const order = `${row.source}\u0000${row.session}`;
		if (order <= previous || (row.selector !== null && selectors.has(row.selector))) return null;
		previous = order;
		if (row.selector !== null) selectors.add(row.selector);
	}
	return v as unknown as EndoCockpitDevelopSessionsV0;
}

const measured =
	(inner: Check): Check =>
	(v) =>
		shape(v, { status: one("reported"), value: inner }) || shape(v, { status: one("unavailable"), reason: text });
const tokens: Check = (v) =>
	shape(v, {
		input: count,
		output: count,
		cacheRead: count,
		cacheWrite: count,
		totalTokens: count,
		reasoning: eitherNull(finite),
		costTotal: eitherNull(finite),
	});
const run: Check = (v) =>
	shape(v, {
		run: (n) => count(n) && n >= 1,
		outcome: one("completed", "failed", "aborted", "interrupted", "unclassified", "open"),
		turns: count,
		stopRequested: (b) => typeof b === "boolean",
		tokens: measured(tokens),
		wallMs: measured((n) => finite(n) && (n as number) >= 0),
	});
const lifecycle: Check = (v) =>
	shape(v, {
		attachments: (a) => shape(a, { count, resumes: count }),
		counts: (c) =>
			shape(c, {
				runs: count,
				turns: count,
				completed: count,
				failed: count,
				aborted: count,
				unclassified: count,
				interrupted: count,
				compactions: count,
				stopsRequested: count,
				stopsAccepted: count,
				stopsRefused: count,
			}),
		open: eitherNull((o) =>
			shape(o, {
				turns: count,
				turnOpen: (b) => typeof b === "boolean",
				stopRequested: (b) => typeof b === "boolean",
				stopAccepted: (b) => typeof b === "boolean",
			}),
		),
		anomalies: count,
		unrecognized: count,
		unavailable: (u) =>
			Array.isArray(u) && u.length <= 32 && u.every((x) => shape(x, { field: string, reason: text })),
	});

/** The entry fields every DEVELOP renderer reads; `eventDetail` below is the check that the rest can be shown. */
function entryOk(entry: unknown): boolean {
	return (
		obj(entry) &&
		Number.isSafeInteger(entry.storageSequence) &&
		typeof entry.eventId === "string" &&
		typeof entry.kind === "string" &&
		(CATEGORIES as readonly string[]).includes(entry.category as string) &&
		typeof entry.producer === "string" &&
		typeof entry.recordedAt === "string" &&
		(entry.sessionId === null || typeof entry.sessionId === "string") &&
		Array.isArray(entry.flags) &&
		entry.flags.every((flag) => typeof flag === "string") &&
		Array.isArray(entry.derivedFrom) &&
		entry.derivedFrom.every((id) => typeof id === "string") &&
		obj(entry.fields)
	);
}

export function readDevelopSession(v: unknown): EndoCockpitDevelopSessionV0 | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.cockpit-develop-session.v0"),
			projectionVersion: one("cockpit-develop-session.1"),
			consistency: one("single-event-log-observation"),
			source: sourceOk,
			generation: token,
			session: rowOk,
			attachment: eitherNull(string),
			lifecycle,
			runs: (r) =>
				shape(r, {
					status: one("reported"),
					total: count,
					entries: (e) => Array.isArray(e) && e.length <= 100 && list(run)(e),
				}) || shape(r, { status: one("unavailable"), reason: text }),
			activity: obj,
		})
	)
		return null;
	const row = v.session as unknown as EndoCockpitDevelopSessionRowV0;
	if (row.qualification !== "inspectable" || row.recorded === null) return null;
	const life = v.lifecycle as unknown as EndoCockpitDevelopSessionV0["lifecycle"] & object;
	if (life.counts.runs !== row.recorded.runs || life.counts.turns !== row.recorded.turns) return null;
	const a = v.activity as Record<string, unknown>;
	if (
		!shape(a, {
			total: (n) => count(n) && n === row.events,
			byCategory: (c) => shape(c, Object.fromEntries(CATEGORIES.map((name) => [name, count]))),
			tools: (t) => shape(t, { calls: eitherNull(count), errors: eitherNull(count) }),
			flagged: (f) => shape(f, { interruption: count, discontinuity: count, anomaly: count, unrecognized: count }),
			page: obj,
			entries: Array.isArray,
		})
	)
		return null;
	const entries = a.entries as unknown[];
	const page = a.page as Record<string, unknown>;
	if (
		!shape(page, {
			offset: count,
			limit: one(ACTIVITY_PAGE),
			hasMore: (b) => typeof b === "boolean",
			nextCursor: eitherNull(activityCursor),
		})
	)
		return null;
	const offset = page.offset as number;
	const total = a.total as number;
	if (
		offset % ACTIVITY_PAGE !== 0 ||
		(offset > 0 && offset >= total) ||
		entries.length !== Math.min(ACTIVITY_PAGE, total - offset) ||
		page.hasMore !== offset + entries.length < total ||
		(page.hasMore
			? page.nextCursor === null || cursorOffset(page.nextCursor) !== offset + entries.length
			: page.nextCursor !== null)
	)
		return null;
	let previous = 0;
	for (const entry of entries) {
		if (!entryOk(entry)) return null;
		const e = entry as { storageSequence: number; sessionId: string | null };
		if (
			e.storageSequence <= previous ||
			e.storageSequence < row.firstStorageSequence ||
			e.storageSequence > row.lastStorageSequence
		)
			return null;
		if (e.sessionId !== row.session) return null;
		previous = e.storageSequence;
		try {
			eventDetail(entry as never);
		} catch {
			return null;
		}
	}
	if (offset === 0 && (entries[0] as { storageSequence: number }).storageSequence !== row.firstStorageSequence)
		return null;
	if (!page.hasMore && (entries.at(-1) as { storageSequence: number }).storageSequence !== row.lastStorageSequence)
		return null;
	return v as unknown as EndoCockpitDevelopSessionV0;
}

export type DevelopReply =
	| { kind: "sessions"; record: EndoCockpitDevelopSessionsV0 }
	| { kind: "session"; record: EndoCockpitDevelopSessionV0 }
	| { kind: "failure"; message: string; invalid: boolean; retrySeconds: number | null };

/** A failure becomes fixed text: a body never reaches the page. 404 and 409 invalidate what was held; neither proves a change. */
export function developFailure(
	status: number,
	body: unknown,
	retry: string | null,
): Extract<DevelopReply, { kind: "failure" }> {
	const code = obj(body) && typeof body.error === "string" ? body.error : "";
	const invalid = status === 404 || status === 409;
	return {
		kind: "failure",
		invalid,
		retrySeconds:
			status === 429 && retry !== null && /^(0|[1-9][0-9]{0,3})$/.test(retry) ? Math.min(3600, Number(retry)) : null,
		message: invalid
			? "This selection or continuation is no longer valid, or is unknown. That alone does not show the store changed. Rediscover sessions."
			: status === 429
				? "The server is pacing reads. Wait for the requested pause, then retry explicitly."
				: code === "too-many-candidates"
					? "The store holds more than 10,000 recorded sessions, which this view does not list."
					: "The read failed. Nothing from it was accepted. Retry explicitly.",
	};
}
