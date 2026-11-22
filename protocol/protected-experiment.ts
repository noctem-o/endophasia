// Protected experiments (EVAL-ISO-001, docs/protected-experiments.md): the operator's spec, the run record, and one evidence record per
// attempted trial. Language-neutral: shapes, closed vocabularies and the consistency rules between fields. Digests are checked by the
// runtime reader (runtime/contracts/protected-experiment.ts), which also recomputes each record's own digest.
//
// Version 1 (EVAL-ISO-003, docs/protected-model-access.md §9) is a model-connected experiment: the spec declares the model access (one
// upstream, one model, the routes, and the bounds the relay enforces), the agent's sandbox reaches the model only through the relay, and
// each trial record carries the relay's established policy and what its recording shows. Version 0 stays what it was: offline, and refusing
// any relay. Neither is read as the other.
//
// Each record is read only by the validator for the version it declares (protocol/versioned.ts): an unknown version, an unknown field in a
// closed record, or a record whose fields contradict each other is refused, naming why. Nothing is defaulted or migrated. Historical
// experiment records (endo.experiment-run.v0, endo.experiment-trial.v0/v1) are untouched: a protected run writes these records instead.

import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";
import {
	DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	ENDO_CHANGESET_REFUSAL_REASONS_V0,
	ENDO_CHANGESET_VERIFY_FAILURE_REASONS_V0,
	type EndoChangeSetLimitsV0,
	type EndoChangeSetRefusalReasonV0,
	type EndoChangeSetRefusalV0,
	type EndoChangeSetVerifyFailureReasonV0,
	type EndoStagedChangeSetSummaryV0,
	endoFileAncestorConflictV0,
	isPlainChangeSetPathV0,
} from "./staged-changeset.ts";
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
export const ENDO_PROTECTED_SPEC_V1 = "endo.protected-experiment-spec.v1";
export const ENDO_PROTECTED_RUN_V1 = "endo.protected-run.v1";
export const ENDO_PROTECTED_TRIAL_V1 = "endo.protected-trial.v1";
// Versions 2 and 3 (docs/designs/protected-staged-changeset.md) are versions 0 and 1 with staged change-set submission: every task's
// submission is the whole difference between a controller-pinned baseline and the agent's terminated workspace, collected, verified and
// reconstructed before it is evaluated. Version 2 is offline (as 0), version 3 model-connected (as 1). Versions 0 and 1 are unchanged.
export const ENDO_PROTECTED_SPEC_V2 = "endo.protected-experiment-spec.v2";
export const ENDO_PROTECTED_RUN_V2 = "endo.protected-run.v2";
export const ENDO_PROTECTED_TRIAL_V2 = "endo.protected-trial.v2";
export const ENDO_PROTECTED_SPEC_V3 = "endo.protected-experiment-spec.v3";
export const ENDO_PROTECTED_RUN_V3 = "endo.protected-run.v3";
export const ENDO_PROTECTED_TRIAL_V3 = "endo.protected-trial.v3";

const MODEL_CONNECTED_VERSIONS: ReadonlySet<string> = new Set([
	ENDO_PROTECTED_SPEC_V1,
	ENDO_PROTECTED_RUN_V1,
	ENDO_PROTECTED_TRIAL_V1,
	ENDO_PROTECTED_SPEC_V3,
	ENDO_PROTECTED_RUN_V3,
	ENDO_PROTECTED_TRIAL_V3,
]);
const STAGED_VERSIONS: ReadonlySet<string> = new Set([
	ENDO_PROTECTED_SPEC_V2,
	ENDO_PROTECTED_RUN_V2,
	ENDO_PROTECTED_TRIAL_V2,
	ENDO_PROTECTED_SPEC_V3,
	ENDO_PROTECTED_RUN_V3,
	ENDO_PROTECTED_TRIAL_V3,
]);
/** Whether a spec, run or trial version is model-connected (1 and 3). */
export const endoProtectedModelConnectedV0 = (version: string): boolean => MODEL_CONNECTED_VERSIONS.has(version);
/** Whether a spec, run or trial version submits staged change sets (2 and 3). */
export const endoProtectedStagedV2 = (version: string): boolean => STAGED_VERSIONS.has(version);
/** The run version a spec version runs as, and the trial version a run version records: each only as its own. */
export const ENDO_PROTECTED_RUN_OF_SPEC = {
	[ENDO_PROTECTED_SPEC_V0]: ENDO_PROTECTED_RUN_V0,
	[ENDO_PROTECTED_SPEC_V1]: ENDO_PROTECTED_RUN_V1,
	[ENDO_PROTECTED_SPEC_V2]: ENDO_PROTECTED_RUN_V2,
	[ENDO_PROTECTED_SPEC_V3]: ENDO_PROTECTED_RUN_V3,
} as const;
export const ENDO_PROTECTED_TRIAL_OF_RUN = {
	[ENDO_PROTECTED_RUN_V0]: ENDO_PROTECTED_TRIAL_V0,
	[ENDO_PROTECTED_RUN_V1]: ENDO_PROTECTED_TRIAL_V1,
	[ENDO_PROTECTED_RUN_V2]: ENDO_PROTECTED_TRIAL_V2,
	[ENDO_PROTECTED_RUN_V3]: ENDO_PROTECTED_TRIAL_V3,
} as const;
const SPEC_OF_RUN = {
	[ENDO_PROTECTED_RUN_V0]: ENDO_PROTECTED_SPEC_V0,
	[ENDO_PROTECTED_RUN_V1]: ENDO_PROTECTED_SPEC_V1,
	[ENDO_PROTECTED_RUN_V2]: ENDO_PROTECTED_SPEC_V2,
	[ENDO_PROTECTED_RUN_V3]: ENDO_PROTECTED_SPEC_V3,
} as const;

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

/**
 * A model-connected experiment's model access (EVAL-ISO-003): the one way out of every agent sandbox of the run. The controller starts a
 * relay per attempt with exactly this policy (adapters/sandbox/model-relay.ts); the record names it by digest, and the reader judges every
 * forwarded request again under it.
 */
export interface EndoProtectedModelAccessV1 {
	/** The model server's origin, on this host's loopback only: `http://127.0.0.1:<port>`. */
	upstream: string;
	/** The one model every admitted request must name. */
	model: string;
	/** The admitted routes: method and exact path. */
	routes: { method: string; path: string }[];
	maxRequestBytes: number;
	/** All bytes through the relay, both ways, per attempt. */
	maxTransferredBytes: number;
	/** Connections open at once, and accepted over the attempt. */
	maxConnections: number;
	maxTotalConnections: number;
	/** Requests forwarded to the model server per attempt. */
	maxExchanges: number;
	/** The generation bound every admitted request must state (max_tokens or max_completion_tokens; refused, never rewritten). */
	maxCompletionTokens: number;
	/**
	 * The fewest successful model exchanges (answered 2xx, verified) an attempt needs to count as a model-connected result. At least 1: over
	 * an empty recording, a passing evaluation says nothing about the model. Fewer is a judged failure, never a pass and never attrition (the
	 * agent decides whether it calls the model).
	 */
	minExchanges: number;
}

/** Version 1 limits: version 0's, and the agent's scope's memory and CPU, which the kernel enforces on its whole cgroup. */
export interface EndoProtectedLimitsV1 extends EndoProtectedLimitsV0 {
	memoryMaxBytes: number;
	cpuQuotaPercent: number;
}

export interface EndoProtectedSpecV1 extends Omit<EndoProtectedSpecV0, "schemaVersion" | "limits" | "runtime"> {
	schemaVersion: typeof ENDO_PROTECTED_SPEC_V1;
	limits: EndoProtectedLimitsV1;
	/**
	 * Version 0's executables, and aliases: one of them mounted again at another path (`/usr/bin/sh` for `/usr/bin/bash`, where the host's
	 * `sh` is a link and links are refused), read-only and by digest.
	 */
	runtime: { executables: string[]; aliases: { target: string; executable: string }[] };
	modelAccess: EndoProtectedModelAccessV1;
}

/**
 * A staged task's submission (versions 2 and 3): the agent's whole workspace, compared with the baseline the controller pinned from the
 * task's `workspace`, collected (`collectStagedChangeSetV0`) within these explicit bounds. Each bound is at most the collector's default.
 */
export interface EndoProtectedStagedSubmissionV2 {
	mode: "staged-changeset";
	limits: EndoChangeSetLimitsV0;
}

export interface EndoProtectedStagedTaskV2 extends Omit<EndoProtectedTaskV0, "submission"> {
	submission: EndoProtectedStagedSubmissionV2;
}

/** An offline experiment whose tasks submit staged change sets. `limits.maxFileBytes`/`maxTotalBytes` bound fixed-path collection only. */
export interface EndoProtectedSpecV2 extends Omit<EndoProtectedSpecV0, "schemaVersion" | "tasks"> {
	schemaVersion: typeof ENDO_PROTECTED_SPEC_V2;
	tasks: EndoProtectedStagedTaskV2[];
}

/** A model-connected experiment whose tasks submit staged change sets. */
export interface EndoProtectedSpecV3 extends Omit<EndoProtectedSpecV1, "schemaVersion" | "tasks"> {
	schemaVersion: typeof ENDO_PROTECTED_SPEC_V3;
	tasks: EndoProtectedStagedTaskV2[];
}

export type EndoProtectedModelSpec = EndoProtectedSpecV1 | EndoProtectedSpecV3;
export type EndoProtectedStagedSpec = EndoProtectedSpecV2 | EndoProtectedSpecV3;
export type EndoProtectedSpec = EndoProtectedSpecV0 | EndoProtectedSpecV1 | EndoProtectedSpecV2 | EndoProtectedSpecV3;

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
	isolation: {
		mechanism: "bubblewrap";
		version: string;
		executableSha256: string;
		containment: EndoProtectedContainmentV0;
	};
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

/** A model-connected run: version 0's run record over a version 1 spec (its model access included, so in its digest). */
export interface EndoProtectedRunV1 extends Omit<EndoProtectedRunV0, "schemaVersion" | "spec"> {
	schemaVersion: typeof ENDO_PROTECTED_RUN_V1;
	spec: EndoProtectedSpecV1;
}

export interface EndoProtectedRunV2 extends Omit<EndoProtectedRunV0, "schemaVersion" | "spec"> {
	schemaVersion: typeof ENDO_PROTECTED_RUN_V2;
	spec: EndoProtectedSpecV2;
}

export interface EndoProtectedRunV3 extends Omit<EndoProtectedRunV0, "schemaVersion" | "spec"> {
	schemaVersion: typeof ENDO_PROTECTED_RUN_V3;
	spec: EndoProtectedSpecV3;
}

export type EndoProtectedRun = EndoProtectedRunV0 | EndoProtectedRunV1 | EndoProtectedRunV2 | EndoProtectedRunV3;

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

export interface EndoProtectedContainmentV0 {
	mechanism: "systemd-user-scope";
	/** The systemd version of the tools. */
	version: string;
	systemdRunSha256: string;
	tasksMax: number;
}

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
		/** The process containment every sandbox ran in (adapters/sandbox/containment.ts). */
		containment: EndoProtectedContainmentV0;
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
		/**
		 * The agent's systemd user scope: its unit, whether bubblewrap was seen running inside it (false when not observed, as on resume),
		 * and whether the user manager confirmed it ended and its cgroup holds no process. Null
		 * when the agent never ran. `termination: confirmed` requires `ended: confirmed`.
		 */
		scope: { unit: string; established: boolean; ended: "confirmed" | "unconfirmed" } | null;
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

/**
 * Version 1's invalidating conditions: version 0's, and four of the model access. `relay-unavailable`: the relay could not be started, so
 * the agent was not. `recording-incomplete`: a capture write failed, or an exchange has no end or does not verify. `model-upstream-error`: a
 * forwarded request failed on the model server's side. `recording-inconsistent`: the controller could not write the recording's summary
 * as a consistent record (a defect, never expected); its store is kept, and nothing is claimed of it. A refused request is never one of
 * them: it is the agent's doing.
 */
export const ENDO_PROTECTED_INVALIDATING_V1 = [
	...ENDO_PROTECTED_INVALIDATING_V0,
	"relay-unavailable",
	"recording-incomplete",
	"model-upstream-error",
	"recording-inconsistent",
] as const;
export type EndoProtectedInvalidatingV1 = (typeof ENDO_PROTECTED_INVALIDATING_V1)[number];

/** A mount of a version 1 sandbox: version 0's kinds, and the relay's socket. */
export interface EndoProtectedMountV1 extends Omit<EndoProtectedMountV0, "kind"> {
	kind: EndoProtectedMountV0["kind"] | "socket";
}

export const ENDO_PROTECTED_EXCHANGE_CLASSES_V1 = [
	"answered",
	"client-disconnected",
	"model-failed",
	"transfer-bound",
	"refused",
	"not-forwarded",
	"unended",
] as const;

/** One recorded exchange (adapters/sandbox/model-evidence.ts), as the reader derives it again from the recording. */
export interface EndoProtectedModelExchangeV1 {
	exchange: number;
	method: string;
	path: string;
	requestSha256: string;
	status: number | null;
	class: (typeof ENDO_PROTECTED_EXCHANGE_CLASSES_V1)[number];
	verified: boolean;
}

export const ENDO_PROTECTED_RELAY_REFUSALS_V1 = [
	"route",
	"size",
	"body",
	"model",
	"generation",
	"unjudged",
	"connections",
	"exchanges",
] as const;

export interface EndoProtectedRelayV1 {
	/** The digest of the policy the relay enforced (its frozen snapshot). The reader compares it with the run's declared policy. */
	policySha256: string;
	/**
	 * `not-started`: the boundary was not established, so no relay was started. `failed-to-start`: it was, and the relay could not be
	 * started (the agent was not). `ran`: it ran for the agent, and was closed (its recording flushed) after the agent's sandbox ended.
	 * `interrupted`: the controller stopped while it ran; its counters died with it.
	 */
	status: "not-started" | "failed-to-start" | "ran" | "interrupted";
	/** Requests the judge admitted; null unless it ran. */
	admitted: number | null;
	refusals: Record<(typeof ENDO_PROTECTED_RELAY_REFUSALS_V1)[number], number> | null;
	transferredBytes: number | null;
	/** Capture writes that failed. Any makes the recording incomplete. */
	recordingFailures: number | null;
}

export interface EndoProtectedRecordingV1 {
	/**
	 * `complete`: no capture write failed, and every exchange ended and verifies. `incomplete`: otherwise. `unknown`: the controller stopped
	 * while the relay ran, so whether a write was lost is not known. `none`: no relay ran. `inconsistent`: the relay ran, but its summary
	 * did not make a consistent record (a defect): no exchange is claimed, and the trial is attrition, so that no recording an agent shaped
	 * can stop the controller or make its record unwritable.
	 */
	status: "complete" | "incomplete" | "unknown" | "none" | "inconsistent";
	/** The digest domain of the recording (the attempt's own key), or null when nothing was recorded. */
	keyId: string | null;
	/** The spec's minimum of successful model exchanges, repeated so that the record alone states its rule. */
	required: number;
	exchanges: EndoProtectedModelExchangeV1[];
}

export interface EndoProtectedTrialV1
	extends Omit<EndoProtectedTrialV0, "schemaVersion" | "isolation" | "network" | "agent" | "invalidating"> {
	schemaVersion: typeof ENDO_PROTECTED_TRIAL_V1;
	isolation: Omit<EndoProtectedTrialV0["isolation"], "requested"> & {
		requested: Omit<EndoProtectedTrialV0["isolation"]["requested"], "network" | "mounts"> & {
			network: "model-relay";
			mounts: EndoProtectedMountV1[];
		};
		/** The agent's scope's resource limits, enforced by the kernel on its cgroup. */
		limits: { memoryMaxBytes: number; cpuQuotaPercent: number };
	};
	network: { mode: "model-relay"; relay: EndoProtectedRelayV1; status: "established" | "failed" | "unavailable" };
	agent: Omit<EndoProtectedTrialV0["agent"], "scope"> & {
		/** Version 0's scope, and the user manager's result for a limited scope that failed (`oom-kill`), or null. */
		scope: { unit: string; established: boolean; ended: "confirmed" | "unconfirmed"; result: string | null } | null;
	};
	recording: EndoProtectedRecordingV1;
	invalidating: EndoProtectedInvalidatingV1[];
}

/**
 * The staged versions' invalidating conditions, added to their base version's. `baseline-mismatch`: before the agent was started, the
 * attempt's baseline or workspace tree was not the baseline pinned from the spec, so the agent was not started. `changeset-unverified`: a
 * collected change set did not verify against its pins, the complete baseline record and the baseline tree, or could not be reconstructed
 * exactly; nothing was evaluated. Neither is the agent's doing: its termination was confirmed before collection.
 */
export const ENDO_PROTECTED_STAGED_INVALIDATING_V2 = ["baseline-mismatch", "changeset-unverified"] as const;
export const ENDO_PROTECTED_INVALIDATING_V2 = [
	...ENDO_PROTECTED_INVALIDATING_V0,
	...ENDO_PROTECTED_STAGED_INVALIDATING_V2,
] as const;
export type EndoProtectedInvalidatingV2 = (typeof ENDO_PROTECTED_INVALIDATING_V2)[number];
export const ENDO_PROTECTED_INVALIDATING_V3 = [
	...ENDO_PROTECTED_INVALIDATING_V1,
	...ENDO_PROTECTED_STAGED_INVALIDATING_V2,
] as const;
export type EndoProtectedInvalidatingV3 = (typeof ENDO_PROTECTED_INVALIDATING_V3)[number];

/**
 * A staged attempt's change-set evidence, in place of a fixed-path submission.
 * - `baseline`: the pin, derived from the spec's workspace before anything ran; `pinned` when the attempt's baseline and workspace
 *   trees were captured again after the preflight and both were exactly it (only then is the agent started), `mismatch` when not, and
 *   `not-pinned` when the attempt ended before the comparison.
 * - `collection`: what `collectStagedChangeSetV0` returned after the agent's termination was confirmed, with its digest pin.
 * - `verification`: the evaluator step's independent check of the staging directory against both pins, the complete baseline record
 *   and the trusted baseline tree, then the reconstruction of the candidate in a fresh directory; `candidateSha256` is the digest (in the
 *   baseline record's form) of the tree that was evaluated.
 */
/**
 * The most refusals a staged record lists, and the longest refusal path it records. A refusal's path is whatever the collector
 * refused, so it is bounded by the filesystem rather than by any change-set limit: the record is bounded when it is sealed instead,
 * and says so (see `EndoProtectedChangeSetRefusalV2.truncated` and `refusalsOmitted`). What a record derives from its refusals
 * (its invalidating conditions) it derives from `refusalCounts`, which counts every refusal, listed or not.
 */
export const ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2 = 4096;
export const ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2 = 400;

/** A recorded refusal. A path longer than the record's bound keeps its first characters, and records its full length and digest. */
export interface EndoProtectedChangeSetRefusalV2 extends EndoChangeSetRefusalV0 {
	truncated: { length: number; sha256: string } | null;
}

export interface EndoProtectedChangeSetV2 {
	baseline: { status: "pinned" | "mismatch" | "not-pinned"; sha256: string; files: number; totalBytes: number };
	collection: {
		status: "collected" | "refused" | "not-collected";
		changesetSha256: string | null;
		summary: EndoStagedChangeSetSummaryV0 | null;
		/** The first refusals, in the collector's order, at most `ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2`. */
		refusals: EndoProtectedChangeSetRefusalV2[];
		/** How many further refusals the collector made that the record does not list: 0 when it lists them all. */
		refusalsOmitted: number;
		/** Every refusal the collector made, listed or omitted, counted by reason (each reason present, 0 when none). */
		refusalCounts: Record<EndoChangeSetRefusalReasonV0, number>;
	};
	verification: {
		status: "verified" | "failed" | "not-run";
		reason: EndoChangeSetVerifyFailureReasonV0 | null;
		candidateSha256: string | null;
	};
}

/**
 * What a staged attempt handed the evaluator, as the invalidating conditions read it: its status, and one refusal for each reason the
 * collector refused anything for, from the complete census rather than the bounded list, so a reason past the list's bound still counts.
 */
export function endoProtectedStagedHandedV2(
	collection: EndoProtectedChangeSetV2["collection"],
): Pick<EndoProtectedTrialV0["submission"], "status" | "refusals"> {
	return {
		status: collection.status,
		refusals: ENDO_CHANGESET_REFUSAL_REASONS_V0.filter((reason) => collection.refusalCounts[reason] > 0).map(
			(reason) => ({
				path: ".",
				reason,
			}),
		) as unknown as EndoProtectedTrialV0["submission"]["refusals"],
	};
}

export interface EndoProtectedTrialV2
	extends Omit<EndoProtectedTrialV0, "schemaVersion" | "submission" | "invalidating"> {
	schemaVersion: typeof ENDO_PROTECTED_TRIAL_V2;
	changeset: EndoProtectedChangeSetV2;
	invalidating: EndoProtectedInvalidatingV2[];
}

export interface EndoProtectedTrialV3
	extends Omit<EndoProtectedTrialV1, "schemaVersion" | "submission" | "invalidating"> {
	schemaVersion: typeof ENDO_PROTECTED_TRIAL_V3;
	changeset: EndoProtectedChangeSetV2;
	invalidating: EndoProtectedInvalidatingV3[];
}

export type EndoProtectedTrial =
	| EndoProtectedTrialV0
	| EndoProtectedTrialV1
	| EndoProtectedTrialV2
	| EndoProtectedTrialV3;
export type EndoProtectedModelTrial = EndoProtectedTrialV1 | EndoProtectedTrialV3;
export type EndoProtectedStagedTrial = EndoProtectedTrialV2 | EndoProtectedTrialV3;
export const endoProtectedTrialIsModelConnectedV0 = (r: EndoProtectedTrial): r is EndoProtectedModelTrial =>
	endoProtectedModelConnectedV0(r.schemaVersion);
export const endoProtectedTrialIsStagedV2 = (r: EndoProtectedTrial): r is EndoProtectedStagedTrial =>
	endoProtectedStagedV2(r.schemaVersion);

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

function containmentOf(v: unknown, what: string): EndoProtectedContainmentV0 {
	const o = obj(v, ["mechanism", "version", "systemdRunSha256", "tasksMax"], what);
	return {
		mechanism: oneOf(o.mechanism, ["systemd-user-scope"] as const, `${what}.mechanism`),
		version: match(o.version, /^[0-9]{1,6}$/, `${what}.version`),
		systemdRunSha256: match(o.systemdRunSha256, HEX64, `${what}.systemdRunSha256`),
		tasksMax: count(o.tasksMax, `${what}.tasksMax`, 1, 1_000_000),
	};
}

function limitsOf(v: unknown, version: string): EndoProtectedLimitsV0 | EndoProtectedLimitsV1 {
	const v1 = endoProtectedModelConnectedV0(version);
	const o = obj(
		v,
		[
			"agentTimeoutMs",
			"evaluationTimeoutMs",
			"outputBytes",
			"tmpfsBytes",
			"maxFileBytes",
			"maxTotalBytes",
			...(v1 ? ["memoryMaxBytes", "cpuQuotaPercent"] : []),
		],
		"limits",
	);
	const scope = v1
		? {
				memoryMaxBytes: count(
					o.memoryMaxBytes,
					"limits.memoryMaxBytes",
					16 * 1024 * 1024,
					256 * 1024 * 1024 * 1024,
				),
				cpuQuotaPercent: count(o.cpuQuotaPercent, "limits.cpuQuotaPercent", 1, 6400),
			}
		: {};
	return {
		agentTimeoutMs: count(o.agentTimeoutMs, "limits.agentTimeoutMs", 100, 24 * 3_600_000),
		evaluationTimeoutMs: count(o.evaluationTimeoutMs, "limits.evaluationTimeoutMs", 100, 3_600_000),
		outputBytes: count(o.outputBytes, "limits.outputBytes", 1024, 64 * 1024 * 1024),
		tmpfsBytes: count(o.tmpfsBytes, "limits.tmpfsBytes", 1024 * 1024, 8 * 1024 * 1024 * 1024),
		maxFileBytes: count(o.maxFileBytes, "limits.maxFileBytes", 1, 64 * 1024 * 1024),
		maxTotalBytes: count(o.maxTotalBytes, "limits.maxTotalBytes", 1, 256 * 1024 * 1024),
		...scope,
	};
}

/** Where a version 1 sandbox's own mounts live: an alias may not shadow any of them. */
const RESERVED_TARGETS = ["/agent", "/work", "/run", "/tmp", "/home", "/proc", "/dev"] as const;
const ROUTE_PATH = /^\/[A-Za-z0-9._~\-/]{1,200}$/;

function modelAccessOf(v: unknown): EndoProtectedModelAccessV1 {
	const o = obj(
		v,
		[
			"upstream",
			"model",
			"routes",
			"maxRequestBytes",
			"maxTransferredBytes",
			"maxConnections",
			"maxTotalConnections",
			"maxExchanges",
			"maxCompletionTokens",
			"minExchanges",
		],
		"modelAccess",
	);
	// This host's loopback only: the relay's upstream is a local model server, never a remote (possibly paid) service.
	const upstream = match(o.upstream, /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/, "modelAccess.upstream");
	if (Number(upstream.slice("http://127.0.0.1:".length)) > 65535)
		fail("modelAccess.upstream: the port is out of range");
	const routes = list(o.routes, "modelAccess.routes", 16).map((r, i) => {
		const x = obj(r, ["method", "path"], `modelAccess.routes[${i}]`);
		const method = match(x.method, /^[A-Z]{3,7}$/, `modelAccess.routes[${i}].method`);
		if (method === "CONNECT") fail("modelAccess.routes: CONNECT is never a route");
		const path = match(x.path, ROUTE_PATH, `modelAccess.routes[${i}].path`);
		if (path.includes("//") || path.includes("/.")) fail(`modelAccess.routes[${i}].path is not an exact plain path`);
		return { method, path };
	});
	if (routes.length === 0 || new Set(routes.map((r) => `${r.method} ${r.path}`)).size !== routes.length)
		fail("modelAccess.routes must name at least one route, each once");
	const maxExchanges = count(o.maxExchanges, "modelAccess.maxExchanges", 1, 1_000_000);
	return {
		upstream,
		model: match(o.model, /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/, "modelAccess.model"),
		routes,
		maxRequestBytes: count(o.maxRequestBytes, "modelAccess.maxRequestBytes", 1, 1024 * 1024),
		maxTransferredBytes: count(o.maxTransferredBytes, "modelAccess.maxTransferredBytes", 1, 64 * 1024 * 1024 * 1024),
		maxConnections: count(o.maxConnections, "modelAccess.maxConnections", 1, 64),
		maxTotalConnections: count(o.maxTotalConnections, "modelAccess.maxTotalConnections", 1, 1_000_000),
		maxExchanges,
		maxCompletionTokens: count(o.maxCompletionTokens, "modelAccess.maxCompletionTokens", 1, 1_000_000),
		minExchanges: count(o.minExchanges, "modelAccess.minExchanges", 1, maxExchanges),
	};
}

/** A staged task's submission: the mode, and every collection bound explicitly, each at most the collector's default. */
function stagedSubmissionOf(v: unknown, what: string): EndoProtectedStagedSubmissionV2 {
	const o = obj(v, ["mode", "limits"], what);
	const l = obj(
		o.limits,
		["maxFileBytes", "maxTotalStagedBytes", "maxWorkspaceBytes", "maxWalkedEntries", "maxChangedFiles", "maxDepth"],
		`${what}.limits`,
	);
	const d = DEFAULT_ENDO_CHANGESET_LIMITS_V0;
	return {
		mode: oneOf(o.mode, ["staged-changeset"] as const, `${what}.mode`),
		limits: {
			maxFileBytes: count(l.maxFileBytes, `${what}.limits.maxFileBytes`, 1, d.maxFileBytes),
			maxTotalStagedBytes: count(
				l.maxTotalStagedBytes,
				`${what}.limits.maxTotalStagedBytes`,
				1,
				d.maxTotalStagedBytes,
			),
			maxWorkspaceBytes: count(l.maxWorkspaceBytes, `${what}.limits.maxWorkspaceBytes`, 1, d.maxWorkspaceBytes),
			maxWalkedEntries: count(l.maxWalkedEntries, `${what}.limits.maxWalkedEntries`, 1, d.maxWalkedEntries),
			maxChangedFiles: count(l.maxChangedFiles, `${what}.limits.maxChangedFiles`, 1, d.maxChangedFiles),
			maxDepth: count(l.maxDepth, `${what}.limits.maxDepth`, 1, d.maxDepth),
		},
	};
}

function specOf(value: unknown, version: string): EndoProtectedSpec {
	const v1 = endoProtectedModelConnectedV0(version);
	const staged = endoProtectedStagedV2(version);
	const o = obj(
		value,
		[
			"schemaVersion",
			"id",
			"description",
			"seed",
			"trials",
			"limits",
			"runtime",
			"tasks",
			"conditions",
			...(v1 ? ["modelAccess"] : []),
		],
		"spec",
	);
	// Read only as the version it declares (an embedded spec too: a run record's version fixes its spec's).
	if (o.schemaVersion !== version) fail(`spec: schemaVersion is not ${version}`);
	const runtime = obj(o.runtime, v1 ? ["executables", "aliases"] : ["executables"], "runtime");
	const executables = list(runtime.executables, "runtime.executables", 8).map((x, i) =>
		match(x, ABS, `runtime.executables[${i}]`),
	);
	if (executables.length === 0 || new Set(executables).size !== executables.length)
		fail("runtime.executables must name at least one executable, each once");
	const aliases = v1
		? list(runtime.aliases, "runtime.aliases", 8).map((a, i) => {
				const x = obj(a, ["target", "executable"], `runtime.aliases[${i}]`);
				const target = match(x.target, ABS, `runtime.aliases[${i}].target`);
				const executable = match(x.executable, ABS, `runtime.aliases[${i}].executable`);
				if (!executables.includes(executable))
					fail(`runtime.aliases[${i}].executable must be one of runtime.executables`);
				if (RESERVED_TARGETS.some((r) => target === r || target.startsWith(`${r}/`)))
					fail(`runtime.aliases[${i}].target is a path the sandbox reserves`);
				return { target, executable };
			})
		: [];
	const targets = [...executables, ...aliases.map((a) => a.target)];
	if (new Set(targets).size !== targets.length)
		fail("runtime.aliases: each target once, and none an executable's own path");
	const ids = (items: { id: string }[], what: string) => {
		if (items.length === 0 || new Set(items.map((x) => x.id)).size !== items.length)
			fail(`${what} ids must be unique`);
	};
	const tasks = list(o.tasks, "tasks", 64).map((t, i): EndoProtectedTaskV0 | EndoProtectedStagedTaskV2 => {
		const w = `tasks[${i}]`;
		const x = obj(t, ["id", "workspace", "submission", "evaluator"], w);
		if (!isPlainJsonObjectV0(x.workspace)) fail(`${w}.workspace is not an object`);
		// A dictionary with no prototype, its entries defined as own properties: a file named `__proto__` (or `constructor`) is a file,
		// never a prototype assignment that silently drops it.
		const workspace: Record<string, string> = Object.create(null);
		for (const [path, content] of Object.entries(x.workspace as Shape)) {
			match(path, REL, `${w}.workspace path`);
			if (typeof content !== "string") fail(`${w}.workspace content is not text`);
			Object.defineProperty(workspace, path, {
				value: content,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		const e = obj(x.evaluator, ["file", "sha256"], `${w}.evaluator`);
		const evaluator = {
			file: match(e.file, ABS, `${w}.evaluator.file`),
			sha256: match(e.sha256, HEX64, `${w}.evaluator.sha256`),
		};
		if (staged) {
			// The workspace is the baseline: every path a plain change-set path (no .git), and together a possible tree.
			for (const path of Object.keys(workspace))
				if (!isPlainChangeSetPathV0(path)) fail(`${w}.workspace path is not a plain change-set path`);
			if (endoFileAncestorConflictV0(Object.keys(workspace)) !== null)
				fail(`${w}.workspace holds a file beneath another file`);
			return {
				id: match(x.id, SLUG, `${w}.id`),
				workspace,
				submission: stagedSubmissionOf(x.submission, `${w}.submission`),
				evaluator,
			};
		}
		const submission = list(x.submission, `${w}.submission`, 256).map((p, j) =>
			match(p, REL, `${w}.submission[${j}]`),
		);
		if (submission.length === 0 || new Set(submission).size !== submission.length)
			fail(`${w}.submission must name each file once`);
		return { id: match(x.id, SLUG, `${w}.id`), workspace, submission, evaluator };
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
	const common = {
		id: match(o.id, /^endo\.experiment\.[a-z0-9][a-z0-9.-]{0,120}$/, "id"),
		description: text(o.description, "description"),
		seed: nullable(o.seed, (s) => count(s, "seed", 0, 0xffffffff)),
		trials: count(o.trials, "trials", 1, 1000),
		tasks,
		conditions,
	};
	if (!v1)
		return {
			schemaVersion: version,
			...common,
			limits: limitsOf(o.limits, version),
			runtime: { executables },
		} as EndoProtectedSpecV0 | EndoProtectedSpecV2;
	return {
		schemaVersion: version,
		...common,
		limits: limitsOf(o.limits, version) as EndoProtectedLimitsV1,
		runtime: { executables, aliases },
		modelAccess: modelAccessOf(o.modelAccess),
	} as EndoProtectedSpecV1 | EndoProtectedSpecV3;
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

function runOf(value: unknown, version: string): EndoProtectedRun {
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
	// A run is over a spec of its own version only (version 0 over version 0, …, version 3 over version 3): never another.
	const spec = specOf(o.spec, SPEC_OF_RUN[version as keyof typeof SPEC_OF_RUN]);
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
	const iso = obj(o.isolation, ["mechanism", "version", "executableSha256", "containment"], "isolation");
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
		schemaVersion: version as typeof ENDO_PROTECTED_RUN_V0,
		runner: text(o.runner, "runner", 200),
		spec: spec as EndoProtectedSpecV0,
		specSha256: match(o.specSha256, HEX64, "specSha256"),
		seed,
		seedSource,
		ordering: text(o.ordering, "ordering"),
		plan,
		isolation: {
			mechanism: oneOf(iso.mechanism, ["bubblewrap"] as const, "isolation.mechanism"),
			version: text(iso.version, "isolation.version", 80),
			executableSha256: match(iso.executableSha256, HEX64, "isolation.executableSha256"),
			containment: containmentOf(iso.containment, "isolation.containment"),
		},
		profiles,
		evaluators,
		createdAt: match(o.createdAt, ISO, "createdAt"),
	} as EndoProtectedRun;
}

const MOUNT_KINDS = ["ro-file", "ro-dir", "rw-dir", "tmpfs", "proc", "dev", "symlink"] as const;
const MOUNT_KINDS_V1 = [...MOUNT_KINDS, "socket"] as const;
/** Where a version 1 sandbox's relay socket and bridge are mounted (adapters/sandbox/model-relay.ts). */
export const ENDO_PROTECTED_RELAY_SOCKET_TARGET_V1 = "/run/endo/model.sock";
export const ENDO_PROTECTED_RELAY_BRIDGE_TARGET_V1 = "/run/endo/bridge.cjs";

function trialOf(value: unknown, version: string): EndoProtectedTrial {
	const v1 = endoProtectedModelConnectedV0(version);
	const staged = endoProtectedStagedV2(version);
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
			staged ? "changeset" : "submission",
			"evaluation",
			"controller",
			"invalidating",
			"recordedAt",
			"recordSha256",
			...(v1 ? ["recording"] : []),
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
		[
			"mechanism",
			"version",
			"executableSha256",
			"containment",
			"profileSha256",
			"requested",
			...(v1 ? ["limits"] : []),
		],
		"isolation",
	);
	const req = obj(
		iso.requested,
		["namespaces", "network", "rootReadOnly", "userNamespacesDisabled", "environment", "mounts"],
		"isolation.requested",
	);
	const mounts = list(req.mounts, "mounts", 4096).map((m, i): EndoProtectedMountV1 => {
		const x = obj(m, ["target", "kind", "role", "sha256"], `mounts[${i}]`);
		const kind = oneOf(x.kind, v1 ? MOUNT_KINDS_V1 : MOUNT_KINDS, `mounts[${i}].kind`);
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
		mode: v1
			? oneOf(net.mode, ["model-relay"] as const, "network.mode")
			: oneOf(net.mode, ["none"] as const, "network.mode"),
		relay: v1
			? relayOf(net.relay)
			: net.relay === null
				? null
				: fail("network.relay: no relay is supported in this version"),
		status: oneOf(net.status, ["established", "failed", "unavailable"] as const, "network.status"),
	};
	if (network.status === "established" && preflight.status !== "established")
		fail("the network boundary cannot be established when the preflight was not");
	const a = obj(
		o.agent,
		["status", "exitCode", "signal", "durationMs", "termination", "outputSha256", "scope"],
		"agent",
	);
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
		scope: nullable(a.scope, (x) => {
			const sc = obj(
				x,
				v1 ? ["unit", "established", "ended", "result"] : ["unit", "established", "ended"],
				"agent.scope",
			);
			return {
				unit: match(sc.unit, /^endo-sandbox-[0-9a-f]{24}$/, "agent.scope.unit"),
				established: bool(sc.established, "agent.scope.established"),
				ended: oneOf(sc.ended, ["confirmed", "unconfirmed"] as const, "agent.scope.ended"),
				...(v1
					? { result: nullable(sc.result, (r) => match(r, /^[a-z][a-z-]{0,39}$/, "agent.scope.result")) }
					: {}),
			};
		}),
	};
	// Termination is confirmed by the agent's scope having ended, never by a pid alone.
	if (agent.termination === "confirmed" && agent.scope?.ended !== "confirmed")
		fail("a confirmed termination needs the agent's scope confirmed ended");
	if (agent.status === "not-run" && agent.scope !== null) fail("an agent that did not run has no scope");
	// Never unprotected: an agent that ran (or was started) had an established boundary first.
	if (agent.status !== "not-run" && preflight.status !== "established")
		fail("an agent ran without an established boundary");
	if ((agent.status === "not-run") !== (agent.termination === "not-applicable"))
		fail("agent.termination is not-applicable exactly when the agent did not run");
	if (agent.status === "completed" && agent.exitCode !== 0) fail("a completed agent exited 0");
	const ctl = obj(o.controller, ["finalized"], "controller");
	const controller = { finalized: oneOf(ctl.finalized, ["normally", "on-resume"] as const, "controller.finalized") };
	const changeset = staged ? changesetOf(o.changeset, agent, preflight.status, controller.finalized) : null;
	// What the evaluator was handed, by status and refusals: a fixed-path submission, or a staged change set's collection.
	const submission = staged
		? null
		: submissionOf(o.submission, agent.termination as EndoProtectedTrialV0["agent"]["termination"]);
	const handed: Pick<EndoProtectedTrialV0["submission"], "status" | "refusals"> =
		changeset === null
			? (submission as EndoProtectedTrialV0["submission"])
			: endoProtectedStagedHandedV2(changeset.collection);
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
		if (handed.status !== "collected") fail("an evaluation result needs a collected submission");
		if (preflight.status !== "established") fail("an evaluation result needs an established boundary");
		if (cases === null && evaluation.reason === null) fail("an evaluation result counts its cases or says why not");
		if (changeset !== null && changeset.verification.status !== "verified")
			fail("an evaluation result needs a verified change set");
	}
	if (changeset !== null && changeset.verification.status === "failed" && evaluation.status !== "not-run")
		fail("a change set that did not verify is never evaluated");
	if (evaluation.status === "passed" && (cases === null || cases.passed !== cases.total))
		fail("a passed evaluation passed every case");
	if (evaluation.status !== "passed" && evaluation.status !== "failed" && cases !== null)
		fail("only an evaluation that ran counts cases");
	if (controller.finalized === "on-resume" && (evaluation.status !== "not-run" || handed.status === "collected"))
		fail("a record finalized on resume has no collected submission and no evaluation");
	const invalidating = list(o.invalidating, "invalidating", 16).map((x, i) =>
		oneOf(
			x,
			staged
				? v1
					? ENDO_PROTECTED_INVALIDATING_V3
					: ENDO_PROTECTED_INVALIDATING_V2
				: v1
					? ENDO_PROTECTED_INVALIDATING_V1
					: ENDO_PROTECTED_INVALIDATING_V0,
			`invalidating[${i}]`,
		),
	);
	if (new Set(invalidating).size !== invalidating.length) fail("invalidating repeats a condition");
	const relay = network.relay as EndoProtectedRelayV1 | null;
	const recording = v1 ? recordingOf(o.recording) : null;
	if (v1)
		modelConsistency(
			relay as EndoProtectedRelayV1,
			recording as EndoProtectedRecordingV1,
			preflight.status,
			agent.status,
			controller.finalized,
			mounts,
			changeset?.baseline.status === "mismatch",
		);
	// The invalidating conditions follow from the facts above: none may be omitted, and none may be invented.
	const expected: string[] = [
		...(v1
			? expectedInvalidatingV1(
					controller.finalized,
					preflight.status,
					agent,
					handed,
					evaluation.status,
					relay as EndoProtectedRelayV1,
					recording as EndoProtectedRecordingV1,
				)
			: expectedInvalidating(controller.finalized, preflight.status, agent, handed, evaluation.status)),
		...(changeset === null ? [] : expectedStagedInvalidatingV2(changeset)),
	];
	if ([...invalidating].sort().join() !== [...expected].sort().join())
		fail(`invalidating is not what the record's facts imply (${expected.join(", ") || "none"})`);
	return {
		schemaVersion: version as typeof ENDO_PROTECTED_TRIAL_V0,
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
			containment: containmentOf(iso.containment, "isolation.containment"),
			profileSha256: match(iso.profileSha256, HEX64, "isolation.profileSha256"),
			requested: {
				namespaces: list(req.namespaces, "namespaces", 16).map((n) => match(n, /^[a-z]{2,10}$/, "namespace")),
				network: v1
					? (oneOf(req.network, ["model-relay"] as const, "requested.network") as unknown as "none")
					: oneOf(req.network, ["none"] as const, "requested.network"),
				rootReadOnly: bool(req.rootReadOnly, "rootReadOnly"),
				userNamespacesDisabled: bool(req.userNamespacesDisabled, "userNamespacesDisabled"),
				environment: list(req.environment, "environment", 64).map((n) =>
					match(n, /^[A-Z_][A-Z0-9_]{0,63}$/, "variable"),
				),
				mounts: mounts as EndoProtectedMountV0[],
			},
			...(v1 ? { limits: scopeLimitsOf(iso.limits) } : {}),
		},
		preflight,
		network: network as EndoProtectedTrialV0["network"],
		agent: agent as EndoProtectedTrialV0["agent"],
		...(changeset === null ? { submission } : { changeset }),
		evaluation,
		controller,
		invalidating: invalidating as EndoProtectedInvalidatingV0[],
		...(v1 ? { recording } : {}),
		recordedAt: match(o.recordedAt, ISO, "recordedAt"),
		recordSha256: match(o.recordSha256, HEX64, "recordSha256"),
	} as EndoProtectedTrial;
}

/** A fixed-path submission (versions 0 and 1). */
function submissionOf(
	v: unknown,
	termination: EndoProtectedTrialV0["agent"]["termination"],
): EndoProtectedTrialV0["submission"] {
	const s = obj(v, ["status", "files", "sha256", "refusals"], "submission");
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
	if (submission.status === "collected" && termination !== "confirmed")
		fail("a submission is collected only after the agent's termination was confirmed");
	return submission;
}

const SUMMARY_KEYS = [
	"baselineFiles",
	"candidateFiles",
	"unchangedFiles",
	"addedFiles",
	"modifiedFiles",
	"modeChangedFiles",
	"deletedFiles",
	"stagedBytes",
] as const;

/** A staged change set's evidence (versions 2 and 3), against itself and the agent's facts. */
function changesetOf(
	v: unknown,
	agent: Pick<EndoProtectedTrialV0["agent"], "status" | "termination">,
	preflight: EndoProtectedTrialV0["preflight"]["status"],
	finalized: EndoProtectedTrialV0["controller"]["finalized"],
): EndoProtectedChangeSetV2 {
	const o = obj(v, ["baseline", "collection", "verification"], "changeset");
	const b = obj(o.baseline, ["status", "sha256", "files", "totalBytes"], "changeset.baseline");
	const baseline = {
		status: oneOf(b.status, ["pinned", "mismatch", "not-pinned"] as const, "changeset.baseline.status"),
		sha256: match(b.sha256, HEX64, "changeset.baseline.sha256"),
		files: count(b.files, "changeset.baseline.files"),
		totalBytes: count(b.totalBytes, "changeset.baseline.totalBytes"),
	};
	const c = obj(
		o.collection,
		["status", "changesetSha256", "summary", "refusals", "refusalsOmitted", "refusalCounts"],
		"changeset.collection",
	);
	const refusals = list(c.refusals, "changeset.collection.refusals", ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2).map(
		(r, i): EndoProtectedChangeSetRefusalV2 => {
			const w = `changeset.collection.refusals[${i}]`;
			const x = obj(r, ["path", "reason", "truncated"], w);
			const path = text(x.path, `${w}.path`, ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2);
			const truncated = nullable(x.truncated, (t) => {
				const y = obj(t, ["length", "sha256"], `${w}.truncated`);
				return {
					length: count(y.length, `${w}.truncated.length`, ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2 + 1),
					sha256: match(y.sha256, HEX64, `${w}.truncated.sha256`),
				};
			});
			// A truncated path keeps as many characters as the bound allows, less one when the bound would split a surrogate pair.
			if (truncated !== null && path.length < ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2 - 1)
				fail(`${w}: a truncated path keeps the bound's length`);
			return {
				path,
				reason: oneOf(x.reason, ENDO_CHANGESET_REFUSAL_REASONS_V0, `${w}.reason`),
				truncated,
			};
		},
	);
	const refusalsOmitted = count(c.refusalsOmitted, "changeset.collection.refusalsOmitted");
	if (refusalsOmitted > 0 && refusals.length !== ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2)
		fail("refusals are omitted only from a full list");
	const rc = obj(c.refusalCounts, ENDO_CHANGESET_REFUSAL_REASONS_V0, "changeset.collection.refusalCounts");
	const refusalCounts = Object.fromEntries(
		ENDO_CHANGESET_REFUSAL_REASONS_V0.map((k) => [k, count(rc[k], `changeset.collection.refusalCounts.${k}`)]),
	) as Record<EndoChangeSetRefusalReasonV0, number>;
	// The census is the whole population: the listed refusals are part of it, and the rest are exactly the omitted ones.
	if (
		ENDO_CHANGESET_REFUSAL_REASONS_V0.reduce((n, k) => n + refusalCounts[k], 0) !==
		refusals.length + refusalsOmitted
	)
		fail("the refusal counts are not the listed and omitted refusals");
	for (const k of ENDO_CHANGESET_REFUSAL_REASONS_V0)
		if (refusals.filter((r) => r.reason === k).length > refusalCounts[k])
			fail(`the refusal counts list fewer ${k} refusals than the record does`);
	const summary = nullable(c.summary, (x) => {
		const s = obj(x, SUMMARY_KEYS, "changeset.collection.summary");
		return Object.fromEntries(
			SUMMARY_KEYS.map((k) => [k, count(s[k], `changeset.collection.summary.${k}`)]),
		) as unknown as EndoStagedChangeSetSummaryV0;
	});
	const collection = {
		status: oneOf(c.status, ["collected", "refused", "not-collected"] as const, "changeset.collection.status"),
		changesetSha256: nullable(c.changesetSha256, (x) => match(x, HEX64, "changeset.collection.changesetSha256")),
		summary,
		refusals,
		refusalsOmitted,
		refusalCounts,
	};
	const vf = obj(o.verification, ["status", "reason", "candidateSha256"], "changeset.verification");
	const verification = {
		status: oneOf(vf.status, ["verified", "failed", "not-run"] as const, "changeset.verification.status"),
		reason: nullable(vf.reason, (x) =>
			oneOf(x, ENDO_CHANGESET_VERIFY_FAILURE_REASONS_V0, "changeset.verification.reason"),
		),
		candidateSha256: nullable(vf.candidateSha256, (x) => match(x, HEX64, "changeset.verification.candidateSha256")),
	};
	// The agent is started only on a pinned baseline; a mismatch is found after the boundary was established, before any agent.
	if (agent.status !== "not-run" && baseline.status !== "pinned")
		fail("an agent is started only on a pinned baseline");
	if (baseline.status === "mismatch" && (preflight !== "established" || finalized !== "normally"))
		fail("a baseline mismatch is found after an established boundary, in an attempt the controller finished");
	const collected = collection.status === "collected";
	if (collected !== (collection.changesetSha256 !== null) || collected !== (summary !== null))
		fail("a collected change set, and only one, has a digest and a summary");
	if ((collection.status === "refused") !== refusals.length > 0) fail("a refused change set, and only one, says why");
	if (collection.status !== "not-collected" && agent.termination !== "confirmed")
		fail("a change set is collected only after the agent's termination was confirmed");
	if (summary !== null) {
		if (summary.baselineFiles !== baseline.files) fail("the change set's baseline is not the pinned baseline");
		if (
			summary.baselineFiles !==
				summary.unchangedFiles + summary.modifiedFiles + summary.modeChangedFiles + summary.deletedFiles ||
			summary.candidateFiles !==
				summary.unchangedFiles + summary.modifiedFiles + summary.modeChangedFiles + summary.addedFiles
		)
			fail("the change set's summary contradicts its own counts");
	}
	const verified = verification.status === "verified";
	if (verification.status !== "not-run" && !collected) fail("only a collected change set is verified");
	if (verified !== (verification.candidateSha256 !== null))
		fail("a verified change set, and only one, names the candidate it reconstructed");
	if ((verification.status === "failed") !== (verification.reason !== null))
		fail("a change set that did not verify, and only one, says why");
	return { baseline, collection, verification };
}

/** The staged versions' own invalidating conditions, in a fixed order, after their base version's. */
export function expectedStagedInvalidatingV2(
	changeset: Pick<EndoProtectedChangeSetV2, "baseline" | "verification">,
): (typeof ENDO_PROTECTED_STAGED_INVALIDATING_V2)[number][] {
	const out: (typeof ENDO_PROTECTED_STAGED_INVALIDATING_V2)[number][] = [];
	if (changeset.baseline.status === "mismatch") out.push("baseline-mismatch");
	if (changeset.verification.status === "failed") out.push("changeset-unverified");
	return out;
}

function scopeLimitsOf(v: unknown): { memoryMaxBytes: number; cpuQuotaPercent: number } {
	const o = obj(v, ["memoryMaxBytes", "cpuQuotaPercent"], "isolation.limits");
	return {
		memoryMaxBytes: count(
			o.memoryMaxBytes,
			"isolation.limits.memoryMaxBytes",
			16 * 1024 * 1024,
			256 * 1024 * 1024 * 1024,
		),
		cpuQuotaPercent: count(o.cpuQuotaPercent, "isolation.limits.cpuQuotaPercent", 1, 6400),
	};
}

function relayOf(v: unknown): EndoProtectedRelayV1 {
	const o = obj(
		v,
		["policySha256", "status", "admitted", "refusals", "transferredBytes", "recordingFailures"],
		"network.relay",
	);
	const status = oneOf(
		o.status,
		["not-started", "failed-to-start", "ran", "interrupted"] as const,
		"network.relay.status",
	);
	const relay: EndoProtectedRelayV1 = {
		policySha256: match(o.policySha256, HEX64, "network.relay.policySha256"),
		status,
		admitted: nullable(o.admitted, (x) => count(x, "network.relay.admitted")),
		refusals: nullable(o.refusals, (x) => {
			const r = obj(x, ENDO_PROTECTED_RELAY_REFUSALS_V1, "network.relay.refusals");
			return Object.fromEntries(
				ENDO_PROTECTED_RELAY_REFUSALS_V1.map((k) => [k, count(r[k], `network.relay.refusals.${k}`)]),
			) as EndoProtectedRelayV1["refusals"];
		}),
		transferredBytes: nullable(o.transferredBytes, (x) => count(x, "network.relay.transferredBytes")),
		recordingFailures: nullable(o.recordingFailures, (x) => count(x, "network.relay.recordingFailures")),
	};
	// The relay's own counters exist exactly when it ran to its close: an interrupted relay's died with the controller.
	const counted = [relay.admitted, relay.refusals, relay.transferredBytes, relay.recordingFailures];
	if (status === "ran" ? counted.some((c) => c === null) : counted.some((c) => c !== null))
		fail("network.relay: the relay's counters are recorded exactly when it ran");
	return relay;
}

function recordingOf(v: unknown): EndoProtectedRecordingV1 {
	const o = obj(v, ["status", "keyId", "required", "exchanges"], "recording");
	const exchanges = list(o.exchanges, "recording.exchanges", 1_000_000).map((e, i): EndoProtectedModelExchangeV1 => {
		const x = obj(
			e,
			["exchange", "method", "path", "requestSha256", "status", "class", "verified"],
			`exchanges[${i}]`,
		);
		return {
			exchange: count(x.exchange, `exchanges[${i}].exchange`, 1),
			// As the proxy parses them: an HTTP token, and a target within its head bound (256 KiB). An agent chooses both.
			method: match(x.method, /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,262144}$/, `exchanges[${i}].method`),
			path: text(x.path, `exchanges[${i}].path`, 262144),
			requestSha256: match(x.requestSha256, HEX64, `exchanges[${i}].requestSha256`),
			status: nullable(x.status, (s) => count(s, `exchanges[${i}].status`, 100, 999)),
			class: oneOf(x.class, ENDO_PROTECTED_EXCHANGE_CLASSES_V1, `exchanges[${i}].class`),
			verified: bool(x.verified, `exchanges[${i}].verified`),
		};
	});
	// Numbered as the recording numbers them: 1, 2, 3… without a gap (a cassette is contiguous).
	if (exchanges.some((e, i) => e.exchange !== i + 1)) fail("recording.exchanges are numbered from 1 without gaps");
	for (const e of exchanges)
		if (
			e.class === "answered"
				? e.status === null
				: e.class === "refused" || e.class === "not-forwarded"
					? e.status !== null
					: false
		)
			fail(`recording.exchanges: exchange ${e.exchange} has a status its class cannot have`);
	const keyId = nullable(o.keyId, (k) => match(k, /^[A-Za-z0-9._:-]{1,128}$/, "recording.keyId"));
	if (keyId === null && exchanges.length > 0)
		fail("recording: exchanges need the digest domain they were recorded in");
	return {
		status: oneOf(
			o.status,
			["complete", "incomplete", "unknown", "none", "inconsistent"] as const,
			"recording.status",
		),
		keyId,
		required: count(o.required, "recording.required", 1, 1_000_000),
		exchanges,
	};
}

/** Requests the recording shows forwarded for certain (adapters/sandbox/model-evidence.ts), and those it shows possibly forwarded. */
const certainlyForwarded = (e: EndoProtectedModelExchangeV1) =>
	e.class === "answered" ||
	e.class === "model-failed" ||
	e.class === "transfer-bound" ||
	(e.class === "client-disconnected" && e.status !== null);
const possiblyForwarded = (e: EndoProtectedModelExchangeV1) => e.class === "client-disconnected" && e.status === null;

/** A version 1 record's model facts, against each other and the rest of the record. */
function modelConsistency(
	relay: EndoProtectedRelayV1,
	recording: EndoProtectedRecordingV1,
	preflight: EndoProtectedTrialV0["preflight"]["status"],
	agent: EndoProtectedTrialV0["agent"]["status"],
	finalized: EndoProtectedTrialV0["controller"]["finalized"],
	mounts: readonly EndoProtectedMountV1[],
	baselineMismatch = false,
): void {
	// The sandbox's one way out is the relay's socket, mounted alone, with the bridge beside it.
	const sockets = mounts.filter((m) => m.kind === "socket");
	if (
		sockets.length !== 1 ||
		sockets[0]?.target !== ENDO_PROTECTED_RELAY_SOCKET_TARGET_V1 ||
		sockets[0]?.role !== "model-relay" ||
		!mounts.some(
			(m) => m.target === ENDO_PROTECTED_RELAY_BRIDGE_TARGET_V1 && m.kind === "ro-file" && m.role === "model-bridge",
		)
	)
		fail("a model-connected sandbox mounts exactly the relay's socket and its bridge");
	// A relay that ran was closed after its agent: on resume too, when the controller stopped later (collecting, evaluating).
	if (relay.status === "ran" && agent === "not-run") fail("a relay that ran served an agent");
	if (relay.status === "interrupted" && finalized !== "on-resume")
		fail("a relay is interrupted only in an attempt finalized on resume");
	if (
		relay.status === "failed-to-start" &&
		(agent !== "not-run" || preflight !== "established" || finalized !== "normally")
	)
		fail("a relay that failed to start follows an established boundary, and no agent ran");
	if (relay.status === "not-started" && agent !== "not-run") fail("an agent ran without its relay");
	// After an established boundary, the controller either starts the relay or records that it failed to: never neither, unless it
	// stopped in between (on resume).
	// A staged attempt whose baseline did not match its pin after the boundary was established starts neither its relay nor its agent.
	if (relay.status === "not-started" && preflight === "established" && finalized !== "on-resume" && !baselineMismatch)
		fail("a relay not started after an established boundary needs an attempt finalized on resume");
	if (agent !== "not-run" && relay.status !== "ran" && relay.status !== "interrupted")
		fail("an agent ran without its relay");
	if (preflight !== "established" && relay.status !== "not-started")
		fail("a relay is started only after the boundary was established");
	const nothing = recording.status === "none";
	if ((relay.status === "not-started" || relay.status === "failed-to-start") !== nothing)
		fail("recording.status is none exactly when no relay ran");
	if (nothing && (recording.keyId !== null || recording.exchanges.length > 0))
		fail("a recording with no relay has no exchanges");
	if ((relay.status === "interrupted") !== (recording.status === "unknown") && recording.status !== "inconsistent")
		fail("recording.status is unknown exactly when the relay was interrupted");
	if (recording.status === "inconsistent" && (nothing || recording.exchanges.length > 0))
		fail("an inconsistent recording follows a relay that ran, and claims no exchange");
	if (relay.status === "ran" && recording.status !== "inconsistent") {
		// A relay that ran always opened its recording (its start is an event): one that does not load at all is not whole.
		const whole =
			relay.recordingFailures === 0 &&
			recording.keyId !== null &&
			recording.exchanges.every((e) => e.verified && e.class !== "unended");
		if ((recording.status === "complete") !== whole)
			fail(
				"recording.status is complete exactly when the recording loads, no capture write failed, and every exchange ended and verifies",
			);
		// Two accounts of the same requests: the judge's count, and the exchanges the recording shows forwarded, certainly or possibly.
		const certain = recording.exchanges.filter(certainlyForwarded).length;
		const possible = recording.exchanges.filter(possiblyForwarded).length;
		const admitted = relay.admitted as number;
		if (recording.status === "complete" && (admitted < certain || admitted > certain + possible))
			fail(
				"a complete recording shows the requests the relay admitted: no fewer forwarded, no more possibly forwarded",
			);
	}
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

/** A version 1 record's invalidating conditions: version 0's, then the model access's, in a fixed order. */
export function expectedInvalidatingV1(
	finalized: EndoProtectedTrialV0["controller"]["finalized"],
	preflight: EndoProtectedTrialV0["preflight"]["status"],
	agent: Pick<EndoProtectedTrialV0["agent"], "status" | "termination">,
	submission: Pick<EndoProtectedTrialV0["submission"], "status" | "refusals">,
	evaluation: EndoProtectedTrialV0["evaluation"]["status"],
	relay: Pick<EndoProtectedRelayV1, "status">,
	recording: Pick<EndoProtectedRecordingV1, "status" | "exchanges">,
): EndoProtectedInvalidatingV1[] {
	const out: EndoProtectedInvalidatingV1[] = expectedInvalidating(finalized, preflight, agent, submission, evaluation);
	if (relay.status === "failed-to-start") out.push("relay-unavailable");
	if (recording.status === "incomplete") out.push("recording-incomplete");
	if (recording.exchanges.some((e) => e.class === "model-failed")) out.push("model-upstream-error");
	if (recording.status === "inconsistent") out.push("recording-inconsistent");
	return out;
}

/** Successful model exchanges in a version 1 record: answered with a 2xx status, and verified. */
export const endoProtectedSuccessfulExchangesV1 = (r: EndoProtectedModelTrial): number =>
	r.recording.exchanges.filter(
		(e) => e.class === "answered" && e.verified && e.status !== null && e.status >= 200 && e.status < 300,
	).length;

export const ENDO_PROTECTED_SPEC_VERSIONS_V0 = defineEndoVersionTableV0<EndoProtectedSpec>(
	"endo.protected-experiment-spec",
	[
		[ENDO_PROTECTED_SPEC_V0, (v) => specOf(v, ENDO_PROTECTED_SPEC_V0)],
		[ENDO_PROTECTED_SPEC_V1, (v) => specOf(v, ENDO_PROTECTED_SPEC_V1)],
		[ENDO_PROTECTED_SPEC_V2, (v) => specOf(v, ENDO_PROTECTED_SPEC_V2)],
		[ENDO_PROTECTED_SPEC_V3, (v) => specOf(v, ENDO_PROTECTED_SPEC_V3)],
	],
);
export const ENDO_PROTECTED_RUN_VERSIONS_V0 = defineEndoVersionTableV0<EndoProtectedRun>("endo.protected-run", [
	[ENDO_PROTECTED_RUN_V0, (v) => runOf(v, ENDO_PROTECTED_RUN_V0)],
	[ENDO_PROTECTED_RUN_V1, (v) => runOf(v, ENDO_PROTECTED_RUN_V1)],
	[ENDO_PROTECTED_RUN_V2, (v) => runOf(v, ENDO_PROTECTED_RUN_V2)],
	[ENDO_PROTECTED_RUN_V3, (v) => runOf(v, ENDO_PROTECTED_RUN_V3)],
]);
export const ENDO_PROTECTED_TRIAL_VERSIONS_V0 = defineEndoVersionTableV0<EndoProtectedTrial>("endo.protected-trial", [
	[ENDO_PROTECTED_TRIAL_V0, (v) => trialOf(v, ENDO_PROTECTED_TRIAL_V0)],
	[ENDO_PROTECTED_TRIAL_V1, (v) => trialOf(v, ENDO_PROTECTED_TRIAL_V1)],
	[ENDO_PROTECTED_TRIAL_V2, (v) => trialOf(v, ENDO_PROTECTED_TRIAL_V2)],
	[ENDO_PROTECTED_TRIAL_V3, (v) => trialOf(v, ENDO_PROTECTED_TRIAL_V3)],
]);
export const ENDO_FUNCTION_EVALUATOR_VERSIONS_V0 = defineEndoVersionTableV0<EndoFunctionEvaluatorV0>(
	"endo.function-evaluator",
	[[ENDO_FUNCTION_EVALUATOR_V0, evaluatorOf]],
);

/** Reads a spec of either version, each strictly by its own rules: the caller tells them apart by `schemaVersion`. */
export const readEndoProtectedSpecV0 = (v: unknown): EndoVersionedReadV0<EndoProtectedSpec> =>
	readEndoVersionedV0(ENDO_PROTECTED_SPEC_VERSIONS_V0, v);
export const readEndoProtectedRunV0 = (v: unknown): EndoVersionedReadV0<EndoProtectedRun> =>
	readEndoVersionedV0(ENDO_PROTECTED_RUN_VERSIONS_V0, v);
export const readEndoProtectedTrialV0 = (v: unknown): EndoVersionedReadV0<EndoProtectedTrial> =>
	readEndoVersionedV0(ENDO_PROTECTED_TRIAL_VERSIONS_V0, v);
export const readEndoFunctionEvaluatorV0 = (v: unknown): EndoVersionedReadV0<EndoFunctionEvaluatorV0> =>
	readEndoVersionedV0(ENDO_FUNCTION_EVALUATOR_VERSIONS_V0, v);

/**
 * A trial's outcome for analysis. `attrition`: something outside the agent's control kept it from being judged (the boundary, the
 * controller, the host, the evaluator infrastructure). Otherwise it is judged: `passed` or `failed` by the independent evaluator, or
 * `failed` because the agent left no acceptable submission (missing, a link, a special file, unreadable, too large), which it chose.
 */
export function endoProtectedTrialOutcomeV0(r: EndoProtectedTrial): {
	outcome: "passed" | "failed" | "attrition";
	reason: string | null;
} {
	if (r.invalidating.length > 0) return { outcome: "attrition", reason: r.invalidating[0] as string };
	// A model-connected trial with fewer successful model exchanges than its spec requires is not a model-connected result: whatever the
	// evaluator found (kept as the evaluator's fact), it is a judged failure. Never attrition, since the agent decides whether it calls
	// the model (and an agent able to remove itself from the denominator could bias a comparison), and never a pass.
	if (
		endoProtectedTrialIsModelConnectedV0(r) &&
		r.agent.status !== "not-run" &&
		endoProtectedSuccessfulExchangesV1(r) < r.recording.required
	)
		return { outcome: "failed", reason: "model-exchanges-below-minimum" };
	if (r.evaluation.status === "passed") return { outcome: "passed", reason: null };
	if (r.evaluation.status === "failed") return { outcome: "failed", reason: r.evaluation.reason };
	// A staged change set the collector refused (a link, a special file, .git, too large or too many) is the agent's own doing too.
	if (endoProtectedTrialIsStagedV2(r)) {
		if (r.changeset.collection.status === "refused")
			return { outcome: "failed", reason: `changeset-${r.changeset.collection.refusals[0]?.reason ?? "refused"}` };
	} else if (r.submission.status === "missing" || r.submission.status === "refused")
		return { outcome: "failed", reason: `submission-${r.submission.refusals[0]?.reason ?? r.submission.status}` };
	return { outcome: "attrition", reason: `evaluation-${r.evaluation.status}` };
}

/** Whether a trial enters a qualified comparison: it was judged (passed or failed), not lost to attrition. */
export function endoProtectedTrialQualifiesV0(r: EndoProtectedTrial): boolean {
	return endoProtectedTrialOutcomeV0(r).outcome !== "attrition";
}
