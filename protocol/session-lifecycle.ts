// The canonical session lifecycle: how a recorded runtime session starts, runs, ends, stops, is interrupted and is
// resumed, as `lifecycle.*` events.
//
// Lifecycle events are interpretations (source "interpretation"). Each derives from exactly one recorded event
// (`derivedFrom`) by a deterministic rule in the producing adapter (adapters/pi/lifecycle.ts for Pi), so the lifecycle
// stream can be rebuilt from the recorded events and must come out identical. They carry what the runtime reported and
// nothing it did not: a field the runtime does not report is UNAVAILABLE with a reason, never filled in.
//
// Two things are kept apart on purpose:
// - a STOP's request and acceptance (what the operator asked and what the runtime acknowledged) versus the observed
//   termination of the run (`lifecycle.run-aborted`, from the runtime's own stop reason). Acceptance is not evidence
//   that the run ended, and an aborted run is not evidence that a STOP caused it.
// - a run's outcome as the runtime reported it (`completed`, `failed` with the runtime's own cause, `aborted`) versus
//   an interruption the observer recorded (`lifecycle.interrupted`: the runtime process exited, or the observer itself
//   ended without recording an exit). An interrupted run has no runtime-reported outcome.

import type { JsonValueV0 } from "./primitives.ts";

/** A value the runtime reported, or the reason it is not available. Never a default standing in for a gap. */
export type EndoReportedV0<T> = { status: "reported"; value: T } | { status: "UNAVAILABLE"; reason: string };

export function endoReportedV0<T>(value: T): EndoReportedV0<T> {
	return { status: "reported", value };
}

export function endoUnavailableV0<T = never>(reason: string): EndoReportedV0<T> {
	return { status: "UNAVAILABLE", reason };
}

/** The lifecycle event kinds this version defines. A consumer must surface any other `lifecycle.*` kind, not drop it. */
export const ENDO_LIFECYCLE_KINDS_V0 = [
	/** First attachment to a runtime session. Payload: runtime, runtimeSessionId, instance, unavailable[]. */
	"lifecycle.session-started",
	/** A later attachment to a session already recorded. Payload: + previousInstance, previousEnd. */
	"lifecycle.session-resumed",
	/** A session-level run began (the first low-level run while idle). Payload: instance. */
	"lifecycle.run-started",
	/** Payload: turn (1-based within the run, counted by the observer). */
	"lifecycle.turn-started",
	/** Payload: turn, stopReason (reported or UNAVAILABLE). */
	"lifecycle.turn-completed",
	/** The run settled and its last assistant stop reason was not an error or an abort. Payload: turns, stopReason. */
	"lifecycle.run-completed",
	/** The run settled after a reported failure. Payload: turns, cause (the runtime's own cause, or UNAVAILABLE). */
	"lifecycle.run-failed",
	/** The run settled with the runtime reporting an abort. Payload: turns, stopRequested. */
	"lifecycle.run-aborted",
	/** The run settled with no terminal stop reason observed. Payload: turns, reason. */
	"lifecycle.run-unclassified",
	/** The operator asked the runtime to stop. Payload: runOpen. */
	"lifecycle.stop-requested",
	/** The runtime acknowledged a stop request. Payload: runOpen. Not evidence of termination. */
	"lifecycle.stop-accepted",
	/** The runtime refused a stop request. Payload: runOpen. */
	"lifecycle.stop-refused",
	/**
	 * Observation of a session ended without a runtime-reported outcome. Payload: cause ("runtime-exited" |
	 * "observer-lost"), instance, runOpen, turnOpen, turns, stopRequested, and for "runtime-exited" the exit; for
	 * "observer-lost" the store recovery report of the reopening observer.
	 */
	"lifecycle.interrupted",
	/** The runtime process ended with no run open. Payload: instance, expected, exit { code, signal }. */
	"lifecycle.detached",
	/** The runtime compacted the session's context. Payload: reason, firstKeptEntryId, tokensBefore. */
	"lifecycle.compacted",
	/** A recorded runtime event arrived in an order the lifecycle does not allow. Payload: observed, problem. */
	"lifecycle.anomaly",
	/** The runtime sent an event type this version does not know. Payload: runtimeEvent. */
	"lifecycle.unrecognized-runtime-event",
] as const;

export type EndoLifecycleKindV0 = (typeof ENDO_LIFECYCLE_KINDS_V0)[number];

export function isEndoLifecycleKindV0(kind: string): kind is EndoLifecycleKindV0 {
	return (ENDO_LIFECYCLE_KINDS_V0 as readonly string[]).includes(kind);
}

/** One field the runtime does not report, declared by the adapter on session start. */
export interface EndoUnavailableFieldV0 {
	field: string;
	reason: string;
}

/** The previous observation's end, as recorded, on a resume. */
export type EndoPreviousEndV0 = "runtime-exited-expected" | "runtime-exited-unexpected" | "interrupted";

/** A failure cause as the runtime reported it. */
export interface EndoReportedCauseV0 {
	/** Where the cause came from: the run's last assistant message, or the retry loop's final error. */
	source: "assistant-message" | "retry-exhausted";
	stopReason: EndoReportedV0<string>;
	message: EndoReportedV0<string>;
	[key: string]: JsonValueV0;
}
