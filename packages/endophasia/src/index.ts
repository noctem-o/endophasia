import type { AgentHarness } from "@earendil-works/pi-agent-core";

export type { ContinuityEntryV0, ContinuitySnapshotV0 } from "./continuity.ts";
export { captureContinuityV0 } from "./continuity.ts";
export type { OperationOutcomeV0 } from "./durable-outcomes.ts";
export { captureOperationOutcomeV0 } from "./durable-outcomes.ts";
export type { RuntimeMetricsV0 } from "./runtime-metrics.ts";
export { captureRuntimeMetricsV0 } from "./runtime-metrics.ts";
export type { SessionLaneOverviewV0, SessionOverviewV0 } from "./session-overview.ts";
export { captureSessionOverviewV0 } from "./session-overview.ts";
export type {
	SteeringActionResultV0,
	SteeringActionV0,
	SteeringReceiptV0,
	SteeringRejectionReasonV0,
	SteeringStateV0,
} from "./steering.ts";
export { captureSteeringStateV0, queueFollowUpV0, steerV0, stopV0 } from "./steering.ts";

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

type TraceInputV0 = MissionTraceEventV0 extends infer Event
	? Event extends MissionTraceEventV0
		? Omit<Event, "schemaVersion" | "sequence">
		: never
	: never;

export interface MissionTraceAttachmentV0 {
	sinceSequence(from: number): MissionTraceEventV0[];
	detach(): void;
}

/** Observe only the selected public harness lifecycle events during this attachment's lifetime. */
export function attachMissionTraceV0(harness: Pick<AgentHarness, "events">): MissionTraceAttachmentV0 {
	const recorded: MissionTraceEventV0[] = [];
	let active = true;
	const unsubscribe = [
		harness.events.on("run_start", ({ lane, runId }) => append({ kind: "mission.started", lane, runId })),
		harness.events.on("run_resume", ({ lane, runId }) => append({ kind: "mission.resumed", lane, runId })),
		harness.events.on("run_suspend", ({ lane, runId }) => append({ kind: "mission.suspended", lane, runId })),
		harness.events.on("turn_start", ({ lane, runId, turnId }) =>
			append({ kind: "turn.started", lane, runId, turnId }),
		),
		harness.events.on("message_end", ({ lane, runId, message }) => {
			if (message.role === "assistant" && runId !== undefined) {
				append({ kind: "model.completed", lane, runId });
			}
		}),
		harness.events.on("tool_start", ({ lane, runId, turnId, toolCallId, toolName }) =>
			append({ kind: "tool.started", lane, runId, turnId, toolCallId, toolName }),
		),
		harness.events.on("tool_end", ({ lane, runId, turnId, toolCallId, toolName, isError }) =>
			append({ kind: "tool.finished", lane, runId, turnId, toolCallId, toolName, isError }),
		),
		harness.events.on("turn_end", ({ lane, runId, turnId }) =>
			append({ kind: "turn.finished", lane, runId, turnId }),
		),
		harness.events.on("run_end", ({ lane, runId, status }) => {
			const kind = {
				completed: "mission.completed",
				aborted: "mission.aborted",
				failed: "mission.failed",
			} as const;
			append({ kind: kind[status], lane, runId });
		}),
	];

	function append(event: TraceInputV0): void {
		if (!active) return;
		recorded.push({
			...event,
			schemaVersion: "mission-trace.v0",
			sequence: recorded.length + 1,
		} as MissionTraceEventV0);
	}

	return {
		sinceSequence(from) {
			if (!Number.isSafeInteger(from) || from < 0) throw new RangeError("Invalid Mission Trace cursor");
			return recorded.slice(from).map((event) => ({ ...event }));
		},
		detach() {
			if (!active) return;
			active = false;
			for (const remove of unsubscribe) remove();
		},
	};
}
