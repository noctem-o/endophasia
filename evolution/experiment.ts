/**
 * Phase 6 — the experiment lifecycle (README "## Phase 6 — Evolution substrate": experiment
 * lifecycle; "the state of an experiment must be reconstructible from recorded transitions").
 *
 * The lifecycle is an explicit state machine over `EndoExperimentStateV0`. The state is never a
 * field of a record: it is derived from the recorded transition chain. A legal move is one the
 * closed transition table allows from the current state; anything else — skipping ahead, stepping
 * back, moving out of a terminal state — is rejected. `replayEndoExperimentLifecycleV0` rebuilds the
 * lifecycle from the record and its transitions, and a broken chain (gap in the sequence, a `from`
 * that does not continue the chain, a foreign experiment id, a repeated id) is not a replay: it
 * throws.
 */

import type {
	EndoExperimentRecordV0,
	EndoExperimentStateV0,
	EndoExperimentTransitionV0,
} from "../protocol/evolution.ts";
import {
	ENDO_EXPERIMENT_STATE_TRANSITIONS_V0,
	ENDO_EXPERIMENT_STATES_V0,
	validateEndoExperimentRecordV0,
	validateEndoExperimentTransitionV0,
} from "../protocol/evolution.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";
import { deepFreezeCopyV0, deepFreezeV0 } from "../runtime/contracts/immutability.ts";

/**
 * The lifecycle of one experiment: the declared record, the recorded transition chain, the current
 * state derived from that chain, and the door for recording the next transition.
 */
export interface EndoExperimentLifecycleV0 {
	/** The declared experiment inputs. */
	record: EndoExperimentRecordV0;
	/** The recorded transitions, in sequence order. */
	readonly transitions: readonly EndoExperimentTransitionV0[];
	/** The current state, derived from the transition chain ("created" before the first transition). */
	readonly state: EndoExperimentStateV0;
	/**
	 * Record the next transition and advance the state. Throws TypeError when the id is not an
	 * endo.evidence.* identifier or is already recorded, when `to` is not a valid state, or when the
	 * move is illegal from the current state (skips, back-steps, and terminal-state moves all throw).
	 */
	transition(args: { id: unknown; to: unknown; evidence?: unknown; reason?: unknown }): EndoExperimentTransitionV0;
}

function buildLifecycleV0(
	record: EndoExperimentRecordV0,
	transitions: readonly EndoExperimentTransitionV0[],
): EndoExperimentLifecycleV0 {
	const storedRecord = deepFreezeCopyV0(record);
	const transitionsList: EndoExperimentTransitionV0[] = transitions.map((entry) => deepFreezeCopyV0(entry));
	let state: EndoExperimentStateV0 =
		transitionsList.length === 0 ? "created" : transitionsList[transitionsList.length - 1].to;
	const lifecycle: EndoExperimentLifecycleV0 = {
		record: storedRecord,
		transitions: transitionsList,
		get state() {
			return state;
		},
		transition(args) {
			if (typeof args.id !== "string" || !isEndoIdentifierV0(args.id, "evidence")) {
				throw new TypeError("transition id must be an endo.evidence.* identifier");
			}
			if (transitionsList.some((entry) => entry.id === args.id)) {
				throw new TypeError(`transition ${args.id} is already recorded`);
			}
			if (typeof args.to !== "string" || !(ENDO_EXPERIMENT_STATES_V0 as readonly string[]).includes(args.to)) {
				throw new TypeError("to must be a valid experiment state");
			}
			if (!(ENDO_EXPERIMENT_STATE_TRANSITIONS_V0[state] as readonly string[]).includes(args.to)) {
				throw new TypeError(`illegal transition from ${state} to ${args.to}`);
			}
			const candidate: Record<string, unknown> = {
				schemaVersion: "endo.experiment-transition.v0",
				id: args.id,
				experimentId: storedRecord.id,
				sequence: transitionsList.length + 1,
				from: state,
				to: args.to,
			};
			if (args.evidence !== undefined) candidate.evidence = args.evidence;
			if (args.reason !== undefined) candidate.reason = args.reason;
			const validated = validateEndoExperimentTransitionV0(candidate);
			if (validated === null) throw new TypeError("not a valid endo.experiment-transition.v0 transition");
			deepFreezeV0(validated);
			transitionsList.push(validated);
			state = validated.to;
			return validated;
		},
	};
	return lifecycle;
}

/**
 * Start the lifecycle of a new experiment. The record must be a valid endo.experiment.v0; the
 * lifecycle begins in state "created" with no transitions.
 */
export function createEndoExperimentLifecycleV0(record: unknown): EndoExperimentLifecycleV0 {
	const validated = validateEndoExperimentRecordV0(record);
	if (validated === null) throw new TypeError("not a valid endo.experiment.v0 record");
	return buildLifecycleV0(validated, []);
}

/**
 * Replay a lifecycle from its record and its recorded transitions. Re-validates every transition,
 * requires the experiment ids to agree, the sequences to be exactly 1..n in order, each `from` to
 * continue the chain from "created", and no id to appear twice. Throws TypeError on any break — a
 * broken chain is not a replay.
 */
export function replayEndoExperimentLifecycleV0(record: unknown, transitions: unknown): EndoExperimentLifecycleV0 {
	const validatedRecord = validateEndoExperimentRecordV0(record);
	if (validatedRecord === null) throw new TypeError("not a valid endo.experiment.v0 record");
	if (!Array.isArray(transitions)) throw new TypeError("transitions must be an array");
	const chain: EndoExperimentTransitionV0[] = [];
	const seen = new Set<string>();
	let state: EndoExperimentStateV0 = "created";
	for (let index = 0; index < transitions.length; index++) {
		const validated = validateEndoExperimentTransitionV0(transitions[index]);
		if (validated === null)
			throw new TypeError(`transition ${index} is not a valid endo.experiment-transition.v0 record`);
		if (validated.experimentId !== validatedRecord.id) {
			throw new TypeError(`transition ${index} belongs to a different experiment`);
		}
		if (validated.sequence !== index + 1) throw new TypeError(`transition ${index} has a broken sequence`);
		if (validated.from !== state) throw new TypeError(`transition ${index} does not continue the recorded chain`);
		if (seen.has(validated.id)) throw new TypeError(`transition ${validated.id} is recorded more than once`);
		seen.add(validated.id);
		state = validated.to;
		chain.push(validated);
	}
	return buildLifecycleV0(validatedRecord, chain);
}
