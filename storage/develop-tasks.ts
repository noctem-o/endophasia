// The DEVELOP task store: `<root>/develop/tasks.json` (`endo.develop-tasks.v0` or `.v1`, protocol/develop-tasks.ts).
//
// Versions. Both are read; every operation works on the v1 model. A file is written in the version it was READ in: a v0 file stays v0 while
// it holds only what v0 can say (a change v0 cannot record, an `omp-saved` reference, is refused `upgrade-required`), and becomes v1 only
// through `upgrade()`, the operator's explicit act. A v1 file is always written as v1. A missing file is created as v1. Nothing is migrated
// by being read.
//
// This is operator metadata, kept SEPARATE from the evidence it sits beside: it is not an event, is never appended to the event log, and
// changes nothing the log, the ledger, the capture store or any intervention record holds. Deleting `develop/` loses tasks and nothing else.
//
// Discipline:
// - One small JSON file, rewritten whole. Every change is: take the lock, READ the file again from disk, validate it, apply ONE change to
//   that copy, validate the result, write it to a uniquely named temporary file (mode 0600, created exclusively, never through a link),
//   fsync it, rename it over the file, fsync the directory. A crash leaves the old file or the new one, never a mixture; a temporary file
//   a crash left behind is removed by the next writer (which holds the lock, so it cannot be a live writer's).
// - Two processes write it (the attached workbench and the `endo` CLI). The lock (`tasks.lock.<n>`, the highest number holds it, created exclusively, naming its pid;
//   a lock whose process is gone is superseded, never removed from under a writer that has just taken it) keeps a read-modify-write whole; a per-task `revision` and a per-file `revision` mean an edit
//   made against an old view is refused (`stale-revision`), not merged over a newer one.
// - Nothing is cached: a read is a read of the file. A file that is malformed, of a version this reader does not know, over the size limit,
//   or reached through a link is UNREADABLE: it is reported with a closed reason, no write is ever made over it, and it is left byte for byte as found.
// - Text is bounded and closed (protocol/develop-tasks.ts); the file is at most 4 MiB.
// - It never reads or writes outside `<root>/develop/`: the directory and the file must be plain (not links) and are created owner-only.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	checkEndoDevelopTextV0,
	ENDO_DEVELOP_TASK_LIMITS_V0,
	ENDO_DEVELOP_TASKS_SCHEMA_V0,
	ENDO_DEVELOP_TASKS_SCHEMA_V1,
	ENDO_LINK_ID_PATTERN_V0,
	ENDO_PROJECT_ID_PATTERN_V0,
	ENDO_TASK_ID_PATTERN_V0,
	type EndoDevelopOmpSessionRefV1,
	type EndoDevelopPiSessionRefV1,
	type EndoDevelopProjectV0,
	type EndoDevelopTaskStatusV0,
	type EndoDevelopTasksFileV0,
	type EndoDevelopTasksFileV1,
	type EndoDevelopTaskV1,
	type EndoDevelopUnreadableReasonV0,
	emptyEndoDevelopTasksFileV1,
	endoDevelopNextStatusesV0,
	endoDevelopSessionKeyV1,
	endoDevelopTasksAsV0,
	isEndoDevelopTaskStatusV0,
	readEndoDevelopTasksFileV1,
	upgradeEndoDevelopTasksV0toV1,
	validateEndoDevelopTasksFileV1,
} from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { writeExactSyncV0 } from "./log.ts";

export const ENDO_DEVELOP_DIRECTORY_V0 = "develop";
const FILE = "tasks.json";
const LOCK = "tasks.lock";
const LOCK_NUMBER = /^tasks\.lock\.([1-9][0-9]{0,14})$/;
const LOCK_TEMPORARY = /^tasks\.lock\.tmp-[0-9]+-[0-9a-f]{12}$/;
const TEMPORARY = /^tasks\.json\.tmp-[0-9]+-[0-9a-f]{12}$/;

/** The version a file is in on disk (or, for a missing file, the version it will be created in). */
export type EndoDevelopTasksFormatV1 = typeof ENDO_DEVELOP_TASKS_SCHEMA_V0 | typeof ENDO_DEVELOP_TASKS_SCHEMA_V1;

/** `file` is always the v1 model (a v0 file read through the pure v0 → v1 projection); `format` is what is on disk, unchanged by the read. */
export type EndoTasksReadV0 =
	| { ok: true; file: EndoDevelopTasksFileV1; format: EndoDevelopTasksFormatV1; exists: boolean }
	| { ok: false; reason: EndoDevelopUnreadableReasonV0 };

/** Why a change was not made. Nothing was written for any of them. */
export type EndoTasksRefusalV0 =
	| "not-found"
	| "stale-revision"
	| "invalid-transition"
	| "bad-request"
	| "limit"
	| "duplicate"
	| "unreadable"
	| "busy"
	| "storage-failed"
	/** The change needs a v1 file and the file is v0: `endo task upgrade --apply` first. */
	| "upgrade-required";

export type EndoTasksResultV0<T> =
	| { ok: true; value: T; file: EndoDevelopTasksFileV1 }
	| { ok: false; code: EndoTasksRefusalV0; reason?: EndoDevelopUnreadableReasonV0 };

export interface EndoDevelopTasksStoreOptionsV0 {
	now?: () => number;
	/** How long a writer waits for the lock before answering `busy`. Default 2 000 ms. */
	lockWaitMs?: number;
	/** For tests: runs after the temporary file is complete and before it replaces the file (a throw there is a crash at that point). */
	beforeReplace?: () => void;
}

/** `unchanged`: the change found nothing to do (the same selection, a reference already there): nothing is written and the file is not touched. */
type Draft<T> = { ok: true; value: T; unchanged?: boolean } | { ok: false; code: EndoTasksRefusalV0 };
const fail = (code: EndoTasksRefusalV0): { ok: false; code: EndoTasksRefusalV0 } => ({ ok: false, code });

const sleep = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const clone = (file: EndoDevelopTasksFileV1): EndoDevelopTasksFileV1 =>
	JSON.parse(JSON.stringify(file)) as EndoDevelopTasksFileV1;

/** What an upgrade did: `unchanged` when the file was already v1 (or missing: it will be created as v1), and nothing was written. */
export interface EndoTasksUpgradeV1 {
	from: EndoDevelopTasksFormatV1;
	to: typeof ENDO_DEVELOP_TASKS_SCHEMA_V1;
	unchanged: boolean;
}

export class DevelopTasksStoreV0 {
	readonly #dir: string;
	readonly #now: () => number;
	readonly #lockWaitMs: number;
	readonly #beforeReplace: (() => void) | undefined;

	constructor(root: string, options: EndoDevelopTasksStoreOptionsV0 = {}) {
		this.#dir = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#now = options.now ?? Date.now;
		this.#lockWaitMs = options.lockWaitMs ?? 2000;
		this.#beforeReplace = options.beforeReplace;
	}

	get path(): string {
		return join(this.#dir, FILE);
	}

	// ---- reading ---------------------------------------------------------------------------------------------------------------------

	/** Read the file now. A missing file is an empty workspace (and nothing is created); anything else that is not a good file is unreadable. */
	read(): EndoTasksReadV0 {
		try {
			const directory = lstatSync(this.#dir, { throwIfNoEntry: false });
			const absent = {
				ok: true as const,
				file: emptyEndoDevelopTasksFileV1(),
				format: ENDO_DEVELOP_TASKS_SCHEMA_V1 as EndoDevelopTasksFormatV1,
				exists: false,
			};
			if (directory === undefined) return absent;
			if (!directory.isDirectory()) return { ok: false, reason: "unsafe-path" };
			const entry = lstatSync(this.path, { throwIfNoEntry: false });
			if (entry === undefined) return absent;
			if (!entry.isFile()) return { ok: false, reason: "unsafe-path" };
			if (entry.size > ENDO_DEVELOP_TASK_LIMITS_V0.maxFileBytes) return { ok: false, reason: "too-large" };
			// O_NOFOLLOW: a link swapped in after the check is refused by the system. The size is checked again on the descriptor.
			const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			let bytes: Buffer;
			try {
				const opened = fstatSync(fd);
				if (!opened.isFile()) return { ok: false, reason: "unsafe-path" };
				if (opened.size > ENDO_DEVELOP_TASK_LIMITS_V0.maxFileBytes) return { ok: false, reason: "too-large" };
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
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			} catch {
				return { ok: false, reason: "malformed" };
			}
			const read = readEndoDevelopTasksFileV1(parsed);
			if (!read.ok)
				return { ok: false, reason: read.kind === "unsupported-version" ? "unsupported-version" : "invalid" };
			// A v0 file is shown through the pure projection; the bytes on disk are untouched, and stay v0 until the operator upgrades.
			if (read.value.schemaVersion === ENDO_DEVELOP_TASKS_SCHEMA_V0)
				return {
					ok: true,
					file: upgradeEndoDevelopTasksV0toV1(read.value),
					format: ENDO_DEVELOP_TASKS_SCHEMA_V0,
					exists: true,
				};
			return { ok: true, file: read.value, format: ENDO_DEVELOP_TASKS_SCHEMA_V1, exists: true };
		} catch (error) {
			return { ok: false, reason: errno(error) === "ELOOP" || errno(error) === "ENOTDIR" ? "unsafe-path" : "io" };
		}
	}

	// ---- the one write path ----------------------------------------------------------------------------------------------------------

	/**
	 * The writer lock. It is a series of numbered files, `tasks.lock.<n>`, and the HIGHEST number is the lock: its file says who holds it, or
	 * that it was released. A writer takes the lock by creating `n + 1` (a hard link of a finished temporary file, so the name appears whole
	 * and only one of several contenders can create it), then deletes the lower numbers. Nothing is ever removed or rewritten to take a lock
	 * from another writer, so one writer cannot take away a lock another has just acquired; a lock whose process is gone is simply
	 * superseded by the next number. The highest number is never deleted (a release marks it released, by an atomic rename), so a number is
	 * never reused and a slow contender that judged an old holder dead can only ever create a number that already exists or has been passed.
	 */
	#acquire(): (() => void) | "busy" | "failed" {
		const deadline = Date.now() + this.#lockWaitMs;
		for (;;) {
			const numbers = this.#lockNumbers();
			if (numbers === undefined) return "failed";
			const top = numbers.length === 0 ? 0 : Math.max(...numbers);
			let claimable = top === 0;
			if (top > 0) {
				const state = this.#lockState(top);
				if (state === "gone") continue;
				if (state === "failed") return "failed";
				claimable = state === "free";
			}
			if (claimable) {
				const mine = top + 1;
				const made = this.#createLock(mine, false);
				if (made === "failed") return "failed";
				if (made === "created") {
					// Someone may have created a higher number than ours while ours was not there (ours was deleted as a lower one, then
					// created again by a slow contender): then ours is not the lock, and is withdrawn.
					const after = this.#lockNumbers();
					if (after === undefined) {
						rmSync(this.#lockPath(mine), { force: true });
						return "failed";
					}
					if (after.some((n) => n > mine)) rmSync(this.#lockPath(mine), { force: true });
					else {
						for (const n of after) if (n < mine) rmSync(this.#lockPath(n), { force: true });
						let released = false;
						return () => {
							if (released) return;
							released = true;
							// Marked released, never deleted: the highest number must stay.
							if (this.#createLock(mine, true) === "failed") rmSync(this.#lockPath(mine), { force: true });
						};
					}
				}
				if (Date.now() < deadline) continue;
			}
			if (Date.now() >= deadline) return "busy";
			sleep(20);
		}
	}

	#lockPath(n: number): string {
		return join(this.#dir, `${LOCK}.${n}`);
	}

	/** The lock numbers present, or undefined when the directory cannot be listed. */
	#lockNumbers(): number[] | undefined {
		try {
			const numbers: number[] = [];
			for (const name of readdirSync(this.#dir)) {
				const found = LOCK_NUMBER.exec(name);
				if (found !== null) numbers.push(Number(found[1]));
			}
			return numbers;
		} catch {
			return undefined;
		}
	}

	/** Whether the lock `n` is free to be superseded: released, or held by a process that is gone (or an unreadable one that is old). */
	#lockState(n: number): "free" | "held" | "gone" | "failed" {
		const path = this.#lockPath(n);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			return errno(error) === "ENOENT" ? "gone" : "failed";
		}
		let parsed: { pid?: unknown; released?: unknown } | undefined;
		try {
			parsed = JSON.parse(text) as { pid?: unknown; released?: unknown };
		} catch {
			parsed = undefined;
		}
		if (parsed?.released === true) return "free";
		const holder =
			typeof parsed?.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
		if (holder === undefined) {
			// Not a lock this module wrote (hand-made, damaged): it is only superseded once it is old.
			const info = lstatSync(path, { throwIfNoEntry: false });
			if (info === undefined) return "gone";
			return Date.now() - info.mtimeMs > 60_000 ? "free" : "held";
		}
		if (holder === process.pid) return "held";
		try {
			process.kill(holder, 0);
			return "held";
		} catch (probe) {
			return errno(probe) === "EPERM" ? "held" : "free";
		}
	}

	/** Make lock `n` appear whole: created exclusively when it is a new lock, replaced atomically when it is the release of one's own. */
	#createLock(n: number, release: boolean): "created" | "exists" | "failed" {
		const temporary = join(this.#dir, `${LOCK}.tmp-${process.pid}-${hex(6)}`);
		const content = `${JSON.stringify(
			release ? { released: true } : { pid: process.pid, at: new Date(this.#now()).toISOString() },
		)}\n`;
		try {
			writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
			if (release) renameSync(temporary, this.#lockPath(n));
			else linkSync(temporary, this.#lockPath(n));
			return "created";
		} catch (error) {
			return !release && errno(error) === "EEXIST" ? "exists" : "failed";
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	/** Make the directory (owner-only) and prove it is a plain directory, not a link someone put there. */
	#ensureDirectory(): boolean {
		try {
			const existing = lstatSync(this.#dir, { throwIfNoEntry: false });
			if (existing === undefined) {
				// A fresh store root may not exist yet. Its missing parents are made the ordinary way; only `develop/` is held to 0700, and a
				// link in the way of `develop/` itself is still refused by the lstat above and the check below.
				mkdirSync(dirname(this.#dir), { recursive: true });
				mkdirSync(this.#dir, { mode: 0o700 });
			}
			return lstatSync(this.#dir).isDirectory();
		} catch {
			return false;
		}
	}

	#replace(file: EndoDevelopTasksFileV0 | EndoDevelopTasksFileV1): boolean {
		const text = `${canonicalEndoJsonV0(file as never)}\n`;
		const bytes = Buffer.from(text, "utf8");
		if (bytes.length > ENDO_DEVELOP_TASK_LIMITS_V0.maxFileBytes) return false;
		const temporary = join(this.#dir, `${FILE}.tmp-${process.pid}-${hex(6)}`);
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
			this.#beforeReplace?.();
			renameSync(temporary, this.path);
			const directory = openSync(this.#dir, constants.O_RDONLY | constants.O_DIRECTORY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			return true;
		} catch {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// the descriptor is gone either way
				}
			}
			rmSync(temporary, { force: true });
			return false;
		}
	}

	/** A temporary file left by a writer that crashed. The caller holds the lock, so no live writer owns one. */
	#sweep(): void {
		try {
			for (const name of readdirSync(this.#dir)) {
				const lockTemporary = LOCK_TEMPORARY.test(name);
				if (!TEMPORARY.test(name) && !lockTemporary) continue;
				const info = lstatSync(join(this.#dir, name), { throwIfNoEntry: false });
				// A lock's temporary file belongs to a contender that may be alive and about to link it: only an old one is a crash's.
				if (lockTemporary && info !== undefined && Date.now() - info.mtimeMs < 60_000) continue;
				if (info?.isFile()) rmSync(join(this.#dir, name), { force: true });
			}
		} catch {
			// a sweep that cannot run leaves the files for the next writer
		}
	}

	/**
	 * Apply ONE change to a fresh read of the file. `change` receives a private copy of the v1 model and the version on disk; it returns the
	 * value to answer, or a refusal. The result is validated as a whole in the version it will be written in, so this module never writes a
	 * file it would not itself read. It is written in the version it was read in, unless `upgrade` (the operator's explicit act) says v1.
	 */
	#mutate<T>(
		change: (draft: EndoDevelopTasksFileV1, now: number, format: EndoDevelopTasksFormatV1) => Draft<T>,
		options: { upgrade?: boolean } = {},
	): EndoTasksResultV0<T> {
		if (!this.#ensureDirectory()) return { ok: false, code: "unreadable", reason: "unsafe-path" };
		const release = this.#acquire();
		if (release === "busy") return fail("busy");
		if (release === "failed") return fail("storage-failed");
		try {
			this.#sweep();
			const read = this.read();
			if (!read.ok) return { ok: false, code: "unreadable", reason: read.reason };
			const draft = clone(read.file);
			const made = change(draft, this.#now(), read.format);
			if (!made.ok) return made;
			if (made.unchanged === true) return { ok: true, value: made.value, file: read.file };
			draft.revision = read.file.revision + 1;
			let checked: EndoDevelopTasksFileV1;
			try {
				checked = validateEndoDevelopTasksFileV1(draft);
			} catch {
				return fail("bad-request");
			}
			let written: EndoDevelopTasksFileV0 | EndoDevelopTasksFileV1 = checked;
			if (read.format === ENDO_DEVELOP_TASKS_SCHEMA_V0 && options.upgrade !== true) {
				// Still v0 on disk: written as v0, which it can be only while it says nothing v0 cannot.
				const asV0 = endoDevelopTasksAsV0(checked);
				if (asV0 === null) return fail("upgrade-required");
				written = asV0;
			}
			if (!this.#replace(written)) return fail("storage-failed");
			return { ok: true, value: made.value, file: checked };
		} finally {
			release();
		}
	}

	// ---- the operations --------------------------------------------------------------------------------------------------------------

	/** Register a project: the operator's explicit act. A second registration of the same directory is refused and names the first. */
	registerProject(input: {
		name: string;
		path: string;
		observedGitRoot: string | null;
	}): EndoTasksResultV0<EndoDevelopProjectV0> {
		const name = checkEndoDevelopTextV0("name", input.name);
		if (!name.ok) return fail("bad-request");
		return this.#mutate((draft, now) => {
			if (draft.projects.length >= ENDO_DEVELOP_TASK_LIMITS_V0.maxProjects) return fail("limit");
			if (draft.projects.some((p) => p.path === input.path)) return fail("duplicate");
			const project: EndoDevelopProjectV0 = {
				id: `endo.project.${hex(16)}`,
				name: name.text,
				path: input.path,
				observedGitRoot: input.observedGitRoot,
				createdAtMs: now,
				updatedAtMs: now,
				revision: 0,
				selectedTaskId: null,
			};
			draft.projects.push(project);
			return { ok: true, value: project };
		});
	}

	createTask(
		projectId: string,
		input: { title: unknown; description?: unknown; acceptance?: unknown },
		options: { select?: boolean } = {},
	): EndoTasksResultV0<EndoDevelopTaskV1> {
		const title = checkEndoDevelopTextV0("title", input.title);
		const description = checkEndoDevelopTextV0("text", input.description ?? "");
		const acceptance = checkEndoDevelopTextV0("text", input.acceptance ?? "");
		if (!title.ok || !description.ok || !acceptance.ok || !ENDO_PROJECT_ID_PATTERN_V0.test(projectId))
			return fail("bad-request");
		return this.#mutate((draft, now) => {
			const project = draft.projects.find((p) => p.id === projectId);
			if (project === undefined) return fail("not-found");
			if (draft.tasks.length >= ENDO_DEVELOP_TASK_LIMITS_V0.maxTasks) return fail("limit");
			const task: EndoDevelopTaskV1 = {
				id: `endo.task.${hex(16)}`,
				projectId,
				title: title.text,
				description: description.text,
				acceptance: acceptance.text,
				status: "open",
				createdAtMs: now,
				updatedAtMs: now,
				revision: 0,
				history: [{ atMs: now, from: null, to: "open", note: null }],
				sessions: [],
			};
			draft.tasks.push(task);
			// Creating and choosing the new task is one operator act and one write.
			if (options.select === true) {
				project.selectedTaskId = task.id;
				project.revision += 1;
				project.updatedAtMs = now;
			}
			return { ok: true, value: task };
		});
	}

	/** Edit the task's words. The status is not editable here: it changes only through `setStatus`. */
	updateTask(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		patch: { title?: unknown; description?: unknown; acceptance?: unknown },
	): EndoTasksResultV0<EndoDevelopTaskV1> {
		const parts: Partial<Record<"title" | "description" | "acceptance", string>> = {};
		for (const [key, rule] of [
			["title", "title"],
			["description", "text"],
			["acceptance", "text"],
		] as const) {
			if (patch[key] === undefined) continue;
			const checked = checkEndoDevelopTextV0(rule, patch[key]);
			if (!checked.ok) return fail("bad-request");
			parts[key] = checked.text;
		}
		if (Object.keys(parts).length === 0 || !Number.isSafeInteger(expectedRevision)) return fail("bad-request");
		return this.#mutate((draft, now) => {
			const task = this.#taskOf(draft, projectId, taskId);
			if (task === null) return fail("not-found");
			if (task.revision !== expectedRevision) return fail("stale-revision");
			Object.assign(task, parts);
			task.revision += 1;
			task.updatedAtMs = now;
			return { ok: true, value: task };
		});
	}

	/** Record a status the OPERATOR chose, with an optional note. The only way a status changes. */
	setStatus(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		to: unknown,
		note: unknown,
	): EndoTasksResultV0<EndoDevelopTaskV1> {
		if (!isEndoDevelopTaskStatusV0(to) || !Number.isSafeInteger(expectedRevision)) return fail("bad-request");
		const checkedNote =
			note === undefined || note === null ? { ok: true as const, text: "" } : checkEndoDevelopTextV0("note", note);
		if (!checkedNote.ok) return fail("bad-request");
		return this.#mutate((draft, now) => {
			const task = this.#taskOf(draft, projectId, taskId);
			if (task === null) return fail("not-found");
			if (task.revision !== expectedRevision) return fail("stale-revision");
			if (!endoDevelopNextStatusesV0(task.status).includes(to as EndoDevelopTaskStatusV0))
				return fail("invalid-transition");
			task.history.push({
				atMs: now,
				from: task.status,
				to: to as EndoDevelopTaskStatusV0,
				note: checkedNote.text === "" ? null : checkedNote.text,
			});
			// The newest entries are kept; the first (creation) is an old fact, not worth more than a recent one.
			while (task.history.length > ENDO_DEVELOP_TASK_LIMITS_V0.maxHistory) task.history.shift();
			task.status = to as EndoDevelopTaskStatusV0;
			task.revision += 1;
			task.updatedAtMs = now;
			return { ok: true, value: task };
		});
	}

	/** Remember which task the operator is working on (null: none). Never touches a task. Choosing what is already chosen writes nothing. */
	selectTask(projectId: string, taskId: string | null): EndoTasksResultV0<EndoDevelopProjectV0> {
		if (taskId !== null && !ENDO_TASK_ID_PATTERN_V0.test(taskId)) return fail("bad-request");
		return this.#mutate((draft, now) => {
			const project = draft.projects.find((p) => p.id === projectId);
			if (project === undefined) return fail("not-found");
			if (taskId !== null && !draft.tasks.some((t) => t.id === taskId && t.projectId === projectId))
				return fail("not-found");
			if (project.selectedTaskId === taskId) return { ok: true, value: project, unchanged: true };
			project.selectedTaskId = taskId;
			project.revision += 1;
			project.updatedAtMs = now;
			return { ok: true, value: project };
		});
	}

	/**
	 * Add the explicit reference. Idempotent per association (`endoDevelopSessionKeyV1`): the same Pi session in the same launch, or the same
	 * OMP session in the same directory scope, is not referenced twice and nothing is written. The caller supplies the reference from a trusted
	 * host's or observer's OWN facts; nothing a page sent becomes part of it. An `omp-saved` reference on a v0 file is `upgrade-required`.
	 */
	linkSession(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		ref:
			| Omit<EndoDevelopPiSessionRefV1, "linkId" | "linkedAtMs">
			| Omit<EndoDevelopOmpSessionRefV1, "linkId" | "linkedAtMs">,
	): EndoTasksResultV0<EndoDevelopTaskV1> {
		if (!Number.isSafeInteger(expectedRevision)) return fail("bad-request");
		const key = endoDevelopSessionKeyV1(ref);
		return this.#mutate((draft, now, format) => {
			const task = this.#taskOf(draft, projectId, taskId);
			if (task === null) return fail("not-found");
			if (task.revision !== expectedRevision) return fail("stale-revision");
			if (task.sessions.some((s) => endoDevelopSessionKeyV1(s) === key))
				return { ok: true, value: task, unchanged: true };
			// Said before anything else is decided, so the operator is told what to do rather than that a limit or a shape was wrong.
			if (ref.source !== "pi-live" && format === ENDO_DEVELOP_TASKS_SCHEMA_V0) return fail("upgrade-required");
			if (task.sessions.length >= ENDO_DEVELOP_TASK_LIMITS_V0.maxSessions) return fail("limit");
			task.sessions.push({ ...ref, linkId: hex(8), linkedAtMs: now } as EndoDevelopTaskV1["sessions"][number]);
			task.revision += 1;
			task.updatedAtMs = now;
			return { ok: true, value: task };
		});
	}

	/**
	 * The operator's explicit upgrade of a v0 file to v1: one locked re-read, the pure v0 → v1 projection, validation, and one atomic replacement.
	 * Task revisions, histories, selections and references are kept exactly; the file revision increases by one, as for every write. A v1 file
	 * (or a missing one) is `unchanged` and nothing is written. `expectedRevision`, when given, is the file revision the operator inspected.
	 */
	upgrade(expectedRevision?: number): EndoTasksResultV0<EndoTasksUpgradeV1> {
		if (expectedRevision !== undefined && !Number.isSafeInteger(expectedRevision)) return fail("bad-request");
		return this.#mutate(
			(draft, _now, format) => {
				if (expectedRevision !== undefined && draft.revision !== expectedRevision) return fail("stale-revision");
				const value: EndoTasksUpgradeV1 = {
					from: format,
					to: ENDO_DEVELOP_TASKS_SCHEMA_V1,
					unchanged: format !== ENDO_DEVELOP_TASKS_SCHEMA_V0,
				};
				return value.unchanged ? { ok: true, value, unchanged: true } : { ok: true, value };
			},
			{ upgrade: true },
		);
	}

	unlinkSession(
		projectId: string,
		taskId: string,
		expectedRevision: number,
		linkId: string,
	): EndoTasksResultV0<EndoDevelopTaskV1> {
		if (!Number.isSafeInteger(expectedRevision) || !ENDO_LINK_ID_PATTERN_V0.test(linkId)) return fail("bad-request");
		return this.#mutate((draft, now) => {
			const task = this.#taskOf(draft, projectId, taskId);
			if (task === null) return fail("not-found");
			if (task.revision !== expectedRevision) return fail("stale-revision");
			const at = task.sessions.findIndex((s) => s.linkId === linkId);
			if (at === -1) return fail("not-found");
			task.sessions.splice(at, 1);
			task.revision += 1;
			task.updatedAtMs = now;
			return { ok: true, value: task };
		});
	}

	#taskOf(draft: EndoDevelopTasksFileV1, projectId: string, taskId: string): EndoDevelopTaskV1 | null {
		return draft.tasks.find((t) => t.id === taskId && t.projectId === projectId) ?? null;
	}
}
