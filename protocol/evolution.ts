/**
 * Phase 6 — the evolution substrate: artifacts, mutations, candidates, experiments, transitions,
 * selection decisions, and promotion requests/decisions (README "# The evolution layer",
 * "## Phase 6 — Evolution substrate").
 *
 * The substrate is algorithm-neutral: it records what a candidate is, what was changed, what was
 * measured, what was decided, and who decided it. It owns no selection policy, no promotion
 * authority, no deployment, and no receipt. Selection and promotion are recorded decisions, not
 * gates; a promotion decision is a record about a request and confers no authority.
 *
 * Every shape is a record, never an event: the same discipline as the Phase 5 evaluation shapes.
 * Records that are evidence (artifacts, mutations, transitions, selection decisions, promotion
 * requests and decisions) use the endo.evidence.* namespace; candidates use endo.candidate.*;
 * experiments use endo.experiment.*. The identifier grammar (README "# Identity") is unchanged.
 */

import type { EndoEnvironmentProfileV0 } from "./evaluation.ts";
import { validateEndoEnvironmentProfileV0 } from "./evaluation.ts";
import type { EndoIdentifierKindV0 } from "./identity.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import type { JsonValueV0 } from "./primitives.ts";

/**
 * SHA-256 digest: 64 lowercase hex characters.
 */
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

/**
 * Strict JSON: plain objects and arrays only — the JSON canonical form is defined over plain values.
 * Non-finite numbers are rejected.
 */
function isStrictJsonValue(value: unknown): value is JsonValueV0 {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isStrictJsonValue);
	if (typeof value === "object") return Object.entries(value).every(([, entry]) => isStrictJsonValue(entry));
	return false;
}

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * The candidate states. "active" and "superseded" describe where a candidate stands relative to its
 * descendants; "retired" is terminal. A missing state is honest absence, not "active" by default.
 */
export type EndoCandidateStateV0 = "active" | "superseded" | "retired";

/** The closed candidate states. */
export const ENDO_CANDIDATE_STATES_V0 = [
	"active",
	"superseded",
	"retired",
] as const satisfies readonly EndoCandidateStateV0[];

/**
 * The mutation operations. The operation names the change; the component names what was changed; the
 * artifact reference (when present) names the changed content. The substrate is representation-
 * neutral: no textual patch format is assumed.
 */
export type EndoMutationOperationV0 = "add" | "replace" | "remove" | "reconfigure";

/** The closed mutation operations. */
export const ENDO_MUTATION_OPERATIONS_V0 = [
	"add",
	"replace",
	"remove",
	"reconfigure",
] as const satisfies readonly EndoMutationOperationV0[];

/**
 * The experiment lifecycle states. The spine is created → prepared → running → evaluated → compared;
 * "compared" branches to selected / rejected / inconclusive; "selected" continues to
 * promotion-requested, which ends at promoted / denied. The four terminal states have no exits.
 */
export type EndoExperimentStateV0 =
	| "created"
	| "prepared"
	| "running"
	| "evaluated"
	| "compared"
	| "selected"
	| "rejected"
	| "inconclusive"
	| "promotion-requested"
	| "promoted"
	| "denied";

/** The closed experiment lifecycle states. */
export const ENDO_EXPERIMENT_STATES_V0 = [
	"created",
	"prepared",
	"running",
	"evaluated",
	"compared",
	"selected",
	"rejected",
	"inconclusive",
	"promotion-requested",
	"promoted",
	"denied",
] as const satisfies readonly EndoExperimentStateV0[];

/**
 * The closed lifecycle transition table: the complete state machine. A transition whose `to` is not
 * in the table entry for its `from` is invalid as a record — the validator enforces this, so an
 * illegal transition cannot enter the substrate from any door. Terminal states have no exits.
 */
export const ENDO_EXPERIMENT_STATE_TRANSITIONS_V0: Readonly<
	Record<EndoExperimentStateV0, readonly EndoExperimentStateV0[]>
> = {
	created: ["prepared"],
	prepared: ["running"],
	running: ["evaluated"],
	evaluated: ["compared"],
	compared: ["selected", "rejected", "inconclusive"],
	selected: ["promotion-requested"],
	"promotion-requested": ["promoted", "denied"],
	rejected: [],
	inconclusive: [],
	promoted: [],
	denied: [],
};

/**
 * The selection outcomes. "selected" names the chosen candidate; "rejected" and "inconclusive" name
 * none. A selection decision is a recorded policy result — the policy identity, the outcome, the
 * evaluated conditions, and the evidence read — never an implicit "highest score wins".
 */
export type EndoSelectionOutcomeV0 = "selected" | "rejected" | "inconclusive";

/** The closed selection outcomes. */
export const ENDO_SELECTION_OUTCOMES_V0 = [
	"selected",
	"rejected",
	"inconclusive",
] as const satisfies readonly EndoSelectionOutcomeV0[];

/** The promotion outcomes. */
export type EndoPromotionOutcomeV0 = "granted" | "denied";

/** The closed promotion outcomes. */
export const ENDO_PROMOTION_OUTCOMES_V0 = ["granted", "denied"] as const satisfies readonly EndoPromotionOutcomeV0[];

/**
 * The evidence ledger kinds: the closed set of record kinds the ledger can hold. Every kind maps
 * one-to-one to a schemaVersion (the ledger derives the kind from the record, never from a caller-
 * supplied field). The "candidate" kind is the one kind whose record lives outside the evidence
 * namespace (endo.candidate.*).
 */
export type EndoEvidenceKindV0 =
	| "evaluation-result"
	| "conformance-suite"
	| "experiment-bundle"
	| "replay-comparison"
	| "mutation"
	| "artifact"
	| "candidate"
	| "selection-decision"
	| "promotion-request"
	| "promotion-decision"
	| "experiment-transition";

/** The closed evidence ledger kinds. */
export const ENDO_EVIDENCE_KINDS_V0 = [
	"evaluation-result",
	"conformance-suite",
	"experiment-bundle",
	"replay-comparison",
	"mutation",
	"artifact",
	"candidate",
	"selection-decision",
	"promotion-request",
	"promotion-decision",
	"experiment-transition",
] as const satisfies readonly EndoEvidenceKindV0[];

/**
 * The documented component and artifact vocabulary (README "# The evolution layer"). Like the graph
 * edge relations, it is open-but-well-formed: the validator accepts any well-formed dotted kind, and
 * this tuple records the common ones so producers share one vocabulary.
 */
export const ENDO_ARTIFACT_KINDS_V0 = [
	"prompt",
	"context-policy",
	"memory",
	"skill",
	"tool",
	"orchestration",
	"model-choice",
	"model-weights",
	"evaluator-config",
	"runtime-config",
] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

/**
 * A content-addressable artifact: a named piece of content (prompt, context policy, memory, skill,
 * tool, orchestration, model choice/weights, evaluator or runtime config) with a SHA-256 digest.
 *
 * The id is in the evidence namespace (artifacts are evidence). When `content` is present the digest
 * is computed over its canonical JSON form — the same content always has the same digest; when the
 * content is stored elsewhere the digest must be supplied. A digest change under a stable id is
 * detected, never silently accepted (evolution/artifacts.ts).
 */
export interface EndoArtifactV0 {
	schemaVersion: "endo.artifact.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The artifact kind: a well-formed dotted kind (see ENDO_ARTIFACT_KINDS_V0). */
	kind: string;
	/** SHA-256 hex digest of the content (see the interface note). */
	digest: string;
	/** The recorded content (strict JSON), when stored with the artifact. */
	content?: JsonValueV0;
	/** The source revision the artifact was built from, if recorded. */
	sourceRevision?: string;
}

const ENDO_ARTIFACT_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "kind", "digest", "content", "sourceRevision"]);

/**
 * Validates an artifact. Rejects unknown fields, an identifier outside the evidence namespace, a
 * non-well-formed kind, a malformed digest, non-strict content, and over-long revisions. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoArtifactV0(value: unknown): EndoArtifactV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_ARTIFACT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.artifact.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (typeof v.kind !== "string" || !isWellFormedKindV0(v.kind)) return null;
	if (!isSha256HexV0(v.digest)) return null;
	if (v.content !== undefined && !isStrictJsonValue(v.content)) return null;
	if (v.sourceRevision !== undefined && !isProfileTextV0(v.sourceRevision, 256)) return null;
	return value as EndoArtifactV0;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * A recorded mutation: what changed (component + operation), where it changed (source/target
 * revisions), what it produced (artifact reference, when content was captured), the hypothesis and
 * expected/observed effects, and the cost delta. Representation-neutral: prompts, context policies,
 * memory, skills, tools, orchestration, model choice/weights, evaluator and runtime config are all
 * representable without a textual patch format.
 */
export interface EndoMutationV0 {
	schemaVersion: "endo.mutation.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The component mutated: a well-formed dotted kind (see ENDO_ARTIFACT_KINDS_V0). */
	component: string;
	/** The operation applied to the component. */
	operation: EndoMutationOperationV0;
	/** The revision of the component before the mutation, if recorded. */
	sourceRevision?: string;
	/** The revision of the component after the mutation, if recorded. */
	targetRevision?: string;
	/** The artifact capturing the changed content, when captured. endo.evidence.* identifier. */
	artifactId?: string;
	/** The hypothesis the mutation tests. */
	hypothesis?: string;
	/** The effect the mutation is expected to have. */
	expectedEffect?: string;
	/** The effect observed in evaluation, when recorded. */
	observedEffect?: string;
	/** The cost delta attributed to the mutation (strict JSON). */
	costDelta?: JsonValueV0;
	/** A free-form description of the change. */
	description?: string;
}

const ENDO_MUTATION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"component",
	"operation",
	"sourceRevision",
	"targetRevision",
	"artifactId",
	"hypothesis",
	"expectedEffect",
	"observedEffect",
	"costDelta",
	"description",
]);

/**
 * Validates a mutation. Rejects unknown fields, an identifier outside the evidence namespace, a
 * non-well-formed component, an operation outside the closed four-way, non-strict cost deltas, and
 * over-long statements. Returns the validated value unchanged, or null.
 */
export function validateEndoMutationV0(value: unknown): EndoMutationV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_MUTATION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.mutation.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (typeof v.component !== "string" || !isWellFormedKindV0(v.component)) return null;
	if (!(ENDO_MUTATION_OPERATIONS_V0 as readonly string[]).includes(v.operation as string)) return null;
	if (v.sourceRevision !== undefined && !isProfileTextV0(v.sourceRevision, 256)) return null;
	if (v.targetRevision !== undefined && !isProfileTextV0(v.targetRevision, 256)) return null;
	if (v.artifactId !== undefined && !isEndoIdentifier(v.artifactId, "evidence")) return null;
	if (v.hypothesis !== undefined && !isStatementV0(v.hypothesis, 4096)) return null;
	if (v.expectedEffect !== undefined && !isStatementV0(v.expectedEffect, 4096)) return null;
	if (v.observedEffect !== undefined && !isStatementV0(v.observedEffect, 4096)) return null;
	if (v.costDelta !== undefined && !isStrictJsonValue(v.costDelta)) return null;
	if (v.description !== undefined && !isStatementV0(v.description, 4096)) return null;
	return value as EndoMutationV0;
}

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/**
 * A candidate: a point in the evolution space. It names what it descends from (parent candidate),
 * what it was built from (source revision, artifact), what it changes (mutations, in application
 * order), and what it claims to change about behaviour (hypothesis). The candidate is the unit of
 * comparison in a selection decision.
 *
 * The registry (evolution/core.ts) is add-only: supersession is recorded by a descendant candidate
 * and a promotion decision, not by mutating this record.
 */
export interface EndoCandidateV0 {
	schemaVersion: "endo.candidate.v0";
	/** endo.candidate.* identifier. */
	id: string;
	/** The parent candidate, when this candidate descends from another. endo.candidate.* identifier. */
	parentCandidateId?: string;
	/** The source revision the candidate was built from, if recorded. */
	sourceRevision?: string;
	/** The artifact the candidate materialises, when captured. endo.evidence.* identifier. */
	artifactId?: string;
	/** The model identity, if recorded. */
	model?: string;
	/** The runtime identity, if recorded. */
	runtime?: string;
	/** The environment identity, if recorded. */
	environment?: string;
	/** The hypothesis the candidate tests. */
	hypothesis?: string;
	/** The mutation ids the candidate applies, in application order. Empty for a base candidate. */
	mutations: string[];
	/** The provenance of the candidate. */
	provenance?: string;
	/** The candidate state, when recorded. */
	state?: EndoCandidateStateV0;
	/** The candidate revision, when the candidate is versioned. */
	revision?: string;
}

const ENDO_CANDIDATE_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"parentCandidateId",
	"sourceRevision",
	"artifactId",
	"model",
	"runtime",
	"environment",
	"hypothesis",
	"mutations",
	"provenance",
	"state",
	"revision",
]);

/**
 * Validates a candidate. Rejects unknown fields, identifiers in the wrong namespaces, a state
 * outside the closed three-way, a missing or non-array mutation list, and over-long statements.
 * Returns the validated value unchanged, or null.
 */
export function validateEndoCandidateV0(value: unknown): EndoCandidateV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_CANDIDATE_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.candidate.v0") return null;
	if (!isEndoIdentifier(v.id, "candidate")) return null;
	if (v.parentCandidateId !== undefined && !isEndoIdentifier(v.parentCandidateId, "candidate")) return null;
	if (v.sourceRevision !== undefined && !isProfileTextV0(v.sourceRevision, 256)) return null;
	if (v.artifactId !== undefined && !isEndoIdentifier(v.artifactId, "evidence")) return null;
	if (v.model !== undefined && !isProfileTextV0(v.model, 256)) return null;
	if (v.runtime !== undefined && !isProfileTextV0(v.runtime, 256)) return null;
	if (v.environment !== undefined && !isProfileTextV0(v.environment, 256)) return null;
	if (v.hypothesis !== undefined && !isStatementV0(v.hypothesis, 4096)) return null;
	if (!Array.isArray(v.mutations) || !v.mutations.every((entry) => isEndoIdentifier(entry, "evidence"))) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	if (v.state !== undefined && !(ENDO_CANDIDATE_STATES_V0 as readonly string[]).includes(v.state as string))
		return null;
	if (v.revision !== undefined && !isProfileTextV0(v.revision, 256)) return null;
	return value as EndoCandidateV0;
}

// ---------------------------------------------------------------------------
// Experiment record and lifecycle
// ---------------------------------------------------------------------------

/**
 * The experiment record: the declared inputs of an experiment — the environment profile, the
 * evaluator and grader identities, the model, the candidate set, the budget, and the provenance.
 * The record declares inputs only; the experiment's state is not a field of the record. State lives
 * in the transition ledger (EndoExperimentTransitionV0) and is derived by replay
 * (evolution/experiment.ts).
 */
export interface EndoExperimentRecordV0 {
	schemaVersion: "endo.experiment.v0";
	/** endo.experiment.* identifier. */
	id: string;
	/** The environment profile, when the experiment declares one. */
	environment?: EndoEnvironmentProfileV0;
	/** The evaluator identity/revision, if recorded. */
	evaluator?: string;
	/** The grader identity/revision, if recorded. */
	grader?: string;
	/** The model identity, if recorded. */
	model?: string;
	/** The candidates under comparison, when declared. */
	candidateIds?: string[];
	/** The declared budget (strict JSON), if recorded. */
	budget?: JsonValueV0;
	/** The provenance of the experiment. */
	provenance?: string;
}

const ENDO_EXPERIMENT_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"environment",
	"evaluator",
	"grader",
	"model",
	"candidateIds",
	"budget",
	"provenance",
]);

/**
 * Validates an experiment record. Rejects unknown fields, an identifier outside the experiment
 * namespace, identifiers in the wrong namespace in candidateIds, an invalid environment profile, a
 * non-strict budget, and over-long identities. Returns the validated value unchanged, or null.
 */
export function validateEndoExperimentRecordV0(value: unknown): EndoExperimentRecordV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EXPERIMENT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.experiment.v0") return null;
	if (!isEndoIdentifier(v.id, "experiment")) return null;
	if (v.environment !== undefined && validateEndoEnvironmentProfileV0(v.environment) === null) return null;
	if (v.evaluator !== undefined && !isProfileTextV0(v.evaluator, 256)) return null;
	if (v.grader !== undefined && !isProfileTextV0(v.grader, 256)) return null;
	if (v.model !== undefined && !isProfileTextV0(v.model, 256)) return null;
	if (
		v.candidateIds !== undefined &&
		(!Array.isArray(v.candidateIds) || !v.candidateIds.every((entry) => isEndoIdentifier(entry, "candidate")))
	) {
		return null;
	}
	if (v.budget !== undefined && !isStrictJsonValue(v.budget)) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	return value as EndoExperimentRecordV0;
}

/**
 * An experiment lifecycle transition: one recorded move of the experiment between two adjacent
 * states, with the evidence that justified the move. Transitions are records, never events; the
 * state of an experiment is reconstructable by replaying its transitions in sequence order
 * (evolution/experiment.ts).
 *
 * The validator enforces the closed transition table: a transition whose `to` is not legal for its
 * `from` is not a valid record.
 */
export interface EndoExperimentTransitionV0 {
	schemaVersion: "endo.experiment-transition.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The experiment the transition belongs to. endo.experiment.* identifier. */
	experimentId: string;
	/** The 1-based position of the transition in the experiment's transition ledger. */
	sequence: number;
	/** The state the experiment was in before the transition. */
	from: EndoExperimentStateV0;
	/** The state the experiment moved to. */
	to: EndoExperimentStateV0;
	/** The evidence the transition was based on (evaluation results, selection decisions, ...). */
	evidence?: string[];
	/** The reason for the transition, when recorded. */
	reason?: string;
}

const ENDO_EXPERIMENT_TRANSITION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"experimentId",
	"sequence",
	"from",
	"to",
	"evidence",
	"reason",
]);

/**
 * Validates an experiment lifecycle transition. Rejects unknown fields, identifiers in the wrong
 * namespaces, a sequence below one or non-integer, states outside the closed set, an illegal
 * from→to pair per ENDO_EXPERIMENT_STATE_TRANSITIONS_V0, non-evidence entries in evidence, and
 * over-long reasons. Returns the validated value unchanged, or null.
 */
export function validateEndoExperimentTransitionV0(value: unknown): EndoExperimentTransitionV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EXPERIMENT_TRANSITION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.experiment-transition.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return null;
	if (!(ENDO_EXPERIMENT_STATES_V0 as readonly string[]).includes(v.from as string)) return null;
	if (!(ENDO_EXPERIMENT_STATES_V0 as readonly string[]).includes(v.to as string)) return null;
	if (
		!(ENDO_EXPERIMENT_STATE_TRANSITIONS_V0[v.from as EndoExperimentStateV0] as readonly string[]).includes(
			v.to as string,
		)
	)
		return null;
	if (
		v.evidence !== undefined &&
		(!Array.isArray(v.evidence) || !v.evidence.every((entry) => isEndoIdentifier(entry, "evidence")))
	)
		return null;
	if (v.reason !== undefined && !isStatementV0(v.reason, 4096)) return null;
	return value as EndoExperimentTransitionV0;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * The selection policy identity: the name (and revision) of the policy whose conditions produced a
 * selection decision. This is the seam the Phase 7 policy providers plug into: the substrate records
 * which policy decided, and the provider executes the policy. The policy is opaque here — never
 * parsed, never executed by the protocol.
 */
export interface EndoSelectionPolicyV0 {
	schemaVersion: "endo.selection-policy.v0";
	/** The policy name, e.g. "rrsi-v1" or "highest-score". */
	name: string;
	/** The policy revision, when the policy is versioned. */
	revision?: string;
}

const ENDO_SELECTION_POLICY_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "name", "revision"]);

/**
 * Validates a selection policy identity. Rejects unknown fields, an empty or over-long name, and an
 * over-long revision. Returns the validated value unchanged, or null.
 */
export function validateEndoSelectionPolicyV0(value: unknown): EndoSelectionPolicyV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_SELECTION_POLICY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.selection-policy.v0") return null;
	if (!isProfileTextV0(v.name, 256)) return null;
	if (v.revision !== undefined && !isProfileTextV0(v.revision, 256)) return null;
	return value as EndoSelectionPolicyV0;
}

/**
 * One evaluated condition of a selection policy: what was checked (name), with which parameters,
 * what was observed, and whether it was met. A selection decision records its conditions, so a
 * decision is never an unexplained choice — multiple non-equivalent conditions (evaluation results,
 * noise floors, cost deltas, leakage, held-out performance, budgets, policy constraints) are all
 * representable without hard-coding any provider's acceptance equation.
 */
export interface EndoSelectionConditionV0 {
	schemaVersion: "endo.selection-condition.v0";
	/** The condition name, e.g. "mean-score-above-floor" or "no-held-out-degradation". */
	name: string;
	/** The parameters the condition was evaluated with (strict JSON). */
	parameters?: JsonValueV0;
	/** The value observed during evaluation (strict JSON). */
	observed?: JsonValueV0;
	/** Whether the condition was met. */
	met: boolean;
}

const ENDO_SELECTION_CONDITION_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "name", "parameters", "observed", "met"]);

/**
 * Validates a selection condition. Rejects unknown fields, an empty or over-long name, non-strict
 * parameters or observations, and a missing or non-boolean met flag. Returns the validated value
 * unchanged, or null.
 */
export function validateEndoSelectionConditionV0(value: unknown): EndoSelectionConditionV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_SELECTION_CONDITION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.selection-condition.v0") return null;
	if (!isProfileTextV0(v.name, 256)) return null;
	if (v.parameters !== undefined && !isStrictJsonValue(v.parameters)) return null;
	if (v.observed !== undefined && !isStrictJsonValue(v.observed)) return null;
	if (typeof v.met !== "boolean") return null;
	return value as EndoSelectionConditionV0;
}

/**
 * A selection decision: the recorded result of a selection policy applied to an experiment. It names
 * the policy, the outcome, the candidate (when the outcome is "selected"), the evaluated conditions,
 * and the evidence read (evaluation results; held-out evidence separately).
 *
 * Invariants the validator enforces: the conditions list is never empty; the outcome "selected" if
 * and only if a candidate is named; and a "selected" outcome must point to at least one evidence
 * record — a selection that names a candidate without recorded evidence is not a decision.
 * "rejected" and "inconclusive" may name no evidence (a budget exhaustion is a policy result without
 * a benchmark run) and must name no candidate.
 *
 * A selection decision is a record, not a gate: it decides nothing by itself. It becomes a
 * promotion request (EndoPromotionRequestV0) when someone asks to act on it.
 */
export interface EndoSelectionDecisionV0 {
	schemaVersion: "endo.selection-decision.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The experiment the decision belongs to. endo.experiment.* identifier. */
	experimentId: string;
	/** The policy identity that produced the decision. */
	policy: EndoSelectionPolicyV0;
	/** The outcome. */
	outcome: EndoSelectionOutcomeV0;
	/** The chosen candidate, present if and only if the outcome is "selected". endo.candidate.* identifier. */
	candidateId?: string;
	/** The evaluated conditions, in policy order. Non-empty. */
	conditions: EndoSelectionConditionV0[];
	/** The evidence the decision read (evaluation result ids). Non-empty when the outcome is "selected". */
	evidence: string[];
	/** The held-out evidence, when the policy evaluated held-out data. */
	heldOutEvidence?: string[];
	/** The reason for the outcome, when recorded. */
	reason?: string;
}

const ENDO_SELECTION_DECISION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"experimentId",
	"policy",
	"outcome",
	"candidateId",
	"conditions",
	"evidence",
	"heldOutEvidence",
	"reason",
]);

/**
 * Validates a selection decision. Rejects unknown fields, identifiers in the wrong namespaces, an
 * outcome outside the closed three-way, an invalid policy, conditions or evidence that are not
 * arrays of valid entries, the outcome↔candidate invariant, empty conditions, and a "selected"
 * outcome with no evidence. Returns the validated value unchanged, or null.
 */
export function validateEndoSelectionDecisionV0(value: unknown): EndoSelectionDecisionV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_SELECTION_DECISION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.selection-decision.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (validateEndoSelectionPolicyV0(v.policy) === null) return null;
	if (!(ENDO_SELECTION_OUTCOMES_V0 as readonly string[]).includes(v.outcome as string)) return null;
	if (v.candidateId !== undefined && !isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (
		!Array.isArray(v.conditions) ||
		v.conditions.length === 0 ||
		!v.conditions.every((entry) => validateEndoSelectionConditionV0(entry) !== null)
	) {
		return null;
	}
	if (!Array.isArray(v.evidence) || !v.evidence.every((entry) => isEndoIdentifier(entry, "evidence"))) return null;
	if (
		v.heldOutEvidence !== undefined &&
		(!Array.isArray(v.heldOutEvidence) || !v.heldOutEvidence.every((entry) => isEndoIdentifier(entry, "evidence")))
	) {
		return null;
	}
	if (v.reason !== undefined && !isStatementV0(v.reason, 4096)) return null;
	if (v.outcome === "selected") {
		if (v.candidateId === undefined) return null;
		if (v.evidence.length === 0) return null;
	} else if (v.candidateId !== undefined) {
		return null;
	}
	return value as EndoSelectionDecisionV0;
}

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

/**
 * A promotion request: the recorded ask to promote a candidate. It names the experiment, the
 * candidate, the selection decision it rests on, the artifact (when captured), and a named target
 * (an opaque description of where the candidate would be promoted to — not an execution target).
 *
 * A promotion request is a record, not an effect: recording it changes nothing.
 */
export interface EndoPromotionRequestV0 {
	schemaVersion: "endo.promotion-request.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The experiment the request belongs to. endo.experiment.* identifier. */
	experimentId: string;
	/** The candidate to promote. endo.candidate.* identifier. */
	candidateId: string;
	/** The selection decision the request rests on. endo.evidence.* identifier. */
	selectionId: string;
	/** The artifact the candidate materialises, when captured. endo.evidence.* identifier. */
	artifactId?: string;
	/** The named target (an opaque description, not an execution target). */
	target?: string;
	/** The provenance of the request. */
	provenance?: string;
}

const ENDO_PROMOTION_REQUEST_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"experimentId",
	"candidateId",
	"selectionId",
	"artifactId",
	"target",
	"provenance",
]);

/**
 * Validates a promotion request. Rejects unknown fields, identifiers in the wrong namespaces, and
 * over-long targets and provenance. Returns the validated value unchanged, or null.
 */
export function validateEndoPromotionRequestV0(value: unknown): EndoPromotionRequestV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROMOTION_REQUEST_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.promotion-request.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (!isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (!isEndoIdentifier(v.selectionId, "evidence")) return null;
	if (v.artifactId !== undefined && !isEndoIdentifier(v.artifactId, "evidence")) return null;
	if (v.target !== undefined && !isProfileTextV0(v.target, 256)) return null;
	if (v.provenance !== undefined && !isStatementV0(v.provenance, 4096)) return null;
	return value as EndoPromotionRequestV0;
}

/**
 * A promotion decision: the recorded answer to a promotion request. "granted" is a recorded
 * decision, not an authority grant: the decision confers no authority, triggers no deployment, and
 * produces no receipt. (The authority and the receipt land with Phase 8 trust integrations.)
 *
 * `authority` is the identity of the decision recorder — who or what recorded the decision — never
 * a role or a permission. A "granted" decision must point to at least one evidence record; a
 * "denied" decision may stand on its reason alone.
 */
export interface EndoPromotionDecisionV0 {
	schemaVersion: "endo.promotion-decision.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The promotion request this decision answers. endo.evidence.* identifier. */
	requestId: string;
	/** The experiment the decision belongs to. endo.experiment.* identifier. */
	experimentId: string;
	/** The candidate the decision is about. endo.candidate.* identifier. */
	candidateId: string;
	/** The outcome. */
	outcome: EndoPromotionOutcomeV0;
	/** The identity of the decision recorder (an identity, not a grant). */
	authority: string;
	/** The evidence the decision rests on. Non-empty when the outcome is "granted". */
	evidence: string[];
	/** The reason for the outcome, when recorded. */
	reason?: string;
}

const ENDO_PROMOTION_DECISION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"requestId",
	"experimentId",
	"candidateId",
	"outcome",
	"authority",
	"evidence",
	"reason",
]);

/**
 * Validates a promotion decision. Rejects unknown fields, identifiers in the wrong namespaces, an
 * outcome outside the closed two-way, an empty or over-long authority, non-evidence entries in
 * evidence, a "granted" outcome with no evidence, and over-long reasons. Returns the validated
 * value unchanged, or null.
 */
export function validateEndoPromotionDecisionV0(value: unknown): EndoPromotionDecisionV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_PROMOTION_DECISION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.promotion-decision.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.requestId, "evidence")) return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (!isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (!(ENDO_PROMOTION_OUTCOMES_V0 as readonly string[]).includes(v.outcome as string)) return null;
	if (!isProfileTextV0(v.authority, 256)) return null;
	if (!Array.isArray(v.evidence) || !v.evidence.every((entry) => isEndoIdentifier(entry, "evidence"))) return null;
	if (v.reason !== undefined && !isStatementV0(v.reason, 4096)) return null;
	if (v.outcome === "granted" && v.evidence.length === 0) return null;
	return value as EndoPromotionDecisionV0;
}

// ---------------------------------------------------------------------------
// Evidence ledger
// ---------------------------------------------------------------------------

/**
 * One entry of the evidence ledger: the position (1-based sequence), the kind of record, and the
 * record's identifier. Entries are append-only and in causal order: a record that references other
 * records may only be appended after its references have been appended (evolution/evidence.ts).
 */
export interface EndoEvidenceLedgerEntryV0 {
	schemaVersion: "endo.evidence-ledger-entry.v0";
	/** The 1-based position of the entry in the ledger. */
	sequence: number;
	/** The kind of record the entry names. */
	kind: EndoEvidenceKindV0;
	/** The identifier of the named record: endo.candidate.* for the "candidate" kind, endo.evidence.* otherwise. */
	recordId: string;
}

const ENDO_EVIDENCE_LEDGER_ENTRY_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "sequence", "kind", "recordId"]);

/**
 * Validates an evidence ledger entry. Rejects unknown fields, a sequence below one or non-integer,
 * a kind outside the closed set, and a record identifier in the wrong namespace for the kind
 * (candidate records use the candidate namespace; every other kind uses the evidence namespace).
 * Returns the validated value unchanged, or null.
 */
export function validateEndoEvidenceLedgerEntryV0(value: unknown): EndoEvidenceLedgerEntryV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EVIDENCE_LEDGER_ENTRY_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.evidence-ledger-entry.v0") return null;
	if (typeof v.sequence !== "number" || !Number.isInteger(v.sequence) || v.sequence < 1) return null;
	if (!(ENDO_EVIDENCE_KINDS_V0 as readonly string[]).includes(v.kind as string)) return null;
	if (v.kind === "candidate") {
		if (!isEndoIdentifier(v.recordId, "candidate")) return null;
	} else if (!isEndoIdentifier(v.recordId, "evidence")) {
		return null;
	}
	return value as EndoEvidenceLedgerEntryV0;
}

/**
 * The evidence ledger of an experiment: the append-only, sequence-ordered list of records the
 * experiment produced (evaluation results, conformance suites, experiment bundles, replay
 * comparisons, mutations, artifacts, candidates, selection decisions, promotion requests and
 * decisions, transitions). It is the per-experiment referential-integrity point: append order is
 * causal order, no record appears twice, and replay reconstructs the ledger from its entries
 * (evolution/evidence.ts).
 */
export interface EndoEvidenceLedgerV0 {
	schemaVersion: "endo.evidence-ledger.v0";
	/** endo.evidence.* identifier for the ledger itself. */
	id: string;
	/** The experiment the ledger belongs to. endo.experiment.* identifier. */
	experimentId: string;
	/** The entries in append order. */
	entries: EndoEvidenceLedgerEntryV0[];
}

const ENDO_EVIDENCE_LEDGER_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "experimentId", "entries"]);

/**
 * Validates an evidence ledger. Rejects unknown fields, identifiers in the wrong namespaces, an
 * entry that is not a valid entry, a sequence that is not exactly 1..n in order, and a record
 * identifier that appears in more than one entry. Returns the validated value unchanged, or null.
 */
export function validateEndoEvidenceLedgerV0(value: unknown): EndoEvidenceLedgerV0 | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_EVIDENCE_LEDGER_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.evidence-ledger.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (!Array.isArray(v.entries)) return null;
	const seen = new Set<string>();
	for (let index = 0; index < v.entries.length; index++) {
		const entry = validateEndoEvidenceLedgerEntryV0(v.entries[index]);
		if (entry === null) return null;
		if (entry.sequence !== index + 1) return null;
		if (seen.has(entry.recordId)) return null;
		seen.add(entry.recordId);
	}
	return value as EndoEvidenceLedgerV0;
}
