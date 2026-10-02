// Test-only Session worker: the standard Endophasia services, with Continuity over the main lane's real
// configuration and a synthetic durable ancestry sized to the remote byte limit (ENDOPHASIA_TEST_CONTINUITY is
// "at-limit" or "over-limit"), to measure that limit over the real Pi transport. Launched through startServer's
// sessionWorkerEntryUrl, like runtime/session-worker.ts.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createPiRuntimeObservationSourcesV0 } from "../../adapters/pi/observation-sources.ts";
import { createEndophasiaContinuityFacetV0 } from "../../runtime/contracts/continuity-facet.ts";
import { createEndophasiaInspectorFacetV0 } from "../../runtime/contracts/inspector.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../runtime/contracts/mission-trace.ts";
import { createEndophasiaRuntimeFactsFacetV0 } from "../../runtime/contracts/runtime-facts.ts";
import { createEndophasiaRuntimeProfileFacetV0 } from "../../runtime/contracts/runtime-profile-facet.ts";
import { createEndophasiaUsageFacetV0 } from "../../runtime/contracts/usage-facet.ts";
import { largestSyntheticCountWithinLimit, syntheticContinuityLane } from "../continuity-synthetic.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	const mode = process.env.ENDOPHASIA_TEST_CONTINUITY;
	if (mode !== "at-limit" && mode !== "over-limit") throw new Error("ENDOPHASIA_TEST_CONTINUITY is not set");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: async ({ harness, usageReader }) => {
			const main = await harness.lane("main", BACKGROUND_CONTEXT);
			const pi = createPiRuntimeObservationSourcesV0({ harness, lane: main, usageReader });
			const { count } = await largestSyntheticCountWithinLimit(main, BACKGROUND_CONTEXT);
			return [
				createEndophasiaRuntimeProfileFacetV0({
					schemaVersion: "runtime-profile.v0",
					scope: "session-worker-lifetime",
					runtimeFamily: "pi",
					adapterProfileId: "endophasia.test.large-continuity.v0",
					capabilities: [
						"endophasia.session-overview.v0",
						"endophasia.mission-trace.v0",
						"endophasia.runtime-metrics.v0",
						"endophasia.operation-outcome.v0",
						"endophasia.usage.v0",
						"endophasia.continuity.v0",
					],
				}),
				createEndophasiaInspectorFacetV0(harness),
				createEndophasiaMissionTraceFacetV0(pi.missionTrace),
				createEndophasiaRuntimeFactsFacetV0({
					runtimeMetrics: pi.runtimeMetrics,
					operationOutcome: pi.operationOutcome,
				}),
				createEndophasiaUsageFacetV0(pi.usage),
				createEndophasiaContinuityFacetV0(syntheticContinuityLane(main, mode === "at-limit" ? count : count + 1)),
			];
		},
	}).catch(() => process.exit(1));
}
