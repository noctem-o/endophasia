// The Pi session lifecycle: recorded Pi attachment events in, canonical `lifecycle.*` events out
// (protocol/session-lifecycle.ts).
//
// A pure fold. `piLifecycleStepV0(state, event)` reads one recorded event of the Pi attachment's stream and returns the
// next state and the lifecycle events it implies. Each lifecycle event's id is derived from the recorded event's id,
// its `at` and coordinates are copied from it, and its sequence counts the lifecycle stream, so folding the same
// recorded events always yields byte-identical lifecycle events. That is what lets the attachment re-derive any
// lifecycle event a crash kept it from storing, and lets replay check the stored lifecycle against the recording.
//
// What maps to what, from Pi 1.0.0's documented records (docs/json.md, docs/rpc.md, docs/rpc-commands.md):
//
// | Recorded event (Pi record)                       | Lifecycle                                                   |
// | :---                                             | :---                                                        |
// | harness.attached (get_state.sessionId)           | session-started; session-resumed for a session seen before  |
// | agent.run-started (agent_start) while idle       | run-started (a later agent_start before agent_settled is a   |
// |                                                  | continuation: retry, overflow recovery, follow-up)          |
// | agent.turn-started / agent.turn-finished         | turn-started / turn-completed with the reported stopReason   |
// | agent.settled (agent_settled)                    | run-completed, run-failed (cause: the assistant message's    |
// |                                                  | errorMessage or auto_retry_end's finalError), run-aborted    |
// |                                                  | (stopReason "aborted"), or run-unclassified                  |
// | control.requested / accepted / refused (abort)   | stop-requested / stop-accepted / stop-refused                |
// | harness.process-exited                           | interrupted (cause runtime-exited) with a run open, else     |
// |                                                  | detached                                                    |
// | harness.attached after an instance with no       | interrupted (cause observer-lost), carrying the reopening    |
// | recorded exit                                    | store's recovery report (harness.store-opened)               |
// | compaction.finished with a result                | compacted                                                   |
// | runtime.unrecognized-event                       | unrecognized-runtime-event                                  |
//
// Pi's abort responds only once the session is idle (rpc-commands.md#abort), so a STOP's acceptance normally arrives
// after the run already ended; the termination itself is Pi's stopReason "aborted". The two are separate events and
// neither is inferred from the other. Events out of lifecycle order (a turn ending that never started, a settle with no
// run) become `lifecycle.anomaly`, never a silent correction.

import type { EndoEventV0 } from "../../protocol/event.ts";
import { validateEndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	type EndoLifecycleKindV0,
	type EndoPreviousEndV0,
	type EndoUnavailableFieldV0,
	endoReportedV0,
	endoUnavailableV0,
} from "../../protocol/session-lifecycle.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

/** The producer prefix of the recorded stream the fold reads, and of the lifecycle stream it writes. */
export const PI_RECORDING_PRODUCER_PREFIX_V0 = "pi-rpc-adapter:";
export const PI_LIFECYCLE_PRODUCER_PREFIX_V0 = "pi-lifecycle:";

/** What Pi 1.0.0 does not report about a session's lifecycle, declared on every session start. */
export const PI_LIFECYCLE_UNAVAILABLE_V0: readonly EndoUnavailableFieldV0[] = Object.freeze([
	{
		field: "run.id",
		reason: "Pi 1.0.0 lifecycle events carry no run identifier (earendil-works/pi#3682, closed not planned)",
	},
	{ field: "turn.id", reason: "Pi reports no turn identifier; turns are counted by the observer within a run" },
	{
		field: "operation.outcome",
		reason:
			"Pi 1.0.0 has no durable operation outcome; a run's outcome is its last assistant stop reason, read at agent_settled",
	},
	{ field: "stop.target", reason: "Pi's abort is untargeted: a STOP cannot be confined to the observed run" },
	{ field: "lanes", reason: "Pi 1.0 RPC exposes one session and no lanes" },
]);

/** The open run, as far as the recorded events show it. */
export interface PiLifecycleRunV0 {
	readonly turns: number;
	readonly turnOpen: boolean;
	/** agent_start records after the first, before agent_settled (retries, overflow recovery, follow-ups). */
	readonly continuations: number;
	readonly lastStopReason: string | null;
	readonly lastErrorMessage: string | null;
	readonly retryFinalError: string | null;
	readonly stopRequested: boolean;
}

export interface PiLifecycleStateV0 {
	/** The one attachment whose recorded stream this fold reads; every other producer is ignored. */
	readonly attachment: string;
	/** Pi session ids attached before, sorted. */
	readonly sessions: readonly string[];
	/** The last attached process instance, and how its observation ended (null while it is being observed). */
	readonly instance: null | {
		readonly id: string;
		readonly piSessionId: string;
		readonly ended: EndoPreviousEndV0 | null;
	};
	/** The recovery report of the last store open not yet followed by an attach. */
	readonly storeRecovery: JsonValueV0 | null;
	readonly run: PiLifecycleRunV0 | null;
	/** Lifecycle events emitted so far: the lifecycle stream's sequence. */
	readonly emitted: number;
}

/** The state before any recorded event of `attachment` (e.g. `pi.default`). */
export function piLifecycleInitialStateV0(attachment: string): PiLifecycleStateV0 {
	return { attachment, sessions: [], instance: null, storeRecovery: null, run: null, emitted: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The deterministic id of the `index`th lifecycle event derived from the recorded event `sourceId`. */
export function piLifecycleEventIdV0(sourceId: string, kind: string, index: number): string {
	return `endo.event.pi-lifecycle.${sha256HexV0(`${sourceId}\u0000${kind}\u0000${index}`).slice(0, 48)}`;
}

function newRun(): PiLifecycleRunV0 {
	return {
		turns: 0,
		turnOpen: false,
		continuations: 0,
		lastStopReason: null,
		lastErrorMessage: null,
		retryFinalError: null,
		stopRequested: false,
	};
}

/**
 * Fold one recorded event. Events of other producers (another attachment recording into the same store, or the
 * lifecycle stream itself) leave the state as it is and emit nothing.
 */
export function piLifecycleStepV0(
	state: PiLifecycleStateV0,
	event: EndoEventV0,
): { state: PiLifecycleStateV0; events: EndoEventV0[] } {
	if (event.producer !== `${PI_RECORDING_PRODUCER_PREFIX_V0}${state.attachment}`) return { state, events: [] };
	const attachment = state.attachment;
	const payload = isRecord(event.payload) ? event.payload : {};
	let next: PiLifecycleStateV0 = state;
	const out: EndoEventV0[] = [];
	const emit = (kind: EndoLifecycleKindV0, body: Record<string, JsonValueV0>): void => {
		const lifecycle = {
			schemaVersion: "endo.event.v0" as const,
			id: piLifecycleEventIdV0(event.id, kind, out.length),
			kind,
			source: "interpretation" as const,
			sequence: next.emitted + 1,
			at: event.at,
			coordinates: { ...event.coordinates },
			producer: `${PI_LIFECYCLE_PRODUCER_PREFIX_V0}${attachment}`,
			derivedFrom: [event.id],
			payload: body,
		};
		const validated = validateEndoEventV0(lifecycle);
		if (validated === null) throw new TypeError(`the derived ${kind} event failed endo.event.v0 validation`);
		out.push(validated);
		next = { ...next, emitted: next.emitted + 1 };
	};
	const anomaly = (problem: string): void => emit("lifecycle.anomaly", { observed: event.kind, problem });
	const setRun = (run: PiLifecycleRunV0 | null): void => {
		next = { ...next, run };
	};
	const runFacts = (run: PiLifecycleRunV0): Record<string, JsonValueV0> => ({
		runOpen: true,
		turnOpen: run.turnOpen,
		turns: run.turns,
		stopRequested: run.stopRequested,
	});
	const idleFacts: Record<string, JsonValueV0> = { runOpen: false, turnOpen: false, turns: 0, stopRequested: false };

	switch (event.kind) {
		case "harness.store-opened":
			next = { ...next, storeRecovery: (payload.recovery ?? null) as JsonValueV0 };
			break;
		case "harness.attached": {
			const instance = text(payload.instance);
			const piSessionId = text(payload.piSessionId);
			if (instance === null || piSessionId === null) {
				anomaly("an attachment without its process instance or Pi session id");
				break;
			}
			const previous = next.instance;
			let previousEnd: EndoPreviousEndV0 | null = previous?.ended ?? null;
			if (previous !== null && previous.ended === null) {
				// The previous observation ended without recording an exit: the observer itself was lost.
				emit("lifecycle.interrupted", {
					cause: "observer-lost",
					instance: previous.id,
					...(next.run === null ? idleFacts : runFacts(next.run)),
					storeRecovery:
						next.storeRecovery ?? endoUnavailableV0("no store-open report was recorded before this attachment"),
				});
				previousEnd = "interrupted";
				setRun(null);
			}
			const resumed = next.sessions.includes(piSessionId);
			emit(resumed ? "lifecycle.session-resumed" : "lifecycle.session-started", {
				runtime: "pi",
				runtimeSessionId: piSessionId,
				instance,
				...(resumed && previous !== null
					? {
							previousInstance: previous.id,
							previousEnd: previousEnd ?? "interrupted",
						}
					: {}),
				unavailable: PI_LIFECYCLE_UNAVAILABLE_V0.map((entry) => ({ ...entry })),
			});
			next = {
				...next,
				sessions: resumed ? next.sessions : [...next.sessions, piSessionId].sort(),
				instance: { id: instance, piSessionId, ended: null },
				storeRecovery: null,
				run: null,
			};
			break;
		}
		case "harness.process-exited": {
			const current = next.instance;
			if (current === null || current.ended !== null) {
				anomaly("a process exit with no attached process");
				break;
			}
			const expected = payload.expected === true;
			const exit: Record<string, JsonValueV0> = {
				code: typeof payload.code === "number" ? payload.code : null,
				signal: typeof payload.signal === "string" ? payload.signal : null,
				expected,
			};
			if (next.run !== null) {
				emit("lifecycle.interrupted", {
					cause: "runtime-exited",
					instance: current.id,
					...runFacts(next.run),
					exit,
				});
				setRun(null);
			} else emit("lifecycle.detached", { instance: current.id, expected, exit });
			next = {
				...next,
				instance: { ...current, ended: expected ? "runtime-exited-expected" : "runtime-exited-unexpected" },
			};
			break;
		}
		case "agent.run-started":
			if (next.instance === null || next.instance.ended !== null) {
				anomaly("a run started with no attached process");
				break;
			}
			if (next.run !== null) setRun({ ...next.run, continuations: next.run.continuations + 1 });
			else {
				setRun(newRun());
				emit("lifecycle.run-started", { instance: next.instance.id });
			}
			break;
		case "agent.turn-started": {
			const run = next.run;
			if (run === null) {
				anomaly("a turn started with no run open");
				break;
			}
			if (run.turnOpen) anomaly("a turn started while another turn was open");
			setRun({ ...run, turns: run.turns + 1, turnOpen: true });
			emit("lifecycle.turn-started", { turn: run.turns + 1 });
			break;
		}
		case "agent.turn-finished": {
			const run = next.run;
			if (run === null || !run.turnOpen) {
				anomaly(run === null ? "a turn finished with no run open" : "a turn finished that had not started");
				break;
			}
			const stopReason = text(payload.stopReason);
			setRun({
				...run,
				turnOpen: false,
				...(stopReason === null
					? {}
					: { lastStopReason: stopReason, lastErrorMessage: text(payload.errorMessage) }),
			});
			emit("lifecycle.turn-completed", {
				turn: run.turns,
				stopReason:
					stopReason === null
						? endoUnavailableV0("Pi's turn_end carried no assistant stop reason")
						: endoReportedV0(stopReason),
			});
			break;
		}
		case "message.completed": {
			const run = next.run;
			const stopReason = text(payload.stopReason);
			if (run !== null && payload.role === "assistant" && stopReason !== null) {
				setRun({ ...run, lastStopReason: stopReason, lastErrorMessage: text(payload.errorMessage) });
			}
			break;
		}
		case "retry.finished":
			if (next.run !== null && payload.success === false) {
				setRun({
					...next.run,
					retryFinalError: text(payload.finalError) ?? "",
				});
			}
			break;
		case "agent.settled": {
			const run = next.run;
			if (run === null) {
				anomaly("agent_settled with no run open");
				break;
			}
			if (run.turnOpen) anomaly("agent_settled while a turn was open");
			const turns = run.turns;
			if (run.retryFinalError !== null) {
				emit("lifecycle.run-failed", {
					turns,
					stopReason:
						run.lastStopReason === null
							? endoUnavailableV0("no assistant stop reason was observed in this run")
							: endoReportedV0(run.lastStopReason),
					cause: {
						source: "retry-exhausted",
						stopReason:
							run.lastStopReason === null
								? endoUnavailableV0("no assistant stop reason was observed in this run")
								: endoReportedV0(run.lastStopReason),
						message:
							run.retryFinalError === ""
								? endoUnavailableV0("Pi's auto_retry_end carried no finalError")
								: endoReportedV0(run.retryFinalError),
					},
				});
			} else if (run.lastStopReason === "error") {
				emit("lifecycle.run-failed", {
					turns,
					stopReason: endoReportedV0("error"),
					cause: {
						source: "assistant-message",
						stopReason: endoReportedV0("error"),
						message:
							run.lastErrorMessage === null
								? endoUnavailableV0("Pi's assistant message carried no errorMessage")
								: endoReportedV0(run.lastErrorMessage),
					},
				});
			} else if (run.lastStopReason === "aborted") {
				emit("lifecycle.run-aborted", {
					turns,
					stopReason: endoReportedV0("aborted"),
					stopRequested: run.stopRequested,
				});
			} else if (run.lastStopReason === null) {
				emit("lifecycle.run-unclassified", {
					turns,
					reason: "no assistant stop reason was observed in this run",
				});
			} else {
				emit("lifecycle.run-completed", { turns, stopReason: endoReportedV0(run.lastStopReason) });
			}
			setRun(null);
			break;
		}
		case "control.requested":
		case "control.accepted":
		case "control.refused": {
			if (payload.action !== "abort") break;
			const runOpen = next.run !== null;
			if (event.kind === "control.requested") {
				if (next.run !== null) setRun({ ...next.run, stopRequested: true });
				emit("lifecycle.stop-requested", { runOpen });
			} else
				emit(event.kind === "control.accepted" ? "lifecycle.stop-accepted" : "lifecycle.stop-refused", { runOpen });
			break;
		}
		case "compaction.finished":
			if (payload.succeeded === true) {
				emit("lifecycle.compacted", {
					reason: text(payload.reason) ?? "unreported",
					firstKeptEntryId: text(payload.firstKeptEntryId),
					tokensBefore: typeof payload.tokensBefore === "number" ? payload.tokensBefore : null,
				});
			}
			break;
		case "runtime.unrecognized-event":
			emit("lifecycle.unrecognized-runtime-event", { runtimeEvent: text(payload.runtimeEvent) ?? "unprintable" });
			break;
	}
	return { state: next, events: out };
}

/** Fold one attachment's recorded stream: the final state and every lifecycle event it implies, in order. */
export function piLifecycleFoldV0(
	events: readonly EndoEventV0[],
	attachment: string,
): {
	state: PiLifecycleStateV0;
	events: EndoEventV0[];
} {
	let state = piLifecycleInitialStateV0(attachment);
	const out: EndoEventV0[] = [];
	for (const event of events) {
		const step = piLifecycleStepV0(state, event);
		state = step.state;
		out.push(...step.events);
	}
	return { state, events: out };
}
