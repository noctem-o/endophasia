// DEVELOP-PROTECTED-ATTEMPT-001 (docs/designs/protected-attempt-execution.md): the terminal-authorised protected attempt launcher and the
// read-only reading of what it recorded.
//
// The launcher executes ONE prepared DEVELOP attempt through the existing protected runner and nothing else. In order:
//   1. plan (reads only): the attempt passes the same checks as a workbench send (DevelopAttemptDispatchV0.check), has no protected launch
//      yet, and the operator's template spec is one staged-changeset task, one condition, one trial (endo.protected-experiment-spec.v2,
//      offline; v3 is refused in this version). The spec is constructed from the template with the attempt's own run id and an agent directory that is the template's with
//      /agent/prompt.txt replaced by the frozen brief; the operation (every identity and digest) is shown whole with its digest;
//   2. the operator types the operation's phrase on the controlling terminal (the caller supplies the reading of that line); anything else
//      declines and nothing is written;
//   3. the plan is made again and must have the same digest (a change while the operator read is refused);
//   4. the launch record is written once (develop/protected-attempts/<id>.launch.json): a second launcher of the same attempt stops here;
//   5. the agent directory is built and re-hashed, the spec written, and the caller's protected runner runs it once (never retried, no other
//      way of running);
//   6. the run directory is read back independently (the same reading "endo attempt bridge" makes); only when every check passes, with
//      the agent's scope confirmed ended and the candidate re-verified from its bytes, is the binding sealed and written once.
// It never changes a task's status, never applies a candidate to a checkout, and never runs anything but the protected runner.
//
// The reading (readProtectedAttemptV0) writes nothing, creates nothing and runs nothing.

import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ENDO_ATTEMPT_BINDING_INTEGRITY_V0,
	ENDO_ATTEMPT_BINDING_STANDING_V0,
	ENDO_DEVELOP_ATTEMPT_CANDIDATE_BINDING_SCHEMA_V0,
	ENDO_DEVELOP_PROTECTED_ATTEMPT_LAUNCH_SCHEMA_V0,
	ENDO_DEVELOP_PROTECTED_ATTEMPT_OPERATION_SCHEMA_V0,
	ENDO_DEVELOP_PROTECTED_ATTEMPTS_DIRECTORY_V0,
	ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0,
	type EndoDevelopAttemptCandidateBindingV0,
	type EndoProtectedAttemptAssociationV0,
	type EndoProtectedAttemptCheckV0,
	type EndoProtectedAttemptLaunchV0,
	type EndoProtectedAttemptOperationV0,
	endoProtectedAttemptRunIdV0,
	validateEndoDevelopAttemptCandidateBindingV0,
	validateEndoProtectedAttemptLaunchV0,
} from "../../protocol/develop-attempt-candidate-binding.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0, renderEndoDevelopBriefV0 } from "../../protocol/develop-attempts.ts";
import type { EndoBridgeProtectedExperimentV0 } from "../../protocol/develop-evidence-bridge.ts";
import {
	type EndoProtectedSpec,
	type EndoProtectedSpecV2,
	type EndoProtectedSpecV3,
	readEndoProtectedSpecV0,
} from "../../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	type EndoRecordReadV0,
	endoAssessProtectedAttemptV0,
	endoAttemptCandidateBindingSealOkV0,
	endoProtectedAttemptApprovalPhraseV0,
	endoProtectedAttemptAuthorityV0,
	endoProtectedAttemptLaunchSha256V0,
	endoProtectedAttemptOperationDigestV0,
	renderEndoProtectedAttemptOperationV0,
	sealEndoAttemptCandidateBindingV0,
} from "../../runtime/contracts/develop-attempt-candidate-binding.ts";
import {
	DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0,
	type DevelopAttemptDispatchRefusalV0,
	DevelopAttemptDispatchV0,
} from "../../runtime/contracts/develop-attempt-dispatch.ts";
import { endoBriefSha256V0 } from "../../runtime/contracts/develop-attempt-execution.ts";
import { endoEmptyProtectedBridgeV0 } from "../../runtime/contracts/develop-evidence-bridge.ts";
import { DevelopAttemptRoutesStoreV0 } from "../../storage/develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0, endoAttemptProblemsOfV0 } from "../../storage/develop-attempts.ts";
import { DevelopTasksStoreV0, ENDO_DEVELOP_DIRECTORY_V0 } from "../../storage/develop-tasks.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	writeOnceSyncV0,
} from "../../storage/write-once.ts";
import { endoTreeDigestV0 } from "../sandbox/bubblewrap.ts";
import { inspectProtectedRunForBridgeV0 } from "./evidence-bridge.ts";

/** Closed bounds on everything the launcher and the reading read. */
export const ENDO_PROTECTED_ATTEMPT_LIMITS_V0 = Object.freeze({
	/** The template spec file (it embeds the workspace). */
	maxTemplateBytes: 1024 * 1024,
	/** A launch record or binding file. */
	maxRecordBytes: 64 * 1024,
	/** An agent directory (a Pi condition holds Pi's dist: about 1,200 entries and 22 MB on the measured host). */
	maxAgentEntries: 8192,
	maxAgentBytes: 256 * 1024 * 1024,
	maxAgentDepth: 32,
	/** The prompt file, read back: a brief is at most a workbench prompt. */
	maxPromptBytes: 16 * 1024,
});

const ABS = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9._+\-/]{1,400}$/;
const SAFE_COMPONENT = /^[a-z0-9][a-z0-9-]{0,63}$/;

const developDir = (root: string) => join(root, ENDO_DEVELOP_DIRECTORY_V0);
const protectedDir = (root: string) => join(developDir(root), ENDO_DEVELOP_PROTECTED_ATTEMPTS_DIRECTORY_V0);
const recordPath = (root: string, attemptId: string, kind: "launch" | "candidate") =>
	join(protectedDir(root), `${attemptId}.${kind}.json`);

// ---- bounded, link-refusing tree reading -------------------------------------------------------------------------------------------

type TreeEntry = [string, string, number, string];
export type EndoBoundedTreeV0 =
	| { ok: true; sha256: string; entries: number; bytes: number }
	| { ok: false; reason: string };

/** Read one regular file whole without following a link, within a bound; null on anything else. */
function readPlainFile(path: string, maxBytes: number): { bytes: Buffer; mode: number } | null {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
	let fd: number;
	try {
		const before = lstatSync(path, { bigint: true });
		if (!before.isFile() || before.size > BigInt(maxBytes)) return null;
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.size > BigInt(maxBytes)) return null;
		const size = Number(opened.size);
		const bytes = Buffer.alloc(size);
		let at = 0;
		while (at < bytes.length) {
			const n = readSync(fd, bytes, at, bytes.length - at, at);
			if (n === 0) break;
			at += n;
		}
		const extra = Buffer.alloc(1);
		const grew = readSync(fd, extra, 0, 1, at) > 0;
		const after = fstatSync(fd, { bigint: true });
		if (grew || at !== size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return null;
		return { bytes, mode: Number(opened.mode) };
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * The tree digest endoTreeDigestV0 (adapters/sandbox/bubblewrap.ts) computes, byte for byte the same entries, but bounded and refusing
 * links and special files rather than throwing; optionally with one root-level file's bytes replaced (the prompt). The launcher checks
 * the directory it builds against endoTreeDigestV0 itself, so the two cannot drift silently.
 */
export function endoBoundedTreeDigestV0(
	root: string,
	override?: { name: string; bytes: Buffer },
	limits: { readonly [K in keyof typeof ENDO_PROTECTED_ATTEMPT_LIMITS_V0]: number } = ENDO_PROTECTED_ATTEMPT_LIMITS_V0,
): EndoBoundedTreeV0 {
	const entries: TreeEntry[] = [];
	let bytes = 0;
	const walk = (dir: string, prefix: string, depth: number): string | null => {
		if (depth > limits.maxAgentDepth) return "too deep";
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return `unreadable directory ${prefix}`;
		}
		if (depth === 0 && override !== undefined && !names.includes(override.name)) names.push(override.name);
		for (const name of names.sort()) {
			if (entries.length >= limits.maxAgentEntries) return `more than ${limits.maxAgentEntries} entries`;
			const path = `${dir}/${name}`;
			if (depth === 0 && override !== undefined && name === override.name) {
				const existing = lstatSync(path, { throwIfNoEntry: false });
				if (existing !== undefined && !existing.isFile()) return `${override.name} is not a regular file`;
				if (bytes + override.bytes.length > limits.maxAgentBytes) return `exceeds ${limits.maxAgentBytes} bytes`;
				bytes += override.bytes.length;
				entries.push([name, "file:644", override.bytes.length, sha256HexV0(override.bytes)]);
				continue;
			}
			let s: ReturnType<typeof lstatSync>;
			try {
				s = lstatSync(path);
			} catch {
				return `unreadable entry ${prefix}${name}`;
			}
			if (s.isDirectory()) {
				entries.push([prefix + name, "dir", 0, ""]);
				const problem = walk(path, `${prefix + name}/`, depth + 1);
				if (problem !== null) return problem;
			} else if (s.isFile()) {
				const file = readPlainFile(path, limits.maxAgentBytes - bytes);
				if (file === null) return `unreadable, changing or too large file ${prefix}${name}`;
				bytes += file.bytes.length;
				entries.push([
					prefix + name,
					`file:${(file.mode & 0o755).toString(8)}`,
					file.bytes.length,
					sha256HexV0(file.bytes),
				]);
			} else return `${prefix + name} is a link or special file`;
		}
		return null;
	};
	const top = lstatSync(root, { throwIfNoEntry: false });
	if (top === undefined || !top.isDirectory()) return { ok: false, reason: "not a plain directory" };
	const problem = walk(root, "", 0);
	if (problem !== null) return { ok: false, reason: problem };
	return { ok: true, sha256: sha256HexV0(canonicalEndoJsonV0(entries)), entries: entries.length, bytes };
}

/** Copy a template agent directory into a new directory, bounded, links refused, keeping the permission bits the tree digest records. */
function copyAgentTemplate(template: string, destination: string, prompt: Buffer): void {
	let entries = 0;
	let bytes = 0;
	const copy = (from: string, to: string, depth: number) => {
		if (depth > ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxAgentDepth) throw new Error("the agent template is too deep");
		mkdirSync(to, { mode: 0o755 });
		for (const name of readdirSync(from).sort()) {
			if (depth === 0 && name === ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0) continue;
			if (++entries > ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxAgentEntries)
				throw new Error("the agent template has too many entries");
			const source = join(from, name);
			const s = lstatSync(source);
			if (s.isDirectory()) copy(source, join(to, name), depth + 1);
			else if (s.isFile()) {
				const file = readPlainFile(source, ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxAgentBytes - bytes);
				if (file === null) throw new Error("an agent template file is unreadable, changing or too large");
				bytes += file.bytes.length;
				writeFileSync(join(to, name), file.bytes, { flag: "wx", mode: 0o600 });
				chmodSync(join(to, name), file.mode & 0o755);
			} else throw new Error("the agent template holds a link or special file");
		}
	};
	copy(template, destination, 0);
	if (++entries > ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxAgentEntries)
		throw new Error("the agent template has too many entries");
	if (bytes + prompt.length > ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxAgentBytes)
		throw new Error("the agent template exceeds the byte limit");
	writeFileSync(join(destination, ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0), prompt, { flag: "wx", mode: 0o600 });
	chmodSync(join(destination, ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0), 0o644);
}

// ---- the records -------------------------------------------------------------------------------------------------------------------

function readRecord<T>(path: string, validate: (value: unknown) => T): EndoRecordReadV0<T> {
	const dirs = checkDirectoriesSyncV0([dirname(dirname(path)), dirname(path)]);
	if (dirs === "missing") return { state: "absent" };
	if (dirs !== "ok") return { state: "problem", reason: dirs };
	let present: ReturnType<typeof lstatSync> | undefined;
	try {
		present = lstatSync(path, { throwIfNoEntry: false });
	} catch {
		return { state: "problem", reason: "io" };
	}
	if (present === undefined) return { state: "absent" };
	const read = readBoundedJsonSyncV0(path, ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxRecordBytes);
	if (!read.ok) return { state: "problem", reason: read.reason };
	try {
		return { state: "present", record: validate(read.value) };
	} catch {
		return { state: "problem", reason: "invalid" };
	}
}

/** The attempt's protected launch record and binding, as found. A record under the attempt's name that names another is a problem. */
export function readProtectedAttemptRecordsV0(
	root: string,
	attemptId: string,
): {
	launch: EndoRecordReadV0<EndoProtectedAttemptLaunchV0>;
	binding: EndoRecordReadV0<EndoDevelopAttemptCandidateBindingV0>;
} {
	let launch = readRecord(recordPath(root, attemptId, "launch"), validateEndoProtectedAttemptLaunchV0);
	if (launch.state === "present" && launch.record.attemptId !== attemptId)
		launch = { state: "problem", reason: "misnamed" };
	let binding = readRecord(recordPath(root, attemptId, "candidate"), validateEndoDevelopAttemptCandidateBindingV0);
	if (binding.state === "present" && binding.record.attemptId !== attemptId)
		binding = { state: "problem", reason: "misnamed" };
	if (binding.state === "present" && !endoAttemptCandidateBindingSealOkV0(binding.record))
		binding = { state: "problem", reason: "seal does not match" };
	return { launch, binding };
}

function writeRecord(
	root: string,
	attemptId: string,
	kind: "launch" | "candidate",
	record: object,
	beforeLink?: () => void,
) {
	if (!ensureDirectoriesSyncV0([developDir(root), protectedDir(root)])) return "unsafe-path" as const;
	const bytes = Buffer.from(`${canonicalEndoJsonV0(record as never)}\n`, "utf8");
	if (bytes.length > ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxRecordBytes) return "failed" as const;
	return writeOnceSyncV0(protectedDir(root), `${attemptId}.${kind}.json`, bytes, beforeLink);
}

// ---- the reading -------------------------------------------------------------------------------------------------------------------

const realOrResolved = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

export interface ReadProtectedAttemptOptionsV0 {
	root: string;
	attemptId: string;
	protectedRunDir?: string;
	specPin?: string;
	trial?: string;
}

/**
 * How this attempt relates to a protected candidate, read now: null when the attempt has neither a launch record nor a binding (the bridge
 * then reads exactly as it always has). Reads only: no file or directory is created or changed, and nothing is run.
 */
export function readProtectedAttemptV0(options: ReadProtectedAttemptOptionsV0): EndoBridgeProtectedExperimentV0 | null {
	const { root, attemptId } = options;
	if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return null;
	const { launch, binding } = readProtectedAttemptRecordsV0(root, attemptId);
	if (launch.state === "absent" && binding.state === "absent") return null;

	const attempts = new DevelopAttemptsStoreV0(root).read();
	const entry = attempts.ok ? attempts.entries.find((e) => e.attempt.id === attemptId) : undefined;
	const currentProjectId = entry?.attempt.projectId ?? null;
	const currentTaskId = entry?.attempt.taskId ?? null;
	const currentBriefSha256 = entry === undefined ? null : endoBriefSha256V0(renderEndoDevelopBriefV0(entry.attempt));
	const routeReservation = DevelopAttemptRoutesStoreV0.forRoot(root).read(attemptId);
	const workbenchAuthorized =
		entry?.authorized != null ||
		(attempts.ok && endoAttemptProblemsOfV0(attempts.problems, attemptId).some((p) => p.kind === "authorized")) ||
		(routeReservation.state === "present" && routeReservation.record.route === "workbench");

	const b = binding.state === "present" ? binding.record : null;
	const l = launch.state === "present" ? launch.record : null;
	const runDirectory = b?.target.runDirectory ?? l?.operation.run.directory ?? null;
	const expectedSpec = b?.target.specSha256 ?? l?.operation.run.specSha256 ?? undefined;
	const expectedTrial =
		b !== null
			? `${b.target.trial.task}/${b.target.trial.condition}/${b.target.trial.trial}`
			: l !== null
				? `${l.operation.trial.task}/${l.operation.trial.condition}/0`
				: undefined;
	const trial = options.trial ?? expectedTrial;
	const inspectedDirectory = options.protectedRunDir ?? runDirectory;
	let runDirectoryUnsafe = false;
	if (inspectedDirectory !== null) {
		try {
			const st = lstatSync(inspectedDirectory, { throwIfNoEntry: false });
			if (st !== undefined && !st.isDirectory()) runDirectoryUnsafe = true;
		} catch {
			runDirectoryUnsafe = true;
		}
	}
	const inspected =
		inspectedDirectory === null || runDirectoryUnsafe
			? {
					...endoEmptyProtectedBridgeV0(),
					supplied: true,
					outcome: "unreadable" as const,
					candidateIntegrity: "unreadable" as const,
					candidateDetail: runDirectoryUnsafe
						? "the run directory path is a symbolic link or not a plain directory (refused, never followed)"
						: "no usable record names a run directory",
					problem: runDirectoryUnsafe
						? "the run directory path is a symbolic link or not a plain directory"
						: "no usable record names a run directory",
				}
			: inspectProtectedRunForBridgeV0({
					directory: inspectedDirectory,
					...(expectedSpec === undefined ? {} : { specPin: options.specPin ?? expectedSpec }),
					...(trial === undefined ? {} : { trial }),
				});

	let agentCopy: { treeSha256: string | null; promptSha256: string | null; detail: string } | null = null;
	const condition = inspected.trialCoordinates?.condition;
	if (
		!runDirectoryUnsafe &&
		inspectedDirectory !== null &&
		condition !== undefined &&
		SAFE_COMPONENT.test(condition)
	) {
		const agentsDir = join(inspectedDirectory, ".agents");
		const dirCheck = checkDirectoriesSyncV0([inspectedDirectory, agentsDir]);
		if (dirCheck !== "ok") {
			agentCopy = {
				treeSha256: null,
				promptSha256: null,
				detail: dirCheck === "missing" ? "missing .agents directory" : ".agents directory is not a plain directory",
			};
		} else {
			const copy = join(agentsDir, condition);
			const tree = endoBoundedTreeDigestV0(copy);
			const prompt = readPlainFile(
				join(copy, ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0),
				ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxPromptBytes,
			);
			agentCopy = {
				treeSha256: tree.ok ? tree.sha256 : null,
				promptSha256: prompt === null ? null : sha256HexV0(prompt.bytes),
				detail: tree.ok ? (prompt === null ? "no readable prompt.txt" : "re-hashed") : tree.reason,
			};
		}
	}

	const assessment = endoAssessProtectedAttemptV0({
		attemptId,
		currentProjectId,
		currentTaskId,
		currentBriefSha256,
		workbenchAuthorized,
		launch,
		binding,
		suppliedRunDirectoryMatches:
			options.protectedRunDir === undefined || runDirectory === null
				? null
				: realOrResolved(options.protectedRunDir) === realOrResolved(runDirectory),
		runDirectoryUnsafe,
		suppliedSpecPin: options.specPin ?? null,
		inspected,
		agentCopy,
	});
	const admitted = assessment.association === "established" || assessment.association === "operator-declared";
	return {
		...inspected,
		agentTreeSha256: agentCopy?.treeSha256 ?? null,
		candidateDetail: admitted
			? inspected.candidateDetail.replace(
					/(?:, but|;) has NO stored binding to this DEVELOP attempt\.$/,
					`; bound to this DEVELOP attempt by an ${assessment.association} binding record (integrity evidence, not a signature).`,
				)
			: inspected.candidateDetail,
		attemptAssociation: assessment.association,
		missingBindingRecord: admitted ? null : "develop-attempt-protected-candidate-binding",
		binding: {
			launch: launch.state === "present" ? "present" : launch.state === "absent" ? "absent" : "unusable",
			record: binding.state === "present" ? "present" : binding.state === "absent" ? "absent" : "unusable",
			boundBy: b?.boundBy ?? null,
			standing: admitted ? (b?.boundBy === "controller" ? "controller-established" : "operator-declared") : null,
			operationDigest: l?.operationDigest ?? b?.authorization?.operationDigest ?? null,
			bindingSha256: b?.bindingSha256 ?? null,
			runSource:
				options.protectedRunDir !== undefined
					? "operator-flag"
					: b !== null
						? "binding-record"
						: l !== null
							? "launch-record"
							: null,
			label: assessment.label,
			checks: assessment.checks,
			limitation: assessment.limitation,
		},
	};
}

// ---- the plan ----------------------------------------------------------------------------------------------------------------------

export type EndoProtectedAttemptRefusalV0 =
	| DevelopAttemptDispatchRefusalV0
	| "already-launched"
	| "out-unusable"
	| "template-unreadable"
	| "template-unsupported"
	| "agent-template-unusable"
	| "spec-invalid"
	| "changed-during-approval"
	| "declined";

export const ENDO_PROTECTED_ATTEMPT_REFUSAL_WORDS_V0: Readonly<Record<EndoProtectedAttemptRefusalV0, string>> = {
	...DEVELOP_ATTEMPT_DISPATCH_REFUSAL_WORDS_V0,
	"already-authorized":
		"this attempt was already authorised for a workbench send; one attempt is executed by one route only. Prepare a new attempt",
	"launch-not-registered": "the project's registered directory is gone, so the attempt cannot be checked against it",
	"already-launched":
		"a protected launch or binding already exists for this attempt (or a file at its name is unusable); it is never retried. Prepare a new attempt",
	"out-unusable":
		"--out must be a new absolute path (letters, digits and ._+- only) whose parent is an existing directory; nothing is ever written into an existing one",
	"template-unreadable": "--template must name a regular JSON file (not a link) of at most 1 MiB",
	"template-unsupported":
		"the template must be an endo.protected-experiment-spec.v2 (offline) with exactly one staged-changeset task, one condition and trials 1",
	"agent-template-unusable":
		"the template's agent directory must be a plain directory of regular files (no links, bounded), and prompt.txt, if present, a regular file",
	"spec-invalid": "the constructed spec does not validate",
	"changed-during-approval":
		"the attempt, the task, the template or its agent directory changed while you read the operation; nothing was run",
	declined: "the typed line was not this operation's approval phrase; nothing was written or run",
};

export interface EndoProtectedAttemptPlanV0 {
	operation: EndoProtectedAttemptOperationV0;
	operationDigest: string;
	phrase: string;
	text: string;
	brief: string;
	spec: EndoProtectedSpecV2 | EndoProtectedSpecV3;
	templateAgentDirectory: string;
	outDirectory: string;
}

export type EndoProtectedAttemptPlanResultV0 =
	| { ok: true; plan: EndoProtectedAttemptPlanV0 }
	| { ok: false; code: EndoProtectedAttemptRefusalV0; detail: string };

export interface PlanProtectedAttemptOptionsV0 {
	root: string;
	attemptId: string;
	templatePath: string;
	out: string;
}

/** Everything the operator would approve, computed from the records and files as they are now. Reads only. */
export function planProtectedAttemptV0(options: PlanProtectedAttemptOptionsV0): EndoProtectedAttemptPlanResultV0 {
	const refuse = (code: EndoProtectedAttemptRefusalV0, detail?: string): EndoProtectedAttemptPlanResultV0 => ({
		ok: false,
		code,
		detail: detail ?? ENDO_PROTECTED_ATTEMPT_REFUSAL_WORDS_V0[code],
	});
	const { root, attemptId } = options;
	if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return refuse("bad-request");
	const tasks = new DevelopTasksStoreV0(root);
	const attempts = new DevelopAttemptsStoreV0(root);
	const read = attempts.read();
	if (!read.ok) return refuse("unreadable");
	const entry = read.entries.find((e) => e.attempt.id === attemptId);
	if (entry === undefined)
		return refuse(endoAttemptProblemsOfV0(read.problems, attemptId).length > 0 ? "unreadable" : "not-found");
	const taskFile = tasks.read();
	if (!taskFile.ok) return refuse("tasks-unreadable");
	const project = taskFile.file.projects.find((p) => p.id === entry.attempt.projectId);
	if (project === undefined) return refuse("other-project");
	const existing = readProtectedAttemptRecordsV0(root, attemptId);
	if (existing.launch.state !== "absent" || existing.binding.state !== "absent") return refuse("already-launched");
	const route = DevelopAttemptRoutesStoreV0.forRoot(root).read(attemptId);
	if (route.state === "present")
		return refuse(route.record.route === "workbench" ? "already-authorized" : "already-launched");
	if (route.state === "problem") return refuse("already-launched");
	const checked = new DevelopAttemptDispatchV0(tasks, attempts, {
		projectId: project.id,
		launchDirectory: project.path,
	}).check(attemptId);
	if (!checked.ok) return refuse(checked.code);

	const out = resolve(options.out);
	if (!ABS.test(out) || !ABS.test(join(out, "agent")) || !ABS.test(join(out, "run"))) return refuse("out-unusable");
	if (lstatSync(out, { throwIfNoEntry: false }) !== undefined) return refuse("out-unusable");
	if (lstatSync(dirname(out), { throwIfNoEntry: false })?.isDirectory() !== true) return refuse("out-unusable");

	const templateRead = readBoundedJsonSyncV0(
		resolve(options.templatePath),
		ENDO_PROTECTED_ATTEMPT_LIMITS_V0.maxTemplateBytes,
	);
	if (!templateRead.ok) return refuse("template-unreadable", `--template: ${templateRead.reason}`);
	const template = readEndoProtectedSpecV0(templateRead.value);
	if (!template.ok) return refuse("template-unsupported", `--template: ${template.message}`);
	const t = template.value;
	if (
		t.schemaVersion !== "endo.protected-experiment-spec.v2" ||
		t.tasks.length !== 1 ||
		t.conditions.length !== 1 ||
		t.trials !== 1
	)
		return refuse("template-unsupported");
	const staged = t as EndoProtectedSpecV2 | EndoProtectedSpecV3;
	const task = staged.tasks[0]!;
	const condition = staged.conditions[0]!;

	const brief = checked.value.brief;
	const briefBytes = Buffer.from(brief, "utf8");
	const templateAgent = condition.agent.directory;
	const templateTree = endoBoundedTreeDigestV0(templateAgent);
	const builtTree = endoBoundedTreeDigestV0(templateAgent, {
		name: ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0,
		bytes: briefBytes,
	});
	if (!templateTree.ok || !builtTree.ok)
		return refuse(
			"agent-template-unusable",
			`agent template: ${templateTree.ok ? (builtTree as { reason: string }).reason : templateTree.reason}`,
		);

	const runId = endoProtectedAttemptRunIdV0(attemptId);
	const agentDirectory = join(out, "agent");
	const runDirectory = join(out, "run");
	const constructed = readEndoProtectedSpecV0({
		...staged,
		id: runId,
		description: `DEVELOP attempt ${attemptId}; brief sha256 ${checked.value.briefSha256} at /agent/prompt.txt`,
		conditions: [{ ...condition, agent: { directory: agentDirectory, argv: condition.agent.argv } }],
	});
	if (!constructed.ok) return refuse("spec-invalid", `constructed spec: ${constructed.message}`);
	const spec = constructed.value as EndoProtectedSpecV2 | EndoProtectedSpecV3;
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as unknown as Record<string, unknown>));

	const operation: EndoProtectedAttemptOperationV0 = {
		schemaVersion: ENDO_DEVELOP_PROTECTED_ATTEMPT_OPERATION_SCHEMA_V0,
		attemptId,
		projectId: project.id,
		taskId: checked.value.taskId,
		taskRevision: checked.value.taskRevision,
		briefSha256: checked.value.briefSha256,
		briefBytes: briefBytes.length,
		run: {
			directory: runDirectory,
			id: runId,
			specSchemaVersion: spec.schemaVersion as EndoProtectedAttemptOperationV0["run"]["specSchemaVersion"],
			specSha256,
		},
		trial: { task: task.id, condition: condition.id, trial: 0 },
		agent: {
			directory: agentDirectory,
			templateTreeSha256: templateTree.sha256,
			treeSha256: builtTree.sha256,
			prompt: ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0,
		},
		evaluator: { definitionSha256: task.evaluator.sha256 },
		modelAccess:
			spec.schemaVersion === "endo.protected-experiment-spec.v3"
				? { upstream: spec.modelAccess.upstream, model: spec.modelAccess.model }
				: null,
	};
	const operationDigest = endoProtectedAttemptOperationDigestV0(operation);
	return {
		ok: true,
		plan: {
			operation,
			operationDigest,
			phrase: endoProtectedAttemptApprovalPhraseV0(operationDigest),
			text: renderEndoProtectedAttemptOperationV0(operation, operationDigest, brief),
			brief,
			spec,
			templateAgentDirectory: templateAgent,
			outDirectory: out,
		},
	};
}

// ---- the launch --------------------------------------------------------------------------------------------------------------------

export type EndoProtectedAttemptLaunchStatusV0 =
	| "refused"
	| "declined"
	| "launch-not-recorded"
	| "not-run"
	| "run-failed"
	| "not-bound"
	| "bound";

export interface EndoProtectedAttemptLaunchResultV0 {
	status: EndoProtectedAttemptLaunchStatusV0;
	attemptId: string;
	code: EndoProtectedAttemptRefusalV0 | null;
	detail: string;
	operationDigest: string | null;
	runDirectory: string | null;
	/** The independent reading after the run (the one "endo attempt bridge" makes); null when nothing ran. */
	association: EndoProtectedAttemptAssociationV0 | null;
	checks: EndoProtectedAttemptCheckV0[];
	evaluation: { status: string; cases: { total: number; passed: number } | null } | null;
	bindingSha256: string | null;
}

export interface LaunchProtectedAttemptOptionsV0 extends PlanProtectedAttemptOptionsV0 {
	/** Show the operation and read the operator's one line from the controlling terminal; null when nothing was typed. */
	approve: (plan: EndoProtectedAttemptPlanV0) => Promise<string | null>;
	/** The existing protected runner (cli/experiment-protected.ts runProtectedExperimentV0). The CLI passes only that. */
	runner: (spec: EndoProtectedSpec, directory: string) => Promise<unknown>;
	now?: () => number;
	/** For tests: runs before the binding is linked into place (a throw there leaves only a temporary file, as a crash would). */
	beforeBindingLinkForTests?: () => void;
}

const SEAL_CHECKS = new Set([
	"launch-record",
	"operation-digest",
	"attempt-identity",
	"brief-digest",
	"single-execution-route",
	"run-directory",
	"spec-digest",
	"run-identity",
	"trial-coordinates",
	"trial-record",
	"termination",
	"agent-tree",
	"agent-prompt",
	"candidate",
]);

/** Run one prepared attempt through the protected runner after the operator approved exactly this operation; seal the binding if it verifies. */
export async function launchProtectedAttemptV0(
	options: LaunchProtectedAttemptOptionsV0,
): Promise<EndoProtectedAttemptLaunchResultV0> {
	const now = options.now ?? Date.now;
	const result = (
		status: EndoProtectedAttemptLaunchStatusV0,
		fields: Partial<EndoProtectedAttemptLaunchResultV0>,
	): EndoProtectedAttemptLaunchResultV0 => ({
		status,
		attemptId: options.attemptId,
		code: null,
		detail: "",
		operationDigest: null,
		runDirectory: null,
		association: null,
		checks: [],
		evaluation: null,
		bindingSha256: null,
		...fields,
	});

	const planned = planProtectedAttemptV0(options);
	if (!planned.ok) return result("refused", { code: planned.code, detail: planned.detail });
	const plan = planned.plan;
	const typed = await options.approve(plan);
	const decision = endoProtectedAttemptAuthorityV0(typed, plan.operationDigest);
	if (decision.decision !== "allow")
		return result("declined", {
			code: "declined",
			detail: `${ENDO_PROTECTED_ATTEMPT_REFUSAL_WORDS_V0.declined} (${decision.reason})`,
			operationDigest: plan.operationDigest,
		});

	const again = planProtectedAttemptV0(options);
	if (!again.ok)
		return result("refused", { code: again.code, detail: again.detail, operationDigest: plan.operationDigest });
	if (again.plan.operationDigest !== plan.operationDigest)
		return result("refused", {
			code: "changed-during-approval",
			detail: ENDO_PROTECTED_ATTEMPT_REFUSAL_WORDS_V0["changed-during-approval"],
			operationDigest: plan.operationDigest,
		});

	const recordedAtMs = now();
	const launch: EndoProtectedAttemptLaunchV0 = {
		schemaVersion: ENDO_DEVELOP_PROTECTED_ATTEMPT_LAUNCH_SCHEMA_V0,
		attemptId: options.attemptId,
		recordedAtMs,
		operation: plan.operation,
		operationDigest: plan.operationDigest,
		approvedBy: "operator",
		via: "controlling-terminal-phrase",
	};
	validateEndoProtectedAttemptLaunchV0(JSON.parse(canonicalEndoJsonV0(launch as never)));
	// Atomically claim the shared execution-route reservation before writing the launch record so a concurrent
	// workbench dispatch cannot race past preflight and execute the same attempt.
	const routes = DevelopAttemptRoutesStoreV0.forRoot(options.root);
	const claimed = routes.claim(options.attemptId, "protected", recordedAtMs);
	if (claimed !== "created") {
		if (claimed === "exists") {
			const winner = routes.read(options.attemptId);
			const byWorkbench = winner.state === "present" && winner.record.route === "workbench";
			return result("refused", {
				code: byWorkbench ? "already-authorized" : "already-launched",
				detail: ENDO_PROTECTED_ATTEMPT_REFUSAL_WORDS_V0[byWorkbench ? "already-authorized" : "already-launched"],
				operationDigest: plan.operationDigest,
			});
		}
		return result("launch-not-recorded", {
			code: "storage-failed",
			detail: "the execution-route reservation could not be written, so nothing was created or run",
			operationDigest: plan.operationDigest,
		});
	}
	const written = writeRecord(options.root, options.attemptId, "launch", launch);
	if (written !== "created")
		return result(written === "exists" ? "refused" : "launch-not-recorded", {
			code: written === "exists" ? "already-launched" : "storage-failed",
			detail:
				written === "exists"
					? ENDO_PROTECTED_ATTEMPT_REFUSAL_WORDS_V0["already-launched"]
					: "the launch record could not be written, so nothing was created or run",
			operationDigest: plan.operationDigest,
		});

	// From here the attempt is used: whatever happens, a reader sees the launch record and never a fresh, sendable attempt.
	const runDirectory = plan.operation.run.directory;
	try {
		mkdirSync(plan.outDirectory, { mode: 0o700 });
		copyAgentTemplate(plan.templateAgentDirectory, plan.operation.agent.directory, Buffer.from(plan.brief, "utf8"));
		const built = endoBoundedTreeDigestV0(plan.operation.agent.directory);
		if (
			!built.ok ||
			built.sha256 !== plan.operation.agent.treeSha256 ||
			endoTreeDigestV0(plan.operation.agent.directory) !== built.sha256
		)
			throw new Error("the built agent directory is not the approved tree (the template changed after approval)");
		writeFileSync(join(plan.outDirectory, "spec.json"), `${canonicalEndoJsonV0(plan.spec as never)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		return result("not-run", {
			detail: `launch recorded, nothing run: ${error instanceof Error ? error.message : String(error)}`,
			operationDigest: plan.operationDigest,
			runDirectory,
		});
	}

	let runError: string | null = null;
	try {
		await options.runner(plan.spec, runDirectory);
	} catch (error) {
		runError = error instanceof Error ? error.message : String(error);
	}

	const reading = readProtectedAttemptV0({ root: options.root, attemptId: options.attemptId });
	const evaluation =
		reading?.evaluation === null || reading === null
			? null
			: { status: reading.evaluation.status, cases: reading.evaluation.cases };
	if (reading === null)
		return result("run-failed", { detail: "the launch record is no longer readable", runDirectory });
	const sealable =
		runError === null &&
		reading.attemptAssociation === "incomplete-execution" &&
		reading.agent?.outputDigestVerified !== false &&
		reading.refusedRecords.length === 0 &&
		reading.invalidating.length === 0 &&
		reading.binding.checks.every((c) => !SEAL_CHECKS.has(c.check) || c.result === "pass");
	if (!sealable)
		return result(runError === null ? "not-bound" : "run-failed", {
			detail:
				(runError === null ? "" : `the protected runner stopped: ${runError}. `) +
				"No binding was sealed: " +
				reading.binding.label +
				".",
			operationDigest: plan.operationDigest,
			runDirectory,
			association: reading.attemptAssociation,
			checks: reading.binding.checks,
			evaluation,
		});

	const coordinates = reading.trialCoordinates!;
	const binding = sealEndoAttemptCandidateBindingV0({
		schemaVersion: ENDO_DEVELOP_ATTEMPT_CANDIDATE_BINDING_SCHEMA_V0,
		attemptId: options.attemptId,
		projectId: plan.operation.projectId,
		taskId: plan.operation.taskId,
		briefSha256: plan.operation.briefSha256,
		recordedAtMs: now(),
		boundBy: "controller",
		via: "protected-attempt-launch",
		standing: ENDO_ATTEMPT_BINDING_STANDING_V0.controller,
		authorization: {
			approvedBy: "operator",
			via: "controlling-terminal-phrase",
			operationDigest: plan.operationDigest,
			launchSha256: endoProtectedAttemptLaunchSha256V0(launch),
		},
		target: {
			kind: "protected-experiment",
			runDirectory,
			runId: reading.runId!,
			runSchemaVersion:
				reading.runSchemaVersion as EndoDevelopAttemptCandidateBindingV0["target"]["runSchemaVersion"],
			specSha256: reading.observedSpecSha256!,
			trial: {
				position: coordinates.position,
				task: coordinates.task,
				condition: coordinates.condition,
				trial: coordinates.trial,
				attempt: coordinates.attempt,
			},
			recordSha256: reading.recordSha256!,
			agent: { treeSha256: plan.operation.agent.treeSha256, promptSha256: plan.operation.briefSha256 },
			candidate: {
				mode: "staged-changeset",
				baselineSha256: reading.baselineSha256!,
				changesetSha256: reading.changesetSha256!,
				candidateSha256: reading.candidateSha256!,
			},
		},
		integrity: ENDO_ATTEMPT_BINDING_INTEGRITY_V0,
	});
	validateEndoDevelopAttemptCandidateBindingV0(JSON.parse(canonicalEndoJsonV0(binding as never)));
	let sealed: ReturnType<typeof writeRecord>;
	try {
		sealed = writeRecord(options.root, options.attemptId, "candidate", binding, options.beforeBindingLinkForTests);
	} catch {
		sealed = "failed";
	}
	const after = readProtectedAttemptV0({ root: options.root, attemptId: options.attemptId });
	return result(sealed === "created" && after?.attemptAssociation === "established" ? "bound" : "not-bound", {
		detail:
			sealed === "created"
				? (after?.binding.label ?? "the binding could not be read back")
				: sealed === "exists"
					? "another writer sealed a binding for this attempt first; it was left as it is"
					: "the binding could not be written; the reading stays incomplete-execution",
		operationDigest: plan.operationDigest,
		runDirectory,
		association: after?.attemptAssociation ?? null,
		checks: after?.binding.checks ?? [],
		evaluation,
		bindingSha256: sealed === "created" ? binding.bindingSha256 : null,
	});
}
