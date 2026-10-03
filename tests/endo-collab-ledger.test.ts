import { describe, expect, it } from "vitest";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import type { EndoExperimentRecordV0 } from "../protocol/evolution.ts";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
}

function candidate(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { schemaVersion: "endo.candidate.v0", id, mutations: [], ...overrides };
}

function room(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-room.v0",
		id,
		experimentId: "endo.experiment.exp-1",
		title: "exp-1 room",
		visibility: "open",
		...overrides,
	};
}

function artifact(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { schemaVersion: "endo.artifact.v0", id, kind: "suite", digest: "a".repeat(64), ...overrides };
}

function discussion(
	id: string,
	roomId: string,
	candidateId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-discussion.v0",
		id,
		roomId,
		candidateId,
		authorKind: "human",
		author: "ada",
		body: "the candidate held the invariant",
		evidenceRefs: [],
		receiptRefs: [],
		...overrides,
	};
}

function approvalRequest(
	id: string,
	roomId: string,
	candidateId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-approval-request.v0",
		id,
		roomId,
		candidateId,
		rationale: "the suite passes",
		evidenceRefs: [],
		...overrides,
	};
}

function approvalDecision(
	id: string,
	requestId: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-approval-decision.v0",
		id,
		requestId,
		outcome: "approved",
		deciderKind: "human",
		decider: "ada",
		reason: "reviewed the diff",
		...overrides,
	};
}

function patch(id: string, roomId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-patch.v0",
		id,
		roomId,
		repo: "github.com/noctem-o/endophasia",
		branch: "phase-11-collaboration",
		patchId: "patch-1",
		status: "open",
		...overrides,
	};
}

function steering(id: string, roomId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-steering.v0",
		id,
		roomId,
		action: "stop",
		...overrides,
	};
}

function ledger(): ReturnType<typeof createEndoEvidenceLedgerV0> {
	return createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
}

describe("the collab records in the evidence ledger", () => {
	it("derives the collab-room kind and keeps the record id as its identity", () => {
		const l = ledger();
		const entry = l.append(room("endo.evidence.room-1"));
		expect(entry.sequence).toBe(1);
		expect(entry.kind).toBe("collab-room");
		expect(entry.recordId).toBe("endo.evidence.room-1");
	});

	it("rejects a discussion whose room is not yet appended", () => {
		const l = ledger();
		l.append(candidate("endo.candidate.c-1"));
		expect(() => l.append(discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1"))).toThrow(
			TypeError,
		);
	});

	it("rejects a discussion whose candidate is not yet appended", () => {
		const l = ledger();
		l.append(room("endo.evidence.room-1"));
		expect(() => l.append(discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1"))).toThrow(
			TypeError,
		);
	});

	it("rejects a discussion that cites evidence or receipts not yet appended", () => {
		const l = ledger();
		l.append(candidate("endo.candidate.c-1"));
		l.append(room("endo.evidence.room-1"));
		expect(() =>
			l.append(
				discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1", {
					evidenceRefs: ["endo.evidence.ev-9"],
				}),
			),
		).toThrow(TypeError);
		expect(() =>
			l.append(
				discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1", {
					receiptRefs: ["endo.evidence.rct-9"],
				}),
			),
		).toThrow(TypeError);
	});

	it("rejects an approval decision whose request is not yet appended", () => {
		const l = ledger();
		expect(() => l.append(approvalDecision("endo.evidence.apprd-1", "endo.evidence.apprq-1"))).toThrow(TypeError);
	});

	it("rejects a patch or steering record whose room is not yet appended", () => {
		const l = ledger();
		expect(() => l.append(patch("endo.evidence.patch-1", "endo.evidence.room-1"))).toThrow(TypeError);
		expect(() => l.append(steering("endo.evidence.steer-1", "endo.evidence.room-1"))).toThrow(TypeError);
	});

	it("rejects a record whose identity is already in the ledger", () => {
		const l = ledger();
		l.append(candidate("endo.candidate.c-1"));
		l.append(room("endo.evidence.room-1"));
		l.append(discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1"));
		expect(() => l.append(discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1"))).toThrow(
			TypeError,
		);
	});

	it("replays a ledger carrying the collab chain", () => {
		const l = ledger();
		const candidateEntry = l.append(candidate("endo.candidate.c-1"));
		const roomEntry = l.append(room("endo.evidence.room-1"));
		const artifactEntry = l.append(artifact("endo.evidence.ev-1"));
		const discussionEntry = l.append(
			discussion("endo.evidence.disc-1", "endo.evidence.room-1", "endo.candidate.c-1", {
				evidenceRefs: ["endo.evidence.ev-1"],
			}),
		);
		const requestEntry = l.append(
			approvalRequest("endo.evidence.apprq-1", "endo.evidence.room-1", "endo.candidate.c-1", {
				evidenceRefs: ["endo.evidence.ev-1"],
			}),
		);
		const decisionEntry = l.append(approvalDecision("endo.evidence.apprd-1", "endo.evidence.apprq-1"));
		const patchEntry = l.append(patch("endo.evidence.patch-1", "endo.evidence.room-1"));
		const steeringEntry = l.append(
			steering("endo.evidence.steer-1", "endo.evidence.room-1", {
				action: "steer",
				instruction: "focus on the ledger",
			}),
		);
		expect(
			[
				candidateEntry,
				roomEntry,
				artifactEntry,
				discussionEntry,
				requestEntry,
				decisionEntry,
				patchEntry,
				steeringEntry,
			].map((entry) => entry.kind),
		).toEqual([
			"candidate",
			"collab-room",
			"artifact",
			"collab-discussion",
			"collab-approval-request",
			"collab-approval-decision",
			"collab-patch",
			"collab-steering",
		]);
		const persisted = l.ledger();
		expect(persisted.entries).toHaveLength(8);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
	});
});
