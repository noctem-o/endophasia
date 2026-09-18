// =============================================================================
// MissionTraceProjectorV0 — deterministic projection of AgentRuntimeEvent
// into MissionTraceEventV0.
//
// Rules:
//   - Zero or one v0 event per runtime event.
//   - Monotonically increasing sequence number across the projector lifetime.
//   - No Date.now(), no random IDs, no environment-dependent values.
//   - Correlation IDs reused from the runtime snapshot only when they already
//     exist. Missing stays missing.
//   - Does not capture raw reasoning, message content, or tool input/output.
//   - Ignores events that carry no semantic mission-trace value.
//   - Observational only — does NOT suppress subsequent runs after a terminal
//     event. Multiple sequential AgentRuntime.run()/continue() executions are
//     all traced with contiguous sequence numbers.
// =============================================================================

import type {
	AgentModelFinishReason,
	AgentRuntimeEvent,
	AgentRuntimeStateSnapshot,
	ProviderErrorClass,
} from "@cline/shared";
import type {
	MissionTraceEventV0,
	MissionTraceEventV0Started,
	MissionTraceEventV0TurnStarted,
	MissionTraceEventV0ModelCompleted,
	MissionTraceEventV0ToolStarted,
	MissionTraceEventV0ToolFinished,
	MissionTraceEventV0TurnFinished,
	MissionTraceEventV0Completed,
	MissionTraceEventV0Aborted,
	MissionTraceEventV0Failed,
} from "./types";

// -----------------------------------------------------------------------------
// Base helpers
// -----------------------------------------------------------------------------

/** Build the common correlation prefix from a runtime snapshot. */
function correlationFromSnapshot(
	snapshot: AgentRuntimeStateSnapshot,
): { agentId: string; runId?: string; conversationId?: string } {
	return {
		agentId: snapshot.agentId,
		runId: snapshot.runId ?? undefined,
		conversationId: snapshot.conversationId ?? undefined,
	};
}

// -----------------------------------------------------------------------------
// Ignored events — documented reasons
// -----------------------------------------------------------------------------

/**
 * Events intentionally ignored by MissionTraceProjectorV0:
 *
 *   - message-added            : transcript bookkeeping, not a semantic mission
 *                                 milestone.
 *   - assistant-text-delta    : streaming token chunks. Not a semantic event.
 *   - assistant-reasoning-delta : raw private reasoning. MUST NOT become trace
 *                                 content. Privacy boundary.
 *   - assistant-media         : media generation streaming.
 *   - tool-updated            : intermediate tool progress.
 *   - usage-updated           : token accounting. Not a semantic milestone.
 *   - status-notice           : informational/runtime notices.
 */

// -----------------------------------------------------------------------------
// Projector
// -----------------------------------------------------------------------------

export class MissionTraceProjectorV0 {
	private sequence = 0;

	/**
	 * Project an AgentRuntimeEvent into a MissionTraceEventV0, or return
	 * undefined when the event carries no semantic trace value.
	 *
	 * The projector is stateful: each call advances its internal sequence
	 * counter. Projection is deterministic for the same ordered runtime events.
	 * Multiple sequential runs are all traced — sequence continues monotonically
	 * across run boundaries. A persistent attachment MUST trace multiple
	 * AgentRuntime.run()/continue() executions. NO terminal suppression.
	 */
	project(event: AgentRuntimeEvent): MissionTraceEventV0 | undefined {
		const snapshot = event.snapshot;

		switch (event.type) {
			case "run-started":
				this.sequence += 1;
				return buildStarted(snapshot, this.sequence);

			case "turn-started": {
				this.sequence += 1;
				return buildTurnStarted(snapshot, event.iteration, this.sequence);
			}

			case "assistant-message": {
				this.sequence += 1;
				const modelInfo = event.message.modelInfo;
				return buildModelCompleted(
					snapshot,
					event.iteration,
					event.finishReason,
					this.sequence,
					modelInfo?.id,
					modelInfo?.provider,
				);
			}

			case "tool-started": {
				this.sequence += 1;
				return buildToolStarted(
					snapshot,
					event.iteration,
					event.toolCall.toolCallId,
					event.toolCall.toolName,
					this.sequence,
				);
			}

			case "tool-finished": {
				this.sequence += 1;
				return buildToolFinished(
					snapshot,
					event.iteration,
					event.toolCall.toolCallId,
					event.toolCall.toolName,
					this.sequence,
				);
			}

			case "turn-finished": {
				this.sequence += 1;
				return buildTurnFinished(
					snapshot,
					event.iteration,
					event.toolCallCount,
					this.sequence,
				);
			}

			case "run-finished": {
				this.sequence += 1;
				const result = event.result;
				const status = result.status;
				if (status === "aborted") {
					// Live: the runtime emits `run-finished` with
					// `status: "aborted"` when a run is aborted.
					return buildAborted(snapshot, result, this.sequence);
				}
				// Defensive: the runtime emits a genuine failure as `run-failed`
				// (not `run-finished`), so `status === "failed"` is a type-valid
				// but currently non-emitted branch. It is retained for robustness
				// in case a future runtime emits it, not as a live path.
				if (status === "failed") {
					return buildFailed(snapshot, result, this.sequence);
				}
				// "completed" and any other non-aborted, non-failed status
				return buildCompleted(snapshot, result, this.sequence);
			}

			case "run-failed": {
				this.sequence += 1;
				return buildFailedFromRunFailed(
					snapshot,
					event.errorClass,
					this.sequence,
				);
			}

			// Ignored events — no semantic mission-trace value.
			case "message-added":
			case "assistant-text-delta":
			case "assistant-reasoning-delta":
			case "assistant-media":
			case "tool-updated":
			case "usage-updated":
			case "status-notice":
				return undefined;
		}
	}
}

// -----------------------------------------------------------------------------
// Payload builders
// -----------------------------------------------------------------------------

function buildStarted(
	snapshot: AgentRuntimeStateSnapshot,
	sequence: number,
): MissionTraceEventV0Started {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "mission.started",
		...correlationFromSnapshot(snapshot),
	};
}

function buildTurnStarted(
	snapshot: AgentRuntimeStateSnapshot,
	iteration: number,
	sequence: number,
): MissionTraceEventV0TurnStarted {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "turn.started",
		...correlationFromSnapshot(snapshot),
		iteration,
	};
}

function buildModelCompleted(
	snapshot: AgentRuntimeStateSnapshot,
	iteration: number,
	finishReason: AgentModelFinishReason,
	sequence: number,
	modelId?: string,
	providerId?: string,
): MissionTraceEventV0ModelCompleted {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "model.completed",
		...correlationFromSnapshot(snapshot),
		iteration,
		finishReason,
		modelId,
		providerId,
	};
}

function buildToolStarted(
	snapshot: AgentRuntimeStateSnapshot,
	iteration: number,
	toolCallId: string,
	toolName: string,
	sequence: number,
): MissionTraceEventV0ToolStarted {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "tool.started",
		...correlationFromSnapshot(snapshot),
		iteration,
		toolCallId,
		toolName,
	};
}

function buildToolFinished(
	snapshot: AgentRuntimeStateSnapshot,
	iteration: number,
	toolCallId: string,
	toolName: string,
	sequence: number,
): MissionTraceEventV0ToolFinished {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "tool.finished",
		...correlationFromSnapshot(snapshot),
		iteration,
		toolCallId,
		toolName,
	};
}

function buildTurnFinished(
	snapshot: AgentRuntimeStateSnapshot,
	iteration: number,
	toolCallCount: number,
	sequence: number,
): MissionTraceEventV0TurnFinished {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "turn.finished",
		...correlationFromSnapshot(snapshot),
		iteration,
		toolCallCount,
	};
}

function buildCompleted(
	snapshot: AgentRuntimeStateSnapshot,
	result: { iterations: number },
	sequence: number,
): MissionTraceEventV0Completed {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "mission.completed",
		...correlationFromSnapshot(snapshot),
		iterations: result.iterations,
	};
}

function buildAborted(
	snapshot: AgentRuntimeStateSnapshot,
	result: { iterations: number },
	sequence: number,
): MissionTraceEventV0Aborted {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "mission.aborted",
		...correlationFromSnapshot(snapshot),
		iterations: result.iterations,
	};
}

function buildFailed(
	snapshot: AgentRuntimeStateSnapshot,
	result: { iterations: number; error?: Error },
	sequence: number,
): MissionTraceEventV0Failed {
	// Map runtime errors to ProviderErrorClass where possible.
	// The projector does not invent classifications — only propagates
	// what the runtime already classified via snapshot.lastErrorClass.
	const knownClass = snapshot.lastErrorClass;
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "mission.failed",
		...correlationFromSnapshot(snapshot),
		iterations: result.iterations,
		errorClass: knownClass ?? (result.error ? "unknown" : undefined),
	};
}

function buildFailedFromRunFailed(
	snapshot: AgentRuntimeStateSnapshot,
	errorClass: ProviderErrorClass | undefined,
	sequence: number,
): MissionTraceEventV0Failed {
	return {
		schemaVersion: "mission-trace.v0",
		sequence,
		kind: "mission.failed",
		...correlationFromSnapshot(snapshot),
		iterations: snapshot.iteration,
		errorClass,
	};
}
