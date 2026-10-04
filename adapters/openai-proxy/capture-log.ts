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
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { EndoAsyncDurableQueueV0 } from "../../storage/async-append.ts";
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
	readonly #queue: EndoAsyncDurableQueueV0 | null;

	/**
	 * Open (or create) the capture log of `storeRoot`.
	 *
	 * With `async`, every event and blob is still appended and fsync'd in order as soon as it is recorded, but on
	 * libuv's threadpool (storage/async-append.ts), so recording never blocks the event loop. The recording proxy uses
	 * this: it relays bytes on that loop, and a synchronous fsync before relaying the upstream's close made a keep-alive
	 * client write into a closing connection. `flush()` resolves once everything recorded so far is on disk.
	 *
	 * On open, an exchange the log shows as started (a request recorded) but never ended, and not yet marked, gets a
	 * `capture.exchange-interrupted` marker: the recording process died with it in flight.
	 */
	constructor(
		storeRoot: string,
		key: EndoDigestKeyV0,
		role: string,
		options: { async?: boolean; queue?: EndoAsyncDurableQueueV0 } = {},
	) {
		this.root = endoCaptureRootV0(storeRoot);
		this.key = key;
		this.producer = `capture:${role}`;
		this.events = createEndoDurableEventStoreV0(this.root);
		this.blobs = createEndoBlobStoreV0(this.root, key);
		this.#sequence = this.events.length;
		this.#queue = options.queue ?? (options.async === true ? new EndoAsyncDurableQueueV0() : null);
		this.#markInterrupted();
	}

	#markInterrupted(): void {
		if (this.events.length === 0) return;
		const open = new Map<string, { producer: string; exchange: number }>();
		let after = 0;
		for (;;) {
			const page = this.events.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			for (const event of page.events) {
				const payload = event.payload as { exchange?: unknown };
				if (typeof payload.exchange !== "number") continue;
				const id = `${event.producer}\u0000${payload.exchange}`;
				if (event.kind === "capture.started") continue;
				if (event.kind === "capture.request")
					open.set(id, { producer: event.producer, exchange: payload.exchange });
				if (event.kind === "capture.exchange-ended" || event.kind === "capture.exchange-interrupted")
					open.delete(id);
			}
			// A new recording (capture.started) restarts exchange numbers: earlier open exchanges stay open, keyed apart.
			after = page.nextAfterSequence;
		}
		for (const { producer, exchange } of open.values())
			this.record(
				"capture.exchange-interrupted",
				{
					exchange,
					reason:
						"the log was reopened with this exchange in flight: the recording process ended (killed or crashed) before it completed",
				},
				producer,
			);
	}

	/** Store bytes in the blob store; returns the reference an event carries. */
	keep(bytes: Uint8Array): EndoCapturedBytesRefV0 {
		if (this.#queue !== null) {
			const digest = this.key.digestBytes(bytes);
			this.#queue.writeFileOnce(join(this.root, "blobs", this.key.keyId, digest.value), bytes);
			return { digest, bytes: bytes.length };
		}
		const stored = this.blobs.put(bytes);
		return { digest: stored.digest, bytes: stored.bytes };
	}

	/** Resolves once everything recorded so far is on disk (immediately for a synchronous log). */
	async flush(): Promise<void> {
		await this.#queue?.idle();
	}

	/** Asynchronous writes that failed (the recording continues; the count is reported). */
	get writeFailures(): number {
		return this.#queue?.failures ?? 0;
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
		if (this.#queue !== null) {
			this.#queue.appendFrame(
				join(this.root, "events", "events.log"),
				new TextEncoder().encode(canonicalEndoJsonV0(event)),
			);
			return event;
		}
		return this.events.ingest(event);
	}

	/** Stop recording. An asynchronous log's queued writes still complete: await flush() first to know they did. */
	close(): void {
		if (this.#closed) return;
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
