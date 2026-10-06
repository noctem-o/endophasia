// The experiment runner's durable run-directory artifacts: the contracts `endo experiment run` writes and later reads
// back (resume, report, the research analysis scripts).
//
//   experiment.json   endo.experiment-run.v0     the experiment as run (embeds the spec and an endo.experiment.v0 record)
//   plan.json         endo.experiment-plan.v0    every (task, condition, trial) in run order
//   trials/**/result.json   endo.experiment-trial.v0   what one trial produced
//
// Each is read by exactly the validator its declared `schemaVersion` selects (protocol/versioned.ts): unknown fields in
// a closed record are refused, an unknown version is refused, and nothing is migrated or rewritten. The spec the runner
// is given (`endo.experiment-spec.v0`) lives in protocol/experiment-spec.ts. The report (`endo.experiment-report.*`)
// is derived, and is not governed here.
//
// One historical case: runs recorded before the plan carried a version have a `plan.json` that declares none. That
// shape cannot take part in version dispatch (there is nothing to dispatch on), so it has one explicit, exact reader of
// its own, `readEndoLegacyExperimentPlanV0`. `readEndoExperimentPlanV0` sends only a record that declares no version to
// it; a record that declares one is never read as the legacy form, and the legacy form is never read as a versioned
// one.
//
// Open on purpose: a trial's recorded `requestParameters` are strict JSON as Pi sent them (the provider's schema, not
// ours); the spec's maps (workspace files, model entry, settings, extensions, environment variables and files, injected
// fields) are maps of data. Everything else is closed.

import type { EndoExperimentRecordV0 } from "./evolution.ts";
import { validateEndoExperimentRecordV0 } from "./evolution.ts";
import type { EndoExperimentSpecV0 } from "./experiment-spec.ts";
import {
	endoExperimentSpecProblemV0,
	isEndoExperimentRelativePathV0,
	isEndoExperimentSlugV0,
} from "./experiment-spec.ts";
import { isIso8601UtcV0, isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";
import {
	defineEndoVersionTableV0,
	EndoInvalidRecordV0,
	EndoSchemaVersionErrorV0,
	type EndoVersionedReadV0,
	endoBoundedDetailV0,
	endoFirstUnknownKeyV0,
	endoSafeTextV0,
	readEndoVersionedV0,
} from "./versioned.ts";

// --- the contracts -------------------------------------------------------------------------------------------------

/** The versions the runner writes. The writer owns them; no caller supplies one. */
export const ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0 = "endo.experiment-run.v0";
export const ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0 = "endo.experiment-plan.v0";
export const ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0 = "endo.experiment-trial.v0";

/** One planned trial. */
export interface EndoExperimentTrialKeyV0 {
	position: number;
	task: string;
	condition: string;
	trial: number;
}

/** The trial order (plan.json). */
export interface EndoExperimentPlanV0 {
	schemaVersion: typeof ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0;
	seed: number;
	ordering: string;
	order: EndoExperimentTrialKeyV0[];
}

/** The plan as runs recorded before it carried a version wrote it: no `schemaVersion`, otherwise the same. */
export interface EndoLegacyExperimentPlanV0 {
	seed: number;
	ordering: string;
	order: EndoExperimentTrialKeyV0[];
}

/** The experiment as run (experiment.json). */
export interface EndoExperimentRunRecordV0 {
	schemaVersion: typeof ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0;
	runner: string;
	spec: EndoExperimentSpecV0;
	specSha256: string;
	seed: number;
	seedSource: "spec" | "drawn";
	ordering: string;
	experiment: EndoExperimentRecordV0;
	scratchRoot: string;
	proxyPort: number | null;
	createdAt: string;
}

/** A keyed digest as a trial records it: which key, the value, how many bytes it covers. */
export interface EndoExperimentKeyedDigestV0 {
	keyId: string;
	value: string;
	bytes: number;
}

/** What one trial produced (result.json). */
export interface EndoExperimentTrialResultV0 {
	schemaVersion: typeof ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0;
	position: number;
	task: string;
	condition: string;
	trial: number;
	status: "completed" | "error";
	error: string | null;
	startedAt: string;
	endedAt: string;
	/** The trial's store, relative to the run directory. */
	store: string;
	/** The endo session coordinate, or null when no session opened. */
	session: string | null;
	exchanges: number;
	/** Every top-level request field except messages and tools, per request, as Pi sent it. Open JSON. */
	requestParameters: JsonValueV0[];
	check:
		| { ran: false; reason: string }
		| {
				ran: true;
				exitCode: number | null;
				passed: boolean;
				timedOut: boolean;
				output: EndoExperimentKeyedDigestV0;
		  };
	/** The keyed digest of the workspace's archive after the session (what the agent left behind). */
	finalWorkspace: EndoExperimentKeyedDigestV0 | null;
	notes: string[];
}

// --- shared checks -------------------------------------------------------------------------------------------------

type Problem = string | null;

const isObject = (value: unknown): value is Record<string, unknown> => isPlainJsonObjectV0(value);
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 4096): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;

/** Why `value` is not an object of exactly the `allowed` keys' kind (unknown fields refused), or null. */
function closed(value: unknown, allowed: readonly string[], what: string): Problem {
	if (!isObject(value)) return `${what} is not a JSON object`;
	const unknown = endoFirstUnknownKeyV0(value, allowed);
	return unknown === undefined ? null : `${what}: unknown field ${endoSafeTextV0(unknown)}`;
}

const throwing =
	<T>(check: (value: unknown) => Problem) =>
	(value: unknown): T => {
		const problem = check(value);
		if (problem !== null) throw new EndoInvalidRecordV0(endoBoundedDetailV0(problem));
		return value as T;
	};

// --- the run record ------------------------------------------------------------------------------------------------

/**
 * The spec versions an `endo.experiment-run.v0` may embed: the run's own table, not whatever the spec family knows
 * today. A later spec version is legal inside a later run version only.
 */
export const ENDO_EXPERIMENT_RUN_SPEC_VERSIONS_V0 = defineEndoVersionTableV0<EndoExperimentSpecV0>(
	"endo.experiment-spec",
	[["endo.experiment-spec.v0", throwing<EndoExperimentSpecV0>(endoExperimentSpecProblemV0)]],
);

/** The experiment-record versions an `endo.experiment-run.v0` may embed: exactly `endo.experiment.v0`. */
export const ENDO_EXPERIMENT_RUN_EXPERIMENT_VERSIONS_V0 = defineEndoVersionTableV0<EndoExperimentRecordV0>(
	"endo.experiment",
	[["endo.experiment.v0", validateEndoExperimentRecordV0]],
);

const RUN_KEYS = [
	"schemaVersion",
	"runner",
	"spec",
	"specSha256",
	"seed",
	"seedSource",
	"ordering",
	"experiment",
	"scratchRoot",
	"proxyPort",
	"createdAt",
] as const;

const isSeed = (value: unknown): value is number => isCount(value) && value <= 0xffffffff;

function runProblem(value: unknown): Problem {
	const shape = closed(value, RUN_KEYS, "the run record");
	if (shape !== null) return shape;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0)
		return `schemaVersion must be ${ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0}`;
	if (!isText(v.runner, 256)) return "runner must be a non-empty string";
	const spec = readEndoVersionedV0(ENDO_EXPERIMENT_RUN_SPEC_VERSIONS_V0, v.spec);
	if (!spec.ok) return `spec: ${spec.message}`;
	if (typeof v.specSha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.specSha256))
		return "specSha256 must be 64 lowercase hex digits";
	if (!isSeed(v.seed)) return "seed must be an unsigned 32-bit integer";
	if (v.seedSource !== "spec" && v.seedSource !== "drawn") return "seedSource must be spec or drawn";
	if (!isText(v.ordering)) return "ordering must be a non-empty string";
	const experiment = readEndoVersionedV0(ENDO_EXPERIMENT_RUN_EXPERIMENT_VERSIONS_V0, v.experiment);
	if (!experiment.ok) return `experiment: ${experiment.message}`;
	if (!isText(v.scratchRoot) || v.scratchRoot.includes("\0")) return "scratchRoot must be a non-empty path";
	if (v.proxyPort !== null && !(isCount(v.proxyPort) && v.proxyPort >= 1 && v.proxyPort <= 65_535))
		return "proxyPort must be a port number or null";
	if (typeof v.createdAt !== "string" || !isIso8601UtcV0(v.createdAt)) return "createdAt must be an ISO-8601 UTC time";
	return null;
}

/** The run-record versions this reader knows. */
export const ENDO_EXPERIMENT_RUN_VERSIONS_V0 = defineEndoVersionTableV0<EndoExperimentRunRecordV0>(
	"endo.experiment-run",
	[[ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0, throwing<EndoExperimentRunRecordV0>(runProblem)]],
);

// --- the plan ------------------------------------------------------------------------------------------------------

const ENTRY_KEYS = ["position", "task", "condition", "trial"] as const;
const PLAN_BODY_KEYS = ["seed", "ordering", "order"] as const;

function orderProblem(order: unknown): Problem {
	if (!Array.isArray(order) || order.length === 0) return "order must be a non-empty list";
	const seen = new Set<string>();
	for (const [index, entry] of order.entries()) {
		const shape = closed(entry, ENTRY_KEYS, `order[${index}]`);
		if (shape !== null) return shape;
		const e = entry as Record<string, unknown>;
		if (e.position !== index) return `order[${index}]: position must equal its index`;
		if (!isEndoExperimentSlugV0(e.task)) return `order[${index}]: task must be a slug`;
		if (!isEndoExperimentSlugV0(e.condition)) return `order[${index}]: condition must be a slug`;
		if (!isCount(e.trial)) return `order[${index}]: trial must be a non-negative integer`;
		const key = `${e.task}\0${e.condition}\0${e.trial}`;
		if (seen.has(key)) return `order[${index}]: the trial is planned twice`;
		seen.add(key);
	}
	return null;
}

function planBodyProblem(v: Record<string, unknown>): Problem {
	if (!isSeed(v.seed)) return "seed must be an unsigned 32-bit integer";
	if (!isText(v.ordering)) return "ordering must be a non-empty string";
	return orderProblem(v.order);
}

function planProblem(value: unknown): Problem {
	const shape = closed(value, ["schemaVersion", ...PLAN_BODY_KEYS], "the plan");
	if (shape !== null) return shape;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0)
		return `schemaVersion must be ${ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0}`;
	return planBodyProblem(v);
}

/** The plan versions this reader knows. A record with no `schemaVersion` is not read through this table. */
export const ENDO_EXPERIMENT_PLAN_VERSIONS_V0 = defineEndoVersionTableV0<EndoExperimentPlanV0>("endo.experiment-plan", [
	[ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0, throwing<EndoExperimentPlanV0>(planProblem)],
]);

/** The legacy unversioned plan: exactly `{ seed, ordering, order }` and no other field, in particular no `schemaVersion`. */
export function readEndoLegacyExperimentPlanV0(
	value: unknown,
): { readonly ok: true; readonly plan: EndoLegacyExperimentPlanV0 } | { readonly ok: false; readonly message: string } {
	const body = closed(value, PLAN_BODY_KEYS, "the legacy plan") ?? planBodyProblem(value as Record<string, unknown>);
	return body === null
		? { ok: true, plan: value as EndoLegacyExperimentPlanV0 }
		: { ok: false, message: endoBoundedDetailV0(body) };
}

export type EndoExperimentPlanReadV0 =
	| {
			readonly ok: true;
			readonly form: "versioned";
			readonly schemaVersion: string;
			readonly plan: EndoExperimentPlanV0;
	  }
	| { readonly ok: true; readonly form: "legacy-unversioned"; readonly plan: EndoLegacyExperimentPlanV0 }
	| Extract<EndoVersionedReadV0<unknown>, { ok: false }>;

/**
 * Read a persisted plan. A record that declares a `schemaVersion` is read by that version's validator and by nothing
 * else. Only a record that declares none is tried, once, as the exact legacy unversioned plan; the result says which
 * form it was, and the bytes are never rewritten.
 */
export function readEndoExperimentPlanV0(value: unknown): EndoExperimentPlanReadV0 {
	const read = readEndoVersionedV0(ENDO_EXPERIMENT_PLAN_VERSIONS_V0, value);
	if (read.ok) return { ok: true, form: "versioned", schemaVersion: read.schemaVersion, plan: read.value };
	if (read.kind !== "missing-version") return read;
	const legacy = readEndoLegacyExperimentPlanV0(value);
	if (legacy.ok) return { ok: true, form: "legacy-unversioned", plan: legacy.plan };
	return {
		ok: false,
		kind: "invalid",
		message: `endo.experiment-plan: the record declares no schemaVersion and is not the legacy unversioned plan (${legacy.message})`,
	};
}

/** `readEndoExperimentPlanV0`, throwing `EndoSchemaVersionErrorV0` on failure. */
export function parseEndoExperimentPlanV0(value: unknown): Extract<EndoExperimentPlanReadV0, { ok: true }> {
	const read = readEndoExperimentPlanV0(value);
	if (!read.ok) throw new EndoSchemaVersionErrorV0(read);
	return read;
}

// --- the trial result ----------------------------------------------------------------------------------------------

const TRIAL_KEYS = [
	"schemaVersion",
	"position",
	"task",
	"condition",
	"trial",
	"status",
	"error",
	"startedAt",
	"endedAt",
	"store",
	"session",
	"exchanges",
	"requestParameters",
	"check",
	"finalWorkspace",
	"notes",
] as const;

function isJson(value: unknown, depth = 0): value is JsonValueV0 {
	if (depth > 64) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
	return isObject(value) && Object.values(value).every((item) => isJson(item, depth + 1));
}

function digestProblem(value: unknown, what: string): Problem {
	const shape = closed(value, ["keyId", "value", "bytes"], what);
	if (shape !== null) return shape;
	const d = value as Record<string, unknown>;
	if (!isText(d.keyId, 1024) || !isText(d.value, 1024)) return `${what}: keyId and value must be non-empty strings`;
	return isCount(d.bytes) ? null : `${what}: bytes must be a non-negative integer`;
}

function checkProblem(value: unknown): Problem {
	if (!isObject(value)) return "check is not a JSON object";
	if (value.ran === false) {
		const shape = closed(value, ["ran", "reason"], "check");
		if (shape !== null) return shape;
		return typeof value.reason === "string" ? null : "check.reason must be a string";
	}
	if (value.ran !== true) return "check.ran must be a boolean";
	const shape = closed(value, ["ran", "exitCode", "passed", "timedOut", "output"], "check");
	if (shape !== null) return shape;
	if (value.exitCode !== null && !(typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)))
		return "check.exitCode must be an integer or null";
	if (typeof value.passed !== "boolean" || typeof value.timedOut !== "boolean")
		return "check.passed and check.timedOut must be booleans";
	return digestProblem(value.output, "check.output");
}

function trialProblem(value: unknown): Problem {
	const shape = closed(value, TRIAL_KEYS, "the trial result");
	if (shape !== null) return shape;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0)
		return `schemaVersion must be ${ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0}`;
	if (!isCount(v.position)) return "position must be a non-negative integer";
	if (!isEndoExperimentSlugV0(v.task)) return "task must be a slug";
	if (!isEndoExperimentSlugV0(v.condition)) return "condition must be a slug";
	if (!isCount(v.trial)) return "trial must be a non-negative integer";
	if (v.status !== "completed" && v.status !== "error") return "status must be completed or error";
	if (v.error !== null && typeof v.error !== "string") return "error must be a string or null";
	if (typeof v.startedAt !== "string" || !isIso8601UtcV0(v.startedAt)) return "startedAt must be an ISO-8601 UTC time";
	if (typeof v.endedAt !== "string" || !isIso8601UtcV0(v.endedAt)) return "endedAt must be an ISO-8601 UTC time";
	if (!isText(v.store) || !isEndoExperimentRelativePathV0(v.store))
		return "store must be a relative path inside the run directory";
	if (v.session !== null && typeof v.session !== "string") return "session must be a string or null";
	if (!isCount(v.exchanges)) return "exchanges must be a non-negative integer";
	if (!Array.isArray(v.requestParameters) || !v.requestParameters.every((entry) => isJson(entry)))
		return "requestParameters must be a list of strict JSON values";
	const check = checkProblem(v.check);
	if (check !== null) return check;
	if (v.finalWorkspace !== null) {
		const digest = digestProblem(v.finalWorkspace, "finalWorkspace");
		if (digest !== null) return digest;
	}
	if (!Array.isArray(v.notes) || !v.notes.every((note) => typeof note === "string"))
		return "notes must be a list of strings";
	return null;
}

/** The trial-result versions this reader knows. */
export const ENDO_EXPERIMENT_TRIAL_VERSIONS_V0 = defineEndoVersionTableV0<EndoExperimentTrialResultV0>(
	"endo.experiment-trial",
	[[ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0, throwing<EndoExperimentTrialResultV0>(trialProblem)]],
);

// --- reading -------------------------------------------------------------------------------------------------------

/** Read a run record under the version it declares. */
export function readEndoExperimentRunRecordV0(value: unknown): EndoVersionedReadV0<EndoExperimentRunRecordV0> {
	return readEndoVersionedV0(ENDO_EXPERIMENT_RUN_VERSIONS_V0, value);
}

/** Read a trial result under the version it declares. */
export function readEndoExperimentTrialResultV0(value: unknown): EndoVersionedReadV0<EndoExperimentTrialResultV0> {
	return readEndoVersionedV0(ENDO_EXPERIMENT_TRIAL_VERSIONS_V0, value);
}
