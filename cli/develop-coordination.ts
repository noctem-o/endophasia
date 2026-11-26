/**
 * `endo assign ...`, `endo dep ...`, `endo candidate ...`: the operator's coordination metadata (`<root>/develop/coordination.json`,
 * storage/develop-coordination.ts; docs/designs/coordinator-assignment-implementation.md).
 *
 * Every mutating command is an explicit operator act with a revision precondition (`--revision`): the coordination FILE revision for a
 * creation (assign create, dep add, candidate declare), the RECORD revision for a change to one record. A stale revision is refused and
 * nothing is written. Each command prints one canonical JSON document on stdout: the result, or `{ "refusal": { code, ... } }` followed
 * by a one-line error on stderr and exit status 1.
 *
 * Nothing here launches a model turn, dispatches or prepares an attempt, grants or answers a native approval, interrupts or attaches to a
 * session, checks out, creates or deletes a worktree, or changes a task. An assignment is not an authorisation; readiness is not
 * permission to execute. A session association recorded here is the operator's declaration (`operator-declared`), never an observation
 * of a live session. These commands are not exposed to the Coordinator, whose only tool reads status.
 */

import { DevelopCoordinationGitV0, resolveProtectedCandidateV0 } from "../adapters/develop/coordination.ts";
import {
	ENDO_ACCESS_INTENTS_V0,
	ENDO_DEPENDENCY_CONDITIONS_V0,
	ENDO_HARNESS_FAMILIES_V0,
	ENDO_PARTICIPANT_ROLES_V0,
	type EndoAccessIntentV0,
	type EndoDependencyConditionV0,
	type EndoIntendedHarnessFamilyV0,
	type EndoParticipantRoleV0,
} from "../protocol/develop-coordination.ts";
import { ENDO_PROJECT_ID_PATTERN_V0, type EndoDevelopProjectV0 } from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { readEndoCoordinatorCoordinationV0 } from "../storage/coordinator-coordination.ts";
import {
	DevelopCoordinationStoreV0,
	type EndoAssignmentSpecV0,
	type EndoCoordinationResultV0,
} from "../storage/develop-coordination.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { flagsOf } from "./develop-tasks.ts";

const NO_AUTHORITY =
	"coordination metadata only: this grants no execution authority, dispatches nothing, and does not change the task; readiness is not permission to execute.\n";

const REFUSALS: Readonly<Record<string, string>> = {
	"not-found": "no such project, task, assignment, dependency, candidate or attempt",
	"stale-revision": "the record changed since that revision; read it again",
	"invalid-transition": "that change is not allowed from the record's current state",
	"bad-request": "the input was not acceptable",
	limit: "a limit of the coordination file was reached",
	duplicate: "that already exists",
	"dependency-cycle": "that dependency would create a cycle",
	"cross-project": "that crosses a project, task or repository boundary",
	"worktree-write-overlap":
		"another writable assignment (active, or ended with liveness unverified) uses that worktree; pass --allow-shared-worktree to acknowledge sharing it",
	"synthetic-not-admitted": "a synthetic (test-*) session source cannot be associated with an assignment",
	"unsupported-source": "that session source cannot be recorded by this version",
	unsupported: "that operation is not supported by this version",
	unreadable: "the coordination file exists but cannot be used; it was not changed",
	"tasks-unreadable": "the task file cannot be read; nothing was changed",
	"attempts-unreadable": "the attempt records cannot be read; nothing was changed",
	busy: "another process is writing the coordination file; try again",
	"storage-failed": "the coordination file could not be written; nothing was changed",
	"commit-uncertain":
		"the coordination file was replaced but its durability could not be confirmed; read it again before acting on it",
};

const print = (value: unknown): void => {
	process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify(value)) as never)}\n`);
};

function refuse(code: string, detail?: string, reason?: string): never {
	print({
		refusal: { code, ...(reason === undefined ? {} : { reason }), ...(detail === undefined ? {} : { detail }) },
	});
	throw new Error(
		`${code}: ${REFUSALS[code] ?? code}${reason === undefined ? "" : ` (${reason})`}${detail === undefined ? "" : ` — ${detail}`}`,
	);
}

function done<T>(result: EndoCoordinationResultV0<T>): { value: T; revision: number; commit: string } {
	if (!result.ok) return refuse(result.code, result.detail, result.reason);
	return { value: result.value, revision: result.file.revision, commit: result.commit };
}

const need = (flags: Map<string, string>, flag: string, usage: string): string => {
	const v = flags.get(flag);
	if (v === undefined || v.length === 0) throw new TypeError(usage);
	return v;
};
const revisionOf = (flags: Map<string, string>, usage: string, flag = "--revision"): number => {
	const raw = need(flags, flag, usage);
	if (!/^(0|[1-9][0-9]{0,14})$/.test(raw)) throw new TypeError(`${flag} must be a non-negative integer`);
	return Number(raw);
};
const oneOf = <T extends string>(value: string, values: readonly T[], flag: string): T => {
	if (!(values as readonly string[]).includes(value))
		throw new TypeError(`${flag} must be one of ${values.join(", ")}`);
	return value as T;
};

function projectOf(root: string, projectId: string): EndoDevelopProjectV0 {
	if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) throw new TypeError("--project needs one endo.project.<32 hex> id");
	const tasks = new DevelopTasksStoreV0(root).read();
	if (!tasks.ok) return refuse("tasks-unreadable", undefined, tasks.reason);
	const project = tasks.file.projects.find((p) => p.id === projectId);
	if (project === undefined) return refuse("not-found", `project ${projectId}`);
	return project;
}

// ---- assignments -------------------------------------------------------------------------------------------------------------------

const ASSIGN_USAGE =
	"usage: endo assign <create|supersede|revoke|close|bind|unbind|link|reconfirm|clear-hazard|list|show> [<root> | --root dir] ... (see endo --help)";
const SPEC_FLAGS = [
	"--task-revision",
	"--participant",
	"--role",
	"--harness",
	"--worktree",
	"--access",
	"--path-hints",
	"--target-task",
	"--target-candidate",
	"--allow-shared-worktree",
];

async function specOf(
	flags: Map<string, string>,
	project: EndoDevelopProjectV0,
	usage: string,
): Promise<EndoAssignmentSpecV0> {
	const role = oneOf<EndoParticipantRoleV0>(need(flags, "--role", usage), ENDO_PARTICIPANT_ROLES_V0, "--role");
	const harness = flags.get("--harness");
	const access = need(flags, "--access", usage);
	const accessIntent = oneOf<EndoAccessIntentV0>(
		access === "rw" ? "read-write-intended" : access === "ro" ? "read-only-intended" : access,
		ENDO_ACCESS_INTENTS_V0,
		"--access (rw | ro)",
	);
	const shared = flags.get("--allow-shared-worktree");
	if (shared !== undefined && shared !== "yes") throw new TypeError("--allow-shared-worktree takes the value yes");
	const targetTask = flags.get("--target-task");
	const targetCandidate = flags.get("--target-candidate");
	if ((targetTask === undefined) !== (targetCandidate === undefined))
		throw new TypeError("--target-task and --target-candidate go together");
	const place = await new DevelopCoordinationGitV0().resolveWorkspace(project, need(flags, "--worktree", usage));
	if (!place.ok) return refuse(place.code, place.detail);
	const hints = flags.get("--path-hints");
	return {
		participant: {
			participantId: need(flags, "--participant", usage),
			role,
			intendedHarnessFamily:
				harness === undefined
					? null
					: oneOf<EndoIntendedHarnessFamilyV0>(harness, ENDO_HARNESS_FAMILIES_V0, "--harness"),
		},
		workspace: {
			worktreePath: place.worktreePath,
			registration: place.registration,
			accessIntent,
			pathHints: hints === undefined || hints === "" ? [] : hints.split(","),
			allowSharedWorktree: shared === "yes",
		},
		targetCandidate:
			targetTask === undefined || targetCandidate === undefined
				? null
				: { taskId: targetTask, candidateId: targetCandidate },
	};
}

const describe = (a: { assignmentId: string; projectId: string; taskId: string; state: string; revision: number }) =>
	`assignment ${a.assignmentId} (${a.state}, revision ${a.revision}) on task ${a.taskId} of project ${a.projectId}`;

async function assignCreate(argv: readonly string[]): Promise<void> {
	const usage =
		"usage: endo assign create [<root> | --root dir] --project <id> --task <id> --participant <slug> --role <builder|reviewer|investigator> [--harness <pi|codex|claude-code|any>] --worktree <dir> --access <rw|ro> [--path-hints a,b] [--target-task <id> --target-candidate <id>] [--allow-shared-worktree yes] --revision <file revision> --task-revision <task revision>";
	const { root, flags } = flagsOf(argv, ["--project", "--task", "--revision", ...SPEC_FLAGS], usage);
	const project = projectOf(root, need(flags, "--project", usage));
	const spec = await specOf(flags, project, usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).createAssignment({
			expectedTaskRevision: revisionOf(flags, usage, "--task-revision"),
			expectedFileRevision: revisionOf(flags, usage),
			projectId: project.id,
			taskId: need(flags, "--task", usage),
			...spec,
		}),
	);
	print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(`confirmed ${describe(r.value)}.\n${NO_AUTHORITY}`);
}

async function assignSupersede(argv: readonly string[]): Promise<void> {
	const usage =
		"usage: endo assign supersede [<root> | --root dir] --assignment <id> --revision <assignment revision> --participant ... --role ... --worktree ... --access ... [--reason <text>] (the replacement's flags as for create) --task-revision <task revision>";
	const { root, flags } = flagsOf(argv, ["--assignment", "--revision", "--reason", ...SPEC_FLAGS], usage);
	const store = new DevelopCoordinationStoreV0(root);
	const read = store.read();
	if (!read.ok) return refuse("unreadable", undefined, read.reason);
	const id = need(flags, "--assignment", usage);
	const current = read.file.assignments.find((a) => a.assignmentId === id);
	if (current === undefined) return refuse("not-found", `assignment ${id}`);
	const spec = await specOf(flags, projectOf(root, current.projectId), usage);
	const r = done(
		store.supersedeAssignment(
			id,
			revisionOf(flags, usage),
			revisionOf(flags, usage, "--task-revision"),
			spec,
			flags.get("--reason"),
		),
	);
	print({
		superseded: r.value.superseded,
		replacement: r.value.replacement,
		coordinationRevision: r.revision,
		commit: r.commit,
	});
	process.stderr.write(
		`superseded ${describe(r.value.superseded)}; hazard: ${r.value.superseded.worktreeHazard.state}.\nconfirmed ${describe(r.value.replacement)}.\nsuperseding does not stop any process the old participant may still be running.\n${NO_AUTHORITY}`,
	);
}

function assignEnd(to: "revoked" | "closed") {
	return (argv: readonly string[]): void => {
		const usage = `usage: endo assign ${to === "revoked" ? "revoke" : "close"} [<root> | --root dir] --assignment <id> --revision <assignment revision> [--reason <text>]`;
		const { root, flags } = flagsOf(argv, ["--assignment", "--revision", "--reason"], usage);
		const r = done(
			new DevelopCoordinationStoreV0(root).endAssignment(
				need(flags, "--assignment", usage),
				revisionOf(flags, usage),
				to,
				flags.get("--reason"),
			),
		);
		print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
		process.stderr.write(
			`${to} ${describe(r.value)}; hazard: ${r.value.worktreeHazard.state}.\nthis does not stop, and does not establish that anything stopped; the worktree is not declared safe to reuse.\n`,
		);
	};
}

function assignBind(argv: readonly string[]): void {
	const usage =
		"usage: endo assign bind [<root> | --root dir] --assignment <id> --revision <assignment revision> --source <pi-live|codex-live> --session-key <source:scope:id> --attachment <name> [--instance <id>] [--fingerprint <id>]";
	const { root, flags } = flagsOf(
		argv,
		["--assignment", "--revision", "--source", "--session-key", "--attachment", "--instance", "--fingerprint"],
		usage,
	);
	const r = done(
		new DevelopCoordinationStoreV0(root).associateSession(
			need(flags, "--assignment", usage),
			revisionOf(flags, usage),
			{
				source: need(flags, "--source", usage) as never,
				sessionKey: need(flags, "--session-key", usage),
				attachmentId: need(flags, "--attachment", usage),
				instanceId: flags.get("--instance") ?? null,
				runtimeFingerprintId: flags.get("--fingerprint") ?? null,
			},
		),
	);
	print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(
		`recorded an operator-declared session association on ${describe(r.value)}.\nthis is not an observation: whether that session is live, or is the session you meant, is not established here.\n${NO_AUTHORITY}`,
	);
}

function assignUnbind(argv: readonly string[]): void {
	const usage = "usage: endo assign unbind [<root> | --root dir] --assignment <id> --revision <assignment revision>";
	const { root, flags } = flagsOf(argv, ["--assignment", "--revision"], usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).associateSession(
			need(flags, "--assignment", usage),
			revisionOf(flags, usage),
			null,
		),
	);
	print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(`cleared the session association on ${describe(r.value)}. The session itself is untouched.\n`);
}

function assignLink(argv: readonly string[]): void {
	const usage =
		"usage: endo assign link [<root> | --root dir] --assignment <id> --revision <assignment revision> --attempt <id>";
	const { root, flags } = flagsOf(argv, ["--assignment", "--revision", "--attempt"], usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).linkAttempt(
			need(flags, "--assignment", usage),
			revisionOf(flags, usage),
			need(flags, "--attempt", usage),
		),
	);
	print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(`linked; a link is a reference, not a dispatch. ${NO_AUTHORITY}`);
}

function assignReconfirm(argv: readonly string[]): void {
	const usage =
		"usage: endo assign reconfirm [<root> | --root dir] --assignment <id> --revision <assignment revision> --task-revision <task revision>";
	const { root, flags } = flagsOf(argv, ["--assignment", "--revision", "--task-revision"], usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).reconfirmTask(
			need(flags, "--assignment", usage),
			revisionOf(flags, usage),
			revisionOf(flags, usage, "--task-revision"),
		),
	);
	print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(`${describe(r.value)} now names task revision ${r.value.taskRevisionAtBind}.\n`);
}

function assignClearHazard(argv: readonly string[]): void {
	const usage =
		"usage: endo assign clear-hazard [<root> | --root dir] --assignment <id> --revision <assignment revision> --note <what you verified>";
	const { root, flags } = flagsOf(argv, ["--assignment", "--revision", "--note"], usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).clearHazard(
			need(flags, "--assignment", usage),
			revisionOf(flags, usage),
			need(flags, "--note", usage),
		),
	);
	print({ assignment: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(
		`recorded your statement that the processes behind ${describe(r.value)} have stopped. Endophasia did not verify it.\n`,
	);
}

function assignList(argv: readonly string[]): void {
	const usage = "usage: endo assign list [<root> | --root dir] --project <id>";
	const { root, flags } = flagsOf(argv, ["--project"], usage);
	const projectId = need(flags, "--project", usage);
	projectOf(root, projectId);
	const read = new DevelopCoordinationStoreV0(root).read();
	if (!read.ok) refuse("unreadable", undefined, read.reason);
	print({
		coordinationRevision: read.file.revision,
		exists: read.exists,
		assignments: read.file.assignments.filter((a) => a.projectId === projectId),
	});
}

async function assignShow(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo assign show [<root> | --root dir] --assignment <id>";
	const { root, flags } = flagsOf(argv, ["--assignment"], usage);
	const id = need(flags, "--assignment", usage);
	const read = new DevelopCoordinationStoreV0(root).read();
	if (!read.ok) return refuse("unreadable", undefined, read.reason);
	const assignment = read.file.assignments.find((a) => a.assignmentId === id);
	if (assignment === undefined) return refuse("not-found", `assignment ${id}`);
	const projection = await hostProjection(root, [assignment.projectId]);
	print({
		coordinationRevision: read.file.revision,
		assignment,
		reading: projection.projects[0]?.assignments.find((a) => a.assignmentId === id) ?? null,
	});
}

export const ASSIGN_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	create: assignCreate,
	supersede: assignSupersede,
	revoke: assignEnd("revoked"),
	close: assignEnd("closed"),
	bind: assignBind,
	unbind: assignUnbind,
	link: assignLink,
	reconfirm: assignReconfirm,
	"clear-hazard": assignClearHazard,
	list: assignList,
	show: assignShow,
};
export const ASSIGN_USAGE_V0 = ASSIGN_USAGE;

// ---- dependencies ------------------------------------------------------------------------------------------------------------------

function depAdd(argv: readonly string[]): void {
	const usage = `usage: endo dep add [<root> | --root dir] --project <id> --dependent <task id> --prerequisite <task id> --condition <${ENDO_DEPENDENCY_CONDITIONS_V0.join("|")}> --revision <file revision>`;
	const { root, flags } = flagsOf(
		argv,
		["--project", "--dependent", "--prerequisite", "--condition", "--revision"],
		usage,
	);
	const r = done(
		new DevelopCoordinationStoreV0(root).addDependency({
			expectedFileRevision: revisionOf(flags, usage),
			projectId: need(flags, "--project", usage),
			dependentTaskId: need(flags, "--dependent", usage),
			prerequisiteTaskId: need(flags, "--prerequisite", usage),
			condition: oneOf<EndoDependencyConditionV0>(
				need(flags, "--condition", usage),
				ENDO_DEPENDENCY_CONDITIONS_V0,
				"--condition",
			),
		}),
	);
	print({ dependency: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(
		`declared dependency ${r.value.dependencyId}: task ${r.value.dependentTaskId} waits on ${r.value.prerequisiteTaskId} (${r.value.condition}).\n${NO_AUTHORITY}`,
	);
}

function depDecide(withdraw: boolean) {
	return (argv: readonly string[]): void => {
		const usage = withdraw
			? "usage: endo dep withdraw-decision [<root> | --root dir] --dependency <id> --revision <dependency revision>"
			: "usage: endo dep decide [<root> | --root dir] --dependency <id> --revision <dependency revision> --rationale <text> --prerequisite-revision <task revision>";
		const { root, flags } = flagsOf(
			argv,
			withdraw
				? ["--dependency", "--revision"]
				: ["--dependency", "--revision", "--rationale", "--prerequisite-revision"],
			usage,
		);
		const r = done(
			new DevelopCoordinationStoreV0(root).decideDependency(
				need(flags, "--dependency", usage),
				revisionOf(flags, usage),
				withdraw ? null : need(flags, "--rationale", usage),
				withdraw ? null : revisionOf(flags, usage, "--prerequisite-revision"),
			),
		);
		print({ dependency: r.value, coordinationRevision: r.revision, commit: r.commit });
		process.stderr.write(
			withdraw
				? "withdrew the operator decision.\n"
				: `recorded your decision, bound to the prerequisite's revision ${r.value.operatorDecision?.prerequisiteTaskRevision}; any edit to that task makes it stale.\n${NO_AUTHORITY}`,
		);
	};
}

function depRemove(argv: readonly string[]): void {
	const usage = "usage: endo dep remove [<root> | --root dir] --dependency <id> --revision <dependency revision>";
	const { root, flags } = flagsOf(argv, ["--dependency", "--revision"], usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).removeDependency(
			need(flags, "--dependency", usage),
			revisionOf(flags, usage),
		),
	);
	print({ removed: r.value, coordinationRevision: r.revision, commit: r.commit });
}

async function depList(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo dep list [<root> | --root dir] --project <id>";
	const { root, flags } = flagsOf(argv, ["--project"], usage);
	const projectId = need(flags, "--project", usage);
	projectOf(root, projectId);
	const projection = await hostProjection(root, [projectId]);
	const project = projection.projects[0];
	print({
		source: projection.source,
		gaps: projection.gaps,
		dependencies: project?.dependencies ?? [],
		readiness: (project?.tasks ?? []).map((t) => ({ taskId: t.taskId, readiness: t.readiness })),
	});
}

export const DEP_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	add: depAdd,
	decide: depDecide(false),
	"withdraw-decision": depDecide(true),
	remove: depRemove,
	list: depList,
};

// ---- candidates --------------------------------------------------------------------------------------------------------------------

async function candidateDeclare(argv: readonly string[]): Promise<void> {
	const usage =
		"usage: endo candidate declare [<root> | --root dir] --project <id> --task <id> --worktree <dir> --commit <full object id> [--attempt <id>] --revision <file revision>";
	const { root, flags } = flagsOf(
		argv,
		["--project", "--task", "--worktree", "--commit", "--attempt", "--revision"],
		usage,
	);
	const project = projectOf(root, need(flags, "--project", usage));
	const expected = revisionOf(flags, usage);
	// Git runs here, BEFORE the store takes its lock: no lock is ever held across a Git subprocess.
	const resolved = await new DevelopCoordinationGitV0().resolveGitCandidate(
		project,
		need(flags, "--worktree", usage),
		need(flags, "--commit", usage),
		flags.get("--attempt") ?? null,
	);
	if (!resolved.ok) return refuse(resolved.code, resolved.detail);
	const r = done(
		new DevelopCoordinationStoreV0(root).declareCandidate({
			expectedFileRevision: expected,
			projectId: project.id,
			taskId: need(flags, "--task", usage),
			candidate: resolved.candidate,
		}),
	);
	print({ candidate: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(
		`declared candidate ${r.value.candidateId} as the current candidate of task ${need(flags, "--task", usage)}${r.value.supersedesCandidateId === null ? "" : `, superseding ${r.value.supersedesCandidateId} (kept, with its history)`}.\na candidate declaration is not task acceptance. ${NO_AUTHORITY}`,
	);
}

function candidateDeclareProtected(argv: readonly string[]): void {
	const usage =
		"usage: endo candidate declare-protected [<root> | --root dir] --project <id> --task <id> --attempt <id> --revision <file revision>";
	const { root, flags } = flagsOf(argv, ["--project", "--task", "--attempt", "--revision"], usage);
	const project = projectOf(root, need(flags, "--project", usage));
	const resolved = resolveProtectedCandidateV0(root, need(flags, "--attempt", usage));
	if (!resolved.ok) refuse(resolved.code, resolved.detail);
	const r = done(
		new DevelopCoordinationStoreV0(root).declareCandidate({
			expectedFileRevision: revisionOf(flags, usage),
			projectId: project.id,
			taskId: need(flags, "--task", usage),
			candidate: resolved.candidate,
		}),
	);
	print({ candidate: r.value, coordinationRevision: r.revision, commit: r.commit });
	process.stderr.write(
		`declared protected candidate ${r.value.candidateId} (experimental, non-authoritative; H0 BLOCKED).\n`,
	);
}

function candidateSelect(argv: readonly string[]): void {
	const usage =
		"usage: endo candidate select [<root> | --root dir] --task <id> --candidate <id|none> --revision <task candidates revision>";
	const { root, flags } = flagsOf(argv, ["--task", "--candidate", "--revision"], usage);
	const chosen = need(flags, "--candidate", usage);
	const r = done(
		new DevelopCoordinationStoreV0(root).selectCandidate(
			need(flags, "--task", usage),
			revisionOf(flags, usage),
			chosen === "none" ? null : chosen,
		),
	);
	print({ selection: r.value, coordinationRevision: r.revision, commit: r.commit });
}

async function candidateList(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo candidate list [<root> | --root dir] --project <id>";
	const { root, flags } = flagsOf(argv, ["--project"], usage);
	const projectId = need(flags, "--project", usage);
	projectOf(root, projectId);
	const read = new DevelopCoordinationStoreV0(root).read();
	if (!read.ok) return refuse("unreadable", undefined, read.reason);
	const projection = await hostProjection(root, [projectId]);
	print({
		coordinationRevision: read.file.revision,
		taskCandidates: read.file.taskCandidates.filter((t) => t.projectId === projectId),
		readings: (projection.projects[0]?.tasks ?? []).filter((t) => t.candidates.length > 0),
	});
}

export const CANDIDATE_COMMANDS_V0: Record<string, (argv: readonly string[]) => void | Promise<void>> = {
	declare: candidateDeclare,
	"declare-protected": candidateDeclareProtected,
	select: candidateSelect,
	list: candidateList,
};

// ---- the host projection -----------------------------------------------------------------------------------------------------------

/** The companion projection read on the host: Git and protected re-verification on, route reservations read. Read-only. */
export function hostProjection(root: string, projects: readonly string[] | null) {
	const git = new DevelopCoordinationGitV0();
	return readEndoCoordinatorCoordinationV0({
		root,
		projects,
		identity: (c) => git.identity(root, c),
		workspace: (path) => git.workspace(path),
	});
}
