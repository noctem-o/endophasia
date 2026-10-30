// The Field appearance of DEVELOP draws a slow contour field behind the work. This module is the only thing that decides how that field
// behaves, and it decides from typed state the page already holds, never from text. Pure: no DOM, no clock, no randomness.
//
// What the field may say, and what it may not:
//  - It may say what the BROKER reported (connected, a run open, idle), what THIS PAGE observed (the broker did not answer; new items
//    arrived in its copy of the transcript) and what the OPERATOR is doing (reading a diff, waiting on the terminal).
//  - It never depicts the model's work or reasoning. A run Pi reported open makes the field flow; that is a picture of a report, not of
//    cognition, and the legend says so.
//  - A report is only shown as current while the page is re-reading it (Follow on, or a request open). Otherwise the field is still and
//    the legend says "as last read": a status can be minutes old, and motion would claim it is not.
//  - A recording never moves the field, whatever its last recorded state: a recording is not a live process.
//  - Unreachable and disconnected are different. The broker saying "disconnected" is an answer; no answer is not an ending.

/** How the contours behave. */
export type FieldMotion =
	/** Slow and undirected: atmosphere only. Shown when nothing live is being claimed. */
	| "drift"
	/** Directed flow: Pi reports a run open, and the page is re-reading that report. */
	| "current"
	/** Stopped, because something waits on the operator (an approval) or a stop is on its way. */
	| "held"
	/** Stopped: a recording, a disconnected session, a report not being re-read, or the operator reading. */
	| "still";

export type FieldSurface =
	/** Nothing to read yet: no session open, or a live session with nothing in its conversation. */
	| "arrival"
	/** A live conversation is shown. */
	| "conversation"
	/** The operator is reading the worktree's changes. */
	| "changes"
	/** A recorded session is open. */
	| "recording";

export interface FieldInput {
	surface: FieldSurface;
	/** Whether this server has a workbench at all (`absent` on the read-only `endo studio`). */
	workbench: "unknown" | "available" | "absent";
	/** What the broker last said about its connection, or null when it has not said anything yet. */
	connection: "connected" | "disconnected" | null;
	/** What the broker last reported about the run, or null when it has not said anything yet. */
	run: "active" | "idle" | "unknown" | null;
	/** The last attempt did not reach the broker. */
	unreachable: boolean;
	/** The page is re-reading the broker by itself now (Follow is on, or a request or a check is open). */
	following: boolean;
	/** What waits for the operator's approval in the attached terminal, if anything. */
	awaiting: "prompt" | "steer" | "queue" | "stop" | null;
	/** A stop was approved and sent, and Pi has not answered yet. */
	stopping: boolean;
	/** How many conversation items this page holds. Only the count: the field never sees what they say. */
	received: number;
	/** The operator paused the field, or asked the system for reduced motion. */
	paused: boolean;
}

export interface FieldSignal {
	motion: FieldMotion;
	/** 0..1: how fast the contours move when they move at all. */
	tempo: number;
	/** `dashed` only when the connection is unknown: the same texture the instrument uses for what is unavailable. */
	texture: "solid" | "dashed";
	/** Something waits on the operator, in the terminal. The field tints; it is never a control. */
	attention: boolean;
	/** 0..1: how much of the field is shown. Reading surfaces push it back. */
	presence: number;
	/** The count of received items, so the field can ripple once when it grows. Not a measure of anything. */
	pulse: number;
	/** Whether the field may follow the pointer (only where nothing is being read). */
	responsive: boolean;
	/** One line for the legend: what the field is showing, in words. */
	words: string;
}

const OPERATION = { prompt: "prompt", steer: "steer", queue: "queue", stop: "stop" } as const;

const PRESENCE: Readonly<Record<FieldSurface, number>> = {
	arrival: 1,
	conversation: 0.42,
	recording: 0.42,
	changes: 0.16,
};

export function fieldSignal(input: FieldInput): FieldSignal {
	const signal = describe(input);
	// The field follows the pointer only while it moves anyway: a field the legend calls still, held or broken does not move at all.
	return { ...signal, responsive: signal.responsive && (signal.motion === "drift" || signal.motion === "current") };
}

function describe(input: FieldInput): FieldSignal {
	const presence = PRESENCE[input.surface];
	const base = {
		texture: "solid" as const,
		attention: false,
		presence,
		pulse: input.received,
		responsive: input.surface === "arrival" && !input.paused,
	};
	const live = input.workbench === "available";
	// The operator's pause stops what would move and says so: "Flowing" over a still field would be a claim the picture does not make.
	const moving = (wanted: "drift" | "current", tempo: number, lead: string, rest: string) =>
		input.paused
			? {
					...base,
					motion: "still" as const,
					tempo: 0,
					words: `Paused by you. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`,
				}
			: { ...base, motion: wanted, tempo, words: `${lead}: ${rest}` };

	// Waiting on the operator comes first: it is the one thing on the page that needs a person, and it is never approved here.
	if (live && input.awaiting !== null)
		return {
			...base,
			motion: "held",
			tempo: 0,
			attention: true,
			words: `Held: a ${OPERATION[input.awaiting]} waits for your approval in the attached terminal. This page cannot approve it.`,
		};
	if (input.surface === "changes")
		return {
			...base,
			motion: "still",
			tempo: 0,
			words: "Still while you read changes.",
		};
	if (input.surface === "recording")
		return {
			...base,
			motion: "still",
			tempo: 0,
			words: "A recording: the field does not move. Nothing recorded is live.",
		};
	if (input.workbench === "absent")
		return moving("drift", 0.25, "Read-only", "the field drifts on its own; it shows no activity.");
	// No answer outranks "not read yet": a first request that failed has been read, and its answer was silence. (The page does not ask
	// again by itself while it does not know there is a workbench, so "not read yet" would stay on screen.)
	if (input.unreachable)
		return {
			...base,
			motion: "still",
			tempo: 0,
			texture: "dashed",
			words:
				input.workbench === "unknown"
					? "Broken: the page asked for a workbench and got no answer. Whether a session runs is not known; unreachable is not ended."
					: "Broken: the broker did not answer. The session may still be running; unreachable is not ended.",
		};
	if (input.workbench === "unknown" || input.connection === null)
		return moving("drift", 0.2, "Not read yet", "nothing is known about a live session.");
	if (input.connection === "disconnected")
		return {
			...base,
			motion: "still",
			tempo: 0,
			presence: presence * 0.6,
			words: "Still: the broker reports no admitted connection now.",
		};
	if (input.stopping)
		return {
			...base,
			motion: "held",
			tempo: 0,
			words: "Held: a stop was sent to Pi. Pi answers once the run is idle.",
		};
	if (input.run === "active")
		return input.following
			? moving(
					"current",
					0.7,
					"Flowing",
					"Pi reports a run open, re-read every few seconds. The motion is not the model's work.",
				)
			: {
					...base,
					motion: "still",
					tempo: 0,
					words: "Still: Pi reported a run open at the last read. Not re-reading now; switch Follow on to keep it current.",
				};
	return moving(
		"drift",
		0.3,
		"Drifting",
		input.run === "idle"
			? "Pi reports the session idle. The drift is atmosphere, not activity."
			: "connected; Pi has not reported a run state. The drift is atmosphere, not activity.",
	);
}
