#!/usr/bin/env node
/**
 * S2-LIVE-002 Stage 2 — Paired Live Comparative Evaluation Harness & Zero-Inference Preflight
 *
 * Modes (mutually exclusive):
 *   --preflight              Zero-inference fixture, assertion, and A/B/C semantic-equivalence verification.
 *                            Writes observations/stage2-preflight-manifest.json. Contacts zero endpoints.
 *   --dry-run                Runs --preflight PLUS a full 24-cell end-to-end dry run through real installed
 *                            OpenClaw 2026.11.10 + /usr/bin/bwrap + model relay against an ephemeral local
 *                            deterministic fake provider (ZERO contact with 127.0.0.1:8091).
 *                            Writes observations/stage2-dry-run.jsonl.
 *   --authorize-live-stage2  Executes the live paired comparison against 127.0.0.1:8091 ONLY after explicit
 *                            operator approval. Append-only, interrupt-safe, resumable, and hard-capped at
 *                            24 aggregate dispatched live turns across all runs/restarts.
 *
 * Never stops, restarts, or reconfigures `llama-server` (127.0.0.1:8091) or `openclaw-gateway.service`.
 * Never modifies PR #192 or any operator workspace.
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
import { pinnedCoordinatorBriefStatusV0 } from "../../../../adapters/coordinator/openclaw.ts";
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
import { parseEndoCoordinatorModelPoolV0 } from "../../../../protocol/coordinator-model-pool.ts";
import { ENDO_COORDINATOR_TOOL_V0 } from "../../../../runtime/contracts/coordinator-brief.ts";
import {
	buildEndoCoordinatorModelViewV1,
	endoCoordinatorModelViewSha256V1,
} from "../../../../runtime/contracts/coordinator-grounding.ts";
import {
	endoAdvisorySemanticObservationV0,
	endoAdvisoryWakeDecisionV0,
} from "../../../../runtime/contracts/develop-advisory.ts";
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
const POOL_MEMBER_TIMEOUT_MS = 135_000; // protocol/coordinator-model-pool.ts max ceiling (135 s)
const ADVISORY_TURN_WALL_CLOCK_MS = 180_000; // separate S2 advisory turn deadline (180 s)
const AGGREGATE_LIVE_TURN_CEILING = 24;

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../observations");
mkdirSync(OUT_DIR, { recursive: true });

const CONDITIONS = [
	{ id: "A", briefingMode: "legacy-v0", visibilityMode: "status-v0" },
	{ id: "B", briefingMode: "grounded-v1", visibilityMode: "status-v0" },
	{ id: "C", briefingMode: "grounded-v1", visibilityMode: "status-and-coordination-v1" },
];

const ROTATIONS = [
	["A", "B", "C"],
	["B", "C", "A"],
	["C", "A", "B"],
];

function makePool(endpoint) {
	return parseEndoCoordinatorModelPoolV0({
		schemaVersion: "endo.coordinator-model-pool.v0",
		selection: { fallback: "none", unconfirmedModel: "permit" },
		members: [
			{
				memberId: "inkling-local",
				kind: "local-openai-compat",
				endpoint,
				modelId: MODEL_ID,
				priority: 100,
				maxPromptBytes: 8192,
				maxOutputTokens: 2048,
				timeoutMs: POOL_MEMBER_TIMEOUT_MS,
				advisoryOnly: true,
			},
		],
	});
}

function mustOk(res, label) {
	if (!res || res.ok !== true) {
		throw new Error(`${label} failed: ${JSON.stringify(res)}`);
	}
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
		if (res.value.status !== to) throw new Error(`expected status ${to}, got ${res.value.status}`);
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
	if (done.written !== "created") throw new Error(`receipt.write(${taskId}) returned ${done.written}`);
	if (done.receipt.outcome !== outcome)
		throw new Error(`receipt outcome mismatch: expected ${outcome}, got ${done.receipt.outcome}`);
	return { attempt: prep.value, receipt: done.receipt };
}

function createBaseFixture(scenarioId, { initEventsAndAttempts = true } = {}) {
	const base = mkdtempSync(join(tmpdir(), `endo-s2-live-002-${scenarioId}-`));
	const repo = join(base, "project");
	const storeRoot = join(base, "store");
	mkdirSync(repo, { recursive: true });
	mkdirSync(storeRoot, { recursive: true });
	if (initEventsAndAttempts) {
		mkdirSync(join(storeRoot, "events"), { recursive: true });
		mkdirSync(join(storeRoot, "develop/attempts"), { recursive: true });
		mkdirSync(join(storeRoot, "develop/receipts"), { recursive: true });
		writeFileSync(join(storeRoot, "events/events.log"), "");
	}
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

async function observeFixture(storeRoot, projectId) {
	const { status, coordination } = await defaultObserveAdvisoryProjectV0({
		root: storeRoot,
		projectId,
		nowMs: Date.now(),
	});
	const semantic = endoAdvisorySemanticObservationV0(projectId, status, coordination);
	const pinned = mustOk(pinnedCoordinatorBriefStatusV0(storeRoot, projectId, { status, coordination }), "pinned");
	const modelViewB = buildEndoCoordinatorModelViewV1({
		projectId,
		statusView: pinned.view,
		coordination: pinned.coordination,
		visibilityMode: "status-v0",
	});
	const modelViewC = buildEndoCoordinatorModelViewV1({
		projectId,
		statusView: pinned.view,
		coordination: pinned.coordination,
		visibilityMode: "status-and-coordination-v1",
	});
	return { status, coordination, semantic, pinned, modelViewB, modelViewC };
}

/** Normalize random IDs/timestamps so structural equivalence across A/B/C can be verified mechanically. */
function normalizeObservedStructure(obs) {
	const proj = obs.modelViewC.project;
	// Assign deterministic semantic slots independent of random UUID sort order
	const sortedTasks = [...proj.tasks].sort((a, b) =>
		`${a.phase}|${a.verification.state}|${a.title ?? ""}`.localeCompare(
			`${b.phase}|${b.verification.state}|${b.title ?? ""}`,
		),
	);
	const taskMap = new Map(sortedTasks.map((t, i) => [t.taskId, `T${i + 1}`]));
	const coord = obs.modelViewC.coordination;
	const sortedAssigns = [...(coord?.assignments ?? [])].sort((a, b) =>
		`${a.hazard}|${a.state}|${a.role}|${a.participantId}`.localeCompare(
			`${b.hazard}|${b.state}|${b.role}|${b.participantId}`,
		),
	);
	const assignMap = new Map(sortedAssigns.map((a, i) => [a.assignmentId, `A${i + 1}`]));
	const sortedDeps = [...(coord?.dependencies ?? [])].sort((a, b) =>
		`${taskMap.get(a.dependentTaskId)}->${taskMap.get(a.prerequisiteTaskId)}`.localeCompare(
			`${taskMap.get(b.dependentTaskId)}->${taskMap.get(b.prerequisiteTaskId)}`,
		),
	);
	const depMap = new Map(sortedDeps.map((d, i) => [d.dependencyId, `D${i + 1}`]));
	const sortedCands = [...(coord?.candidates ?? [])].sort((a, b) =>
		`${taskMap.get(a.taskId)}|${a.kind}|${a.relation}`.localeCompare(
			`${taskMap.get(b.taskId)}|${b.kind}|${b.relation}`,
		),
	);
	const candMap = new Map(sortedCands.map((c, i) => [c.candidateId, `C${i + 1}`]));
	return {
		completeness: obs.semantic.completeness,
		gaps: obs.semantic.gaps,
		sources: {
			tasks: obs.modelViewC.sources.tasks.state,
			attempts: obs.modelViewC.sources.attempts.state,
			events: obs.modelViewC.sources.events.state,
		},
		head: proj.head,
		counts: proj.counts,
		tasks: sortedTasks.map((t) => ({
			slot: taskMap.get(t.taskId),
			phase: t.phase,
			verificationState: t.verification.state,
			incomplete: t.verification.incomplete,
			results: t.verification.results,
			gaps: t.gaps,
		})),
		coordination: coord
			? {
					sourceState: coord.sourceState,
					completeness: coord.completeness,
					truncated: coord.truncated,
					gaps: coord.gaps,
					assignments: sortedAssigns.map((a) => ({
						slot: assignMap.get(a.assignmentId),
						task: taskMap.get(a.taskId),
						state: a.state,
						role: a.role,
						hazard: a.hazard,
						hasSession: a.session !== null,
						sessionLiveness: a.session?.liveness ?? null,
						terminationConfirmed: a.session?.terminationConfirmed ?? null,
						accessIntent: a.workspace.accessIntent,
						registration: a.workspace.registration,
						hasTargetCandidate: a.targetCandidate !== null,
						findings: a.findings,
					})),
					dependencies: sortedDeps.map((d) => ({
						slot: depMap.get(d.dependencyId),
						dependent: taskMap.get(d.dependentTaskId),
						prerequisite: taskMap.get(d.prerequisiteTaskId),
						condition: d.condition,
						satisfaction: d.satisfaction,
						reasons: d.reasons,
					})),
					candidates: sortedCands.map((c) => ({
						slot: candMap.get(c.candidateId),
						task: taskMap.get(c.taskId),
						kind: c.kind,
						relation: c.relation,
						identity: c.identity,
						receipts: c.receipts,
					})),
					worktrees: coord.worktrees.map((w) => ({ observation: w.observation, clean: w.clean })),
					conflicts: coord.conflicts
						.map((cf) => ({
							kind: cf.kind,
							assignmentSlots: cf.assignmentIds.map((id) => assignMap.get(id)).sort(),
						}))
						.sort((a, b) => `${a.kind}:${a.assignmentSlots.join(",")}`.localeCompare(`${b.kind}:${b.assignmentSlots.join(",")}`)),
					reviews: coord.reviews.map((r) => ({
						candidateTask: taskMap.get(r.candidateTaskId),
						candidateRelation: r.candidateRelation,
						standing: r.standing,
						basis: r.basis,
						verdict: r.verdict,
						findingCounts: r.findingCounts,
					})),
				}
			: null,
		proposalEligibilityB: sortedTasks.map((t) => ({
			slot: taskMap.get(t.taskId),
			eligibleKinds: obs.modelViewB.proposalEligibility.find((e) => e.taskId === t.taskId)?.eligibleKinds ?? [],
		})),
		proposalEligibilityC: sortedTasks.map((t) => ({
			slot: taskMap.get(t.taskId),
			eligibleKinds: obs.modelViewC.proposalEligibility.find((e) => e.taskId === t.taskId)?.eligibleKinds ?? [],
		})),
	};
}

async function buildS6Fixture(label = "S6-W9-unplanned-pass") {
	const f = createBaseFixture(label);
	const t1 = mustOk(f.tasks.createTask(f.projectId, { title: "Assigned implementation task" }), "create T1");
	const t2 = mustOk(f.tasks.createTask(f.projectId, { title: "Review task with unplanned check" }), "create T2");
	const t1Moved = transitionTask(f.tasks, f.projectId, t1.value.id, t1.value.revision, [
		{ to: "in-progress", note: "active work" },
	]);
	transitionTask(f.tasks, f.projectId, t2.value.id, t2.value.revision, [
		{ to: "in-progress", note: "started" },
		{ to: "review", note: "ready for review" },
	]);
	await runHostVerificationCheck(f.storeRoot, f.projectId, t2.value.id, f.repo, {
		outcome: "passed",
		objective: "Verify T2 at current HEAD",
	});
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
		"createAssignment(S6 builder)",
	);
	return f;
}

const SCENARIOS = [
	{
		id: "S1-B1-partial",
		wake: "on-change",
		actionKind: "generate-advisory-brief",
		permitPartialObservation: true,
		async build() {
			const f = createBaseFixture("S1-B1-partial", { initEventsAndAttempts: false });
			mustOk(f.tasks.createTask(f.projectId, { title: "Initial open task on partial store" }), "create T1");
			return f;
		},
		assertObserved(obs) {
			if (obs.semantic.completeness !== "partial") throw new Error(`S1 expected partial, got ${obs.semantic.completeness}`);
			if (obs.modelViewC.sources.events.state === "ready") throw new Error("S1 expected non-ready events source");
			if (obs.modelViewC.sources.attempts.state === "ready") throw new Error("S1 expected non-ready attempts source");
			if (obs.modelViewC.project.tasks.length !== 1 || obs.modelViewC.project.tasks[0].phase !== "open")
				throw new Error("S1 expected 1 open task");
		},
	},
	{
		id: "S2-W0-unassigned",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		async build() {
			const f = createBaseFixture("S2-W0-unassigned");
			mustOk(f.tasks.createTask(f.projectId, { title: "Unassigned open task" }), "create T1");
			return f;
		},
		assertObserved(obs) {
			if (obs.semantic.completeness !== "complete") throw new Error(`S2 expected complete, got ${obs.semantic.completeness}`);
			if (obs.modelViewC.coordination?.sourceState !== "absent") throw new Error("S2 expected absent coordination");
			if (obs.modelViewC.proposalEligibility[0]?.eligibleKinds.length !== 0)
				throw new Error("S2 expected 0 eligible proposal kinds");
		},
	},
	{
		id: "S3-W3-blocked",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		async build() {
			const f = createBaseFixture("S3-W3-blocked");
			const t1 = mustOk(f.tasks.createTask(f.projectId, { title: "Blocked integration task" }), "create T1");
			transitionTask(f.tasks, f.projectId, t1.value.id, t1.value.revision, [
				{ to: "blocked", note: "waiting on upstream schema" },
			]);
			return f;
		},
		assertObserved(obs) {
			if (obs.modelViewC.project.tasks[0]?.phase !== "blocked") throw new Error("S3 expected blocked task");
			if (!obs.modelViewC.proposalEligibility[0]?.eligibleKinds.includes("resolve-blocked-task"))
				throw new Error("S3 expected resolve-blocked-task eligibility");
		},
	},
	{
		id: "S4-W6-review-fail",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		async build() {
			const f = createBaseFixture("S4-W6-review-fail");
			const t1 = mustOk(f.tasks.createTask(f.projectId, { title: "In-progress work without checks" }), "create T1");
			const t2 = mustOk(f.tasks.createTask(f.projectId, { title: "Review candidate with failing check" }), "create T2");
			transitionTask(f.tasks, f.projectId, t1.value.id, t1.value.revision, [{ to: "in-progress", note: "active" }]);
			transitionTask(f.tasks, f.projectId, t2.value.id, t2.value.revision, [
				{ to: "in-progress", note: "implemented" },
				{ to: "review", note: "ready for review" },
			]);
			await runHostVerificationCheck(f.storeRoot, f.projectId, t2.value.id, f.repo, {
				outcome: "failed",
				objective: "Run host check on T2 at HEAD",
			});
			return f;
		},
		assertObserved(obs) {
			const tasks = obs.modelViewC.project.tasks;
			const tFail = tasks.find((t) => t.verification.state === "failing");
			const tNoChecks = tasks.find((t) => t.verification.state === "no-checks");
			if (!tFail || tFail.phase !== "awaiting-review")
				throw new Error("S4 expected failing task in awaiting-review phase");
			if (!tNoChecks || tNoChecks.phase !== "in-progress")
				throw new Error("S4 expected in-progress no-checks sibling task");
			const elig = obs.modelViewC.proposalEligibility.find((e) => e.taskId === tFail.taskId);
			if (!elig?.eligibleKinds.includes("review-failing-verification"))
				throw new Error("S4 expected review-failing-verification eligibility");
		},
	},
	{
		id: "S5-W8-mixed-head",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
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
		id: "S6-W9-unplanned-pass",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		async build() {
			return buildS6Fixture("S6-W9-unplanned-pass");
		},
		assertObserved(obs) {
			const tasks = obs.modelViewC.project.tasks;
			const tNo = tasks.find((t) => t.verification.state === "no-checks" && !t.verification.incomplete);
			const tInc = tasks.find(
				(t) =>
					t.verification.state === "incomplete" &&
					t.verification.incomplete &&
					t.verification.results.some((r) => r.outcome === "passed" && r.relation === "at-head"),
			);
			if (!tNo || !tInc) throw new Error("S6 expected no-checks + unplanned at-HEAD passing incomplete task");
			if (obs.modelViewC.coordination?.assignments.length !== 1)
				throw new Error("S6 expected 1 active builder assignment");
		},
	},
	{
		id: "S7-W10-digest",
		wake: "digest-window",
		actionKind: "generate-advisory-brief",
		permitPartialObservation: false,
		seedPriorConsideredBriefing: true,
		async build() {
			return buildS6Fixture("S7-W10-digest");
		},
		assertObserved(obs) {
			SCENARIOS[5].assertObserved(obs);
		},
	},
	{
		id: "S8-multi-agent",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
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

			// Real registered sibling Git worktree for the reviewer.
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

			// Prior builder assignment on primary repo with an operator-declared session -> ending it produces a REAL liveness-unverified hazard!
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
				"endAssignment(S8 prior builder -> liveness-unverified)",
			);

			// New active builder assignment on the same primary repo (allowSharedWorktree: true creates a REAL conflict with the unverified hazard!).
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

			// Prepare an attempt on T1, link it to active builder, and declare a verified git-commit candidate C1 (no passing receipts yet).
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

			// Active reviewer assignment on T2 targeting candidate C1 in the registered sibling worktree.
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

			// Unsatisfied dependency: T2 requires T1 candidate to have a passing receipt.
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

			// Structured advisory review (changes-requested) bound to C1 and reviewer assignment.
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
				throw new Error(`S8 expected complete observation, got ${obs.semantic.completeness} (${obs.semantic.gaps.join(",")})`);
			const c = obs.modelViewC.coordination;
			if (!c || c.sourceState !== "ready") throw new Error("S8 expected ready coordination");
			if (!c.assignments.some((a) => a.hazard === "liveness-unverified"))
				throw new Error("S8 expected liveness-unverified hazard assignment");
			if (!c.assignments.some((a) => a.role === "builder" && a.state === "active" && a.session?.liveness === "unknown"))
				throw new Error("S8 expected active builder assignment with unknown session liveness");
			if (!c.assignments.some((a) => a.role === "reviewer" && a.state === "active" && a.targetCandidate !== null))
				throw new Error("S8 expected active reviewer assignment with targetCandidate");
			if (c.candidates.length !== 1 || c.candidates[0].relation !== "current")
				throw new Error("S8 expected 1 current git-commit candidate");
			if (c.dependencies.length !== 1 || c.dependencies[0].satisfaction !== "unsatisfied")
				throw new Error("S8 expected 1 unsatisfied dependency");
			if (c.worktrees.length !== 1) throw new Error("S8 expected 1 registered worktree in coordination projection");
			if (c.conflicts.length < 1) throw new Error("S8 expected >= 1 worktree conflict");
			if (c.reviews.length !== 1 || c.reviews[0].verdict !== "changes-requested")
				throw new Error("S8 expected 1 changes-requested advisory review");
			const t1Elig = obs.modelViewC.proposalEligibility.find((e) =>
				e.eligibleKinds.includes("investigate-liveness-hazard"),
			);
			if (!t1Elig || !t1Elig.eligibleKinds.includes("consider-attempt-for-assignment"))
				throw new Error("S8 expected investigate-liveness-hazard + consider-attempt-for-assignment eligibility in C");
			const bHasCoordProp = obs.modelViewB.proposalEligibility.some(
				(e) =>
					e.eligibleKinds.includes("investigate-liveness-hazard") ||
					e.eligibleKinds.includes("consider-attempt-for-assignment"),
			);
			if (bHasCoordProp) throw new Error("S8 Condition B must not expose coordination-only proposal eligibility");
		},
	},
];

/** Configure schedule + authorization and (for S7) run one zero-inference synthetic prior-briefing seed tick. */
async function prepareSchedule(fixture, scenario, condition, pool, nowStart) {
	const scheduleId = `stage2-${scenario.id}-${condition.id}`.toLowerCase();
	const isSeededDigest = scenario.seedPriorConsideredBriefing === true;
	const seedAtMs = nowStart - 60_000;
	const liveAtMs = nowStart;

	mustOk(
		addEndoAdvisoryScheduleV0(
			fixture.storeRoot,
			{
				scheduleId,
				projectId: fixture.projectId,
				actionKind: scenario.actionKind,
				wake: scenario.wake,
				missedRunPolicy: "skip-and-report",
				label: `${scenario.id}:${condition.id}`,
				trigger: isSeededDigest
					? { kind: "interval", everyMs: 60_000, anchorMs: seedAtMs }
					: { kind: "once", atMs: liveAtMs - 1000 },
			},
			() => nowStart - 120_000,
		),
		`addSchedule(${scheduleId})`,
	);
	mustOk(
		setEndoAdvisoryScheduleEnabledV0(fixture.storeRoot, scheduleId, true, 1, () => nowStart - 110_000),
		`enableSchedule(${scheduleId})`,
	);
	mustOk(
		authorizeEndoAdvisoryScheduleV0(
			fixture.storeRoot,
			{
				scheduleId,
				scheduleRevision: 2,
				pool,
				policy: {
					permitCapacityUnknown: true,
					permitModelUnconfirmed: true,
					permitPartialObservation: scenario.permitPartialObservation,
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 600_000,
				},
				budget: {
					periodMs: 3_600_000,
					maxTurnsPerPeriod: isSeededDigest ? 2 : 1,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 2048,
					maxGeneratedTokensPerPeriod: isSeededDigest ? 8192 : 4096,
					maxTurnWallClockMs: ADVISORY_TURN_WALL_CLOCK_MS,
				},
				lifetimeMs: 3_600_000,
			},
			() => nowStart - 100_000,
		),
		`authorizeSchedule(${scheduleId})`,
	);

	let priorSeed = null;
	if (isSeededDigest) {
		// Deterministic zero-inference seed tick at T-60s so S7 fires on an ALREADY-CONSIDERED unchanged state!
		const seedTick = mustOk(
			await runEndoAdvisoryTickV0({
				root: fixture.storeRoot,
				now: () => seedAtMs + 1000,
				briefingMode: condition.briefingMode,
				visibilityMode: condition.visibilityMode,
				observeMember: async (m) => ({
					memberId: m.memberId,
					endpoint: m.endpoint,
					modelId: m.modelId,
					basis: "controller-observed",
					observedAtMs: seedAtMs + 1000,
					elapsedMs: 1,
					readiness: "model-unconfirmed",
					detail: "router-model-state-not-observed",
					backend: "llama.cpp-router",
					build: "b12622-19bc41dbb",
					requests: [{ path: "/health", status: 200 }],
					inferenceTokens: 0,
				}),
				preflight: () => ({ ok: true }),
				run: async (root, req, opts) => {
					const pinned = mustOk(pinnedCoordinatorBriefStatusV0(root, req.projectId, opts.pinnedObservation), "seed pinned");
					const mvSha =
						condition.briefingMode === "grounded-v1"
							? endoCoordinatorModelViewSha256V1(
									buildEndoCoordinatorModelViewV1({
										projectId: req.projectId,
										statusView: pinned.view,
										coordination: pinned.coordination,
										visibilityMode: condition.visibilityMode,
									}),
								)
							: pinned.evidence.modelViewSha256;
					const evidence = {
						readAtMs: pinned.evidence.readAtMs,
						projectionSha256: pinned.evidence.projectionSha256,
						modelViewSha256: mvSha,
					};
					opts.trial?.({
						promptSha256: "0".repeat(64),
						inference: { temperature: 0, top_k: 1, top_p: 1, min_p: 0, seed: 101, max_tokens: 2048 },
						wire: {
							toolDefinitions: [],
							statusDelivered: true,
							statusMessage: null,
							inference: [],
							responses: [
								{ finish: "stop", usage: { prompt_tokens: 0, completion_tokens: 0 }, text: "synthetic-seed", toolCalled: false },
							],
							refusal: null,
						},
						dispatched: true,
						toolOutcome: null,
						evidence,
						latencyMs: 1,
						inferenceElapsedMs: 1,
						admittedExchanges: 0,
						recorderClean: true,
						stderr: "",
					});
					return {
						schemaVersion: "endo.coordinator-brief.v0",
						projectId: req.projectId,
						runtime: { harness: "synthetic-zero-inference-seed", provider: "synthetic", model: MODEL_ID },
						availability: "available",
						answer: "Synthetic pre-experiment seed briefing (0 live tokens) establishing unchanged cursor state.",
						evidence,
						toolSurface: [ENDO_COORDINATOR_TOOL_V0],
					};
				},
			}),
			`seedPriorBriefing(${scheduleId})`,
		);
		const adv = new DevelopAdvisoryStoreV0(fixture.storeRoot);
		const scheds = mustOk(adv.readSchedules(), "readSchedules after S7 seed");
		const sched = scheds.value.schedules.find((s) => s.scheduleId === scheduleId);
		const obs = await observeFixture(fixture.storeRoot, fixture.projectId);
		if (!sched || sched.cursor.lastConsideredSemanticDigest !== obs.semantic.semanticDigest) {
			throw new Error("S7 seed failed to establish lastConsideredSemanticDigest === current semanticDigest");
		}
		// Prove mechanically that an on-change wake WOULD skip this unchanged state, while digest-window admits it!
		const onChangeCheck = endoAdvisoryWakeDecisionV0({
			wake: "on-change",
			cursor: sched.cursor,
			observation: obs.semantic,
			permitPartialObservation: false,
		});
		const digestCheck = endoAdvisoryWakeDecisionV0({
			wake: "digest-window",
			cursor: sched.cursor,
			observation: obs.semantic,
			permitPartialObservation: false,
		});
		if (onChangeCheck.admit !== false || onChangeCheck.status !== "skipped-unchanged") {
			throw new Error(`S7 on-change control check failed: ${JSON.stringify(onChangeCheck)}`);
		}
		if (digestCheck.admit !== true || digestCheck.reason !== "digest-window") {
			throw new Error(`S7 digest-window admission check failed: ${JSON.stringify(digestCheck)}`);
		}
		priorSeed = {
			seedTurnId: seedTick.turnId,
			lastConsideredSemanticDigest: sched.cursor.lastConsideredSemanticDigest,
			onChangeWouldBe: onChangeCheck.status,
			digestAdmitsReason: digestCheck.reason,
		};
	}
	return { scheduleId, priorSeed };
}

/** Deterministic fake provider for --dry-run (strictly local ephemeral port, ZERO contact with 127.0.0.1:8091). */
async function startFakeProvider() {
	let requestCount = 0;
	const server = createServer(async (req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}
		if (req.url === "/props") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ role: "router", build_info: "b12622-19bc41dbb" }));
			return;
		}
		if (req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: MODEL_ID }] }));
			return;
		}
		const chunks = [];
		for await (const ch of req) chunks.push(ch);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requestCount += 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const sse = (delta, finish) =>
			`${[
				{ choices: [{ index: 0, delta, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: finish }] },
				{ choices: [], usage: { prompt_tokens: 180, completion_tokens: 95, total_tokens: 275 } },
			]
				.map(
					(v) =>
						`data: ${JSON.stringify({ id: `dry-${requestCount}`, object: "chat.completion.chunk", model: MODEL_ID, ...v })}\n\n`,
				)
				.join("")}data: [DONE]\n\n`;

		const toolMsg = (body.messages ?? []).find((m) => m.role === "tool");
		if (!toolMsg) {
			res.end(
				sse(
					{
						tool_calls: [
							{
								index: 0,
								id: `call_${requestCount}`,
								type: "function",
								function: { name: ENDO_COORDINATOR_TOOL_V0, arguments: "{}" },
							},
						],
					},
					"tool_calls",
				),
			);
			return;
		}

		const userText = (body.messages ?? [])
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""))
			.join("\n");
		const wantsProposal = userText.includes("PROPOSAL:") || userText.includes("proposalEligibility");
		const parsedTool = JSON.parse(toolMsg.content);
		const status = parsedTool.status;

		// Condition A (legacy-v0): emits accurate natural prose matching S2-LIVE-001 style
		if (status.schemaVersion !== "endo.coordinator-model-view.v1") {
			const proj = status.projects[0];
			const lines = [];
			if (status.sources.events.state !== "ready") {
				lines.push("Event and attempt sources are not initialized; session activity is unknown.");
			}
			for (const t of proj.tasks) {
				if (t.verification.state === "no-checks") {
					lines.push(`Task ${t.taskId} (${t.phase}): no check is recorded for this task.`);
				} else if (t.verification.state === "failing") {
					lines.push(`Task ${t.taskId} (${t.phase}): current-HEAD verification check failed.`);
				} else if (t.verification.state === "not-current") {
					lines.push(`Task ${t.taskId} (${t.phase}): earlier check is not current at HEAD.`);
				} else if (t.verification.state === "incomplete") {
					lines.push(`Task ${t.taskId} (${t.phase}): unplanned check passed at HEAD, verification remains incomplete.`);
				} else {
					lines.push(`Task ${t.taskId} (${t.phase}): verification state is ${t.verification.state}.`);
				}
			}
			if (wantsProposal) {
				const failTask = proj.tasks.find((t) => t.verification.state === "failing");
				const blockedTask = proj.tasks.find((t) => t.phase === "blocked");
				const reviewTask = proj.tasks.find((t) => t.phase === "awaiting-review");
				if (failTask) lines.push(`PROPOSAL: review-failing-verification ${failTask.taskId}`);
				else if (blockedTask) lines.push(`PROPOSAL: resolve-blocked-task ${blockedTask.taskId}`);
				else if (reviewTask) lines.push(`PROPOSAL: review-awaiting-review ${reviewTask.taskId}`);
				else lines.push("PROPOSAL: none");
			}
			res.end(sse({ content: lines.join("\n") }, "stop"));
			return;
		}

		// Conditions B & C (grounded-v1): build strictly grounded endo.coordinator-grounded-brief.v1 JSON from modelView alone
		const claims = [
			{
				subjectKind: "project",
				subjectId: status.projectId,
				predicate: "head-state",
				value: status.project.head,
				evidenceRef: "ev:project",
			},
		];
		const uncertainties = [];
		const recommendations = [];

		if (status.sources.events.state !== "ready" || status.sources.attempts.state !== "ready") {
			claims.push({
				subjectKind: "sources",
				subjectId: status.projectId,
				predicate: "session-activity",
				value: "unknown-source-unavailable",
				evidenceRef: "ev:sources",
			});
			if (status.sources.events.state !== "ready") {
				uncertainties.push({
					subjectKind: "sources",
					subjectId: status.projectId,
					code: "event-source-unavailable",
					evidenceRef: "ev:sources",
				});
			}
			recommendations.push({
				kind: "inspect-missing-sources",
				subjectKind: "sources",
				subjectId: status.projectId,
				supportingRefs: ["ev:sources"],
				priority: "medium",
				rationaleCode: "store-sources-incomplete",
			});
		}

		for (const t of status.project.tasks) {
			claims.push({
				subjectKind: "task",
				subjectId: t.taskId,
				predicate: "task-phase",
				value: t.phase,
				evidenceRef: t.evidenceRef,
			});
			if (t.verification.state === "no-checks" && !t.verification.incomplete) {
				claims.push({
					subjectKind: "task",
					subjectId: t.taskId,
					predicate: "current-head-check",
					value: "none-recorded",
					evidenceRef: t.evidenceRef,
				});
			} else if (t.verification.state === "failing") {
				claims.push({
					subjectKind: "task",
					subjectId: t.taskId,
					predicate: "current-head-check",
					value: "failing",
					evidenceRef: t.evidenceRef,
				});
				recommendations.push({
					kind: "review-failing-verification",
					subjectKind: "task",
					subjectId: t.taskId,
					supportingRefs: [t.evidenceRef],
					priority: "high",
					rationaleCode: t.phase === "awaiting-review" ? "review-contradicts-failing-check" : "failing-check-at-head",
				});
			} else if (t.verification.state === "not-current") {
				claims.push({
					subjectKind: "task",
					subjectId: t.taskId,
					predicate: "verification-state",
					value: "not-current",
					evidenceRef: t.evidenceRef,
				});
				uncertainties.push({
					subjectKind: "task",
					subjectId: t.taskId,
					code: "verification-not-current",
					evidenceRef: t.evidenceRef,
				});
				recommendations.push({
					kind: "investigate-incomplete-verification",
					subjectKind: "task",
					subjectId: t.taskId,
					supportingRefs: [t.evidenceRef],
					priority: "high",
					rationaleCode: t.gaps.includes("earlier-failure-not-current")
						? "historical-failure-not-current"
						: "verification-not-current-or-incomplete",
				});
			} else if (
				t.verification.state === "incomplete" &&
				t.verification.results.some((r) => r.outcome === "passed" && r.relation === "at-head")
			) {
				claims.push({
					subjectKind: "task",
					subjectId: t.taskId,
					predicate: "current-head-check",
					value: "passing-incomplete",
					evidenceRef: t.evidenceRef,
				});
				uncertainties.push({
					subjectKind: "task",
					subjectId: t.taskId,
					code: "verification-incomplete",
					evidenceRef: t.evidenceRef,
				});
			} else if (t.phase === "blocked") {
				recommendations.push({
					kind: "resolve-blocked-task",
					subjectKind: "task",
					subjectId: t.taskId,
					supportingRefs: [t.evidenceRef],
					priority: "high",
					rationaleCode: "task-blocked",
				});
			}
		}

		// Condition C coordination claims & recommendations
		if (status.coordination !== null) {
			claims.push({
				subjectKind: "coordination",
				subjectId: status.projectId,
				predicate: "coordination-source",
				value: status.coordination.sourceState,
				evidenceRef: "ev:coordination",
			});
			const hazardAssign = status.coordination.assignments.find((a) => a.hazard === "liveness-unverified");
			if (hazardAssign) {
				claims.push({
					subjectKind: "assignment",
					subjectId: hazardAssign.assignmentId,
					predicate: "assignment-hazard",
					value: "liveness-unverified",
					evidenceRef: hazardAssign.evidenceRef,
				});
				uncertainties.push({
					subjectKind: "assignment",
					subjectId: hazardAssign.assignmentId,
					code: "termination-unconfirmed",
					evidenceRef: hazardAssign.evidenceRef,
				});
				recommendations.push({
					kind: "investigate-liveness-hazard",
					subjectKind: "assignment",
					subjectId: hazardAssign.assignmentId,
					supportingRefs: [hazardAssign.evidenceRef],
					priority: "high",
					rationaleCode: "liveness-hazard-unverified",
				});
			}
			const unsatDep = status.coordination.dependencies.find((d) => d.satisfaction === "unsatisfied");
			if (unsatDep && claims.length < 15) {
				claims.push({
					subjectKind: "dependency",
					subjectId: unsatDep.dependencyId,
					predicate: "dependency-satisfaction",
					value: "unsatisfied",
					evidenceRef: unsatDep.evidenceRef,
				});
			}
			const rev = status.coordination.reviews[0];
			if (rev && claims.length < 15) {
				claims.push({
					subjectKind: "review",
					subjectId: rev.reviewId,
					predicate: "review-verdict",
					value: rev.verdict,
					evidenceRef: rev.evidenceRef,
				});
				uncertainties.push({
					subjectKind: "review",
					subjectId: rev.reviewId,
					code: "advisory-review-not-host-check",
					evidenceRef: rev.evidenceRef,
				});
			}
		}

		let proposal = null;
		if (wantsProposal) {
			const priorityOrder = [
				"review-failing-verification",
				"investigate-liveness-hazard",
				"resolve-blocked-task",
				"investigate-incomplete-verification",
				"review-awaiting-review",
				"consider-attempt-for-assignment",
			];
			for (const kind of priorityOrder) {
				const found = status.proposalEligibility.find((e) => e.eligibleKinds.includes(kind));
				if (found) {
					proposal = { kind, taskId: found.taskId, evidenceRef: `ev:task:${found.taskId}` };
					break;
				}
			}
		}

		const reply = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: claims.slice(0, 16),
			uncertainties: uncertainties.slice(0, 10),
			recommendations: recommendations.slice(0, 4),
			proposal,
		});
		res.end(sse({ content: reply }, "stop"));
	});
	await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const port = server.address().port;
	return {
		endpoint: `http://127.0.0.1:${port}`,
		close: () => new Promise((r) => server.close(() => r())),
	};
}

/** Append one JSONL record durably with fsyncSync — NEVER overwrites or truncates earlier records. */
function appendJsonlDurable(path, record) {
	const line = `${JSON.stringify(record)}\n`;
	const fd = openSync(path, "a", 0o600);
	try {
		appendFileSync(fd, line, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function readExistingJsonl(path) {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length === 0) return [];
	return raw.split("\n").map((line, i) => {
		try {
			return JSON.parse(line);
		} catch (err) {
			throw new Error(`Existing ledger ${path} line ${i + 1} is corrupt: ${err.message}`);
		}
	});
}

async function runPreflight() {
	const manifest = {
		recordedAtUtc: new Date().toISOString(),
		liveInferenceExecuted: false,
		poolMemberTimeoutMs: POOL_MEMBER_TIMEOUT_MS,
		advisoryTurnWallClockMs: ADVISORY_TURN_WALL_CLOCK_MS,
		aggregateLiveTurnCeiling: AGGREGATE_LIVE_TURN_CEILING,
		scenarios: [],
	};
	const dummyPool = makePool(LIVE_ENDPOINT);

	for (const scenario of SCENARIOS) {
		const perCondition = {};
		const normalizedByCond = {};
		for (const cond of CONDITIONS) {
			const fixture = await scenario.build();
			try {
				const obs = await observeFixture(fixture.storeRoot, fixture.projectId);
				scenario.assertObserved(obs);
				const { priorSeed } = await prepareSchedule(fixture, scenario, cond, dummyPool, Date.now());
				const norm = normalizeObservedStructure(obs);
				normalizedByCond[cond.id] = norm;
				perCondition[cond.id] = {
					briefingMode: cond.briefingMode,
					visibilityMode: cond.visibilityMode,
					modelViewBytes:
						cond.briefingMode === "legacy-v0"
							? Buffer.byteLength(JSON.stringify({ availability: "available", status: obs.pinned.view }), "utf8")
							: Buffer.byteLength(
									JSON.stringify({
										availability: "available",
										status: cond.visibilityMode === "status-v0" ? obs.modelViewB : obs.modelViewC,
									}),
									"utf8",
								),
					priorSeed,
				};
			} finally {
				rmSync(fixture.base, { recursive: true, force: true });
			}
		}
		// Verify exact structural semantic equivalence across Conditions A, B, and C!
		const refJson = JSON.stringify(normalizedByCond.A);
		if (JSON.stringify(normalizedByCond.B) !== refJson || JSON.stringify(normalizedByCond.C) !== refJson) {
			throw new Error(`Semantic equivalence mismatch across A/B/C in scenario ${scenario.id}`);
		}
		manifest.scenarios.push({
			scenarioId: scenario.id,
			wake: scenario.wake,
			actionKind: scenario.actionKind,
			permitPartialObservation: scenario.permitPartialObservation,
			abcSemanticallyEquivalent: true,
			observedState: normalizedByCond.A,
			conditions: perCondition,
		});
	}

	const outPath = join(OUT_DIR, "stage2-preflight-manifest.json");
	writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

async function runSingleTurn(scenario, condition, pool, { mode }) {
	const fixture = await scenario.build();
	const nowStart = Date.now();
	try {
		const obs = await observeFixture(fixture.storeRoot, fixture.projectId);
		scenario.assertObserved(obs);
		const { scheduleId, priorSeed } = await prepareSchedule(fixture, scenario, condition, pool, nowStart);
		const t0 = performance.now();
		const tick = await runEndoAdvisoryTickV0({
			root: fixture.storeRoot,
			now: () => nowStart + 1000,
			briefingMode: condition.briefingMode,
			visibilityMode: condition.visibilityMode,
		});
		const elapsedMs = Math.round(performance.now() - t0);
		const advStore = new DevelopAdvisoryStoreV0(fixture.storeRoot);
		const turns = mustOk(advStore.listTurns(Date.now()), "listTurns");
		const proposals = mustOk(advStore.listProposals(), "listProposals");
		const measuredTurn =
			turns.entries.find((e) => e.admission.turnId === (tick.ok ? tick.turnId : null)) ??
			turns.entries.at(-1) ??
			null;
		return {
			recordedAtUtc: new Date().toISOString(),
			mode,
			scenarioId: scenario.id,
			conditionId: condition.id,
			scheduleId,
			briefingMode: condition.briefingMode,
			visibilityMode: condition.visibilityMode,
			elapsedMs,
			priorSeed,
			observedState: normalizeObservedStructure(obs),
			tick,
			turn: measuredTurn,
			proposals: proposals.entries,
		};
	} finally {
		rmSync(fixture.base, { recursive: true, force: true });
	}
}

async function runDryRun() {
	console.error("Step 1/2: Running zero-inference preflight & A/B/C semantic equivalence checks...");
	const manifest = await runPreflight();
	console.error(`Preflight PASS: ${manifest.scenarios.length}/8 scenarios verified equivalent across A/B/C.`);

	console.error("Step 2/2: Starting local ephemeral fake provider (ZERO contact with 127.0.0.1:8091)...");
	const fake = await startFakeProvider();
	const pool = makePool(fake.endpoint);
	const outPath = join(OUT_DIR, "stage2-dry-run.jsonl");
	rmSync(outPath, { force: true });

	const summary = [];
	let completed = 0;
	try {
		for (let idx = 0; idx < SCENARIOS.length; idx++) {
			const scenario = SCENARIOS[idx];
			const order = ROTATIONS[idx % ROTATIONS.length];
			for (const condId of order) {
				const cond = CONDITIONS.find((c) => c.id === condId);
				completed += 1;
				console.error(`[dry-run ${completed}/24] ${scenario.id} | Condition ${cond.id} (${cond.briefingMode}/${cond.visibilityMode})...`);
				const rec = await runSingleTurn(scenario, cond, pool, { mode: "dry-run-fake-provider" });
				appendJsonlDurable(outPath, rec);
				summary.push({
					scenarioId: rec.scenarioId,
					conditionId: rec.conditionId,
					tickOk: rec.tick.ok,
					outcomeStatus: rec.tick.ok ? rec.tick.outcomes[0]?.status : rec.tick.refusal,
					availability: rec.turn?.briefing?.availability ?? null,
					refusal: rec.turn?.briefing?.refusal ?? null,
					proposalOutcome: rec.turn?.briefing?.proposal?.outcome ?? null,
					proposalKind: rec.proposals[0]?.proposal.kind ?? null,
					elapsedMs: rec.elapsedMs,
					harness: rec.turn?.briefing?.model.harness ?? null,
				});
			}
		}
	} finally {
		await fake.close();
	}

	// Verify key comparative mechanics observed during dry run:
	// 1. Every dry-run turn ran real OpenClaw 2026.11.10 through bubblewrap & relay
	for (const s of summary) {
		if (!s.tickOk) throw new Error(`Dry-run tick failed on ${s.scenarioId}/${s.conditionId}`);
		if (s.harness !== "OpenClaw 2026.11.10")
			throw new Error(`Expected OpenClaw 2026.11.10 on ${s.scenarioId}/${s.conditionId}, got ${s.harness}`);
	}
	// 2. Condition A STILL exhibits legacy W8/W9/W10 receipt-absence-unestablished collision while B & C publish cleanly!
	for (const collId of ["S5-W8-mixed-head", "S6-W9-unplanned-pass", "S7-W10-digest"]) {
		const a = summary.find((s) => s.scenarioId === collId && s.conditionId === "A");
		const b = summary.find((s) => s.scenarioId === collId && s.conditionId === "B");
		const c = summary.find((s) => s.scenarioId === collId && s.conditionId === "C");
		if (a?.refusal !== "receipt-absence-unestablished")
			throw new Error(`Expected Condition A legacy collision on ${collId}, got ${JSON.stringify(a)}`);
		if (b?.availability !== "available" || c?.availability !== "available")
			throw new Error(`Expected Conditions B & C available on ${collId}, got B=${b?.availability} C=${c?.availability}`);
	}
	// 3. S8 Condition C creates investigate-liveness-hazard proposal whereas Condition B cannot
	const s8B = summary.find((s) => s.scenarioId === "S8-multi-agent" && s.conditionId === "B");
	const s8C = summary.find((s) => s.scenarioId === "S8-multi-agent" && s.conditionId === "C");
	if (s8C?.proposalKind !== "investigate-liveness-hazard")
		throw new Error(`Expected S8 Condition C investigate-liveness-hazard proposal, got ${JSON.stringify(s8C)}`);
	if (s8B?.proposalKind === "investigate-liveness-hazard")
		throw new Error("S8 Condition B must not ground coordination-only liveness-hazard proposal");

	console.log(JSON.stringify({ dryRunPassed: true, totalCells: summary.length, summary }, null, 2));
}

async function runLive() {
	const outPath = join(OUT_DIR, "stage2-paired-live.jsonl");
	const existing = readExistingJsonl(outPath);
	// Count BOTH completed results and pre-dispatch intents conservatively so even SIGKILL mid-turn cannot cause >24 live turns on restart.
	const attemptedKeys = new Set(existing.map((r) => `${r.scenarioId}:${r.conditionId}`));
	const intentRows = existing.filter((r) => r.recordType === "turn-intent");
	const legacyResultRows = existing.filter(
		(r) => r.recordType === undefined && (r.tick?.inferenceDispatched === true || r.turn?.dispatch !== null),
	);
	let aggregateReserved = intentRows.length + legacyResultRows.length;

	if (aggregateReserved >= AGGREGATE_LIVE_TURN_CEILING) {
		throw new Error(
			`REFUSED: Aggregate live ceiling of ${AGGREGATE_LIVE_TURN_CEILING} reserved/dispatched turns already reached in ${outPath}.`,
		);
	}

	let interrupted = false;
	const onSignal = (sig) => {
		console.error(`Received ${sig}; preserving ${attemptedKeys.size} recorded cells and halting before next turn.`);
		interrupted = true;
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const pool = makePool(LIVE_ENDPOINT);
	try {
		for (let idx = 0; idx < SCENARIOS.length; idx++) {
			const scenario = SCENARIOS[idx];
			const order = ROTATIONS[idx % ROTATIONS.length];
			for (const condId of order) {
				if (interrupted) {
					console.error("Halted cleanly due to signal; earlier evidence preserved intact.");
					process.exit(130);
				}
				const key = `${scenario.id}:${condId}`;
				if (attemptedKeys.has(key)) {
					console.error(`[skip already recorded/attempted] ${key}`);
					continue;
				}
				if (aggregateReserved >= AGGREGATE_LIVE_TURN_CEILING) {
					throw new Error(`Hard aggregate ceiling (${AGGREGATE_LIVE_TURN_CEILING} live turns) reached.`);
				}
				const cond = CONDITIONS.find((c) => c.id === condId);
				// Durable pre-dispatch intent record (fsynced BEFORE any live turn runs) prevents restart over-dispatch even under SIGKILL.
				appendJsonlDurable(outPath, {
					recordType: "turn-intent",
					recordedAtUtc: new Date().toISOString(),
					scenarioId: scenario.id,
					conditionId: cond.id,
					briefingMode: cond.briefingMode,
					visibilityMode: cond.visibilityMode,
					aggregateTurnNumber: aggregateReserved + 1,
				});
				aggregateReserved += 1;
				attemptedKeys.add(key);
				console.error(
					`[live ${aggregateReserved}/${AGGREGATE_LIVE_TURN_CEILING}] ${scenario.id} | Condition ${cond.id} (${cond.briefingMode}/${cond.visibilityMode})...`,
				);
				const rec = await runSingleTurn(scenario, cond, pool, { mode: "live-stage2" });
				appendJsonlDurable(outPath, { recordType: "turn-result", ...rec });
			}
		}
		console.error(
			`Stage 2 live complete: ${attemptedKeys.size}/24 cells recorded (${aggregateReserved} reserved turns) in ${outPath}.`,
		);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

async function main() {
	const flags = new Set(process.argv.slice(2));
	const modes = ["--preflight", "--dry-run", "--authorize-live-stage2"].filter((f) => flags.has(f));
	if (modes.length !== 1) {
		console.error(
			"REFUSED: Specify exactly one mode:\n" +
				"  --preflight              (zero-inference fixture & A/B/C semantic equivalence verification)\n" +
				"  --dry-run                (zero-live-inference 24-cell end-to-end run against ephemeral fake provider)\n" +
				"  --authorize-live-stage2  (live Stage 2 run; ONLY after explicit operator authorization)",
		);
		process.exit(2);
	}
	if (modes[0] === "--preflight") {
		const manifest = await runPreflight();
		console.log(JSON.stringify({ preflightPassed: true, scenarios: manifest.scenarios.length }, null, 2));
		return;
	}
	if (modes[0] === "--dry-run") {
		await runDryRun();
		return;
	}
	await runLive();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
