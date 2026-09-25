import type { AgentLane, Context, SessionStats } from "@earendil-works/pi-agent-core";

/**
 * Pi's maintained, session-wide accounting at one snapshot, read through a lane's public watch().
 * The lane is only the access route; these totals are not attributable to it.
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

function projectStats(stats: SessionStats): RuntimeMetricsV0 {
	const { usage } = stats;
	return {
		schemaVersion: "runtime-metrics.v0",
		scope: "session",
		messageCount: stats.messageCount,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
			...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
			totalTokens: usage.totalTokens,
			cost: {
				input: usage.cost.input,
				output: usage.cost.output,
				cacheRead: usage.cost.cacheRead,
				cacheWrite: usage.cost.cacheWrite,
				total: usage.cost.total,
			},
		},
	};
}

/** Capture Pi's maintained session accounting with a short-lived watch. Read failures propagate. */
export async function captureRuntimeMetricsV0(
	lane: Pick<AgentLane, "watch">,
	context: Context,
): Promise<RuntimeMetricsV0> {
	const watch = await lane.watch(context);
	try {
		return projectStats(watch.snapshot.stats);
	} finally {
		watch.unsubscribe();
	}
}
