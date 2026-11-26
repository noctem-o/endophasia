// Pure read-side interpretation of DEVELOP coordination metadata (protocol/develop-coordination.ts) against the evidence that already
// exists: tasks.json, attempt records, verification receipts, route reservations, and Git/protected-run re-verification the CALLER did.
// Nothing here reads a file, runs a process or keeps state: the caller gathers, this module decides, and the same inputs give the same
// output. Nothing here grants anything: readiness is computed for the operator to read, and no caller uses it as permission.
//
// The candidate-bound receipt predicate (docs/designs/coordinator-assignment.md §7.1) is evaluated per candidate against EXACT
// (commonDir, commit, tree) identity, with each planned check read through endoPlannedReadingV0, never through the live-HEAD acceptance
// ledger. A passing reading is evidence about that immutable candidate only, and always carries the GEO-26 disclosure.

import {
	ENDO_COORDINATION_PROJECTION_AUTHORITY_V0,
	ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
	type EndoCandidateIdentityReadingV0,
	type EndoCandidateReceiptReadingV0,
	type EndoCandidateWorkspaceReadingV0,
	type EndoCoordinationAssignmentFindingV0,
	type EndoCoordinationAssignmentViewV0,
	type EndoCoordinationConflictViewV0,
	type EndoCoordinationDependencyReasonV0,
	type EndoCoordinationDependencyViewV0,
	type EndoCoordinationDependencyWarningV0,
	type EndoCoordinationGapV0,
	type EndoCoordinationProjectViewV0,
	type EndoCoordinationReadinessV0,
	type EndoCoordinationTaskViewV0,
	type EndoCoordinatorCoordinationV0,
} from "../../protocol/coordinator-coordination.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0, endoAttemptPlanV0 } from "../../protocol/develop-attempts.ts";
import {
	ENDO_HAZARD_BASES_V0,
	type EndoAccessIntentV0,
	type EndoAssignmentV0,
	type EndoCandidateRefV0,
	type EndoDependencyV0,
	type EndoDevelopCoordinationFileV0,
	type EndoHazardBasisV0,
} from "../../protocol/develop-coordination.ts";
import type {
	EndoDevelopReceiptV0,
	EndoReceiptCurrentV0,
	EndoReceiptOutcomeV0,
} from "../../protocol/develop-receipts.ts";
import type { EndoDevelopTaskStatusV0 } from "../../protocol/develop-tasks.ts";
import type { EndoAttemptEntryV0, EndoAttemptProblemV0 } from "../../storage/develop-attempts.ts";
import { endoPlannedReadingV0 } from "./develop-verification.ts";

// ---- workspace conflicts (used by writers to refuse, and by readers to report) ------------------------------------------------------

/** Whether an assignment is a writer that still occupies its worktree: active, or ended with an unverified hazard. */
export const endoOccupiesWorktreeV0 = (a: EndoAssignmentV0): boolean =>
	a.workspace.accessIntent === "read-write-intended" &&
	(a.state === "active" || a.worktreeHazard.state === "liveness-unverified");

/**
 * The assignments a NEW writable assignment on `worktreePath` would overlap (§10.1): every other writer on the same canonical path that is
 * active or ended with `liveness-unverified`. A read-only proposal overlaps nothing that refuses it (it is reported, not refused).
 */
export function endoWorktreeWriteConflictsV0(
	assignments: readonly EndoAssignmentV0[],
	proposal: { worktreePath: string; accessIntent: EndoAccessIntentV0 },
	exclude: ReadonlySet<string> = new Set(),
): { assignmentId: string; reason: "active-writer" | "liveness-unverified" }[] {
	if (proposal.accessIntent !== "read-write-intended") return [];
	return assignments
		.filter((a) => !exclude.has(a.assignmentId) && a.workspace.worktreePath === proposal.worktreePath)
		.filter(endoOccupiesWorktreeV0)
		.map((a) => ({
			assignmentId: a.assignmentId,
			reason: a.state === "active" ? ("active-writer" as const) : ("liveness-unverified" as const),
		}));
}

/** Per-attempt execution evidence as found on disk by the caller: never inferred, `unknown` when it could not be read. */
export type EndoAttemptExecutionEvidenceV0 = {
	authorized: boolean | "unknown";
	route: "claimed" | "absent" | "unknown";
};

/**
 * Why a terminal transition (supersede, revoke, close) must leave the worktree hazardous: any linked attempt with an authorisation or a
 * route reservation on disk (or whose evidence cannot be read), and a writable assignment with an associated session (#183's Studio can
 * prompt a session directly, with no attempt at all). Empty: nothing on disk suggests anything ran. E1 has no abort or cleanup record,
 * so nothing here can clear a basis.
 */
export function endoTerminalHazardBasesV0(
	a: EndoAssignmentV0,
	evidence: (attemptId: string) => EndoAttemptExecutionEvidenceV0,
): EndoHazardBasisV0[] {
	const found = new Set<EndoHazardBasisV0>();
	for (const id of a.attemptIds) {
		const e = evidence(id);
		if (e.authorized === true) found.add("attempt-authorized");
		if (e.route === "claimed") found.add("attempt-route-claimed");
		if (e.authorized === "unknown" || e.route === "unknown") found.add("attempt-evidence-unreadable");
	}
	if (a.session !== null && a.workspace.accessIntent === "read-write-intended")
		found.add("writable-session-associated");
	return ENDO_HAZARD_BASES_V0.filter((b) => found.has(b));
}

// ---- the candidate-bound receipt predicate ----------------------------------------------------------------------------------------

export type EndoReceiptSourceV0 =
	| { ok: true; receipts: readonly EndoDevelopReceiptV0[]; problems: number }
	| { ok: false };

export interface EndoCandidateReceiptsInputV0 {
	candidate: Extract<EndoCandidateRefV0, { kind: "git-commit" }>;
	/** Every readable attempt of the candidate's owning task. */
	attempts: readonly EndoAttemptEntryV0[];
	/** The complete receipt read of each of those attempts; anything short of complete is `ok: false`. */
	receipts: (attemptId: string) => EndoReceiptSourceV0;
	/** Whether an unreadable attempt record could belong to this task (it would hide a plan or receipts). */
	attemptRecordsComplete: boolean;
}

const sameArgv = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The receipt reading of ONE immutable candidate: `passing` only when every receipt read is complete, at least one receipt ran at the exact
 * (commonDir, commit, tree) with a clean recorded post-check observation, no such receipt reads failed or inconclusive (planned checks read
 * through their plan, so an expected non-zero exit passes), and every planned check of every attempt in scope passed at least once.
 */
export function endoCandidateReceiptReadingV0(input: EndoCandidateReceiptsInputV0): {
	reading: Exclude<EndoCandidateReceiptReadingV0, "not-applicable">;
	reasons: EndoCoordinationDependencyReasonV0[];
} {
	const c = input.candidate;
	if (!input.attemptRecordsComplete) return { reading: "unknown", reasons: ["receipt-read-incomplete"] };
	const readings: { attemptId: string; receipt: EndoDevelopReceiptV0; reading: EndoReceiptOutcomeV0 }[] = [];
	const plans = new Map(input.attempts.map((e) => [e.attempt.id, endoAttemptPlanV0(e.attempt)]));
	for (const entry of input.attempts) {
		const read = input.receipts(entry.attempt.id);
		if (!read.ok || read.problems > 0) return { reading: "unknown", reasons: ["receipt-read-incomplete"] };
		const plan = plans.get(entry.attempt.id) ?? null;
		for (const r of read.receipts) {
			if (
				r.repository.commonDir !== c.commonDir ||
				r.revision.commit !== c.commitSha ||
				r.revision.tree !== c.treeSha
			)
				continue;
			const check = plan?.checks.find((k) => sameArgv(k.argv, r.check.argv));
			const clean = r.after.state === "observed" && r.after.clean;
			const reading = !clean ? "inconclusive" : check === undefined ? r.outcome : endoPlannedReadingV0(check, r);
			readings.push({ attemptId: entry.attempt.id, receipt: r, reading });
		}
	}
	const reasons: EndoCoordinationDependencyReasonV0[] = [];
	if (readings.length === 0) return { reading: "none", reasons: ["no-receipt-for-candidate"] };
	const failed = readings.some((x) => x.reading === "failed");
	const inconclusive = readings.some((x) => x.reading === "inconclusive");
	if (failed) reasons.push("failing-receipt-for-candidate");
	if (inconclusive) reasons.push("inconclusive-receipt-for-candidate");
	// Plans in scope: every attempt with a receipt at this candidate, and the attempt the candidate names.
	const inScope = new Set(readings.map((x) => x.attemptId));
	if (c.attemptId !== null && plans.has(c.attemptId)) inScope.add(c.attemptId);
	for (const attemptId of inScope) {
		const plan = plans.get(attemptId) ?? null;
		if (plan === null) continue;
		for (const check of plan.checks) {
			const mine = readings.filter((x) => x.attemptId === attemptId && sameArgv(x.receipt.check.argv, check.argv));
			if (!mine.some((x) => x.reading === "passed")) {
				if (!reasons.includes("planned-check-not-passed")) reasons.push("planned-check-not-passed");
			}
		}
	}
	if (failed) return { reading: "failing", reasons };
	if (inconclusive) return { reading: "inconclusive", reasons };
	if (reasons.length > 0 || !readings.some((x) => x.reading === "passed")) {
		if (reasons.length === 0) reasons.push("no-receipt-for-candidate");
		return { reading: "none", reasons };
	}
	return { reading: "passing", reasons: [] };
}

// ---- the projection ---------------------------------------------------------------------------------------------------------------

export interface EndoCoordinationTaskFactV0 {
	projectId: string;
	status: EndoDevelopTaskStatusV0;
	revision: number;
}

export interface EndoCoordinationProjectionInputV0 {
	readAtMs: number;
	requested: readonly string[] | null;
	/** The project ids the task file registers (scope is checked against it). */
	registeredProjects: readonly string[] | null;
	coordination:
		| { state: "absent" }
		| { state: "ready"; file: EndoDevelopCoordinationFileV0 }
		| { state: "unreadable"; reason: string };
	tasks: { ok: true; byId: ReadonlyMap<string, EndoCoordinationTaskFactV0> } | { ok: false };
	attempts:
		| { ok: true; entries: readonly EndoAttemptEntryV0[]; problems: readonly EndoAttemptProblemV0[] }
		| { ok: false };
	receipts: (attemptId: string) => EndoReceiptSourceV0;
	/** Route reservation per attempt, as read now; `unknown` when it could not be read (or is not mounted). */
	route: (attemptId: string) => "claimed" | "absent" | "unknown";
	/** Re-verification of each candidate by candidate id, done by the caller (Git / protected-run reading), or `unavailable`. */
	identity: ReadonlyMap<string, EndoCandidateIdentityReadingV0>;
	/** The live HEAD of a worktree path, observed now by the caller; absent or null when it was not or could not be. */
	workspaces: ReadonlyMap<string, EndoReceiptCurrentV0 | null>;
	/** Read gaps the caller already knows of (git unavailable in a sandbox, receipts truncated by a budget...). */
	gaps: readonly EndoCoordinationGapV0[];
}

const sorted = <T>(items: readonly T[], key: (x: T) => string): T[] =>
	[...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function workspaceReading(
	c: EndoCandidateRefV0,
	workspaces: ReadonlyMap<string, EndoReceiptCurrentV0 | null>,
): EndoCandidateWorkspaceReadingV0 {
	if (c.kind !== "git-commit") return "not-applicable";
	const now = workspaces.get(c.worktreePath);
	if (now === undefined || now === null) return "unavailable";
	if (now.commonDir !== c.commonDir) return "other-repository";
	if (now.commit !== c.commitSha) return "moved-from-candidate";
	return now.clean ? "matches-candidate" : "dirty-at-candidate";
}

/** Build the companion projection for the projects in scope. Deterministic: sorted, closed codes, no clock reads. */
export function endoCoordinationProjectionV0(input: EndoCoordinationProjectionInputV0): EndoCoordinatorCoordinationV0 {
	const gaps = new Set<EndoCoordinationGapV0>(input.gaps);
	const source: EndoCoordinatorCoordinationV0["source"] =
		input.coordination.state === "ready"
			? { state: "ready", reason: null, revision: input.coordination.file.revision }
			: input.coordination.state === "absent"
				? { state: "absent", reason: null, revision: null }
				: { state: "unreadable", reason: input.coordination.reason, revision: null };
	if (input.coordination.state === "unreadable") gaps.add("coordination-unreadable");
	if (!input.tasks.ok) gaps.add("tasks-unreadable");
	if (!input.attempts.ok) gaps.add("attempts-unreadable");
	const registered = input.registeredProjects === null ? null : new Set(input.registeredProjects);
	const projectIds =
		input.requested !== null
			? [...new Set(input.requested)].sort()
			: registered === null
				? []
				: [...registered].sort();
	if (registered !== null && projectIds.some((p) => !registered.has(p))) gaps.add("unknown-project");
	const file = input.coordination.state === "ready" ? input.coordination.file : null;

	const taskOf = (id: string): EndoCoordinationTaskFactV0 | null | "unknown" =>
		!input.tasks.ok ? "unknown" : (input.tasks.byId.get(id) ?? null);
	const entries = input.attempts.ok ? input.attempts.entries : [];
	const entryById = new Map(entries.map((e) => [e.attempt.id, e]));
	// An attempt record that could not be read but names an attempt: it may belong to any task, and could hide a plan or a receipt.
	const unreadableAttempts = input.attempts.ok
		? input.attempts.problems
				.map((p) => p.claims ?? p.name.split(".", 3).join("."))
				.filter((id) => ENDO_ATTEMPT_ID_PATTERN_V0.test(id))
		: [];
	if (unreadableAttempts.length > 0) gaps.add("attempt-problems");
	const attemptRecordsComplete = input.attempts.ok && unreadableAttempts.length === 0;
	const execution = (id: string): EndoAttemptExecutionEvidenceV0 => {
		const route = input.route(id);
		if (!input.attempts.ok) return { authorized: "unknown", route };
		const e = entryById.get(id);
		return { authorized: e === undefined ? "unknown" : e.authorized !== null, route };
	};

	const candidateEntry = new Map((file?.taskCandidates ?? []).map((t) => [t.taskId, t]));
	const receiptReading = new Map<string, ReturnType<typeof endoCandidateReceiptReadingV0>>();
	const readingOf = (c: Extract<EndoCandidateRefV0, { kind: "git-commit" }>, ownerTaskId: string) => {
		const cached = receiptReading.get(c.candidateId);
		if (cached !== undefined) return cached;
		const reading = endoCandidateReceiptReadingV0({
			candidate: c,
			attempts: entries.filter((e) => e.attempt.taskId === ownerTaskId),
			receipts: input.receipts,
			attemptRecordsComplete,
		});
		receiptReading.set(c.candidateId, reading);
		return reading;
	};

	const evaluate = (d: EndoDependencyV0): EndoCoordinationDependencyViewV0 => {
		const reasons: EndoCoordinationDependencyReasonV0[] = [];
		const warnings: EndoCoordinationDependencyWarningV0[] = [];
		const disclosures: EndoCoordinationDependencyViewV0["disclosures"] = [];
		let satisfaction: EndoCoordinationDependencyViewV0["satisfaction"] = "unsatisfied";
		let candidateId: string | null = null;
		const pre = taskOf(d.prerequisiteTaskId);
		const dep = taskOf(d.dependentTaskId);
		const view = () => ({
			dependencyId: d.dependencyId,
			dependentTaskId: d.dependentTaskId,
			prerequisiteTaskId: d.prerequisiteTaskId,
			condition: d.condition,
			satisfaction,
			candidateId,
			reasons: satisfaction === "satisfied" ? [] : reasons,
			warnings,
			disclosures: [...disclosures, "readiness-confers-no-authority" as const],
		});
		if (pre === "unknown" || dep === "unknown") {
			satisfaction = "unknown";
			reasons.push("tasks-unreadable");
			return view();
		}
		if (dep === null) reasons.push("dependent-missing");
		if (pre === null) {
			reasons.push("prerequisite-missing");
			return view();
		}
		if (pre.revision !== d.declaredAt.prerequisiteTaskRevision) warnings.push("prerequisite-changed-since-declared");
		if (dep !== null && dep.revision !== d.declaredAt.dependentTaskRevision)
			warnings.push("dependent-changed-since-declared");
		const met = (): void => {
			if (dep !== null) satisfaction = "satisfied";
		};
		if (d.condition === "operator-task-done") {
			if (pre.status === "done") met();
			else reasons.push("prerequisite-not-done");
			return view();
		}
		if (d.condition === "operator-decision") {
			if (d.operatorDecision === null) reasons.push("no-operator-decision");
			else if (d.operatorDecision.prerequisiteTaskRevision !== pre.revision) reasons.push("operator-decision-stale");
			else met();
			return view();
		}
		const entry = candidateEntry.get(d.prerequisiteTaskId);
		const current = entry?.candidates.find((c) => c.candidateId === entry.currentCandidateId) ?? null;
		if (current === null) {
			reasons.push("no-current-candidate");
			return view();
		}
		candidateId = current.candidateId;
		const identity = input.identity.get(current.candidateId) ?? "unavailable";
		if (identity === "unavailable") {
			satisfaction = "unknown";
			reasons.push("candidate-identity-unavailable");
		} else if (identity !== "verified" && identity !== "established") {
			reasons.push("candidate-identity-failed");
			return view();
		}
		if (current.kind === "git-commit") {
			const ws = workspaceReading(current, input.workspaces);
			if (ws === "unavailable") warnings.push("workspace-unobserved");
			else if (ws !== "matches-candidate") warnings.push("workspace-drifted-from-candidate");
		}
		if (d.condition === "candidate-declared") {
			if (identity !== "unavailable") met();
			return view();
		}
		// candidate-has-passing-receipt
		disclosures.push("receipt-history-unverifiable");
		if (current.kind !== "git-commit") {
			satisfaction = "unsatisfied";
			reasons.push("protected-candidate-has-no-host-receipt");
			return view();
		}
		const reading = readingOf(current, d.prerequisiteTaskId);
		for (const r of reading.reasons) if (!reasons.includes(r)) reasons.push(r);
		if (reading.reading === "unknown") satisfaction = "unknown";
		else if (reading.reading !== "passing") satisfaction = "unsatisfied";
		else if (identity !== "unavailable") met();
		return view();
	};

	// A requested id the task file does not register is a gap, never an (empty) project.
	const listed = registered === null ? projectIds : projectIds.filter((p) => registered.has(p));
	const projects: EndoCoordinationProjectViewV0[] = listed.map((projectId) => {
		const assignments = sorted(
			(file?.assignments ?? []).filter((a) => a.projectId === projectId),
			(a) => a.assignmentId,
		);
		const dependencies = sorted(
			(file?.dependencies ?? []).filter((d) => d.projectId === projectId),
			(d) => d.dependencyId,
		).map(evaluate);
		const taskEntries = sorted(
			(file?.taskCandidates ?? []).filter((t) => t.projectId === projectId),
			(t) => t.taskId,
		);
		const readiness = (taskId: string): EndoCoordinationReadinessV0 => {
			const edges = dependencies.filter((d) => d.dependentTaskId === taskId);
			if (edges.length === 0) return "no-dependencies";
			if (edges.some((d) => d.satisfaction === "unknown")) return "unknown";
			if (edges.some((d) => d.satisfaction === "unsatisfied")) return "waiting";
			return edges.some((d) => d.warnings.includes("workspace-drifted-from-candidate"))
				? "ready-for-pinned-candidate"
				: "ready";
		};
		const taskIds = new Set<string>([
			...assignments.map((a) => a.taskId),
			...dependencies.flatMap((d) => [d.dependentTaskId, d.prerequisiteTaskId]),
			...taskEntries.map((t) => t.taskId),
		]);
		const tasks: EndoCoordinationTaskViewV0[] = [...taskIds].sort().map((taskId) => {
			const entry = candidateEntry.get(taskId);
			const supersededIds = new Set(
				(entry?.candidates ?? []).map((c) => c.supersedesCandidateId).filter((x): x is string => x !== null),
			);
			return {
				taskId,
				readiness: readiness(taskId),
				currentCandidateId: entry?.currentCandidateId ?? null,
				candidates: (entry?.candidates ?? []).map((c) => ({
					candidateId: c.candidateId,
					kind: c.kind,
					relation:
						c.candidateId === entry?.currentCandidateId
							? ("current" as const)
							: supersededIds.has(c.candidateId)
								? ("superseded" as const)
								: ("not-selected" as const),
					identity: input.identity.get(c.candidateId) ?? "unavailable",
					workspace: workspaceReading(c, input.workspaces),
					receipts: c.kind === "git-commit" ? readingOf(c, taskId).reading : ("not-applicable" as const),
				})),
			};
		});
		const assignmentViews: EndoCoordinationAssignmentViewV0[] = assignments.map((a) => {
			const findings = new Set<EndoCoordinationAssignmentFindingV0>();
			const task = taskOf(a.taskId);
			const taskBinding =
				task === "unknown"
					? ("unknown" as const)
					: task === null
						? ("task-missing" as const)
						: task.revision !== a.taskRevisionAtBind
							? ("task-stale" as const)
							: ("current" as const);
			if (taskBinding === "task-missing") findings.add("assignment-task-missing");
			if (taskBinding === "task-stale") findings.add("assignment-task-stale");
			let target: EndoCoordinationAssignmentViewV0["targetCandidate"] = null;
			if (a.targetCandidate !== null) {
				const entry = candidateEntry.get(a.targetCandidate.taskId);
				const exists = entry?.candidates.some((c) => c.candidateId === a.targetCandidate?.candidateId) === true;
				const relation = !exists
					? ("candidate-missing" as const)
					: entry?.currentCandidateId === a.targetCandidate.candidateId
						? ("current-candidate" as const)
						: ("superseded-candidate" as const);
				if (relation === "candidate-missing") findings.add("target-candidate-missing");
				if (relation === "superseded-candidate") findings.add("target-candidate-superseded");
				target = { ...a.targetCandidate, relation };
			}
			if (a.session !== null) {
				findings.add("session-liveness-unknown");
				if (a.session.instanceId === null) findings.add("session-instance-undeclared");
			}
			const attempts = a.attemptIds.map((attemptId) => {
				const e = execution(attemptId);
				const entry = entryById.get(attemptId);
				const link = !input.attempts.ok
					? ("unknown" as const)
					: entry === undefined
						? ("missing" as const)
						: entry.attempt.taskId !== a.taskId
							? ("other-task" as const)
							: ("resolved" as const);
				const ran =
					e.authorized === true
						? ("workbench-authorized" as const)
						: e.route === "claimed"
							? ("route-claimed" as const)
							: e.authorized === "unknown" || e.route === "unknown"
								? ("unknown" as const)
								: ("none-recorded" as const);
				if (link === "missing" || link === "other-task") findings.add("attempt-link-unresolved");
				if (ran === "workbench-authorized" || ran === "route-claimed") findings.add("attempt-execution-recorded");
				if (ran === "unknown") findings.add("attempt-evidence-unknown");
				return { attemptId, link, execution: ran };
			});
			if (a.state === "active") {
				const r = readiness(a.taskId);
				if (r === "waiting") findings.add("prerequisites-not-satisfied");
				if (r === "unknown") findings.add("prerequisites-unknown");
			}
			if (a.worktreeHazard.state === "liveness-unverified") findings.add("worktree-liveness-unverified");
			if (a.workspace.registration === "same-repository-unregistered") findings.add("worktree-not-registered");
			if (
				a.state !== "active" &&
				a.worktreeHazard.state !== "operator-cleared" &&
				(a.session !== null || a.attemptIds.length > 0)
			)
				findings.add("ended-without-process-confirmation");
			return {
				assignmentId: a.assignmentId,
				taskId: a.taskId,
				state: a.state,
				revision: a.revision,
				participantId: a.participant.participantId,
				role: a.participant.role,
				intendedHarnessFamily: a.participant.intendedHarnessFamily,
				taskBinding,
				session:
					a.session === null
						? null
						: {
								source: a.session.source,
								sessionKey: a.session.sessionKey,
								standing: "operator-declared" as const,
								liveness: "unknown" as const,
							},
				workspace: {
					worktreePath: a.workspace.worktreePath,
					registration: a.workspace.registration,
					accessIntent: a.workspace.accessIntent,
					sharedWorktreeAcknowledged: a.workspace.sharedWorktreeAcknowledged,
				},
				hazard: a.worktreeHazard.state,
				targetCandidate: target,
				attempts,
				findings: [...findings].sort(),
			};
		});
		return {
			id: projectId,
			assignments: assignmentViews,
			dependencies,
			tasks,
			conflicts: endoWorktreeConflictsV0(assignments),
		};
	});
	return {
		schemaVersion: ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
		readAtMs: input.readAtMs,
		authority: { ...ENDO_COORDINATION_PROJECTION_AUTHORITY_V0 },
		basis: { liveness: "not-observed", consistency: "per-file-snapshot", attribution: "unsigned-local-record" },
		scope: { requested: input.requested === null ? null : [...new Set(input.requested)].sort() },
		source,
		projects,
		gaps: [...gaps].sort(),
	};
}

const hintsOverlap = (a: readonly string[], b: readonly string[]): boolean =>
	a.some((x) => b.some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));

/** Read-side conflict findings for one project's assignments (§10): reported, never resolved, never cleared by time. */
export function endoWorktreeConflictsV0(assignments: readonly EndoAssignmentV0[]): EndoCoordinationConflictViewV0[] {
	const out: EndoCoordinationConflictViewV0[] = [];
	const byPath = new Map<string, EndoAssignmentV0[]>();
	for (const a of assignments)
		byPath.set(a.workspace.worktreePath, [...(byPath.get(a.workspace.worktreePath) ?? []), a]);
	for (const [worktreePath, group] of [...byPath].sort(([x], [y]) => (x < y ? -1 : 1))) {
		const ids = (xs: readonly EndoAssignmentV0[]) => xs.map((a) => a.assignmentId).sort();
		const writers = group.filter(endoOccupiesWorktreeV0);
		const readers = group.filter((a) => a.state === "active" && a.workspace.accessIntent === "read-only-intended");
		const hazardous = group.filter((a) => a.worktreeHazard.state === "liveness-unverified");
		if (hazardous.length > 0)
			out.push({ kind: "worktree-liveness-unverified", worktreePath, assignmentIds: ids(hazardous) });
		if (writers.length >= 2) {
			// The first writer needs no acknowledgement; every later one must carry the operator's. Counted, not ordered: confirmation
			// times can tie, and an ordering would make the same file read differently.
			const acknowledged = writers.filter((a) => !a.workspace.sharedWorktreeAcknowledged).length <= 1;
			out.push({
				kind: acknowledged ? "shared-writable-worktree-acknowledged" : "unacknowledged-worktree-write-overlap",
				worktreePath,
				assignmentIds: ids(writers),
			});
			for (let i = 0; i < writers.length; i++)
				for (let j = i + 1; j < writers.length; j++) {
					const x = writers[i] as EndoAssignmentV0;
					const y = writers[j] as EndoAssignmentV0;
					if (hintsOverlap(x.workspace.pathHints, y.workspace.pathHints))
						out.push({ kind: "path-hint-overlap", worktreePath, assignmentIds: ids([x, y]) });
				}
		}
		if (writers.length >= 1 && readers.length >= 1)
			out.push({ kind: "shared-mutable-worktree", worktreePath, assignmentIds: ids([...writers, ...readers]) });
	}
	return out;
}
