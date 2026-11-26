// COORDINATOR-ASSIGNMENT-002 (E1): the companion coordination projection read by the sandboxed status worker. coordination.json is
// descriptor-pinned like the other files; a store without one reads as absent; an unreadable one is reported and the status still reads;
// Git and protected runs are not reachable in the sandbox, so candidates read `unavailable` and nothing is satisfied on identity.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COORDINATOR_ENV_V0,
	coordinatorBwrapV0,
	readCoordinatorBriefStatusV0,
} from "../adapters/coordinator/status.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { createBriefFixtureV0, fixtureManifestV0 } from "./coordinator-brief-fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-coord-coordination-"));
	dirs.push(dir);
	return dir;
};

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

describe.skipIf(!sandboxAvailable)("the coordination projection in bubblewrap", () => {
	it("a pre-E1 store reads as absent, and the model view is what it was", async () => {
		const dir = scratch();
		const f = createBriefFixtureV0(dir, "healthy");
		const before = fixtureManifestV0(dir);
		const status = await readCoordinatorBriefStatusV0(f.root, f.projectId);
		if (!status.ok) throw new Error(status.reason);
		expect(status.coordination.source).toEqual({ state: "absent", reason: null, revision: null });
		expect(status.coordination.scope.requested).toEqual([f.projectId]);
		expect(JSON.stringify(status.view)).not.toMatch(/coordination|assignment/);
		expect(fixtureManifestV0(dir)).toEqual(before);
	});

	it("reads assignments, dependencies and candidates without writing, and says what it could not verify", async () => {
		const dir = scratch();
		const f = createBriefFixtureV0(dir, "healthy");
		const tasks = new DevelopTasksStoreV0(f.root);
		const read = tasks.read();
		if (!read.ok) throw new Error(read.reason);
		const project = read.file.projects.find((p) => p.id === f.projectId);
		const prerequisite = read.file.tasks.find((t) => t.projectId === f.projectId);
		if (project === undefined || prerequisite === undefined) throw new Error("fixture");
		const made = tasks.createTask(f.projectId, { title: "follow-up" });
		if (!made.ok) throw new Error(made.code);
		const store = new DevelopCoordinationStoreV0(f.root);
		const assignment = store.createAssignment({
			expectedTaskRevision: prerequisite.revision,
			expectedFileRevision: 0,
			projectId: f.projectId,
			taskId: prerequisite.id,
			participant: { participantId: "codex-builder", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: project.path,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		expect(assignment.ok).toBe(true);
		expect(
			store.declareCandidate({
				expectedFileRevision: 1,
				projectId: f.projectId,
				taskId: prerequisite.id,
				candidate: {
					kind: "git-commit",
					commonDir: join(project.path, ".git"),
					worktreePath: project.path,
					commitSha: "1".repeat(40),
					treeSha: "e".repeat(40),
					attemptId: null,
				},
			}).ok,
		).toBe(true);
		expect(
			store.addDependency({
				expectedFileRevision: 2,
				projectId: f.projectId,
				dependentTaskId: made.value.id,
				prerequisiteTaskId: prerequisite.id,
				condition: "candidate-has-passing-receipt",
			}).ok,
		).toBe(true);
		const before = fixtureManifestV0(dir);
		const status = await readCoordinatorBriefStatusV0(f.root, f.projectId);
		if (!status.ok) throw new Error(status.reason);
		const c = status.coordination;
		expect(c.source).toEqual({ state: "ready", reason: null, revision: 3 });
		expect(c.gaps).toEqual(expect.arrayContaining(["git-unavailable", "protected-runs-unavailable"]));
		expect(c.authority).toMatchObject({ readinessIsPermission: false, assignmentIsAuthorization: false });
		const p = c.projects[0];
		expect(p?.assignments.map((a) => a.participantId)).toEqual(["codex-builder"]);
		expect(p?.tasks.find((t) => t.taskId === prerequisite.id)?.candidates[0]?.identity).toBe("unavailable");
		expect(p?.dependencies[0]?.satisfaction).not.toBe("satisfied");
		expect(JSON.stringify(status.view)).not.toMatch(/coordination|assignment|codex-builder/);
		expect(fixtureManifestV0(dir)).toEqual(before);
	});

	it("a symlink is never mounted and cannot suppress the model status", async () => {
		const f = createBriefFixtureV0(scratch(), "healthy");
		symlinkSync("tasks.json", join(f.root, "develop", "coordination.json"));
		const result = await readCoordinatorBriefStatusV0(f.root, f.projectId);
		if (!result.ok) throw new Error(result.reason);
		expect(result.view.projects).toHaveLength(1);
		expect(result.coordination.source).toMatchObject({ state: "unreadable", reason: "unsafe-path" });
	});
	it("an unreadable coordination file is reported and the status still reads", async () => {
		const dir = scratch();
		const f = createBriefFixtureV0(dir, "healthy");
		writeFileSync(join(f.root, "develop", "coordination.json"), "{");
		const status = await readCoordinatorBriefStatusV0(f.root, f.projectId);
		if (!status.ok) throw new Error(status.reason);
		expect(status.coordination.source).toMatchObject({ state: "unreadable", reason: "malformed" });
		expect(status.coordination.gaps).toContain("coordination-unreadable");
		expect(status.view.projects).toHaveLength(1);
	});
});
