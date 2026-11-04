// The write side of attempt execution (docs/designs/develop-attempt-execution.md), for the live workbench broker ONLY: whether a prepared
// attempt may be sent, as a new prompt, to the Pi session of this launch, and, once the operator has approved it on the attached terminal,
// the one write-once record that binds the attempt to that request.
//
// It sends nothing and asks nobody: the broker (adapters/pi/workbench.ts) owns the request, the terminal approval, the gate and the send.
// This module only answers "may this attempt be sent from here, now?" and writes `<id>.authorized.json`. The independent workspace host and
// `endo studio` never construct it (a test pins their import closures), so neither can write an authorisation.
//
// What it checks, every time (the second time just before the record is written, so a change made while the operator read the brief is
// caught): the attempt exists and is valid; it belongs to this launch's project; this launch's directory is that project's registered one
// (Pi works in the launch directory, so a brief for one directory is never run in another); its task is in the project, not done, and its
// words are the ones the brief was prepared on; no outcome and no authorisation are recorded for it; and its brief fits a workbench prompt.

import { realpathSync } from "node:fs";
import {
	ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0,
	type EndoAttemptMessageRefV0,
	type EndoDevelopAttemptAuthorizationV0,
	validateEndoDevelopAttemptAuthorizationV0,
} from "../../protocol/develop-attempt-execution.ts";
import {
	ENDO_ATTEMPT_ID_PATTERN_V0,
	endoDevelopTaskWordsChangedV0,
	renderEndoDevelopBriefV0,
} from "../../protocol/develop-attempts.ts";
import { ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 } from "../../protocol/workbench.ts";
import type { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import type { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { endoBriefSha256V0 } from "./develop-attempt-execution.ts";

/**
 * Why an attempt cannot be sent from this launch. Nothing was written or sent for any of them.
 * - `bad-request`: not an attempt id. `not-found`: no such attempt. `other-project`: it belongs to another project than this launch's.
 * - `unreadable`: the attempts directory, or a file at the attempt's names, is not usable. `tasks-unreadable`: the task file cannot be read.
 * - `launch-not-registered`: Pi was not started in the project's registered directory (or that directory is gone).
 * - `task-not-found` / `task-done` / `task-words-changed`: the task is gone from the project, done, or its words changed since preparation.
 * - `outcome-recorded`: the operator already recorded an outcome (reported or abandoned).
 * - `handed-off`: the operator recorded handing it to another agent: one attempt is not given to two executors.
 * - `already-authorized`: this attempt was already authorised to be sent (by this or another workbench). Retrying is a new attempt.
 * - `brief-too-large` / `brief-unsafe`: the brief exceeds a workbench prompt, or holds characters the terminal cannot show faithfully.
 * - `storage-failed`: the record could not be written.
 */
export type DevelopAttemptDispatchRefusalV0 =
	| "bad-request"
	| "not-found"
	| "other-project"
	| "unreadable"
	| "tasks-unreadable"
	| "launch-not-registered"
	| "task-not-found"
	| "task-done"
	| "task-words-changed"
	| "outcome-recorded"
	| "handed-off"
	| "already-authorized"
	| "brief-too-large"
	| "brief-unsafe"
	| "storage-failed";

/** One sentence per refusal, for the operator's terminal. */
export const DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0: Readonly<Record<DevelopAttemptDispatchRefusalV0, string>> = {
	"bad-request": "that is not an attempt id (endo.attempt.<32 hex>)",
	"not-found": "no such attempt in this store",
	"other-project": "the attempt belongs to another project than this workbench's --project",
	unreadable: "the attempt's records cannot be read safely (see `endo attempt show`)",
	"tasks-unreadable": "the task file cannot be read now",
	"launch-not-registered":
		"Pi was not started in the project's registered directory, so the brief would run somewhere else",
	"task-not-found": "the attempt's task is no longer in this project",
	"task-done": "the attempt's task is done",
	"task-words-changed":
		"the task's title, description or acceptance changed since the brief was prepared; prepare a new attempt",
	"outcome-recorded": "an outcome (reported or abandoned) is already recorded for this attempt",
	"handed-off": "you recorded handing this attempt to another agent; to send it to Pi as well, prepare a new attempt",
	"already-authorized": "this attempt was already authorised to be sent once; to try again, prepare a new attempt",
	"brief-too-large": `the brief is longer than a workbench prompt (${ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0} bytes)`,
	"brief-unsafe": "the brief holds characters that cannot be shown faithfully on the terminal for approval",
	"storage-failed": "the authorisation could not be recorded, so nothing was sent",
};

/** What the operator approves: the attempt, the exact brief, and the task as it stands now. */
export interface DevelopAttemptCandidateV0 {
	attemptId: string;
	taskId: string;
	taskTitle: string;
	/** The task file's revision at this check. */
	taskRevision: number;
	/** The revision the attempt was prepared on. */
	preparedOnRevision: number;
	brief: string;
	briefSha256: string;
}

/** The workbench request the attempt is being sent as: the broker's own facts, never a page's. */
export interface DevelopAttemptBindingV0 {
	session: string;
	attachment: string;
	launchId: string;
	proposalId: string;
	proposalDigest: string;
	authorizationEventId: string;
	message: EndoAttemptMessageRefV0;
}

export type DevelopAttemptDispatchResultV0<T> =
	| { ok: true; value: T }
	| { ok: false; code: DevelopAttemptDispatchRefusalV0 };

/** The same characters the broker refuses in a prompt it must show on the terminal (adapters/pi/workbench.ts). */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const realpath = (path: string): string | null => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

export class DevelopAttemptDispatchV0 {
	readonly #tasks: DevelopTasksStoreV0;
	readonly #attempts: DevelopAttemptsStoreV0;
	readonly #projectId: string;
	readonly #launchDirectory: string;
	readonly #now: () => number;

	constructor(
		tasks: DevelopTasksStoreV0,
		attempts: DevelopAttemptsStoreV0,
		config: { projectId: string; launchDirectory: string },
		options: { now?: () => number } = {},
	) {
		this.#tasks = tasks;
		this.#attempts = attempts;
		this.#projectId = config.projectId;
		this.#launchDirectory = config.launchDirectory;
		this.#now = options.now ?? Date.now;
	}

	/** Whether this attempt may be sent from this launch now, and what the operator would approve. Reads only. */
	check(attemptId: string): DevelopAttemptDispatchResultV0<DevelopAttemptCandidateV0> {
		const refuse = (code: DevelopAttemptDispatchRefusalV0) => ({ ok: false as const, code });
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return refuse("bad-request");
		const read = this.#attempts.read();
		if (!read.ok) return refuse("unreadable");
		const entry = read.entries.find((e) => e.attempt.id === attemptId);
		// A file at one of the attempt's names that is not a usable record blocks it: it might be a record this build cannot read.
		if (read.problems.some((p) => p.name.startsWith(`${attemptId}.`)))
			return refuse(entry === undefined ? "not-found" : "unreadable");
		if (entry === undefined) return refuse("not-found");
		const { attempt } = entry;
		if (attempt.projectId !== this.#projectId) return refuse("other-project");
		if (entry.authorized !== null) return refuse("already-authorized");
		if (entry.outcome !== null) return refuse("outcome-recorded");
		if (entry.handoff !== null) return refuse("handed-off");
		const tasks = this.#tasks.read();
		if (!tasks.ok) return refuse("tasks-unreadable");
		const project = tasks.file.projects.find((p) => p.id === this.#projectId);
		if (project === undefined) return refuse("other-project");
		const registered = realpath(project.path);
		if (registered === null || realpath(this.#launchDirectory) !== registered) return refuse("launch-not-registered");
		const task = tasks.file.tasks.find((t) => t.id === attempt.taskId && t.projectId === this.#projectId);
		if (task === undefined) return refuse("task-not-found");
		if (task.status === "done") return refuse("task-done");
		if (endoDevelopTaskWordsChangedV0(attempt, task).length > 0) return refuse("task-words-changed");
		const brief = renderEndoDevelopBriefV0(attempt);
		if (Buffer.byteLength(brief, "utf8") > ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0) return refuse("brief-too-large");
		if (UNSAFE.test(brief)) return refuse("brief-unsafe");
		return {
			ok: true,
			value: {
				attemptId,
				taskId: task.id,
				taskTitle: task.title,
				taskRevision: task.revision,
				preparedOnRevision: attempt.task.revision,
				brief,
				briefSha256: endoBriefSha256V0(brief),
			},
		};
	}

	/**
	 * After the operator's approval, and before the broker records the send: check again, require the brief to be byte for byte the one that
	 * was approved, and write the authorisation once. `already-authorized` when another writer (another workbench on this store, or a moment
	 * ago) got there first; that record is left as it is.
	 */
	authorize(
		approved: DevelopAttemptCandidateV0,
		binding: DevelopAttemptBindingV0,
	): DevelopAttemptDispatchResultV0<EndoDevelopAttemptAuthorizationV0> {
		const now = this.check(approved.attemptId);
		if (!now.ok) return now;
		if (now.value.briefSha256 !== approved.briefSha256 || now.value.brief !== approved.brief)
			return { ok: false, code: "task-words-changed" };
		let record: EndoDevelopAttemptAuthorizationV0;
		try {
			record = validateEndoDevelopAttemptAuthorizationV0({
				schemaVersion: ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0,
				attemptId: approved.attemptId,
				recordedAtMs: this.#now(),
				briefSha256: approved.briefSha256,
				taskRevision: now.value.taskRevision,
				harness: "pi",
				session: binding.session,
				attachment: binding.attachment,
				launchId: binding.launchId,
				proposalId: binding.proposalId,
				proposalDigest: binding.proposalDigest,
				authorizationEventId: binding.authorizationEventId,
				message: binding.message,
				approvedBy: "operator",
				via: "workbench-terminal",
			});
		} catch {
			return { ok: false, code: "storage-failed" };
		}
		const written = this.#attempts.write(approved.attemptId, "authorized", record);
		if (written === "created") return { ok: true, value: record };
		if (written === "exists") {
			// Only a valid authorisation at that name is "already authorised"; anything else there is unreadable, never taken for one.
			const after = this.#attempts.read();
			const entry = after.ok ? after.entries.find((e) => e.attempt.id === approved.attemptId) : undefined;
			return { ok: false, code: entry?.authorized ? "already-authorized" : "unreadable" };
		}
		return { ok: false, code: written === "unsafe-path" ? "unreadable" : "storage-failed" };
	}
}
