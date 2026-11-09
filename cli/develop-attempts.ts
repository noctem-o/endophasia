/**
 * `endo attempt prepare|brief|handoff|report|abandon|list|show|check|receipts|receipt|evidence`: the operator's work attempts on a task (docs/designs/develop-work-attempts.md),
 * kept in the store root's `develop/attempts/` as write-once records (storage/develop-attempts.ts).
 *
 * An attempt is one request the operator prepared on one task. `brief` prints it as plain text for the operator to copy into any coding
 * agent; nothing here sends it anywhere, runs an agent, or reads an agent's reply. `handoff`, `report` and `abandon` record the operator's
 * own statements, once each: that they handed it over, what was reported (never verified here), or that they stopped. None of them changes
 * the task: its status moves only by `endo task status` or the workbench's buttons. The task file is read, never written.
 *
 * `check` is the one command that runs anything (docs/designs/develop-verification-receipts.md): the executable and arguments the operator
 * typed after `--`, nothing else, never from a record. It records what Endophasia observed as a receipt (develop/receipts/), which is
 * neither the task's acceptance nor a change of anything's status. `receipts` and `receipt` read receipts back, each compared with the HEAD
 * of a working tree the operator chose.
 *
 * These commands are a translation of flags and refusals around the shared services (runtime/contracts/develop-attempts.ts and
 * develop-receipts.ts).
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { runCheckV0 } from "../adapters/develop/check-runner.ts";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { ENDO_ATTEMPT_RUN_LABELS_V0, ENDO_ATTEMPT_SEND_LABELS_V0 } from "../protocol/develop-attempt-execution.ts";
import { ENDO_DEVELOP_ATTEMPT_LABELS_V0, ENDO_DEVELOP_ATTEMPT_LIMITS_V0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_RECEIPT_LIMITS_V0,
	ENDO_RECEIPT_LIMITATION_TEXT_V0,
	ENDO_RECEIPT_OUTCOME_LABELS_V0,
	ENDO_RECEIPT_REASON_TEXT_V0,
	ENDO_RECEIPT_RELATION_LABELS_V0,
	type EndoDevelopReceiptV0,
	type EndoReceiptRelationV0,
	endoReceiptRelationV0,
} from "../protocol/develop-receipts.ts";
import { validateEndoVerificationPlanV0 } from "../protocol/develop-verification.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoAttemptEvidenceV0, renderEndoAttemptEvidenceV0 } from "../runtime/contracts/develop-attempt-evidence.ts";
import {
	type DevelopAttemptReportV0,
	type DevelopAttemptsRefusalV0,
	type DevelopAttemptsResultV0,
	DevelopAttemptsServiceV0,
} from "../runtime/contracts/develop-attempts.ts";
import {
	type DevelopCheckRefusalV0,
	type DevelopReceiptsReadResultV0,
	DevelopReceiptsServiceV0,
} from "../runtime/contracts/develop-receipts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { endoSessionLogV0 } from "./develop-service.ts";
import { flagsOf } from "./develop-tasks.ts";
import { endoVersionV0 } from "./help.ts";

const USAGE =
	"usage: endo attempt prepare [<root> | --root dir] --project <id> --task <id> (--objective <text> | --objective-file <path>) [--constraints <text> | --constraints-file <path>] [--report-back <text> | --report-back-file <path>] [--plan-file <path>] | endo attempt brief ... --attempt <id> | endo attempt handoff ... --attempt <id> --to <label> [--note <n>] | endo attempt report ... --attempt <id> --note <what was reported> | endo attempt abandon ... --attempt <id> [--note <n>] | endo attempt list ... --project <id> [--task <id>] | endo attempt show ... --attempt <id> | endo attempt check ... --attempt <id> [--cwd <dir>] [--timeout <seconds>] -- <executable> [args...] | endo attempt receipts ... --attempt <id> [--cwd <dir>] | endo attempt receipt ... --receipt <id> [--cwd <dir>] | endo attempt evidence ... --attempt <id> [--cwd <dir>]";

const REFUSALS: Readonly<Record<DevelopAttemptsRefusalV0, string>> = {
	"not-found": "no such project, task (in that project) or attempt in this store",
	"bad-request":
		"the input was not acceptable (a blank objective or report, a value too long, control characters, or a malformed id)",
	limit: `that store already holds ${ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxAttempts} attempts, or that task ${ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxPerTask}; remove attempts you no longer need by deleting their files (develop/attempts/<id>.*)`,
	"already-recorded": "that was already recorded for this attempt, and it was left as it is (endo attempt show)",
	"tasks-unreadable": "the task file cannot be used, so no attempt can be prepared on it; it was not changed",
	unreadable: "the attempts directory, or a file at that record's name, cannot be used; nothing was changed",
	"storage-failed": "the record could not be written; nothing was recorded, try again",
};

function unwrap<T>(result: DevelopAttemptsResultV0<T>): T {
	if (result.ok) return result.value;
	const why = result.reason === undefined ? "" : ` (${result.reason})`;
	throw new Error(`${REFUSALS[result.code] ?? result.code}${why}`);
}

const serviceAt = (root: string) =>
	new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root), {
		sessionLog: () => endoSessionLogV0(root),
	});

const print = (value: unknown): void => {
	process.stdout.write(`${canonicalEndoJsonV0(value as never)}\n`);
};

/** A `--*-file` value: a regular file (not a link, not a device), read whole, at most 16 KiB, UTF-8. Its text is used exactly. */
function readInputFile(flag: string, path: string): string {
	const limit = ENDO_DEVELOP_ATTEMPT_LIMITS_V0.maxInputFileBytes;
	let entry: ReturnType<typeof lstatSync>;
	try {
		entry = lstatSync(path);
	} catch {
		throw new TypeError(`${flag}: no such file`);
	}
	if (!entry.isFile()) throw new TypeError(`${flag} must name a regular file (not a link, a directory or a device)`);
	if (entry.size > limit) throw new TypeError(`${flag}: the file is larger than ${limit} bytes`);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.size > limit)
			throw new TypeError(`${flag} must name a regular file of at most ${limit} bytes`);
		const bytes = Buffer.alloc(opened.size);
		let at = 0;
		while (at < bytes.length) {
			const n = readSync(fd, bytes, at, bytes.length - at, at);
			if (n === 0) break;
			at += n;
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, at));
		} catch {
			throw new TypeError(`${flag}: the file is not UTF-8 text`);
		}
	} finally {
		closeSync(fd);
	}
}

/** `--name <text>` or `--name-file <path>`, not both. */
function textOf(flags: Map<string, string>, name: string): string | undefined {
	const inline = flags.get(`--${name}`);
	const file = flags.get(`--${name}-file`);
	if (inline !== undefined && file !== undefined) throw new TypeError(`give --${name} or --${name}-file, not both`);
	return file === undefined ? inline : readInputFile(`--${name}-file`, file);
}

/** One attempt in a list: enough to choose one, and its state in the words it is shown with everywhere. */
const summary = (r: DevelopAttemptReportV0) => ({
	id: r.attempt.id,
	taskId: r.attempt.taskId,
	state: r.state,
	label: ENDO_DEVELOP_ATTEMPT_LABELS_V0[r.state],
	preparedAtMs: r.attempt.preparedAtMs,
	objective: r.attempt.objective.split("\n", 1)[0] ?? "",
	target: r.handoff?.target ?? null,
	task: r.task,
	taskWordsChanged: r.taskWordsChanged,
	// Each later record: recorded, absent, or damaged (a file at its name that is not usable; never the same as absent).
	records: r.records,
	// Sent to Pi through the workbench? What the session's own records say, in the words shown everywhere. Never a verdict on the work.
	execution:
		r.execution === null
			? null
			: {
					send: r.execution.send,
					sendLabel: ENDO_ATTEMPT_SEND_LABELS_V0[r.execution.send],
					run: r.execution.run,
					runLabel: ENDO_ATTEMPT_RUN_LABELS_V0[r.execution.run],
				},
});

const shown = (r: DevelopAttemptReportV0) => ({
	...summary(r),
	attempt: r.attempt,
	handoff: r.handoff,
	outcome: r.outcome,
	// The authorisation record as written (ids to look up in the session's log), and the full reading of that log.
	authorized: r.authorized,
	// Whether each later record is recorded, absent, or damaged (a file at its name that is not usable: not the same as absent).
	records: r.records,
	damaged: r.damaged,
	unattributedWorkbenchSends: r.unattributedWorkbenchSends,
	execution:
		r.execution === null
			? null
			: {
					...r.execution,
					sendLabel: ENDO_ATTEMPT_SEND_LABELS_V0[r.execution.send],
					runLabel: ENDO_ATTEMPT_RUN_LABELS_V0[r.execution.run],
				},
});

function attemptOf(flags: Map<string, string>): string {
	const id = flags.get("--attempt");
	if (id === undefined) throw new TypeError(USAGE);
	return id;
}

function prepare(argv: readonly string[]): void {
	const { root, flags } = flagsOf(
		argv,
		[
			"--project",
			"--task",
			"--objective",
			"--objective-file",
			"--constraints",
			"--constraints-file",
			"--report-back",
			"--report-back-file",
			"--plan-file",
		],
		USAGE,
	);
	const project = flags.get("--project");
	const task = flags.get("--task");
	const objective = textOf(flags, "objective");
	if (project === undefined || task === undefined || objective === undefined) throw new TypeError(USAGE);
	// A verification plan (docs/designs/develop-verification-plans.md): JSON the operator wrote, checked whole by the plan's validator.
	const planFile = flags.get("--plan-file");
	let verification: unknown;
	if (planFile !== undefined) {
		try {
			verification = JSON.parse(readInputFile("--plan-file", planFile));
		} catch (error) {
			if (error instanceof SyntaxError) throw new TypeError("--plan-file: the file is not JSON");
			throw error;
		}
		try {
			validateEndoVerificationPlanV0(verification);
		} catch (error) {
			throw new TypeError(`--plan-file: ${error instanceof Error ? error.message : "not a verification plan"}`);
		}
	}
	const service = serviceAt(root);
	const attempt = unwrap(
		service.prepare(project, task, {
			objective,
			constraints: textOf(flags, "constraints"),
			reportBack: textOf(flags, "report-back"),
			...(verification === undefined ? {} : { verification }),
		}),
	);
	print({ attempt: shown(unwrap(service.get(attempt.id))) });
	process.stderr.write(
		`prepared. Nothing was sent to any agent. Print the brief to copy with: endo attempt brief --root ${root} --attempt ${attempt.id}\n`,
	);
}

function brief(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--attempt"], USAGE);
	// The brief alone on stdout, exactly as rendered, so it can be piped to a clipboard tool.
	process.stdout.write(unwrap(serviceAt(root).brief(attemptOf(flags))));
}

function handoff(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--attempt", "--to", "--note"], USAGE);
	const to = flags.get("--to");
	if (to === undefined) throw new TypeError(USAGE);
	const done = unwrap(serviceAt(root).handoff(attemptOf(flags), { target: to, note: flags.get("--note") }));
	print({ attempt: summary(done) });
	process.stderr.write(
		"recorded: you said you handed this brief over. That is your statement; it does not show the agent read or followed it.\n",
	);
}

function report(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--attempt", "--note", "--note-file"], USAGE);
	const note = textOf(flags, "note");
	if (note === undefined) throw new TypeError("endo attempt report needs --note <what was reported> (or --note-file)");
	const done = unwrap(serviceAt(root).report(attemptOf(flags), note));
	print({ attempt: summary(done) });
	process.stderr.write(
		"recorded as reported, not verified. The task's status is unchanged: change it yourself with endo task status when you have checked the work.\n",
	);
}

function abandon(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--attempt", "--note"], USAGE);
	const done = unwrap(serviceAt(root).abandon(attemptOf(flags), flags.get("--note")));
	print({ attempt: summary(done) });
	process.stderr.write("recorded as abandoned. The task's status is unchanged.\n");
}

function list(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--project", "--task"], USAGE);
	const project = flags.get("--project");
	if (project === undefined) throw new TypeError(USAGE);
	const found = unwrap(serviceAt(root).list(project, flags.get("--task")));
	print({ attempts: found.attempts.map(summary), problems: found.problems });
}

function show(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--attempt"], USAGE);
	const report = unwrap(serviceAt(root).get(attemptOf(flags)));
	print({ attempt: shown(report) });
	for (const kind of ["handoff", "outcome"] as const)
		if (report.records[kind] === "damaged")
			process.stderr.write(
				`${kind}: unknown. A file at this attempt's ${kind} record's name is not a usable record; what the operator recorded there cannot be read. The file was left as found.\n`,
			);
	if (report.records.authorized === "damaged")
		process.stderr.write(
			"execution: unknown. A file at this attempt's authorisation record's name is not a usable record, so whether a send was authorised cannot be read; nothing in the session log is attributed to it. The file was left as found.\n",
		);
	if (report.execution !== null)
		process.stderr.write(
			`execution: ${ENDO_ATTEMPT_SEND_LABELS_V0[report.execution.send]}. ${ENDO_ATTEMPT_RUN_LABELS_V0[report.execution.run]}. This is what the session recorded, read now${report.execution.evidence === "partial" ? " (part of the session log could not be read, so later records may be missing)" : ""}; it is not verification. Check the work with \`endo attempt check\`, and set the task's status yourself.\n`,
		);
}

// ---- verification receipts ------------------------------------------------------------------------------------------------------------

const receiptsAt = (root: string) => {
	const observer = new GitRevisionObserverV0();
	return new DevelopReceiptsServiceV0(
		new DevelopTasksStoreV0(root),
		new DevelopAttemptsStoreV0(root),
		new DevelopReceiptsStoreV0(root),
		{
			observe: (directory, options) => observer.observe(directory, options),
			run: runCheckV0,
			version: endoVersionV0(),
		},
	);
};

const CHECK_REFUSALS: Readonly<Record<DevelopCheckRefusalV0, string>> = {
	"bad-request": `the check was not acceptable: give the executable and its arguments after --, at most ${ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxArgs} of them, and a --timeout of 1 to ${ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxTimeoutMs / 1000} seconds`,
	"not-found": "no such attempt in this store, or its project is not in the task file",
	"tasks-unreadable": "the task file cannot be used, so the attempt's project cannot be found; it was not changed",
	unreadable: "the attempts or receipts directory cannot be used; nothing was changed",
	limit: `that attempt already has ${ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxPerAttempt} receipts; remove ones you no longer need by deleting their files (develop/receipts/<attempt>/)`,
	"unsupported-platform": "checks need process groups, which this platform does not have",
	"executable-not-found":
		"no executable file by that name (PATH entries that are empty, relative or inside the working tree are skipped; give a path to use one there)",
	repository: "that directory cannot be observed as the top of a Git working tree",
	"project-repository": "the attempt's project's registered path is not in a Git repository",
	"other-repository": "that directory is a working tree of a different repository from the attempt's project",
	"not-clean":
		"the working tree is not a clean, committed state; commit or remove the changes (checks are only recorded against a commit)",
	unrecordable:
		"a receipt for this check could not be recorded (an argument list, a path or the branch name is too long, or not plain text)",
};

const RISK =
	"endo attempt check: this runs the command below with your permissions and your environment. Whatever it invokes from the repository (package.json scripts, test files, a Makefile) is the repository's code, which an agent may have written: running a repository's tests is running that repository. Endophasia cannot tell whether anything else (an agent still working, an editor) writes the tree while it runs; stop them first.";

const receiptSummary = (receipt: EndoDevelopReceiptV0, relation: EndoReceiptRelationV0) => ({
	id: receipt.id,
	attemptId: receipt.attemptId,
	startedAtMs: receipt.startedAtMs,
	argv: receipt.check.argv,
	commit: receipt.revision.commit,
	branch: receipt.revision.branch,
	execution: receipt.execution,
	outcome: receipt.outcome,
	label: ENDO_RECEIPT_OUTCOME_LABELS_V0[receipt.outcome],
	reasons: receipt.reasons.map((r) => ENDO_RECEIPT_REASON_TEXT_V0[r]),
	relation,
	relationLabel: ENDO_RECEIPT_RELATION_LABELS_V0[relation],
});

const receiptShown = (receipt: EndoDevelopReceiptV0, relation: EndoReceiptRelationV0) => ({
	...receiptSummary(receipt, relation),
	limitations: receipt.limitations.map((l) => ENDO_RECEIPT_LIMITATION_TEXT_V0[l]),
	receipt,
});

/** Exit codes of `check`: what was observed, or that nothing ran. */
export const ENDO_CHECK_EXIT_CODES_V0 = Object.freeze({
	passed: 0,
	refused: 2,
	failed: 3,
	inconclusive: 4,
	notRecorded: 5,
	interrupted: 130,
});

async function check(argv: readonly string[]): Promise<void> {
	const split = argv.indexOf("--");
	if (split === -1) throw new TypeError(`endo attempt check needs the command after --\n${USAGE}`);
	const command = argv.slice(split + 1);
	if (command.length === 0) throw new TypeError(`endo attempt check needs an executable after --\n${USAGE}`);
	const { root, flags } = flagsOf(argv.slice(0, split), ["--attempt", "--cwd", "--timeout"], USAGE);
	const timeout = flags.get("--timeout");
	if (timeout !== undefined && !/^[1-9][0-9]{0,5}$/.test(timeout))
		throw new TypeError("--timeout takes whole seconds");
	const service = receiptsAt(root);
	const cwd = flags.get("--cwd");
	const planned = await service.plan(attemptOf(flags), {
		argv: command,
		...(cwd === undefined ? {} : { cwd }),
		...(timeout === undefined ? {} : { timeoutMs: Number(timeout) * 1000 }),
	});
	if (!planned.ok) {
		const why = [planned.reason, ...(planned.dirty ?? [])].filter((x) => x !== undefined).join(", ");
		process.stderr.write(
			`${CHECK_REFUSALS[planned.code]}${why === "" ? "" : ` (${why})`}. Nothing was run and nothing was recorded.\n`,
		);
		process.exitCode = ENDO_CHECK_EXIT_CODES_V0.refused;
		return;
	}
	const plan = planned.plan;
	process.stderr.write(
		`${RISK}\n  command:   ${JSON.stringify(plan.argv)}\n  spawned:   ${plan.executable}${plan.realExecutable === plan.executable ? "" : ` (${plan.realExecutable})`}\n  in:        ${plan.before.worktree}\n  at:        ${plan.before.commit} (tree ${plan.before.tree})\n  time limit ${plan.timeoutMs / 1000} s\n--- the check's own output follows ---\n`,
	);
	// The check's output goes to this process's stderr. If that goes away (the terminal closed, a pipe reader exited), writing to it fails:
	// the failure must not end this process before the receipt is written.
	process.stderr.on("error", () => {});
	process.stdout.on("error", () => {});
	const interrupt = new AbortController();
	const hurry = new AbortController();
	let interrupted = false;
	const onSignal = (): void => {
		if (interrupted) hurry.abort();
		interrupted = true;
		interrupt.abort();
	};
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	for (const signal of signals) process.on(signal, onSignal);
	let done: Awaited<ReturnType<typeof service.run>>;
	try {
		done = await service.run(plan, {
			stdout: process.stderr,
			stderr: process.stderr,
			interrupt: interrupt.signal,
			hurry: hurry.signal,
		});
	} finally {
		for (const signal of signals) process.off(signal, onSignal);
	}
	const { receipt, written } = done;
	process.stderr.write("--- end of the check's output ---\n");
	if (written !== "created") {
		process.stderr.write(
			`the check ran, but its receipt could not be written (${written}); NOTHING WAS RECORDED. What was observed: ${ENDO_RECEIPT_OUTCOME_LABELS_V0[receipt.outcome]}, ${JSON.stringify(receipt.execution)}.\n`,
		);
		process.exitCode = ENDO_CHECK_EXIT_CODES_V0.notRecorded;
		return;
	}
	// Its relation to the tree as it is now, observed again (the same working tree): never assumed.
	const now = await service.current(plan.before.worktree);
	print({ receipt: receiptShown(receipt, endoReceiptRelationV0(receipt, now)) });
	process.stderr.write(
		`recorded: ${ENDO_RECEIPT_OUTCOME_LABELS_V0[receipt.outcome]}${receipt.reasons.length === 0 ? "" : ` (${receipt.reasons.map((r) => ENDO_RECEIPT_REASON_TEXT_V0[r]).join("; ")})`}, at ${receipt.revision.commit}. This is what Endophasia observed of that command in that working tree; it is not acceptance of the task, whose status is unchanged.\n`,
	);
	// 130 only when the check itself was stopped by the interruption: a signal after it ended does not change what was recorded.
	process.exitCode =
		receipt.execution.kind === "interrupted"
			? ENDO_CHECK_EXIT_CODES_V0.interrupted
			: receipt.outcome === "passed"
				? ENDO_CHECK_EXIT_CODES_V0.passed
				: receipt.outcome === "failed"
					? ENDO_CHECK_EXIT_CODES_V0.failed
					: ENDO_CHECK_EXIT_CODES_V0.inconclusive;
}

const READ_REFUSALS: Readonly<Record<Exclude<DevelopReceiptsReadResultV0, { ok: true }>["code"], string>> = {
	"bad-request": "a malformed id",
	"not-found": "no such attempt or receipt in this store",
	unreadable: "the attempts or receipts directory cannot be used; nothing was changed",
};

async function readReceipts(
	service: DevelopReceiptsServiceV0,
	attemptId: string,
	cwd: string | undefined,
): Promise<{ directory: string | null; read: Extract<DevelopReceiptsReadResultV0, { ok: true }> }> {
	const directory = cwd ?? service.defaultDirectory(attemptId);
	const current = directory === null ? null : await service.current(directory);
	const read = service.list(attemptId, current);
	if (!read.ok) throw new Error(`${READ_REFUSALS[read.code]}${read.reason === undefined ? "" : ` (${read.reason})`}`);
	return { directory, read };
}

async function receipts(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(argv, ["--attempt", "--cwd"], USAGE);
	const { directory, read } = await readReceipts(receiptsAt(root), attemptOf(flags), flags.get("--cwd"));
	print({
		comparedWith: directory,
		receipts: read.receipts.map((r) => receiptSummary(r.receipt, r.relation)),
		problems: read.problems,
	});
}

async function receipt(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(argv, ["--receipt", "--cwd"], USAGE);
	const id = flags.get("--receipt");
	if (id === undefined) throw new TypeError(USAGE);
	const service = receiptsAt(root);
	const found = service.find(id);
	if (found === null) throw new Error(READ_REFUSALS["not-found"]);
	const { directory, read } = await readReceipts(service, found.attemptId, flags.get("--cwd"));
	const one = read.receipts.find((r) => r.receipt.id === id);
	if (one === undefined) throw new Error(READ_REFUSALS["not-found"]);
	print({ comparedWith: directory, receipt: receiptShown(one.receipt, one.relation) });
}

/**
 * `evidence`: one attempt's records read together (docs/designs/develop-attempt-evidence.md). Read-only: it writes, stores and runs nothing,
 * and names no revision as the attempt's result. The working tree compared is the one `receipts` would compare with.
 */
async function evidence(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(argv, ["--attempt", "--cwd"], USAGE);
	const attemptId = attemptOf(flags);
	// The records are read one after another, not under a lock: readAtMs is when this reading began.
	const readAtMs = Date.now();
	const report = unwrap(serviceAt(root).get(attemptId));
	const service = receiptsAt(root);
	const directory = flags.get("--cwd") ?? service.defaultDirectory(attemptId);
	const current = directory === null ? null : await service.current(directory);
	const read = service.list(attemptId, current);
	const tasks = new DevelopTasksStoreV0(root).read();
	const task = tasks.ok
		? (tasks.file.tasks.find((t) => t.id === report.attempt.taskId && t.projectId === report.attempt.projectId) ??
			null)
		: null;
	const view = endoAttemptEvidenceV0({
		report,
		task,
		receipts: read.ok ? read.receipts : null,
		receiptProblems: read.ok ? read.problems.length : 0,
		comparedWith: directory,
		current,
		readAtMs,
	});
	print({ evidence: view });
	process.stderr.write(renderEndoAttemptEvidenceV0(view));
}

export const ATTEMPT_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	prepare,
	brief,
	handoff,
	report,
	abandon,
	list,
	show,
	check,
	receipts,
	receipt,
	evidence,
};
