/**
 * COORDINATOR-GROUNDING-002 — Deterministic baseline reproductions (S2-LIVE-001 findings).
 *
 * Documents and reproduces the exact baseline mechanisms observed in S2-LIVE-001:
 *   1. Project-wide `receipt-absence-unestablished` collisions (W8 `no-checks` + `not-current`; W9/W10 `no-checks` + `incomplete` unplanned PASS).
 *   2. Project-wide `verification-positive-contradiction` collision (Task A passing at HEAD alongside Task B failing).
 *   3. Protective refusals that MUST remain effective (Phase B-1 missing event source, unavailable/unread verification, historical FAIL/PASS conflation).
 *   4. Model-visible coordination blindness in `pinnedCoordinatorBriefStatusV0` (host has coordination, model view omits it).
 */

import { describe, expect, it } from "vitest";
import { pinnedCoordinatorBriefStatusV0 } from "../adapters/coordinator/openclaw.ts";
import { coordinatorAnswerRefusalV0 } from "../adapters/coordinator/status.ts";
import type { EndophasiaExternalStatusV0 } from "../integrations/openclaw-endophasia-status/src/status-reader.ts";
import {
	ENDO_COORDINATION_PROJECTION_AUTHORITY_V0,
	ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
	type EndoCoordinatorCoordinationV0,
} from "../protocol/coordinator-coordination.ts";
import {
	ENDO_COORDINATOR_AUTHORITY_V0,
	ENDO_COORDINATOR_NOT_ESTABLISHED_V0,
	ENDO_COORDINATOR_STATUS_SCHEMA_V0,
	type EndoCoordinatorStatusV0,
} from "../protocol/coordinator-status.ts";

const PROJECT_ID = `endo.project.${"1".repeat(32)}`;
const TASK_A = `endo.task.${"a".repeat(32)}`;
const TASK_B = `endo.task.${"b".repeat(32)}`;
const ATTEMPT_B = `endo.attempt.${"c".repeat(32)}`;
const RECEIPT_B = `endo.receipt.${"d".repeat(32)}`;
const ASSIGN_A = `endo.assignment.${"e".repeat(32)}`;

type ExternalTask = EndophasiaExternalStatusV0["projects"][number]["tasks"][number];

function externalView(
	tasks: ExternalTask[],
	overrides: Partial<{
		sources: EndophasiaExternalStatusV0["sources"];
		head: EndophasiaExternalStatusV0["projects"][number]["head"];
	}> = {},
): EndophasiaExternalStatusV0 {
	const counts: Record<string, number> = {
		"in-progress": 0,
		"awaiting-review": 0,
		completed: 0,
		open: 0,
		blocked: 0,
	};
	for (const t of tasks) counts[t.phase] = (counts[t.phase] ?? 0) + 1;
	return {
		schemaVersion: ENDO_COORDINATOR_STATUS_SCHEMA_V0,
		readAtMs: 1795767000000,
		sources: overrides.sources ?? {
			tasks: { state: "ready", freshness: "fresh" },
			attempts: { state: "ready", freshness: "fresh" },
			events: { state: "ready", freshness: "fresh" },
		},
		projects: [
			{
				project: PROJECT_ID,
				freshness: "fresh",
				head: overrides.head ?? "clean",
				counts,
				tasks,
			},
		],
		sessions: [],
		attention: [],
		findings: [],
	};
}

function extTask(
	taskId: string,
	phase: string,
	verification: Partial<ExternalTask["verification"]> & { state: string },
	gaps: string[] = [],
): ExternalTask {
	return {
		taskId,
		phase,
		verification: {
			state: verification.state,
			freshness: verification.freshness ?? "fresh",
			incomplete: verification.incomplete ?? false,
			results: verification.results ?? [],
			moreResults: verification.moreResults ?? 0,
		},
		gaps,
		association: "unknown",
		linkedSessions: 0,
	};
}

describe("COORDINATOR-GROUNDING-002 baseline deterministic reproductions", () => {
	it("reproduces W8 false-positive collision: no-checks task alongside not-current task", () => {
		const view = externalView([
			extTask(TASK_A, "in-progress", { state: "no-checks", freshness: "unavailable", incomplete: false }, [
				"no-check-recorded",
			]),
			extTask(
				TASK_B,
				"awaiting-review",
				{
					state: "not-current",
					freshness: "stale",
					incomplete: false,
					results: [{ outcome: "failed", relation: "head-differs" }],
				},
				["checks-not-current", "earlier-failure-not-current"],
			),
		]);
		// Factually accurate statement about Task A (following the prompt's own "no check is recorded for this task" rule)
		const accurateAnswer = `For ${TASK_A}, no check is recorded for this task. For ${TASK_B}, an earlier failing receipt is recorded at a prior commit (not-current).`;
		expect(coordinatorAnswerRefusalV0(accurateAnswer, view)).toBe("receipt-absence-unestablished");
	});

	it("reproduces W9/W10 false-positive collision: no-checks task alongside unplanned PASS (incomplete: true)", () => {
		const view = externalView([
			extTask(TASK_A, "in-progress", { state: "no-checks", freshness: "unavailable", incomplete: false }, [
				"no-check-recorded",
			]),
			extTask(
				TASK_B,
				"awaiting-review",
				{
					state: "incomplete",
					freshness: "incomplete",
					incomplete: true,
					results: [{ outcome: "passed", relation: "at-head" }],
				},
				["receipt-history-unverifiable"],
			),
		]);
		const accurateAnswer = `For ${TASK_A}, no check is recorded for this task. For ${TASK_B}, one unplanned passing receipt is recorded at current HEAD, though verification remains incomplete.`;
		expect(coordinatorAnswerRefusalV0(accurateAnswer, view)).toBe("receipt-absence-unestablished");
	});

	it("reproduces verification-positive-contradiction false-positive: passing Task A alongside failing Task B", () => {
		const view = externalView([
			extTask(TASK_A, "awaiting-review", {
				state: "incomplete",
				freshness: "incomplete",
				incomplete: true,
				results: [{ outcome: "passed", relation: "at-head" }],
			}),
			extTask(TASK_B, "awaiting-review", {
				state: "failing",
				freshness: "fresh",
				incomplete: false,
				results: [{ outcome: "failed", relation: "at-head" }],
			}),
		]);
		// Accurately distinguishes Task A's at-HEAD pass from Task B's at-HEAD failure
		const accurateAnswer = `For ${TASK_A}, checks passed at HEAD (unplanned, incomplete). For ${TASK_B}, verification is failing at current HEAD.`;
		expect(coordinatorAnswerRefusalV0(accurateAnswer, view)).toBe("verification-positive-contradiction");
	});

	it("preserves protective refusals for true factual errors (historical PASS + current FAIL, unavailable/not-read, missing events B-1)", () => {
		// 1. Historical PASS alongside current FAIL: claiming current verification is clean is a TRUE factual error
		const histPassCurrFail = externalView([
			extTask(TASK_A, "in-progress", {
				state: "not-current",
				freshness: "stale",
				results: [{ outcome: "passed", relation: "head-differs" }],
			}),
			extTask(TASK_B, "awaiting-review", {
				state: "failing",
				freshness: "fresh",
				results: [{ outcome: "failed", relation: "at-head" }],
			}),
		]);
		expect(coordinatorAnswerRefusalV0("Verification is clean and passing.", histPassCurrFail)).toBe(
			"verification-positive-contradiction",
		);

		// 2. Historical FAIL alongside current PASS: claiming no failures exist on file is false
		const histFailCurrPass = externalView([
			extTask(TASK_A, "awaiting-review", {
				state: "incomplete",
				incomplete: true,
				results: [
					{ outcome: "passed", relation: "at-head" },
					{ outcome: "failed", relation: "head-differs" },
				],
			}),
		]);
		expect(coordinatorAnswerRefusalV0("No failing receipts were found.", histFailCurrPass)).toBe(
			"receipt-absence-unestablished",
		);

		// 3. Unavailable / unread verification: claiming no checks exist is a TRUE factual error
		const unavailableAndCompleted = externalView([
			extTask(TASK_A, "open", { state: "unavailable", freshness: "unavailable", incomplete: true }),
			extTask(TASK_B, "completed", { state: "not-read", freshness: "unavailable", incomplete: true }),
		]);
		expect(coordinatorAnswerRefusalV0("No check is recorded for this task.", unavailableAndCompleted)).toBe(
			"receipt-absence-unestablished",
		);

		// 4. Phase B-1: missing event source -> claiming no session activity recorded MUST stay refused
		const missingEvents = externalView(
			[extTask(TASK_A, "open", { state: "unavailable", freshness: "unavailable", incomplete: true })],
			{
				sources: {
					tasks: { state: "ready", freshness: "fresh" },
					attempts: { state: "missing", freshness: "unavailable" },
					events: { state: "unavailable", freshness: "unavailable" },
				},
			},
		);
		expect(coordinatorAnswerRefusalV0("No session activity is recorded.", missingEvents)).toBe(
			"event-absence-unestablished",
		);
	});

	it("reproduces coordination invisibility: pinnedCoordinatorBriefStatusV0 omits active coordination from model view", () => {
		const status: EndoCoordinatorStatusV0 = {
			schemaVersion: ENDO_COORDINATOR_STATUS_SCHEMA_V0,
			readAtMs: 1795767000000,
			staleAfterMs: 600_000,
			authority: ENDO_COORDINATOR_AUTHORITY_V0,
			notEstablished: ENDO_COORDINATOR_NOT_ESTABLISHED_V0,
			scope: { requested: [PROJECT_ID], projects: [PROJECT_ID], unknown: [] },
			sources: {
				tasks: {
					state: "ready",
					freshness: { state: "fresh", observedAtMs: 1795767000000, ageMs: 0, reason: null },
					detail: null,
				},
				attempts: {
					state: "ready",
					freshness: { state: "fresh", observedAtMs: 1795767000000, ageMs: 0, reason: null },
					detail: null,
				},
				events: {
					state: "ready",
					freshness: { state: "fresh", observedAtMs: 1795767000000, ageMs: 0, reason: null },
					detail: null,
				},
			},
			projects: [
				{
					id: PROJECT_ID,
					name: "repro",
					source: "operator-declared",
					head: { commit: "a".repeat(40), clean: true },
					freshness: { state: "fresh", observedAtMs: 1795767000000, ageMs: 0, reason: null },
					counts: { "in-progress": 1, "awaiting-review": 0, completed: 0, open: 0, blocked: 0 },
					tasks: [
						{
							taskId: TASK_A,
							projectId: PROJECT_ID,
							title: "Assigned task",
							status: "in-progress",
							phase: "in-progress",
							statusSource: "operator-declared",
							updatedAtMs: 1795767000000,
							revision: 1,
							attempts: { count: 0, latest: null },
							verification: {
								state: "no-checks",
								basis: "controller-observed-host-check",
								receiptReadComplete: true,
								incomplete: false,
								freshness: { state: "unavailable", observedAtMs: null, ageMs: null, reason: "no check" },
								results: [],
								moreResults: 0,
							},
							gaps: [{ code: "no-check-recorded", text: "No verification receipt was found." }],
							sessions: [],
							association: "unknown",
						},
					],
				},
			],
			sessions: [],
			unlistedSessions: { unknownActive: 0, unknownRelationship: 0, outOfScope: 0 },
			attention: [],
			findings: [],
		};
		const coordination: EndoCoordinatorCoordinationV0 = {
			schemaVersion: ENDO_COORDINATOR_COORDINATION_SCHEMA_V0,
			readAtMs: 1795767000000,
			authority: ENDO_COORDINATION_PROJECTION_AUTHORITY_V0,
			basis: { liveness: "not-observed", consistency: "per-file-snapshot", attribution: "unsigned-local-record" },
			scope: { requested: [PROJECT_ID] },
			source: { state: "ready", reason: null, revision: 1 },
			projects: [
				{
					id: PROJECT_ID,
					assignments: [
						{
							assignmentId: ASSIGN_A,
							taskId: TASK_A,
							state: "active",
							revision: 1,
							participantId: "worker-1",
							role: "builder",
							intendedHarnessFamily: "pi",
							taskBinding: "current",
							session: null,
							workspace: {
								worktreePath: "/tmp/repro/project",
								registration: "project-path",
								accessIntent: "read-write-intended",
								sharedWorktreeAcknowledged: false,
							},
							hazard: "none",
							targetCandidate: null,
							attempts: [{ attemptId: ATTEMPT_B, link: "resolved", execution: "none-recorded" }],
							findings: [],
						},
					],
					dependencies: [],
					tasks: [{ taskId: TASK_A, readiness: "no-dependencies", currentCandidateId: null, candidates: [] }],
					conflicts: [],
					registeredWorktrees: [],
					reviews: [],
				},
			],
			gaps: [],
		};
		const pinned = pinnedCoordinatorBriefStatusV0("/tmp/repro/store", PROJECT_ID, { status, coordination });
		expect(pinned.ok).toBe(true);
		if (!pinned.ok) return;
		// Baseline v0 view carries zero coordination information: the model cannot see ASSIGN_A!
		expect(JSON.stringify(pinned.view)).not.toContain(ASSIGN_A);
		expect(JSON.stringify(pinned.view)).not.toContain("worker-1");
		expect("coordination" in pinned.view).toBe(false);
		expect(RECEIPT_B.length).toBeGreaterThan(0);
	});
});
