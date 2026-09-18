// =============================================================================
// Attach Mission Trace v0 to an AgentRuntime through its public subscribe() API.
// =============================================================================

import type { AgentRuntime, AgentEventListener } from "../agent-runtime";
import { MissionTraceProjectorV0 } from "./projector";
import { MissionTraceSinkV0 } from "./sink";

// -----------------------------------------------------------------------------
// Attachment
// -----------------------------------------------------------------------------

export interface MissionTraceAttachment {
  /** The sink that collected projected events for the attachment's lifetime. */
  sink: MissionTraceSinkV0;
  /** Call to unsubscribe and stop projecting further runtime events. */
  detach: () => void;
}

/**
 * Attach Mission Trace v0 observation to an existing AgentRuntime.
 *
 *   - Subscribes to the runtime's public `subscribe()` listener.
 *   - Projects each runtime event through MissionTraceProjectorV0.
 *   - Appends projected events to a fresh in-memory sink.
 *   - Returns an unsubscribe/detach function plus the sink.
 *
 * After detach, later runtime events do not reach the trace sink. The sink
 * remains readable (holds a snapshot of what was collected before detach).
 */
export function attachMissionTraceV0(runtime: AgentRuntime): MissionTraceAttachment {
  const projector = new MissionTraceProjectorV0();
  const sink = new MissionTraceSinkV0();

  const listener: AgentEventListener = (event) => {
    const projected = projector.project(event);
    if (projected !== undefined) {
      sink.append(projected);
    }
  };

  const detach = runtime.subscribe(listener);

  return { sink, detach };
}
