// Session overviews.
//
// `EndoSessionOverviewV0` is the overview Endophasia produces: a pure reduction of a recorded session's `lifecycle.*`
// events (protocol/session-lifecycle.ts) by `reduceEndoSessionOverviewV0` (runtime/contracts/session-overview.ts).
// It is rebuilt on every replay and holds nothing the recorded events do not: what the runtime does not report is
// listed as UNAVAILABLE with the adapter's reason, events out of lifecycle order are listed as anomalies, and event
// kinds this version does not know are listed as unrecognized rather than dropped.
//
// `SessionOverviewV0` and `SessionLaneOverviewV0` below are the fork-era lane inventory. They have no producer: the
// Pi-backed capture was fork-only and was removed (docs/pi-attach-inventory.md §5), and Pi 1.0's RPC has one session
// and no lanes. They are kept because the sealed Prime 0.9.7 study names `SessionOverviewV0` as a compared contract.
import type { JsonValueV0, ModelIdentityV0, OperationStatusV0 } from "./primitives.ts";
import type { EndoReportedV0, EndoUnavailableFieldV0 } from "./session-lifecycle.ts";

/** How a session's last run ended. */
export type EndoRunOutcomeV0 = "completed" | "failed" | "aborted" | "unclassified" | "interrupted";

/** The overview of one recorded session, reduced from its lifecycle events. */
export interface EndoSessionOverviewV0 {
	schemaVersion: "endo.session-overview.v0";
	/** Always "replayed": the overview is derived from recorded events only, never from a live query. */
	consistency: "replayed";
	/** The runtime session last attached to, as the runtime reported it. */
	session: EndoReportedV0<{ runtime: string; runtimeSessionId: string }>;
	/**
	 * - `not-observed`: no session was attached in the recorded events.
	 * - `idle`: attached, no run open.
	 * - `running`: attached, a run open.
	 * - `interrupted`: the last observation ended without a runtime-reported outcome, and nothing has attached since.
	 * - `detached`: the runtime process ended, with no run open.
	 */
	state: "not-observed" | "idle" | "running" | "interrupted" | "detached";
	attachments: { count: number; resumes: number; lastInstance: string | null };
	/** The open run, or null. */
	run: null | {
		turns: number;
		turnOpen: boolean;
		stop: {
			requested: boolean;
			accepted: boolean;
			/** The runtime's report that the run ended by abort; UNAVAILABLE until observed. */
			termination: EndoReportedV0<"aborted">;
		};
	};
	/** The last run that ended, or null. */
	lastRun: null | {
		outcome: EndoRunOutcomeV0;
		turns: number;
		stopReason: EndoReportedV0<string>;
		/** The runtime's reported failure cause for `failed`; the interruption for `interrupted`; else null. */
		cause: JsonValueV0;
		stopRequested: boolean;
	};
	counts: {
		runs: number;
		turns: number;
		completed: number;
		failed: number;
		aborted: number;
		unclassified: number;
		interrupted: number;
		compactions: number;
		stopsRequested: number;
		stopsAccepted: number;
		stopsRefused: number;
	};
	/** Fields the runtime does not report, with the adapter's reasons. */
	unavailable: EndoUnavailableFieldV0[];
	/** Recorded events that arrived in an order the lifecycle does not allow. */
	anomalies: { eventId: string; observed: string; problem: string }[];
	/** Lifecycle kinds this version does not define, and runtime event types the adapter did not recognize. */
	unrecognized: { eventId: string; kind: string; runtimeEvent: string | null }[];
	/** Events seen twice (same id) in the input; counted once. */
	duplicatesIgnored: number;
	/** The id of the last lifecycle event reduced, or null. */
	lastEventId: string | null;
}

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
