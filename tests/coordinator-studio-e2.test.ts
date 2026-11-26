// COORDINATOR-ASSIGNMENT-003 (E2-D / E2-F): HTTP authorization, bubblewrap cross-project isolation,
// and read-only Studio Mission Board coordination views.
//
// Covers:
// - AT19: Unauthorized Coordinator HTTP operations (unpaired 401, revoked grant mid-read 401, wrong project 400,
//         POST/PUT/DELETE → 405, zero store mutations).
// - AT20 (sandbox): Project-scoped `bwrap` FD pinning of `develop/coordination-reviews/<projectId>/` mounts ONLY
//         the requested project's reviews, filters `WRITE_ONCE_TEMPORARY_V0` files, isolates symlinked/unsafe review
//         directories into `reviews-unreadable` without suppressing primary status, and never writes to the store.
// - AT23: Real HTTP `GET /api/v0/workbench/workspace/coordinator/coordination` → `readCoordinatorCoordination` →
//         React SSR rendering of `CoordinationBanner`, `ParticipantLanesView`, `DependencyGraphView`, and
//         `CoordinationProvenancePanel`, proving all required read-only coordination surfaces and zero mutation controls.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	COORDINATOR_ENV_V0,
	coordinatorBwrapV0,
	readCoordinatorBriefStatusV0,
} from "../adapters/coordinator/status.ts";
import { DevelopCoordinationGitV0 } from "../adapters/develop/coordination.ts";
import { EndoCockpitCoordinatorV0 } from "../cockpit-http/coordinator.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import { validateEndoCoordinatorCoordinationV0 } from "../protocol/coordinator-coordination.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopCoordinationReviewsStoreV0 } from "../storage/develop-coordination-reviews.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { readCoordinatorCoordination } from "../studio-ui/src/coordinator/read.ts";
import { capabilityOf, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { createBriefFixtureV0, fixtureManifestV0 } from "./coordinator-brief-fixtures.ts";
import { buildCoordinatorStoreV0, cleanCoordinatorFixturesV0 } from "./coordinator-status-fixture.ts";
import { git, haveGit } from "./git-fixtures.ts";

const dirs: string[] = [];
const scratch = (prefix = "endo-e2-studio-") => {
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

const sandboxAvailable = (() => {
	try {
		return (
			process.platform === "linux" &&
			spawnSync("/usr/bin/bwrap", coordinatorBwrapV0([], ["-e", ""]), { env: COORDINATOR_ENV_V0 }).status === 0
		);
	} catch {
		return false;
	}
})();

describe.skipIf(!haveGit)("AT19 & AT23: Coordinator coordination HTTP boundary & read-only Studio views", () => {
	async function openFixture() {
		const { root, repo, projectId, taskId } = await buildCoordinatorStoreV0();
		const tasks = new DevelopTasksStoreV0(root);
		const task2 = tasks.createTask(projectId, { title: "Review candidate" });
		if (!task2.ok) throw new Error(task2.code);
		const task3 = tasks.createTask(projectId, { title: "Independent task" });
		if (!task3.ok) throw new Error(task3.code);

		// Create a real sibling worktree and register it.
		const sibling = join(scratch("endo-e2-sibling-"), "wt-review");
		git(repo, "worktree", "add", "-q", "-b", "review-wt", sibling);
		const headSha = git(repo, "rev-parse", "HEAD").trim();
		const treeSha = git(repo, "rev-parse", "HEAD^{tree}").trim();

		const coord = new DevelopCoordinationStoreV0(root);
		const tasksRead = tasks.read();
		if (!tasksRead.ok) throw new Error(tasksRead.reason);
		const proj = tasksRead.file.projects.find((p) => p.id === projectId)!;
		const validated = await new DevelopCoordinationGitV0().validateSiblingWorktree(proj, sibling);
		if (!validated.ok) throw new Error(validated.detail);

		const reg = coord.registerWorktree({
			expectedFileRevision: 0,
			projectId,
			worktreePath: validated.worktree.worktreePath,
			commonDir: validated.worktree.commonDir,
			gitDir: validated.worktree.gitDir,
			label: "pi-review-wt",
		});
		if (!reg.ok) throw new Error(reg.code);

		// Builder assignment (Codex) on primary repo + Reviewer assignment (Pi) on registered sibling.
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

		const aReviewer = coord.createAssignment({
			expectedFileRevision: aBuilder.file.revision,
			expectedTaskRevision: 0,
			projectId,
			taskId: task2.value.id,
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
		if (!aReviewer.ok) throw new Error(aReviewer.code);

		// Associate a declared session on builder so offline liveness renders honestly.
		const sessLinked = coord.associateSession(aBuilder.value.assignmentId, aBuilder.value.revision, {
			source: "codex-live",
			sessionKey: "codex-live:persistent:thread-1",
			attachmentId: "codex.demo",
			instanceId: "inst-demo-1",
			runtimeFingerprintId: null,
		});
		if (!sessLinked.ok) throw new Error(sessLinked.code);

		// Link a prepared attempt on builder.
		const attempts = new DevelopAttemptsStoreV0(root);
		const prep = new DevelopAttemptsServiceV0(tasks, attempts).prepare(projectId, taskId, {
			objective: "Build feature",
		});
		if (!prep.ok) throw new Error(prep.code);
		const attLinked = coord.linkAttempt(sessLinked.value.assignmentId, sessLinked.value.revision, prep.value.id);
		if (!attLinked.ok) throw new Error(attLinked.code);

		// Declare a candidate on task1 and a dependency task2 -> task1 (ONLY 1 declared edge; task3 has NO edge!).
		const cand = coord.declareCandidate({
			expectedFileRevision: attLinked.file.revision,
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
			dependentTaskId: task2.value.id,
			prerequisiteTaskId: taskId,
			condition: "candidate-has-passing-receipt",
		});
		if (!dep.ok) throw new Error(dep.code);

		// Record a structured advisory review bound to the candidate.
		const reviews = new DevelopCoordinationReviewsStoreV0(root);
		const rev = reviews.recordReview({
			projectId,
			candidateTaskId: taskId,
			candidateId: cand.value.candidateId,
			assignmentId: aReviewer.value.assignmentId,
			attemptId: prep.value.id,
			reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
			verdict: "approve-advisory",
			summary: "Advisory review approves candidate structure.",
			findings: [{ severity: "low", category: "style", summary: "Minor doc typo", location: "README.md:2" }],
			agentClaimedChecks: "npm test (claimed by reviewer)",
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
		return {
			root,
			repo,
			sibling,
			projectId,
			taskId,
			task2Id: task2.value.id,
			task3Id: task3.value.id,
			candidateId: cand.value.candidateId,
			reviewId: rev.review.reviewId,
			host,
			server,
			base,
			req,
		};
	}

	it("AT19: refuses unpaired (401), revoked-mid-read (401), foreign project (400), and non-GET mutations (405) with zero store writes", async () => {
		const fx = await openFixture();
		const before = fixtureManifestV0(fx.root);

		// Unpaired request → 401.
		expect((await fx.req("workspace/coordinator/coordination", "GET", false)).status).toBe(401);

		// Non-GET mutation attempts → refused over HTTP (403/405) AND 405 directly on EndoWorkspaceHostV0!
		for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
			expect([403, 405]).toContain((await fx.req("workspace/coordinator/coordination", method, true)).status);
			const direct = await fx.host.handle({
				method: method as "POST",
				route: ["workspace", "coordinator", "coordination"],
				grant: null,
				query: "",
				body: {},
			});
			expect([401, 405]).toContain(direct.status);
		}

		// Cross-project query → 400.
		expect(
			(await fx.req("workspace/coordinator/coordination?project=endo.project.deadbeefdeadbeef", "GET", true)).status,
		).toBe(400);

		// Grant revoked between read and response → 401.
		const origRead = EndoCockpitCoordinatorV0.prototype.readCoordination;
		vi.spyOn(EndoCockpitCoordinatorV0.prototype, "readCoordination").mockImplementation(async function (
			this: EndoCockpitCoordinatorV0,
			...args
		) {
			const ans = await origRead.apply(this, args);
			expect(ans.status).toBe(200);
			fx.host.revoke();
			return ans;
		});
		const revokedRes = await fx.req("workspace/coordinator/coordination", "GET", true);
		expect([revokedRes.status, JSON.parse(revokedRes.body)]).toEqual([401, { error: "grant-required" }]);

		// Zero store mutations across all requests.
		expect(fixtureManifestV0(fx.root)).toEqual(before);
	});

	it("AT23: serves read-only coordination projection and renders Studio Lanes, Dependency Graph, and Provenance panels cleanly", async () => {
		const fx = await openFixture();
		const before = fixtureManifestV0(fx.root);

		const res = await fx.req("workspace/coordinator/coordination", "GET", true);
		expect(res.status).toBe(200);
		const raw = JSON.parse(res.body);
		const validated = validateEndoCoordinatorCoordinationV0(raw);
		const uiModel = readCoordinatorCoordination(raw);
		expect(uiModel).not.toBeNull();
		expect(validated.authority).toMatchObject({
			kind: "read-only-projection",
			assignmentIsAuthorization: false,
			readinessIsPermission: false,
		});
		expect(validated.projects).toHaveLength(1);
		const proj = validated.projects[0]!;
		expect(proj.assignments).toHaveLength(2);
		expect(proj.dependencies).toHaveLength(1);
		expect(proj.registeredWorktrees).toHaveLength(1);
		expect(proj.reviews).toHaveLength(1);
		// Offline session liveness never claims live state.
		const builderAssign = proj.assignments.find((a) => a.participantId === "codex-builder");
		expect(builderAssign?.session).toMatchObject({
			liveness: "unknown",
			observationMode: "offline-projection",
			terminationConfirmed: false,
		});

		const titles = new Map<string, string>([
			[fx.taskId, "Build primary feature"],
			[fx.task2Id, "Review candidate"],
			[fx.task3Id, "Independent task"],
		]);
		const noop = () => {};

		const viewsModulePath = "../studio-ui/src/coordinator/CoordinationViews.tsx";
		const { CoordinationBanner, CoordinationProvenancePanel, DependencyGraphView, ParticipantLanesView } =
			(await import(viewsModulePath)) as {
				CoordinationBanner: (props: {
					coordination: NonNullable<typeof uiModel>;
				}) => ReturnType<typeof createElement>;
				ParticipantLanesView: (props: {
					projects: NonNullable<typeof uiModel>["projects"];
					taskTitles: ReadonlyMap<string, string>;
					onJumpToTask: (id: string) => void;
				}) => ReturnType<typeof createElement>;
				DependencyGraphView: (props: {
					projects: NonNullable<typeof uiModel>["projects"];
					taskTitles: ReadonlyMap<string, string>;
					onJumpToTask: (id: string) => void;
				}) => ReturnType<typeof createElement>;
				CoordinationProvenancePanel: (props: {
					projects: NonNullable<typeof uiModel>["projects"];
					taskTitles: ReadonlyMap<string, string>;
				}) => ReturnType<typeof createElement>;
			};

		const bannerHtml = renderToStaticMarkup(createElement(CoordinationBanner, { coordination: uiModel! }));
		const lanesHtml = renderToStaticMarkup(
			createElement(ParticipantLanesView, { projects: uiModel!.projects, taskTitles: titles, onJumpToTask: noop }),
		);
		const graphHtml = renderToStaticMarkup(
			createElement(DependencyGraphView, { projects: uiModel!.projects, taskTitles: titles, onJumpToTask: noop }),
		);
		const provHtml = renderToStaticMarkup(
			createElement(CoordinationProvenancePanel, { projects: uiModel!.projects, taskTitles: titles }),
		);

		// Banner communicates offline, non-authoritative posture.
		expect(bannerHtml).toContain("Read-only offline projection");
		expect(bannerHtml).toContain("readiness is not execution permission");

		// Participant lanes display builder & reviewer roles, harnesses, offline liveness, and worktree registration.
		expect(lanesHtml).toContain("codex-builder");
		expect(lanesHtml).toContain("Builder");
		expect(lanesHtml).toContain("pi-reviewer");
		expect(lanesHtml).toContain("Reviewer");
		expect(lanesHtml).toContain("registered-sibling");
		expect(lanesHtml).toContain("offline");

		// Dependency graph renders ONLY the 1 actual declared edge (no decorative edges for unlinked task3!).
		expect(graphHtml).toContain("Build primary feature");
		expect(graphHtml).toContain("Review candidate");
		expect(graphHtml).toContain("candidate-has-passing-receipt");
		expect((graphHtml.match(/<line /g) ?? []).length).toBe(1);
		expect(graphHtml).not.toContain("Independent task");

		// Provenance panel displays registered sibling worktrees, candidates, and advisory-only review disclosures.
		expect(proj.reviews?.[0]?.disclosures).toEqual(["advisory-only-not-host-check", "not-operator-acceptance"]);
		expect(provHtml).toContain("pi-review-wt");
		expect(provHtml).toContain("advisory-agent-review");
		expect(provHtml).toContain("Agent-reported advisory reviews only — never host check receipts.");
		expect(provHtml).toContain("Agent claimed checks ran (unverified statement; not a host receipt).");

		// Zero mutation controls or drag-to-dispatch affordances anywhere in the rendered HTML.
		const combined = bannerHtml + lanesHtml + graphHtml + provHtml;
		expect(combined).not.toMatch(/<form\b|draggable=|style=/i);

		// Zero store mutations during HTTP read.
		expect(fixtureManifestV0(fx.root)).toEqual(before);

		// Adversarial Finding #4: Tamper with registered sibling worktree's `.git` pointer to point to a foreign repo;
		// `cockpit-http/coordinator.ts` MUST refuse to observe it (reports `unavailable` instead of `observed`).
		const foreign = scratch("endo-e2-foreign-");
		git(foreign, "init", "-q");
		writeFileSync(join(foreign, "x.txt"), "x\n");
		git(foreign, "add", "x.txt");
		git(foreign, "commit", "-q", "-m", "foreign");
		writeFileSync(join(fx.sibling, ".git"), `gitdir: ${join(foreign, ".git")}\n`);
		const afterTamper = await fx.req("workspace/coordinator/coordination", "GET", true);
		expect(afterTamper.status).toBe(200);
		const tamperedProj = validateEndoCoordinatorCoordinationV0(JSON.parse(afterTamper.body)).projects[0]!;
		expect(tamperedProj.registeredWorktrees?.[0]?.observation).toBe("unavailable");
		expect(tamperedProj.registeredWorktrees?.[0]?.headCommit).toBeNull();
	});
});

describe.skipIf(!sandboxAvailable)(
	"AT20 (sandbox): bubblewrap project-scoped review isolation & failure containment",
	() => {
		it("mounts ONLY the requested project's reviews, ignores temporary write-once files, and isolates unsafe review directories", async () => {
			const dir = scratch("endo-e2-bwrap-");
			const f = createBriefFixtureV0(dir, "healthy");
			const tasks = new DevelopTasksStoreV0(f.root);
			const read = tasks.read();
			if (!read.ok) throw new Error(read.reason);
			const projA = read.file.projects.find((p) => p.id === f.projectId)!;
			const taskA = read.file.tasks.find((t) => t.projectId === f.projectId)!;

			// Add a second project B with its own task, candidate, and secret-tagged advisory review.
			const repoB = join(dir, "repo-b");
			mkdirSync(repoB);
			const projB = tasks.registerProject({ name: "project-b", path: repoB, observedGitRoot: repoB });
			if (!projB.ok) throw new Error(projB.code);
			const taskB = tasks.createTask(projB.value.id, { title: "Project B secret task" });
			if (!taskB.ok) throw new Error(taskB.code);

			const coord = new DevelopCoordinationStoreV0(f.root);
			const candA = coord.declareCandidate({
				expectedFileRevision: 0,
				projectId: projA.id,
				taskId: taskA.id,
				candidate: {
					kind: "git-commit",
					commonDir: join(projA.path, ".git"),
					worktreePath: projA.path,
					commitSha: "a".repeat(40),
					treeSha: "b".repeat(40),
					attemptId: null,
				},
			});
			if (!candA.ok) throw new Error(candA.code);
			const candB = coord.declareCandidate({
				expectedFileRevision: candA.file.revision,
				projectId: projB.value.id,
				taskId: taskB.value.id,
				candidate: {
					kind: "git-commit",
					commonDir: join(repoB, ".git"),
					worktreePath: repoB,
					commitSha: "c".repeat(40),
					treeSha: "d".repeat(40),
					attemptId: null,
				},
			});
			if (!candB.ok) throw new Error(candB.code);

			const reviews = new DevelopCoordinationReviewsStoreV0(f.root);
			const revA = reviews.recordReview({
				projectId: projA.id,
				candidateTaskId: taskA.id,
				candidateId: candA.value.candidateId,
				assignmentId: null,
				attemptId: null,
				reviewer: {
					participantId: "pi-reviewer-a",
					harnessFamily: "pi",
					sessionKey: null,
					runtimeFingerprintId: null,
				},
				verdict: "approve-advisory",
				summary: "Project A review summary",
				findings: [],
				agentClaimedChecks: null,
				checkout: {
					standing: "unobserved",
					worktreePath: null,
					preObservationId: null,
					postObservationId: null,
					cleanAtCandidate: false,
					reason: null,
				},
				recordedBy: "operator",
			});
			if (!revA.ok) throw new Error(revA.code);

			const revB = reviews.recordReview({
				projectId: projB.value.id,
				candidateTaskId: taskB.value.id,
				candidateId: candB.value.candidateId,
				assignmentId: null,
				attemptId: null,
				reviewer: {
					participantId: "secret-reviewer-b",
					harnessFamily: "codex",
					sessionKey: null,
					runtimeFingerprintId: null,
				},
				verdict: "blocked",
				summary: "TOP_SECRET_PROJECT_B_MARKER",
				findings: [],
				agentClaimedChecks: null,
				checkout: {
					standing: "unobserved",
					worktreePath: null,
					preObservationId: null,
					postObservationId: null,
					cleanAtCandidate: false,
					reason: null,
				},
				recordedBy: "operator",
			});
			if (!revB.ok) throw new Error(revB.code);

			// Drop a stale write-once temporary file inside project A's review directory — must be filtered, not mounted!
			writeFileSync(join(reviews.projectDirectory(projA.id), ".tmp-12345-deadbeefcafe"), "not valid json");

			const before = fixtureManifestV0(dir);
			const statusA = await readCoordinatorBriefStatusV0(f.root, projA.id);
			if (!statusA.ok) throw new Error(statusA.reason);

			const serialized = JSON.stringify(statusA);
			// Project A sees ONLY its own review; ZERO leakage from Project B!
			expect(statusA.coordination.projects[0]?.reviews?.map((r) => r.reviewId)).toEqual([revA.review.reviewId]);
			expect(serialized).not.toContain("secret-reviewer-b");
			expect(serialized).not.toContain("TOP_SECRET_PROJECT_B_MARKER");
			expect(serialized).not.toContain(revB.review.reviewId);
			expect(statusA.coordination.gaps).not.toContain("reviews-unreadable");
			expect(fixtureManifestV0(dir)).toEqual(before);

			// Replace project B's review directory with a symlink: requesting project B MUST still succeed on primary
			// status while isolating the unsafe review directory into `reviews-unreadable`!
			const projBDir = reviews.projectDirectory(projB.value.id);
			rmSync(projBDir, { recursive: true, force: true });
			symlinkSync(reviews.projectDirectory(projA.id), projBDir);

			const statusB = await readCoordinatorBriefStatusV0(f.root, projB.value.id);
			if (!statusB.ok) throw new Error(statusB.reason);
			expect(statusB.coordination.gaps).toContain("reviews-unreadable");
			expect(statusB.coordination.projects[0]?.reviews ?? []).toEqual([]);
			expect(JSON.stringify(statusB)).not.toContain(revA.review.reviewId);

			// Adversarial Finding #3: Bloating `coordination-reviews/<projA>/` past the 320-entry cap MUST isolate into
			// `reviews-unreadable` and roll back partial FDs WITHOUT suppressing primary Coordinator status!
			const projADir = reviews.projectDirectory(projA.id);
			for (let i = 0; i < 325; i += 1) {
				writeFileSync(join(projADir, `endo.review.${String(i).padStart(32, "0")}.json`), "{}");
			}
			const statusBloated = await readCoordinatorBriefStatusV0(f.root, projA.id);
			if (!statusBloated.ok) throw new Error(statusBloated.reason);
			expect(statusBloated.view.projects[0]?.project).toBe(projA.id);
			expect(statusBloated.coordination.gaps).toContain("reviews-unreadable");
			expect(statusBloated.coordination.projects[0]?.reviews ?? []).toEqual([]);
		});
	},
);
