// DEVELOP-PROTECTED-ATTEMPT-001 (docs/designs/protected-attempt-execution.md): the one relation the evidence bridge could not establish,
// a DEVELOP attempt ("endo.attempt.<32 hex>") and the protected-experiment trial whose reconstructable candidate it produced.
//
// Two write-once records, in "<root>/develop/protected-attempts/" (never beside the attempt's own records in "develop/attempts/", whose
// closed reader lists any other name as a problem and would then refuse to send that attempt from the workbench):
//
//   <id>.launch.json      endo.develop-protected-attempt-launch.v0      the operator, on the controlling terminal, approved THIS operation
//                                                                      (its digest) for THIS attempt. Written after the approval and before
//                                                                      anything is created or run: "authorised; a protected run may follow".
//   <id>.candidate.json   endo.develop-attempt-candidate-binding.v0     the controller that ran it re-read the sealed trial record, saw the
//                                                                      agent's termination confirmed and re-verified the candidate, and
//                                                                      binds these digests. Never written for an incomplete execution.
//
// The binding also has an operator-declared form (boundBy "operator"). It is read and validated so a reader can show it for what it is,
// strictly weaker than a controller-established one; this build ships no command that writes it.
//
// What a binding is NOT: a signature, a proof of origin, a proof of authorship, host authority, acceptance, or a protected PASS. Its digests
// are unkeyed SHA-256 over unsigned files the operator's uid (and so any same-uid process) can rewrite. Workstation H0 stays BLOCKED and
// every protected evaluation stays experimental and non-authoritative.
//
// Pure: types, closed vocabularies and shape validators only. No Node imports; digests and seals are checked in
// runtime/contracts/develop-attempt-candidate-binding.ts.

import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import { ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_DEVELOP_PROTECTED_ATTEMPTS_DIRECTORY_V0 = "protected-attempts";
export const ENDO_DEVELOP_PROTECTED_ATTEMPT_OPERATION_SCHEMA_V0 = "endo.develop-protected-attempt-operation.v0";
export const ENDO_DEVELOP_PROTECTED_ATTEMPT_LAUNCH_SCHEMA_V0 = "endo.develop-protected-attempt-launch.v0";
export const ENDO_DEVELOP_ATTEMPT_CANDIDATE_BINDING_SCHEMA_V0 = "endo.develop-attempt-candidate-binding.v0";

/** The file in the agent directory (mounted at /agent) that carries the frozen brief: the Pi condition's own prompt file. */
export const ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0 = "prompt.txt";

/** The one protected run an attempt can have: its spec id is derived from the attempt's id. */
export const endoProtectedAttemptRunIdV0 = (attemptId: string): string =>
	`endo.experiment.attempt-${attemptId.slice("endo.attempt.".length)}`;

export type EndoProtectedAttemptSpecVersionV0 =
	| "endo.protected-experiment-spec.v2"
	| "endo.protected-experiment-spec.v3";

/**
 * What the operator approves, whole. Its digest (sha256 of its canonical JSON) is the operation digest; the approval phrase carries its
 * first 16 hex characters and the launch record carries all of it. Every value is the launcher's own, computed from the prepared attempt,
 * the operator's template spec and its agent directory; none comes from an agent.
 */
export interface EndoProtectedAttemptOperationV0 {
	schemaVersion: typeof ENDO_DEVELOP_PROTECTED_ATTEMPT_OPERATION_SCHEMA_V0;
	attemptId: string;
	projectId: string;
	taskId: string;
	/** The task file's revision at the check that produced this operation. */
	taskRevision: number;
	/** sha256 of the brief rendered from the prepared record, and its UTF-8 length: the bytes written to /agent/prompt.txt. */
	briefSha256: string;
	briefBytes: number;
	run: {
		/** Absolute host path of the new protected run directory ("<out>/run"). */
		directory: string;
		id: string;
		specSchemaVersion: EndoProtectedAttemptSpecVersionV0;
		/** sha256 of the canonical JSON of the constructed spec (what protected-run.json must carry as specSha256). */
		specSha256: string;
	};
	trial: { task: string; condition: string; trial: 0 };
	agent: {
		/** Absolute host path of the agent directory the launcher builds ("<out>/agent"). */
		directory: string;
		/** Tree digest (endoTreeDigestV0) of the operator's template agent directory as read for this operation. */
		templateTreeSha256: string;
		/** Tree digest of the agent directory the launcher builds: the template with prompt.txt replaced by the brief. */
		treeSha256: string;
		prompt: typeof ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0;
	};
	evaluator: { definitionSha256: string };
	/** A model-connected (v3) template's declared loopback model; null offline (v2). */
	modelAccess: { upstream: string; model: string } | null;
}

/** "<id>.launch.json": immutable. Written by the terminal-authorised launcher only, after the approval, before anything is created or run. */
export interface EndoProtectedAttemptLaunchV0 {
	schemaVersion: typeof ENDO_DEVELOP_PROTECTED_ATTEMPT_LAUNCH_SCHEMA_V0;
	attemptId: string;
	recordedAtMs: number;
	operation: EndoProtectedAttemptOperationV0;
	operationDigest: string;
	approvedBy: "operator";
	/** The exact approval phrase was typed on the launcher's controlling terminal (stdin and stderr both that terminal). */
	via: "controlling-terminal-phrase";
}

export type EndoAttemptBindingBoundByV0 = "controller" | "operator";

/**
 * The epistemic standing of every part of a binding, fixed by who bound it. A validator accepts only the exact standing for its boundBy,
 * so an operator-declared binding can never present itself as controller-established.
 */
export const ENDO_ATTEMPT_BINDING_STANDING_V0 = Object.freeze({
	controller: Object.freeze({
		association: "controller-established",
		attempt: "operator-declared-prepared-record",
		briefSha256: "recomputed-from-prepared-record",
		authorization: "operator-phrase-on-controlling-terminal",
		run: "constructed-and-launched-by-controller",
		trial: "read-from-sealed-trial-record",
		recordSha256: "read-from-sealed-trial-record",
		termination: "controller-observed-scope-confirmed-ended",
		agent: "recomputed-from-mounted-agent-copy",
		candidate: "re-verified-from-baseline-and-changeset-bytes",
	} as const),
	operator: Object.freeze({
		association: "operator-declared",
		attempt: "operator-declared-prepared-record",
		briefSha256: "recomputed-from-prepared-record",
		authorization: "none",
		run: "operator-declared",
		trial: "read-from-sealed-trial-record",
		recordSha256: "read-from-sealed-trial-record",
		termination: "read-from-sealed-trial-record",
		agent: "not-recorded",
		candidate: "re-verified-from-sealed-record-and-bytes",
	} as const),
});
export type EndoAttemptBindingStandingV0 =
	| (typeof ENDO_ATTEMPT_BINDING_STANDING_V0)["controller"]
	| (typeof ENDO_ATTEMPT_BINDING_STANDING_V0)["operator"];

/** Every binding says what its digests are. */
export const ENDO_ATTEMPT_BINDING_INTEGRITY_V0 = "unkeyed-sha256-integrity-evidence-not-signature" as const;

export type EndoAttemptBindingCandidateV0 =
	| { mode: "staged-changeset"; baselineSha256: string; changesetSha256: string; candidateSha256: string }
	| { mode: "fixed-paths"; submissionSha256: string };

export type EndoAttemptBindingRunVersionV0 =
	| "endo.protected-run.v0"
	| "endo.protected-run.v1"
	| "endo.protected-run.v2"
	| "endo.protected-run.v3";

/** "<id>.candidate.json": immutable. */
export interface EndoDevelopAttemptCandidateBindingV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_CANDIDATE_BINDING_SCHEMA_V0;
	attemptId: string;
	projectId: string;
	taskId: string;
	briefSha256: string;
	recordedAtMs: number;
	boundBy: EndoAttemptBindingBoundByV0;
	/** "protected-attempt-launch" with controller; "operator-declaration" with operator. Nothing else. */
	via: "protected-attempt-launch" | "operator-declaration";
	standing: EndoAttemptBindingStandingV0;
	/** The launch the controller ran under: the operation digest the operator approved and the launch record's own digest. Null for operator. */
	authorization: {
		approvedBy: "operator";
		via: "controlling-terminal-phrase";
		operationDigest: string;
		launchSha256: string;
	} | null;
	target: {
		kind: "protected-experiment";
		runDirectory: string;
		runId: string;
		runSchemaVersion: EndoAttemptBindingRunVersionV0;
		specSha256: string;
		trial: { position: number; task: string; condition: string; trial: number; attempt: number };
		recordSha256: string;
		/**
		 * The /agent tree the launch record pinned before the run (re-hashed from the run's retained copy, <run>/.agents/<condition>; the
		 * sealed v2/v3 trial record does not name it), and the digest of its prompt file. Required for controller; null for operator.
		 */
		agent: { treeSha256: string; promptSha256: string } | null;
		candidate: EndoAttemptBindingCandidateV0;
	};
	integrity: typeof ENDO_ATTEMPT_BINDING_INTEGRITY_V0;
	/** sha256 of the canonical JSON of this record without this field. Detects accidents, not forgery. */
	bindingSha256: string;
}

// ---- the reading: one closed set of states -----------------------------------------------------------------------------------------

/**
 * How a DEVELOP attempt relates to a protected-experiment candidate, as read now.
 * - not-supplied: no binding, no launch record, and no protected run was given to the reader (the historical reading).
 * - unestablished: no binding and no launch record, and a protected run was given: it is verified on its own and NOT linked (missing).
 * - established: a controller binding whose every digest matches the re-read launch record, prepared attempt, sealed trial record,
 *   mounted agent copy and re-verified candidate bytes.
 * - operator-declared: an operator binding whose digests match the re-read run and candidate. Never upgraded to established.
 * - invalid: a binding or launch record that is unreadable, malformed, misnamed, mis-sealed, or contradicts what is re-read (a structurally
 *   valid but false binding lands here), or an attempt that was also sent through the workbench.
 * - incomplete-execution: a launch record without a binding: the run is absent, unfinished, interrupted, its termination unconfirmed, or
 *   the binding was never sealed. Never read as a result.
 * - candidate-integrity-failure: the run finished but its candidate does not verify (bytes changed after sealing, or never verified).
 */
export const ENDO_PROTECTED_ATTEMPT_ASSOCIATIONS_V0 = [
	"not-supplied",
	"unestablished",
	"established",
	"operator-declared",
	"invalid",
	"incomplete-execution",
	"candidate-integrity-failure",
] as const;
export type EndoProtectedAttemptAssociationV0 = (typeof ENDO_PROTECTED_ATTEMPT_ASSOCIATIONS_V0)[number];

export const ENDO_PROTECTED_ATTEMPT_ASSOCIATION_LABELS_V0: Readonly<Record<EndoProtectedAttemptAssociationV0, string>> =
	Object.freeze({
		"not-supplied": "No protected run, launch record or binding exists for this attempt",
		unestablished:
			"Missing: no binding record links this attempt to the supplied protected run; it is never inferred from timestamps, text, filenames or agent statements",
		established:
			"Controller-established association: the launcher that ran this attempt bound it, and every digest re-verifies now (integrity evidence, not a signature)",
		"operator-declared":
			"Operator-declared association: the operator's own statement; its digests re-verify now, but no controller established it",
		invalid:
			"Invalid or contradictory binding: unreadable, mis-sealed, or not matching what is re-read now, so it is not admitted",
		"incomplete-execution":
			"Incomplete execution: a protected launch was authorised but no binding was sealed (run absent, unfinished, interrupted or termination unconfirmed)",
		"candidate-integrity-failure":
			"Candidate integrity failure: the protected run's candidate does not verify against its sealed record and bytes",
	});

/** The fixed limitation every bound reading carries. */
export const ENDO_PROTECTED_ATTEMPT_AUTHORITY_LIMITATION_V0 =
	"Matching digests are integrity evidence over unsigned local files a same-uid process can rewrite: not a signature, not proof of origin or authorship, not host authority. Workstation H0 remains BLOCKED; protected evaluation is experimental and non-authoritative and never an authoritative PASS; nothing here accepts, applies or merges the candidate.";

/** The closed checks a binding reading reports, in this order. */
export const ENDO_PROTECTED_ATTEMPT_CHECKS_V0 = [
	"launch-record",
	"binding-record",
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
] as const;
export type EndoProtectedAttemptCheckIdV0 = (typeof ENDO_PROTECTED_ATTEMPT_CHECKS_V0)[number];

export interface EndoProtectedAttemptCheckV0 {
	check: EndoProtectedAttemptCheckIdV0;
	result: "pass" | "fail" | "not-applicable";
	detail: string;
}

// ---- validators --------------------------------------------------------------------------------------------------------------------

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const HEX64 = /^[0-9a-f]{64}$/;
/** As protocol/protected-experiment.ts admits an absolute host path. */
const ABS = /^\/(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9._+\-/]{1,400}$/;
const SPEC_ID = /^endo\.experiment\.[a-z0-9][a-z0-9.-]{0,120}$/;
const PLAN_ID = /^[\x21-\x7e]{1,128}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;
const MODEL = /^[\x21-\x7e]{1,200}$/;

function plain(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
}
const text = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);
const int = (v: unknown, min: number, max: number, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(`${what} is out of range`);
const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not allowed`);

export function validateEndoProtectedAttemptOperationV0(value: unknown): EndoProtectedAttemptOperationV0 {
	const r = plain(
		value,
		[
			"schemaVersion",
			"attemptId",
			"projectId",
			"taskId",
			"taskRevision",
			"briefSha256",
			"briefBytes",
			"run",
			"trial",
			"agent",
			"evaluator",
			"modelAccess",
		],
		"operation",
	);
	const run = plain(r.run, ["directory", "id", "specSchemaVersion", "specSha256"], "operation.run");
	const trial = plain(r.trial, ["task", "condition", "trial"], "operation.trial");
	const agent = plain(r.agent, ["directory", "templateTreeSha256", "treeSha256", "prompt"], "operation.agent");
	const evaluator = plain(r.evaluator, ["definitionSha256"], "operation.evaluator");
	const attemptId = text(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "operation.attemptId");
	const runId = text(run.id, SPEC_ID, "operation.run.id");
	if (runId !== endoProtectedAttemptRunIdV0(attemptId)) bad("operation.run.id is not the attempt's run id");
	let modelAccess: EndoProtectedAttemptOperationV0["modelAccess"] = null;
	if (r.modelAccess !== null) {
		const m = plain(r.modelAccess, ["upstream", "model"], "operation.modelAccess");
		modelAccess = {
			upstream: text(m.upstream, LOOPBACK, "operation.modelAccess.upstream"),
			model: text(m.model, MODEL, "operation.modelAccess.model"),
		};
	}
	const specSchemaVersion = oneOf(
		run.specSchemaVersion,
		["endo.protected-experiment-spec.v2", "endo.protected-experiment-spec.v3"] as const,
		"operation.run.specSchemaVersion",
	);
	if ((specSchemaVersion === "endo.protected-experiment-spec.v3") !== (modelAccess !== null))
		bad("operation.modelAccess does not match the spec version");
	return {
		schemaVersion:
			r.schemaVersion === ENDO_DEVELOP_PROTECTED_ATTEMPT_OPERATION_SCHEMA_V0
				? ENDO_DEVELOP_PROTECTED_ATTEMPT_OPERATION_SCHEMA_V0
				: bad("operation.schemaVersion"),
		attemptId,
		projectId: text(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "operation.projectId"),
		taskId: text(r.taskId, ENDO_TASK_ID_PATTERN_V0, "operation.taskId"),
		taskRevision: int(r.taskRevision, 0, Number.MAX_SAFE_INTEGER, "operation.taskRevision"),
		briefSha256: text(r.briefSha256, HEX64, "operation.briefSha256"),
		briefBytes: int(r.briefBytes, 1, 16 * 1024, "operation.briefBytes"),
		run: {
			directory: text(run.directory, ABS, "operation.run.directory"),
			id: runId,
			specSchemaVersion,
			specSha256: text(run.specSha256, HEX64, "operation.run.specSha256"),
		},
		trial: {
			task: text(trial.task, PLAN_ID, "operation.trial.task"),
			condition: text(trial.condition, PLAN_ID, "operation.trial.condition"),
			trial: trial.trial === 0 ? 0 : bad("operation.trial.trial"),
		},
		agent: {
			directory: text(agent.directory, ABS, "operation.agent.directory"),
			templateTreeSha256: text(agent.templateTreeSha256, HEX64, "operation.agent.templateTreeSha256"),
			treeSha256: text(agent.treeSha256, HEX64, "operation.agent.treeSha256"),
			prompt:
				agent.prompt === ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0
					? ENDO_PROTECTED_ATTEMPT_PROMPT_FILE_V0
					: bad("operation.agent.prompt"),
		},
		evaluator: { definitionSha256: text(evaluator.definitionSha256, HEX64, "operation.evaluator.definitionSha256") },
		modelAccess,
	};
}

export function validateEndoProtectedAttemptLaunchV0(value: unknown): EndoProtectedAttemptLaunchV0 {
	const r = plain(
		value,
		["schemaVersion", "attemptId", "recordedAtMs", "operation", "operationDigest", "approvedBy", "via"],
		"launch",
	);
	const operation = validateEndoProtectedAttemptOperationV0(r.operation);
	const attemptId = text(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "launch.attemptId");
	if (operation.attemptId !== attemptId) bad("launch.operation names another attempt");
	return {
		schemaVersion:
			r.schemaVersion === ENDO_DEVELOP_PROTECTED_ATTEMPT_LAUNCH_SCHEMA_V0
				? ENDO_DEVELOP_PROTECTED_ATTEMPT_LAUNCH_SCHEMA_V0
				: bad("launch.schemaVersion"),
		attemptId,
		recordedAtMs: int(r.recordedAtMs, 0, 8.64e15, "launch.recordedAtMs"),
		operation,
		operationDigest: text(r.operationDigest, HEX64, "launch.operationDigest"),
		approvedBy: r.approvedBy === "operator" ? "operator" : bad("launch.approvedBy"),
		via: r.via === "controlling-terminal-phrase" ? "controlling-terminal-phrase" : bad("launch.via"),
	};
}

function validateCandidate(value: unknown): EndoAttemptBindingCandidateV0 {
	const mode = (value as { mode?: unknown } | null)?.mode;
	if (mode === "staged-changeset") {
		const c = plain(
			value,
			["mode", "baselineSha256", "changesetSha256", "candidateSha256"],
			"binding.target.candidate",
		);
		return {
			mode,
			baselineSha256: text(c.baselineSha256, HEX64, "binding.target.candidate.baselineSha256"),
			changesetSha256: text(c.changesetSha256, HEX64, "binding.target.candidate.changesetSha256"),
			candidateSha256: text(c.candidateSha256, HEX64, "binding.target.candidate.candidateSha256"),
		};
	}
	if (mode === "fixed-paths") {
		const c = plain(value, ["mode", "submissionSha256"], "binding.target.candidate");
		return { mode, submissionSha256: text(c.submissionSha256, HEX64, "binding.target.candidate.submissionSha256") };
	}
	return bad("binding.target.candidate.mode");
}

/**
 * Shape only (the seal is checked by the runtime contract). Closed, and consistent by construction: a controller binding comes only from
 * the protected launch, carries its authorisation, the agent tree, the controller's standing and a staged candidate; an operator binding
 * carries no authorisation and only the operator standing. Anything else is refused, never read as the weaker or the stronger kind.
 */
export function validateEndoDevelopAttemptCandidateBindingV0(value: unknown): EndoDevelopAttemptCandidateBindingV0 {
	const r = plain(
		value,
		[
			"schemaVersion",
			"attemptId",
			"projectId",
			"taskId",
			"briefSha256",
			"recordedAtMs",
			"boundBy",
			"via",
			"standing",
			"authorization",
			"target",
			"integrity",
			"bindingSha256",
		],
		"binding",
	);
	const boundBy = oneOf(r.boundBy, ["controller", "operator"] as const, "binding.boundBy");
	const expectedStanding = ENDO_ATTEMPT_BINDING_STANDING_V0[boundBy];
	const standing = plain(r.standing, Object.keys(expectedStanding), "binding.standing");
	for (const [key, word] of Object.entries(expectedStanding))
		if (standing[key] !== word) bad(`binding.standing.${key} is not the ${boundBy}'s standing`);
	const via = oneOf(r.via, ["protected-attempt-launch", "operator-declaration"] as const, "binding.via");
	if ((boundBy === "controller") !== (via === "protected-attempt-launch")) bad("binding.via does not match boundBy");

	let authorization: EndoDevelopAttemptCandidateBindingV0["authorization"] = null;
	if (r.authorization !== null) {
		const a = plain(
			r.authorization,
			["approvedBy", "via", "operationDigest", "launchSha256"],
			"binding.authorization",
		);
		authorization = {
			approvedBy: a.approvedBy === "operator" ? "operator" : bad("binding.authorization.approvedBy"),
			via:
				a.via === "controlling-terminal-phrase" ? "controlling-terminal-phrase" : bad("binding.authorization.via"),
			operationDigest: text(a.operationDigest, HEX64, "binding.authorization.operationDigest"),
			launchSha256: text(a.launchSha256, HEX64, "binding.authorization.launchSha256"),
		};
	}
	if ((boundBy === "controller") !== (authorization !== null))
		bad("binding.authorization is required for a controller binding and absent for an operator one");

	const t = plain(
		r.target,
		[
			"kind",
			"runDirectory",
			"runId",
			"runSchemaVersion",
			"specSha256",
			"trial",
			"recordSha256",
			"agent",
			"candidate",
		],
		"binding.target",
	);
	const trial = plain(t.trial, ["position", "task", "condition", "trial", "attempt"], "binding.target.trial");
	let agent: EndoDevelopAttemptCandidateBindingV0["target"]["agent"] = null;
	if (t.agent !== null) {
		const a = plain(t.agent, ["treeSha256", "promptSha256"], "binding.target.agent");
		agent = {
			treeSha256: text(a.treeSha256, HEX64, "binding.target.agent.treeSha256"),
			promptSha256: text(a.promptSha256, HEX64, "binding.target.agent.promptSha256"),
		};
	}
	const candidate = validateCandidate(t.candidate);
	const runSchemaVersion = oneOf(
		t.runSchemaVersion,
		["endo.protected-run.v0", "endo.protected-run.v1", "endo.protected-run.v2", "endo.protected-run.v3"] as const,
		"binding.target.runSchemaVersion",
	);
	const staged = runSchemaVersion === "endo.protected-run.v2" || runSchemaVersion === "endo.protected-run.v3";
	if (staged !== (candidate.mode === "staged-changeset"))
		bad("binding.target.candidate does not match the run version");
	if (boundBy === "controller" && (agent === null || !staged))
		bad("a controller binding names the mounted agent tree and a staged candidate");
	if (boundBy === "operator" && agent !== null) bad("an operator binding records no agent tree");
	const attemptId = text(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "binding.attemptId");
	const runId = text(t.runId, SPEC_ID, "binding.target.runId");
	if (boundBy === "controller" && runId !== endoProtectedAttemptRunIdV0(attemptId))
		bad("a controller binding names the attempt's own run id");
	const briefSha256 = text(r.briefSha256, HEX64, "binding.briefSha256");
	if (agent !== null && agent.promptSha256 !== briefSha256) bad("a controller binding's prompt is its brief");

	return {
		schemaVersion:
			r.schemaVersion === ENDO_DEVELOP_ATTEMPT_CANDIDATE_BINDING_SCHEMA_V0
				? ENDO_DEVELOP_ATTEMPT_CANDIDATE_BINDING_SCHEMA_V0
				: bad("binding.schemaVersion"),
		attemptId,
		projectId: text(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "binding.projectId"),
		taskId: text(r.taskId, ENDO_TASK_ID_PATTERN_V0, "binding.taskId"),
		briefSha256,
		recordedAtMs: int(r.recordedAtMs, 0, 8.64e15, "binding.recordedAtMs"),
		boundBy,
		via,
		standing: expectedStanding,
		authorization,
		target: {
			kind: t.kind === "protected-experiment" ? "protected-experiment" : bad("binding.target.kind"),
			runDirectory: text(t.runDirectory, ABS, "binding.target.runDirectory"),
			runId,
			runSchemaVersion,
			specSha256: text(t.specSha256, HEX64, "binding.target.specSha256"),
			trial: {
				position: int(trial.position, 0, 1_000_000, "binding.target.trial.position"),
				task: text(trial.task, PLAN_ID, "binding.target.trial.task"),
				condition: text(trial.condition, PLAN_ID, "binding.target.trial.condition"),
				trial: int(trial.trial, 0, 1_000_000, "binding.target.trial.trial"),
				attempt: int(trial.attempt, 1, 1_000_000, "binding.target.trial.attempt"),
			},
			recordSha256: text(t.recordSha256, HEX64, "binding.target.recordSha256"),
			agent,
			candidate,
		},
		integrity:
			r.integrity === ENDO_ATTEMPT_BINDING_INTEGRITY_V0
				? ENDO_ATTEMPT_BINDING_INTEGRITY_V0
				: bad("binding.integrity"),
		bindingSha256: text(r.bindingSha256, HEX64, "binding.bindingSha256"),
	};
}
