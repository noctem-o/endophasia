// The evaluation and conformance lab v0 schemas: the evaluation profile (the inputs that produced a result),
// the environment profile, the data-partition vocabulary, the trial result (raw and derived kept apart), the
// evaluation result, the conformance study and its suite, the replay comparison, and the experiment bundle
// (README "Evaluation", "Conformance lab", "Replay"). Coordinates identify and locate; they never assert that an
// outcome is good, bad, or accepted — a recorded result is evidence, not authority, and a "supported under
// policy P" or "may replace the current version" statement is a later (Phase 6) record, not a field here.
// The lab services are in lab/; the trial and evidence coordinate shapes in protocol/coordinates.ts.

import { type EndoTrialCoordinatesV0, validateTrialCoordinatesV0 } from "./coordinates.ts";
import type { EndoReplayLayerV0, EndoResourceUsageV0 } from "./event-record.ts";
import { ENDO_REPLAY_LAYERS_V0, validateEndoResourceUsageV0 } from "./event-record.ts";
import { type EndoIdentifierKindV0, isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

/**
 * The data a trial drew from. A partition is a statement about the trial's data, never about its quality.
 *
 * Two partitions are kept apart on purpose:
 *
 * - "validation": data outside the evolve set that selection may read, to choose among candidates (for example a
 *   leakage screen or a second objective). Once a policy has selected on it, it is no longer untouched.
 * - "promotion-holdout": data no selection policy ever reads. It exists only so a promotion decision can be checked
 *   against evidence the search never saw. The in-tree policies refuse a context that contains it, and the
 *   evidence ledger refuses a selection decision that cites a result containing it.
 */
export type EndoEvaluationPartitionV0 =
	| "evolve-set"
	| "validation"
	| "promotion-holdout"
	| "out-of-distribution"
	| "live-traffic"
	| "simulated"
	| "replay";

/** The closed partition vocabulary, machine-checkable. */
export const ENDO_EVALUATION_PARTITIONS_V0 = [
	"evolve-set",
	"validation",
	"promotion-holdout",
	"out-of-distribution",
	"live-traffic",
	"simulated",
	"replay",
] as const satisfies readonly EndoEvaluationPartitionV0[];

/**
 * The cognitive policy under which the candidate runs (README "Cognition policies": WORK and DREAM). A closed
 * pair in v0; a new policy is a protocol change, not a string.
 */
export type EndoCognitionPolicyV0 = "work" | "dream";

/** The closed v0 cognitive policies, machine-checkable. */
export const ENDO_COGNITION_POLICIES_V0 = ["work", "dream"] as const satisfies readonly EndoCognitionPolicyV0[];

/**
 * How one conformance outcome stands against its expected semantic meaning (README "Conformance lab"). A
 * classification is a statement about fit, never about the subject's quality. "Nothing matched exactly" (i.e.
 * UNAVAILABLE) is a useful scientific result, not an error.
 */
export type EndoConformanceClassificationV0 = "EXACT" | "QUALIFIED" | "PARTIAL" | "UNAVAILABLE" | "MISMATCH";

/** The closed conformance classifications, machine-checkable. */
export const ENDO_CONFORMANCE_CLASSIFICATIONS_V0 = [
	"EXACT",
	"QUALIFIED",
	"PARTIAL",
	"UNAVAILABLE",
	"MISMATCH",
] as const satisfies readonly EndoConformanceClassificationV0[];

/**
 * The environment a candidate ran in, identified by name and optional revision. "A simulated result must say
 * that it was simulated": `simulated` is required and explicit — an absent profile is an honest absence, a
 * present one must answer.
 */
export interface EndoEnvironmentProfileV0 {
	schemaVersion: "endo.environment-profile.v0";
	/** The environment's identity, opaque and at most 256 characters. */
	environmentId: string;
	/** The environment's revision, when the environment versions itself. */
	revision?: string;
	/** The sandbox identity, when the environment runs sandboxed. */
	sandboxId?: string;
	/** True when the environment is simulated; the result must carry that forward. */
	simulated: boolean;
}

/**
 * The inputs an evaluation was produced under (README "Evaluation": the "Store:" list minus the outcomes).
 * "A result must identify the inputs that produced it": a result that cannot name its profile is not a result.
 */
export interface EndoEvaluationProfileV0 {
	schemaVersion: "endo.evaluation-profile.v0";
	/** `endo.experiment.*` — the experiment the trials belong to. */
	experimentId: string;
	/** `endo.candidate.*` — the candidate under test; absent for experiment-level evaluations. */
	candidateId?: string;
	/** The candidate's revision, when the candidate versions itself. */
	candidateRevision?: string;
	/** The runtime's identity, e.g. a product name and version. */
	runtime: string;
	/** The model's identity, e.g. a provider and model name. */
	model: string;
	/** The cognitive policy the candidate ran under. */
	cognitionPolicy: EndoCognitionPolicyV0;
	/** The environment profile: identity, optional revision, optional sandbox, and the simulation flag. */
	environment: EndoEnvironmentProfileV0;
	/** The evaluator's identity/revision, when one is recorded. */
	evaluator?: string;
	/** The grader's identity/revision, when one is recorded. */
	grader?: string;
	/**
	 * The recorded seeds, in order; trial i draws seed `i % seeds.length`. Absent when the trials record no seed —
	 * an honest absence, never a fabricated one.
	 */
	seeds?: readonly (number | string)[];
	/** The declared trial count: the result must carry exactly this many trials. */
	trialCount: number;
}

/**
 * One trial's result. The raw outcome (what was recorded) and the derived metrics (what was computed from it)
 * are different records in different fields: a derived value is never silently promoted to an observed one.
 */
export interface EndoTrialResultV0 {
	schemaVersion: "endo.trial-result.v0";
	/** The trial's coordinates: experiment, candidate, index, and the recorded run. */
	coordinates: EndoTrialCoordinatesV0;
	/** The data partition the trial drew from; absent when undeclared, which is not "evolve-set". */
	partition?: EndoEvaluationPartitionV0;
	/** The recorded raw outcome, strict JSON. */
	raw?: JsonValueV0;
	/** The derived metrics, strict JSON. */
	derived?: JsonValueV0;
}

/**
 * An evaluation result: the profile that produced it, the recorded trials, and what the process reported.
 * "Equal-looking outputs with different producing coordinates are not necessarily the same result": the profile
 * is stored, not merely digested, so the difference is visible without a reference.
 */
export interface EndoEvaluationResultV0 {
	schemaVersion: "endo.evaluation-result.v0";
	/** The result's identity, in the evidence namespace. */
	id: string;
	/** The inputs the result was produced under. */
	profile: EndoEvaluationProfileV0;
	/** The recorded trials, exactly `profile.trialCount` of them, in trial order. */
	trials: EndoTrialResultV0[];
	/** The resources the evaluation consumed, as reported. */
	usage?: EndoResourceUsageV0;
	/** The wall-clock duration in milliseconds, as reported. */
	wallTimeMs?: number;
	/** The SHA-256 of the result bundle the trials produced, when one was built; 64 lowercase hex. */
	resultBundleDigest?: string;
	/** The selection policy that read this result, when one was recorded. */
	selectionPolicy?: string;
	/** The promotion state as reported, when one was recorded. */
	promotionState?: string;
}

/**
 * One conformance study: what was claimed, what was observed, and how the two stand (README "Conformance
 * lab"). The study names every input — subject, version, scenario, decoder, predicate, expectation — so that
 * the classification is checkable against named evidence, and every limitation is written down.
 */
export interface EndoConformanceStudyV0 {
	schemaVersion: "endo.conformance-study.v0";
	/** The subject under test, e.g. a runtime or agent name. */
	subject: string;
	/** The subject's version or revision. */
	version: string;
	/** The scenario the study exercised. */
	scenario: string;
	/** The decoder's identity/revision that produced the observed reading. */
	decoder: string;
	/** The predicate's identity that the expected meaning is stated under. */
	predicate: string;
	/** The expected semantic meaning, in words. */
	expected: string;
	/** The observed result, in words. */
	observed: string;
	/** How the observed result stands against the expected meaning. */
	classification: EndoConformanceClassificationV0;
	/** The evidence the classification rests on: digests or endo.evidence.* references. */
	evidence: string[];
	/** The recorded limitations of the study, in words. */
	limitations: string[];
}

/**
 * A conformance suite: the studies for one subject and version, in the order the study declared. The order is
 * part of the record: a suite re-sorted by hand is a different suite (the research conformance discipline —
 * study-declared order, never capture order).
 */
export interface EndoConformanceSuiteV0 {
	schemaVersion: "endo.conformance-suite.v0";
	/** The subject the suite tests; every study must name it. */
	subject: string;
	/** The subject's version or revision; every study must name it. */
	version: string;
	/** The studies, in declared scenario order. */
	studies: EndoConformanceStudyV0[];
}

/**
 * What a replay comparison verified, layer by layer (README "Replay"): the events and derived layers the
 * Phase 2 replay report covers, extended with the graph and the semantic visual state — the full workflow of
 * record, persist, replay, rebuild graph, rebuild visual state, compare against the original. A layer the
 * comparison's inputs cannot support is unreproducible, never omitted.
 */
export interface EndoReplayComparisonV0 {
	schemaVersion: "endo.replay-comparison.v0";
	/** The record the comparison is about. */
	recordId: string;
	/** The events layer: re-validation and the digest. */
	events: EndoReplayLayerV0;
	/** The derived layer: the recorded summary, recomputed. */
	derived: EndoReplayLayerV0;
	/** The SHA-256 the replay computed over the record's events; 64 lowercase hex. Absent when not computable. */
	computedDigest?: string;
	/** The graph layer: the rebuilt graph state against the original. */
	graph: EndoReplayLayerV0;
	/** The visual-state layer: the rebuilt semantic visual state against the original. */
	visualState: EndoReplayLayerV0;
}

/**
 * An experiment bundle: the evaluation result and the bundle's own digest over it. The artifact a consumer
 * persists or compares across processes; its digest makes the bundle checkable after transport.
 */
export interface EndoExperimentBundleV0 {
	schemaVersion: "endo.experiment-bundle.v0";
	/** The bundle's identity, in the evidence namespace. */
	id: string;
	/** The evaluation result the bundle carries. */
	result: EndoEvaluationResultV0;
	/** The SHA-256 over the result in canonical form: 64 lowercase hex. */
	digest: string;
}

const SHA256_HEX_V0 = /^[0-9a-f]{64}$/;

function isSha256HexV0(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX_V0.test(value);
}

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

/** A recorded identity or name: a non-empty string within the given length bound. Opaque by design. */
function isProfileTextV0(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** A recorded statement (expectation, observation, limitation): a non-empty string within the bound. */
function isStatementV0(value: unknown, maxLength: number): value is string {
	return isProfileTextV0(value, maxLength);
}

function isNonNegativeIntegerV0(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPlainRecordV0(value: unknown): value is Record<string, unknown> {
	return isPlainJsonObjectV0(value);
}

function isStrictJsonValue(value: unknown): value is JsonValueV0 {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isStrictJsonValue);
	if (typeof value === "object" && isPlainRecordV0(value)) {
		return Object.entries(value).every(([, entry]) => isStrictJsonValue(entry));
	}
	return false;
}

function isSeedV0(value: unknown): value is number | string {
	return (isNonNegativeIntegerV0(value) && !Array.isArray(value)) || isProfileTextV0(value, 256);
}

const ENDO_ENVIRONMENT_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"environmentId",
	"revision",
	"sandboxId",
	"simulated",
]);

/**
 * Validates an environment profile. Rejects unknown fields, empty or over-long identities, and a missing or
 * non-boolean simulated flag. Returns the validated value unchanged, or null.
 */
export function validateEndoEnvironmentProfileV0(value: unknown): EndoEnvironmentProfileV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_ENVIRONMENT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.environment-profile.v0") return null;
	if (!isProfileTextV0(v.environmentId, 256)) return null;
	if (v.revision !== undefined && !isProfileTextV0(v.revision, 256)) return null;
	if (v.sandboxId !== undefined && !isProfileTextV0(v.sandboxId, 256)) return null;
	if (typeof v.simulated !== "boolean") return null;
	return value as EndoEnvironmentProfileV0;
}

const ENDO_EVALUATION_PROFILE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"experimentId",
	"candidateId",
	"candidateRevision",
	"runtime",
	"model",
	"cognitionPolicy",
	"environment",
	"evaluator",
	"grader",
	"seeds",
	"trialCount",
]);

/**
 * Validates an evaluation profile. Rejects unknown fields, identifiers in the wrong namespace, a cognition
 * policy outside the closed pair, a missing or invalid environment profile, seeds that are neither non-negative
 * integers nor non-empty strings, and a trial count below one. Returns the validated value unchanged, or null.
 */
export function validateEndoEvaluationProfileV0(value: unknown): EndoEvaluationProfileV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EVALUATION_PROFILE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.evaluation-profile.v0") return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (v.candidateId !== undefined && !isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (v.candidateRevision !== undefined && !isProfileTextV0(v.candidateRevision, 256)) return null;
	if (!isProfileTextV0(v.runtime, 256)) return null;
	if (!isProfileTextV0(v.model, 256)) return null;
	if (!(ENDO_COGNITION_POLICIES_V0 as readonly string[]).includes(v.cognitionPolicy as string)) return null;
	if (validateEndoEnvironmentProfileV0(v.environment) === null) return null;
	if (v.evaluator !== undefined && !isProfileTextV0(v.evaluator, 256)) return null;
	if (v.grader !== undefined && !isProfileTextV0(v.grader, 256)) return null;
	if (v.seeds !== undefined) {
		if (!Array.isArray(v.seeds) || v.seeds.length === 0 || !v.seeds.every(isSeedV0)) return null;
	}
	if (typeof v.trialCount !== "number" || !Number.isInteger(v.trialCount) || v.trialCount < 1) return null;
	return value as EndoEvaluationProfileV0;
}

const ENDO_TRIAL_RESULT_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "coordinates", "partition", "raw", "derived"]);

/**
 * Validates a trial result. Rejects unknown fields, invalid trial coordinates, a partition outside the closed
 * vocabulary, and non-strict-JSON raw or derived values. Returns the validated value unchanged, or null.
 */
export function validateEndoTrialResultV0(value: unknown): EndoTrialResultV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_TRIAL_RESULT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.trial-result.v0") return null;
	if (validateTrialCoordinatesV0(v.coordinates) === null) return null;
	if (
		v.partition !== undefined &&
		!(ENDO_EVALUATION_PARTITIONS_V0 as readonly string[]).includes(v.partition as string)
	)
		return null;
	if (v.raw !== undefined && !isStrictJsonValue(v.raw)) return null;
	if (v.derived !== undefined && !isStrictJsonValue(v.derived)) return null;
	return value as EndoTrialResultV0;
}

const ENDO_EVALUATION_RESULT_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"profile",
	"trials",
	"usage",
	"wallTimeMs",
	"resultBundleDigest",
	"selectionPolicy",
	"promotionState",
]);

/**
 * Validates an evaluation result. Rejects unknown fields, a result identity outside the evidence namespace, an
 * invalid profile, an invalid trial, and a trial array that does not match the profile's declared trial count.
 * Returns the validated value unchanged, or null.
 */
export function validateEndoEvaluationResultV0(value: unknown): EndoEvaluationResultV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EVALUATION_RESULT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.evaluation-result.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	const profile = validateEndoEvaluationProfileV0(v.profile);
	if (profile === null) return null;
	if (!Array.isArray(v.trials) || v.trials.length !== profile.trialCount) return null;
	for (const trial of v.trials) if (validateEndoTrialResultV0(trial) === null) return null;
	if (v.usage !== undefined && validateEndoResourceUsageV0(v.usage) === null) return null;
	if (v.wallTimeMs !== undefined && !isNonNegativeIntegerV0(v.wallTimeMs)) return null;
	if (v.resultBundleDigest !== undefined && !isSha256HexV0(v.resultBundleDigest)) return null;
	if (v.selectionPolicy !== undefined && !isProfileTextV0(v.selectionPolicy, 256)) return null;
	if (v.promotionState !== undefined && !isProfileTextV0(v.promotionState, 256)) return null;
	return value as EndoEvaluationResultV0;
}

const ENDO_CONFORMANCE_STUDY_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"subject",
	"version",
	"scenario",
	"decoder",
	"predicate",
	"expected",
	"observed",
	"classification",
	"evidence",
	"limitations",
]);

/** A study evidence reference: a digest or an endo.evidence.* identifier. */
function isStudyEvidenceV0(value: unknown): value is string {
	return isSha256HexV0(value) || isEndoIdentifier(value, "evidence");
}

/**
 * Validates a conformance study. Rejects unknown fields, empty or over-long names and statements, a
 * classification outside the closed five-way, and evidence entries that are neither digests nor
 * endo.evidence.* identifiers. Returns the validated value unchanged, or null.
 */
export function validateEndoConformanceStudyV0(value: unknown): EndoConformanceStudyV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_CONFORMANCE_STUDY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.conformance-study.v0") return null;
	if (!isProfileTextV0(v.subject, 256)) return null;
	if (!isProfileTextV0(v.version, 256)) return null;
	if (!isProfileTextV0(v.scenario, 256)) return null;
	if (!isProfileTextV0(v.decoder, 256)) return null;
	if (!isProfileTextV0(v.predicate, 256)) return null;
	if (!isStatementV0(v.expected, 4096)) return null;
	if (!isStatementV0(v.observed, 4096)) return null;
	if (!(ENDO_CONFORMANCE_CLASSIFICATIONS_V0 as readonly string[]).includes(v.classification as string)) return null;
	if (!Array.isArray(v.evidence) || !v.evidence.every(isStudyEvidenceV0)) return null;
	if (!Array.isArray(v.limitations) || !v.limitations.every((entry) => isStatementV0(entry, 4096))) return null;
	return value as EndoConformanceStudyV0;
}

const ENDO_CONFORMANCE_SUITE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "subject", "version", "studies"]);

/**
 * Validates a conformance suite. Rejects unknown fields, an empty study list, studies that do not name the
 * suite's subject and version, and duplicate scenarios (which would make the declared order ambiguous).
 * Returns the validated value unchanged, or null.
 */
export function validateEndoConformanceSuiteV0(value: unknown): EndoConformanceSuiteV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_CONFORMANCE_SUITE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.conformance-suite.v0") return null;
	if (!isProfileTextV0(v.subject, 256)) return null;
	if (!isProfileTextV0(v.version, 256)) return null;
	if (!Array.isArray(v.studies) || v.studies.length === 0) return null;
	const scenarios = new Set<string>();
	for (const study of v.studies) {
		const validated = validateEndoConformanceStudyV0(study);
		if (validated === null) return null;
		if (validated.subject !== v.subject || validated.version !== v.version) return null;
		if (scenarios.has(validated.scenario)) return null;
		scenarios.add(validated.scenario);
	}
	return value as EndoConformanceSuiteV0;
}

const ENDO_REPLAY_COMPARISON_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"recordId",
	"events",
	"derived",
	"computedDigest",
	"graph",
	"visualState",
]);

/**
 * Validates a replay comparison. Rejects unknown fields, a record identifier outside the evidence namespace,
 * layer values outside the closed three-way, and malformed digests. Returns the validated value unchanged, or
 * null.
 */
export function validateEndoReplayComparisonV0(value: unknown): EndoReplayComparisonV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_REPLAY_COMPARISON_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.replay-comparison.v0") return null;
	if (!isEndoIdentifier(v.recordId, "evidence")) return null;
	if (!(ENDO_REPLAY_LAYERS_V0 as readonly string[]).includes(v.events as string)) return null;
	if (!(ENDO_REPLAY_LAYERS_V0 as readonly string[]).includes(v.derived as string)) return null;
	if (v.computedDigest !== undefined && !isSha256HexV0(v.computedDigest)) return null;
	if (!(ENDO_REPLAY_LAYERS_V0 as readonly string[]).includes(v.graph as string)) return null;
	if (!(ENDO_REPLAY_LAYERS_V0 as readonly string[]).includes(v.visualState as string)) return null;
	return value as EndoReplayComparisonV0;
}

const ENDO_EXPERIMENT_BUNDLE_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "result", "digest"]);

/**
 * Validates an experiment bundle. Rejects unknown fields, a bundle identity outside the evidence namespace, an
 * invalid evaluation result, and a malformed digest. Returns the validated value unchanged, or null.
 */
export function validateEndoExperimentBundleV0(value: unknown): EndoExperimentBundleV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EXPERIMENT_BUNDLE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.experiment-bundle.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (validateEndoEvaluationResultV0(v.result) === null) return null;
	if (!isSha256HexV0(v.digest)) return null;
	return value as EndoExperimentBundleV0;
}
