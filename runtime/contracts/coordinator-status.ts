// COORDINATOR-STATUS-001 (docs/designs/coordinator-status.md): the pure status projection. Records already read in, one
// EndoCoordinatorStatusV0 out (protocol/coordinator-status.ts). Deterministic for the same inputs and the same `readAtMs`; zero I/O.
//
// It only relabels and joins what the records say. A session is `active` only while its own record says it is attached, its newest event
// is fresh and the log was read whole; a task's phase is the operator's status; a session belongs to a task only through a record that
// names both. Everything else is reported as last-observed, unknown, stale, incomplete or unavailable, never filled in.

import {
	ENDO_COORDINATOR_AUTHORITY_V0,
	ENDO_COORDINATOR_LIMITS_V0,
	ENDO_COORDINATOR_NOT_ESTABLISHED_V0,
	ENDO_COORDINATOR_PHASE_OF_STATUS_V0,
	ENDO_COORDINATOR_PHASES_V0,
	ENDO_COORDINATOR_STATUS_SCHEMA_V0,
	type EndoCoordinatorActivityV0,
	type EndoCoordinatorAttentionV0,
	type EndoCoordinatorBasisV0,
	type EndoCoordinatorFindingV0,
	type EndoCoordinatorFreshnessV0,
	type EndoCoordinatorGapV0,
	type EndoCoordinatorLinkV0,
	type EndoCoordinatorPhaseV0,
	type EndoCoordinatorProjectV0,
	type EndoCoordinatorResultV0,
	type EndoCoordinatorSessionV0,
	type EndoCoordinatorSourceV0,
	type EndoCoordinatorStatusV0,
	type EndoCoordinatorTaskV0,
	type EndoCoordinatorVerificationStateV0,
} from "../../protocol/coordinator-status.ts";
import { endoDevelopAttemptStateV0 } from "../../protocol/develop-attempts.ts";
import {
	type EndoDevelopAttentionPlannedV1,
	type EndoDevelopAttentionTaskV0,
	type EndoDevelopAttentionViewV0,
	endoPlannedTriageV1,
} from "../../protocol/develop-attention.ts";
import type { EndoReceiptRelationV0 } from "../../protocol/develop-receipts.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type { EndoAttemptsReadV0 } from "../../storage/develop-attempts.ts";
import type { EndoTasksReadV0 } from "../../storage/develop-tasks.ts";
import type { EndoSessionLogReadV0 } from "./develop-attempt-execution.ts";
import { reduceEndoSessionOverviewV0 } from "./session-overview.ts";

/** One project's attention projection as read for this status, and when its HEAD was observed (null view: not computed). */
export interface EndoCoordinatorAttentionReadV0 {
	view: EndoDevelopAttentionViewV0 | null;
	observedAtMs: number;
}

export interface EndoCoordinatorInputsV0 {
	readAtMs: number;
	staleAfterMs: number;
	/** Project ids asked for, or null for every project in the task file. */
	requested: readonly string[] | null;
	tasks: EndoTasksReadV0;
	attempts: EndoAttemptsReadV0;
	events: EndoSessionLogReadV0;
	attention: ReadonlyMap<string, EndoCoordinatorAttentionReadV0>;
}

const fresh = (observedAtMs: number, readAtMs: number): EndoCoordinatorFreshnessV0 => ({
	state: "fresh",
	observedAtMs,
	ageMs: Math.max(0, readAtMs - observedAtMs),
	reason: null,
});
const notFresh = (
	state: "stale" | "unavailable" | "incomplete",
	reason: string,
	observedAtMs: number | null = null,
	readAtMs = 0,
): EndoCoordinatorFreshnessV0 => ({
	state,
	observedAtMs,
	ageMs: observedAtMs === null ? null : Math.max(0, readAtMs - observedAtMs),
	reason,
});

/**
 * Who says so, by event kind. `harness.*`, `workbench.*` and `control.*` are written by Endophasia's controller from what it did or saw;
 * the Pi runtime's own events (`agent.*`, `tool.*`, `message.*`, ...) are the agent's report. Lifecycle interpretations inherit the basis of
 * what they derive from: an attachment, an operator's stop request, an interruption and a process exit are controller-observed; runs, turns,
 * stop acknowledgements and compactions are the runtime's report. Anything else is `unclassified`, never promoted.
 */
const CONTROLLER_LIFECYCLE = new Set([
	"lifecycle.session-started",
	"lifecycle.session-resumed",
	"lifecycle.stop-requested",
	"lifecycle.interrupted",
	"lifecycle.detached",
]);
const AGENT_PREFIXES = ["agent.", "tool.", "message.", "session.", "retry.", "compaction.", "extension."];
const CONTROLLER_PREFIXES = ["harness.", "workbench.", "control."];

export function endoCoordinatorBasisOfKindV0(kind: string): EndoCoordinatorBasisV0 {
	if (kind.startsWith("lifecycle.")) {
		if (CONTROLLER_LIFECYCLE.has(kind)) return "controller-observed";
		return kind === "lifecycle.anomaly" || kind === "lifecycle.unrecognized-runtime-event"
			? "unclassified"
			: "agent-reported";
	}
	if (CONTROLLER_PREFIXES.some((p) => kind.startsWith(p))) return "controller-observed";
	if (AGENT_PREFIXES.some((p) => kind.startsWith(p))) return "agent-reported";
	return "unclassified";
}

const PLANNED_RELATION: Record<EndoDevelopAttentionPlannedV1["state"], EndoReceiptRelationV0 | null> = {
	passed: "at-head",
	failed: "at-head",
	inconclusive: "at-head",
	mixed: "at-head",
	"tree-changed": "at-head-changed",
	stale: "head-differs",
	elsewhere: "other-worktree",
	unavailable: "unavailable",
	"not-run": null,
};

const relationFreshness = (relation: EndoReceiptRelationV0 | null): EndoCoordinatorResultV0["freshness"] =>
	relation === "at-head"
		? "fresh"
		: relation === "unavailable"
			? "unavailable"
			: relation === null
				? "unavailable"
				: "stale";

type Triage = "failed" | "inconclusive" | "unsettled" | "passed";

function resultsOf(
	task: EndoDevelopAttentionTaskV0,
	headClean: boolean,
): { result: EndoCoordinatorResultV0; triage: Triage }[] {
	const planned = task.planned.map((p) => {
		const relation = PLANNED_RELATION[p.state];
		const outcome: EndoCoordinatorResultV0["outcome"] =
			p.state === "passed" ||
			p.state === "failed" ||
			p.state === "inconclusive" ||
			p.state === "mixed" ||
			p.state === "not-run"
				? p.state
				: (p.receipt?.outcome ?? "not-run");
		return {
			result: {
				command: p.command,
				reading: "planned" as const,
				outcome,
				relation,
				freshness: relationFreshness(relation),
				attemptId: p.attemptId,
				receiptId: p.receipt?.receiptId ?? null,
				commit: p.receipt?.commit ?? null,
				startedAtMs: p.receipt?.startedAtMs ?? null,
				basis: "controller-observed" as const,
			},
			triage: endoPlannedTriageV1(p),
		};
	});
	const unplanned = task.checks.map((c) => ({
		result: {
			command: c.command,
			reading: "unplanned" as const,
			outcome: c.outcome,
			relation: c.relation,
			freshness: relationFreshness(c.relation),
			attemptId: c.attemptId,
			receiptId: c.receiptId,
			commit: c.commit,
			startedAtMs: c.startedAtMs,
			basis: "controller-observed" as const,
		},
		triage: (c.outcome === "failed"
			? "failed"
			: c.outcome === "inconclusive"
				? "inconclusive"
				: c.relation === "at-head" && headClean
					? "passed"
					: "unsettled") as Triage,
	}));
	const rank: Record<Triage, number> = { failed: 0, inconclusive: 1, unsettled: 2, passed: 3 };
	return [...planned, ...unplanned].sort((a, b) => rank[a.triage] - rank[b.triage]);
}

const PHASE_ORDER: Record<EndoCoordinatorPhaseV0, number> = {
	"awaiting-review": 0,
	"in-progress": 1,
	blocked: 2,
	open: 3,
	completed: 4,
};

/** The status projection. Pure: every record it needs is already read into `inputs`. */
export function endoCoordinatorStatusV0(inputs: EndoCoordinatorInputsV0): EndoCoordinatorStatusV0 {
	const { readAtMs, staleAfterMs } = inputs;
	const findings: EndoCoordinatorFindingV0[] = [];
	const attention: EndoCoordinatorAttentionV0[] = [];

	// ---- sources -----------------------------------------------------------------------------------------------------------------------
	const tasksRead = inputs.tasks;
	const tasksSource: EndoCoordinatorSourceV0 = tasksRead.ok
		? {
				state: tasksRead.exists ? "ready" : "missing",
				freshness: fresh(readAtMs, readAtMs),
				detail: tasksRead.exists
					? `task file revision ${tasksRead.file.revision}`
					: "no task file: no project is registered",
			}
		: {
				state: "unavailable",
				freshness: notFresh("unavailable", `the task file cannot be used (${tasksRead.reason})`),
				detail: tasksRead.reason,
			};
	if (!tasksRead.ok)
		findings.push({
			code: "tasks-unavailable",
			severity: "unavailable",
			subject: null,
			text: `The task file cannot be used (${tasksRead.reason}): nothing is said about any project or task.`,
		});
	const attemptsRead = inputs.attempts;
	const attemptsSource: EndoCoordinatorSourceV0 = !attemptsRead.ok
		? {
				state: "unavailable",
				freshness: notFresh("unavailable", `the attempt records cannot be read (${attemptsRead.reason})`),
				detail: attemptsRead.reason,
			}
		: attemptsRead.problems.length > 0
			? {
					state: "partial",
					freshness: notFresh(
						"incomplete",
						`${attemptsRead.problems.length} attempt file(s) are not usable records`,
						readAtMs,
						readAtMs,
					),
					detail: `${attemptsRead.entries.length} attempt(s), ${attemptsRead.problems.length} unusable file(s)`,
				}
			: {
					state: "ready",
					freshness: fresh(readAtMs, readAtMs),
					detail: `${attemptsRead.entries.length} attempt(s)`,
				};
	if (!attemptsRead.ok)
		findings.push({
			code: "attempts-unavailable",
			severity: "unavailable",
			subject: null,
			text: `The attempt records cannot be read (${attemptsRead.reason}): no attempt, authorisation or send link is known.`,
		});
	else if (attemptsRead.problems.length > 0)
		findings.push({
			code: "attempt-records-unusable",
			severity: "integrity",
			subject: null,
			text: `${attemptsRead.problems.length} attempt file(s) are not usable records; attempts and links may be incomplete.`,
		});
	const log = inputs.events;
	const eventsSource: EndoCoordinatorSourceV0 =
		log.state === "unavailable"
			? {
					state: "unavailable",
					freshness: notFresh("unavailable", "the event log is absent or cannot be opened read-only"),
					detail: null,
				}
			: log.state === "partial"
				? {
						state: "partial",
						freshness: notFresh(
							"incomplete",
							"the event log has a torn or unverifiable tail; only its verified prefix was read",
							readAtMs,
							readAtMs,
						),
						detail: `${log.events.length} verified event(s)`,
					}
				: { state: "ready", freshness: fresh(readAtMs, readAtMs), detail: `${log.events.length} event(s)` };
	if (log.state === "unavailable")
		findings.push({
			code: "event-log-unavailable",
			severity: "unavailable",
			subject: null,
			text: "The event log is absent or cannot be opened read-only: no session is known.",
		});
	else if (log.state === "partial")
		findings.push({
			code: "event-log-incomplete",
			severity: "incomplete",
			subject: null,
			text: "The event log has a torn or unverifiable tail: no session is reported active from it.",
		});

	// ---- scope -------------------------------------------------------------------------------------------------------------------------
	const file = tasksRead.ok ? tasksRead.file : null;
	const known = new Set(file?.projects.map((p) => p.id) ?? []);
	const requested = inputs.requested === null ? null : [...new Set(inputs.requested)];
	const inScope = file === null ? [] : file.projects.filter((p) => requested === null || requested.includes(p.id));
	const scopeIds = new Set(inScope.map((p) => p.id));
	const unknown = requested === null || file === null ? [] : requested.filter((id) => !known.has(id));
	for (const id of unknown)
		findings.push({
			code: "project-not-permitted-or-unknown",
			severity: "unavailable",
			subject: id,
			text: `Project ${id} is not in the task file; nothing is said about it.`,
		});

	// ---- explicit links ----------------------------------------------------------------------------------------------------------------
	const sessionEvents = new Map<string, EndoEventV0[]>();
	if (log.state !== "unavailable")
		for (const e of log.events) {
			const sid = e.coordinates.sessionId;
			if (sid === undefined) continue;
			const list = sessionEvents.get(sid);
			if (list === undefined) sessionEvents.set(sid, [e]);
			else list.push(e);
		}
	const inLog = (sessionId: string): EndoCoordinatorLinkV0["inLog"] =>
		sessionEvents.has(sessionId) ? "yes" : log.state === "complete" ? "no" : "unknown";
	const taskProject = new Map(file?.tasks.map((t) => [t.id, t.projectId] as const) ?? []);
	const links: EndoCoordinatorLinkV0[] = [];
	for (const t of file?.tasks ?? [])
		for (const ref of t.sessions)
			links.push({
				taskId: t.id,
				sessionId: ref.sessionId,
				via: "operator-linked",
				basis: "operator-declared",
				source: ref.source,
				attemptId: null,
				launchId: ref.source === "pi-live" ? ref.launchId : null,
				recordedAtMs: ref.linkedAtMs,
				inLog: ref.source === "pi-live" ? inLog(ref.sessionId) : "not-applicable",
			});
	if (attemptsRead.ok)
		for (const e of attemptsRead.entries) {
			const a = e.authorized;
			if (a === null || taskProject.get(e.attempt.taskId) !== e.attempt.projectId) continue;
			links.push({
				taskId: e.attempt.taskId,
				sessionId: a.session,
				via: "send-authorized",
				basis: "controller-observed",
				source: "pi-live",
				attemptId: a.attemptId,
				launchId: a.launchId,
				recordedAtMs: a.recordedAtMs,
				inLog: inLog(a.session),
			});
		}
	const inScopeLink = (l: EndoCoordinatorLinkV0): boolean => scopeIds.has(taskProject.get(l.taskId) ?? "");
	for (const l of links)
		if (inScopeLink(l) && l.inLog === "no")
			findings.push({
				code: "session-link-not-in-log",
				severity: "integrity",
				subject: l.taskId,
				text: `Task ${l.taskId} names session ${l.sessionId} (${l.via}), which the complete event log does not record.`,
			});

	// ---- projects and tasks ------------------------------------------------------------------------------------------------------------
	const entriesByTask = new Map<string, NonNullable<Extract<EndoAttemptsReadV0, { ok: true }>["entries"]>>();
	if (attemptsRead.ok)
		for (const e of attemptsRead.entries) {
			if (taskProject.get(e.attempt.taskId) !== e.attempt.projectId) continue;
			entriesByTask.set(e.attempt.taskId, [...(entriesByTask.get(e.attempt.taskId) ?? []), e]);
		}
	const projects: EndoCoordinatorProjectV0[] = inScope.map((project) => {
		const read = inputs.attention.get(project.id);
		const view = read?.view ?? null;
		const head = view?.head ?? null;
		const headAt = read?.observedAtMs ?? readAtMs;
		const projectFreshness =
			view === null || view.state !== "ready"
				? notFresh("unavailable", "the project's verification records could not be read")
				: head === null
					? notFresh("unavailable", "HEAD of the project's registered path could not be observed")
					: view.truncated || view.unattributed > 0
						? notFresh(
								"incomplete",
								"some receipt or attempt files were not read or could not be placed",
								headAt,
								readAtMs,
							)
						: fresh(headAt, readAtMs);
		if (view !== null && view.state === "ready" && head === null)
			findings.push({
				code: "project-head-unavailable",
				severity: "unavailable",
				subject: project.id,
				text: `HEAD of project ${project.id}'s registered path could not be observed; no check reads as current.`,
			});
		const views = new Map(view?.state === "ready" ? view.tasks.map((t) => [t.taskId, t] as const) : []);
		const tasks: EndoCoordinatorTaskV0[] = (file?.tasks ?? [])
			.filter((t) => t.projectId === project.id)
			.map((t) => {
				const phase = ENDO_COORDINATOR_PHASE_OF_STATUS_V0[t.status];
				const entries = [...(entriesByTask.get(t.id) ?? [])].sort(
					(a, b) => b.attempt.preparedAtMs - a.attempt.preparedAtMs || (a.attempt.id < b.attempt.id ? 1 : -1),
				);
				const newest = entries[0];
				const latest =
					newest === undefined
						? null
						: {
								id: newest.attempt.id,
								state: endoDevelopAttemptStateV0(newest.handoff, newest.outcome),
								stateBasis: "operator-declared" as const,
								preparedAtMs: newest.attempt.preparedAtMs,
								sendAuthorized: newest.authorized !== null,
							};
				const gaps: EndoCoordinatorGapV0[] = [];
				let verification: EndoCoordinatorTaskV0["verification"];
				const tv = views.get(t.id);
				if (t.status === "done") {
					verification = {
						state: "not-read",
						basis: "controller-observed-host-check",
						incomplete: false,
						freshness: notFresh("unavailable", "receipts of a completed task are not re-read by this status"),
						results: [],
						moreResults: 0,
					};
					gaps.push({
						code: "completed-not-reverified",
						text: "Completed by the operator's record; this status does not re-read its verification.",
					});
				} else if (tv === undefined) {
					verification = {
						state: "unavailable",
						basis: "controller-observed-host-check",
						incomplete: true,
						freshness: notFresh("unavailable", "the project's verification records could not be read"),
						results: [],
						moreResults: 0,
					};
					gaps.push({ code: "attention-unavailable", text: "Its verification records could not be read." });
				} else {
					const all = resultsOf(tv, head?.clean === true);
					const moreNotPassing = tv.more.notPassing + tv.morePlanned.notPassing;
					const moreNotCurrent = tv.more.notCurrent + tv.morePlanned.notCurrent;
					const moreAll = tv.more.commands + tv.morePlanned.checks;
					const incomplete = tv.unreadable + tv.skipped + tv.problems + tv.records > 0 || view?.truncated === true;
					const triages = all.map((r) => r.triage);
					const ran = all.filter((r) => r.result.outcome !== "not-run");
					const state: EndoCoordinatorVerificationStateV0 =
						head === null && all.length > 0
							? triages.includes("failed")
								? "failing"
								: "unavailable"
							: triages.includes("failed")
								? "failing"
								: triages.includes("inconclusive")
									? "inconclusive"
									: moreNotPassing > 0
										? "failing"
										: ran.length + moreAll === 0
											? "no-checks"
											: triages.every((x) => x === "passed") && moreNotCurrent === 0
												? "passing-at-head"
												: "not-current";
					const vFreshness =
						head === null
							? notFresh("unavailable", "HEAD could not be observed, so no check reads as current")
							: incomplete
								? notFresh("incomplete", "some of its receipt or attempt files were not read", headAt, readAtMs)
								: state === "not-current"
									? notFresh("stale", "its latest checks are not at the current clean HEAD", headAt, readAtMs)
									: fresh(headAt, readAtMs);
					verification = {
						state,
						basis: "controller-observed-host-check",
						incomplete,
						freshness: vFreshness,
						results: all.slice(0, ENDO_COORDINATOR_LIMITS_V0.maxResultsPerTask).map((r) => r.result),
						moreResults: Math.max(0, all.length - ENDO_COORDINATOR_LIMITS_V0.maxResultsPerTask) + moreAll,
					};
					if (head === null)
						gaps.push({
							code: "head-unavailable",
							text: "HEAD of the project could not be observed for this read.",
						});
					if ((t.status === "in-progress" || t.status === "review") && entries.length === 0)
						gaps.push({ code: "no-attempt", text: "No attempt record exists for this task." });
					if (entries.length > 0 && state === "no-checks")
						gaps.push({
							code: "no-check-recorded",
							text: "No verification receipt has been recorded for its attempts.",
						});
					if (state === "not-current") {
						gaps.push({
							code: "checks-not-current",
							text: "Its latest checks were run at another commit, in a changed tree or in another worktree.",
						});
						if (!all.some((r) => r.result.relation === "at-head"))
							gaps.push({
								code: "no-check-at-current-head",
								text: "No check has been run at the current HEAD.",
							});
					}
					if (tv.unreadable > 0)
						gaps.push({
							code: "receipts-unreadable",
							text: `${tv.unreadable} attempt receipt directory(ies) could not be read.`,
						});
					if (tv.skipped > 0)
						gaps.push({
							code: "receipts-skipped-at-limit",
							text: `${tv.skipped} attempt(s) were not read: the read limit was reached.`,
						});
					if (tv.problems > 0)
						gaps.push({
							code: "receipt-files-unusable",
							text: `${tv.problems} receipt file(s) are not usable receipts.`,
						});
					if (tv.records > 0)
						gaps.push({
							code: "attempt-records-unusable",
							text: `${tv.records} of its attempt record file(s) are not usable.`,
						});
					if (latest?.state === "reported" && state !== "passing-at-head")
						gaps.push({
							code: "agent-report-unverified",
							text: "A result was reported for its latest attempt, but no passing check at the current clean HEAD supports it.",
						});
					if (t.status === "review" && state !== "passing-at-head")
						gaps.push({
							code: "review-without-passing-check",
							text: "It awaits review without a passing check at the current clean HEAD.",
						});
					if (t.status === "review" && state === "failing")
						findings.push({
							code: "status-contradicts-verification",
							severity: "contradiction",
							subject: t.id,
							text: `Task ${t.id} is in review by the operator's record while a check of it fails.`,
						});
					if (latest?.state === "reported" && state === "failing")
						findings.push({
							code: "agent-report-contradicts-verification",
							severity: "contradiction",
							subject: t.id,
							text: `A result was reported for task ${t.id}'s latest attempt, but a controller-observed check of it fails.`,
						});
				}
				const taskLinks = links.filter((l) => l.taskId === t.id);
				return {
					taskId: t.id,
					projectId: t.projectId,
					title: t.title,
					status: t.status,
					phase,
					statusSource: "operator-declared" as const,
					updatedAtMs: t.updatedAtMs,
					revision: t.revision,
					attempts: { count: entries.length, latest },
					verification,
					gaps,
					sessions: taskLinks,
					association: taskLinks.length > 0 ? ("explicit" as const) : ("unknown" as const),
				};
			})
			.sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase]);
		const counts = Object.fromEntries(ENDO_COORDINATOR_PHASES_V0.map((p) => [p, 0])) as Record<
			EndoCoordinatorPhaseV0,
			number
		>;
		for (const t of tasks) counts[t.phase] += 1;
		return {
			id: project.id,
			name: project.name,
			source: "operator-declared",
			head,
			freshness: projectFreshness,
			counts,
			tasks,
		};
	});

	// ---- sessions ----------------------------------------------------------------------------------------------------------------------
	const allSessions: { session: EndoCoordinatorSessionV0; outOfScope: boolean }[] = [];
	for (const [sessionId, events] of sessionEvents) {
		const overview = reduceEndoSessionOverviewV0(events);
		const times = events.map((e) => Date.parse(e.at)).filter((n) => Number.isFinite(n));
		const firstEventAtMs = times.length === 0 ? 0 : Math.min(...times);
		const lastEventAtMs = times.length === 0 ? 0 : Math.max(...times);
		const open = overview.state === "idle" || overview.state === "running";
		const sessionFreshness: EndoCoordinatorFreshnessV0 =
			log.state === "partial"
				? notFresh("incomplete", "the event log's tail could not be verified", lastEventAtMs, readAtMs)
				: readAtMs - lastEventAtMs > staleAfterMs
					? notFresh(
							"stale",
							`its newest recorded event is older than ${Math.round(staleAfterMs / 1000)} s`,
							lastEventAtMs,
							readAtMs,
						)
					: fresh(lastEventAtMs, readAtMs);
		const observation = open && sessionFreshness.state === "fresh" ? "active" : "last-observed";
		const basisCounts = { events: events.length, agentReported: 0, controllerObserved: 0, unclassified: 0 };
		const activityAll: EndoCoordinatorActivityV0[] = events.map((e) => {
			const basis = endoCoordinatorBasisOfKindV0(e.kind);
			if (basis === "agent-reported") basisCounts.agentReported += 1;
			else if (basis === "controller-observed") basisCounts.controllerObserved += 1;
			else basisCounts.unclassified += 1;
			return { kind: e.kind, atMs: Date.parse(e.at), basis, eventId: e.id };
		});
		const activity = activityAll.slice(-ENDO_COORDINATOR_LIMITS_V0.maxActivityPerSession).reverse();
		const sessionLinks = links.filter((l) => l.sessionId === sessionId);
		const scopedLinks = sessionLinks.filter(inScopeLink);
		const session: EndoCoordinatorSessionV0 = {
			sessionId,
			runtime: overview.session.status === "reported" ? overview.session.value.runtime : null,
			runtimeSessionId: overview.session.status === "reported" ? overview.session.value.runtimeSessionId : null,
			observation,
			recordedState: overview.state,
			stateBasis: "controller-observed",
			freshness: sessionFreshness,
			firstEventAtMs,
			lastEventAtMs,
			openRun: overview.run === null ? null : { turns: overview.run.turns, basis: "agent-reported" },
			lastRun:
				overview.lastRun === null
					? null
					: {
							outcome: overview.lastRun.outcome,
							turns: overview.lastRun.turns,
							basis: overview.lastRun.outcome === "interrupted" ? "controller-observed" : "agent-reported",
						},
			activity,
			moreActivity: Math.max(0, activityAll.length - activity.length),
			counts: { ...basisCounts, anomalies: overview.anomalies.length },
			association: scopedLinks.length > 0 ? "explicit" : "unknown",
			links: scopedLinks,
		};
		// A session linked only to tasks out of scope is never listed, only counted.
		allSessions.push({ session, outOfScope: scopedLinks.length === 0 && sessionLinks.length > 0 });
	}
	allSessions.sort(
		(a, b) =>
			b.session.lastEventAtMs - a.session.lastEventAtMs || (a.session.sessionId < b.session.sessionId ? -1 : 1),
	);
	const unlistedSessions = { unknownRelationship: 0, outOfScope: 0, active: 0 };
	const listed: EndoCoordinatorSessionV0[] = [];
	for (const { session: s, outOfScope } of allSessions) {
		const show = s.association === "explicit" || (!outOfScope && requested === null);
		if (!show) {
			if (outOfScope) unlistedSessions.outOfScope += 1;
			else unlistedSessions.unknownRelationship += 1;
			if (s.observation === "active") unlistedSessions.active += 1;
			continue;
		}
		listed.push(s);
	}
	const sessions = listed.slice(0, ENDO_COORDINATOR_LIMITS_V0.maxSessions);
	if (listed.length > sessions.length)
		findings.push({
			code: "sessions-truncated",
			severity: "incomplete",
			subject: null,
			text: `${listed.length - sessions.length} older session(s) are not listed.`,
		});
	for (const s of sessions) {
		if ((s.recordedState === "idle" || s.recordedState === "running") && s.observation !== "active")
			findings.push({
				code: "session-recorded-open-but-stale",
				severity: "stale",
				subject: s.sessionId,
				text: `Session ${s.sessionId} was last recorded as ${s.recordedState}, but that record is ${s.freshness.state}; it is not reported as active.`,
			});
		if (s.counts.anomalies > 0)
			findings.push({
				code: "session-lifecycle-anomalies",
				severity: "contradiction",
				subject: s.sessionId,
				text: `Session ${s.sessionId} has ${s.counts.anomalies} recorded event(s) out of lifecycle order.`,
			});
	}

	// ---- attention (advisory) ----------------------------------------------------------------------------------------------------------
	for (const f of findings)
		if (f.severity === "unavailable")
			attention.push({ kind: "source-unavailable", subject: f.subject, text: f.text });
	for (const p of projects)
		for (const t of p.tasks) {
			if (t.phase === "awaiting-review")
				attention.push({
					kind: "awaiting-your-review",
					subject: t.taskId,
					text: `Task ${t.taskId} awaits your review (verification: ${t.verification.state}).`,
				});
			if (t.verification.state === "failing")
				attention.push({
					kind: "verification-failing",
					subject: t.taskId,
					text: `A check of task ${t.taskId} fails.`,
				});
			if (t.verification.state === "inconclusive")
				attention.push({
					kind: "verification-inconclusive",
					subject: t.taskId,
					text: `A check of task ${t.taskId} is inconclusive.`,
				});
			if (t.phase === "blocked")
				attention.push({
					kind: "blocked",
					subject: t.taskId,
					text: `Task ${t.taskId} is blocked by the operator's record.`,
				});
			if ((t.phase === "in-progress" || t.phase === "awaiting-review") && t.verification.state === "not-current")
				attention.push({
					kind: "evidence-stale",
					subject: t.taskId,
					text: `Task ${t.taskId}'s checks are not current; recheck before relying on them.`,
				});
		}
	for (const f of findings) {
		if (f.severity === "contradiction") attention.push({ kind: "contradiction", subject: f.subject, text: f.text });
		if (f.code === "session-recorded-open-but-stale")
			attention.push({ kind: "evidence-stale", subject: f.subject, text: f.text });
	}

	return {
		schemaVersion: ENDO_COORDINATOR_STATUS_SCHEMA_V0,
		readAtMs,
		staleAfterMs,
		authority: ENDO_COORDINATOR_AUTHORITY_V0,
		scope: { requested, projects: inScope.map((p) => p.id), unknown },
		sources: { tasks: tasksSource, attempts: attemptsSource, events: eventsSource },
		projects,
		sessions,
		unlistedSessions,
		attention,
		findings,
		notEstablished: ENDO_COORDINATOR_NOT_ESTABLISHED_V0,
	};
}

const iso = (ms: number | null): string => (ms === null ? "unknown" : new Date(ms).toISOString());
const age = (ms: number | null): string => {
	if (ms === null) return "age unknown";
	const s = Math.round(ms / 1000);
	if (s < 120) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 120) return `${m}m ago`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** The operator-facing text of a status reading (stderr of `endo coordinator status`). */
export function renderEndoCoordinatorStatusV0(status: EndoCoordinatorStatusV0): string {
	const out: string[] = [];
	out.push(
		`coordinator status ${status.schemaVersion} read ${iso(status.readAtMs)} (read-only; grants nothing; decisions are yours)`,
	);
	const src = status.sources;
	out.push(
		`  sources   tasks=${src.tasks.state}/${src.tasks.freshness.state} attempts=${src.attempts.state}/${src.attempts.freshness.state} events=${src.events.state}/${src.events.freshness.state}`,
	);
	for (const p of status.projects) {
		const head =
			p.head === null ? "HEAD unavailable" : `HEAD ${p.head.commit.slice(0, 12)}${p.head.clean ? "" : " (dirty)"}`;
		out.push(`  project   ${p.id} ${p.name} [${p.freshness.state}] ${head}`);
		for (const t of p.tasks) {
			out.push(
				`    task    [${t.phase}; operator-declared] ${t.taskId} ${t.title} — verification ${t.verification.state} [${t.verification.freshness.state}]; attempts ${t.attempts.count}${t.attempts.latest === null ? "" : ` (latest ${t.attempts.latest.state})`}; sessions ${t.association}`,
			);
			for (const g of t.gaps) out.push(`      gap   ${g.code}: ${g.text}`);
		}
	}
	if (status.sessions.length === 0) out.push("  sessions  none listed");
	for (const s of status.sessions)
		out.push(
			`  session   [${s.observation}] ${s.sessionId} recorded ${s.recordedState} [${s.freshness.state}] last event ${iso(s.lastEventAtMs)} (${age(s.freshness.ageMs)}); last run ${s.lastRun === null ? "none" : `${s.lastRun.outcome} [${s.lastRun.basis}]`}; association ${s.association}`,
		);
	const u = status.unlistedSessions;
	if (u.unknownRelationship + u.outOfScope > 0)
		out.push(
			`  unlisted  ${u.unknownRelationship} session(s) of unknown relationship, ${u.outOfScope} out of scope (${u.active} active)`,
		);
	for (const a of status.attention) out.push(`  attention [${a.kind}] ${a.text}`);
	for (const f of status.findings) out.push(`  finding   [${f.severity}] ${f.code}: ${f.text}`);
	out.push("  not established:");
	for (const n of status.notEstablished) out.push(`    - ${n}`);
	return `${out.join("\n")}\n`;
}
