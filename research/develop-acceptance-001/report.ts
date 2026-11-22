import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDO_EVALUATOR_DRIVER_SHA256_V0, loadEvaluatorV0 } from "../../adapters/sandbox/evaluator.ts";
import { successfulExchangeV0 } from "../../adapters/sandbox/model-evidence.ts";
import { exportSubmissionV0 } from "../../adapters/sandbox/submission.ts";
import { reportProtectedExperimentV0 } from "../../cli/experiment-protected.ts";
import {
	type EndoProtectedRecordingV1,
	type EndoProtectedRunV0,
	type EndoProtectedRunV1,
	endoProtectedStagedV2,
	endoProtectedTrialIsStagedV2,
} from "../../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	readEndoProtectedRunFileV0,
	readEndoProtectedTrialFileV0,
} from "../../runtime/contracts/protected-experiment.ts";

export function observedClass(modelAccess: boolean, recording: EndoProtectedRecordingV1 | null, scoped: boolean) {
	if (modelAccess && recording?.exchanges.some(successfulExchangeV0)) return "model-connected observation";
	return scoped ? "isolated-process observation" : "unknown";
}

export function acceptance(directory: string, pin: string) {
	const run = readEndoProtectedRunFileV0(join(directory, "protected-run.json"));
	if (!run.ok) throw new Error(run.reason);
	if (endoProtectedStagedV2(run.value.schemaVersion)) throw new Error("not the single-file acceptance plan");
	const { spec, specSha256, plan } = run.value as EndoProtectedRunV0 | EndoProtectedRunV1;
	if (pin !== specSha256) throw new Error("operator spec pin mismatch");
	const task = spec.tasks[0]!;
	const condition = spec.conditions[0]!;
	if (
		spec.tasks.length !== 1 ||
		spec.conditions.length !== 1 ||
		spec.trials !== 1 ||
		plan.length !== 1 ||
		plan[0]?.position !== 0 ||
		plan[0]?.trial !== 0 ||
		plan[0]?.task !== task.id ||
		plan[0]?.condition !== condition.id ||
		task.submission.length !== 1 ||
		task.submission[0] !== "count.mjs"
	)
		throw new Error("not the single-file acceptance plan");
	const report = reportProtectedExperimentV0(directory);
	const cell = report.cells[0]!;
	if (report.refusedRecords.length || cell.attempts !== 1)
		throw new Error(report.refusedRecords[0]?.reason ?? "missing or multiple attempts");
	const attempt = join(directory, "trials", task.id, condition.id, "0", "attempt-1");
	const read = readEndoProtectedTrialFileV0(join(attempt, "record.json"));
	if (!read.ok || endoProtectedTrialIsStagedV2(read.value))
		throw new Error(read.ok ? "not a fixed-path record" : read.reason);
	const r = read.value;
	const checks = loadEvaluatorV0(
		fileURLToPath(new URL("./checks/evaluator.json", import.meta.url)),
		task.evaluator.sha256,
		task.submission,
	);
	if (
		!checks.ok ||
		r.evaluation.driverSha256 !== ENDO_EVALUATOR_DRIVER_SHA256_V0 ||
		r.evaluation.definitionSha256 !== task.evaluator.sha256
	)
		throw new Error("evaluator pin mismatch");
	if (r.agent.outputSha256 !== null && sha256HexV0(readFileSync(join(attempt, "agent.log"))) !== r.agent.outputSha256)
		throw new Error("agent log digest mismatch");
	let checkedCandidate: string | null = null;
	if (r.submission.status === "collected") {
		const source = join(attempt, "submission");
		if (!lstatSync(source).isDirectory() || readdirSync(source).join("/") !== "count.mjs")
			throw new Error("staged tree mismatch");
		const scratch = mkdtempSync(join(tmpdir(), "endo-acceptance-"));
		try {
			const copy = exportSubmissionV0(source, task.submission, spec.limits, join(scratch, "candidate"));
			if (copy.status !== "collected" || copy.sha256 !== r.submission.sha256)
				throw new Error("staged bytes mismatch");
			checkedCandidate = copy.sha256;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	const complete =
		checkedCandidate !== null &&
		cell.qualified === 1 &&
		run.value.evaluators.length === 1 &&
		run.value.evaluators[0]?.negative === "failed" &&
		r.agent.outputSha256 !== null &&
		r.agent.status === "completed" &&
		r.agent.scope?.ended === "confirmed" &&
		r.agent.scope.established &&
		r.agent.termination === "confirmed" &&
		r.evaluation.outputSha256 !== null &&
		r.evaluation.cases?.total === checks.evaluator.definition.cases.length;
	const recording = "recording" in r ? r.recording : null;
	return {
		evidenceClass: observedClass(
			report.modelAccess !== undefined,
			recording,
			r.preflight.status === "established" && r.agent.scope?.established === true,
		),
		decision: "operator only",
		authority: "experimental, non-authoritative",
		recommendation: !complete ? "incomplete" : cell.passed === 1 ? "review candidate" : "reject candidate",
		run: r.run,
		trial: r.trial,
		recordSha256: r.recordSha256,
		task: task.id,
		objective: spec.description,
		startingWorkspaceSha256: sha256HexV0(canonicalEndoJsonV0(task.workspace)),
		condition: condition.agent.argv,
		profileSha256: r.isolation.profileSha256,
		preflight: r.preflight.status,
		hostAgent: r.agent,
		providerReports: "Not used for grading or tool attribution",
		model: report.modelAccess ?? null,
		recording,
		submission: r.submission,
		evaluatedCandidateSha256: r.evaluation.cases === null ? null : checkedCandidate,
		evaluation: r.evaluation,
		qualification: run.value.evaluators,
		invalidating: r.invalidating,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const result = acceptance(process.argv[2] ?? "", process.argv[3] ?? "");
		console.log(JSON.stringify(result, null, 2));
		if (result.recommendation === "incomplete") process.exitCode = 1;
	} catch (e) {
		console.error(
			JSON.stringify({
				recommendation: "incomplete",
				authority: "none",
				reason: e instanceof Error ? e.message : "unreadable evidence",
			}),
		);
		process.exitCode = 1;
	}
}
