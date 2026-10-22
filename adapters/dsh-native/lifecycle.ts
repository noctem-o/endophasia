// The lifecycle fold of the DSH native importer: canonical `lifecycle.*` events (protocol/session-lifecycle.ts) derived from the
// recorded rows, by a deterministic rule, one row at a time.
//
// APPEND-STABLE: the events a row produces depend only on that row and the rows before it. A log that grows later therefore
// produces the same earlier events, which is what makes re-import idempotent and an extended import append-only.
//
// The mapping is QUALIFIED, not identity: a DSH turn (open input to settlement) is the Endophasia RUN, and a DSH step (one model
// call and the tools it requested) is the Endophasia TURN. Every event names the mapping in `qualification`.
//
// What DSH reports is kept apart from what Endophasia observed. `lifecycle.interrupted` is Endophasia's own observation of a runtime
// exit and is NEVER emitted here: when DSH itself closed a crash-orphaned turn on resume (reason `interrupted`) or while seeding a
// fork (`forked`), the run is `run-unclassified` with `provenance: "dsh-written-closer"`, naming the reason DSH wrote.
// `lifecycle.session-resumed` is likewise Endophasia's re-attachment and is never derived from DSH's own resume marker.

import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { endoReportedV0, endoUnavailableV0 } from "../../protocol/session-lifecycle.ts";
import type { DshSessionEvent } from "./log.ts";
import { DSH_NATIVE_MAPPING_VERSION_V0, type DshRecordedRowV0, dshStopReason, isRecord } from "./mapping.ts";

export interface DshLifecycleStateV0 {
	/** Lifecycle events emitted so far (the producer sequence of the next one is `emitted + 1`). */
	emitted: number;
	started: boolean;
	runs: number;
	run: { index: number; steps: number; lastStop: string | null; dshTurn: number | null } | null;
	step: DshStepStateV0 | null;
	/** The step that last ended (or is still open at a turn end), kept so a recovery closer can say what it closed. */
	lastStep: (DshStepStateV0 & { endWritten: boolean }) | null;
}

/**
 * What a step's log committed. NONE of these says the step completed:
 * - "none": no assistant message or attempt;
 * - "attempt-only": a failed or cancelled attempt that committed no message;
 * - "committed": an assistant message (it may still have tool calls whose results never came);
 * - "cancelled-prefix": an assistant message DSH finalised from a cancelled stream (`interrupted: true`).
 */
export type DshStepOutputV0 = "none" | "attempt-only" | "committed" | "cancelled-prefix";

export interface DshStepStateV0 {
	n: number;
	stop: string | null;
	output: DshStepOutputV0;
	/** Tool results DSH wrote itself during recovery (TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN) inside this step. */
	recoveredResults: number;
}

export const INITIAL_DSH_LIFECYCLE_STATE_V0: DshLifecycleStateV0 = Object.freeze({
	emitted: 0,
	started: false,
	runs: 0,
	run: null,
	step: null,
	lastStep: null,
});

export interface DshLifecycleOutV0 {
	kind: string;
	payload: Record<string, JsonValueV0>;
}

const QUALIFIED_RUN = "dsh-turn-as-run";
const QUALIFIED_TURN = "dsh-step-as-turn";

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Fold one source row into the lifecycle state and the events it yields (zero or more). */
export function foldDshLifecycleV0(
	state: DshLifecycleStateV0,
	row: DshSessionEvent,
	recorded: DshRecordedRowV0,
	dshSessionId: string,
	/** The row after this one, if the log has one yet. A step's end is decided one row late (see below). */
	following: DshSessionEvent | undefined,
): { state: DshLifecycleStateV0; events: DshLifecycleOutV0[] } {
	const data = isRecord(row.data) ? row.data : {};
	const events: DshLifecycleOutV0[] = [];
	let next: DshLifecycleStateV0 = state;
	const emit = (kind: string, payload: Record<string, JsonValueV0>): void => {
		events.push({ kind, payload });
		next = { ...next, emitted: next.emitted + 1 };
	};
	const anomaly = (problem: string): void => emit("lifecycle.anomaly", { observed: row.type, problem });

	if (!next.started) {
		next = { ...next, started: true };
		emit("lifecycle.session-started", {
			runtime: "dsh",
			runtimeSessionId: endoReportedV0(dshSessionId),
			unavailable: ["instance"],
			mapping: DSH_NATIVE_MAPPING_VERSION_V0,
			basis: "imported-from-persisted-log",
		});
	}

	switch (row.type) {
		case "turn/start": {
			if (next.run !== null) anomaly("a turn started while another was open");
			const index = next.runs + 1;
			next = {
				...next,
				runs: index,
				run: { index, steps: 0, lastStop: null, dshTurn: count(data.turn) ?? null },
				step: null,
				lastStep: null,
			};
			emit("lifecycle.run-started", { dshTurn: count(data.turn) ?? null, qualification: QUALIFIED_RUN });
			break;
		}
		case "step/start": {
			if (next.run === null) {
				anomaly("a step started outside an open turn");
				break;
			}
			const n = count(data.step) ?? next.run.steps + 1;
			next = {
				...next,
				run: { ...next.run, steps: next.run.steps + 1 },
				step: { n, stop: null, output: "none", recoveredResults: 0 },
				lastStep: null,
			};
			emit("lifecycle.turn-started", { turn: n, qualification: QUALIFIED_TURN });
			break;
		}
		case "assistant/attempt":
			// An attempt that committed no message. It is output only when nothing better was committed.
			if (next.step !== null && next.step.output === "none")
				next = { ...next, step: { ...next.step, output: "attempt-only" } };
			break;
		case "assistant/message": {
			if (next.step === null) break;
			// A message says the model produced something, not that the step finished: `interrupted: true` marks a prefix DSH
			// finalised from a cancelled stream, and the message may carry tool calls that were never answered.
			const stop = dshStopReason(data);
			next = {
				...next,
				step: {
					...next.step,
					output: data.interrupted === true ? "cancelled-prefix" : "committed",
					stop: stop ?? next.step.stop,
				},
				run: stop !== undefined && next.run !== null ? { ...next.run, lastStop: stop } : next.run,
			};
			break;
		}
		case "tool/result":
			if (next.step !== null && typeof recorded.payload.dshRecovery === "string")
				next = { ...next, step: { ...next.step, recoveredResults: next.step.recoveredResults + 1 } };
			break;
		case "step/end": {
			if (next.step === null) {
				anomaly("a step ended that was not open");
				break;
			}
			const closing = next.step;
			next = { ...next, step: null, lastStep: { ...closing, endWritten: true } };
			// A step's end is decided ONE ROW LATE, which keeps the fold append-stable and honest:
			// - the last row of the log so far: nothing is emitted yet (the next import, which sees the next row, emits it);
			// - a step/end directly followed by a turn/end of reason `interrupted` or `forked` may have been WRITTEN BY DSH during
			//   recovery (an open step is closed that way, whatever it committed, and the closer reuses the last event's time).
			//   A genuine step end followed by a recovery turn end looks identical, so no completion is claimed either way; the
			//   closing turn event records what the step had committed (`finalStep`).
			if (following === undefined) break;
			const followingReason =
				following.type === "turn/end" && isRecord(following.data) && isRecord(following.data.reason)
					? following.data.reason.kind
					: null;
			if (followingReason === "interrupted" || followingReason === "forked") break;
			emit("lifecycle.turn-completed", {
				turn: closing.n,
				output: closing.output,
				stopReason:
					closing.stop === null
						? endoUnavailableV0("no assistant message with a stop reason was committed in this step")
						: endoReportedV0(closing.stop),
				qualification: QUALIFIED_TURN,
			});
			break;
		}
		case "turn/end": {
			if (next.run === null) {
				anomaly("a turn ended that was not open");
				break;
			}
			const run = next.run;
			// What the turn's last step had committed, whether DSH wrote its end or it is still open.
			const last = next.step !== null ? { ...next.step, endWritten: false } : next.lastStep;
			next = { ...next, run: null, step: null, lastStep: null };
			const reported = typeof recorded.payload.reason === "string" ? recorded.payload.reason : "unrecognised";
			const turns = run.steps;
			const closed = { turns, qualification: QUALIFIED_RUN };
			if (reported === "completed") {
				emit("lifecycle.run-completed", {
					...closed,
					stopReason:
						run.lastStop === null
							? endoUnavailableV0("no assistant message with a stop reason was committed in this turn")
							: endoReportedV0(run.lastStop),
				});
			} else if (reported === "aborted") {
				const cause = recorded.payload.abortCause;
				emit("lifecycle.run-aborted", {
					...closed,
					stopReason: endoReportedV0("aborted"),
					stopRequested: cause === "user",
					...(typeof cause === "string" ? { abortCause: cause } : {}),
				});
			} else if (reported === "error") {
				// The cause deliberately does not use EndoReportedCauseV0: its message reference is Pi's runtime-text store, which DSH
				// has none of. The failure is DSH's own code and status plus a keyed digest and length of its message.
				emit("lifecycle.run-failed", {
					...closed,
					cause: { source: "dsh-turn-end", failure: recorded.payload.failure ?? null },
				});
			} else if (reported === "interrupted" || reported === "forked") {
				// DSH wrote this closer itself, after the fact (a resume closed an orphaned turn; a fork seed closed an open one).
				emit("lifecycle.run-unclassified", {
					...closed,
					reason: `DSH closed this turn after the fact with reason '${reported}'; no end of it was observed`,
					reportedReason: reported,
					provenance: "dsh-written-closer",
					...(last === null
						? {}
						: {
								finalStep: {
									turn: last.n,
									output: last.output,
									recoveredToolResults: last.recoveredResults,
									stepEndWritten: last.endWritten,
								},
							}),
				});
			} else {
				emit("lifecycle.run-unclassified", {
					...closed,
					reason: `DSH reported turn end reason '${reported}', which has no Endophasia outcome`,
					reportedReason: reported,
				});
			}
			break;
		}
		default:
	}
	return { state: next, events };
}
