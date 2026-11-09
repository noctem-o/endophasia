// The DEVELOP attempts service: the one implementation of the operator's work-attempt operations (docs/designs/develop-work-attempts.md),
// shared by the `endo attempt` CLI (every change) and the workbench's launch scope (one read-only view).
//
//   caller (CLI | the workbench's GET workspace/attempts)
//   DevelopAttemptsServiceV0          prepare, handoff, report, abandon, list, get; viewFor(project)
//     |-- DevelopTasksStoreV0         READ only: the task an attempt is prepared on, and whether its words changed since
//     `-- DevelopAttemptsStoreV0      the write-once records under develop/attempts/
//
// What it guarantees: an attempt is prepared only on a task that exists in the named project, with the task's words copied as they were; a
// handoff or outcome is recorded once and never replaced; everything after preparation is marked as the operator's statement; the task
// file is never written (this module has no handle that could write it: it calls only `read()` on the task store).
//
// What none of its operations can do: send a prompt or a brief anywhere, start or select a session, read a transcript or an agent's
// reply, change a task's status, or approve anything. It is not an authentication boundary: who may hold it is decided by its caller (the
// CLI is the operator's own process; the workbench reaches only `viewFor`, for its launch's project, after the broker's grant check).

import { randomBytes } from "node:crypto";
import type { EndoDevelopAttemptExecutionViewV0 } from "../../protocol/develop-attempt-execution.ts";
import {
	checkEndoDevelopAttemptInputV0,
	ENDO_ATTEMPT_ID_PATTERN_V0,
	ENDO_DEVELOP_ATTEMPT_HANDOFF_SCHEMA_V0,
	ENDO_DEVELOP_ATTEMPT_LIMITS_V0,
	ENDO_DEVELOP_ATTEMPT_OUTCOME_SCHEMA_V0,
	ENDO_DEVELOP_ATTEMPT_SCHEMA_V0,
	ENDO_DEVELOP_ATTEMPT_SCHEMA_V1,
	ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V3,
	ENDO_DEVELOP_BRIEF_V0,
	ENDO_DEVELOP_BRIEF_V1,
	type EndoAttemptVerificationViewV0,
	type EndoDevelopAttemptHandoffV0,
	type EndoDevelopAttemptOutcomeV0,
	type EndoDevelopAttemptStateV0,
	type EndoDevelopAttemptsViewV3,
	type EndoDevelopAttemptV0,
	type EndoDevelopAttemptViewV3,
	type EndoDevelopTaskWordV0,
	endoAttemptPlanV0,
	endoDevelopAttemptStateV0,
	endoDevelopTaskWordsChangedV0,
	renderEndoDevelopBriefV0,
	validateEndoDevelopAttemptHandoffV0,
	validateEndoDevelopAttemptOutcomeV0,
	validateEndoDevelopAttemptV0,
} from "../../protocol/develop-attempts.ts";
import {
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	endoReceiptRelationV0,
} from "../../protocol/develop-receipts.ts";
import {
	checkEndoDevelopTextV0,
	ENDO_PROJECT_ID_PATTERN_V0,
	ENDO_TASK_ID_PATTERN_V0,
	type EndoDevelopTasksFileV1,
	type EndoDevelopUnreadableReasonV0,
} from "../../protocol/develop-tasks.ts";
import type {
	DevelopAttemptsStoreV0,
	EndoAttemptEntryV0,
	EndoAttemptProblemV0,
	EndoAttemptRecordKindV0,
} from "../../storage/develop-attempts.ts";
import { endoAttemptProblemsOfV0 } from "../../storage/develop-attempts.ts";
import type { DevelopReceiptsStoreV0 } from "../../storage/develop-receipts.ts";
import type { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { type EndoSessionLogReadV0, endoAttemptExecutionViewV0 } from "./develop-attempt-execution.ts";
import { endoAcceptanceLedgerV0 } from "./develop-verification.ts";

/**
 * Why an operation was refused. Nothing was written for any of them.
 * - `not-found`: no such project, task (in that project) or attempt.
 * - `bad-request`: an input was not acceptable (blank, too long, control characters, a malformed id).
 * - `limit`: the directory or the task has as many attempts as it may (remove some: delete their files).
 * - `already-recorded`: that handoff or outcome was recorded before (perhaps a moment ago, by another process); it is left as it is.
 * - `tasks-unreadable`: the task file cannot be read, so no attempt can be prepared on it (`reason` says why). It was not changed.
 * - `unreadable`: the attempts directory, or a file at the name a record would take, is not usable. Nothing was changed.
 * - `storage-failed`: the record could not be written; try again.
 */
export type DevelopAttemptsRefusalV0 =
	| "not-found"
	| "bad-request"
	| "limit"
	| "already-recorded"
	| "tasks-unreadable"
	| "unreadable"
	| "storage-failed";

export type DevelopAttemptsResultV0<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			code: DevelopAttemptsRefusalV0;
			reason?: EndoDevelopUnreadableReasonV0 | EndoAttemptProblemV0["reason"];
	  };

/** An attempt as the operator's terminal shows it: its records, its derived state, and what is known now of its task. */
export interface DevelopAttemptReportV0 extends EndoAttemptEntryV0 {
	state: EndoDevelopAttemptStateV0;
	/** What the session's records say happened after the operator authorised sending it to Pi; null when that was never authorised. */
	execution: EndoDevelopAttemptExecutionViewV0 | null;
	/**
	 * The task now: `present` (in the attempt's project), `not-found` (the task file is readable and has no such task in that project),
	 * `unavailable` (the task file cannot be read now). Only `present` compares words.
	 */
	task: "present" | "not-found" | "unavailable";
	taskWordsChanged: EndoDevelopTaskWordV0[];
	/**
	 * Each of the attempt's later records as this read found it (EVIDENCE-INTEGRITY-001): `recorded` (valid), `absent` (no file at its name,
	 * in a directory that was read whole), or `damaged` (a file at exactly that record's name is not a usable record: malformed, invalid,
	 * misnamed, over its bound, a link, or unreadable). `damaged` never means "absent": whether that record was written is unknown.
	 */
	records: Readonly<Record<Exclude<EndoAttemptRecordKindV0, "prepared">, EndoAttemptRecordStateV0>>;
	/** The problems at this attempt's own record names, as the store reported them (name and reason only; contents are never read out). */
	damaged: EndoAttemptProblemV0[];
	/**
	 * Only when the authorisation record is damaged and the session log was read whole: how many workbench sends in the log no readable
	 * authorisation record (of any attempt) accounts for, by exact proposal id. They may be plain workbench prompts, or this attempt's send;
	 * none is attributed. Null otherwise.
	 */
	unattributedWorkbenchSends: number | null;
}

export type EndoAttemptRecordStateV0 = "recorded" | "absent" | "damaged";

export interface DevelopAttemptsListV0 {
	attempts: DevelopAttemptReportV0[];
	/** Files in the directory that are not usable records (never shown as attempts; never written over). */
	problems: EndoAttemptProblemV0[];
}

const refuse = <T>(
	code: DevelopAttemptsRefusalV0,
	reason?: EndoDevelopUnreadableReasonV0 | EndoAttemptProblemV0["reason"],
): DevelopAttemptsResultV0<T> => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });

/**
 * Text from a receipt as the page shows it (an argument, a branch name): a control, bidirectional or separator character becomes U+FFFD,
 * and a long one is cut, so an odd argument or branch name cannot make the page refuse the whole view. The receipt file keeps it exactly.
 */
export const endoShownTextV0 = (text: string, max: number): string => {
	const safe = text.replace(
		/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g,
		"\ufffd",
	);
	return safe.length > max ? `${safe.slice(0, max - 1)}\u2026` : safe;
};

/**
 * One attempt's receipts as the workbench shows them: no path, each related to the reader's working tree. `records` are the receipts as
 * read (for the ledger), null when the directory could not be read.
 */
function receiptsOf(
	attemptId: string,
	receipts: { store: DevelopReceiptsStoreV0; current: EndoReceiptCurrentV0 | null } | null,
): { view: EndoDevelopAttemptViewV3["receipts"]; records: EndoDevelopReceiptV0[] | null } {
	if (receipts === null) return { view: { state: "ready", list: [], problems: 0 }, records: null };
	const read = receipts.store.read(attemptId);
	if (!read.ok) return { view: { state: "unreadable", list: [], problems: 0 }, records: null };
	const view: EndoDevelopAttemptViewV3["receipts"] = {
		state: "ready",
		list: read.receipts.map((r) => ({
			id: r.id,
			startedAtMs: r.startedAtMs,
			endedAtMs: r.endedAtMs,
			argv: r.check.argv.map((arg) => endoShownTextV0(arg, 400)),
			commit: r.revision.commit,
			branch: r.revision.branch === null ? null : endoShownTextV0(r.revision.branch, 1024),
			execution: r.execution,
			outcome: r.outcome,
			reasons: [...r.reasons],
			limitations: [...r.limitations],
			relation: endoReceiptRelationV0(r, receipts.current),
		})),
		problems: read.problems.length,
	};
	return { view, records: read.receipts };
}

/**
 * The plan and its ledger as the page shows them. Without readable receipts (no receipt store, or its directory unreadable) nothing is
 * compared: every check is `unavailable`, never `not-run`, since a receipt that could not be read may exist.
 */
export function endoAttemptVerificationViewV0(
	attempt: EndoDevelopAttemptV0,
	receipts: readonly EndoDevelopReceiptV0[] | null,
	current: EndoReceiptCurrentV0 | null,
): EndoAttemptVerificationViewV0 | null {
	const plan = endoAttemptPlanV0(attempt);
	if (plan === null) return null;
	const ledger = endoAcceptanceLedgerV0({
		plan,
		receipts: receipts ?? [],
		current: receipts === null ? null : current,
	});
	return {
		checks: ledger.checks.map((c, i) => {
			const planned = plan.checks[i] as (typeof plan.checks)[number];
			return {
				name: c.name,
				// Planned arguments are refused unless they can be shown exactly (protocol/develop-verification.ts): this is the argv itself.
				argv: [...planned.argv],
				shows: planned.shows,
				state: c.state,
				current: c.current,
				atHead: c.atHead,
				otherCommit: c.otherCommit,
				runs: c.runs,
			};
		}),
		criteria: ledger.criteria,
		unplanned: ledger.unplanned,
	};
}

export class DevelopAttemptsServiceV0 {
	readonly #tasks: DevelopTasksStoreV0;
	readonly #attempts: DevelopAttemptsStoreV0;
	readonly #now: () => number;
	readonly #sessionLog: () => EndoSessionLogReadV0;

	/**
	 * `sessionLog` reads the store's event log, read-only, for attempts that were authorised to be sent to Pi. It is called at most once per
	 * read, and only when such an attempt is in it. Without it, their execution is shown as `evidence-unavailable`.
	 */
	constructor(
		tasks: DevelopTasksStoreV0,
		attempts: DevelopAttemptsStoreV0,
		options: { now?: () => number; sessionLog?: () => EndoSessionLogReadV0 } = {},
	) {
		this.#tasks = tasks;
		this.#attempts = attempts;
		this.#now = options.now ?? Date.now;
		this.#sessionLog = options.sessionLog ?? (() => ({ state: "unavailable" }));
	}

	/** One read of the session log, shared by every attempt of one answer, made only if one of them needs it. */
	#logOnce(): () => EndoSessionLogReadV0 {
		let read: EndoSessionLogReadV0 | null = null;
		return () => {
			if (read === null) {
				try {
					read = this.#sessionLog();
				} catch {
					read = { state: "unavailable" };
				}
			}
			return read;
		};
	}

	#execution(
		entry: EndoAttemptEntryV0,
		log: () => EndoSessionLogReadV0,
		aliasOf?: (sessionId: string) => string,
	): EndoDevelopAttemptExecutionViewV0 | null {
		return entry.authorized === null
			? null
			: endoAttemptExecutionViewV0(entry.authorized, log(), renderEndoDevelopBriefV0(entry.attempt), aliasOf);
	}

	// ---- reading ---------------------------------------------------------------------------------------------------------------------

	/** The task file now, or null when it cannot be read (a missing file reads as empty, as everywhere). */
	#taskFile(): EndoDevelopTasksFileV1 | null {
		const read = this.#tasks.read();
		return read.ok ? read.file : null;
	}

	#report(
		entry: EndoAttemptEntryV0,
		file: EndoDevelopTasksFileV1 | null,
		log: () => EndoSessionLogReadV0 = this.#logOnce(),
		problems: readonly EndoAttemptProblemV0[] = [],
	): DevelopAttemptReportV0 {
		const { attempt } = entry;
		// Exact record names, or a misnamed record that claims this attempt: a damaged file of another attempt says nothing about this
		// one, and a stray `<id>.x.authorized.json` is not this attempt's authorisation record.
		const mine = endoAttemptProblemsOfV0(problems, attempt.id).filter(
			(x) => x.kind !== null && x.kind !== "prepared",
		);
		const damaged = mine.map((x) => x.problem);
		const stateOf = (kind: "handoff" | "outcome" | "authorized"): EndoAttemptRecordStateV0 =>
			entry[kind] !== null ? "recorded" : mine.some((x) => x.kind === kind) ? "damaged" : "absent";
		const task =
			file === null
				? undefined
				: file.tasks.find((t) => t.id === attempt.taskId && t.projectId === attempt.projectId);
		return {
			...entry,
			state: endoDevelopAttemptStateV0(entry.handoff, entry.outcome),
			execution: this.#execution(entry, log),
			task: file === null ? "unavailable" : task === undefined ? "not-found" : "present",
			taskWordsChanged: task === undefined ? [] : endoDevelopTaskWordsChangedV0(attempt, task),
			records: { handoff: stateOf("handoff"), outcome: stateOf("outcome"), authorized: stateOf("authorized") },
			damaged,
			unattributedWorkbenchSends: null,
		};
	}

	/**
	 * Workbench sends in a whole log that no readable authorisation record accounts for (exact proposal ids). Every valid authorisation
	 * counts, including one whose prepared record is damaged or missing: its send happened, and is accounted for, even though no attempt
	 * can be shown for it. Null for a log not read whole: what is missing from it could be either.
	 */
	#unattributedSends(authorizedProposalIds: readonly string[], log: EndoSessionLogReadV0): number | null {
		if (log.state !== "complete") return null;
		const accounted = new Set(authorizedProposalIds);
		return log.events.filter((e) => {
			if (e.kind !== "workbench.prompt-dispatched") return false;
			const payload = e.payload as { proposalId?: unknown } | null;
			return typeof payload?.proposalId !== "string" || !accounted.has(payload.proposalId);
		}).length;
	}

	/** Every attempt of a project (and, when given, one task), oldest first, with the directory's problems. */
	list(projectId: string, taskId?: string): DevelopAttemptsResultV0<DevelopAttemptsListV0> {
		if (
			!ENDO_PROJECT_ID_PATTERN_V0.test(projectId) ||
			(taskId !== undefined && !ENDO_TASK_ID_PATTERN_V0.test(taskId))
		)
			return refuse("bad-request");
		const read = this.#attempts.read();
		if (!read.ok) return refuse("unreadable", read.reason);
		const file = this.#taskFile();
		// A project the readable task file does not have is said, not answered with an empty list (a mistyped id would look like "none").
		if (file !== null && !file.projects.some((p) => p.id === projectId)) return refuse("not-found");
		const log = this.#logOnce();
		return {
			ok: true,
			value: {
				attempts: read.entries
					.filter(
						(e) => e.attempt.projectId === projectId && (taskId === undefined || e.attempt.taskId === taskId),
					)
					.map((e) => this.#report(e, file, log, read.problems)),
				problems: read.problems,
			},
		};
	}

	/** One attempt, by id. */
	get(attemptId: string): DevelopAttemptsResultV0<DevelopAttemptReportV0> {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return refuse("bad-request");
		const read = this.#attempts.read();
		if (!read.ok) return refuse("unreadable", read.reason);
		const entry = read.entries.find((e) => e.attempt.id === attemptId);
		if (entry === undefined) {
			// Files at this attempt's names that are not usable (its prepared record damaged, or later records without it): the attempt may
			// exist, so it is not "not found" (EVIDENCE-INTEGRITY-001).
			const at = endoAttemptProblemsOfV0(read.problems, attemptId)[0];
			return at === undefined ? refuse("not-found") : refuse("unreadable", at.problem.reason);
		}
		const log = this.#logOnce();
		const report = this.#report(entry, this.#taskFile(), log, read.problems);
		if (report.records.authorized === "damaged")
			report.unattributedWorkbenchSends = this.#unattributedSends(read.authorizedProposalIds, log());
		return { ok: true, value: report };
	}

	/** The brief of one attempt: a pure rendering of its prepared record. Reading it sends nothing and writes nothing. */
	brief(attemptId: string): DevelopAttemptsResultV0<string> {
		const got = this.get(attemptId);
		return got.ok ? { ok: true, value: renderEndoDevelopBriefV0(got.value.attempt) } : got;
	}

	/**
	 * The workbench's view: the attempts of the task the project has SELECTED, chosen from the task file, never from a request. The caller
	 * (the launch scope) supplies its own project id, and, for the receipts, the store and the working tree it compares them with (its own
	 * launch directory, observed by the caller; a path in a receipt is never used to choose what to read). Without a receipts store, every
	 * attempt's receipt list is empty.
	 */
	viewFor(
		projectId: string,
		receipts: { store: DevelopReceiptsStoreV0; current: EndoReceiptCurrentV0 | null } | null = null,
		aliasOf?: (sessionId: string) => string,
	): EndoDevelopAttemptsViewV3 {
		const empty = (state: EndoDevelopAttemptsViewV3["state"], taskId: string | null): EndoDevelopAttemptsViewV3 => ({
			schemaVersion: ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V3,
			state,
			taskId,
			attempts: [],
			problems: 0,
		});
		const file = this.#taskFile();
		if (file === null) return empty("unreadable", null);
		const project = file.projects.find((p) => p.id === projectId);
		const taskId = project?.selectedTaskId ?? null;
		if (taskId === null) return empty("no-task", null);
		const read = this.#attempts.read();
		if (!read.ok) return empty("unreadable", taskId);
		const log = this.#logOnce();
		return {
			schemaVersion: ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V3,
			state: "ready",
			taskId,
			attempts: read.entries
				.filter((e) => e.attempt.projectId === projectId && e.attempt.taskId === taskId)
				.map((e) => {
					const r = this.#report(e, file, () => ({ state: "unavailable" }));
					const seen = receiptsOf(e.attempt.id, receipts);
					return {
						id: e.attempt.id,
						state: r.state,
						preparedAtMs: e.attempt.preparedAtMs,
						taskRevision: e.attempt.task.revision,
						objective: e.attempt.objective,
						handoff:
							e.handoff === null
								? null
								: { recordedAtMs: e.handoff.recordedAtMs, target: e.handoff.target, note: e.handoff.note },
						outcome:
							e.outcome === null
								? null
								: { recordedAtMs: e.outcome.recordedAtMs, kind: e.outcome.kind, note: e.outcome.note },
						taskWordsChanged: r.taskWordsChanged,
						brief: renderEndoDevelopBriefV0(e.attempt),
						receipts: seen.view,
						// The session is shown by its presented alias: a label, never a handle to it.
						execution: this.#execution(e, log, aliasOf),
						verification: endoAttemptVerificationViewV0(e.attempt, seen.records, receipts?.current ?? null),
					};
				}),
			problems: read.problems.length,
		};
	}

	// ---- recording -------------------------------------------------------------------------------------------------------------------

	/**
	 * Prepare an attempt on a task: the task must be in the project (read from the task file now, lock-free: the task store replaces its file
	 * atomically, so this is one whole revision), and its words are copied. Writes one new file; the task file is not touched.
	 */
	prepare(
		projectId: string,
		taskId: string,
		input: { objective: unknown; constraints?: unknown; reportBack?: unknown; verification?: unknown },
	): DevelopAttemptsResultV0<EndoDevelopAttemptV0> {
		if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId) || !ENDO_TASK_ID_PATTERN_V0.test(taskId))
			return refuse("bad-request");
		const checked = checkEndoDevelopAttemptInputV0(input);
		if (!checked.ok) return refuse("bad-request");
		const tasks = this.#tasks.read();
		if (!tasks.ok) return refuse("tasks-unreadable", tasks.reason);
		const project = tasks.file.projects.find((p) => p.id === projectId);
		const task = tasks.file.tasks.find((t) => t.id === taskId && t.projectId === projectId);
		if (project === undefined || task === undefined) return refuse("not-found");
		const read = this.#attempts.read();
		if (!read.ok) return refuse("unreadable", read.reason);
		// Bounds on growth, checked now (see ENDO_DEVELOP_ATTEMPT_LIMITS_V0); problem files count too, since they occupy the directory.
		const prepared = read.entries.length + read.problems.filter((p) => p.name.endsWith(".prepared.json")).length;
		if (
			prepared >= ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxAttempts ||
			read.entries.filter((e) => e.attempt.taskId === taskId).length >= ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxPerTask
		)
			return refuse("limit");
		let attempt: EndoDevelopAttemptV0;
		try {
			// With a verification plan, a v1 record (brief v1, which renders the plan); without one, exactly the v0 record as before.
			const planned = input.verification !== undefined;
			attempt = validateEndoDevelopAttemptV0({
				schemaVersion: planned ? ENDO_DEVELOP_ATTEMPT_SCHEMA_V1 : ENDO_DEVELOP_ATTEMPT_SCHEMA_V0,
				id: `endo.attempt.${randomBytes(16).toString("hex")}`,
				projectId,
				taskId,
				preparedAtMs: this.#now(),
				task: {
					revision: task.revision,
					projectName: project.name,
					title: task.title,
					description: task.description,
					acceptance: task.acceptance,
				},
				objective: checked.objective,
				constraints: checked.constraints,
				reportBack: checked.reportBack,
				brief: planned ? ENDO_DEVELOP_BRIEF_V1 : ENDO_DEVELOP_BRIEF_V0,
				recordedBy: "operator",
				via: "cli",
				...(planned ? { verification: input.verification } : {}),
			});
		} catch {
			return refuse("bad-request");
		}
		const written = this.#attempts.write(attempt.id, "prepared", attempt);
		// A fresh random id cannot already exist; a name that is taken is someone else's file there, and is left alone.
		if (written === "created") return { ok: true, value: attempt };
		return written === "unsafe-path" || written === "exists" ? refuse("unreadable") : refuse("storage-failed");
	}

	/** The operator's statement that they handed the brief to `target`. Recorded once. It does not say anyone read it. */
	handoff(
		attemptId: string,
		input: { target: unknown; note?: unknown },
	): DevelopAttemptsResultV0<DevelopAttemptReportV0> {
		const target = checkEndoDevelopTextV0("name", input.target);
		const note =
			input.note === undefined ? { ok: true as const, text: "" } : checkEndoDevelopTextV0("note", input.note);
		if (!target.ok || !note.ok) return refuse("bad-request");
		return this.#record(attemptId, "handoff", (now) =>
			validateEndoDevelopAttemptHandoffV0({
				schemaVersion: ENDO_DEVELOP_ATTEMPT_HANDOFF_SCHEMA_V0,
				attemptId,
				recordedAtMs: now,
				target: target.text,
				note: note.text === "" ? null : note.text,
				recordedBy: "operator",
				via: "cli",
			}),
		);
	}

	/** What the operator recorded as reported. A claim: nothing here checks it, and the task's status does not move. */
	report(attemptId: string, note: unknown): DevelopAttemptsResultV0<DevelopAttemptReportV0> {
		return this.#outcome(attemptId, "reported", note);
	}

	/** The operator stopped without claiming success. */
	abandon(attemptId: string, note?: unknown): DevelopAttemptsResultV0<DevelopAttemptReportV0> {
		return this.#outcome(attemptId, "abandoned", note ?? "");
	}

	#outcome(
		attemptId: string,
		kind: "reported" | "abandoned",
		note: unknown,
	): DevelopAttemptsResultV0<DevelopAttemptReportV0> {
		return this.#record(attemptId, "outcome", (now) =>
			validateEndoDevelopAttemptOutcomeV0({
				schemaVersion: ENDO_DEVELOP_ATTEMPT_OUTCOME_SCHEMA_V0,
				attemptId,
				recordedAtMs: now,
				kind,
				// The note rules are the record's own: what was reported must be said; a reason for stopping is one optional line.
				note: kind === "abandoned" && typeof note === "string" ? note.trim() : note,
				recordedBy: "operator",
				via: "cli",
			}),
		);
	}

	/**
	 * Record a handoff or an outcome once: refused unless the attempt's prepared record is valid now, and `already-recorded` when that record
	 * exists, whether it was there before or a concurrent writer won the moment between this read and the write.
	 */
	#record(
		attemptId: string,
		kind: Exclude<EndoAttemptRecordKindV0, "prepared">,
		make: (now: number) => EndoDevelopAttemptHandoffV0 | EndoDevelopAttemptOutcomeV0,
	): DevelopAttemptsResultV0<DevelopAttemptReportV0> {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return refuse("bad-request");
		const read = this.#attempts.read();
		if (!read.ok) return refuse("unreadable", read.reason);
		const entry = read.entries.find((e) => e.attempt.id === attemptId);
		if (entry === undefined) {
			const at = endoAttemptProblemsOfV0(read.problems, attemptId)[0];
			return at === undefined ? refuse("not-found") : refuse("unreadable", at.problem.reason);
		}
		if (entry[kind] !== null) return refuse("already-recorded");
		const blocked = read.problems.find((p) => p.name === `${attemptId}.${kind}.json`);
		if (blocked !== undefined) return refuse("unreadable", blocked.reason);
		let record: EndoDevelopAttemptHandoffV0 | EndoDevelopAttemptOutcomeV0;
		try {
			record = make(this.#now());
		} catch {
			return refuse("bad-request");
		}
		const written = this.#attempts.write(attemptId, kind, record);
		if (written === "unsafe-path") return refuse("unreadable", "unsafe-path");
		if (written === "failed") return refuse("storage-failed");
		// Created, or the name was taken a moment ago: either way, read what is there now with the reader's own checks. Only a valid record of
		// this kind for this attempt is "already recorded"; anything else at that name is unreadable, never taken for a record.
		const after = this.get(attemptId);
		if (!after.ok) return after;
		if (after.value[kind] === null) return refuse("unreadable");
		return written === "created" ? { ok: true, value: after.value } : refuse("already-recorded");
	}
}
