// Protected experiments (docs/protected-experiments.md): `endo experiment protected-run` and `endo experiment protected-report`.
//
// The same blocked randomization as `endo experiment run` (planEndoExperimentV0), with each attempt run as an untrusted process in a
// Bubblewrap sandbox whose boundary is checked from inside before the agent starts, its submission collected only after its processes are
// confirmed gone, and its result decided by an independent evaluator in a separate sandbox. Every attempt, including an interrupted one,
// leaves a sealed endo.protected-trial.v0 record; a retry is a new attempt that names the one it retries. Nothing here ever runs an agent
// outside a sandbox: if the boundary cannot be established, the attempt is recorded as refused and the agent is not started.
//
// Layout of a run directory:
//   protected-run.json                                    endo.protected-run.v0: spec, seed, plan, isolation, profiles, evaluators
//   trials/<task>/<condition>/<trial>/attempt-<n>/        one attempt: started.json, preflight.json, agent-started.json, agent.log,
//                                                         work/ (the agent's workspace), submission/ (the trusted copy), record.json

import { randomInt } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	type EndoBubblewrapV0,
	type EndoRuntimeFileV0,
	type EndoSandboxProfileInputV0,
	type EndoSandboxProfileV0,
	endoTreeDigestV0,
	processesInNamespaceV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../adapters/sandbox/bubblewrap.ts";
import {
	ENDO_EVALUATOR_DRIVER_SHA256_V0,
	type EndoLoadedEvaluatorV0,
	evaluateV0,
	loadEvaluatorV0,
	qualifyEvaluatorV0,
} from "../adapters/sandbox/evaluator.ts";
import { type EndoPreflightV0, preflightV0 } from "../adapters/sandbox/preflight.ts";
import { exportSubmissionV0 } from "../adapters/sandbox/submission.ts";
import {
	type EndoProtectedRunV0,
	type EndoProtectedSpecV0,
	type EndoProtectedTrialV0,
	endoProtectedTrialQualifiesV0,
	expectedInvalidating,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	checkEndoProtectedRunV0,
	readEndoProtectedTrialFileV0,
	sealEndoProtectedTrialV0,
} from "../runtime/contracts/protected-experiment.ts";
import { ENDO_EXPERIMENT_ORDERING_V0, planEndoExperimentV0 } from "./experiment.ts";

export const ENDO_PROTECTED_RUNNER_V0 = "endo-protected-runner.1";
const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));

/** Why a protected run did not start. Nothing was run; any record already written is left as it is. */
export class EndoProtectedRefusalV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EndoProtectedRefusalV0";
	}
}

export interface EndoProtectedRunOptionsV0 {
	spec: EndoProtectedSpecV0;
	dir: string;
	/** Start a new attempt, naming the one it retries, for an attempt that was interrupted. Off by default: attrition stays attrition. */
	retryInterrupted?: boolean;
	/** At most this many new attempts in this session. */
	maxAttempts?: number;
	/** For tests: where to look for bubblewrap (default: the fixed system path). */
	bwrapCandidates?: readonly string[];
	/** For tests only: weaken a condition's agent profile, to show the preflight refuses it. Never reachable from the CLI. */
	unsafeForTests?: Record<string, EndoSandboxProfileInputV0["unsafeForTests"]>;
	/** For tests: called with an attempt directory once the agent's sandbox has started. */
	onAgentStarted?: (attemptDir: string) => void;
}

export interface EndoProtectedRunSummaryV0 {
	dir: string;
	attempts: number;
	finalizedOnResume: number;
	skipped: number;
}

const writeJsonAtomically = (path: string, value: unknown) => {
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeSync(fd, canonicalEndoJsonV0(value as Record<string, unknown>));
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
};
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const AGENT_ENV = { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" } as const;

interface Prepared {
	bwrap: EndoBubblewrapV0;
	runtime: EndoRuntimeFileV0[];
	node: string;
	evaluators: Map<string, EndoLoadedEvaluatorV0>;
	/** Per condition, the digest of its agent directory's tree: part of the profile, so changed agent code is a different profile. */
	agents: Map<string, string>;
}

/** The agent's profile for one attempt. Its digest depends on roles, not paths, so it is the same for every attempt of a condition. */
function agentProfile(
	p: Prepared,
	spec: EndoProtectedSpecV0,
	condition: EndoProtectedSpecV0["conditions"][number],
	work: string,
	unsafe: EndoSandboxProfileInputV0["unsafeForTests"],
): EndoSandboxProfileV0 {
	return buildSandboxProfileV0({
		runtime: p.runtime,
		mounts: [
			{
				target: "/agent",
				kind: "ro-dir",
				role: "agent",
				source: condition.agent.directory,
				sha256: p.agents.get(condition.id) as string,
			},
			{ target: "/work", kind: "rw-dir", role: "workspace", source: work },
		],
		env: AGENT_ENV,
		cwd: "/work",
		tmpfsBytes: spec.limits.tmpfsBytes,
		...(unsafe === undefined ? {} : { unsafeForTests: unsafe }),
	});
}

/** Detect and check everything a run needs, before anything runs. Refuses with the reason; never falls back. */
function prepare(spec: EndoProtectedSpecV0, candidates: readonly string[] | undefined): Prepared {
	const detected = detectBubblewrapV0(candidates);
	if (!detected.ok) throw new EndoProtectedRefusalV0(`isolation unavailable (${detected.reason}): ${detected.detail}`);
	const runtime = resolveRuntimeV0(spec.runtime.executables);
	if (!runtime.ok) throw new EndoProtectedRefusalV0(`runtime refused (${runtime.reason}): ${runtime.detail}`);
	const node = spec.runtime.executables.find((e) => e.endsWith("/node"));
	if (node === undefined)
		throw new EndoProtectedRefusalV0(
			"runtime.executables must include node: the boundary probe and the evaluator run on it",
		);
	const agents = new Map<string, string>();
	for (const c of spec.conditions) {
		if (!existsSync(c.agent.directory))
			throw new EndoProtectedRefusalV0(`condition ${c.id}: the agent directory does not exist`);
		try {
			agents.set(c.id, endoTreeDigestV0(c.agent.directory));
		} catch (error) {
			throw new EndoProtectedRefusalV0(`condition ${c.id}: ${(error as Error).message}`);
		}
	}
	const evaluators = new Map<string, EndoLoadedEvaluatorV0>();
	for (const t of spec.tasks) {
		const loaded = loadEvaluatorV0(t.evaluator.file, t.evaluator.sha256, t.submission);
		if (!loaded.ok) throw new EndoProtectedRefusalV0(`task ${t.id}: ${loaded.detail}`);
		evaluators.set(t.id, loaded.evaluator);
	}
	return { bwrap: detected.bwrap, runtime: runtime.files, node, evaluators, agents };
}

const attemptsOf = (trialDir: string): number[] =>
	existsSync(trialDir)
		? readdirSync(trialDir)
				.map((n) => /^attempt-([1-9][0-9]*)$/.exec(n))
				.filter((m): m is RegExpExecArray => m !== null)
				.map((m) => Number(m[1]))
				.sort((a, b) => a - b)
		: [];

/** Host paths whose absence inside the sandbox the preflight checks. */
function protectedTargets(dir: string, task: EndoLoadedEvaluatorV0, spec: EndoProtectedSpecV0, condition: string) {
	const uid = process.getuid?.() ?? 0;
	const agentSource = spec.conditions.find((c) => c.id === condition)?.agent.directory ?? "/";
	return {
		protectedPaths: {
			"host-home": homedir(),
			repository: resolve(REPOSITORY),
			// The research archive (research/DATA.md), resolved as research/data.ts does; production code does not import research.
			"research-data": resolve(process.env.ENDO_RESEARCH_DATA ?? join(REPOSITORY, "..", "endophasia-research")),
			"run-directory": dir,
			"other-trials": join(dir, "trials"),
			"evaluator-directory": task.directory,
			"agent-source": agentSource,
		},
		readOnly: [...spec.runtime.executables, "/agent/.endo-probe", "/usr/.endo-probe"],
		writable: "/work",
		environment: [...Object.keys(AGENT_ENV), "PWD"],
		sockets: [
			`/run/user/${uid}`,
			"/run/dbus/system_bus_socket",
			"/var/run/docker.sock",
			"/run/docker.sock",
			"/run/systemd/private",
			"/tmp/.X11-unix",
			...(process.env.SSH_AUTH_SOCK?.startsWith("/") ? [process.env.SSH_AUTH_SOCK] : []),
		],
	};
}

function recordBase(
	run: EndoProtectedRunV0,
	entry: EndoProtectedRunV0["plan"][number],
	attempt: number,
	retryOf: number | null,
	profile: EndoSandboxProfileV0,
	evaluator: EndoLoadedEvaluatorV0,
) {
	return {
		schemaVersion: "endo.protected-trial.v0" as const,
		run: { id: run.spec.id, specSha256: run.specSha256, seed: run.seed },
		trial: { ...entry, attempt, retryOf },
		isolation: {
			mechanism: "bubblewrap" as const,
			version: run.isolation.version,
			executableSha256: run.isolation.executableSha256,
			profileSha256: profile.sha256,
			requested: {
				namespaces: profile.logical.namespaces,
				network: profile.logical.network,
				rootReadOnly: profile.logical.rootReadOnly,
				userNamespacesDisabled: profile.logical.userNamespacesDisabled,
				environment: profile.logical.environment,
				mounts: profile.logical.mounts.map((m) => ({
					target: m.target,
					kind: m.kind as EndoProtectedTrialV0["isolation"]["requested"]["mounts"][number]["kind"],
					role: m.role,
					sha256: m.sha256,
				})),
			},
		},
		evaluationIdentity: { definitionSha256: evaluator.sha256, driverSha256: ENDO_EVALUATOR_DRIVER_SHA256_V0 },
	};
}

/** Seal and write a record, deriving its invalidating conditions from its facts. */
function finish(
	path: string,
	base: ReturnType<typeof recordBase>,
	facts: Pick<EndoProtectedTrialV0, "preflight" | "agent" | "submission" | "controller"> & {
		evaluation: Pick<EndoProtectedTrialV0["evaluation"], "status" | "cases" | "reason" | "outputSha256">;
	},
): EndoProtectedTrialV0 {
	const { evaluationIdentity, ...rest } = base;
	const network = {
		mode: "none" as const,
		relay: null,
		status:
			facts.preflight.status === "established"
				? ("established" as const)
				: facts.preflight.status === "failed"
					? ("failed" as const)
					: ("unavailable" as const),
	};
	const record = sealEndoProtectedTrialV0({
		...rest,
		preflight: facts.preflight,
		network,
		agent: facts.agent,
		submission: facts.submission,
		evaluation: { ...evaluationIdentity, ...facts.evaluation },
		controller: facts.controller,
		invalidating: expectedInvalidating(
			facts.controller.finalized,
			facts.preflight.status,
			facts.agent,
			facts.submission.status,
			facts.evaluation.status,
		),
		recordedAt: new Date().toISOString(),
	});
	writeJsonAtomically(path, record);
	return record;
}

const NOT_COLLECTED = { status: "not-collected" as const, files: [], sha256: null, refusals: [] };
const NOT_RUN = { status: "not-run" as const, cases: null, reason: null, outputSha256: null };

/** An attempt the controller stopped during: written from what its directory shows, nothing assumed. */
function finalizeOnResume(attemptDir: string, base: ReturnType<typeof recordBase>): EndoProtectedTrialV0 {
	const preflight: EndoPreflightV0 = existsSync(join(attemptDir, "preflight.json"))
		? (readJson(join(attemptDir, "preflight.json")) as EndoPreflightV0)
		: { status: "unavailable", probes: [], reason: "the controller stopped before the boundary was checked" };
	let agent: EndoProtectedTrialV0["agent"];
	if (preflight.status !== "established")
		agent = {
			status: "not-run",
			exitCode: null,
			signal: null,
			durationMs: null,
			termination: "not-applicable",
			outputSha256: null,
		};
	else {
		// The agent may have started. Its sandbox died with the controller (it dies with its parent); check, and kill anything left.
		let termination: "confirmed" | "unconfirmed" = "unconfirmed";
		if (existsSync(join(attemptDir, "agent-started.json"))) {
			const ns = (readJson(join(attemptDir, "agent-started.json")) as { pidNamespace: number }).pidNamespace;
			for (const pid of processesInNamespaceV0(ns))
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// gone
				}
			termination = processesInNamespaceV0(ns).length === 0 ? "confirmed" : "unconfirmed";
		}
		agent = {
			status: "interrupted",
			exitCode: null,
			signal: null,
			durationMs: null,
			termination,
			outputSha256: null,
		};
	}
	return finish(join(attemptDir, "record.json"), base, {
		preflight,
		agent,
		submission: NOT_COLLECTED,
		evaluation: NOT_RUN,
		controller: { finalized: "on-resume" },
	});
}

async function runAttempt(
	p: Prepared,
	run: EndoProtectedRunV0,
	entry: EndoProtectedRunV0["plan"][number],
	attemptDir: string,
	base: ReturnType<typeof recordBase>,
	profile: EndoSandboxProfileV0,
	options: EndoProtectedRunOptionsV0,
): Promise<EndoProtectedTrialV0> {
	const spec = run.spec;
	const task = spec.tasks.find((t) => t.id === entry.task)!;
	const condition = spec.conditions.find((c) => c.id === entry.condition)!;
	const evaluator = p.evaluators.get(task.id)!;
	const work = join(attemptDir, "work");
	const record = join(attemptDir, "record.json");
	const preflight = await preflightV0(
		p.bwrap,
		profile,
		p.node,
		protectedTargets(options.dir, evaluator, spec, condition.id),
	);
	writeJsonAtomically(join(attemptDir, "preflight.json"), preflight);
	if (preflight.status !== "established")
		return finish(record, base, {
			preflight,
			agent: {
				status: "not-run",
				exitCode: null,
				signal: null,
				durationMs: null,
				termination: "not-applicable",
				outputSha256: null,
			},
			submission: NOT_COLLECTED,
			evaluation: NOT_RUN,
			controller: { finalized: "normally" },
		});
	const ran = await runSandboxV0(p.bwrap, profile, condition.agent.argv, {
		timeoutMs: spec.limits.agentTimeoutMs,
		outputBytes: spec.limits.outputBytes,
		onStarted: (pidNamespace) => {
			writeJsonAtomically(join(attemptDir, "agent-started.json"), { pidNamespace });
			options.onAgentStarted?.(attemptDir);
		},
	});
	const output = Buffer.concat([ran.stdout, ran.stderr]);
	writeFileSync(join(attemptDir, "agent.log"), output, { mode: 0o600 });
	const agent: EndoProtectedTrialV0["agent"] = {
		status: !ran.started
			? "failed-to-start"
			: ran.timedOut
				? "timed-out"
				: ran.exitCode === 0
					? "completed"
					: "exited-nonzero",
		exitCode: ran.exitCode !== null && ran.exitCode >= 0 && ran.exitCode <= 255 ? ran.exitCode : null,
		signal: ran.signal,
		durationMs: ran.durationMs,
		termination: ran.termination,
		outputSha256: sha256HexV0(output),
	};
	if (agent.termination !== "confirmed" || !ran.started)
		return finish(record, base, {
			preflight,
			agent,
			submission: NOT_COLLECTED,
			evaluation: NOT_RUN,
			controller: { finalized: "normally" },
		});
	const submission = exportSubmissionV0(work, task.submission, spec.limits, join(attemptDir, "submission"));
	const evaluation =
		submission.status === "collected"
			? await evaluateV0(
					{ bwrap: p.bwrap, runtime: p.runtime, node: p.node, limits: spec.limits },
					evaluator,
					join(attemptDir, "submission"),
					join(attemptDir, ".evaluation"),
				)
			: NOT_RUN;
	return finish(record, base, { preflight, agent, submission, evaluation, controller: { finalized: "normally" } });
}

/** Run, or resume, a protected experiment. Refuses (EndoProtectedRefusalV0) before running anything when anything it needs is wrong. */
export async function runProtectedExperimentV0(options: EndoProtectedRunOptionsV0): Promise<EndoProtectedRunSummaryV0> {
	const spec = options.spec;
	const dir = resolve(options.dir);
	const p = prepare(spec, options.bwrapCandidates);
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as unknown as Record<string, unknown>));
	const profiles = spec.conditions.map((c) => ({
		condition: c.id,
		sha256: agentProfile(p, spec, c, "/nonexistent-workspace", options.unsafeForTests?.[c.id]).sha256,
	}));
	const runPath = join(dir, "protected-run.json");
	let run: EndoProtectedRunV0;
	const scratch = join(dir, ".qualification", `session-${process.pid}-${Date.now()}`);
	const qualify = async () => {
		const out: EndoProtectedRunV0["evaluators"] = [];
		for (const t of spec.tasks) {
			const ev = p.evaluators.get(t.id)!;
			const q = await qualifyEvaluatorV0(
				{ bwrap: p.bwrap, runtime: p.runtime, node: p.node, limits: spec.limits },
				ev,
				t.submission,
				join(scratch, t.id),
			);
			if (!q.ok) throw new EndoProtectedRefusalV0(`task ${t.id}: ${q.detail}`);
			out.push({
				task: t.id,
				definitionSha256: ev.sha256,
				driverSha256: ENDO_EVALUATOR_DRIVER_SHA256_V0,
				reference: "passed",
				negative: q.negative,
			});
		}
		return out;
	};
	mkdirSync(dir, { recursive: true });
	if (existsSync(runPath)) {
		const read = checkEndoProtectedRunV0(readJson(runPath));
		if (!read.ok) throw new EndoProtectedRefusalV0(`the existing run record is not readable: ${read.reason}`);
		run = read.value;
		const same =
			run.specSha256 === specSha256 &&
			run.isolation.executableSha256 === p.bwrap.sha256 &&
			run.isolation.version === p.bwrap.version &&
			canonicalEndoJsonV0(run.profiles) === canonicalEndoJsonV0(profiles) &&
			run.evaluators.every(
				(e) =>
					e.definitionSha256 === p.evaluators.get(e.task)?.sha256 &&
					e.driverSha256 === ENDO_EVALUATOR_DRIVER_SHA256_V0,
			);
		if (!same)
			throw new EndoProtectedRefusalV0(
				"a protected run resumes only under the identical spec, isolation, agent profiles and evaluators; start a new run directory",
			);
		const evaluators = await qualify();
		if (canonicalEndoJsonV0(evaluators) !== canonicalEndoJsonV0(run.evaluators))
			throw new EndoProtectedRefusalV0("the evaluators no longer qualify as they did when the run began");
	} else {
		const seed = spec.seed ?? randomInt(0, 0x100000000);
		const evaluators = await qualify();
		run = {
			schemaVersion: "endo.protected-run.v0",
			runner: ENDO_PROTECTED_RUNNER_V0,
			spec,
			specSha256,
			seed,
			seedSource: spec.seed === null ? "drawn" : "spec",
			ordering: ENDO_EXPERIMENT_ORDERING_V0,
			plan: planEndoExperimentV0(spec, seed),
			isolation: { mechanism: "bubblewrap", version: p.bwrap.version, executableSha256: p.bwrap.sha256 },
			profiles,
			evaluators,
			createdAt: new Date().toISOString(),
		};
		const back = checkEndoProtectedRunV0(run);
		if (!back.ok) throw new EndoProtectedRefusalV0(`refusing to write an unreadable run record: ${back.reason}`);
		writeJsonAtomically(runPath, run);
	}
	const summary: EndoProtectedRunSummaryV0 = { dir, attempts: 0, finalizedOnResume: 0, skipped: 0 };
	for (const entry of run.plan) {
		const task = spec.tasks.find((t) => t.id === entry.task)!;
		const condition = spec.conditions.find((c) => c.id === entry.condition)!;
		const evaluator = p.evaluators.get(task.id)!;
		const trialDir = join(dir, "trials", entry.task, entry.condition, String(entry.trial));
		const attempts = attemptsOf(trialDir);
		const unsafe = options.unsafeForTests?.[condition.id];
		let retryOf: number | null = null;
		const latest = attempts.at(-1);
		if (latest !== undefined) {
			const latestDir = join(trialDir, `attempt-${latest}`);
			let rec: EndoProtectedTrialV0;
			if (existsSync(join(latestDir, "record.json"))) {
				const read = readEndoProtectedTrialFileV0(join(latestDir, "record.json"));
				if (!read.ok) throw new EndoProtectedRefusalV0(`attempt ${latestDir}: ${read.reason}`);
				rec = read.value;
			} else {
				const profile = agentProfile(p, spec, condition, join(latestDir, "work"), unsafe);
				const started = existsSync(join(latestDir, "started.json"))
					? (readJson(join(latestDir, "started.json")) as { retryOf: number | null }).retryOf
					: latest > 1
						? latest - 1
						: null;
				rec = finalizeOnResume(latestDir, recordBase(run, entry, latest, started, profile, evaluator));
				summary.finalizedOnResume++;
			}
			const interrupted = rec.invalidating.includes("controller-interrupted") || rec.agent.status === "interrupted";
			if (!(interrupted && options.retryInterrupted === true)) {
				summary.skipped++;
				continue;
			}
			retryOf = latest;
		}
		if (options.maxAttempts !== undefined && summary.attempts >= options.maxAttempts) break;
		const attempt = (latest ?? 0) + 1;
		const attemptDir = join(trialDir, `attempt-${attempt}`);
		mkdirSync(dirname(attemptDir), { recursive: true });
		mkdirSync(attemptDir);
		writeJsonAtomically(join(attemptDir, "started.json"), { attempt, retryOf, startedAt: new Date().toISOString() });
		const work = join(attemptDir, "work");
		mkdirSync(work);
		for (const [path, content] of Object.entries(task.workspace)) {
			mkdirSync(dirname(join(work, path)), { recursive: true });
			writeFileSync(join(work, path), content, { flag: "wx" });
		}
		const profile = agentProfile(p, spec, condition, work, unsafe);
		const base = recordBase(run, entry, attempt, retryOf, profile, evaluator);
		await runAttempt(p, run, entry, attemptDir, base, profile, options);
		summary.attempts++;
	}
	return summary;
}

// ---- the report -----------------------------------------------------------------------------------------------------------------------------

export interface EndoProtectedReportV0 {
	schemaVersion: "endo.protected-report.v0";
	run: { id: string; specSha256: string; seed: number; isolation: EndoProtectedRunV0["isolation"] };
	/** How each kind of outcome enters an analysis. */
	rules: string[];
	cells: {
		task: string;
		condition: string;
		planned: number;
		attempted: number;
		notAttempted: number;
		attempts: number;
		retries: number;
		qualified: number;
		passed: number;
		failed: number;
		attrition: Record<string, number>;
	}[];
	refusedRecords: { path: string; reason: string }[];
}

/** Every attempt of a run, read independently: each record by its own version and digests, none trusted from another. */
export function reportProtectedExperimentV0(directory: string): EndoProtectedReportV0 {
	const dir = resolve(directory);
	const read = checkEndoProtectedRunV0(readJson(join(dir, "protected-run.json")));
	if (!read.ok) throw new EndoProtectedRefusalV0(`the run record is not readable: ${read.reason}`);
	const run = read.value;
	const refusedRecords: EndoProtectedReportV0["refusedRecords"] = [];
	const cells = new Map<string, EndoProtectedReportV0["cells"][number]>();
	for (const t of run.spec.tasks)
		for (const c of run.spec.conditions)
			cells.set(`${t.id}/${c.id}`, {
				task: t.id,
				condition: c.id,
				planned: 0,
				attempted: 0,
				notAttempted: 0,
				attempts: 0,
				retries: 0,
				qualified: 0,
				passed: 0,
				failed: 0,
				attrition: {},
			});
	for (const entry of run.plan) {
		const cell = cells.get(`${entry.task}/${entry.condition}`)!;
		cell.planned++;
		const trialDir = join(dir, "trials", entry.task, entry.condition, String(entry.trial));
		const attempts = attemptsOf(trialDir);
		if (attempts.length === 0) {
			cell.notAttempted++;
			continue;
		}
		cell.attempted++;
		let final: EndoProtectedTrialV0 | null = null;
		for (const n of attempts) {
			cell.attempts++;
			// The trial's outcome is its last attempt's; an unreadable last record is attrition, never replaced by an earlier one.
			final = null;
			const path = join(trialDir, `attempt-${n}`, "record.json");
			const rel = path.slice(dir.length + 1);
			if (!existsSync(path)) {
				refusedRecords.push({ path: rel, reason: "no record (the attempt was not finalized)" });
				continue;
			}
			const r = readEndoProtectedTrialFileV0(path);
			if (!r.ok) {
				refusedRecords.push({ path: rel, reason: r.reason });
				continue;
			}
			const v = r.value;
			const coordinates =
				v.trial.position === entry.position &&
				v.trial.task === entry.task &&
				v.trial.condition === entry.condition &&
				v.trial.trial === entry.trial &&
				v.trial.attempt === n &&
				v.run.specSha256 === run.specSha256 &&
				v.run.seed === run.seed;
			if (!coordinates) {
				refusedRecords.push({ path: rel, reason: "the record is not this run's attempt at these coordinates" });
				continue;
			}
			if (v.trial.retryOf !== null) cell.retries++;
			final = v;
		}
		if (final === null) {
			cell.attrition["record-refused"] = (cell.attrition["record-refused"] ?? 0) + 1;
			continue;
		}
		if (endoProtectedTrialQualifiesV0(final)) {
			cell.qualified++;
			if (final.evaluation.status === "passed") cell.passed++;
			else cell.failed++;
		} else {
			const reason = final.invalidating[0] ?? final.evaluation.status;
			cell.attrition[reason] = (cell.attrition[reason] ?? 0) + 1;
		}
	}
	return {
		schemaVersion: "endo.protected-report.v0",
		run: { id: run.spec.id, specSha256: run.specSha256, seed: run.seed, isolation: run.isolation },
		rules: [
			"planned counts every randomized trial; none is ever removed",
			"qualified: the boundary was established and checked, the agent's termination confirmed, the submission collected, and the independent evaluator ran",
			"passed and failed are counted among qualified trials only; a failure is the evaluator's, never inferred from missing evidence",
			"attrition (by its first invalidating condition) and notAttempted are reported beside them, never as failures, and stay in the planned denominator",
			"a retry is a new attempt naming the one it retries; the trial's outcome is its last attempt's (an unreadable one is attrition), and every attempt stays counted",
		],
		cells: [...cells.values()],
		refusedRecords,
	};
}

// ---- commands ---------------------------------------------------------------------------------------------------------------------------------

export async function experimentProtectedRunCommand(argv: readonly string[]): Promise<void> {
	const args = [...argv];
	const flag = (name: string) => {
		const i = args.indexOf(name);
		if (i === -1) return false;
		args.splice(i, 1);
		return true;
	};
	const take = (name: string) => {
		const i = args.indexOf(name);
		if (i === -1) return undefined;
		const v = args[i + 1];
		if (v === undefined || v.startsWith("--")) throw new TypeError(`the flag ${name} needs a value`);
		args.splice(i, 2);
		return v;
	};
	const retryInterrupted = flag("--retry-interrupted");
	const out = take("--out");
	const max = take("--max-attempts");
	if (args.length !== 1 || out === undefined || (args[0] as string).startsWith("--"))
		throw new TypeError(
			"usage: endo experiment protected-run <spec.json> --out <dir> [--retry-interrupted] [--max-attempts n]",
		);
	const read = readEndoProtectedSpecV0(readJson(args[0] as string));
	if (!read.ok) throw new TypeError(`${args[0]}: ${read.message}`);
	const summary = await runProtectedExperimentV0({
		spec: read.value,
		dir: out,
		retryInterrupted,
		...(max === undefined ? {} : { maxAttempts: Number(max) }),
	});
	process.stdout.write(canonicalEndoJsonV0(summary as unknown as Record<string, unknown>));
}

export async function experimentProtectedReportCommand(argv: readonly string[]): Promise<void> {
	if (argv.length !== 1) throw new TypeError("usage: endo experiment protected-report <dir>");
	process.stdout.write(
		canonicalEndoJsonV0(reportProtectedExperimentV0(argv[0] as string) as unknown as Record<string, unknown>),
	);
}
