// COORDINATOR-STATUS-001 (docs/designs/coordinator-status.md): the read-only Coordinator status.
//
// Part 1 drives the pure projection with synthetic records for the normal, stale, incomplete, contradictory and unavailable states,
// scope, and the "never guess an association" rule. Part 2 builds a real store and a real Git repository on disk, runs the real CLI as a
// subprocess, and proves the read wrote nothing by comparing content-hash manifests of the store and the repository (.git included)
// before and after; a write command run against the same manifests is the negative control showing the manifest does see writes.

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readEndoCoordinatorStatusV0 } from "../adapters/develop/coordinator-status.ts";
import {
	ENDO_COORDINATOR_STATUS_SCHEMA_V0,
	type EndoCoordinatorStatusV0,
	EndoInvalidCoordinatorStatusV0,
	validateEndoCoordinatorStatusV0,
} from "../protocol/coordinator-status.ts";
import type {
	EndoDevelopAttentionPlannedV1,
	EndoDevelopAttentionTaskV0,
	EndoDevelopAttentionViewV0,
} from "../protocol/develop-attention.ts";
import type { EndoDevelopTaskStatusV0 } from "../protocol/develop-tasks.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import {
	type EndoCoordinatorInputsV0,
	endoCoordinatorBasisResolverV0,
	endoCoordinatorStatusV0,
	renderEndoCoordinatorStatusV0,
} from "../runtime/contracts/coordinator-status.ts";
import {
	buildCoordinatorStoreV0,
	cleanCoordinatorFixturesV0,
	coordinatorTempDirV0,
} from "./coordinator-status-fixture.ts";
import { manifestOf } from "./read-only-manifest.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const MIN = 60_000;
const P = "endo.project.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const Q = "endo.project.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T_REVIEW = "endo.task.11111111111111111111111111111111";
const T_WORK = "endo.task.22222222222222222222222222222222";
const T_DONE = "endo.task.33333333333333333333333333333333";
const T_OTHER = "endo.task.44444444444444444444444444444444";
const A_REVIEW = "endo.attempt.11111111111111111111111111111111";
const A_WORK = "endo.attempt.22222222222222222222222222222222";
const S_LIVE = "endo.session.pi.live-0001";
const S_OTHER = "endo.session.pi.other-0002";
const HEAD = "c".repeat(40);

// ---- synthetic records ------------------------------------------------------------------------------------------------------------

function task(id: string, projectId: string, status: EndoDevelopTaskStatusV0, sessions: unknown[] = []) {
	return {
		id,
		projectId,
		title: `Task ${id.slice(-4)}`,
		description: "",
		acceptance: "",
		status,
		createdAtMs: NOW - 60 * MIN,
		updatedAtMs: NOW - 30 * MIN,
		revision: 2,
		history: [],
		sessions,
	};
}

function project(id: string, name: string) {
	return {
		id,
		name,
		path: `/repo/${name}`,
		observedGitRoot: null,
		createdAtMs: 0,
		updatedAtMs: 0,
		revision: 1,
		selectedTaskId: null,
	};
}

function piLink(sessionId: string) {
	return {
		linkId: "endo.link.0001",
		source: "pi-live",
		sessionId,
		attachment: "pi.default",
		launchId: "0123456789abcdef",
		linkedAtMs: NOW - 20 * MIN,
		linkedBy: "operator",
		via: "workbench",
	};
}

function attemptEntry(id: string, taskId: string, outcome: "reported" | "abandoned" | null = null) {
	return {
		attempt: { id, projectId: P, taskId, preparedAtMs: NOW - 25 * MIN },
		handoff: null,
		outcome: outcome === null ? null : { kind: outcome, recordedAtMs: NOW - 5 * MIN, note: "done, it says" },
		authorized: null,
	};
}

let seq = 0;
function ev(
	kind: string,
	sessionId: string,
	atMs: number,
	payload: Record<string, unknown> = {},
	derivedFrom: string[] = [],
): EndoEventV0 {
	seq += 1;
	return {
		schemaVersion: "endo.event.v0",
		id: `endo.event.${seq.toString(16).padStart(32, "0")}`,
		kind,
		source: kind.startsWith("lifecycle.") ? "interpretation" : "runtime-fact",
		sequence: seq,
		at: new Date(atMs).toISOString(),
		coordinates: { sessionId },
		producer: "endo.test",
		derivedFrom,
		payload: payload as never,
	};
}

const started = (sessionId: string, atMs: number, derivedFrom: string[] = []) =>
	ev(
		"lifecycle.session-started",
		sessionId,
		atMs,
		{
			runtime: "pi",
			runtimeSessionId: sessionId.split(".").at(-1),
			instance: "inst-1",
			unavailable: [],
		},
		derivedFrom,
	);

/** A Pi-shaped live session: the controller saw the attachment, the runtime reported agent_start, then a turn. */
function liveSession(sessionId: string, atMs: number): EndoEventV0[] {
	const attached = ev("harness.attached", sessionId, atMs - 6_000);
	const agentStart = ev("agent.agent-start", sessionId, atMs + MIN - 6_000);
	return [
		attached,
		started(sessionId, atMs, [attached.id]),
		agentStart,
		ev("lifecycle.run-started", sessionId, atMs + MIN, { instance: "inst-1" }, [agentStart.id]),
		ev("agent.turn-started", sessionId, atMs + 2 * MIN),
	];
}

function planned(
	attemptId: string,
	state: EndoDevelopAttentionPlannedV1["state"],
	outcome = "passed",
): EndoDevelopAttentionPlannedV1 {
	return {
		attemptId,
		name: "test",
		command: "npm test",
		behavioural: false,
		state,
		atHead: { passed: state === "passed" ? 1 : 0, failed: state === "failed" ? 1 : 0, inconclusive: 0 },
		receipt:
			state === "not-run"
				? null
				: {
						receiptId: "endo.receipt.1",
						commit: HEAD,
						startedAtMs: NOW - 10 * MIN,
						endedAtMs: NOW - 9 * MIN,
						outcome: outcome as never,
					},
		incomplete: false,
		elsewhere: null,
	};
}

function attentionTask(
	taskId: string,
	plannedChecks: EndoDevelopAttentionPlannedV1[],
	extra: Partial<EndoDevelopAttentionTaskV0> = {},
) {
	return {
		taskId,
		attempts: 1,
		latestAttempt: null,
		unreadable: 0,
		skipped: 0,
		problems: 0,
		records: 0,
		checks: [],
		planned: plannedChecks,
		morePlanned: { checks: 0, notPassing: 0, notCurrent: 0 },
		more: { commands: 0, notPassing: 0, notCurrent: 0 },
		...extra,
	} satisfies EndoDevelopAttentionTaskV0;
}

function view(
	tasks: EndoDevelopAttentionTaskV0[],
	extra: Partial<EndoDevelopAttentionViewV0> = {},
): EndoDevelopAttentionViewV0 {
	return {
		schemaVersion: "endo.develop-attention-view.v1",
		launchId: "coordinator-status",
		state: "ready",
		taskRevision: 3,
		head: { commit: HEAD, clean: true },
		tasks,
		truncated: false,
		unattributed: 0,
		...extra,
	};
}

/** A healthy baseline: one task in review with a passing planned check, one in progress linked to a live session, one done. */
function baseline(over: Partial<EndoCoordinatorInputsV0> = {}): EndoCoordinatorInputsV0 {
	return {
		readAtMs: NOW,
		staleAfterMs: 10 * MIN,
		requested: null,
		tasks: {
			ok: true,
			exists: true,
			format: "endo.develop-tasks.v1",
			file: {
				schemaVersion: "endo.develop-tasks.v1",
				revision: 3,
				projects: [project(P, "alpha")],
				tasks: [
					task(T_REVIEW, P, "review"),
					task(T_WORK, P, "in-progress", [piLink(S_LIVE)]),
					task(T_DONE, P, "done"),
				],
			},
		} as never,
		attempts: {
			ok: true,
			entries: [attemptEntry(A_REVIEW, T_REVIEW), attemptEntry(A_WORK, T_WORK)],
			problems: [],
			authorizedProposalIds: [],
		} as never,
		events: { state: "complete", events: liveSession(S_LIVE, NOW - 4 * MIN) },
		attention: new Map([
			[
				P,
				{
					observedAtMs: NOW - 1000,
					view: view([
						attentionTask(T_REVIEW, [planned(A_REVIEW, "passed")]),
						attentionTask(T_WORK, [planned(A_WORK, "not-run")]),
					]),
				},
			],
		]),
		...over,
	};
}

const taskOf = (s: EndoCoordinatorStatusV0, id: string) =>
	s.projects.flatMap((p) => p.tasks).find((t) => t.taskId === id)!;
const codes = (s: EndoCoordinatorStatusV0) => s.findings.map((f) => f.code);

describe("coordinator status projection", () => {
	it("normal: phases follow the operator's status, a fresh open session is active, sources are kept apart", () => {
		const s = validateEndoCoordinatorStatusV0(endoCoordinatorStatusV0(baseline()));
		expect(s.schemaVersion).toBe(ENDO_COORDINATOR_STATUS_SCHEMA_V0);
		expect(s.authority).toMatchObject({ kind: "read-only-projection", grants: "none", writes: "none" });
		const p = s.projects[0]!;
		expect(p.counts).toEqual({ "in-progress": 1, "awaiting-review": 1, completed: 1, open: 0, blocked: 0 });
		expect(p.tasks.map((t) => t.phase)).toEqual(["awaiting-review", "in-progress", "completed"]);
		for (const t of p.tasks) expect(t.statusSource).toBe("operator-declared");

		const review = taskOf(s, T_REVIEW);
		expect(review.verification.state).toBe("incomplete");
		expect(review.verification.freshness.state).toBe("incomplete");
		expect(review.verification.results[0]).toMatchObject({
			relation: "at-head",
			freshness: "fresh",
			basis: "controller-observed",
		});
		expect(review.gaps.map((g) => g.code)).toEqual(["receipt-history-unverifiable"]);
		expect(review.association).toBe("unknown");

		const done = taskOf(s, T_DONE);
		expect(done.verification.state).toBe("not-read");
		expect(done.gaps.map((g) => g.code)).toEqual(["completed-not-reverified"]);

		const work = taskOf(s, T_WORK);
		expect(work.verification.state).toBe("no-checks");
		expect(work.gaps.map((g) => g.code)).toEqual(["no-check-recorded"]);
		expect(work.association).toBe("explicit");
		expect(work.sessions[0]).toMatchObject({
			sessionId: S_LIVE,
			via: "operator-linked",
			basis: "operator-declared",
			inLog: "yes",
		});

		expect(s.sessions).toHaveLength(1);
		const live = s.sessions[0]!;
		expect(live).toMatchObject({
			observation: "active",
			recordedState: "running",
			stateBasis: "agent-reported",
			association: "explicit",
		});
		expect(live.freshness.state).toBe("fresh");
		expect(live.openRun).toEqual({ turns: 0, basis: "agent-reported" });
		const basisOf = Object.fromEntries(live.activity.map((a) => [a.kind, a.basis]));
		expect(basisOf).toEqual({
			"harness.attached": "controller-observed",
			"lifecycle.session-started": "controller-observed",
			"agent.agent-start": "agent-reported",
			"lifecycle.run-started": "agent-reported",
			"agent.turn-started": "agent-reported",
		});
		expect(live.counts).toMatchObject({ events: 5, agentReported: 3, controllerObserved: 2 });
		expect(s.attention.map((a) => a.kind)).toEqual(["awaiting-your-review"]);
		expect(s.findings).toEqual([]);
		expect(renderEndoCoordinatorStatusV0(s)).toContain("[active] endo.session.pi.live-0001");
	});

	it("stale: an open session record that went quiet is last-observed, and old checks are not current", () => {
		const b = baseline();
		const s = endoCoordinatorStatusV0({
			...b,
			attempts: {
				ok: true,
				entries: [attemptEntry(A_REVIEW, T_REVIEW, "reported"), attemptEntry(A_WORK, T_WORK)],
				problems: [],
				authorizedProposalIds: [],
			} as never,
			events: {
				state: "complete",
				events: [
					started(S_LIVE, NOW - 180 * MIN),
					ev("lifecycle.run-started", S_LIVE, NOW - 179 * MIN, { instance: "inst-1" }),
				],
			},
			attention: new Map([
				[P, { observedAtMs: NOW, view: view([attentionTask(T_REVIEW, [planned(A_REVIEW, "stale")])]) }],
			]),
		});
		validateEndoCoordinatorStatusV0(s);
		const live = s.sessions[0]!;
		expect(live.recordedState).toBe("running");
		expect(live.observation).toBe("last-observed");
		expect(live.freshness).toMatchObject({ state: "stale", ageMs: 179 * MIN });
		expect(codes(s)).toContain("session-recorded-open-but-stale");
		const review = taskOf(s, T_REVIEW);
		expect(review.verification.state).toBe("not-current");
		expect(review.verification.freshness.state).toBe("stale");
		expect(review.verification.results[0]).toMatchObject({
			relation: "head-differs",
			freshness: "stale",
			outcome: "passed",
		});
		expect(review.gaps.map((g) => g.code)).toEqual([
			"checks-not-current",
			"no-check-at-current-head",
			"report-recorded-unverified",
			"review-without-passing-check",
		]);
		// A stale pass and a recorded report are not a contradiction, only unverified.
		expect(s.findings.filter((f) => f.severity === "contradiction")).toEqual([]);
		expect(s.attention.map((a) => a.kind)).toContain("evidence-stale");
	});

	it("stale: never active even when the record says running, whatever the staleness window", () => {
		const s = endoCoordinatorStatusV0({ ...baseline(), staleAfterMs: 60_000 });
		expect(s.sessions[0]!.observation).toBe("last-observed");
		expect(() => validateEndoCoordinatorStatusV0(s)).not.toThrow();
	});

	it("incomplete: a torn log, unusable attempt files and unread receipts are said, never smoothed over", () => {
		const b = baseline();
		const s = endoCoordinatorStatusV0({
			...b,
			events: { state: "partial", events: (b.events as { events: readonly EndoEventV0[] }).events },
			attempts: { ...(b.attempts as object), problems: [{ name: "x.prepared.json", reason: "malformed" }] } as never,
			attention: new Map([
				[
					P,
					{
						observedAtMs: NOW,
						view: view([attentionTask(T_REVIEW, [planned(A_REVIEW, "passed")], { unreadable: 1, skipped: 2 })], {
							truncated: true,
						}),
					},
				],
			]),
		});
		validateEndoCoordinatorStatusV0(s);
		expect(s.sources.events).toMatchObject({ state: "partial", freshness: { state: "incomplete" } });
		expect(s.sources.attempts).toMatchObject({ state: "partial", freshness: { state: "incomplete" } });
		expect(s.sessions[0]).toMatchObject({ observation: "last-observed", recordedState: "running" });
		expect(s.sessions[0]!.freshness.state).toBe("incomplete");
		const review = taskOf(s, T_REVIEW);
		expect(review.verification.incomplete).toBe(true);
		expect(review.verification.freshness.state).toBe("incomplete");
		expect(review.gaps.map((g) => g.code)).toEqual(
			expect.arrayContaining(["receipts-unreadable", "receipts-skipped-at-limit"]),
		);
		expect(s.projects[0]!.freshness.state).toBe("incomplete");
		expect(codes(s)).toEqual(expect.arrayContaining(["event-log-incomplete", "attempt-records-unusable"]));
	});

	it("contradictory: review against a failing check, lifecycle anomalies, a link the log never saw", () => {
		const b = baseline();
		const s = endoCoordinatorStatusV0({
			...b,
			tasks: {
				...(b.tasks as object),
				file: {
					...(b.tasks as { file: object }).file,
					tasks: [
						task(T_REVIEW, P, "review", [piLink("endo.session.pi.never-recorded")]),
						task(T_WORK, P, "in-progress", [piLink(S_LIVE)]),
					],
				},
			} as never,
			attempts: {
				ok: true,
				entries: [attemptEntry(A_REVIEW, T_REVIEW, "reported")],
				problems: [],
				authorizedProposalIds: [],
			} as never,
			events: {
				state: "complete",
				events: [
					started(S_LIVE, NOW - 3 * MIN),
					ev("lifecycle.turn-completed", S_LIVE, NOW - 2 * MIN, { turn: 1 }),
				],
			},
			attention: new Map([
				[P, { observedAtMs: NOW, view: view([attentionTask(T_REVIEW, [planned(A_REVIEW, "failed", "failed")])]) }],
			]),
		});
		validateEndoCoordinatorStatusV0(s);
		expect(taskOf(s, T_REVIEW).verification.state).toBe("failing");
		expect(s.findings.filter((f) => f.severity === "contradiction").map((f) => f.code)).toEqual([
			"status-contradicts-verification",
			"session-lifecycle-anomalies",
		]);
		// A recorded report plus a failing check is not a contradiction: the report record does not say what result was claimed.
		expect(taskOf(s, T_REVIEW).gaps.map((g) => g.code)).toContain("report-recorded-unverified");
		expect(s.findings.find((f) => f.code === "session-link-not-in-log")).toMatchObject({
			severity: "integrity",
			subject: T_REVIEW,
		});
		expect(taskOf(s, T_REVIEW).sessions[0]!.inLog).toBe("no");
		expect(s.attention.map((a) => a.kind)).toEqual(
			expect.arrayContaining(["verification-failing", "contradiction", "awaiting-your-review"]),
		);
		// The task's status is still the operator's: a failing check never moves it.
		expect(taskOf(s, T_REVIEW)).toMatchObject({ status: "review", phase: "awaiting-review" });
	});

	it("unavailable: an unreadable task file says nothing about any task; a missing log knows no session; no HEAD makes nothing current", () => {
		const none = endoCoordinatorStatusV0({
			...baseline(),
			tasks: { ok: false, reason: "invalid" } as never,
			events: { state: "unavailable" },
		});
		validateEndoCoordinatorStatusV0(none);
		expect(none.projects).toEqual([]);
		expect(none.sessions).toEqual([]);
		expect(none.sources.tasks).toMatchObject({ state: "unavailable", freshness: { state: "unavailable" } });
		expect(codes(none)).toEqual(["tasks-unavailable", "event-log-unavailable"]);
		expect(none.attention.every((a) => a.kind === "source-unavailable")).toBe(true);

		const noHead = endoCoordinatorStatusV0({
			...baseline(),
			attention: new Map([
				[
					P,
					{
						observedAtMs: NOW,
						view: view([attentionTask(T_REVIEW, [planned(A_REVIEW, "unavailable")])], { head: null }),
					},
				],
			]),
		});
		validateEndoCoordinatorStatusV0(noHead);
		expect(noHead.projects[0]!.freshness.state).toBe("unavailable");
		expect(taskOf(noHead, T_REVIEW).verification.state).toBe("unavailable");
		expect(taskOf(noHead, T_REVIEW).gaps.map((g) => g.code)).toContain("head-unavailable");
		expect(codes(noHead)).toContain("project-head-unavailable");
		expect(taskOf(noHead, T_WORK).verification.state).toBe("unavailable");

		const noAttention = endoCoordinatorStatusV0({ ...baseline(), attention: new Map() });
		expect(taskOf(noAttention, T_REVIEW).verification.state).toBe("unavailable");
		expect(taskOf(noAttention, T_REVIEW).gaps.map((g) => g.code)).toEqual(["attention-unavailable"]);
	});

	it("scope: only permitted projects are read; sessions of unknown or out-of-scope relationship are counted, not listed", () => {
		const b = baseline();
		const s = endoCoordinatorStatusV0({
			...b,
			requested: [P, "endo.project.ffffffffffffffffffffffffffffffff"],
			tasks: {
				...(b.tasks as object),
				file: {
					...(b.tasks as { file: object }).file,
					projects: [project(P, "alpha"), project(Q, "beta")],
					tasks: [task(T_REVIEW, P, "review"), task(T_OTHER, Q, "in-progress", [piLink(S_OTHER)])],
				},
			} as never,
			events: {
				state: "complete",
				events: [
					started(S_LIVE, NOW - 2 * MIN),
					started(S_OTHER, NOW - 2 * MIN),
					started("endo.session.pi.loose", NOW - 300 * MIN),
				],
			},
		});
		validateEndoCoordinatorStatusV0(s);
		expect(s.scope).toEqual({
			requested: [P, "endo.project.ffffffffffffffffffffffffffffffff"],
			projects: [P],
			unknown: ["endo.project.ffffffffffffffffffffffffffffffff"],
		});
		expect(s.projects.map((p) => p.id)).toEqual([P]);
		expect(JSON.stringify(s)).not.toContain(T_OTHER);
		expect(JSON.stringify(s)).not.toContain(S_OTHER);
		expect(s.sessions).toEqual([]);
		// The out-of-scope session is counted but its activity is not reported; only unknown sessions carry an active count.
		expect(s.unlistedSessions).toEqual({ unknownRelationship: 2, unknownActive: 1, outOfScope: 1 });
		expect(codes(s)).toContain("project-not-permitted-or-unknown");
	});

	it("never guesses an association from names or timestamps", () => {
		const b = baseline();
		// A session whose id embeds the task id, started the very millisecond the task was last updated, with no record linking them.
		const lookalike = `endo.session.pi.${T_REVIEW.slice(10)}`;
		const s = endoCoordinatorStatusV0({
			...b,
			events: { state: "complete", events: [started(lookalike, NOW - 30 * MIN)] },
		});
		validateEndoCoordinatorStatusV0(s);
		expect(taskOf(s, T_REVIEW).association).toBe("unknown");
		expect(taskOf(s, T_REVIEW).sessions).toEqual([]);
		expect(s.sessions.find((x) => x.sessionId === lookalike)).toMatchObject({ association: "unknown", links: [] });
	});

	it("includes session findings only for the requested project", () => {
		const b = baseline();
		const input: EndoCoordinatorInputsV0 = {
			...b,
			tasks: {
				...b.tasks,
				file: {
					...(b.tasks as { file: object }).file,
					projects: [project(P, "alpha"), project(Q, "beta")],
					tasks: [
						task(T_WORK, P, "in-progress", [piLink(S_LIVE)]),
						task(T_OTHER, Q, "in-progress", [piLink(S_OTHER)]),
					],
				},
			} as never,
			events: { state: "complete", events: [started(S_LIVE, NOW + MIN), started(S_OTHER, NOW + MIN)] },
		};
		const affected = (s: EndoCoordinatorStatusV0) =>
			s.findings.filter((f) => f.code === "event-time-in-future").map((f) => f.subject);
		const all = validateEndoCoordinatorStatusV0(endoCoordinatorStatusV0(input));
		expect(affected(all)).toEqual(expect.arrayContaining([S_LIVE, S_OTHER]));
		const scoped = validateEndoCoordinatorStatusV0(endoCoordinatorStatusV0({ ...input, requested: [P] }));
		expect(affected(scoped)).toEqual([S_LIVE]);
		expect(JSON.stringify(scoped)).not.toContain(S_OTHER);
		const otherFinding = all.findings.find((f) => f.subject === S_OTHER);
		expect(() =>
			validateEndoCoordinatorStatusV0({ ...scoped, findings: [...scoped.findings, otherFinding] }),
		).toThrow(/outside the reported scope/);
	});

	it("an attempt's send authorisation is an explicit, controller-observed link", () => {
		const b = baseline();
		const entry = {
			...attemptEntry(A_REVIEW, T_REVIEW),
			authorized: {
				attemptId: A_REVIEW,
				session: S_LIVE,
				launchId: "fedcba9876543210",
				recordedAtMs: NOW - 4 * MIN,
			},
		};
		const s = endoCoordinatorStatusV0({
			...b,
			attempts: { ok: true, entries: [entry], problems: [], authorizedProposalIds: [] } as never,
		});
		validateEndoCoordinatorStatusV0(s);
		expect(taskOf(s, T_REVIEW).sessions).toEqual([
			expect.objectContaining({
				via: "send-authorized",
				basis: "controller-observed",
				attemptId: A_REVIEW,
				inLog: "yes",
			}),
		]);
		expect(taskOf(s, T_REVIEW).attempts.latest).toMatchObject({ id: A_REVIEW, sendAuthorized: true });
	});

	it("derives who said what from the evidence an event rests on, not from its kind name", () => {
		const sid = "endo.session.acp.basis";
		// ACP v1: the run start is derived from the controller's own prompt request.
		const requested = ev("control.requested", sid, NOW - 5 * MIN, { capability: "session.prompt" });
		const acpRun = ev("lifecycle.run-started", sid, NOW - 5 * MIN, { instance: "x" }, [requested.id]);
		// Pi: the same kind derived from the runtime's own agent_start.
		const agentStart = ev("agent.agent-start", sid, NOW - 4 * MIN);
		const piRun = ev("lifecycle.run-started", sid, NOW - 4 * MIN, { instance: "y" }, [agentStart.id]);
		const orphan = ev("lifecycle.run-completed", sid, NOW - 3 * MIN, {}, ["endo.event.not-in-this-log"]);
		const bare = ev("lifecycle.interrupted", sid, NOW - 3 * MIN);
		const mixed = ev("lifecycle.stop-accepted", sid, NOW - 2 * MIN, {}, [requested.id, agentStart.id]);
		const hypothesis = { ...ev("harness.guess", sid, NOW - 2 * MIN), source: "hypothesis" as const };
		const loopA = ev("lifecycle.run-aborted", sid, NOW - MIN, {}, ["endo.event.loop-b"]);
		const loopB = { ...ev("lifecycle.run-aborted", sid, NOW - MIN, {}, [loopA.id]), id: "endo.event.loop-b" };
		const all = [requested, acpRun, agentStart, piRun, orphan, bare, mixed, hypothesis, loopA, loopB];
		const basis = endoCoordinatorBasisResolverV0(all);
		expect(basis(requested)).toBe("controller-observed");
		expect(basis(acpRun)).toBe("controller-observed");
		expect(basis(agentStart)).toBe("agent-reported");
		expect(basis(piRun)).toBe("agent-reported");
		expect(basis(mixed)).toBe("agent-reported");
		expect(basis(orphan)).toBe("unclassified");
		expect(basis(bare)).toBe("unclassified");
		expect(basis(hypothesis)).toBe("unclassified");
		expect(basis(loopA)).toBe("unclassified");

		const s = endoCoordinatorStatusV0({
			...baseline(),
			events: { state: "complete", events: [ev("harness.attached", sid, NOW - 6 * MIN), requested, acpRun] },
		});
		const session = s.sessions.find((x) => x.sessionId === sid)!;
		expect(session.openRun).toEqual({ turns: 0, basis: "controller-observed" });
		expect(session.stateBasis).toBe("controller-observed");
	});

	it("the validator refuses what would mislead: active without fresh evidence, a phase not the operator's, another version", () => {
		const good = endoCoordinatorStatusV0(baseline());
		const clone = () => JSON.parse(JSON.stringify(good)) as EndoCoordinatorStatusV0;
		const staleActive = clone();
		staleActive.sessions[0]!.freshness = {
			...staleActive.sessions[0]!.freshness,
			state: "stale",
			reason: "doctored",
		};
		expect(() => validateEndoCoordinatorStatusV0(staleActive)).toThrow(/active without fresh evidence/);
		const inferredPhase = clone();
		inferredPhase.projects[0]!.tasks[0]!.phase = "completed";
		expect(() => validateEndoCoordinatorStatusV0(inferredPhase)).toThrow(/does not follow the operator's status/);
		const guessed = clone();
		guessed.projects[0]!.tasks[0]!.association = "explicit";
		expect(() => validateEndoCoordinatorStatusV0(guessed)).toThrow(/association does not match its links/);
		const other = { ...clone(), schemaVersion: "endo.coordinator-status.v9" };
		expect(() => validateEndoCoordinatorStatusV0(other)).toThrow(EndoInvalidCoordinatorStatusV0);
		const granting = clone() as unknown as { authority: { grants: string } };
		granting.authority.grants = "terminal";
		expect(() => validateEndoCoordinatorStatusV0(granting)).toThrow(/grants nothing/);
	});
});

describe("coordinator status: review findings (ENDO-28 review)", () => {
	const failedElsewhere = (state: "stale" | "tree-changed" = "stale") => planned(A_REVIEW, state, "failed");

	it("a failure at an earlier HEAD is history, never a current failure; current state comes from checks at the current HEAD", () => {
		for (const extra of [{}, { unreadable: 1 }]) {
			const s = endoCoordinatorStatusV0({
				...baseline(),
				attention: new Map([
					[
						P,
						{
							observedAtMs: NOW,
							view: view([
								attentionTask(T_REVIEW, [failedElsewhere()], {
									...extra,
									checks: [
										{
											command: "node check.mjs",
											outcome: "failed",
											relation: "head-differs",
											attemptId: A_REVIEW,
											receiptId: "endo.receipt.2",
											commit: "d".repeat(40),
											startedAtMs: NOW - 20 * MIN,
										},
									] as never,
								}),
							]),
						},
					],
				]),
			});
			validateEndoCoordinatorStatusV0(s);
			const v = taskOf(s, T_REVIEW).verification;
			expect(v.state).toBe("not-current");
			expect(v.freshness.state).toBe(Object.keys(extra).length > 0 ? "incomplete" : "stale");
			expect(v.results.every((r) => r.freshness === "stale")).toBe(true);
			expect(taskOf(s, T_REVIEW).gaps.map((g) => g.code)).toEqual(
				expect.arrayContaining(["earlier-failure-not-current", "checks-not-current", "no-check-at-current-head"]),
			);
			expect(s.attention.map((a) => a.kind)).not.toContain("verification-failing");
			expect(codes(s)).not.toContain("status-contradicts-verification");
		}
		// A current pass outranks an older failure, and the older failure stays visible as history.
		const mixedHistory = endoCoordinatorStatusV0({
			...baseline(),
			attention: new Map([
				[
					P,
					{
						observedAtMs: NOW,
						view: view([attentionTask(T_REVIEW, [failedElsewhere(), planned(A_REVIEW, "passed")])]),
					},
				],
			]),
		});
		validateEndoCoordinatorStatusV0(mixedHistory);
		const m = taskOf(mixedHistory, T_REVIEW);
		expect(m.verification.results[0]).toMatchObject({ relation: "at-head", outcome: "passed" });
		expect(m.verification.state).toBe("not-current");
		expect(m.gaps.map((g) => g.code)).toContain("earlier-failure-not-current");
	});

	it("a timestamp after the read never makes a session active or fresh", () => {
		const sid = "endo.session.pi.future";
		const s = endoCoordinatorStatusV0({
			...baseline(),
			staleAfterMs: 1000,
			events: { state: "complete", events: [started(sid, NOW + 24 * 60 * MIN)] },
		});
		validateEndoCoordinatorStatusV0(s);
		const x = s.sessions.find((y) => y.sessionId === sid)!;
		expect(x.observation).toBe("last-observed");
		expect(x.freshness.state).toBe("incomplete");
		expect(x.lastEventAtMs).toBeLessThanOrEqual(NOW);
		expect(codes(s)).toContain("event-time-in-future");
	});

	it("the validator recomputes the premises of every label instead of trusting them (doctored snapshots)", () => {
		const good = endoCoordinatorStatusV0({ ...baseline(), requested: [P] });
		validateEndoCoordinatorStatusV0(good);
		const doctor = (edit: (s: EndoCoordinatorStatusV0) => void) => {
			const c = JSON.parse(JSON.stringify(good)) as EndoCoordinatorStatusV0;
			edit(c);
			return () => validateEndoCoordinatorStatusV0(c);
		};
		const live = (s: EndoCoordinatorStatusV0) => s.sessions.find((x) => x.sessionId === S_LIVE)!;
		expect(
			doctor((s) => {
				live(s).recordedState = "detached";
			}),
		).toThrow(/active but recorded detached/);
		expect(
			doctor((s) => {
				const x = live(s);
				x.lastEventAtMs = NOW - 20 * MIN;
				x.freshness = { ...x.freshness, observedAtMs: NOW - 20 * MIN, ageMs: 20 * MIN };
			}),
		).toThrow(/fresh but older than the staleness window/);
		expect(
			doctor((s) => {
				live(s).freshness.ageMs = 0;
			}),
		).toThrow(/ageMs is not readAtMs - observedAtMs/);
		expect(
			doctor((s) => {
				live(s).lastEventAtMs = NOW + 1;
				live(s).freshness = { ...live(s).freshness, observedAtMs: NOW + 1, ageMs: -1 };
			}),
		).toThrow(/observed after the read/);
		expect(
			doctor((s) => {
				s.sources.events.state = "partial";
			}),
		).toThrow(/partial but its freshness is fresh/);
		expect(
			doctor((s) => {
				s.sources.events = {
					state: "partial",
					freshness: { state: "incomplete", observedAtMs: NOW, ageMs: 0, reason: "doctored" },
					detail: null,
				};
			}),
		).toThrow(/without its event-log-incomplete finding/);
		expect(
			doctor((s) => {
				s.scope.projects = [];
			}),
		).toThrow(/projects do not match scope.projects/);
		expect(
			doctor((s) => {
				s.scope.projects = [];
				s.projects = [];
				s.sessions = [];
			}),
		).toThrow(/neither reported nor declared unknown/);
		expect(
			doctor((s) => {
				s.scope.requested = [Q];
			}),
		).toThrow(/outside the requested scope/);
		expect(
			doctor((s) => {
				const done = taskOf(s, T_DONE);
				done.gaps = [];
			}),
		).toThrow(/completed without completed-not-reverified/);
		expect(
			doctor((s) => {
				const review = taskOf(s, T_REVIEW);
				review.verification.state = "failing";
			}),
		).toThrow(/failing without a failed check at the current HEAD/);
		expect(
			doctor((s) => {
				taskOf(s, T_REVIEW).gaps = [];
			}),
		).toThrow(/must qualify unverifiable receipt history/);

		const stale = endoCoordinatorStatusV0({
			...baseline(),
			attention: new Map([
				[P, { observedAtMs: NOW, view: view([attentionTask(T_REVIEW, [planned(A_REVIEW, "stale")])]) }],
			]),
		});
		validateEndoCoordinatorStatusV0(stale);
		const cleared = JSON.parse(JSON.stringify(stale)) as EndoCoordinatorStatusV0;
		taskOf(cleared, T_REVIEW).gaps = [];
		expect(() => validateEndoCoordinatorStatusV0(cleared)).toThrow(/not-current without its gap/);
		const relabelled = JSON.parse(JSON.stringify(stale)) as EndoCoordinatorStatusV0;
		taskOf(relabelled, T_REVIEW).verification.results[0]!.freshness = "fresh";
		expect(() => validateEndoCoordinatorStatusV0(relabelled)).toThrow(/freshness does not follow its relation/);
	});

	it("a recorded report that a check fails, and a failing check, is not a contradiction", () => {
		const s = endoCoordinatorStatusV0({
			...baseline(),
			attempts: {
				ok: true,
				entries: [
					{
						...attemptEntry(A_WORK, T_WORK, "reported"),
						outcome: { kind: "reported", recordedAtMs: NOW - 5 * MIN, note: "The synthetic check fails" },
					},
				],
				problems: [],
				authorizedProposalIds: [],
			} as never,
			attention: new Map([
				[P, { observedAtMs: NOW, view: view([attentionTask(T_WORK, [planned(A_WORK, "failed", "failed")])]) }],
			]),
		});
		validateEndoCoordinatorStatusV0(s);
		expect(taskOf(s, T_WORK).verification.state).toBe("failing");
		expect(s.findings.filter((f) => f.severity === "contradiction")).toEqual([]);
		expect(taskOf(s, T_WORK).attempts.latest).toMatchObject({ state: "reported", stateBasis: "operator-declared" });
		expect(taskOf(s, T_WORK).gaps.map((g) => g.code)).toContain("report-recorded-unverified");
	});
});

// ---- on disk: the real CLI, and proof that a read writes nothing ------------------------------------------------------------------

afterEach(cleanCoordinatorFixturesV0);

describe("endo coordinator status on disk", () => {
	it("is byte-identical for the same on-disk records, HEAD and read time", async () => {
		const f = await buildCoordinatorStoreV0({ repeatWithFailure: true });
		const now = Date.now();
		const read = async () =>
			JSON.stringify(
				await readEndoCoordinatorStatusV0({
					root: f.root,
					projects: [f.projectId],
					now: () => now,
				}),
			);
		const first = await read();
		expect(taskOf(validateEndoCoordinatorStatusV0(JSON.parse(first)), f.taskId).verification.state).toBe("failing");
		for (let i = 0; i < 3; i += 1) expect(await read()).toBe(first);
	});

	it.each(["attempts", "receipts"] as const)(
		"reports missing %s in a populated store without claiming readiness",
		async (component) => {
			const f = await buildCoordinatorStoreV0();
			const read = () => {
				const run = spawnSync(
					process.execPath,
					[CLI, "coordinator", "status", "--root", f.root, "--project", f.projectId, "--quiet"],
					{ encoding: "utf8" },
				);
				expect(run.status, run.stderr).toBe(0);
				return validateEndoCoordinatorStatusV0(JSON.parse(run.stdout).coordinatorStatus);
			};
			expect(taskOf(read(), f.taskId).verification.state).toBe("incomplete");
			rmSync(join(f.root, "develop", component), { recursive: true });
			const status = read();
			const code = component === "attempts" ? "attempt-records-missing" : "receipt-records-missing";
			if (component === "attempts")
				expect(status.sources.attempts).toMatchObject({ state: "missing", freshness: { state: "unavailable" } });
			const t = taskOf(status, f.taskId);
			expect(t.verification).toMatchObject({
				state: "unavailable",
				incomplete: true,
				freshness: { state: "unavailable" },
			});
			expect(t.gaps.map((g) => g.code)).toContain(code);
			expect(codes(status)).toContain(code);
		},
	);

	it("refuses an at-head receipt naming a different commit", () => {
		const snapshot = validateEndoCoordinatorStatusV0(endoCoordinatorStatusV0(baseline()));
		taskOf(snapshot, T_REVIEW).verification.results[0]!.commit = "e".repeat(40);
		expect(() => validateEndoCoordinatorStatusV0(snapshot)).toThrow(
			/at-head but names a commit other than the observed HEAD/,
		);
	});

	it("prints a valid status and writes nothing: store and repository manifests (.git included) are identical", async () => {
		const f = await buildCoordinatorStoreV0();
		const before = { store: manifestOf(f.root), repo: manifestOf(f.repo) };
		const run = spawnSync(
			process.execPath,
			[CLI, "coordinator", "status", "--root", f.root, "--project", f.projectId],
			{
				encoding: "utf8",
			},
		);
		expect(run.status, run.stderr).toBe(0);
		const after = { store: manifestOf(f.root), repo: manifestOf(f.repo) };
		expect(after).toEqual(before);
		expect(before.repo.some((line) => line.startsWith(".git/index "))).toBe(true);

		const status = validateEndoCoordinatorStatusV0(JSON.parse(run.stdout).coordinatorStatus);
		const t = status.projects[0]!.tasks[0]!;
		expect(t).toMatchObject({ taskId: f.taskId, phase: "awaiting-review", association: "unknown" });
		expect(t.verification.state).toBe("incomplete");
		expect(status.sessions).toEqual([]);
		expect(status.unlistedSessions).toEqual({ unknownRelationship: 1, unknownActive: 1, outOfScope: 0 });
		expect(run.stderr).toContain("coordinator status endo.coordinator-status.v0");

		const all = spawnSync(process.execPath, [CLI, "coordinator", "status", f.root, "--quiet"], { encoding: "utf8" });
		expect(all.status, all.stderr).toBe(0);
		expect(all.stderr).toBe("");
		const everything = validateEndoCoordinatorStatusV0(JSON.parse(all.stdout).coordinatorStatus);
		expect(everything.sessions).toEqual([expect.objectContaining({ observation: "active", association: "unknown" })]);
		expect({ store: manifestOf(f.root), repo: manifestOf(f.repo) }).toEqual(before);
	});

	it("negative control: the same manifests do see a write (an operator status move) — the proof above is not vacuous", async () => {
		const f = await buildCoordinatorStoreV0();
		const before = manifestOf(f.root);
		const moved = spawnSync(
			process.execPath,
			[
				CLI,
				"task",
				"status",
				"--root",
				f.root,
				"--project",
				f.projectId,
				"--task",
				f.taskId,
				"--to",
				"in-progress",
				"--revision",
				String(f.revision),
			],
			{ encoding: "utf8" },
		);
		expect(moved.status, moved.stderr).toBe(0);
		const after = manifestOf(f.root);
		expect(after).not.toEqual(before);
		expect(
			after.filter((line) => !before.includes(line)).some((line) => line.startsWith("develop/tasks.json ")),
		).toBe(true);
	});

	it("refuses a bad --stale-after and an unknown flag without reading", () => {
		const root = coordinatorTempDirV0("endo-coord-empty-");
		const bad = spawnSync(process.execPath, [CLI, "coordinator", "status", root, "--stale-after", "0"], {
			encoding: "utf8",
		});
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("--stale-after");
		const flag = spawnSync(process.execPath, [CLI, "coordinator", "status", root, "--write"], { encoding: "utf8" });
		expect(flag.status).toBe(1);
		expect(flag.stderr).toContain("usage: endo coordinator status");
		expect(readdirSync(root)).toEqual([]);
	});
});
