/**
 * The recording proxy's capture as the intervention desk reads it (runtime/contracts/intervention.ts): the captured model
 * requests of a session store, in capture order, each with its body from the keyed blob store. Null when the store holds
 * no proxy capture. Built here, in the CLI layer, so the Pi adapter depends on no proxy code.
 *
 * Two readers over the same capture:
 *   requests()  every request with its body at once. The whole capture is read; the closing `finish` uses it through the desk.
 *   open()      the INDEX of the capture (no bodies) and a body reader: one verified blob per call. The workbench's explicit evidence
 *               check scans through this in bounded slices. Opening reads and validates the capture's event log, so a log over
 *               `ENDO_CAPTURE_INDEX_MAX_BYTES_V0` is not indexed (it throws, and the desk reports the check as incomplete): the event
 *               log holds only metadata, so this limit is far beyond a long session, and the bodies, which are large, are never loaded here.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import type {
	EndoCapturedRequestV0,
	EndoCaptureIndexEntryV0,
	EndoInterventionCaptureSourceV0,
} from "../runtime/contracts/intervention.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";

/** The largest capture event log `open()` will index, in bytes. */
export const ENDO_CAPTURE_INDEX_MAX_BYTES_V0 = 16 * 1024 * 1024;

interface RequestPayload {
	exchange: number;
	body?: { digest: EndoKeyedDigestV0; bytes?: number };
}

export function endoInterventionCaptureSourceV0(root: string, key: EndoDigestKeyV0): EndoInterventionCaptureSourceV0 {
	const present = () => existsSync(join(endoCaptureRootV0(root), "events"));
	return {
		requests() {
			if (!present()) return null;
			const blobs = createEndoBlobStoreV0(endoCaptureRootV0(root), key, { readOnly: true });
			return readEndoCaptureEventsV0(root)
				.filter((event) => event.kind === "capture.request" && event.producer === "capture:record")
				.flatMap((event): EndoCapturedRequestV0[] => {
					const p = event.payload as unknown as RequestPayload;
					if (p.body === undefined) return [];
					try {
						return [
							{
								exchange: p.exchange,
								captureEvent: event.id,
								at: event.at,
								body: JSON.parse(Buffer.from(blobs.get(p.body.digest)).toString("utf8")),
							},
						];
					} catch {
						return [];
					}
				});
		},
		open(options) {
			if (!present()) return null;
			const log = join(endoCaptureRootV0(root), "events", "events.log");
			if (existsSync(log) && statSync(log).size > (options?.maxIndexBytes ?? ENDO_CAPTURE_INDEX_MAX_BYTES_V0))
				throw new RangeError("the capture's event log is larger than the bounded index");
			const blobs = createEndoBlobStoreV0(endoCaptureRootV0(root), key, { readOnly: true });
			const digests = new Map<string, EndoKeyedDigestV0>();
			const entries: EndoCaptureIndexEntryV0[] = [];
			for (const event of readEndoCaptureEventsV0(root)) {
				if (event.kind !== "capture.request" || event.producer !== "capture:record") continue;
				const p = event.payload as unknown as RequestPayload;
				if (p.body === undefined) continue;
				digests.set(event.id, p.body.digest);
				entries.push({
					exchange: p.exchange,
					captureEvent: event.id,
					at: event.at,
					bodyBytes: typeof p.body.bytes === "number" && p.body.bytes >= 0 ? p.body.bytes : 0,
				});
			}
			return {
				entries,
				body: (entry) => JSON.parse(Buffer.from(blobs.get(digests.get(entry.captureEvent)!)).toString("utf8")),
			};
		},
	};
}
