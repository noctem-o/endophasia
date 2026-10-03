// The Session Overview v0 schema: a payload-minimal, read-only inventory of a harness's lanes.
//
// Status: UNWIRED, planned protocol surface. Nothing in the tree produces or consumes it. Its Pi-backed capture and
// inspector service were fork-only and were removed with the vendored fork (docs/pi-attach-inventory.md §5). It is kept
// as the intended shape for the session lifecycle work and will be revised when a producer exists. Until then it
// describes no capability Endophasia has.
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
