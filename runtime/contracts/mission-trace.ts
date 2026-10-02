// The Mission Trace service, host facet, and wire projection. The v0 event schema is in protocol/mission-trace.ts; the
// Pi-backed source in adapters/pi/mission-trace.ts.
import { defineFacet, defineService, type Facet, type ReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	MISSION_TRACE_REPLICATED_EVENT_LIMIT,
	type MissionTraceEventV0,
	type MissionTraceObservationV0,
} from "../../protocol/mission-trace.ts";
import type { RuntimeMissionTraceSourceV0 } from "../observation/ports.ts";

/** Live, read-only Mission Trace v0 observations exposed through Chord's remote service boundary. */
export interface EndophasiaMissionTraceV0 {
	readonly state: ReplicatedState<MissionTraceObservationV0>;
}

export const EndophasiaMissionTraceV0 = defineService<EndophasiaMissionTraceV0>("endophasia.mission-trace.v0");

/**
 * The event as the v0 schema defines it, field for field and in its field order: whatever else a source's object
 * carries (a payload, a runtime-native field) never crosses the service boundary.
 */
function missionTraceEventV0(event: MissionTraceEventV0): MissionTraceEventV0 {
	const { schemaVersion, sequence } = event;
	switch (event.kind) {
		case "turn.started":
		case "turn.finished":
			return {
				kind: event.kind,
				lane: event.lane,
				runId: event.runId,
				turnId: event.turnId,
				schemaVersion,
				sequence,
			};
		case "tool.started":
			return {
				kind: event.kind,
				lane: event.lane,
				runId: event.runId,
				turnId: event.turnId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				schemaVersion,
				sequence,
			};
		case "tool.finished":
			return {
				kind: event.kind,
				lane: event.lane,
				runId: event.runId,
				turnId: event.turnId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				schemaVersion,
				sequence,
			};
		default:
			return { kind: event.kind, lane: event.lane, runId: event.runId, schemaVersion, sequence };
	}
}

/**
 * Provide EndophasiaMissionTraceV0 from one Mission Trace source for the facet's lifetime. Nothing but the replicated
 * state's bounded trailing window is retained, so memory stays bounded however long the worker lives. The host owns
 * the authoritative state; consumers receive immutable replicated revisions. The facet knows nothing of how a runtime
 * produces its lifecycle: the source delivers finished Mission Trace v0 events.
 */
export function createEndophasiaMissionTraceFacetV0(source: RuntimeMissionTraceSourceV0): Facet {
	// An absent capability is never replaced by an empty trace: a runtime without one does not install this facet.
	if (source === undefined || source === null) throw new TypeError("A Mission Trace source is required");
	return defineFacet({
		id: "@endophasia/mission-trace",
		setup(env) {
			const state = env.replicatedState<MissionTraceObservationV0>({
				schemaVersion: "mission-trace-observation.v0",
				scope: "session-worker-lifetime",
				events: [],
			});
			env.provide(EndophasiaMissionTraceV0, { state });
			// Observe from setup, before any other worker service runs, so the trace covers the whole worker lifetime.
			const stop = source.observe((event) => {
				const retained = missionTraceEventV0(event);
				state.change(BACKGROUND_CONTEXT, (draft) => {
					// Dropping the oldest event and appending the newest replicates as two small splices, not the window.
					if (draft.events.length >= MISSION_TRACE_REPLICATED_EVENT_LIMIT) {
						draft.events.splice(0, draft.events.length - MISSION_TRACE_REPLICATED_EVENT_LIMIT + 1);
					}
					draft.events.push(retained);
				});
			});
			env.own(stop);
		},
	});
}
