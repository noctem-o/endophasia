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
import type { EndoCandidateIdentityReadingV0 } from "../protocol/coordinator-coordination.ts";
import type { EndoDevelopAdapterAuthorizationV0 } from "../protocol/develop-adapter-authorization.ts";
import {
	ENDO_ATTEMPT_ID_PATTERN_V0,
	endoDevelopTaskWordsChangedV0,
	renderEndoDevelopBriefV0,
} from "../protocol/develop-attempts.ts";
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
	ENDO_WORKTREE_ID_PATTERN_V0,
	type EndoAccessIntentV0,
	type EndoAssignmentV0,
	type EndoCandidateRefV0,
	type EndoDependencyConditionV0,
	type EndoDependencyV0,
	type EndoDevelopCoordinationFileV0,
	type EndoHazardEvidenceSnapshotV0,
	type EndoIntendedHarnessFamilyV0,
	type EndoParticipantRoleV0,
	type EndoRegisteredWorktreeV0,
	type EndoSessionAssociationV0,
	type EndoWorkspaceRegistrationV0,
	type EndoWorktreeHazardV0,
	emptyEndoDevelopCoordinationFileV0,
	endoDependencyCycleV0,
	endoHazardBasesFromSnapshotV0,
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
import { endoBriefSha256V0 } from "../runtime/contracts/develop-attempt-execution.ts";
import {
	type EndoAttemptExecutionEvidenceV0,
	type EndoCoordinationTaskFactV0,
	type EndoReceiptSourceV0,
	endoAttemptExecutionEvidenceFromReadV0,
	endoCoordinationProjectionV0,
	endoEffectiveAssignmentFromSnapshotV0,
	endoEffectiveAssignmentV0,
	endoHazardEvidenceDigestV0,
	endoHazardEvidenceSnapshotV0,
	endoRouteEvidenceForAttemptV0,
	endoTerminalHazardBasesV0,
	endoWorktreeConflictsV0,
	endoWorktreeWriteConflictsV0,
} from "../runtime/contracts/develop-coordination.ts";
import {
	checkAdapterAuthorizationPresenceSyncV0,
	DevelopAdapterAuthorizationsStoreV0,
} from "./develop-adapter-authorizations.ts";
import {
	checkProtectedAttemptPresenceSyncV0,
	DevelopAttemptRoutesStoreV0,
	type EndoDevelopAttemptRouteV0,
} from "./develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0, type EndoAttemptsReadV0, endoAttemptProblemsOfV0 } from "./develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "./develop-receipts.ts";
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
	| "stale-evidence"
	| "invalid-transition"
	| "bad-request"
	| "limit"
	| "duplicate"
	| "dependency-cycle"
	| "cross-project"
	| "worktree-write-overlap"
	| "worktree-not-registered"
	| "assignment-not-active"
	| "attempt-not-linked"
	| "already-authorized"
	| "prerequisites-not-satisfied"
	| "prerequisites-unknown"
	| "task-done"
	| "task-words-changed"
	| "admission-refused"
	| "synthetic-not-admitted"
	| "unsupported-source"
	| "unreadable"
	| "tasks-unreadable"
	| "attempts-unreadable"
	| "busy"
	| "storage-failed"
	| "commit-partial"
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
	/** For tests: after clearHazard captured and verified its execution-evidence snapshot under the lock, before committing. */
	afterEvidenceRead?: () => void;
	/** For tests: after `.route.json` is claimed inside `commitAssignmentDispatch`, before writing authorization (crash window W1). */
	afterRouteClaim?: () => void;
	/** For tests: after authorization is written inside `commitAssignmentDispatch`, before replacing `coordination.json` (crash window W1b). */
	afterAuthorizationWrite?: () => void;
	/** For tests: deterministic lock interleavings. */
	lockHooks?: EndoNumberedLockHooksV0;
}

const HEX64 = /^[0-9a-f]{64}$/;

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
	evidence: (attemptId: string, assignmentId?: string) => EndoAttemptExecutionEvidenceV0;
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

	/**
	 * Read-only, lock-free snapshot of an assignment's current observed execution evidence and effective hazard.
	 * Operators inspect this (via `endo assign show`) to obtain the exact `digest` bound into `clearHazard`.
	 */
	readHazardEvidence(assignmentId: string):
		| {
				ok: true;
				coordinationRevision: number;
				assignment: EndoAssignmentV0;
				effectiveHazard: EndoWorktreeHazardV0;
				snapshot: EndoHazardEvidenceSnapshotV0;
				digest: string;
		  }
		| {
				ok: false;
				code: "bad-request" | "unreadable" | "not-found";
				reason?: EndoDevelopUnreadableReasonV0;
				detail?: string;
		  } {
		if (!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId)) return { ok: false, code: "bad-request" };
		const read = this.read();
		if (!read.ok) return { ok: false, code: "unreadable", reason: read.reason };
		const assignment = read.file.assignments.find((a) => a.assignmentId === assignmentId);
		if (assignment === undefined) return { ok: false, code: "not-found", detail: `assignment ${assignmentId}` };
		const attemptsRead = new DevelopAttemptsStoreV0(this.#root).read();
		const routes = DevelopAttemptRoutesStoreV0.forRoot(this.#root);
		const adapterAuths = DevelopAdapterAuthorizationsStoreV0.forRoot(this.#root);
		const evidence = (attemptId: string, forAssignmentId?: string): EndoAttemptExecutionEvidenceV0 =>
			endoAttemptExecutionEvidenceFromReadV0(
				attemptId,
				attemptsRead,
				endoRouteEvidenceForAttemptV0(this.#dir, routes, attemptId),
				adapterAuths.read(attemptId),
				forAssignmentId ?? assignment.assignmentId,
			);
		const snapshot = endoHazardEvidenceSnapshotV0(assignment, evidence);
		const effective = endoEffectiveAssignmentFromSnapshotV0(assignment, snapshot);
		return {
			ok: true,
			coordinationRevision: read.file.revision,
			assignment,
			effectiveHazard: effective.worktreeHazard,
			snapshot,
			digest: endoHazardEvidenceDigestV0(snapshot),
		};
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
			const adapterAuths = DevelopAdapterAuthorizationsStoreV0.forRoot(this.#root);
			const evidence = (attemptId: string, assignmentId?: string): EndoAttemptExecutionEvidenceV0 =>
				endoAttemptExecutionEvidenceFromReadV0(
					attemptId,
					readAttempts(),
					endoRouteEvidenceForAttemptV0(this.#dir, routes, attemptId),
					adapterAuths.read(attemptId),
					assignmentId,
				);
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
		if (spec.workspace.registration === "registered-sibling") {
			const registered = (draft.registeredWorktrees ?? []).some(
				(w) => w.projectId === projectId && w.worktreePath === spec.workspace.worktreePath,
			);
			if (!registered)
				return {
					ok: false,
					code: "worktree-not-registered",
					detail: "sibling worktree is not explicitly registered for this project",
				};
		}
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
					// Always write explicit `acknowledgedConflictIds` on E2 assignments (even `[]`) so legacy E1
					// boolean `sharedWorktreeAcknowledged` on another assignment can never mask a new overlap (#8).
					acknowledgedConflictIds:
						conflicts.length > 0 && spec.workspace.allowSharedWorktree
							? conflicts.map((c) => c.assignmentId).sort()
							: [],
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
	 * The operator's explicit statement that they verified the processes behind an ended assignment have stopped,
	 * bound to the exact observed execution evidence snapshot (`expectedEvidenceDigest`) the operator reviewed.
	 * Kept as a record (the bases, acknowledged evidence and prior clearances stay), never automatic and never an
	 * exemption against future execution evidence: newly observed or unreadable evidence reactivates `liveness-unverified`.
	 */
	clearHazard(
		assignmentId: string,
		expectedRevision: number,
		expectedEvidenceDigest: string,
		note: unknown,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		const checked = checkEndoDevelopTextV0("note", note);
		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) ||
			!isRevision(expectedRevision) ||
			typeof expectedEvidenceDigest !== "string" ||
			!HEX64.test(expectedEvidenceDigest) ||
			!checked.ok ||
			checked.text === ""
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision, { allowEnded: true });
			if (!found.ok) return found;
			const a = found.a;
			const snapshot = endoHazardEvidenceSnapshotV0(a, context.evidence);
			const currentDigest = endoHazardEvidenceDigestV0(snapshot);
			const effective = endoEffectiveAssignmentFromSnapshotV0(a, snapshot);
			if (effective.worktreeHazard.state !== "liveness-unverified")
				return fail("invalid-transition", `hazard is ${effective.worktreeHazard.state}`);
			if (currentDigest !== expectedEvidenceDigest)
				return fail(
					"stale-evidence",
					`observed execution evidence changed (current digest ${currentDigest}); re-read before clearing`,
				);
			const priorClearances = effective.worktreeHazard.priorClearances ?? [];
			if (priorClearances.length > L.maxClearanceHistoryPerAssignment)
				return fail("limit", "clearance history limit reached");
			this.#options.afterEvidenceRead?.();
			a.worktreeHazard = {
				state: "operator-cleared",
				clearedBy: "operator",
				via: "cli",
				clearedAtMs: context.now,
				bases: effective.worktreeHazard.bases,
				acknowledgedEvidence: snapshot,
				note: checked.text,
				priorClearances,
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

	// ---- registered sibling worktrees (E2-C) ----------------------------------------------------------------------------------------

	/**
	 * Explicitly register a validated sibling Git worktree for `projectId`.
	 * Git identity validation (canonical path, shared commonDir, bidirectional gitdir check) MUST run outside the lock
	 * before calling this method. Never creates, checks out, or mutates any Git directory.
	 */
	registerWorktree(input: {
		expectedFileRevision: number;
		projectId: string;
		worktreePath: string;
		commonDir: string;
		gitDir: string;
		label?: unknown;
	}): EndoCoordinationResultV0<EndoRegisteredWorktreeV0> {
		const labelCheck = DevelopCoordinationStoreV0.#reason(input.label);
		if (
			!isRevision(input.expectedFileRevision) ||
			!ENDO_PROJECT_ID_PATTERN_V0.test(input.projectId) ||
			!isEndoCanonicalPathV0(input.worktreePath) ||
			!isEndoCanonicalPathV0(input.commonDir) ||
			!isEndoCanonicalPathV0(input.gitDir) ||
			input.worktreePath === input.commonDir ||
			input.gitDir === input.commonDir ||
			!labelCheck.ok
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			if (draft.revision !== input.expectedFileRevision)
				return fail("stale-revision", `coordination file is at revision ${draft.revision}`);
			const tasks = context.tasks();
			if (!tasks.ok) return fail("tasks-unreadable");
			const project = tasks.file.projects.find((p) => p.id === input.projectId);
			if (project === undefined) return fail("not-found", `project ${input.projectId}`);
			if (project.path === input.worktreePath)
				return fail("bad-request", "the project's primary checkout is already registered in tasks.json");
			const list = draft.registeredWorktrees ?? [];
			if (list.length >= L.maxRegisteredWorktrees) return fail("limit");
			const dup = list.find((w) => w.worktreePath === input.worktreePath || w.gitDir === input.gitDir);
			if (dup !== undefined) return fail("duplicate", `worktree ${dup.worktreeId}`);
			const entry: EndoRegisteredWorktreeV0 = {
				worktreeId: `endo.worktree.${hex(16)}`,
				projectId: input.projectId,
				worktreePath: input.worktreePath,
				commonDir: input.commonDir,
				gitDir: input.gitDir,
				label: labelCheck.text,
				registeredBy: "operator",
				via: "cli",
				registeredAtMs: context.now,
			};
			draft.registeredWorktrees = [...list, entry];
			return { ok: true, value: entry };
		});
	}

	/** Remove an operator-registered sibling worktree. Refuses while an active assignment references it. */
	unregisterWorktree(
		worktreeId: string,
		expectedFileRevision: number,
	): EndoCoordinationResultV0<EndoRegisteredWorktreeV0> {
		if (!ENDO_WORKTREE_ID_PATTERN_V0.test(worktreeId) || !isRevision(expectedFileRevision))
			return fail("bad-request");
		return this.#mutate((draft) => {
			if (draft.revision !== expectedFileRevision)
				return fail("stale-revision", `coordination file is at revision ${draft.revision}`);
			const list = draft.registeredWorktrees ?? [];
			const idx = list.findIndex((w) => w.worktreeId === worktreeId);
			if (idx === -1) return fail("not-found", `worktree ${worktreeId}`);
			const target = list[idx] as EndoRegisteredWorktreeV0;
			const activeUsing = draft.assignments.find(
				(a) =>
					a.state === "active" &&
					a.projectId === target.projectId &&
					a.workspace.worktreePath === target.worktreePath &&
					a.workspace.registration === "registered-sibling",
			);
			if (activeUsing !== undefined)
				return fail(
					"invalid-transition",
					`active assignment ${activeUsing.assignmentId} still references this registered worktree`,
				);
			const remaining = [...list.slice(0, idx), ...list.slice(idx + 1)];
			if (remaining.length === 0) delete draft.registeredWorktrees;
			else draft.registeredWorktrees = remaining;
			return { ok: true, value: target };
		});
	}

	/**
	 * Conservative pre-transport abort hazard clear (docs/designs/coordinator-assignment.md §6.2 Winner B):
	 * Re-acquires `coordination.lock.<n>` with `expectedRevision` OCC and clears `liveness-unverified` to `none`
	 * ONLY if:
	 * 1. The specific `(attemptId, authorizationId)` is linked to `assignmentId` and has matching `.authorized.json`
	 *    and `.aborted.json` bound to `assignmentId` with no `.outcome.json`, AND
	 * 2. Every currently observed hazard basis across the assignment is gone (zero writable-session hazard, zero
	 *    unreadable/conflicting attempt evidence, zero other unverified attempts).
	 */
	clearHazardAfterPreTransportAbort(
		assignmentId: string,
		expectedRevision: number,
		attemptId: string,
		authorizationId: string,
	): EndoCoordinationResultV0<EndoAssignmentV0> {
		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(assignmentId) ||
			!isRevision(expectedRevision) ||
			!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId) ||
			typeof authorizationId !== "string" ||
			authorizationId.length === 0
		)
			return fail("bad-request");
		return this.#mutate((draft, context) => {
			const found = this.#activeAssignment(draft, assignmentId, expectedRevision, { allowEnded: true });
			if (!found.ok) return found;
			const a = found.a;
			if (a.state === "active") return fail("invalid-transition", "assignment is active");
			if (a.worktreeHazard.state !== "liveness-unverified")
				return fail("invalid-transition", `hazard is ${a.worktreeHazard.state}`);
			if (!a.attemptIds.includes(attemptId))
				return fail("attempt-not-linked", `attempt ${attemptId} is not linked to ${assignmentId}`);
			const adapterRecords = DevelopAdapterAuthorizationsStoreV0.forRoot(this.#root).read(attemptId);
			if (
				adapterRecords.authorization.state !== "present" ||
				adapterRecords.abort.state !== "present" ||
				adapterRecords.outcome.state !== "absent" ||
				adapterRecords.authorization.record.assignmentId !== assignmentId ||
				adapterRecords.authorization.record.authorizationId !== authorizationId ||
				adapterRecords.abort.record.assignmentId !== assignmentId ||
				adapterRecords.abort.record.authorizationId !== authorizationId
			) {
				return fail(
					"invalid-transition",
					"pre-transport abort evidence does not match this assignment and authorization",
				);
			}
			const snapshot = endoHazardEvidenceSnapshotV0(a, context.evidence);
			const remainingBases = endoHazardBasesFromSnapshotV0(snapshot);
			if (remainingBases.length > 0)
				return fail(
					"invalid-transition",
					`unverified hazard bases remain (${remainingBases.join(", ")}); cannot clear automatically`,
				);
			a.worktreeHazard = { state: "none" };
			a.revision += 1;
			a.updatedAtMs = context.now;
			return { ok: true, value: a };
		});
	}

	/**
	 * Linearises an unlinked (non-assignment) workbench or protected route claim inside `coordination.lock.<n>`,
	 * closing the TOCTOU window where a concurrent `linkAttempt` links `attemptId` to an assignment between
	 * preflight and `.route.json` claim (Adversarial Finding #2). Never creates `coordination.json`.
	 */
	claimUnlinkedAttemptRoute(input: {
		attemptId: string;
		route: "workbench" | "protected";
		recordedAtMs?: number;
		writeRouteRecord: (recordedAtMs: number) => "created" | "exists" | "unsafe-path" | "failed";
	}):
		| { ok: true; recordedAtMs: number }
		| {
				ok: false;
				code:
					| "assignment-required"
					| "already-authorized"
					| "already-launched"
					| "unreadable"
					| "busy"
					| "storage-failed";
				routeClaimed: boolean;
		  } {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(input.attemptId))
			return { ok: false, code: "unreadable", routeClaimed: false };
		if (!this.#ensureDirectory()) return { ok: false, code: "unreadable", routeClaimed: false };
		const release = acquireEndoNumberedLockV0(this.#dir, ENDO_DEVELOP_COORDINATION_LOCK_V0, {
			waitMs: this.#options.lockWaitMs ?? 2000,
			now: this.#now,
			...(this.#options.lockHooks === undefined ? {} : { hooks: this.#options.lockHooks }),
		});
		if (release === "busy") return { ok: false, code: "busy", routeClaimed: false };
		if (release === "failed") return { ok: false, code: "storage-failed", routeClaimed: false };
		try {
			const coordRead = this.read();
			if (!coordRead.ok) return { ok: false, code: "unreadable", routeClaimed: false };
			if (coordRead.exists && coordRead.file.assignments.some((a) => a.attemptIds.includes(input.attemptId))) {
				return { ok: false, code: "assignment-required", routeClaimed: false };
			}
			const nowMs = input.recordedAtMs ?? this.#now();
			const routes = DevelopAttemptRoutesStoreV0.forRoot(this.#root);
			const claimed = routes.claim(input.attemptId, input.route, nowMs);
			if (claimed !== "created") {
				if (claimed === "exists") {
					const winner = routes.read(input.attemptId);
					if (winner.state !== "present") return { ok: false, code: "unreadable", routeClaimed: false };
					if (input.route === "protected" && winner.record.route === "protected") {
						return { ok: false, code: "already-launched", routeClaimed: false };
					}
					return { ok: false, code: "already-authorized", routeClaimed: false };
				}
				return {
					ok: false,
					code: claimed === "unsafe-path" ? "unreadable" : "storage-failed",
					routeClaimed: false,
				};
			}
			const written = input.writeRouteRecord(nowMs);
			if (written === "created") return { ok: true, recordedAtMs: nowMs };
			if (written === "exists") {
				return {
					ok: false,
					code: input.route === "protected" ? "already-launched" : "already-authorized",
					routeClaimed: true,
				};
			}
			return {
				ok: false,
				code: written === "unsafe-path" ? "unreadable" : "storage-failed",
				routeClaimed: true,
			};
		} finally {
			release();
		}
	}

	// ---- atomic revocation-dispatch linearisation boundary (E2-B) -------------------------------------------------------------------

	/**
	 * Linearises assignment-linked dispatch commitment against assignment mutations (revocation, supersession, close)
	 * inside `coordination.lock.<n>` (docs/designs/coordinator-assignment.md §6.2).
	 *
	 * Bounded local filesystem critical section ONLY:
	 * - Never acquires `tasks.lock.<n>` (reads `tasks.json` lock-free as one atomic snapshot).
	 * - Never runs Git subprocesses, terminal prompts, or harness transport I/O.
	 * - Releases `coordination.lock.<n>` unconditionally before returning.
	 * - Explicitly discloses partial cross-file write state (`routeClaimed`, `authorizationWritten`) on failure so
	 *   callers never silently retry a burned attempt or claim multi-file writes are a single OS transaction.
	 */
	commitAssignmentDispatch(input: EndoCommitAssignmentDispatchInputV0): EndoCommitAssignmentDispatchResultV0 {
		const refuse = (
			code: EndoCoordinationRefusalV0,
			detail?: string,
			extra: { routeClaimed?: boolean; authorizationWritten?: boolean; admissionCode?: string } = {},
		): EndoCommitAssignmentDispatchResultV0 => ({
			ok: false,
			code,
			...(detail === undefined ? {} : { detail }),
			...(extra.admissionCode === undefined ? {} : { admissionCode: extra.admissionCode }),
			routeClaimed: extra.routeClaimed ?? false,
			authorizationWritten: extra.authorizationWritten ?? false,
		});

		if (
			!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(input.assignmentId) ||
			!isRevision(input.expectedAssignmentRevision) ||
			!isRevision(input.expectedTaskRevision) ||
			!ENDO_PROJECT_ID_PATTERN_V0.test(input.projectId) ||
			!ENDO_TASK_ID_PATTERN_V0.test(input.taskId) ||
			!ENDO_ATTEMPT_ID_PATTERN_V0.test(input.attemptId) ||
			!HEX64.test(input.expectedBriefSha256) ||
			!isEndoCanonicalPathV0(input.worktreePath)
		)
			return refuse("bad-request", "invalid dispatch commitment parameters");

		if (input.route === "adapter-live" && input.adapterAuthorization === undefined)
			return refuse("bad-request", "adapter-live commitment requires adapterAuthorization payload");

		if (!this.#ensureDirectory()) return refuse("unreadable", "develop directory is unsafe");
		const release = acquireEndoNumberedLockV0(this.#dir, ENDO_DEVELOP_COORDINATION_LOCK_V0, {
			waitMs: this.#options.lockWaitMs ?? 2000,
			now: this.#now,
			...(this.#options.lockHooks === undefined ? {} : { hooks: this.#options.lockHooks }),
		});
		if (release === "busy") return refuse("busy");
		if (release === "failed") return refuse("storage-failed");

		try {
			this.#sweep();
			const coordRead = this.read();
			if (!coordRead.ok) return refuse("unreadable", `coordination store unreadable (${coordRead.reason})`);
			if (!coordRead.exists) return refuse("not-found", `assignment ${input.assignmentId}`);

			const draft = clone(coordRead.file);
			const assignment = draft.assignments.find((a) => a.assignmentId === input.assignmentId);
			if (assignment === undefined) return refuse("not-found", `assignment ${input.assignmentId}`);
			if (assignment.state !== "active")
				return refuse("assignment-not-active", `assignment ${input.assignmentId} is ${assignment.state}`);
			if (assignment.revision !== input.expectedAssignmentRevision)
				return refuse("stale-revision", `assignment is at revision ${assignment.revision}`);
			if (assignment.projectId !== input.projectId || assignment.taskId !== input.taskId)
				return refuse("cross-project", "assignment does not match requested project/task");
			if (!assignment.attemptIds.includes(input.attemptId))
				return refuse("attempt-not-linked", `attempt ${input.attemptId} is not linked to ${input.assignmentId}`);

			// Re-read tasks.json lock-free (no tasks.lock.<n> nesting).
			const tasksRead = new DevelopTasksStoreV0(this.#root).read();
			if (!tasksRead.ok) return refuse("tasks-unreadable", `tasks unreadable (${tasksRead.reason})`);
			const project = tasksRead.file.projects.find((p) => p.id === input.projectId);
			if (project === undefined) return refuse("not-found", `project ${input.projectId}`);
			const task = tasksRead.file.tasks.find((t) => t.id === input.taskId && t.projectId === input.projectId);
			if (task === undefined) return refuse("not-found", `task ${input.taskId}`);
			if (task.status === "done") return refuse("task-done", `task ${input.taskId} is done`);
			if (task.revision !== input.expectedTaskRevision)
				return refuse("stale-revision", `task ${input.taskId} is at revision ${task.revision}`);
			if (task.revision !== assignment.taskRevisionAtBind)
				return refuse(
					"stale-revision",
					`assignment is bound to task revision ${assignment.taskRevisionAtBind}, current is ${task.revision}`,
				);

			// Revalidate worktree registration inside the critical section.
			if (assignment.workspace.worktreePath !== input.worktreePath)
				return refuse("worktree-not-registered", "dispatch worktree does not match assignment workspace");
			if (assignment.workspace.registration === "project-path") {
				if (input.worktreePath !== project.path)
					return refuse("worktree-not-registered", "worktree does not match project primary path");
			} else if (assignment.workspace.registration === "registered-sibling") {
				const reg = (draft.registeredWorktrees ?? []).find(
					(w) => w.projectId === input.projectId && w.worktreePath === input.worktreePath,
				);
				if (reg === undefined) return refuse("worktree-not-registered", "sibling worktree is no longer registered");
				if (
					input.verifiedWorktree === undefined ||
					input.verifiedWorktree.commonDir !== reg.commonDir ||
					input.verifiedWorktree.gitDir === null ||
					input.verifiedWorktree.gitDir !== reg.gitDir
				)
					return refuse(
						"worktree-not-registered",
						"registered sibling worktree identity could not be re-established",
					);
			} else {
				return refuse(
					"worktree-not-registered",
					"unregistered sibling worktrees are not eligible for governed dispatch",
				);
			}

			// Revalidate attempt records, routes, protected presence, and adapter authorizations.
			const attemptsRead = new DevelopAttemptsStoreV0(this.#root).read();
			if (!attemptsRead.ok) return refuse("attempts-unreadable", `attempts unreadable (${attemptsRead.reason})`);
			if (endoAttemptProblemsOfV0(attemptsRead.problems, input.attemptId).length > 0)
				return refuse("unreadable", `attempt ${input.attemptId} has unreadable files`);
			const entry = attemptsRead.entries.find((e) => e.attempt.id === input.attemptId);
			if (entry === undefined) return refuse("not-found", `attempt ${input.attemptId}`);
			if (entry.attempt.projectId !== input.projectId || entry.attempt.taskId !== input.taskId)
				return refuse("cross-project", `attempt ${input.attemptId} belongs to another task`);
			if (entry.authorized !== null)
				return refuse("already-authorized", "attempt already has a workbench authorization");
			if (entry.outcome !== null) return refuse("invalid-transition", "attempt already has a recorded outcome");
			if (entry.handoff !== null) return refuse("invalid-transition", "attempt was already handed off");

			const routes = DevelopAttemptRoutesStoreV0.forRoot(this.#root);
			const existingRoute = routes.read(input.attemptId);
			if (existingRoute.state === "present")
				return refuse("already-authorized", `attempt route already claimed by ${existingRoute.record.route}`);
			if (existingRoute.state === "problem") return refuse("unreadable", "attempt route reservation is unreadable");

			const protectedPresence = checkProtectedAttemptPresenceSyncV0(this.#dir, input.attemptId);
			if (protectedPresence === "present")
				return refuse("already-authorized", "attempt already has a protected launch or binding");
			if (protectedPresence === "problem") return refuse("unreadable", "protected attempts directory is unreadable");

			const adapterPresence = checkAdapterAuthorizationPresenceSyncV0(this.#dir, input.attemptId);
			if (adapterPresence === "present")
				return refuse("already-authorized", "attempt already has an adapter authorization record");
			if (adapterPresence === "problem")
				return refuse("unreadable", "adapter authorizations directory is unreadable");

			if (endoDevelopTaskWordsChangedV0(entry.attempt, task).length > 0)
				return refuse("task-words-changed", "task words changed since attempt preparation");
			const briefSha = endoBriefSha256V0(renderEndoDevelopBriefV0(entry.attempt));
			if (briefSha !== input.expectedBriefSha256)
				return refuse("task-words-changed", "attempt brief digest differs from approved digest");

			// Revalidate effective hazards and worktree write overlaps inside the lock.
			const adapterAuths = DevelopAdapterAuthorizationsStoreV0.forRoot(this.#root);
			const evidence = (attemptId: string, assignmentId?: string): EndoAttemptExecutionEvidenceV0 =>
				endoAttemptExecutionEvidenceFromReadV0(
					attemptId,
					attemptsRead,
					endoRouteEvidenceForAttemptV0(this.#dir, routes, attemptId),
					adapterAuths.read(attemptId),
					assignmentId,
				);
			const effectiveAssignments = draft.assignments.map((a) => endoEffectiveAssignmentV0(a, evidence));
			if (assignment.workspace.accessIntent === "read-write-intended") {
				const conflicts = endoWorktreeConflictsV0(effectiveAssignments);
				const blocking = conflicts.find(
					(c) =>
						c.worktreePath === input.worktreePath &&
						c.kind === "unacknowledged-worktree-write-overlap" &&
						c.assignmentIds.includes(assignment.assignmentId),
				);
				if (blocking !== undefined)
					return refuse(
						"worktree-write-overlap",
						`unacknowledged worktree write overlap on ${input.worktreePath}`,
					);
			}

			// Revalidate relevant dependency state for this task inside the lock.
			const taskDeps = draft.dependencies.filter(
				(d) => d.projectId === input.projectId && d.dependentTaskId === input.taskId,
			);
			if (taskDeps.length > 0) {
				const byId = new Map<string, EndoCoordinationTaskFactV0>();
				for (const t of tasksRead.file.tasks) {
					if (t.projectId === input.projectId)
						byId.set(t.id, { projectId: t.projectId, status: t.status, revision: t.revision });
				}
				const receiptsStore = new DevelopReceiptsStoreV0(this.#root);
				const receiptMap = new Map<string, EndoReceiptSourceV0>();
				const prereqTasks = new Set(taskDeps.map((d) => d.prerequisiteTaskId));
				for (const e of attemptsRead.entries) {
					if (e.attempt.projectId === input.projectId && prereqTasks.has(e.attempt.taskId)) {
						const r = receiptsStore.read(e.attempt.id);
						receiptMap.set(
							e.attempt.id,
							r.ok ? { ok: true, receipts: r.receipts, problems: r.problems.length } : { ok: false },
						);
					}
				}
				const proj = endoCoordinationProjectionV0({
					readAtMs: this.#now(),
					requested: [input.projectId],
					registeredProjects: tasksRead.file.projects.map((p) => p.id),
					coordination: { state: "ready", file: draft },
					tasks: { ok: true, byId },
					attempts: { ok: true, entries: attemptsRead.entries, problems: attemptsRead.problems },
					receipts: (id) => receiptMap.get(id) ?? { ok: false },
					route: (id) => endoRouteEvidenceForAttemptV0(this.#dir, routes, id),
					adapterAuthorizations: (id) => adapterAuths.read(id),
					identity: input.verifiedCandidates ?? new Map(),
					workspaces: new Map(),
					gaps: [],
				});
				const evaluated = (proj.projects[0]?.dependencies ?? []).filter((d) => d.dependentTaskId === input.taskId);
				const unsatisfied = evaluated.find((d) => d.satisfaction === "unsatisfied");
				if (unsatisfied !== undefined)
					return refuse(
						"prerequisites-not-satisfied",
						`dependency ${unsatisfied.dependencyId} unsatisfied (${unsatisfied.reasons.join(", ")})`,
					);
				const unknownDep = evaluated.find((d) => d.satisfaction === "unknown");
				if (unknownDep !== undefined)
					return refuse(
						"prerequisites-unknown",
						`dependency ${unknownDep.dependencyId} unknown (${unknownDep.reasons.join(", ")})`,
					);
			}

			// Pure in-memory live adapter admission check before claiming `.route.json`.
			if (input.admitInLock !== undefined) {
				const decision = input.admitInLock();
				if (!decision.admitted)
					return refuse("admission-refused", decision.reason, { admissionCode: decision.code });
			}

			// ---- Commitment writes (bounded local FS only; cross-file windows explicitly disclosed) ----
			const nowMs = this.#now();

			// C1: Atomically claim shared immutable `.route.json` via POSIX `link(2)`.
			const claimed = routes.claim(input.attemptId, input.route, nowMs);
			if (claimed !== "created") {
				if (claimed === "exists") {
					const after = routes.read(input.attemptId);
					return refuse(after.state === "present" ? "already-authorized" : "unreadable");
				}
				return refuse(claimed === "unsafe-path" ? "unreadable" : "storage-failed");
			}
			// Test hook for crash window W1 (after `.route.json` claim, before authorization write).
			try {
				this.#options.afterRouteClaim?.();
			} catch (error) {
				return refuse(
					"commit-partial",
					`interrupted after route claim (Window W1): ${error instanceof Error ? error.message : "unknown error"}; do not retry automatically`,
					{ routeClaimed: true, authorizationWritten: false },
				);
			}

			// C2: Write the write-once authorization / route record.
			let writtenAuth: EndoDevelopAdapterAuthorizationV0 | undefined;
			if (input.route === "adapter-live") {
				const record: EndoDevelopAdapterAuthorizationV0 = {
					...(input.adapterAuthorization as Omit<EndoDevelopAdapterAuthorizationV0, "recordedAtMs">),
					recordedAtMs: nowMs,
				};
				const written = adapterAuths.writeAuthorization(record);
				if (written !== "created") {
					// Never delete `.route.json` on failure: attempt is permanently burned.
					return refuse(
						"commit-partial",
						`route reservation was claimed but adapter authorization write returned ${written}; do not retry automatically`,
						{ routeClaimed: true, authorizationWritten: false },
					);
				}
				writtenAuth = record;
			} else if (input.writeRouteRecord !== undefined) {
				const written = input.writeRouteRecord(nowMs);
				if (written !== "created") {
					return refuse(
						"commit-partial",
						`route reservation was claimed but route record write returned ${written}; do not retry automatically`,
						{ routeClaimed: true, authorizationWritten: false },
					);
				}
			}
			// Test hook for crash window W1b (after auth write, before `coordination.json` replace).
			try {
				this.#options.afterAuthorizationWrite?.();
			} catch (error) {
				return refuse(
					"commit-partial",
					`interrupted after authorization write (Window W1b): ${error instanceof Error ? error.message : "unknown error"}; do not retry automatically`,
					{ routeClaimed: true, authorizationWritten: true },
				);
			}

			// C3: Record the linked dispatched attempt on the assignment and replace `coordination.json`.
			const existingDispatched = assignment.dispatchedAttemptIds ?? [];
			if (!existingDispatched.includes(input.attemptId)) {
				assignment.dispatchedAttemptIds = [...existingDispatched, input.attemptId];
			}
			assignment.revision += 1;
			assignment.updatedAtMs = nowMs;
			draft.revision = coordRead.file.revision + 1;

			let checked: EndoDevelopCoordinationFileV0;
			try {
				checked = validateEndoDevelopCoordinationFileV0(draft);
			} catch {
				return refuse(
					"commit-partial",
					"route and authorization were written but updated coordination.json failed validation; do not retry automatically",
					{ routeClaimed: true, authorizationWritten: true },
				);
			}
			const outcome = this.#replace(checked);
			if (outcome !== "committed") {
				return refuse(
					outcome === "uncertain" ? "commit-uncertain" : "commit-partial",
					"route and authorization were written before coordination.json could be confirmed; inspect before acting and never retry automatically",
					{ routeClaimed: true, authorizationWritten: true },
				);
			}
			const updated = checked.assignments.find((a) => a.assignmentId === input.assignmentId) as EndoAssignmentV0;
			return {
				ok: true,
				assignment: updated,
				coordinationRevision: checked.revision,
				route: input.route,
				recordedAtMs: nowMs,
				...(writtenAuth === undefined ? {} : { adapterAuthorization: writtenAuth }),
				commit: "committed",
			};
		} finally {
			release();
		}
	}
}

export interface EndoCommitAssignmentDispatchInputV0 {
	assignmentId: string;
	expectedAssignmentRevision: number;
	expectedTaskRevision: number;
	projectId: string;
	taskId: string;
	attemptId: string;
	expectedBriefSha256: string;
	worktreePath: string;
	verifiedWorktree?: { commonDir: string; gitDir: string | null };
	verifiedCandidates?: ReadonlyMap<string, EndoCandidateIdentityReadingV0>;
	route: EndoDevelopAttemptRouteV0;
	admitInLock?: () => { admitted: true } | { admitted: false; code: string; reason: string };
	adapterAuthorization?: Omit<EndoDevelopAdapterAuthorizationV0, "recordedAtMs">;
	writeRouteRecord?: (recordedAtMs: number) => "created" | "exists" | "unsafe-path" | "failed";
}

export type EndoCommitAssignmentDispatchResultV0 =
	| {
			ok: true;
			assignment: EndoAssignmentV0;
			coordinationRevision: number;
			route: EndoDevelopAttemptRouteV0;
			recordedAtMs: number;
			adapterAuthorization?: EndoDevelopAdapterAuthorizationV0;
			commit: "committed";
	  }
	| {
			ok: false;
			code: EndoCoordinationRefusalV0;
			detail?: string;
			admissionCode?: string;
			routeClaimed: boolean;
			authorizationWritten: boolean;
	  };

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
