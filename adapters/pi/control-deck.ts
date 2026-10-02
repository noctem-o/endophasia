// Pi-specific: captures and configures the lane's controls through Pi's lane snapshots and setters. The v0 schemas are
// in protocol/control.ts.
import type { AgentLane, Context } from "@earendil-works/pi-agent-core";
import type { ControlReceiptV0, ControlStateV0 } from "../../protocol/control.ts";
import type { ModelIdentityV0, ThinkingLevelV0 } from "../../protocol/primitives.ts";

// The schemas are the runtime-neutral contract's; re-exported for the modules that already import them from here.
export type { ControlReceiptV0, ControlStateV0 };

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
	model: ModelIdentityV0,
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
	level: ThinkingLevelV0,
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
