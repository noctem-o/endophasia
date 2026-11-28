#!/usr/bin/env node
// Reproducible synthetic end-to-end demonstration for Coordinator Studio F1 (`COORDINATOR-STUDIO-F1-002`).
// Builds an isolated temp store containing:
//   - Multi-agent S8-style tasks, overlapping writable worktree hazard, unverified termination hazard,
//     unsatisfied dependency, declared candidate, and agent-reported `request-changes` advisory review
//   - Stale S1 recorded resource observation pointing at a live prohibited-route sentinel (proves 0 model wakes)
//   - Enabled S1 observation schedule with completed & claimed-incomplete fires
//   - Disabled S2 advisory schedule with historical `generation-limit` refusal
//   - Unrelated second Project B with secret markers (proves 0 cross-project disclosure)
//
// Usage:
//   node scripts/demo-coordinator-studio-f1.mjs              # starts host, prints capability URL & pairing code until Ctrl+C
//   node scripts/demo-coordinator-studio-f1.mjs --json-info  # prints single JSON line with url, code, sentinelPort, root, projectId

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	setEndoAdvisoryScheduleEnabledV0,
} = await import(join(repoRoot, "adapters/develop/advisory-operator.ts"));
const { runEndoAdvisoryTickV0 } = await import(join(repoRoot, "adapters/develop/advisory-tick.ts"));
const { DevelopCoordinationGitV0 } = await import(join(repoRoot, "adapters/develop/coordination.ts"));
const { endoStartOnDevelopV0 } = await import(join(repoRoot, "cockpit-http/host.ts"));
const { startEndoCockpitServerV0 } = await import(join(repoRoot, "cockpit-http/server.ts"));
const { loadEndoStudioUiFilesV0 } = await import(join(repoRoot, "cockpit-http/studio-ui.ts"));
const { EndoWorkspaceHostV0 } = await import(join(repoRoot, "cockpit-http/workspace-host.ts"));
const { parseEndoCoordinatorModelPoolV0 } = await import(join(repoRoot, "protocol/coordinator-model-pool.ts"));
const {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
} = await import(join(repoRoot, "protocol/develop-automation.ts"));
const { DevelopAttemptsServiceV0 } = await import(join(repoRoot, "runtime/contracts/develop-attempts.ts"));
const { DevelopWorkspaceServiceV0 } = await import(join(repoRoot, "runtime/contracts/develop-workspace.ts"));
const { DevelopAttemptsStoreV0 } = await import(join(repoRoot, "storage/develop-attempts.ts"));
const { DevelopAutomationStoreV0 } = await import(join(repoRoot, "storage/develop-automation.ts"));
const { DevelopCoordinationStoreV0 } = await import(join(repoRoot, "storage/develop-coordination.ts"));
const { DevelopCoordinationReviewsStoreV0 } = await import(join(repoRoot, "storage/develop-coordination-reviews.ts"));
const { DevelopTasksStoreV0 } = await import(join(repoRoot, "storage/develop-tasks.ts"));

const git = (cwd, ...args) =>
	execFileSync("/usr/bin/git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Endo Demo",
			GIT_AUTHOR_EMAIL: "demo@endophasia.local",
			GIT_COMMITTER_NAME: "Endo Demo",
			GIT_COMMITTER_EMAIL: "demo@endophasia.local",
		},
	});

const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "endo-studio-f1-demo-")));
const storeRoot = join(baseDir, "store");
const repo = join(baseDir, "repo-alpha");
const sibling = join(baseDir, "repo-alpha-review-wt");
const repoB = join(baseDir, "repo-beta-secret");
mkdirSync(storeRoot, { recursive: true });
mkdirSync(repo, { recursive: true });
mkdirSync(repoB, { recursive: true });

// Prohibited-route sentinel HTTP server (must receive 0 requests!)
let sentinelHits = 0;
const sentinel = createServer((_req, res) => {
	sentinelHits += 1;
	res.writeHead(500);
	res.end("prohibited-model-wake");
});
await new Promise((r) => sentinel.listen(0, "127.0.0.1", r));
const sentinelPort = sentinel.address().port;

// Initialize primary git repo + sibling worktree
git(repo, "init", "-q");
writeFileSync(join(repo, "README.md"), "# Alpha Coordination Demo\n");
git(repo, "add", "README.md");
git(repo, "commit", "-q", "-m", "initial commit");
git(repo, "worktree", "add", "-q", "-b", "review-wt", sibling);
const headSha = git(repo, "rev-parse", "HEAD").trim();
const treeSha = git(repo, "rev-parse", "HEAD^{tree}").trim();

const nowMs = Date.now();
const now = () => nowMs;
const tasks = new DevelopTasksStoreV0(storeRoot);

const pA = tasks.registerProject({ name: "Alpha Runtime (S8 Demo)", path: repo, observedGitRoot: repo });
if (!pA.ok) throw new Error(pA.code);
const projectId = pA.value.id;

const t1 = tasks.createTask(projectId, { title: "Harden scheduler lease fencing" });
const t1a = tasks.setStatus(projectId, t1.value.id, 0, "in-progress", null);
const t2 = tasks.createTask(projectId, { title: "Verify candidate checkout receipts" });
const t2a = tasks.setStatus(projectId, t2.value.id, 0, "in-progress", null);
const t2b = tasks.setStatus(projectId, t2.value.id, t2a.value.revision, "review", null);
const t3 = tasks.createTask(projectId, { title: "Migrate legacy event cursor" });
const t3b = tasks.setStatus(projectId, t3.value.id, 0, "blocked", null);
tasks.createTask(projectId, { title: "Document operator runbook" });

// Unrelated Project B (must never appear in Project A's Studio views)
const pB = tasks.registerProject({ name: "SECRET_FOREIGN_PROJECT_B", path: repoB, observedGitRoot: repoB });
tasks.createTask(pB.value.id, { title: "SECRET_FOREIGN_TASK_B" });

// Coordination state (S8 multi-agent scenario)
const validated = await new DevelopCoordinationGitV0().validateSiblingWorktree(pA.value, sibling);
const coord = new DevelopCoordinationStoreV0(storeRoot);
const reg = coord.registerWorktree({
	expectedFileRevision: 0,
	projectId,
	worktreePath: validated.worktree.worktreePath,
	commonDir: validated.worktree.commonDir,
	gitDir: validated.worktree.gitDir,
	label: "pi-review-wt",
});
const a1 = coord.createAssignment({
	expectedFileRevision: reg.file.revision,
	expectedTaskRevision: t1a.value.revision,
	projectId,
	taskId: t1.value.id,
	participant: { participantId: "codex-builder", role: "builder", intendedHarnessFamily: "codex" },
	workspace: {
		worktreePath: repo,
		registration: "project-path",
		accessIntent: "read-write-intended",
		pathHints: ["adapters/develop/"],
		allowSharedWorktree: true,
	},
	targetCandidate: null,
});
const a1s = coord.associateSession(a1.value.assignmentId, a1.value.revision, {
	source: "codex-live",
	sessionKey: "codex-live:persistent:thread-s8",
	attachmentId: "codex.demo",
	instanceId: "inst-s8-1",
	runtimeFingerprintId: null,
});
const a2 = coord.createAssignment({
	expectedFileRevision: a1s.file.revision,
	expectedTaskRevision: t2b.value.revision,
	projectId,
	taskId: t2.value.id,
	participant: { participantId: "pi-builder-overlap", role: "builder", intendedHarnessFamily: "pi" },
	workspace: {
		worktreePath: repo,
		registration: "project-path",
		accessIntent: "read-write-intended",
		pathHints: ["adapters/develop/"],
		allowSharedWorktree: true,
	},
	targetCandidate: null,
});
const a3 = coord.createAssignment({
	expectedFileRevision: a2.file.revision,
	expectedTaskRevision: t2b.value.revision,
	projectId,
	taskId: t2.value.id,
	participant: { participantId: "pi-reviewer", role: "reviewer", intendedHarnessFamily: "pi" },
	workspace: {
		worktreePath: sibling,
		registration: "registered-sibling",
		accessIntent: "read-only-intended",
		pathHints: [],
		allowSharedWorktree: false,
	},
	targetCandidate: null,
});
const aEnded = coord.createAssignment({
	expectedFileRevision: a3.file.revision,
	expectedTaskRevision: t3b.value.revision,
	projectId,
	taskId: t3.value.id,
	participant: { participantId: "codex-migrator", role: "builder", intendedHarnessFamily: "codex" },
	workspace: {
		worktreePath: repo,
		registration: "project-path",
		accessIntent: "read-write-intended",
		pathHints: ["storage/"],
		allowSharedWorktree: true,
	},
	targetCandidate: null,
});
const aEndedSess = coord.associateSession(aEnded.value.assignmentId, aEnded.value.revision, {
	source: "codex-live",
	sessionKey: "codex-live:persistent:thread-ended-s8",
	attachmentId: "codex.demo",
	instanceId: "inst-ended-s8",
	runtimeFingerprintId: null,
});
const aRevoked = coord.endAssignment(
	aEndedSess.value.assignmentId,
	aEndedSess.value.revision,
	"revoked",
	"operator revoked before confirming process exit",
);

const attempts = new DevelopAttemptsStoreV0(storeRoot);
const prep = new DevelopAttemptsServiceV0(tasks, attempts).prepare(projectId, t1.value.id, {
	objective: "Harden scheduler lease fencing",
});
const cand = coord.declareCandidate({
	expectedFileRevision: aRevoked.file.revision,
	projectId,
	taskId: t1.value.id,
	candidate: {
		kind: "git-commit",
		commonDir: validated.worktree.commonDir,
		worktreePath: repo,
		commitSha: headSha,
		treeSha,
		attemptId: prep.value.id,
	},
});
coord.addDependency({
	expectedFileRevision: cand.file.revision,
	projectId,
	dependentTaskId: t2.value.id,
	prerequisiteTaskId: t1.value.id,
	condition: "candidate-has-passing-receipt",
});

new DevelopCoordinationReviewsStoreV0(storeRoot).recordReview({
	projectId,
	candidateTaskId: t1.value.id,
	candidateId: cand.value.candidateId,
	assignmentId: a3.value.assignmentId,
	attemptId: prep.value.id,
	reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
	verdict: "changes-requested",
	summary: "Publication margin check needs explicit monotonic clock guard.",
	findings: [{ severity: "high", category: "correctness", summary: "Guard monotonic deadline before publish", location: "adapters/develop/advisory-tick.ts:1240" }],
	agentClaimedChecks: "npm run typecheck (agent-claimed; not a host receipt)",
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

// S1 recorded resources (stale) + enabled schedule + completed & incomplete fires
const s1 = new DevelopAutomationStoreV0(storeRoot, { now });
s1.addSchedule({
	scheduleId: "obs-local-health",
	label: "Passive local model & provider observation",
	actionKind: "observe-health",
	missedRunPolicy: "skip-and-report",
	trigger: { kind: "interval", everyMs: 300_000, anchorMs: nowMs - 600_000 },
});
s1.setScheduleEnabled("obs-local-health", true, 1);
const staleAt = nowMs - 720_000;
s1.withAutomationLockSync((s) => {
	s.writeLease({
		schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
		holderId: "endo.s1.demo",
		epoch: 3,
		acquiredAtMs: staleAt,
		expiresAtMs: staleAt + 60_000,
		releasedAtMs: staleAt + 4_000,
	});
	s.writeResources({
		schemaVersion: ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
		leaseEpoch: 3,
		holderId: "endo.s1.demo",
		observedAtMs: staleAt,
		publishedAtMs: staleAt + 400,
		staleAfterMs: 300_000,
		tokensConsumed: 0,
		modelPool: {
			poolSha256: "a".repeat(64),
			poolSource: "file",
			localEndpoints: [
				{
					memberId: "local-inkling-2-mini",
					endpoint: `http://127.0.0.1:${sentinelPort}`,
					modelId: "Inkling-2-Mini-Uncensored-AD-Q4_K",
					basis: "controller-observed",
					observedAtMs: staleAt,
					staleAfterMs: 300_000,
					elapsedMs: 21,
					readiness: "capacity-unknown",
					detail: "slots-not-observable",
					backend: "llama.cpp-router",
					build: "b7012-1234abc",
					requests: [{ path: "/health", status: 200 }],
					deviceId: "gpu-0",
					inferenceTokens: 0,
				},
			],
		},
		providers: [
			{
				providerId: "local-router",
				surfaceKind: "local-compute",
				quotaPoolId: null,
				standing: "unknown",
				basis: "controller-observed",
				observedAtMs: staleAt,
				staleAfterMs: 300_000,
				windows: [],
				localLedgerLowerBound: { recordedTurns: 1, recordedAtMs: staleAt, note: "local-endophasia-lower-bound-only" },
				detail: null,
			},
		],
		sessions: [],
		worktrees: [],
		hardware: {
			mode: "passive-host-os-only",
			observedAtMs: staleAt,
			staleAfterMs: 300_000,
			devices: [
				{
					deviceId: "gpu-0",
					kind: "gpu",
					backendFamily: "vulkan",
					label: "Local Accelerator (demo)",
					memoryTotalBytes: 24 * 1024 ** 3,
					memoryUsedBytes: 8 * 1024 ** 3,
					memoryFreeBytes: 16 * 1024 ** 3,
					memoryBasis: "controller-observed",
					attributedModelMemberIds: ["local-inkling-2-mini"],
					sharedDeviceContention: "none-observed",
					activeResourceLeaseIds: [],
					supportsCpuOnlyDecisionModel: false,
				},
			],
		},
		projectionSummary: null,
	});
	s.writeFireClaimOnce({
		schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
		idempotencyKey: "a".repeat(64),
		scheduleId: "obs-local-health",
		scheduleRevision: 2,
		actionKind: "observe-health",
		triggerKind: "interval",
		triggerCursor: `interval:300000:${nowMs - 600_000}`,
		windowStartMs: nowMs - 600_000,
		missedWindowsBefore: 0,
		claimedAtMs: nowMs - 600_000,
		leaseEpoch: 3,
		holderId: "endo.s1.demo",
	});
	s.writeFireOutcomeOnce({
		schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
		idempotencyKey: "a".repeat(64),
		scheduleId: "obs-local-health",
		scheduleRevision: 2,
		actionKind: "observe-health",
		windowStartMs: nowMs - 600_000,
		completedAtMs: nowMs - 599_000,
		leaseEpoch: 3,
		holderId: "endo.s1.demo",
		status: "completed",
		missedWindowCount: 0,
		observationDigest: "b".repeat(64),
		detail: "passive observation completed",
		tokensConsumed: 0,
	});
	s.writeFireClaimOnce({
		schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
		idempotencyKey: "b".repeat(64),
		scheduleId: "obs-local-health",
		scheduleRevision: 2,
		actionKind: "observe-health",
		triggerKind: "interval",
		triggerCursor: `interval:300000:${nowMs - 600_000}`,
		windowStartMs: nowMs - 300_000,
		missedWindowsBefore: 0,
		claimedAtMs: nowMs - 300_000,
		leaseEpoch: 3,
		holderId: "endo.s1.demo",
	});
});

// S2 disabled advisory schedule + historical refusal on Project A
const pool = parseEndoCoordinatorModelPoolV0({
	schemaVersion: "endo.coordinator-model-pool.v0",
	selection: { fallback: "none", unconfirmedModel: "refuse" },
	members: [
		{
			memberId: "local-inkling-2-mini",
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
addEndoAdvisoryScheduleV0(
	storeRoot,
	{
		scheduleId: "adv-alpha-hourly",
		label: "Alpha Hourly Advisory Brief (disabled)",
		projectId,
		actionKind: "generate-advisory-brief",
		wake: "on-change",
		missedRunPolicy: "skip-and-report",
		trigger: { kind: "interval", everyMs: 3_600_000, anchorMs: nowMs - 3_600_000 },
	},
	now,
);
setEndoAdvisoryScheduleEnabledV0(storeRoot, "adv-alpha-hourly", true, 1, now);
authorizeEndoAdvisoryScheduleV0(
	storeRoot,
	{
		scheduleId: "adv-alpha-hourly",
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
	root: storeRoot,
	now,
	observeMember: async (m) => ({
		memberId: m.memberId,
		endpoint: m.endpoint,
		modelId: m.modelId,
		basis: "controller-observed",
		observedAtMs: nowMs,
		elapsedMs: 5,
		readiness: "capacity-unknown",
		detail: "slots-not-observable",
		backend: "llama.cpp-router",
		build: null,
		requests: [{ path: "/health", status: 200 }],
		inferenceTokens: 0,
	}),
	run: async (_r, req) => ({
		schemaVersion: "endo.coordinator-brief.v0",
		projectId: req.projectId,
		runtime: { harness: "OpenClaw 2026.11.10", provider: "llama.cpp", model: "Inkling-2-Mini-Uncensored-AD-Q4_K" },
		availability: "unavailable",
		reason: "generation-limit",
	}),
});
setEndoAdvisoryScheduleEnabledV0(storeRoot, "adv-alpha-hourly", false, 2, now);

// Build or load Studio UI assets
const distDir = join(repoRoot, "dist", "studio-ui");
const ui = endoStartOnDevelopV0(loadEndoStudioUiFilesV0(distDir));
const service = new DevelopWorkspaceServiceV0(tasks);
const host = new EndoWorkspaceHostV0({
	open: (facts) => service.forLaunch({ projectId, launchDirectory: repo }, facts),
});
const server = await startEndoCockpitServerV0({
	root: storeRoot,
	ui,
	workbench: host,
});
const { code } = host.issuePairingCode();
const info = {
	url: `${server.baseUrl}/`,
	pairingCode: code,
	sentinelPort,
	sentinelHits,
	projectId,
	storeRoot,
};

if (process.argv.includes("--json-info")) {
	process.stdout.write(`${JSON.stringify(info)}\n`);
} else {
	console.log("Coordinator Studio F1 synthetic demonstration running:");
	console.log(`  URL:           ${info.url}`);
	console.log(`  Pairing code:  ${info.pairingCode}`);
	console.log(`  Sentinel port: 127.0.0.1:${sentinelPort} (must remain 0 hits)`);
	console.log("Press Ctrl+C to stop and clean up temporary fixture.");
}

const shutdown = async () => {
	console.error(`Demo shutting down. Prohibited sentinel requests observed: ${sentinelHits}`);
	await server.close();
	await new Promise((r) => sentinel.close(() => r()));
	rmSync(baseDir, { recursive: true, force: true });
	process.exit(sentinelHits === 0 ? 0 : 1);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
