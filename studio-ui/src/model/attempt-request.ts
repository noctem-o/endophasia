// What the live workbench page says about a prepared work attempt it may ask to send to Pi (docs/designs/develop-attempt-workbench.md).
// Pure: no DOM, no network, no clock. Every sentence is read from two authoritative sources and nothing else: the broker's view of the one
// prompt in flight (which names its attempt, from the attempt's own record), and the attempts view (the store's records, read through the
// workspace routes). A session is never related to an attempt by its title, its text or its timing.
import { type Attempt, type AttemptsView, EXECUTION_RUN_LABELS, EXECUTION_SEND_LABELS } from "./attempts-wire.ts";
import { commandOpen, REFUSAL_WORDS } from "./workbench.ts";
import {
	ATTEMPT_REFUSAL_WORDS,
	type AttemptRefusal,
	type WorkbenchCommand,
	type WorkbenchReply,
} from "./workbench-wire.ts";

export const shortAttempt = (id: string): string => id.slice(-8);

/** The broker's request for THIS attempt, when the one prompt it holds carries it. */
export const requestFor = (command: WorkbenchCommand | null, attemptId: string): WorkbenchCommand | null =>
	command !== null && command.attempt?.attemptId === attemptId ? command : null;

/**
 * Whether the page may offer to ask for this attempt at all. Advisory only: the broker checks everything again when asked, and again at
 * the moment of sending. An attempt that was authorised once is never offered again, whatever followed.
 */
export function requestable(a: Attempt): { ok: true } | { ok: false; why: string } {
	if (a.execution !== null) return { ok: false, why: "It was authorised to be sent once already." };
	if (a.state !== "prepared")
		return {
			ok: false,
			why:
				a.state === "handed-off"
					? "You recorded handing it to another agent."
					: "An outcome is already recorded for it.",
		};
	if (a.taskWordsChanged.length > 0)
		return { ok: false, why: "The task's words changed since its brief was prepared: prepare a new attempt." };
	return { ok: true };
}

export interface RequestWords {
	/** One line: where the request stands, saying no more than the broker reported. */
	head: string;
	/** What follows from it for this attempt (whether it can be asked again). */
	detail: string;
}

/** The words for a request that carries an attempt. Never "done": a reply from Pi is not a result, and a run's end is not verification. */
export function requestWords(c: WorkbenchCommand): RequestWords {
	const bound = c.attempt?.bound === true;
	switch (c.state) {
		case "awaiting-approval":
			return {
				head: "Requested. Waiting for approval in the attached terminal",
				detail: `Type the APPROVE ATTEMPT phrase shown there (digest ${c.digestPrefix}). This page cannot approve it; nothing has been recorded for the attempt or sent.`,
			};
		case "dispatching":
			return bound
				? {
						head: "Approved in the terminal. Authorisation recorded; sending to Pi",
						detail: "From here it is never sent again, whatever happens next.",
					}
				: // Defensive: the broker binds an attempt before it reports `dispatching`, so this is not expected to be shown.
					{
						head: "Approved in the terminal. Checking the attempt again before sending",
						detail: "Nothing has been recorded for the attempt yet.",
					};
		case "accepted":
			return {
				head: `Recorded as sent, once. Pi replied: ${c.disposition ?? "a reply"}`,
				detail:
					"A reply from Pi, not a result. Follow the run in the conversation; a run Pi reports as completed is not verification, and the task's status is yours.",
			};
		case "unknown":
			return {
				head: "Recorded as sent, once. Pi's reply was not seen or not recognised",
				detail:
					"Work may have started: this is not a failure, and not a success. It will not be sent again; the session's records show what followed.",
			};
		case "refused": {
			const why =
				c.reason === "runtime-refused"
					? "Pi refused it"
					: c.attempt?.refusal != null
						? ATTEMPT_REFUSAL_WORDS[c.attempt.refusal]
						: c.reason === null
							? "no reason was given"
							: (REFUSAL_WORDS[c.reason] ?? c.reason);
			const blocked = c.attempt?.refusal != null && !TRANSIENT.has(c.attempt.refusal);
			return {
				head: c.reason === "runtime-refused" ? "Recorded as sent, once. Pi refused it" : `Not sent: ${why}`,
				detail: bound
					? "Its authorisation was recorded, so it will not be sent again; prepare a new attempt to try again."
					: blocked
						? "Nothing was recorded for this request, and the attempt cannot be sent as it stands; prepare a new attempt if you still want one sent."
						: "Nothing was recorded for the attempt: it can be requested again.",
			};
		}
	}
}

/**
 * The attempt refusals at binding that may clear by themselves (a file that could not be read or written this time). Every other one
 * means the attempt cannot be sent as it stands: already authorised elsewhere, handed off, an outcome recorded, the task done or changed,
 * or the launch not in the project's directory.
 */
const TRANSIENT: ReadonlySet<AttemptRefusal> = new Set(["tasks-unreadable", "unreadable", "storage-failed"]);

export type NextStepKind =
	| "awaiting-approval"
	| "sending"
	| "awaiting-evidence"
	| "run-open"
	| "no-check"
	| "review"
	| "ready"
	| "unclear";

export interface NextStep {
	kind: NextStepKind;
	attemptId: string;
	/** What is known, then what the operator can do. Model text is never quoted; agent claims are never stated as facts. */
	text: string;
}

/**
 * The next decision the operator holds for the selected task, from the records, newest attempt first. Null when there is nothing to say
 * (no task selected, no attempts, attempts not read). A request in flight comes first: it is what is happening now.
 */
export function nextStep(view: AttemptsView | null, command: WorkbenchCommand | null): NextStep | null {
	if (command?.attempt != null && commandOpen(command)) {
		const id = command.attempt.attemptId;
		if (command.state === "awaiting-approval")
			return {
				kind: "awaiting-approval",
				attemptId: id,
				text: "Waiting for your approval in the attached terminal.",
			};
		if (command.state === "dispatching")
			return { kind: "sending", attemptId: id, text: "Approved in the terminal; being sent to Pi." };
	}
	if (view === null || view.state !== "ready" || view.attempts.length === 0) {
		if (command?.attempt != null && (command.state === "accepted" || command.state === "unknown"))
			return {
				kind: "awaiting-evidence",
				attemptId: command.attempt.attemptId,
				text: "Recorded as sent; its records are read with the task's attempts. Follow the run in the conversation.",
			};
		return null;
	}
	const latest = [...view.attempts].sort((a, b) => b.preparedAtMs - a.preparedAtMs)[0] as Attempt;
	const e = latest.execution;
	// The broker says this attempt was bound (or sent) and the attempts were read before that: the records are awaited, never "not sent".
	if (
		e === null &&
		command?.attempt != null &&
		command.attempt.attemptId === latest.id &&
		(command.attempt.bound || command.state === "accepted" || command.state === "unknown")
	)
		return {
			kind: "awaiting-evidence",
			attemptId: latest.id,
			text: "Recorded as sent; its records are read with the task's attempts. Follow the run in the conversation.",
		};
	if (e !== null) {
		// Sent, by the session's records (a reply seen or not). A send Pi refused ran nothing.
		const sent = e.send === "runtime-accepted" || e.send === "sent-no-reply";
		if (!sent)
			return {
				kind: "unclear",
				attemptId: latest.id,
				// The execution's own words (the same everywhere), then what is left to the operator: never a resend of this attempt.
				text: `${EXECUTION_SEND_LABELS[e.send]}. To try again, prepare a new attempt.`,
			};
		if (e.run === "open" || e.run === "not-observed")
			return {
				kind: e.run === "open" ? "run-open" : "awaiting-evidence",
				attemptId: latest.id,
				text:
					e.run === "open"
						? "Sent; a run started and no end is recorded yet. Follow it in the conversation."
						: "Sent; no run is recorded for it yet.",
			};
		// An empty list proves no check only when every receipt was read: an unreadable directory or rejected files may hide one.
		if (latest.receipts.list.length === 0 && (latest.receipts.state !== "ready" || latest.receipts.problems > 0))
			return {
				kind: "unclear",
				attemptId: latest.id,
				text: `${EXECUTION_RUN_LABELS[e.run]}. Its checks could not all be read, so whether one is recorded is unknown. The task's status is yours.`,
			};
		if (latest.receipts.list.length === 0)
			return {
				kind: "no-check",
				attemptId: latest.id,
				text: `${EXECUTION_RUN_LABELS[e.run]}. No check is recorded: run one yourself (endo attempt check). The task's status is yours.`,
			};
		return {
			kind: "review",
			attemptId: latest.id,
			text: "Checks are recorded. Review them and the changes; whether the task is done is your decision.",
		};
	}
	if (latest.receipts.list.length > 0)
		return {
			kind: "review",
			attemptId: latest.id,
			text: "Checks are recorded. Review them and the changes; whether the task is done is your decision.",
		};
	if (requestable(latest).ok)
		return {
			kind: "ready",
			attemptId: latest.id,
			text: "Prepared and not sent. Read its brief in Task; you can request it there, or copy it.",
		};
	return null;
}

/**
 * What a failed request means for the attempt. Only the broker's own refusal (a 4xx or 503 with a code it names) establishes that nothing
 * was requested. A request that timed out, could not be read back, or got a malformed answer may have reached the broker and be waiting
 * on the terminal now: the page says so and reads the workbench again rather than claiming nothing happened.
 */
export function failureWords(f: Extract<WorkbenchReply, { kind: "failure" }>): { text: string; uncertain: boolean } {
	const refused = f.code !== "" && (f.status === 503 || (f.status >= 400 && f.status < 500));
	if (refused)
		return {
			text: /nothing was requested|nothing was recorded/i.test(f.message)
				? f.message
				: `${f.message} Nothing was recorded or sent.`,
			uncertain: false,
		};
	return {
		text: `${f.message} It may still have been requested: the terminal is the place to check. Reading the workbench again.`,
		uncertain: true,
	};
}
