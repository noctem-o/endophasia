// Harness-neutral DEVELOP attempt authorization, pre-transport abort, and controller-observed outcome records
// (`<root>/develop/adapter-authorizations/<attemptId>.{authorized,aborted,outcome}.json`).
//
// Design invariants (docs/designs/coordinator-assignment.md §6.2–§6.3, E2-A/E2-B):
// - Strictly write-once via storage/write-once.ts (`link(2)`), keeping `<root>/develop/attempts/` closed and untouched.
// - Shares ONE store-root-wide attempt-route reservation domain (`<root>/develop/attempt-routes/<attemptId>.route.json`)
//   with Pi workbench (`workbench`) and protected attempts (`protected`).
// - Binds authorization to the exact attempt, assignmentId + assignmentRevision (when linked), taskRevision, harness
//   identity, source-qualified sessionKey, attachmentId, launchId, instanceId, runtimeFingerprintId, worktreePath,
//   briefSha256, and proposalDigest.
// - Codex remains Strict-only: `mechanism: "session-grant"` is strictly restricted to `pi-live` on `pi-workbench-broker`.
// - `accepted` records ONLY runtime acknowledgement (`consequenceObserved: false`), never completion or verification.
// - Protocol imports only protocol.

import { ENDO_ADAPTER_AUTHORITY_MECHANISMS_V0, type EndoAdapterAuthorityMechanismV0 } from "./develop-adapter.ts";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "./develop-attempts.ts";
import {
	ENDO_ASSIGNMENT_ID_PATTERN_V0,
	ENDO_COORDINATION_SESSION_SOURCES_V0,
	type EndoCoordinationSessionSourceV0,
	isEndoCanonicalPathV0,
} from "./develop-coordination.ts";
import { ENDO_LAUNCH_ID_PATTERN_V0, ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import { isWellFormedKindV0 } from "./identity.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_DEVELOP_ADAPTER_AUTHORIZATION_SCHEMA_V0 = "endo.develop-adapter-authorization.v0";
export const ENDO_DEVELOP_ADAPTER_ABORT_SCHEMA_V0 = "endo.develop-adapter-abort.v0";
export const ENDO_DEVELOP_ADAPTER_OUTCOME_SCHEMA_V0 = "endo.develop-adapter-outcome.v0";

export const ENDO_ADAPTER_AUTHORIZATION_VIAS_V0 = ["controlling-terminal", "workbench-terminal"] as const;
export type EndoAdapterAuthorizationViaV0 = (typeof ENDO_ADAPTER_AUTHORIZATION_VIAS_V0)[number];

export const ENDO_ADAPTER_ABORT_OBSERVED_STATES_V0 = [
	"revoked",
	"superseded",
	"closed",
	"revision-changed",
	"missing",
	"unreadable",
] as const;
export type EndoAdapterAbortObservedStateV0 = (typeof ENDO_ADAPTER_ABORT_OBSERVED_STATES_V0)[number];

export const ENDO_ADAPTER_OUTCOME_STATUSES_V0 = ["accepted", "refused", "unknown"] as const;
export type EndoAdapterOutcomeStatusV0 = (typeof ENDO_ADAPTER_OUTCOME_STATUSES_V0)[number];

/** Write-once harness-neutral attempt authorization (`<attemptId>.authorized.json`). */
export interface EndoDevelopAdapterAuthorizationV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADAPTER_AUTHORIZATION_SCHEMA_V0;
	attemptId: string;
	authorizationId: string;
	recordedAtMs: number;
	projectId: string;
	taskId: string;
	taskRevision: number;
	assignmentId: string | null;
	assignmentRevision: number | null;
	briefSha256: string;
	proposalDigest: string;
	harnessFamily: "pi" | "codex";
	source: EndoCoordinationSessionSourceV0;
	controlPath: "pi-workbench-broker" | "codex-live-controller";
	sessionKey: string;
	attachmentId: string;
	launchId: string;
	instanceId: string;
	runtimeFingerprintId: string;
	worktreePath: string;
	mechanism: EndoAdapterAuthorityMechanismV0;
	sessionGrantId: string | null;
	approvedBy: "operator";
	via: EndoAdapterAuthorizationViaV0;
}

/** Write-once pre-transport abort marker (`<attemptId>.aborted.json`). Leaves `.route.json` permanently burned. */
export interface EndoDevelopAdapterAbortV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADAPTER_ABORT_SCHEMA_V0;
	attemptId: string;
	authorizationId: string;
	recordedAtMs: number;
	reason: "dispatch-aborted-post-reservation";
	assignmentId: string | null;
	observedAssignmentState: EndoAdapterAbortObservedStateV0;
	recordedBy: "controller";
}

/** Write-once controller-observed dispatch/outcome evidence (`<attemptId>.outcome.json`). */
export interface EndoDevelopAdapterOutcomeV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADAPTER_OUTCOME_SCHEMA_V0;
	attemptId: string;
	authorizationId: string;
	recordedAtMs: number;
	harnessFamily: "pi" | "codex";
	source: EndoCoordinationSessionSourceV0;
	sessionKey: string;
	instanceId: string;
	status: EndoAdapterOutcomeStatusV0;
	disposition: string | null;
	turnId: string | null;
	receiptId: string | null;
	refusalCode: string | null;
	reason: string | null;
	consequenceObserved: false;
	recordedBy: "controller";
}

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[\x21-\x7e]{1,256}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/;

function closed(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(value, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const k of keys) if (!Object.hasOwn(value, k)) return bad(`${what} lacks ${k}`);
	return value as Record<string, unknown>;
}

const match = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);

const int = (v: unknown, min: number, max: number, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : bad(`${what} is out of range`);

const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not allowed`);

const nullableMatch = (v: unknown, pattern: RegExp, what: string): string | null =>
	v === null ? null : match(v, pattern, what);

export function validateEndoDevelopAdapterAuthorizationV0(value: unknown): EndoDevelopAdapterAuthorizationV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"attemptId",
			"authorizationId",
			"recordedAtMs",
			"projectId",
			"taskId",
			"taskRevision",
			"assignmentId",
			"assignmentRevision",
			"briefSha256",
			"proposalDigest",
			"harnessFamily",
			"source",
			"controlPath",
			"sessionKey",
			"attachmentId",
			"launchId",
			"instanceId",
			"runtimeFingerprintId",
			"worktreePath",
			"mechanism",
			"sessionGrantId",
			"approvedBy",
			"via",
		],
		"adapter authorization",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_ADAPTER_AUTHORIZATION_SCHEMA_V0) bad("schemaVersion");
	const harnessFamily = oneOf(r.harnessFamily, ["pi", "codex"] as const, "harnessFamily");
	const source = oneOf(r.source, ENDO_COORDINATION_SESSION_SOURCES_V0, "source");
	const controlPath = oneOf(r.controlPath, ["pi-workbench-broker", "codex-live-controller"] as const, "controlPath");
	if (
		(harnessFamily === "pi" && (source !== "pi-live" || controlPath !== "pi-workbench-broker")) ||
		(harnessFamily === "codex" && (source !== "codex-live" || controlPath !== "codex-live-controller"))
	)
		bad("harnessFamily, source, and controlPath disagree");

	const sessionKey = match(r.sessionKey, SAFE_TOKEN, "sessionKey");
	if (!sessionKey.startsWith(`${source}:`)) bad("sessionKey does not match source");
	if (typeof r.attachmentId !== "string" || !isWellFormedKindV0(r.attachmentId)) return bad("attachmentId");
	if (!isEndoCanonicalPathV0(r.worktreePath)) return bad("worktreePath");
	const attachmentId: string = r.attachmentId;
	const worktreePath: string = r.worktreePath;

	const assignmentId = nullableMatch(r.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, "assignmentId");
	const assignmentRevision =
		r.assignmentRevision === null
			? null
			: int(r.assignmentRevision, 1, Number.MAX_SAFE_INTEGER, "assignmentRevision");
	if ((assignmentId === null) !== (assignmentRevision === null))
		bad("assignmentId and assignmentRevision must be present together");

	const mechanism = oneOf(r.mechanism, ENDO_ADAPTER_AUTHORITY_MECHANISMS_V0, "mechanism");
	const sessionGrantId = nullableMatch(r.sessionGrantId, SAFE_TOKEN, "sessionGrantId");
	if (mechanism === "session-grant") {
		// Codex remains Strict-only; Pi Everyday eligibility must not broaden.
		if (harnessFamily !== "pi" || source !== "pi-live" || controlPath !== "pi-workbench-broker")
			bad("session-grant is restricted to pi-live on pi-workbench-broker");
		if (sessionGrantId === null) bad("session-grant requires sessionGrantId");
	} else if (sessionGrantId !== null) {
		bad("non-grant mechanism must not carry sessionGrantId");
	}

	if (r.approvedBy !== "operator") bad("approvedBy must be operator");
	const via = oneOf(r.via, ENDO_ADAPTER_AUTHORIZATION_VIAS_V0, "via");

	return {
		schemaVersion: ENDO_DEVELOP_ADAPTER_AUTHORIZATION_SCHEMA_V0,
		attemptId: match(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		authorizationId: match(r.authorizationId, SAFE_TOKEN, "authorizationId"),
		recordedAtMs: int(r.recordedAtMs, 0, 8.64e15, "recordedAtMs"),
		projectId: match(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		taskId: match(r.taskId, ENDO_TASK_ID_PATTERN_V0, "taskId"),
		taskRevision: int(r.taskRevision, 0, Number.MAX_SAFE_INTEGER, "taskRevision"),
		assignmentId,
		assignmentRevision,
		briefSha256: match(r.briefSha256, HEX64, "briefSha256"),
		proposalDigest: match(r.proposalDigest, HEX64, "proposalDigest"),
		harnessFamily,
		source,
		controlPath,
		sessionKey,
		attachmentId,
		launchId: match(r.launchId, ENDO_LAUNCH_ID_PATTERN_V0, "launchId"),
		instanceId: match(r.instanceId, SAFE_TOKEN, "instanceId"),
		runtimeFingerprintId: match(r.runtimeFingerprintId, SAFE_TOKEN, "runtimeFingerprintId"),
		worktreePath,
		mechanism,
		sessionGrantId,
		approvedBy: "operator",
		via,
	};
}

export function validateEndoDevelopAdapterAbortV0(value: unknown): EndoDevelopAdapterAbortV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"attemptId",
			"authorizationId",
			"recordedAtMs",
			"reason",
			"assignmentId",
			"observedAssignmentState",
			"recordedBy",
		],
		"adapter abort record",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_ADAPTER_ABORT_SCHEMA_V0) bad("schemaVersion");
	if (r.reason !== "dispatch-aborted-post-reservation") bad("reason");
	if (r.recordedBy !== "controller") bad("recordedBy");
	return {
		schemaVersion: ENDO_DEVELOP_ADAPTER_ABORT_SCHEMA_V0,
		attemptId: match(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		authorizationId: match(r.authorizationId, SAFE_TOKEN, "authorizationId"),
		recordedAtMs: int(r.recordedAtMs, 0, 8.64e15, "recordedAtMs"),
		reason: "dispatch-aborted-post-reservation",
		assignmentId: nullableMatch(r.assignmentId, ENDO_ASSIGNMENT_ID_PATTERN_V0, "assignmentId"),
		observedAssignmentState: oneOf(
			r.observedAssignmentState,
			ENDO_ADAPTER_ABORT_OBSERVED_STATES_V0,
			"observedAssignmentState",
		),
		recordedBy: "controller",
	};
}

export function validateEndoDevelopAdapterOutcomeV0(value: unknown): EndoDevelopAdapterOutcomeV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"attemptId",
			"authorizationId",
			"recordedAtMs",
			"harnessFamily",
			"source",
			"sessionKey",
			"instanceId",
			"status",
			"disposition",
			"turnId",
			"receiptId",
			"refusalCode",
			"reason",
			"consequenceObserved",
			"recordedBy",
		],
		"adapter outcome record",
	);
	if (r.schemaVersion !== ENDO_DEVELOP_ADAPTER_OUTCOME_SCHEMA_V0) bad("schemaVersion");
	const harnessFamily = oneOf(r.harnessFamily, ["pi", "codex"] as const, "harnessFamily");
	const source = oneOf(r.source, ENDO_COORDINATION_SESSION_SOURCES_V0, "source");
	if ((harnessFamily === "pi" && source !== "pi-live") || (harnessFamily === "codex" && source !== "codex-live"))
		bad("harnessFamily and source disagree");
	const sessionKey = match(r.sessionKey, SAFE_TOKEN, "sessionKey");
	if (!sessionKey.startsWith(`${source}:`)) bad("sessionKey does not match source");
	if (r.consequenceObserved !== false) bad("consequenceObserved must be false");
	if (r.recordedBy !== "controller") bad("recordedBy");
	const status = oneOf(r.status, ENDO_ADAPTER_OUTCOME_STATUSES_V0, "status");
	return {
		schemaVersion: ENDO_DEVELOP_ADAPTER_OUTCOME_SCHEMA_V0,
		attemptId: match(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		authorizationId: match(r.authorizationId, SAFE_TOKEN, "authorizationId"),
		recordedAtMs: int(r.recordedAtMs, 0, 8.64e15, "recordedAtMs"),
		harnessFamily,
		source,
		sessionKey,
		instanceId: match(r.instanceId, SAFE_TOKEN, "instanceId"),
		status,
		disposition: nullableMatch(r.disposition, SAFE_TOKEN, "disposition"),
		turnId: nullableMatch(r.turnId, SAFE_TOKEN, "turnId"),
		receiptId: nullableMatch(r.receiptId, SAFE_TOKEN, "receiptId"),
		refusalCode: nullableMatch(r.refusalCode, SAFE_TOKEN, "refusalCode"),
		reason: nullableMatch(r.reason, SAFE_TEXT, "reason"),
		consequenceObserved: false,
		recordedBy: "controller",
	};
}
