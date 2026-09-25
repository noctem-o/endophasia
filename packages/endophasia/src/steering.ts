import { type AgentLane, type Context, HarnessClosed, type OperationStatus } from "@earendil-works/pi-agent-core";

export type SteeringReceiptV0 =
	| { schemaVersion: "steering.v0"; kind: "steer.accepted"; lane: string; entryId: string }
	| { schemaVersion: "steering.v0"; kind: "queue.accepted"; lane: string; entryId: string }
	| {
			schemaVersion: "steering.v0";
			kind: "stop.requested";
			lane: string;
			operationId: string;
			newlyRequested: boolean;
			clearedSteerCount: number;
			clearedFollowUpCount: number;
	  };

export type SteeringActionV0 = "steer" | "queue" | "stop";
export type SteeringRejectionReasonV0 =
	| "invalid-message"
	| "closed"
	| "no-active-operation"
	| "active-operation-is-not-run"
	| "operation-changed";

export type SteeringActionResultV0<TReceipt extends SteeringReceiptV0 = SteeringReceiptV0> =
	| { ok: true; receipt: TReceipt }
	| { ok: false; action: SteeringActionV0; reason: SteeringRejectionReasonV0 };

export interface SteeringStateV0 {
	schemaVersion: "steering-state.v0";
	lane: string;
	operation: null | {
		operationId: string;
		kind: "run" | "compaction" | "navigation";
		status: OperationStatus;
	};
	queues: { steer: string[]; followUp: string[] };
}

/** Submit text to Pi's durable steer queue. Acceptance says nothing about later consumption. */
export async function steerV0(
	lane: Pick<AgentLane, "name" | "steer">,
	text: string,
	context: Context,
): Promise<SteeringActionResultV0<Extract<SteeringReceiptV0, { kind: "steer.accepted" }>>> {
	try {
		const result = await lane.steer(text, undefined, context);
		if (!result.ok) {
			return { ok: false, action: "steer", reason: result.error._tag === "Closed" ? "closed" : "invalid-message" };
		}
		return {
			ok: true,
			receipt: {
				schemaVersion: "steering.v0",
				kind: "steer.accepted",
				lane: lane.name,
				entryId: result.value.entryId,
			},
		};
	} catch (error) {
		if (error instanceof HarnessClosed) return { ok: false, action: "steer", reason: "closed" };
		throw error;
	}
}

/** Submit text to Pi's durable follow-up queue. Acceptance says nothing about later execution. */
export async function queueFollowUpV0(
	lane: Pick<AgentLane, "name" | "followUp">,
	text: string,
	context: Context,
): Promise<SteeringActionResultV0<Extract<SteeringReceiptV0, { kind: "queue.accepted" }>>> {
	try {
		const result = await lane.followUp(text, undefined, context);
		if (!result.ok) {
			return { ok: false, action: "queue", reason: result.error._tag === "Closed" ? "closed" : "invalid-message" };
		}
		return {
			ok: true,
			receipt: {
				schemaVersion: "steering.v0",
				kind: "queue.accepted",
				lane: lane.name,
				entryId: result.value.entryId,
			},
		};
	} catch (error) {
		if (error instanceof HarnessClosed) return { ok: false, action: "queue", reason: "closed" };
		throw error;
	}
}

/** Request cancellation only of the run observed by inspectExecution. Never retarget a newer operation. */
export async function stopV0(
	lane: Pick<AgentLane, "inspectExecution" | "requestAbort">,
	context: Context,
): Promise<SteeringActionResultV0<Extract<SteeringReceiptV0, { kind: "stop.requested" }>>> {
	try {
		const execution = await lane.inspectExecution(context);
		if (execution.current === null) return { ok: false, action: "stop", reason: "no-active-operation" };
		if (execution.current.kind !== "run") {
			return { ok: false, action: "stop", reason: "active-operation-is-not-run" };
		}
		const result = await lane.requestAbort(execution.current.id, context);
		if (!result.ok) {
			return { ok: false, action: "stop", reason: result.error._tag === "Closed" ? "closed" : "operation-changed" };
		}
		return {
			ok: true,
			receipt: {
				schemaVersion: "steering.v0",
				kind: "stop.requested",
				lane: execution.lane,
				operationId: result.value.operationId,
				newlyRequested: result.value.newlyRequested,
				clearedSteerCount: result.value.steer.length,
				clearedFollowUpCount: result.value.followUp.length,
			},
		};
	} catch (error) {
		if (error instanceof HarnessClosed) return { ok: false, action: "stop", reason: "closed" };
		throw error;
	}
}

/** Read only accepted conversational queue identities from one atomic Pi lane snapshot. */
export async function captureSteeringStateV0(
	lane: Pick<AgentLane, "watch">,
	context: Context,
): Promise<SteeringStateV0> {
	const watch = await lane.watch(context);
	try {
		const point = watch.snapshot;
		return {
			schemaVersion: "steering-state.v0",
			lane: point.lane,
			operation:
				point.operation === null
					? null
					: {
							operationId: point.operation.id,
							kind: point.operation.kind,
							status: point.operation.status,
						},
			queues: {
				steer: point.queues.filter((item) => item.kind === "steer").map((item) => item.entryId),
				followUp: point.queues.filter((item) => item.kind === "followUp").map((item) => item.entryId),
			},
		};
	} finally {
		watch.unsubscribe();
	}
}
