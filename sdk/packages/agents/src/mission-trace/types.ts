// =============================================================================
// MissionTraceEventV0 — versioned, deterministic semantic projection of
// AgentRuntimeEvent. v0 is intentionally small and does NOT capture:
//
//   - raw reasoning / reasoning deltas
//   - full assistant message content
//   - arbitrary tool input/output
//   - wall-clock timestamps
//   - random identifiers
//
// Correlation IDs are reused from the runtime snapshot only when they
// already exist. Missing stays missing.
// =============================================================================

import type { AgentModelFinishReason, ProviderErrorClass } from "@cline/shared";

// -----------------------------------------------------------------------------
// Schema version
// -----------------------------------------------------------------------------

export type MissionTraceSchemaVersion = "mission-trace.v0";

// -----------------------------------------------------------------------------
// Common fields present on every v0 event
// -----------------------------------------------------------------------------

/** Every MissionTraceEventV0 identifies its schema version explicitly. */
export interface MissionTraceEventV0Base {
  /** Always `"mission-trace.v0"` for this version. */
  schemaVersion: MissionTraceSchemaVersion;
  /** Monotonically increasing per-projector sequence. Starts at 1. */
  sequence: number;
}

// -----------------------------------------------------------------------------
// Correlation identifiers (reused from runtime snapshot, never fabricated)
// -----------------------------------------------------------------------------

/** Stable agent identity, taken from runtime snapshot.agentId. */
export interface MissionTraceAgentCorrelation {
  /** Runtime agentId. Present on every runtime event's snapshot. */
  agentId: string;
  /**
   * Runtime runId when available. The runtime assigns a fresh runId at the
   * start of each run, before the first `run-started` event, so this is present
   * from `run-started` onward — absent only for events that precede run start.
   * */
  runId?: string;
  /** Runtime conversationId when available. */
  conversationId?: string;
}

// -----------------------------------------------------------------------------
// Semantic event vocabulary
// -----------------------------------------------------------------------------

/** The agent runtime began a run. */
export interface MissionTraceEventV0Started
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "mission.started";
}

/** A model turn began. */
export interface MissionTraceEventV0TurnStarted
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "turn.started";
  /** Runtime iteration number. */
  iteration: number;
}

/** The model produced a completed assistant message. */
export interface MissionTraceEventV0ModelCompleted
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "model.completed";
  /** Runtime iteration number. */
  iteration: number;
  /** Why the model stopped: stop | tool-calls | max-tokens | aborted | error. */
  finishReason: AgentModelFinishReason;
  /**
   * Model identifier when the runtime already attached one to the message.
   * Copied verbatim — never inferred. Absent when the runtime did not tag
   * the message.
   */
  modelId?: string;
  /**
   * Provider identifier when the runtime already attached one to the message.
   * Copied verbatim — never inferred. Absent when the runtime did not tag
   * the message.
   */
  providerId?: string;
}

/** A tool execution began. */
export interface MissionTraceEventV0ToolStarted
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "tool.started";
  /** Runtime iteration number. */
  iteration: number;
  /** Tool call identifier from the runtime event. */
  toolCallId: string;
  /** Tool name from the runtime event. */
  toolName: string;
}

/** A tool execution finished. */
export interface MissionTraceEventV0ToolFinished
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "tool.finished";
  /** Runtime iteration number. */
  iteration: number;
  /** Tool call identifier from the runtime event. */
  toolCallId: string;
  /** Tool name from the runtime event. */
  toolName: string;
}

/** A model turn finished (no pending tool calls or all tools done). */
export interface MissionTraceEventV0TurnFinished
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "turn.finished";
  /** Runtime iteration number. */
  iteration: number;
  /** Number of tool calls executed in this turn. */
  toolCallCount: number;
}

/** The mission completed normally. Exactly one terminal event per ordinary run. */
export interface MissionTraceEventV0Completed
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "mission.completed";
  /** Total runtime iterations for this mission. */
  iterations: number;
}

/** The mission was aborted (controlled stop / user cancellation). */
export interface MissionTraceEventV0Aborted
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "mission.aborted";
  /** Total runtime iterations before abort. */
  iterations: number;
}

/** The mission failed with an error. */
export interface MissionTraceEventV0Failed
  extends MissionTraceEventV0Base,
    MissionTraceAgentCorrelation {
  kind: "mission.failed";
  /** Total runtime iterations before failure. */
  iterations: number;
  /**
   * Structured provider error classification when the runtime already
   * classified it. Copied verbatim. Absent when the runtime did not classify
   * the error.
   */
  errorClass?: ProviderErrorClass;
}

// -----------------------------------------------------------------------------
// Union
// -----------------------------------------------------------------------------

export type MissionTraceEventV0 =
  | MissionTraceEventV0Started
  | MissionTraceEventV0TurnStarted
  | MissionTraceEventV0ModelCompleted
  | MissionTraceEventV0ToolStarted
  | MissionTraceEventV0ToolFinished
  | MissionTraceEventV0TurnFinished
  | MissionTraceEventV0Completed
  | MissionTraceEventV0Aborted
  | MissionTraceEventV0Failed;

// -----------------------------------------------------------------------------
// Narrowing helpers
// -----------------------------------------------------------------------------

/** The schema-valid `kind` values for a MissionTraceEventV0. */
const MISSION_TRACE_KINDS = new Set<string>([
	"mission.started",
	"turn.started",
	"model.completed",
	"tool.started",
	"tool.finished",
	"turn.finished",
	"mission.completed",
	"mission.aborted",
	"mission.failed",
]);

/** The valid `finishReason` literals, required on `model.completed`. */
const MISSION_TRACE_FINISH_REASONS = new Set<AgentModelFinishReason>([
	"stop",
	"tool-calls",
	"max-tokens",
	"aborted",
	"error",
]);

/**
 * Per-kind fields required in addition to the common envelope
 * (schemaVersion, kind, agentId, sequence) and the optional correlation
 * identifiers (runId, conversationId). Each entry is `[field, type]`.
 *
 * Optional fields (modelId, providerId, errorClass, runId, conversationId)
 * are intentionally omitted — the guard does not require them.
 */
const MISSION_TRACE_REQUIRED_FIELDS: Record<
	string,
	readonly [string, "number" | "string"][]
> = {
	"mission.started": [],
	"turn.started": [["iteration", "number"]],
	"model.completed": [["iteration", "number"], ["finishReason", "string"]],
	"tool.started": [
		["iteration", "number"],
		["toolCallId", "string"],
		["toolName", "string"],
	],
	"tool.finished": [
		["iteration", "number"],
		["toolCallId", "string"],
		["toolName", "string"],
	],
	"turn.finished": [["iteration", "number"], ["toolCallCount", "number"]],
	"mission.completed": [["iterations", "number"]],
	"mission.aborted": [["iterations", "number"]],
	"mission.failed": [["iterations", "number"]],
};

function isKindComplete(rec: Record<string, unknown>, kind: string): boolean {
	const required = MISSION_TRACE_REQUIRED_FIELDS[kind];
	if (!required) {
		return false;
	}
	for (const [field, type] of required) {
		const value = rec[field];
		if (value === undefined) {
			return false;
		}
		if (type === "number") {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return false;
			}
		} else if (typeof value !== "string") {
			return false;
		}
		if (field === "finishReason") {
			if (!MISSION_TRACE_FINISH_REASONS.has(value as AgentModelFinishReason)) {
				return false;
			}
		}
	}
	return true;
}

export function isMissionTraceEventV0(
	value: unknown,
): value is MissionTraceEventV0 {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const rec = value as Record<string, unknown>;
	return (
		rec.schemaVersion === "mission-trace.v0" &&
		typeof rec.kind === "string" &&
		MISSION_TRACE_KINDS.has(rec.kind) &&
		typeof rec.agentId === "string" &&
		typeof rec.sequence === "number" &&
		Number.isInteger(rec.sequence) &&
		rec.sequence >= 1 &&
		isKindComplete(rec, rec.kind)
	);
}

/** Return the kind string for a v0 event, or null for non-v0 values. */
export function missionTraceEventKind(
  event: unknown,
): string | null {
  if (!isMissionTraceEventV0(event)) return null;
  return (event as MissionTraceEventV0).kind;
}
