// REEF-specific: the mapping from REEF's recorded shapes (adapters/reef/shapes.ts) into
// Endophasia's common experiment/evidence model (README "## Phase 7 — RRSI + REEF providers").
// Every function is pure: it validates its inputs at the door (TypeError, never a repair), and it
// validates its output through the protocol — a mapping that cannot produce a valid record throws.
// Nothing here talks to a REEF deployment; the shapes are mirrors of REEF's documented records.
//
// The fixed correspondence (REEF glossary term → Endophasia record):
//   scenario   → EndoExperimentRecordV0 (one workload, one experiment, the recipe in provenance)
//   receipt    → the run id of a trial coordinate (a receipt names the exchange and its release)
//   feedback   → the trial's raw (recorded, not interpreted) and derived { score }
//   report     → EndoEvaluationResultV0 (one result per report, one trial per quoted receipt)
//   mutation   → EndoMutationV0 (create → add, update → replace, remove → remove)
//   candidate  → EndoCandidateV0 (a composite proposal: the mapped mutation ids, in order)
//   artifact   → EndoArtifactV0 (content present → digest computed; a content_id alone is not a digest)
//   release    → EndoPromotionRequestV0 + EndoPromotionDecisionV0 (granted; rollback is a new
//                decision on the same artifact — history appended, never rewound)

import { buildEndoArtifactV0 } from "../../evolution/artifacts.ts";
import type { EndoTrialCoordinatesV0 } from "../../protocol/coordinates.ts";
import type {
	EndoCognitionPolicyV0,
	EndoEnvironmentProfileV0,
	EndoEvaluationPartitionV0,
	EndoEvaluationProfileV0,
	EndoEvaluationResultV0,
	EndoTrialResultV0,
} from "../../protocol/evaluation.ts";
import {
	ENDO_COGNITION_POLICIES_V0,
	validateEndoEnvironmentProfileV0,
	validateEndoEvaluationResultV0,
} from "../../protocol/evaluation.ts";
import type {
	EndoArtifactV0,
	EndoCandidateV0,
	EndoExperimentRecordV0,
	EndoMutationOperationV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
} from "../../protocol/evolution.ts";
import {
	validateEndoCandidateV0,
	validateEndoExperimentRecordV0,
	validateEndoMutationV0,
	validateEndoPromotionDecisionV0,
	validateEndoPromotionRequestV0,
} from "../../protocol/evolution.ts";
import { formatEndoIdentifierV0, isEndoIdentifierV0, isWellFormedKindV0 } from "../../protocol/identity.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { assertPlainJsonValueV0 } from "../../runtime/contracts/canonical-json.ts";
import type {
	ReefArtifactV0,
	ReefCandidateV0,
	ReefMutationV0,
	ReefReleaseV0,
	ReefReportV0,
	ReefScenarioV0,
} from "./shapes.ts";

const LOCAL_PART_V0 = /^[A-Za-z0-9._-]{1,256}$/;
const KIND_SEGMENT_V0 = /^[a-z][a-z0-9-]*$/;

/** A v0 identifier local part: 1-256 of [A-Za-z0-9._-]. */
function reefLocalV0(label: string, value: unknown): string {
	if (typeof value !== "string" || !LOCAL_PART_V0.test(value)) {
		throw new TypeError(`${label} must fit the v0 identifier local-part grammar (1-256 of [A-Za-z0-9._-])`);
	}
	return value;
}

/** A non-empty string of at most 256 characters (profile text / identity). */
function profileTextV0(label: string, value: string): void {
	if (value.length < 1 || value.length > 256) {
		throw new TypeError(`${label} must be a non-empty string of at most 256 characters`);
	}
}

/** A non-empty statement of at most 4096 characters. */
function statementV0(label: string, value: string): void {
	if (value.length < 1 || value.length > 4096) {
		throw new TypeError(`${label} must be a non-empty string of at most 4096 characters`);
	}
}

/** A v0 identifier in one namespace. */
function idV0(label: string, value: string, kind: "evidence" | "experiment" | "candidate"): void {
	if (typeof value !== "string" || !isEndoIdentifierV0(value, kind)) {
		throw new TypeError(`${label} must be an endo.${kind}.* identifier`);
	}
}

/**
 * A REEF harness-tree entry (a path from the tree root) as a well-formed dotted kind: the segments
 * are joined with dots, and each segment must be lowercase [a-z][a-z0-9-]* — the dotted-kind
 * grammar. A segment the grammar rejects (e.g. an uppercase file name) is rejected, not mangled:
 * the caller names the component.
 */
function reefEntryToKindV0(entry: unknown): string {
	if (typeof entry !== "string" || entry.length < 1) {
		throw new TypeError("a REEF mutation entry must be a non-empty path from the harness-tree root");
	}
	const segments = entry.split("/");
	for (const segment of segments) {
		if (segment.length < 1 || !KIND_SEGMENT_V0.test(segment)) {
			throw new TypeError(`a REEF mutation entry segment (${segment}) must be lowercase [a-z][a-z0-9-]*`);
		}
	}
	const kind = segments.join(".");
	if (!isWellFormedKindV0(kind)) {
		throw new TypeError(`a REEF mutation entry (${entry}) does not fit the dotted-kind grammar`);
	}
	return kind;
}

/**
 * Map a REEF scenario to an Endophasia experiment record: one workload is one experiment. The
 * scenario name becomes the experiment's local part under the `reef-` prefix (so two REEF
 * scenarios never collide with a hand-minted experiment id), and the bound recipe is recorded in
 * the provenance — the recipe is REEF's method identity, never Endophasia's policy identity.
 */
export function mapReefScenarioToExperimentV0(args: {
	scenario: ReefScenarioV0;
	evaluator?: string;
	grader?: string;
	model?: string;
	environment?: EndoEnvironmentProfileV0;
	budget?: unknown;
}): EndoExperimentRecordV0 {
	const name = reefLocalV0("scenario name", args.scenario.name);
	profileTextV0("recipe", args.scenario.recipe);
	const experimentId = formatEndoIdentifierV0("experiment", `reef-${name}`);
	if (experimentId === null) {
		throw new TypeError("the scenario name plus the reef- prefix does not fit the v0 experiment identifier grammar");
	}
	const record: EndoExperimentRecordV0 = {
		schemaVersion: "endo.experiment.v0",
		id: experimentId,
		provenance: `reef scenario ${name}, recipe ${args.scenario.recipe}`,
	};
	if (args.evaluator !== undefined) {
		profileTextV0("evaluator", args.evaluator);
		record.evaluator = args.evaluator;
	}
	if (args.grader !== undefined) {
		profileTextV0("grader", args.grader);
		record.grader = args.grader;
	}
	if (args.model !== undefined) {
		profileTextV0("model", args.model);
		record.model = args.model;
	}
	if (args.environment !== undefined) {
		if (validateEndoEnvironmentProfileV0(args.environment) === null) {
			throw new TypeError("environment must be a valid endo.environment-profile.v0");
		}
		record.environment = args.environment;
	}
	if (args.budget !== undefined) {
		assertPlainJsonValueV0(args.budget);
		record.budget = args.budget;
	}
	const validated = validateEndoExperimentRecordV0(record);
	if (validated === null) throw new TypeError("did not map to a valid endo.experiment.v0 record");
	return validated;
}

/**
 * Map a REEF report to an Endophasia evaluation result: one result per report, one trial per
 * quoted receipt, in the report's reference order. A receipt names the exchange and the release
 * that produced it — the v0 analogue is the trial's run id, minted under the `reef-` prefix. The
 * score channel lands in the trial's derived metrics as `{ score }`; the feedback channel lands in
 * the trial's raw, recorded and not interpreted (the recipe decides what it means, as in REEF).
 * A report is consumed at most once, as in REEF: appending the resulting record twice is the
 * ledger's duplicate-recordId rejection.
 */
export function mapReefReportToEvaluationResultV0(args: {
	id: string;
	experimentId: string;
	candidateId?: string;
	partition?: EndoEvaluationPartitionV0;
	runtime: string;
	model: string;
	cognitionPolicy: EndoCognitionPolicyV0;
	environment: EndoEnvironmentProfileV0;
	evaluator?: string;
	grader?: string;
	report: ReefReportV0;
}): EndoEvaluationResultV0 {
	idV0("result id", args.id, "evidence");
	idV0("experiment id", args.experimentId, "experiment");
	if (args.candidateId !== undefined) idV0("candidate id", args.candidateId, "candidate");
	profileTextV0("runtime", args.runtime);
	profileTextV0("model", args.model);
	if (!(ENDO_COGNITION_POLICIES_V0 as readonly string[]).includes(args.cognitionPolicy)) {
		throw new TypeError("cognitionPolicy must be work or dream");
	}
	if (validateEndoEnvironmentProfileV0(args.environment) === null) {
		throw new TypeError("environment must be a valid endo.environment-profile.v0");
	}
	if (args.evaluator !== undefined) profileTextV0("evaluator", args.evaluator);
	if (args.grader !== undefined) profileTextV0("grader", args.grader);

	const references = args.report.references;
	if (!Array.isArray(references) || references.length < 1) {
		throw new TypeError("a REEF report must quote at least one receipt");
	}
	let score: number | undefined;
	if (args.report.score !== undefined) {
		if (!Number.isFinite(args.report.score)) {
			throw new TypeError("a REEF report score must be a finite number");
		}
		score = args.report.score;
	}
	let feedback: JsonValueV0 | undefined;
	if (args.report.feedback !== undefined) {
		assertPlainJsonValueV0(args.report.feedback);
		feedback = args.report.feedback;
	}

	const trials: EndoTrialResultV0[] = references.map((receipt, index) => {
		if (typeof receipt !== "string" || receipt.length < 1) {
			throw new TypeError("a REEF report receipt must be a non-empty string");
		}
		const runId = formatEndoIdentifierV0("run", `reef-${receipt}`);
		if (runId === null) {
			throw new TypeError(`receipt ${receipt} plus the reef- prefix does not fit the v0 run identifier grammar`);
		}
		const coordinates: EndoTrialCoordinatesV0 = {
			schemaVersion: "endo.trial.v0",
			experimentId: args.experimentId,
			trial: index,
			runId,
		};
		if (args.candidateId !== undefined) coordinates.candidateId = args.candidateId;
		const trial: EndoTrialResultV0 = { schemaVersion: "endo.trial-result.v0", coordinates };
		if (args.partition !== undefined) trial.partition = args.partition;
		if (feedback !== undefined) trial.raw = feedback;
		if (score !== undefined) trial.derived = { score };
		return trial;
	});

	const profile: EndoEvaluationProfileV0 = {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: args.experimentId,
		runtime: args.runtime,
		model: args.model,
		cognitionPolicy: args.cognitionPolicy,
		environment: args.environment,
		trialCount: trials.length,
	};
	if (args.candidateId !== undefined) profile.candidateId = args.candidateId;
	if (args.evaluator !== undefined) profile.evaluator = args.evaluator;
	if (args.grader !== undefined) profile.grader = args.grader;

	const result: EndoEvaluationResultV0 = { schemaVersion: "endo.evaluation-result.v0", id: args.id, profile, trials };
	const validated = validateEndoEvaluationResultV0(result);
	if (validated === null) throw new TypeError("did not map to a valid endo.evaluation-result.v0 record");
	return validated;
}

/** The REEF mutation operation to the Endophasia mutation operation. */
const REEF_MUTATION_OPERATIONS_V0: Record<ReefMutationV0["operation"], EndoMutationOperationV0> = {
	create: "add",
	update: "replace",
	remove: "remove",
};

/**
 * Map a REEF mutation to an Endophasia mutation: one edit on a single root-level harness-tree
 * entry. create → add, update → replace, remove → remove (a reconfigure has no REEF analogue in
 * the mutation vocabulary: the caller records it with the other operation plus a description).
 * The entry path becomes the component's dotted kind.
 */
export function mapReefMutationToMutationV0(args: {
	id: string;
	mutation: ReefMutationV0;
	sourceRevision?: string;
	targetRevision?: string;
	artifactId?: string;
	hypothesis?: string;
	expectedEffect?: string;
	description?: string;
	costDelta?: unknown;
}): EndoMutationV0 {
	idV0("mutation id", args.id, "evidence");
	const operation = REEF_MUTATION_OPERATIONS_V0[args.mutation.operation];
	if (operation === undefined) {
		throw new TypeError("a REEF mutation operation must be create, update, or remove");
	}
	const record: EndoMutationV0 = {
		schemaVersion: "endo.mutation.v0",
		id: args.id,
		component: reefEntryToKindV0(args.mutation.entry),
		operation,
	};
	if (args.sourceRevision !== undefined) {
		profileTextV0("sourceRevision", args.sourceRevision);
		record.sourceRevision = args.sourceRevision;
	}
	if (args.targetRevision !== undefined) {
		profileTextV0("targetRevision", args.targetRevision);
		record.targetRevision = args.targetRevision;
	}
	if (args.artifactId !== undefined) {
		idV0("artifactId", args.artifactId, "evidence");
		record.artifactId = args.artifactId;
	}
	if (args.hypothesis !== undefined) {
		statementV0("hypothesis", args.hypothesis);
		record.hypothesis = args.hypothesis;
	}
	if (args.expectedEffect !== undefined) {
		statementV0("expectedEffect", args.expectedEffect);
		record.expectedEffect = args.expectedEffect;
	}
	if (args.description !== undefined) {
		statementV0("description", args.description);
		record.description = args.description;
	}
	if (args.costDelta !== undefined) {
		assertPlainJsonValueV0(args.costDelta);
		record.costDelta = args.costDelta;
	}
	const validated = validateEndoMutationV0(record);
	if (validated === null) throw new TypeError("did not map to a valid endo.mutation.v0 record");
	return validated;
}

/**
 * Map a REEF candidate (a produced update: a composite harness-tree proposal) to an Endophasia
 * candidate. The mapped mutation ids are supplied in the composite proposal's application order;
 * the candidate name is preserved in the provenance unless the caller names one.
 */
export function mapReefCandidateToCandidateV0(args: {
	id: string;
	candidate: ReefCandidateV0;
	mutations: string[];
	parentCandidateId?: string;
	sourceRevision?: string;
	artifactId?: string;
	model?: string;
	runtime?: string;
	environment?: string;
	provenance?: string;
	revision?: string;
}): EndoCandidateV0 {
	idV0("candidate id", args.id, "candidate");
	profileTextV0("candidate name", args.candidate.name);
	if (!Array.isArray(args.mutations)) {
		throw new TypeError("mutations must be an array of endo.evidence.* mutation ids");
	}
	for (const mutationId of args.mutations) idV0("mutation id", mutationId, "evidence");
	const record: EndoCandidateV0 = {
		schemaVersion: "endo.candidate.v0",
		id: args.id,
		mutations: [...args.mutations],
		provenance: args.provenance ?? `reef candidate ${args.candidate.name}`,
	};
	if (args.candidate.hypothesis !== undefined) {
		statementV0("hypothesis", args.candidate.hypothesis);
		record.hypothesis = args.candidate.hypothesis;
	}
	if (args.parentCandidateId !== undefined) {
		idV0("parentCandidateId", args.parentCandidateId, "candidate");
		record.parentCandidateId = args.parentCandidateId;
	}
	if (args.sourceRevision !== undefined) {
		profileTextV0("sourceRevision", args.sourceRevision);
		record.sourceRevision = args.sourceRevision;
	}
	if (args.artifactId !== undefined) {
		idV0("artifactId", args.artifactId, "evidence");
		record.artifactId = args.artifactId;
	}
	if (args.model !== undefined) {
		profileTextV0("model", args.model);
		record.model = args.model;
	}
	if (args.runtime !== undefined) {
		profileTextV0("runtime", args.runtime);
		record.runtime = args.runtime;
	}
	if (args.environment !== undefined) {
		profileTextV0("environment", args.environment);
		record.environment = args.environment;
	}
	if (args.revision !== undefined) {
		profileTextV0("revision", args.revision);
		record.revision = args.revision;
	}
	const validated = validateEndoCandidateV0(record);
	if (validated === null) throw new TypeError("did not map to a valid endo.candidate.v0 record");
	return validated;
}

/**
 * Map a REEF artifact to an Endophasia artifact. The content_id is REEF's content identity, not a
 * digest: when the content was captured, the Endophasia digest is computed over its canonical form
 * (the house content-addressing rule) and the content_id is carried in sourceRevision for
 * traceability. When only the content_id is available, the mapping cannot produce an
 * EndoArtifactV0 — a digest is required, and one is never fabricated.
 */
export function mapReefArtifactToArtifactV0(args: {
	id: string;
	artifact: ReefArtifactV0;
	kind: string;
}): EndoArtifactV0 {
	idV0("artifact id", args.id, "evidence");
	if (
		typeof args.artifact.contentId !== "string" ||
		args.artifact.contentId.length < 1 ||
		args.artifact.contentId.length > 256
	) {
		throw new TypeError("a REEF artifact must carry its content_id (1-256 characters)");
	}
	if (args.artifact.content === undefined) {
		throw new TypeError(
			"a REEF artifact without its content cannot map to an EndoArtifactV0: a content_id is a content identity, not a digest",
		);
	}
	assertPlainJsonValueV0(args.artifact.content);
	return buildEndoArtifactV0({
		id: args.id,
		kind: args.kind,
		content: args.artifact.content,
		sourceRevision: args.artifact.contentId,
	});
}

/**
 * Map a REEF release to an Endophasia promotion request: the ask to make the released content the
 * promoted one. The release names no selection of its own; the selection the request rests on is
 * supplied by the caller (the gate's recorded decision — in REEF terms, the CandidateSelector's
 * verdict).
 */
export function mapReefReleaseToPromotionRequestV0(args: {
	id: string;
	release: ReefReleaseV0;
	experimentId: string;
	candidateId: string;
	selectionId: string;
	artifactId?: string;
	target?: string;
}): EndoPromotionRequestV0 {
	idV0("request id", args.id, "evidence");
	const releaseId = reefLocalV0("release id", args.release.releaseId);
	idV0("experiment id", args.experimentId, "experiment");
	idV0("candidate id", args.candidateId, "candidate");
	idV0("selection id", args.selectionId, "evidence");
	if (args.artifactId !== undefined) idV0("artifact id", args.artifactId, "evidence");
	const target = args.target ?? `reef release ${releaseId}`;
	profileTextV0("target", target);
	const record: EndoPromotionRequestV0 = {
		schemaVersion: "endo.promotion-request.v0",
		id: args.id,
		experimentId: args.experimentId,
		candidateId: args.candidateId,
		selectionId: args.selectionId,
		target,
	};
	if (args.artifactId !== undefined) record.artifactId = args.artifactId;
	const validated = validateEndoPromotionRequestV0(record);
	if (validated === null) throw new TypeError("did not map to a valid endo.promotion-request.v0 record");
	return validated;
}

/**
 * Map a REEF release to an Endophasia promotion decision. A release is an accepted publication, so
 * the outcome is always "granted" (a rejected candidate never becomes a release: in Endophasia
 * terms, no decision is recorded); the decision's evidence is the evaluation evidence the gate
 * read, supplied by the caller. The decision recorder's identity defaults to the release identity.
 * Rollback — a new release pointing at an older content_id — maps to a new request and decision on
 * the same artifact: the history is appended, never rewound, and the earlier decision stands.
 */
export function mapReefReleaseToPromotionDecisionV0(args: {
	id: string;
	release: ReefReleaseV0;
	experimentId: string;
	candidateId: string;
	requestId: string;
	evidence: string[];
	authority?: string;
	reason?: string;
}): EndoPromotionDecisionV0 {
	idV0("decision id", args.id, "evidence");
	const releaseId = reefLocalV0("release id", args.release.releaseId);
	idV0("experiment id", args.experimentId, "experiment");
	idV0("candidate id", args.candidateId, "candidate");
	idV0("request id", args.requestId, "evidence");
	if (!Array.isArray(args.evidence) || args.evidence.length < 1) {
		throw new TypeError("a REEF release maps to a granted decision: its evidence must be non-empty");
	}
	for (const entry of args.evidence) idV0("evidence id", entry, "evidence");
	const authority = args.authority ?? `reef-${releaseId}`;
	profileTextV0("authority", authority);
	if (args.reason !== undefined) statementV0("reason", args.reason);
	const record: EndoPromotionDecisionV0 = {
		schemaVersion: "endo.promotion-decision.v0",
		id: args.id,
		requestId: args.requestId,
		experimentId: args.experimentId,
		candidateId: args.candidateId,
		outcome: "granted",
		authority,
		evidence: [...args.evidence],
	};
	if (args.reason !== undefined) record.reason = args.reason;
	const validated = validateEndoPromotionDecisionV0(record);
	if (validated === null) throw new TypeError("did not map to a valid endo.promotion-decision.v0 record");
	return validated;
}
