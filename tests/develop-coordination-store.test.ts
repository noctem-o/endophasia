// COORDINATOR-ASSIGNMENT-002 (E1): the durable coordination file. Every change is the operator's explicit act against the revision they
// read; a refusal writes nothing; a file that cannot be read is never repaired; and nothing here changes a task or grants authority.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENDO_DEVELOP_COORDINATION_LIMITS_V0,
	type EndoDevelopCoordinationFileV0,
	endoDependencyCycleV0,
	readEndoDevelopCoordinationFileV0,
	validateEndoDevelopCoordinationFileV0,
} from "../protocol/develop-coordination.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptRoutesStoreV0 } from "../storage/develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import {
	DevelopCoordinationStoreV0,
	type EndoAssignmentSpecV0,
	type EndoCoordinationResultV0,
} from "../storage/develop-coordination.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";

const roots: string[] = [];
const fresh = (): string => {
	const root = mkdtempSync(join(tmpdir(), "endo-coordination-"));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PATH = "/work/demo";
const COMMON = "/work/demo/.git";
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const TREE = "e".repeat(40);

const ok = <T>(r: EndoCoordinationResultV0<T> | { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(`refused: ${r.code} ${"detail" in r ? (r.detail ?? "") : ""}`);
	return r.value;
};
const coordinationBytes = (root: string) => readFileSync(join(root, "develop", "coordination.json"));
const developFiles = (root: string) => readdirSync(join(root, "develop")).sort();

/** A registered project with two tasks, and a coordination store at a fixed clock. */
function world() {
	const root = fresh();
	const tasks = new DevelopTasksStoreV0(root);
	const project = ok(tasks.registerProject({ name: "demo", path: PATH, observedGitRoot: PATH }));
	const build = ok(tasks.createTask(project.id, { title: "build" }));
	const review = ok(tasks.createTask(project.id, { title: "review" }));
	let clock = 1_000;
	const store = new DevelopCoordinationStoreV0(root, { now: () => ++clock });
	const revision = () => {
		const read = store.read();
		if (!read.ok) throw new Error(read.reason);
		return read.file.revision;
	};
	return { root, tasks, project, build, review, store, revision };
}

const spec = (
	participantId: string,
	change: Partial<EndoAssignmentSpecV0["workspace"]> = {},
): EndoAssignmentSpecV0 => ({
	participant: { participantId, role: "builder", intendedHarnessFamily: "codex" },
	workspace: {
		worktreePath: PATH,
		registration: "project-path",
		accessIntent: "read-write-intended",
		pathHints: [],
		allowSharedWorktree: false,
		...change,
	},
	targetCandidate: null,
});

function assign(
	w: ReturnType<typeof world>,
	participantId: string,
	change: Partial<EndoAssignmentSpecV0["workspace"]> = {},
) {
	return w.store.createAssignment({
		expectedTaskRevision: 0,
		expectedFileRevision: w.revision(),
		projectId: w.project.id,
		taskId: w.build.id,
		...spec(participantId, change),
	});
}

function declare(w: ReturnType<typeof world>, taskId: string, commitSha: string) {
	return w.store.declareCandidate({
		expectedFileRevision: w.revision(),
		projectId: w.project.id,
		taskId,
		candidate: {
			kind: "git-commit",
			commonDir: COMMON,
			worktreePath: PATH,
			commitSha,
			treeSha: TREE,
			attemptId: null,
		},
	});
}

describe("a pre-E1 store", () => {
	it("reads as an empty file and creates nothing", () => {
		const w = world();
		const read = w.store.read();
		expect(read).toMatchObject({ ok: true, exists: false, file: { revision: 0, assignments: [] } });
		expect(developFiles(w.root).filter((n) => n.startsWith("coordination"))).toEqual([]);
	});
});

describe("assignments", () => {
	it("are created at revision 1, change no task, and grant nothing", () => {
		const w = world();
		const before = readFileSync(join(w.root, "develop", "tasks.json"));
		const a = ok(assign(w, "codex-builder"));
		expect(a).toMatchObject({ revision: 1, state: "active", taskRevisionAtBind: w.build.revision, session: null });
		expect(a.worktreeHazard).toEqual({ state: "none" });
		expect(readFileSync(join(w.root, "develop", "tasks.json"))).toEqual(before);
		expect(w.revision()).toBe(1);
		expect(JSON.stringify(a)).not.toMatch(/authori[sz]ed|permission|dispatch/);
	});

	it("a second writer on the same worktree is refused unless the operator acknowledges sharing", () => {
		const w = world();
		const first = ok(assign(w, "one"));
		const bytes = coordinationBytes(w.root);
		const refused = assign(w, "two");
		expect(refused).toMatchObject({ ok: false, code: "worktree-write-overlap" });
		expect(!refused.ok && refused.detail).toContain(first.assignmentId);
		expect(coordinationBytes(w.root)).toEqual(bytes);
		// A reader is not refused, and an acknowledged writer is recorded as such.
		expect(ok(assign(w, "reader", { accessIntent: "read-only-intended" })).workspace.sharedWorktreeAcknowledged).toBe(
			false,
		);
		expect(ok(assign(w, "two", { allowSharedWorktree: true })).workspace.sharedWorktreeAcknowledged).toBe(true);
	});

	it("refuses a stale file revision, a duplicate participant, a wrong project path and a foreign project", () => {
		const w = world();
		ok(assign(w, "one", { accessIntent: "read-only-intended" }));
		expect(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 0,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("x"),
			}),
		).toMatchObject({ ok: false, code: "stale-revision" });
		expect(assign(w, "one", { accessIntent: "read-only-intended" })).toMatchObject({ ok: false, code: "duplicate" });
		expect(assign(w, "elsewhere", { worktreePath: "/work/other" })).toMatchObject({ ok: false, code: "bad-request" });
		const other = ok(w.tasks.registerProject({ name: "other", path: "/work/other", observedGitRoot: null }));
		expect(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.revision(),
				projectId: other.id,
				taskId: w.build.id,
				...spec("y"),
			}),
		).toMatchObject({ ok: false, code: "cross-project" });
		expect(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: w.revision(),
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("Bad Id"),
			}),
		).toMatchObject({ ok: false, code: "bad-request" });
	});

	it("a builder cannot target a candidate; a reviewer targets one of the same project", () => {
		const w = world();
		const c = ok(declare(w, w.build.id, C1));
		const base = { expectedFileRevision: w.revision(), projectId: w.project.id, taskId: w.review.id };
		expect(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				...base,
				...spec("b"),
				targetCandidate: { taskId: w.build.id, candidateId: c.candidateId },
			}),
		).toMatchObject({ ok: false, code: "bad-request" });
		const reviewer = ok(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				...base,
				...spec("r", { accessIntent: "read-only-intended" }),
				participant: { participantId: "r", role: "reviewer", intendedHarnessFamily: "pi" },
				targetCandidate: { taskId: w.build.id, candidateId: c.candidateId },
			}),
		);
		expect(reviewer.targetCandidate).toEqual({ taskId: w.build.id, candidateId: c.candidateId });
	});

	it("supersede ends the old one and confirms the replacement in one write, with symmetric links", () => {
		const w = world();
		const old = ok(assign(w, "one"));
		const at = w.revision();
		const { superseded, replacement } = ok(
			w.store.supersedeAssignment(old.assignmentId, old.revision, 0, spec("two"), "handover"),
		);
		expect(w.revision()).toBe(at + 1);
		expect(superseded).toMatchObject({ state: "superseded", supersededByAssignmentId: replacement.assignmentId });
		expect(superseded.ended?.reason).toBe("handover");
		expect(replacement).toMatchObject({ state: "active", supersedesAssignmentId: old.assignmentId });
		// The ended assignment is history: no transition leaves it.
		expect(w.store.endAssignment(old.assignmentId, superseded.revision, "closed")).toMatchObject({ ok: false });
		expect(w.store.supersedeAssignment(old.assignmentId, old.revision, 0, spec("three"))).toMatchObject({
			ok: false,
		});
	});

	it("an ended writer with an associated session stays hazardous; a replacement on its worktree is refused until cleared", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		const bound = ok(
			w.store.associateSession(a.assignmentId, a.revision, {
				source: "codex-live",
				sessionKey: "codex-live:persistent:thread-1",
				attachmentId: "codex.default",
				instanceId: null,
				runtimeFingerprintId: null,
			}),
		);
		expect(bound.session).toMatchObject({ standing: "operator-declared", source: "codex-live" });
		expect(w.store.associateSession(a.assignmentId, bound.revision, null)).toMatchObject({
			ok: false,
			code: "invalid-transition",
		});
		const ended = ok(w.store.endAssignment(a.assignmentId, bound.revision, "revoked"));
		expect(ended.worktreeHazard).toMatchObject({
			state: "liveness-unverified",
			bases: ["writable-session-associated"],
		});
		expect(assign(w, "two")).toMatchObject({ ok: false, code: "worktree-write-overlap" });
		expect(w.store.clearHazard(a.assignmentId, ended.revision, "")).toMatchObject({ ok: false, code: "bad-request" });
		const cleared = ok(w.store.clearHazard(a.assignmentId, ended.revision, "pkill confirmed; no codex process"));
		expect(cleared.worktreeHazard).toMatchObject({
			state: "operator-cleared",
			bases: ["writable-session-associated"],
		});
		expect(ok(assign(w, "two")).state).toBe("active");
	});

	it("an ended writer with nothing on disk suggesting execution leaves no hazard", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		expect(ok(w.store.endAssignment(a.assignmentId, a.revision, "closed")).worktreeHazard).toEqual({ state: "none" });
		expect(ok(assign(w, "two")).state).toBe("active");
	});

	it("refuses synthetic and unknown session sources, and malformed keys", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		const session = {
			source: "codex-live",
			sessionKey: "codex-live:persistent:thread-1",
			attachmentId: "codex.default",
			instanceId: null,
			runtimeFingerprintId: null,
		} as const;
		expect(
			w.store.associateSession(a.assignmentId, a.revision, {
				...session,
				source: "test-fake" as never,
				sessionKey: "test-fake:persistent:x",
			}),
		).toMatchObject({ ok: false, code: "synthetic-not-admitted" });
		expect(
			w.store.associateSession(a.assignmentId, a.revision, { ...session, source: "openclaw" as never }),
		).toMatchObject({ ok: false, code: "unsupported-source" });
		expect(
			w.store.associateSession(a.assignmentId, a.revision, { ...session, sessionKey: "codex-live:somewhere:x" }),
		).toMatchObject({ ok: false, code: "bad-request" });
	});

	it("links only an attempt of the same task; a prepared link adds no hazard on its own", () => {
		const w = world();
		const service = new DevelopAttemptsServiceV0(w.tasks, new DevelopAttemptsStoreV0(w.root));
		const mine = ok(service.prepare(w.project.id, w.build.id, { objective: "Build it." }));
		const theirs = ok(service.prepare(w.project.id, w.review.id, { objective: "Review it." }));
		const a = ok(assign(w, "one"));
		expect(w.store.linkAttempt(a.assignmentId, a.revision, theirs.id)).toMatchObject({ ok: false });
		const linked = ok(w.store.linkAttempt(a.assignmentId, a.revision, mine.id));
		expect(linked.attemptIds).toEqual([mine.id]);
		expect(ok(w.store.endAssignment(a.assignmentId, linked.revision, "closed")).worktreeHazard).toEqual({
			state: "none",
		});
	});

	it("§12 4a: a linked attempt whose route is claimed leaves the worktree hazardous when the assignment is revoked", () => {
		const w = world();
		const service = new DevelopAttemptsServiceV0(w.tasks, new DevelopAttemptsStoreV0(w.root));
		const attempt = ok(service.prepare(w.project.id, w.build.id, { objective: "Build it." }));
		const a = ok(assign(w, "one"));
		const linked = ok(w.store.linkAttempt(a.assignmentId, a.revision, attempt.id));
		expect(DevelopAttemptRoutesStoreV0.forRoot(w.root).claim(attempt.id, "workbench", 1)).toBe("created");
		const ended = ok(w.store.endAssignment(linked.assignmentId, linked.revision, "revoked"));
		expect(ended.worktreeHazard).toMatchObject({ state: "liveness-unverified", bases: ["attempt-route-claimed"] });
		expect(assign(w, "two")).toMatchObject({ ok: false, code: "worktree-write-overlap" });
	});

	it("a route claimed after closure blocks the next writer and can be cleared explicitly", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		const service = new DevelopAttemptsServiceV0(w.tasks, new DevelopAttemptsStoreV0(w.root));
		const attempt = ok(service.prepare(w.project.id, w.build.id, { objective: "build" }));
		const linked = ok(w.store.linkAttempt(a.assignmentId, a.revision, attempt.id));
		const ended = ok(w.store.endAssignment(a.assignmentId, linked.revision, "closed"));
		expect(ended.worktreeHazard.state).toBe("none");
		expect(DevelopAttemptRoutesStoreV0.forRoot(w.root).claim(attempt.id, "workbench", 1)).toBe("created");
		expect(assign(w, "two")).toMatchObject({ ok: false, code: "worktree-write-overlap" });
		ok(w.store.clearHazard(a.assignmentId, ended.revision, "Stopped and checked"));
		ok(assign(w, "two"));
	});
	it("damaged tasks do not prevent revocation", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		writeFileSync(join(w.root, "develop", "tasks.json"), "{");
		expect(ok(w.store.endAssignment(a.assignmentId, a.revision, "revoked")).state).toBe("revoked");
	});
	it("a later task edit cannot be silently confirmed or approved", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		const d = ok(
			w.store.addDependency({
				expectedFileRevision: w.revision(),
				projectId: w.project.id,
				dependentTaskId: w.review.id,
				prerequisiteTaskId: w.build.id,
				condition: "operator-decision",
			}),
		);
		ok(w.tasks.updateTask(w.project.id, w.build.id, 0, { title: "edited" }));
		const before = coordinationBytes(w.root);
		for (const r of [
			assign(w, "two"),
			w.store.supersedeAssignment(a.assignmentId, 1, 0, spec("two")),
			w.store.reconfirmTask(a.assignmentId, 1, 0),
			w.store.decideDependency(d.dependencyId, 1, "ok", 0),
		])
			expect(r).toMatchObject({ ok: false, code: "stale-revision" });
		expect(coordinationBytes(w.root)).toEqual(before);
	});
	it("reconfirm binds the task's current revision", () => {
		const w = world();
		const a = ok(assign(w, "one"));
		const edited = ok(w.tasks.updateTask(w.project.id, w.build.id, w.build.revision, { title: "build it well" }));
		const again = ok(w.store.reconfirmTask(a.assignmentId, a.revision, 1));
		expect(again.taskRevisionAtBind).toBe(edited.revision);
		expect(w.store.reconfirmTask(a.assignmentId, a.revision, 1)).toMatchObject({ ok: false, code: "stale-revision" });
	});
});

describe("dependencies", () => {
	it("refuses self edges, duplicates and cycles, and keeps the file unchanged", () => {
		const w = world();
		const add = (dependentTaskId: string, prerequisiteTaskId: string) =>
			w.store.addDependency({
				expectedFileRevision: w.revision(),
				projectId: w.project.id,
				dependentTaskId,
				prerequisiteTaskId,
				condition: "operator-task-done",
			});
		expect(add(w.build.id, w.build.id)).toMatchObject({ ok: false, code: "dependency-cycle" });
		ok(add(w.review.id, w.build.id));
		const bytes = coordinationBytes(w.root);
		expect(add(w.review.id, w.build.id)).toMatchObject({ ok: false, code: "duplicate" });
		expect(add(w.build.id, w.review.id)).toMatchObject({ ok: false, code: "dependency-cycle" });
		expect(coordinationBytes(w.root)).toEqual(bytes);
	});

	it("an operator decision is bound to the prerequisite's revision and can be withdrawn", () => {
		const w = world();
		const d = ok(
			w.store.addDependency({
				expectedFileRevision: w.revision(),
				projectId: w.project.id,
				dependentTaskId: w.review.id,
				prerequisiteTaskId: w.build.id,
				condition: "operator-decision",
			}),
		);
		const decided = ok(w.store.decideDependency(d.dependencyId, d.revision, "the API is settled", 0));
		expect(decided.operatorDecision).toMatchObject({
			prerequisiteTaskRevision: w.build.revision,
			rationale: "the API is settled",
		});
		const withdrawn = ok(w.store.decideDependency(d.dependencyId, decided.revision, null, null));
		expect(withdrawn.operatorDecision).toBeNull();
		ok(w.store.removeDependency(d.dependencyId, withdrawn.revision));
		const read = w.store.read();
		expect(read.ok && read.file.dependencies).toEqual([]);
	});

	it("a decision on a condition that is not operator-decision is refused", () => {
		const w = world();
		const d = ok(
			w.store.addDependency({
				expectedFileRevision: w.revision(),
				projectId: w.project.id,
				dependentTaskId: w.review.id,
				prerequisiteTaskId: w.build.id,
				condition: "operator-task-done",
			}),
		);
		expect(w.store.decideDependency(d.dependencyId, d.revision, "go", 0)).toMatchObject({ ok: false });
	});

	it("the cycle check finds a long cycle and passes a DAG", () => {
		const e = (a: string, b: string) => ({ dependentTaskId: a, prerequisiteTaskId: b });
		expect(endoDependencyCycleV0([e("a", "b"), e("b", "c"), e("a", "c")])).toBeNull();
		const cycle = endoDependencyCycleV0([e("a", "b"), e("b", "c"), e("c", "d"), e("d", "b")]);
		expect(cycle?.at(0)).toBe(cycle?.at(-1));
		expect(new Set(cycle)).toEqual(new Set(["b", "c", "d"]));
	});
});

describe("candidates", () => {
	it("are immutable: a new declaration supersedes the current one and keeps it", () => {
		const w = world();
		const first = ok(declare(w, w.build.id, C1));
		const second = ok(declare(w, w.build.id, C2));
		expect(second.supersedesCandidateId).toBe(first.candidateId);
		const read = w.store.read();
		const entry = read.ok ? read.file.taskCandidates[0] : undefined;
		expect(entry?.currentCandidateId).toBe(second.candidateId);
		expect(entry?.candidates.map((c) => c.candidateId)).toEqual([first.candidateId, second.candidateId]);
		expect(entry?.candidates[0]).toEqual(first);
	});

	it("selection is explicit, revision-checked, and never erases", () => {
		const w = world();
		const first = ok(declare(w, w.build.id, C1));
		ok(declare(w, w.build.id, C2));
		const read = w.store.read();
		const entry = read.ok ? read.file.taskCandidates[0] : undefined;
		if (entry === undefined) throw new Error("no entry");
		ok(w.store.selectCandidate(w.build.id, entry.revision, first.candidateId));
		expect(w.store.selectCandidate(w.build.id, entry.revision, null)).toMatchObject({
			ok: false,
			code: "stale-revision",
		});
		ok(w.store.selectCandidate(w.build.id, entry.revision + 1, null));
		const after = w.store.read();
		expect(after.ok && after.file.taskCandidates[0]?.candidates).toHaveLength(2);
		expect(after.ok && after.file.taskCandidates[0]?.currentCandidateId).toBeNull();
	});

	it("refuses a short or symbolic commit", () => {
		const w = world();
		expect(declare(w, w.build.id, "abc1234")).toMatchObject({ ok: false, code: "bad-request" });
		expect(declare(w, w.build.id, "main")).toMatchObject({ ok: false, code: "bad-request" });
	});
});

describe("a file that cannot be read is never repaired", () => {
	for (const [name, bytes, reason] of [
		["malformed", "{not json", "malformed"],
		["unknown version", JSON.stringify({ schemaVersion: "endo.develop-coordination.v9" }), "unsupported-version"],
		["invalid", JSON.stringify({ schemaVersion: "endo.develop-coordination.v0", revision: -1 }), "invalid"],
	] as const) {
		it(`${name}: every change is refused and the bytes stay`, () => {
			const w = world();
			writeFileSync(join(w.root, "develop", "coordination.json"), bytes);
			expect(w.store.read()).toEqual({ ok: false, reason });
			expect(
				w.store.createAssignment({
					expectedTaskRevision: 0,
					expectedFileRevision: 0,
					projectId: w.project.id,
					taskId: w.build.id,
					...spec("x"),
				}),
			).toMatchObject({ ok: false, code: "unreadable", reason });
			expect(readFileSync(join(w.root, "develop", "coordination.json"), "utf8")).toBe(bytes);
		});
	}

	it("an oversize file is refused unread", () => {
		const w = world();
		writeFileSync(
			join(w.root, "develop", "coordination.json"),
			" ".repeat(ENDO_DEVELOP_COORDINATION_LIMITS_V0.maxFileBytes + 1),
		);
		expect(w.store.read()).toEqual({ ok: false, reason: "too-large" });
	});

	it("an unreadable tasks.json refuses the change and leaves coordination.json alone", () => {
		const w = world();
		ok(assign(w, "one", { accessIntent: "read-only-intended" }));
		const bytes = coordinationBytes(w.root);
		writeFileSync(join(w.root, "develop", "tasks.json"), "{");
		expect(
			w.store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 1,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("two"),
			}),
		).toMatchObject({ ok: false, code: "tasks-unreadable" });
		expect(coordinationBytes(w.root)).toEqual(bytes);
	});
});

describe("interrupted writes", () => {
	it("a failure before the rename is storage-failed: the old file stays and the leftover is swept next time", () => {
		const w = world();
		ok(assign(w, "one", { accessIntent: "read-only-intended" }));
		const bytes = coordinationBytes(w.root);
		const crashing = new DevelopCoordinationStoreV0(w.root, {
			beforeReplace: () => {
				throw new Error("crash");
			},
		});
		expect(
			crashing.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 1,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("two"),
			}),
		).toMatchObject({ ok: false, code: "storage-failed" });
		expect(coordinationBytes(w.root)).toEqual(bytes);
		ok(assign(w, "two", { accessIntent: "read-only-intended" }));
		expect(developFiles(w.root).filter((n) => n.includes(".tmp-"))).toEqual([]);
	});

	it("a failure after the rename is commit-uncertain, and the change is visible", () => {
		const w = world();
		const uncertain = new DevelopCoordinationStoreV0(w.root, {
			afterReplace: () => {
				throw new Error("fsync");
			},
		});
		expect(
			uncertain.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 0,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		).toMatchObject({ ok: false, code: "commit-uncertain" });
		const read = w.store.read();
		expect(read.ok && read.file.assignments.map((a) => a.participant.participantId)).toEqual(["one"]);
	});

	it("a task edited between the coordination read and the change binds the revision it read (no cross-file atomicity)", () => {
		const w = world();
		let edited = 0;
		const store = new DevelopCoordinationStoreV0(w.root, {
			afterTasksRead: () => {
				edited = ok(w.tasks.updateTask(w.project.id, w.build.id, w.build.revision, { title: "edited" })).revision;
			},
		});
		const a = ok(
			store.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 0,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		expect(a.taskRevisionAtBind).toBe(w.build.revision);
		expect(edited).toBeGreaterThan(a.taskRevisionAtBind);
	});
});

describe("concurrency", () => {
	it("a held lock answers busy without writing", () => {
		const w = world();
		let inner: EndoCoordinationResultV0<unknown> | undefined;
		const holder = new DevelopCoordinationStoreV0(w.root, {
			afterTasksRead: () => {
				inner = new DevelopCoordinationStoreV0(w.root, { lockWaitMs: 50 }).createAssignment({
					expectedTaskRevision: 0,
					expectedFileRevision: 0,
					projectId: w.project.id,
					taskId: w.build.id,
					...spec("two"),
				});
			},
		});
		ok(
			holder.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 0,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		expect(inner).toMatchObject({ ok: false, code: "busy" });
		expect(w.revision()).toBe(1);
	});

	it("never holds the task lock: a task write succeeds while the coordination lock is held", () => {
		const w = world();
		let during: { ok: boolean } | undefined;
		const holder = new DevelopCoordinationStoreV0(w.root, {
			afterTasksRead: () => {
				during = new DevelopTasksStoreV0(w.root, { lockWaitMs: 50 }).createTask(w.project.id, {
					title: "concurrent",
				});
			},
		});
		ok(
			holder.createAssignment({
				expectedTaskRevision: 0,
				expectedFileRevision: 0,
				projectId: w.project.id,
				taskId: w.build.id,
				...spec("one"),
			}),
		);
		expect(during?.ok).toBe(true);
	});

	it("many processes writing at once lose nothing and corrupt nothing", async () => {
		const w = world();
		const worker = fileURLToPath(new URL("./fixtures/develop-coordination-writer.ts", import.meta.url));
		const go = join(w.root, "go");
		const runs = Array.from({ length: 4 }, (_, n) => {
			const child = spawn(process.execPath, [worker, w.root, w.project.id, w.build.id, PATH, String(n), "6", go], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const ready = new Promise<void>((resolve, reject) => {
				child.stdout.once("data", () => resolve());
				child.once("error", reject);
				child.once("close", () => reject(new Error(`writer ${n} ended before it was ready: ${stderr}`)));
			});
			const done = new Promise<{ status: number | null; stderr: string }>((resolve) => {
				child.once("close", (status) => resolve({ status, stderr }));
			});
			return { ready, done };
		});
		await Promise.all(runs.map((run) => run.ready));
		writeFileSync(go, "");
		for (const run of await Promise.all(runs.map((r) => r.done))) expect(run.status, run.stderr).toBe(0);
		rmSync(go);
		const read = w.store.read();
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.assignments).toHaveLength(24);
		expect(new Set(read.file.assignments.map((a) => a.participant.participantId)).size).toBe(24);
		expect(read.file.revision).toBe(24);
		expect(developFiles(w.root).filter((n) => n.startsWith("coordination.lock"))).toHaveLength(1);
		expect(developFiles(w.root).filter((n) => n.includes(".tmp-"))).toEqual([]);
	}, 60_000);
});

describe("the file validator", () => {
	const valid = (): EndoDevelopCoordinationFileV0 => {
		const w = world();
		const a = ok(assign(w, "one"));
		ok(declare(w, w.build.id, C1));
		ok(
			w.store.addDependency({
				expectedFileRevision: w.revision(),
				projectId: w.project.id,
				dependentTaskId: w.review.id,
				prerequisiteTaskId: w.build.id,
				condition: "candidate-has-passing-receipt",
			}),
		);
		ok(w.store.supersedeAssignment(a.assignmentId, a.revision, 0, spec("two")));
		const read = w.store.read();
		if (!read.ok) throw new Error(read.reason);
		return read.file;
	};
	const rejects = (mutate: (f: EndoDevelopCoordinationFileV0) => void) => {
		const f = structuredClone(valid());
		mutate(f);
		expect(() => validateEndoDevelopCoordinationFileV0(f)).toThrow();
	};

	it("accepts what the store writes", () => {
		const f = valid();
		expect(validateEndoDevelopCoordinationFileV0(structuredClone(f))).toEqual(f);
		expect(readEndoDevelopCoordinationFileV0(f)).toMatchObject({ ok: true });
	});
	it("rejects an unknown member, bad ids and enums", () => {
		rejects((f) => Object.assign(f, { extra: 1 }));
		rejects((f) => Object.assign(f.assignments[0] as object, { granted: true }));
		rejects((f) => {
			(f.assignments[0] as { assignmentId: string }).assignmentId = "endo.assignment.xyz";
		});
		rejects((f) => {
			(f.assignments[0] as { state: string }).state = "running";
		});
		rejects((f) => {
			(f.assignments[0] as { participant: { role: string } }).participant.role = "owner";
		});
		rejects((f) => {
			(f.dependencies[0] as { condition: string }).condition = "always";
		});
	});
	it("rejects broken supersession links and duplicates", () => {
		rejects((f) => {
			(f.assignments[0] as { supersededByAssignmentId: string | null }).supersededByAssignmentId = null;
		});
		rejects((f) => {
			f.assignments.push(structuredClone(f.assignments[1]) as never);
		});
		rejects((f) => {
			f.dependencies.push(structuredClone(f.dependencies[0]) as never);
		});
	});
	it("rejects a cycle and a dangling current candidate", () => {
		rejects((f) => {
			const d = structuredClone(f.dependencies[0]) as NonNullable<(typeof f.dependencies)[0]>;
			d.dependencyId = `endo.dep.${"f".repeat(32)}`;
			[d.dependentTaskId, d.prerequisiteTaskId] = [d.prerequisiteTaskId, d.dependentTaskId];
			f.dependencies.push(d);
		});
		rejects((f) => {
			(f.taskCandidates[0] as { currentCandidateId: string }).currentCandidateId =
				`endo.candidate.${"0".repeat(32)}`;
		});
	});
	it("§12 20: a record that claims anyone but the operator confirmed it is invalid", () => {
		rejects((f) => {
			(f.assignments[0] as { origin: { confirmedBy: string } }).origin.confirmedBy = "coordinator";
		});
		rejects((f) => {
			(f.dependencies[0] as { createdBy: string }).createdBy = "agent";
		});
		rejects((f) => {
			(f.taskCandidates[0]?.candidates[0] as { declaredBy: string }).declaredBy = "builder";
		});
	});
	it("an unknown version is reported as such", () => {
		expect(readEndoDevelopCoordinationFileV0({ schemaVersion: "endo.develop-coordination.v1" })).toMatchObject({
			ok: false,
			kind: "unsupported-version",
		});
	});
});
