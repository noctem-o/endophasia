// Read-only Protected Experiment Inspector contracts (EVOLVE-INSPECT-001):
// - `endo.evolve-protected-experiments.v0`: the read-only index of admitted protected experiment runs under an operator-named
//   directory (`endo studio --protected-runs <dir>`), or the fixed absent sentinel `{ available: false }`.
// - `endo.evolve-protected-experiment.v0`: the independently validated report and per-trial/attempt provenance projection of one
//   selected protected run.
//
// Security & epistemic boundaries:
// - Strictly read-only: no execution, rerun, configuration edit, or host path browsing.
// - No raw host filesystem paths (`agent.directory`, `evaluator.file`, absolute run paths), hidden evaluator cases,
//   model credentials, relay secrets, or private model transcripts ever cross this boundary.
// - Evaluated candidate correctness and agent process completion remain distinct fields (a candidate that passed evaluation
//   while its agent timed out afterward stays explicitly visible as both).
// - Missing, refused, unsupported, and tampered records stay explicitly reported and never silently vanish from accounting.
//
// The protocol imports only the protocol.

import { isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0 = "endo.evolve-protected-experiments.v0";
export const ENDO_EVOLVE_PROTECTED_EXPERIMENT_DETAIL_SCHEMA_V0 = "endo.evolve-protected-experiment.v0";

export const ENDO_EVOLVE_EXPERIMENT_SELECTOR_PATTERN_V0 = /^e1-[0-9a-f]{32}$/;

export const ENDO_EVOLVE_EXPERIMENT_LIMITS_V0 = Object.freeze({
	maxRuns: 64,
	maxScanEntries: 256,
	maxScanDepth: 2,
	maxRunFileBytes: 16 * 1024 * 1024,
	maxTrialFileBytes: 16 * 1024 * 1024,
	maxTrials: 256,
	maxAttemptsPerTrial: 16,
	maxRefusedRecords: 128,
});

export const ENDO_EVOLVE_RUN_STATES_V0 = [
	"readable",
	"unsupported-version",
	"invalid",
	"too-large",
	"unreadable",
] as const;
export type EndoEvolveRunStateV0 = (typeof ENDO_EVOLVE_RUN_STATES_V0)[number];

export const ENDO_EVOLVE_EXPERIMENT_TYPES_V0 = [
	"offline-fixed",
	"model-connected-fixed",
	"offline-staged",
	"model-connected-staged",
] as const;
export type EndoEvolveExperimentTypeV0 = (typeof ENDO_EVOLVE_EXPERIMENT_TYPES_V0)[number];

export const ENDO_EVOLVE_EVIDENCE_AVAILABILITY_V0 = ["complete", "partial", "has-refusals", "not-started"] as const;
export type EndoEvolveEvidenceAvailabilityV0 = (typeof ENDO_EVOLVE_EVIDENCE_AVAILABILITY_V0)[number];

export const ENDO_EVOLVE_TRIAL_OUTCOMES_V0 = ["passed", "failed", "attrition", "not-attempted", "refused"] as const;
export type EndoEvolveTrialOutcomeV0 = (typeof ENDO_EVOLVE_TRIAL_OUTCOMES_V0)[number];

export interface EndoEvolveProtectedExperimentsAbsentV0 {
	schemaVersion: typeof ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0;
	available: false;
	reason: "no-protected-runs-configured";
}

export const ENDO_EVOLVE_PROTECTED_EXPERIMENTS_ABSENT_V0: EndoEvolveProtectedExperimentsAbsentV0 = Object.freeze({
	schemaVersion: ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0,
	available: false,
	reason: "no-protected-runs-configured",
});

export interface EndoEvolveRunCountsV0 {
	planned: number;
	attempted: number;
	notAttempted: number;
	qualified: number;
	passed: number;
	failed: number;
	attrition: number;
	retries: number;
	refusedRecords: number;
}

export interface EndoEvolveProtectedExperimentSummaryV0 {
	selector: string;
	/** Safe relative display label inside the configured root (never an absolute host path). */
	label: string;
	state: EndoEvolveRunStateV0;
	problem: string | null;
	runId: string | null;
	runSchemaVersion: string | null;
	reportSchemaVersion: "endo.protected-report.v0" | "endo.protected-report.v1" | null;
	experimentType: EndoEvolveExperimentTypeV0 | null;
	specSha256: string | null;
	seed: number | null;
	createdAt: string | null;
	taskCount: number | null;
	conditionCount: number | null;
	counts: EndoEvolveRunCountsV0 | null;
	evidenceAvailability: EndoEvolveEvidenceAvailabilityV0 | null;
}

export interface EndoEvolveProtectedExperimentsIndexV0 {
	schemaVersion: typeof ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0;
	available: true;
	runs: EndoEvolveProtectedExperimentSummaryV0[];
	skipped: {
		links: number;
		notDirectory: number;
		overLimit: number;
		unreadable: number;
	};
}

export type EndoEvolveProtectedExperimentsReplyV0 =
	| EndoEvolveProtectedExperimentsAbsentV0
	| EndoEvolveProtectedExperimentsIndexV0;

export interface EndoEvolveProtectedReportCellV0 {
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
	failedWithoutSubmission: number;
	failedBelowMinimumExchanges?: number;
	attrition: Record<string, number>;
}

export interface EndoEvolveProtectedSubmissionProvenanceV0 {
	mode: "fixed-paths";
	status: "collected" | "refused" | "missing" | "not-collected";
	sha256: string | null;
	fileCount: number;
	refusalCount: number;
}

export interface EndoEvolveProtectedStagedProvenanceV0 {
	mode: "staged-changeset";
	baselineStatus: "pinned" | "mismatch" | "not-pinned";
	baselineSha256: string;
	collectionStatus: "collected" | "refused" | "not-collected";
	changesetSha256: string | null;
	verificationStatus: "verified" | "failed" | "not-run";
	verificationReason: string | null;
	candidateSha256: string | null;
	changedFileCount: number | null;
	refusalCount: number;
	refusalsOmitted: number;
}

export type EndoEvolveProtectedArtifactProvenanceV0 =
	| EndoEvolveProtectedSubmissionProvenanceV0
	| EndoEvolveProtectedStagedProvenanceV0;

export interface EndoEvolveProtectedModelRecordingProvenanceV0 {
	status: "complete" | "incomplete" | "none" | "inconsistent" | "unknown";
	required: number;
	answeredVerified: number;
	totalExchanges: number;
	refusedRequests: number | null;
	policySha256: string;
}

export interface EndoEvolveProtectedAttemptViewV0 {
	attempt: number;
	retryOf: number | null;
	recordStatus: "verified" | "refused" | "missing";
	refusalReason: string | null;
	trialSchemaVersion: string | null;
	recordSha256: string | null;
	recordedAt: string | null;
	finalized: "normally" | "on-resume" | null;
	preflightStatus: "established" | "failed" | "unavailable" | null;
	agent: {
		status: "completed" | "exited-nonzero" | "timed-out" | "interrupted" | "failed-to-start" | "not-run";
		exitCode: number | null;
		signal: string | null;
		durationMs: number | null;
		termination: "confirmed" | "unconfirmed" | "not-applicable";
	} | null;
	evaluation: {
		status: "passed" | "failed" | "could-not-run" | "not-run";
		cases: { total: number; passed: number } | null;
		reason: string | null;
		definitionSha256: string;
		driverSha256: string;
		outputSha256: string | null;
	} | null;
	submission: EndoEvolveProtectedArtifactProvenanceV0 | null;
	modelRecording: EndoEvolveProtectedModelRecordingProvenanceV0 | null;
	invalidating: string[];
}

export interface EndoEvolveProtectedTrialViewV0 {
	position: number;
	task: string;
	condition: string;
	trial: number;
	outcome: EndoEvolveTrialOutcomeV0;
	outcomeReason: string | null;
	attemptCount: number;
	retryCount: number;
	finalAttempt: EndoEvolveProtectedAttemptViewV0 | null;
	attempts: EndoEvolveProtectedAttemptViewV0[];
}

export interface EndoEvolveProtectedExperimentDetailV0 {
	schemaVersion: typeof ENDO_EVOLVE_PROTECTED_EXPERIMENT_DETAIL_SCHEMA_V0;
	selector: string;
	label: string;
	runSchemaVersion:
		| "endo.protected-run.v0"
		| "endo.protected-run.v1"
		| "endo.protected-run.v2"
		| "endo.protected-run.v3";
	reportSchemaVersion: "endo.protected-report.v0" | "endo.protected-report.v1";
	experimentType: EndoEvolveExperimentTypeV0;
	run: {
		id: string;
		description: string;
		runner: string;
		specSha256: string;
		seed: number;
		seedSource: "spec" | "drawn";
		ordering: string;
		createdAt: string;
		isolation: {
			mechanism: "bubblewrap";
			version: string;
			executableSha256: string;
			containment: {
				mechanism: "systemd-user-scope";
				version: string;
				systemdRunSha256: string;
				tasksMax: number;
			};
		};
	};
	modelAccess: {
		upstream: string;
		model: string;
		policySha256: string;
		minExchanges: number;
		maxExchanges: number;
		maxCompletionTokens: number;
	} | null;
	tasks: {
		id: string;
		submissionMode: "fixed-paths" | "staged-changeset";
		evaluatorDefinitionSha256: string;
		evaluatorDriverSha256: string;
		referenceQualified: "passed";
		negativeQualified: "failed" | null;
	}[];
	conditions: {
		id: string;
		description: string;
		profileSha256: string;
	}[];
	rules: string[];
	cells: EndoEvolveProtectedReportCellV0[];
	refusedRecords: { path: string; reason: string }[];
	refusedRecordsOmitted: number;
	trials: EndoEvolveProtectedTrialViewV0[];
	trialsOmitted: number;
}

export interface EndoEvolveProtectedExperimentsObserverV0 {
	list(): EndoEvolveProtectedExperimentsIndexV0;
	detail(selector: string): EndoEvolveProtectedExperimentDetailV0 | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => isPlainJsonObjectV0(v);
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isSha256 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isSha256OrNull = (v: unknown): v is string | null => v === null || isSha256(v);
const inSet = <T extends string>(set: readonly T[], v: unknown): v is T =>
	typeof v === "string" && (set as readonly string[]).includes(v);

const REPORT_VERSIONS = ["endo.protected-report.v0", "endo.protected-report.v1"] as const;
const RUN_VERSIONS = [
	"endo.protected-run.v0",
	"endo.protected-run.v1",
	"endo.protected-run.v2",
	"endo.protected-run.v3",
] as const;

function validCounts(v: unknown): v is EndoEvolveRunCountsV0 {
	if (!isRecord(v)) return false;
	return (
		isNonNegInt(v.planned) &&
		isNonNegInt(v.attempted) &&
		isNonNegInt(v.notAttempted) &&
		isNonNegInt(v.qualified) &&
		isNonNegInt(v.passed) &&
		isNonNegInt(v.failed) &&
		isNonNegInt(v.attrition) &&
		isNonNegInt(v.retries) &&
		isNonNegInt(v.refusedRecords)
	);
}

function validSummary(v: unknown): v is EndoEvolveProtectedExperimentSummaryV0 {
	if (!isRecord(v)) return false;
	if (typeof v.selector !== "string" || !ENDO_EVOLVE_EXPERIMENT_SELECTOR_PATTERN_V0.test(v.selector)) return false;
	if (typeof v.label !== "string" || v.label.length === 0 || v.label.length > 128) return false;
	if (!inSet(ENDO_EVOLVE_RUN_STATES_V0, v.state)) return false;
	if (!isStringOrNull(v.problem)) return false;
	if (!isStringOrNull(v.runId)) return false;
	if (!isStringOrNull(v.runSchemaVersion)) return false;
	if (v.reportSchemaVersion !== null && !inSet(REPORT_VERSIONS, v.reportSchemaVersion)) return false;
	if (v.experimentType !== null && !inSet(ENDO_EVOLVE_EXPERIMENT_TYPES_V0, v.experimentType)) return false;
	if (!isSha256OrNull(v.specSha256)) return false;
	if (v.seed !== null && !isNonNegInt(v.seed)) return false;
	if (!isStringOrNull(v.createdAt)) return false;
	if (v.taskCount !== null && !isNonNegInt(v.taskCount)) return false;
	if (v.conditionCount !== null && !isNonNegInt(v.conditionCount)) return false;
	if (v.counts !== null && !validCounts(v.counts)) return false;
	if (v.evidenceAvailability !== null && !inSet(ENDO_EVOLVE_EVIDENCE_AVAILABILITY_V0, v.evidenceAvailability))
		return false;
	if (v.state === "readable") {
		if (
			v.runId === null ||
			v.runSchemaVersion === null ||
			v.reportSchemaVersion === null ||
			v.experimentType === null ||
			v.specSha256 === null ||
			v.seed === null ||
			v.counts === null ||
			v.evidenceAvailability === null
		)
			return false;
	}
	return true;
}

export function validateEndoEvolveProtectedExperimentsReplyV0(
	value: unknown,
): EndoEvolveProtectedExperimentsReplyV0 | null {
	if (!isRecord(value)) return null;
	if (value.schemaVersion !== ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0) return null;
	if (value.available === false) {
		return value.reason === "no-protected-runs-configured" && Object.keys(value).length === 3
			? (value as unknown as EndoEvolveProtectedExperimentsAbsentV0)
			: null;
	}
	if (value.available !== true) return null;
	if (!Array.isArray(value.runs) || value.runs.length > ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRuns) return null;
	if (!value.runs.every(validSummary)) return null;
	if (!isRecord(value.skipped)) return null;
	const s = value.skipped;
	if (!isNonNegInt(s.links) || !isNonNegInt(s.notDirectory) || !isNonNegInt(s.overLimit) || !isNonNegInt(s.unreadable))
		return null;
	return value as unknown as EndoEvolveProtectedExperimentsIndexV0;
}

function validCell(v: unknown): v is EndoEvolveProtectedReportCellV0 {
	if (!isRecord(v)) return false;
	if (typeof v.task !== "string" || typeof v.condition !== "string") return false;
	if (
		!isNonNegInt(v.planned) ||
		!isNonNegInt(v.attempted) ||
		!isNonNegInt(v.notAttempted) ||
		!isNonNegInt(v.attempts) ||
		!isNonNegInt(v.retries) ||
		!isNonNegInt(v.qualified) ||
		!isNonNegInt(v.passed) ||
		!isNonNegInt(v.failed) ||
		!isNonNegInt(v.failedWithoutSubmission)
	)
		return false;
	if (v.failedBelowMinimumExchanges !== undefined && !isNonNegInt(v.failedBelowMinimumExchanges)) return false;
	if (!isRecord(v.attrition)) return false;
	for (const count of Object.values(v.attrition)) if (!isNonNegInt(count)) return false;
	return true;
}

function validAttempt(v: unknown): v is EndoEvolveProtectedAttemptViewV0 {
	if (!isRecord(v)) return false;
	if (!isNonNegInt(v.attempt) || (v.retryOf !== null && !isNonNegInt(v.retryOf))) return false;
	if (!inSet(["verified", "refused", "missing"] as const, v.recordStatus)) return false;
	if (!isStringOrNull(v.refusalReason) || !isStringOrNull(v.trialSchemaVersion)) return false;
	if (!isSha256OrNull(v.recordSha256) || !isStringOrNull(v.recordedAt)) return false;
	if (v.finalized !== null && !inSet(["normally", "on-resume"] as const, v.finalized)) return false;
	if (v.preflightStatus !== null && !inSet(["established", "failed", "unavailable"] as const, v.preflightStatus))
		return false;
	if (v.agent !== null) {
		if (!isRecord(v.agent)) return false;
		if (
			!inSet(
				["completed", "exited-nonzero", "timed-out", "interrupted", "failed-to-start", "not-run"] as const,
				v.agent.status,
			)
		)
			return false;
		if (
			v.agent.exitCode !== null &&
			(typeof v.agent.exitCode !== "number" || !Number.isSafeInteger(v.agent.exitCode))
		)
			return false;
		if (!isStringOrNull(v.agent.signal)) return false;
		if (v.agent.durationMs !== null && !isNonNegInt(v.agent.durationMs)) return false;
		if (!inSet(["confirmed", "unconfirmed", "not-applicable"] as const, v.agent.termination)) return false;
	}
	if (v.evaluation !== null) {
		if (!isRecord(v.evaluation)) return false;
		if (!inSet(["passed", "failed", "could-not-run", "not-run"] as const, v.evaluation.status)) return false;
		if (v.evaluation.cases !== null) {
			if (
				!isRecord(v.evaluation.cases) ||
				!isNonNegInt(v.evaluation.cases.total) ||
				!isNonNegInt(v.evaluation.cases.passed)
			)
				return false;
		}
		if (!isStringOrNull(v.evaluation.reason)) return false;
		if (!isSha256(v.evaluation.definitionSha256) || !isSha256(v.evaluation.driverSha256)) return false;
		if (!isSha256OrNull(v.evaluation.outputSha256)) return false;
	}
	if (v.submission !== null) {
		if (!isRecord(v.submission)) return false;
		if (v.submission.mode === "fixed-paths") {
			if (!inSet(["collected", "refused", "missing", "not-collected"] as const, v.submission.status)) return false;
			if (!isSha256OrNull(v.submission.sha256)) return false;
			if (!isNonNegInt(v.submission.fileCount) || !isNonNegInt(v.submission.refusalCount)) return false;
		} else if (v.submission.mode === "staged-changeset") {
			if (!inSet(["pinned", "mismatch", "not-pinned"] as const, v.submission.baselineStatus)) return false;
			if (!isSha256(v.submission.baselineSha256)) return false;
			if (!inSet(["collected", "refused", "not-collected"] as const, v.submission.collectionStatus)) return false;
			if (!isSha256OrNull(v.submission.changesetSha256)) return false;
			if (!inSet(["verified", "failed", "not-run"] as const, v.submission.verificationStatus)) return false;
			if (!isStringOrNull(v.submission.verificationReason)) return false;
			if (!isSha256OrNull(v.submission.candidateSha256)) return false;
			if (v.submission.changedFileCount !== null && !isNonNegInt(v.submission.changedFileCount)) return false;
			if (!isNonNegInt(v.submission.refusalCount) || !isNonNegInt(v.submission.refusalsOmitted)) return false;
		} else {
			return false;
		}
	}
	if (v.modelRecording !== null) {
		if (!isRecord(v.modelRecording)) return false;
		if (!inSet(["complete", "incomplete", "none", "inconsistent", "unknown"] as const, v.modelRecording.status))
			return false;
		if (
			!isNonNegInt(v.modelRecording.required) ||
			!isNonNegInt(v.modelRecording.answeredVerified) ||
			!isNonNegInt(v.modelRecording.totalExchanges)
		)
			return false;
		if (v.modelRecording.refusedRequests !== null && !isNonNegInt(v.modelRecording.refusedRequests)) return false;
		if (!isSha256(v.modelRecording.policySha256)) return false;
	}
	if (!Array.isArray(v.invalidating) || !v.invalidating.every((x) => typeof x === "string")) return false;
	return true;
}

function validTrial(v: unknown): v is EndoEvolveProtectedTrialViewV0 {
	if (!isRecord(v)) return false;
	if (
		!isNonNegInt(v.position) ||
		typeof v.task !== "string" ||
		typeof v.condition !== "string" ||
		!isNonNegInt(v.trial)
	)
		return false;
	if (!inSet(ENDO_EVOLVE_TRIAL_OUTCOMES_V0, v.outcome) || !isStringOrNull(v.outcomeReason)) return false;
	if (!isNonNegInt(v.attemptCount) || !isNonNegInt(v.retryCount)) return false;
	if (v.finalAttempt !== null && !validAttempt(v.finalAttempt)) return false;
	if (!Array.isArray(v.attempts) || !v.attempts.every(validAttempt)) return false;
	return true;
}

export function validateEndoEvolveProtectedExperimentDetailV0(
	value: unknown,
): EndoEvolveProtectedExperimentDetailV0 | null {
	if (!isRecord(value)) return null;
	if (value.schemaVersion !== ENDO_EVOLVE_PROTECTED_EXPERIMENT_DETAIL_SCHEMA_V0) return null;
	if (typeof value.selector !== "string" || !ENDO_EVOLVE_EXPERIMENT_SELECTOR_PATTERN_V0.test(value.selector))
		return null;
	if (typeof value.label !== "string" || value.label.length === 0 || value.label.length > 128) return null;
	if (!inSet(RUN_VERSIONS, value.runSchemaVersion)) return null;
	if (!inSet(REPORT_VERSIONS, value.reportSchemaVersion)) return null;
	if (!inSet(ENDO_EVOLVE_EXPERIMENT_TYPES_V0, value.experimentType)) return null;
	if (!isRecord(value.run)) return null;
	const r = value.run;
	if (
		typeof r.id !== "string" ||
		typeof r.description !== "string" ||
		typeof r.runner !== "string" ||
		!isSha256(r.specSha256) ||
		!isNonNegInt(r.seed) ||
		!inSet(["spec", "drawn"] as const, r.seedSource) ||
		typeof r.ordering !== "string" ||
		typeof r.createdAt !== "string" ||
		!isRecord(r.isolation) ||
		r.isolation.mechanism !== "bubblewrap" ||
		typeof r.isolation.version !== "string" ||
		!isSha256(r.isolation.executableSha256) ||
		!isRecord(r.isolation.containment) ||
		r.isolation.containment.mechanism !== "systemd-user-scope" ||
		typeof r.isolation.containment.version !== "string" ||
		!isSha256(r.isolation.containment.systemdRunSha256) ||
		!isNonNegInt(r.isolation.containment.tasksMax)
	)
		return null;
	if (value.modelAccess !== null) {
		if (!isRecord(value.modelAccess)) return null;
		const m = value.modelAccess;
		if (
			typeof m.upstream !== "string" ||
			typeof m.model !== "string" ||
			!isSha256(m.policySha256) ||
			!isNonNegInt(m.minExchanges) ||
			!isNonNegInt(m.maxExchanges) ||
			!isNonNegInt(m.maxCompletionTokens)
		)
			return null;
	}
	if (!Array.isArray(value.tasks) || !Array.isArray(value.conditions)) return null;
	for (const t of value.tasks) {
		if (
			!isRecord(t) ||
			typeof t.id !== "string" ||
			!inSet(["fixed-paths", "staged-changeset"] as const, t.submissionMode) ||
			!isSha256(t.evaluatorDefinitionSha256) ||
			!isSha256(t.evaluatorDriverSha256) ||
			t.referenceQualified !== "passed" ||
			(t.negativeQualified !== null && t.negativeQualified !== "failed")
		)
			return null;
	}
	for (const c of value.conditions) {
		if (!isRecord(c) || typeof c.id !== "string" || typeof c.description !== "string" || !isSha256(c.profileSha256))
			return null;
	}
	if (!Array.isArray(value.rules) || !value.rules.every((x) => typeof x === "string")) return null;
	if (!Array.isArray(value.cells) || !value.cells.every(validCell)) return null;
	if (!Array.isArray(value.refusedRecords) || !isNonNegInt(value.refusedRecordsOmitted)) return null;
	for (const rec of value.refusedRecords) {
		if (!isRecord(rec) || typeof rec.path !== "string" || typeof rec.reason !== "string") return null;
	}
	if (!Array.isArray(value.trials) || !value.trials.every(validTrial) || !isNonNegInt(value.trialsOmitted))
		return null;
	return value as unknown as EndoEvolveProtectedExperimentDetailV0;
}
