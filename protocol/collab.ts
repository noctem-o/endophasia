/**
 * Phase 11 — Collaboration (README "## Phase 11 — Collaboration"): the protocol-bound
 * records for the Buzz integration — experiments as rooms, candidate discussions,
 * evidence/receipt links, approval flows, repository/patch context, and human-in-the-loop
 * steering. Endophasia does not run a relay: Buzz is the external workspace where humans
 * and agents share rooms, and this module records what happened in one of its rooms as
 * evidence-shaped records in the endo.evidence.* namespace. A room anchors an experiment
 * (the experiment is the room's subject, not a ledger dependency — it seeds the ledger);
 * a discussion is a posted statement about one candidate, by a human or an agent, with its
 * evidence and receipt links; an approval request and its decision are a recorded review
 * gate; a patch is a recorded git event in the NIP-34 vocabulary Buzz ships ("Git events
 * (NIP-34: patches, repo announcements, status)"); a steering record is a steering request
 * issued from the room, reusing the closed steering action vocabulary of
 * `protocol/steering.ts`. The room report is a derived view, computed by
 * `collab/room-report.ts` and serialized for persistence and replay, not a ledger record.
 * No network, no relay, no signatures: a record here is a record, not a message.
 */

import type { EndoIdentifierKindV0 } from "./identity.ts";
import { isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import type { SteeringActionV0 } from "./steering.ts";

function isEndoIdentifier(value: unknown, kind: EndoIdentifierKindV0): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, kind);
}

/** A recorded text field: a non-empty string within the given length bound. Opaque by design. */
function isCollabTextV0(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/** A recorded non-negative integer: a finite, integral, non-negative number. */
function isNonNegativeIntV0(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/** A list of unique evidence-namespace identifiers. */
function isCollabIdListV0(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every((entry) => isEndoIdentifier(entry, "evidence"))) return false;
	return new Set(value).size === value.length;
}

/** The room visibility: open, or private (Buzz: "Name it, describe it, make it private"). */
export type EndoCollabRoomVisibilityV0 = "open" | "private";

/** The closed room visibilities. */
export const ENDO_COLLAB_ROOM_VISIBILITIES_V0 = [
	"open",
	"private",
] as const satisfies readonly EndoCollabRoomVisibilityV0[];

/** The identity kind of a room participant: a person, or a process (Buzz: "whether the author is a person or a process"). */
export type EndoCollabIdentityKindV0 = "human" | "agent";

/** The closed identity kinds. */
export const ENDO_COLLAB_IDENTITY_KINDS_V0 = ["human", "agent"] as const satisfies readonly EndoCollabIdentityKindV0[];

/** The recorded outcomes of a room approval decision. */
export type EndoCollabApprovalOutcomeV0 = "approved" | "rejected" | "changes-requested";

/** The closed approval outcomes. */
export const ENDO_COLLAB_APPROVAL_OUTCOMES_V0 = [
	"approved",
	"rejected",
	"changes-requested",
] as const satisfies readonly EndoCollabApprovalOutcomeV0[];

/**
 * The recorded status of a git patch: the NIP-34 status vocabulary (Buzz ships "Git events
 * (NIP-34: patches, repo announcements, status)").
 */
export type EndoCollabPatchStatusV0 = "open" | "merged" | "closed";

/** The closed git patch statuses. */
export const ENDO_COLLAB_PATCH_STATUSES_V0 = [
	"open",
	"merged",
	"closed",
] as const satisfies readonly EndoCollabPatchStatusV0[];

/**
 * A collaboration room: the anchor of one experiment's collaboration context. The room
 * records the experiment it is the room of, its name, and its visibility. A ledger record
 * in the endo.evidence.* namespace. The room names the experiment by identifier; it does
 * not reference it — the experiment is the ledger's seed, not a ledger entry.
 */
export interface EndoCollabRoomV0 {
	schemaVersion: "endo.collab-room.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The experiment this room is the room of. endo.experiment.* identifier. */
	experimentId: string;
	/** The room name, 1-256 characters. */
	title: string;
	/** The room description, when recorded, 1-4096 characters. */
	summary?: string;
	/** The room visibility. */
	visibility: EndoCollabRoomVisibilityV0;
}

const ENDO_COLLAB_ROOM_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"experimentId",
	"title",
	"summary",
	"visibility",
]);

/**
 * Validates a collaboration room record. Rejects unknown fields, an id outside the
 * endo.evidence.* namespace, an experiment id outside the endo.experiment.* namespace, an
 * over-long title or summary, and a visibility outside the closed two-way. Returns the
 * validated value unchanged, or null.
 */
export function validateEndoCollabRoomV0(value: unknown): EndoCollabRoomV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_ROOM_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-room.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.experimentId, "experiment")) return null;
	if (!isCollabTextV0(v.title, 256)) return null;
	if (v.summary !== undefined && !isCollabTextV0(v.summary, 4096)) return null;
	if (!(ENDO_COLLAB_ROOM_VISIBILITIES_V0 as readonly string[]).includes(v.visibility as string)) return null;
	return value as EndoCollabRoomV0;
}

/**
 * One discussion post in a room, about one candidate. A ledger record in the
 * endo.evidence.* namespace. The post records its author's identity kind — the room does
 * not distinguish a person and a process beyond the recorded kind — and its evidence and
 * receipt links: the record ids the post cites. The links are references, not
 * inclusions: a post that cites a record that was never appended is not appendable.
 */
export interface EndoCollabDiscussionV0 {
	schemaVersion: "endo.collab-discussion.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The room the post belongs to. endo.evidence.* identifier. */
	roomId: string;
	/** The candidate the post discusses. endo.candidate.* identifier. */
	candidateId: string;
	/** The author's identity kind. */
	authorKind: EndoCollabIdentityKindV0;
	/** The author's recorded name, 1-256 characters. Opaque. */
	author: string;
	/** The post body, 1-8192 characters. */
	body: string;
	/** The evidence records the post cites: unique endo.evidence.* identifiers. */
	evidenceRefs: string[];
	/** The receipt records the post cites: unique endo.evidence.* identifiers. */
	receiptRefs: string[];
}

const ENDO_COLLAB_DISCUSSION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"roomId",
	"candidateId",
	"authorKind",
	"author",
	"body",
	"evidenceRefs",
	"receiptRefs",
]);

/**
 * Validates a discussion post. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, a candidate id outside the endo.candidate.* namespace, an identity kind
 * outside the closed two-way, an over-long author or body, and evidence or receipt lists
 * that are not arrays of unique endo.evidence.* identifiers. Returns the validated value
 * unchanged, or null.
 */
export function validateEndoCollabDiscussionV0(value: unknown): EndoCollabDiscussionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_DISCUSSION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-discussion.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.roomId, "evidence")) return null;
	if (!isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (!(ENDO_COLLAB_IDENTITY_KINDS_V0 as readonly string[]).includes(v.authorKind as string)) return null;
	if (!isCollabTextV0(v.author, 256)) return null;
	if (!isCollabTextV0(v.body, 8192)) return null;
	if (!isCollabIdListV0(v.evidenceRefs)) return null;
	if (!isCollabIdListV0(v.receiptRefs)) return null;
	return value as EndoCollabDiscussionV0;
}

/**
 * One approval request in a room: the recorded ask that a candidate be approved, with its
 * rationale and the evidence the requester cites. A ledger record in the endo.evidence.*
 * namespace. A request is not a gate: it decides nothing until a decision (
 * EndoCollabApprovalDecisionV0) is recorded for it.
 */
export interface EndoCollabApprovalRequestV0 {
	schemaVersion: "endo.collab-approval-request.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The room the request belongs to. endo.evidence.* identifier. */
	roomId: string;
	/** The candidate the request asks to approve. endo.candidate.* identifier. */
	candidateId: string;
	/** The rationale for the request, 1-4096 characters. */
	rationale: string;
	/** The evidence records the request cites: unique endo.evidence.* identifiers. */
	evidenceRefs: string[];
}

const ENDO_COLLAB_APPROVAL_REQUEST_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"roomId",
	"candidateId",
	"rationale",
	"evidenceRefs",
]);

/**
 * Validates an approval request. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, a candidate id outside the endo.candidate.* namespace, an over-long
 * rationale, and an evidence list that is not an array of unique endo.evidence.*
 * identifiers. Returns the validated value unchanged, or null.
 */
export function validateEndoCollabApprovalRequestV0(value: unknown): EndoCollabApprovalRequestV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_APPROVAL_REQUEST_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-approval-request.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.roomId, "evidence")) return null;
	if (!isEndoIdentifier(v.candidateId, "candidate")) return null;
	if (!isCollabTextV0(v.rationale, 4096)) return null;
	if (!isCollabIdListV0(v.evidenceRefs)) return null;
	return value as EndoCollabApprovalRequestV0;
}

/**
 * One approval decision in a room: the recorded outcome of an approval request, by a
 * recorded decider, with its reason. A ledger record in the endo.evidence.* namespace. A
 * decision without a reason is not a decision: the reason is required, never optional.
 */
export interface EndoCollabApprovalDecisionV0 {
	schemaVersion: "endo.collab-approval-decision.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The request the decision settles. endo.evidence.* identifier. */
	requestId: string;
	/** The outcome. */
	outcome: EndoCollabApprovalOutcomeV0;
	/** The decider's identity kind. */
	deciderKind: EndoCollabIdentityKindV0;
	/** The decider's recorded name, 1-256 characters. Opaque. */
	decider: string;
	/** The reason for the outcome, 1-4096 characters. Required. */
	reason: string;
}

const ENDO_COLLAB_APPROVAL_DECISION_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"requestId",
	"outcome",
	"deciderKind",
	"decider",
	"reason",
]);

/**
 * Validates an approval decision. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, an outcome outside the closed three-way, an identity kind outside the closed
 * two-way, an over-long decider or reason, and a missing reason. Returns the validated
 * value unchanged, or null.
 */
export function validateEndoCollabApprovalDecisionV0(value: unknown): EndoCollabApprovalDecisionV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_APPROVAL_DECISION_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-approval-decision.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.requestId, "evidence")) return null;
	if (!(ENDO_COLLAB_APPROVAL_OUTCOMES_V0 as readonly string[]).includes(v.outcome as string)) return null;
	if (!(ENDO_COLLAB_IDENTITY_KINDS_V0 as readonly string[]).includes(v.deciderKind as string)) return null;
	if (!isCollabTextV0(v.decider, 256)) return null;
	if (!isCollabTextV0(v.reason, 4096)) return null;
	return value as EndoCollabApprovalDecisionV0;
}

/**
 * One recorded git patch event for a room: the repository, the branch, the patch
 * identifier, and the recorded status, in the NIP-34 vocabulary. A ledger record in the
 * endo.evidence.* namespace. A patch record is context, not a git operation: it records
 * what Buzz logged, it performs nothing.
 */
export interface EndoCollabPatchV0 {
	schemaVersion: "endo.collab-patch.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The room the patch context belongs to. endo.evidence.* identifier. */
	roomId: string;
	/** The repository the patch belongs to, 1-512 characters. Opaque. */
	repo: string;
	/** The branch the patch is against, 1-256 characters. */
	branch: string;
	/** The patch identifier as recorded by the workspace, 1-256 characters. Opaque. */
	patchId: string;
	/** The recorded status. */
	status: EndoCollabPatchStatusV0;
}

const ENDO_COLLAB_PATCH_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"id",
	"roomId",
	"repo",
	"branch",
	"patchId",
	"status",
]);

/**
 * Validates a patch record. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, over-long repo, branch, or patch identifiers, and a status outside the
 * closed three-way. Returns the validated value unchanged, or null.
 */
export function validateEndoCollabPatchV0(value: unknown): EndoCollabPatchV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_PATCH_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-patch.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.roomId, "evidence")) return null;
	if (!isCollabTextV0(v.repo, 512)) return null;
	if (!isCollabTextV0(v.branch, 256)) return null;
	if (!isCollabTextV0(v.patchId, 256)) return null;
	if (!(ENDO_COLLAB_PATCH_STATUSES_V0 as readonly string[]).includes(v.status as string)) return null;
	return value as EndoCollabPatchV0;
}

/**
 * One steering request issued from a room: the steering action and, for steer and queue,
 * its instruction. A ledger record in the endo.evidence.* namespace. The action reuses
 * the closed steering action vocabulary of `protocol/steering.ts` (steer / queue / stop);
 * the runtime's bounded receipt stays in the runtime's lane — the room records the
 * request, not the runtime's internal acknowledgment. The door: a stop carries no
 * instruction; a steer and a queue carry one.
 */
export interface EndoCollabSteeringV0 {
	schemaVersion: "endo.collab-steering.v0";
	/** endo.evidence.* identifier. */
	id: string;
	/** The room the request was issued from. endo.evidence.* identifier. */
	roomId: string;
	/** The steering action. */
	action: SteeringActionV0;
	/** The steering instruction, 1-4096 characters. Required for steer and queue, absent for stop. */
	instruction?: string;
}

const ENDO_COLLAB_STEERING_ALLOWED_KEYS_V0 = new Set(["schemaVersion", "id", "roomId", "action", "instruction"]);

/**
 * Validates a steering request. Rejects unknown fields, ids outside the endo.evidence.*
 * namespace, an action outside the closed three-way (steer / queue / stop), an over-long
 * instruction, and the action↔instruction door: a stop with an instruction, and a steer or
 * queue without one. Returns the validated value unchanged, or null.
 */
export function validateEndoCollabSteeringV0(value: unknown): EndoCollabSteeringV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_STEERING_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-steering.v0") return null;
	if (!isEndoIdentifier(v.id, "evidence")) return null;
	if (!isEndoIdentifier(v.roomId, "evidence")) return null;
	if (typeof v.action !== "string" || !["steer", "queue", "stop"].includes(v.action)) return null;
	if (v.action === "stop") {
		if (v.instruction !== undefined) return null;
	} else if (!isCollabTextV0(v.instruction, 4096)) {
		return null;
	}
	return value as EndoCollabSteeringV0;
}

/** One row of the room report: one discussed candidate and its post count. */
export interface EndoCollabRoomDiscussionRowV0 {
	/** endo.candidate.* identifier. */
	candidateId: string;
	/** The number of posts about the candidate: a non-negative integer. */
	count: number;
}

/** One row of the room report: one approval request and its recorded outcome, or null when undecided. */
export interface EndoCollabRoomApprovalRowV0 {
	/** endo.evidence.* identifier of the request. */
	requestId: string;
	/** The recorded outcome, or null when no decision has been recorded for the request. */
	outcome: null | EndoCollabApprovalOutcomeV0;
}

/** One row of the room report: one recorded patch and its status. */
export interface EndoCollabRoomPatchRowV0 {
	/** The patch identifier as recorded by the workspace. */
	patchId: string;
	/** The recorded status. */
	status: EndoCollabPatchStatusV0;
}

/**
 * The room report: the derived view of one room over its records — who discussed what,
 * what the room cites, where every approval stands, what the recorded patches say, and
 * how the room steered. A derived report, not a ledger record: it is computed by
 * `collab/room-report.ts` from the presented records and serialized for persistence and
 * replay. The rows carry unique keys; the service emits them in deterministic order
 * (candidate id, request id, patch id) and unique-sorted evidence references.
 */
export interface EndoCollabRoomReportV0 {
	schemaVersion: "endo.collab-room-report.v0";
	/** endo.evidence.* identifier of the room the report summarizes. */
	roomId: string;
	/** One row per discussed candidate, unique by candidate id. */
	discussions: EndoCollabRoomDiscussionRowV0[];
	/** Every evidence and receipt id cited in the room, unique. */
	evidenceRefs: string[];
	/** One row per approval request, unique by request id. */
	approvals: EndoCollabRoomApprovalRowV0[];
	/** One row per recorded patch id, unique by patch id. */
	patches: EndoCollabRoomPatchRowV0[];
	/** The steering counts by action. */
	steering: { steer: number; queue: number; stop: number };
}

const ENDO_COLLAB_ROOM_REPORT_ALLOWED_KEYS_V0 = new Set([
	"schemaVersion",
	"roomId",
	"discussions",
	"evidenceRefs",
	"approvals",
	"patches",
	"steering",
]);
const ENDO_COLLAB_ROOM_REPORT_STEERING_KEYS_V0 = new Set(["steer", "queue", "stop"]);

/**
 * Validates a room report. Rejects unknown fields, a room id outside the endo.evidence.*
 * namespace, rows with duplicate keys or invalid fields, an evidence list that is not an
 * array of unique endo.evidence.* identifiers, and steering counts that are not
 * non-negative integers. Returns the validated value unchanged, or null.
 */
export function validateEndoCollabRoomReportV0(value: unknown): EndoCollabRoomReportV0 | null {
	if (typeof value !== "object" || value === null || !isPlainJsonObjectV0(value)) return null;
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!ENDO_COLLAB_ROOM_REPORT_ALLOWED_KEYS_V0.has(key)) return null;
	if (v.schemaVersion !== "endo.collab-room-report.v0") return null;
	if (!isEndoIdentifier(v.roomId, "evidence")) return null;
	if (!Array.isArray(v.discussions)) return null;
	const seenCandidates = new Set<string>();
	for (const row of v.discussions) {
		if (typeof row !== "object" || row === null || !isPlainJsonObjectV0(row)) return null;
		const r = row as Record<string, unknown>;
		for (const key of Object.keys(r)) if (key !== "candidateId" && key !== "count") return null;
		if (!isEndoIdentifier(r.candidateId, "candidate")) return null;
		if (!isNonNegativeIntV0(r.count)) return null;
		if (seenCandidates.has(r.candidateId)) return null;
		seenCandidates.add(r.candidateId);
	}
	if (!isCollabIdListV0(v.evidenceRefs)) return null;
	if (!Array.isArray(v.approvals)) return null;
	const seenRequests = new Set<string>();
	for (const row of v.approvals) {
		if (typeof row !== "object" || row === null || !isPlainJsonObjectV0(row)) return null;
		const r = row as Record<string, unknown>;
		for (const key of Object.keys(r)) if (key !== "requestId" && key !== "outcome") return null;
		if (!isEndoIdentifier(r.requestId, "evidence")) return null;
		if (r.outcome !== null && !(ENDO_COLLAB_APPROVAL_OUTCOMES_V0 as readonly string[]).includes(r.outcome as string))
			return null;
		if (seenRequests.has(r.requestId)) return null;
		seenRequests.add(r.requestId);
	}
	if (!Array.isArray(v.patches)) return null;
	const seenPatches = new Set<string>();
	for (const row of v.patches) {
		if (typeof row !== "object" || row === null || !isPlainJsonObjectV0(row)) return null;
		const r = row as Record<string, unknown>;
		for (const key of Object.keys(r)) if (key !== "patchId" && key !== "status") return null;
		if (!isCollabTextV0(r.patchId, 256)) return null;
		if (!(ENDO_COLLAB_PATCH_STATUSES_V0 as readonly string[]).includes(r.status as string)) return null;
		if (seenPatches.has(r.patchId)) return null;
		seenPatches.add(r.patchId);
	}
	if (typeof v.steering !== "object" || v.steering === null || !isPlainJsonObjectV0(v.steering)) return null;
	const s = v.steering as Record<string, unknown>;
	for (const key of Object.keys(s)) if (!ENDO_COLLAB_ROOM_REPORT_STEERING_KEYS_V0.has(key)) return null;
	if (!isNonNegativeIntV0(s.steer) || !isNonNegativeIntV0(s.queue) || !isNonNegativeIntV0(s.stop)) return null;
	return value as EndoCollabRoomReportV0;
}
