// The Mission Trace v0 schema: the event vocabulary and the bounded replicated observation shape. The service
// handle and the host facet are in runtime/contracts/mission-trace.ts.

interface TraceBaseV0 {
	schemaVersion: "mission-trace.v0";
	sequence: number;
	lane: string;
}

interface RunTraceBaseV0 extends TraceBaseV0 {
	runId: string;
}

interface TurnTraceBaseV0 extends RunTraceBaseV0 {
	turnId: string;
}

interface ToolTraceBaseV0 extends TurnTraceBaseV0 {
	toolCallId: string;
	toolName: string;
}

export type MissionTraceEventV0 =
	| (RunTraceBaseV0 & { kind: "mission.started" })
	| (RunTraceBaseV0 & { kind: "mission.resumed" })
	| (RunTraceBaseV0 & { kind: "mission.suspended" })
	| (TurnTraceBaseV0 & { kind: "turn.started" })
	| (RunTraceBaseV0 & { kind: "model.completed" })
	| (ToolTraceBaseV0 & { kind: "tool.started" })
	| (ToolTraceBaseV0 & { kind: "tool.finished"; isError: boolean })
	| (TurnTraceBaseV0 & { kind: "turn.finished" })
	| (RunTraceBaseV0 & { kind: "mission.completed" })
	| (RunTraceBaseV0 & { kind: "mission.aborted" })
	| (RunTraceBaseV0 & { kind: "mission.failed" });

/**
 * Maximum number of Mission Trace events retained in the replicated observation. Every new or reconnecting consumer
 * receives the whole observation in one subscription snapshot, which must fit in one Pi frame (16 MiB by default).
 * A retained event is a few hundred bytes, so this window stays well under 1 MiB, while it is still far larger than
 * any consumer's view (the Standard Cockpit shows the latest 50 events).
 */
export const MISSION_TRACE_REPLICATED_EVENT_LIMIT = 1024;

/**
 * A bounded recent window of the Mission Trace a Session worker has observed since it activated. It is not durable
 * Session history: events from before activation or from a previous worker process are absent, and a new worker starts
 * again at sequence 1. Event order is the sequence order; the trace carries no event times.
 */
export interface MissionTraceObservationV0 {
	schemaVersion: "mission-trace-observation.v0";
	/**
	 * The lifetime being observed: the current Session worker's. It does not promise that every event of that lifetime
	 * is still retained here.
	 */
	scope: "session-worker-lifetime";
	/**
	 * The trailing window of at most MISSION_TRACE_REPLICATED_EVENT_LIMIT events, unchanged, with their original
	 * sequences and in sequence order. Older events are dropped from this window and cannot be retrieved through it; a
	 * first retained sequence above 1 means earlier events were dropped.
	 */
	events: MissionTraceEventV0[];
}
