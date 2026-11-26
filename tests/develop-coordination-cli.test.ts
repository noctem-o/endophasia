// `endo assign`, `endo dep`, `endo candidate` and `endo coordinator coordination` as real processes over a temporary store and a
// temporary Git repository. No Pi, no model, no network. Every refusal is JSON on stdout with exit 1, and writes nothing.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateEndoCoordinatorCoordinationV0 } from "../protocol/coordinator-coordination.ts";
import { git, haveGit } from "./git-fixtures.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-coordination-cli-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const endo = (args: string[]) =>
	spawnSync(process.execPath, [CLI, ...args], { cwd: base, encoding: "utf8", env: { ...process.env, HOME: base } });
const json = (text: string) => JSON.parse(text) as Record<string, any>;
const run = (args: string[]) => {
	const r = endo(args);
	expect(r.status, r.stderr + r.stdout).toBe(0);
	return json(r.stdout);
};
const refused = (args: string[]) => {
	const r = endo(args);
	expect(r.status, r.stdout).toBe(1);
	return json(r.stdout).refusal as { code: string; detail?: string };
};

describe.skipIf(!haveGit)("endo assign, dep and candidate", () => {
	const repo = join(base, "repo");
	mkdirSync(repo);
	const root = join(base, "store");
	let project = "";
	let build = "";
	let review = "";
	let assignment = "";
	let head = "";

	it("sets up a project and two tasks", () => {
		git(repo, "init", "-q");
		git(repo, "commit", "-q", "--allow-empty", "-m", "init");
		head = git(repo, "rev-parse", "HEAD").trim();
		project = run(["project", "add", root, "--name", "demo", "--path", repo]).project.id;
		build = run(["task", "add", "--root", root, "--project", project, "--title", "build"]).task.id;
		review = run(["task", "add", "--root", root, "--project", project, "--title", "review"]).task.id;
		expect(run(["assign", "list", "--root", root, "--project", project])).toMatchObject({ assignments: [] });
	});

	it("creates an assignment against the file revision, and refuses an overlapping writer", () => {
		const made = run([
			"assign",
			"create",
			"--root",
			root,
			"--project",
			project,
			"--task",
			build,
			"--participant",
			"codex-builder",
			"--role",
			"builder",
			"--harness",
			"codex",
			"--worktree",
			repo,
			"--access",
			"rw",
			"--revision",
			"0",
		]);
		assignment = made.assignment.assignmentId;
		expect(made.assignment).toMatchObject({ state: "active", revision: 1, workspace: { worktreePath: repo } });
		const before = readFileSync(join(root, "develop", "coordination.json"));
		expect(
			refused([
				"assign",
				"create",
				"--root",
				root,
				"--project",
				project,
				"--task",
				build,
				"--participant",
				"other",
				"--role",
				"builder",
				"--worktree",
				repo,
				"--access",
				"rw",
				"--revision",
				"1",
			]).code,
		).toBe("worktree-write-overlap");
		expect(
			refused([
				"assign",
				"create",
				"--root",
				root,
				"--project",
				project,
				"--task",
				build,
				"--participant",
				"late",
				"--role",
				"reviewer",
				"--worktree",
				repo,
				"--access",
				"ro",
				"--revision",
				"0",
			]).code,
		).toBe("stale-revision");
		expect(readFileSync(join(root, "develop", "coordination.json"))).toEqual(before);
		// The task is untouched by an assignment.
		const tasks = json(readFileSync(join(root, "develop", "tasks.json"), "utf8"));
		expect(tasks.tasks.find((t: { id: string }) => t.id === build).status).toBe("open");
	});

	it("refuses a synthetic session source", () => {
		expect(
			refused([
				"assign",
				"bind",
				"--root",
				root,
				"--assignment",
				assignment,
				"--revision",
				"1",
				"--source",
				"test-fake",
				"--session-key",
				"test-fake:persistent:x",
				"--attachment",
				"pi.default",
			]).code,
		).toBe("synthetic-not-admitted");
	});

	it("declares a candidate only by a full object id, and adds a dependency without a cycle", () => {
		expect(
			refused([
				"candidate",
				"declare",
				"--root",
				root,
				"--project",
				project,
				"--task",
				build,
				"--worktree",
				repo,
				"--commit",
				"HEAD",
				"--revision",
				"1",
			]).code,
		).toBe("bad-request");
		const c = run([
			"candidate",
			"declare",
			"--root",
			root,
			"--project",
			project,
			"--task",
			build,
			"--worktree",
			repo,
			"--commit",
			head,
			"--revision",
			"1",
		]);
		expect(c.candidate).toMatchObject({ kind: "git-commit", commitSha: head, worktreePath: repo });
		run([
			"dep",
			"add",
			"--root",
			root,
			"--project",
			project,
			"--dependent",
			review,
			"--prerequisite",
			build,
			"--condition",
			"candidate-has-passing-receipt",
			"--revision",
			"2",
		]);
		expect(
			refused([
				"dep",
				"add",
				"--root",
				root,
				"--project",
				project,
				"--dependent",
				build,
				"--prerequisite",
				review,
				"--condition",
				"operator-task-done",
				"--revision",
				"3",
			]).code,
		).toBe("dependency-cycle");
	});

	it("refuses a protected candidate for an attempt with no protected run", () => {
		const attempt = run([
			"attempt",
			"prepare",
			"--root",
			root,
			"--project",
			project,
			"--task",
			build,
			"--objective",
			"Do it.",
		]);
		const id = attempt.attempt?.id ?? attempt.id;
		expect(typeof id).toBe("string");
		expect(
			refused([
				"candidate",
				"declare-protected",
				"--root",
				root,
				"--project",
				project,
				"--task",
				build,
				"--attempt",
				id,
				"--revision",
				"3",
			]).code,
		).toBe("not-found");
	});

	it("the host projection verifies the candidate and grants nothing", () => {
		const r = endo(["coordinator", "coordination", "--root", root, "--project", project, "--quiet"]);
		expect(r.status, r.stderr).toBe(0);
		const v = validateEndoCoordinatorCoordinationV0(json(r.stdout).coordinatorCoordination);
		expect(v.source).toMatchObject({ state: "ready", revision: 3 });
		expect(v.authority).toMatchObject({ readinessIsPermission: false, assignmentIsAuthorization: false });
		const p = v.projects[0];
		expect(p?.tasks.find((t) => t.taskId === build)?.candidates[0]).toMatchObject({
			identity: "verified",
			workspace: "matches-candidate",
			receipts: "none",
		});
		expect(p?.dependencies[0]).toMatchObject({ satisfaction: "unsatisfied", reasons: ["no-receipt-for-candidate"] });
		expect(p?.tasks.find((t) => t.taskId === review)?.readiness).toBe("waiting");
	});

	it("revoking a writer with no session or execution evidence leaves no hazard", () => {
		const r = run([
			"assign",
			"revoke",
			"--root",
			root,
			"--assignment",
			assignment,
			"--revision",
			"1",
			"--reason",
			"done for now",
		]);
		expect(r.assignment).toMatchObject({ state: "revoked", worktreeHazard: { state: "none" } });
	});
});
