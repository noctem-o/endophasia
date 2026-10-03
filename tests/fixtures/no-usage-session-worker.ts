// Test-only Session worker: every Endophasia service except Usage, to prove Presentation Client v0 requires Usage
// itself. Its Runtime Profile truthfully advertises what it installs, without Usage. Launched through startServer's
// sessionWorkerEntryUrl, like runtime/session-worker.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import {
	createPiMissionTraceSourceV0,
	createPiOperationOutcomeSourceV0,
	createPiRuntimeMetricsSourceV0,
} from "../../adapters/pi/observation-sources.ts";
import { createPiContinuityCaptureV0, createPiSessionOverviewCaptureV0 } from "../../adapters/pi/ports.ts";
import { createEndophasiaContinuityFacetV0 } from "../../runtime/contracts/continuity-facet.ts";
import { createEndophasiaInspectorFacetV0 } from "../../runtime/contracts/inspector.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../runtime/contracts/mission-trace.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../../runtime/contracts/runtime-facts.ts";
import { createEndophasiaRuntimeProfileFacetV0 } from "../../runtime/contracts/runtime-profile-facet.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: async ({ harness }) => {
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			return [
				createEndophasiaRuntimeProfileFacetV0({
					schemaVersion: "runtime-profile.v0",
					scope: "session-worker-lifetime",
					runtimeFamily: "pi",
					adapterProfileId: "endophasia.test.no-usage.v0",
					capabilities: [
						"endophasia.session-overview.v0",
						"endophasia.mission-trace.v0",
						"endophasia.runtime-metrics.v0",
						"endophasia.operation-outcome.v0",
						"endophasia.continuity.v0",
					],
				}),
				createEndophasiaInspectorFacetV0(createPiSessionOverviewCaptureV0(harness)),
				createEndophasiaMissionTraceFacetV0(createPiMissionTraceSourceV0(harness)),
				createEndophasiaRuntimeFactsFacetV0({
					runtimeMetrics: createPiRuntimeMetricsSourceV0(main),
					operationOutcome: createPiOperationOutcomeSourceV0(main),
				}),
				createEndophasiaContinuityFacetV0(createPiContinuityCaptureV0(main)),
			];
		},
	}).catch(() => process.exit(1));
}
