// Protected experiments (EVAL-ISO-001, docs/protected-experiments.md): the operator's spec, the run record, and one evidence record per
// attempted trial. Language-neutral: shapes, closed vocabularies and the consistency rules between fields. Digests are checked by the
// runtime reader (runtime/contracts/protected-experiment.ts), which also recomputes each record's own digest.
//
// Each record is read only by the validator for the version it declares (protocol/versioned.ts): an unknown version, an unknown field in a
// closed record, or a record whose fields contradict each other is refused, naming why. Nothing is defaulted or migrated. Historical
// experiment records (endo.experiment-run.v0, endo.experiment-trial.v0/v1) are untouched: a protected run writes these records instead.

import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	type EndoVersionedReadV0,
	endoBoundedDetailV0,
	endoFirstUnknownKeyV0,
	endoSafeTextV0,
	readEndoVersionedV0,
} from "./versioned.ts";

export const ENDO_PROTECTED_SPEC_V0 = "endo.protected-experiment-spec.v0";
export const ENDO_PROTECTED_RUN_V0 = "endo.protected-run.v0";
export const ENDO_PROTECTED_TRIAL_V0 = "endo.protected-trial.v0";
export const ENDO_FUNCTION_EVALUATOR_V0 = "endo.function-evaluator.v0";

// ---- the spec -----------------------------------------------------------------------------------------------------------------------------

export interface EndoProtectedLimitsV0 {
	agentTimeoutMs: number;
	evaluationTimeoutMs: number;
	/** Bound on what the controller reads back from a sandbox's stdout and stderr, each. */
	outputBytes: number;
	/** Size of each private tmpfs (/tmp, HOME) inside a sandbox. */
	tmpfsBytes: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export interface EndoProtectedTaskV0 {
	id: string;
	/** The workspace the agent starts from: relative path to content (as endo.experiment-spec.v0). */
	workspace: { [path: string]: string };
	/** The files the agent must submit, by exact relative path. Nothing else is collected. */
	submission: string[];
	/** The evaluator definition: an absolute host path the agent never sees, pinned by its sha256. */
	evaluator: { file: string; sha256: string };
}

export interface EndoProtectedConditionV0 {
	id: string;
	description: string;
	/** The agent: a host directory mounted read-only at /agent, and the argv run in /work (argv[0] one of runtime.executables). */
	agent: { directory: string; argv: string[] };
}

export interface EndoProtectedSpecV0 {
	schemaVersion: typeof ENDO_PROTECTED_SPEC_V0;
	id: string;
	description: string;
	/** The ordering seed (unsigned 32-bit), or null to draw one at the first run; recorded either way. */
	seed: number | null;
	trials: number;
	limits: EndoProtectedLimitsV0;
	/**
	 * The executables mounted in every sandbox (absolute paths), each with its shared-library closure. They are what the host provides; an
	 * agent can still run executables it writes into its own writable directories.
	 */
	runtime: { executables: string[] };
	tasks: EndoProtectedTaskV0[];
	conditions: EndoProtectedConditionV0[];
}

// ---- the evaluator definition -----------------------------------------------------------------------------------------------------------

export interface EndoFunctionEvaluatorV0 {
	schemaVersion: typeof ENDO_FUNCTION_EVALUATOR_V0;
	/** The submitted module (one of the task's submission paths) and the export to call. */
	entry: string;
	export: string;
	/** Each case: the arguments, and the expected result. Expected results never enter any sandbox. */
	cases: { name: string; input: JsonValueV0[]; expected: JsonValueV0 }[];
	/** A known-correct submission (relative to the definition's directory) that must pass every case, and optionally one that must not. */
	reference: string;
	negative: string | null;
}

// ---- the run record ---------------------------------------------------------------------------------------------------------------------

export interface EndoProtectedPlanEntryV0 {
	position: number;
	task: string;
	condition: string;
	trial: number;
}

export interface EndoProtectedRunV0 {
	schemaVersion: typeof ENDO_PROTECTED_RUN_V0;
	runner: string;
	spec: EndoProtectedSpecV0;
	specSha256: string;
	seed: number;
	seedSource: "spec" | "drawn";
	ordering: string;
	plan: EndoProtectedPlanEntryV0[];
	isolation: { mechanism: "bubblewrap"; version: string; executableSha256: string };
	/** Per condition, the digest of its agent profile (logical: host paths replaced by their role, file contents by digest). */
	profiles: { condition: string; sha256: string }[];
	/** Per task, the evaluator's identity and its qualification before any trial ran. */
	evaluators: {
		task: string;
		definitionSha256: string;
		driverSha256: string;
		reference: "passed";
		negative: "failed" | null;
	}[];
	createdAt: string;
}

// ---- the trial record -------------------------------------------------------------------------------------------------------------------

export const ENDO_PROTECTED_INVALIDATING_V0 = [
	"controller-interrupted",
	"isolation-unavailable",
	"preflight-failed",
	"agent-interrupted",
	"agent-failed-to-start",
	"termination-unconfirmed",
	"collection-disturbed",
	"evaluation-could-not-run",
] as const;
export type EndoProtectedInvalidatingV0 = (typeof ENDO_PROTECTED_INVALIDATING_V0)[number];

export const ENDO_PROTECTED_REFUSALS_V0 = [
	"missing",
	"not-a-regular-file",
	"symbolic-link",
	"hard-link",
	"too-large",
	"total-too-large",
	"changed-during-collection",
	"unsafe-path",
	"unreadable",
] as const;
export type EndoProtectedRefusalV0 = (typeof ENDO_PROTECTED_REFUSALS_V0)[number];

export interface EndoProtectedProbeV0 {
	/** A closed probe id (adapters/sandbox/preflight.ts), what it attempted from inside the sandbox. */
	id: string;
	passed: boolean;
	/** What the sandboxed probe observed: an error code or a short fixed word, never content. */
	observed: string;
}

export interface EndoProtectedMountV0 {
	target: string;
	kind: "ro-file" | "ro-dir" | "rw-dir" | "tmpfs" | "proc" | "dev" | "symlink";
	/** The role of the host source (never its path), or null for kernel-provided mounts. */
	role: string | null;
	/** For an ro-file, the sha256 of its content; otherwise null. */
	sha256: string | null;
}

export interface EndoProtectedTrialV0 {
	schemaVersion: typeof ENDO_PROTECTED_TRIAL_V0;
	run: { id: string; specSha256: string; seed: number };
	trial: { position: number; task: string; condition: string; trial: number; attempt: number; retryOf: number | null };
	isolation: {
		mechanism: "bubblewrap";
		version: string;
		executableSha256: string;
		profileSha256: string;
		requested: {
			namespaces: string[];
			network: "none";
			rootReadOnly: boolean;
			userNamespacesDisabled: boolean;
			environment: string[];
			mounts: EndoProtectedMountV0[];
		};
	};
	preflight: {
		status: "established" | "failed" | "unavailable";
		probes: EndoProtectedProbeV0[];
		reason: string | null;
	};
	network: { mode: "none"; relay: null; status: "established" | "failed" | "unavailable" };
	agent: {
		status: "completed" | "exited-nonzero" | "timed-out" | "interrupted" | "failed-to-start" | "not-run";
		exitCode: number | null;
		signal: string | null;
		durationMs: number | null;
		termination: "confirmed" | "unconfirmed" | "not-applicable";
		outputSha256: string | null;
	};
	submission: {
		status: "collected" | "refused" | "missing" | "not-collected";
		files: { path: string; bytes: number; sha256: string }[];
		sha256: string | null;
		refusals: { path: string; reason: EndoProtectedRefusalV0 }[];
	};
	evaluation: {
		status: "passed" | "failed" | "could-not-run" | "not-run";
		definitionSha256: string;
		driverSha256: string;
		cases: { total: number; passed: number } | null;
		reason: string | null;
		outputSha256: string | null;
	};
	/**
	 * `normally`: the controller wrote this record at the end of the attempt. `on-resume`: the controller stopped during the attempt, and a
	 * later run wrote this record from what the attempt directory showed (the facts it could not know are unavailable, never assumed).
	 */
	controller: { finalized: "normally" | "on-resume" };
	invalidating: EndoProtectedInvalidatingV0[];
	recordedAt: string;
	/** sha256 of the canonical JSON of the record without this field. */
	recordSha256: string;
}

// ---- validation ---------------------------------------------------------------------------------------------------------------------------

type Shape = Record<string, unknown>;
const fail = (detail: string): never => {
	throw new EndoInvalidRecordV0(endoBoundedDetailV0(detail));
};
function obj(value: unknown, keys: readonly string[], what: string): Shape {
	if (!isPlainJsonObjectV0(value)) fail(`${what} is not a JSON object`);
	const v = value as Shape;
	const unknown = endoFirstUnknownKeyV0(v, keys);
	if (unknown !== undefined) fail(`${what}: unknown field ${endoSafeTextV0(unknown)}`);
	for (const k of keys) if (!Object.hasOwn(v, k)) fail(`${what}: missing field ${k}`);
	return v;
}
const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REL = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._\-/]{1,200}$/;
const ABS = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9._+\-/]{1,400}$/;
const text = (v: unknown, what: string, max = 2000): string =>
	typeof v === "string" && v.length > 0 && v.length <= max ? v : fail(`${what} is not acceptable text`);
const match = (v: unknown, re: RegExp, what: string): string =>
	typeof v === "string" && re.test(v) ? v : fail(`${what} is not acceptable`);
const count = (v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
		? v
		: fail(`${what} is not an integer in range`);
const bool = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : fail(`${what} is not a boolean`));
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T =>
	list.includes(v as T) ? (v as T) : fail(`${what} is not one of ${list.join(", ")}`);
const list = (v: unknown, what: string, max = 10_000): unknown[] =>
	Array.isArray(v) && v.length <= max ? v : fail(`${what} is not a list`);
const nullable = <T>(v: unknown, read: (x: unknown) => T): T | null => (v === null ? null : read(v));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function limitsOf(v: unknown): EndoProtectedLimitsV0 {
	const o = obj(
		v,
		["agentTimeoutMs", "evaluationTimeoutMs", "outputBytes", "tmpfsBytes", "maxFileBytes", "maxTotalBytes"],
		"limits",
	);
	return {
		agentTimeoutMs: count(o.agentTimeoutMs, "limits.agentTimeoutMs", 100, 24 * 3_600_000),
		evaluationTimeoutMs: count(o.evaluationTimeoutMs, "limits.evaluationTimeoutMs", 100, 3_600_000),
		outputBytes: count(o.outputBytes, "limits.outputBytes", 1024, 64 * 1024 * 1024),
		tmpfsBytes: count(o.tmpfsBytes, "limits.tmpfsBytes", 1024 * 1024, 8 * 1024 * 1024 * 1024),
		maxFileBytes: count(o.maxFileBytes, "limits.maxFileBytes", 1, 64 * 1024 * 1024),
		maxTotalBytes: count(o.maxTotalBytes, "limits.maxTotalBytes", 1, 256 * 1024 * 1024),
	};
}

function specOf(value: unknown): EndoProtectedSpecV0 {
	const o = obj(
		value,
		["schemaVersion", "id", "description", "seed", "trials", "limits", "runtime", "tasks", "conditions"],
		"spec",
	);
	const runtime = obj(o.runtime, ["executables"], "runtime");
	const executables = list(runtime.executables, "runtime.executables", 8).map((x, i) =>
		match(x, ABS, `runtime.executables[${i}]`),
	);
	if (executables.length === 0 || new Set(executables).size !== executables.length)
		fail("runtime.executables must name at least one executable, each once");
	const ids = (items: { id: string }[], what: string) => {
		if (items.length === 0 || new Set(items.map((x) => x.id)).size !== items.length)
			fail(`${what} ids must be unique`);
	};
	const tasks = list(o.tasks, "tasks", 64).map((t, i): EndoProtectedTaskV0 => {
		const w = `tasks[${i}]`;
		const x = obj(t, ["id", "workspace", "submission", "evaluator"], w);
		if (!isPlainJsonObjectV0(x.workspace)) fail(`${w}.workspace is not an object`);
		const workspace: Record<string, string> = {};
		for (const [path, content] of Object.entries(x.workspace as Shape)) {
			match(path, REL, `${w}.workspace path`);
			if (typeof content !== "string") fail(`${w}.workspace content is not text`);
			workspace[path] = content as string;
		}
		const submission = list(x.submission, `${w}.submission`, 256).map((p, j) =>
			match(p, REL, `${w}.submission[${j}]`),
		);
		if (submission.length === 0 || new Set(submission).size !== submission.length)
			fail(`${w}.submission must name each file once`);
		const e = obj(x.evaluator, ["file", "sha256"], `${w}.evaluator`);
		return {
			id: match(x.id, SLUG, `${w}.id`),
			workspace,
			submission,
			evaluator: {
				file: match(e.file, ABS, `${w}.evaluator.file`),
				sha256: match(e.sha256, HEX64, `${w}.evaluator.sha256`),
			},
		};
	});
	ids(tasks, "task");
	const conditions = list(o.conditions, "conditions", 64).map((c, i): EndoProtectedConditionV0 => {
		const w = `conditions[${i}]`;
		const x = obj(c, ["id", "description", "agent"], w);
		const a = obj(x.agent, ["directory", "argv"], `${w}.agent`);
		const argv = list(a.argv, `${w}.agent.argv`, 64).map((s, j) => text(s, `${w}.agent.argv[${j}]`, 4096));
		if (argv.length === 0 || !executables.includes(argv[0] as string))
			fail(`${w}.agent.argv[0] must be one of runtime.executables`);
		return {
			id: match(x.id, SLUG, `${w}.id`),
			description: text(x.description, `${w}.description`),
			agent: { directory: match(a.directory, ABS, `${w}.agent.directory`), argv },
		};
	});
	ids(conditions, "condition");
	return {
		schemaVersion: ENDO_PROTECTED_SPEC_V0,
		id: match(o.id, /^endo\.experiment\.[a-z0-9][a-z0-9.-]{0,120}$/, "id"),
		description: text(o.description, "description"),
		seed: nullable(o.seed, (s) => count(s, "seed", 0, 0xffffffff)),
		trials: count(o.trials, "trials", 1, 1000),
		limits: limitsOf(o.limits),
		runtime: { executables },
		tasks,
		conditions,
	};
}

function evaluatorOf(value: unknown): EndoFunctionEvaluatorV0 {
	const o = obj(value, ["schemaVersion", "entry", "export", "cases", "reference", "negative"], "evaluator");
	const cases = list(o.cases, "cases", 10_000).map((c, i) => {
		const x = obj(c, ["name", "input", "expected"], `cases[${i}]`);
		if (!Array.isArray(x.input)) fail(`cases[${i}].input is not a list of arguments`);
		return {
			name: text(x.name, `cases[${i}].name`, 200),
			input: x.input as JsonValueV0[],
			expected: x.expected as JsonValueV0,
		};
	});
	if (cases.length === 0) fail("an evaluator needs at least one case");
	if (new Set(cases.map((c) => c.name)).size !== cases.length) fail("case names must be unique");
	return {
		schemaVersion: ENDO_FUNCTION_EVALUATOR_V0,
		entry: match(o.entry, REL, "entry"),
		export: match(o.export, /^[A-Za-z_$][A-Za-z0-9_$]{0,100}$/, "export"),
		cases,
		reference: match(o.reference, REL, "reference"),
		negative: nullable(o.negative, (n) => match(n, REL, "negative")),
	};
}

function planEntryOf(v: unknown, what: string): EndoProtectedPlanEntryV0 {
	const o = obj(v, ["position", "task", "condition", "trial"], what);
	return {
		position: count(o.position, `${what}.position`),
		task: match(o.task, SLUG, `${what}.task`),
		condition: match(o.condition, SLUG, `${what}.condition`),
		trial: count(o.trial, `${what}.trial`),
	};
}

function runOf(value: unknown): EndoProtectedRunV0 {
	const o = obj(
		value,
		[
			"schemaVersion",
			"runner",
			"spec",
			"specSha256",
			"seed",
			"seedSource",
			"ordering",
			"plan",
			"isolation",
			"profiles",
			"evaluators",
			"createdAt",
		],
		"run",
	);
	const spec = specOf(o.spec);
	const plan = list(o.plan, "plan", 1_000_000).map((e, i) => planEntryOf(e, `plan[${i}]`));
	const cells = spec.tasks.length * spec.conditions.length * spec.trials;
	if (plan.length !== cells || plan.some((e, i) => e.position !== i))
		fail("plan is not exactly the spec's cells, in position order");
	const seen = new Set(plan.map((e) => `${e.task}/${e.condition}/${e.trial}`));
	if (seen.size !== cells) fail("plan repeats a cell");
	for (const e of plan)
		if (
			!spec.tasks.some((t) => t.id === e.task) ||
			!spec.conditions.some((c) => c.id === e.condition) ||
			e.trial >= spec.trials
		)
			fail("plan names a cell the spec does not");
	const iso = obj(o.isolation, ["mechanism", "version", "executableSha256"], "isolation");
	const profiles = list(o.profiles, "profiles", 64).map((p, i) => {
		const x = obj(p, ["condition", "sha256"], `profiles[${i}]`);
		return { condition: match(x.condition, SLUG, "condition"), sha256: match(x.sha256, HEX64, "sha256") };
	});
	if (profiles.map((p) => p.condition).join() !== spec.conditions.map((c) => c.id).join())
		fail("profiles must be one per condition, in spec order");
	const evaluators = list(o.evaluators, "evaluators", 64).map((p, i) => {
		const x = obj(p, ["task", "definitionSha256", "driverSha256", "reference", "negative"], `evaluators[${i}]`);
		return {
			task: match(x.task, SLUG, "task"),
			definitionSha256: match(x.definitionSha256, HEX64, "definitionSha256"),
			driverSha256: match(x.driverSha256, HEX64, "driverSha256"),
			reference: oneOf(x.reference, ["passed"] as const, "reference"),
			negative: nullable(x.negative, (n) => oneOf(n, ["failed"] as const, "negative")),
		};
	});
	if (evaluators.map((e) => e.task).join() !== spec.tasks.map((t) => t.id).join())
		fail("evaluators must be one per task, in spec order");
	for (const e of evaluators)
		if (spec.tasks.find((t) => t.id === e.task)?.evaluator.sha256 !== e.definitionSha256)
			fail("an evaluator's definition is not the one the spec pins");
	const seed = count(o.seed, "seed", 0, 0xffffffff);
	const seedSource = oneOf(o.seedSource, ["spec", "drawn"] as const, "seedSource");
	if (seedSource === "spec" && spec.seed !== seed) fail("seed is not the spec's");
	return {
		schemaVersion: ENDO_PROTECTED_RUN_V0,
		runner: text(o.runner, "runner", 200),
		spec,
		specSha256: match(o.specSha256, HEX64, "specSha256"),
		seed,
		seedSource,
		ordering: text(o.ordering, "ordering"),
		plan,
		isolation: {
			mechanism: oneOf(iso.mechanism, ["bubblewrap"] as const, "isolation.mechanism"),
			version: text(iso.version, "isolation.version", 80),
			executableSha256: match(iso.executableSha256, HEX64, "isolation.executableSha256"),
		},
		profiles,
		evaluators,
		createdAt: match(o.createdAt, ISO, "createdAt"),
	};
}

const MOUNT_KINDS = ["ro-file", "ro-dir", "rw-dir", "tmpfs", "proc", "dev", "symlink"] as const;

function trialOf(value: unknown): EndoProtectedTrialV0 {
	const o = obj(
		value,
		[
			"schemaVersion",
			"run",
			"trial",
			"isolation",
			"preflight",
			"network",
			"agent",
			"submission",
			"evaluation",
			"controller",
			"invalidating",
			"recordedAt",
			"recordSha256",
		],
		"trial record",
	);
	const run = obj(o.run, ["id", "specSha256", "seed"], "run");
	const t = obj(o.trial, ["position", "task", "condition", "trial", "attempt", "retryOf"], "trial");
	const attempt = count(t.attempt, "trial.attempt", 1, 1000);
	const retryOf = nullable(t.retryOf, (r) => count(r, "trial.retryOf", 1, 1000));
	if (retryOf !== null && retryOf >= attempt) fail("trial.retryOf must name an earlier attempt");
	if (attempt > 1 && retryOf === null) fail("a later attempt must name the attempt it retries");
	const iso = obj(
		o.isolation,
		["mechanism", "version", "executableSha256", "profileSha256", "requested"],
		"isolation",
	);
	const req = obj(
		iso.requested,
		["namespaces", "network", "rootReadOnly", "userNamespacesDisabled", "environment", "mounts"],
		"isolation.requested",
	);
	const mounts = list(req.mounts, "mounts", 4096).map((m, i): EndoProtectedMountV0 => {
		const x = obj(m, ["target", "kind", "role", "sha256"], `mounts[${i}]`);
		const kind = oneOf(x.kind, MOUNT_KINDS, `mounts[${i}].kind`);
		const sha256 = nullable(x.sha256, (s) => match(s, HEX64, `mounts[${i}].sha256`));
		if ((kind === "ro-file") !== (sha256 !== null))
			fail(`mounts[${i}]: only a read-only file carries a content digest`);
		return {
			target: match(x.target, ABS, `mounts[${i}].target`),
			kind,
			role: nullable(x.role, (r) => text(r, "role", 80)),
			sha256,
		};
	});
	const pf = obj(o.preflight, ["status", "probes", "reason"], "preflight");
	const probes = list(pf.probes, "preflight.probes", 256).map((p, i) => {
		const x = obj(p, ["id", "passed", "observed"], `probes[${i}]`);
		return {
			id: match(x.id, /^[a-z][a-z0-9-]{0,80}$/, `probes[${i}].id`),
			passed: bool(x.passed, `probes[${i}].passed`),
			observed: match(x.observed, /^[A-Za-z0-9_:.\- ]{1,80}$/, `probes[${i}].observed`),
		};
	});
	const preflight = {
		status: oneOf(pf.status, ["established", "failed", "unavailable"] as const, "preflight.status"),
		probes,
		reason: nullable(pf.reason, (r) => text(r, "preflight.reason", 400)),
	};
	if (preflight.status === "established" && (probes.length === 0 || probes.some((p) => !p.passed)))
		fail("an established boundary needs probes, every one passed");
	if (preflight.status === "failed" && !probes.some((p) => !p.passed) && preflight.reason === null)
		fail("a failed boundary names a failed probe or a reason");
	const net = obj(o.network, ["mode", "relay", "status"], "network");
	const network = {
		mode: oneOf(net.mode, ["none"] as const, "network.mode"),
		relay: net.relay === null ? null : fail("network.relay: no relay is supported in this version"),
		status: oneOf(net.status, ["established", "failed", "unavailable"] as const, "network.status"),
	};
	if (network.status === "established" && preflight.status !== "established")
		fail("the network boundary cannot be established when the preflight was not");
	const a = obj(o.agent, ["status", "exitCode", "signal", "durationMs", "termination", "outputSha256"], "agent");
	const agent = {
		status: oneOf(
			a.status,
			["completed", "exited-nonzero", "timed-out", "interrupted", "failed-to-start", "not-run"] as const,
			"agent.status",
		),
		exitCode: nullable(a.exitCode, (x) => count(x, "agent.exitCode", 0, 255)),
		signal: nullable(a.signal, (x) => match(x, /^SIG[A-Z0-9]{1,10}$/, "agent.signal")),
		durationMs: nullable(a.durationMs, (x) => count(x, "agent.durationMs")),
		termination: oneOf(a.termination, ["confirmed", "unconfirmed", "not-applicable"] as const, "agent.termination"),
		outputSha256: nullable(a.outputSha256, (x) => match(x, HEX64, "agent.outputSha256")),
	};
	// Never unprotected: an agent that ran (or was started) had an established boundary first.
	if (agent.status !== "not-run" && preflight.status !== "established")
		fail("an agent ran without an established boundary");
	if ((agent.status === "not-run") !== (agent.termination === "not-applicable"))
		fail("agent.termination is not-applicable exactly when the agent did not run");
	if (agent.status === "completed" && agent.exitCode !== 0) fail("a completed agent exited 0");
	const s = obj(o.submission, ["status", "files", "sha256", "refusals"], "submission");
	const files = list(s.files, "submission.files", 4096).map((f, i) => {
		const x = obj(f, ["path", "bytes", "sha256"], `files[${i}]`);
		return {
			path: match(x.path, REL, `files[${i}].path`),
			bytes: count(x.bytes, `files[${i}].bytes`),
			sha256: match(x.sha256, HEX64, `files[${i}].sha256`),
		};
	});
	for (let i = 1; i < files.length; i++)
		if ((files[i - 1] as { path: string }).path >= (files[i] as { path: string }).path)
			fail("submission files are sorted by path, each once");
	const refusals = list(s.refusals, "submission.refusals", 4096).map((r, i) => {
		const x = obj(r, ["path", "reason"], `refusals[${i}]`);
		return {
			path: text(x.path, "path", 400),
			reason: oneOf(x.reason, ENDO_PROTECTED_REFUSALS_V0, `refusals[${i}].reason`),
		};
	});
	const submission = {
		status: oneOf(s.status, ["collected", "refused", "missing", "not-collected"] as const, "submission.status"),
		files,
		sha256: nullable(s.sha256, (x) => match(x, HEX64, "submission.sha256")),
		refusals,
	};
	if (submission.status === "collected" && (submission.sha256 === null || files.length === 0 || refusals.length > 0))
		fail("a collected submission has files, a digest and no refusals");
	if (submission.status !== "collected" && (submission.sha256 !== null || files.length > 0))
		fail("only a collected submission has files and a digest");
	if ((submission.status === "refused" || submission.status === "missing") && refusals.length === 0)
		fail("a refused or missing submission says why");
	if (submission.status === "collected" && agent.termination !== "confirmed")
		fail("a submission is collected only after the agent's termination was confirmed");
	const e = obj(
		o.evaluation,
		["status", "definitionSha256", "driverSha256", "cases", "reason", "outputSha256"],
		"evaluation",
	);
	const cases = nullable(e.cases, (c) => {
		const x = obj(c, ["total", "passed"], "evaluation.cases");
		const total = count(x.total, "evaluation.cases.total", 1);
		return { total, passed: count(x.passed, "evaluation.cases.passed", 0, total) };
	});
	const evaluation = {
		status: oneOf(e.status, ["passed", "failed", "could-not-run", "not-run"] as const, "evaluation.status"),
		definitionSha256: match(e.definitionSha256, HEX64, "evaluation.definitionSha256"),
		driverSha256: match(e.driverSha256, HEX64, "evaluation.driverSha256"),
		cases,
		reason: nullable(e.reason, (r) => text(r, "evaluation.reason", 400)),
		outputSha256: nullable(e.outputSha256, (x) => match(x, HEX64, "evaluation.outputSha256")),
	};
	if (evaluation.status === "passed" || evaluation.status === "failed") {
		if (submission.status !== "collected") fail("an evaluation result needs a collected submission");
		if (preflight.status !== "established") fail("an evaluation result needs an established boundary");
		if (cases === null && evaluation.reason === null) fail("an evaluation result counts its cases or says why not");
	}
	if (evaluation.status === "passed" && (cases === null || cases.passed !== cases.total))
		fail("a passed evaluation passed every case");
	if (evaluation.status !== "passed" && evaluation.status !== "failed" && cases !== null)
		fail("only an evaluation that ran counts cases");
	const ctl = obj(o.controller, ["finalized"], "controller");
	const controller = { finalized: oneOf(ctl.finalized, ["normally", "on-resume"] as const, "controller.finalized") };
	if (controller.finalized === "on-resume" && (evaluation.status !== "not-run" || submission.status === "collected"))
		fail("a record finalized on resume has no collected submission and no evaluation");
	const invalidating = list(o.invalidating, "invalidating", 16).map((x, i) =>
		oneOf(x, ENDO_PROTECTED_INVALIDATING_V0, `invalidating[${i}]`),
	);
	if (new Set(invalidating).size !== invalidating.length) fail("invalidating repeats a condition");
	// The invalidating conditions follow from the facts above: none may be omitted, and none may be invented.
	const expected = expectedInvalidating(controller.finalized, preflight.status, agent, submission, evaluation.status);
	if ([...invalidating].sort().join() !== [...expected].sort().join())
		fail(`invalidating is not what the record's facts imply (${expected.join(", ") || "none"})`);
	return {
		schemaVersion: ENDO_PROTECTED_TRIAL_V0,
		run: {
			id: text(run.id, "run.id", 200),
			specSha256: match(run.specSha256, HEX64, "run.specSha256"),
			seed: count(run.seed, "run.seed", 0, 0xffffffff),
		},
		trial: {
			position: count(t.position, "trial.position"),
			task: match(t.task, SLUG, "trial.task"),
			condition: match(t.condition, SLUG, "trial.condition"),
			trial: count(t.trial, "trial.trial"),
			attempt,
			retryOf,
		},
		isolation: {
			mechanism: oneOf(iso.mechanism, ["bubblewrap"] as const, "isolation.mechanism"),
			version: text(iso.version, "isolation.version", 80),
			executableSha256: match(iso.executableSha256, HEX64, "isolation.executableSha256"),
			profileSha256: match(iso.profileSha256, HEX64, "isolation.profileSha256"),
			requested: {
				namespaces: list(req.namespaces, "namespaces", 16).map((n) => match(n, /^[a-z]{2,10}$/, "namespace")),
				network: oneOf(req.network, ["none"] as const, "requested.network"),
				rootReadOnly: bool(req.rootReadOnly, "rootReadOnly"),
				userNamespacesDisabled: bool(req.userNamespacesDisabled, "userNamespacesDisabled"),
				environment: list(req.environment, "environment", 64).map((n) =>
					match(n, /^[A-Z_][A-Z0-9_]{0,63}$/, "variable"),
				),
				mounts,
			},
		},
		preflight,
		network,
		agent,
		submission,
		evaluation,
		controller,
		invalidating,
		recordedAt: match(o.recordedAt, ISO, "recordedAt"),
		recordSha256: match(o.recordSha256, HEX64, "recordSha256"),
	};
}

/** The invalidating conditions a record's facts imply, in a fixed order. */
export function expectedInvalidating(
	finalized: EndoProtectedTrialV0["controller"]["finalized"],
	preflight: EndoProtectedTrialV0["preflight"]["status"],
	agent: Pick<EndoProtectedTrialV0["agent"], "status" | "termination">,
	submission: Pick<EndoProtectedTrialV0["submission"], "status" | "refusals">,
	evaluation: EndoProtectedTrialV0["evaluation"]["status"],
): EndoProtectedInvalidatingV0[] {
	const out: EndoProtectedInvalidatingV0[] = [];
	if (finalized === "on-resume") out.push("controller-interrupted");
	if (preflight === "unavailable") out.push("isolation-unavailable");
	if (preflight === "failed") out.push("preflight-failed");
	if (agent.status === "interrupted") out.push("agent-interrupted");
	if (agent.status === "failed-to-start") out.push("agent-failed-to-start");
	if (agent.termination === "unconfirmed") out.push("termination-unconfirmed");
	// A missing or unacceptable submission is the agent's own doing (it can delete, link or lock its files at will): a failure, not
	// attrition. The one exception is a file that changed while it was read after the agent was confirmed gone: not the agent's.
	if (submission.refusals.some((r) => r.reason === "changed-during-collection")) out.push("collection-disturbed");
	if (evaluation === "could-not-run") out.push("evaluation-could-not-run");
	return out;
}

export const ENDO_PROTECTED_SPEC_VERSIONS_V0 = defineEndoVersionTableV0<EndoProtectedSpecV0>(
	"endo.protected-experiment-spec",
	[[ENDO_PROTECTED_SPEC_V0, specOf]],
);
export const ENDO_PROTECTED_RUN_VERSIONS_V0 = defineEndoVersionTableV0<EndoProtectedRunV0>("endo.protected-run", [
	[ENDO_PROTECTED_RUN_V0, runOf],
]);
export const ENDO_PROTECTED_TRIAL_VERSIONS_V0 = defineEndoVersionTableV0<EndoProtectedTrialV0>("endo.protected-trial", [
	[ENDO_PROTECTED_TRIAL_V0, trialOf],
]);
export const ENDO_FUNCTION_EVALUATOR_VERSIONS_V0 = defineEndoVersionTableV0<EndoFunctionEvaluatorV0>(
	"endo.function-evaluator",
	[[ENDO_FUNCTION_EVALUATOR_V0, evaluatorOf]],
);

export const readEndoProtectedSpecV0 = (v: unknown): EndoVersionedReadV0<EndoProtectedSpecV0> =>
	readEndoVersionedV0(ENDO_PROTECTED_SPEC_VERSIONS_V0, v);
export const readEndoProtectedRunV0 = (v: unknown): EndoVersionedReadV0<EndoProtectedRunV0> =>
	readEndoVersionedV0(ENDO_PROTECTED_RUN_VERSIONS_V0, v);
export const readEndoProtectedTrialV0 = (v: unknown): EndoVersionedReadV0<EndoProtectedTrialV0> =>
	readEndoVersionedV0(ENDO_PROTECTED_TRIAL_VERSIONS_V0, v);
export const readEndoFunctionEvaluatorV0 = (v: unknown): EndoVersionedReadV0<EndoFunctionEvaluatorV0> =>
	readEndoVersionedV0(ENDO_FUNCTION_EVALUATOR_VERSIONS_V0, v);

/**
 * A trial's outcome for analysis. `attrition`: something outside the agent's control kept it from being judged (the boundary, the
 * controller, the host, the evaluator infrastructure). Otherwise it is judged: `passed` or `failed` by the independent evaluator, or
 * `failed` because the agent left no acceptable submission (missing, a link, a special file, unreadable, too large), which it chose.
 */
export function endoProtectedTrialOutcomeV0(r: EndoProtectedTrialV0): {
	outcome: "passed" | "failed" | "attrition";
	reason: string | null;
} {
	if (r.invalidating.length > 0) return { outcome: "attrition", reason: r.invalidating[0] as string };
	if (r.evaluation.status === "passed") return { outcome: "passed", reason: null };
	if (r.evaluation.status === "failed") return { outcome: "failed", reason: r.evaluation.reason };
	if (r.submission.status === "missing" || r.submission.status === "refused")
		return { outcome: "failed", reason: `submission-${r.submission.refusals[0]?.reason ?? r.submission.status}` };
	return { outcome: "attrition", reason: `evaluation-${r.evaluation.status}` };
}

/** Whether a trial enters a qualified comparison: it was judged (passed or failed), not lost to attrition. */
export function endoProtectedTrialQualifiesV0(r: EndoProtectedTrialV0): boolean {
	return endoProtectedTrialOutcomeV0(r).outcome !== "attrition";
}
