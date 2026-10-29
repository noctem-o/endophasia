// DEVELOP: the recorded-session inventory and one session's activity, as pure projections of ONE verified observation of the
// event log (cockpit/reader.ts readEndoCockpitObservationV0). Source-specific assembly stays outside cockpit/ with the Compare
// discovery it reuses: only the existing pure adapter projectors and the lifecycle reducer are reached here. No adapter index,
// importer, attachment, process, filesystem discovery, write, clock or key loader is used, and nothing is cached.
//
// What is and is not claimed is in protocol/cockpit-develop.ts. In short: a recorded lifecycle state, counts and positions of
// recorded events, the timeline's own presentation of each event, and per-run usage as the runtime reported it. Nothing is
// live, nothing is summed, and an unestablished fact is absent or says why.
import {
	cockpitAliasesV0,
	cockpitTokenV0,
	compareCodeUnitsV0,
	type EndoCockpitObservationV0,
	projectEndoCockpitTimelineEntryV0,
	readEndoCockpitObservationV0,
	requireAdmittedKeyV0,
} from "../cockpit/index.ts";
import {
	ENDO_COCKPIT_CATEGORIES_V0,
	ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0,
	ENDO_COCKPIT_DEVELOP_MAX_RUNS_V0,
	ENDO_COCKPIT_DEVELOP_MAX_SESSIONS_V0,
	ENDO_COCKPIT_DEVELOP_SESSION_PROJECTION_V0,
	ENDO_COCKPIT_DEVELOP_SESSION_SCHEMA_V0,
	ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0,
	ENDO_COCKPIT_DEVELOP_SESSIONS_PROJECTION_V0,
	ENDO_COCKPIT_DEVELOP_SESSIONS_SCHEMA_V0,
	type EndoCockpitCategoryV0,
	type EndoCockpitDevelopMeasuredV0,
	type EndoCockpitDevelopReasonV0,
	type EndoCockpitDevelopRunOutcomeV0,
	type EndoCockpitDevelopRunV0,
	type EndoCockpitDevelopSessionRowV0,
	type EndoCockpitDevelopSessionsV0,
	type EndoCockpitDevelopSessionV0,
	type EndoCockpitDevelopTokensV0,
	type EndoCockpitTimelineEntryV0,
	isEndoCockpitDevelopSelectorV0,
	parseEndoCockpitDevelopActivityCursorV0,
	parseEndoCockpitDevelopSessionsCursorV0,
	validateEndoCockpitDevelopSessionsV0,
	validateEndoCockpitDevelopSessionV0,
} from "../protocol/cockpit.ts";
import {
	endoCockpitGapNameAdmittedV0,
	endoCockpitPresentableTextV0,
	isEndoCockpitSourceKindAdmittedV0,
} from "../protocol/cockpit-fields.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoTrajectoryLayerV0, EndoTrajectoryV0 } from "../protocol/trajectory.ts";
import type { EndoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import {
	EndoCockpitComparisonRefusalV0,
	type EndoCockpitComparisonSelectionV0,
	endoCockpitRecordingSourceV0,
	projectEndoCockpitRecordingV0,
} from "./comparison.ts";

interface Recording {
	selection: EndoCockpitComparisonSelectionV0;
	publicSession: string;
	events: EndoEventV0[];
	/** The log position (1-based) of each event, parallel to `events`. */
	positions: number[];
}

/** Every token has its own purpose: none is a cursor, selector or generation of Compare, or of another DEVELOP token. */
const purpose = {
	generation: "endo.cockpit.develop-generation.v0",
	selection: "endo.cockpit.develop-selection.v0",
	sessionsCursor: "endo.cockpit.develop-sessions-cursor.v0",
	activityCursor: "endo.cockpit.develop-activity-cursor.v0",
};

function inventory(observation: EndoCockpitObservationV0, key: EndoDigestKeyV0) {
	requireAdmittedKeyV0(key);
	const { source, events } = observation;
	if (source.watermark !== null && source.watermark.keyId !== key.keyId)
		throw new TypeError("the digest key is not the key the observation was read under");
	const generation =
		source.watermark === null || source.watermark.length === 0
			? null
			: cockpitTokenV0(key, purpose.generation, {
					prefix: source.watermark.prefixDigest,
					length: source.watermark.length,
				});
	const recordings = new Map<string, Recording>();
	const sessions = new Set<string>();
	const aliases = cockpitAliasesV0(key);
	for (const event of events) {
		const session = event.coordinates.sessionId;
		if (session === undefined || session === null) continue;
		sessions.add(session);
		const recorded = endoCockpitRecordingSourceV0(event);
		if (recorded !== null) {
			const id = `${recorded}\u0000${session}`;
			if (!recordings.has(id)) {
				if (recordings.size >= ENDO_COCKPIT_DEVELOP_MAX_SESSIONS_V0)
					throw new EndoCockpitComparisonRefusalV0("too-many-candidates");
				recordings.set(id, {
					selection: { source: recorded, session },
					publicSession: aliases.id(session),
					events: [],
					positions: [],
				});
			}
		}
	}
	// One pass assigns each event to every recording of its session (a session id could be a Pi and a DSH recording).
	const bySession = new Map<string, Recording[]>();
	for (const recording of recordings.values()) {
		const list = bySession.get(recording.selection.session);
		if (list === undefined) bySession.set(recording.selection.session, [recording]);
		else list.push(recording);
	}
	events.forEach((event, index) => {
		const session = event.coordinates.sessionId;
		if (session === undefined || session === null) return;
		for (const recording of bySession.get(session) ?? []) {
			recording.events.push(event);
			recording.positions.push(index + 1);
		}
	});
	const rows = [...recordings.values()].sort(
		(a, b) =>
			compareCodeUnitsV0(a.selection.source, b.selection.source) ||
			compareCodeUnitsV0(a.publicSession, b.publicSession),
	);
	// An alias collision would merge two recordings: refuse the whole listing rather than conflate them.
	let previous = "";
	for (const row of rows) {
		const order = `${row.selection.source}\u0000${row.publicSession}`;
		if (order === previous) throw new EndoCockpitComparisonRefusalV0("ambiguous-selection");
		previous = order;
	}
	const selectorOf = (row: Recording): string =>
		`d1-${cockpitTokenV0(key, purpose.selection, {
			generation,
			source: row.selection.source,
			session: row.selection.session,
		})}`;
	const others = [...sessions].filter((session) => !bySession.has(session)).length;
	return { generation, rows, selectorOf, otherSessions: others };
}

interface Qualified {
	qualification: EndoCockpitDevelopSessionRowV0["qualification"];
	reason: EndoCockpitDevelopReasonV0 | null;
	trajectory: EndoTrajectoryV0 | null;
}

/** The authoritative admission Compare uses. A source that fails it for any reason degrades this one row, never the listing. */
function qualify(recording: Recording): Qualified {
	try {
		const trajectory = projectEndoCockpitRecordingV0(recording.events, recording.selection);
		return { qualification: "inspectable", reason: null, trajectory };
	} catch (error) {
		if (error instanceof EndoCockpitComparisonRefusalV0) {
			if (error.refusal === "ambiguous-selection")
				return { qualification: "ambiguous", reason: "several-attachments", trajectory: null };
			if (error.refusal === "source-degraded" && recording.selection.source === "dsh")
				return { qualification: "insufficient", reason: "import-incomplete", trajectory: null };
		}
		return { qualification: "insufficient", reason: "not-qualified", trajectory: null };
	}
}

function rowOf(recording: Recording, selector: string, qualified: Qualified): EndoCockpitDevelopSessionRowV0 {
	const last = recording.events.at(-1)!;
	const inspectable = qualified.qualification === "inspectable";
	const overview = inspectable ? reduceEndoSessionOverviewV0(recording.events) : null;
	return {
		source: recording.selection.source,
		label: recording.selection.source === "pi" ? "Pi recording" : "DSH recording",
		session: recording.publicSession,
		qualification: qualified.qualification,
		reason: qualified.reason,
		selector: inspectable ? selector : null,
		events: recording.events.length,
		firstStorageSequence: recording.positions[0]!,
		lastStorageSequence: recording.positions.at(-1)!,
		lastRecordedAt: last.at,
		recorded:
			overview === null
				? null
				: {
						state: overview.state,
						lastRunOutcome: overview.lastRun?.outcome ?? null,
						runs: overview.counts.runs,
						turns: overview.counts.turns,
					},
	};
}

function cursorAt(key: EndoDigestKeyV0, name: "sessionsCursor", generation: string, offset: number): string;
function cursorAt(
	key: EndoDigestKeyV0,
	name: "activityCursor",
	generation: string,
	offset: number,
	selector: string,
): string;
function cursorAt(
	key: EndoDigestKeyV0,
	name: "sessionsCursor" | "activityCursor",
	generation: string,
	offset: number,
	selector?: string,
): string {
	const mac = cockpitTokenV0(key, purpose[name], {
		generation,
		offset,
		...(selector === undefined ? {} : { selector }),
	});
	return `${name === "sessionsCursor" ? "s1" : "a1"}-${offset}-${mac}`;
}

/** Pure and deterministic, given one validated observation. A page bounds output, not the cost of the store's validation. */
export function projectEndoCockpitDevelopSessionsV0(
	observation: EndoCockpitObservationV0,
	key: EndoDigestKeyV0,
	cursor?: string,
): EndoCockpitDevelopSessionsV0 {
	const parsed = cursor === undefined ? null : parseEndoCockpitDevelopSessionsCursorV0(cursor);
	if (cursor !== undefined && parsed === null) throw new TypeError("invalid sessions cursor");
	const { generation, rows, selectorOf, otherSessions } = inventory(observation, key);
	const offset = parsed?.offset ?? 0;
	if (
		cursor !== undefined &&
		(generation === null || offset >= rows.length || cursor !== cursorAt(key, "sessionsCursor", generation, offset))
	)
		throw new EndoCockpitComparisonRefusalV0("continuation-invalid");
	const page = rows.slice(offset, offset + ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0);
	const sessions = page.map((recording) => rowOf(recording, selectorOf(recording), qualify(recording)));
	const next = offset + sessions.length;
	const record: EndoCockpitDevelopSessionsV0 = {
		schemaVersion: ENDO_COCKPIT_DEVELOP_SESSIONS_SCHEMA_V0,
		projectionVersion: ENDO_COCKPIT_DEVELOP_SESSIONS_PROJECTION_V0,
		consistency: "single-event-log-observation",
		source: observation.source,
		generation,
		otherSessions,
		sessions,
		page: {
			offset,
			total: rows.length,
			hasMore: next < rows.length,
			nextCursor:
				next < rows.length && generation !== null ? cursorAt(key, "sessionsCursor", generation, next) : null,
		},
	};
	if (validateEndoCockpitDevelopSessionsV0(record) === null) throw new Error("develop sessions presentation contract");
	return record;
}

const layer = <T>(value: EndoTrajectoryLayerV0<T>): T[] | { reason: string } =>
	value.status === "reported" ? value.entries : { reason: endoCockpitPresentableTextV0(value.reason) };

function measured<T>(
	value: { status: "reported"; value: T } | { status: "UNAVAILABLE"; reason: string },
): EndoCockpitDevelopMeasuredV0<T> {
	return value.status === "reported"
		? { status: "reported", value: value.value }
		: { status: "unavailable", reason: endoCockpitPresentableTextV0(value.reason) };
}

function runsOf(trajectory: EndoTrajectoryV0): EndoCockpitDevelopSessionV0["runs"] {
	const outcomes = layer(trajectory.layers.outcome);
	if (!Array.isArray(outcomes)) return { status: "unavailable", reason: outcomes.reason };
	const usage = layer(trajectory.layers.usage);
	const timing = layer(trajectory.layers.timing);
	const noUsage = (usage as { reason?: string }).reason ?? "";
	const entries = [...outcomes]
		.sort((a, b) => a.run - b.run)
		.slice(0, ENDO_COCKPIT_DEVELOP_MAX_RUNS_V0)
		.map((outcome): EndoCockpitDevelopRunV0 => {
			const u = Array.isArray(usage) ? usage.find((item) => item.run === outcome.run) : undefined;
			const t = Array.isArray(timing) ? timing.find((item) => item.run === outcome.run) : undefined;
			let tokens: EndoCockpitDevelopMeasuredV0<EndoCockpitDevelopTokensV0>;
			if (u === undefined)
				tokens = {
					status: "unavailable",
					reason: Array.isArray(usage) ? "The recording carries no usage entry for this run." : noUsage,
				};
			else {
				const reported = measured(u.tokens);
				tokens =
					reported.status === "unavailable"
						? reported
						: {
								status: "reported",
								value: {
									input: reported.value.input,
									output: reported.value.output,
									cacheRead: reported.value.cacheRead,
									cacheWrite: reported.value.cacheWrite,
									totalTokens: reported.value.totalTokens,
									reasoning: reported.value.reasoning ?? null,
									costTotal: reported.value.costTotal ?? null,
								},
							};
			}
			return {
				run: outcome.run,
				outcome: outcome.outcome as EndoCockpitDevelopRunOutcomeV0,
				turns: outcome.turns,
				stopRequested: outcome.stopRequested,
				tokens,
				wallMs:
					t === undefined
						? {
								status: "unavailable",
								reason: Array.isArray(timing)
									? "The recording carries no timing entry for this run."
									: (timing as { reason: string }).reason,
							}
						: measured(t.wallMs),
			};
		});
	return { status: "reported", total: outcomes.length, entries };
}

/** Pure and deterministic, given one validated observation. Refuses (with a closed code) a selector or cursor not of this read. */
export function projectEndoCockpitDevelopSessionV0(
	observation: EndoCockpitObservationV0,
	key: EndoDigestKeyV0,
	selector: string,
	cursor?: string,
): EndoCockpitDevelopSessionV0 {
	if (!isEndoCockpitDevelopSelectorV0(selector)) throw new TypeError("invalid session selector");
	const parsed = cursor === undefined ? null : parseEndoCockpitDevelopActivityCursorV0(cursor);
	if (cursor !== undefined && parsed === null) throw new TypeError("invalid activity cursor");
	const { generation, rows, selectorOf } = inventory(observation, key);
	const matches = generation === null ? [] : rows.filter((row) => selectorOf(row) === selector);
	if (generation === null || matches.length !== 1) throw new EndoCockpitComparisonRefusalV0("not-found");
	const recording = matches[0]!;
	const qualified = qualify(recording);
	if (qualified.trajectory === null) throw new EndoCockpitComparisonRefusalV0("not-found");
	const total = recording.events.length;
	const offset = parsed?.offset ?? 0;
	if (
		cursor !== undefined &&
		(offset >= total || cursor !== cursorAt(key, "activityCursor", generation, offset, selector))
	)
		throw new EndoCockpitComparisonRefusalV0("continuation-invalid");
	const overview = reduceEndoSessionOverviewV0(recording.events);
	const entries = recording.events.map((event, index) =>
		projectEndoCockpitTimelineEntryV0({ storageSequence: recording.positions[index]!, event }, key),
	);
	const byCategory = Object.fromEntries(ENDO_COCKPIT_CATEGORIES_V0.map((name) => [name, 0])) as Record<
		EndoCockpitCategoryV0,
		number
	>;
	const flagged = { interruption: 0, discontinuity: 0, anomaly: 0, unrecognized: 0 };
	for (const entry of entries) {
		byCategory[entry.category] += 1;
		for (const flag of entry.flags) flagged[flag] += 1;
	}
	const calls = layer(qualified.trajectory.layers.toolCalls);
	const results = layer(qualified.trajectory.layers.toolResults);
	const page: EndoCockpitTimelineEntryV0[] = entries.slice(
		offset,
		offset + ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0,
	);
	const next = offset + page.length;
	const attachment =
		recording.selection.source === "pi" && isEndoCockpitSourceKindAdmittedV0(qualified.trajectory.source.attachment)
			? qualified.trajectory.source.attachment
			: null;
	const selectorRow = rowOf(recording, selector, qualified);
	const record: EndoCockpitDevelopSessionV0 = {
		schemaVersion: ENDO_COCKPIT_DEVELOP_SESSION_SCHEMA_V0,
		projectionVersion: ENDO_COCKPIT_DEVELOP_SESSION_PROJECTION_V0,
		consistency: "single-event-log-observation",
		source: observation.source,
		generation,
		session: selectorRow,
		attachment,
		lifecycle: {
			attachments: { count: overview.attachments.count, resumes: overview.attachments.resumes },
			counts: { ...overview.counts },
			open:
				overview.run === null
					? null
					: {
							turns: overview.run.turns,
							turnOpen: overview.run.turnOpen,
							stopRequested: overview.run.stop.requested,
							stopAccepted: overview.run.stop.accepted,
						},
			anomalies: overview.anomalies.length,
			unrecognized: overview.unrecognized.length,
			// A field name the boundary does not admit (a path or credential shape) is left out; it is never shown or aliased.
			unavailable: overview.unavailable
				.filter((item) => endoCockpitGapNameAdmittedV0(item.field))
				.slice(0, 32)
				.map((item) => ({
					field: item.field,
					reason: endoCockpitPresentableTextV0(item.reason),
				})),
		},
		runs: runsOf(qualified.trajectory),
		activity: {
			total,
			byCategory,
			tools: {
				calls: Array.isArray(calls) ? calls.length : null,
				errors: Array.isArray(results)
					? results.filter((item) => item.status.status === "reported" && item.status.value === "error").length
					: null,
			},
			flagged,
			page: {
				offset,
				limit: ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0,
				hasMore: next < total,
				nextCursor: next < total ? cursorAt(key, "activityCursor", generation, next, selector) : null,
			},
			entries: page,
		},
	};
	if (validateEndoCockpitDevelopSessionV0(record) === null) throw new Error("develop session presentation contract");
	return record;
}

/** One verified read, closed before projection, with no source error or cause exposed even to host diagnostics. */
function withObservation<T>(root: string, key: EndoDigestKeyV0, use: (observation: EndoCockpitObservationV0) => T): T {
	try {
		return use(readEndoCockpitObservationV0(root, key));
	} catch (error) {
		if (error instanceof EndoCockpitComparisonRefusalV0) throw error;
		if (
			error instanceof TypeError &&
			/^invalid (session selector|activity cursor|sessions cursor)$/.test(error.message)
		)
			throw error;
		throw new Error("develop projection failed");
	}
}

export const readEndoCockpitDevelopSessionsV0 = (root: string, key: EndoDigestKeyV0, cursor?: string) =>
	withObservation(root, key, (observation) => projectEndoCockpitDevelopSessionsV0(observation, key, cursor));

export const readEndoCockpitDevelopSessionV0 = (
	root: string,
	key: EndoDigestKeyV0,
	selector: string,
	cursor?: string,
) =>
	withObservation(root, key, (observation) => projectEndoCockpitDevelopSessionV0(observation, key, selector, cursor));
