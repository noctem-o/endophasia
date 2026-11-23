// DEVELOP-PROTECTED-ATTEMPT-001 (docs/designs/protected-attempt-execution.md): the pure half of the protected attempt launcher and of its
// reading. Digests and seals of the records in protocol/develop-attempt-candidate-binding.ts, the approval rule, the operator-facing text,
// and the one comparison that decides how an attempt relates to a protected candidate. No filesystem, no process, no adapter import.
//
// The approval rule is the local operator's (runtime/contracts/intervention.ts, localOperatorAuthorityV0): allow only when the operator
// confirmed exactly this operation's digest, deny everything else, including no answer. It is restated here for the operation digest because
// the intervention proposal (steer, queue or stop, bound to a Pi session and attachment) cannot carry a protected launch; the rule is the same.

import {
	ENDO_PROTECTED_ATTEMPT_ASSOCIATION_LABELS_V0,
	ENDO_PROTECTED_ATTEMPT_AUTHORITY_LIMITATION_V0,
	ENDO_PROTECTED_ATTEMPT_CHECKS_V0,
	type EndoDevelopAttemptCandidateBindingV0,
	type EndoProtectedAttemptAssociationV0,
	type EndoProtectedAttemptCheckIdV0,
	type EndoProtectedAttemptCheckV0,
	type EndoProtectedAttemptLaunchV0,
	type EndoProtectedAttemptOperationV0,
	endoProtectedAttemptRunIdV0,
} from "../../protocol/develop-attempt-candidate-binding.ts";
import type { EndoBridgeProtectedExperimentV0 } from "../../protocol/develop-evidence-bridge.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

const digest = (value: unknown): string => sha256HexV0(canonicalEndoJsonV0(value as never));

/** sha256 of the operation's canonical JSON: what the operator approves. */
export const endoProtectedAttemptOperationDigestV0 = (operation: EndoProtectedAttemptOperationV0): string =>
	digest(operation);

/** sha256 of a launch record's canonical JSON: what a controller binding names. */
export const endoProtectedAttemptLaunchSha256V0 = (launch: EndoProtectedAttemptLaunchV0): string => digest(launch);

/** The phrase that approves exactly one operation. It shares no prefix with the workbench's APPROVE ATTEMPT or APPROVE PROMPT. */
export const endoProtectedAttemptApprovalPhraseV0 = (operationDigest: string): string =>
	`APPROVE PROTECTED ATTEMPT ${operationDigest.slice(0, 16)}`;

/**
 * The local operator's decision on one operation: allow only when the line typed on the controlling terminal is exactly this operation's
 * phrase. No answer, another operation's phrase, a workbench phrase, extra words or the digest alone are each a deny with its reason.
 */
export function endoProtectedAttemptAuthorityV0(
	typed: string | null,
	operationDigest: string,
): { decision: "allow" | "deny"; reason: string | null } {
	if (typed === null) return { decision: "deny", reason: "the operator typed nothing" };
	if (typed.trim() !== endoProtectedAttemptApprovalPhraseV0(operationDigest))
		return { decision: "deny", reason: "the typed line is not this operation's approval phrase" };
	return { decision: "allow", reason: null };
}

/** A binding sealed with its own digest. */
export function sealEndoAttemptCandidateBindingV0(
	binding: Omit<EndoDevelopAttemptCandidateBindingV0, "bindingSha256">,
): EndoDevelopAttemptCandidateBindingV0 {
	return { ...binding, bindingSha256: digest(binding) };
}

/** Whether a validated binding's seal is the digest of the rest of it. */
export function endoAttemptCandidateBindingSealOkV0(binding: EndoDevelopAttemptCandidateBindingV0): boolean {
	const { bindingSha256, ...rest } = binding;
	return digest(rest) === bindingSha256;
}

const short = (hex: string | null): string => (hex === null ? "none" : hex.slice(0, 16));

/** What the operator reads before typing the phrase: every identity and digest the launch is bound to, and what it does not mean. */
export function renderEndoProtectedAttemptOperationV0(
	operation: EndoProtectedAttemptOperationV0,
	operationDigest: string,
	brief: string,
): string {
	const lines = [
		"protected attempt launch (DEVELOP-PROTECTED-ATTEMPT-001)",
		"  attempt     " +
			operation.attemptId +
			" (task " +
			operation.taskId +
			" at revision " +
			operation.taskRevision +
			")",
		"  brief       sha256 " +
			operation.briefSha256 +
			" (" +
			operation.briefBytes +
			" bytes), written to /agent/prompt.txt",
		`  spec        ${operation.run.specSchemaVersion} id ${operation.run.id}`,
		`              sha256 ${operation.run.specSha256}`,
		`  run dir     ${operation.run.directory}`,
		`  trial       ${operation.trial.task}/${operation.trial.condition}/0 (one trial, one attempt)`,
		`  agent dir   ${operation.agent.directory}`,
		`              template tree ${operation.agent.templateTreeSha256}`,
		`              built tree    ${operation.agent.treeSha256}`,
		`  evaluator   definition sha256 ${operation.evaluator.definitionSha256} (pinned; the agent never sees it)`,
		"  model       " +
			(operation.modelAccess === null
				? "none: offline, no network inside the sandbox"
				: operation.modelAccess.model +
					" at " +
					operation.modelAccess.upstream +
					" through the run's own recording relay (loopback only)"),
		`  operation   sha256 ${operationDigest}`,
		"",
		"Approving records that you authorised this one protected run of this attempt, then runs it once through the existing protected",
		"runner (bubblewrap sandbox in its own systemd user scope, preflight probes first, collection only after the scope is confirmed",
		"ended, independent offline evaluation). It is never retried and never falls back to an unprotected run. It changes no task status,",
		"applies nothing to any checkout and merges nothing. Its evaluation is experimental and non-authoritative; workstation H0 stays BLOCKED.",
		"",
		"The brief, exactly as the agent will receive it:",
		"-----",
		brief.endsWith("\n") ? brief.slice(0, -1) : brief,
		"-----",
	];
	return `${lines.join("\n")}\n`;
}

export type EndoRecordReadV0<T> =
	| { state: "absent" }
	| { state: "problem"; reason: string }
	| { state: "present"; record: T };

export interface EndoProtectedAttemptAssessInputV0 {
	attemptId: string;
	/** sha256 of the brief rendered from the prepared record now; null when the prepared record cannot be read. */
	currentBriefSha256: string | null;
	/** The attempt also has a workbench send authorisation (develop/attempts/<id>.authorized.json). */
	workbenchAuthorized: boolean;
	launch: EndoRecordReadV0<EndoProtectedAttemptLaunchV0>;
	binding: EndoRecordReadV0<EndoDevelopAttemptCandidateBindingV0>;
	/** Whether a run directory the reader was given names the same directory the records name; null when none was given. */
	suppliedRunDirectoryMatches: boolean | null;
	/** A spec pin the reader was given; null when none. */
	suppliedSpecPin: string | null;
	/** The independent read-only inspection of the run directory the records name (adapters/develop/evidence-bridge.ts). */
	inspected: EndoBridgeProtectedExperimentV0;
	/** The mounted agent copy in the run directory, re-read: its tree digest and its prompt file's digest (null where unreadable). */
	agentCopy: { treeSha256: string | null; promptSha256: string | null; detail: string } | null;
}

export interface EndoProtectedAttemptAssessmentV0 {
	association: EndoProtectedAttemptAssociationV0;
	label: string;
	checks: EndoProtectedAttemptCheckV0[];
	limitation: string;
}

const IDENTITY_CHECKS: ReadonlySet<EndoProtectedAttemptCheckIdV0> = new Set([
	"launch-record",
	"binding-record",
	"operation-digest",
	"attempt-identity",
	"brief-digest",
	"single-execution-route",
	"run-directory",
	"spec-digest",
	"run-identity",
]);

/**
 * How the attempt relates to the protected candidate its records name, from exact comparisons only. A launch record or binding is never
 * believed: every digest it names is compared with what was re-read now, and a binding is admitted only when all of them match. Nothing
 * here looks at times, names, prompt or objective text, or anything an agent said.
 */
export function endoAssessProtectedAttemptV0(
	input: EndoProtectedAttemptAssessInputV0,
): EndoProtectedAttemptAssessmentV0 {
	const results = new Map<EndoProtectedAttemptCheckIdV0, EndoProtectedAttemptCheckV0>();
	const set = (check: EndoProtectedAttemptCheckIdV0, ok: boolean | null, detail: string) =>
		results.set(check, { check, result: ok === null ? "not-applicable" : ok ? "pass" : "fail", detail });
	const pe = input.inspected;
	const launch = input.launch.state === "present" ? input.launch.record : null;
	const binding = input.binding.state === "present" ? input.binding.record : null;
	const controller = binding?.boundBy === "controller";

	set(
		"launch-record",
		input.launch.state === "absent" ? (controller ? false : null) : input.launch.state === "present",
		input.launch.state === "problem"
			? `the launch record is not usable (${input.launch.reason})`
			: input.launch.state === "absent"
				? controller
					? "a controller binding exists but no launch record authorises it"
					: "no protected launch was recorded for this attempt"
				: "launch record approved on the controlling terminal",
	);
	set(
		"binding-record",
		input.binding.state === "absent" ? null : input.binding.state === "present",
		input.binding.state === "problem"
			? `the binding record is not usable (${input.binding.reason})`
			: input.binding.state === "absent"
				? "no binding was sealed"
				: binding?.boundBy === "controller"
					? "controller binding, seal verified"
					: "operator-declared binding, seal verified",
	);

	if (launch !== null) {
		const opOk = endoProtectedAttemptOperationDigestV0(launch.operation) === launch.operationDigest;
		const bindOk =
			binding === null || binding.authorization === null
				? true
				: binding.authorization.operationDigest === launch.operationDigest &&
					binding.authorization.launchSha256 === endoProtectedAttemptLaunchSha256V0(launch);
		set(
			"operation-digest",
			opOk && bindOk,
			!opOk
				? "the launch record's operation does not hash to its operation digest"
				: !bindOk
					? "the binding names another operation or launch record"
					: `operation ${short(launch.operationDigest)} recomputed`,
		);
	} else set("operation-digest", binding === null || !controller ? null : false, "no launch record to compare");

	const ids = [launch?.attemptId, launch?.operation.attemptId, binding?.attemptId].filter((x) => x !== undefined);
	const projectTaskOk =
		launch === null || binding === null
			? true
			: binding.projectId === launch.operation.projectId && binding.taskId === launch.operation.taskId;
	set(
		"attempt-identity",
		ids.every((id) => id === input.attemptId) && projectTaskOk,
		ids.every((id) => id === input.attemptId) && projectTaskOk
			? `every record names ${input.attemptId}`
			: "a record names another attempt, project or task",
	);

	const briefs = [launch?.operation.briefSha256, binding?.briefSha256].filter((x) => x !== undefined);
	set(
		"brief-digest",
		input.currentBriefSha256 !== null && briefs.every((b) => b === input.currentBriefSha256),
		input.currentBriefSha256 === null
			? "the prepared attempt cannot be read, so its brief cannot be recomputed"
			: briefs.every((b) => b === input.currentBriefSha256)
				? `brief ${short(input.currentBriefSha256)} recomputed from the prepared record`
				: "the brief recomputed now differs from the one the records name",
	);
	set(
		"single-execution-route",
		!input.workbenchAuthorized,
		input.workbenchAuthorized
			? "the attempt was also authorised for a workbench send: two executions cannot both be its candidate"
			: "no workbench send authorisation for this attempt",
	);

	const runDirs = [launch?.operation.run.directory, binding?.target.runDirectory].filter((x) => x !== undefined);
	const runDirOk = runDirs.every((d) => d === runDirs[0]) && input.suppliedRunDirectoryMatches !== false;
	set(
		"run-directory",
		runDirOk,
		runDirOk
			? `run directory ${runDirs[0]}`
			: "the records, or the reader's --protected-run, name different run directories",
	);

	const specs = [launch?.operation.run.specSha256, binding?.target.specSha256].filter((x) => x !== undefined);
	if (input.suppliedSpecPin !== null) specs.push(input.suppliedSpecPin);
	const specOk = pe.observedSpecSha256 !== null && specs.every((s) => s === pe.observedSpecSha256);
	set(
		"spec-digest",
		pe.outcome === "unreadable" && pe.observedSpecSha256 === null ? (binding === null ? null : false) : specOk,
		pe.observedSpecSha256 === null
			? `the run's protected-run.json could not be read (${pe.problem ?? "unreadable"})`
			: specOk
				? `protected-run.json specSha256 ${short(pe.observedSpecSha256)} re-read`
				: "protected-run.json carries another spec digest than the records or the pin",
	);

	const expectedRunId =
		launch !== null
			? launch.operation.run.id
			: binding?.boundBy === "controller"
				? endoProtectedAttemptRunIdV0(input.attemptId)
				: null;
	const runIds = [expectedRunId, binding?.target.runId].filter((x): x is string => x !== null && x !== undefined);
	const runIdOk =
		pe.runId !== null &&
		runIds.every((r) => r === pe.runId) &&
		(binding === null || binding.target.runSchemaVersion === pe.runSchemaVersion);
	set(
		"run-identity",
		pe.runId === null ? (binding === null ? null : false) : runIdOk,
		pe.runId === null
			? "no run identity could be re-read"
			: runIdOk
				? `run ${pe.runId} (${pe.runSchemaVersion})`
				: "the run re-read is not the one the records name",
	);

	const tc = pe.trialCoordinates;
	const coordOk =
		tc !== null &&
		(binding === null
			? launch === null ||
				(tc.task === launch.operation.trial.task &&
					tc.condition === launch.operation.trial.condition &&
					tc.trial === 0)
			: tc.position === binding.target.trial.position &&
				tc.task === binding.target.trial.task &&
				tc.condition === binding.target.trial.condition &&
				tc.trial === binding.target.trial.trial &&
				tc.attempt === binding.target.trial.attempt &&
				(launch === null ||
					(binding.target.trial.task === launch.operation.trial.task &&
						binding.target.trial.condition === launch.operation.trial.condition &&
						binding.target.trial.trial === 0)));
	set(
		"trial-coordinates",
		tc === null ? (binding === null ? null : false) : coordOk,
		tc === null
			? "no trial could be re-read"
			: coordOk
				? `trial ${tc.task}/${tc.condition}/${tc.trial} attempt ${tc.attempt}`
				: "the trial re-read has other coordinates than the records name",
	);

	const recordOk = pe.recordSha256 !== null && (binding === null || binding.target.recordSha256 === pe.recordSha256);
	set(
		"trial-record",
		pe.recordSha256 === null ? (binding === null ? null : false) : recordOk,
		pe.recordSha256 === null
			? `no verified final trial record (${pe.problem ?? pe.outcome})`
			: recordOk
				? `sealed trial record ${short(pe.recordSha256)} re-read and verified`
				: "the sealed trial record re-read is not the one the binding names",
	);

	const terminated =
		pe.agent !== null &&
		pe.preflightStatus === "established" &&
		pe.agent.termination === "confirmed" &&
		pe.agent.scopeEnded === "confirmed";
	set(
		"termination",
		pe.agent === null ? (binding === null ? null : false) : terminated,
		pe.agent === null
			? "no agent facts were re-read"
			: terminated
				? "preflight established; the agent's scope was confirmed ended"
				: "preflight " +
					(pe.preflightStatus ?? "unknown") +
					", termination " +
					pe.agent.termination +
					", scope " +
					(pe.agent.scopeEnded ?? "unknown"),
	);

	const wantsAgent = launch !== null || controller;
	const trees = [launch?.operation.agent.treeSha256, binding?.target.agent?.treeSha256].filter(
		(x): x is string => x !== undefined,
	);
	const copied = input.agentCopy?.treeSha256 ?? null;
	const treeOk = copied !== null && trees.length > 0 && trees.every((t) => t === copied);
	set(
		"agent-tree",
		!wantsAgent || pe.recordSha256 === null ? (wantsAgent && binding !== null ? false : null) : treeOk,
		!wantsAgent
			? "an operator declaration records no agent tree"
			: pe.recordSha256 === null
				? "no sealed record names the mounted agent tree"
				: treeOk
					? `the run's retained /agent copy re-hashes to ${short(copied)}, as the launch record pinned before the run (the sealed trial record does not name it)`
					: "the run's retained /agent copy and the launch or binding record disagree (" +
						(input.agentCopy?.detail ?? "no copy") +
						")",
	);
	const promptOk =
		input.agentCopy?.promptSha256 !== null &&
		input.agentCopy?.promptSha256 !== undefined &&
		input.agentCopy.promptSha256 === input.currentBriefSha256 &&
		(binding?.target.agent === null || binding?.target.agent === undefined
			? true
			: binding.target.agent.promptSha256 === input.agentCopy.promptSha256);
	set(
		"agent-prompt",
		!wantsAgent || pe.recordSha256 === null ? (wantsAgent && binding !== null ? false : null) : promptOk,
		!wantsAgent
			? "an operator declaration records no prompt"
			: promptOk
				? "/agent/prompt.txt is the brief, byte for byte"
				: "/agent/prompt.txt is not the prepared attempt's brief",
	);

	const cand = binding?.target.candidate;
	const candidateMatches =
		pe.candidateIntegrity === "verified" &&
		(cand === undefined
			? true
			: cand.mode === "staged-changeset"
				? pe.candidateMode === "staged-changeset" &&
					cand.baselineSha256 === pe.baselineSha256 &&
					cand.changesetSha256 === pe.changesetSha256 &&
					cand.candidateSha256 === pe.candidateSha256
				: pe.candidateMode === "fixed-paths" && cand.submissionSha256 === pe.submissionSha256);
	set(
		"candidate",
		pe.recordSha256 === null && pe.candidateIntegrity !== "tampered"
			? binding === null
				? null
				: false
			: candidateMatches,
		candidateMatches
			? `candidate ${short(pe.candidateSha256 ?? pe.submissionSha256)} re-verified from its bytes`
			: pe.candidateIntegrity !== "verified"
				? `candidate integrity ${pe.candidateIntegrity}: ${pe.candidateDetail}`
				: "the re-verified candidate is not the one the binding names",
	);

	const checks = ENDO_PROTECTED_ATTEMPT_CHECKS_V0.map((c) => results.get(c) as EndoProtectedAttemptCheckV0);
	const failed = (c: EndoProtectedAttemptCheckIdV0) => results.get(c)?.result === "fail";
	const identityFailed = [...IDENTITY_CHECKS].some(failed);
	const done = (association: EndoProtectedAttemptAssociationV0): EndoProtectedAttemptAssessmentV0 => ({
		association,
		label: ENDO_PROTECTED_ATTEMPT_ASSOCIATION_LABELS_V0[association],
		checks,
		limitation: ENDO_PROTECTED_ATTEMPT_AUTHORITY_LIMITATION_V0,
	});

	if (identityFailed) return done("invalid");
	if (binding !== null) {
		if (pe.candidateIntegrity === "tampered") return done("candidate-integrity-failure");
		if (checks.some((c) => c.result === "fail")) return done("invalid");
		return done(binding.boundBy === "controller" ? "established" : "operator-declared");
	}
	// A launch with no binding: never a result, whatever the run shows.
	if (pe.recordSha256 === null || failed("termination") || pe.agent === null) {
		return done(pe.candidateIntegrity === "tampered" ? "candidate-integrity-failure" : "incomplete-execution");
	}
	if (failed("trial-coordinates") || failed("agent-tree") || failed("agent-prompt")) return done("invalid");
	if (failed("candidate")) return done("candidate-integrity-failure");
	return done("incomplete-execution");
}
