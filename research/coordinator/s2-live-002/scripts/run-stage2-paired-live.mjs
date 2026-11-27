#!/usr/bin/env node
/**
 * S2-LIVE-002 Stage 2 — Paired Live Comparative Evaluation Harness
 *
 * SAFETY GATE: Refuses to execute unless `--authorize-live-stage2` is explicitly passed on the CLI.
 * Never stops, restarts, or reconfigures `llama-server` (127.0.0.1:8091) or `openclaw-gateway.service`.
 *
 * Experimental design (PROTOCOL.md §3):
 *   - 8 matched scenarios x 3 conditions (A: legacy-v0/status-v0, B: grounded-v1/status-v0, C: grounded-v1/status-and-coordination-v1)
 *   - Hard ceiling: 24 bounded live advisory turns total (zero retries on refusal)
 *   - Paired blocks per scenario with rotated condition order (ABC, BCA, CAB, ...) to avoid warm/cold ordering confound
 *   - Isolated temporary Git repos and Endophasia stores per scenario/condition (zero mutation of PR #192 or operator workspaces)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../../../../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../../../../adapters/develop/advisory-tick.ts";
import { parseEndoCoordinatorModelPoolV0 } from "../../../../protocol/coordinator-model-pool.ts";
import { DevelopAdvisoryStoreV0 } from "../../../../storage/develop-advisory.ts";
import { DevelopCoordinationStoreV0 } from "../../../../storage/develop-coordination.ts";
import { DevelopReceiptsStoreV0 } from "../../../../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../../../../storage/develop-tasks.ts";

if (!process.argv.includes("--authorize-live-stage2")) {
	console.error(
		"REFUSED: Stage 2 live inference requires explicit operator authorization.\n" +
			"Re-run with --authorize-live-stage2 ONLY after operator approval of the 24-turn live budget ceiling.",
	);
	process.exit(2);
}

const ENDPOINT = "http://127.0.0.1:8091";
const MODEL_ID = "Inkling-2-Mini-Uncensored-AD-Q4_K";
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

const POOL = parseEndoCoordinatorModelPoolV0({
	schemaVersion: "endo.coordinator-model-pool.v0",
	selection: { fallback: "none", unconfirmedModel: "permit" },
	members: [
		{
			memberId: "inkling-local",
			kind: "local-openai-compat",
			endpoint: ENDPOINT,
			modelId: MODEL_ID,
			priority: 100,
			maxPromptBytes: 8192,
			maxOutputTokens: 2048,
			timeoutMs: 180_000,
			advisoryOnly: true,
		},
	],
});

function git(repo, args) {
	return execFileSync("/usr/bin/git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
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
		writeFileSync(join(storeRoot, "events/events.log"), "");
	}
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.name", "endo-exp"]);
	git(repo, ["config", "user.email", "endo-exp@localhost"]);
	writeFileSync(join(repo, "README.md"), `# ${scenarioId}\n`);
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-m", "initial commit"]);
	const tasks = new DevelopTasksStoreV0(storeRoot);
	const reg = tasks.registerProject({ name: scenarioId, path: repo, observedGitRoot: repo });
	if (!reg.ok) throw new Error(`register failed: ${reg.code}`);
	return { base, repo, storeRoot, projectId: reg.value.id, tasks };
}

function recordUnplannedReceipt(storeRoot, { projectId, taskId, repo, headCommit, outcome }) {
	const receipts = new DevelopReceiptsStoreV0(storeRoot);
	const res = receipts.appendReceipt({
		projectId,
		taskId,
		command: outcome === "passed" ? "true" : "false",
		exitCode: outcome === "passed" ? 0 : 1,
		outcome,
		startedAtMs: Date.now() - 500,
		finishedAtMs: Date.now(),
		gitHeadCommit: headCommit,
		gitWorktreePath: repo,
		gitDirty: false,
		checkName: "stage2-check",
		planned: false,
	});
	if (!res.ok) throw new Error(`receipt failed: ${res.code}`);
	return res.value;
}

const SCENARIOS = [
	{
		id: "S1-B1-partial",
		wake: "on-change",
		actionKind: "generate-advisory-brief",
		permitPartialObservation: true,
		build() {
			const f = createBaseFixture("S1-B1-partial", { initEventsAndAttempts: false });
			f.tasks.createTask(f.projectId, { title: "Initial open task on partial store" });
			return f;
		},
	},
	{
		id: "S2-W0-unassigned",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		build() {
			const f = createBaseFixture("S2-W0-unassigned");
			f.tasks.createTask(f.projectId, { title: "Unassigned open task" });
			return f;
		},
	},
	{
		id: "S3-W3-blocked",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		build() {
			const f = createBaseFixture("S3-W3-blocked");
			const t1 = f.tasks.createTask(f.projectId, { title: "Blocked integration task" });
			if (!t1.ok) throw new Error("t1");
			f.tasks.setStatus(f.projectId, t1.value.id, 0, "blocked", "waiting on upstream schema");
			return f;
		},
	},
	{
		id: "S4-W6-review-fail",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		build() {
			const f = createBaseFixture("S4-W6-review-fail");
			const t1 = f.tasks.createTask(f.projectId, { title: "In-progress work without checks" });
			const t2 = f.tasks.createTask(f.projectId, { title: "Review candidate with failing check" });
			if (!t1.ok || !t2.ok) throw new Error("tasks");
			f.tasks.setStatus(f.projectId, t1.value.id, 0, "in-progress", "active");
			f.tasks.setStatus(f.projectId, t2.value.id, 0, "awaiting-review", "ready for review");
			const head = git(f.repo, ["rev-parse", "HEAD"]);
			recordUnplannedReceipt(f.storeRoot, {
				projectId: f.projectId,
				taskId: t2.value.id,
				repo: f.repo,
				headCommit: head,
				outcome: "failed",
			});
			return f;
		},
	},
	{
		id: "S5-W8-mixed-head",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		build() {
			const f = createBaseFixture("S5-W8-mixed-head");
			const t1 = f.tasks.createTask(f.projectId, { title: "In-progress assigned task without checks" });
			const t2 = f.tasks.createTask(f.projectId, { title: "Task with earlier failing check at prior HEAD" });
			if (!t1.ok || !t2.ok) throw new Error("tasks");
			f.tasks.setStatus(f.projectId, t1.value.id, 0, "in-progress", "active");
			f.tasks.setStatus(f.projectId, t2.value.id, 0, "awaiting-review", "review");
			const oldHead = git(f.repo, ["rev-parse", "HEAD"]);
			recordUnplannedReceipt(f.storeRoot, {
				projectId: f.projectId,
				taskId: t2.value.id,
				repo: f.repo,
				headCommit: oldHead,
				outcome: "failed",
			});
			writeFileSync(join(f.repo, "change.txt"), "new commit\n");
			git(f.repo, ["add", "change.txt"]);
			git(f.repo, ["commit", "-m", "advance HEAD"]);
			const coord = new DevelopCoordinationStoreV0(f.storeRoot);
			coord.createAssignment({
				expectedFileRevision: 0,
				expectedTaskRevision: 1,
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
			});
			return f;
		},
	},
	{
		id: "S6-W9-unplanned-pass",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		build() {
			const f = createBaseFixture("S6-W9-unplanned-pass");
			const t1 = f.tasks.createTask(f.projectId, { title: "In-progress assigned task without checks" });
			const t2 = f.tasks.createTask(f.projectId, { title: "Task with unplanned passing check at HEAD" });
			if (!t1.ok || !t2.ok) throw new Error("tasks");
			f.tasks.setStatus(f.projectId, t1.value.id, 0, "in-progress", "active");
			f.tasks.setStatus(f.projectId, t2.value.id, 0, "awaiting-review", "review");
			const head = git(f.repo, ["rev-parse", "HEAD"]);
			recordUnplannedReceipt(f.storeRoot, {
				projectId: f.projectId,
				taskId: t2.value.id,
				repo: f.repo,
				headCommit: head,
				outcome: "passed",
			});
			const coord = new DevelopCoordinationStoreV0(f.storeRoot);
			coord.createAssignment({
				expectedFileRevision: 0,
				expectedTaskRevision: 1,
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
			});
			return f;
		},
	},
	{
		id: "S7-W10-digest",
		wake: "digest-window",
		actionKind: "generate-advisory-brief",
		permitPartialObservation: false,
		build() {
			return SCENARIOS[5].build();
		},
	},
	{
		id: "S8-multi-agent",
		wake: "on-change",
		actionKind: "emit-operator-proposal",
		permitPartialObservation: false,
		build() {
			const f = createBaseFixture("S8-multi-agent");
			const t1 = f.tasks.createTask(f.projectId, { title: "Builder task with active assignment" });
			const t2 = f.tasks.createTask(f.projectId, { title: "Dependent reviewer task" });
			if (!t1.ok || !t2.ok) throw new Error("tasks");
			f.tasks.setStatus(f.projectId, t1.value.id, 0, "in-progress", "builder active");
			f.tasks.setStatus(f.projectId, t2.value.id, 0, "awaiting-review", "awaiting review");
			const coord = new DevelopCoordinationStoreV0(f.storeRoot);
			const a1 = coord.createAssignment({
				expectedFileRevision: 0,
				expectedTaskRevision: 1,
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
			});
			if (!a1.ok) throw new Error(`a1 failed: ${a1.code}`);
			// Second writer on the same worktree creates an unacknowledged worktree conflict!
			coord.createAssignment({
				expectedFileRevision: 1,
				expectedTaskRevision: 1,
				projectId: f.projectId,
				taskId: t2.value.id,
				participant: { participantId: "reviewer-1", role: "reviewer", intendedHarnessFamily: "codex" },
				workspace: {
					worktreePath: f.repo,
					registration: "project-path",
					accessIntent: "read-write-intended",
					pathHints: [],
					allowSharedWorktree: false,
				},
				targetCandidate: null,
			});
			return f;
		},
	},
];

async function runSingleTurn(scenario, condition) {
	const fixture = scenario.build();
	const nowStart = Date.now();
	const scheduleId = `stage2-${scenario.id}-${condition.id}`.toLowerCase();
	try {
		addEndoAdvisoryScheduleV0(
			fixture.storeRoot,
			{
				scheduleId,
				projectId: fixture.projectId,
				actionKind: scenario.actionKind,
				wake: scenario.wake,
				missedRunPolicy: "skip-and-report",
				label: `${scenario.id}:${condition.id}`,
				trigger: { kind: "once", atMs: nowStart - 1000 },
			},
			() => nowStart - 5000,
		);
		setEndoAdvisoryScheduleEnabledV0(fixture.storeRoot, scheduleId, true, 1, () => nowStart - 4000);
		authorizeEndoAdvisoryScheduleV0(
			fixture.storeRoot,
			{
				scheduleId,
				scheduleRevision: 2,
				pool: POOL,
				policy: {
					permitCapacityUnknown: true,
					permitModelUnconfirmed: true,
					permitPartialObservation: scenario.permitPartialObservation,
					observationSource: "recorded-or-passive-probe",
					recordedObservationMaxAgeMs: 600_000,
				},
				budget: {
					periodMs: 3_600_000,
					maxTurnsPerPeriod: 1,
					completionRequestsPerTurn: 2,
					maxOutputTokensPerRequest: 2048,
					maxGeneratedTokensPerPeriod: 4096,
					maxTurnWallClockMs: 180_000,
				},
				lifetimeMs: 3_600_000,
			},
			() => nowStart - 3000,
		);

		const t0 = performance.now();
		const tick = await runEndoAdvisoryTickV0({
			root: fixture.storeRoot,
			briefingMode: condition.briefingMode,
			visibilityMode: condition.visibilityMode,
		});
		const elapsedMs = Math.round(performance.now() - t0);
		const advStore = new DevelopAdvisoryStoreV0(fixture.storeRoot);
		const turns = advStore.listTurns(Date.now());
		const proposals = advStore.listProposals();
		return {
			scenarioId: scenario.id,
			conditionId: condition.id,
			briefingMode: condition.briefingMode,
			visibilityMode: condition.visibilityMode,
			elapsedMs,
			tick,
			turn: turns.ok ? (turns.entries[0] ?? null) : null,
			proposals: proposals.ok ? proposals.entries : [],
		};
	} finally {
		rmSync(fixture.base, { recursive: true, force: true });
	}
}

async function main() {
	const outPath = join(OUT_DIR, "stage2-paired-live.jsonl");
	const records = [];
	let totalTurns = 0;
	for (let idx = 0; idx < SCENARIOS.length; idx++) {
		const scenario = SCENARIOS[idx];
		const order = ROTATIONS[idx % ROTATIONS.length];
		for (const condId of order) {
			if (totalTurns >= 24) throw new Error("Hard 24-turn ceiling reached");
			const cond = CONDITIONS.find((c) => c.id === condId);
			console.error(`[${totalTurns + 1}/24] Running ${scenario.id} under Condition ${cond.id} (${cond.briefingMode} / ${cond.visibilityMode})...`);
			const rec = await runSingleTurn(scenario, cond);
			totalTurns += 1;
			records.push(rec);
			writeFileSync(outPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
		}
	}
	console.error(`Stage 2 complete: ${totalTurns} bounded turns saved to ${outPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
