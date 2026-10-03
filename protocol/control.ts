// The Control Deck v0 schema: the lane's configured controls from one atomic snapshot, and the readback receipts. The
// Pi-backed capture and setters are in adapters/pi/control-deck.ts. No Endophasia service exposes Control yet: it is a
// direct runtime operation, not behind an observation port.
import type { ModelIdentityV0, OperationStatusV0, ThinkingLevelV0 } from "./primitives.ts";

/**
 * A lane's latest configured model, thinking level, and active tools, from one atomic Pi lane snapshot.
 * This is the configuration future generation snapshots will capture; an in-flight provider request keeps the
 * configuration it already captured.
 */
export interface ControlStateV0 {
	schemaVersion: "control-state.v0";
	lane: string;
	configuration: {
		model: ModelIdentityV0;
		thinkingLevel: ThinkingLevelV0;
		activeToolNames: string[];
	};
	/** Present when work is in flight: a configuration change applies to its later turns, not its current request. */
	operation: null | {
		operationId: string;
		kind: "run" | "compaction" | "navigation";
		status: OperationStatusV0;
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
			configured: ModelIdentityV0;
	  }
	| { schemaVersion: "control.v0"; kind: "thinking.configured"; lane: string; configured: ThinkingLevelV0 }
	| { schemaVersion: "control.v0"; kind: "tools.configured"; lane: string; configured: string[] };
