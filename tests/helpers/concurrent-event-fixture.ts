import type { EndoEventV0 } from "../../protocol/event.ts";

export function concurrentEvent(attachment: string, sequence = 1): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: `endo.event.fixture.${attachment}.n${sequence}`,
		kind: "session.entry-observed",
		source: "runtime-fact",
		at: "2026-11-28T01:00:00Z",
		producer: `pi-rpc-adapter:${attachment}`,
		sequence,
		coordinates: { sessionId: `endo.session.${attachment}` },
		derivedFrom: [],
		payload: { sequence },
	};
}
