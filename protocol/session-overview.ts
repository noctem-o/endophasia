// The Session Overview v0 schema: a payload-minimal, read-only inventory of the harness's lanes. The service handle is
// in runtime/contracts/inspector.ts; the Pi-backed capture in adapters/pi/session-overview.ts.
import type { ModelIdentityV0, OperationStatusV0 } from "./primitives.ts";

export interface SessionLaneOverviewV0 {
	name: string;
	tipId: string | null;
	operation: null | {
		operationId: string;
		kind: "run" | "compaction" | "navigation";
		status: OperationStatusV0;
		startedAt: number;
		/** Model identity Pi captured into the open operation's current request state; not the lane's configured model. */
		capturedModel?: ModelIdentityV0;
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
