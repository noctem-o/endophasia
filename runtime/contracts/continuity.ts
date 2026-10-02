// The Continuity service handle only, free of Pi runtime reads, so presentations can bind it without bundling the
// capture. The v0 schema is in protocol/continuity.ts; the Pi-backed capture is in adapters/pi/continuity.ts and the
// host facet in runtime/contracts/continuity-facet.ts.
import { type Context, defineService } from "@earendil-works/chord";
import type { ContinuitySnapshotV0 } from "../../protocol/continuity.ts";

/** A read-only explanation of the attached Session's main lane at one durable tip. */
export interface EndophasiaContinuityV0 {
	/**
	 * A fresh Continuity v0 capture of the main lane on every call: nothing is cached and nothing is live. Fails, rather
	 * than returning part of the ancestry, when the snapshot exceeds CONTINUITY_REMOTE_BYTE_LIMIT.
	 */
	snapshot(context: Context): Promise<ContinuitySnapshotV0>;
}

export const EndophasiaContinuityV0 = defineService<EndophasiaContinuityV0>("endophasia.continuity.v0");
