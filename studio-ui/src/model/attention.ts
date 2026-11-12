// The attention overview's classification (docs/designs/develop-attention.md): which tasks need the operator, which are under way, which are
// not started and which are finished, and the plain reasons why. Pure and deterministic: the same tasks and the same evidence give the same
// sections in the same order. No clock, no network, no model, no score. Every line follows from one recorded fact:
//
//   the operator's status        review -> a decision waits on them; blocked -> recorded by them (it may be waiting on someone else)
//   a planned check              v1: an attempt with a plan, read by its own acceptance ledger (the Task view's states and words): failed,
//                                inconclusive or disagreeing at HEAD; without a current result it is said, and a review rechecks it
//   an observed check            the LATEST receipt of each other command (by exit status): failed or inconclusive, and how its commit
//                                relates to HEAD now
//   the operator's records       the newest attempt's state ("Result reported, not verified" stays exactly that)
//   what could not be read       counted and said, never taken as "nothing to see"
//
// It never says a task is accepted, failing, being worked on or approved: a status is the operator's, a check is evidence about one command
// at one commit, a handoff is the operator's statement, and a missing check is only missing.

import type { EndoReceiptOutcomeV0 } from "../../../protocol/develop-receipts.ts";
import type { EndoPlannedCheckStateV0 } from "../../../protocol/develop-verification.ts";
import { shortAttempt } from "./attempt-request.ts";
import type { LaunchReadState } from "./attempts-reader.ts";
import { ATTEMPT_LABELS, PLANNED_CHECK_LABELS } from "./attempts-wire.ts";
import type { AttentionCheck, AttentionPlanned, AttentionTask, AttentionView } from "./attention-wire.ts";
import type { Task } from "./workspace-wire.ts";

/** Why a task needs the operator. The order is the precedence: a task appears once, ranked by its first flag. */
export const FLAGS = ["decision", "failed", "inconclusive", "reconsider"] as const;
export type Flag = (typeof FLAGS)[number];
export const FLAG_WORDS: Readonly<Record<Flag, string>> = {
	decision: "Decision",
	failed: "Check failed",
	inconclusive: "Inconclusive",
	reconsider: "Recheck",
};

export type Section = "attention" | "waiting" | "open" | "done";

/** A receipt the Task view is asked to open (an overview row's check). */
export interface ReceiptFocus {
	attemptId: string;
	receiptId: string;
}

/** One line of a row: its kind, and its words, where a command is kept apart so it can be shown as code. */
export interface Line {
	kind: Flag | "blocked" | "evidence" | "note" | "warn";
	parts: readonly (string | { code: string })[];
	/** The receipt this line is about, when it is about one (the row opens it). */
	receipt?: { attemptId: string; receiptId: string };
	/** For a planned check's line: its ledger state, and whether it has no current result to show (the triage's `unsettled`). */
	planned?: EndoPlannedCheckStateV0;
	unsettled?: boolean;
}

export interface Item {
	task: Task;
	section: Section;
	flags: Flag[];
	lines: Line[];
	/** The receipt the row opens: the one behind its first check line, if any. */
	focus: { attemptId: string; receiptId: string } | null;
}

/** What is known of the evidence, as a whole. `shown`: the projection was read; anything else says why no checks are shown. */
export type EvidenceState = "shown" | "pending" | "absent" | "unreadable" | "unknown-project" | "failed";

export interface Overview {
	attention: Item[];
	waiting: Item[];
	open: Item[];
	done: Item[];
	evidence: EvidenceState;
	/** Some task's checks were not all read (unreadable, unusable, over the limit, or not in the projection): "none failed" is only of what was read. */
	gaps: boolean;
	/** Sentences about the read as a whole (HEAD not observed, a limit reached, the tasks changed since). */
	notes: string[];
	/** Some task not done has a planned check with no current result (not run here, stale, elsewhere, or its tree changed since). */
	unsettled: boolean;
}

const short = (sha: string): string => sha.slice(0, 7);

/** The line's words as plain text, a command in backticks: what a test, a title or a screen reader gets. */
export const lineText = (line: Line): string =>
	line.parts.map((p) => (typeof p === "string" ? p : `\`${p.code}\``)).join("");

function ended(c: AttentionCheck): string {
	const e = c.execution;
	switch (e.kind) {
		case "exited":
			return `exited with code ${e.code}`;
		case "signaled":
			return `was ended by ${e.signal}`;
		case "timed-out":
			return "was stopped at its time limit";
		case "interrupted":
			return "was interrupted";
		case "output-limit":
			return "went over the output limit";
		case "spawn-failed":
			return "could not be started";
	}
}

/** Where the check was recorded, relative to this worktree's HEAD now. */
function where(c: AttentionCheck): string {
	switch (c.relation) {
		case "at-head":
			return " at the current HEAD.";
		case "at-head-changed":
			return " at the current HEAD; the working tree has changed since.";
		case "head-differs":
			return ` at an earlier commit (${short(c.commit)}).`;
		case "other-worktree":
			return " in a different working tree; not compared with this one.";
		case "other-repository":
			return " in a different repository; not compared.";
		case "unavailable":
			return "; it cannot currently be compared with this worktree.";
	}
}

function otherWords(c: AttentionCheck): string {
	const { passed, failed, inconclusive } = c.others;
	const bits: string[] = [];
	if (c.outcome === "passed") {
		if (failed > 0) bits.push(`${failed} failed`);
		if (inconclusive > 0) bits.push(`${inconclusive} inconclusive`);
	} else if (passed > 0) bits.push(`${passed} passed`);
	return bits.length === 0 ? "" : ` Other runs of it here: ${bits.join(", ")}.`;
}

const at = (c: AttentionCheck) => ({ attemptId: c.attemptId, receiptId: c.receiptId });

/** A check's line. `review`: the task waits on a decision, so a pass that is not at the current, clean HEAD is a reason to look again. */
function checkLine(c: AttentionCheck, review: boolean, head: string | null): Line {
	if (c.outcome === "failed")
		return {
			kind: "failed",
			parts: ["Latest observed ", { code: c.command }, ` ${ended(c)}${where(c)}${otherWords(c)}`],
			receipt: at(c),
		};
	if (c.outcome === "inconclusive") {
		// An exit that came with reasons (HEAD moved, the tree changed) is inconclusive for those reasons; the first is enough here.
		const why =
			c.execution.kind === "exited" && c.reasons.length > 0
				? `exited with code ${c.execution.code}, but the observation is inconclusive`
				: ended(c);
		return {
			kind: "inconclusive",
			parts: ["Latest observed ", { code: c.command }, ` ${why}${where(c)}${otherWords(c)}`],
			receipt: at(c),
		};
	}
	if (review && c.relation !== "at-head") {
		const rest: Record<Exclude<AttentionCheck["relation"], "at-head">, string> = {
			"head-differs": ` belongs to an earlier commit (${short(c.commit)})${head === null ? "" : `; HEAD is now ${short(head)}`}.`,
			"at-head-changed": " was recorded at the current HEAD, but the working tree has changed since.",
			"other-worktree": " was recorded in a different working tree; not compared with this one.",
			"other-repository": " was recorded in a different repository; not compared.",
			unavailable: " cannot currently be compared with this worktree.",
		};
		return { kind: "reconsider", parts: ["Passing ", { code: c.command }, rest[c.relation]], receipt: at(c) };
	}
	return {
		kind: "evidence",
		parts: ["Latest observed ", { code: c.command }, ` passed${where(c)}${otherWords(c)}`],
		receipt: at(c),
	};
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`);

/** How the plan read a run, in a few words. */
const READ: Readonly<Record<EndoReceiptOutcomeV0, string>> = {
	passed: "passed",
	failed: "failed",
	inconclusive: "was inconclusive",
};

/**
 * The protocol's triage rule for a planned check (endoPlannedTriageV1, protocol/develop-attention.ts), mirrored; a contract test holds them
 * equal over every state, reading and count. A recorded failure is never dropped because the tree, the commit or the worktree moved on.
 */
export function plannedTriage(p: AttentionPlanned): "failed" | "inconclusive" | "unsettled" | "passed" {
	const there = p.elsewhere?.outcome ?? null;
	const here = plannedHere(p);
	if (there === "failed") return "failed";
	if (there === "inconclusive" && here !== "failed") return "inconclusive";
	return here;
}

function plannedHere(p: AttentionPlanned): "failed" | "inconclusive" | "unsettled" | "passed" {
	if (p.state === "failed") return "failed";
	if (p.state === "inconclusive" || p.state === "mixed") return "inconclusive";
	if (p.state === "passed") return p.incomplete ? "unsettled" : "passed";
	if (p.state === "not-run") return "unsettled";
	const reading = p.receipt?.outcome ?? null;
	const disagree = [p.atHead.passed, p.atHead.failed, p.atHead.inconclusive].filter((n) => n > 0).length >= 2;
	if (reading === "failed") return "failed";
	if (reading === "inconclusive" || disagree) return "inconclusive";
	return "unsettled";
}

/**
 * A planned check's line, in the Task view's words (PLANNED_CHECK_LABELS): its state is the attempt's ledger's, its kind the triage's.
 * Without a current result it says how the plan read the run behind it, and where. `attempt`: name the attempt (more than one is listed).
 */
function plannedLine(p: AttentionPlanned, review: boolean, attempt: boolean): Line {
	const by = p.behavioural ? " (read by its declared exit code and output)" : "";
	const { passed, failed, inconclusive } = p.atHead;
	const runs = [
		passed > 0 ? `${passed} passed` : "",
		failed > 0 ? `${failed} failed` : "",
		inconclusive > 0 ? `${inconclusive} inconclusive` : "",
	]
		.filter((x) => x !== "")
		.join(", ");
	const disagree = [passed, failed, inconclusive].filter((n) => n > 0).length >= 2;
	const r = p.receipt;
	const detail =
		p.state === "mixed"
			? ` (${runs})`
			: p.state === "passed" && p.incomplete
				? " (some of this attempt's receipt files could not be read; a later result may be among them)"
				: r === null
					? ""
					: p.state === "tree-changed"
						? ` (its latest run at HEAD ${READ[r.outcome]}${disagree ? `; runs there: ${runs}` : ""})`
						: p.state === "stale"
							? ` (its latest run, at ${short(r.commit)}, ${READ[r.outcome]})`
							: p.state === "elsewhere"
								? ` (its latest run there ${READ[r.outcome]})`
								: p.state === "unavailable"
									? ` (its latest run ${READ[r.outcome]}; this worktree's HEAD could not be read)`
									: "";
	const triage = plannedTriage(p);
	// A run in another working tree is said when it is what raised the triage (a pass there adds nothing to a line about here).
	const there = p.elsewhere;
	const raised = there !== null && there.outcome !== "passed" && plannedHere(p) !== triage;
	const away = raised ? `; in another working tree its latest run ${READ[there.outcome]}` : "";
	const kind: Line["kind"] =
		triage === "failed"
			? "failed"
			: triage === "inconclusive"
				? "inconclusive"
				: triage === "passed"
					? "evidence"
					: review
						? "reconsider"
						: "note";
	return {
		kind,
		parts: [
			"Planned check ",
			{ code: p.name },
			`: ${PLANNED_CHECK_LABELS[p.state]}${detail}${away}${by}${attempt ? ` (attempt ${shortAttempt(p.attemptId)})` : ""}.`,
		],
		// The row opens the run that raised it: the one elsewhere when that is what did.
		...(raised
			? { receipt: { attemptId: p.attemptId, receiptId: there.receiptId } }
			: r === null
				? {}
				: { receipt: { attemptId: p.attemptId, receiptId: r.receiptId } }),
		planned: p.state,
		unsettled: triage === "unsettled",
	};
}

/** What could not be read for this task: said, never taken as "nothing". */
function gaps(e: AttentionTask): Line[] {
	const lines: Line[] = [];
	if (e.unreadable > 0)
		lines.push({
			kind: "warn",
			parts: [
				`${plural(e.unreadable, "One attempt's", "attempts'")} checks could not be read; what is shown may be incomplete.`,
			],
		});
	if (e.problems > 0)
		lines.push({
			kind: "warn",
			parts: [`${plural(e.problems, "One file", "files")} among its checks could not be used.`],
		});
	if (e.records > 0)
		lines.push({
			kind: "warn",
			parts: [
				`${plural(e.records, "One of its attempt records", "of its attempt records")} could not be used; its latest attempt's state may be wrong.`,
			],
		});
	if (e.skipped > 0)
		lines.push({
			kind: "warn",
			parts: [
				`${plural(e.skipped, "One attempt's", "attempts'")} checks were not read: the overview's read limit was reached.`,
			],
		});
	return lines;
}

/** The note the operator wrote when they moved the task to its present status, if they wrote one. */
function statusNote(task: Task): string | null {
	const last = task.history.at(-1);
	return last !== undefined && last.to === task.status && last.note !== null && last.note !== "" ? last.note : null;
}

/** When the task entered its present status (the last change to it), else when it was last touched. */
function since(task: Task): number {
	for (let i = task.history.length - 1; i >= 0; i -= 1) {
		const change = task.history[i];
		if (change !== undefined && change.to === task.status) return change.atMs;
	}
	return task.updatedAtMs;
}

interface Ranked extends Item {
	/** The time the row is ordered by within its section (most recent first). */
	at: number;
}

function classify(task: Task, evidence: EvidenceState, view: AttentionView | null): Ranked {
	const lines: Line[] = [];
	const flags: Flag[] = [];
	const review = task.status === "review";
	if (review) {
		flags.push("decision");
		lines.push({ kind: "decision", parts: ["Marked ready for review; the decision is yours."] });
	}
	if (task.status === "blocked") lines.push({ kind: "blocked", parts: ["Marked blocked by you."] });
	const note = statusNote(task);
	if (note !== null && (review || task.status === "blocked"))
		lines.push({ kind: "note", parts: [`Your note: “${note}”`] });

	let at = since(task);
	const e = evidence === "shown" && view !== null ? view.tasks.find((t) => t.taskId === task.id) : undefined;
	if (task.status !== "done" && evidence === "shown") {
		if (e === undefined)
			lines.push({
				kind: "warn",
				parts: ["Its checks were not read: it changed after the overview was last read. Refresh to read them."],
			});
		else {
			const head = view?.head?.commit ?? null;
			// Where the task also has planned checks, a line no plan reads says so: its receipt belongs to an attempt without a plan, or to a
			// command its plan does not name, and is read by exit status (an attempt's plan never decides another attempt's receipt).
			const unplanned = (l: Line): Line =>
				e.planned.length === 0
					? l
					: { ...l, parts: [...l.parts, " No plan reads this check; this is its exit status."] };
			const checks = [
				...e.planned.map((p) => plannedLine(p, review, new Set(e.planned.map((x) => x.attemptId)).size > 1)),
				...e.checks.map((c) => unplanned(checkLine(c, review, head))),
			];
			if (e.morePlanned.checks > 0)
				checks.push({
					kind:
						e.morePlanned.notPassing > 0
							? "warn"
							: review && e.morePlanned.notCurrent > 0
								? "reconsider"
								: "note",
					parts: [
						`${plural(e.morePlanned.checks, "One more planned check is", "more planned checks are")} not listed${e.morePlanned.notPassing > 0 ? `, ${e.morePlanned.notPassing} failed, inconclusive or disagreeing` : ""}${e.morePlanned.notCurrent > 0 ? `, ${e.morePlanned.notCurrent} without a current result` : ""}; open the task to see every planned check.`,
					],
				});
			// A pass that is not current was cut by the per-task limit: a review still has to recheck it, and says so.
			if (review && e.more.notCurrent > 0)
				checks.push({
					kind: "reconsider",
					parts: [
						`${plural(e.more.notCurrent, "One more passing command was", "more passing commands were")} not recorded at the current, clean HEAD; open the task to see ${e.more.notCurrent === 1 ? "it" : "them"}.`,
					],
				});
			for (const kind of ["failed", "inconclusive", "reconsider"] as const)
				if (checks.some((l) => l.kind === kind)) flags.push(kind);
			// A row ranked by a check is ordered by when that kind of check last ended; a decision, by when the task entered review.
			const by = flags[0];
			if (by === "failed" || by === "inconclusive")
				at = Math.max(
					...e.planned.filter((_, i) => checks[i]?.kind === by).map((p) => p.receipt?.endedAtMs ?? 0),
					...e.checks.filter((_, i) => checks[e.planned.length + i]?.kind === by).map((c) => c.endedAtMs),
				);
			lines.push(...checks);
			if (e.more.commands > 0)
				lines.push({
					kind: e.more.notPassing > 0 ? "warn" : "note",
					parts: [
						`${plural(e.more.commands, "One more command was", "more commands were")} checked${e.more.notPassing > 0 ? `, ${e.more.notPassing} not passing` : ""}; open the task to see every check.`,
					],
				});
			// The newest attempt, where it tells the operator something: a reported result is a claim waiting to be checked; for work under
			// way, what was last recorded. Never as a sign that anyone is working on it.
			const quiet = flags.some((f) => f === "failed" || f === "inconclusive");
			if (
				e.latestAttempt !== null &&
				(e.latestAttempt.state === "reported" ||
					(!quiet && (task.status === "in-progress" || task.status === "blocked")))
			)
				lines.push({
					kind: "note",
					parts: [`Latest attempt: ${ATTEMPT_LABELS[e.latestAttempt.state]}.`],
				});
			// Absence is claimed only where everything was read; otherwise the gap lines below say what was not.
			// An attempt record that could not be placed may be this task's, so even "no attempts" is then only "none read".
			const complete = e.unreadable + e.skipped + e.problems + e.records === 0 && (view?.unattributed ?? 0) === 0;
			// Planned entries cut by the display limit may hold receipts, so absence is claimed only when none was cut (Codex, #144).
			if (
				review &&
				e.checks.length === 0 &&
				e.planned.every((p) => p.receipt === null) &&
				e.morePlanned.checks === 0
			)
				lines.push({
					kind: "note",
					parts: [
						complete
							? e.attempts === 0
								? "No attempts or observed checks recorded."
								: "No observed checks recorded."
							: e.attempts === 0
								? "No attempts or observed checks were read."
								: "No observed checks were read.",
					],
				});
			if (task.status === "open" && e.attempts > 0)
				lines.push({ kind: "note", parts: [`${plural(e.attempts, "One attempt", "attempts")} prepared.`] });
			lines.push(...gaps(e));
		}
	}
	flags.sort((a, b) => FLAGS.indexOf(a) - FLAGS.indexOf(b));
	// A row that needs attention for a check shows the checks that make it so; passing ones are in the task (a decision keeps them: they
	// are part of what is decided on).
	if (!review && flags.length > 0) lines.splice(0, lines.length, ...lines.filter((l) => l.kind !== "evidence"));
	const section: Section =
		task.status === "done" ? "done" : flags.length > 0 ? "attention" : task.status === "open" ? "open" : "waiting";
	// The row opens the receipt behind the flag that put it in its section (Codex, #144), then any other non-pass line's, then any.
	const first =
		lines.find((l) => l.receipt !== undefined && l.kind === flags.find((f) => f !== "decision")) ??
		lines.find((l) => l.receipt !== undefined && l.kind !== "evidence") ??
		lines.find((l) => l.receipt);
	return {
		task,
		section,
		flags,
		lines,
		focus: first?.receipt ?? null,
		at: section === "done" ? task.updatedAtMs : at,
	};
}

const RANK_WAITING: Readonly<Record<string, number>> = { blocked: 0, "in-progress": 1 };

/**
 * The overview. `tasks` are the workspace's (the statuses as last read); `view` is the attention projection when one was read, and
 * `evidence` says what is known of it. `revision` is the workspace's task file revision, to tell when the two reads disagree.
 */
export function overviewOf(
	tasks: readonly Task[],
	evidence: EvidenceState,
	view: AttentionView | null,
	revision: number | null,
): Overview {
	const usable = evidence === "shown" && view !== null && view.state === "ready";
	const state: EvidenceState = evidence === "shown" && view !== null && view.state !== "ready" ? view.state : evidence;
	const items = tasks.map((t) => classify(t, usable ? "shown" : state, usable ? view : null));
	const by = (a: Ranked, b: Ranked, rank: (r: Ranked) => number) =>
		rank(a) - rank(b) || b.at - a.at || (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0);
	const pick = (section: Section, rank: (r: Ranked) => number = () => 0): Item[] =>
		items
			.filter((i) => i.section === section)
			.sort((a, b) => by(a, b, rank))
			.map(({ at: _at, ...item }) => item);
	const notes: string[] = [];
	if (usable) {
		if (view.head === null) notes.push("This worktree's HEAD could not be read, so no check is compared with it.");
		if (view.truncated)
			notes.push("Not every check was read: the overview's read limit was reached. The tasks affected say so.");
		if (view.unattributed > 0)
			notes.push(
				`${plural(view.unattributed, "One attempt record", "attempt records")} could not be used and cannot be placed with a task, so any task's attempts and checks may be incomplete (endo attempt list names ${view.unattributed === 1 ? "it" : "them"}).`,
			);
		if (revision !== null && view.taskRevision !== revision)
			notes.push("The tasks changed after the checks were read. Refresh to read them together.");
	}
	return {
		attention: pick("attention", (r) => FLAGS.indexOf(r.flags[0] as Flag)),
		waiting: pick("waiting", (r) => RANK_WAITING[r.task.status] ?? 2),
		open: pick("open"),
		done: pick("done"),
		evidence: usable ? "shown" : state,
		gaps: (usable && view.unattributed > 0) || items.some((i) => i.lines.some((l) => l.kind === "warn")),
		notes,
		unsettled: items.some((i) => i.section !== "done" && i.lines.some((l) => l.unsettled === true)),
	};
}

/** Why no checks are shown, when none are: one sentence, so an empty list never reads as "all clear". */
export const EVIDENCE_WORDS: Readonly<Record<Exclude<EvidenceState, "shown">, string>> = {
	pending: "Reading the checks…",
	absent: "This workbench serves no attempt records, so no checks are shown. The statuses are yours, as recorded.",
	unreadable: "The attempt records or the task file could not be read, so no checks are shown. Nothing was changed.",
	"unknown-project": "This launch's project is not in the store, so no checks are shown.",
	failed: "The checks could not be read. The statuses are yours, as recorded; no check is shown.",
};

/**
 * What is known of the evidence, from the reader's state: the projection is used only when it was served by the launch that served the
 * tasks (`launchId`), so another launch's evidence is never shown as this one's. Nothing read yet is `pending`; a refusal or a failure, or a
 * projection of another launch, is `failed`; a workbench without the route is `absent`.
 */
export function evidenceOf(
	launchId: string,
	state: LaunchReadState<AttentionView>,
): { evidence: EvidenceState; record: AttentionView | null } {
	if (state.view !== null && state.view.launchId === launchId) return { evidence: "shown", record: state.view };
	if (state.view !== null) return { evidence: "failed", record: null };
	if (state.problem === "absent") return { evidence: "absent", record: null };
	return { evidence: state.problem === null || state.busy ? "pending" : "failed", record: null };
}
