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
	chmodSync,
	closeSync,
	constants,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	type EndoBubblewrapV0,
	type EndoProcessIdentityV0,
	type EndoRuntimeFileV0,
	type EndoSandboxProfileInputV0,
	type EndoSandboxProfileV0,
	endoTreeDigestV0,
	endSandboxV0,
	processAliveV0,
	processStartTimeV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0, type EndoContainmentV0, stopScopeV0 } from "../adapters/sandbox/containment.ts";
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
	endoProtectedTrialOutcomeV0,
	expectedInvalidating,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	checkEndoProtectedRunV0,
	readEndoProtectedTrialFileV0,
	sealEndoProtectedTrialV0,
} from "../runtime/contracts/protected-experiment.ts";
import { writeAllSyncV0 } from "../runtime/contracts/write-all.ts";
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
	/** For tests: which systemd tools to use (default: the fixed system paths). */
	containmentTools?: { systemdRun?: string; systemctl?: string };
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
		writeAllSyncV0(fd, canonicalEndoJsonV0(value as Record<string, unknown>));
		closeSync(fd);
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
};
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** Write a record that must never be replaced: linked into place, which fails if the name exists. */
const writeJsonOnce = (path: string, value: unknown) => {
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeAllSyncV0(fd, canonicalEndoJsonV0(value as Record<string, unknown>));
		closeSync(fd);
		linkSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
};

const AGENT_ENV = { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" } as const;

interface Prepared {
	bwrap: EndoBubblewrapV0;
	containment: EndoContainmentV0;
	runtime: EndoRuntimeFileV0[];
	node: string;
	evaluators: Map<string, EndoLoadedEvaluatorV0>;
	/** Per condition, the digest of its agent directory's tree: part of the profile, so changed agent code is a different profile. */
	agents: Map<string, string>;
	/** Per condition, the controller-private copy that is mounted (made once the run directory is locked). */
	agentCopies: Map<string, string>;
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
				source: p.agentCopies.get(condition.id) ?? condition.agent.directory,
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
/** The real path, through the nearest existing ancestor when the path does not exist yet (so a link on the way is still resolved). */
const realOrResolved = (path: string): string => {
	let head = resolve(path);
	const rest: string[] = [];
	while (!existsSync(head)) {
		const parent = resolve(head, "..");
		if (parent === head) break;
		rest.unshift(head.slice(parent.length).replace(/^\/+/, ""));
		head = parent;
	}
	try {
		return join(realpathSync(head), ...rest);
	} catch {
		return resolve(path);
	}
};

/** Every file's content digest under a tree (links and special files skipped: they are refused where it matters). */
function contentDigests(declared: string, into: Set<string>, top = true): void {
	// A declared root (a reference or negative directory) is resolved first: qualification follows a link there, so must this. Inside the
	// tree, links are not followed (the exported copy refuses them anyway).
	let root = declared;
	if (top)
		try {
			root = realpathSync(declared);
		} catch {
			return;
		}
	const s = lstatSync(root, { throwIfNoEntry: false });
	if (s === undefined) return;
	if (s.isFile()) {
		// Empty files carry nothing hidden, and would match any other empty file.
		if (s.size > 0) into.add(sha256HexV0(readFileSync(root)));
		return;
	}
	if (!s.isDirectory()) return;
	for (const name of readdirSync(root)) contentDigests(join(root, name), into, false);
}
const contains = (outer: string, inner: string): boolean =>
	inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

/**
 * The agent's directory is the one host tree, besides its own workspace, that its sandbox shows. It must not hold, or be held in, anything
 * the agent must not see: an evaluator (cases, reference, negative), or the run directory (other trials, records, qualification copies);
 * and it must not hold the repository, the research archive or the home directory. Compared by real path, both ways.
 */
function agentOverlap(agentDir: string, dir: string, evaluatorPaths: readonly string[]): string | null {
	const agent = realOrResolved(agentDir);
	const both: [string, string][] = [
		...evaluatorPaths.map((e): [string, string] => ["an evaluator's material", realOrResolved(e)]),
		["the run directory", realOrResolved(dir)],
	];
	for (const [what, path] of both) if (contains(agent, path) || contains(path, agent)) return `it overlaps ${what}`;
	const held: [string, string][] = [
		["the repository", realOrResolved(REPOSITORY)],
		["the research archive", realOrResolved(researchData())],
		["the home directory", realOrResolved(homedir())],
	];
	for (const [what, path] of held) if (contains(agent, path)) return `it contains ${what}`;
	return null;
}

/** The research archive (research/DATA.md), resolved as research/data.ts does; production code does not import research. */
const researchData = () => resolve(process.env.ENDO_RESEARCH_DATA ?? join(REPOSITORY, "..", "endophasia-research"));

async function prepare(
	spec: EndoProtectedSpecV0,
	candidates: readonly string[] | undefined,
	dir: string,
	containmentTools: { systemdRun?: string; systemctl?: string } | undefined,
): Promise<Prepared> {
	const detected = detectBubblewrapV0(candidates);
	if (!detected.ok) throw new EndoProtectedRefusalV0(`isolation unavailable (${detected.reason}): ${detected.detail}`);
	// Process containment is part of the boundary: without a user manager that can hold each sandbox in its own scope, nothing runs.
	const contained = await detectContainmentV0(containmentTools);
	if (!contained.ok) throw new EndoProtectedRefusalV0(`process containment unavailable: ${contained.detail}`);
	const runtime = resolveRuntimeV0(spec.runtime.executables);
	if (!runtime.ok) throw new EndoProtectedRefusalV0(`runtime refused (${runtime.reason}): ${runtime.detail}`);
	const node = spec.runtime.executables.find((e) => e.endsWith("/node"));
	if (node === undefined)
		throw new EndoProtectedRefusalV0(
			"runtime.executables must include node: the boundary probe and the evaluator run on it",
		);
	const evaluators = new Map<string, EndoLoadedEvaluatorV0>();
	for (const t of spec.tasks) {
		const loaded = loadEvaluatorV0(t.evaluator.file, t.evaluator.sha256, t.submission);
		if (!loaded.ok) throw new EndoProtectedRefusalV0(`task ${t.id}: ${loaded.detail}`);
		evaluators.set(t.id, loaded.evaluator);
	}
	for (const c of spec.conditions) {
		// The evaluator's material by real path: the definition, its directory, and its reference and negative (each may be a link).
		const material = [...evaluators.values()].flatMap((e) => [
			e.file,
			e.directory,
			join(e.directory, e.definition.reference),
			...(e.definition.negative === null ? [] : [join(e.directory, e.definition.negative)]),
		]);
		const overlap = agentOverlap(c.agent.directory, dir, material);
		if (overlap !== null)
			throw new EndoProtectedRefusalV0(`condition ${c.id}: the agent directory is refused: ${overlap}`);
	}
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
	return {
		bwrap: detected.bwrap,
		runtime: runtime.files,
		node,
		evaluators,
		agents,
		agentCopies: new Map(),
		containment: contained.containment,
	};
}

const attemptsOf = (trialDir: string): number[] =>
	existsSync(trialDir)
		? readdirSync(trialDir)
				.map((n) => /^attempt-([1-9][0-9]*)$/.exec(n))
				.filter((m): m is RegExpExecArray => m !== null)
				.map((m) => Number(m[1]))
				.sort((a, b) => a - b)
		: [];

/** Host paths whose objects the sandbox must not see (by identity: an unrelated inside path of the same name, such as /work, passes). */
function protectedTargets(dir: string, task: EndoLoadedEvaluatorV0, spec: EndoProtectedSpecV0, condition: string) {
	const uid = process.getuid?.() ?? 0;
	const agentSource = spec.conditions.find((c) => c.id === condition)?.agent.directory ?? "/";
	return {
		protectedPaths: {
			"host-home": homedir(),
			repository: resolve(REPOSITORY),
			// The research archive (research/DATA.md), resolved as research/data.ts does; production code does not import research.
			"research-data": researchData(),
			"run-directory": dir,
			"other-trials": join(dir, "trials"),
			"evaluator-directory": task.directory,
			"agent-source": agentSource,
		},
		readOnlyRuntime: [...spec.runtime.executables],
		readOnlyMounts: ["/agent/.endo-probe", "/usr/.endo-probe"],
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
			containment: { ...run.isolation.containment },
			profileSha256: profile.sha256,
			requested: {
				namespaces: profile.logical.namespaces,
				// endo.protected-trial.v0 records offline sandboxes only; a relay (EVAL-ISO-002) is never written into one.
				network: ((network) => {
					if (network !== "none") throw new TypeError("endo.protected-trial.v0 records an offline sandbox only");
					return network;
				})(profile.logical.network),
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
			facts.submission,
			facts.evaluation.status,
		),
		recordedAt: new Date().toISOString(),
	});
	writeJsonOnce(path, record);
	return record;
}

/**
 * Durable scope records for one sandbox of an attempt (`<name>-scope.json`): the unit, written before anything is started, then the
 * launcher's identity right after the launch. A resume ends that launcher and stops that unit (endAttemptScopes).
 */
const SANDBOXES = ["preflight", "agent", "evaluation"] as const;
function scopeRecorder(attemptDir: string, name: (typeof SANDBOXES)[number]) {
	const path = join(attemptDir, `${name}-scope.json`);
	let unit = "";
	return {
		onScope: (u: string) => {
			unit = u;
			writeJsonAtomically(path, { unit });
		},
		onLauncher: (launcher: EndoProcessIdentityV0) => writeJsonAtomically(path, { unit, launcher }),
	};
}

/**
 * On resume, for every sandbox of an attempt that recorded a scope: end its launcher (exactly that pid with that start time: a launcher
 * that outlived the controller may not have registered its scope yet), then stop its scope and confirm it holds no process.
 */
async function endAttemptScopes(
	p: Prepared,
	attemptDir: string,
): Promise<Record<string, { unit: string; ended: "confirmed" | "unconfirmed" }>> {
	const out: Record<string, { unit: string; ended: "confirmed" | "unconfirmed" }> = {};
	for (const name of SANDBOXES) {
		const path = join(attemptDir, `${name}-scope.json`);
		if (!existsSync(path)) continue;
		const rec = readJson(path) as { unit: string; launcher?: EndoProcessIdentityV0 };
		const launcherGone = rec.launcher === undefined ? true : (await endSandboxV0(rec.launcher)) === "confirmed";
		const ended = await stopScopeV0(p.containment, rec.unit);
		out[name] = { unit: rec.unit, ended: launcherGone && ended === "confirmed" ? "confirmed" : "unconfirmed" };
	}
	return out;
}

/** What a run and its records name of the containment: the mechanism, the tools' version and digest, and the bound. */
const containmentRecord = (c: EndoContainmentV0) => ({
	mechanism: c.mechanism,
	version: c.version,
	systemdRunSha256: c.systemdRunSha256,
	tasksMax: c.tasksMax,
});

const NOT_COLLECTED = { status: "not-collected" as const, files: [], sha256: null, refusals: [] };

/** An attempt that may be retried: the controller was interrupted before the agent started. */
export const retryable = (r: EndoProtectedTrialV0): boolean =>
	r.invalidating.includes("controller-interrupted") && r.agent.status === "not-run";

/**
 * After collection, give the operator back the access an agent may have removed (`chmod 000` on its own directories), so the run directory
 * can be inspected and removed. Directories only, never through a link; best effort.
 */
function restoreOwnerAccess(dir: string): void {
	const walk = (d: string) => {
		try {
			const s = lstatSync(d);
			if (!s.isDirectory()) return;
			chmodSync(d, (s.mode & 0o777) | 0o700);
			for (const name of readdirSync(d)) walk(join(d, name));
		} catch {
			// not this user's, or gone
		}
	};
	walk(dir);
}
const NOT_RUN = { status: "not-run" as const, cases: null, reason: null, outputSha256: null };

/** An attempt the controller stopped during: written from what its directory shows, nothing assumed. */
async function finalizeOnResume(
	p: Prepared,
	attemptDir: string,
	base: ReturnType<typeof recordBase>,
): Promise<EndoProtectedTrialV0> {
	// Every sandbox of the attempt that recorded a scope (the preflight, the agent, the evaluation) is ended first: its launcher by
	// identity, its scope through the user manager.
	const scopes = await endAttemptScopes(p, attemptDir);
	// An evaluation the controller stopped during left the cases' inputs behind: removed, like every evaluation's.
	rmSync(join(attemptDir, ".evaluation"), { recursive: true, force: true });
	const preflight: EndoPreflightV0 = existsSync(join(attemptDir, "preflight.json"))
		? (readJson(join(attemptDir, "preflight.json")) as EndoPreflightV0)
		: { status: "unavailable", probes: [], reason: "the controller stopped before the boundary was checked" };
	let agent: EndoProtectedTrialV0["agent"];
	// The agent's scope is recorded synchronously before anything is spawned: without that record, the agent never started (whatever the
	// preflight said), and the attempt stays retryable.
	if (preflight.status !== "established" || !existsSync(join(attemptDir, "agent-scope.json")))
		agent = {
			status: "not-run",
			exitCode: null,
			signal: null,
			durationMs: null,
			termination: "not-applicable",
			outputSha256: null,
			scope: null,
		};
	else if (existsSync(join(attemptDir, "agent-ended.json")))
		// The agent had ended, and the controller stopped later (collecting or evaluating): its facts are known, so they are kept.
		agent = readJson(join(attemptDir, "agent-ended.json")) as EndoProtectedTrialV0["agent"];
	else {
		// The agent may have started. Its scope was recorded before anything started: the user manager stops exactly that scope, which
		// ends every process it holds (an orphaned launcher, a process stranded in bubblewrap's launch window, a detached descendant), and
		// confirms it. The init's identity, when recorded, is ended too, as a supplementary observation only.
		let scope: EndoProtectedTrialV0["agent"]["scope"] = null;
		const ended = scopes.agent;
		if (ended !== undefined) scope = { unit: ended.unit, established: false, ended: ended.ended };
		if (existsSync(join(attemptDir, "agent-started.json")))
			await endSandboxV0((readJson(join(attemptDir, "agent-started.json")) as { init: EndoProcessIdentityV0 }).init);
		agent = {
			status: "interrupted",
			exitCode: null,
			signal: null,
			durationMs: null,
			termination: scope?.ended === "confirmed" ? "confirmed" : "unconfirmed",
			outputSha256: null,
			scope,
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
		p.containment,
		scopeRecorder(attemptDir, "preflight"),
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
				scope: null,
			},
			submission: NOT_COLLECTED,
			evaluation: NOT_RUN,
			controller: { finalized: "normally" },
		});
	const ran = await runSandboxV0(p.bwrap, profile, condition.agent.argv, {
		timeoutMs: spec.limits.agentTimeoutMs,
		outputBytes: spec.limits.outputBytes,
		containment: p.containment,
		// The scope's unit is recorded before anything is started: a resume can always end exactly that scope.
		...scopeRecorder(attemptDir, "agent"),
		onStarted: (init) => {
			writeJsonAtomically(join(attemptDir, "agent-started.json"), { init });
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
		scope: { unit: ran.scope.unit, established: ran.scope.established, ended: ran.scope.ended },
	};
	writeJsonAtomically(join(attemptDir, "agent-ended.json"), agent);
	if (agent.termination !== "confirmed" || !ran.started)
		return finish(record, base, {
			preflight,
			agent,
			submission: NOT_COLLECTED,
			evaluation: NOT_RUN,
			controller: { finalized: "normally" },
		});
	// Nothing the agent left in its workspace can stop the controller: collection maps every filesystem error to a refusal, and any
	// other failure here is the controller's, recorded as an evaluation that could not run (never as an interruption to retry).
	let submission: EndoProtectedTrialV0["submission"];
	let evaluation: Parameters<typeof finish>[2]["evaluation"];
	let collectionFailed = false;
	try {
		submission = exportSubmissionV0(work, task.submission, spec.limits, join(attemptDir, "submission"));
	} catch {
		// Collection maps the errors an agent can cause (access, missing, links) to refusals itself; anything that still throws is the
		// controller's (its staging copy, the host's I/O): attrition, never counted as the agent's failure.
		submission = NOT_COLLECTED;
		collectionFailed = true;
	}
	// After collection (so what was judged is what the agent left), the operator gets back access the agent removed.
	restoreOwnerAccess(work);
	try {
		evaluation = collectionFailed
			? {
					status: "could-not-run",
					cases: null,
					reason: "the controller failed while collecting",
					outputSha256: null,
				}
			: submission.status === "collected"
				? await evaluateV0(
						{ bwrap: p.bwrap, containment: p.containment, runtime: p.runtime, node: p.node, limits: spec.limits },
						evaluator,
						join(attemptDir, "submission"),
						join(attemptDir, ".evaluation"),
						scopeRecorder(attemptDir, "evaluation"),
					)
				: NOT_RUN;
	} catch {
		evaluation = {
			status: "could-not-run",
			cases: null,
			reason: "the controller failed while evaluating",
			outputSha256: null,
		};
	} finally {
		// The job directory holds the cases' inputs: removed once evaluated, so no run directory keeps hidden material.
		rmSync(join(attemptDir, ".evaluation"), { recursive: true, force: true });
	}
	return finish(record, base, { preflight, agent, submission, evaluation, controller: { finalized: "normally" } });
}

/** Run, or resume, a protected experiment. Refuses (EndoProtectedRefusalV0) before running anything when anything it needs is wrong. */
export async function runProtectedExperimentV0(options: EndoProtectedRunOptionsV0): Promise<EndoProtectedRunSummaryV0> {
	const spec = options.spec;
	const dir = resolve(options.dir);
	const p = await prepare(spec, options.bwrapCandidates, dir, options.containmentTools);
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
		try {
			for (const t of spec.tasks) {
				const ev = p.evaluators.get(t.id)!;
				const q = await qualifyEvaluatorV0(
					{ bwrap: p.bwrap, containment: p.containment, runtime: p.runtime, node: p.node, limits: spec.limits },
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
		} finally {
			// The qualification copies are the reference, the negative and the cases' inputs: no run directory keeps them (the lock makes
			// this controller the only one using the directory).
			rmSync(join(dir, ".qualification"), { recursive: true, force: true });
		}
		return out;
	};
	mkdirSync(dir, { recursive: true });
	const releaseLock = lockRunDirectory(dir);
	try {
		// The agent directory is mounted as a copy the controller makes now and checks against its digest, never the live directory.
		for (const c of spec.conditions) {
			const copy = join(dir, ".agents", c.id);
			rmSync(copy, { recursive: true, force: true });
			mkdirSync(join(dir, ".agents"), { recursive: true, mode: 0o700 });
			copyTree(c.agent.directory, copy);
			if (endoTreeDigestV0(copy) !== p.agents.get(c.id))
				throw new EndoProtectedRefusalV0(`condition ${c.id}: the agent directory changed while it was copied`);
			// Whatever its paths, the copy must not hold the hidden material itself (a hard link or a copy of a definition, a reference or a
			// negative).
			const hidden = new Set<string>();
			for (const e of p.evaluators.values()) {
				hidden.add(e.sha256);
				contentDigests(join(e.directory, e.definition.reference), hidden);
				if (e.definition.negative !== null) contentDigests(join(e.directory, e.definition.negative), hidden);
			}
			const held = new Set<string>();
			contentDigests(copy, held);
			if ([...held].some((d) => hidden.has(d)))
				throw new EndoProtectedRefusalV0(
					`condition ${c.id}: the agent directory holds a file of an evaluator's hidden material`,
				);
			p.agentCopies.set(c.id, copy);
		}
		if (existsSync(runPath)) {
			const read = checkEndoProtectedRunV0(readJson(runPath));
			if (!read.ok) throw new EndoProtectedRefusalV0(`the existing run record is not readable: ${read.reason}`);
			run = read.value;
			const same =
				run.specSha256 === specSha256 &&
				run.isolation.executableSha256 === p.bwrap.sha256 &&
				run.isolation.version === p.bwrap.version &&
				canonicalEndoJsonV0(run.isolation.containment) === canonicalEndoJsonV0(containmentRecord(p.containment)) &&
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
				isolation: {
					mechanism: "bubblewrap",
					version: p.bwrap.version,
					executableSha256: p.bwrap.sha256,
					containment: containmentRecord(p.containment),
				},
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
					// What the attempt retried is what its marker says; an attempt without one is not this controller's, and is not guessed at.
					if (!existsSync(join(latestDir, "started.json")))
						throw new EndoProtectedRefusalV0(`${latestDir} has no started.json: refusing to guess what it was`);
					const marker = readJson(join(latestDir, "started.json")) as {
						retryOf: number | null;
						controller?: { pid?: unknown; startTime?: unknown };
					};
					// Never finalize (or end the sandbox of) an attempt whose controller is still running it.
					const owner = marker.controller;
					if (
						owner !== undefined &&
						typeof owner.pid === "number" &&
						typeof owner.startTime === "string" &&
						// This controller holds the lock, so an attempt it started itself earlier is not being run by anyone now.
						!(owner.pid === process.pid && owner.startTime === processStartTimeV0(process.pid)) &&
						processAliveV0({ pid: owner.pid, startTime: owner.startTime })
					)
						throw new EndoProtectedRefusalV0(`${latestDir} is still being run by another controller`);
					const started = marker.retryOf;
					rec = await finalizeOnResume(p, latestDir, recordBase(run, entry, latest, started, profile, evaluator));
					summary.finalizedOnResume++;
				}
				// Only an attempt whose agent never started may be retried: an interruption while or after the agent ran is final attrition, so
				// an agent cannot re-roll its own attempt by making the controller fail (filling the disk, exhausting memory).
				if (!(retryable(rec) && options.retryInterrupted === true)) {
					summary.skipped++;
					continue;
				}
				retryOf = latest;
			}
			if (options.maxAttempts !== undefined && summary.attempts >= options.maxAttempts) break;
			const attempt = (latest ?? 0) + 1;
			const attemptDir = join(trialDir, `attempt-${attempt}`);
			mkdirSync(trialDir, { recursive: true });
			// The attempt directory appears with its started.json already inside (made aside, then renamed into place, which fails if the
			// name exists): an attempt is never without its marker, so a resume never has to guess what it retried.
			const aside = join(trialDir, `.attempt-${attempt}.${process.pid}`);
			mkdirSync(aside);
			writeJsonAtomically(join(aside, "started.json"), {
				attempt,
				retryOf,
				startedAt: new Date().toISOString(),
				controller: { pid: process.pid, startTime: processStartTimeV0(process.pid) },
			});
			if (existsSync(attemptDir)) throw new EndoProtectedRefusalV0(`${attemptDir} exists: refusing to reuse it`);
			renameSync(aside, attemptDir);
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
	} finally {
		releaseLock();
	}
}

/** A copy of a tree of regular files and directories (anything else refused), into a new directory. */
function copyTree(from: string, to: string): void {
	mkdirSync(to, { mode: 0o700 });
	for (const name of readdirSync(from).sort()) {
		const source = join(from, name);
		const s = lstatSync(source);
		if (s.isDirectory()) copyTree(source, join(to, name));
		else if (s.isFile()) {
			writeFileSync(join(to, name), readFileSync(source), { flag: "wx", mode: 0o600 });
			// Exactly the bits the tree digest records, whatever the umask.
			chmodSync(join(to, name), s.mode & 0o755);
		} else throw new EndoProtectedRefusalV0(`${source} is not a regular file or directory`);
	}
}

/**
 * One controller per run directory: an exclusive lock file naming its holder by pid and start time. A lock whose holder no longer exists
 * is stale and taken over; a live one refuses the run.
 */
function lockRunDirectory(dir: string): () => void {
	const path = join(dir, ".lock");
	const me = { pid: process.pid, startTime: processStartTimeV0(process.pid) };
	const holderOf = (file: string): { pid?: unknown; startTime?: unknown } | null => {
		try {
			return JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return null;
		}
	};
	const dead = (h: { pid?: unknown; startTime?: unknown } | null) =>
		h !== null &&
		typeof h.pid === "number" &&
		typeof h.startTime === "string" &&
		!processAliveV0({ pid: h.pid, startTime: h.startTime });
	const release = () => {
		const held = holderOf(path);
		if (held !== null && held.pid === me.pid && held.startTime === me.startTime) unlinkSync(path);
	};
	try {
		const fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeAllSyncV0(fd, JSON.stringify(me));
		} finally {
			closeSync(fd);
		}
		return release;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (!dead(holderOf(path))) throw new EndoProtectedRefusalV0("another controller holds this run directory");
	// Taking over a stale lock never leaves the lock name free: one controller at a time may take over (an exclusive directory), and it
	// replaces the lock file in one rename, so `.lock` exists throughout and no other controller can create it meanwhile.
	const takeover = join(dir, ".lock.takeover");
	try {
		mkdirSync(takeover, { mode: 0o700 });
	} catch {
		throw new EndoProtectedRefusalV0(
			`another controller is taking over this run directory's lock (if none is running, remove ${takeover})`,
		);
	}
	try {
		if (!dead(holderOf(path))) throw new EndoProtectedRefusalV0("another controller holds this run directory");
		const mine = join(takeover, "lock");
		writeFileSync(mine, JSON.stringify(me), { flag: "wx", mode: 0o600 });
		renameSync(mine, path);
		return release;
	} finally {
		rmSync(takeover, { recursive: true, force: true });
	}
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
		/** Of `failed`: the agent left no acceptable submission (missing, a link, a special file, unreadable, too large). */
		failedWithoutSubmission: number;
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
				failedWithoutSubmission: 0,
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
			const previous = final;
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
			// Each record must be this run's attempt, at these coordinates, under this run's isolation, profile and evaluator.
			const profile = run.profiles.find((x) => x.condition === entry.condition)?.sha256;
			const ev = run.evaluators.find((x) => x.task === entry.task);
			const problem =
				v.trial.position !== entry.position ||
				v.trial.task !== entry.task ||
				v.trial.condition !== entry.condition ||
				v.trial.trial !== entry.trial ||
				v.trial.attempt !== n
					? "the record is not this run's attempt at these coordinates"
					: v.run.specSha256 !== run.specSha256 || v.run.seed !== run.seed || v.run.id !== run.spec.id
						? "the record names another run"
						: v.isolation.version !== run.isolation.version ||
								v.isolation.executableSha256 !== run.isolation.executableSha256
							? "the record names another isolation executable"
							: v.isolation.profileSha256 !== profile
								? "the record names another agent profile"
								: v.evaluation.definitionSha256 !== ev?.definitionSha256 ||
										v.evaluation.driverSha256 !== ev?.driverSha256
									? "the record names another evaluator"
									: n !== attempts.indexOf(n) + 1
										? "the attempts are not numbered from 1 without gaps"
										: (n === 1) !== (v.trial.retryOf === null) || (n > 1 && v.trial.retryOf !== n - 1)
											? "the attempt does not retry the attempt before it"
											: n > 1 && (previous === null || !retryable(previous))
												? "the attempt retries one that may not be retried (its agent ran, or its record is unreadable)"
												: null;
			if (problem !== null) {
				refusedRecords.push({ path: rel, reason: problem });
				continue;
			}
			if (v.trial.retryOf !== null) cell.retries++;
			final = v;
		}
		if (final === null) {
			cell.attrition["record-refused"] = (cell.attrition["record-refused"] ?? 0) + 1;
			continue;
		}
		const o = endoProtectedTrialOutcomeV0(final);
		if (o.outcome === "attrition") cell.attrition[o.reason as string] = (cell.attrition[o.reason as string] ?? 0) + 1;
		else {
			cell.qualified++;
			if (o.outcome === "passed") cell.passed++;
			else {
				cell.failed++;
				if (final.evaluation.status !== "failed") cell.failedWithoutSubmission++;
			}
		}
	}
	return {
		schemaVersion: "endo.protected-report.v0",
		run: { id: run.spec.id, specSha256: run.specSha256, seed: run.seed, isolation: run.isolation },
		rules: [
			"planned counts every randomized trial; none is ever removed",
			"qualified (judged): the boundary was established and checked and the agent's termination confirmed, and then either the independent evaluator ran, or the agent left no acceptable submission",
			"passed and failed are counted among qualified trials only; a failure is the evaluator's, or the agent's own missing or unacceptable submission (failedWithoutSubmission), never inferred from missing evidence",
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
		...(max === undefined
			? {}
			: {
					maxAttempts: /^(0|[1-9][0-9]{0,6})$/.test(max)
						? Number(max)
						: (() => {
								throw new TypeError("--max-attempts must be a whole number");
							})(),
				}),
	});
	process.stdout.write(canonicalEndoJsonV0(summary as unknown as Record<string, unknown>));
}

export async function experimentProtectedReportCommand(argv: readonly string[]): Promise<void> {
	if (argv.length !== 1) throw new TypeError("usage: endo experiment protected-report <dir>");
	process.stdout.write(
		canonicalEndoJsonV0(reportProtectedExperimentV0(argv[0] as string) as unknown as Record<string, unknown>),
	);
}
