// COORDINATOR-STUDIO-F1-002: End-to-end real-browser verification of Coordinator Studio F1
// against the real workspace host, real S1/S2 stores, and real built Studio UI bundle.
//
// Exercises:
// - Full pairing flow + Board (`List`), `Attention`, `Lanes`, `Graph`, `Resources`, `Schedules`, `Advisory` views
// - Desktop (1440x900) and narrow (768x900) viewports in Instrument and Field appearances with zero horizontal overflow
// - Auto-refresh opt-in toggle (OFF by default, toggles cleanly to 30s and back OFF)
// - Prohibited-route sentinel HTTP server proving ZERO model wakes or probes across all browser interactions
// - Unavailable operations state (HTTP 503) and revoked-grant auth-lost state (HTTP 401 -> unpaired)
// - Optional PNG screenshot capture when `ENDO_STUDIO_F1_SHOTS=<dir>` is set

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../adapters/develop/advisory-tick.ts";
import { DevelopCoordinationGitV0 } from "../adapters/develop/coordination.ts";
import { endoStartOnDevelopV0 } from "../cockpit-http/host.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import { parseEndoCoordinatorModelPoolV0 } from "../protocol/coordinator-model-pool.ts";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
} from "../protocol/develop-automation.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopAutomationStoreV0 } from "../storage/develop-automation.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopCoordinationReviewsStoreV0 } from "../storage/develop-coordination-reviews.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { Browser, findBrowser } from "./cockpit-browser.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { buildCoordinatorStoreV0, cleanCoordinatorFixturesV0 } from "./coordinator-status-fixture.ts";
import { git, haveGit } from "./git-fixtures.ts";

const executable = findBrowser();
const requireBrowser = process.env.ENDO_REQUIRE_BROWSER === "1";
const board = "[data-testid=coordinator-workspace]";

let browser: Browser | undefined;
let ui: ReturnType<typeof endoStartOnDevelopV0>;
const dirs: string[] = [];

const scratch = (prefix = "endo-f1-browser-") => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};

describe.skipIf(!haveGit || (executable === null && !requireBrowser))(
	"Coordinator Studio F1 live browser end-to-end verification",
	() => {
		beforeAll(async () => {
			if (executable === null) throw new Error("ENDO_REQUIRE_BROWSER=1 but no Chromium was found");
			const { ensureSharedStudioUiDir } = await import("./helpers/studio-ui-build.ts");
			ui = endoStartOnDevelopV0(loadEndoStudioUiFilesV0(await ensureSharedStudioUiDir()));
			browser = await Browser.launch(executable);
		}, 90_000);

		afterAll(async () => {
			await browser?.close();
			await stopServers();
			cleanCoordinatorFixturesV0();
			for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		});

		it("renders deterministic Attention, Resources, Schedules, and Advisory views across viewports with zero model wakes and honest degraded/auth-lost states", async () => {
			let sentinelHits = 0;
			const sentinel = createServer((_req, res) => {
				sentinelHits += 1;
				res.writeHead(500);
				res.end("prohibited");
			});
			await new Promise<void>((resolve) => sentinel.listen(0, "127.0.0.1", () => resolve()));
			const sentinelPort = (sentinel.address() as { port: number }).port;

			try {
				const { root, repo, projectId, taskId } = await buildCoordinatorStoreV0();
				const tasks = new DevelopTasksStoreV0(root);
				const nowMs = Date.now();
				const now = () => nowMs;

				const tReview = tasks.createTask(projectId, { title: "Verify candidate checkout receipts" });
				if (!tReview.ok) throw new Error(tReview.code);
				const tRevIn = tasks.setStatus(projectId, tReview.value.id, 0, "in-progress", null);
				if (!tRevIn.ok) throw new Error(tRevIn.code);
				const tRev = tasks.setStatus(projectId, tReview.value.id, tRevIn.value.revision, "review", null);
				if (!tRev.ok) throw new Error(tRev.code);

				const tBlocked = tasks.createTask(projectId, { title: "Migrate legacy event cursor" });
				if (!tBlocked.ok) throw new Error(tBlocked.code);
				const tBlk = tasks.setStatus(projectId, tBlocked.value.id, 0, "blocked", null);
				if (!tBlk.ok) throw new Error(tBlk.code);

				// Second unrelated Project B (must never render anywhere!)
				const repoB = join(scratch("endo-f1-b-"), "proj-b");
				mkdirSync(repoB);
				const projB = tasks.registerProject({ name: "SECRET_BROWSER_PROJ_B", path: repoB, observedGitRoot: repoB });
				if (!projB.ok) throw new Error(projB.code);
				tasks.createTask(projB.value.id, { title: "SECRET_BROWSER_TASK_B" });

				const sibling = join(scratch("endo-f1-sib-"), "wt-review");
				git(repo, "worktree", "add", "-q", "-b", "f1-browser-wt", sibling);
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
				const a1 = coord.createAssignment({
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
				if (!a1.ok) throw new Error(a1.code);
				const aEnded = coord.createAssignment({
					expectedFileRevision: a1.file.revision,
					expectedTaskRevision: tBlk.value.revision,
					projectId,
					taskId: tBlocked.value.id,
					participant: { participantId: "codex-migrator", role: "builder", intendedHarnessFamily: "codex" },
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
				const aSess = coord.associateSession(aEnded.value.assignmentId, aEnded.value.revision, {
					source: "codex-live",
					sessionKey: "codex-live:persistent:ended-demo",
					attachmentId: "codex.demo",
					instanceId: "inst-1",
					runtimeFingerprintId: null,
				});
				if (!aSess.ok) throw new Error(aSess.code);
				const aRevoked = coord.endAssignment(
					aSess.value.assignmentId,
					aSess.value.revision,
					"revoked",
					"ended before confirming exit",
				);
				if (!aRevoked.ok) throw new Error(aRevoked.code);

				const prep = new DevelopAttemptsServiceV0(tasks, new DevelopAttemptsStoreV0(root)).prepare(
					projectId,
					taskId,
					{
						objective: "Implement feature",
					},
				);
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

				new DevelopCoordinationReviewsStoreV0(root).recordReview({
					projectId,
					candidateTaskId: taskId,
					candidateId: cand.value.candidateId,
					assignmentId: null,
					attemptId: prep.value.id,
					reviewer: {
						participantId: "pi-reviewer",
						harnessFamily: "pi",
						sessionKey: null,
						runtimeFingerprintId: null,
					},
					verdict: "changes-requested",
					summary: "Guard monotonic clock before publish.",
					findings: [
						{ severity: "high", category: "correctness", summary: "Missing clock guard", location: "tick.ts:1" },
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

				// S1 stale resources + enabled schedule + completed & incomplete fire
				const s1 = new DevelopAutomationStoreV0(root, { now });
				s1.addSchedule({
					scheduleId: "obs-local-health",
					label: "Passive local model health",
					actionKind: "observe-health",
					missedRunPolicy: "skip-and-report",
					trigger: { kind: "interval", everyMs: 300_000, anchorMs: nowMs - 600_000 },
				});
				s1.setScheduleEnabled("obs-local-health", true, 1);
				const staleAt = nowMs - 900_000;
				s1.withAutomationLockSync((s) => {
					s.writeLease({
						schemaVersion: ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
						holderId: "endo.s1.browser",
						epoch: 2,
						acquiredAtMs: staleAt,
						expiresAtMs: staleAt + 60_000,
						releasedAtMs: staleAt + 2_000,
					});
					s.writeResources({
						schemaVersion: ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
						leaseEpoch: 2,
						holderId: "endo.s1.browser",
						observedAtMs: staleAt,
						publishedAtMs: staleAt + 200,
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
									observedAtMs: staleAt,
									staleAfterMs: 300_000,
									elapsedMs: 14,
									readiness: "capacity-unknown",
									detail: "slots-not-observable",
									backend: "llama.cpp-router",
									build: "b7012-abcdef1",
									requests: [{ path: "/health", status: 200 }],
									deviceId: null,
									inferenceTokens: 0,
								},
							],
						},
						providers: [],
						sessions: [],
						worktrees: [],
						hardware: { mode: "passive-host-os-only", observedAtMs: staleAt, staleAfterMs: 300_000, devices: [] },
						projectionSummary: null,
					});
					s.writeFireClaimOnce({
						schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
						idempotencyKey: "1".repeat(64),
						scheduleId: "obs-local-health",
						scheduleRevision: 2,
						actionKind: "observe-health",
						triggerKind: "interval",
						triggerCursor: `interval:300000:${nowMs - 600_000}`,
						windowStartMs: nowMs - 600_000,
						missedWindowsBefore: 0,
						claimedAtMs: nowMs - 600_000,
						leaseEpoch: 2,
						holderId: "endo.s1.browser",
					});
					s.writeFireOutcomeOnce({
						schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
						idempotencyKey: "1".repeat(64),
						scheduleId: "obs-local-health",
						scheduleRevision: 2,
						actionKind: "observe-health",
						windowStartMs: nowMs - 600_000,
						completedAtMs: nowMs - 599_000,
						leaseEpoch: 2,
						holderId: "endo.s1.browser",
						status: "completed",
						missedWindowCount: 0,
						observationDigest: "b".repeat(64),
						detail: "passive observation recorded",
						tokensConsumed: 0,
					});
					s.writeFireClaimOnce({
						schemaVersion: ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
						idempotencyKey: "2".repeat(64),
						scheduleId: "obs-local-health",
						scheduleRevision: 2,
						actionKind: "observe-health",
						triggerKind: "interval",
						triggerCursor: `interval:300000:${nowMs - 600_000}`,
						windowStartMs: nowMs - 300_000,
						missedWindowsBefore: 0,
						claimedAtMs: nowMs - 300_000,
						leaseEpoch: 2,
						holderId: "endo.s1.browser",
					});
				});

				// S2 disabled schedule + historical refusal on Project A
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
				addEndoAdvisoryScheduleV0(
					root,
					{
						scheduleId: "adv-alpha",
						label: "Alpha Advisory Digest",
						projectId,
						actionKind: "generate-advisory-brief",
						wake: "on-change",
						missedRunPolicy: "skip-and-report",
						trigger: { kind: "interval", everyMs: 3_600_000, anchorMs: nowMs - 3_600_000 },
					},
					now,
				);
				setEndoAdvisoryScheduleEnabledV0(root, "adv-alpha", true, 1, now);
				authorizeEndoAdvisoryScheduleV0(
					root,
					{
						scheduleId: "adv-alpha",
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
						elapsedMs: 3,
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
						runtime: {
							harness: "OpenClaw 2026.11.10",
							provider: "llama.cpp",
							model: "Inkling-2-Mini-Uncensored-AD-Q4_K",
						},
						availability: "unavailable",
						reason: "generation-limit",
					}),
				});
				setEndoAdvisoryScheduleEnabledV0(root, "adv-alpha", false, 2, now);

				const service = new DevelopWorkspaceServiceV0(tasks);
				const host = new EndoWorkspaceHostV0({
					open: (facts) => service.forLaunch({ projectId, launchDirectory: repo }, facts),
				});
				const server = await serve(root, { ui, workbench: host, readBudget: { duty: 1, burstMs: 1e6 } });

				const shotDir = process.env.ENDO_STUDIO_F1_SHOTS;
				if (shotDir) mkdirSync(shotDir, { recursive: true });
				const snap = async (page: Awaited<ReturnType<Browser["open"]>>, name: string) => {
					if (!shotDir) return;
					await page.eval("document.fonts.ready.then(() => true)");
					await page.eval("window.scrollTo({ top: 0, behavior: 'instant' })");
					writeFileSync(join(shotDir, `${name}.png`), await page.screenshot());
				};

				const page = await browser!.open(1440, 900);
				await page.goto(`${server.baseUrl}/`);
				await page.waitFor("document.querySelector('[data-testid=pair-code]')");
				await page.eval(`(() => {
					const el = document.querySelector('[data-testid=pair-code]');
					Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(host.issuePairingCode().code)});
					el.dispatchEvent(new Event('input', { bubbles: true }));
				})()`);
				await page.click("[data-testid=pair-submit]");
				await page.waitFor("!document.querySelector('[data-testid=pair-code]')");
				await page.click("[data-workspace=coordinator]");
				await page.waitFor(`document.querySelector('${board}[data-state=ready]')`);

				// Verify default Auto-refresh is OFF and toggles cleanly
				expect(await page.text("[data-testid=coordinator-auto-refresh]")).toContain("Auto-refresh: Off");
				await page.click("[data-testid=coordinator-auto-refresh]");
				expect(await page.text("[data-testid=coordinator-auto-refresh]")).toContain("Auto-refresh: 30s");
				await page.click("[data-testid=coordinator-auto-refresh]");
				expect(await page.text("[data-testid=coordinator-auto-refresh]")).toContain("Auto-refresh: Off");
				await snap(page, "01-desktop-board-list");

				// Switch to Attention view
				await page.click("[data-testid=coordinator-view-attention]");
				await page.waitFor("document.querySelector('[data-testid=coordinator-attention-view]')");
				const attnText = await page.text(board);
				expect(attnText).toContain("endo.coordinator-attention-rules.v1");
				expect(attnText).toContain("R1-LIVENESS-UNVERIFIED");
				expect(attnText).toContain("R2-ADVISORY-REVIEW-CHANGES");
				expect(attnText).toContain("R2-UNSATISFIED-DEPENDENCY");
				expect(attnText).not.toContain("SECRET_BROWSER_PROJ_B");
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "02-desktop-attention");

				// Switch to Resources view
				await page.click("[data-testid=coordinator-view-resources]");
				await page.waitFor("document.querySelector('[data-testid=coordinator-resources-view]')");
				const resText = await page.text(board);
				expect(resText).toContain("liveProbed: false");
				expect(resText).toContain("Healthy ≠ free capacity");
				expect(resText).toContain("Inkling-2-Mini-Uncensored-AD-Q4_K");
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "03-desktop-resources");

				// Switch to Schedules view
				await page.click("[data-testid=coordinator-view-schedules]");
				await page.waitFor("document.querySelector('[data-testid=coordinator-schedules-view]')");
				const schedText = await page.text(board);
				expect(schedText).toContain("executesSchedules: false");
				expect(schedText).toContain("obs-local-health");
				expect(schedText).toContain("claimed-incomplete");
				expect(schedText).toContain("adv-alpha");
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "04-desktop-schedules");

				// Switch to Advisory view
				await page.click("[data-testid=coordinator-view-advisory]");
				await page.waitFor("document.querySelector('[data-testid=coordinator-advisory-view]')");
				const advText = await page.text(board);
				expect(advText).toContain("Untrusted model interpretation");
				expect(advText).toContain("generation-limit");
				expect(advText).toContain("deferred to F2");
				expect(await page.eval("document.querySelectorAll('form').length")).toBe(0);
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "05-desktop-advisory");

				// Field mode + Attention view
				await page.click("[data-testid=appearance-field]");
				await page.click("[data-testid=coordinator-view-attention]");
				await page.waitFor(`document.querySelector('${board}[data-appearance=field]')`);
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "06-desktop-field-attention");

				// Narrow viewport (768x900) in Instrument mode
				await page.click("[data-testid=appearance-instrument]");
				await page.resize(768, 900);
				await page.waitFor("document.querySelector('[data-testid=coordinator-attention-view]')");
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "07-narrow-attention");
				await page.click("[data-testid=coordinator-view-resources]");
				await page.waitFor("document.querySelector('[data-testid=coordinator-resources-view]')");
				expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
				await snap(page, "08-narrow-resources");

				// Auth-lost state (grant revoked on host -> next Refresh transitions cleanly to unpaired and clears data!)
				await page.resize(1440, 900);
				host.revoke();
				await page.click("[data-testid=coordinator-refresh]");
				await page.waitFor(`document.querySelector('${board}[data-state=unpaired]')`);
				expect(await page.text(board)).not.toContain("Inkling-2-Mini-Uncensored-AD-Q4_K");
				await snap(page, "09-auth-lost-unpaired");

				// Zero hits to prohibited sentinel server across entire live browser session!
				expect(sentinelHits).toBe(0);
			} finally {
				await new Promise<void>((resolve) => sentinel.close(() => resolve()));
			}
		}, 90_000);
	},
);
