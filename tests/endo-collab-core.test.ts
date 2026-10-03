import { describe, expect, it } from "vitest";
import { summarizeCollabRoomV0 } from "../collab/room-report.ts";
import { createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import { validateEndoCollabRoomReportV0 } from "../protocol/collab.ts";
import type { EndoExperimentRecordV0 } from "../protocol/evolution.ts";

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

function discussion(
	id: string,
	candidateId: string,
	refs: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-discussion.v0",
		id,
		roomId: "endo.evidence.room-1",
		candidateId,
		authorKind: "human",
		author: "ada",
		body: "the candidate held the invariant",
		evidenceRefs: [],
		receiptRefs: [],
		...refs,
		...overrides,
	};
}

function approvalRequest(
	id: string,
	candidateId: string,
	refs: string[] = [],
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-approval-request.v0",
		id,
		roomId: "endo.evidence.room-1",
		candidateId,
		rationale: "the suite passes",
		evidenceRefs: refs,
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

function patch(
	id: string,
	patchId: string,
	status: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-patch.v0",
		id,
		roomId: "endo.evidence.room-1",
		repo: "github.com/noctem-o/endophasia",
		branch: "phase-11-collaboration",
		patchId,
		status,
		...overrides,
	};
}

function steering(id: string, action: string, instruction?: string): Record<string, unknown> {
	return {
		schemaVersion: "endo.collab-steering.v0",
		id,
		roomId: "endo.evidence.room-1",
		action,
		...(instruction === undefined ? {} : { instruction }),
	};
}

function records(): Record<string, unknown>[] {
	return [
		discussion("endo.evidence.disc-a", "endo.candidate.c-1", {
			evidenceRefs: ["endo.evidence.ev-1"],
			receiptRefs: ["endo.evidence.rct-1"],
		}),
		discussion("endo.evidence.disc-b", "endo.candidate.c-2", { evidenceRefs: ["endo.evidence.ev-2"] }),
		discussion("endo.evidence.disc-c", "endo.candidate.c-1"),
		approvalRequest("endo.evidence.apprq-a", "endo.candidate.c-1", ["endo.evidence.ev-1"]),
		approvalRequest("endo.evidence.apprq-b", "endo.candidate.c-2"),
		approvalDecision("endo.evidence.apprd-a", "endo.evidence.apprq-a"),
		patch("endo.evidence.patch-b", "p-b", "open"),
		patch("endo.evidence.patch-a", "p-a", "merged"),
		steering("endo.evidence.steer-1", "steer", "focus on the ledger"),
		steering("endo.evidence.steer-2", "queue", "next: the room report"),
		steering("endo.evidence.steer-3", "stop"),
	];
}

describe("summarizeCollabRoomV0", () => {
	it("reports an empty room as empty", () => {
		expect(summarizeCollabRoomV0(room(), [])).toEqual({
			schemaVersion: "endo.collab-room-report.v0",
			roomId: "endo.evidence.room-1",
			discussions: [],
			evidenceRefs: [],
			approvals: [],
			patches: [],
			steering: { steer: 0, queue: 0, stop: 0 },
		});
	});

	it("groups discussions by candidate in candidate-id order", () => {
		const report = summarizeCollabRoomV0(room(), records());
		expect(report.discussions).toEqual([
			{ candidateId: "endo.candidate.c-1", count: 2 },
			{ candidateId: "endo.candidate.c-2", count: 1 },
		]);
	});

	it("unions and sorts the cited evidence and receipt references", () => {
		const report = summarizeCollabRoomV0(room(), records());
		expect(report.evidenceRefs).toEqual(["endo.evidence.ev-1", "endo.evidence.ev-2", "endo.evidence.rct-1"]);
	});

	it("carries one approval row per request, decided and undecided", () => {
		const report = summarizeCollabRoomV0(room(), records());
		expect(report.approvals).toEqual([
			{ requestId: "endo.evidence.apprq-a", outcome: "approved" },
			{ requestId: "endo.evidence.apprq-b", outcome: null },
		]);
	});

	it("carries patch rows in patch-id order", () => {
		const report = summarizeCollabRoomV0(room(), records());
		expect(report.patches).toEqual([
			{ patchId: "p-a", status: "merged" },
			{ patchId: "p-b", status: "open" },
		]);
	});

	it("counts steering by action", () => {
		const report = summarizeCollabRoomV0(room(), records());
		expect(report.steering).toEqual({ steer: 1, queue: 1, stop: 1 });
	});

	it("exits through the protocol door", () => {
		const report = summarizeCollabRoomV0(room(), records());
		expect(validateEndoCollabRoomReportV0(report)).not.toBeNull();
	});

	it("refuses a room that is not a valid room", () => {
		expect(() => summarizeCollabRoomV0(room({ visibility: "public" }), [])).toThrow(
			"not a valid endo.collab-room.v0 room",
		);
	});

	it("refuses records that are not an array", () => {
		expect(() => summarizeCollabRoomV0(room(), null as unknown as unknown[])).toThrow("records must be an array");
	});

	it("refuses a room record in the list and an unknown record shape", () => {
		expect(() => summarizeCollabRoomV0(room(), [room()])).toThrow("not a valid collab room record");
		expect(() =>
			summarizeCollabRoomV0(room(), [{ schemaVersion: "endo.model-profile.v0", id: "endo.model.gpt-x" }]),
		).toThrow("not a valid collab room record");
	});

	it("refuses a record presented twice", () => {
		const post = discussion("endo.evidence.disc-a", "endo.candidate.c-1");
		expect(() => summarizeCollabRoomV0(room(), [post, { ...post }])).toThrow(
			"record endo.evidence.disc-a is presented twice",
		);
	});

	it("refuses a record from a different room", () => {
		const post = discussion("endo.evidence.disc-a", "endo.candidate.c-1", {}, { roomId: "endo.evidence.room-2" });
		expect(() => summarizeCollabRoomV0(room(), [post])).toThrow("record endo.evidence.disc-a names a different room");
	});

	it("refuses a decision that cites a request not in the room", () => {
		expect(() =>
			summarizeCollabRoomV0(room(), [approvalDecision("endo.evidence.apprd-a", "endo.evidence.apprq-z")]),
		).toThrow("decision endo.evidence.apprd-a cites request endo.evidence.apprq-z, which is not in the room");
	});

	it("refuses two decisions for one request", () => {
		const first = approvalDecision("endo.evidence.apprd-a", "endo.evidence.apprq-a");
		const second = approvalDecision("endo.evidence.apprd-b", "endo.evidence.apprq-a", { outcome: "rejected" });
		expect(() =>
			summarizeCollabRoomV0(room(), [approvalRequest("endo.evidence.apprq-a", "endo.candidate.c-1"), first, second]),
		).toThrow("request endo.evidence.apprq-a has multiple decisions presented");
	});

	it("refuses a patch id recorded twice", () => {
		expect(() =>
			summarizeCollabRoomV0(room(), [
				patch("endo.evidence.patch-a", "p-a", "open"),
				patch("endo.evidence.patch-b", "p-a", "merged"),
			]),
		).toThrow("patch p-a is recorded twice");
	});

	it("summarizes the records a real ledger appended in causal order", () => {
		const experiment: EndoExperimentRecordV0 = {
			schemaVersion: "endo.experiment.v0",
			id: "endo.experiment.exp-1",
			evaluator: "eval-1",
			grader: "grade-1",
		};
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experiment);
		const candidate = { schemaVersion: "endo.candidate.v0", id: "endo.candidate.c-1", mutations: [] as string[] };
		const roomRecord = room();
		const artifact = {
			schemaVersion: "endo.artifact.v0",
			id: "endo.evidence.ev-1",
			kind: "suite",
			digest: "a".repeat(64),
		};
		const post = discussion("endo.evidence.disc-a", "endo.candidate.c-1", { evidenceRefs: ["endo.evidence.ev-1"] });
		const request = approvalRequest("endo.evidence.apprq-a", "endo.candidate.c-1", ["endo.evidence.ev-1"]);
		const decision = approvalDecision("endo.evidence.apprd-a", "endo.evidence.apprq-a");
		const patchRecord = patch("endo.evidence.patch-a", "p-a", "merged");
		const stop = steering("endo.evidence.steer-1", "stop");
		const roomRecords: Record<string, unknown>[] = [post, request, decision, patchRecord, stop];
		ledger.append(candidate);
		ledger.append(roomRecord);
		ledger.append(artifact);
		for (const record of roomRecords) ledger.append(record);
		const persisted = ledger.ledger();
		expect(persisted.entries).toHaveLength(8);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
		expect(summarizeCollabRoomV0(roomRecord, roomRecords)).toEqual({
			schemaVersion: "endo.collab-room-report.v0",
			roomId: "endo.evidence.room-1",
			discussions: [{ candidateId: "endo.candidate.c-1", count: 1 }],
			evidenceRefs: ["endo.evidence.ev-1"],
			approvals: [{ requestId: "endo.evidence.apprq-a", outcome: "approved" }],
			patches: [{ patchId: "p-a", status: "merged" }],
			steering: { steer: 0, queue: 0, stop: 1 },
		});
	});
});
