// The Inspector service and host facet: read-only Endophasia observations (Session Overview v0) exposed through
// Chord's remote service boundary. The v0 schema is in protocol/session-overview.ts; the neutral port in
// runtime/ports.ts; the Pi-backed capture in adapters/pi/ports.ts.
import { type Context, defineFacet, defineService, type Facet } from "@earendil-works/chord";
import type { SessionOverviewV0 } from "../../protocol/session-overview.ts";
import type { SessionOverviewCaptureSourceV0 } from "../ports.ts";

/** Read-only Endophasia observations exposed through Chord's remote service boundary. */
export interface EndophasiaInspectorV0 {
	/** A fresh Session Overview v0 capture per call, with its per-lane consistency. Nothing is cached. */
	sessionOverview(context: Context): Promise<SessionOverviewV0>;
}

export const EndophasiaInspectorV0 = defineService<EndophasiaInspectorV0>("endophasia.inspector.v0");

/** Provide EndophasiaInspectorV0 by delegating each call to one Session Overview capture source. */
export function createEndophasiaInspectorFacetV0(capture: SessionOverviewCaptureSourceV0): Facet {
	return defineFacet({
		id: "@endophasia/inspector",
		setup(env) {
			env.provide(EndophasiaInspectorV0, {
				sessionOverview: (context) => capture.capture(context),
			});
		},
	});
}
