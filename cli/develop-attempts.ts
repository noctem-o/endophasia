/**
 * `endo attempt prepare|brief|handoff|report|abandon|list|show`: the operator's work attempts on a task (docs/designs/develop-work-attempts.md),
 * kept in the store root's `develop/attempts/` as write-once records (storage/develop-attempts.ts).
 *
 * An attempt is one request the operator prepared on one task. `brief` prints it as plain text for the operator to copy into any coding
 * agent; nothing here sends it anywhere, runs an agent, or reads an agent's reply. `handoff`, `report` and `abandon` record the operator's
 * own statements, once each: that they handed it over, what was reported (never verified here), or that they stopped. None of them changes
 * the task: its status moves only by `endo task status` or the workbench's buttons. The task file is read, never written.
 *
 * These commands are a translation of flags and refusals around the shared attempts service (runtime/contracts/develop-attempts.ts).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { ENDO_DEVELOP_ATTEMPT_LABELS_V0, ENDO_DEVELOP_ATTEMPT_LIMITS_V0 } from "../protocol/develop-attempts.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	type DevelopAttemptReportV0,
	type DevelopAttemptsRefusalV0,
	type DevelopAttemptsResultV0,
	DevelopAttemptsServiceV0,
} from "../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { flagsOf } from "./develop-tasks.ts";

const USAGE =
	"usage: endo attempt prepare [<root> | --root dir] --project <id> --task <id> (--objective <text> | --objective-file <path>) [--constraints <text> | --constraints-file <path>] [--report-back <text> | --report-back-file <path>] | endo attempt brief ... --attempt <id> | endo attempt handoff ... --attempt <id> --to <label> [--note <n>] | endo attempt report ... --attempt <id> --note <what was reported> | endo attempt abandon ... --attempt <id> [--note <n>] | endo attempt list ... --project <id> [--task <id>] | endo attempt show ... --attempt <id>";

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
	new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root));

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
});

const shown = (r: DevelopAttemptReportV0) => ({
	...summary(r),
	attempt: r.attempt,
	handoff: r.handoff,
	outcome: r.outcome,
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
		],
		USAGE,
	);
	const project = flags.get("--project");
	const task = flags.get("--task");
	const objective = textOf(flags, "objective");
	if (project === undefined || task === undefined || objective === undefined) throw new TypeError(USAGE);
	const service = serviceAt(root);
	const attempt = unwrap(
		service.prepare(project, task, {
			objective,
			constraints: textOf(flags, "constraints"),
			reportBack: textOf(flags, "report-back"),
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
	print({ attempt: shown(unwrap(serviceAt(root).get(attemptOf(flags)))) });
}

export const ATTEMPT_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	prepare,
	brief,
	handoff,
	report,
	abandon,
	list,
	show,
};
