#!/usr/bin/env node
/**
 * S2-LIVE-002 Stage 1 — Deterministic Offline Replay
 *
 * Replays original S2-LIVE-001 captured responses (exact verbatim replay against legacy-v0)
 * alongside explicitly labelled equivalent `endo.coordinator-grounded-brief.v1` typed claims
 * constructed from the exact same captured S2-LIVE-001 deterministic status & coordination snapshots.
 *
 * Isolates validation behavior from model-generation variability (zero live model contact).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coordinatorAnswerRefusalV0 } from "../../../../adapters/coordinator/status.ts";
import { externalEndophasiaStatusV0 } from "../../../../integrations/openclaw-endophasia-status/src/status-reader.ts";
import { ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1 } from "../../../../protocol/coordinator-grounding.ts";
import {
	buildEndoCoordinatorModelViewV1,
	endoCoordinatorModelViewSha256V1,
	validateAndRenderGroundedBriefV1,
} from "../../../../runtime/contracts/coordinator-grounding.ts";

const S2_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S1_DIR = resolve(S2_DIR, "../s2-live-001");
const OUT_DIR = join(S2_DIR, "observations");
mkdirSync(OUT_DIR, { recursive: true });

function loadJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function toExternal(status, projectId) {
	return externalEndophasiaStatusV0(status, {
		endo: { node: process.execPath, entry: "" },
		storeRoot: "/replay/store",
		projects: [{ id: projectId, root: "/replay/project" }],
	});
}

function runReplay() {
	const results = [];

	// 1. Phase B-1 (partial store, missing events/attempts -> protective event-absence-unestablished)
	{
		const st = loadJson(join(S1_DIR, "evidence/phase-b-smoke/deterministic-status-before.json")).coordinatorStatus;
		const pid = st.projects[0].id;
		const tid = st.projects[0].tasks[0].taskId;
		const ext = toExternal(st, pid);
		const mvB = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: null, visibilityMode: "status-v0" });
		const shaB = endoCoordinatorModelViewSha256V1(mvB);

		// Equivalent typed claim mirroring the unsupported event-absence claim from B-1 (MUST STILL REFUSE!)
		const badEquiv = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: [
				{ subjectKind: "task", subjectId: tid, predicate: "task-phase", value: "open", evidenceRef: `ev:task:${tid}` },
				{ subjectKind: "sources", subjectId: pid, predicate: "session-activity", value: "none-linked", evidenceRef: "ev:sources" },
			],
			uncertainties: [],
			recommendations: [],
			proposal: null,
		});
		// Calibrated typed claim acknowledging unavailable event source (MUST PASS!)
		const calibratedEquiv = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: [
				{ subjectKind: "task", subjectId: tid, predicate: "task-phase", value: "open", evidenceRef: `ev:task:${tid}` },
				{ subjectKind: "task", subjectId: tid, predicate: "verification-state", value: "unavailable", evidenceRef: `ev:task:${tid}` },
				{ subjectKind: "sources", subjectId: pid, predicate: "session-activity", value: "unknown-source-unavailable", evidenceRef: "ev:sources" },
			],
			uncertainties: [
				{ subjectKind: "sources", subjectId: pid, code: "event-source-unavailable", evidenceRef: "ev:sources" },
				{ subjectKind: "sources", subjectId: pid, code: "attempt-source-unavailable", evidenceRef: "ev:sources" },
			],
			recommendations: [
				{
					kind: "inspect-missing-sources",
					subjectKind: "sources",
					subjectId: pid,
					supportingRefs: ["ev:sources"],
					priority: "medium",
					rationaleCode: "store-sources-incomplete",
				},
			],
			proposal: null,
		});

		results.push({
			scenario: "B-1-partial-store",
			fixtureKind: "manually-transformed-equivalent-claims",
			legacyObservedOutcome: "briefing-refused (event-absence-unestablished)",
			groundedV1UnsupportedClaim: validateAndRenderGroundedBriefV1({ rawText: badEquiv, modelView: mvB, modelViewSha256: shaB, includeProposalLine: false }),
			groundedV1CalibratedClaim: (() => {
				const r = validateAndRenderGroundedBriefV1({ rawText: calibratedEquiv, modelView: mvB, modelViewSha256: shaB, includeProposalLine: false });
				return { ok: r.ok, reason: r.ok ? null : r.reason, verifiedClaimCount: r.ok ? r.summary.verifiedClaimCount : 0 };
			})(),
		});
	}

	// 2. Phase C Run 2 W0 (open task, no active assignment -> ungrounded proposal in v0, explicit eligibility in v1-coord)
	{
		const st = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W0-initial-status.json")).coordinatorStatus;
		const co = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W0-initial-coordination.json")).coordinatorCoordination;
		const pid = st.projects[0].id;
		const tid = st.projects[0].tasks[0].taskId;
		const ext = toExternal(st, pid);
		const mvC = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: co, visibilityMode: "status-and-coordination-v1" });
		const obsW0 = readFileSync(join(S1_DIR, "observations/phase-c-controlled.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find((r) => r.window === "W0-initial" && r.briefing);

		results.push({
			scenario: "W0-initial-unassigned",
			fixtureKind: "exact-replay-plus-visibility-comparison",
			legacyExactReplayRefusal: coordinatorAnswerRefusalV0(obsW0.briefing.answer, ext),
			legacyProposalOutcome: obsW0.briefing.proposal,
			conditionCModelVisibleCoordinationSource: mvC.coordination?.sourceState,
			conditionCProposalEligibilityForT1: mvC.proposalEligibility.find((e) => e.taskId === tid)?.eligibleKinds ?? [],
		});
	}

	// 3. Phase C Run 2 W6 (T2 awaiting review with FAIL at HEAD + T1 in-progress no-checks)
	{
		const st = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W6-verify-fail-status.json")).coordinatorStatus;
		const co = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W6-verify-fail-coordination.json")).coordinatorCoordination;
		const pid = st.projects[0].id;
		const tFail = st.projects[0].tasks.find((t) => t.verification.state === "failing");
		const tNoChecks = st.projects[0].tasks.find((t) => t.verification.state === "no-checks");
		const ext = toExternal(st, pid);
		const mvC = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: co, visibilityMode: "status-and-coordination-v1" });
		const shaC = endoCoordinatorModelViewSha256V1(mvC);
		const obsW6 = readFileSync(join(S1_DIR, "observations/phase-c-controlled.jsonl"), "utf8").trim().split("\n").map(JSON.parse).find((r) => r.window === "W6-verify-fail" && r.briefing);

		const equivW6 = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: [
				{ subjectKind: "task", subjectId: tFail.taskId, predicate: "task-phase", value: "awaiting-review", evidenceRef: `ev:task:${tFail.taskId}` },
				{ subjectKind: "task", subjectId: tFail.taskId, predicate: "current-head-check", value: "failing", evidenceRef: `ev:task:${tFail.taskId}` },
				{ subjectKind: "task", subjectId: tFail.taskId, predicate: "verification-contradiction", value: "review-failing", evidenceRef: `ev:task:${tFail.taskId}` },
				{ subjectKind: "task", subjectId: tNoChecks.taskId, predicate: "verification-state", value: "no-checks", evidenceRef: `ev:task:${tNoChecks.taskId}` },
			],
			uncertainties: [
				{ subjectKind: "task", subjectId: tNoChecks.taskId, code: "verification-not-established", evidenceRef: `ev:task:${tNoChecks.taskId}` },
			],
			recommendations: [
				{
					kind: "review-failing-verification",
					subjectKind: "task",
					subjectId: tFail.taskId,
					supportingRefs: [`ev:task:${tFail.taskId}`],
					priority: "high",
					rationaleCode: "review-contradicts-failing-check",
				},
			],
			proposal: { kind: "review-failing-verification", taskId: tFail.taskId, evidenceRef: `ev:task:${tFail.taskId}` },
		});
		const vW6 = validateAndRenderGroundedBriefV1({ rawText: equivW6, modelView: mvC, modelViewSha256: shaC, includeProposalLine: true });
		results.push({
			scenario: "W6-verify-fail",
			fixtureKind: "exact-replay-and-equivalent-claims",
			legacyExactReplayRefusal: coordinatorAnswerRefusalV0(obsW6.briefing.answer, ext),
			groundedV1Outcome: { ok: vW6.ok, reason: vW6.ok ? null : vW6.reason, proposal: vW6.ok ? vW6.brief.proposal : null },
		});
	}

	// 4. Phase C Run 2 W8 (T1 no-checks + active assignment; T2 not-current historical FAIL) — ORIGINAL COLLISION #1
	{
		const st = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W8-coord-and-head-status.json")).coordinatorStatus;
		const co = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W8-coord-and-head-coordination.json")).coordinatorCoordination;
		const pid = st.projects[0].id;
		const tNoChecks = st.projects[0].tasks.find((t) => t.verification.state === "no-checks");
		const tNotCurrent = st.projects[0].tasks.find((t) => t.verification.state === "not-current");
		const assign = co.projects[0].assignments[0];
		const ext = toExternal(st, pid);
		const mvB = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: null, visibilityMode: "status-v0" });
		const mvC = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: co, visibilityMode: "status-and-coordination-v1" });

		// Legacy regex on accurate multi-task prose
		const accurateW8Prose = `For ${tNoChecks.taskId}, no check is recorded for this task. For ${tNotCurrent.taskId}, an earlier check failed at a prior HEAD (not-current).`;
		const legacyRefusal = coordinatorAnswerRefusalV0(accurateW8Prose, ext);

		const equivW8B = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: [
				{ subjectKind: "task", subjectId: tNoChecks.taskId, predicate: "verification-state", value: "no-checks", evidenceRef: `ev:task:${tNoChecks.taskId}` },
				{ subjectKind: "task", subjectId: tNoChecks.taskId, predicate: "current-head-check", value: "none-recorded", evidenceRef: `ev:task:${tNoChecks.taskId}` },
				{ subjectKind: "task", subjectId: tNotCurrent.taskId, predicate: "verification-state", value: "not-current", evidenceRef: `ev:task:${tNotCurrent.taskId}` },
				{ subjectKind: "task", subjectId: tNotCurrent.taskId, predicate: "historical-check", value: "failing-not-current", evidenceRef: `ev:task:${tNotCurrent.taskId}` },
			],
			uncertainties: [
				{ subjectKind: "task", subjectId: tNotCurrent.taskId, code: "verification-not-current", evidenceRef: `ev:task:${tNotCurrent.taskId}` },
			],
			recommendations: [
				{
					kind: "investigate-incomplete-verification",
					subjectKind: "task",
					subjectId: tNotCurrent.taskId,
					supportingRefs: [`ev:task:${tNotCurrent.taskId}`],
					priority: "high",
					rationaleCode: "historical-failure-not-current",
				},
			],
			proposal: { kind: "investigate-incomplete-verification", taskId: tNotCurrent.taskId, evidenceRef: `ev:task:${tNotCurrent.taskId}` },
		});
		const equivW8C = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: [
				...JSON.parse(equivW8B).claims,
				{ subjectKind: "assignment", subjectId: assign.assignmentId, predicate: "assignment-state", value: "active", evidenceRef: `ev:assignment:${assign.assignmentId}` },
				{ subjectKind: "assignment", subjectId: assign.assignmentId, predicate: "assignment-role", value: assign.role, evidenceRef: `ev:assignment:${assign.assignmentId}` },
			],
			uncertainties: JSON.parse(equivW8B).uncertainties,
			recommendations: JSON.parse(equivW8B).recommendations,
			proposal: JSON.parse(equivW8B).proposal,
		});

		const vB = validateAndRenderGroundedBriefV1({ rawText: equivW8B, modelView: mvB, modelViewSha256: endoCoordinatorModelViewSha256V1(mvB), includeProposalLine: true });
		const vC = validateAndRenderGroundedBriefV1({ rawText: equivW8C, modelView: mvC, modelViewSha256: endoCoordinatorModelViewSha256V1(mvC), includeProposalLine: true });
		// Also verify C's assignment claim CANNOT validate under B's status-only snapshot!
		const vCunderB = validateAndRenderGroundedBriefV1({ rawText: equivW8C, modelView: mvB, modelViewSha256: endoCoordinatorModelViewSha256V1(mvB), includeProposalLine: true });

		results.push({
			scenario: "W8-coord-and-head",
			fixtureKind: "manually-transformed-equivalent-claims",
			originalLiveOutcome: "briefing-refused (receipt-absence-unestablished)",
			legacyRegexOnAccurateProse: legacyRefusal,
			conditionBOutcome: { ok: vB.ok, reason: vB.ok ? null : vB.reason, claims: vB.ok ? vB.summary.verifiedClaimCount : 0 },
			conditionCOutcome: { ok: vC.ok, reason: vC.ok ? null : vC.reason, claims: vC.ok ? vC.summary.verifiedClaimCount : 0 },
			conditionCClaimUnderConditionBRefused: { ok: vCunderB.ok, reason: vCunderB.ok ? null : vCunderB.reason },
		});
	}

	// 5. Phase C Run 2 W9/W10 (T1 no-checks + active assignment; T2 unplanned PASS incomplete: true) — ORIGINAL COLLISIONS #2 & #3
	{
		const st = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W9-verify-pass-status.json")).coordinatorStatus;
		const co = loadJson(join(S1_DIR, "evidence/phase-c-controlled/baseline-W9-verify-pass-coordination.json")).coordinatorCoordination;
		const pid = st.projects[0].id;
		const tNoChecks = st.projects[0].tasks.find((t) => t.verification.state === "no-checks");
		const tIncomplete = st.projects[0].tasks.find((t) => t.verification.state === "incomplete");
		const assign = co.projects[0].assignments[0];
		const ext = toExternal(st, pid);
		const mvB = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: null, visibilityMode: "status-v0" });
		const mvC = buildEndoCoordinatorModelViewV1({ projectId: pid, statusView: ext, coordination: co, visibilityMode: "status-and-coordination-v1" });

		const accurateW9Prose = `For ${tNoChecks.taskId}, no check is recorded for this task. For ${tIncomplete.taskId}, an unplanned passing check is recorded at current HEAD, though verification remains incomplete.`;
		const legacyRefusal = coordinatorAnswerRefusalV0(accurateW9Prose, ext);

		const equivW9C = JSON.stringify({
			schemaVersion: ENDO_COORDINATOR_GROUNDED_BRIEF_SCHEMA_V1,
			claims: [
				{ subjectKind: "task", subjectId: tNoChecks.taskId, predicate: "verification-state", value: "no-checks", evidenceRef: `ev:task:${tNoChecks.taskId}` },
				{ subjectKind: "task", subjectId: tNoChecks.taskId, predicate: "current-head-check", value: "none-recorded", evidenceRef: `ev:task:${tNoChecks.taskId}` },
				{ subjectKind: "task", subjectId: tIncomplete.taskId, predicate: "verification-state", value: "incomplete", evidenceRef: `ev:task:${tIncomplete.taskId}` },
				{ subjectKind: "task", subjectId: tIncomplete.taskId, predicate: "current-head-check", value: "passing-incomplete", evidenceRef: `ev:task:${tIncomplete.taskId}` },
				{ subjectKind: "assignment", subjectId: assign.assignmentId, predicate: "assignment-state", value: "active", evidenceRef: `ev:assignment:${assign.assignmentId}` },
			],
			uncertainties: [
				{ subjectKind: "task", subjectId: tIncomplete.taskId, code: "verification-incomplete", evidenceRef: `ev:task:${tIncomplete.taskId}` },
			],
			recommendations: [
				{
					kind: "review-awaiting-review",
					subjectKind: "task",
					subjectId: tIncomplete.taskId,
					supportingRefs: [`ev:task:${tIncomplete.taskId}`],
					priority: "medium",
					rationaleCode: "unplanned-pass-incomplete-verification",
				},
			],
			proposal: { kind: "review-awaiting-review", taskId: tIncomplete.taskId, evidenceRef: `ev:task:${tIncomplete.taskId}` },
		});

		const vC = validateAndRenderGroundedBriefV1({ rawText: equivW9C, modelView: mvC, modelViewSha256: endoCoordinatorModelViewSha256V1(mvC), includeProposalLine: true });
		results.push({
			scenario: "W9-W10-unplanned-pass-and-no-checks",
			fixtureKind: "manually-transformed-equivalent-claims",
			originalLiveOutcome: "briefing-refused (receipt-absence-unestablished) on both W9 and W10",
			legacyRegexOnAccurateProse: legacyRefusal,
			conditionCOutcome: { ok: vC.ok, reason: vC.ok ? null : vC.reason, claims: vC.ok ? vC.summary.verifiedClaimCount : 0 },
		});
	}

	writeFileSync(join(OUT_DIR, "stage1-offline-replay.json"), `${JSON.stringify({ recordedAtUtc: new Date().toISOString(), liveInferenceExecuted: false, results }, null, 2)}\n`);
	console.log(JSON.stringify(results, null, 2));
}

runReplay();
