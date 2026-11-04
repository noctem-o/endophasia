// What the live workbench page says about a prepared work attempt it may ask to send to Pi (docs/designs/develop-attempt-workbench.md).
// Pure: no DOM, no network, no clock. Every sentence is read from two authoritative sources and nothing else: the broker's view of the one
// prompt in flight (which names its attempt, from the attempt's own record), and the attempts view (the store's records, read through the
// workspace routes). A session is never related to an attempt by its title, its text or its timing.
import { type Attempt, type AttemptsView, EXECUTION_RUN_LABELS, EXECUTION_SEND_LABELS } from "./attempts-wire.ts";
import { commandOpen, REFUSAL_WORDS } from "./workbench.ts";
import { ATTEMPT_REFUSAL_WORDS, type WorkbenchCommand } from "./workbench-wire.ts";

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
				: {
						head: "Approved in the terminal. Checking the attempt again before sending",
						detail: "Nothing has been recorded for the attempt yet.",
					};
		case "accepted":
			return {
				head: `Sent once. Pi replied: ${c.disposition ?? "a reply"}`,
				detail:
					"A reply from Pi, not a result. Follow the run in the conversation; a run Pi reports as completed is not verification, and the task's status is yours.",
			};
		case "unknown":
			return {
				head: "Sent once. Pi's reply was not seen",
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
			return {
				head: c.reason === "runtime-refused" ? "Sent once. Pi refused it" : `Not sent: ${why}`,
				detail: bound
					? "Its authorisation was recorded, so it will not be sent again; prepare a new attempt to try again."
					: "Nothing was recorded for the attempt: it can be requested again.",
			};
		}
	}
}

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
				text: "Sent to Pi; its records are read with the task's attempts. Follow the run in the conversation.",
			};
		return null;
	}
	const latest = [...view.attempts].sort((a, b) => b.preparedAtMs - a.preparedAtMs)[0] as Attempt;
	const e = latest.execution;
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
