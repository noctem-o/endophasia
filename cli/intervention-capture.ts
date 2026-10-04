/**
 * The recording proxy's capture as the intervention desk reads it (runtime/contracts/intervention.ts): the captured model
 * requests of a session store, in capture order, each with its body from the keyed blob store. Null when the store holds
 * no proxy capture. Built here, in the CLI layer, so the Pi adapter depends on no proxy code.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import type { EndoCapturedRequestV0, EndoInterventionCaptureSourceV0 } from "../runtime/contracts/intervention.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";

export function endoInterventionCaptureSourceV0(root: string, key: EndoDigestKeyV0): EndoInterventionCaptureSourceV0 {
	return {
		requests() {
			if (!existsSync(join(endoCaptureRootV0(root), "events"))) return null;
			const blobs = createEndoBlobStoreV0(endoCaptureRootV0(root), key, { readOnly: true });
			return readEndoCaptureEventsV0(root)
				.filter((event) => event.kind === "capture.request" && event.producer === "capture:record")
				.flatMap((event): EndoCapturedRequestV0[] => {
					const p = event.payload as unknown as { exchange: number; body?: { digest: EndoKeyedDigestV0 } };
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
	};
}
