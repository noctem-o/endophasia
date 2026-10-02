// The replay half of the event/evidence substrate: the built-in summary reducer, the generic left-to-right
// fold, replay with the README's three-way layer classification, and the result bundle. The storage half is in
// runtime/contracts/event-store.ts; the v0 schemas are in protocol/event-record.ts; the canonical form in
// runtime/contracts/canonical-json.ts.

import { ENDO_EVENT_SOURCES_V0, type EndoEventV0, validateEndoEventV0 } from "../../protocol/event.ts";
import type {
	EndoEventStreamSummaryV0,
	EndoReplayLayerV0,
	EndoReplayReportV0,
	EndoResultBundleV0,
} from "../../protocol/event-record.ts";
import { validateEndoEventRecordV0, validateEndoReplayReportV0 } from "../../protocol/event-record.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

/**
 * The built-in summary reducer: the derived state every replay compares. It counts what the stream contains,
 * per source class; it claims nothing.
 */
export function reduceEndoEventSummaryV0(events: readonly EndoEventV0[]): EndoEventStreamSummaryV0 {
	const sources: Record<string, number> = {
		"runtime-fact": 0,
		interpretation: 0,
		hypothesis: 0,
		"evaluation-result": 0,
		"policy-conclusion": 0,
		"authority-decision": 0,
	};
	let maxSequence = 0;
	for (const event of events) {
		sources[event.source] += 1;
		if (event.sequence > maxSequence) maxSequence = event.sequence;
	}
	return { schemaVersion: "endo.stream-summary.v0", count: events.length, maxSequence, sources };
}

/**
 * Apply a consumer-supplied reducer to a stream, left to right in the given order. The substrate fixes the
 * order; it never inspects the state.
 */
export function reduceEndoEventsV0<S>(
	events: readonly EndoEventV0[],
	reducer: (state: S, event: EndoEventV0) => S,
	initial: S,
): S {
	let state = initial;
	for (const event of events) state = reducer(state, event);
	return state;
}

/** Field-for-field equality of two built-in summaries. */
function summaryEqualV0(a: EndoEventStreamSummaryV0, b: EndoEventStreamSummaryV0): boolean {
	if (a.count !== b.count || a.maxSequence !== b.maxSequence) return false;
	return ENDO_EVENT_SOURCES_V0.every((source) => a.sources[source] === b.sources[source]);
}

/**
 * Replay a persisted record: re-validate the record, re-validate every event, recompute the canonical digest,
 * and recompute the built-in summary. Each layer is classified exactly / reconstructed / unreproducible
 * (README "Replay"): the events layer is unreproducible when an event fails re-validation or the stream cannot
 * be canonicalized; the derived layer is unreproducible when the record carries no summary to compare against.
 * A layer is never omitted from the report. Throws TypeError when the record is not a valid endo.record.v0.
 */
export function replayEndoEventRecordV0(record: unknown): EndoReplayReportV0 {
	const validated = validateEndoEventRecordV0(record);
	if (validated === null) throw new TypeError("not a valid endo.record.v0 record");
	const allValid = validated.events.every((event) => validateEndoEventV0(event) !== null);
	let computedDigest: string | undefined;
	if (allValid) {
		try {
			computedDigest = sha256HexV0(canonicalEndoJsonV0(validated.events));
		} catch {
			computedDigest = undefined;
		}
	}
	const eventsLayer: EndoReplayLayerV0 =
		allValid && computedDigest !== undefined
			? computedDigest === validated.digest
				? "exact"
				: "reconstructed"
			: "unreproducible";
	const derivedLayer: EndoReplayLayerV0 =
		allValid && validated.summary !== undefined
			? summaryEqualV0(reduceEndoEventSummaryV0(validated.events), validated.summary)
				? "exact"
				: "reconstructed"
			: "unreproducible";
	const report: EndoReplayReportV0 = {
		schemaVersion: "endo.replay-report.v0",
		recordId: validated.id,
		events: eventsLayer,
		derived: derivedLayer,
	};
	if (computedDigest !== undefined) report.computedDigest = computedDigest;
	return report;
}

/**
 * Build the result bundle: the record, an optional replay report, and the bundle's own digest over the two in
 * canonical form. The bundle is the artifact a consumer persists or compares across processes. Throws TypeError
 * when the id is not an endo.evidence.* identifier, the record or report is invalid, or the report is about a
 * different record.
 */
export function buildEndoResultBundleV0(id: unknown, record: unknown, replay?: unknown): EndoResultBundleV0 {
	if (typeof id !== "string" || !isEndoIdentifierV0(id, "evidence")) {
		throw new TypeError("bundle id must be an endo.evidence.* identifier");
	}
	const validatedRecord = validateEndoEventRecordV0(record);
	if (validatedRecord === null) throw new TypeError("not a valid endo.record.v0 record");
	let validatedReplay: EndoReplayReportV0 | null;
	if (replay === undefined) {
		validatedReplay = null;
	} else {
		validatedReplay = validateEndoReplayReportV0(replay);
		if (validatedReplay === null) throw new TypeError("not a valid endo.replay-report.v0 report");
		if (validatedReplay.recordId !== validatedRecord.id) {
			throw new TypeError(`replay report ${validatedReplay.recordId} does not match record ${validatedRecord.id}`);
		}
	}
	const digest = sha256HexV0(canonicalEndoJsonV0({ record: validatedRecord, replay: validatedReplay }));
	const bundle: EndoResultBundleV0 = {
		schemaVersion: "endo.result-bundle.v0",
		id,
		record: validatedRecord,
		digest,
	};
	if (validatedReplay !== null) bundle.replay = validatedReplay;
	return bundle;
}
