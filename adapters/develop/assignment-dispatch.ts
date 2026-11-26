// Harness-neutral governed assignment-attempt dispatcher (E2-A & E2-B, docs/designs/coordinator-assignment.md §6.2–§6.3).
//
// Connects operator-confirmed assignments in `develop/coordination.json` to governed execution across ANY admitted
// live harness implementing `EndoDevelopLiveAdapterV0` (Pi and Codex), without introducing a competing execution
// abstraction or separate reservation domain:
// - Shares `<root>/develop/attempt-routes/<attemptId>.route.json` (`route: "adapter-live"`) with Pi workbench and
//   protected attempts.
// - Linearises final assignment/task/dependency/worktree/hazard checks + `.route.json` claim + write-once
//   `develop/adapter-authorizations/<attemptId>.authorized.json` + `assignment.dispatchedAttemptIds` inside
//   `<root>/develop/coordination.lock.<n>` and releases the lock BEFORE harness transport I/O.
// - Preserves Strict-only Codex enforcement (`session-grant` refused for Codex), Pi Everyday boundaries, native
//   approval separation inside the adapter, honest unsupported operation refusals, and conservative recovery
//   (zero automatic retries on partial commit, pre-transport abort, or unknown transport outcome).

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import type { EndoCandidateIdentityReadingV0 } from "../../protocol/coordinator-coordination.ts";
import {
	type EndoAdapterAuthorityMechanismV0,
	type EndoDevelopAuthorityProofV0,
	type EndoDevelopDispatchOutcomeV0,
	type EndoDevelopOperationRequestV0,
	endoAdapterSessionKeyV0,
} from "../../protocol/develop-adapter.ts";
import {
	ENDO_DEVELOP_ADAPTER_ABORT_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_AUTHORIZATION_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_OUTCOME_SCHEMA_V0,
	type EndoAdapterAbortObservedStateV0,
	type EndoDevelopAdapterAbortV0,
	type EndoDevelopAdapterAuthorizationV0,
	type EndoDevelopAdapterOutcomeV0,
} from "../../protocol/develop-adapter-authorization.ts";
import {
	ENDO_ATTEMPT_ID_PATTERN_V0,
	endoDevelopTaskWordsChangedV0,
	renderEndoDevelopBriefV0,
} from "../../protocol/develop-attempts.ts";
import { ENDO_ASSIGNMENT_ID_PATTERN_V0 } from "../../protocol/develop-coordination.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	type EndoDevelopAdmissionOptionsV0,
	type EndoDevelopLiveAdapterV0,
	endoDevelopOperationPayloadDigestV0,
} from "../../runtime/contracts/develop-adapter.ts";
import { endoBriefSha256V0 } from "../../runtime/contracts/develop-attempt-execution.ts";
import { DevelopAdapterAuthorizationsStoreV0 } from "../../storage/develop-adapter-authorizations.ts";
import { DevelopAttemptsStoreV0, endoAttemptProblemsOfV0 } from "../../storage/develop-attempts.ts";
import {
	DevelopCoordinationStoreV0,
	type EndoDevelopCoordinationStoreOptionsV0,
} from "../../storage/develop-coordination.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { DevelopCoordinationGitV0 } from "./coordination.ts";

export interface EndoAssignmentDispatchPlanV0 {
	readonly assignmentId: string;
	readonly assignmentRevision: number;
	readonly projectId: string;
	readonly taskId: string;
	readonly taskRevision: number;
	readonly attemptId: string;
	readonly brief: string;
	readonly briefSha256: string;
	readonly proposalDigest: string;
	readonly harnessFamily: "pi" | "codex";
	readonly source: "pi-live" | "codex-live";
	readonly controlPath: "pi-workbench-broker" | "codex-live-controller";
	readonly sessionKey: string;
	readonly attachmentId: string;
	readonly launchId: string;
	readonly instanceId: string;
	readonly runtimeFingerprintId: string;
	readonly worktreePath: string;
	readonly verifiedWorktree?: { commonDir: string; gitDir: string | null };
	readonly verifiedCandidates: ReadonlyMap<string, EndoCandidateIdentityReadingV0>;
	readonly request: EndoDevelopOperationRequestV0;
	readonly payloadDigest: string;
	readonly requiredPhrase: string;
}

export type EndoAssignmentDispatchPlanResultV0 =
	| { ok: true; plan: EndoAssignmentDispatchPlanV0 }
	| {
			ok: false;
			code:
				| "bad-request"
				| "not-found"
				| "unreadable"
				| "tasks-unreadable"
				| "attempts-unreadable"
				| "assignment-not-active"
				| "attempt-not-linked"
				| "cross-project"
				| "task-done"
				| "task-words-changed"
				| "stale-revision"
				| "worktree-not-registered"
				| "session-binding-stale"
				| "already-authorized"
				| "admission-refused";
			admissionCode?: string;
			detail: string;
	  };

export type EndoAssignmentDispatchApprovalV0 =
	| {
			readonly approved: true;
			readonly mechanism: EndoAdapterAuthorityMechanismV0;
			readonly sessionGrantId?: string | null;
			readonly via?: "controlling-terminal" | "workbench-terminal";
	  }
	| { readonly approved: false; readonly reason: string };

export type EndoAssignmentDispatchOutcomeV0 =
	| {
			readonly status: "accepted" | "refused" | "unknown";
			readonly stage: "transport";
			readonly attemptId: string;
			readonly assignmentId: string;
			readonly authorization: EndoDevelopAdapterAuthorizationV0;
			readonly transportOutcome: EndoDevelopDispatchOutcomeV0;
			readonly outcomeRecord: EndoDevelopAdapterOutcomeV0 | null;
			readonly routeClaimed: true;
	  }
	| {
			readonly status: "aborted-before-transport";
			readonly attemptId: string;
			readonly assignmentId: string;
			readonly authorization: EndoDevelopAdapterAuthorizationV0;
			readonly abortRecord: EndoDevelopAdapterAbortV0 | null;
			readonly observedAssignmentState: EndoAdapterAbortObservedStateV0;
			readonly hazardCleared: boolean;
			readonly routeClaimed: true;
	  }
	| {
			readonly status: "declined";
			readonly attemptId: string;
			readonly assignmentId: string;
			readonly reason: string;
			readonly routeClaimed: false;
	  }
	| {
			readonly status: "refused";
			readonly stage: "plan" | "commit" | "authority";
			readonly attemptId: string;
			readonly assignmentId: string;
			readonly code: string;
			readonly admissionCode?: string;
			readonly detail: string;
			readonly routeClaimed: boolean;
			readonly authorizationWritten: boolean;
	  };

export interface EndoAssignmentDispatchOptionsV0 {
	readonly root: string;
	readonly assignmentId: string;
	readonly attemptId: string;
	readonly adapter: EndoDevelopLiveAdapterV0;
	/** Optional override operation (defaults to `{ kind: "prompt", message: brief }`). Useful for testing unsupported ops. */
	readonly buildRequest?: (brief: string) => EndoDevelopOperationRequestV0;
	readonly approve: (plan: EndoAssignmentDispatchPlanV0) => Promise<EndoAssignmentDispatchApprovalV0>;
	readonly admissionOptions?: Omit<EndoDevelopAdmissionOptionsV0, "nowMs">;
	readonly coordinationOptions?: EndoDevelopCoordinationStoreOptionsV0;
	readonly git?: DevelopCoordinationGitV0;
	readonly approvalTtlMs?: number;
	readonly now?: () => number;
	/** Test hook: runs AFTER `coordination.lock.<n>` release and BEFORE the pre-transport revocation check & harness write (window W2). */
	readonly beforeTransportWrite?: () => void | Promise<void>;
	/** Whether to attempt conservative hazard clearing after a clean pre-transport abort. Default: true. */
	readonly attemptHazardClearOnPreTransportAbort?: boolean;
}

const real = (p: string): string | null => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

export function computeEndoAssignmentProposalDigestV0(fields: {
	attemptId: string;
	briefSha256: string;
	projectId: string;
	taskId: string;
	taskRevision: number;
	assignmentId: string;
	assignmentRevision: number;
	harnessFamily: string;
	source: string;
	controlPath: string;
	sessionKey: string;
	attachmentId: string;
	launchId: string;
	instanceId: string;
	runtimeFingerprintId: string;
	worktreePath: string;
	operationKind: string;
	payloadDigest: string;
}): string {
	return sha256HexV0(canonicalEndoJsonV0(fields as never));
}

/**
 * Preflight plan for an assignment-linked attempt dispatch (read-only, runs outside `coordination.lock.<n>`).
 * Re-validates worktree registration (including sibling worktree identity & symlink/pointer safety), prerequisite
 * candidate identities, live adapter session/instance binding, and adapter admission before asking the operator.
 */
export async function planEndoAssignmentDispatchV0(args: {
	root: string;
	assignmentId: string;
	attemptId: string;
	adapter: EndoDevelopLiveAdapterV0;
	buildRequest?: (brief: string) => EndoDevelopOperationRequestV0;
	admissionOptions?: Omit<EndoDevelopAdmissionOptionsV0, "nowMs">;
	git?: DevelopCoordinationGitV0;
	now?: () => number;
}): Promise<EndoAssignmentDispatchPlanResultV0> {
	const refuse = (
		code: Extract<EndoAssignmentDispatchPlanResultV0, { ok: false }>["code"],
		detail: string,
		admissionCode?: string,
	): EndoAssignmentDispatchPlanResultV0 => ({
		ok: false,
		code,
		detail,
		...(admissionCode === undefined ? {} : { admissionCode }),
	});
	const now = args.now ?? Date.now;
	const git = args.git ?? new DevelopCoordinationGitV0();

	if (!ENDO_ASSIGNMENT_ID_PATTERN_V0.test(args.assignmentId) || !ENDO_ATTEMPT_ID_PATTERN_V0.test(args.attemptId))
		return refuse("bad-request", "invalid assignmentId or attemptId");

	const coordRead = new DevelopCoordinationStoreV0(args.root).read();
	if (!coordRead.ok) return refuse("unreadable", `coordination store unreadable (${coordRead.reason})`);
	if (!coordRead.exists) return refuse("not-found", `assignment ${args.assignmentId}`);

	const assignment = coordRead.file.assignments.find((a) => a.assignmentId === args.assignmentId);
	if (assignment === undefined) return refuse("not-found", `assignment ${args.assignmentId}`);
	if (assignment.state !== "active")
		return refuse("assignment-not-active", `assignment ${args.assignmentId} is ${assignment.state}`);
	if (!assignment.attemptIds.includes(args.attemptId))
		return refuse("attempt-not-linked", `attempt ${args.attemptId} is not linked to ${args.assignmentId}`);

	const tasksRead = new DevelopTasksStoreV0(args.root).read();
	if (!tasksRead.ok) return refuse("tasks-unreadable", `tasks unreadable (${tasksRead.reason})`);
	const project = tasksRead.file.projects.find((p) => p.id === assignment.projectId);
	if (project === undefined) return refuse("not-found", `project ${assignment.projectId}`);
	const task = tasksRead.file.tasks.find((t) => t.id === assignment.taskId && t.projectId === assignment.projectId);
	if (task === undefined) return refuse("not-found", `task ${assignment.taskId}`);
	if (task.status === "done") return refuse("task-done", `task ${assignment.taskId} is done`);
	if (task.revision !== assignment.taskRevisionAtBind)
		return refuse(
			"stale-revision",
			`assignment is bound to task revision ${assignment.taskRevisionAtBind}, current is ${task.revision}`,
		);

	// Revalidate worktree OUTSIDE the lock (AT13/AT14).
	let verifiedWorktree: { commonDir: string; gitDir: string | null } | undefined;
	if (assignment.workspace.registration === "project-path") {
		const primaryReal = real(project.path);
		if (primaryReal === null || primaryReal !== assignment.workspace.worktreePath)
			return refuse("worktree-not-registered", "project primary worktree path does not match or is missing");
	} else if (assignment.workspace.registration === "registered-sibling") {
		const reg = (coordRead.file.registeredWorktrees ?? []).find(
			(w) => w.projectId === assignment.projectId && w.worktreePath === assignment.workspace.worktreePath,
		);
		if (reg === undefined)
			return refuse("worktree-not-registered", "sibling worktree is not registered in coordination.json");
		const reval = await git.revalidateRegisteredWorktree(project, reg);
		if (!reval.ok) return refuse("worktree-not-registered", reval.detail);
		verifiedWorktree = { commonDir: reval.worktree.commonDir, gitDir: reval.worktree.gitDir };
	} else {
		return refuse(
			"worktree-not-registered",
			"unregistered sibling worktrees are refused for governed execution; register with `endo worktree register`",
		);
	}

	const attemptsRead = new DevelopAttemptsStoreV0(args.root).read();
	if (!attemptsRead.ok) return refuse("attempts-unreadable", `attempts unreadable (${attemptsRead.reason})`);
	if (endoAttemptProblemsOfV0(attemptsRead.problems, args.attemptId).length > 0)
		return refuse("unreadable", `attempt ${args.attemptId} has unreadable records`);
	const entry = attemptsRead.entries.find((e) => e.attempt.id === args.attemptId);
	if (entry === undefined) return refuse("not-found", `attempt ${args.attemptId}`);
	if (entry.attempt.projectId !== assignment.projectId || entry.attempt.taskId !== assignment.taskId)
		return refuse("cross-project", "attempt does not belong to assignment's project/task");
	if (endoDevelopTaskWordsChangedV0(entry.attempt, task).length > 0)
		return refuse("task-words-changed", "task words changed since attempt preparation");

	// Re-verify candidate identities for prerequisite tasks OUTSIDE the lock.
	const verifiedCandidates = new Map<string, EndoCandidateIdentityReadingV0>();
	const prereqTaskIds = new Set(
		coordRead.file.dependencies
			.filter((d) => d.projectId === assignment.projectId && d.dependentTaskId === assignment.taskId)
			.map((d) => d.prerequisiteTaskId),
	);
	for (const tc of coordRead.file.taskCandidates) {
		if (tc.projectId !== assignment.projectId || !prereqTaskIds.has(tc.taskId)) continue;
		const current = tc.candidates.find((c) => c.candidateId === tc.currentCandidateId);
		if (current !== undefined) {
			verifiedCandidates.set(current.candidateId, await git.identity(args.root, current));
		}
	}

	// Inspect live adapter descriptor & snapshot (in-process live staleness check, AT11).
	const d = args.adapter.describe();
	const s = args.adapter.snapshot();
	const sessionKey = endoAdapterSessionKeyV0(d.session);
	if (
		(d.harness.family !== "pi" && d.harness.family !== "codex") ||
		(d.session.source !== "pi-live" && d.session.source !== "codex-live") ||
		(d.controlPath !== "pi-workbench-broker" && d.controlPath !== "codex-live-controller")
	)
		return refuse(
			"admission-refused",
			`adapter ${d.harness.family}/${d.session.source}/${d.controlPath} is not an admitted live production harness`,
			"control-path-mismatch",
		);
	if (sessionKey === null || s.sessionKey !== sessionKey)
		return refuse("session-binding-stale", "live adapter has no established session key", "cross-session-control");
	if (d.runtimeFingerprint.status !== "identified")
		return refuse("admission-refused", d.runtimeFingerprint.reason, "runtime-unidentified");

	// Verify live adapter matches the assignment's declared session binding when present (AT11).
	if (assignment.session !== null) {
		if (
			assignment.session.source !== d.session.source ||
			assignment.session.sessionKey !== sessionKey ||
			assignment.session.attachmentId !== d.attachment.attachmentId
		) {
			return refuse(
				"session-binding-stale",
				`live adapter (${d.session.source} / ${sessionKey}) does not match assignment session (${assignment.session.source} / ${assignment.session.sessionKey})`,
				"cross-session-control",
			);
		}
		if (assignment.session.instanceId !== null && assignment.session.instanceId !== d.attachment.instanceId) {
			return refuse(
				"session-binding-stale",
				`live runtime instanceId (${d.attachment.instanceId}) differs from assignment binding (${assignment.session.instanceId})`,
				"stale-attachment",
			);
		}
		if (
			assignment.session.runtimeFingerprintId !== null &&
			assignment.session.runtimeFingerprintId !== d.runtimeFingerprint.fingerprintId
		) {
			return refuse(
				"session-binding-stale",
				`live runtime fingerprint (${d.runtimeFingerprint.fingerprintId}) differs from assignment binding (${assignment.session.runtimeFingerprintId})`,
				"capability-stale",
			);
		}
	}
	if (d.attachment.projectScope !== assignment.workspace.worktreePath) {
		return refuse(
			"admission-refused",
			`adapter projectScope (${d.attachment.projectScope ?? "null"}) does not match assignment worktree (${assignment.workspace.worktreePath})`,
			"project-scope-mismatch",
		);
	}

	const brief = renderEndoDevelopBriefV0(entry.attempt);
	const briefSha256 = endoBriefSha256V0(brief);
	const request: EndoDevelopOperationRequestV0 =
		args.buildRequest !== undefined ? args.buildRequest(brief) : { kind: "prompt", message: brief };
	let payloadDigest: string;
	try {
		payloadDigest = endoDevelopOperationPayloadDigestV0(request);
	} catch {
		return refuse("bad-request", "operation request could not be canonicalized");
	}

	// Probe admission gate BEFORE asking the operator (catches unsupported operations like Pi `queue` on Codex, AT21).
	const nowPre = now();
	const probeProof: EndoDevelopAuthorityProofV0 = {
		authorizationId: `endo.evidence.probe.${randomBytes(8).toString("hex")}`,
		operation: request.kind,
		source: d.session.source,
		sessionKey,
		attachmentId: d.attachment.attachmentId,
		launchId: d.attachment.launchId,
		instanceId: d.attachment.instanceId,
		controlPath: d.controlPath,
		projectScope: d.attachment.projectScope,
		payloadDigest,
		mechanism: "terminal-phrase",
		sessionGrantId: null,
		authorizedAtMs: nowPre,
		expiresAtMs: nowPre + 60_000,
	};
	const preAdmit = args.adapter.admitOperation(request, probeProof, {
		mode: "production",
		...args.admissionOptions,
		nowMs: nowPre,
	});
	if (!preAdmit.admitted) return refuse("admission-refused", preAdmit.reason, preAdmit.code);

	const proposalDigest = computeEndoAssignmentProposalDigestV0({
		attemptId: args.attemptId,
		briefSha256,
		projectId: assignment.projectId,
		taskId: assignment.taskId,
		taskRevision: task.revision,
		assignmentId: assignment.assignmentId,
		assignmentRevision: assignment.revision,
		harnessFamily: d.harness.family,
		source: d.session.source,
		controlPath: d.controlPath,
		sessionKey,
		attachmentId: d.attachment.attachmentId,
		launchId: d.attachment.launchId,
		instanceId: d.attachment.instanceId,
		runtimeFingerprintId: d.runtimeFingerprint.fingerprintId,
		worktreePath: assignment.workspace.worktreePath,
		operationKind: request.kind,
		payloadDigest,
	});

	return {
		ok: true,
		plan: {
			assignmentId: assignment.assignmentId,
			assignmentRevision: assignment.revision,
			projectId: assignment.projectId,
			taskId: assignment.taskId,
			taskRevision: task.revision,
			attemptId: args.attemptId,
			brief,
			briefSha256,
			proposalDigest,
			harnessFamily: d.harness.family,
			source: d.session.source,
			controlPath: d.controlPath,
			sessionKey,
			attachmentId: d.attachment.attachmentId,
			launchId: d.attachment.launchId,
			instanceId: d.attachment.instanceId,
			runtimeFingerprintId: d.runtimeFingerprint.fingerprintId,
			worktreePath: assignment.workspace.worktreePath,
			...(verifiedWorktree === undefined ? {} : { verifiedWorktree }),
			verifiedCandidates,
			request,
			payloadDigest,
			requiredPhrase: `APPROVE ATTEMPT ${proposalDigest.slice(0, 8)}`,
		},
	};
}

/**
 * Full governed assignment-linked dispatch across any admitted `EndoDevelopLiveAdapterV0` (Codex or Pi).
 */
export async function dispatchEndoAssignmentAttemptV0(
	options: EndoAssignmentDispatchOptionsV0,
): Promise<EndoAssignmentDispatchOutcomeV0> {
	const now = options.now ?? Date.now;
	const ttlMs = options.approvalTtlMs ?? 60_000;

	const planned = await planEndoAssignmentDispatchV0({
		root: options.root,
		assignmentId: options.assignmentId,
		attemptId: options.attemptId,
		adapter: options.adapter,
		...(options.buildRequest === undefined ? {} : { buildRequest: options.buildRequest }),
		...(options.admissionOptions === undefined ? {} : { admissionOptions: options.admissionOptions }),
		...(options.git === undefined ? {} : { git: options.git }),
		now,
	});
	if (!planned.ok) {
		return {
			status: "refused",
			stage: "plan",
			attemptId: options.attemptId,
			assignmentId: options.assignmentId,
			code: planned.code,
			...(planned.admissionCode === undefined ? {} : { admissionCode: planned.admissionCode }),
			detail: planned.detail,
			routeClaimed: false,
			authorizationWritten: false,
		};
	}
	const { plan } = planned;

	// Operator explicit approval (runs OUTSIDE `coordination.lock.<n>`).
	const approval = await options.approve(plan);
	if (!approval.approved) {
		return {
			status: "declined",
			attemptId: plan.attemptId,
			assignmentId: plan.assignmentId,
			reason: approval.reason,
			routeClaimed: false,
		};
	}
	// Prepared work attempts NEVER accept `session-grant` on either Codex (Strict-only) or Pi (Everyday grants
	// explicitly exclude prepared work attempts, matching `adapters/pi/workbench.ts`; Adversarial Finding #9).
	if (approval.mechanism === "session-grant") {
		return {
			status: "refused",
			stage: "authority",
			attemptId: plan.attemptId,
			assignmentId: plan.assignmentId,
			code: "session-grant-not-permitted",
			detail:
				plan.harnessFamily === "codex"
					? "Session grants are never permitted for Codex (Strict-only); explicit terminal confirmation is required."
					: "Session grants never cover prepared work attempts on Pi Everyday; explicit terminal confirmation is required.",
			routeClaimed: false,
			authorizationWritten: false,
		};
	}

	const approvedAtMs = now();
	const authorizationId = `endo.evidence.adapter-auth.${randomBytes(12).toString("hex")}`;
	const authorityProof: EndoDevelopAuthorityProofV0 = {
		authorizationId,
		operation: plan.request.kind,
		source: plan.source,
		sessionKey: plan.sessionKey,
		attachmentId: plan.attachmentId,
		launchId: plan.launchId,
		instanceId: plan.instanceId,
		controlPath: plan.controlPath,
		projectScope: plan.worktreePath,
		payloadDigest: plan.payloadDigest,
		mechanism: approval.mechanism,
		sessionGrantId: null,
		authorizedAtMs: approvedAtMs,
		expiresAtMs: approvedAtMs + ttlMs,
	};

	// Atomic commitment inside `coordination.lock.<n>` (released BEFORE harness transport I/O).
	const coordStore = new DevelopCoordinationStoreV0(options.root, {
		now,
		...options.coordinationOptions,
	});
	const committed = coordStore.commitAssignmentDispatch({
		assignmentId: plan.assignmentId,
		expectedAssignmentRevision: plan.assignmentRevision,
		expectedTaskRevision: plan.taskRevision,
		projectId: plan.projectId,
		taskId: plan.taskId,
		attemptId: plan.attemptId,
		expectedBriefSha256: plan.briefSha256,
		worktreePath: plan.worktreePath,
		...(plan.verifiedWorktree === undefined ? {} : { verifiedWorktree: plan.verifiedWorktree }),
		verifiedCandidates: plan.verifiedCandidates,
		sessionBinding: {
			source: plan.source,
			sessionKey: plan.sessionKey,
			attachmentId: plan.attachmentId,
			instanceId: plan.instanceId,
			runtimeFingerprintId: plan.runtimeFingerprintId,
		},
		route: "adapter-live",
		admitInLock: () =>
			options.adapter.admitOperation(plan.request, authorityProof, {
				mode: "production",
				...options.admissionOptions,
				nowMs: now(),
			}),
		adapterAuthorization: {
			schemaVersion: ENDO_DEVELOP_ADAPTER_AUTHORIZATION_SCHEMA_V0,
			attemptId: plan.attemptId,
			authorizationId,
			projectId: plan.projectId,
			taskId: plan.taskId,
			taskRevision: plan.taskRevision,
			assignmentId: plan.assignmentId,
			assignmentRevision: plan.assignmentRevision,
			briefSha256: plan.briefSha256,
			proposalDigest: plan.proposalDigest,
			harnessFamily: plan.harnessFamily,
			source: plan.source,
			controlPath: plan.controlPath,
			sessionKey: plan.sessionKey,
			attachmentId: plan.attachmentId,
			launchId: plan.launchId,
			instanceId: plan.instanceId,
			runtimeFingerprintId: plan.runtimeFingerprintId,
			worktreePath: plan.worktreePath,
			mechanism: approval.mechanism,
			sessionGrantId: authorityProof.sessionGrantId,
			approvedBy: "operator",
			via: approval.via ?? "controlling-terminal",
		},
	});

	if (!committed.ok) {
		return {
			status: "refused",
			stage: "commit",
			attemptId: plan.attemptId,
			assignmentId: plan.assignmentId,
			code: committed.code,
			...(committed.admissionCode === undefined ? {} : { admissionCode: committed.admissionCode }),
			detail: committed.detail ?? committed.code,
			routeClaimed: committed.routeClaimed,
			authorizationWritten: committed.authorizationWritten,
		};
	}

	const authorization = committed.adapterAuthorization as EndoDevelopAdapterAuthorizationV0;
	const authStore = DevelopAdapterAuthorizationsStoreV0.forRoot(options.root);

	// Test hook for crash/revocation window W2 (after lock release, before transport write).
	await options.beforeTransportWrite?.();

	// Best-effort pre-transport revocation check (Winner B, Boundary B3).
	const postCommitRead = coordStore.read();
	let observedAbortState: EndoAdapterAbortObservedStateV0 | null = null;
	if (!postCommitRead.ok) {
		observedAbortState = "unreadable";
	} else {
		const latest = postCommitRead.file.assignments.find((a) => a.assignmentId === plan.assignmentId);
		if (latest === undefined) observedAbortState = "missing";
		else if (latest.state !== "active") observedAbortState = latest.state;
		else if (latest.revision !== committed.assignment.revision) observedAbortState = "revision-changed";
	}

	if (observedAbortState !== null) {
		const abortRecord: EndoDevelopAdapterAbortV0 = {
			schemaVersion: ENDO_DEVELOP_ADAPTER_ABORT_SCHEMA_V0,
			attemptId: plan.attemptId,
			authorizationId: authorization.authorizationId,
			recordedAtMs: now(),
			reason: "dispatch-aborted-post-reservation",
			assignmentId: plan.assignmentId,
			observedAssignmentState: observedAbortState,
			recordedBy: "controller",
		};
		const abortWritten = authStore.writeAbort(abortRecord);
		let hazardCleared = false;
		if (abortWritten === "created" && options.attemptHazardClearOnPreTransportAbort !== false && postCommitRead.ok) {
			const latest = postCommitRead.file.assignments.find((a) => a.assignmentId === plan.assignmentId);
			if (
				latest !== undefined &&
				latest.state !== "active" &&
				latest.worktreeHazard.state === "liveness-unverified"
			) {
				const cleared = coordStore.clearHazardAfterPreTransportAbort(
					latest.assignmentId,
					latest.revision,
					plan.attemptId,
					authorization.authorizationId,
				);
				hazardCleared = cleared.ok;
			}
		}
		return {
			status: "aborted-before-transport",
			attemptId: plan.attemptId,
			assignmentId: plan.assignmentId,
			authorization,
			abortRecord: abortWritten === "created" ? abortRecord : null,
			observedAssignmentState: observedAbortState,
			hazardCleared,
			routeClaimed: true,
		};
	}

	// Harness transport delivery (strictly OUTSIDE `coordination.lock.<n>`).
	let transportOutcome: EndoDevelopDispatchOutcomeV0;
	try {
		transportOutcome = await options.adapter.dispatch(plan.request, authorityProof, {
			mode: "production",
			...options.admissionOptions,
			nowMs: now(),
		});
	} catch (error) {
		transportOutcome = {
			status: "unknown",
			operation: plan.request.kind,
			instanceId: plan.instanceId,
			reason: error instanceof Error ? error.message.slice(0, 256) : "transport threw during dispatch",
			dispatched: true,
		};
	}

	// Record write-once controller-observed outcome evidence (never retries on `unknown`).
	const sanitizeOutcomeReason = (raw: string | null): string | null => {
		if (raw === null) return null;
		const cleaned = raw
			.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
			.trim()
			.slice(0, 512);
		return cleaned.length > 0 ? cleaned : null;
	};
	const outcomeRecord: EndoDevelopAdapterOutcomeV0 = {
		schemaVersion: ENDO_DEVELOP_ADAPTER_OUTCOME_SCHEMA_V0,
		attemptId: plan.attemptId,
		authorizationId: authorization.authorizationId,
		recordedAtMs: now(),
		harnessFamily: plan.harnessFamily,
		source: plan.source,
		sessionKey: plan.sessionKey,
		instanceId: plan.instanceId,
		status: transportOutcome.status,
		disposition: transportOutcome.status === "accepted" ? transportOutcome.disposition : null,
		turnId: transportOutcome.status === "accepted" ? transportOutcome.turnId : null,
		receiptId: transportOutcome.status === "accepted" ? transportOutcome.receiptId : null,
		refusalCode: transportOutcome.status === "refused" ? transportOutcome.code : null,
		reason: transportOutcome.status === "accepted" ? null : sanitizeOutcomeReason(transportOutcome.reason),
		consequenceObserved: false,
		recordedBy: "controller",
	};
	const outcomeWritten = authStore.writeOutcome(outcomeRecord);

	return {
		status: transportOutcome.status,
		stage: "transport",
		attemptId: plan.attemptId,
		assignmentId: plan.assignmentId,
		authorization,
		transportOutcome,
		outcomeRecord: outcomeWritten === "created" ? outcomeRecord : null,
		routeClaimed: true,
	};
}
