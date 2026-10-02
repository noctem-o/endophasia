// The event/evidence substrate v0 schemas: the persisted append-oriented event record, its forward page, the
// replay report with the README's three-way layer classification, the stream summary, the reported resource
// usage, and the result bundle. The storage service is in runtime/contracts/event-store.ts; the replay and
// result-bundle service in runtime/contracts/event-replay.ts.

import type { EndoEventCoordinatesV0, EndoEventSourceV0, EndoEventV0 } from "./event.ts";
import { ENDO_EVENT_SOURCES_V0, validateEndoEventV0 } from "./event.ts";
import { isEndoIdentifierV0 } from "./identity.ts";

/**
 * What a replay verified about one layer: reproduced exactly, reconstructed, or could not be reproduced (README
 * "Replay"). A classification is a statement about what the replay could check, never about the original's
 * quality.
 */
export type EndoReplayLayerV0 = "exact" | "reconstructed" | "unreproducible";

/** The closed three-way layer classification, machine-checkable. */
export const ENDO_REPLAY_LAYERS_V0 = [
	"exact",
	"reconstructed",
	"unreproducible",
] as const satisfies readonly EndoReplayLayerV0[];

/**
 * The summary a stream reduces to under the built-in summary reducer. Derived state, not a claim: it counts
 * what the stream contains, per source class.
 */
export interface EndoEventStreamSummaryV0 {
	schemaVersion: "endo.stream-summary.v0";
	/** The number of events in the stream. */
	count: number;
	/** The largest event sequence in the stream; 0 for an empty stream. */
	maxSequence: number;
	/** The event count per source class; 0 for a class the stream carries none of. */
	sources: Record<EndoEventSourceV0, number>;
}

/**
 * The resources a recorded work consumed, as reported. Reported values, never recomputed from components; an
 * absent field is an honest absence, not a zero.
 */
export interface EndoResourceUsageV0 {
	/** Token counts, as reported. */
	tokens?: { input: number; output: number; total: number };
	/** Cost components, as reported. */
	cost?: { input: number; output: number; total: number };
	/** The wall-clock duration in milliseconds, as reported. */
	durationMs?: number;
}

/**
 * A persisted, append-oriented event stream. The record is the persisted form of one ingestion stream: the
 * events in storage order, the digest over their canonical form, and what the runtime reported. A record is
 * evidence, not authority: it says what was ingested, never that anything succeeded.
 */
export interface EndoEventRecordV0 {
	schemaVersion: "endo.record.v0";
	/** The record's identity, in the evidence namespace. */
	id: string;
	/** The stream the record captures: coordinates, not an outcome. */
	coordinates?: EndoEventCoordinatesV0;
	/** The ingested events, in storage (append) order. */
	events: EndoEventV0[];
	/** The stream summary at record time; the comparison input for replay's derived layer. */
	summary?: EndoEventStreamSummaryV0;
	/**
	 * The SHA-256 over the events' canonical form: 64 lowercase hex. The validator checks the grammar; replay
	 * checks the value.
	 */
	digest: string;
	/** The resources the recorded work consumed, as reported. */
	resources?: EndoResourceUsageV0;
}

/** A forward page query over a store's storage-sequence cursor. */
export interface EndoEventRecordPageQueryV0 {
	/** Return events whose storage sequence is strictly greater than this value. Default 0. */
	afterSequence?: number;
	/** Maximum events in this page. Default 1000, maximum 10000. */
	limit?: number;
}

/**
 * A forward page of stored events after a storage-sequence cursor. Not an atomic snapshot of the store: later
 * appends are reached by calling again with `nextAfterSequence`.
 */
export interface EndoEventRecordPageV0 {
	schemaVersion: "endo.record-page.v0";
	order: "ascending";
	events: EndoEventV0[];
	/** The last returned event's storage sequence, or the input afterSequence when no events were returned. */
	nextAfterSequence: number;
}

/**
 * What a replay verified, layer by layer. A layer the record or the replay's inputs cannot support is
 * unreproducible, never omitted: a report that left a layer out would look like a layer that matched.
 */
export interface EndoReplayReportV0 {
	schemaVersion: "endo.replay-report.v0";
	/** The record the report is about. */
	recordId: string;
	/** The events layer: re-validation and the digest. */
	events: EndoReplayLayerV0;
	/** The derived layer: the recorded summary, recomputed. Absent at record time is unreproducible. */
	derived: EndoReplayLayerV0;
	/**
	 * The SHA-256 the replay computed over the record's events; 64 lowercase hex. Absent when the replay could
	 * not canonicalize the events at all.
	 */
	computedDigest?: string;
}

/**
 * A result bundle: the record, an optional replay report, and the bundle's own digest over the two. The bundle
 * is the artifact a consumer persists or compares across processes; its digest makes the bundle checkable after
 * transport.
 */
export interface EndoResultBundleV0 {
	schemaVersion: "endo.result-bundle.v0";
	/** The bundle's identity, in the evidence namespace. */
	id: string;
	record: EndoEventRecordV0;
	/** The replay of the bundle's record; absent when the bundle was built before a replay. */
	replay?: EndoReplayReportV0;
	/** The SHA-256 over the bundle's record and replay in canonical form: 64 lowercase hex. */
	digest: string;
}

const SHA256_HEX_V0 = /^[0-9a-f]{64}$/;

function isSha256HexV0(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_V0.test(value);
}

function isNonNegativeIntegerV0(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isReportedTotalV0(value: unknown): value is { input: number; output: number; total: number } {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (key !== "input" && key !== "output" && key !== "total") return false;
	return isNonNegativeIntegerV0(v.input) && isNonNegativeIntegerV0(v.output) && isNonNegativeIntegerV0(v.total);
}

/**
 * Validates a stream's coordinates: at most the three lifetime fields, each a well-formed Endo identifier in
 * its own namespace. Returns the validated value unchanged, or null.
 */
export function validateEndoEventCoordinatesV0(value: unknown): EndoEventCoordinatesV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (key !== "sessionId" && key !== "runId" && key !== "experimentId") return null;
	}
	if (v.sessionId !== undefined && (typeof v.sessionId !== "string" || !isEndoIdentifierV0(v.sessionId, "session")))
		return null;
	if (v.runId !== undefined && (typeof v.runId !== "string" || !isEndoIdentifierV0(v.runId, "run"))) return null;
	if (
		v.experimentId !== undefined &&
		(typeof v.experimentId !== "string" || !isEndoIdentifierV0(v.experimentId, "experiment"))
	)
		return null;
	return value as EndoEventCoordinatesV0;
}

/**
 * Validates the built-in stream summary. Rejects unknown fields, non-integer counts, and a sources map that is
 * not exactly the closed six source classes. Returns the validated value unchanged, or null.
 */
export function validateEndoEventStreamSummaryV0(value: unknown): EndoEventStreamSummaryV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (key !== "schemaVersion" && key !== "count" && key !== "maxSequence" && key !== "sources") return null;
	}
	if (v.schemaVersion !== "endo.stream-summary.v0") return null;
	if (!isNonNegativeIntegerV0(v.count)) return null;
	if (!isNonNegativeIntegerV0(v.maxSequence)) return null;
	if (typeof v.sources !== "object" || v.sources === null) return null;
	const sources = v.sources as Record<string, unknown>;
	for (const source of ENDO_EVENT_SOURCES_V0) if (!isNonNegativeIntegerV0(sources[source])) return null;
	for (const key of Object.keys(sources)) if (!(ENDO_EVENT_SOURCES_V0 as readonly string[]).includes(key)) return null;
	return value as EndoEventStreamSummaryV0;
}

/**
 * Validates reported resource usage. Every field is optional (an absent field is an honest absence, not a
 * zero); a present field must be a non-negative integer or an exact reported-total object. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoResourceUsageV0(value: unknown): EndoResourceUsageV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (key !== "tokens" && key !== "cost" && key !== "durationMs") return null;
	}
	if (v.tokens !== undefined && !isReportedTotalV0(v.tokens)) return null;
	if (v.cost !== undefined && !isReportedTotalV0(v.cost)) return null;
	if (v.durationMs !== undefined && !isNonNegativeIntegerV0(v.durationMs)) return null;
	return value as EndoResourceUsageV0;
}

/**
 * Validates a persisted event record. Rejects unknown fields, malformed record identifiers (endo.evidence.*),
 * invalid coordinates, malformed digests (64 lowercase hex), and invalid nested events, summaries, or resources.
 * The digest's value over the events is replay's check, not the validator's. Returns the validated value
 * unchanged, or null.
 */
export function validateEndoEventRecordV0(value: unknown): EndoEventRecordV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (
			key !== "schemaVersion" &&
			key !== "id" &&
			key !== "coordinates" &&
			key !== "events" &&
			key !== "summary" &&
			key !== "digest" &&
			key !== "resources"
		)
			return null;
	}
	if (v.schemaVersion !== "endo.record.v0") return null;
	if (typeof v.id !== "string" || !isEndoIdentifierV0(v.id, "evidence")) return null;
	if (v.coordinates !== undefined && validateEndoEventCoordinatesV0(v.coordinates) === null) return null;
	if (!Array.isArray(v.events) || !v.events.every((event) => validateEndoEventV0(event) !== null)) return null;
	if (v.summary !== undefined && validateEndoEventStreamSummaryV0(v.summary) === null) return null;
	if (!isSha256HexV0(v.digest)) return null;
	if (v.resources !== undefined && validateEndoResourceUsageV0(v.resources) === null) return null;
	return value as EndoEventRecordV0;
}

/**
 * Validates a forward page of stored events. Rejects unknown fields, anything but "ascending", and invalid
 * nested events or cursors. Returns the validated value unchanged, or null.
 */
export function validateEndoEventRecordPageV0(value: unknown): EndoEventRecordPageV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (key !== "schemaVersion" && key !== "order" && key !== "events" && key !== "nextAfterSequence") return null;
	}
	if (v.schemaVersion !== "endo.record-page.v0") return null;
	if (v.order !== "ascending") return null;
	if (!Array.isArray(v.events) || !v.events.every((event) => validateEndoEventV0(event) !== null)) return null;
	if (!isNonNegativeIntegerV0(v.nextAfterSequence)) return null;
	return value as EndoEventRecordPageV0;
}

/**
 * Validates a replay report. Rejects unknown fields, malformed record identifiers (endo.evidence.*), layer
 * values outside the closed three-way, and malformed digests. Returns the validated value unchanged, or null.
 */
export function validateEndoReplayReportV0(value: unknown): EndoReplayReportV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (
			key !== "schemaVersion" &&
			key !== "recordId" &&
			key !== "events" &&
			key !== "derived" &&
			key !== "computedDigest"
		)
			return null;
	}
	if (v.schemaVersion !== "endo.replay-report.v0") return null;
	if (typeof v.recordId !== "string" || !isEndoIdentifierV0(v.recordId, "evidence")) return null;
	if (typeof v.events !== "string" || !(ENDO_REPLAY_LAYERS_V0 as readonly string[]).includes(v.events)) return null;
	if (typeof v.derived !== "string" || !(ENDO_REPLAY_LAYERS_V0 as readonly string[]).includes(v.derived)) return null;
	if (v.computedDigest !== undefined && !isSha256HexV0(v.computedDigest)) return null;
	return value as EndoReplayReportV0;
}

/**
 * Validates a result bundle. Rejects unknown fields, malformed bundle identifiers (endo.evidence.*), a replay
 * report that is not about the bundle's record, and invalid nested records, replay reports, or digests. The
 * bundle digest's value over its contents is the builder's check, not the validator's. Returns the validated
 * value unchanged, or null.
 */
export function validateEndoResultBundleV0(value: unknown): EndoResultBundleV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) {
		if (key !== "schemaVersion" && key !== "id" && key !== "record" && key !== "replay" && key !== "digest")
			return null;
	}
	if (v.schemaVersion !== "endo.result-bundle.v0") return null;
	if (typeof v.id !== "string" || !isEndoIdentifierV0(v.id, "evidence")) return null;
	if (validateEndoEventRecordV0(v.record) === null) return null;
	if (v.replay !== undefined && validateEndoReplayReportV0(v.replay) === null) return null;
	if (v.replay !== undefined && (v.replay as EndoReplayReportV0).recordId !== (v.record as EndoEventRecordV0).id)
		return null;
	if (!isSha256HexV0(v.digest)) return null;
	return value as EndoResultBundleV0;
}
