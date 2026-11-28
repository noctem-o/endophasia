/**
 * Phase 12 — the durable event store (README "## Phase 12 — Operational substrate &
 * integration", work item: "storage/ durable append store"). The in-memory
 * `EndoEventStoreV0` semantics — ingest with namespace + duplicate-id enforcement, the
 * forward page, the persisted record — over the durable frame log at
 * `root/events/events.log`. One frame holds the canonical JSON of one validated event, so
 * a frame is an event record on disk.
 *
 * Open behaviour, in order: every valid frame is decoded and validated first; then a torn
 * tail (a crash mid-append) is truncated away and reported as `recovered`, with its length,
 * sha256 and the file its bytes were preserved in (recovery().discarded). The first frame
 * whose digest fails verification seals the store — the valid prefix stays readable via
 * `page`/`record`, but `ingest` throws forever, because a verified-then-flipped frame means
 * the rest of the file cannot be trusted. A log whose frames decode but violate the event
 * rules (a hand-crafted duplicate id, an invalid event) is unopenable: the TypeError
 * propagates before anything is truncated, so an unopenable store is left byte-for-byte as
 * found.
 *
 * Opened with `{ readOnly: true }`, the store creates no directory and truncates nothing: a
 * torn tail is reported (`truncated`, `tail`) and left in place, and `ingest` throws.
 *
 * Every `ingest` is: validate in the in-memory store (namespace, duplicates), then one
 * framed write + fsync. If the write fails the store is dead — all further operations
 * throw — because the in-memory state has outrun the durable log.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EndoEventCoordinatesV0, EndoEventV0 } from "../protocol/event.ts";
import type {
	EndoEventRecordPageQueryV0,
	EndoEventRecordPageV0,
	EndoEventRecordV0,
	EndoResourceUsageV0,
} from "../protocol/event-record.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { assertEndoAttachmentLockV0, type EndoAttachmentLockHandleV0 } from "./attachment-lock.ts";
import { type EndoEventStreamIdV0, endoEventStreamPathV0 } from "./event-stream-path.ts";
import {
	createEndoFrameLogV0,
	type EndoDurableStoreOptionsV0,
	type EndoFrameLogRecoveryV0,
	endoFrameLogRecoveryV0,
} from "./log.ts";
import {
	assertEndoLegacyStoreWritableV0,
	hasEndoStoreSentinelV0,
	inspectEndoStoreBarrierV0,
	refuseEndoStoreBarrierV0,
} from "./store-format.ts";

/**
 * How open classified the event log, and what it discarded.
 */
export interface EndoDurableEventStoreRecoveryV0 extends EndoFrameLogRecoveryV0 {
	/** True when partial (torn) bytes were discarded; the same as `recovered`. */
	discardedPartial: boolean;
}

/**
 * The durable event store of one root: the in-memory event-store surface plus recovery and
 * close.
 */
export interface EndoDurableEventStoreV0 {
	/** The number of ingested events (the readable prefix when sealed). */
	readonly length: number;
	/** Ingest one endo.event.v0 and return the stored frozen copy. Throws when read-only, sealed, dead, or closed. */
	ingest(value: unknown): EndoEventV0;
	/** A forward page of the stored events, same semantics as the in-memory store. */
	page(query?: EndoEventRecordPageQueryV0): EndoEventRecordPageV0;
	/** Materialise the persisted record for an endo.evidence.* id. Throws on invalid arguments. */
	record(id: string, coordinates?: EndoEventCoordinatesV0, resources?: EndoResourceUsageV0): EndoEventRecordV0;
	/** How open classified the log. */
	recovery(): EndoDurableEventStoreRecoveryV0;
	/** Close the store; every later operation throws. */
	close(): void;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface EndoDurableEventStoreOptionsV0 extends EndoDurableStoreOptionsV0 {
	/** Optional explicit log path for read-only callers. A writable legacy open always targets the root's legacy log. */
	logPath?: string;
}

/**
 * Create (or reopen) the durable event store under `root`.
 */
export function createEndoDurableEventStoreV0(
	root: string,
	options: EndoDurableEventStoreOptionsV0 = {},
): EndoDurableEventStoreV0 {
	const legacyPath = endoEventStreamPathV0(root, { kind: "legacy" });
	const path = options.logPath ?? legacyPath;
	if (options.readOnly !== true && resolve(path) !== resolve(legacyPath))
		throw new TypeError("writable log overrides are not allowed; use an attachment writer lock");
	const assertWritable = () => assertEndoLegacyStoreWritableV0(root);
	if (options.readOnly !== true) assertWritable();
	return openEventLog(path, options, assertWritable);
}

const openWriters = new WeakSet<EndoAttachmentLockHandleV0>();

export function openEndoAttachmentEventStreamV0(
	root: string,
	lock: EndoAttachmentLockHandleV0,
	options: { maxReadBytes?: number } = {},
): EndoDurableEventStoreV0 {
	const attachmentId = lock.attachmentId;
	const assertHeld = () => {
		const state = inspectEndoStoreBarrierV0(root);
		refuseEndoStoreBarrierV0(root, state);
		if (!hasEndoStoreSentinelV0(state)) throw new TypeError("an established per-attachment-v1 sentinel is required");
		assertEndoAttachmentLockV0(root, attachmentId, lock);
	};
	assertHeld();
	if (openWriters.has(lock)) throw new TypeError("this attachment lock already has an open event writer");
	const path = endoEventStreamPathV0(root, { kind: "attachment", attachmentId });
	const store = openEventLog(path, options, assertHeld);
	openWriters.add(lock);
	let closed = false;
	return {
		...store,
		get length() {
			return store.length;
		},
		close() {
			if (closed) return;
			closed = true;
			store.close();
			openWriters.delete(lock);
		},
	};
}

export function openEndoEventStreamReadOnlyV0(
	root: string,
	id: EndoEventStreamIdV0,
	options: { maxReadBytes?: number } = {},
): EndoDurableEventStoreV0 {
	return openEventLog(endoEventStreamPathV0(root, id), { ...options, readOnly: true });
}

function openEventLog(
	logPath: string,
	options: EndoDurableStoreOptionsV0,
	assertWritable?: () => void,
): EndoDurableEventStoreV0 {
	const readOnly = options.readOnly === true;
	if (!readOnly) mkdirSync(dirname(logPath), { recursive: true });
	const log = createEndoFrameLogV0(logPath, { ...options, readOnly });
	const read = log.read();
	const { frames } = read;

	const inner = createEndoEventStoreV0();
	for (const frame of frames) {
		let event: unknown;
		try {
			event = JSON.parse(decoder.decode(frame));
		} catch {
			throw new TypeError("event log frame does not decode as UTF-8 JSON; the store cannot be opened");
		}
		inner.ingest(event);
	}

	// Only now, with every remaining frame validated, is a torn tail cut.
	const discarded = read.truncated && !readOnly ? log.truncateTo(frames.length) : null;
	const recovery: EndoDurableEventStoreRecoveryV0 = {
		...endoFrameLogRecoveryV0(read, readOnly, discarded),
		discardedPartial: discarded !== null,
	};

	let dead = false;
	let closed = false;

	const guard = (write: boolean): void => {
		if (closed) throw new TypeError("the durable event store is closed");
		if (dead)
			throw new TypeError(
				"the durable event store is dead: a log write failed and the in-memory state outruns the log",
			);
		if (write && readOnly) throw new TypeError("the durable event store is open read-only");
		if (write) assertWritable?.();
		if (write && recovery.sealed) {
			throw new TypeError(
				`the durable event store is sealed: frame ${recovery.corruptAt} failed verification on open; the store is read-only`,
			);
		}
	};

	return {
		get length(): number {
			guard(false);
			return inner.length;
		},
		ingest(value: unknown): EndoEventV0 {
			guard(true);
			const event = inner.ingest(value);
			try {
				log.append(new TextEncoder().encode(canonicalEndoJsonV0(event)));
			} catch {
				dead = true;
				throw new TypeError("the durable event store log write failed; the store is dead");
			}
			return event;
		},
		page(query?: EndoEventRecordPageQueryV0): EndoEventRecordPageV0 {
			guard(false);
			return inner.page(query);
		},
		record(id: string, coordinates?: EndoEventCoordinatesV0, resources?: EndoResourceUsageV0): EndoEventRecordV0 {
			guard(false);
			return inner.record(id, coordinates, resources);
		},
		recovery(): EndoDurableEventStoreRecoveryV0 {
			guard(false);
			return JSON.parse(JSON.stringify(recovery));
		},
		close(): void {
			closed = true;
		},
	};
}
