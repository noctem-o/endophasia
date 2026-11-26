// COORDINATOR-ASSIGNMENT-003 (E2): Deterministic acceptance & regression tests for governed assignment integration.
//
// Covers:
// - AT01: Valid assignment-linked Codex attempt (Strict-only, shared `.route.json`, write-once adapter auth & outcome,
//         `consequenceObserved: false`, Codex `session-grant` refusal, native approvals remain separate).
// - AT02: Assignment revision changed during approval → refused (`stale-revision`), zero route claim, zero transport.
// - AT03: Task revision changed during approval → refused (`stale-revision`), zero route claim, zero transport.
// - AT04: Revocation wins commitment race → no dispatch (`assignment-not-active`), `.route.json` absent.
// - AT05: Dispatch commitment wins race → `liveness-unverified` retained on revocation; pre-transport abort writes
//         `.aborted.json`, keeps `.route.json` burned, retains hazard when other unverified basis exists, clears only
//         when no unverified basis remains.
// - AT06: Pi and Codex compete for the same attempt → at most one winner on shared `.route.json`.
// - AT07: Protected and live routes compete → shared exclusivity + anti-bypass gate prevents raw Pi workbench or
//         protected route from dispatching an assignment-linked attempt outside `coordination.lock.<n>`.
// - AT08: Crash after `.route.json` claim (Window W1) → conservative recovery, no silent retry, hazard retained.
// - AT09: Crash after authorization write (Window W1b) → uncertainty represented, retry refused, hazard retained.
// - AT10: Uncertain transport delivery (Window W3, `disconnect-mid-turn`) → `.outcome.json` records `unknown`, zero
//         automatic retries, projection reports `adapter-unknown`.
// - AT11: Runtime `instanceId` changes → stale authorization refused (`session-binding-stale` / `stale-attachment`).
// - AT12: Dependency invalidated before commitment → dispatch refused (`prerequisites-not-satisfied`).
// - AT13: Unregistered sibling worktree → refused (`worktree-not-registered`); registered sibling accepted.
// - AT14: Malicious worktree path substitution (symlinked `.git`, foreign `gitdir:`, swapped symlink after registration)
//         → refused cleanly without following malicious pointers.
// - AT15: Reviewer evaluates superseded candidate C1 after C2 declared → C1 provenance preserved (`superseded-candidate`).
// - AT16: Agent falsely claims tests passed → review stays `advisory-agent-review`, never becomes host receipt,
//         `candidate-has-passing-receipt` stays `unsatisfied`.
// - AT17: Offline session observation → never claims live state or confirmed termination; validator rejects forgery.
// - AT18: Live session liveness → connected, running, disconnected (`termination.confirmed: false`), and
//         `termination-confirmed` only with confirmed OS scope cleanup (`remainingProcesses: 0`).
// - AT20 (store): Cross-project advisory review refused (`cross-project`).
// - AT21: Unsupported Pi-only capability (`queue` / `native-command`) on Codex → honest refusal, zero route claim.
// - AT24 (E1 §10.6): Pairwise `acknowledgedConflictIds` catches reactivated unacknowledged shared-worktree overlap.
// - CLI: `endo worktree register|list|unregister` and `endo review record|list|show` end-to-end.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCodexLocalProtocolCheckV0 } from "../adapters/codex/checks.ts";
import { buildCodexNativeApprovalDecisionV0 } from "../adapters/codex/controller.ts";
import { CodexDevelopAdapterV0 } from "../adapters/codex/develop-adapter.ts";
import {
	dispatchEndoAssignmentAttemptV0,
	planEndoAssignmentDispatchV0,
} from "../adapters/develop/assignment-dispatch.ts";
import { DevelopCoordinationGitV0 } from "../adapters/develop/coordination.ts";
import { planProtectedAttemptV0 } from "../adapters/develop/protected-attempt.ts";
import { endoAdapterSessionKeyV0 } from "../protocol/develop-adapter.ts";
import { validateEndoDevelopCoordinationFileV0 } from "../protocol/develop-coordination.ts";
import {
	ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0,
	validateEndoDevelopAdvisoryReviewV0,
} from "../protocol/develop-coordination-reviews.ts";
import {
	ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0,
	validateEndoSessionLivenessObservationV0,
} from "../protocol/develop-session-liveness.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { endoCoordinationProjectionV0 } from "../runtime/contracts/develop-coordination.ts";
import {
	endoObserveAdapterLivenessV0,
	endoOfflineSessionLivenessV0,
} from "../runtime/contracts/develop-session-liveness.ts";
import { readEndoCoordinatorCoordinationV0 } from "../storage/coordinator-coordination.ts";
import { DevelopAdapterAuthorizationsStoreV0 } from "../storage/develop-adapter-authorizations.ts";
import { DevelopAttemptRoutesStoreV0 } from "../storage/develop-attempt-routes.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopCoordinationStoreV0 } from "../storage/develop-coordination.ts";
import { DevelopCoordinationReviewsStoreV0 } from "../storage/develop-coordination-reviews.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { git, haveGit } from "./git-fixtures.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function scratch(prefix = "endo-e2-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (cleanups.length > 0) {
		const fn = cleanups.pop();
		try {
			await fn?.();
		} catch {
			// Ignore test teardown errors.
		}
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

interface FixtureEnv {
	base: string;
	root: string;
	repo: string;
	projectId: string;
	taskId: string;
	attemptId: string;
	headSha: string;
	treeSha: string;
	tasks: DevelopTasksStoreV0;
	attempts: DevelopAttemptsStoreV0;
	coord: DevelopCoordinationStoreV0;
}

function createRepoStore(name = "repo"): FixtureEnv {
	const base = scratch("endo-e2-env-");
	const root = join(base, "store");
	const repo = join(base, name);
	mkdirSync(root, { recursive: true });
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "initial commit");
	const headSha = git(repo, "rev-parse", "HEAD").trim();
	const treeSha = git(repo, "rev-parse", "HEAD^{tree}").trim();

	const tasks = new DevelopTasksStoreV0(root);
	const proj = tasks.registerProject({ name: "demo", path: repo, observedGitRoot: repo });
	if (!proj.ok) throw new Error(`registerProject: ${proj.code}`);
	const task = tasks.createTask(proj.value.id, { title: "Implement E2", description: "Do the work." });
	if (!task.ok) throw new Error(`createTask: ${task.code}`);
	const attempts = new DevelopAttemptsStoreV0(root);
	const svc = new DevelopAttemptsServiceV0(tasks, attempts);
	const prep = svc.prepare(proj.value.id, task.value.id, { objective: "Implement E2 attempt" });
	if (!prep.ok) throw new Error(`prepare: ${prep.code}`);
	const coord = new DevelopCoordinationStoreV0(root);

	return {
		base,
		root,
		repo,
		projectId: proj.value.id,
		taskId: task.value.id,
		attemptId: prep.value.id,
		headSha,
		treeSha,
		tasks,
		attempts,
		coord,
	};
}

async function createLiveCodexAdapter(args: {
	root: string;
	worktree: string;
	attachmentId?: string;
	scenario?: string;
	logFile?: string;
	onNativeApprovalRequest?: ConstructorParameters<typeof CodexDevelopAdapterV0>[0]["onNativeApprovalRequest"];
}): Promise<CodexDevelopAdapterV0> {
	const attachmentId = args.attachmentId ?? "codex.e2";
	const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" };
	const check = await runCodexLocalProtocolCheckV0({
		root: args.root,
		attachment: attachmentId,
		executable: FAKE_CODEX,
		checkCwd: args.worktree,
		env,
	});
	const runtimeEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		FAKE_CODEX_SCENARIO: args.scenario ?? "default",
		...(args.logFile === undefined ? {} : { FAKE_CODEX_LOG_FILE: args.logFile }),
	};
	const adapter = new CodexDevelopAdapterV0({
		root: args.root,
		attachmentId,
		projectScope: args.worktree,
		executable: FAKE_CODEX,
		env: runtimeEnv,
		fingerprint: check.fingerprint,
		capabilityState: check.capabilityState,
		...(args.onNativeApprovalRequest === undefined ? {} : { onNativeApprovalRequest: args.onNativeApprovalRequest }),
	});
	await adapter.open();
	cleanups.push(async () => {
		await adapter.close();
	});
	return adapter;
}

function bindAssignment(
	env: FixtureEnv,
	opts: {
		participantId?: string;
		role?: "builder" | "reviewer" | "investigator";
		harness?: "codex" | "pi";
		worktreePath?: string;
		registration?: "project-path" | "registered-sibling" | "same-repository-unregistered";
		accessIntent?: "read-write-intended" | "read-only-intended";
		adapter?: CodexDevelopAdapterV0;
		attemptId?: string;
		expectedFileRevision?: number;
		taskId?: string;
		expectedTaskRevision?: number;
	} = {},
) {
	const d = opts.adapter?.describe();
	const sessionKey = d ? endoAdapterSessionKeyV0(d.session) : null;
	const created = env.coord.createAssignment({
		expectedFileRevision: opts.expectedFileRevision ?? 0,
		expectedTaskRevision: opts.expectedTaskRevision ?? 0,
		projectId: env.projectId,
		taskId: opts.taskId ?? env.taskId,
		participant: {
			participantId: opts.participantId ?? "codex-builder",
			role: opts.role ?? "builder",
			intendedHarnessFamily: opts.harness ?? "codex",
		},
		workspace: {
			worktreePath: opts.worktreePath ?? env.repo,
			registration: opts.registration ?? "project-path",
			accessIntent: opts.accessIntent ?? "read-write-intended",
			pathHints: [],
			allowSharedWorktree: false,
		},
		targetCandidate: null,
	});
	if (!created.ok) throw new Error(`createAssignment failed: ${created.code} ${created.detail ?? ""}`);
	let assign = created.value;

	if (d !== undefined && sessionKey !== null) {
		const linked = env.coord.associateSession(assign.assignmentId, assign.revision, {
			source: d.session.source as "codex-live" | "pi-live",
			sessionKey,
			attachmentId: d.attachment.attachmentId,
			instanceId: d.attachment.instanceId,
			runtimeFingerprintId: d.runtimeFingerprint.status === "identified" ? d.runtimeFingerprint.fingerprintId : null,
		});
		if (!linked.ok) throw new Error(`associateSession failed: ${linked.code} ${linked.detail ?? ""}`);
		assign = linked.value;
	}

	const attId = opts.attemptId ?? env.attemptId;
	const linkedAtt = env.coord.linkAttempt(assign.assignmentId, assign.revision, attId);
	if (!linkedAtt.ok) throw new Error(`linkAttempt failed: ${linkedAtt.code} ${linkedAtt.detail ?? ""}`);
	return { assignment: linkedAtt.value, fileRevision: linkedAtt.file.revision };
}

describe.skipIf(!haveGit)("E2-A & E2-B: Governed harness-neutral assignment dispatch & atomic commitment", () => {
	it("AT01: dispatches a valid assignment-linked Codex attempt with Strict-only proof, shared route, and write-once records", async () => {
		const env = createRepoStore();
		const nativeApprovals: string[] = [];
		const adapter = await createLiveCodexAdapter({
			root: env.root,
			worktree: env.repo,
			scenario: "native-approval-cmd",
			onNativeApprovalRequest: async (req) => {
				nativeApprovals.push(req.approvalKind);
				return buildCodexNativeApprovalDecisionV0({ request: req, decision: "decline", nowMs: Date.now() });
			},
		});
		const { assignment } = bindAssignment(env, { adapter });

		// Codex MUST refuse `session-grant` (Strict-only invariant).
		const grantRefused = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => ({ approved: true, mechanism: "session-grant", sessionGrantId: "grant-1" }),
		});
		expect(grantRefused).toMatchObject({
			status: "refused",
			stage: "authority",
			code: "session-grant-not-permitted",
			routeClaimed: false,
			authorizationWritten: false,
		});
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("absent");

		// Explicit operator terminal confirmation succeeds.
		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async (plan) => {
				expect(plan.assignmentId).toBe(assignment.assignmentId);
				expect(plan.assignmentRevision).toBe(assignment.revision);
				expect(plan.taskRevision).toBe(0);
				expect(plan.harnessFamily).toBe("codex");
				expect(plan.requiredPhrase).toMatch(/^APPROVE ATTEMPT [0-9a-f]{8}$/);
				return { approved: true, mechanism: "terminal-phrase", via: "controlling-terminal" };
			},
		});

		expect(outcome.status).toBe("accepted");
		if (outcome.status !== "accepted") throw new Error("expected accepted");
		expect(outcome.routeClaimed).toBe(true);
		expect(outcome.authorization).toMatchObject({
			attemptId: env.attemptId,
			assignmentId: assignment.assignmentId,
			assignmentRevision: assignment.revision,
			taskRevision: 0,
			harnessFamily: "codex",
			source: "codex-live",
			mechanism: "terminal-phrase",
			approvedBy: "operator",
		});
		expect(outcome.outcomeRecord).toMatchObject({
			attemptId: env.attemptId,
			authorizationId: outcome.authorization.authorizationId,
			status: "accepted",
			consequenceObserved: false,
			recordedBy: "controller",
		});

		// Shared store-wide route reservation domain holds `"adapter-live"`.
		const routeRead = DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId);
		expect(routeRead).toMatchObject({ state: "present", record: { route: "adapter-live" } });

		// Write-once adapter authorization + outcome records are durable.
		const authRead = DevelopAdapterAuthorizationsStoreV0.forRoot(env.root).read(env.attemptId);
		expect(authRead.authorization.state).toBe("present");
		expect(authRead.outcome.state).toBe("present");
		expect(authRead.abort.state).toBe("absent");

		// `dispatchedAttemptIds` recorded on the assignment inside `coordination.json`.
		const coordAfter = env.coord.read();
		if (!coordAfter.ok) throw new Error(coordAfter.reason);
		const assignAfter = coordAfter.file.assignments.find((a) => a.assignmentId === assignment.assignmentId);
		expect(assignAfter?.dispatchedAttemptIds).toEqual([env.attemptId]);

		// Projection reads `adapter-accepted` and never weakens authority flags.
		const proj = await readEndoCoordinatorCoordinationV0({ root: env.root, projects: [env.projectId] });
		expect(proj.authority).toMatchObject({
			assignmentIsAuthorization: false,
			readinessIsPermission: false,
			kind: "read-only-projection",
		});
		const assignView = proj.projects[0]?.assignments.find((a) => a.assignmentId === assignment.assignmentId);
		expect(assignView?.attempts[0]?.execution).toBe("adapter-accepted");

		// Wait briefly for the fake Codex server's native approval callback to confirm native approvals remained separate.
		await new Promise((r) => setTimeout(r, 150));
		expect(nativeApprovals).toContain("command-execution");
	});

	it("AT02: refuses dispatch when assignment revision changes during operator approval (zero route claim, zero transport)", async () => {
		const env = createRepoStore();
		const logFile = join(env.base, "codex.log.json");
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo, logFile });
		const { assignment } = bindAssignment(env, { adapter });

		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => {
				// Mutate assignment revision (add another attempt link) while operator is reviewing.
				const prep2 = new DevelopAttemptsServiceV0(env.tasks, env.attempts).prepare(env.projectId, env.taskId, {
					objective: "second attempt",
				});
				if (!prep2.ok) throw new Error(prep2.code);
				const bumped = env.coord.linkAttempt(assignment.assignmentId, assignment.revision, prep2.value.id);
				expect(bumped.ok).toBe(true);
				return { approved: true, mechanism: "terminal-phrase" };
			},
		});

		expect(outcome).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "stale-revision",
			routeClaimed: false,
			authorizationWritten: false,
		});
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("absent");
		const events = existsSync(logFile)
			? (JSON.parse(readFileSync(logFile, "utf8")) as Array<{ method?: string }>)
			: [];
		expect(events.filter((e) => e.method === "turn/start")).toHaveLength(0);
	});

	it("AT03: refuses dispatch when task revision changes during operator approval (zero route claim, zero transport)", async () => {
		const env = createRepoStore();
		const logFile = join(env.base, "codex.log.json");
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo, logFile });
		const { assignment } = bindAssignment(env, { adapter });

		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => {
				const edited = env.tasks.updateTask(env.projectId, env.taskId, 0, { title: "Changed title mid-approval" });
				expect(edited.ok).toBe(true);
				return { approved: true, mechanism: "terminal-phrase" };
			},
		});

		expect(outcome).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "stale-revision",
			routeClaimed: false,
			authorizationWritten: false,
		});
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("absent");
		const events = existsSync(logFile)
			? (JSON.parse(readFileSync(logFile, "utf8")) as Array<{ method?: string }>)
			: [];
		expect(events.filter((e) => e.method === "turn/start")).toHaveLength(0);
	});

	it("AT04: Winner A — revocation wins commitment race; dispatch is refused with zero route claim", async () => {
		const env = createRepoStore();
		const logFile = join(env.base, "codex.log.json");
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo, logFile });
		const { assignment } = bindAssignment(env, { adapter });

		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => {
				const revoked = env.coord.endAssignment(
					assignment.assignmentId,
					assignment.revision,
					"revoked",
					"operator-cancelled",
				);
				expect(revoked.ok).toBe(true);
				return { approved: true, mechanism: "terminal-phrase" };
			},
		});

		expect(outcome).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "assignment-not-active",
			routeClaimed: false,
			authorizationWritten: false,
		});
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("absent");
		const events = existsSync(logFile)
			? (JSON.parse(readFileSync(logFile, "utf8")) as Array<{ method?: string }>)
			: [];
		expect(events.filter((e) => e.method === "turn/start")).toHaveLength(0);
	});

	it("AT05: Winner B — dispatch commits before revocation; revocation retains liveness-unverified, pre-transport abort burns route and only clears hazard when no other unverified basis remains", async () => {
		const env = createRepoStore();
		const logFile = join(env.base, "codex.log.json");
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo, logFile });
		// Case 1: Assignment has a linked writable session → even after pre-transport abort, `writable-session` basis
		// remains, so `clearHazardAfterPreTransportAbort` MUST conservatively KEEP `liveness-unverified`!
		const { assignment } = bindAssignment(env, { adapter });

		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			beforeTransportWrite: () => {
				const r = env.coord.read();
				if (!r.ok) throw new Error(r.reason);
				const latest = r.file.assignments.find((a) => a.assignmentId === assignment.assignmentId);
				if (!latest) throw new Error("missing");
				const revoked = env.coord.endAssignment(
					latest.assignmentId,
					latest.revision,
					"revoked",
					"operator-revoked-in-window-w2",
				);
				expect(revoked.ok).toBe(true);
				if (revoked.ok) expect(revoked.value.worktreeHazard.state).toBe("liveness-unverified");
			},
		});

		expect(outcome.status).toBe("aborted-before-transport");
		if (outcome.status !== "aborted-before-transport") throw new Error("expected abort");
		expect(outcome.routeClaimed).toBe(true);
		expect(outcome.observedAssignmentState).toBe("revoked");
		expect(outcome.abortRecord).not.toBeNull();
		// Hazard NOT cleared because writable session is still linked!
		expect(outcome.hazardCleared).toBe(false);
		// Route stays permanently burned (never cleared or reused).
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("present");
		// Transport was NOT invoked!
		const events = existsSync(logFile)
			? (JSON.parse(readFileSync(logFile, "utf8")) as Array<{ method?: string }>)
			: [];
		expect(events.filter((e) => e.method === "turn/start")).toHaveLength(0);

		// Case 2: Assignment WITHOUT a linked session (so the ONLY hazard basis is the aborted attempt) →
		// pre-transport abort safely clears the hazard while keeping `.route.json` permanently burned!
		const env2 = createRepoStore("repo-nosess");
		const adapter2 = await createLiveCodexAdapter({
			root: env2.root,
			worktree: env2.repo,
			attachmentId: "codex.nosess",
		});
		const { assignment: assign2 } = bindAssignment(env2); // no session linked on assignment
		const outcome2 = await dispatchEndoAssignmentAttemptV0({
			root: env2.root,
			assignmentId: assign2.assignmentId,
			attemptId: env2.attemptId,
			adapter: adapter2,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			beforeTransportWrite: () => {
				const r = env2.coord.read();
				if (!r.ok) throw new Error(r.reason);
				const latest = r.file.assignments.find((a) => a.assignmentId === assign2.assignmentId)!;
				const revoked = env2.coord.endAssignment(latest.assignmentId, latest.revision, "revoked", "revoked-in-w2");
				expect(revoked.ok).toBe(true);
				if (revoked.ok) expect(revoked.value.worktreeHazard.state).toBe("liveness-unverified");
			},
		});
		expect(outcome2.status).toBe("aborted-before-transport");
		if (outcome2.status !== "aborted-before-transport") throw new Error("expected abort");
		expect(outcome2.hazardCleared).toBe(true);
		const after2 = env2.coord.read();
		if (!after2.ok) throw new Error(after2.reason);
		expect(after2.file.assignments[0]?.worktreeHazard.state).toBe("none");
		expect(DevelopAttemptRoutesStoreV0.forRoot(env2.root).read(env2.attemptId).state).toBe("present");
	});

	it("AT06: Pi and Codex compete for the same attempt on one shared route domain — at most one winner", async () => {
		const env = createRepoStore();
		const codex = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });
		const { assignment } = bindAssignment(env, { adapter: codex });

		// Codex dispatches and wins `.route.json`.
		const first = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter: codex,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(first.status).toBe("accepted");

		// Pi workbench dispatch check for the exact same attempt MUST see `already-authorized`!
		const dispatch = new DevelopAttemptDispatchV0(env.tasks, env.attempts, {
			projectId: env.projectId,
			launchDirectory: env.repo,
		});
		const piCheck = dispatch.check(env.attemptId, {
			assignmentId: assignment.assignmentId,
			expectedAssignmentRevision: assignment.revision + 1,
		});
		expect(piCheck).toMatchObject({ ok: false, code: "already-authorized" });

		// And reverse direction: if Pi workbench claims the attempt first, Codex is refused `already-authorized`!
		const env2 = createRepoStore("repo-pi-first");
		const { assignment: a2 } = bindAssignment(env2, { harness: "pi" });
		const dispatch2 = new DevelopAttemptDispatchV0(env2.tasks, env2.attempts, {
			projectId: env2.projectId,
			launchDirectory: env2.repo,
		});
		const check2 = dispatch2.check(env2.attemptId, {
			assignmentId: a2.assignmentId,
			expectedAssignmentRevision: a2.revision,
		});
		if (!check2.ok) throw new Error(`pi check2 failed: ${check2.code}`);
		const piWin = dispatch2.authorize(
			check2.value,
			{
				session: "endo.session.pi.sess-1",
				attachment: "pi.default",
				launchId: "1".repeat(16),
				proposalId: `endo.evidence.workbench-prompt-${"1".repeat(32)}`,
				proposalDigest: "a".repeat(64),
				authorizationEventId: `endo.event.${"1".repeat(32)}`,
				message: {
					digest: { algorithm: "hmac-sha256", keyId: "k1", value: "b".repeat(64) },
					bytes: Buffer.byteLength(check2.value.brief),
				},
			},
			{ assignmentId: a2.assignmentId, expectedAssignmentRevision: a2.revision },
		);
		expect(piWin.ok, piWin.ok ? "" : piWin.code).toBe(true);
		const codex2 = await createLiveCodexAdapter({
			root: env2.root,
			worktree: env2.repo,
			attachmentId: "codex.second",
		});
		const codexSecond = await dispatchEndoAssignmentAttemptV0({
			root: env2.root,
			assignmentId: a2.assignmentId,
			attemptId: env2.attemptId,
			adapter: codex2,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(codexSecond).toMatchObject({ status: "refused", stage: "commit", code: "already-authorized" });
	});

	it("AT07: protected and live routes share exclusivity AND assignment-linked attempts cannot bypass via raw Pi workbench or protected routes", async () => {
		const env = createRepoStore();
		const { assignment } = bindAssignment(env);

		// 1. Raw Pi workbench check WITHOUT assignment binding MUST be refused `assignment-required`!
		const piDispatch = new DevelopAttemptDispatchV0(env.tasks, env.attempts, {
			projectId: env.projectId,
			launchDirectory: env.repo,
		});
		const rawPi = piDispatch.check(env.attemptId);
		expect(rawPi).toMatchObject({ ok: false, code: "assignment-required" });

		// 2. Raw protected attempt plan WITHOUT assignment binding MUST also be refused `assignment-required`!
		const rawProtected = planProtectedAttemptV0({
			root: env.root,
			attemptId: env.attemptId,
			templatePath: join(env.base, "template.json"),
			out: join(env.base, "runs"),
		});
		expect(rawProtected).toMatchObject({ ok: false, code: "assignment-required" });

		// 3. Even WITH assignment binding, once `"adapter-live"` claims the route, protected route sees `already-authorized`.
		const codex = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });
		const committed = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter: codex,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(committed.status).toBe("accepted");
		const protAfter = planProtectedAttemptV0({
			root: env.root,
			attemptId: env.attemptId,
			templatePath: join(env.base, "template.json"),
			out: join(env.base, "runs"),
			assignment: { assignmentId: assignment.assignmentId, expectedAssignmentRevision: assignment.revision + 1 },
		});
		expect(protAfter).toMatchObject({ ok: false, code: "already-authorized" });
	});

	it("AT08: crash after `.route.json` claim (Window W1) leaves route claimed, refuses retry, and forces liveness-unverified on revocation", async () => {
		const env = createRepoStore();
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });
		const { assignment } = bindAssignment(env, { adapter });

		const crashed = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			coordinationOptions: {
				afterRouteClaim: () => {
					throw new Error("simulated crash in Window W1");
				},
			},
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(crashed).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "commit-partial",
			routeClaimed: true,
			authorizationWritten: false,
		});
		// Route is NOT cleared automatically.
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("present");
		// Retry is refused as `already-authorized`.
		const retry = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(retry).toMatchObject({ status: "refused", stage: "commit", code: "already-authorized" });
		// Revocation conservatively records `liveness-unverified` (route claimed).
		const revoked = env.coord.endAssignment(
			assignment.assignmentId,
			assignment.revision,
			"revoked",
			"recover-after-w1",
		);
		expect(revoked.ok).toBe(true);
		if (revoked.ok) expect(revoked.value.worktreeHazard.state).toBe("liveness-unverified");
	});

	it("AT09: crash after authorization write (Window W1b) preserves uncertainty, refuses retry, and retains hazard on revocation", async () => {
		const env = createRepoStore();
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });
		const { assignment } = bindAssignment(env, { adapter });

		const crashed = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			coordinationOptions: {
				afterAuthorizationWrite: () => {
					throw new Error("simulated crash in Window W1b");
				},
			},
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(crashed).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "commit-partial",
			routeClaimed: true,
			authorizationWritten: true,
		});
		expect(DevelopAdapterAuthorizationsStoreV0.forRoot(env.root).read(env.attemptId).authorization.state).toBe(
			"present",
		);
		const retry = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(retry).toMatchObject({ status: "refused", stage: "commit", code: "already-authorized" });

		// Projection surfaces `adapter-authorized` (no outcome yet).
		const proj = await readEndoCoordinatorCoordinationV0({ root: env.root, projects: [env.projectId] });
		expect(proj.projects[0]?.assignments[0]?.attempts[0]?.execution).toBe("adapter-authorized");

		const revoked = env.coord.endAssignment(
			assignment.assignmentId,
			assignment.revision,
			"revoked",
			"recover-after-w1b",
		);
		expect(revoked.ok).toBe(true);
		if (revoked.ok) expect(revoked.value.worktreeHazard.state).toBe("liveness-unverified");
	});

	it("AT10: uncertain transport delivery (Window W3, disconnect-mid-turn) records `unknown` with zero automatic retries", async () => {
		const env = createRepoStore();
		const adapter = await createLiveCodexAdapter({
			root: env.root,
			worktree: env.repo,
			scenario: "disconnect-mid-turn",
		});
		const { assignment } = bindAssignment(env, { adapter });
		let dispatchCalls = 0;
		const origDispatch = adapter.dispatch.bind(adapter);
		adapter.dispatch = async (...args) => {
			dispatchCalls += 1;
			return origDispatch(...args);
		};

		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(outcome.status).toBe("unknown");
		if (outcome.status !== "unknown") throw new Error("expected unknown");
		expect(outcome.outcomeRecord).toMatchObject({
			status: "unknown",
			consequenceObserved: false,
			recordedBy: "controller",
		});
		// Exactly ONE dispatch call (zero silent retries).
		expect(dispatchCalls).toBe(1);
		// Projection reports `adapter-unknown`.
		const proj = await readEndoCoordinatorCoordinationV0({ root: env.root, projects: [env.projectId] });
		expect(proj.projects[0]?.assignments[0]?.attempts[0]?.execution).toBe("adapter-unknown");
	});

	it("AT11: runtime instanceId change refuses stale authorization (`session-binding-stale` / `stale-attachment`)", async () => {
		const env = createRepoStore();
		const adapter1 = await createLiveCodexAdapter({
			root: env.root,
			worktree: env.repo,
			attachmentId: "codex.rotate",
		});
		const { assignment } = bindAssignment(env, { adapter: adapter1 });
		await adapter1.close();

		// Start a new runtime instance (new `instanceId`) under the same attachmentId.
		const adapter2 = await createLiveCodexAdapter({
			root: env.root,
			worktree: env.repo,
			attachmentId: "codex.rotate",
		});
		expect(adapter2.describe().attachment.instanceId).not.toBe(assignment.session?.instanceId);

		const plan = await planEndoAssignmentDispatchV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter: adapter2,
		});
		expect(plan).toMatchObject({ ok: false, code: "session-binding-stale" });
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("absent");
	});

	it("AT12: invalidated dependency before commitment refuses dispatch (`prerequisites-not-satisfied`)", async () => {
		const env = createRepoStore();
		const task2 = env.tasks.createTask(env.projectId, { title: "Review after build" });
		if (!task2.ok) throw new Error(task2.code);
		// Mark prerequisite task1 done (open → in-progress → review → done) so dependency is satisfied at plan time.
		expect(env.tasks.setStatus(env.projectId, env.taskId, 0, "in-progress", null).ok).toBe(true);
		expect(env.tasks.setStatus(env.projectId, env.taskId, 1, "review", null).ok).toBe(true);
		expect(env.tasks.setStatus(env.projectId, env.taskId, 2, "done", null).ok).toBe(true);
		const dep = env.coord.addDependency({
			expectedFileRevision: 0,
			projectId: env.projectId,
			dependentTaskId: task2.value.id,
			prerequisiteTaskId: env.taskId,
			condition: "operator-task-done",
		});
		expect(dep.ok).toBe(true);

		const prep2 = new DevelopAttemptsServiceV0(env.tasks, env.attempts).prepare(env.projectId, task2.value.id, {
			objective: "review after build",
		});
		if (!prep2.ok) throw new Error(prep2.code);
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });
		const { assignment } = bindAssignment(env, {
			adapter,
			taskId: task2.value.id,
			attemptId: prep2.value.id,
			expectedFileRevision: 1,
		});

		const outcome = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: prep2.value.id,
			adapter,
			approve: async () => {
				// Reopen prerequisite task during operator approval!
				const reopened = env.tasks.setStatus(env.projectId, env.taskId, 3, "open", "reopened mid-approval");
				expect(reopened.ok).toBe(true);
				return { approved: true, mechanism: "terminal-phrase" };
			},
		});
		expect(outcome).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "prerequisites-not-satisfied",
			routeClaimed: false,
		});
	});

	it("AT21: Pi-only capabilities (`queue`, `native-command`) on Codex return honest unsupported refusal with zero route claim", async () => {
		const env = createRepoStore();
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });
		const { assignment } = bindAssignment(env, { adapter });

		for (const buildRequest of [
			(brief: string) => ({ kind: "queue" as const, message: brief }),
			() => ({ kind: "native-command" as const, command: "/compact", args: [] }),
		]) {
			const res = await dispatchEndoAssignmentAttemptV0({
				root: env.root,
				assignmentId: assignment.assignmentId,
				attemptId: env.attemptId,
				adapter,
				buildRequest,
				approve: async () => {
					throw new Error("operator approval must never be prompted for unsupported operations");
				},
			});
			expect(res).toMatchObject({
				status: "refused",
				stage: "plan",
				code: "admission-refused",
				routeClaimed: false,
				authorizationWritten: false,
			});
			expect(res.status === "refused" && res.stage === "plan" ? res.admissionCode : "").toMatch(/unsupported/);
		}
		expect(DevelopAttemptRoutesStoreV0.forRoot(env.root).read(env.attemptId).state).toBe("absent");
	});
});

describe.skipIf(!haveGit)("E2-C: Registered sibling worktrees & pointer/symlink safety", () => {
	it("AT13: refuses unregistered sibling worktrees and accepts explicitly registered sibling worktrees for governed dispatch", async () => {
		const env = createRepoStore();
		const sibling = join(env.base, "repo-wt-sibling");
		git(env.repo, "worktree", "add", "-q", "-b", "wt-branch", sibling);

		// Creating an assignment on an unregistered sibling worktree with `registration: "registered-sibling"` fails.
		const unregAssign = env.coord.createAssignment({
			expectedFileRevision: 0,
			expectedTaskRevision: 0,
			projectId: env.projectId,
			taskId: env.taskId,
			participant: { participantId: "codex-wt", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: sibling,
				registration: "registered-sibling",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		expect(unregAssign).toMatchObject({ ok: false, code: "worktree-not-registered" });

		// Even if an assignment was created as `same-repository-unregistered`, dispatch MUST refuse it!
		const unregOk = env.coord.createAssignment({
			expectedFileRevision: 0,
			expectedTaskRevision: 0,
			projectId: env.projectId,
			taskId: env.taskId,
			participant: { participantId: "codex-unreg", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: sibling,
				registration: "same-repository-unregistered",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		if (!unregOk.ok) throw new Error(unregOk.code);
		const linked = env.coord.linkAttempt(unregOk.value.assignmentId, unregOk.value.revision, env.attemptId);
		if (!linked.ok) throw new Error(linked.code);

		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: sibling });
		const refused = await planEndoAssignmentDispatchV0({
			root: env.root,
			assignmentId: unregOk.value.assignmentId,
			attemptId: env.attemptId,
			adapter,
		});
		expect(refused).toMatchObject({ ok: false, code: "worktree-not-registered" });

		// Now validate & explicitly register the sibling worktree.
		const gitHelper = new DevelopCoordinationGitV0();
		const tasksRead = env.tasks.read();
		if (!tasksRead.ok) throw new Error(tasksRead.reason);
		const proj = tasksRead.file.projects[0]!;
		const validated = await gitHelper.validateSiblingWorktree(proj, sibling);
		expect(validated.ok).toBe(true);
		if (!validated.ok) throw new Error(validated.detail);
		const reg = env.coord.registerWorktree({
			expectedFileRevision: linked.file.revision,
			projectId: env.projectId,
			worktreePath: validated.worktree.worktreePath,
			commonDir: validated.worktree.commonDir,
			gitDir: validated.worktree.gitDir,
			label: "builder-sibling",
		});
		expect(reg.ok).toBe(true);
		if (!reg.ok) throw new Error(reg.code);

		// Create a registered-sibling assignment on a second attempt and dispatch!
		const prep2 = new DevelopAttemptsServiceV0(env.tasks, env.attempts).prepare(env.projectId, env.taskId, {
			objective: "registered sibling attempt",
		});
		if (!prep2.ok) throw new Error(prep2.code);
		const rev = env.coord.endAssignment(
			unregOk.value.assignmentId,
			linked.value.revision,
			"revoked",
			"replace-with-registered",
		);
		if (!rev.ok) throw new Error(rev.code);
		const { assignment: regAssign } = bindAssignment(env, {
			adapter,
			worktreePath: sibling,
			registration: "registered-sibling",
			attemptId: prep2.value.id,
			expectedFileRevision: rev.file.revision,
		});
		const dispatched = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: regAssign.assignmentId,
			attemptId: prep2.value.id,
			adapter,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(dispatched.status).toBe("accepted");
	});

	it("AT14: refuses malicious Git pointers, symlinked `.git`, foreign repositories, and post-registration path substitution", async () => {
		const env = createRepoStore();
		const tasksRead = env.tasks.read();
		if (!tasksRead.ok) throw new Error(tasksRead.reason);
		const proj = tasksRead.file.projects[0]!;
		const gitHelper = new DevelopCoordinationGitV0();

		// 1. Separate unrelated Git repository is refused (`shared-repo-mismatch`).
		const foreignRepo = join(env.base, "foreign-repo");
		mkdirSync(foreignRepo);
		git(foreignRepo, "init", "-q");
		writeFileSync(join(foreignRepo, "f.txt"), "x\n");
		git(foreignRepo, "add", "f.txt");
		git(foreignRepo, "commit", "-q", "-m", "foreign");
		const foreignRes = await gitHelper.validateSiblingWorktree(proj, foreignRepo);
		expect(foreignRes.ok).toBe(false);

		// 2. Directory with symlinked `.git` pointing to primary `.git` is refused.
		const fakeSymlinkWt = join(env.base, "fake-symlink-wt");
		mkdirSync(fakeSymlinkWt);
		symlinkSync(join(env.repo, ".git"), join(fakeSymlinkWt, ".git"));
		const symRes = await gitHelper.validateSiblingWorktree(proj, fakeSymlinkWt);
		expect(symRes).toMatchObject({ ok: false, code: "bad-request" });

		// 3. Directory with crafted `.git` file pointing at a foreign `gitdir:` is refused.
		const fakePointerWt = join(env.base, "fake-pointer-wt");
		mkdirSync(fakePointerWt);
		writeFileSync(join(fakePointerWt, ".git"), `gitdir: ${join(foreignRepo, ".git")}\n`);
		const ptrRes = await gitHelper.validateSiblingWorktree(proj, fakePointerWt);
		expect(ptrRes).toMatchObject({ ok: false, code: "bad-request" });

		// 4. Legitimate sibling worktree swapped with a symlink to another directory AFTER registration is refused on revalidation!
		const realSibling = join(env.base, "real-sibling");
		git(env.repo, "worktree", "add", "-q", "-b", "wt-swap", realSibling);
		const val = await gitHelper.validateSiblingWorktree(proj, realSibling);
		expect(val.ok).toBe(true);
		if (!val.ok) throw new Error(val.detail);
		const reg = env.coord.registerWorktree({
			expectedFileRevision: 0,
			projectId: env.projectId,
			worktreePath: val.worktree.worktreePath,
			commonDir: val.worktree.commonDir,
			gitDir: val.worktree.gitDir,
		});
		if (!reg.ok) throw new Error(reg.code);

		// Swap the registered path with a symlink pointing elsewhere!
		const movedAside = join(env.base, "real-sibling-moved");
		renameSync(realSibling, movedAside);
		symlinkSync(movedAside, realSibling);
		const reval = await gitHelper.revalidateRegisteredWorktree(proj, reg.value);
		expect(reval).toMatchObject({ ok: false, code: "worktree-not-registered" });
	});
});

describe.skipIf(!haveGit)("E2-D: Structured advisory reviews & verification provenance", () => {
	it("AT15 & AT16 & AT20: preserves superseded candidate provenance, blocks review-to-receipt promotion, and enforces project scope", async () => {
		const env = createRepoStore();
		const task2 = env.tasks.createTask(env.projectId, { title: "Dependent task" });
		if (!task2.ok) throw new Error(task2.code);
		const proj2Repo = join(env.base, "repo2");
		mkdirSync(proj2Repo);
		git(proj2Repo, "init", "-q");
		writeFileSync(join(proj2Repo, "a.txt"), "a\n");
		git(proj2Repo, "add", "a.txt");
		git(proj2Repo, "commit", "-q", "-m", "p2");
		const proj2 = env.tasks.registerProject({ name: "other-project", path: proj2Repo, observedGitRoot: proj2Repo });
		if (!proj2.ok) throw new Error(proj2.code);

		// Declare C1, then supersede with C2.
		const c1 = env.coord.declareCandidate({
			expectedFileRevision: 0,
			projectId: env.projectId,
			taskId: env.taskId,
			candidate: {
				kind: "git-commit",
				commonDir: join(env.repo, ".git"),
				worktreePath: env.repo,
				commitSha: env.headSha,
				treeSha: env.treeSha,
				attemptId: env.attemptId,
			},
		});
		if (!c1.ok) throw new Error(c1.code);

		writeFileSync(join(env.repo, "README.md"), "hello v2\n");
		git(env.repo, "add", "README.md");
		git(env.repo, "commit", "-q", "-m", "second commit");
		const head2 = git(env.repo, "rev-parse", "HEAD").trim();
		const tree2 = git(env.repo, "rev-parse", "HEAD^{tree}").trim();

		const c2 = env.coord.declareCandidate({
			expectedFileRevision: c1.file.revision,
			projectId: env.projectId,
			taskId: env.taskId,
			candidate: {
				kind: "git-commit",
				commonDir: join(env.repo, ".git"),
				worktreePath: env.repo,
				commitSha: head2,
				treeSha: tree2,
				attemptId: null,
			},
		});
		if (!c2.ok) throw new Error(c2.code);

		// Add `candidate-has-passing-receipt` dependency on task1.
		const dep = env.coord.addDependency({
			expectedFileRevision: c2.file.revision,
			projectId: env.projectId,
			dependentTaskId: task2.value.id,
			prerequisiteTaskId: env.taskId,
			condition: "candidate-has-passing-receipt",
		});
		expect(dep.ok).toBe(true);

		const reviews = new DevelopCoordinationReviewsStoreV0(env.root);
		// AT15 & AT16: Record an advisory review on C1 where the agent enthusiastically claims tests passed!
		const rec1 = reviews.recordReview({
			projectId: env.projectId,
			candidateTaskId: env.taskId,
			candidateId: c1.value.candidateId,
			assignmentId: null,
			attemptId: env.attemptId,
			reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
			verdict: "approve-advisory",
			summary: "Looks great! All unit tests passed!",
			findings: [
				{
					severity: "info",
					category: "review",
					summary: "Clean implementation — no bugs spotted.",
					location: "README.md:1",
				},
			],
			agentClaimedChecks: "npm test (agent claims passed)",
			checkout: {
				standing: "controller-observed",
				worktreePath: env.repo,
				preObservationId: null,
				postObservationId: null,
				cleanAtCandidate: true,
				reason: null,
			},
			recordedBy: "operator",
		});
		expect(rec1.ok).toBe(true);
		if (!rec1.ok) throw new Error(rec1.code);
		expect(rec1.review).toMatchObject({
			schemaVersion: ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0,
			standing: "advisory-agent-review",
			basis: "agent-reported",
			verdict: "approve-advisory",
		});

		// Record another approving review on current candidate C2 too — STILL must NOT become a host receipt!
		const rec2 = reviews.recordReview({
			projectId: env.projectId,
			candidateTaskId: env.taskId,
			candidateId: c2.value.candidateId,
			assignmentId: null,
			attemptId: null,
			reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
			verdict: "approve-advisory",
			summary: "C2 also passes all checks (claimed by agent).",
			findings: [],
			agentClaimedChecks: "vitest --run (agent claims 100% pass)",
			checkout: {
				standing: "unobserved",
				worktreePath: null,
				preObservationId: null,
				postObservationId: null,
				cleanAtCandidate: false,
				reason: "not-observed",
			},
			recordedBy: "operator",
		});
		expect(rec2.ok).toBe(true);

		// Verify receipts directory was NEVER touched by advisory reviews.
		expect(existsSync(join(env.root, "develop", "receipts"))).toBe(false);

		// Project coordination view: C1 review is labelled `superseded-candidate`, C2 review is `current-candidate`,
		// BOTH carry explicit advisory disclosures, AND `candidate-has-passing-receipt` stays UNSATISFIED!
		const proj = await readEndoCoordinatorCoordinationV0({ root: env.root, projects: [env.projectId] });
		const p = proj.projects[0]!;
		const r1View = p.reviews?.find((r) => r.reviewId === rec1.review.reviewId);
		const r2View = p.reviews?.find((r) => r.reviewId === (rec2.ok ? rec2.review.reviewId : ""));
		expect(r1View).toMatchObject({
			candidateId: c1.value.candidateId,
			candidateRelation: "superseded-candidate",
			standing: "advisory-agent-review",
			basis: "agent-reported",
			disclosures: ["advisory-only-not-host-check", "not-operator-acceptance"],
		});
		expect(r2View).toMatchObject({
			candidateId: c2.value.candidateId,
			candidateRelation: "current-candidate",
		});
		expect(p.dependencies[0]?.satisfaction).toBe("unsatisfied");

		// AT20 (store): Cross-project review binding MUST be refused (`cross-project`).
		const cross = reviews.recordReview({
			projectId: proj2.value.id,
			candidateTaskId: env.taskId,
			candidateId: c1.value.candidateId,
			assignmentId: null,
			attemptId: null,
			reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
			verdict: "comment",
			summary: "Attempt to smuggle project A candidate into project B review",
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
		expect(cross).toMatchObject({ ok: false, code: "cross-project" });

		// Protocol rejects forged standing or unobserved `cleanAtCandidate: true`.
		expect(() =>
			validateEndoDevelopAdvisoryReviewV0({
				...rec1.review,
				standing: "host-receipt",
			}),
		).toThrow();
		expect(() =>
			validateEndoDevelopAdvisoryReviewV0({
				...rec1.review,
				checkout: {
					standing: "unobserved",
					worktreePath: null,
					preObservationId: null,
					postObservationId: null,
					cleanAtCandidate: true,
					reason: null,
				},
			}),
		).toThrow();
	});
});

describe.skipIf(!haveGit)("E2-E: Session liveness & termination evidence", () => {
	it("AT17: offline session observations never claim live state or confirmed termination", () => {
		const staleObs = endoOfflineSessionLivenessV0({
			harnessFamily: "codex",
			source: "codex-live",
			sessionKey: "codex.e2:sess-1",
			attachmentId: "codex.e2",
			instanceId: "inst-1",
			runtimeFingerprintId: null,
			observedAtMs: 1_700_000_000_000,
			lastRecordedAtMs: 1_699_999_000_000, // 1_000_000ms old > default 600_000ms stale threshold
			eventsAvailable: true,
		});
		expect(staleObs.state).toBe("stale-observation");
		expect(staleObs.observationMode).toBe("offline-projection");
		expect(staleObs.termination.confirmed).toBe(false);

		const unknownObs = endoOfflineSessionLivenessV0({
			harnessFamily: "codex",
			source: "codex-live",
			sessionKey: "codex.e2:sess-1",
			attachmentId: "codex.e2",
			instanceId: "inst-1",
			runtimeFingerprintId: null,
			observedAtMs: 1_700_000_000_000,
			lastRecordedAtMs: null,
			eventsAvailable: true,
		});
		expect(unknownObs.state).toBe("liveness-unknown");
		expect(unknownObs.termination.confirmed).toBe(false);

		const unavailObs = endoOfflineSessionLivenessV0({
			harnessFamily: "codex",
			source: "codex-live",
			sessionKey: "codex.e2:sess-1",
			attachmentId: "codex.e2",
			instanceId: "inst-1",
			runtimeFingerprintId: null,
			observedAtMs: 1_700_000_000_000,
			lastRecordedAtMs: null,
			eventsAvailable: false,
		});
		expect(unavailObs.state).toBe("unsupported-observation");

		// Forging live state or `termination.confirmed: true` on an offline projection MUST be rejected!
		expect(() =>
			validateEndoSessionLivenessObservationV0({
				...staleObs,
				state: "connected",
			}),
		).toThrow();
		expect(() =>
			validateEndoSessionLivenessObservationV0({
				...staleObs,
				termination: {
					confirmed: true,
					boundary: "scope",
					result: "confirmed",
					remainingProcesses: 0,
					scopeName: "endo-forged.scope",
				},
			}),
		).toThrow();
	});

	it("AT18: live adapter differentiates connected, disconnected (unconfirmed termination), stale, and termination-confirmed (remainingProcesses === 0)", async () => {
		const env = createRepoStore();
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });

		const live = endoObserveAdapterLivenessV0(adapter, { nowMs: Date.now() });
		expect(live.state).toBe("connected");
		expect(live.observationMode).toBe("live-controller");
		expect(live.termination.confirmed).toBe(false);

		// Snapshot older than staleAfterMs yields `stale-observation`.
		const stale = endoObserveAdapterLivenessV0(adapter, { nowMs: Date.now() + 120_000, staleAfterMs: 60_000 });
		expect(stale.state).toBe("stale-observation");

		// Stop the adapter: without OS scope cleanup, disconnected adapter MUST report `disconnected` with `termination.confirmed: false`.
		await adapter.close();
		const afterStop = endoObserveAdapterLivenessV0(adapter, { nowMs: Date.now() });
		expect(afterStop.state).toBe("disconnected");
		expect(afterStop.termination.confirmed).toBe(false);

		// Verified OS scope cleanup (`boundary: "scope"`, `result: "confirmed"`, `remainingProcesses: 0`) yields `termination-confirmed`.
		const d = adapter.describe();
		const s = adapter.snapshot();
		const scopedConfirmed = endoObserveAdapterLivenessV0(
			{
				describe: () => d,
				snapshot: () => ({
					...s,
					observedAt: new Date().toISOString(),
					connection: { state: "disconnected", reason: "stopped" },
					processCleanup: {
						boundary: "scope",
						result: "confirmed",
						remainingProcesses: 0,
						scopeName: "endo-test.scope",
					},
				}),
			},
			{ nowMs: Date.now() },
		);
		expect(scopedConfirmed.state).toBe("termination-confirmed");
		expect(scopedConfirmed.termination.confirmed).toBe(true);
		expect(scopedConfirmed.termination.remainingProcesses).toBe(0);

		// Protocol MUST reject `termination-confirmed` if `remainingProcesses !== 0` or `boundary !== "scope"`.
		expect(() =>
			validateEndoSessionLivenessObservationV0({
				schemaVersion: ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0,
				observedAtMs: 1000,
				snapshotAtMs: 1000,
				staleAfterMs: 60_000,
				observationMode: "live-controller",
				basis: "controller-observed",
				source: "codex-live",
				harnessFamily: "codex",
				sessionKey: "k",
				attachmentId: "a",
				instanceId: "i",
				runtimeFingerprintId: null,
				state: "termination-confirmed",
				connectionState: "disconnected",
				activeTurnState: null,
				termination: {
					confirmed: true,
					boundary: "scope",
					result: "confirmed",
					remainingProcesses: 1,
					scopeName: "endo-test.scope",
				},
				reason: null,
			}),
		).toThrow();
	});
});

describe.skipIf(!haveGit)("E1 §10.6 remediation (AT24) & E2 CLI commands", () => {
	it("AT24: pairwise acknowledgedConflictIds catches reactivated unacknowledged shared-worktree overlap", async () => {
		const env = createRepoStore();
		const task2 = env.tasks.createTask(env.projectId, { title: "Second task" });
		if (!task2.ok) throw new Error(task2.code);

		// A1 (rw) and A2 (rw) created with allowSharedWorktree: true → acknowledged mutually.
		const a1 = env.coord.createAssignment({
			expectedFileRevision: 0,
			expectedTaskRevision: 0,
			projectId: env.projectId,
			taskId: env.taskId,
			participant: { participantId: "builder-1", role: "builder", intendedHarnessFamily: "codex" },
			workspace: {
				worktreePath: env.repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		if (!a1.ok) throw new Error(a1.code);

		const a2 = env.coord.createAssignment({
			expectedFileRevision: a1.file.revision,
			expectedTaskRevision: 0,
			projectId: env.projectId,
			taskId: task2.value.id,
			participant: { participantId: "builder-2", role: "builder", intendedHarnessFamily: "pi" },
			workspace: {
				worktreePath: env.repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: true,
			},
			targetCandidate: null,
		});
		if (!a2.ok) throw new Error(a2.code);
		expect(a2.value.workspace.acknowledgedConflictIds).toEqual([a1.value.assignmentId]);

		// Initially, A1 vs A2 is acknowledged (`shared-writable-worktree-acknowledged`).
		const proj1 = await readEndoCoordinatorCoordinationV0({ root: env.root, projects: [env.projectId] });
		expect(proj1.projects[0]?.conflicts).toHaveLength(1);
		expect(proj1.projects[0]?.conflicts[0]?.kind).toBe("shared-writable-worktree-acknowledged");

		// Simulate the exact E1 §10.6 scenario where A2 had `sharedWorktreeAcknowledged: true` from A1 only,
		// and now shares the worktree with a different active assignment A3 not in `acknowledgedConflictIds`.
		const tasksRead = env.tasks.read();
		const coordRead = env.coord.read();
		if (!tasksRead.ok || !coordRead.ok) throw new Error("unreadable");
		const projCheck = endoCoordinationProjectionV0({
			readAtMs: Date.now(),
			requested: [env.projectId],
			registeredProjects: [env.projectId],
			tasks: {
				ok: true,
				byId: new Map(
					tasksRead.file.tasks.map((t) => [
						t.id,
						{ taskId: t.id, projectId: t.projectId, revision: t.revision, status: t.status },
					]),
				),
			},
			coordination: {
				state: "ready",
				file: {
					...coordRead.file,
					assignments: [
						{
							...a2.value,
							workspace: {
								...a2.value.workspace,
								sharedWorktreeAcknowledged: true,
								acknowledgedConflictIds: [a1.value.assignmentId],
							},
						},
						{
							...a1.value,
							assignmentId: "endo.assignment.aaaaaaaaaaaaaaaa",
							participant: { participantId: "builder-3", role: "builder", intendedHarnessFamily: "codex" },
							workspace: {
								...a1.value.workspace,
								sharedWorktreeAcknowledged: false,
								acknowledgedConflictIds: [],
							},
						},
					],
				},
			},
			attempts: env.attempts.read(),
			receipts: () => ({ ok: true, receipts: [], problems: 0 }),
			route: () => ({ state: "absent" }),
			identity: new Map(),
			workspaces: new Map(),
			gaps: [],
		});
		const conflict = projCheck.projects[0]?.conflicts[0];
		expect(conflict).toBeDefined();
		expect(conflict?.kind).toBe("unacknowledged-worktree-write-overlap");
	});

	it("CLI: `endo worktree register|list|unregister` and `endo review record|list|show` operate cleanly end-to-end", () => {
		const env = createRepoStore();
		const sibling = join(env.base, "cli-sibling");
		git(env.repo, "worktree", "add", "-q", "-b", "cli-wt", sibling);

		const runCli = (args: string[]) => {
			const r = spawnSync(process.execPath, [CLI, ...args], {
				cwd: env.base,
				encoding: "utf8",
				env: { ...process.env, HOME: env.base },
			});
			return { status: r.status, json: JSON.parse(r.stdout || "{}") as Record<string, any>, stderr: r.stderr };
		};

		// Register sibling worktree.
		const reg = runCli([
			"worktree",
			"register",
			"--root",
			env.root,
			"--project",
			env.projectId,
			"--path",
			sibling,
			"--label",
			"review-wt",
			"--revision",
			"0",
		]);
		expect(reg.status, reg.stderr).toBe(0);
		expect(reg.json.worktree).toMatchObject({ worktreePath: sibling, label: "review-wt" });
		const wtId = reg.json.worktree.worktreeId as string;

		const listed = runCli(["worktree", "list", "--root", env.root, "--project", env.projectId]);
		expect(listed.status).toBe(0);
		expect(listed.json.registeredWorktrees).toHaveLength(1);

		// Declare a candidate and record a structured advisory review via CLI.
		const cand = env.coord.declareCandidate({
			expectedFileRevision: 1,
			projectId: env.projectId,
			taskId: env.taskId,
			candidate: {
				kind: "git-commit",
				commonDir: join(env.repo, ".git"),
				worktreePath: env.repo,
				commitSha: env.headSha,
				treeSha: env.treeSha,
				attemptId: null,
			},
		});
		if (!cand.ok) throw new Error(cand.code);

		const rev = runCli([
			"review",
			"record",
			"--root",
			env.root,
			"--project",
			env.projectId,
			"--candidate-task",
			env.taskId,
			"--candidate",
			cand.value.candidateId,
			"--participant",
			"pi-reviewer",
			"--harness",
			"pi",
			"--verdict",
			"changes-requested",
			"--summary",
			"Missing edge-case test.",
			"--finding",
			"high:edge-case:Handle empty input",
		]);
		expect(rev.status, rev.stderr).toBe(0);
		expect(rev.json.review).toMatchObject({
			standing: "advisory-agent-review",
			basis: "agent-reported",
			verdict: "changes-requested",
		});
		const revId = rev.json.review.reviewId as string;

		const revList = runCli(["review", "list", "--root", env.root, "--project", env.projectId]);
		expect(revList.status).toBe(0);
		expect(revList.json.reviews).toHaveLength(1);

		const revShow = runCli(["review", "show", "--root", env.root, "--project", env.projectId, "--review", revId]);
		expect(revShow.status).toBe(0);
		expect(revShow.json.review.reviewId).toBe(revId);

		// Unregister sibling worktree cleanly.
		const unreg = runCli(["worktree", "unregister", "--root", env.root, "--worktree", wtId, "--revision", "2"]);
		expect(unreg.status, unreg.stderr).toBe(0);
		expect(unreg.json.removed.worktreeId).toBe(wtId);
	});

	it("Adversarial regressions (#1, #2, #7A, #8, #10, #11): closes hazard-clearing, TOCTOU route claim, stale-termination, legacy-masking, multiline-reason, and cross-project-attempt edge cases", async () => {
		const env = createRepoStore("repo-adv");
		const adapter = await createLiveCodexAdapter({ root: env.root, worktree: env.repo });

		// #2: `claimUnlinkedAttemptRoute` inside `coordination.lock.<n>` refuses attempts linked to an assignment!
		const { assignment } = bindAssignment(env);
		const unlinkedClaim = env.coord.claimUnlinkedAttemptRoute({
			attemptId: env.attemptId,
			route: "workbench",
			writeRouteRecord: () => "created",
		});
		expect(unlinkedClaim).toMatchObject({ ok: false, code: "assignment-required", routeClaimed: false });

		// #8: E2 assignment without conflicts explicitly persists `acknowledgedConflictIds: []` (cannot be masked
		// by a legacy E1 boolean) AND protocol rejects self-references in `acknowledgedConflictIds`.
		expect(assignment.workspace.acknowledgedConflictIds).toEqual([]);
		const coordNow = env.coord.read();
		if (!coordNow.ok) throw new Error(coordNow.reason);
		expect(() =>
			validateEndoDevelopCoordinationFileV0({
				...coordNow.file,
				assignments: [
					{
						...assignment,
						workspace: {
							...assignment.workspace,
							sharedWorktreeAcknowledged: true,
							acknowledgedConflictIds: [assignment.assignmentId],
						},
					},
				],
			}),
		).toThrow();

		// #1: Corrupt `develop/attempts/` record prevents `clearHazardAfterPreTransportAbort` from clearing hazard!
		const outcomeAbort = await dispatchEndoAssignmentAttemptV0({
			root: env.root,
			assignmentId: assignment.assignmentId,
			attemptId: env.attemptId,
			adapter,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			beforeTransportWrite: () => {
				const r = env.coord.read();
				if (!r.ok) throw new Error(r.reason);
				const a = r.file.assignments[0]!;
				expect(env.coord.endAssignment(a.assignmentId, a.revision, "revoked", "adv-w2").ok).toBe(true);
				// Corrupt an unrelated problem file naming this attempt inside `develop/attempts/`.
				writeFileSync(join(env.root, "develop", "attempts", `${env.attemptId}.authorized.json`), "{not-json");
			},
		});
		expect(outcomeAbort.status).toBe("aborted-before-transport");
		if (outcomeAbort.status === "aborted-before-transport") {
			expect(outcomeAbort.hazardCleared).toBe(false);
			// Mismatched authorizationId is also rejected.
			const badClear = env.coord.clearHazardAfterPreTransportAbort(
				assignment.assignmentId,
				assignment.revision + 2,
				env.attemptId,
				"endo.evidence.wrong-auth-id",
			);
			expect(badClear.ok).toBe(false);
		}

		// #7A: Stale disconnected snapshot with confirmed OS scope cleanup MUST emit `stale-observation` with
		// `termination.confirmed: false`, and protocol rejects `confirmed: true` on non-`termination-confirmed` states.
		const d = adapter.describe();
		const s = adapter.snapshot();
		const staleDisconnected = endoObserveAdapterLivenessV0(
			{
				describe: () => d,
				snapshot: () => ({
					...s,
					observedAt: new Date(Date.now() - 300_000).toISOString(),
					connection: { state: "disconnected", reason: "stopped" },
					processCleanup: {
						boundary: "scope",
						result: "confirmed",
						remainingProcesses: 0,
						scopeName: "endo-stale.scope",
					},
				}),
			},
			{ nowMs: Date.now(), staleAfterMs: 60_000 },
		);
		expect(staleDisconnected.state).toBe("stale-observation");
		expect(staleDisconnected.termination.confirmed).toBe(false);
		expect(() =>
			validateEndoSessionLivenessObservationV0({
				...staleDisconnected,
				termination: { ...staleDisconnected.termination, confirmed: true },
			}),
		).toThrow();

		// #10: Multiline/control-character transport error reason is sanitized and written cleanly to `.outcome.json`.
		const env10 = createRepoStore("repo-adv-10");
		const adapter10 = await createLiveCodexAdapter({
			root: env10.root,
			worktree: env10.repo,
			attachmentId: "codex.adv10",
		});
		const { assignment: a10 } = bindAssignment(env10, { adapter: adapter10 });
		adapter10.dispatch = async () => {
			throw new Error("transport failed\nwith newline\tand\x00control");
		};
		const out10 = await dispatchEndoAssignmentAttemptV0({
			root: env10.root,
			assignmentId: a10.assignmentId,
			attemptId: env10.attemptId,
			adapter: adapter10,
			approve: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		expect(out10.status).toBe("unknown");
		if (out10.status === "unknown") {
			expect(out10.outcomeRecord).not.toBeNull();
			expect(out10.outcomeRecord?.reason).toBe("transport failed with newline and control");
		}

		// #11: Cross-project `attemptId` on advisory review is refused `cross-project`.
		const repoB = join(env10.base, "repo-b");
		mkdirSync(repoB);
		git(repoB, "init", "-q");
		writeFileSync(join(repoB, "b.txt"), "b\n");
		git(repoB, "add", "b.txt");
		git(repoB, "commit", "-q", "-m", "b");
		const projB = env10.tasks.registerProject({ name: "proj-b", path: repoB, observedGitRoot: repoB });
		if (!projB.ok) throw new Error(projB.code);
		const taskB = env10.tasks.createTask(projB.value.id, { title: "Task B" });
		if (!taskB.ok) throw new Error(taskB.code);
		const prepB = new DevelopAttemptsServiceV0(env10.tasks, env10.attempts).prepare(projB.value.id, taskB.value.id, {
			objective: "Attempt B",
		});
		if (!prepB.ok) throw new Error(prepB.code);
		const curCoord10 = env10.coord.read();
		if (!curCoord10.ok) throw new Error(curCoord10.reason);
		const cand10 = env10.coord.declareCandidate({
			expectedFileRevision: curCoord10.file.revision,
			projectId: env10.projectId,
			taskId: env10.taskId,
			candidate: {
				kind: "git-commit",
				commonDir: join(env10.repo, ".git"),
				worktreePath: env10.repo,
				commitSha: env10.headSha,
				treeSha: env10.treeSha,
				attemptId: null,
			},
		});
		if (!cand10.ok) throw new Error(cand10.code);
		const crossAttReview = new DevelopCoordinationReviewsStoreV0(env10.root).recordReview({
			projectId: env10.projectId,
			candidateTaskId: env10.taskId,
			candidateId: cand10.value.candidateId,
			assignmentId: null,
			attemptId: prepB.value.id,
			reviewer: { participantId: "pi-reviewer", harnessFamily: "pi", sessionKey: null, runtimeFingerprintId: null },
			verdict: "comment",
			summary: "Foreign attempt id check",
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
		expect(crossAttReview).toMatchObject({ ok: false, code: "cross-project" });
	});

	it("Codex review regressions (P1 #1 sibling pointer mid-approval, P1 #2 workbench session check, P2 #3 Pi payload.instance, P2 #4 verifiedCandidates forwarding)", async () => {
		// P1 #1: Tampering with a registered sibling worktree's `.git` pointer WHILE operator approval is pending
		// MUST be caught inside `commitAssignmentDispatch` under `coordination.lock.<n>` with zero route claim!
		const env1 = createRepoStore("repo-codex-p1");
		const sibling = join(env1.base, "codex-p1-sibling");
		git(env1.repo, "worktree", "add", "-q", "-b", "codex-p1-wt", sibling);
		const foreign = join(env1.base, "codex-p1-foreign");
		mkdirSync(foreign);
		git(foreign, "init", "-q");
		writeFileSync(join(foreign, "f.txt"), "f\n");
		git(foreign, "add", "f.txt");
		git(foreign, "commit", "-q", "-m", "foreign");
		const tasksRead = env1.tasks.read();
		if (!tasksRead.ok) throw new Error(tasksRead.reason);
		const val = await new DevelopCoordinationGitV0().validateSiblingWorktree(tasksRead.file.projects[0]!, sibling);
		if (!val.ok) throw new Error(val.detail);
		const reg = env1.coord.registerWorktree({
			expectedFileRevision: 0,
			projectId: env1.projectId,
			worktreePath: val.worktree.worktreePath,
			commonDir: val.worktree.commonDir,
			gitDir: val.worktree.gitDir,
		});
		if (!reg.ok) throw new Error(reg.code);
		const adapter = await createLiveCodexAdapter({ root: env1.root, worktree: sibling });
		const { assignment: a1 } = bindAssignment(env1, {
			adapter,
			worktreePath: sibling,
			registration: "registered-sibling",
			expectedFileRevision: reg.file.revision,
		});
		const tamperedRes = await dispatchEndoAssignmentAttemptV0({
			root: env1.root,
			assignmentId: a1.assignmentId,
			attemptId: env1.attemptId,
			adapter,
			approve: async () => {
				// Replace sibling's `.git` pointer with foreign repo pointer mid-approval!
				writeFileSync(join(sibling, ".git"), `gitdir: ${join(foreign, ".git")}\n`);
				return { approved: true, mechanism: "terminal-phrase" };
			},
		});
		expect(tamperedRes).toMatchObject({
			status: "refused",
			stage: "commit",
			code: "worktree-not-registered",
			routeClaimed: false,
		});
		expect(DevelopAttemptRoutesStoreV0.forRoot(env1.root).read(env1.attemptId).state).toBe("absent");

		// P1 #2 & P2 #4: Workbench `authorize()` validates declared assignment session AND forwards `verifiedCandidates`!
		const env2 = createRepoStore("repo-codex-p2");
		const task2 = env2.tasks.createTask(env2.projectId, { title: "Dependent Pi task" });
		if (!task2.ok) throw new Error(task2.code);
		const cand1 = env2.coord.declareCandidate({
			expectedFileRevision: 0,
			projectId: env2.projectId,
			taskId: env2.taskId,
			candidate: {
				kind: "git-commit",
				commonDir: join(env2.repo, ".git"),
				worktreePath: env2.repo,
				commitSha: env2.headSha,
				treeSha: env2.treeSha,
				attemptId: null,
			},
		});
		if (!cand1.ok) throw new Error(cand1.code);
		const dep = env2.coord.addDependency({
			expectedFileRevision: cand1.file.revision,
			projectId: env2.projectId,
			dependentTaskId: task2.value.id,
			prerequisiteTaskId: env2.taskId,
			condition: "candidate-declared",
		});
		if (!dep.ok) throw new Error(dep.code);
		const prep2 = new DevelopAttemptsServiceV0(env2.tasks, env2.attempts).prepare(env2.projectId, task2.value.id, {
			objective: "Work after candidate declared",
		});
		if (!prep2.ok) throw new Error(prep2.code);
		const a2Create = env2.coord.createAssignment({
			expectedFileRevision: dep.file.revision,
			expectedTaskRevision: 0,
			projectId: env2.projectId,
			taskId: task2.value.id,
			participant: { participantId: "pi-builder", role: "builder", intendedHarnessFamily: "pi" },
			workspace: {
				worktreePath: env2.repo,
				registration: "project-path",
				accessIntent: "read-write-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		if (!a2Create.ok) throw new Error(a2Create.code);
		const a2Sess = env2.coord.associateSession(a2Create.value.assignmentId, a2Create.value.revision, {
			source: "pi-live",
			sessionKey: "pi-live:persistent:endo.session.pi.approved",
			attachmentId: "pi.default",
			instanceId: "pi-inst-old",
			runtimeFingerprintId: null,
		});
		if (!a2Sess.ok) throw new Error(a2Sess.code);
		const a2Link = env2.coord.linkAttempt(a2Sess.value.assignmentId, a2Sess.value.revision, prep2.value.id);
		if (!a2Link.ok) throw new Error(a2Link.code);

		const piDispatch = new DevelopAttemptDispatchV0(env2.tasks, env2.attempts, {
			projectId: env2.projectId,
			launchDirectory: env2.repo,
		});
		const verifiedCandidates = new Map([[cand1.value.candidateId, "verified" as const]]);
		const assignBinding = {
			assignmentId: a2Link.value.assignmentId,
			expectedAssignmentRevision: a2Link.value.revision,
			verifiedCandidates,
		};
		const checked = piDispatch.check(prep2.value.id, assignBinding);
		if (!checked.ok) throw new Error(`pi check failed: ${checked.code}`);

		// Wrong session (`endo.session.pi.different`) MUST be refused `session-binding-stale` with zero route claim!
		const wrongSession = piDispatch.authorize(
			checked.value,
			{
				session: "endo.session.pi.different",
				attachment: "pi.default",
				launchId: "2".repeat(16),
				proposalId: `endo.evidence.workbench-prompt-${"2".repeat(32)}`,
				proposalDigest: "a".repeat(64),
				authorizationEventId: `endo.event.${"2".repeat(32)}`,
				message: {
					digest: { algorithm: "hmac-sha256", keyId: "k1", value: "b".repeat(64) },
					bytes: Buffer.byteLength(checked.value.brief),
				},
				instanceId: "pi-inst-old",
			},
			assignBinding,
		);
		expect(wrongSession).toEqual({ ok: false, code: "session-binding-stale" });
		expect(DevelopAttemptRoutesStoreV0.forRoot(env2.root).read(prep2.value.id).state).toBe("absent");

		// Matching session (`endo.session.pi.approved`) + forwarded `verifiedCandidates` SUCCEEDS!
		const rightSession = piDispatch.authorize(
			checked.value,
			{
				session: "endo.session.pi.approved",
				attachment: "pi.default",
				launchId: "2".repeat(16),
				proposalId: `endo.evidence.workbench-prompt-${"2".repeat(32)}`,
				proposalDigest: "a".repeat(64),
				authorizationEventId: `endo.event.${"2".repeat(32)}`,
				message: {
					digest: { algorithm: "hmac-sha256", keyId: "k1", value: "b".repeat(64) },
					bytes: Buffer.byteLength(checked.value.brief),
				},
				instanceId: "pi-inst-old",
			},
			assignBinding,
		);
		expect(rightSession.ok, rightSession.ok ? "" : rightSession.code).toBe(true);

		// P2 #3: Pi `harness.attached` event using `payload.instance` (not `payload.instanceId`) triggers
		// `instanceStatus: "recorded-instance-superseded"` for a Pi assignment bound to `pi-inst-old`!
		const eventStore = createEndoDurableEventStoreV0(env2.root);
		try {
			eventStore.ingest({
				schemaVersion: "endo.event.v0",
				id: `endo.event.${"9".repeat(32)}`,
				kind: "harness.attached",
				source: "runtime-fact",
				sequence: 1,
				at: new Date().toISOString(),
				coordinates: { sessionId: "endo.session.pi.approved" },
				producer: "pi.default",
				derivedFrom: [],
				payload: { instance: "pi-inst-new", piSessionId: "approved" },
			});
		} finally {
			eventStore.close();
		}
		const projPi = await readEndoCoordinatorCoordinationV0({ root: env2.root, projects: [env2.projectId] });
		const piAssignView = projPi.projects[0]?.assignments.find((a) => a.assignmentId === a2Link.value.assignmentId);
		expect(piAssignView?.session?.instanceStatus).toBe("recorded-instance-superseded");
		expect(piAssignView?.findings).toContain("recorded-instance-superseded");
	});
});
