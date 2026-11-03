/**
 * `endo project add|list` and `endo task list|add|status|show|link|unlink|upgrade`: the operator's own metadata about their work, kept in the store root's
 * `develop/tasks.json` (storage/develop-tasks.ts). These commands are the only way to REGISTER a project, and the way to read and edit tasks
 * when no workbench is attached (a workbench page can change tasks only while it is paired to a live session).
 *
 * Registering a project is an explicit statement: "this directory is this project". The directory is named with --path (there is no default,
 * so no registration happens by being somewhere), resolved to the place the system calls it, and must be an existing directory. It is not
 * opened, searched or run; Git is asked once, read-only, what the worktree root there is, and the answer is kept as an observation. The
 * registration grants no access to anything: a workbench uses the project only when it is started with `--project <id>` from that directory.
 *
 * `endo task link --source omp-saved` records a reference from a task to an Oh My Pi saved session. The operator names the session by OMP's own
 * id AND the OMP sessions directory; this process then reads that directory with the read-only observer (adapters/omp/observer.ts) and links
 * only when exactly one readable file there carries that id and every file there was read. The id alone is never taken as proof, a Studio
 * selector is refused, and OMP's files are only read: OMP is not run, nothing is sent to it, and the reference grants no control of it.
 * A live Pi session cannot be linked here: only the workbench that serves it can make that reference.
 *
 * `endo task upgrade` shows the task file's version (a dry run); `--apply` rewrites a v0 file as v1, the operator's explicit act.
 *
 * Nothing here talks to Pi, a model, the event store or the network, and no command sends a prompt or changes a worktree. The commands are a
 * translation of flags and refusals around the shared workspace service (runtime/contracts/develop-workspace.ts), the same one the workbench uses.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import {
	ENDO_DEVELOP_TASK_STATUSES_V0,
	ENDO_DEVELOP_TASKS_SCHEMA_V0,
	type EndoDevelopSessionRefV1,
	type EndoDevelopTaskV1,
	endoDevelopOmpScopeLabelV1,
	isEndoDevelopOmpSessionIdV1,
} from "../protocol/develop-tasks.ts";
import { ENDO_OMP_SELECTOR_PATTERN_V0 } from "../protocol/omp-observation.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	type DevelopWorkspaceRefusalV0,
	type DevelopWorkspaceResultV0,
	DevelopWorkspaceServiceV0,
} from "../runtime/contracts/develop-workspace.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";

const PROJECT_USAGE =
	"usage: endo project add [<root> | --root dir] --name <name> --path <directory> | endo project list [<root> | --root dir]";
const TASK_USAGE =
	"usage: endo task list [<root> | --root dir] --project <id> | endo task add ... --project <id> --title <t> [--description <d>] [--acceptance <a>] | endo task status ... --project <id> --task <id> --to <status> [--note <n>] [--revision n] | endo task show ... --project <id> --task <id> [--omp-sessions <dir>] | endo task link ... --project <id> --task <id> --source omp-saved --session <omp-session-id> --omp-sessions <dir> [--revision n] | endo task unlink ... --project <id> --task <id> --link <link-id> [--revision n] | endo task upgrade [<root> | --root dir] [--apply [--revision n]]";

const REFUSALS: Readonly<Record<DevelopWorkspaceRefusalV0, string>> = {
	"not-found": "no such project or task in this store",
	"stale-revision": "the task changed since that revision; read it again",
	"invalid-transition": "that status change is not allowed from the task's current status",
	"bad-request": "the input was not acceptable (check lengths, control characters and the status name)",
	limit: "a limit of the task store was reached (see docs/develop-tasks.md)",
	duplicate: "that directory is already registered as a project",
	unreadable: "the task file exists but cannot be used; it was not changed",
	busy: "another process is writing the task file; try again",
	"storage-failed": "the task file could not be written; nothing was changed",
	"not-a-directory": "--path must be an existing directory",
	// A launch's refusals: the CLI is not a launch and is never given them.
	"read-only": "the workspace is read-only here",
	"no-session": "there is no connected session",
	"unsupported-source": "that session source cannot be recorded",
	unavailable: "the session facts are unavailable",
	"upgrade-required":
		"the task file is endo.develop-tasks.v0, which cannot record this reference; run `endo task upgrade` to see what an upgrade does, then `endo task upgrade --apply`",
};

/** The develop commands' flag reader: each flag in `values` at most once, each with a value; the store root as every command takes it. */
export function flagsOf(argv: readonly string[], values: readonly string[], usage: string, positionals = 0) {
	const taken = takeEndoRootV0(argv, positionals, new Set(values));
	const flags = new Map<string, string>();
	const rest = [...taken.rest];
	while (rest.length > 0) {
		const flag = rest.shift() as string;
		if (!flag.startsWith("--") || !values.includes(flag)) throw new TypeError(usage);
		const value = rest.shift();
		if (value === undefined) throw new TypeError(`the flag ${flag} needs a value`);
		if (flags.has(flag)) throw new TypeError(`${flag} was given more than once`);
		flags.set(flag, value);
	}
	announceEndoRootV0(taken);
	return { root: taken.root, flags };
}

/** A read's answer: an unreadable file is said in a read's words. */
function unwrapRead<T>(result: DevelopWorkspaceResultV0<T>): T {
	if (!result.ok && result.code === "unreadable")
		throw new Error(`the task file cannot be used (${result.reason ?? "io"}); it was not changed`);
	return unwrap(result);
}

function unwrap<T>(result: DevelopWorkspaceResultV0<T>): T {
	if (result.ok) return result.value;
	const why = result.reason === undefined ? "" : ` (${result.reason})`;
	throw new Error(`${REFUSALS[result.code] ?? result.code}${why}`);
}

/** What Git says the worktree root of a directory is, read-only, as an observation to compare later. Not finding one is not a failure. */
async function observeGitRoot(directory: string): Promise<string | null> {
	const inspector = new GitProjectInspectorV0({ cwd: directory });
	try {
		const overview = await inspector.overview();
		return overview.state === "ready" && overview.repository !== null ? overview.repository.root : null;
	} finally {
		inspector.dispose();
	}
}

const serviceAt = (root: string) => new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), { observeGitRoot });

const print = (value: unknown): void => {
	process.stdout.write(`${canonicalEndoJsonV0(value as never)}\n`);
};

async function projectAdd(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(argv, ["--name", "--path"], PROJECT_USAGE);
	const name = flags.get("--name");
	const given = flags.get("--path");
	if (name === undefined || given === undefined) throw new TypeError(PROJECT_USAGE);
	// The service resolves the path, requires a directory, and asks Git once, read-only, what the worktree root there is (an observation).
	const project = unwrap(await serviceAt(root).registerProject({ name, path: given }));
	const path = project.path;
	print({ project });
	process.stderr.write(
		`registered. Start a workbench for it from that directory with: endo harness attach --root ${root} --cwd ${path} --control --workbench --project ${project.id}\nthe workbench may change this project's tasks only when launched in exactly this directory (${path}); from a subdirectory or elsewhere it shows them read-only. Register the subdirectory instead if that is where you work.\n`,
	);
}

function projectList(argv: readonly string[]): void {
	const { root } = flagsOf(argv, [], PROJECT_USAGE);
	const file = unwrapRead(serviceAt(root).read());
	const format = unwrapRead(serviceAt(root).inspect()).format;
	print({
		format,
		revision: file.revision,
		projects: file.projects.map((p) => ({
			id: p.id,
			name: p.name,
			path: p.path,
			observedGitRoot: p.observedGitRoot,
			tasks: Object.fromEntries(
				ENDO_DEVELOP_TASK_STATUSES_V0.map((s) => [
					s,
					file.tasks.filter((t) => t.projectId === p.id && t.status === s).length,
				]),
			),
		})),
	});
}

const summary = (t: EndoDevelopTaskV1) => ({
	id: t.id,
	title: t.title,
	status: t.status,
	revision: t.revision,
	updatedAtMs: t.updatedAtMs,
	sessionReferences: t.sessions.length,
});

function taskList(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--project"], TASK_USAGE);
	const project = flags.get("--project");
	if (project === undefined) throw new TypeError(TASK_USAGE);
	print({ tasks: unwrapRead(serviceAt(root).tasks(project)).map(summary) });
}

function taskAdd(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--project", "--title", "--description", "--acceptance"], TASK_USAGE);
	const project = flags.get("--project");
	const title = flags.get("--title");
	if (project === undefined || title === undefined) throw new TypeError(TASK_USAGE);
	const task = unwrap(
		serviceAt(root).createTask(project, {
			title,
			description: flags.get("--description"),
			acceptance: flags.get("--acceptance"),
		}),
	);
	print({ task: summary(task) });
}

/** `--revision n`, or the task's revision read now (a change is still refused if the task changes between this read and the write). */
function revisionFor(
	service: DevelopWorkspaceServiceV0,
	flags: Map<string, string>,
	project: string,
	taskId: string,
): number {
	if (flags.has("--revision")) {
		const given = flags.get("--revision") as string;
		if (!/^(0|[1-9][0-9]{0,9})$/.test(given)) throw new TypeError("--revision is a non-negative integer");
		return Number(given);
	}
	return unwrapRead(service.task(project, taskId)).revision;
}

/** A reference as the terminal shows it: the operator's own file, so ids are shown; never a path or any session content. */
const referenceOut = (r: EndoDevelopSessionRefV1) =>
	r.source === "pi-live"
		? {
				linkId: r.linkId,
				source: r.source,
				sessionId: r.sessionId,
				attachment: r.attachment,
				launchId: r.launchId,
				linkedAtMs: r.linkedAtMs,
				via: r.via,
			}
		: {
				linkId: r.linkId,
				source: r.source,
				sessionId: r.sessionId,
				scope: r.scope,
				scopeLabel: endoDevelopOmpScopeLabelV1(r.scope),
				observedFormat: r.observedFormat,
				linkedAtMs: r.linkedAtMs,
				via: r.via,
			};

/** Whether `path` is the directory `root` or lies beneath it (both resolved). */
const within = (root: string, path: string): boolean => {
	const from = relative(root, path);
	return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
};
/** Where a path lies: the realpath of its nearest existing ancestor, with the rest appended, so a link above a missing part is resolved. */
const placeOf = (path: string): string => {
	let at = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(at), ...rest);
		} catch {
			const up = dirname(at);
			if (up === at) return resolve(path);
			rest.unshift(basename(at));
			at = up;
		}
	}
};

/**
 * The read-only OMP observer over the directory the operator named, keyed with a throwaway in-process key (its selectors are never shown or
 * kept). The task store and the OMP directory must not overlap: this command writes the store and must write nothing under OMP's directory.
 */
async function ompObserverAt(directory: string, root: string) {
	const { OmpSavedSessionObserverV0, resolveOmpRootV0 } = await import("../adapters/omp/observer.ts");
	const ompRoot = resolveOmpRootV0(directory);
	const store = placeOf(root);
	if (within(ompRoot, store) || within(store, ompRoot))
		throw new TypeError("the store root and the OMP sessions directory overlap; name separate directories");
	return new OmpSavedSessionObserverV0({ root: ompRoot, key: endoDigestKeyV0(randomBytes(32), "omp-link") });
}

const UNSETTLED: Record<"not-found" | "duplicate" | "uncertain", (n: number) => string> = {
	"not-found": (n) =>
		`no readable saved session in that directory carries that id${n > 0 ? ` (${n} entries there were not read: links, deeper directories, or unreadable or unknown-format files; name OMP's sessions directory itself)` : ""}. Use OMP's own session id (OMP's /session info, or Studio's OMP inspector) and the directory that holds it`,
	duplicate: (n) =>
		`${n} saved files in that directory carry that id, so none of them is established as the session; nothing was linked`,
	uncertain: (n) =>
		`one readable file carries that id, but ${n} entries there were not read (links, deeper directories, or unreadable or unknown-format files) and might carry it too, so it is not established; name a narrower directory or try again`,
};

async function taskLink(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(
		argv,
		["--project", "--task", "--source", "--session", "--omp-sessions", "--revision"],
		TASK_USAGE,
	);
	const project = flags.get("--project");
	const taskId = flags.get("--task");
	const source = flags.get("--source");
	const sessionId = flags.get("--session");
	const directory = flags.get("--omp-sessions");
	if (project === undefined || taskId === undefined || source === undefined) throw new TypeError(TASK_USAGE);
	if (source === "pi-live")
		throw new TypeError(
			"a live Pi session is linked only by the workbench that serves it (Link the current session); `endo task link` records --source omp-saved",
		);
	if (source !== "omp-saved") throw new TypeError("--source must be omp-saved (the only source this command records)");
	if (sessionId === undefined || directory === undefined)
		throw new TypeError(
			"--source omp-saved needs --session <OMP's session id> and --omp-sessions <the directory that holds it>",
		);
	if (ENDO_OMP_SELECTOR_PATTERN_V0.test(sessionId))
		throw new TypeError(
			"that is an Endophasia Studio selector (it names a file in one Studio launch), not an OMP session id; use the id OMP wrote (OMP's /session info, or Studio's OMP inspector)",
		);
	if (!isEndoDevelopOmpSessionIdV1(sessionId)) throw new TypeError("--session is not an OMP session id");
	const service = serviceAt(root);
	// Said before OMP's directory is read. A store with no task file has no task to link (and nothing is created for it); a v0 file
	// cannot record this, and the operator decides whether to upgrade.
	const file = unwrapRead(service.inspect());
	if (!file.exists)
		throw new Error("this store has no task file yet: register a project and add a task first; nothing was written");
	if (file.format === ENDO_DEVELOP_TASKS_SCHEMA_V0) unwrap({ ok: false, code: "upgrade-required" });
	const observer = await ompObserverAt(directory, root);
	const revision = revisionFor(service, flags, project, taskId);
	const found = observer.resolve(sessionId);
	if (found.status !== "established")
		throw new Error(UNSETTLED[found.status](found.status === "duplicate" ? found.files : found.unread));
	const task = unwrap(
		service.linkObservedSession(project, taskId, revision, {
			source: "omp-saved",
			sessionId: found.sessionId,
			scope: found.scope,
			format: found.format,
		}),
	);
	const reference = task.sessions.find(
		(r) => r.source === "omp-saved" && r.sessionId === found.sessionId && r.scope === found.scope,
	);
	print({
		task: summary(task),
		linked: task.revision === revision ? "already" : "new",
		reference: reference === undefined ? null : referenceOut(reference),
	});
	process.stderr.write(
		"a reference records your choice. It is not a connection: it cannot resume, prompt, steer, queue, stop or select the OMP session, and OMP's files were only read.\n",
	);
}

function taskUnlink(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--project", "--task", "--link", "--revision"], TASK_USAGE);
	const project = flags.get("--project");
	const taskId = flags.get("--task");
	const link = flags.get("--link");
	if (project === undefined || taskId === undefined || link === undefined) throw new TypeError(TASK_USAGE);
	const service = serviceAt(root);
	const revision = revisionFor(service, flags, project, taskId);
	print({ task: summary(unwrap(service.unlinkSession(project, taskId, revision, link))) });
}

async function taskShow(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(argv, ["--project", "--task", "--omp-sessions"], TASK_USAGE);
	const project = flags.get("--project");
	const taskId = flags.get("--task");
	if (project === undefined || taskId === undefined) throw new TypeError(TASK_USAGE);
	const task = unwrapRead(serviceAt(root).task(project, taskId));
	const directory = flags.get("--omp-sessions");
	let observed: ((r: EndoDevelopSessionRefV1) => string) | null = null;
	if (directory !== undefined) {
		// Checked now, read-only, in the directory named: a reference from another directory is not looked for there.
		const observer = await ompObserverAt(directory, root);
		const ids = task.sessions.flatMap((r) =>
			r.source === "omp-saved" && r.scope === observer.scope ? [r.sessionId] : [],
		);
		const answers = observer.resolveAll(ids);
		observed = (r) =>
			r.source !== "omp-saved"
				? "not-applicable"
				: r.scope !== observer.scope
					? "other-directory"
					: (answers.get(r.sessionId)?.status ?? "not-found");
	}
	print({
		task: {
			...summary(task),
			references: task.sessions.map((r) => ({
				...referenceOut(r),
				...(observed === null ? {} : { observedNow: observed(r) }),
			})),
		},
	});
}

/** `endo task upgrade`: a dry run that says what the file is and what `--apply` would do; `--apply` does it. */
function taskUpgrade(argv: readonly string[]): void {
	const applies = argv.filter((a) => a === "--apply").length;
	if (applies > 1) throw new TypeError("--apply was given more than once");
	const { root, flags } = flagsOf(
		argv.filter((a) => a !== "--apply"),
		["--revision"],
		TASK_USAGE,
	);
	const service = serviceAt(root);
	const before = unwrapRead(service.inspect());
	if (applies === 0) {
		if (flags.has("--revision")) throw new TypeError("--revision is for --apply");
		const needed = before.exists && before.format === ENDO_DEVELOP_TASKS_SCHEMA_V0;
		print({ file: before, upgrade: needed ? "available" : "not-needed" });
		process.stderr.write(
			needed
				? `dry run: nothing was written. \`endo task upgrade --apply\` rewrites develop/tasks.json once, atomically, as endo.develop-tasks.v1: every project, task, status, history, selection and Pi reference is kept exactly, and the file revision becomes ${before.revision + 1}. After it, OMP saved sessions can be linked, and endo builds from before v1 refuse the file (they never write over it). Copy tasks.json first if you may go back to such a build.\n`
				: "nothing to upgrade.\n",
		);
		return;
	}
	if (!before.exists) {
		// Nothing to upgrade, and nothing is created: no directory, no lock. A new store is created as v1 by its first write.
		print({ upgrade: { from: before.format, to: before.format, unchanged: true }, file: before });
		process.stderr.write(
			"there is no task file yet; nothing was written. A new one is created as endo.develop-tasks.v1.\n",
		);
		return;
	}
	let expected: number | undefined;
	if (flags.has("--revision")) {
		const given = flags.get("--revision") as string;
		if (!/^(0|[1-9][0-9]{0,9})$/.test(given)) throw new TypeError("--revision is a non-negative integer");
		expected = Number(given);
	}
	const done = unwrap(service.upgrade(expected));
	const after = unwrapRead(service.inspect());
	print({ upgrade: done, file: after });
	process.stderr.write(done.unchanged ? "nothing to upgrade; nothing was written.\n" : "upgraded.\n");
}

function taskStatus(argv: readonly string[]): void {
	const { root, flags } = flagsOf(argv, ["--project", "--task", "--to", "--note", "--revision"], TASK_USAGE);
	const project = flags.get("--project");
	const taskId = flags.get("--task");
	const to = flags.get("--to");
	if (project === undefined || taskId === undefined || to === undefined) throw new TypeError(TASK_USAGE);
	const service = serviceAt(root);
	const revision = revisionFor(service, flags, project, taskId);
	print({ task: summary(unwrap(service.setStatus(project, taskId, revision, to, flags.get("--note")))) });
}

export const PROJECT_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	add: projectAdd,
	list: projectList,
};
export const TASK_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	list: taskList,
	add: taskAdd,
	status: taskStatus,
	show: taskShow,
	link: taskLink,
	unlink: taskUnlink,
	upgrade: taskUpgrade,
};
