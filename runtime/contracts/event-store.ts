// The storage half of the event/evidence substrate: strict ingestion at the door, an append-only in-memory
// store, forward pages after a storage-sequence cursor, and the persisted record. The v0 schemas are in
// protocol/event-record.ts; the replay and result-bundle service in runtime/contracts/event-replay.ts; the
// canonical form the record digest uses in runtime/contracts/canonical-json.ts. One store is one stream: an
// ingested event is never mutated or removed, and the storage sequence is the append order (1-based),
// independent of the producer numbering in the events' own sequences.

import { type EndoEventCoordinatesV0, type EndoEventV0, validateEndoEventV0 } from "../../protocol/event.ts";
import {
	type EndoEventRecordPageQueryV0,
	type EndoEventRecordPageV0,
	type EndoEventRecordV0,
	type EndoResourceUsageV0,
	validateEndoEventCoordinatesV0,
	validateEndoResourceUsageV0,
} from "../../protocol/event-record.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";
import { assertPlainJsonValueV0, canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import { reduceEndoEventSummaryV0 } from "./event-replay.ts";
import { deepFreezeCopyV0 } from "./immutability.ts";

/** The default page size; the demonstrated usage ledger page default. */
export const ENDO_EVENT_RECORD_PAGE_DEFAULT_LIMIT_V0 = 1000;
/** The maximum page size; the demonstrated usage ledger page limit. */
export const ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0 = 10000;

/**
 * An append-only in-memory store for one event stream. Ingestion is strict: the value must be a valid
 * endo.event.v0 that canonicalizes, and duplicate ids are rejected, so what a stream says is exactly what the
 * store holds. The store never mutates the events it is handed; from Phase 12 it stores a deep-frozen copy,
 * so the caller's reference and the returned reference are frozen — post-ingestion mutation throws instead
 * of rewriting the stream the digests and sequences point at.
 */
export interface EndoEventStoreV0 {
	/** The number of ingested events. */
	length: number;
	/**
	 * Ingest one event and return the stored, deep-frozen copy. Throws TypeError when the value is not a valid,
	 * canonicalizable event or its id is already in the store. The caller's object is not mutated or frozen;
	 * the returned event is the stored one, frozen at every level.
	 */
	ingest(value: unknown): EndoEventV0;
	/**
	 * A forward page of the stored events after a storage-sequence cursor: ascending, bounded by the query's
	 * limit, `nextAfterSequence` ready for the next call. Throws TypeError when the query is not a plain object
	 * or carries unknown, non-integer, or out-of-range fields.
	 */
	page(query?: EndoEventRecordPageQueryV0): EndoEventRecordPageV0;
	/**
	 * Materialize the persisted record: the events in storage order, their canonical digest, the built-in
	 * summary, and the reported resources. Throws TypeError when the id is not an endo.evidence.* identifier or
	 * the coordinates or resources are invalid.
	 */
	record(id: string, coordinates?: EndoEventCoordinatesV0, resources?: EndoResourceUsageV0): EndoEventRecordV0;
}

/**
 * Accept a page query only as sent: a plain object with optional non-negative integer afterSequence and integer
 * limit (undefined is accepted from in-process callers). Anything else is rejected rather than coerced.
 */
function parseEndoEventRecordPageQueryV0(query: unknown): EndoEventRecordPageQueryV0 | undefined {
	if (query === undefined) return undefined;
	if (query === null || typeof query !== "object" || Object.getPrototypeOf(query) !== Object.prototype) {
		throw new TypeError("Event record page query must be a plain object");
	}
	const record = query as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "afterSequence" && key !== "limit")
			throw new TypeError(`Unknown event record page query field: ${key}`);
	}
	const { afterSequence, limit } = record;
	if (
		afterSequence !== undefined &&
		(typeof afterSequence !== "number" || !Number.isInteger(afterSequence) || afterSequence < 0)
	) {
		throw new TypeError("Event record page cursor must be a non-negative integer");
	}
	if (
		limit !== undefined &&
		(typeof limit !== "number" ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0)
	) {
		throw new TypeError(
			`Event record page limit must be an integer between 1 and ${ENDO_EVENT_RECORD_PAGE_MAX_LIMIT_V0}`,
		);
	}
	return { afterSequence, limit };
}

/** The event store: strict ingestion, the append-only stream, the forward page, and the persisted record. */
export function createEndoEventStoreV0(): EndoEventStoreV0 {
	const events: EndoEventV0[] = [];
	const seen = new Set<string>();
	return {
		get length(): number {
			return events.length;
		},
		ingest(value: unknown): EndoEventV0 {
			const event = validateEndoEventV0(value);
			if (event === null) throw new TypeError("not a valid endo.event.v0 event");
			assertPlainJsonValueV0(event);
			if (seen.has(event.id)) throw new TypeError(`duplicate event id: ${event.id}`);
			seen.add(event.id);
			const stored = deepFreezeCopyV0(event);
			events.push(stored);
			return stored;
		},
		page(query?: EndoEventRecordPageQueryV0): EndoEventRecordPageV0 {
			const parsed = parseEndoEventRecordPageQueryV0(query);
			const afterSequence = parsed?.afterSequence ?? 0;
			const limit = parsed?.limit ?? ENDO_EVENT_RECORD_PAGE_DEFAULT_LIMIT_V0;
			const pageEvents = events.slice(afterSequence, afterSequence + limit);
			const nextAfterSequence = pageEvents.length === 0 ? afterSequence : afterSequence + pageEvents.length;
			return { schemaVersion: "endo.record-page.v0", order: "ascending", events: pageEvents, nextAfterSequence };
		},
		record(id: string, coordinates?: EndoEventCoordinatesV0, resources?: EndoResourceUsageV0): EndoEventRecordV0 {
			if (!isEndoIdentifierV0(id, "evidence")) {
				throw new TypeError("record id must be an endo.evidence.* identifier");
			}
			if (coordinates !== undefined && validateEndoEventCoordinatesV0(coordinates) === null) {
				throw new TypeError("record coordinates are not valid endo event coordinates");
			}
			if (resources !== undefined && validateEndoResourceUsageV0(resources) === null) {
				throw new TypeError("record resources are not valid endo resource usage");
			}
			const stored = [...events];
			const record: EndoEventRecordV0 = {
				schemaVersion: "endo.record.v0",
				id,
				events: stored,
				summary: reduceEndoEventSummaryV0(stored),
				digest: sha256HexV0(canonicalEndoJsonV0(stored)),
			};
			if (coordinates !== undefined) record.coordinates = coordinates;
			if (resources !== undefined) record.resources = resources;
			return record;
		},
	};
}
