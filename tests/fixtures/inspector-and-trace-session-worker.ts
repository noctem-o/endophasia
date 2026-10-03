// Test-only Session worker: the Endophasia Inspector and Mission Trace without Runtime Facts (or Usage), to prove
// Presentation Client v0 requires Runtime Facts. Launched through startServer's sessionWorkerEntryUrl, like runtime/session-worker.ts.
import {
	consumeInternalProcessRole,
	isDirectInternalProcessEntry,
} from "@earendil-works/pi-coding-agent/experimental/process";
import { runCodingAgentSessionWorker } from "@earendil-works/pi-coding-agent/experimental/session-worker";
import { createPiMissionTraceSourceV0 } from "../../adapters/pi/observation-sources.ts";
import { createPiSessionOverviewCaptureV0 } from "../../adapters/pi/ports.ts";
import { createEndophasiaInspectorFacetV0 } from "../../runtime/contracts/inspector.ts";
import { createEndophasiaMissionTraceFacetV0 } from "../../runtime/contracts/mission-trace.ts";

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Test Session worker requires an internal session-worker invocation");
	void runCodingAgentSessionWorker(process.argv.slice(2), {
		createHostFacets: ({ harness }) => [
			createEndophasiaInspectorFacetV0(createPiSessionOverviewCaptureV0(harness)),
			createEndophasiaMissionTraceFacetV0(createPiMissionTraceSourceV0(harness)),
		],
	}).catch(() => process.exit(1));
}
