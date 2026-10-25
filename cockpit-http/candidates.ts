// Pure candidate derivation and token resolution, plus the one-read HTTP bridge. No cache or original-source access.
import {
	cockpitAliasesV0,
	cockpitTokenV0,
	compareCodeUnitsV0,
	eventLogPrefixDigestV0,
	requireAdmittedKeyV0,
} from "../cockpit/projections/common.ts";
import { projectEndoCockpitTrajectoryComparisonV0 } from "../cockpit/projections/trajectory-comparison.ts";
import {
	ENDO_COCKPIT_CANDIDATE_MAX_TOTAL_V0,
	ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0,
	ENDO_COCKPIT_COMPARE_CANDIDATES_PROJECTION_V0,
	ENDO_COCKPIT_COMPARE_CANDIDATES_SCHEMA_V0,
	type EndoCockpitCompareCandidatesV0,
	type EndoCockpitCompareCandidateV0,
	isEndoCockpitCandidateSelectorV0,
	parseEndoCockpitCandidateCursorV0,
	validateEndoCockpitCompareCandidatesV0,
} from "../protocol/cockpit-candidates.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import {
	EndoCockpitComparisonRefusalV0,
	type EndoCockpitComparisonSelectionV0,
	endoCockpitRecordingSourceV0,
	projectEndoCockpitRecordingV0,
	withEndoCockpitComparisonEventsV0,
} from "./comparison.ts";

interface Recording {
	selection: EndoCockpitComparisonSelectionV0;
	publicSession: string;
	selector: string;
	events: EndoEventV0[];
}

/** All tokens have separate purposes; the selection additionally binds source, original coordinate and full log generation. */
const purpose = {
	generation: "endo.cockpit.compare-generation.v0",
	selection: "endo.cockpit.compare-selection.v0",
	cursor: "endo.cockpit.compare-cursor.v0",
};

function inventory(events: readonly EndoEventV0[], key: EndoDigestKeyV0) {
	requireAdmittedKeyV0(key);
	const generation = cockpitTokenV0(key, purpose.generation, { prefix: eventLogPrefixDigestV0(key, events) });
	const selections = new Map<string, EndoCockpitComparisonSelectionV0>();
	const groups = new Map<string, EndoEventV0[]>();
	for (const event of events) {
		const source = endoCockpitRecordingSourceV0(event);
		if (source === null) continue;
		const session = event.coordinates.sessionId!;
		selections.set(`${source}\u0000${session}`, { source, session });
		if (selections.size > ENDO_COCKPIT_CANDIDATE_MAX_TOTAL_V0)
			throw new EndoCockpitComparisonRefusalV0("too-many-candidates");
		if (!groups.has(session)) groups.set(session, []);
	}
	for (const event of events) groups.get(event.coordinates.sessionId ?? "")?.push(event);
	const aliases = cockpitAliasesV0(key);
	const rows: Recording[] = [...selections.values()].map((selection) => ({
		selection,
		publicSession: aliases.id(selection.session),
		selector: `c1-${cockpitTokenV0(key, purpose.selection, { generation, source: selection.source, session: selection.session })}`,
		events: groups.get(selection.session)!,
	}));
	rows.sort(
		(a, b) =>
			compareCodeUnitsV0(a.selection.source, b.selection.source) ||
			compareCodeUnitsV0(a.publicSession, b.publicSession),
	);
	const tokens = new Set<string>();
	let previous = "";
	for (const row of rows) {
		const order = `${row.selection.source}\u0000${row.publicSession}`;
		// Detect any alias/token collision instead of conflating two source recordings, even for an ineligible candidate.
		if (order === previous || tokens.has(row.selector))
			throw new EndoCockpitComparisonRefusalV0("ambiguous-selection");
		previous = order;
		tokens.add(row.selector);
	}
	return { generation, rows };
}

function eligibility(row: Recording): EndoCockpitCompareCandidateV0["eligibility"] {
	try {
		projectEndoCockpitRecordingV0(row.events, row.selection);
		return "selectable";
	} catch (error) {
		if (!(error instanceof EndoCockpitComparisonRefusalV0)) throw error;
		if (error.refusal === "ambiguous-selection") return "ambiguous";
		if (error.refusal === "source-degraded" || error.refusal === "not-found") return "insufficient";
		throw error;
	}
}

function cursorAt(key: EndoDigestKeyV0, generation: string, offset: number): string {
	return `p1-${offset}-${cockpitTokenV0(key, purpose.cursor, { generation, offset })}`;
}

/** Pure and deterministic, given events from one validated log observation. A page bounds output, not store-validation cost. */
export function projectEndoCockpitCompareCandidatesV0(
	events: readonly EndoEventV0[],
	key: EndoDigestKeyV0,
	cursor?: string,
): EndoCockpitCompareCandidatesV0 {
	const parsed = cursor === undefined ? null : parseEndoCockpitCandidateCursorV0(cursor);
	if (cursor !== undefined && parsed === null) throw new TypeError("invalid candidate cursor");
	const { generation, rows } = inventory(events, key);
	const offset = parsed?.offset ?? 0;
	if (cursor !== undefined && (offset >= rows.length || cursor !== cursorAt(key, generation, offset)))
		throw new EndoCockpitComparisonRefusalV0("continuation-invalid");
	const candidates = rows
		.slice(offset, offset + ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0)
		.map((row): EndoCockpitCompareCandidateV0 => {
			const state = eligibility(row);
			return {
				source: row.selection.source,
				session: row.publicSession,
				label: row.selection.source === "pi" ? "Pi recording" : "DSH recording",
				eligibility: state,
				selector: state === "selectable" ? row.selector : null,
			};
		});
	const next = offset + candidates.length;
	const record: EndoCockpitCompareCandidatesV0 = {
		schemaVersion: ENDO_COCKPIT_COMPARE_CANDIDATES_SCHEMA_V0,
		projectionVersion: ENDO_COCKPIT_COMPARE_CANDIDATES_PROJECTION_V0,
		generation,
		candidates,
		page: {
			offset,
			total: rows.length,
			hasMore: next < rows.length,
			nextCursor: next < rows.length ? cursorAt(key, generation, next) : null,
		},
	};
	if (validateEndoCockpitCompareCandidatesV0(record) === null) throw new Error("candidate presentation contract");
	return record;
}

export function readEndoCockpitCompareCandidatesV0(root: string, key: EndoDigestKeyV0, cursor?: string) {
	if (cursor !== undefined && parseEndoCockpitCandidateCursorV0(cursor) === null)
		throw new TypeError("invalid candidate cursor");
	return withEndoCockpitComparisonEventsV0(root, key, (events) =>
		projectEndoCockpitCompareCandidatesV0(events, key, cursor),
	);
}

/** No literal-coordinate or alias fallback. Resolve uniquely against this read; then reapply the authoritative admission. */
export function readEndoCockpitSelectedComparisonV0(
	root: string,
	key: EndoDigestKeyV0,
	a: { source: "pi" | "dsh"; selector: string },
	b: { source: "pi" | "dsh"; selector: string },
) {
	for (const selection of [a, b])
		if (
			(selection.source !== "pi" && selection.source !== "dsh") ||
			!isEndoCockpitCandidateSelectorV0(selection.selector)
		)
			throw new TypeError("invalid candidate selection");
	return withEndoCockpitComparisonEventsV0(root, key, (events) => {
		const { rows } = inventory(events, key);
		const resolve = (selection: typeof a) => {
			const matches = rows.filter(
				(row) => row.selection.source === selection.source && row.selector === selection.selector,
			);
			if (matches.length !== 1) throw new EndoCockpitComparisonRefusalV0("not-found");
			return projectEndoCockpitRecordingV0(matches[0]!.events, matches[0]!.selection);
		};
		return projectEndoCockpitTrajectoryComparisonV0(resolve(a), resolve(b), key);
	});
}
