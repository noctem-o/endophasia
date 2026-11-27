#!/usr/bin/env node
/**
 * COORDINATOR-REASONING-001 — Governed Cognitive Resource Allocation Harness
 *
 * Modes (mutually exclusive):
 *   --preflight            Zero-inference fixture, resource-profile, authorization, and OpenClaw preflight verification.
 *                          Writes observations/preflight-manifest.json. Contacts ZERO network endpoints.
 *   --dry-run              Runs --preflight PLUS an end-to-end dry run of S5 & S8 across R1/R2/R3/R4 (and a
 *                          reasoning-budget-exhausted probe) through real installed OpenClaw 2026.11.10 +
 *                          /usr/bin/bwrap + protected model relay against an ephemeral local deterministic fake provider
 *                          (ZERO contact with 127.0.0.1:8091). Writes observations/dry-run-fake-provider.jsonl.
 *   --authorize-phase-b    Live Phase B (S5, S8 under R3 deep=16,384; hard cap: 2 live turns). Requires operator authorization.
 *   --authorize-phase-c    Live Phase C (S5, S8 under R1 light=4,096 & R2 deliberate=8,192; hard cap: 4 live turns).
 *   --authorize-phase-d-r4 Optional Live R4 fallback (S5, S8 under R4 extended=24,576; hard cap: 2 live turns).
 *
 * Frozen architecture (§9):
 *   - Condition C only: briefingMode = "grounded-v1", visibilityMode = "status-and-coordination-v1"
 *   - Prompts, closed rationaleCode vocabulary, validator, sampling (temp=0, top_k=1, top_p=1, min_p=0, seed=101),
 *     and maxAnswerBytes = 4096 are completely unchanged from PR #193 (efd8599cd).
 */

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { coordinatorTargetFromMemberV0 } from "../../../../adapters/coordinator/model-relay.ts";
import {
	pinnedCoordinatorBriefStatusV0,
	preflightOpenClawCoordinatorV0,
	runOpenClawCoordinatorV0,
} from "../../../../adapters/coordinator/openclaw.ts";
import { COORDINATOR_INFERENCE_V0 } from "../../../../adapters/coordinator/wire.ts";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../../../../adapters/develop/advisory-operator.ts";
import {
	defaultObserveAdvisoryProjectV0,
	runEndoAdvisoryTickV0,
} from "../../../../adapters/develop/advisory-tick.ts";
import { runCheckV0 } from "../../../../adapters/develop/check-runner.ts";
import { DevelopCoordinationGitV0 } from "../../../../adapters/develop/coordination.ts";
import { GitRevisionObserverV0 } from "../../../../adapters/git/revision-observer.ts";
import { endoVersionV0 } from "../../../../cli/help.ts";
import { ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1 } from "../../../../protocol/coordinator-grounding.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
	parseEndoCoordinatorModelPoolV1,
} from "../../../../protocol/coordinator-model-pool.ts";
import { presetEndoCoordinatorResourceProfileV1 } from "../../../../protocol/coordinator-resource-policy.ts";
import { validateEndoAdvisoryBudgetV0 } from "../../../../protocol/develop-advisory.ts";
import { ENDO_COORDINATOR_TOOL_V0 } from "../../../../runtime/contracts/coordinator-brief.ts";
import {
	buildEndoCoordinatorModelViewV1,
	ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_SHA256_V1,
	ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_SHA256_V1,
	endoCoordinatorModelViewSha256V1,
} from "../../../../runtime/contracts/coordinator-grounding.ts";
import {
	coordinatorModelPoolSha256V0,
	endoCoordinatorResourceProfileSha256V1,
} from "../../../../runtime/contracts/coordinator-model-pool.ts";
import { endoAdvisorySemanticObservationV0 } from "../../../../runtime/contracts/develop-advisory.ts";
import { DevelopAttemptsServiceV0 } from "../../../../runtime/contracts/develop-attempts.ts";
import { DevelopReceiptsServiceV0 } from "../../../../runtime/contracts/develop-receipts.ts";
import { DevelopAdvisoryStoreV0 } from "../../../../storage/develop-advisory.ts";
import { DevelopAttemptsStoreV0 } from "../../../../storage/develop-attempts.ts";
import { DevelopCoordinationStoreV0 } from "../../../../storage/develop-coordination.ts";
import { DevelopCoordinationReviewsStoreV0 } from "../../../../storage/develop-coordination-reviews.ts";
import { DevelopReceiptsStoreV0 } from "../../../../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../../../../storage/develop-tasks.ts";

const LIVE_ENDPOINT = "http://127.0.0.1:8091";
const MODEL_ID = "Inkling-2-Mini-Uncensored-AD-Q4_K";
const BRIEFING_MODE = "grounded-v1";
const VISIBILITY_MODE = "status-and-coordination-v1";

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../observations");
mkdirSync(OUT_DIR, { recursive: true });

const CONDITIONS = {
	R1: {
		id: "R1",
		tier: "light",
		profile: presetEndoCoordinatorResourceProfileV1("light"),
	},
	R2: {
		id: "R2",
		tier: "deliberate",
		profile: presetEndoCoordinatorResourceProfileV1("deliberate"),
	},
	R3: {
		id: "R3",
		tier: "deep",
		profile: presetEndoCoordinatorResourceProfileV1("deep"),
	},
	R4: {
		id: "R4",
		tier: "extended",
		profile: presetEndoCoordinatorResourceProfileV1("extended"),
	},
};

function mustOk(res, label) {
	if (!res || res.ok !== true) throw new Error(`${label} failed: ${JSON.stringify(res)}`);
	return res;
}

function git(repo, args) {
	return execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function transitionTask(tasks, projectId, taskId, initialRevision, steps) {
	let rev = initialRevision;
	let latest = null;
	for (const { to, note } of steps) {
		const res = mustOk(tasks.setStatus(projectId, taskId, rev, to, note), `setStatus(${taskId} -> ${to})`);
		rev = res.value.revision;
		latest = res.value;
	}
	return latest;
}

async function runHostVerificationCheck(storeRoot, projectId, taskId, repo, { outcome, objective }) {
	const tasks = new DevelopTasksStoreV0(storeRoot);
	const attempts = new DevelopAttemptsStoreV0(storeRoot);
	const attemptSvc = new DevelopAttemptsServiceV0(tasks, attempts);
	const prep = mustOk(attemptSvc.prepare(projectId, taskId, { objective }), `attempt.prepare(${taskId})`);
	const observer = new GitRevisionObserverV0();
	const receiptSvc = new DevelopReceiptsServiceV0(tasks, attempts, new DevelopReceiptsStoreV0(storeRoot), {
		observe: (directory, options) => observer.observe(directory, options),
		run: runCheckV0,
		version: endoVersionV0(),
	});
	const cmd = outcome === "passed" ? ["/usr/bin/true"] : ["/usr/bin/false"];
	const planned = mustOk(
		await receiptSvc.plan(prep.value.id, { argv: cmd, cwd: repo, timeoutMs: 10_000, keepOutput: false }),
		`receipt.plan(${taskId}, ${outcome})`,
	);
	const sink = new PassThrough();
	sink.resume();
	const done = await receiptSvc.run(planned.plan, {
		stdout: sink,
		stderr: sink,
		interrupt: new AbortController().signal,
		hurry: new AbortController().signal,
	});
	if (done.written !== "created" || done.receipt.outcome !== outcome)
		throw new Error(`receipt mismatch for ${taskId}: ${done.written} / ${done.receipt.outcome}`);
	return { attempt: prep.value, receipt: done.receipt };
}

function createBaseFixture(scenarioId) {
	const base = mkdtempSync(join(tmpdir(), `endo-r001-${scenarioId}-`));
	const repo = join(base, "project");
	const storeRoot = join(base, "store");
	mkdirSync(repo, { recursive: true });
	mkdirSync(join(storeRoot, "events"), { recursive: true });
	mkdirSync(join(storeRoot, "develop/attempts"), { recursive: true });
	mkdirSync(join(storeRoot, "develop/receipts"), { recursive: true });
	writeFileSync(join(storeRoot, "events/events.log"), "");
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.name", "endo-exp"]);
	git(repo, ["config", "user.email", "endo-exp@localhost"]);
	writeFileSync(join(repo, "README.md"), `# ${scenarioId}\n`);
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-m", "initial commit"]);
	const tasks = new DevelopTasksStoreV0(storeRoot);
	const reg = mustOk(
		tasks.registerProject({ name: scenarioId, path: repo, observedGitRoot: repo }),
		`registerProject(${scenarioId})`,
	);
	return { base, repo, storeRoot, projectId: reg.value.id, tasks };
}

/** Exact S5 and S8 scenario builders preserved verbatim from S2-LIVE-002 (b1c6b7be9). */
const SCENARIOS = [
	{
		id: "S5-W8-mixed-head",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		async build() {
			const f = createBaseFixture("S5-W8-mixed-head");
			const t1 = mustOk(f.tasks.createTask(f.projectId, { title: "Assigned work without checks" }), "create T1");
			const t2 = mustOk(f.tasks.createTask(f.projectId, { title: "Review task with earlier failure" }), "create T2");
			const t1Moved = transitionTask(f.tasks, f.projectId, t1.value.id, t1.value.revision, [
				{ to: "in-progress", note: "active" },
			]);
			transitionTask(f.tasks, f.projectId, t2.value.id, t2.value.revision, [
				{ to: "in-progress", note: "implemented" },
				{ to: "review", note: "review requested" },
			]);
			await runHostVerificationCheck(f.storeRoot, f.projectId, t2.value.id, f.repo, {
				outcome: "failed",
				objective: "Initial failing check before commit advance",
			});
			writeFileSync(join(f.repo, "change.txt"), "new commit after failure\n");
			git(f.repo, ["add", "change.txt"]);
			git(f.repo, ["commit", "-m", "advance HEAD"]);
			const coord = new DevelopCoordinationStoreV0(f.storeRoot);
			mustOk(
				coord.createAssignment({
					expectedFileRevision: 0,
					expectedTaskRevision: t1Moved.revision,
					projectId: f.projectId,
					taskId: t1.value.id,
					participant: { participantId: "builder-1", role: "builder", intendedHarnessFamily: "pi" },
					workspace: {
						worktreePath: f.repo,
						registration: "project-path",
						accessIntent: "read-write-intended",
						pathHints: [],
						allowSharedWorktree: false,
					},
					targetCandidate: null,
				}),
				"createAssignment(S5 builder)",
			);
			return f;
		},
		assertObserved(obs) {
			const tasks = obs.modelViewC.project.tasks;
			const tNo = tasks.find((t) => t.verification.state === "no-checks" && !t.verification.incomplete);
			const tNotCurr = tasks.find((t) => t.verification.state === "not-current");
			if (!tNo || !tNotCurr) throw new Error("S5 expected no-checks + not-current tasks");
			if (!tNotCurr.gaps.includes("earlier-failure-not-current"))
				throw new Error("S5 expected earlier-failure-not-current gap");
			if (obs.modelViewC.coordination?.assignments.length !== 1)
				throw new Error("S5 expected 1 active builder assignment");
		},
	},
	{
		id: "S8-multi-agent",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		async build() {
			const f = createBaseFixture("S8-multi-agent");
			const t1 = mustOk(f.tasks.createTask(f.projectId, { title: "Primary implementation task" }), "create T1");
			const t2 = mustOk(f.tasks.createTask(f.projectId, { title: "Dependent integration task" }), "create T2");
			const t1Moved = transitionTask(f.tasks, f.projectId, t1.value.id, t1.value.revision, [
				{ to: "in-progress", note: "builder working" },
			]);
			const t2Moved = transitionTask(f.tasks, f.projectId, t2.value.id, t2.value.revision, [
				{ to: "in-progress", note: "started" },
				{ to: "review", note: "awaiting candidate verification and review" },
			]);
			const sibling = join(f.base, "wt-review");
			git(f.repo, ["worktree", "add", "-q", "-b", "review-wt", sibling]);
			const headSha = git(f.repo, ["rev-parse", "HEAD"]);
			const treeSha = git(f.repo, ["rev-parse", "HEAD^{tree}"]);
			const tasksRead = mustOk(f.tasks.read(), "tasks.read(S8)");
			const proj = tasksRead.file.projects.find((p) => p.id === f.projectId);
			const validatedWt = mustOk(
				await new DevelopCoordinationGitV0().validateSiblingWorktree(proj, sibling),
				"validateSiblingWorktree(S8)",
			);
			const coord = new DevelopCoordinationStoreV0(f.storeRoot);
			const regWt = mustOk(
				coord.registerWorktree({
					expectedFileRevision: 0,
					projectId: f.projectId,
					worktreePath: validatedWt.worktree.worktreePath,
					commonDir: validatedWt.worktree.commonDir,
					gitDir: validatedWt.worktree.gitDir,
					label: "s8-review-wt",
				}),
				"registerWorktree(S8)",
			);
			const priorBuilder = mustOk(
				coord.createAssignment({
					expectedFileRevision: regWt.file.revision,
					expectedTaskRevision: t1Moved.revision,
					projectId: f.projectId,
					taskId: t1.value.id,
					participant: { participantId: "builder-prev", role: "builder", intendedHarnessFamily: "pi" },
					workspace: {
						worktreePath: f.repo,
						registration: "project-path",
						accessIntent: "read-write-intended",
						pathHints: [],
						allowSharedWorktree: false,
					},
					targetCandidate: null,
				}),
				"createAssignment(S8 prior builder)",
			);
			const priorSess = mustOk(
				coord.associateSession(priorBuilder.value.assignmentId, priorBuilder.value.revision, {
					source: "codex-live",
					sessionKey: "codex-live:persistent:s8-prev",
					attachmentId: "codex.s8",
					instanceId: "inst-s8-prev",
					runtimeFingerprintId: null,
				}),
				"associateSession(S8 prior builder)",
			);
			const endedHazard = mustOk(
				coord.endAssignment(priorSess.value.assignmentId, priorSess.value.revision, "revoked", "process stop unconfirmed"),
				"endAssignment(S8 prior builder)",
			);
			const activeBuilder = mustOk(
				coord.createAssignment({
					expectedFileRevision: endedHazard.file.revision,
					expectedTaskRevision: t1Moved.revision,
					projectId: f.projectId,
					taskId: t1.value.id,
					participant: { participantId: "builder-1", role: "builder", intendedHarnessFamily: "pi" },
					workspace: {
						worktreePath: f.repo,
						registration: "project-path",
						accessIntent: "read-write-intended",
						pathHints: [],
						allowSharedWorktree: true,
					},
					targetCandidate: null,
				}),
				"createAssignment(S8 active builder)",
			);
			const activeSess = mustOk(
				coord.associateSession(activeBuilder.value.assignmentId, activeBuilder.value.revision, {
					source: "codex-live",
					sessionKey: "codex-live:persistent:s8-active",
					attachmentId: "codex.s8",
					instanceId: "inst-s8-active",
					runtimeFingerprintId: null,
				}),
				"associateSession(S8 active builder)",
			);
			const attemptSvc = new DevelopAttemptsServiceV0(f.tasks, new DevelopAttemptsStoreV0(f.storeRoot));
			const prep = mustOk(
				attemptSvc.prepare(f.projectId, t1.value.id, { objective: "Deliver candidate commit for T1" }),
				"attempt.prepare(S8 T1)",
			);
			const linkedAtt = mustOk(
				coord.linkAttempt(activeSess.value.assignmentId, activeSess.value.revision, prep.value.id),
				"linkAttempt(S8 active builder)",
			);
			const cand = mustOk(
				coord.declareCandidate({
					expectedFileRevision: linkedAtt.file.revision,
					projectId: f.projectId,
					taskId: t1.value.id,
					candidate: {
						kind: "git-commit",
						commonDir: validatedWt.worktree.commonDir,
						worktreePath: f.repo,
						commitSha: headSha,
						treeSha,
						attemptId: prep.value.id,
					},
				}),
				"declareCandidate(S8 C1)",
			);
			const reviewer = mustOk(
				coord.createAssignment({
					expectedFileRevision: cand.file.revision,
					expectedTaskRevision: t2Moved.revision,
					projectId: f.projectId,
					taskId: t2.value.id,
					participant: { participantId: "reviewer-1", role: "reviewer", intendedHarnessFamily: "codex" },
					workspace: {
						worktreePath: validatedWt.worktree.worktreePath,
						registration: "registered-sibling",
						accessIntent: "read-only-intended",
						pathHints: [],
						allowSharedWorktree: false,
					},
					targetCandidate: { taskId: t1.value.id, candidateId: cand.value.candidateId },
				}),
				"createAssignment(S8 reviewer)",
			);
			mustOk(
				coord.addDependency({
					expectedFileRevision: reviewer.file.revision,
					projectId: f.projectId,
					dependentTaskId: t2.value.id,
					prerequisiteTaskId: t1.value.id,
					condition: "candidate-has-passing-receipt",
				}),
				"addDependency(S8 T2->T1)",
			);
			const reviews = new DevelopCoordinationReviewsStoreV0(f.storeRoot);
			mustOk(
				reviews.recordReview({
					projectId: f.projectId,
					candidateTaskId: t1.value.id,
					candidateId: cand.value.candidateId,
					assignmentId: reviewer.value.assignmentId,
					attemptId: prep.value.id,
					reviewer: {
						participantId: "reviewer-1",
						harnessFamily: "codex",
						sessionKey: null,
						runtimeFingerprintId: null,
					},
					verdict: "changes-requested",
					summary: "Candidate lacks host verification receipt and has unresolved edge cases.",
					findings: [
						{ severity: "high", category: "correctness", summary: "Missing boundary check", location: "README.md:1" },
						{ severity: "medium", category: "testing", summary: "No host check recorded", location: "README.md:1" },
					],
					agentClaimedChecks: "reviewer inspected diff only",
					checkout: {
						standing: "unobserved",
						worktreePath: null,
						preObservationId: null,
						postObservationId: null,
						cleanAtCandidate: false,
						reason: "offline",
					},
					recordedBy: "operator",
				}),
				"recordReview(S8)",
			);
			return f;
		},
		assertObserved(obs) {
			if (obs.semantic.completeness !== "complete")
				throw new Error(`S8 expected complete observation, got ${obs.semantic.completeness}`);
			const c = obs.modelViewC.coordination;
			if (!c || c.sourceState !== "ready") throw new Error("S8 expected ready coordination");
			if (!c.assignments.some((a) => a.hazard === "liveness-unverified"))
				throw new Error("S8 expected liveness-unverified hazard assignment");
			if (c.candidates.length !== 1 || c.candidates[0].relation !== "current")
				throw new Error("S8 expected 1 current git-commit candidate");
			if (c.dependencies.length !== 1 || c.dependencies[0].satisfaction !== "unsatisfied")
				throw new Error("S8 expected 1 unsatisfied dependency");
			if (c.conflicts.length < 1) throw new Error("S8 expected >= 1 worktree conflict");
			if (c.reviews.length !== 1 || c.reviews[0].verdict !== "changes-requested")
				throw new Error("S8 expected 1 changes-requested advisory review");
		},
	},
];

/** Deterministic static priority ruleset baseline (§12) — zero tokens, fixed priority ordering. */
function staticPriorityBaseline(modelViewC) {
	const ranked = [];
	const c = modelViewC.coordination;
	if (c) {
		for (const cf of c.conflicts)
			ranked.push({ priority: 1, kind: "resolve-worktree-conflict", subject: cf.conflictRef, rule: "worktree-conflict" });
		for (const a of c.assignments)
			if (a.hazard === "liveness-unverified")
				ranked.push({
					priority: 2,
					kind: "investigate-liveness-hazard",
					subject: a.assignmentId,
					rule: "liveness-hazard",
				});
		for (const d of c.dependencies)
			if (d.satisfaction === "unsatisfied")
				ranked.push({
					priority: 3,
					kind: "resolve-unsatisfied-dependency",
					subject: d.dependencyId,
					rule: "unsatisfied-dependency",
				});
		for (const r of c.reviews)
			if (r.verdict === "changes-requested")
				ranked.push({ priority: 4, kind: "inspect-advisory-review", subject: r.reviewId, rule: "changes-requested" });
	}
	for (const t of modelViewC.project.tasks) {
		if (t.verification.state === "failing")
			ranked.push({ priority: 2, kind: "review-failing-verification", subject: t.taskId, rule: "failing-at-head" });
		if (t.verification.state === "not-current" || t.verification.incomplete)
			ranked.push({
				priority: 5,
				kind: "investigate-incomplete-verification",
				subject: t.taskId,
				rule: "not-current-or-incomplete",
			});
		if (t.phase === "awaiting-review")
			ranked.push({ priority: 6, kind: "review-awaiting-review", subject: t.taskId, rule: "awaiting-review" });
	}
	ranked.sort((a, b) => a.priority - b.priority);
	return { topAction: ranked[0] ?? null, totalSignals: ranked.length, ranked: ranked.slice(0, 6) };
}

async function observeFixture(storeRoot, projectId) {
	const { status, coordination } = await defaultObserveAdvisoryProjectV0({
		root: storeRoot,
		projectId,
		nowMs: Date.now(),
	});
	const semantic = endoAdvisorySemanticObservationV0(projectId, status, coordination);
	const pinned = mustOk(pinnedCoordinatorBriefStatusV0(storeRoot, projectId, { status, coordination }), "pinned");
	const modelViewC = buildEndoCoordinatorModelViewV1({
		projectId,
		statusView: pinned.view,
		coordination: pinned.coordination,
		visibilityMode: VISIBILITY_MODE,
	});
	return {
		status,
		coordination,
		semantic,
		pinned,
		modelViewC,
		modelViewSha256: endoCoordinatorModelViewSha256V1(modelViewC),
		modelViewBytes: Buffer.byteLength(JSON.stringify(modelViewC), "utf8"),
	};
}

function makePoolV1(endpoint, profile) {
	return parseEndoCoordinatorModelPoolV1({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V1,
		selection: { fallback: "none", unconfirmedModel: "permit" },
		resourceProfile: profile,
		members: [
			{
				memberId: "inkling-local",
				kind: "local-openai-compat",
				endpoint,
				modelId: MODEL_ID,
				priority: 100,
				maxPromptBytes: 8192,
				maxOutputTokens: profile.maxOutputTokensPerRequest,
				timeoutMs: profile.modelExecutionTimeoutMs,
				advisoryOnly: true,
			},
		],
	});
}

function configureAdvisorySchedule(storeRoot, projectId, scenario, condition, endpoint, nowMs) {
	const scheduleId = `r001-${scenario.id.toLowerCase().slice(0, 12)}-${condition.id.toLowerCase()}`;
	mustOk(
		addEndoAdvisoryScheduleV0(
			storeRoot,
			{
				scheduleId,
				label: `${scenario.id} ${condition.id}`,
				projectId,
				actionKind: scenario.actionKind,
				wake: scenario.wake,
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "once", atMs: nowMs },
			},
			() => nowMs,
		),
		"addSchedule",
	);
	mustOk(setEndoAdvisoryScheduleEnabledV0(storeRoot, scheduleId, true, 1, () => nowMs), "enableSchedule");
	const pool = makePoolV1(endpoint, condition.profile);
	const budget = validateEndoAdvisoryBudgetV0(
		{
			periodMs: 3_600_000,
			maxTurnsPerPeriod: 1,
			completionRequestsPerTurn: 2,
			maxOutputTokensPerRequest: condition.profile.maxOutputTokensPerRequest,
			maxGeneratedTokensPerPeriod: 2 * condition.profile.maxOutputTokensPerRequest,
			maxTurnWallClockMs: condition.profile.advisoryTurnDeadlineMs,
		},
		"budget",
		condition.profile,
	);
	const auth = mustOk(
		authorizeEndoAdvisoryScheduleV0(
			storeRoot,
			{
				scheduleId,
				scheduleRevision: 2,
				pool,
				resourceProfile: condition.profile,
				policy: {
					permitCapacityUnknown: true,
					permitModelUnconfirmed: true,
					permitPartialObservation: false,
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 600_000,
				},
				budget,
				lifetimeMs: 86_400_000,
			},
			() => nowMs,
		),
		"authorizeSchedule",
	);
	return { scheduleId, pool, budget, authorization: auth.value };
}

async function runPreflight() {
	const manifest = {
		schemaVersion: "endo.coordinator-reasoning-001.preflight.v1",
		generatedAt: new Date().toISOString(),
		liveInferenceContacted: false,
		frozenArchitecture: {
			briefingMode: BRIEFING_MODE,
			visibilityMode: VISIBILITY_MODE,
			instructionsSha256: ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_SHA256_V1,
			proposalQuestionSha256: ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_SHA256_V1,
			sampling: COORDINATOR_INFERENCE_V0,
			maxAnswerBytes: 4096,
		},
		conditions: Object.values(CONDITIONS).map((c) => ({
			id: c.id,
			tier: c.tier,
			resourceProfileSha256: endoCoordinatorResourceProfileSha256V1(c.profile),
			poolSha256AtLiveEndpoint: coordinatorModelPoolSha256V0(makePoolV1(LIVE_ENDPOINT, c.profile)),
			profile: c.profile,
		})),
		scenarios: [],
	};

	for (const scenario of SCENARIOS) {
		const f = await scenario.build();
		try {
			const obs = await observeFixture(f.storeRoot, f.projectId);
			scenario.assertObserved(obs);
			const openclawPreflightByCondition = {};
			for (const cond of Object.values(CONDITIONS)) {
				const pool = makePoolV1(LIVE_ENDPOINT, cond.profile);
				const target = coordinatorTargetFromMemberV0(pool.members[0], cond.profile);
				const pf = preflightOpenClawCoordinatorV0(
					f.storeRoot,
					{ projectId: f.projectId },
					{
						target,
						pinnedObservation: { status: obs.status, coordination: obs.coordination },
						briefingMode: BRIEFING_MODE,
						visibilityMode: VISIBILITY_MODE,
					},
				);
				if (!pf.ok) throw new Error(`OpenClaw preflight failed for ${scenario.id}/${cond.id}: ${pf.reason} (${pf.detail})`);
				openclawPreflightByCondition[cond.id] = pf;
			}
			manifest.scenarios.push({
				id: scenario.id,
				actionKind: scenario.actionKind,
				wake: scenario.wake,
				completeness: obs.semantic.completeness,
				gaps: obs.semantic.gaps,
				modelViewBytes: obs.modelViewBytes,
				taskCount: obs.modelViewC.project.tasks.length,
				assignmentCount: obs.modelViewC.coordination?.assignments.length ?? 0,
				dependencyCount: obs.modelViewC.coordination?.dependencies.length ?? 0,
				candidateCount: obs.modelViewC.coordination?.candidates.length ?? 0,
				conflictCount: obs.modelViewC.coordination?.conflicts.length ?? 0,
				reviewCount: obs.modelViewC.coordination?.reviews.length ?? 0,
				staticPriorityBaseline: staticPriorityBaseline(obs.modelViewC),
				openclawPreflightByCondition,
			});
		} finally {
			rmSync(f.base, { recursive: true, force: true });
		}
	}

	const outPath = join(OUT_DIR, "preflight-manifest.json");
	writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return { manifest, outPath };
}

function buildValidGroundedResponse(obs) {
	const tasks = obs.modelViewC.project.tasks;
	const c = obs.modelViewC.coordination;
	const firstTask = tasks[0];
	const claims = [
		{
			subjectKind: "task",
			subjectId: firstTask.taskId,
			predicate: "task-phase",
			value: firstTask.phase,
			evidenceRef: firstTask.evidenceRef,
		},
	];
	if (c?.conflicts.length) {
		claims.push({
			subjectKind: "conflict",
			subjectId: c.conflicts[0].conflictRef,
			predicate: "conflict-kind",
			value: c.conflicts[0].kind,
			evidenceRef: c.conflicts[0].evidenceRef,
		});
	}
	const eligTask = obs.modelViewC.proposalEligibility.find((e) => e.eligibleKinds.length > 0);
	const proposal = eligTask
		? { kind: eligTask.eligibleKinds[0], taskId: eligTask.taskId, evidenceRef: `ev:task:${eligTask.taskId}` }
		: null;
	const rec = c?.conflicts.length
		? {
				kind: "resolve-worktree-conflict",
				subjectKind: "conflict",
				subjectId: c.conflicts[0].conflictRef,
				supportingRefs: [c.conflicts[0].evidenceRef],
				priority: "high",
				rationaleCode: "worktree-write-conflict",
			}
		: {
				kind: "investigate-incomplete-verification",
				subjectKind: "task",
				subjectId: tasks.find((t) => t.verification.state === "not-current")?.taskId ?? firstTask.taskId,
				supportingRefs: [tasks.find((t) => t.verification.state === "not-current")?.evidenceRef ?? firstTask.evidenceRef],
				priority: "high",
				rationaleCode: "verification-not-current-or-incomplete",
			};
	return JSON.stringify({
		schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
		claims,
		uncertainties: [],
		recommendations: [rec],
		proposal,
	});
}

function sse(delta, finishReason, usage) {
	return (
		`data: ${JSON.stringify({ id: "cmpl-dry", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
		`data: ${JSON.stringify({ id: "cmpl-dry", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n` +
		"data: [DONE]\n\n"
	);
}

async function runDryRun() {
	await runPreflight();
	const outPath = join(OUT_DIR, "dry-run-fake-provider.jsonl");
	writeFileSync(outPath, "");
	const results = [];

	const cells = [];
	for (const scenario of SCENARIOS) {
		for (const cond of Object.values(CONDITIONS)) cells.push({ scenario, cond, mode: "valid" });
	}
	cells.push({ scenario: SCENARIOS[0], cond: CONDITIONS.R1, mode: "reasoning-exhausted" });

	for (const cell of cells) {
		const f = await cell.scenario.build();
		let server;
		try {
			const obs = await observeFixture(f.storeRoot, f.projectId);
			const seenRequests = [];
			server = createServer(async (req, res) => {
				const chunks = [];
				for await (const c of req) chunks.push(c);
				const body = Buffer.concat(chunks).toString("utf8");
				if (req.method === "GET" && req.url === "/health") {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ status: "ok" }));
					return;
				}
				if (req.method === "GET" && req.url === "/props") {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ role: "single", build_info: "b12622-dryrun" }));
					return;
				}
				if (req.method === "GET" && req.url === "/v1/models") {
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ data: [{ id: MODEL_ID, status: { value: "loaded" } }] }));
					return;
				}
				if (req.method === "POST" && req.url === "/v1/chat/completions") {
					const parsed = JSON.parse(body);
					seenRequests.push({
						max_tokens: parsed.max_tokens,
						temperature: parsed.temperature,
						top_k: parsed.top_k,
						top_p: parsed.top_p,
						min_p: parsed.min_p,
						seed: parsed.seed,
					});
					const isFirst = !body.includes('"role":"tool"');
					res.setHeader("content-type", "text/event-stream");
					if (isFirst) {
						res.end(
							sse(
								{
									tool_calls: [
										{
											index: 0,
											id: "call_dry_1",
											type: "function",
											function: {
												name: ENDO_COORDINATOR_TOOL_V0,
												arguments: JSON.stringify({ project: f.projectId }),
											},
										},
									],
								},
								"tool_calls",
								{ prompt_tokens: 1100, completion_tokens: 40 },
							),
						);
						return;
					}
					if (cell.mode === "reasoning-exhausted") {
						res.end(
							sse({ reasoning_content: "DRY_RUN_SECRET_THOUGHT_MUST_NOT_LEAK" }, "length", {
								prompt_tokens: 3200,
								completion_tokens: cell.cond.profile.maxOutputTokensPerRequest,
							}),
						);
						return;
					}
					res.end(
						sse(
							{
								reasoning_content: "DRY_RUN_INTERNAL_REASONING_NEVER_STORED",
								content: buildValidGroundedResponse(obs),
							},
							"stop",
							{ prompt_tokens: 3200, completion_tokens: 380 },
						),
					);
					return;
				}
				res.statusCode = 404;
				res.end();
			});
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			const port = server.address().port;
			const fakeOrigin = `http://127.0.0.1:${port}`;
			const nowMs = Date.now();
			configureAdvisorySchedule(f.storeRoot, f.projectId, cell.scenario, cell.cond, fakeOrigin, nowMs);

			let capturedTrial = null;
			const tick = await runEndoAdvisoryTickV0({
				root: f.storeRoot,
				now: () => nowMs,
				briefingMode: BRIEFING_MODE,
				visibilityMode: VISIBILITY_MODE,
				run: (r, req, opts) =>
					runOpenClawCoordinatorV0(r, req, {
						...opts,
						trial: (t) => {
							capturedTrial = t;
							opts?.trial?.(t);
						},
					}),
			});
			const store = new DevelopAdvisoryStoreV0(f.storeRoot);
			const turns = store.listTurns(nowMs);
			const briefing = turns.ok ? turns.entries[0]?.briefing ?? null : null;
			const record = {
				mode: cell.mode,
				scenarioId: cell.scenario.id,
				conditionId: cell.cond.id,
				tier: cell.cond.tier,
				expectedMaxTokens: cell.cond.profile.maxOutputTokensPerRequest,
				observedWireRequests: seenRequests,
				tickOk: tick.ok,
				outcomeStatus: tick.ok ? tick.outcomes[0]?.status ?? null : tick.refusal,
				availability: briefing?.availability ?? null,
				refusal: briefing?.refusal ?? null,
				proposalOutcome: briefing?.proposal?.outcome ?? null,
				reservedTokens: briefing?.accounting?.reserved?.generatedTokens ?? null,
				chargedTokens: briefing?.accounting?.chargedGeneratedTokens ?? null,
				diagnostics: capturedTrial?.diagnostics ?? null,
			};
			if (JSON.stringify(record).includes("DRY_RUN_SECRET_THOUGHT") || JSON.stringify(record).includes("DRY_RUN_INTERNAL_REASONING"))
				throw new Error("Raw reasoning leaked into dry-run record!");
			if (cell.mode === "valid") {
				if (record.availability !== "available")
					throw new Error(`Dry run failed for ${cell.scenario.id}/${cell.cond.id}: ${record.refusal}`);
				if (seenRequests.some((r) => r.max_tokens !== cell.cond.profile.maxOutputTokensPerRequest))
					throw new Error(`max_tokens mismatch for ${cell.scenario.id}/${cell.cond.id}`);
			} else if (record.refusal !== "reasoning-budget-exhausted") {
				throw new Error(`Expected reasoning-budget-exhausted, got ${record.refusal}`);
			}
			appendFileSync(outPath, `${JSON.stringify(record)}\n`);
			results.push(record);
		} finally {
			if (server) {
				server.closeAllConnections();
				await new Promise((r) => server.close(r));
			}
			rmSync(f.base, { recursive: true, force: true });
		}
	}
	return { results, outPath };
}

function appendLedgerFsync(path, entry) {
	const fd = openSync(path, "a", 0o600);
	try {
		appendFileSync(fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

async function runLivePhase(phaseFlag) {
	if (process.env.ENDO_REASONING_001_LOCKED !== "1") {
		throw new Error("Live execution MUST run under an operator-local exclusive flock (set ENDO_REASONING_001_LOCKED=1 inside flock).");
	}
	const phasePlan = {
		"--authorize-phase-b": { phase: "B", maxPhaseTurns: 2, conditionIds: ["R3"] },
		"--authorize-phase-c": { phase: "C", maxPhaseTurns: 4, conditionIds: ["R1", "R2"] },
		"--authorize-phase-d-r4": { phase: "D-R4", maxPhaseTurns: 2, conditionIds: ["R4"] },
	}[phaseFlag];
	if (!phasePlan) throw new Error(`Unknown live phase flag: ${phaseFlag}`);

	const ledgerPath = join(OUT_DIR, "live-ledger.jsonl");
	const existing = existsSync(ledgerPath)
		? readFileSync(ledgerPath, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
	const attemptedCells = new Set(existing.filter((e) => e.recordType === "turn-intent").map((e) => e.cellId));
	const phaseIntents = existing.filter((e) => e.recordType === "turn-intent" && e.phase === phasePlan.phase).length;
	const totalIntents = existing.filter((e) => e.recordType === "turn-intent").length;
	if (totalIntents >= 8) throw new Error("Hard aggregate live ceiling (8 turns across all phases) reached.");

	let ranInPhase = phaseIntents;
	for (const condId of phasePlan.conditionIds) {
		const cond = CONDITIONS[condId];
		for (const scenario of SCENARIOS) {
			const cellId = `${scenario.id}::${cond.id}`;
			if (attemptedCells.has(cellId)) continue;
			if (ranInPhase >= phasePlan.maxPhaseTurns) {
				throw new Error(`Phase ${phasePlan.phase} turn ceiling (${phasePlan.maxPhaseTurns}) reached.`);
			}
			const f = await scenario.build();
			try {
				const obs = await observeFixture(f.storeRoot, f.projectId);
				scenario.assertObserved(obs);
				const nowMs = Date.now();
				configureAdvisorySchedule(f.storeRoot, f.projectId, scenario, cond, LIVE_ENDPOINT, nowMs);

				appendLedgerFsync(ledgerPath, {
					recordType: "turn-intent",
					phase: phasePlan.phase,
					cellId,
					scenarioId: scenario.id,
					conditionId: cond.id,
					tier: cond.tier,
					maxOutputTokens: cond.profile.maxOutputTokensPerRequest,
					reservedTokens: cond.profile.maxAggregateGeneratedTokensPerTurn,
					resourceProfileSha256: endoCoordinatorResourceProfileSha256V1(cond.profile),
					startedAt: new Date().toISOString(),
				});
				ranInPhase += 1;

				let capturedTrial = null;
				const wallStart = Date.now();
				const tick = await runEndoAdvisoryTickV0({
					root: f.storeRoot,
					now: () => Date.now(),
					briefingMode: BRIEFING_MODE,
					visibilityMode: VISIBILITY_MODE,
					run: (r, req, opts) =>
						runOpenClawCoordinatorV0(r, req, {
							...opts,
							trial: (t) => {
								capturedTrial = t;
								opts?.trial?.(t);
							},
						}),
				});
				const store = new DevelopAdvisoryStoreV0(f.storeRoot);
				const turns = store.listTurns(Date.now());
				const briefing = turns.ok ? turns.entries[0]?.briefing ?? null : null;
				const proposals = store.listProposals();
				appendLedgerFsync(ledgerPath, {
					recordType: "turn-result",
					phase: phasePlan.phase,
					cellId,
					scenarioId: scenario.id,
					conditionId: cond.id,
					tier: cond.tier,
					finishedAt: new Date().toISOString(),
					wallElapsedMs: Date.now() - wallStart,
					tickOk: tick.ok,
					inferenceDispatched: tick.inferenceDispatched,
					outcomeStatus: tick.ok ? tick.outcomes[0]?.status ?? null : tick.refusal,
					availability: briefing?.availability ?? null,
					refusal: briefing?.refusal ?? null,
					answer: briefing?.answer ?? null,
					proposal: briefing?.proposal ?? null,
					proposalDetails: proposals.ok ? proposals.entries.map((e) => e.proposal) : [],
					accounting: briefing?.accounting ?? null,
					diagnostics: capturedTrial?.diagnostics ?? null,
				});
			} finally {
				rmSync(f.base, { recursive: true, force: true });
			}
		}
	}
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
if (flags.length !== 1) {
	console.error(
		"Usage: node run-reasoning-001.mjs (--preflight | --dry-run | --authorize-phase-b | --authorize-phase-c | --authorize-phase-d-r4)",
	);
	process.exit(2);
}

if (flags[0] === "--preflight") {
	const { manifest, outPath } = await runPreflight();
	console.log(
		JSON.stringify({
			ok: true,
			mode: "preflight",
			outPath,
			scenarios: manifest.scenarios.length,
			conditions: manifest.conditions.length,
			liveInferenceContacted: false,
		}),
	);
} else if (flags[0] === "--dry-run") {
	const { results, outPath } = await runDryRun();
	console.log(
		JSON.stringify({
			ok: true,
			mode: "dry-run",
			outPath,
			cellsVerified: results.length,
			liveInferenceContacted: false,
		}),
	);
} else {
	await runLivePhase(flags[0]);
	console.log(JSON.stringify({ ok: true, mode: flags[0] }));
}
