/**
 * @cline/agents
 *
 * Browser-safe agent runtime for the next-generation Cline SDK.
 *
 * Exports:
 *   - `AgentRuntime` / `Agent` — the agentic loop class (two names for the
 *     same class). Use `Agent` when supplying provider/model IDs, or
 *     `AgentRuntime` when supplying a pre-built `AgentModel`.
 *   - `createAgentRuntime` / `createAgent` — factory-function equivalents.
 *   - `AgentRuntimeConfig` and its two variants (`AgentRuntimeConfigWithModel`,
 *     `AgentRuntimeConfigWithProvider`) — the discriminated config union.
 *   - `AgentRunInput` / `AgentEventListener` — convenience type aliases.
 *   - `createTool` — re-exported from `@cline/shared` for authoring tools.
 *
 * Shared types (`AgentMessage`, `AgentRunResult`, etc.) should be imported
 * directly from `@cline/shared`.
 */

export type {
	AgentAfterToolResult,
	AgentBeforeModelResult,
	AgentBeforeToolResult,
	AgentMessage,
	AgentMessagePart,
	AgentModel,
	AgentModelFinishReason,
	AgentModelRequest,
	AgentRunResult,
	AgentRuntimeConfig as BaseAgentRuntimeConfig,
	AgentRuntimeEvent,
	AgentRuntimeHooks,
	AgentRuntimeStateSnapshot,
	AgentStopControl,
	AgentTool,
	AgentToolCallPart,
	AgentToolDefinition,
	AgentToolResult,
	AgentUsage,
	ToolApprovalResult,
	ToolPolicy,
} from "@cline/shared";
export { createTool } from "@cline/shared";
export type {
	AgentEventListener,
	AgentRunInput,
	AgentRuntimeConfig,
	AgentRuntimeConfigWithModel,
	AgentRuntimeConfigWithProvider,
} from "./agent-runtime";
export {
	Agent,
	AgentRuntime,
	AgentRuntimeAbortError,
	createAgent,
	createAgentRuntime,
} from "./agent-runtime";

// =============================================================================
// Mission Trace v0 — passive, deterministic semantic projection of
// AgentRuntimeEvent. Experimental. Subject to change.
// =============================================================================

export type {
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
	MissionTraceSchemaVersion,
} from "./mission-trace/types";
export { isMissionTraceEventV0, missionTraceEventKind } from "./mission-trace/types";
export {
	MissionTraceProjectorV0,
} from "./mission-trace/projector";
export { MissionTraceSinkV0, type MissionTraceSnapshotV0 } from "./mission-trace/sink";
export { attachMissionTraceV0, type MissionTraceAttachment } from "./mission-trace/attach";
