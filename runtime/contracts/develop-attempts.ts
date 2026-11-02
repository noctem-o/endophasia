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
import {
	checkEndoDevelopAttemptInputV0,
	ENDO_ATTEMPT_ID_PATTERN_V0,
	ENDO_DEVELOP_ATTEMPT_HANDOFF_SCHEMA_V0,
	ENDO_DEVELOP_ATTEMPT_LIMITS_V0,
	ENDO_DEVELOP_ATTEMPT_OUTCOME_SCHEMA_V0,
	ENDO_DEVELOP_ATTEMPT_SCHEMA_V0,
	ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V0,
	ENDO_DEVELOP_BRIEF_V0,
	type EndoDevelopAttemptHandoffV0,
	type EndoDevelopAttemptOutcomeV0,
	type EndoDevelopAttemptStateV0,
	type EndoDevelopAttemptsViewV0,
	type EndoDevelopAttemptV0,
	type EndoDevelopTaskWordV0,
	endoDevelopAttemptStateV0,
	endoDevelopTaskWordsChangedV0,
	renderEndoDevelopBriefV0,
	validateEndoDevelopAttemptHandoffV0,
	validateEndoDevelopAttemptOutcomeV0,
	validateEndoDevelopAttemptV0,
} from "../../protocol/develop-attempts.ts";
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
import type { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";

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
	/**
	 * The task now: `present` (in the attempt's project), `not-found` (the task file is readable and has no such task in that project),
	 * `unavailable` (the task file cannot be read now). Only `present` compares words.
	 */
	task: "present" | "not-found" | "unavailable";
	taskWordsChanged: EndoDevelopTaskWordV0[];
}

export interface DevelopAttemptsListV0 {
	attempts: DevelopAttemptReportV0[];
	/** Files in the directory that are not usable records (never shown as attempts; never written over). */
	problems: EndoAttemptProblemV0[];
}

const refuse = <T>(
	code: DevelopAttemptsRefusalV0,
	reason?: EndoDevelopUnreadableReasonV0 | EndoAttemptProblemV0["reason"],
): DevelopAttemptsResultV0<T> => (reason === undefined ? { ok: false, code } : { ok: false, code, reason });

export class DevelopAttemptsServiceV0 {
	readonly #tasks: DevelopTasksStoreV0;
	readonly #attempts: DevelopAttemptsStoreV0;
	readonly #now: () => number;

	constructor(tasks: DevelopTasksStoreV0, attempts: DevelopAttemptsStoreV0, options: { now?: () => number } = {}) {
		this.#tasks = tasks;
		this.#attempts = attempts;
		this.#now = options.now ?? Date.now;
	}

	// ---- reading ---------------------------------------------------------------------------------------------------------------------

	/** The task file now, or null when it cannot be read (a missing file reads as empty, as everywhere). */
	#taskFile(): EndoDevelopTasksFileV1 | null {
		const read = this.#tasks.read();
		return read.ok ? read.file : null;
	}

	#report(entry: EndoAttemptEntryV0, file: EndoDevelopTasksFileV1 | null): DevelopAttemptReportV0 {
		const { attempt } = entry;
		const task =
			file === null
				? undefined
				: file.tasks.find((t) => t.id === attempt.taskId && t.projectId === attempt.projectId);
		return {
			...entry,
			state: endoDevelopAttemptStateV0(entry.handoff, entry.outcome),
			task: file === null ? "unavailable" : task === undefined ? "not-found" : "present",
			taskWordsChanged: task === undefined ? [] : endoDevelopTaskWordsChangedV0(attempt, task),
		};
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
		return {
			ok: true,
			value: {
				attempts: read.entries
					.filter(
						(e) => e.attempt.projectId === projectId && (taskId === undefined || e.attempt.taskId === taskId),
					)
					.map((e) => this.#report(e, file)),
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
		return entry === undefined ? refuse("not-found") : { ok: true, value: this.#report(entry, this.#taskFile()) };
	}

	/** The brief of one attempt: a pure rendering of its prepared record. Reading it sends nothing and writes nothing. */
	brief(attemptId: string): DevelopAttemptsResultV0<string> {
		const got = this.get(attemptId);
		return got.ok ? { ok: true, value: renderEndoDevelopBriefV0(got.value.attempt) } : got;
	}

	/**
	 * The workbench's view: the attempts of the task the project has SELECTED, chosen from the task file, never from a request. The caller
	 * (the launch scope) supplies its own project id.
	 */
	viewFor(projectId: string): EndoDevelopAttemptsViewV0 {
		const empty = (state: EndoDevelopAttemptsViewV0["state"], taskId: string | null): EndoDevelopAttemptsViewV0 => ({
			schemaVersion: ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V0,
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
		return {
			schemaVersion: ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V0,
			state: "ready",
			taskId,
			attempts: read.entries
				.filter((e) => e.attempt.projectId === projectId && e.attempt.taskId === taskId)
				.map((e) => {
					const r = this.#report(e, file);
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
		input: { objective: unknown; constraints?: unknown; reportBack?: unknown },
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
			attempt = validateEndoDevelopAttemptV0({
				schemaVersion: ENDO_DEVELOP_ATTEMPT_SCHEMA_V0,
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
				brief: ENDO_DEVELOP_BRIEF_V0,
				recordedBy: "operator",
				via: "cli",
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
		if (entry === undefined) return refuse("not-found");
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
