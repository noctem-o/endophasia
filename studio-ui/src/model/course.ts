// The course of the selected session, and of a prepared work attempt: what the rail's lower region may say (docs/develop-course.md).
// Pure: no DOM, no network, no clock. A PRESENTATION ADAPTER and nothing else: every value is read from state the page already holds
// (the broker's last status and the transcript it served, a recording's detail, the attempts view). It governs nothing, stores nothing
// and decides nothing: the chart drawn from it is a picture of what was reported, never a state machine and never a verification.
//
// Each statement carries HOW it is known, in five words used everywhere here:
//   observed     Endophasia did or read it itself (its broker's own bookkeeping, a check it ran, the session log it read)
//   reported     the runtime said so (Pi's run events, Pi's reply); not checked against anything
//   declared     the operator recorded it (a prepared brief, a typed approval, a recorded outcome)
//   derived      computed here from the above, by a rule the text states
//   unavailable  not established by anything this page holds
// A stage's name says where the work is, never that it went well: "Check" is a stage; whether a check passed is its status.
import type { EndoCockpitDevelopSessionV0 } from "../../../protocol/cockpit-develop.ts";
import type { Attempt, AttemptsView } from "./attempts-wire.ts";
import { basesOf, markClassOf } from "./timeline.ts";
import { commandOpen, interventionOpen, type WorkbenchState } from "./workbench.ts";
import type { TranscriptItem, WorkbenchCommand, WorkbenchIntervention } from "./workbench-wire.ts";

export type CourseBasis = "observed" | "reported" | "declared" | "derived" | "unavailable";
export const COURSE_BASIS_WORDS: Readonly<Record<CourseBasis, { word: string; meaning: string }>> = {
	observed: { word: "observed", meaning: "Endophasia did or read this itself." },
	reported: { word: "reported", meaning: "The runtime said so. Nothing checked it." },
	declared: { word: "declared", meaning: "You recorded this." },
	derived: { word: "derived", meaning: "Computed on this page from what it holds." },
	unavailable: { word: "unknown", meaning: "Nothing this page holds establishes it." },
};

/** How a step or a node stands. `done` means it happened, not that it was right. */
export type CourseStatus =
	| "done"
	| "current"
	| "waiting"
	| "failed"
	| "interrupted"
	| "unknown"
	| "pending"
	| "skipped";
export const COURSE_STATUS_WORDS: Readonly<Record<CourseStatus, string>> = {
	done: "happened",
	current: "now",
	waiting: "waiting",
	failed: "failed",
	interrupted: "interrupted",
	unknown: "unknown",
	pending: "not yet",
	skipped: "not taken",
};

export interface CourseNode {
	id: string;
	label: string;
	/** Whether the session is at this node, as of the last read. At most one per lane. */
	on: boolean;
	status: CourseStatus;
	basis: CourseBasis;
}
export interface CourseLane {
	id: "run" | "request";
	label: string;
	nodes: CourseNode[];
	/** The state in a few words, for beside the track: the lit node's name, with what is happening inside it. */
	state: string;
	/** One sentence for the lane's current node. */
	text: string;
	basis: CourseBasis;
	status: CourseStatus;
}

/** One run among the items this page holds: from a "run started" marker to the next "run ended" (or to the end of what is held). */
export interface CourseRun {
	/** 1-based among the runs HELD here. Earlier runs may have been dropped: it is not the session's run number. */
	ordinal: number;
	/** The transcript position of its start marker, or null when the run began before what is held. */
	startSeq: number | null;
	endSeq: number | null;
	state: "open" | "ended";
	tools: number;
	running: number;
	errors: number;
	messages: number;
	/** What a message in it reported about how it stopped. */
	reportedError: boolean;
	reportedAbort: boolean;
	interventions: { operation: WorkbenchIntervention["operation"]; state: WorkbenchIntervention["state"] }[];
}

export interface LiveCourse {
	kind: "live";
	/** The broker did not answer the last read: everything here is what it last reported. */
	stale: boolean;
	lanes: [CourseLane, CourseLane];
	runs: CourseRun[];
	totals: { runs: number; tools: number; errors: number; dropped: number };
}

const node = (id: string, label: string, on: boolean, status: CourseStatus, basis: CourseBasis): CourseNode => ({
	id,
	label,
	on,
	status: on ? status : "pending",
	basis,
});

/** The runs among the held items, oldest first. Items before the first held start marker belong to a run whose start is not held. */
export function runsOf(items: readonly TranscriptItem[], interventions: readonly WorkbenchIntervention[]): CourseRun[] {
	const runs: CourseRun[] = [];
	let open: CourseRun | null = null;
	const begin = (startSeq: number | null): CourseRun => {
		const run: CourseRun = {
			ordinal: runs.length + 1,
			startSeq,
			endSeq: null,
			state: "open",
			tools: 0,
			running: 0,
			errors: 0,
			messages: 0,
			reportedError: false,
			reportedAbort: false,
			interventions: [],
		};
		runs.push(run);
		return run;
	};
	let marked = false;
	for (const item of items) {
		if (item.kind === "run") {
			marked = true;
			if (item.state === "started") open = begin(item.seq);
			else {
				// An end with no held start: the run began before what this page holds.
				const run: CourseRun = open ?? begin(null);
				run.endSeq = item.seq;
				run.state = "ended";
				open = null;
			}
			continue;
		}
		// Before any held marker, a tool call or an assistant message belongs to a run whose start is not held. After one, an item outside
		// a run (the user's next message) is part of no run held here.
		if (open === null && !marked && (item.kind === "tool" || item.role === "assistant")) open = begin(null);
		if (open === null) continue;
		if (item.kind === "tool") {
			open.tools += 1;
			if (item.status === "running") open.running += 1;
			if (item.status === "error") open.errors += 1;
		} else {
			open.messages += 1;
			if (item.stopReason === "error") open.reportedError = true;
			if (item.stopReason === "aborted") open.reportedAbort = true;
		}
	}
	// An intervention belongs to the run that was open at the transcript position it was requested at.
	for (const i of interventions) {
		const run = runs.find(
			(r) => r.startSeq !== null && i.afterSeq >= r.startSeq && (r.endSeq === null || i.afterSeq < r.endSeq),
		);
		run?.interventions.push({ operation: i.operation, state: i.state });
	}
	return runs;
}

const OPERATION_NAME = {
	prompt: "prompt",
	attempt: "attempt",
	steer: "steer",
	queue: "queue",
	stop: "stop",
} as const;

/** The live session's course, from the broker's last report and the transcript this page holds. Nothing is inferred beyond the rule stated. */
export function liveCourse(s: WorkbenchState): LiveCourse {
	const status = s.status;
	const stale = s.unreachable;
	const runs = runsOf(s.items, s.interventions);
	const connected = status !== null && status.connection === "connected";
	const active = connected && status.run === "active";
	const idle = connected && status.run === "idle";
	const lastRun = runs.at(-1) ?? null;
	const toolRunning = active && lastRun !== null && lastRun.state === "open" && lastRun.running > 0;
	const writing = active && s.open !== null;
	const runText =
		status === null
			? stale
				? "The broker did not answer. Nothing about the session is known here."
				: "Not read yet."
			: status.connection === "disconnected"
				? "Disconnected: the broker has no admitted connection now."
				: active
					? toolRunning
						? "A run is open, and a tool call it made has no result yet."
						: writing
							? "A run is open, and a message is being written."
							: "A run is open."
					: idle
						? "No run is open."
						: "Connected. Whether a run is open was not reported.";
	const runLane: CourseLane = {
		id: "run",
		label: "Run",
		nodes: [
			node("disconnected", "disconnected", status !== null && !connected, "interrupted", "observed"),
			node("idle", "idle", idle, "done", "reported"),
			node("open", "run open", active, "current", "reported"),
		],
		// One node is lit. What is happening inside an open run is said in words, not drawn as a second state.
		state:
			status === null
				? "not known"
				: !connected
					? "disconnected"
					: active
						? toolRunning
							? "run open · tool running"
							: writing
								? "run open · writing"
								: "run open"
						: idle
							? "idle"
							: "not reported",
		text: stale && status !== null ? `Last reported: ${runText.charAt(0).toLowerCase()}${runText.slice(1)}` : runText,
		basis: status === null || stale ? "unavailable" : connected ? "reported" : "observed",
		status: status === null || stale ? "unknown" : !connected ? "interrupted" : active ? "current" : "done",
	};

	// The one request in flight: a prompt (or an attempt's brief) the broker holds, else the first intervention still moving.
	const command = commandOpen(s.command) ? (s.command as WorkbenchCommand) : null;
	const moving =
		s.interventions.find((i) => i.state === "awaiting-approval") ??
		s.interventions.find((i) => i.state === "dispatching") ??
		s.interventions.find((i) => interventionOpen(i)) ??
		null;
	const operation: keyof typeof OPERATION_NAME | null =
		command !== null ? (command.attempt === null ? "prompt" : "attempt") : (moving?.operation ?? null);
	const stage =
		command !== null
			? command.state === "awaiting-approval"
				? "awaiting"
				: "sending"
			: moving === null
				? "none"
				: moving.state === "awaiting-approval"
					? "awaiting"
					: moving.state === "dispatching"
						? "sending"
						: "sent";
	const name = operation === null ? "" : OPERATION_NAME[operation];
	const requestLane: CourseLane = {
		id: "request",
		label: "Request",
		nodes: [
			node("none", "none", stage === "none", "done", "observed"),
			node("awaiting", "awaits terminal", stage === "awaiting", "waiting", "observed"),
			node("sending", "sending", stage === "sending", "current", "observed"),
			node("sent", "sent", stage === "sent", "current", "observed"),
		],
		state:
			stage === "none"
				? "none"
				: `${name} ${stage === "awaiting" ? "awaits terminal" : stage === "sending" ? "sending" : "sent, reply pending"}`,
		text:
			stage === "none"
				? "Nothing is waiting to be sent."
				: stage === "awaiting"
					? `A ${name} waits for your approval in the attached terminal. Nothing has been sent.`
					: stage === "sending"
						? `A ${name} was approved in the terminal and is being sent.`
						: `A ${name} was sent to Pi. Its reply has not been seen.`,
		basis: status === null || stale ? "unavailable" : "observed",
		status:
			status === null || stale
				? "unknown"
				: stage === "none"
					? "done"
					: stage === "awaiting"
						? "waiting"
						: "current",
	};
	// When the broker does not answer, nothing is lit as where the session IS: the last report is said in words only.
	const dim = (lane: CourseLane): CourseLane =>
		stale
			? {
					...lane,
					nodes: lane.nodes.map((n) => ({ ...n, on: false, status: "pending" as const })),
					state: `last reported: ${lane.state}`,
				}
			: lane;
	return {
		kind: "live",
		stale,
		lanes: [dim(runLane), dim(requestLane)],
		runs,
		totals: {
			runs: runs.length,
			tools: runs.reduce((n, r) => n + r.tools, 0),
			errors: runs.reduce((n, r) => n + r.errors, 0),
			dropped: s.evicted + s.trimmed,
		},
	};
}

/** One sentence for a held run, saying no more than its items did. */
export function runWords(r: CourseRun): string {
	const parts = [
		r.state === "open" ? "open, no end seen" : "ended",
		`${r.tools} tool call${r.tools === 1 ? "" : "s"}`,
		...(r.running > 0 ? [`${r.running} with no result yet`] : []),
		...(r.errors > 0 ? [`${r.errors} reported as error`] : []),
		...(r.reportedError ? ["a message reported a run error"] : []),
		...(r.reportedAbort ? ["a message reported an abort"] : []),
		...r.interventions.map((i) => `${i.operation} ${i.state.replace("-", " ")}`),
	];
	return parts.join(" · ");
}

export interface RecordedMark {
	sequence: number;
	/** Which of the strip's four rows it sits on. */
	row: "run" | "message" | "tool" | "other";
	/** The provenance class of its presented fields (the same mark the activity table draws). */
	mark: string;
	flagged: boolean;
}
export interface RecordedCourse {
	kind: "recorded";
	state: string;
	runs: number;
	turns: number;
	lastRunOutcome: string | null;
	tools: { calls: number | null; errors: number | null };
	flagged: number;
	loaded: number;
	total: number;
	marks: RecordedMark[];
}

const ROW_OF: Readonly<Record<string, RecordedMark["row"]>> = {
	lifecycle: "run",
	agent: "run",
	message: "message",
	tool: "tool",
};

/** A recording's course: its recorded lifecycle and the events loaded, in storage order. Null when the recording is not inspectable. */
export function recordedCourse(detail: EndoCockpitDevelopSessionV0): RecordedCourse | null {
	const recorded = detail.session.recorded;
	if (recorded === null) return null;
	const flagged = detail.activity.flagged;
	return {
		kind: "recorded",
		state: recorded.state,
		runs: recorded.runs,
		turns: recorded.turns,
		lastRunOutcome: recorded.lastRunOutcome,
		tools: detail.activity.tools,
		flagged: flagged.interruption + flagged.discontinuity + flagged.anomaly + flagged.unrecognized,
		loaded: detail.activity.entries.length,
		total: detail.activity.total,
		marks: detail.activity.entries.map((entry) => ({
			sequence: entry.storageSequence,
			row: ROW_OF[entry.category] ?? "other",
			mark: markClassOf(basesOf(entry)),
			flagged: entry.flags.length > 0,
		})),
	};
}

export interface CourseStep {
	id: "brief" | "authorise" | "send" | "run" | "check" | "judge";
	label: string;
	status: CourseStatus;
	basis: CourseBasis;
	text: string;
}
export interface AttemptCourse {
	kind: "attempt";
	attemptId: string;
	steps: CourseStep[];
	/** The step the attempt stands at. */
	at: CourseStep["id"];
	/** The operator recorded an outcome: nothing on it asks for attention any more. */
	closed: boolean;
}

const step = (
	id: CourseStep["id"],
	label: string,
	status: CourseStatus,
	basis: CourseBasis,
	text: string,
): CourseStep => ({ id, label, status, basis, text });

/**
 * A prepared attempt as six stages, each read from its own record. These are the stages the records have: there is no Fix or Build stage
 * because nothing records one. No stage's status is taken from the conversation, and none says the work is right.
 */
export function attemptCourse(a: Attempt, command: WorkbenchCommand | null): AttemptCourse {
	const mine = command !== null && command.attempt?.attemptId === a.id ? command : null;
	const e = a.execution;
	const brief = step(
		"brief",
		"Brief",
		"done",
		"declared",
		[
			"You prepared it.",
			...(a.taskWordsChanged.length > 0 ? ["The task's words have changed since."] : []),
			...(e?.brief === "differs" ? ["Its brief, rendered now, is not the text that was approved."] : []),
		].join(" "),
	);
	const assent = (status: CourseStatus, basis: CourseBasis, text: string) =>
		step("authorise", "Assent", status, basis, text);
	const authorise =
		e !== null
			? assent("done", "declared", "You approved sending it, in the terminal. Recorded once.")
			: mine !== null && mine.state === "awaiting-approval"
				? assent("waiting", "observed", "Waiting for your approval in the attached terminal.")
				: mine !== null && mine.state === "dispatching"
					? assent("current", "observed", "Approved in the terminal; being recorded and sent.")
					: // The broker says it was bound or sent, and the attempt's records were read before that: awaited, never "not requested".
						mine !== null &&
							(mine.attempt?.bound === true || mine.state === "accepted" || mine.state === "unknown")
						? assent(
								"unknown",
								"observed",
								"The workbench recorded it as sent. The attempt's records are not read yet.",
							)
						: mine !== null && mine.state === "refused"
							? assent("pending", "observed", "Requested, and not sent. No authorisation is recorded.")
							: a.state === "handed-off"
								? assent("skipped", "declared", "You recorded handing it to another agent.")
								: assent("pending", "unavailable", "Not requested. No authorisation is recorded.");
	const sent = e !== null && (e.send === "runtime-accepted" || e.send === "sent-no-reply");
	// Whether a send happened is not known: the log could not be read, or does not hold the request.
	const blind = e !== null && (e.send === "evidence-unavailable" || e.send === "not-attributable");
	const partial = e?.evidence === "partial" ? " The session's log was read only in part." : "";
	const send =
		e === null
			? step("send", "Send", a.state === "handed-off" ? "skipped" : "pending", "unavailable", "No send is recorded.")
			: e.send === "runtime-accepted"
				? step("send", "Send", "done", "reported", "Sent to Pi, and Pi acknowledged it. A reply, not completion.")
				: e.send === "sent-no-reply"
					? step("send", "Send", "unknown", "observed", "Sent to Pi. Pi's reply was not recorded.")
					: e.send === "refused-by-runtime"
						? step("send", "Send", "failed", "reported", "Sent to Pi, and Pi refused it.")
						: e.send === "not-sent"
							? step("send", "Send", "failed", "observed", "Not sent: the workbench refused it before sending.")
							: e.send === "no-send-recorded"
								? step("send", "Send", "pending", "observed", "No send is recorded as of this read.")
								: step(
										"send",
										"Send",
										"unknown",
										"unavailable",
										"The session's log could not be read or does not hold the request.",
									);
	const run = (() => {
		const of = (status: CourseStatus, basis: CourseBasis, text: string) =>
			step("run", "Run", status, basis, `${text}${partial}`);
		if (e === null)
			return of(a.state === "handed-off" ? "skipped" : "pending", "unavailable", "No run is recorded for it.");
		if (blind) return of("unknown", "unavailable", "Whether a run followed is not known: nothing is attributed.");
		if (e.send === "no-send-recorded") return of("pending", "unavailable", "No run is recorded for it.");
		// Refused before sending, or refused by Pi: nothing ran.
		if (!sent) return of("skipped", "observed", "Nothing was sent that could run.");
		switch (e.run) {
			case "open":
				return of("current", "reported", "A run started. No end is recorded.");
			case "completed":
				return of("done", "reported", "Pi reported the run completed. Not verified.");
			case "failed":
				return of("failed", "reported", "Pi reported the run failed.");
			case "aborted":
				return of("interrupted", "reported", "Pi reported the run aborted.");
			case "interrupted":
				return of(
					"interrupted",
					"observed",
					"The Pi process or its observer ended with the run open. No outcome was reported.",
				);
			case "process-ended":
				return of("interrupted", "observed", "The Pi process ended before a run started.");
			case "unclassified":
				return of("unknown", "reported", "The run ended with no stop reason reported.");
			default:
				return of("pending", "observed", "No run is recorded for it yet.");
		}
	})();
	const receipts = a.receipts;
	const unread = receipts.state !== "ready" || receipts.problems > 0;
	const check = (() => {
		const of = (status: CourseStatus, basis: CourseBasis, text: string) =>
			step("check", "Check", status, basis, text);
		const plan = a.verification;
		// With a verification plan, the stage follows the plan's own ledger (its checks as they stand at HEAD), never a count of receipts.
		if (plan !== null && plan.checks.length > 0) {
			const states = plan.checks.map((c) => c.state as string);
			const n = (state: string) => states.filter((s) => s === state).length;
			const text = `Planned checks at HEAD: ${n("passed")} passed, ${n("failed")} failed, ${states.length - n("passed") - n("failed")} not settled. Task has each one.`;
			if (n("failed") > 0) return of("failed", "observed", text);
			if (states.some((s) => s === "inconclusive" || s === "mixed" || s === "unavailable"))
				return of("unknown", "observed", text);
			return of(n("passed") === states.length ? "done" : "pending", "observed", text);
		}
		if (receipts.list.length === 0)
			return unread
				? of("unknown", "unavailable", "Its checks could not all be read.")
				: of("pending", "observed", "No check is recorded.");
		// Without a plan, the newest check Endophasia ran stands for the stage: an older failure a later run superseded is history.
		const newest = receipts.list[receipts.list.length - 1]!.outcome;
		const more = receipts.list.length - 1;
		return of(
			newest === "failed" ? "failed" : newest === "passed" && !unread ? "done" : "unknown",
			"observed",
			`The newest check Endophasia ran ${newest === "inconclusive" ? "was inconclusive" : newest}${more > 0 ? ` (${more} earlier)` : ""}${unread ? "; some could not be read" : ""}. It holds for the commit it ran at; Task relates it to HEAD.`,
		);
	})();
	const judge =
		a.outcome === null
			? step("judge", "Judge", "pending", "unavailable", "Yours. Whether the task is done is your decision.")
			: a.outcome.kind === "reported"
				? step("judge", "Judge", "done", "declared", "You recorded a result: reported, not verified.")
				: step("judge", "Judge", "skipped", "declared", "You recorded it as abandoned.");
	const steps = [brief, authorise, send, run, check, judge];
	// Where it stands: the first stage that is not behind it. A send whose reply was not seen is behind it once a run is known; an attempt
	// with a recorded outcome stands at Judge whatever came before.
	const behind = (s: CourseStep) =>
		s.status === "done" ||
		s.status === "skipped" ||
		(s.id === "send" && s.status === "unknown" && run.status !== "pending" && run.status !== "unknown");
	const at = a.outcome !== null ? judge : (steps.find((s) => !behind(s)) ?? judge);
	return { kind: "attempt", attemptId: a.id, steps, at: at.id, closed: a.outcome !== null };
}

/**
 * The attempt the course shows: the one the broker's open request names, when it is among the selected task's attempts (as nextStep
 * does: what is happening now comes first), else the newest. Null when the attempts are not read.
 */
export function courseAttempt(view: AttemptsView | null, command: WorkbenchCommand | null): Attempt | null {
	if (view === null || view.state !== "ready" || view.attempts.length === 0) return null;
	const named = commandOpen(command) ? view.attempts.find((a) => a.id === command?.attempt?.attemptId) : undefined;
	return named ?? ([...view.attempts].sort((a, b) => b.preparedAtMs - a.preparedAtMs)[0] as Attempt);
}

/** Whether something on the course asks for the operator: a request waiting for the terminal, or a failed or interrupted stage. */
export function courseAttention(live: LiveCourse | null, attempt: AttemptCourse | null): "waiting" | "fault" | null {
	if (live?.lanes[1].status === "waiting") return "waiting";
	if (attempt?.steps.some((s) => s.status === "waiting")) return "waiting";
	if (attempt?.closed === false && attempt.steps.some((s) => s.status === "failed" || s.status === "interrupted"))
		return "fault";
	if (live?.lanes[0].status === "interrupted") return "fault";
	return null;
}
