// The DEVELOP coordination store: `<root>/develop/coordination.json` (`endo.develop-coordination.v0`, protocol/develop-coordination.ts).
//
// Operator metadata about coordination INTENT, kept beside (never inside) the task file. Deleting it loses assignments, dependencies and
// candidate declarations, and nothing else: no task, attempt, receipt, route reservation or event refers to it.
//
// Discipline (the same as storage/develop-tasks.ts, under its own lock):
// - One small JSON file, rewritten whole. Every change: take `coordination.lock.<n>` (storage/numbered-lock.ts), READ the file again from
//   disk, validate it, read tasks.json lock-free (never taking `tasks.lock.<n>`: the two locks are never nested), apply ONE change, validate
//   the whole result, write a uniquely named temporary file (0600, O_EXCL|O_NOFOLLOW), fsync it, rename it over the file, fsync the
//   directory. A crash leaves the old file or the new one; a temporary left behind is removed by the next writer (which holds the lock).
// - Optimistic concurrency: creations name the FILE revision they were decided against; changes to one record name THAT record's revision.
//   A mismatch is `stale-revision` and nothing is written.
// - Commit outcomes are distinguished: a failure before the rename leaves the old file (`storage-failed`, nothing changed); a failure AFTER
//   the rename, while making the directory entry durable, is `commit-uncertain`: the new state is visible now but its durability across a
//   power loss is not established, and it is never reported as an established commit.
// - Nothing is cached, repaired or defaulted. A file that is malformed, of an unknown version, over the size limit, not a regular file, or
//   reached through a link is UNREADABLE: reported with a closed reason, never written over, left byte for byte as found.
// - Cross-file limit (stated, not hidden): tasks.json is read as one atomic snapshot under this lock, but tasks.json can change the moment
//   after; holding coordination.lock does not make a task edit and a coordination edit atomic. A reference that later stops resolving, or
//   a task revision that moves on, is reported by readers (runtime/contracts/develop-coordination.ts), never silently repaired here.
// - Nothing here launches, prompts, dispatches, approves, interrupts, checks out or deletes anything. No lock is held across a terminal
//   prompt, a Git subprocess, a model call or harness I/O: callers do their Git work before calling in.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_ACCESS_INTENTS_V0,
	ENDO_ASSIGNMENT_ID_PATTERN_V0,
	ENDO_CANDIDATE_ID_PATTERN_V0,
	ENDO_DEPENDENCY_CONDITIONS_V0,
	ENDO_DEPENDENCY_ID_PATTERN_V0,
	ENDO_DEVELOP_COORDINATION_LIMITS_V0,
	ENDO_HARNESS_FAMILIES_V0,
	ENDO_PARTICIPANT_ID_PATTERN_V0,
	ENDO_PARTICIPANT_ROLES_V0,
	ENDO_WORKSPACE_REGISTRATIONS_V0,
	type EndoAccessIntentV0,
	type EndoAssignmentV0,
	type EndoCandidateRefV0,
	type EndoDependencyConditionV0,
	type EndoDependencyV0,
	type EndoDevelopCoordinationFileV0,
	type EndoIntendedHarnessFamilyV0,
	type EndoParticipantRoleV0,
	type EndoSessionAssociationV0,
	type EndoWorkspaceRegistrationV0,
	emptyEndoDevelopCoordinationFileV0,
	endoDependencyCycleV0,
	endoSessionAssociationProblemV0,
	isEndoCanonicalPathV0,
	isEndoPathHintV0,
	readEndoDevelopCoordinationFileV0,
	validateEndoDevelopCoordinationFileV0,
} from "../protocol/develop-coordination.ts";
import {
	checkEndoDevelopTextV0,
	ENDO_PROJECT_ID_PATTERN_V0,
	ENDO_TASK_ID_PATTERN_V0,
	type EndoDevelopTasksFileV1,
	type EndoDevelopUnreadableReasonV0,
} from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	type EndoAttemptExecutionEvidenceV0,
	endoEffectiveAssignmentV0,
	endoTerminalHazardBasesV0,
	endoWorktreeWriteConflictsV0,
} from "../runtime/contracts/develop-coordination.ts";
import { DevelopAttemptRoutesStoreV0 } from "./develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0, type EndoAttemptsReadV0, endoAttemptProblemsOfV0 } from "./develop-attempts.ts";
import { DevelopTasksStoreV0, ENDO_DEVELOP_DIRECTORY_V0, type EndoTasksReadV0 } from "./develop-tasks.ts";
import { writeExactSyncV0 } from "./log.ts";
import {
	acquireEndoNumberedLockV0,
	type EndoNumberedLockHooksV0,
	endoNumberedLockPatternsV0,
} from "./numbered-lock.ts";

export const ENDO_DEVELOP_COORDINATION_FILE_V0 = "coordination.json";
export const ENDO_DEVELOP_COORDINATION_LOCK_V0 = "coordination.lock";
const TEMPORARY = /^coordination\.json\.tmp-[0-9]+-[0-9a-f]{12}$/;
const LOCK_TEMPORARY = endoNumberedLockPatternsV0(ENDO_DEVELOP_COORDINATION_LOCK_V0).temporary;

export type EndoCoordinationReadV0 =
	| { ok: true; file: EndoDevelopCoordinationFileV0; exists: boolean }
	| { ok: false; reason: EndoDevelopUnreadableReasonV0 };

/** Why a change was not made (nothing was written), or `commit-uncertain` (the change is visible but not established as durable). */
export type EndoCoordinationRefusalV0 =
	| "not-found"
	| "stale-revision"
	| "invalid-transition"
	| "bad-request"
	| "limit"
	| "duplicate"
	| "dependency-cycle"
	| "cross-project"
	| "worktree-write-overlap"
	| "synthetic-not-admitted"
	| "unsupported-source"
	| "unreadable"
	| "tasks-unreadable"
	| "attempts-unreadable"
	| "busy"
	| "storage-failed"
	| "commit-uncertain";

export type EndoCoordinationResultV0<T> =
	| { ok: true; value: T; file: EndoDevelopCoordinationFileV0; commit: "committed" | "unchanged" }
	| {
			ok: false;
			code: EndoCoordinationRefusalV0;
			reason?: EndoDevelopUnreadableReasonV0;
			/** What the refusal is about, for the operator: an id, a cycle, the conflicting assignments. Never file contents. */
			detail?: string;
	  };

export interface EndoDevelopCoordinationStoreOptionsV0 {
	now?: () => number;
	/** How long a writer waits for the lock before answering `busy`. Default 2 000 ms. */
	lockWaitMs?: number;
	/** For tests: after the temporary file is complete and synced, before the rename (a throw there is a crash before commit). */
	beforeReplace?: () => void;
	/** For tests: after the rename, before the directory fsync (a throw there is a failure after commit: `commit-uncertain`). */
	afterReplace?: () => void;
	/** For tests: after tasks.json was read under the coordination lock, before the change is applied. */
	afterTasksRead?: () => void;
	/** For tests: deterministic lock interleavings. */
	lockHooks?: EndoNumberedLockHooksV0;
}

type Draft<T> =
	| { ok: true; value: T; unchanged?: boolean }
	| { ok: false; code: EndoCoordinationRefusalV0; detail?: string };
const fail = (code: EndoCoordinationRefusalV0, detail?: string) =>
	({ ok: false, code, ...(detail === undefined ? {} : { detail }) }) as const;
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const L = ENDO_DEVELOP_COORDINATION_LIMITS_V0;
const isRevision = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

interface MutationContext {
	now: number;
	/** The task file, read lock-free on first use: a mutation that never needs it is not refused when it is unreadable. */
	tasks: () => EndoTasksReadV0;
	attempts: () => EndoAttemptsReadV0;
	evidence: (attemptId: string) => EndoAttemptExecutionEvidenceV0;
}

export interface EndoAssignmentSpecV0 {
	participant: {
		participantId: string;
		role: EndoParticipantRoleV0;
		intendedHarnessFamily: EndoIntendedHarnessFamilyV0 | null;
	};
	workspace: {
		worktreePath: string;
		registration: EndoWorkspaceRegistrationV0;
		accessIntent: EndoAccessIntentV0;
		pathHints: string[];
		/** The operator's explicit acknowledgement (`--allow-shared-worktree`). Never defaulted to true. */
		allowSharedWorktree: boolean;
	};
	targetCandidate: { taskId: string; candidateId: string } | null;
}

export type EndoSessionDeclarationV0 = Omit<EndoSessionAssociationV0, "standing" | "declaredAtMs">;

/** What a caller supplies for a candidate it has verified (Git or protected re-verification happens BEFORE the store is called). */
export type EndoCandidateDeclarationV0 =
	| {
			kind: "git-commit";
			commonDir: string;
			worktreePath: string;
			commitSha: string;
			treeSha: string;
			attemptId: string | null;
	  }
	| { kind: "protected-candidate"; attemptId: string; runId: string; bindingSha256: string; candidateSha256: string };

export class DevelopCoordinationStoreV0 {
	readonly #root: string;
	readonly #dir: string;
	readonly #options: EndoDevelopCoordinationStoreOptionsV0;
	readonly #now: () => number;

	constructor(root: string, options: EndoDevelopCoordinationStoreOptionsV0 = {}) {
		this.#root = root;
		this.#dir = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	get path(): string {
		return join(this.#dir, ENDO_DEVELOP_COORDINATION_FILE_V0);
	}

	// ---- reading ---------------------------------------------------------------------------------------------------------------------

	/** Read the file now. Missing: an empty file (a pre-E1 store; nothing is created). Anything else that is not a good file is unreadable. */
	read(): EndoCoordinationReadV0 {
		try {
			const absent = { ok: true as const, file: emptyEndoDevelopCoordinationFileV0(), exists: false };
			const directory = lstatSync(this.#dir, { throwIfNoEntry: false });
			if (directory === undefined) return absent;
			if (!directory.isDirectory()) return { ok: false, reason: "unsafe-path" };
			const entry = lstatSync(this.path, { throwIfNoEntry: false });
			if (entry === undefined) return absent;
			if (!entry.isFile()) return { ok: false, reason: "unsafe-path" };
			if (entry.size > L.maxFileBytes) return { ok: false, reason: "too-large" };
			// O_NOFOLLOW: a link swapped in after the check is refused; O_NONBLOCK: a FIFO swapped in cannot hang the read.
			const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let bytes: Buffer;
			try {
				const opened = fstatSync(fd);
				if (!opened.isFile()) return { ok: false, reason: "unsafe-path" };
				if (opened.size > L.maxFileBytes) return { ok: false, reason: "too-large" };
				bytes = Buffer.alloc(opened.size);
				let at = 0;
				while (at < bytes.length) {
					const n = readSync(fd, bytes, at, bytes.length - at, at);
					if (n === 0) break;
					at += n;
				}
				if (at !== bytes.length) return { ok: false, reason: "io" };
			} finally {
				closeSync(fd);
			}
			return endoParseCoordinationBytesV0(bytes);
		} catch (error) {
			return { ok: false, reason: errno(error) === "ELOOP" || errno(error) === "ENOTDIR" ? "unsafe-path" : "io" };
		}
	}

	// ---- the one write path ----------------------------------------------------------------------------------------------------------

	#ensureDirectory(): boolean {
		try {
			const existing = lstatSync(this.#dir, { throwIfNoEntry: false });
			if (existing === undefined) {
				mkdirSync(dirname(this.#dir), { recursive: true });
				mkdirSync(this.#dir, { mode: 0o700 });
				const parent = openSync(dirname(this.#dir), constants.O_RDONLY | constants.O_DIRECTORY);
				try {
					fsyncSync(parent);
				} finally {
					closeSync(parent);
				}
			}
			return lstatSync(this.#dir).isDirectory();
		} catch {
			return false;
		}
	}

	/** `committed`: renamed and the directory synced. `not-committed`: the old file stands. `uncertain`: renamed, durability not established. */
	#replace(file: EndoDevelopCoordinationFileV0): "committed" | "not-committed" | "uncertain" | "limit" {
		const bytes = Buffer.from(`${canonicalEndoJsonV0(file as never)}\n`, "utf8");
		if (bytes.length > L.maxFileBytes) return "limit";
		const temporary = join(this.#dir, `${ENDO_DEVELOP_COORDINATION_FILE_V0}.tmp-${process.pid}-${hex(6)}`);
		let fd: number | undefined;
		try {
			fd = openSync(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			writeExactSyncV0(fd, bytes, temporary);
			fsyncSync(fd);
			closeSync(fd);
			fd = undefined;
			this.#options.beforeReplace?.();
			renameSync(temporary, this.path);
		} catch {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// the descriptor is gone either way
				}
			}
			rmSync(temporary, { force: true });
			return "not-committed";
		}
		try {
			this.#options.afterReplace?.();
			const directory = openSync(this.#dir, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			return "committed";
		} catch {
			return "uncertain";
		}
	}

	/** Temporary files left by a crashed writer. The caller holds the lock, so no live writer owns a data temporary. */
	#sweep(): void {
		try {
			for (const name of readdirSync(this.#dir)) {
				const lockTemporary = LOCK_TEMPORARY.test(name);
				if (!TEMPORARY.test(name) && !lockTemporary) continue;
				const info = lstatSync(join(this.#dir, name), { throwIfNoEntry: false });
				// A lock temporary belongs to a contender that may be alive and about to link it: only an old one is a crash's.
				if (lockTemporary && info !== undefined && Date.now() - info.mtimeMs < 60_000) continue;
				if (info?.isFile()) rmSync(join(this.#dir, name), { force: true });
			}
		} catch {
			// a sweep that cannot run leaves the files for the next writer
		}
	}

	#mutate<T>(
		change: (draft: EndoDevelopCoordinationFileV0, context: MutationContext) => Draft<T>,
	): EndoCoordinationResultV0<T> {
		if (!this.#ensureDirectory()) return { ok: false, code: "unreadable", reason: "unsafe-path" };
		const release = acquireEndoNumberedLockV0(this.#dir, ENDO_DEVELOP_COORDINATION_LOCK_V0, {
			waitMs: this.#options.lockWaitMs ?? 2000,
			now: this.#now,
			...(this.#options.lockHooks === undefined ? {} : { hooks: this.#options.lockHooks }),
		});
		if (release === "busy") return fail("busy");
		if (release === "failed") return fail("storage-failed");
		try {
			this.#sweep();
			const read = this.read();
			if (!read.ok) return { ok: false, code: "unreadable", reason: read.reason };
			// Lock-free snapshot of the task file: one atomic read, never under tasks.lock (no nesting, no deadlock), never atomic WITH it.
			let tasksRead: EndoTasksReadV0 | undefined;
			const tasks = () => {
				if (tasksRead === undefined) {
					tasksRead = new DevelopTasksStoreV0(this.#root).read();
					if (tasksRead.ok) this.#options.afterTasksRead?.();
				}
				return tasksRead;
			};
			let attempts: EndoAttemptsReadV0 | undefined;
			const readAttempts = () => {
				attempts ??= new DevelopAttemptsStoreV0(this.#root).read();
				return attempts;
			};
			const routes = DevelopAttemptRoutesStoreV0.forRoot(this.#root);
			const evidence = (attemptId: string): EndoAttemptExecutionEvidenceV0 => {
				const a = readAttempts();
				const route = routes.read(attemptId);
				const routeState = route.state === "present" ? "claimed" : route.state === "absent" ? "absent" : "unknown";
				if (!a.ok) return { authorized: "unknown", route: routeState };
				const entry = a.entries.find((e) => e.attempt.id === attemptId);
				const problem = endoAttemptProblemsOfV0(a.problems, attemptId).length > 0;
				return {
					authorized: entry?.authorized != null ? true : problem || entry === undefined ? "unknown" : false,
					route: routeState,
				};
			};
			const draft = clone(read.file);
			const made = change(draft, { now: this.#now(), tasks, attempts: readAttempts, evidence });
			if (!made.ok)
				return made.code === "tasks-unreadable" && tasksRead !== undefined && !tasksRead.ok
					? { ...made, reason: tasksRead.reason }
					: made;
			if (made.unchanged === true) return { ok: true, value: made.value, file: read.file, commit: "unchanged" };
			draft.revision = read.file.revision + 1;
			let checked: EndoDevelopCoordinationFileV0;
			try {
				checked = validateEndoDevelopCoordinationFileV0(draft);
			} catch {
				return fail("bad-request", "the change would produce an invalid coordination file");
			}
			const outcome = this.#replace(checked);
			if (outcome === "limit") return fail("limit");
			if (outcome === "not-committed") return fail("storage-failed");
			if (outcome === "uncertain")
				return fail(
					"commit-uncertain",
					"the file was replaced but the directory could not be synced; re-read it before acting",
				);
			return { ok: true, value: made.value, file: checked, commit: "committed" };
		} finally {
			release();
		}
	}

	// ---- shared checks ---------------------------------------------------------------------------------------------------------------

	static #task(
		context: MutationContext,
		projectId: string,
		taskId: string,
	):
		| { ok: true; revision: number; projectPath: string }
		| { ok: false; code: EndoCoordinationRefusalV0; detail: string } {
		const read = context.tasks();
		if (!read.ok) return { ok: false, code: "tasks-unreadable", detail: "the task file cannot be read" };
		const tasks: EndoDevelopTasksFileV1 = read.file;
		const project = tasks.projects.find((p) => p.id === projectId);
		if (project === undefined) return { ok: false, code: "not-found", detail: `project ${projectId}` };
		const task = tasks.tasks.find((t) => t.id === taskId);
		if (task === undefined) return { ok: false, code: "not-found", detail: `task ${taskId}` };
		if (task.projectId !== projectId) return { ok: false, code: "cross-project", detail: `task ${taskId}` };
		return { ok: true, revision: task.revision, projectPath: project.path };
	}

	static #specProblem(spec: EndoAssignmentSpecV0): string | null {
		const p = spec.participant;
		if (!ENDO_PARTICIPANT_ID_PATTERN_V0.test(p.participantId)) return "participant id";
		if (!(ENDO_PARTICIPANT_ROLES_V0 as readonly string[]).includes(p.role)) return "role";
		if (
			p.intendedHarnessFamily !== null &&
			!(ENDO_HARNESS_FAMILIES_V0 as readonly string[]).includes(p.intendedHarnessFamily)
		)
			return "harness family";
		const w = spec.workspace;
		if (!isEndoCanonicalPathV0(w.worktreePath)) return "worktree path";
		if (!(ENDO_WORKSPACE_REGISTRATIONS_V0 as readonly string[]).includes(w.registration)) return "registration";
		if (!(ENDO_ACCESS_INTENTS_V0 as readonly string[]).includes(w.accessIntent)) return "access intent";
		if (!Array.isArray(w.pathHints) || w.pathHints.length > L.maxPathHints || !w.pathHints.every(isEndoPathHintV0))
			return "path hints";
		if (new Set(w.pathHints).size !== w.pathHints.length) return "path hints repeat";
		if (typeof w.allowSharedWorktree !== "boolean") return "shared-worktree acknowledgement";
		if (spec.targetCandidate !== null) {
			if (p.role === "builder") return "a builder has no target candidate";
			if (
				!ENDO_TASK_ID_PATTERN_V0.test(spec.targetCandidate.taskId) ||
				!ENDO_CANDIDATE_ID_PATTERN_V0.test(spec.targetCandidate.candidateId)
			)
				return "target candidate";
		}
		return null;
	}

	/** Build a new active assignment on `taskId`, refusing what the file and the task snapshot say cannot stand. */
	static #newAssignment(
		draft: EndoDevelopCoordinationFileV0,
		context: MutationContext,
		projectId: string,
		taskId: string,
		spec: EndoAssignmentSpecV0,
		exclude: ReadonlySet<string>,
		expectedTaskRevision: number,
	): { ok: true; assignment: EndoAssignmentV0 } | { ok: false; code: EndoCoordinationRefusalV0; detail?: string } {
		const task = DevelopCoordinationStoreV0.#task(context, projectId, taskId);
		if (!task.ok) return task;
		// Bound to the task revision the operator READ, never to whatever is on disk at write time.
		if (task.revision !== expectedTaskRevision)
			return { ok: false, code: "stale-revision", detail: `task ${taskId} is at revision ${task.revision}` };
		if (spec.workspace.registration === "project-path" && spec.workspace.worktreePath !== task.projectPath)
			return {
				ok: false,
				code: "bad-request",
				detail: "a project-path workspace must be the project's registered path",
			};
		if (spec.targetCandidate !== null) {
			const entry = draft.taskCandidates.find((t) => t.taskId === spec.targetCandidate?.taskId);
			if (entry === undefined || !entry.candidates.some((c) => c.candidateId === spec.targetCandidate?.candidateId))
				return { ok: false, code: "not-found", detail: `candidate ${spec.targetCandidate.candidateId}` };
			if (entry.projectId !== projectId)
				return { ok: false, code: "cross-project", detail: `candidate ${spec.targetCandidate.candidateId}` };
		}
		if (draft.assignments.length >= L.maxAssignments) return { ok: false, code: "limit" };
		const twin = draft.assignments.find(
			(a) =>
				a.state === "active" &&
				!exclude.has(a.assignmentId) &&
				a.taskId === taskId &&
				a.participant.participantId === spec.participant.participantId,
		);
		if (twin !== undefined) return { ok: false, code: "duplicate", detail: `assignment ${twin.assignmentId}` };
		const conflicts = endoWorktreeWriteConflictsV0(
			draft.assignments.map((a) => endoEffectiveAssignmentV0(a, context.evidence)),
			spec.workspace,
			exclude,
		);
		if (conflicts.length > 0 && !spec.workspace.allowSharedWorktree)
			return {
				ok: false,
				code: "worktree-write-overlap",
				detail: conflicts
					.map((c) =>
						draft.assignments.some((a) => a.assignmentId === c.assignmentId && a.projectId === projectId)
							? `${c.assignmentId} (${c.reason})`
							: "another project occupies this worktree",
					)
					.join(", "),
			};
		return {
			ok: true,
			assignment: {
				assignmentId: `endo.assignment.${hex(16)}`,
				projectId,
				taskId,
				taskRevisionAtBind: task.revision,
				revision: 1,
				state: "active",
				participant: { ...spec.participant },
				session: null,
				workspace: {
					worktreePath: spec.workspace.worktreePath,
					registration: spec.workspace.registration,
					accessIntent: spec.workspace.accessIntent,
					pathHints: [...spec.workspace.pathHints],
					sharedWorktreeAcknowledged: conflicts.length > 0 && spec.workspace.allowSharedWorktree,
				},
				worktreeHazard: { state: "none" },
				targetCandidate: spec.targetCandidate === null ? null : { ...spec.targetCandidate },
				attemptIds: [],
				origin: { confirmedBy: "operator", via: "cli", confirmedAtMs: context.now },
				supersedesAssignmentId: null,
				supersededByAssignmentId: null,
				ended: null,
				updatedAtMs: context.now,
			},
		};
	}

	/** The one terminal transition: state, end, and the hazard the on-disk execution evidence warrants (never cleared here). */
	static #end(
		a: EndoAssignmentV0,
		context: MutationContext,
		state: "superseded" | "revoked" | "closed",
		reason: string | null,
	): void {
		const bases = endoTerminalHazardBasesV0(a, context.evidence);
		a.state = state;
		a.ended = { atMs: context.now, reason };
		a.worktreeHazard =
			bases.length === 0 ? { state: "none" } : { state: "liveness-unverified", sinceMs: context.now, bases };
		a.revision += 1;
		a.updatedAtMs = context.now;
	}

	static #reason(reason: unknown): { ok: true; text: string | null } | { ok: false } {
		if (reason === null || reason === undefined) return { ok: true, text: null };
		const checked = checkEndoDevelopTextV0("note", reason);
		if (!checked.ok) return { ok: false };
		return { ok: true, text: checked.text === "" ? null : checked.text };
	}

	#activeAssignment(
		draft: EndoDevelopCoordinationFileV0,
		assignmentId: string,
		expectedRevision: number,
		{ allowEnded = false } = {},
	): { ok: true; a: EndoAssignmentV0 } | { ok: false; code: EndoCoordinationRefusalV0; detail?: string } {
		const a = draft.assignments.find((x) => x.assignmentId === assignmentId);
		if (a === undefined) return { ok: false, code: "not-found", detail: `assignment ${assignmentId}` };
		if (a.revision !== expectedRevision)
			return { ok: false, code: "stale-revision", detail: `assignment is at revision ${a.revision}` };
		if (!allowEnded && a.state !== "active")
			return { ok: false, code: "invalid-transition", detail: `assignment is ${a.state}` };
		return { ok: true, a };
	}

	// ---- assignments -----------------------------------------------------------------------------------------------------------------

	/** Confirm a new assignment: the operator's explicit act, decided against the file revision they read. Changes no task. */
	createAssignment(
		input: {
			expectedFileRevision: number;
			expectedTaskRevision: number;
			projectId: string;
			taskId: string;
		} & EndoAssignmentSpecV0,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		if (
			!isRevision(input.expectedFileRevision) ||
			!isRevision(input.expectedTaskRevision) ||
			!ENDO_PROJECT_ID_PATTERN_V0.test(input.projectId) ||
			!ENDO_TASK_ID_PATTERN_V0.test(input.taskId)
		)
			return fail("bad-request");
		const problem = DevelopCoordinationStoreV0.#specProblem(input);
		if (problem !== null) return fail("bad-request", problem);
		return this.#mutate((draft, context) => {
			if (draft.revision !== input.expectedFileRevision)
				return fail("stale-revision", `coordination file is at revision ${draft.revision}`);
			const made = DevelopCoordinationStoreV0.#newAssignment(
				draft,
				context,
				input.projectId,
				input.taskId,
				input,
				new Set(),
				input.expectedTaskRevision,
			);
			if (!made.ok) return made;
			draft.assignments.push(made.assignment);
			return { ok: true, value: made.assignment };
		});
	}

	/**
	 * Reassign: end `assignmentId` as superseded and confirm its replacement on the same task, in one write. The superseded assignment keeps
	 * its history and gets the hazard its evidence warrants; the replacement is refused if it would write a worktree that hazard occupies.
	 */
	supersedeAssignment(
		assignmentId: string,
		expectedRevision: number,
		expectedTaskRevision: number,
		replacement: EndoAssignmentSpecV0,
		reason?: unknown,
	): EndoCoordinationResultV0<{ superseded: EndoAssignmentV0; replacement: EndoAssignmentV0 }> {
		const why = DevelopCoordinationStoreV0.#reason(reason);
		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) ||
			!isRevision(expectedRevision) ||
			!isRevision(expectedTaskRevision) ||
			!why.ok
		)
			return fail("bad-request");
		const problem = DevelopCoordinationStoreV0.#specProblem(replacement);
		if (problem !== null) return fail("bad-request", problem);
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision);
			if (!found.ok) return found;
			const old = found.a;
			DevelopCoordinationStoreV0.#end(old, context, "superseded", why.text);
			// The old assignment now occupies its worktree only if its hazard says so; it is never excluded from the overlap check.
			const made = DevelopCoordinationStoreV0.#newAssignment(
				draft,
				context,
				old.projectId,
				old.taskId,
				replacement,
				new Set(),
				expectedTaskRevision,
			);
			if (!made.ok) return made;
			old.supersededByAssignmentId = made.assignment.assignmentId;
			made.assignment.supersedesAssignmentId = old.assignmentId;
			draft.assignments.push(made.assignment);
			return { ok: true, value: { superseded: old, replacement: made.assignment } };
		});
	}

	/** Revoke or close. Neither stops a process nor proves one stopped: the hazard records what the evidence on disk warrants. */
	endAssignment(
		assignmentId: string,
		expectedRevision: number,
		to: "revoked" | "closed",
		reason?: unknown,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		const why = DevelopCoordinationStoreV0.#reason(reason);
		if (!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) || !isRevision(expectedRevision) || !why.ok)
			return fail("bad-request");
		if (to !== "revoked" && to !== "closed") return fail("bad-request");
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision);
			if (!found.ok) return found;
			DevelopCoordinationStoreV0.#end(found.a, context, to, why.text);
			return { ok: true, value: found.a };
		});
	}

	/**
	 * Record (or clear, with null) the operator's declared session association. Standing is `operator-declared`: nothing here observed the
	 * session, and nothing here makes it live. A synthetic (`test-*`) or unknown source is refused.
	 */
	associateSession(
		assignmentId: string,
		expectedRevision: number,
		session: EndoSessionDeclarationV0 | null,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		if (!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) || !isRevision(expectedRevision))
			return fail("bad-request");
		if (session !== null) {
			const problem = endoSessionAssociationProblemV0(session);
			if (problem === "synthetic-not-admitted" || problem === "unsupported-source") return fail(problem);
			if (problem !== null) return fail("bad-request", problem);
		}
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision);
			if (!found.ok) return found;
			const a = found.a;
			// A writable assignment that had a session keeps it until it ends, so the terminal hazard cannot be skipped by unbinding first.
			if (session === null && a.session !== null && a.workspace.accessIntent === "read-write-intended")
				return fail(
					"invalid-transition",
					"a writable assignment's session stays recorded until the assignment ends; revoke or close it, then clear the hazard",
				);
			if (session !== null) {
				const other = draft.assignments.find(
					(x) =>
						x.state === "active" &&
						x.assignmentId !== a.assignmentId &&
						x.session?.sessionKey === session.sessionKey &&
						x.participant.participantId !== a.participant.participantId,
				);
				if (other !== undefined)
					return fail(
						"duplicate",
						`session is associated with another participant's assignment ${other.assignmentId}`,
					);
			}
			a.session =
				session === null
					? null
					: {
							standing: "operator-declared",
							source: session.source,
							sessionKey: session.sessionKey,
							attachmentId: session.attachmentId,
							instanceId: session.instanceId,
							runtimeFingerprintId: session.runtimeFingerprintId,
							declaredAtMs: context.now,
						};
			a.revision += 1;
			a.updatedAtMs = context.now;
			return { ok: true, value: a };
		});
	}

	/** Link a prepared attempt of the SAME task. A reference only: it records no dispatch and claims no execution. */
	linkAttempt(
		assignmentId: string,
		expectedRevision: number,
		attemptId: string,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) ||
			!isRevision(expectedRevision) ||
			!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision);
			if (!found.ok) return found;
			const a = found.a;
			if (a.attemptIds.includes(attemptId)) return { ok: true, value: a, unchanged: true };
			const attempts = context.attempts();
			if (!attempts.ok) return fail("attempts-unreadable");
			const entry = attempts.entries.find((e) => e.attempt.id === attemptId);
			if (entry === undefined) return fail("not-found", `attempt ${attemptId}`);
			if (entry.attempt.taskId !== a.taskId || entry.attempt.projectId !== a.projectId)
				return fail("cross-project", `attempt ${attemptId} belongs to another task`);
			if (a.attemptIds.length >= L.maxAttemptsPerAssignment) return fail("limit");
			a.attemptIds.push(attemptId);
			a.revision += 1;
			a.updatedAtMs = context.now;
			return { ok: true, value: a };
		});
	}

	/** The operator re-confirms an active assignment against the task's CURRENT revision (after reading the edited task). */
	reconfirmTask(
		assignmentId: string,
		expectedRevision: number,
		expectedTaskRevision: number,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) ||
			!isRevision(expectedRevision) ||
			!isRevision(expectedTaskRevision)
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision);
			if (!found.ok) return found;
			const a = found.a;
			const task = DevelopCoordinationStoreV0.#task(context, a.projectId, a.taskId);
			if (!task.ok) return task;
			if (task.revision !== expectedTaskRevision)
				return fail("stale-revision", `task ${a.taskId} is at revision ${task.revision}`);
			if (task.revision === a.taskRevisionAtBind) return { ok: true, value: a, unchanged: true };
			a.taskRevisionAtBind = task.revision;
			a.revision += 1;
			a.updatedAtMs = context.now;
			return { ok: true, value: a };
		});
	}

	/**
	 * The operator's explicit statement that they verified the processes behind an ended assignment have stopped. Kept as a record (the
	 * bases stay), never automatic: no timer, lease, unreachability or agent claim reaches this.
	 */
	clearHazard(
		assignmentId: string,
		expectedRevision: number,
		note: unknown,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		const checked = checkEndoDevelopTextV0("note", note);
		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) ||
			!isRevision(expectedRevision) ||
			!checked.ok ||
			checked.text === ""
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision, { allowEnded: true });
			if (!found.ok) return found;
			const a = found.a;
			a.worktreeHazard = endoEffectiveAssignmentV0(a, context.evidence).worktreeHazard;
			if (a.worktreeHazard.state !== "liveness-unverified")
				return fail("invalid-transition", `hazard is ${a.worktreeHazard.state}`);
			a.worktreeHazard = {
				state: "operator-cleared",
				clearedAtMs: context.now,
				bases: a.worktreeHazard.bases,
				note: checked.text,
			};
			a.revision += 1;
			a.updatedAtMs = context.now;
			return { ok: true, value: a };
		});
	}

	// ---- dependencies ----------------------------------------------------------------------------------------------------------------

	/** Declare `dependent` waits on `prerequisite` under `condition`: same project, existing tasks, no duplicate pair, no cycle. */
	addDependency(input: {
		expectedFileRevision: number;
		projectId: string;
		dependentTaskId: string;
		prerequisiteTaskId: string;
		condition: EndoDependencyConditionV0;
	}): EndoCoordinationResultV0<EndoDependencyV0> {
		if (
			!isRevision(input.expectedFileRevision) ||
			!ENDO_PROJECT_ID_PATTERN_V0.test(input.projectId) ||
			!ENDO_TASK_ID_PATTERN_V0.test(input.dependentTaskId) ||
			!ENDO_TASK_ID_PATTERN_V0.test(input.prerequisiteTaskId) ||
			!(ENDO_DEPENDENCY_CONDITIONS_V0 as readonly string[]).includes(input.condition)
		)
			return fail("bad-request");
		if (input.dependentTaskId === input.prerequisiteTaskId)
			return fail("dependency-cycle", "a task cannot depend on itself");
		return this.#mutate((draft, context) => {
			if (draft.revision !== input.expectedFileRevision)
				return fail("stale-revision", `coordination file is at revision ${draft.revision}`);
			const dependent = DevelopCoordinationStoreV0.#task(context, input.projectId, input.dependentTaskId);
			if (!dependent.ok) return dependent;
			const prerequisite = DevelopCoordinationStoreV0.#task(context, input.projectId, input.prerequisiteTaskId);
			if (!prerequisite.ok) return prerequisite;
			const same = draft.dependencies.find(
				(d) => d.dependentTaskId === input.dependentTaskId && d.prerequisiteTaskId === input.prerequisiteTaskId,
			);
			if (same !== undefined) return fail("duplicate", `dependency ${same.dependencyId}`);
			if (draft.dependencies.length >= L.maxDependencies) return fail("limit");
			const cycle = endoDependencyCycleV0([...draft.dependencies, input]);
			if (cycle !== null) return fail("dependency-cycle", cycle.join(" -> "));
			const dependency: EndoDependencyV0 = {
				dependencyId: `endo.dep.${hex(16)}`,
				projectId: input.projectId,
				dependentTaskId: input.dependentTaskId,
				prerequisiteTaskId: input.prerequisiteTaskId,
				condition: input.condition,
				declaredAt: {
					dependentTaskRevision: dependent.revision,
					prerequisiteTaskRevision: prerequisite.revision,
					atMs: context.now,
				},
				operatorDecision: null,
				createdBy: "operator",
				revision: 1,
			};
			draft.dependencies.push(dependency);
			return { ok: true, value: dependency };
		});
	}

	/**
	 * Record (or withdraw, with null) the operator's decision standing in for an `operator-decision` prerequisite. It is bound to the
	 * prerequisite task's revision NOW; any later edit of that task makes it stale at read time.
	 */
	decideDependency(
		dependencyId: string,
		expectedRevision: number,
		rationale: unknown,
		/** The prerequisite task revision the operator read; required to decide (null only to withdraw). */
		expectedPrerequisiteRevision: number | null,
	): EndoCoordinationResultV0<EndoDependencyV0> {
		const checked = rationale === null ? null : checkEndoDevelopTextV0("note", rationale);
		if (
			!ENDO_DEPENDENCY_ID_PATTERN_V0.test(dependencyId) ||
			!isRevision(expectedRevision) ||
			(checked !== null && !isRevision(expectedPrerequisiteRevision)) ||
			(checked !== null && (!checked.ok || checked.text === ""))
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			const d = draft.dependencies.find((x) => x.dependencyId === dependencyId);
			if (d === undefined) return fail("not-found", `dependency ${dependencyId}`);
			if (d.revision !== expectedRevision) return fail("stale-revision", `dependency is at revision ${d.revision}`);
			if (d.condition !== "operator-decision") return fail("invalid-transition", `condition is ${d.condition}`);
			if (checked === null) {
				if (d.operatorDecision === null) return { ok: true, value: d, unchanged: true };
				d.operatorDecision = null;
			} else {
				const pre = DevelopCoordinationStoreV0.#task(context, d.projectId, d.prerequisiteTaskId);
				if (!pre.ok) return pre;
				if (pre.revision !== expectedPrerequisiteRevision)
					return fail("stale-revision", `prerequisite ${d.prerequisiteTaskId} is at revision ${pre.revision}`);
				d.operatorDecision = {
					prerequisiteTaskRevision: pre.revision,
					rationale: (checked as { text: string }).text,
					decidedAtMs: context.now,
				};
			}
			d.revision += 1;
			return { ok: true, value: d };
		});
	}

	/** Remove an edge: the operator's explicit act. An edge whose task disappeared is never removed automatically. */
	removeDependency(dependencyId: string, expectedRevision: number): EndoCoordinationResultV0<EndoDependencyV0> {
		if (!ENDO_DEPENDENCY_ID_PATTERN_V0.test(dependencyId) || !isRevision(expectedRevision))
			return fail("bad-request");
		return this.#mutate((draft) => {
			const at = draft.dependencies.findIndex((x) => x.dependencyId === dependencyId);
			if (at === -1) return fail("not-found", `dependency ${dependencyId}`);
			const d = draft.dependencies[at] as EndoDependencyV0;
			if (d.revision !== expectedRevision) return fail("stale-revision", `dependency is at revision ${d.revision}`);
			draft.dependencies.splice(at, 1);
			return { ok: true, value: d };
		});
	}

	// ---- candidates ------------------------------------------------------------------------------------------------------------------

	/**
	 * Declare a candidate the CALLER has already verified (Git commit/tree in the project's repository, or an established protected
	 * association), and make it the task's current candidate. The previous current one is superseded by it and kept.
	 */
	declareCandidate(input: {
		expectedFileRevision: number;
		projectId: string;
		taskId: string;
		candidate: EndoCandidateDeclarationV0;
	}): EndoCoordinationResultV0<EndoCandidateRefV0> {
		if (
			!isRevision(input.expectedFileRevision) ||
			!ENDO_PROJECT_ID_PATTERN_V0.test(input.projectId) ||
			!ENDO_TASK_ID_PATTERN_V0.test(input.taskId)
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			if (draft.revision !== input.expectedFileRevision)
				return fail("stale-revision", `coordination file is at revision ${draft.revision}`);
			const task = DevelopCoordinationStoreV0.#task(context, input.projectId, input.taskId);
			if (!task.ok) return task;
			const attemptId = input.candidate.attemptId;
			if (attemptId !== null) {
				const attempts = context.attempts();
				if (!attempts.ok) return fail("attempts-unreadable");
				const entry = attempts.entries.find((e) => e.attempt.id === attemptId);
				if (entry === undefined) return fail("not-found", `attempt ${attemptId}`);
				if (entry.attempt.taskId !== input.taskId || entry.attempt.projectId !== input.projectId)
					return fail("cross-project", `attempt ${attemptId} belongs to another task`);
			}
			let entry = draft.taskCandidates.find((t) => t.taskId === input.taskId);
			if (entry === undefined) {
				if (draft.taskCandidates.length >= L.maxCandidateTasks) return fail("limit");
				entry = {
					projectId: input.projectId,
					taskId: input.taskId,
					revision: 0,
					currentCandidateId: null,
					candidates: [],
				};
				draft.taskCandidates.push(entry);
			}
			if (entry.candidates.length >= L.maxCandidatesPerTask) return fail("limit");
			const c = input.candidate;
			const twin = entry.candidates.find((x) =>
				x.kind === "git-commit" && c.kind === "git-commit"
					? x.commonDir === c.commonDir && x.commitSha === c.commitSha
					: x.kind === "protected-candidate" && c.kind === "protected-candidate"
						? x.attemptId === c.attemptId && x.bindingSha256 === c.bindingSha256
						: false,
			);
			if (twin !== undefined) return fail("duplicate", `candidate ${twin.candidateId}; select it instead`);
			const common = {
				candidateId: `endo.candidate.${hex(16)}`,
				declaredBy: "operator" as const,
				supersedesCandidateId: entry.currentCandidateId,
				taskRevisionAtDeclare: task.revision,
				declaredAtMs: context.now,
			};
			const made: EndoCandidateRefV0 =
				c.kind === "git-commit"
					? {
							kind: "git-commit",
							...common,
							commonDir: c.commonDir,
							worktreePath: c.worktreePath,
							commitSha: c.commitSha,
							treeSha: c.treeSha,
							attemptId: c.attemptId,
						}
					: {
							kind: "protected-candidate",
							...common,
							attemptId: c.attemptId,
							runId: c.runId,
							bindingSha256: c.bindingSha256,
							candidateSha256: c.candidateSha256,
						};
			entry.candidates.push(made);
			entry.currentCandidateId = made.candidateId;
			entry.revision += 1;
			return { ok: true, value: made };
		});
	}

	/** Select which declared candidate is current (or none). A selection, never an acceptance; nothing is erased. */
	selectCandidate(
		taskId: string,
		expectedRevision: number,
		candidateId: string | null,
	): EndoCoordinationResultV0<{ taskId: string; currentCandidateId: string | null }> {
		if (
			!ENDO_TASK_ID_PATTERN_V0.test(taskId) ||
			!isRevision(expectedRevision) ||
			(candidateId !== null && !ENDO_CANDIDATE_ID_PATTERN_V0.test(candidateId))
		)
			return fail("bad-request");
		return this.#mutate((draft) => {
			const entry = draft.taskCandidates.find((t) => t.taskId === taskId);
			if (entry === undefined) return fail("not-found", `task ${taskId} has no candidates`);
			if (entry.revision !== expectedRevision)
				return fail("stale-revision", `candidates are at revision ${entry.revision}`);
			if (candidateId !== null && !entry.candidates.some((c) => c.candidateId === candidateId))
				return fail("not-found", `candidate ${candidateId}`);
			const value = { taskId, currentCandidateId: candidateId };
			if (entry.currentCandidateId === candidateId) return { ok: true, value, unchanged: true };
			entry.currentCandidateId = candidateId;
			entry.revision += 1;
			return { ok: true, value };
		});
	}
}

/** Parse and validate bytes that claim to be a coordination file (shared by the store and descriptor-pinned sandbox readers). */
export function endoParseCoordinationBytesV0(bytes: Uint8Array): EndoCoordinationReadV0 {
	if (bytes.length > L.maxFileBytes) return { ok: false, reason: "too-large" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return { ok: false, reason: "malformed" };
	}
	const read = readEndoDevelopCoordinationFileV0(parsed);
	if (!read.ok) return { ok: false, reason: read.kind === "unsupported-version" ? "unsupported-version" : "invalid" };
	return { ok: true, file: read.value, exists: true };
}
