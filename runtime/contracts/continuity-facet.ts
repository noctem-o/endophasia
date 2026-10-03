// The host facet that provides EndophasiaContinuityV0 from one Continuity capture source, by design Pi-backed. The
// v0 schema is in protocol/continuity.ts; the service handle in runtime/contracts/continuity.ts; the neutral port in
// runtime/ports.ts; the Pi capture in adapters/pi/ports.ts.
import { defineFacet, type Facet } from "@earendil-works/chord";
import { CONTINUITY_REMOTE_BYTE_LIMIT, type ContinuitySnapshotV0 } from "../../protocol/continuity.ts";
import type { ContinuityCaptureSourceV0 } from "../ports.ts";
import { EndophasiaContinuityV0 } from "./continuity.ts";

/** Fail a snapshot whose JSON exceeds the remote byte limit. It is never truncated into a complete-looking snapshot. */
function withinRemoteLimit(snapshot: ContinuitySnapshotV0): ContinuitySnapshotV0 {
	const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
	if (bytes > CONTINUITY_REMOTE_BYTE_LIMIT) {
		throw new RangeError(
			`Continuity snapshot of lane ${snapshot.lane} is ${bytes} bytes with ${snapshot.counts.activePathEntries} active-path entries, over the ${CONTINUITY_REMOTE_BYTE_LIMIT}-byte remote limit; it is not truncated`,
		);
	}
	return snapshot;
}

/**
 * Provide EndophasiaContinuityV0 from one Continuity capture source: each call is a fresh capture of that source's
 * lane, which releases its temporary watcher, and nothing is held between calls. The facet receives only the capture
 * capability, never lane reads or mutation authority. A failed capture fails the call; it is never replaced by an
 * empty snapshot.
 */
export function createEndophasiaContinuityFacetV0(capture: ContinuityCaptureSourceV0): Facet {
	if (capture === undefined || capture === null) throw new TypeError("A Continuity capture source is required");
	return defineFacet({
		id: "@endophasia/continuity",
		setup(env) {
			env.provide(EndophasiaContinuityV0, {
				snapshot: async (context) => withinRemoteLimit(await capture.capture(context)),
			});
		},
	});
}
