// The session overview reducer: recorded `lifecycle.*` events in, one EndoSessionOverviewV0 out
// (protocol/session-overview.ts). Pure and deterministic: the same events in the same order give the same overview,
// byte for byte, on every replay. Other event kinds are ignored; an event id seen twice is counted once.
//
// The reducer trusts nothing about payload shape. A lifecycle event whose payload lacks what its kind needs is listed
// as an anomaly instead of being half-applied; a `lifecycle.*` kind this version does not define is listed as
// unrecognized instead of being dropped.

import type { EndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	type EndoReportedV0,
	type EndoUnavailableFieldV0,
	endoReportedV0,
	endoUnavailableV0,
	isEndoLifecycleKindV0,
} from "../../protocol/session-lifecycle.ts";
import type { EndoRunOutcomeV0, EndoSessionOverviewV0 } from "../../protocol/session-overview.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reported(value: unknown): EndoReportedV0<string> | null {
	if (!isRecord(value)) return null;
	if (value.status === "reported" && typeof value.value === "string") return endoReportedV0(value.value);
	if (value.status === "UNAVAILABLE" && typeof value.reason === "string") return endoUnavailableV0(value.reason);
	return null;
}

const NOT_YET_OBSERVED = "no termination has been observed for this run";

/** Reduce recorded events to the overview of the session they record. */
export function reduceEndoSessionOverviewV0(events: readonly EndoEventV0[]): EndoSessionOverviewV0 {
	const overview: EndoSessionOverviewV0 = {
		schemaVersion: "endo.session-overview.v0",
		consistency: "replayed",
		session: endoUnavailableV0("no session attachment has been recorded"),
		state: "not-observed",
		attachments: { count: 0, resumes: 0, lastInstance: null },
		run: null,
		lastRun: null,
		counts: {
			runs: 0,
			turns: 0,
			completed: 0,
			failed: 0,
			aborted: 0,
			unclassified: 0,
			interrupted: 0,
			compactions: 0,
			stopsRequested: 0,
			stopsAccepted: 0,
			stopsRefused: 0,
		},
		unavailable: [],
		anomalies: [],
		unrecognized: [],
		duplicatesIgnored: 0,
		lastEventId: null,
	};
	const seen = new Set<string>();
	const anomaly = (event: EndoEventV0, problem: string): void => {
		overview.anomalies.push({ eventId: event.id, observed: event.kind, problem });
	};
	const endRun = (outcome: EndoRunOutcomeV0, payload: Record<string, unknown>, cause: JsonValueV0): void => {
		const run = overview.run;
		overview.lastRun = {
			outcome,
			turns: typeof payload.turns === "number" ? payload.turns : (run?.turns ?? 0),
			stopReason: reported(payload.stopReason) ?? endoUnavailableV0("the runtime reported no stop reason"),
			cause,
			stopRequested: payload.stopRequested === true || run?.stop.requested === true,
		};
		overview.counts[outcome] += 1;
		overview.run = null;
	};

	for (const event of events) {
		if (!event.kind.startsWith("lifecycle.")) continue;
		if (seen.has(event.id)) {
			overview.duplicatesIgnored += 1;
			continue;
		}
		seen.add(event.id);
		overview.lastEventId = event.id;
		const payload = isRecord(event.payload) ? event.payload : {};
		if (!isEndoLifecycleKindV0(event.kind)) {
			overview.unrecognized.push({ eventId: event.id, kind: event.kind, runtimeEvent: null });
			continue;
		}
		switch (event.kind) {
			case "lifecycle.session-started":
			case "lifecycle.session-resumed": {
				if (typeof payload.runtime !== "string" || typeof payload.runtimeSessionId !== "string") {
					anomaly(event, "a session start without the runtime or its session id");
					break;
				}
				overview.session = endoReportedV0({ runtime: payload.runtime, runtimeSessionId: payload.runtimeSessionId });
				overview.attachments.count += 1;
				if (event.kind === "lifecycle.session-resumed") overview.attachments.resumes += 1;
				overview.attachments.lastInstance = typeof payload.instance === "string" ? payload.instance : null;
				if (Array.isArray(payload.unavailable)) {
					const declared: EndoUnavailableFieldV0[] = [];
					for (const entry of payload.unavailable as unknown[]) {
						if (isRecord(entry) && typeof entry.field === "string" && typeof entry.reason === "string")
							declared.push({ field: entry.field, reason: entry.reason });
					}
					overview.unavailable = declared;
				}
				overview.run = null;
				overview.state = "idle";
				break;
			}
			case "lifecycle.run-started":
				overview.counts.runs += 1;
				overview.run = {
					turns: 0,
					turnOpen: false,
					stop: { requested: false, accepted: false, termination: endoUnavailableV0(NOT_YET_OBSERVED) },
				};
				overview.state = "running";
				break;
			case "lifecycle.turn-started":
				if (overview.run === null) {
					anomaly(event, "a turn started with no run open");
					break;
				}
				overview.run.turns += 1;
				overview.run.turnOpen = true;
				overview.counts.turns += 1;
				break;
			case "lifecycle.turn-completed":
				if (overview.run === null) {
					anomaly(event, "a turn completed with no run open");
					break;
				}
				overview.run.turnOpen = false;
				break;
			case "lifecycle.run-completed":
				endRun("completed", payload, null);
				overview.state = "idle";
				break;
			case "lifecycle.run-failed":
				endRun("failed", payload, (payload.cause ?? null) as JsonValueV0);
				overview.state = "idle";
				break;
			case "lifecycle.run-aborted":
				if (overview.run !== null) overview.run.stop.termination = endoReportedV0("aborted");
				endRun("aborted", payload, null);
				overview.state = "idle";
				break;
			case "lifecycle.run-unclassified":
				endRun("unclassified", payload, null);
				overview.state = "idle";
				break;
			case "lifecycle.stop-requested":
				overview.counts.stopsRequested += 1;
				if (overview.run !== null) overview.run.stop.requested = true;
				break;
			case "lifecycle.stop-accepted":
				overview.counts.stopsAccepted += 1;
				if (overview.run !== null) overview.run.stop.accepted = true;
				break;
			case "lifecycle.stop-refused":
				overview.counts.stopsRefused += 1;
				break;
			case "lifecycle.interrupted": {
				const cause: JsonValueV0 = {
					cause: typeof payload.cause === "string" ? payload.cause : "unknown",
					...(isRecord(payload.exit) ? { exit: payload.exit as JsonValueV0 } : {}),
					...(payload.storeRecovery !== undefined ? { storeRecovery: payload.storeRecovery as JsonValueV0 } : {}),
				};
				if (payload.runOpen === true) {
					endRun("interrupted", { turns: payload.turns, stopRequested: payload.stopRequested }, cause);
				} else overview.run = null;
				overview.state = "interrupted";
				break;
			}
			case "lifecycle.detached":
				if (overview.run !== null) anomaly(event, "a detach recorded while a run is open");
				overview.run = null;
				overview.state = "detached";
				break;
			case "lifecycle.compacted":
				overview.counts.compactions += 1;
				break;
			case "lifecycle.anomaly":
				overview.anomalies.push({
					eventId: event.id,
					observed: typeof payload.observed === "string" ? payload.observed : "unknown",
					problem: typeof payload.problem === "string" ? payload.problem : "unspecified",
				});
				break;
			case "lifecycle.unrecognized-runtime-event":
				overview.unrecognized.push({
					eventId: event.id,
					kind: event.kind,
					runtimeEvent: typeof payload.runtimeEvent === "string" ? payload.runtimeEvent : null,
				});
				break;
		}
	}
	return overview;
}
