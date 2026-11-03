// The DEVELOP verification-receipts service (docs/designs/develop-verification-receipts.md): the one implementation of "run the operator's
// check against an attempt and record what was observed", and of reading those records back with their relation to a working tree.
//
//   caller: `endo attempt check|receipts|receipt` (the operator's own process), and the workbench's attempts view (read-only)
//   DevelopReceiptsServiceV0
//     |-- DevelopTasksStoreV0       READ only: the attempt's project and its registered path
//     |-- DevelopAttemptsStoreV0    READ only: the attempt must exist
//     |-- DevelopReceiptsStoreV0    write-once receipts under develop/receipts/<attempt>/
//     |-- observe(dir)              injected: the read-only Git revision observer (adapters/git/revision-observer.ts)
//     `-- run(options)              injected: the check runner (adapters/develop/check-runner.ts)
//
// What it guarantees: a check runs only when the operator's argv was given to `check` directly (this module has no other way to obtain
// one, and never reads one from a record); only in a clean, committed working tree of the attempt's own project's repository; and every
// check that was started is recorded as observed, whatever its end, unless the store itself refuses the write (then the caller is told
// and nothing is claimed). It never writes the task file or an attempt record, and never changes a status.

import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { CheckRunOptionsV0, CheckRunResultV0 } from "../../adapters/develop/check-runner.ts";
import type {
	EndoRevisionDirtyV0,
	EndoRevisionObservationV0,
	EndoRevisionObservedV0,
	EndoRevisionUnavailableV0,
} from "../../adapters/git/revision-observer.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../../protocol/develop-attempts.ts";
import {
	checkEndoReceiptArgvV0,
	ENDO_DEVELOP_RECEIPT_LIMITS_V0,
	ENDO_DEVELOP_RECEIPT_SCHEMA_V0,
	ENDO_RECEIPT_ID_PATTERN_V0,
	type EndoDevelopReceiptV0,
	type EndoReceiptCurrentV0,
	type EndoReceiptRelationV0,
	endoReceiptRelationV0,
	endoReceiptVerdictV0,
	validateEndoDevelopReceiptV0,
} from "../../protocol/develop-receipts.ts";
import type { EndoDevelopUnreadableReasonV0 } from "../../protocol/develop-tasks.ts";
import type { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0, type EndoReceiptProblemV0 } from "../../storage/develop-receipts.ts";
import type { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";

/**
 * Why a check was refused BEFORE anything ran. Nothing was run and nothing was recorded for any of them.
 * - `bad-request`: the argv or the time limit was not acceptable, or an id was malformed.
 * - `not-found`: no such attempt, or its project is not in the task file.
 * - `tasks-unreadable`: the task file cannot be read, so the attempt's project cannot be checked.
 * - `unreadable`: the attempts or the receipts directory is not usable.
 * - `limit`: the attempt already has as many receipts as it may.
 * - `unsupported-platform`: process groups are needed (POSIX).
 * - `executable-not-found`: no executable file by that name (a PATH entry that is relative, empty or inside the working tree is skipped).
 * - `repository`: the directory could not be observed as the top of a working tree (`reason`).
 * - `project-repository`: the project's registered path is not in a Git repository (`reason`).
 * - `other-repository`: the directory is a working tree of a different repository from the project's.
 * - `not-clean`: the tree is not a clean, committed state (`dirty` says what).
 * - `unrecordable`: a receipt for this check could not be recorded, whatever its end: it would not fit its bound, or a recorded value (a
 *   path, the branch name) is not one a receipt can hold. Refused now rather than after the check has run.
 */
export type DevelopCheckRefusalV0 =
	| "bad-request"
	| "not-found"
	| "tasks-unreadable"
	| "unreadable"
	| "limit"
	| "unsupported-platform"
	| "executable-not-found"
	| "repository"
	| "project-repository"
	| "other-repository"
	| "not-clean"
	| "unrecordable";

export type DevelopCheckPlanResultV0 =
	| { ok: true; plan: DevelopCheckPlanV0 }
	| {
			ok: false;
			code: DevelopCheckRefusalV0;
			reason?: EndoRevisionUnavailableV0 | EndoDevelopUnreadableReasonV0 | "unsafe-path" | "io";
			dirty?: EndoRevisionDirtyV0[];
	  };

/** A check that may run: everything decided and observed before the process starts. Opaque to callers but for what they show. */
export interface DevelopCheckPlanV0 {
	readonly attemptId: string;
	readonly projectId: string;
	readonly argv: readonly string[];
	readonly executable: string;
	readonly realExecutable: string;
	readonly timeoutMs: number;
	readonly before: EndoRevisionObservationV0;
}

export interface DevelopCheckDoneV0 {
	receipt: EndoDevelopReceiptV0;
	/** `created`: recorded. Otherwise the check ran but its receipt could not be written (nothing was recorded). */
	written: "created" | "unsafe-path" | "failed";
}

export interface DevelopReceiptReportV0 {
	receipt: EndoDevelopReceiptV0;
	relation: EndoReceiptRelationV0;
}

export type DevelopReceiptsReadResultV0 =
	| { ok: true; receipts: DevelopReceiptReportV0[]; problems: EndoReceiptProblemV0[] }
	| { ok: false; code: "bad-request" | "not-found" | "unreadable"; reason?: "unsafe-path" | "io" };

export interface DevelopReceiptsServiceOptionsV0 {
	observe: (directory: string, options?: { within?: boolean }) => Promise<EndoRevisionObservedV0>;
	run: (options: CheckRunOptionsV0) => Promise<CheckRunResultV0>;
	/** Endophasia's version, recorded as the observer's. */
	version: string;
	now?: () => number;
	/** For tests. Default: this process's. */
	platform?: NodeJS.Platform;
}

/**
 * Variables of the operator's environment that would point the check's own Git at a different repository, index or configuration from
 * the one observed. They are removed from the check's environment; everything else is inherited unchanged (and not recorded).
 */
export const ENDO_CHECK_REMOVED_ENV_V0 = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
] as const;

export function endoCheckEnvironmentV0(env: NodeJS.ProcessEnv): Record<string, string> {
	const removed = new Set<string>(ENDO_CHECK_REMOVED_ENV_V0);
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || removed.has(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue;
		out[key] = value;
	}
	return out;
}

const insideOf = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * The executable a check spawns. A name with a `/` is taken relative to the working tree; a bare name is looked up along PATH, skipping
 * entries that are empty, relative, or inside the working tree (each would let a repository file shadow the operator's tool). Links are
 * NOT followed for the path that is spawned (a multi-call tool such as `cargo` under rustup chooses its job by the name it was run as);
 * the real path is recorded beside it.
 */
export function resolveEndoCheckExecutableV0(
	name: string,
	worktree: string,
	path: string | undefined,
): { executable: string; realExecutable: string } | null {
	const usable = (candidate: string): { executable: string; realExecutable: string } | null => {
		try {
			if (!statSync(candidate).isFile()) return null;
			accessSync(candidate, fsConstants.X_OK);
			return { executable: candidate, realExecutable: realpathSync(candidate) };
		} catch {
			return null;
		}
	};
	if (name.includes("/")) return usable(isAbsolute(name) ? name : resolve(worktree, name));
	for (const entry of (path ?? "").split(delimiter)) {
		if (entry === "" || !isAbsolute(entry)) continue;
		let real: string;
		try {
			real = realpathSync(entry);
		} catch {
			continue;
		}
		if (insideOf(worktree, resolve(entry)) || insideOf(worktree, real)) continue;
		const found = usable(join(entry, name));
		if (found !== null) return found;
	}
	return null;
}

const refuse = (
	code: DevelopCheckRefusalV0,
	extra: {
		reason?: EndoRevisionUnavailableV0 | EndoDevelopUnreadableReasonV0 | "unsafe-path" | "io";
		dirty?: EndoRevisionDirtyV0[];
	} = {},
): DevelopCheckPlanResultV0 => ({ ok: false, code, ...extra });

export class DevelopReceiptsServiceV0 {
	readonly #tasks: DevelopTasksStoreV0;
	readonly #attempts: DevelopAttemptsStoreV0;
	readonly #receipts: DevelopReceiptsStoreV0;
	readonly #o: DevelopReceiptsServiceOptionsV0;
	readonly #now: () => number;

	constructor(
		tasks: DevelopTasksStoreV0,
		attempts: DevelopAttemptsStoreV0,
		receipts: DevelopReceiptsStoreV0,
		options: DevelopReceiptsServiceOptionsV0,
	) {
		this.#tasks = tasks;
		this.#attempts = attempts;
		this.#receipts = receipts;
		this.#o = options;
		this.#now = options.now ?? Date.now;
	}

	/** The attempt's project, from the task file now (read only). */
	#project(attemptId: string):
		| { ok: true; projectId: string; path: string }
		| {
				ok: false;
				code: "not-found" | "unreadable" | "tasks-unreadable";
				reason?: EndoDevelopUnreadableReasonV0 | "unsafe-path" | "io";
		  } {
		const attempts = this.#attempts.read();
		if (!attempts.ok) return { ok: false, code: "unreadable", reason: attempts.reason };
		const entry = attempts.entries.find((e) => e.attempt.id === attemptId);
		if (entry === undefined) return { ok: false, code: "not-found" };
		const tasks = this.#tasks.read();
		if (!tasks.ok) return { ok: false, code: "tasks-unreadable", reason: tasks.reason };
		const project = tasks.file.projects.find((p) => p.id === entry.attempt.projectId);
		if (project === undefined) return { ok: false, code: "not-found" };
		return { ok: true, projectId: project.id, path: project.path };
	}

	/**
	 * Everything that is decided before a check runs: the attempt, the directory (default: the project's registered path), the
	 * executable, and the first observation, which must be clean and committed. Nothing runs and nothing is written here.
	 */
	async plan(
		attemptId: string,
		input: { argv: unknown; cwd?: string; timeoutMs?: number },
	): Promise<DevelopCheckPlanResultV0> {
		if ((this.#o.platform ?? process.platform) === "win32") return refuse("unsupported-platform");
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId) || !checkEndoReceiptArgvV0(input.argv))
			return refuse("bad-request");
		const argv = [...input.argv];
		const timeoutMs = input.timeoutMs ?? ENDO_DEVELOP_RECEIPT_LIMITS_V0.defaultTimeoutMs;
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < ENDO_DEVELOP_RECEIPT_LIMITS_V0.minTimeoutMs ||
			timeoutMs > ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxTimeoutMs
		)
			return refuse("bad-request");
		const project = this.#project(attemptId);
		if (!project.ok) return refuse(project.code, project.reason === undefined ? {} : { reason: project.reason });
		const existing = this.#receipts.read(attemptId);
		if (!existing.ok) return refuse("unreadable", { reason: existing.reason });
		if (existing.receipts.length + existing.problems.length >= ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxPerAttempt)
			return refuse("limit");

		const seen = await this.#o.observe(input.cwd ?? project.path);
		if (!seen.ok) return refuse("repository", { reason: seen.reason });
		const before = seen.observation;
		// The directory must be a working tree of the attempt's own project's repository (its main tree or a linked one).
		const home = await this.#o.observe(project.path, { within: true });
		if (!home.ok) return refuse("project-repository", { reason: home.reason });
		if (home.observation.commonDir !== before.commonDir) return refuse("other-repository");
		if (before.dirty.length > 0) return refuse("not-clean", { dirty: before.dirty });

		const resolved = resolveEndoCheckExecutableV0(argv[0] as string, before.worktree, process.env.PATH);
		if (resolved === null) return refuse("executable-not-found");
		const plan: DevelopCheckPlanV0 = {
			attemptId,
			projectId: project.projectId,
			argv,
			executable: resolved.executable,
			realExecutable: resolved.realExecutable,
			timeoutMs,
			before,
		};
		// The receipt must be able to hold this check, whatever its end: refused now, before anything runs, if it could not.
		const largest = this.#receipt(
			plan,
			{
				execution: { kind: "signaled", signal: "SIGXXXXXXXXXXXX" },
				output: { stdoutBytes: Number.MAX_SAFE_INTEGER, stderrBytes: Number.MAX_SAFE_INTEGER },
				strayProcesses: true,
				escapedProcess: true,
				durationMs: Number.MAX_SAFE_INTEGER,
			},
			{ ok: true, observation: before },
			8.64e15,
			8.64e15,
		);
		try {
			validateEndoDevelopReceiptV0(largest);
		} catch {
			return refuse("unrecordable");
		}
		if (DevelopReceiptsStoreV0.encode(largest) === null) return refuse("unrecordable");
		return { ok: true, plan };
	}

	/**
	 * Run a planned check, observe the tree again, and record the receipt. The check's output goes to `io`'s sinks as it comes. Interrupted
	 * through `io.interrupt`, it is stopped and recorded as interrupted.
	 */
	async run(
		plan: DevelopCheckPlanV0,
		io: Pick<CheckRunOptionsV0, "stdout" | "stderr" | "interrupt" | "hurry" | "graceMs" | "pipeWaitMs">,
	): Promise<DevelopCheckDoneV0> {
		const startedAtMs = this.#now();
		const result = await this.#o.run({
			executable: plan.executable,
			args: plan.argv.slice(1),
			cwd: plan.before.worktree,
			env: endoCheckEnvironmentV0(process.env),
			timeoutMs: plan.timeoutMs,
			maxOutputBytes: ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxOutputBytes,
			...io,
		});
		const endedAtMs = Math.max(startedAtMs, this.#now());
		const afterSeen = await this.#o.observe(plan.before.worktree);
		const receipt = this.#receipt(plan, result, afterSeen, startedAtMs, endedAtMs);
		return { receipt, written: this.#receipts.write(receipt) };
	}

	#receipt(
		plan: DevelopCheckPlanV0,
		result: CheckRunResultV0,
		afterSeen: EndoRevisionObservedV0,
		startedAtMs: number,
		endedAtMs: number,
	): EndoDevelopReceiptV0 {
		const b = plan.before;
		const a = afterSeen.ok ? afterSeen.observation : null;
		const facts = {
			repository: { worktree: b.worktree, commonDir: b.commonDir, linked: b.linked },
			revision: { commit: b.commit, tree: b.tree, branch: b.branch },
			// Compared only when every reflog that could have logged a movement was there to compare.
			reflog:
				b.reflogs.head === null || (b.branch !== null && b.reflogs.branch === null)
					? ("unavailable" as const)
					: ("compared" as const),
			check: {
				argv: [...plan.argv],
				executable: plan.executable,
				realExecutable: plan.realExecutable,
				timeoutMs: plan.timeoutMs,
			},
			execution: result.execution,
			strayProcesses: result.strayProcesses,
			escapedProcess: result.escapedProcess,
			after:
				a === null
					? { state: "unavailable" as const }
					: {
							state: "observed" as const,
							sameRepository: a.worktree === b.worktree && a.commonDir === b.commonDir,
							commit: a.commit,
							tree: a.tree,
							clean: a.dirty.length === 0,
							reflogsUnchanged:
								a.branch === b.branch &&
								a.reflogs.head === b.reflogs.head &&
								a.reflogs.branch === b.reflogs.branch,
							rulesUnchanged: a.rules === b.rules,
						},
		};
		return {
			schemaVersion: ENDO_DEVELOP_RECEIPT_SCHEMA_V0,
			id: `endo.receipt.${randomBytes(16).toString("hex")}`,
			attemptId: plan.attemptId,
			projectId: plan.projectId,
			requestedBy: "operator",
			via: "cli",
			observer: { tool: "endo", version: this.#o.version },
			startedAtMs,
			endedAtMs,
			durationMs: result.durationMs,
			...facts,
			output: result.output,
			...endoReceiptVerdictV0(facts),
		};
	}

	// ---- reading -------------------------------------------------------------------------------------------------------------------

	/** The working tree a reader compares receipts with, observed now; null when it cannot be. */
	async current(directory: string): Promise<EndoReceiptCurrentV0 | null> {
		const seen = await this.#o.observe(directory, { within: true });
		if (!seen.ok) return null;
		const o = seen.observation;
		return { worktree: o.worktree, commonDir: o.commonDir, commit: o.commit, clean: o.dirty.length === 0 };
	}

	/** The directory a reader compares with by default: the attempt's project's registered path. */
	defaultDirectory(attemptId: string): string | null {
		const project = this.#project(attemptId);
		return project.ok ? project.path : null;
	}

	/** One attempt's receipts, oldest first, each related to `current` (a working tree the reader chose). */
	list(attemptId: string, current: EndoReceiptCurrentV0 | null): DevelopReceiptsReadResultV0 {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return { ok: false, code: "bad-request" };
		const attempts = this.#attempts.read();
		if (!attempts.ok) return { ok: false, code: "unreadable", reason: attempts.reason };
		if (!attempts.entries.some((e) => e.attempt.id === attemptId)) return { ok: false, code: "not-found" };
		const read = this.#receipts.read(attemptId);
		if (!read.ok) return { ok: false, code: "unreadable", reason: read.reason };
		return {
			ok: true,
			receipts: read.receipts.map((receipt) => ({ receipt, relation: endoReceiptRelationV0(receipt, current) })),
			problems: read.problems,
		};
	}

	/** One receipt by id, looked up among the attempts' receipt directories. */
	find(receiptId: string): { attemptId: string } | null {
		if (!ENDO_RECEIPT_ID_PATTERN_V0.test(receiptId)) return null;
		const attempts = this.#attempts.read();
		if (!attempts.ok) return null;
		for (const entry of attempts.entries) {
			const read = this.#receipts.read(entry.attempt.id);
			if (read.ok && read.receipts.some((r) => r.id === receiptId)) return { attemptId: entry.attempt.id };
		}
		return null;
	}
}
