// The capture log: what the recording proxy, the cassette server and the session driver record, kept beside a session's
// event store in `<store>/capture/`.
//
//   <store>/capture/events/   an Endophasia event store (endo.event.v0), producer `capture:<role>`
//   <store>/capture/blobs/    a keyed blob store (storage/blob-store.ts): HTTP bodies, workspace archives, prompts
//
// Canonical events carry keyed digests and lengths only. Bodies, chunks, archives and prompt text live in the blob
// store, outside canonical evidence, addressed by their keyed digest so a file name is never a plain-hash oracle.
//
// The event kinds (payloads are strict JSON):
//   capture.started          {role: "record" | "replay", listen, upstream | cassette, digestKey, timing?}
//   capture.request          {exchange, attempt, method, path, requestDigest, body, headers}
//   capture.response         {exchange, status, headers, offsetMs}
//   capture.exchange-ended   {exchange, outcome, status, chunks, body, offsetMs, error?}
//   capture.served           {exchange, cassetteExchange, requestDigest, outcome, chunksDelivered, offsetMs}
//   capture.cassette-miss    {exchange, reason, requestDigest, expected, detail}
//   capture.workspace-snapshot {path, archive, summary}
//   capture.driver-step      {step, op, ...}: what the session driver did, in order (the replay script)
//   capture.stopped          {exchanges}

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { EndoEventV0 } from "../../protocol/event.ts";
import { validateEndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0, type EndoBlobStoreV0 } from "../../storage/blob-store.ts";
import { createEndoDurableEventStoreV0, type EndoDurableEventStoreV0 } from "../../storage/event-store.ts";

/** The directory under a store root that holds the capture log. */
export const ENDO_CAPTURE_DIRECTORY_V0 = "capture";

/** The capture log's version: bumped when an event's meaning or shape changes. */
export const ENDO_CAPTURE_VERSION_V0 = "endo-capture.1";

/** A keyed digest and the length of what it digests. */
export interface EndoCapturedBytesRefV0 {
	digest: EndoKeyedDigestV0;
	bytes: number;
}

/** The capture directory of a store root. */
export function endoCaptureRootV0(storeRoot: string): string {
	return join(storeRoot, ENDO_CAPTURE_DIRECTORY_V0);
}

export class EndoCaptureLogV0 {
	readonly root: string;
	readonly key: EndoDigestKeyV0;
	readonly producer: string;
	readonly events: EndoDurableEventStoreV0;
	readonly blobs: EndoBlobStoreV0;
	readonly #instance = randomBytes(8).toString("hex");
	#sequence: number;
	#next = 0;
	#closed = false;
	readonly #buffered: boolean;
	readonly #pendingEvents: EndoEventV0[] = [];
	readonly #pendingBlobs = new Map<string, Uint8Array>();

	/**
	 * Open (or create) the capture log of `storeRoot`. With `buffered`, events and blobs are kept in memory (digests,
	 * sequence numbers and timestamps assigned at once) and written durably only by `flushToDisk()` or `close()`: the
	 * recording proxy uses it so that no fsync'd write ever runs while bytes are being relayed. A crash loses what was
	 * not flushed; the experiment runner counts a trial only once its result is written, so such a trial is rerun.
	 */
	constructor(storeRoot: string, key: EndoDigestKeyV0, role: string, options: { buffered?: boolean } = {}) {
		this.root = endoCaptureRootV0(storeRoot);
		this.key = key;
		this.producer = `capture:${role}`;
		this.events = createEndoDurableEventStoreV0(this.root);
		this.blobs = createEndoBlobStoreV0(this.root, key);
		this.#sequence = this.events.length;
		this.#buffered = options.buffered === true;
	}

	/** Store bytes in the blob store (or the buffer); returns the reference an event carries. */
	keep(bytes: Uint8Array): EndoCapturedBytesRefV0 {
		if (this.#buffered) {
			const digest = this.key.digestBytes(bytes);
			this.#pendingBlobs.set(digest.value, Buffer.from(bytes));
			return { digest, bytes: bytes.length };
		}
		const stored = this.blobs.put(bytes);
		return { digest: stored.digest, bytes: stored.bytes };
	}

	/** Events and blobs not yet written to disk (buffered mode). */
	get pending(): number {
		return this.#pendingEvents.length + this.#pendingBlobs.size;
	}

	/** Write everything buffered: blobs first, then events in order. A no-op when nothing is buffered. */
	flushToDisk(): void {
		for (const [value, bytes] of this.#pendingBlobs) {
			this.blobs.put(bytes);
			this.#pendingBlobs.delete(value);
		}
		while (this.#pendingEvents.length > 0) this.events.ingest(this.#pendingEvents.shift()!);
	}

	/**
	 * Append one event, by default under this log's producer (`capture:<role>`); the session driver records its steps
	 * as `capture:driver` in the same log. Never throws after close: a late event (a socket closing during shutdown) is
	 * dropped.
	 */
	record(kind: string, payload: Record<string, JsonValueV0>, producer: string = this.producer): EndoEventV0 | null {
		if (this.#closed) return null;
		this.#sequence += 1;
		this.#next += 1;
		const event = validateEndoEventV0({
			schemaVersion: "endo.event.v0",
			id: `endo.event.capture.${this.#instance}.${this.#next}`,
			kind,
			source: "runtime-fact",
			sequence: this.#sequence,
			at: new Date().toISOString(),
			coordinates: {},
			producer,
			derivedFrom: [],
			payload: JSON.parse(JSON.stringify(payload)),
		});
		if (event === null) throw new TypeError(`the ${kind} capture event failed endo.event.v0 validation`);
		if (this.#buffered) {
			this.#pendingEvents.push(event);
			return event;
		}
		return this.events.ingest(event);
	}

	close(): void {
		if (this.#closed) return;
		this.flushToDisk();
		this.#closed = true;
		this.events.close();
	}
}

/** Every event of the capture log under `storeRoot`, in store order (read-only). */
export function readEndoCaptureEventsV0(storeRoot: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(endoCaptureRootV0(storeRoot), { readOnly: true });
	try {
		const events: EndoEventV0[] = [];
		let after = 0;
		for (;;) {
			const page = store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
			after = page.nextAfterSequence;
		}
		return events;
	} finally {
		store.close();
	}
}
