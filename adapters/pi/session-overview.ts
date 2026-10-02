// The Pi-backed Session Overview capture. The v0 schema is in protocol/session-overview.ts; the service handle and
// host facet are in runtime/contracts/inspector.ts.
import type { AgentHarness, Context, LaneInfo } from "@earendil-works/pi-agent-core";
import type { SessionLaneOverviewV0, SessionOverviewV0 } from "../../protocol/session-overview.ts";

function projectLane(info: LaneInfo): SessionLaneOverviewV0 {
	const operation = info.operation;
	return {
		name: info.name,
		tipId: info.tipId,
		operation:
			operation === null
				? null
				: {
						operationId: operation.id,
						kind: operation.kind,
						status: operation.status,
						startedAt: operation.startedAt,
						...(operation.capturedModel === undefined
							? {}
							: {
									capturedModel: {
										provider: operation.capturedModel.provider,
										modelId: operation.capturedModel.modelId,
									},
								}),
					},
	};
}

/** Capture a payload-minimal, read-only inventory of the harness's current lanes. Not a session-wide atomic snapshot. */
export async function captureSessionOverviewV0(
	harness: Pick<AgentHarness, "lanes">,
	context: Context,
): Promise<SessionOverviewV0> {
	const lanes = (await harness.lanes(context))
		.map(projectLane)
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return {
		schemaVersion: "session-overview.v0",
		consistency: "per-lane",
		lanes,
		counts: {
			lanes: lanes.length,
			activeOperations: lanes.filter((lane) => lane.operation !== null).length,
			abortingOperations: lanes.filter((lane) => lane.operation?.status === "aborting").length,
		},
	};
}
