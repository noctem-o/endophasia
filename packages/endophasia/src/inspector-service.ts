import { type Context, defineFacet, defineService, type Facet } from "@earendil-works/chord";
import type { AgentHarness } from "@earendil-works/pi-agent-core";
import { captureSessionOverviewV0, type SessionOverviewV0 } from "./session-overview.ts";

/** Read-only Endophasia observations exposed through Chord's remote service boundary. */
export interface EndophasiaInspectorV0 {
	/** A fresh Session Overview v0 capture per call, with its per-lane consistency. Nothing is cached. */
	sessionOverview(context: Context): Promise<SessionOverviewV0>;
}

export const EndophasiaInspectorV0 = defineService<EndophasiaInspectorV0>("endophasia.inspector.v0");

/** Provide EndophasiaInspectorV0 by delegating each call to the existing Endophasia projection. */
export function createEndophasiaInspectorFacetV0(harness: Pick<AgentHarness, "lanes">): Facet {
	return defineFacet({
		id: "@endophasia/inspector",
		setup(env) {
			env.provide(EndophasiaInspectorV0, {
				sessionOverview: (context) => captureSessionOverviewV0(harness, context),
			});
		},
	});
}
