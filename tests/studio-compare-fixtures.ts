// Retained sanitised recordings, never active sessions. Shared by pure frontend models and production-server browser tests.
import { readFileSync } from "node:fs";
import { importDshSessionBytesV0 } from "../adapters/dsh-native/import.ts";
import { projectDshTrajectoryV0 } from "../adapters/dsh-native/trajectory.ts";
import { projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import { projectEndoCockpitTrajectoryComparisonV0 } from "../cockpit/index.ts";
import { projectEndoCockpitCompareCandidatesV0 } from "../cockpit-http/candidates.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

export function comparePiEvents(name = "baseline", session = "endo.session.pi.a"): EndoEventV0[] {
	return readFileSync(new URL(`./fixtures/trajectory/fake-pi/${name}.events.jsonl`, import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map((line, i) => {
			const e = JSON.parse(line) as EndoEventV0;
			return {
				...e,
				id: `endo.event.compare.${session.slice(13)}.${i}`,
				coordinates: { ...e.coordinates, sessionId: session },
			};
		});
}
export function compareEvents(): EndoEventV0[] {
	const store = createEndoEventStoreV0();
	importDshSessionBytesV0(
		readFileSync(new URL("../research/dsh-native/fixtures/real/tool-read.events.jsonl", import.meta.url)),
		store,
		{ digestKey: OTHER_KEY, now: () => "2026-10-24T00:00:00Z" },
	);
	return [...comparePiEvents(), ...store.page({ limit: 10000 }).events];
}
export function compareRecords() {
	const events = compareEvents();
	const candidates = projectEndoCockpitCompareCandidatesV0(events, OTHER_KEY);
	const a = projectPiTrajectoryV0(events, { session: "endo.session.pi.a", store: "test" });
	const b = projectDshTrajectoryV0(events, {
		session: "endo.session.dsh.session-1",
		sessionKind: "endo-coordinate",
		store: "test",
	});
	return { candidates, comparison: projectEndoCockpitTrajectoryComparisonV0(a, b, OTHER_KEY) };
}
