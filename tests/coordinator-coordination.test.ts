// COORDINATOR-ASSIGNMENT-002 (E1): the read-only companion projection, through the real gatherer over real stores. Readiness is computed
// from closed codes only; a candidate's receipts are bound to its exact (commonDir, commit, tree); nothing here grants anything.
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type EndoCoordinatorCoordinationV0,
	validateEndoCoordinatorCoordinationV0,
} from "../protocol/coordinator-coordination.ts";
import type { EndoCandidateRefV0 } from "../protocol/develop-coordination.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { endoWorktreeConflictsV0 } from "../runtime/contracts/develop-coordination.ts";
import { readEndoCoordinatorCoordinationV0 } from "../storage/coordinator-coordination.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopCoordinationStoreV0, type EndoCoordinationResultV0 } from "../storage/develop-coordination.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { receiptAt } from "./studio-attention-fixtures.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PATH = "/work/demo";
const COMMON = "/work/demo/.git";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const TREE = "e".repeat(40);
const T0 = Date.UTC(2026, 10, 1);
const AT: EndoReceiptCurrentV0 = { worktree: PATH, commonDir: COMMON, commit: C1, clean: true };

const ok = <T>(r: EndoCoordinationResultV0<T> | { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(`refused: ${r.code}`);
	return r.value;
};

function world() {
	const root = mkdtempSync(join(tmpdir(), "endo-coordination-view-"));
	roots.push(root);
	const tasks = new DevelopTasksStoreV0(root);
	const project = ok(tasks.registerProject({ name: "demo", path: PATH, observedGitRoot: PATH }));
	const build = ok(tasks.createTask(project.id, { title: "build" }));
	const review = ok(tasks.createTask(project.id, { title: "review" }));
	const store = new DevelopCoordinationStoreV0(root);
	const service = new DevelopAttemptsServiceV0(tasks, new DevelopAttemptsStoreV0(root));
	const receipts = new DevelopReceiptsStoreV0(root);
	const rev = () => {
		const read = store.read();
		if (!read.ok) throw new Error(read.reason);
		return read.file.revision;
	};
	const attempt = (taskId: string) => ok(service.prepare(project.id, taskId, { objective: "Do it." })).id;
	const candidate = (commitSha: string, attemptId: string | null = null) =>
		ok(
			store.declareCandidate({
				expectedFileRevision: rev(),
				projectId: project.id,
				taskId: build.id,
				candidate: {
					kind: "git-commit",
					commonDir: COMMON,
					worktreePath: PATH,
					commitSha,
					treeSha: TREE,
					attemptId,
				},
			}),
		);
	const depend = (
		condition: "operator-task-done" | "candidate-has-passing-receipt" | "operator-decision" | "candidate-declared",
	) =>
		ok(
			store.addDependency({
				expectedFileRevision: rev(),
				projectId: project.id,
				dependentTaskId: review.id,
				prerequisiteTaskId: build.id,
				condition,
			}),
		);
	/** A receipt of `npm test` that exited `code`, observed at `commit` (tree TREE unless given). */
	const ran = (attemptId: string, commit: string, code: number, tree = TREE) => {
		const r = receiptAt({ ...AT, commit }, attemptId, project.id, T0, { execution: { kind: "exited", code } });
		const receipt = { ...r, revision: { ...r.revision, tree }, after: { ...r.after, tree } };
		expect(receipts.write(receipt)).toBe("created");
	};
	const view = async (
		identity: ((c: EndoCandidateRefV0) => Promise<"verified" | "mismatch">) | null = async () => "verified",
		workspace: EndoReceiptCurrentV0 | null = AT,
		projects: string[] | null = [project.id],
	) => {
		const v = await readEndoCoordinatorCoordinationV0({
			root,
			projects,
			now: () => T0,
			...(identity === null ? {} : { identity }),
			workspace: async () => workspace,
		});
		// Every projection passes the strict validator a sandboxed worker's output is held to.
		expect(validateEndoCoordinatorCoordinationV0(JSON.parse(JSON.stringify(v)))).toEqual(v);
		return v;
	};
	return { root, tasks, project, build, review, store, rev, attempt, candidate, depend, ran, view };
}

const only = (v: EndoCoordinatorCoordinationV0) => {
	const p = v.projects[0];
	if (p === undefined || v.projects.length !== 1) throw new Error("one project expected");
	return p;
};
const dep = (v: EndoCoordinatorCoordinationV0) => only(v).dependencies[0];
const taskView = (v: EndoCoordinatorCoordinationV0, taskId: string) => only(v).tasks.find((t) => t.taskId === taskId);

describe("the projection's standing", () => {
	it("a pre-E1 store reads as absent, not an error, and states that it grants nothing", async () => {
		const w = world();
		const v = await w.view();
		expect(v.source).toEqual({ state: "absent", reason: null, revision: null });
		expect(v.authority).toMatchObject({
			grants: "none",
			writes: "none",
			assignmentIsAuthorization: false,
			readinessIsPermission: false,
		});
		expect(v.basis).toMatchObject({ liveness: "not-observed", consistency: "per-file-snapshot" });
		expect(only(v)).toMatchObject({ assignments: [], dependencies: [], conflicts: [] });
		expect(readdirSync(join(w.root, "develop")).filter((n) => n.startsWith("coordination"))).toEqual([]);
	});

	it("is deterministic and writes nothing", async () => {
		const w = world();
		w.candidate(C1);
		w.depend("candidate-declared");
		const before = readdirSync(join(w.root, "develop")).map((n) => [n, statSync(join(w.root, "develop", n)).mtimeMs]);
		const a = await w.view();
		const b = await w.view();
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(
			readdirSync(join(w.root, "develop")).map((n) => [n, statSync(join(w.root, "develop", n)).mtimeMs]),
		).toEqual(before);
	});

	it("an unreadable coordination file is reported, never repaired", async () => {
		const w = world();
		writeFileSync(join(w.root, "develop", "coordination.json"), "{");
		const v = await w.view();
		expect(v.source).toMatchObject({ state: "unreadable", reason: "malformed" });
		expect(v.gaps).toContain("coordination-unreadable");
	});

	it("a requested project the task file does not register is a gap", async () => {
		const w = world();
		const v = await w.view(undefined, AT, ["endo.project.ffffffffffffffffffffffffffffffff"]);
		expect(v.gaps).toContain("unknown-project");
	});
});

describe("dependency readiness", () => {
	it("operator-task-done waits on the prerequisite's status, and readiness carries its disclaimer", async () => {
		const w = world();
		w.depend("operator-task-done");
		const v = await w.view();
		expect(dep(v)).toMatchObject({ satisfaction: "unsatisfied", reasons: ["prerequisite-not-done"] });
		expect(dep(v)?.disclosures).toContain("readiness-confers-no-authority");
		expect(taskView(v, w.review.id)?.readiness).toBe("waiting");
	});

	it("candidate-has-passing-receipt reads only receipts at the candidate's exact commit and tree", async () => {
		const w = world();
		const a = w.attempt(w.build.id);
		w.candidate(C1, a);
		w.depend("candidate-has-passing-receipt");
		expect(dep(await w.view())).toMatchObject({ satisfaction: "unsatisfied", reasons: ["no-receipt-for-candidate"] });
		// A pass at another commit, or at the same commit with another tree, is not evidence about this candidate.
		w.ran(a, C2, 0);
		w.ran(a, C1, 0, "f".repeat(40));
		expect(dep(await w.view())).toMatchObject({ satisfaction: "unsatisfied", reasons: ["no-receipt-for-candidate"] });
		w.ran(a, C1, 0);
		const v = await w.view();
		expect(dep(v)).toMatchObject({ satisfaction: "satisfied", reasons: [] });
		expect(dep(v)?.disclosures).toEqual(
			expect.arrayContaining(["receipt-history-unverifiable", "readiness-confers-no-authority"]),
		);
		expect(taskView(v, w.review.id)?.readiness).toBe("ready");
		expect(taskView(v, w.build.id)?.candidates[0]).toMatchObject({
			relation: "current",
			identity: "verified",
			receipts: "passing",
		});
	});

	it("a failing receipt at the candidate fails it, whatever else passed", async () => {
		const w = world();
		const a = w.attempt(w.build.id);
		w.candidate(C1, a);
		w.depend("candidate-has-passing-receipt");
		w.ran(a, C1, 0);
		w.ran(a, C1, 1);
		const v = await w.view();
		expect(dep(v)).toMatchObject({ satisfaction: "unsatisfied" });
		expect(dep(v)?.reasons).toContain("failing-receipt-for-candidate");
	});

	it("a new candidate is evaluated afresh; the old one keeps its history", async () => {
		const w = world();
		const a = w.attempt(w.build.id);
		const first = w.candidate(C1, a);
		w.depend("candidate-has-passing-receipt");
		w.ran(a, C1, 0);
		const second = w.candidate(C2, a);
		const v = await w.view(async () => "verified", { ...AT, commit: C2 });
		expect(dep(v)).toMatchObject({ satisfaction: "unsatisfied", candidateId: second.candidateId });
		const views = taskView(v, w.build.id)?.candidates ?? [];
		expect(views.find((c) => c.candidateId === first.candidateId)).toMatchObject({
			relation: "superseded",
			receipts: "passing",
		});
		expect(views.find((c) => c.candidateId === second.candidateId)).toMatchObject({
			relation: "current",
			receipts: "none",
		});
	});

	it("an identity that cannot be re-verified is never satisfied", async () => {
		const w = world();
		const a = w.attempt(w.build.id);
		w.candidate(C1, a);
		w.depend("candidate-has-passing-receipt");
		w.ran(a, C1, 0);
		const unavailable = await w.view(null);
		expect(dep(unavailable)?.satisfaction).not.toBe("satisfied");
		expect(dep(unavailable)?.reasons).toContain("candidate-identity-unavailable");
		const mismatch = await w.view(async () => "mismatch");
		expect(dep(mismatch)?.satisfaction).toBe("unsatisfied");
		expect(dep(mismatch)?.reasons).toContain("candidate-identity-failed");
	});

	it("§12 10: a builder's claim without a declared candidate satisfies nothing", async () => {
		const w = world();
		w.depend("candidate-declared");
		const v = await w.view();
		expect(dep(v)).toMatchObject({ satisfaction: "unsatisfied", reasons: ["no-current-candidate"] });
		expect(taskView(v, w.review.id)?.readiness).toBe("waiting");
	});

	it("§12 12a: a worktree that moved after a passing receipt keeps the receipt and warns of drift", async () => {
		const w = world();
		const a = w.attempt(w.build.id);
		w.candidate(C1, a);
		w.depend("candidate-has-passing-receipt");
		w.ran(a, C1, 0);
		const v = await w.view(async () => "verified", { ...AT, commit: C2 });
		expect(dep(v)?.satisfaction).toBe("satisfied");
		expect(dep(v)?.warnings).toContain("workspace-drifted-from-candidate");
		expect(taskView(v, w.review.id)?.readiness).toBe("ready-for-pinned-candidate");
		expect(taskView(v, w.build.id)?.candidates[0]).toMatchObject({
			workspace: "moved-from-candidate",
			receipts: "passing",
		});
	});

	it("an operator decision goes stale when the prerequisite changes", async () => {
		const w = world();
		const d = w.depend("operator-decision");
		expect(dep(await w.view())).toMatchObject({ satisfaction: "unsatisfied", reasons: ["no-operator-decision"] });
		ok(w.store.decideDependency(d.dependencyId, d.revision, "settled", 0));
		expect(dep(await w.view())).toMatchObject({ satisfaction: "satisfied" });
		ok(w.tasks.updateTask(w.project.id, w.build.id, w.build.revision, { title: "changed" }));
		const v = await w.view();
		expect(dep(v)).toMatchObject({ satisfaction: "unsatisfied" });
		expect(dep(v)?.reasons).toContain("operator-decision-stale");
	});
});

describe("assignments and conflicts", () => {
	const spec = (participantId: string, allowSharedWorktree = false) => ({
		participant: { participantId, role: "builder" as const, intendedHarnessFamily: null },
		workspace: {
			worktreePath: PATH,
			registration: "project-path" as const,
			accessIntent: "read-write-intended" as const,
			pathHints: ["src"],
			allowSharedWorktree,
		},
		targetCandidate: null,
	});

	it("a task edited after binding is reported stale until reconfirmed; the task itself never changes", async () => {
		const w = world();
		const a = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		expect(only(await w.view()).assignments[0]).toMatchObject({ taskBinding: "current", state: "active" });
		ok(w.tasks.updateTask(w.project.id, w.build.id, w.build.revision, { title: "edited" }));
		const v = await w.view();
		expect(only(v).assignments[0]).toMatchObject({ taskBinding: "task-stale" });
		expect(only(v).assignments[0]?.findings).toContain("assignment-task-stale");
		ok(w.store.reconfirmTask(a.assignmentId, a.revision, 1));
		expect(only(await w.view()).assignments[0]?.taskBinding).toBe("current");
		const read = w.tasks.read();
		expect(read.ok && read.file.tasks.find((t) => t.id === w.build.id)?.status).toBe("open");
	});

	it("reports cross-project conflicts only when both projects are in scope", async () => {
		const w = world();
		const p = ok(w.tasks.registerProject({ name: "other", path: "/work/other", observedGitRoot: null }));
		const t = ok(w.tasks.createTask(p.id, { title: "other" }));
		const a = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("first"),
			}),
		);
		const shared = spec("second");
		shared.workspace.allowSharedWorktree = true;
		const b = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: p.id,
				taskId: t.id,
				...shared,
				workspace: { ...shared.workspace, registration: "same-repository-unregistered" },
			}),
		);
		expect(JSON.stringify(await w.view())).not.toContain(b.assignmentId);
		const v = await w.view(undefined, AT, null);
		expect(
			v.projects[0]?.conflicts.find((c) => c.kind === "shared-writable-worktree-acknowledged")?.assignmentIds,
		).toEqual([a.assignmentId, b.assignmentId].sort());
	});
	it("an acknowledged shared writable worktree is reported as a conflict, with path-hint overlap", async () => {
		const w = world();
		const one = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		const two = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.review.id,
				...spec("two", true),
			}),
		);
		const conflicts = only(await w.view()).conflicts;
		expect(conflicts.map((c) => c.kind)).toEqual(
			expect.arrayContaining(["shared-writable-worktree-acknowledged", "path-hint-overlap"]),
		);
		for (const c of conflicts) expect(c.assignmentIds.sort()).toEqual([one.assignmentId, two.assignmentId].sort());
	});

	it("an assignment whose prerequisites are not satisfied says so, and stays active (§12 scenario 13)", async () => {
		const w = world();
		w.depend("operator-task-done");
		ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.review.id,
				...spec("one"),
			}),
		);
		let pre = w.build;
		for (const next of ["in-progress", "review", "done"] as const)
			pre = ok(w.tasks.setStatus(w.project.id, pre.id, pre.revision, next, "confirmed"));
		expect(dep(await w.view())?.satisfaction).toBe("satisfied");
		ok(w.tasks.setStatus(w.project.id, pre.id, pre.revision, "open", "reopened"));
		const a = only(await w.view()).assignments[0];
		expect(a?.state).toBe("active");
		expect(a?.findings).toContain("prerequisites-not-satisfied");
	});

	it("the reading does not depend on file order when confirmations share a millisecond", () => {
		const w = world();
		const store = new DevelopCoordinationStoreV0(w.root, { now: () => T0 });
		ok(
			store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		ok(
			store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.review.id,
				...spec("two", true),
			}),
		);
		const read = store.read();
		if (!read.ok) throw new Error(read.reason);
		const forward = endoWorktreeConflictsV0(read.file.assignments);
		expect(endoWorktreeConflictsV0([...read.file.assignments].reverse())).toEqual(forward);
		expect(forward.map((c) => c.kind)).toContain("shared-writable-worktree-acknowledged");
	});

	it("§12 11: a reviewer pinned to a candidate that was superseded is told so", async () => {
		const w = world();
		const c1 = w.candidate(C1);
		ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.review.id,
				participant: { participantId: "reviewer", role: "reviewer", intendedHarnessFamily: "pi" },
				workspace: { ...spec("reviewer").workspace, accessIntent: "read-only-intended" },
				targetCandidate: { taskId: w.build.id, candidateId: c1.candidateId },
			}),
		);
		expect(only(await w.view()).assignments[0]?.targetCandidate?.relation).toBe("current-candidate");
		w.candidate(C2);
		const a = only(await w.view()).assignments[0];
		expect(a?.targetCandidate?.relation).toBe("superseded-candidate");
		expect(a?.findings).toContain("target-candidate-superseded");
	});

	it("a declared session reads as operator-declared with unknown liveness", async () => {
		const w = world();
		const a = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.rev(),
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		ok(
			w.store.associateSession(a.assignmentId, a.revision, {
				source: "pi-live",
				sessionKey: "pi-live:launch:abc",
				attachmentId: "pi.default",
				instanceId: null,
				runtimeFingerprintId: null,
			}),
		);
		const view = only(await w.view()).assignments[0];
		expect(view?.session).toEqual({
			source: "pi-live",
			sessionKey: "pi-live:launch:abc",
			standing: "operator-declared",
			liveness: "unknown",
		});
		expect(view?.findings).toEqual(
			expect.arrayContaining(["session-liveness-unknown", "session-instance-undeclared"]),
		);
	});
});
