// A real DEVELOP store and Git repository on disk for the Coordinator status tests (tests/coordinator-status.test.ts,
// tests/openclaw-endophasia-status.test.ts): one project, one task moved to review by the operator, one attempt with a passing check
// recorded at HEAD, and an event log holding one session (started a minute ago, a run open) that no record links to the task.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runCheckV0 } from "../adapters/develop/check-runner.ts";
import { readEndoCoordinatorStatusV0 } from "../adapters/develop/coordinator-status.ts";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopReceiptsServiceV0 } from "../runtime/contracts/develop-receipts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { receiptAt, seedAttention, taskIn } from "./studio-attention-fixtures.ts";

const roots: string[] = [];

export function coordinatorTempDirV0(prefix: string): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(d);
	return d;
}

export function cleanCoordinatorFixturesV0(): void {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test Operator",
	GIT_AUTHOR_EMAIL: "operator@example.test",
	GIT_COMMITTER_NAME: "Test Operator",
	GIT_COMMITTER_EMAIL: "operator@example.test",
};
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
const sink = () => new Writable({ write: (_c, _e, cb) => cb() });

function event(
	sequence: number,
	kind: string,
	sessionId: string,
	atMs: number,
	payload: Record<string, unknown>,
): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: `endo.event.${sequence.toString(16).padStart(32, "0")}`,
		kind,
		source: "interpretation",
		sequence,
		at: new Date(atMs).toISOString(),
		coordinates: { sessionId },
		producer: "endo.test",
		derivedFrom: [],
		payload: payload as never,
	};
}

export const COORDINATOR_FIXTURE_SESSION_V0 = "endo.session.pi.disk-0001";

export async function buildMissionBoardFixtureV0() {
	const root = coordinatorTempDirV0("endo-board-store-");
	const repo = coordinatorTempDirV0("endo-board-project-");
	const empty = coordinatorTempDirV0("endo-board-empty-");
	const now = Date.UTC(2026, 10, 23, 12);
	git(repo, ["init", "-q", "-b", "main"]);
	const tasks = new DevelopTasksStoreV0(root);
	const project = tasks.registerProject({ name: "Parser instrumentation", path: repo, observedGitRoot: repo });
	const emptyProject = tasks.registerProject({ name: "New research project", path: empty, observedGitRoot: null });
	if (!project.ok || !emptyProject.ok) throw new Error("project registration refused");
	const { id } = project.value;
	const head = { commit: "c".repeat(40), commonDir: join(repo, ".git"), worktree: repo, clean: true };
	const seeded = seedAttention(root, id, head);
	taskIn(root, id, "<img src=x onerror=window.boardInjected=true>", "open");
	const task = new DevelopAttemptsServiceV0(tasks, new DevelopAttemptsStoreV0(root));
	const receiptStore = new DevelopReceiptsStoreV0(root);
	const addFailed = (title: string, commit: string) => {
		const taskId = taskIn(root, id, title, "review");
		const made = task.prepare(id, taskId, { objective: "Check parser behavior" });
		if (!made.ok) throw new Error("attempt refused");
		const receipt = receiptAt({ ...head, commit }, made.value.id, id, now - 600_000, {
			execution: { kind: "exited", code: 1 },
		});
		if (receiptStore.write(receipt) !== "created") throw new Error("receipt refused");
	};
	addFailed("Stream partial tokens", head.commit);
	addFailed("Retain source offsets", "f".repeat(40));
	const file = tasks.read();
	if (!file.ok) throw new Error("tasks refused");
	const events = createEndoDurableEventStoreV0(root);
	for (const [i, [sid, offset, taskId]] of [
		["endo.session.pi.board-active", 120_000, seeded.tasks.regressed],
		["endo.session.pi.board-stale", 3_600_000, seeded.tasks.decide],
		["endo.session.pi.board-unknown", 30_000, undefined],
	].entries()) {
		if (typeof sid !== "string" || typeof offset !== "number") throw new Error("bad session fixture");
		const started = event(i * 2 + 1, "lifecycle.session-started", sid, now - offset, {
			runtime: "pi",
			runtimeSessionId: sid,
			instance: sid,
			unavailable: [],
		});
		events.ingest({ ...started, source: "runtime-fact", kind: "harness.attached" });
		events.ingest({
			...started,
			id: `endo.event.${(i * 2 + 2).toString(16).padStart(32, "0")}`,
			sequence: i * 2 + 2,
			derivedFrom: [started.id],
		});
		if (typeof taskId !== "string") continue;
		const saved = file.file.tasks.find((candidate) => candidate.id === taskId);
		if (
			saved === undefined ||
			!tasks.linkSession(id, taskId, saved.revision, {
				source: "pi-live",
				sessionId: sid,
				attachment: "fixture",
				launchId: "f".repeat(16),
				linkedBy: "operator",
				via: "workbench",
			}).ok
		)
			throw new Error("link refused");
	}
	events.close();
	const status = await readEndoCoordinatorStatusV0({
		root,
		projects: [id, emptyProject.value.id],
		now: () => now,
		current: async (directory) => (directory === repo ? head : null),
	});
	return { root, repo, projectId: id, status };
}

export async function buildCoordinatorStoreV0(options: { checkArgv?: string[]; repeatWithFailure?: boolean } = {}) {
	const root = coordinatorTempDirV0("endo-coord-store-");
	const repo = coordinatorTempDirV0("endo-coord-repo-");
	git(repo, ["init", "-q", "-b", "main"]);
	const flag = join(root, "test-check-failure");
	writeFileSync(
		join(repo, "ok.mjs"),
		options.repeatWithFailure
			? `import { existsSync } from "node:fs"; process.exit(existsSync(${JSON.stringify(flag)}) ? 1 : 0);\n`
			: "process.exit(0);\n",
	);
	git(repo, ["add", "ok.mjs"]);
	git(repo, ["commit", "-qm", "initial"]);
	const tasks = new DevelopTasksStoreV0(root);
	const attempts = new DevelopAttemptsStoreV0(root);
	const proj = tasks.registerProject({ name: "Disk Demo", path: repo, observedGitRoot: repo });
	if (!proj.ok) throw new Error(proj.code);
	const added = tasks.createTask(proj.value.id, {
		title: "Make ok.mjs succeed",
		description: "",
		acceptance: "exits 0",
	});
	if (!added.ok) throw new Error(added.code);
	const prepared = new DevelopAttemptsServiceV0(tasks, attempts).prepare(proj.value.id, added.value.id, {
		objective: "Keep it passing",
	});
	if (!prepared.ok) throw new Error(prepared.code);
	const receipts = new DevelopReceiptsServiceV0(tasks, attempts, new DevelopReceiptsStoreV0(root), {
		observe: (directory, opts) => new GitRevisionObserverV0().observe(directory, opts),
		run: runCheckV0,
		version: "0.1.0-test",
	});
	const plan = await receipts.plan(prepared.value.id, { argv: options.checkArgv ?? ["node", "ok.mjs"], cwd: repo });
	if (!plan.ok) throw new Error(plan.code);
	const ran = await receipts.run(plan.plan, { stdout: sink(), stderr: sink() });
	if (ran.written !== "created" || ran.receipt.outcome !== "passed") throw new Error("check did not pass");
	let failedReceiptPath: string | undefined;
	if (options.repeatWithFailure) {
		writeFileSync(flag, "");
		const repeated = await receipts.plan(prepared.value.id, {
			argv: options.checkArgv ?? ["node", "ok.mjs"],
			cwd: repo,
		});
		if (!repeated.ok) throw new Error(repeated.code);
		const failed = await receipts.run(repeated.plan, { stdout: sink(), stderr: sink() });
		if (
			failed.written !== "created" ||
			failed.receipt.outcome !== "failed" ||
			failed.receipt.revision.commit !== ran.receipt.revision.commit
		)
			throw new Error("repeat did not record a failure at the same HEAD");
		failedReceiptPath = join(root, "develop", "receipts", prepared.value.id, `${failed.receipt.id}.json`);
	}
	let rev = added.value.revision;
	for (const to of ["in-progress", "review"] as const) {
		const moved = tasks.setStatus(proj.value.id, added.value.id, rev, to, null);
		if (!moved.ok) throw new Error(moved.code);
		rev = moved.value.revision;
	}
	const events = createEndoDurableEventStoreV0(root);
	const now = Date.now();
	const sid = COORDINATOR_FIXTURE_SESSION_V0;
	events.ingest(
		event(1, "lifecycle.session-started", sid, now - 60_000, {
			runtime: "pi",
			runtimeSessionId: "disk-0001",
			instance: "inst-1",
			unavailable: [],
		}),
	);
	events.ingest(event(2, "lifecycle.run-started", sid, now - 30_000, { instance: "inst-1" }));
	events.close();
	return { root, repo, projectId: proj.value.id, taskId: added.value.id, revision: rev, failedReceiptPath };
}
