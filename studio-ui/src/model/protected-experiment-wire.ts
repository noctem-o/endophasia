// Browser wire gate for Evolve's read-only Protected Experiment Inspector (EVOLVE-INSPECT-001).
// Validates every payload returned by `/api/v0/evolve/experiments` and `/api/v0/evolve/experiment/<selector>`
// fail-closed before anything reaches React state. Imports protocol types only.

import type {
	EndoEvolveProtectedAttemptViewV0,
	EndoEvolveProtectedExperimentDetailV0,
	EndoEvolveProtectedExperimentSummaryV0,
	EndoEvolveProtectedExperimentsReplyV0,
	EndoEvolveProtectedReportCellV0,
	EndoEvolveProtectedTrialViewV0,
	EndoEvolveRunCountsV0,
} from "../../../protocol/protected-experiment-observation.ts";

export type EvolveExperimentsIndex = EndoEvolveProtectedExperimentsReplyV0;
export type EvolveExperimentDetail = EndoEvolveProtectedExperimentDetailV0;

const SELECTOR_RE = /^e1-[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const RUN_STATES = new Set(["readable", "unsupported-version", "invalid", "too-large", "unreadable"]);
const EXP_TYPES = new Set(["offline-fixed", "model-connected-fixed", "offline-staged", "model-connected-staged"]);
const AVAILABILITY = new Set(["complete", "partial", "has-refusals", "not-started"]);
const OUTCOMES = new Set(["passed", "failed", "attrition", "not-attempted", "refused"]);
const RUN_VERSIONS = new Set([
	"endo.protected-run.v0",
	"endo.protected-run.v1",
	"endo.protected-run.v2",
	"endo.protected-run.v3",
]);
const REPORT_VERSIONS = new Set(["endo.protected-report.v0", "endo.protected-report.v1"]);
const AGENT_STATUSES = new Set([
	"completed",
	"exited-nonzero",
	"timed-out",
	"interrupted",
	"failed-to-start",
	"not-run",
]);
const TERMINATIONS = new Set(["confirmed", "unconfirmed", "not-applicable"]);
const EVAL_STATUSES = new Set(["passed", "failed", "could-not-run", "not-run"]);
const RECORD_STATUSES = new Set(["verified", "refused", "missing"]);
const PREFLIGHT_STATUSES = new Set(["established", "failed", "unavailable"]);
const FINALIZED_STATES = new Set(["normally", "on-resume"]);
const SUB_STATUSES = new Set(["collected", "refused", "missing", "not-collected"]);
const BASELINE_STATUSES = new Set(["pinned", "mismatch", "not-pinned"]);
const COLLECTION_STATUSES = new Set(["collected", "refused", "not-collected"]);
const VERIFY_STATUSES = new Set(["verified", "failed", "not-run"]);
const RECORDING_STATUSES = new Set(["complete", "incomplete", "none", "inconsistent", "unknown"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isSha = (v: unknown): v is string => typeof v === "string" && SHA256_RE.test(v);
const isShaOrNull = (v: unknown): v is string | null => v === null || isSha(v);

export function evolveExperimentSelector(value: unknown): value is string {
	return typeof value === "string" && SELECTOR_RE.test(value);
}

function readCounts(v: unknown): EndoEvolveRunCountsV0 | null {
	if (!isObj(v)) return null;
	if (
		!isInt(v.planned) ||
		!isInt(v.attempted) ||
		!isInt(v.notAttempted) ||
		!isInt(v.qualified) ||
		!isInt(v.passed) ||
		!isInt(v.failed) ||
		!isInt(v.attrition) ||
		!isInt(v.retries) ||
		!isInt(v.refusedRecords)
	)
		return null;
	return v as unknown as EndoEvolveRunCountsV0;
}

function readSummary(v: unknown): EndoEvolveProtectedExperimentSummaryV0 | null {
	if (!isObj(v)) return null;
	if (!evolveExperimentSelector(v.selector)) return null;
	if (!isStr(v.label) || v.label.length === 0 || v.label.length > 128) return null;
	if (!isStr(v.state) || !RUN_STATES.has(v.state)) return null;
	if (!isStrOrNull(v.problem) || !isStrOrNull(v.runId) || !isStrOrNull(v.runSchemaVersion)) return null;
	if (v.reportSchemaVersion !== null && (!isStr(v.reportSchemaVersion) || !REPORT_VERSIONS.has(v.reportSchemaVersion)))
		return null;
	if (v.experimentType !== null && (!isStr(v.experimentType) || !EXP_TYPES.has(v.experimentType))) return null;
	if (!isShaOrNull(v.specSha256)) return null;
	if (v.seed !== null && !isInt(v.seed)) return null;
	if (!isStrOrNull(v.createdAt)) return null;
	if (v.taskCount !== null && !isInt(v.taskCount)) return null;
	if (v.conditionCount !== null && !isInt(v.conditionCount)) return null;
	if (v.counts !== null && readCounts(v.counts) === null) return null;
	if (v.evidenceAvailability !== null && (!isStr(v.evidenceAvailability) || !AVAILABILITY.has(v.evidenceAvailability)))
		return null;
	if (
		v.state === "readable" &&
		(v.runId === null ||
			v.runSchemaVersion === null ||
			v.reportSchemaVersion === null ||
			v.experimentType === null ||
			v.specSha256 === null ||
			v.seed === null ||
			v.counts === null ||
			v.evidenceAvailability === null)
	)
		return null;
	return v as unknown as EndoEvolveProtectedExperimentSummaryV0;
}

export function readEvolveExperimentsIndex(value: unknown): EvolveExperimentsIndex | null {
	if (!isObj(value)) return null;
	if (value.schemaVersion !== "endo.evolve-protected-experiments.v0") return null;
	if (value.available === false) {
		return value.reason === "no-protected-runs-configured" ? (value as unknown as EvolveExperimentsIndex) : null;
	}
	if (value.available !== true) return null;
	if (!Array.isArray(value.runs)) return null;
	for (const run of value.runs) if (readSummary(run) === null) return null;
	if (!isObj(value.skipped)) return null;
	if (
		!isInt(value.skipped.links) ||
		!isInt(value.skipped.notDirectory) ||
		!isInt(value.skipped.overLimit) ||
		!isInt(value.skipped.unreadable)
	)
		return null;
	return value as unknown as EvolveExperimentsIndex;
}

function readCell(v: unknown): EndoEvolveProtectedReportCellV0 | null {
	if (!isObj(v)) return null;
	if (!isStr(v.task) || !isStr(v.condition)) return null;
	if (
		!isInt(v.planned) ||
		!isInt(v.attempted) ||
		!isInt(v.notAttempted) ||
		!isInt(v.attempts) ||
		!isInt(v.retries) ||
		!isInt(v.qualified) ||
		!isInt(v.passed) ||
		!isInt(v.failed) ||
		!isInt(v.failedWithoutSubmission)
	)
		return null;
	if (v.failedBelowMinimumExchanges !== undefined && !isInt(v.failedBelowMinimumExchanges)) return null;
	if (!isObj(v.attrition)) return null;
	for (const count of Object.values(v.attrition)) if (!isInt(count)) return null;
	return v as unknown as EndoEvolveProtectedReportCellV0;
}

function readAttempt(v: unknown): EndoEvolveProtectedAttemptViewV0 | null {
	if (!isObj(v)) return null;
	if (!isInt(v.attempt) || (v.retryOf !== null && !isInt(v.retryOf))) return null;
	if (!isStr(v.recordStatus) || !RECORD_STATUSES.has(v.recordStatus)) return null;
	if (!isStrOrNull(v.refusalReason) || !isStrOrNull(v.trialSchemaVersion)) return null;
	if (!isShaOrNull(v.recordSha256) || !isStrOrNull(v.recordedAt)) return null;
	if (v.finalized !== null && (!isStr(v.finalized) || !FINALIZED_STATES.has(v.finalized))) return null;
	if (v.preflightStatus !== null && (!isStr(v.preflightStatus) || !PREFLIGHT_STATUSES.has(v.preflightStatus)))
		return null;
	if (v.agent !== null) {
		if (!isObj(v.agent)) return null;
		if (!isStr(v.agent.status) || !AGENT_STATUSES.has(v.agent.status)) return null;
		if (
			v.agent.exitCode !== null &&
			(typeof v.agent.exitCode !== "number" || !Number.isSafeInteger(v.agent.exitCode))
		)
			return null;
		if (!isStrOrNull(v.agent.signal)) return null;
		if (v.agent.durationMs !== null && !isInt(v.agent.durationMs)) return null;
		if (!isStr(v.agent.termination) || !TERMINATIONS.has(v.agent.termination)) return null;
	}
	if (v.evaluation !== null) {
		if (!isObj(v.evaluation)) return null;
		if (!isStr(v.evaluation.status) || !EVAL_STATUSES.has(v.evaluation.status)) return null;
		if (v.evaluation.cases !== null) {
			if (!isObj(v.evaluation.cases) || !isInt(v.evaluation.cases.total) || !isInt(v.evaluation.cases.passed))
				return null;
		}
		if (!isStrOrNull(v.evaluation.reason)) return null;
		if (
			!isSha(v.evaluation.definitionSha256) ||
			!isSha(v.evaluation.driverSha256) ||
			!isShaOrNull(v.evaluation.outputSha256)
		)
			return null;
	}
	if (v.submission !== null) {
		if (!isObj(v.submission)) return null;
		if (v.submission.mode === "fixed-paths") {
			if (!isStr(v.submission.status) || !SUB_STATUSES.has(v.submission.status)) return null;
			if (!isShaOrNull(v.submission.sha256) || !isInt(v.submission.fileCount) || !isInt(v.submission.refusalCount))
				return null;
		} else if (v.submission.mode === "staged-changeset") {
			if (!isStr(v.submission.baselineStatus) || !BASELINE_STATUSES.has(v.submission.baselineStatus)) return null;
			if (!isSha(v.submission.baselineSha256)) return null;
			if (!isStr(v.submission.collectionStatus) || !COLLECTION_STATUSES.has(v.submission.collectionStatus))
				return null;
			if (!isShaOrNull(v.submission.changesetSha256)) return null;
			if (!isStr(v.submission.verificationStatus) || !VERIFY_STATUSES.has(v.submission.verificationStatus))
				return null;
			if (!isStrOrNull(v.submission.verificationReason) || !isShaOrNull(v.submission.candidateSha256)) return null;
			if (v.submission.changedFileCount !== null && !isInt(v.submission.changedFileCount)) return null;
			if (!isInt(v.submission.refusalCount) || !isInt(v.submission.refusalsOmitted)) return null;
		} else {
			return null;
		}
	}
	if (v.modelRecording !== null) {
		if (!isObj(v.modelRecording)) return null;
		if (!isStr(v.modelRecording.status) || !RECORDING_STATUSES.has(v.modelRecording.status)) return null;
		if (
			!isInt(v.modelRecording.required) ||
			!isInt(v.modelRecording.answeredVerified) ||
			!isInt(v.modelRecording.totalExchanges) ||
			(v.modelRecording.refusedRequests !== null && !isInt(v.modelRecording.refusedRequests)) ||
			!isSha(v.modelRecording.policySha256)
		)
			return null;
	}
	if (!Array.isArray(v.invalidating) || !v.invalidating.every(isStr)) return null;
	return v as unknown as EndoEvolveProtectedAttemptViewV0;
}

function readTrial(v: unknown): EndoEvolveProtectedTrialViewV0 | null {
	if (!isObj(v)) return null;
	if (!isInt(v.position) || !isStr(v.task) || !isStr(v.condition) || !isInt(v.trial)) return null;
	if (!isStr(v.outcome) || !OUTCOMES.has(v.outcome) || !isStrOrNull(v.outcomeReason)) return null;
	if (!isInt(v.attemptCount) || !isInt(v.retryCount)) return null;
	if (v.finalAttempt !== null && readAttempt(v.finalAttempt) === null) return null;
	if (!Array.isArray(v.attempts)) return null;
	for (const a of v.attempts) if (readAttempt(a) === null) return null;
	return v as unknown as EndoEvolveProtectedTrialViewV0;
}

export function readEvolveExperimentDetail(value: unknown): EvolveExperimentDetail | null {
	if (!isObj(value)) return null;
	if (value.schemaVersion !== "endo.evolve-protected-experiment.v0") return null;
	if (!evolveExperimentSelector(value.selector)) return null;
	if (!isStr(value.label) || value.label.length === 0 || value.label.length > 128) return null;
	if (!isStr(value.runSchemaVersion) || !RUN_VERSIONS.has(value.runSchemaVersion)) return null;
	if (!isStr(value.reportSchemaVersion) || !REPORT_VERSIONS.has(value.reportSchemaVersion)) return null;
	if (!isStr(value.experimentType) || !EXP_TYPES.has(value.experimentType)) return null;
	if (!isObj(value.run)) return null;
	const r = value.run;
	if (
		!isStr(r.id) ||
		!isStr(r.description) ||
		!isStr(r.runner) ||
		!isSha(r.specSha256) ||
		!isInt(r.seed) ||
		(r.seedSource !== "spec" && r.seedSource !== "drawn") ||
		!isStr(r.ordering) ||
		!isStr(r.createdAt) ||
		!isObj(r.isolation) ||
		r.isolation.mechanism !== "bubblewrap" ||
		!isStr(r.isolation.version) ||
		!isSha(r.isolation.executableSha256) ||
		!isObj(r.isolation.containment) ||
		r.isolation.containment.mechanism !== "systemd-user-scope" ||
		!isStr(r.isolation.containment.version) ||
		!isSha(r.isolation.containment.systemdRunSha256) ||
		!isInt(r.isolation.containment.tasksMax)
	)
		return null;
	if (value.modelAccess !== null) {
		if (!isObj(value.modelAccess)) return null;
		const m = value.modelAccess;
		if (
			!isStr(m.upstream) ||
			!isStr(m.model) ||
			!isSha(m.policySha256) ||
			!isInt(m.minExchanges) ||
			!isInt(m.maxExchanges) ||
			!isInt(m.maxCompletionTokens)
		)
			return null;
	}
	if (!Array.isArray(value.tasks) || !Array.isArray(value.conditions)) return null;
	for (const t of value.tasks) {
		if (
			!isObj(t) ||
			!isStr(t.id) ||
			(t.submissionMode !== "fixed-paths" && t.submissionMode !== "staged-changeset") ||
			!isSha(t.evaluatorDefinitionSha256) ||
			!isSha(t.evaluatorDriverSha256) ||
			t.referenceQualified !== "passed" ||
			(t.negativeQualified !== null && t.negativeQualified !== "failed")
		)
			return null;
	}
	for (const c of value.conditions) {
		if (!isObj(c) || !isStr(c.id) || !isStr(c.description) || !isSha(c.profileSha256)) return null;
	}
	if (!Array.isArray(value.rules) || !value.rules.every(isStr)) return null;
	if (!Array.isArray(value.cells)) return null;
	for (const cell of value.cells) if (readCell(cell) === null) return null;
	if (!Array.isArray(value.refusedRecords) || !isInt(value.refusedRecordsOmitted)) return null;
	for (const rec of value.refusedRecords) {
		if (!isObj(rec) || !isStr(rec.path) || !isStr(rec.reason)) return null;
	}
	if (!Array.isArray(value.trials) || !isInt(value.trialsOmitted)) return null;
	for (const trial of value.trials) if (readTrial(trial) === null) return null;
	return value as unknown as EvolveExperimentDetail;
}
