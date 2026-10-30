// The ledger: what the Field appearance of DEVELOP says when there is nothing to read yet. It answers the four questions the workbench
// exists to keep apart: what is known (and how), what is not known, what can be done from here, and what only the operator can do.
// Every line is built from state the page already holds; nothing is inferred. Pure: no DOM, no clock (times are passed in, already
// written out), no randomness.
import type { LifecycleState } from "./develop.ts";
import { countParts, REASON_WORDS } from "./project.ts";
import type { Project } from "./project-wire.ts";
import type { WorkbenchStatus } from "./workbench-wire.ts";

/** How a line is known. The first four are drawn with the provenance marks; a standing fact is a statement of how the system works. */
export type LedgerBasis = "observed" | "reported" | "recorded" | "unavailable" | "standing";

export interface LedgerLine {
	basis: LedgerBasis;
	text: string;
}

export interface Ledger {
	/** The sentence at the head: what is the case, at most one clause of it in mono (an identifier). */
	statement: { before: string; mono: string | null; after: string };
	/** One line under it: where the statement comes from. */
	source: string;
	known: LedgerLine[];
	unknown: LedgerLine[];
	possible: LedgerLine[];
	yours: LedgerLine[];
}

export interface LedgerInput {
	workbench: "unknown" | "available" | "absent";
	status: WorkbenchStatus | null;
	/** When the status was read, by the browser's clock, already written out; null when it has not been read. */
	statusAt: string | null;
	unreachable: boolean;
	/** The page is re-reading the broker by itself now (Follow on, or a request or check open). If not, the status is as last read. */
	following: boolean;
	paired: boolean;
	/** What waits for approval in the terminal, if anything: the operation, the short digest and when it expires (written out). */
	awaiting: { operation: "prompt" | "steer" | "queue" | "stop"; digest: string; expires: string } | null;
	/** The worktree as last read, or why it is not known. */
	project:
		| { kind: "ready"; project: Project }
		| { kind: "unavailable"; reason: string }
		| { kind: "unpaired" | "unsupported" | "unread" | "reading" };
	/** The recorded sessions the page has listed, with the condition of the store they were read from; null before the list was read. */
	recordings: {
		condition: "absent" | "empty" | "readable" | "degraded" | "unopenable";
		loaded: number;
		total: number;
		states: Readonly<Partial<Record<LifecycleState, number>>>;
	} | null;
}

const short = (alias: string): string => alias.replace(/^endo\.session\./, "");

const OPS = ["prompt", "steer", "queue", "stop"] as const;
const OP_NAME: Readonly<Record<(typeof OPS)[number], string>> = {
	prompt: "Prompt",
	steer: "Steer",
	queue: "Queue",
	stop: "Stop",
};
const OP_DOES: Readonly<Record<(typeof OPS)[number], string>> = {
	prompt: "a new prompt, which starts a run",
	steer: "change the run that is open",
	queue: "a follow-up for when the run's work is done",
	stop: "ask Pi to abort the run that is open",
};

export function ledger(input: LedgerInput): Ledger {
	const { status } = input;
	const known: LedgerLine[] = [];
	const unknown: LedgerLine[] = [];
	const possible: LedgerLine[] = [];
	const yours: LedgerLine[] = [];

	// The recordings are the same on every server: the store holds them, and they say what was recorded, never what is running.
	// An absent store is not an empty one, and a store that cannot be opened says nothing about what it holds.
	if (input.recordings !== null) {
		const { loaded, total, condition } = input.recordings;
		if (condition === "absent")
			unknown.push({
				basis: "unavailable",
				text: "Recordings: there is no event store here (absent, which is not empty).",
			});
		else if (condition === "unopenable")
			unknown.push({
				basis: "unavailable",
				text: "Recordings: the event store could not be opened, so what it holds is not known.",
			});
		else
			known.push({
				basis: "recorded",
				text:
					total === 0
						? condition === "empty"
							? "The event store is empty: it holds no recording."
							: "This store holds no Pi or DSH recording."
						: `${total} recorded session${total === 1 ? "" : "s"} in this store${loaded < total ? ` (${loaded} listed so far)` : ""}${
								condition === "degraded"
									? ", listed from the readable part of a degraded log; what follows it is not readable here"
									: ""
							}.`,
			});
		const running = input.recordings.states.running ?? 0;
		if (running > 0)
			unknown.push({
				basis: "unavailable",
				text: `Whether anything still runs for the ${running} recording${running === 1 ? "" : "s"} last recorded running. A recording is not a process.`,
			});
		if (total > 0)
			possible.push({ basis: "standing", text: "Read a recording, then open it in Observe or Compare." });
	}

	if (input.workbench === "absent") {
		yours.push({
			basis: "standing",
			text: "This server only reads. To work with a live Pi session, attach it from a terminal with endo harness attach … --control --workbench.",
		});
		unknown.push({ basis: "unavailable", text: "Anything live: nothing is attached to this server." });
		return {
			statement: { before: "Nothing is attached here.", mono: null, after: "" },
			source: "endo studio: a read-only server over the recorded store.",
			known,
			unknown,
			possible,
			yours,
		};
	}

	if (input.workbench === "unknown" || (status === null && !input.unreachable))
		return {
			statement: { before: "Reading the workbench…", mono: null, after: "" },
			source: "Nothing has been read from it yet.",
			known,
			unknown,
			possible,
			yours,
		};

	const name = status?.session == null ? null : short(status.session);
	// The time is when THIS PAGE read the status (the browser's clock), never when Pi said anything.
	const at = input.statusAt === null ? "" : ` (read at ${input.statusAt}, browser clock)`;
	// Not being re-read, the status is what the last read said, and the sentence is in the past.
	const now = input.following;

	// The statement: what the broker said, or that it said nothing.
	let statement: Ledger["statement"];
	if (input.unreachable) statement = { before: "The broker did not answer.", mono: null, after: "" };
	else if (input.awaiting !== null) statement = { before: "Waiting for you in the terminal.", mono: null, after: "" };
	else if (status?.connection === "disconnected")
		statement = {
			before: "",
			mono: name ?? "The session",
			after: now ? " is disconnected." : " was disconnected at the last read.",
		};
	else {
		const state = status?.run === "active" ? ", with a run open" : status?.run === "idle" ? " and idle" : "";
		statement = {
			before: "",
			mono: name ?? "A Pi session",
			after: now
				? ` is connected${state}.`
				: ` was connected${state}${status?.run === "active" ? "," : ""} at the last read.`,
		};
	}
	const source = input.unreachable
		? `The last answer${status === null ? " never came" : ` said ${status.connection}${at}`}. Unreachable is not ended.`
		: now
			? `Reported through this broker and re-read every few seconds${at}.`
			: `Reported through this broker${at}. Not re-read since: switch Follow on to keep it current, or read the session again.`;

	// Known.
	if (status !== null && !input.unreachable) {
		known.unshift(
			status.connection === "connected"
				? {
						basis: "observed",
						text: `Connected: admitted by this broker${name === null ? "" : ` as ${name}`}${at}.`,
					}
				: { basis: "observed", text: `The broker reported no admitted connection${at}.` },
		);
		if (status.connection === "connected")
			known.splice(1, 0, {
				basis: "reported",
				text:
					status.run === "active"
						? `Pi reported a run open${at}.`
						: status.run === "idle"
							? `Pi reported the session idle${at}.`
							: "Pi has not reported a run state.",
			});
	}
	if (input.project.kind === "ready") {
		const p = input.project.project;
		if (p.repository !== null) {
			const head = p.head;
			const where =
				head === null
					? ""
					: head.kind === "branch"
						? ` on ${head.branch}`
						: head.kind === "detached"
							? " at a detached HEAD"
							: ` on ${head.branch} (no commit yet)`;
			const parts = countParts(p).map((part) => part.text);
			known.push({
				basis: "observed",
				text: `Worktree ${p.repository.label}${where}, read with Git: ${
					p.changes.state === "unavailable" ? "changes unknown" : parts.length === 0 ? "clean" : parts.join(" · ")
				}.`,
			});
		} else
			unknown.push({
				basis: "unavailable",
				text: `The worktree: ${REASON_WORDS[p.reason ?? "git-failed"] ?? REASON_WORDS["git-failed"]}`,
			});
	} else if (input.project.kind === "unavailable")
		unknown.push({
			basis: "unavailable",
			text: `The worktree: ${REASON_WORDS[input.project.reason] ?? REASON_WORDS["git-failed"]}`,
		});

	// Not known: what the workbench cannot see, said once, here.
	if (input.unreachable)
		unknown.unshift({
			basis: "unavailable",
			text: "Whether the session still runs: the broker did not answer, which is not the same as ended.",
		});
	unknown.push({
		basis: "unavailable",
		text: "What was said before this workbench started, and anything this page is not paired to read.",
	});
	if (input.project.kind === "ready" && input.project.project.repository !== null)
		unknown.push({ basis: "unavailable", text: "Who changed the files in the worktree: Git does not say." });

	// Possible: what the broker offers now, each with its reason when it does not.
	if (!input.paired)
		possible.unshift({
			basis: "standing",
			text: "Pair this page with the code shown in the attached terminal. Pairing approves nothing.",
		});
	else if (status !== null && !input.unreachable)
		for (const op of OPS) {
			const offer = status.offers[op];
			possible.push({
				basis: offer.offered ? "reported" : "unavailable",
				text: offer.offered
					? `${OP_NAME[op]}: ${OP_DOES[op]}. Requested here, approved in the terminal.`
					: `${OP_NAME[op]}: ${lower(offer.reason ?? "not offered now.")}`,
			});
		}

	// Yours: authority stays with the person at the terminal.
	if (input.awaiting !== null)
		yours.push({
			basis: "standing",
			text: `A ${input.awaiting.operation} (digest ${input.awaiting.digest}) waits for you in the attached terminal, until ${input.awaiting.expires} (browser clock). Approve or decline it there.`,
		});
	yours.push({
		basis: "standing",
		text: "Every prompt, steer, queue and stop is approved by you, in the attached terminal. This page can only request.",
	});
	yours.push({
		basis: "standing",
		text: "An approval there is a local confirmation, not proof of identity.",
	});

	return { statement, source, known, unknown, possible, yours };
}

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
