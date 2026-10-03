// Test-only Session worker: every Endophasia service except Continuity, to prove Presentation Client v0 requires
// Continuity itself. Its Runtime Profile truthfully advertises what it installs, without Continuity, and still
// hydrates when the attachment degrades. Launched through startServer's sessionWorkerEntryUrl, like
// runtime/session-worker.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createPiRuntimeObservationSourcesV0 } from "../../adapters/pi/observation-sources.ts";
import { createPiSessionOverviewCaptureV0 } from "../../adapters/pi/ports.ts";
import { createEndophasiaInspectorFacetV0 } from "../../runtime/contracts/inspector.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../runtime/contracts/mission-trace.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../../runtime/contracts/runtime-facts.ts";
import { createEndophasiaRuntimeProfileFacetV0 } from "../../runtime/contracts/runtime-profile-facet.ts";
import { createEndophasiaUsageFacetV0 } from "../../runtime/contracts/usage-facet.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: async ({ harness, usageReader }) => {
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			const pi = createPiRuntimeObservationSourcesV0({ harness, lane: main, usageReader });
			return [
				createEndophasiaRuntimeProfileFacetV0({
					schemaVersion: "runtime-profile.v0",
					scope: "session-worker-lifetime",
					runtimeFamily: "pi",
					adapterProfileId: "endophasia.test.no-continuity.v0",
					capabilities: [
						"endophasia.session-overview.v0",
						"endophasia.mission-trace.v0",
						"endophasia.runtime-metrics.v0",
						"endophasia.operation-outcome.v0",
						"endophasia.usage.v0",
					],
				}),
				createEndophasiaInspectorFacetV0(createPiSessionOverviewCaptureV0(harness)),
				createEndophasiaMissionTraceFacetV0(pi.missionTrace),
				createEndophasiaRuntimeFactsFacetV0({
					runtimeMetrics: pi.runtimeMetrics,
					operationOutcome: pi.operationOutcome,
				}),
				createEndophasiaUsageFacetV0(pi.usage),
			];
		},
	}).catch(() => process.exit(1));
}
