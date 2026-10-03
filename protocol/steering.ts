// The Steering v0 schema: receipts, actions, rejection reasons, and the atomic lane snapshot projection. The Pi-backed
// actions and capture are in adapters/pi/steering.ts. No Endophasia service exposes Steering yet: it is a direct
// runtime operation, not behind an observation port.
import type { OperationStatusV0 } from "./primitives.ts";

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
		status: OperationStatusV0;
	};
	queues: { steer: string[]; followUp: string[] };
}
