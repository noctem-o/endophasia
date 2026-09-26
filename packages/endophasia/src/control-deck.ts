import type { AgentLane, Context, ModelIdentity, OperationStatus, ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * A lane's latest configured model, thinking level, and active tools, from one atomic Pi lane snapshot.
 * This is the configuration future generation snapshots will capture; an in-flight provider request keeps the
 * configuration it already captured.
 */
export interface ControlStateV0 {
	schemaVersion: "control-state.v0";
	lane: string;
	configuration: {
		model: { provider: string; modelId: string };
		thinkingLevel: ThinkingLevel;
		activeToolNames: string[];
	};
	/** Present when work is in flight: a configuration change applies to its later turns, not its current request. */
	operation: null | {
		operationId: string;
		kind: "run" | "compaction" | "navigation";
		status: OperationStatus;
	};
}

/**
 * Pi accepted the change and Endophasia then observed this configured value. Not a promise that future provider
 * or tool execution will succeed, and not proof that no other writer changed the lane between setter and readback.
 */
export type ControlReceiptV0 =
	| {
			schemaVersion: "control.v0";
			kind: "model.configured";
			lane: string;
			configured: { provider: string; modelId: string };
	  }
	| { schemaVersion: "control.v0"; kind: "thinking.configured"; lane: string; configured: ThinkingLevel }
	| { schemaVersion: "control.v0"; kind: "tools.configured"; lane: string; configured: string[] };

/** Capture the lane's configured controls from one short-lived watch snapshot. Read failures propagate. */
export async function captureControlStateV0(lane: Pick<AgentLane, "watch">, context: Context): Promise<ControlStateV0> {
	const watch = await lane.watch(context);
	try {
		const { configuration, operation } = watch.snapshot;
		return {
			schemaVersion: "control-state.v0",
			lane: watch.snapshot.lane,
			configuration: {
				model: { provider: configuration.model.provider, modelId: configuration.model.modelId },
				thinkingLevel: configuration.thinkingLevel,
				activeToolNames: [...configuration.activeToolNames],
			},
			operation:
				operation === null ? null : { operationId: operation.id, kind: operation.kind, status: operation.status },
		};
	} finally {
		watch.unsubscribe();
	}
}

// If the setter commits but the readback then fails, the call rejects although the configuration changed.
// Nothing is retried.

/** Configure the lane model for future generation snapshots. Pi's setter errors propagate unchanged. */
export async function configureModelV0(
	lane: Pick<AgentLane, "setModel" | "watch">,
	model: ModelIdentity,
	context: Context,
): Promise<Extract<ControlReceiptV0, { kind: "model.configured" }>> {
	const requested = { provider: model.provider, modelId: model.modelId };
	await lane.setModel(requested, context);
	const state = await captureControlStateV0(lane, context);
	return {
		schemaVersion: "control.v0",
		kind: "model.configured",
		lane: state.lane,
		configured: state.configuration.model,
	};
}

/** Configure the lane thinking level for future generation snapshots. Pi's setter errors propagate unchanged. */
export async function configureThinkingLevelV0(
	lane: Pick<AgentLane, "setThinkingLevel" | "watch">,
	level: ThinkingLevel,
	context: Context,
): Promise<Extract<ControlReceiptV0, { kind: "thinking.configured" }>> {
	await lane.setThinkingLevel(level, context);
	const state = await captureControlStateV0(lane, context);
	return {
		schemaVersion: "control.v0",
		kind: "thinking.configured",
		lane: state.lane,
		configured: state.configuration.thinkingLevel,
	};
}

/** Configure the lane's active tool names, in the given order, for future generation snapshots. */
export async function configureActiveToolsV0(
	lane: Pick<AgentLane, "setActiveTools" | "watch">,
	names: string[],
	context: Context,
): Promise<Extract<ControlReceiptV0, { kind: "tools.configured" }>> {
	const requested = [...names];
	await lane.setActiveTools(requested, context);
	const state = await captureControlStateV0(lane, context);
	return {
		schemaVersion: "control.v0",
		kind: "tools.configured",
		lane: state.lane,
		configured: state.configuration.activeToolNames,
	};
}
