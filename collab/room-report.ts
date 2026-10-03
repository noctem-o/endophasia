/**
 * Phase 11 — Collaboration (README "## Phase 11 — Collaboration"): the room report, the
 * derived view of one room over its records — who discussed what, what the room cites,
 * where every approval stands, what the recorded patches say, and how the room steered.
 * No network, no relay: the report is computed from the presented records and serialized
 * for persistence and replay. The service takes `unknown` at its doors (the house boundary
 * pattern) and exits through the protocol validator of the report it returns.
 */

import type {
	EndoCollabApprovalDecisionV0,
	EndoCollabApprovalRequestV0,
	EndoCollabDiscussionV0,
	EndoCollabPatchV0,
	EndoCollabRoomApprovalRowV0,
	EndoCollabRoomDiscussionRowV0,
	EndoCollabRoomPatchRowV0,
	EndoCollabRoomReportV0,
	EndoCollabSteeringV0,
} from "../protocol/collab.ts";
import {
	validateEndoCollabApprovalDecisionV0,
	validateEndoCollabApprovalRequestV0,
	validateEndoCollabDiscussionV0,
	validateEndoCollabPatchV0,
	validateEndoCollabRoomReportV0,
	validateEndoCollabRoomV0,
	validateEndoCollabSteeringV0,
} from "../protocol/collab.ts";

/** A room record: one of the five record shapes a room report summarizes. */
type CollabRoomRecordV0 =
	| EndoCollabDiscussionV0
	| EndoCollabApprovalRequestV0
	| EndoCollabApprovalDecisionV0
	| EndoCollabPatchV0
	| EndoCollabSteeringV0;

function validateRoomRecordV0(value: unknown): CollabRoomRecordV0 | null {
	return (
		validateEndoCollabDiscussionV0(value) ??
		validateEndoCollabApprovalRequestV0(value) ??
		validateEndoCollabApprovalDecisionV0(value) ??
		validateEndoCollabPatchV0(value) ??
		validateEndoCollabSteeringV0(value)
	);
}

function byKeyV0<T>(rows: T[], key: (row: T) => string): T[] {
	return [...rows].sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

/**
 * The room report for one room over its presented records. The doors: a valid room; an
 * array of records, each one of the five room-record shapes (a room record in the list, or
 * an unknown shape, is not a room record); unique record ids; every record in the same
 * room; a decision that cites only a presented request; at most one decision per request
 * (two decisions for one request are ambiguous, and the report refuses rather than picks
 * one); unique patch ids. The report groups discussions by candidate, unions and sorts
 * every cited evidence and receipt reference, carries one row per approval request (the
 * outcome, or null when undecided), one row per patch id, and the steering counts by
 * action. Rows are emitted in deterministic order (candidate id, request id, patch id).
 * Throws TypeError when a door fails.
 */
export function summarizeCollabRoomV0(room: unknown, records: unknown[]): EndoCollabRoomReportV0 {
	const validatedRoom = validateEndoCollabRoomV0(room);
	if (validatedRoom === null) throw new TypeError("not a valid endo.collab-room.v0 room");
	if (!Array.isArray(records)) throw new TypeError("records must be an array of collab room records");
	const seen = new Set<string>();
	const discussions: EndoCollabDiscussionV0[] = [];
	const requests: EndoCollabApprovalRequestV0[] = [];
	const decisions = new Map<string, EndoCollabApprovalDecisionV0>();
	const patches: EndoCollabPatchV0[] = [];
	let steer = 0;
	let queue = 0;
	let stop = 0;
	for (const entry of records) {
		const record = validateRoomRecordV0(entry);
		if (record === null) throw new TypeError("not a valid collab room record");
		if (seen.has(record.id)) throw new TypeError(`record ${record.id} is presented twice`);
		seen.add(record.id);
		if (record.schemaVersion !== "endo.collab-approval-decision.v0" && record.roomId !== validatedRoom.id) {
			throw new TypeError(`record ${record.id} names a different room`);
		}

		switch (record.schemaVersion) {
			case "endo.collab-discussion.v0":
				discussions.push(record);
				break;
			case "endo.collab-approval-request.v0":
				requests.push(record);
				break;
			case "endo.collab-approval-decision.v0": {
				const existing = decisions.get(record.requestId);
				if (existing !== undefined)
					throw new TypeError(`request ${record.requestId} has multiple decisions presented`);
				decisions.set(record.requestId, record);
				break;
			}
			case "endo.collab-patch.v0":
				if (patches.some((row) => row.patchId === record.patchId)) {
					throw new TypeError(`patch ${record.patchId} is recorded twice`);
				}
				patches.push(record);
				break;
			case "endo.collab-steering.v0":
				if (record.action === "steer") steer += 1;
				else if (record.action === "queue") queue += 1;
				else stop += 1;
				break;
		}
	}
	for (const [requestId, decision] of decisions) {
		if (!requests.some((row) => row.id === requestId)) {
			throw new TypeError(`decision ${decision.id} cites request ${requestId}, which is not in the room`);
		}
	}
	const counts = new Map<string, number>();
	for (const discussion of discussions) {
		counts.set(discussion.candidateId, (counts.get(discussion.candidateId) ?? 0) + 1);
	}
	const discussionRows: EndoCollabRoomDiscussionRowV0[] = byKeyV0(
		[...counts.entries()],
		([candidateId]) => candidateId,
	).map(([candidateId, count]) => ({ candidateId, count }));
	const evidenceRefs: string[] = [
		...new Set([
			...discussions.flatMap((d) => [...d.evidenceRefs, ...d.receiptRefs]),
			...requests.flatMap((r) => r.evidenceRefs),
		]),
	].sort();
	const approvalRows: EndoCollabRoomApprovalRowV0[] = byKeyV0(requests, (request) => request.id).map((request) => ({
		requestId: request.id,
		outcome: decisions.get(request.id)?.outcome ?? null,
	}));
	const patchRows: EndoCollabRoomPatchRowV0[] = byKeyV0(patches, (patch) => patch.patchId).map((patch) => ({
		patchId: patch.patchId,
		status: patch.status,
	}));
	const report: EndoCollabRoomReportV0 = {
		schemaVersion: "endo.collab-room-report.v0",
		roomId: validatedRoom.id,
		discussions: discussionRows,
		evidenceRefs,
		approvals: approvalRows,
		patches: patchRows,
		steering: { steer, queue, stop },
	};
	const validatedReport = validateEndoCollabRoomReportV0(report);
	if (validatedReport === null) throw new TypeError("the room report failed the protocol door");
	return validatedReport;
}
