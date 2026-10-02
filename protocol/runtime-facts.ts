// The Runtime Facts v0 schemas: the Session's cumulative accounting and the durable terminal result of one
// operation. The service handle and the host facet are in runtime/contracts/runtime-facts.ts.

/**
 * A Session's maintained, session-wide accounting at one snapshot. It is not attributable to any lane.
 * Cumulative accounting, not current context-window occupancy. Recorded/accounted cost, not a provider invoice.
 * Totals include usage from failed, retried, and aborted attempts, plus caller adjustments, which may be negative.
 */
export interface RuntimeMetricsV0 {
	schemaVersion: "runtime-metrics.v0";
	scope: "session";
	/** Number of persisted `message` entries in the session, of any role. */
	messageCount: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		/** Present only once some accounted row reported it. Subset of cacheWrite. */
		cacheWrite1h?: number;
		/** Present only once some accounted row reported it. Subset of output. */
		reasoning?: number;
		/** Sum of reported totalTokens; not recomputed from the components. */
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
}

/**
 * Payload-minimal projection of the immutable terminal result record for one operation ID.
 * It carries no lane: the result lookup is keyed by operation ID only, so the lane used for the read does not
 * establish which lane ran the operation.
 */
export interface OperationOutcomeV0 {
	schemaVersion: "operation-outcome.v0";
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	status: "completed" | "declined" | "aborted" | "failed";
	fromTipId: string | null;
	tipId: string | null;
	startedAt: number;
	endedAt: number;
	/** The machine-readable error code only; message and details are never exposed. */
	errorCode?: string;
}
