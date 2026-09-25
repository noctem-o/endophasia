import type { AgentHarness, Context, LaneInfo, OperationStatus } from "@earendil-works/pi-agent-core";

export interface SessionLaneOverviewV0 {
	name: string;
	tipId: string | null;
	operation: null | {
		operationId: string;
		kind: "run" | "compaction" | "navigation";
		status: OperationStatus;
		startedAt: number;
		/** Model identity Pi captured into the open operation's current request state; not the lane's configured model. */
		capturedModel?: { provider: string; modelId: string };
	};
}

export interface SessionOverviewV0 {
	schemaVersion: "session-overview.v0";
	/** Each lane is one atomic Pi observation; lanes may have been observed at different instants. */
	consistency: "per-lane";
	/** Sorted by lane name (code-unit order). An Endophasia presentation choice, not Pi execution order. */
	lanes: SessionLaneOverviewV0[];
	counts: {
		lanes: number;
		activeOperations: number;
		abortingOperations: number;
	};
}

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
