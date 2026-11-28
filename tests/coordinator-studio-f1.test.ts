// COORDINATOR-STUDIO-F1-002: Deterministic Coordinator Studio F1 verification suite.
//
// Covers:
// - Host route security: GET /api/v0/workbench/workspace/coordinator/operations refuses unpaired (401),
//   query parameters / foreign project selectors (400), non-GET (403/405), and mid-read revoked grants (401),
//   with zero store mutations.
// - Strict cross-project disclosure boundary: Project B's schedules, fires, briefings, proposals, titles,
//   and counts NEVER leak into Project A's operations response (including aggregate counts or error messages).
// - Zero-inference / zero-model-wake guarantee: an active loopback sentinel server referenced in S1 resources
//   receives ZERO HTTP requests when Studio reads operations.
// - Deterministic Attention Engine (`buildDeterministicAttention`): explicit rule-ranked tiers across hazards,
//   blockers, verification gaps, and operational/resource degradation with observed/consequence/uncertainty separation.
// - Strictly read-only SSR rendering of Attention, Resources, Schedules, and Advisory views with zero forms,
//   zero inline styles, zero proposal acceptance or schedule execution controls, and explicit epistemic caveats.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../adapters/develop/advisory-tick.ts";
import { DevelopCoordinationGitV0 } from "../adapters/develop/coordination.ts";
import { EndoCockpitCoordinatorV0 } from "../cockpit-http/coordinator.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import { validateEndoCoordinatorCoordinationV0 } from "../protocol/coordinator-coordination.ts";
import { parseEndoCoordinatorModelPoolV0 } from "../protocol/coordinator-model-pool.ts";
import { validateEndoCoordinatorStatusV0 } from "../protocol/coordinator-status.ts";
import { validateEndoCoordinatorStudioOperationsV0 } from "../protocol/coordinator-studio-operations.ts";
import { ENDO_ADVISORY_LIMITS_V0 } from "../protocol/develop-advisory.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
} from "../protocol/develop-automation.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { evaluateEndoScheduleDueV0 } from "../runtime/contracts/develop-automation.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { readEndoCoordinatorStudioOperationsV0 } from "../storage/coordinator-studio-operations.ts";
import { DevelopAdvisoryStoreV0 } from "../storage/develop-advisory.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopAutomationStoreV0 } from "../storage/develop-automation.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopCoordinationReviewsStoreV0 } from "../storage/develop-coordination-reviews.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { buildDeterministicAttention } from "../studio-ui/src/coordinator/attention.ts";
import { readCoordinatorOperations } from "../studio-ui/src/coordinator/read.ts";
import { capabilityOf, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { fixtureManifestV0 } from "./coordinator-brief-fixtures.ts";
import { buildCoordinatorStoreV0, cleanCoordinatorFixturesV0 } from "./coordinator-status-fixture.ts";
import { git, haveGit } from "./git-fixtures.ts";

const dirs: string[] = [];
const scratch = (prefix = "endo-f1-studio-") => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};

afterEach(async () => {
	vi.restoreAllMocks();
	await stopServers();
	cleanCoordinatorFixturesV0();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!haveGit)("COORDINATOR-STUDIO-F1-002: deterministic Studio F1 host, attention, and views", () => {
	async function buildRichMultiProjectFixture(sentinelPort: number) {
		const { root, repo, projectId, taskId } = await buildCoordinatorStoreV0();
		const tasks = new DevelopTasksStoreV0(root);
		const nowMs = Date.now();
		const now = () => nowMs;

		// Add tasks on Project A (blocked, awaiting-review, dependent)
		const tReview = tasks.createTask(projectId, { title: "Verify auth token refresh" });
		if (!tReview.ok) throw new Error(tReview.code);
		const tRevInProg = tasks.setStatus(projectId, tReview.value.id, 0, "in-progress", null);
		if (!tRevInProg.ok) throw new Error(tRevInProg.code);
		const tRevReview = tasks.setStatus(projectId, tReview.value.id, tRevInProg.value.revision, "review", null);
		if (!tRevReview.ok) throw new Error(tRevReview.code);

		const tBlocked = tasks.createTask(projectId, { title: "Migrate session schema" });
		if (!tBlocked.ok) throw new Error(tBlocked.code);
		const tBlk = tasks.setStatus(projectId, tBlocked.value.id, 0, "blocked", null);
		if (!tBlk.ok) throw new Error(tBlk.code);

		// Register a second unrelated Project B with secret marker strings to verify zero cross-project disclosure!
		const repoB = join(scratch("endo-f1-repo-b-"), "secret-proj-b");
		mkdirSync(repoB);
		const projB = tasks.registerProject({ name: "SECRET_PROJECT_B_NAME", path: repoB, observedGitRoot: repoB });
		if (!projB.ok) throw new Error(projB.code);
		const taskB = tasks.createTask(projB.value.id, { title: "SECRET_PROJECT_B_TASK" });
		if (!taskB.ok) throw new Error(taskB.code);

		// Coordination on Project A: builder + reviewer assignments, dependency, candidate, changes-requested review, worktree overlap
		const sibling = join(scratch("endo-f1-sibling-"), "wt-review");
		git(repo, "worktree", "add", "-q", "-b", "f1-review", sibling);
		const headSha = git(repo, "rev-parse", "HEAD").trim();
		const treeSha = git(repo, "rev-parse", "HEAD^{tree}").trim();
		const tasksRead = tasks.read();
		if (!tasksRead.ok) throw new Error(tasksRead.reason);
		const projA = tasksRead.file.projects.find((p) => p.id === projectId)!;
		const validated = await new DevelopCoordinationGitV0().validateSiblingWorktree(projA, sibling);
		if (!validated.ok) throw new Error(validated.detail);

		const coord = new DevelopCoordinationStoreV0(root);
		const reg = coord.registerWorktree({
			expectedFileRevision: 0,
			projectId,
			worktreePath: validated.worktree.worktreePath,
			commonDir: validated.worktree.commonDir,
			gitDir: validated.worktree.gitDir,
			label: "pi-review-wt",
		});
		if (!reg.ok) throw new Error(reg.code);

		const aBuilder = coord.createAssignment({
			expectedFileRevision: reg.file.revision,
			expectedTaskRevision: tasksRead.file.tasks.find((t) => t.id === taskId)!.revision,
			projectId,
			taskId,
			participant: { participantId: "codex-builder", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		if (!aBuilder.ok) throw new Error(aBuilder.code);

		// Second overlapping rw assignment on primary repo (explicitly acknowledged) -> triggers shared-writable-worktree conflict!
		const aOverlap = coord.createAssignment({
			expectedFileRevision: aBuilder.file.revision,
			expectedTaskRevision: tRevReview.value.revision,
			projectId,
			taskId: tReview.value.id,
			participant: { participantId: "pi-builder-2", role: "builder", intendedHarnessFamily: "pi" },
			workspace: {
				worktreePath: repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: true,
			},
			targetCandidate: null,
		});
		if (!aOverlap.ok) throw new Error(aOverlap.code);

		// Associate a session on aBuilder and revoke an earlier helper assignment to produce a real `liveness-unverified` hazard!
		const aEnded = coord.createAssignment({
			expectedFileRevision: aOverlap.file.revision,
			expectedTaskRevision: tBlk.value.revision,
			projectId,
			taskId: tBlocked.value.id,
			participant: { participantId: "codex-helper-ended", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: true,
			},
			targetCandidate: null,
		});
		if (!aEnded.ok) throw new Error(aEnded.code);
		const aEndedSess = coord.associateSession(aEnded.value.assignmentId, aEnded.value.revision, {
			source: "codex-live",
			sessionKey: "codex-live:persistent:ended-unverified",
			attachmentId: "codex.demo",
			instanceId: "inst-ended-1",
			runtimeFingerprintId: null,
		});
		if (!aEndedSess.ok) throw new Error(aEndedSess.code);
		const aRevoked = coord.endAssignment(
			aEndedSess.value.assignmentId,
			aEndedSess.value.revision,
			"revoked",
			"ended before confirming process exit",
		);
		if (!aRevoked.ok) throw new Error(aRevoked.code);

		const attempts = new DevelopAttemptsStoreV0(root);
		const prep = new DevelopAttemptsServiceV0(tasks, attempts).prepare(projectId, taskId, {
			objective: "Implement feature",
		});
		if (!prep.ok) throw new Error(prep.code);

		const cand = coord.declareCandidate({
			expectedFileRevision: aRevoked.file.revision,
			projectId,
			taskId,
			candidate: {
				kind: "git-commit",
				commonDir: validated.worktree.commonDir,
				worktreePath: repo,
				commitSha: headSha,
				treeSha,
				attemptId: prep.value.id,
			},
		});
		if (!cand.ok) throw new Error(cand.code);

		const dep = coord.addDependency({
			expectedFileRevision: cand.file.revision,
			projectId,
			dependentTaskId: tReview.value.id,
			prerequisiteTaskId: tBlocked.value.id,
			condition: "candidate-has-passing-receipt",
		});
		if (!dep.ok) throw new Error(dep.code);

		const reviews = new DevelopCoordinationReviewsStoreV0(root);
		const rev = reviews.recordReview({
			projectId,
			candidateTaskId: taskId,
			candidateId: cand.value.candidateId,
			assignmentId: null,
			attemptId: prep.value.id,
			reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
			verdict: "changes-requested",
			summary: "Edge case in retry loop needs handling.",
			findings: [
				{ severity: "high", category: "correctness", summary: "Missing timeout guard", location: "src/a.ts:12" },
			],
			agentClaimedChecks: null,
			checkout: {
				standing: "unobserved",
				worktreePath: null,
				preObservationId: null,
				postObservationId: null,
				cleanAtCandidate: false,
				reason: "offline",
			},
			recordedBy: "operator",
		});
		if (!rev.ok) throw new Error(rev.code);

		// S1 Automation: recorded resource observation pointing at sentinelPort (STALE so stale rule triggers),
		// enabled S1 schedule, completed fire + claimed-incomplete fire.
		const s1Store = new DevelopAutomationStoreV0(root, { now });
		const s1Add = s1Store.addSchedule({
			scheduleId: "obs-health-5m",
			label: "Passive local resource health",
			actionKind: "observe-health",
			missedRunPolicy: "skip-and-report",
			trigger: { kind: "interval", everyMs: 300_000, anchorMs: nowMs - 600_000 },
		});
		if (!s1Add.ok) throw new Error(s1Add.code);
		const s1En = s1Store.setScheduleEnabled("obs-health-5m", true, 1);
		if (!s1En.ok) throw new Error(s1En.code);

		const staleObservedAtMs = nowMs - 900_000;
		const s1Write = s1Store.withAutomationLockSync((s) => {
			s.writeLease({
				schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
				holderId: "endo.s1.demo",
				epoch: 1,
				acquiredAtMs: staleObservedAtMs,
				expiresAtMs: staleObservedAtMs + 60_000,
				releasedAtMs: staleObservedAtMs + 5_000,
			});
			s.writeResources({
				schemaVersion: ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
				leaseEpoch: 1,
				holderId: "endo.s1.demo",
				observedAtMs: staleObservedAtMs,
				publishedAtMs: staleObservedAtMs + 500,
				staleAfterMs: 300_000,
				tokensConsumed: 0,
				modelPool: {
					poolSha256: "a".repeat(64),
					poolSource: "file",
					localEndpoints: [
						{
							memberId: "local-inkling",
							endpoint: `http://127.0.0.1:${sentinelPort}`,
							modelId: "Inkling-2-Mini-Uncensored-AD-Q4_K",
							basis: "controller-observed",
							observedAtMs: staleObservedAtMs,
							staleAfterMs: 300_000,
							elapsedMs: 18,
							readiness: "capacity-unknown",
							detail: "slots-not-observable",
							backend: "llama.cpp-router",
							build: "b7000-abcdef1",
							requests: [{ path: "/health", status: 200 }],
							deviceId: "gpu-0",
							inferenceTokens: 0,
						},
					],
				},
				providers: [],
				sessions: [],
				// Include a Project B worktree entry in S1 resources to prove F1 strips foreign S1 worktrees & projectCount!
				worktrees: [
					{
						projectId: projB.value.id,
						worktreePath: repoB,
						worktreeId: null,
						activeHazardCount: 3,
						writeConflictCount: 2,
						driftedCandidateCount: 1,
						observedAtMs: staleObservedAtMs,
						basis: "controller-observed",
					},
				],
				hardware: {
					mode: "passive-host-os-only",
					observedAtMs: staleObservedAtMs,
					staleAfterMs: 300_000,
					devices: [],
				},
				projectionSummary: {
					statusSha256: null,
					coordinationSha256: null,
					projectCount: 2,
					activeAssignmentCount: 2,
					unresolvedHazardCount: 1,
					gaps: [],
				},
			});
			// Completed fire + incomplete claim
			s.writeFireClaimOnce({
				schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
				idempotencyKey: "1".repeat(64),
				scheduleId: "obs-health-5m",
				scheduleRevision: 2,
				actionKind: "observe-health",
				triggerKind: "interval",
				triggerCursor: `interval:300000:${nowMs - 600_000}`,
				windowStartMs: nowMs - 600_000,
				missedWindowsBefore: 0,
				claimedAtMs: nowMs - 600_000,
				leaseEpoch: 1,
				holderId: "endo.s1.demo",
			});
			s.writeFireOutcomeOnce({
				schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
				idempotencyKey: "1".repeat(64),
				scheduleId: "obs-health-5m",
				scheduleRevision: 2,
				actionKind: "observe-health",
				windowStartMs: nowMs - 600_000,
				completedAtMs: nowMs - 598_000,
				leaseEpoch: 1,
				holderId: "endo.s1.demo",
				status: "completed",
				missedWindowCount: 0,
				observationDigest: "b".repeat(64),
				detail: "passive observation recorded",
				tokensConsumed: 0,
			});
			s.writeFireClaimOnce({
				schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
				idempotencyKey: "2".repeat(64),
				scheduleId: "obs-health-5m",
				scheduleRevision: 2,
				actionKind: "observe-health",
				triggerKind: "interval",
				triggerCursor: `interval:300000:${nowMs - 600_000}`,
				windowStartMs: nowMs - 300_000,
				missedWindowsBefore: 0,
				claimedAtMs: nowMs - 300_000,
				leaseEpoch: 1,
				holderId: "endo.s1.demo",
			});
		});
		if (!s1Write.ok) throw new Error(s1Write.code);

		// S2 Advisory:
		//   1. Disabled advisory schedule on Project A + one historical refused briefing on Project A
		//   2. Active advisory schedule + published briefing + proposal on Project B (MUST NOT LEAK into Project A!)
		const pool = parseEndoCoordinatorModelPoolV0({
			schemaVersion: "endo.coordinator-model-pool.v0",
			selection: { fallback: "none", unconfirmedModel: "refuse" },
			members: [
				{
					memberId: "local-inkling",
					kind: "local-openai-compat",
					endpoint: `http://127.0.0.1:${sentinelPort}`,
					modelId: "Inkling-2-Mini-Uncensored-AD-Q4_K",
					priority: 1,
					maxPromptBytes: 8192,
					maxOutputTokens: 2048,
					timeoutMs: 60_000,
					advisoryOnly: true,
				},
			],
		});

		const addA = addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "adv-proj-a",
				label: "Project A Advisory Digest",
				projectId,
				actionKind: "generate-advisory-brief",
				wake: "on-change",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 3_600_000, anchorMs: nowMs - 3_600_000 },
			},
			now,
		);
		if (!addA.ok) throw new Error(addA.code);
		setEndoAdvisoryScheduleEnabledV0(root, "adv-proj-a", true, 1, now);
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "adv-proj-a",
				scheduleRevision: 2,
				pool,
				policy: {
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 60_000,
					permitCapacityUnknown: true,
					permitModelUnconfirmed: false,
					permitPartialObservation: true,
				},
				budget: {
					periodMs: 3_600_000,
					maxTurnsPerPeriod: 4,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 2048,
					maxGeneratedTokensPerPeriod: 16_384,
					maxTurnWallClockMs: 60_000,
				},
				lifetimeMs: 3_600_000,
			},
			now,
		);

		// Run one simulated refused advisory tick for Project A (zero real inference)
		await runEndoAdvisoryTickV0({
			root,
			now,
			observeMember: async (m) => ({
				memberId: m.memberId,
				endpoint: m.endpoint,
				modelId: m.modelId,
				basis: "controller-observed",
				observedAtMs: nowMs,
				elapsedMs: 4,
				readiness: "capacity-unknown",
				detail: "slots-not-observable",
				backend: "llama.cpp-router",
				build: null,
				requests: [{ path: "/health", status: 200 }],
				inferenceTokens: 0,
			}),
			run: async (_root, req) => ({
				schemaVersion: "endo.coordinator-brief.v0",
				projectId: req.projectId,
				runtime: {
					harness: "OpenClaw 2026.11.10",
					provider: "llama.cpp",
					model: "Inkling-2-Mini-Uncensored-AD-Q4_K",
				},
				availability: "unavailable",
				reason: "generation-limit",
			}),
		});
		// Disable Project A's advisory schedule after the historical refusal
		setEndoAdvisoryScheduleEnabledV0(root, "adv-proj-a", false, 2, now);

		// Seed Project B with its own schedule, published briefing, and proposal containing SECRET markers!
		const addB = addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "adv-secret-proj-b",
				label: "SECRET_SCHEDULE_B",
				projectId: projB.value.id,
				actionKind: "emit-operator-proposal",
				wake: "digest-window",
				missedRunPolicy: "skip-and-report",
				trigger: { kind: "interval", everyMs: 3_600_000, anchorMs: nowMs - 3_600_000 },
			},
			now,
		);
		if (!addB.ok) throw new Error(addB.code);
		setEndoAdvisoryScheduleEnabledV0(root, "adv-secret-proj-b", true, 1, now);
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "adv-secret-proj-b",
				scheduleRevision: 2,
				pool,
				policy: {
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 60_000,
					permitCapacityUnknown: true,
					permitModelUnconfirmed: false,
					permitPartialObservation: true,
				},
				budget: {
					periodMs: 3_600_000,
					maxTurnsPerPeriod: 4,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 2048,
					maxGeneratedTokensPerPeriod: 16_384,
					maxTurnWallClockMs: 60_000,
				},
				lifetimeMs: 3_600_000,
			},
			now,
		);
		await runEndoAdvisoryTickV0({
			root,
			now,
			observeMember: async (m) => ({
				memberId: m.memberId,
				endpoint: m.endpoint,
				modelId: m.modelId,
				basis: "controller-observed",
				observedAtMs: nowMs,
				elapsedMs: 4,
				readiness: "ready",
				detail: "slot-idle",
				backend: "llama.cpp-single",
				build: null,
				requests: [{ path: "/health", status: 200 }],
				inferenceTokens: 0,
			}),
			run: async (_root, req) => ({
				schemaVersion: "endo.coordinator-brief.v0",
				projectId: req.projectId,
				runtime: {
					harness: "OpenClaw 2026.11.10",
					provider: "llama.cpp",
					model: "Inkling-2-Mini-Uncensored-AD-Q4_K",
				},
				availability: "available",
				answer: "- SECRET_PROJECT_B_ADVISORY_ANSWER\nPROPOSAL: none",
				evidence: { readAtMs: nowMs, projectionSha256: "c".repeat(64), modelViewSha256: "d".repeat(64) },
				toolSurface: ["endophasia_status"],
			}),
		});

		const service = new DevelopWorkspaceServiceV0(tasks);
		const host = new EndoWorkspaceHostV0({
			open: (facts) => service.forLaunch({ projectId, launchDirectory: repo }, facts),
		});
		const server = await serve(root, { workbench: host });
		const base = `${capabilityOf(server)}/api/v0/workbench`;
		const paired = await host.handle({
			method: "POST",
			route: ["pair"],
			grant: null,
			query: "",
			body: { code: host.issuePairingCode().code },
		});
		const grant = (paired.body as { grant: string }).grant;
		const req = (route: string, method = "GET", withGrant = true) =>
			send(server, `${base}/${route}`, {
				method,
				headers: withGrant ? { "X-Endo-Grant": grant } : {},
			});
		return { root, repo, projectId, projectBId: projB.value.id, taskId, host, server, req };
	}

	it("enforces project scoping, zero cross-project leakage, zero model wakes, and deterministic F1 rendering", async () => {
		// Prohibited-route sentinel: MUST receive ZERO requests throughout the entire test!
		let sentinelHits = 0;
		const sentinel = createServer((_req, res) => {
			sentinelHits += 1;
			res.writeHead(500);
			res.end("prohibited");
		});
		await new Promise<void>((resolve) => sentinel.listen(0, "127.0.0.1", () => resolve()));
		const sentinelPort = (sentinel.address() as { port: number }).port;

		try {
			const fx = await buildRichMultiProjectFixture(sentinelPort);
			const before = fixtureManifestV0(fx.root);

			// 1. Authorization & method boundary checks
			expect((await fx.req("workspace/coordinator/operations", "GET", false)).status).toBe(401);
			expect((await fx.req(`workspace/coordinator/operations?project=${fx.projectBId}`, "GET", true)).status).toBe(
				400,
			);
			for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
				expect([403, 405]).toContain((await fx.req("workspace/coordinator/operations", method, true)).status);
			}

			// 2. Fetch status, coordination, and operations for Project A
			const [statusRes, coordRes, opsRes] = await Promise.all([
				fx.req("workspace/coordinator"),
				fx.req("workspace/coordinator/coordination"),
				fx.req("workspace/coordinator/operations"),
			]);
			expect([statusRes.status, coordRes.status, opsRes.status]).toEqual([200, 200, 200]);

			// 3. Strict cross-project disclosure check: ZERO Project B identifiers, schedules, or answers in opsRes!
			expect(opsRes.body).not.toContain(fx.projectBId);
			expect(opsRes.body).not.toContain("SECRET_PROJECT_B");
			expect(opsRes.body).not.toContain("adv-secret-proj-b");
			expect(opsRes.body).not.toContain("SECRET_SCHEDULE_B");
			expect(opsRes.body).not.toContain("SECRET_PROJECT_B_ADVISORY_ANSWER");

			const status = validateEndoCoordinatorStatusV0(JSON.parse(statusRes.body));
			const coordination = validateEndoCoordinatorCoordinationV0(JSON.parse(coordRes.body));
			const operations = validateEndoCoordinatorStudioOperationsV0(JSON.parse(opsRes.body));
			expect(readCoordinatorOperations(JSON.parse(opsRes.body))).not.toBeNull();

			// Project A sees ONLY its own 1 advisory schedule & 1 historical refused briefing (never Project B's!)
			expect(operations.projectId).toBe(fx.projectId);
			expect(operations.authority).toEqual({
				grants: "none",
				triggersInference: false,
				executesSchedules: false,
				wakesModels: false,
			});
			expect(operations.resources.liveProbed).toBe(false);
			expect(operations.resources.freshness).toBe("stale");
			expect(operations.schedules.observation.schedules.map((s) => s.scheduleId)).toEqual(["obs-health-5m"]);
			expect(operations.schedules.observation.incompleteCount).toBe(1);
			expect(operations.schedules.advisory.schedules.map((s) => s.scheduleId)).toEqual(["adv-proj-a"]);
			expect(operations.schedules.advisory.schedules[0]?.enabled).toBe(false);
			expect(operations.advisoryHistory.briefings).toHaveLength(1);
			expect(operations.advisoryHistory.briefings[0]?.availability).toBe("unavailable");
			expect(operations.advisoryHistory.briefings[0]?.refusal).toBe("generation-limit");
			expect(operations.advisoryHistory.totals.briefingsCount).toBe(1);
			expect(operations.advisoryHistory.totals.refusedCount).toBe(1);
			expect(operations.advisoryHistory.totals.publishedCount).toBe(0);

			// 4. Mid-read grant revocation returns 401 and discards operations payload
			const origOps = EndoCockpitCoordinatorV0.prototype.readOperations;
			vi.spyOn(EndoCockpitCoordinatorV0.prototype, "readOperations").mockImplementation(async function (
				this: EndoCockpitCoordinatorV0,
				...args
			) {
				const ans = await origOps.apply(this, args);
				fx.host.revoke();
				return ans;
			});
			const revokedRes = await fx.req("workspace/coordinator/operations");
			expect([revokedRes.status, JSON.parse(revokedRes.body)]).toEqual([401, { error: "grant-required" }]);

			// 5. Deterministic Attention Engine produces ordered rule-ranked items with zero models
			const attention = buildDeterministicAttention({
				status,
				coordination,
				operations,
				coordinationProblem: null,
				operationsProblem: null,
			});
			expect(attention.rulesetVersion).toBe("endo.coordinator-attention-rules.v1");
			const rules = attention.items.map((i) => i.ruleId);
			expect(rules).toContain("R1-WORKTREE-HAZARD");
			expect(rules).toContain("R2-ADVISORY-REVIEW-CHANGES");
			expect(rules).toContain("R2-UNSATISFIED-DEPENDENCY");
			expect(rules).toContain("R2-TASK-BLOCKED");
			expect(rules).toContain("R3-AWAITING-REVIEW");
			expect(rules).toContain("R4-SCHEDULE-FIRE-INCOMPLETE");
			expect(rules).toContain("R4-RESOURCES-STALE");
			// Hazards strictly rank ahead of blockers, verification, and observation items
			const firstHazard = attention.items.findIndex((i) => i.tier === "hazard");
			const firstBlocker = attention.items.findIndex((i) => i.tier === "blocker");
			const firstObs = attention.items.findIndex((i) => i.tier === "observation");
			expect(firstHazard).toBeGreaterThanOrEqual(0);
			expect(firstBlocker).toBeGreaterThan(firstHazard);
			expect(firstObs).toBeGreaterThan(firstBlocker);

			// 6. SSR render all four F1 operational views and verify epistemic caveats + zero mutation controls
			const opsViewsPath = "../studio-ui/src/coordinator/OperationsViews.tsx";
			const { AdvisoryHistoryView, DeterministicAttentionView, ResourcesView, SchedulesView } = (await import(
				opsViewsPath
			)) as {
				DeterministicAttentionView: (props: {
					attention: typeof attention;
					onNavigate: () => void;
				}) => ReturnType<typeof createElement>;
				ResourcesView: (props: {
					operations: typeof operations;
					problem: null;
				}) => ReturnType<typeof createElement>;
				SchedulesView: (props: {
					operations: typeof operations;
					problem: null;
				}) => ReturnType<typeof createElement>;
				AdvisoryHistoryView: (props: {
					operations: typeof operations;
					problem: null;
					taskTitles: ReadonlyMap<string, string>;
					onJumpToTask: () => void;
				}) => ReturnType<typeof createElement>;
			};
			const titles = new Map(status.projects.flatMap((p) => p.tasks.map((t) => [t.taskId, t.title] as const)));
			const noop = () => {};
			const attnHtml = renderToStaticMarkup(
				createElement(DeterministicAttentionView, { attention, onNavigate: noop }),
			);
			const resHtml = renderToStaticMarkup(createElement(ResourcesView, { operations, problem: null }));
			const schedHtml = renderToStaticMarkup(createElement(SchedulesView, { operations, problem: null }));
			const advHtml = renderToStaticMarkup(
				createElement(AdvisoryHistoryView, { operations, problem: null, taskTitles: titles, onJumpToTask: noop }),
			);

			expect(attnHtml).toContain("zero language models");
			expect(attnHtml).toContain("not a verified optimal plan");
			expect(attnHtml).toContain("R1-WORKTREE-HAZARD");
			expect(resHtml).toContain("liveProbed: false");
			expect(resHtml).toContain("Healthy ≠ free capacity");
			expect(resHtml).toContain("self-reported (unauthenticated)");
			expect(schedHtml).toContain("executesSchedules: false");
			expect(schedHtml).toContain("Scheduled ≠ running");
			expect(schedHtml).toContain("claimed-incomplete");
			expect(advHtml).toContain("Untrusted model interpretation");
			expect(advHtml).toContain("deferred to F2");
			expect(advHtml).toContain("generation-limit");

			const allHtml = attnHtml + resHtml + schedHtml + advHtml;
			expect(allHtml).not.toMatch(/<form\b|draggable=|style=/i);
			expect(allHtml).not.toContain("SECRET_PROJECT_B");

			// 7. Zero requests to sentinel server and zero store mutations
			expect(sentinelHits).toBe(0);
			expect(fixtureManifestV0(fx.root)).toEqual(before);

			// 8. S3: store-wide S2 lease epoch is NEVER disclosed under project-scoped advisory schedules
			expect(operations.schedules.advisory.lease.epoch).toBeNull();
			expect(operations.schedules.advisory.lease.expiresAtMs).toBeNull();

			// 9. S6: strict client validator rejects epistemically contradictory capacityConfirmed or out-of-range ports
			const badCap = structuredClone(operations) as unknown as Record<string, unknown>;
			(badCap.resources as { localEndpoints: { capacityConfirmed: boolean }[] })
				.localEndpoints[0]!.capacityConfirmed = true;
			expect(readCoordinatorOperations(badCap)).toBeNull();

			const badPort = structuredClone(operations) as unknown as Record<string, unknown>;
			(badPort.resources as { localEndpoints: { endpoint: string }[] }).localEndpoints[0]!.endpoint =
				"http://127.0.0.1:99999";
			expect(readCoordinatorOperations(badPort)).toBeNull();

			// 10. S2: control characters in an untrusted briefing answer are sanitized instead of causing HTTP 503
			const { readEndoCoordinatorStudioOperationsV0 } = await import("../storage/coordinator-studio-operations.ts");
			const { writeFileSync: writeRaw } = await import("node:fs");
			const ctrlDir = scratch("endo-f1-s2-ctrl-");
			const ctrlTasks = new DevelopTasksStoreV0(ctrlDir);
			const pCtrl = ctrlTasks.registerProject({ name: "Ctrl Test", path: ctrlDir, observedGitRoot: null });
			if (!pCtrl.ok) throw new Error(pCtrl.code);
			const ctrlPool = parseEndoCoordinatorModelPoolV0({
				schemaVersion: "endo.coordinator-model-pool.v0",
				selection: { fallback: "none", unconfirmedModel: "refuse" },
				members: [
					{
						memberId: "m1",
						kind: "local-openai-compat",
						endpoint: "http://127.0.0.1:18099",
						modelId: "test-model",
						priority: 1,
						maxPromptBytes: 8192,
						maxOutputTokens: 2048,
						timeoutMs: 60_000,
						advisoryOnly: true,
					},
				],
			});
			const nowCtrl = () => 1_700_000_000_000;
			addEndoAdvisoryScheduleV0(
				ctrlDir,
				{
					scheduleId: "sched-ctrl",
					label: "Ctrl /home/secret/path test",
					projectId: pCtrl.value.id,
					actionKind: "generate-advisory-brief",
					wake: "on-change",
					missedRunPolicy: "skip-and-report",
					trigger: { kind: "interval", everyMs: 60_000, anchorMs: nowCtrl() },
				},
				nowCtrl,
			);
			setEndoAdvisoryScheduleEnabledV0(ctrlDir, "sched-ctrl", true, 1, nowCtrl);
			authorizeEndoAdvisoryScheduleV0(
				ctrlDir,
				{
					scheduleId: "sched-ctrl",
					scheduleRevision: 2,
					pool: ctrlPool,
					policy: {
						observationSource: "recorded-or-passive-probe",
						recordedObservationMaxAgeMs: 60_000,
						permitCapacityUnknown: true,
						permitModelUnconfirmed: false,
						permitPartialObservation: true,
					},
					budget: {
						periodMs: 3_600_000,
						maxTurnsPerPeriod: 4,
						completionRequestsPerTurn: 2,
						maxOutputTokensPerRequest: 2048,
						maxGeneratedTokensPerPeriod: 16_384,
						maxTurnWallClockMs: 60_000,
					},
					lifetimeMs: 3_600_000,
				},
				nowCtrl,
			);
			await runEndoAdvisoryTickV0({
				root: ctrlDir,
				now: nowCtrl,
				observeMember: async (m) => ({
					memberId: m.memberId,
					endpoint: m.endpoint,
					modelId: m.modelId,
					basis: "controller-observed",
					observedAtMs: nowCtrl(),
					elapsedMs: 1,
					readiness: "ready",
					detail: "slot-idle",
					backend: "llama.cpp-single",
					build: null,
					requests: [{ path: "/health", status: 200 }],
					inferenceTokens: 0,
				}),
				run: async (_r, req) => ({
					schemaVersion: "endo.coordinator-brief.v0",
					projectId: req.projectId,
					runtime: { harness: "OpenClaw 2026.11.10", provider: "test", model: "test-model" },
					availability: "available",
					answer: "Hello\x00\x07\x1b[31mWorld\nLine2",
					evidence: { readAtMs: nowCtrl(), projectionSha256: "a".repeat(64), modelViewSha256: "b".repeat(64) },
					toolSurface: ["endophasia_status"],
				}),
			});
			// Also drop a corrupt turn file to verify S5 degraded flag!
			writeRaw(join(ctrlDir, "develop", "automation", "advisory", "turns", "corrupt.admitted.json"), "{ bad json");
			const ctrlOps = readEndoCoordinatorStudioOperationsV0({
				root: ctrlDir,
				projectId: pCtrl.value.id,
				now: nowCtrl,
			});
			expect(ctrlOps.advisoryHistory.briefings[0]?.answer).toBe("Hello   [31mWorld\nLine2");
			expect(ctrlOps.advisoryHistory.degraded).toBe(true);
			expect(ctrlOps.schedules.advisory.schedules[0]?.label).not.toContain("/home/secret/path");
			// S1: bounded read budget fails closed on overflow
			const overBudget = readEndoCoordinatorStudioOperationsV0({
				root: ctrlDir,
				projectId: pCtrl.value.id,
				now: nowCtrl,
				budget: { maxS2TurnFiles: 1 },
			});
			expect(overBudget.advisoryHistory.state).toBe("unreadable");
			expect(overBudget.advisoryHistory.detail).toBe("too-many");
		} finally {
			await new Promise<void>((resolve) => sentinel.close(() => resolve()));
		}
	});
});

describe("COORDINATOR-STUDIO-F1-002: review findings on #196", () => {
	const T0 = 1_700_000_000_000;
	const pool = () =>
		parseEndoCoordinatorModelPoolV0({
			schemaVersion: "endo.coordinator-model-pool.v0",
			selection: { fallback: "none", unconfirmedModel: "refuse" },
			members: [
				{
					memberId: "m1",
					kind: "local-openai-compat",
					endpoint: "http://127.0.0.1:18099",
					modelId: "test-model",
					priority: 1,
					maxPromptBytes: 8192,
					maxOutputTokens: 2048,
					timeoutMs: 60_000,
					advisoryOnly: true,
				},
			],
		});

	function advisoryProject(trigger: Parameters<typeof addEndoAdvisoryScheduleV0>[1]["trigger"]) {
		const root = scratch("endo-f1-findings-");
		const project = new DevelopTasksStoreV0(root).registerProject({
			name: "Findings",
			path: root,
			observedGitRoot: null,
		});
		if (!project.ok) throw new Error(project.code);
		const now = () => T0;
		addEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "adv-findings",
				label: "Findings",
				projectId: project.value.id,
				actionKind: "generate-advisory-brief",
				wake: "on-change",
				missedRunPolicy: "skip-and-report",
				trigger,
			},
			now,
		);
		setEndoAdvisoryScheduleEnabledV0(root, "adv-findings", true, 1, now);
		return { root, projectId: project.value.id };
	}

	it("F1: classifies an advisory schedule with the advisory tick's grace and an S1 schedule with S1's", () => {
		const atMs = T0 + 60_000;
		const { root, projectId } = advisoryProject({ kind: "once", atMs });
		const s1 = new DevelopAutomationStoreV0(root, { now: () => T0 });
		const added = s1.addSchedule({
			scheduleId: "obs-once",
			label: "Observe once",
			actionKind: "observe-health",
			missedRunPolicy: "skip-and-report",
			trigger: { kind: "once", atMs },
		});
		if (!added.ok) throw new Error(added.code);
		const enabled = s1.setScheduleEnabled("obs-once", true, 1);
		if (!enabled.ok) throw new Error(enabled.code);

		const at = (offsetMs: number) => {
			const operations = readEndoCoordinatorStudioOperationsV0({ root, projectId, now: () => atMs + offsetMs });
			return {
				advisory: operations.schedules.advisory.schedules[0]?.nextDueState,
				observation: operations.schedules.observation.schedules[0]?.nextDueState,
			};
		};

		// Two minutes past its trigger the advisory tick still fires, so Studio must say due, not missed.
		const read = new DevelopAdvisoryStoreV0(root).readSchedules();
		if (!read.ok || read.value === null) throw new Error("advisory schedules unreadable");
		expect(
			evaluateEndoScheduleDueV0(read.value.schedules[0] as never, atMs + 120_000, {
				onTimeGraceMs: ENDO_ADVISORY_LIMITS_V0.defaultOnTimeGraceMs,
			}).kind,
		).toBe("due-fire");
		expect(at(120_000)).toEqual({ advisory: "due", observation: "missed" });
		// S1 keeps its own 60-second grace, and the advisory grace still ends at 600 seconds.
		expect(at(30_000)).toEqual({ advisory: "due", observation: "due" });
		expect(at(ENDO_ADVISORY_LIMITS_V0.defaultOnTimeGraceMs + 60_000)).toEqual({
			advisory: "missed",
			observation: "missed",
		});
	});

	it("F2: redacts foreign project ids and absolute paths from a briefing answer and keeps its formatting", async () => {
		const { root, projectId } = advisoryProject({ kind: "interval", everyMs: 60_000, anchorMs: T0 });
		const foreign = `endo.project.${"f".repeat(32)}`;
		expect(foreign).not.toBe(projectId);
		authorizeEndoAdvisoryScheduleV0(
			root,
			{
				scheduleId: "adv-findings",
				scheduleRevision: 2,
				pool: pool(),
				policy: {
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 60_000,
					permitCapacityUnknown: true,
					permitModelUnconfirmed: false,
					permitPartialObservation: true,
				},
				budget: {
					periodMs: 3_600_000,
					maxTurnsPerPeriod: 4,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 2048,
					maxGeneratedTokensPerPeriod: 16_384,
					maxTurnWallClockMs: 60_000,
				},
				lifetimeMs: 3_600_000,
			},
			() => T0,
		);
		const answer = [
			"## Findings",
			"",
			`- Compare \`/home/private/other-repo/src/a.ts\` with ${foreign}.`,
			`- This project ${projectId} lives at ${root}.`,
			"\tIndented **bold**, see src/lib/x.ts, either/or and https://example.com/docs/a.",
		].join("\n");
		await runEndoAdvisoryTickV0({
			root,
			now: () => T0,
			observeMember: async (m) => ({
				memberId: m.memberId,
				endpoint: m.endpoint,
				modelId: m.modelId,
				basis: "controller-observed",
				observedAtMs: T0,
				elapsedMs: 1,
				readiness: "ready",
				detail: "slot-idle",
				backend: "llama.cpp-single",
				build: null,
				requests: [{ path: "/health", status: 200 }],
				inferenceTokens: 0,
			}),
			run: async (_r, req) => ({
				schemaVersion: "endo.coordinator-brief.v0",
				projectId: req.projectId,
				runtime: { harness: "OpenClaw 2026.11.10", provider: "test", model: "test-model" },
				availability: "available",
				answer,
				evidence: { readAtMs: T0, projectionSha256: "a".repeat(64), modelViewSha256: "b".repeat(64) },
				toolSurface: ["endophasia_status"],
			}),
		});
		const operations = validateEndoCoordinatorStudioOperationsV0(
			readEndoCoordinatorStudioOperationsV0({ root, projectId, now: () => T0 }),
		);
		const published = operations.advisoryHistory.briefings[0]?.answer;
		expect(published).toBe(
			[
				"## Findings",
				"",
				"- Compare `[redacted-path]` with [redacted-project].",
				`- This project ${projectId} lives at [redacted-path].`,
				"\tIndented **bold**, see src/lib/x.ts, either/or and https://example.com/docs/a.",
			].join("\n"),
		);
		expect(published).not.toContain("/home/private");
		expect(published).not.toContain(foreign);
		expect(published).not.toContain(root);
	});

	const busyWorkbench = {
		handle: async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			const until = performance.now() + 50;
			while (performance.now() < until) {}
			return { status: 200, body: { ok: true } };
		},
	};
	const operationsRoute = (server: Parameters<typeof capabilityOf>[0]) =>
		`${capabilityOf(server)}/api/v0/workbench/workspace/coordinator/operations`;

	it("F3: charges the read budget for the asynchronous operations read, so a sequential burst is throttled", async () => {
		const server = await serve(scratch(), { workbench: busyWorkbench, readBudget: { duty: 1e-9, burstMs: 5 } });
		expect((await send(server, operationsRoute(server))).status).toBe(200);
		expect((await send(server, operationsRoute(server))).status).toBe(429);
	});

	it("F3: charges an ordinary operations read once, not twice", async () => {
		const server = await serve(scratch(), { workbench: busyWorkbench, readBudget: { duty: 1e-9, burstMs: 90 } });
		expect((await send(server, operationsRoute(server))).status).toBe(200);
		expect((await send(server, operationsRoute(server))).status).toBe(200);
		expect((await send(server, operationsRoute(server))).status).toBe(429);
	});
});
