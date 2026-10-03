import { describe, expect, it } from "vitest";
import {
	ENDO_COLLAB_APPROVAL_OUTCOMES_V0,
	ENDO_COLLAB_IDENTITY_KINDS_V0,
	ENDO_COLLAB_PATCH_STATUSES_V0,
	ENDO_COLLAB_ROOM_VISIBILITIES_V0,
	validateEndoCollabApprovalDecisionV0,
	validateEndoCollabApprovalRequestV0,
	validateEndoCollabDiscussionV0,
	validateEndoCollabPatchV0,
	validateEndoCollabRoomReportV0,
	validateEndoCollabRoomV0,
	validateEndoCollabSteeringV0,
} from "../protocol/collab.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

function room(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-room.v0",
		id: "endo.evidence.room-1",
		experimentId: "endo.experiment.exp-1",
		title: "exp-1 room",
		visibility: "open",
		...overrides,
	};
}

function discussion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-discussion.v0",
		id: "endo.evidence.disc-1",
		roomId: "endo.evidence.room-1",
		candidateId: "endo.candidate.c-1",
		authorKind: "human",
		author: "ada",
		body: "the candidate held the invariant",
		evidenceRefs: ["endo.evidence.ev-1"],
		receiptRefs: ["endo.evidence.rct-1"],
		...overrides,
	};
}

function approvalRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-approval-request.v0",
		id: "endo.evidence.apprq-1",
		roomId: "endo.evidence.room-1",
		candidateId: "endo.candidate.c-1",
		rationale: "the suite passes",
		evidenceRefs: ["endo.evidence.ev-1"],
		...overrides,
	};
}

function approvalDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-approval-decision.v0",
		id: "endo.evidence.apprd-1",
		requestId: "endo.evidence.apprq-1",
		outcome: "approved",
		deciderKind: "human",
		decider: "ada",
		reason: "reviewed the diff",
		...overrides,
	};
}

function patch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-patch.v0",
		id: "endo.evidence.patch-1",
		roomId: "endo.evidence.room-1",
		repo: "github.com/noctem-o/endophasia",
		branch: "phase-11-collaboration",
		patchId: "patch-1",
		status: "open",
		...overrides,
	};
}

function steering(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-steering.v0",
		id: "endo.evidence.steer-1",
		roomId: "endo.evidence.room-1",
		action: "steer",
		instruction: "focus on the ledger",
		...overrides,
	};
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-room-report.v0",
		roomId: "endo.evidence.room-1",
		discussions: [{ candidateId: "endo.candidate.c-1", count: 1 }],
		evidenceRefs: ["endo.evidence.ev-1", "endo.evidence.rct-1"],
		approvals: [{ requestId: "endo.evidence.apprq-1", outcome: "approved" }],
		patches: [{ patchId: "patch-1", status: "open" }],
		steering: { steer: 1, queue: 0, stop: 0 },
		...overrides,
	};
}

function roundTrips(value: Record<string, unknown>, validate: (entry: unknown) => unknown): void {
	const parsed = JSON.parse(canonicalEndoJsonV0(value));
	expect(validate(parsed)).not.toBeNull();
}

describe("the closed collab sets", () => {
	it("record the visibility, identity kind, outcome, and status vocabularies", () => {
		expect([...ENDO_COLLAB_ROOM_VISIBILITIES_V0]).toEqual(["open", "private"]);
		expect([...ENDO_COLLAB_IDENTITY_KINDS_V0]).toEqual(["human", "agent"]);
		expect([...ENDO_COLLAB_APPROVAL_OUTCOMES_V0]).toEqual(["approved", "rejected", "changes-requested"]);
		expect([...ENDO_COLLAB_PATCH_STATUSES_V0]).toEqual(["open", "merged", "closed"]);
	});
});

describe("the collab room record", () => {
	it("accepts an open room with a summary", () => {
		expect(validateEndoCollabRoomV0(room({ summary: "the experiment room" }))).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabRoomV0(room({ relay: "relay-1" }))).toBeNull();
	});

	it("requires the evidence namespace for the id and the experiment namespace for the experiment", () => {
		expect(validateEndoCollabRoomV0(room({ id: "endo.model.room-1" }))).toBeNull();
		expect(validateEndoCollabRoomV0(room({ experimentId: "endo.evidence.exp-1" }))).toBeNull();
	});

	it("requires a 1-256 character title and a 1-4096 character summary", () => {
		expect(validateEndoCollabRoomV0(room({ title: "" }))).toBeNull();
		expect(validateEndoCollabRoomV0(room({ title: "x".repeat(257) }))).toBeNull();
		expect(validateEndoCollabRoomV0(room({ title: "x".repeat(256) }))).not.toBeNull();
		expect(validateEndoCollabRoomV0(room({ summary: "x".repeat(4097) }))).toBeNull();
		expect(validateEndoCollabRoomV0(room({ summary: "x".repeat(4096) }))).not.toBeNull();
	});

	it("rejects a visibility outside the closed two-way", () => {
		expect(validateEndoCollabRoomV0(room({ visibility: "public" }))).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(room({ summary: "the experiment room" }), validateEndoCollabRoomV0);
	});
});

describe("the discussion record", () => {
	it("accepts a post with evidence and receipt links, and one with none", () => {
		expect(validateEndoCollabDiscussionV0(discussion())).not.toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ evidenceRefs: [], receiptRefs: [] }))).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabDiscussionV0(discussion({ reaction: "up" }))).toBeNull();
	});

	it("requires the evidence namespace for the id and room, and the candidate namespace for the candidate", () => {
		expect(validateEndoCollabDiscussionV0(discussion({ id: "endo.model.disc-1" }))).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ roomId: "endo.candidate.room-1" }))).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ candidateId: "endo.evidence.c-1" }))).toBeNull();
	});

	it("rejects an identity kind outside the closed two-way", () => {
		expect(validateEndoCollabDiscussionV0(discussion({ authorKind: "process" }))).toBeNull();
	});

	it("requires a 1-256 character author and a 1-8192 character body", () => {
		expect(validateEndoCollabDiscussionV0(discussion({ author: "" }))).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ author: "x".repeat(257) }))).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ body: "" }))).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ body: "x".repeat(8193) }))).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ body: "x".repeat(8192) }))).not.toBeNull();
	});

	it("requires evidence and receipt lists of unique endo.evidence.* identifiers", () => {
		expect(validateEndoCollabDiscussionV0(discussion({ evidenceRefs: "endo.evidence.ev-1" }))).toBeNull();
		expect(
			validateEndoCollabDiscussionV0(discussion({ evidenceRefs: ["endo.evidence.ev-1", "endo.evidence.ev-1"] })),
		).toBeNull();
		expect(validateEndoCollabDiscussionV0(discussion({ receiptRefs: ["endo.model.rct-1"] }))).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(discussion(), validateEndoCollabDiscussionV0);
	});
});

describe("the approval request record", () => {
	it("accepts a request with and without cited evidence", () => {
		expect(validateEndoCollabApprovalRequestV0(approvalRequest())).not.toBeNull();
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ evidenceRefs: [] }))).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ gate: "merge" }))).toBeNull();
	});

	it("requires the evidence namespace for the id and room, and the candidate namespace for the candidate", () => {
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ id: "endo.candidate.apprq-1" }))).toBeNull();
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ roomId: "endo.experiment.room-1" }))).toBeNull();
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ candidateId: "endo.evidence.c-1" }))).toBeNull();
	});

	it("requires a 1-4096 character rationale", () => {
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ rationale: "" }))).toBeNull();
		expect(validateEndoCollabApprovalRequestV0(approvalRequest({ rationale: "x".repeat(4097) }))).toBeNull();
	});

	it("requires an evidence list of unique endo.evidence.* identifiers", () => {
		expect(
			validateEndoCollabApprovalRequestV0(
				approvalRequest({ evidenceRefs: ["endo.evidence.ev-1", "endo.evidence.ev-1"] }),
			),
		).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(approvalRequest(), validateEndoCollabApprovalRequestV0);
	});
});

describe("the approval decision record", () => {
	it("accepts each closed outcome", () => {
		for (const outcome of ["approved", "rejected", "changes-requested"]) {
			expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ outcome }))).not.toBeNull();
		}
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ reaction: "up" }))).toBeNull();
	});

	it("requires the evidence namespace for the id and the request", () => {
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ id: "endo.model.apprd-1" }))).toBeNull();
		expect(
			validateEndoCollabApprovalDecisionV0(approvalDecision({ requestId: "endo.candidate.apprq-1" })),
		).toBeNull();
	});

	it("rejects an outcome outside the closed three-way", () => {
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ outcome: "merged" }))).toBeNull();
	});

	it("rejects a decider kind outside the closed two-way", () => {
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ deciderKind: "relay" }))).toBeNull();
	});

	it("requires a 1-256 character decider and a 1-4096 character reason, and a missing reason is not a decision", () => {
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ decider: "x".repeat(257) }))).toBeNull();
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ reason: "" }))).toBeNull();
		expect(validateEndoCollabApprovalDecisionV0(approvalDecision({ reason: "x".repeat(4097) }))).toBeNull();
		const { reason: _omitted, ...withoutReason } = approvalDecision();
		expect(validateEndoCollabApprovalDecisionV0(withoutReason)).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(approvalDecision(), validateEndoCollabApprovalDecisionV0);
	});
});

describe("the patch record", () => {
	it("accepts each closed status", () => {
		for (const status of ["open", "merged", "closed"]) {
			expect(validateEndoCollabPatchV0(patch({ status }))).not.toBeNull();
		}
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabPatchV0(patch({ ci: "passed" }))).toBeNull();
	});

	it("requires the evidence namespace for the id and the room", () => {
		expect(validateEndoCollabPatchV0(patch({ id: "endo.candidate.patch-1" }))).toBeNull();
		expect(validateEndoCollabPatchV0(patch({ roomId: "endo.experiment.room-1" }))).toBeNull();
	});

	it("requires 1-512 character repo, 1-256 character branch and patch id", () => {
		expect(validateEndoCollabPatchV0(patch({ repo: "x".repeat(513) }))).toBeNull();
		expect(validateEndoCollabPatchV0(patch({ repo: "x".repeat(512) }))).not.toBeNull();
		expect(validateEndoCollabPatchV0(patch({ branch: "" }))).toBeNull();
		expect(validateEndoCollabPatchV0(patch({ branch: "x".repeat(257) }))).toBeNull();
		expect(validateEndoCollabPatchV0(patch({ patchId: "x".repeat(257) }))).toBeNull();
	});

	it("rejects a status outside the closed three-way", () => {
		expect(validateEndoCollabPatchV0(patch({ status: "pending" }))).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(patch(), validateEndoCollabPatchV0);
	});
});

describe("the steering record", () => {
	it("accepts a steer and a queue with an instruction, and a stop without one", () => {
		expect(validateEndoCollabSteeringV0(steering())).not.toBeNull();
		expect(
			validateEndoCollabSteeringV0(steering({ action: "queue", instruction: "next: the room report" })),
		).not.toBeNull();
		expect(validateEndoCollabSteeringV0(steering({ action: "stop", instruction: undefined }))).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabSteeringV0(steering({ lane: "lane-1" }))).toBeNull();
	});

	it("requires the evidence namespace for the id and the room", () => {
		expect(validateEndoCollabSteeringV0(steering({ id: "endo.model.steer-1" }))).toBeNull();
		expect(validateEndoCollabSteeringV0(steering({ roomId: "endo.candidate.room-1" }))).toBeNull();
	});

	it("rejects an action outside the closed three-way", () => {
		expect(validateEndoCollabSteeringV0(steering({ action: "pause" }))).toBeNull();
	});

	it("enforces the action-instruction door", () => {
		expect(validateEndoCollabSteeringV0(steering({ action: "stop", instruction: "halt" }))).toBeNull();
		expect(validateEndoCollabSteeringV0(steering({ action: "steer", instruction: undefined }))).toBeNull();
	});

	it("requires a 1-4096 character instruction", () => {
		expect(validateEndoCollabSteeringV0(steering({ instruction: "x".repeat(4097) }))).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(steering(), validateEndoCollabSteeringV0);
		const { instruction: _omitted, ...stopRecord } = steering({ action: "stop" });
		roundTrips(stopRecord, validateEndoCollabSteeringV0);
	});
});

describe("the room report", () => {
	it("accepts a report, and an empty one", () => {
		expect(validateEndoCollabRoomReportV0(report())).not.toBeNull();
		expect(
			validateEndoCollabRoomReportV0(
				report({
					discussions: [],
					evidenceRefs: [],
					approvals: [],
					patches: [],
					steering: { steer: 0, queue: 0, stop: 0 },
				}),
			),
		).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCollabRoomReportV0(report({ members: 2 }))).toBeNull();
	});

	it("requires the evidence namespace for the room", () => {
		expect(validateEndoCollabRoomReportV0(report({ roomId: "endo.experiment.room-1" }))).toBeNull();
	});

	it("requires discussion rows with a candidate-namespace id, a non-negative count, and unique candidates", () => {
		expect(
			validateEndoCollabRoomReportV0(report({ discussions: [{ candidateId: "endo.evidence.c-1", count: 1 }] })),
		).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(report({ discussions: [{ candidateId: "endo.candidate.c-1", count: -1 }] })),
		).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(
				report({
					discussions: [
						{ candidateId: "endo.candidate.c-1", count: 1 },
						{ candidateId: "endo.candidate.c-1", count: 2 },
					],
				}),
			),
		).toBeNull();
	});

	it("requires an evidence list of unique endo.evidence.* identifiers", () => {
		expect(
			validateEndoCollabRoomReportV0(report({ evidenceRefs: ["endo.evidence.ev-1", "endo.evidence.ev-1"] })),
		).toBeNull();
		expect(validateEndoCollabRoomReportV0(report({ evidenceRefs: ["endo.model.ev-1"] }))).toBeNull();
	});

	it("requires approval rows with an evidence-namespace request, a closed outcome or null, and unique requests", () => {
		expect(
			validateEndoCollabRoomReportV0(
				report({ approvals: [{ requestId: "endo.candidate.apprq-1", outcome: null }] }),
			),
		).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(report({ approvals: [{ requestId: "endo.evidence.apprq-1", outcome: "up" }] })),
		).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(
				report({
					approvals: [
						{ requestId: "endo.evidence.apprq-1", outcome: null },
						{ requestId: "endo.evidence.apprq-1", outcome: "approved" },
					],
				}),
			),
		).toBeNull();
	});

	it("requires patch rows with a 1-256 character id, a closed status, and unique patch ids", () => {
		expect(
			validateEndoCollabRoomReportV0(report({ patches: [{ patchId: "x".repeat(257), status: "open" }] })),
		).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(report({ patches: [{ patchId: "patch-1", status: "pending" }] })),
		).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(
				report({
					patches: [
						{ patchId: "patch-1", status: "open" },
						{ patchId: "patch-1", status: "merged" },
					],
				}),
			),
		).toBeNull();
	});

	it("requires steering counts that are non-negative integers with no unknown keys", () => {
		expect(validateEndoCollabRoomReportV0(report({ steering: { steer: 0, queue: 0, stop: -1 } }))).toBeNull();
		expect(
			validateEndoCollabRoomReportV0(report({ steering: { steer: 0, queue: 0, stop: 0, pause: 0 } })),
		).toBeNull();
	});

	it("round-trips through the canonical form", () => {
		roundTrips(report(), validateEndoCollabRoomReportV0);
	});
});
