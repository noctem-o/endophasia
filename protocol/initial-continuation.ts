import {
	type EndoInitialChildExecutionAttemptV0,
	type EndoInitialChildExecutionPlanV0,
	isEndoInitialChildExecutionPlanV0,
} from "./initial-child-execution.ts";
import { type EndoKeyedDigestV0, isEndoKeyedDigestV0 } from "./keyed-digest-shape.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";

/** A new two-turn contract; this does not change endo.initial-child-execution.v0. */
export const ENDO_INITIAL_CONTINUATION_VERSION_V0 = "endo.initial-continuation.v0";
export const ENDO_INITIAL_CONTINUATION_MAX_BYTES_V0 = 64 * 1024;
export interface InitialContinuationPlanV0 {
	initial: EndoInitialChildExecutionPlanV0;
	continuationPromptCommitment: EndoKeyedDigestV0;
	sourceCapture: EndoKeyedDigestV0;
	replayCapture: EndoKeyedDigestV0;
	maxApprovalIdleMs: number;
	maxRpcOutputBytes: number;
	commitment: EndoKeyedDigestV0;
}
export interface InitialContinuationApprovalV0 {
	attemptId: string;
	planCommitment: EndoKeyedDigestV0;
	confirmedAt: string;
	method: "local-explicit";
}
export interface InitialContinuationBoundaryV0 {
	attemptId: string;
	planCommitment: EndoKeyedDigestV0;
	sessionId: string;
	pid: number;
	provider: string;
	model: string;
	toolPolicy: "none";
	continuationPromptCommitment: EndoKeyedDigestV0;
	adaptedArchive: EndoKeyedDigestV0;
	boundaryArchive: EndoKeyedDigestV0;
	firstRequestEventId: string;
	firstRequestDigest: EndoKeyedDigestV0;
	firstResponseDigest: EndoKeyedDigestV0;
	firstTrajectoryIdentity: string;
	capturePrefixCount: number;
	capturePrefixCommitment: EndoKeyedDigestV0;
	storePrefixCount: number;
	storePrefixCommitment: EndoKeyedDigestV0;
	observedAt: string;
	deadlineAt: string;
	approvalDeadlineAt: string;
	remainingTransferredBytes: number;
	remainingRpcOutputBytes: number;
	commitment: EndoKeyedDigestV0;
}
export interface ContinuationTurnApprovalV0 {
	attemptId: string;
	boundaryCommitment: EndoKeyedDigestV0;
	confirmedAt: string;
	method: "local-explicit";
}
export interface InitialContinuationDispatchV0 {
	turn: 1 | 2;
	attemptId: string;
	planCommitment: EndoKeyedDigestV0;
	sessionId: string;
	adaptedArchive: EndoKeyedDigestV0;
	boundaryCommitment: EndoKeyedDigestV0 | null;
	approvalCommitment: EndoKeyedDigestV0;
	at: string;
	commitment: EndoKeyedDigestV0;
}
export type InitialContinuationStatusV0 =
	| "approved-not-dispatched"
	| "initial-dispatched"
	| "awaiting-approval"
	| "first-completed-not-approved"
	| "continuation-approved-not-dispatched"
	| "continuation-dispatched"
	| "completed"
	| "completed-unverifiable"
	| "failed"
	| "cancelled"
	| "outcome-unknown";
export interface InitialContinuationReceiptV0 {
	schemaVersion: typeof ENDO_INITIAL_CONTINUATION_VERSION_V0;
	plan: InitialContinuationPlanV0;
	firstApproval: InitialContinuationApprovalV0;
	status: InitialContinuationStatusV0;
	runtime: EndoInitialChildExecutionAttemptV0["runtime"];
	dispatch1: InitialContinuationDispatchV0 | null;
	boundary: InitialContinuationBoundaryV0 | null;
	secondApproval: ContinuationTurnApprovalV0 | null;
	dispatch2: InitialContinuationDispatchV0 | null;
	observed: null | {
		requestEventIds: string[];
		requestDigests: EndoKeyedDigestV0[];
		responseDigests: EndoKeyedDigestV0[];
		trajectoryIdentity: string;
		captureGeneration: EndoKeyedDigestV0;
		storeGeneration: EndoKeyedDigestV0;
	};
	reason: string | null;
	commitment: EndoKeyedDigestV0;
}

const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
	isPlainJsonObjectV0(v) &&
	Object.keys(v as object).length === keys.length &&
	keys.every((key) => Object.hasOwn(v as object, key));
const str = (v: unknown, max = 4096) => typeof v === "string" && v.length > 0 && v.length <= max;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const integer = (v: unknown, min: number, max: number) =>
	Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const digests = (values: unknown[], domain: string) =>
	values.every((v) => isEndoKeyedDigestV0(v) && v.keyId === domain);

export function isInitialContinuationPlanV0(v: unknown): v is InitialContinuationPlanV0 {
	if (
		!exact(v, [
			"initial",
			"continuationPromptCommitment",
			"sourceCapture",
			"replayCapture",
			"maxApprovalIdleMs",
			"maxRpcOutputBytes",
			"commitment",
		]) ||
		!isEndoInitialChildExecutionPlanV0(v.initial)
	)
		return false;
	return (
		v.maxRpcOutputBytes === 2 * 1024 * 1024 &&
		integer(v.maxApprovalIdleMs, 1000, 60000) &&
		(v.maxApprovalIdleMs as number) <= v.initial.wallTimeoutMs &&
		digests(
			[v.continuationPromptCommitment, v.sourceCapture, v.replayCapture, v.commitment],
			v.initial.commitment.keyId,
		)
	);
}
export function isInitialContinuationApprovalV0(v: unknown, domain: string): v is InitialContinuationApprovalV0 {
	return (
		exact(v, ["attemptId", "planCommitment", "confirmedAt", "method"]) &&
		str(v.attemptId) &&
		date(v.confirmedAt) &&
		v.method === "local-explicit" &&
		digests([v.planCommitment], domain)
	);
}
export function isContinuationTurnApprovalV0(v: unknown, domain: string): v is ContinuationTurnApprovalV0 {
	return (
		exact(v, ["attemptId", "boundaryCommitment", "confirmedAt", "method"]) &&
		str(v.attemptId) &&
		date(v.confirmedAt) &&
		v.method === "local-explicit" &&
		digests([v.boundaryCommitment], domain)
	);
}
export function isInitialContinuationBoundaryV0(v: unknown, domain: string): v is InitialContinuationBoundaryV0 {
	if (
		!exact(v, [
			"attemptId",
			"planCommitment",
			"sessionId",
			"pid",
			"provider",
			"model",
			"toolPolicy",
			"continuationPromptCommitment",
			"adaptedArchive",
			"boundaryArchive",
			"firstRequestEventId",
			"firstRequestDigest",
			"firstResponseDigest",
			"firstTrajectoryIdentity",
			"capturePrefixCount",
			"capturePrefixCommitment",
			"storePrefixCount",
			"storePrefixCommitment",
			"observedAt",
			"deadlineAt",
			"approvalDeadlineAt",
			"remainingTransferredBytes",
			"remainingRpcOutputBytes",
			"commitment",
		])
	)
		return false;
	return (
		[v.attemptId, v.sessionId, v.provider, v.model, v.firstRequestEventId, v.firstTrajectoryIdentity].every((x) =>
			str(x),
		) &&
		integer(v.pid, 1, 2 ** 31 - 1) &&
		v.toolPolicy === "none" &&
		[v.observedAt, v.deadlineAt, v.approvalDeadlineAt].every(date) &&
		integer(v.capturePrefixCount, 1, 100000) &&
		integer(v.storePrefixCount, 1, 100000) &&
		integer(v.remainingTransferredBytes, 0, 16 * 1024 * 1024) &&
		integer(v.remainingRpcOutputBytes, 0, 2 * 1024 * 1024) &&
		digests(
			[
				v.planCommitment,
				v.continuationPromptCommitment,
				v.adaptedArchive,
				v.boundaryArchive,
				v.firstRequestDigest,
				v.firstResponseDigest,
				v.capturePrefixCommitment,
				v.storePrefixCommitment,
				v.commitment,
			],
			domain,
		)
	);
}
export function isInitialContinuationDispatchV0(v: unknown, domain: string): v is InitialContinuationDispatchV0 {
	return (
		exact(v, [
			"turn",
			"attemptId",
			"planCommitment",
			"sessionId",
			"adaptedArchive",
			"boundaryCommitment",
			"approvalCommitment",
			"at",
			"commitment",
		]) &&
		(v.turn === 1 || v.turn === 2) &&
		str(v.attemptId) &&
		str(v.sessionId) &&
		date(v.at) &&
		(v.turn === 1 ? v.boundaryCommitment === null : digests([v.boundaryCommitment], domain)) &&
		digests([v.planCommitment, v.adaptedArchive, v.approvalCommitment, v.commitment], domain)
	);
}
export function readInitialContinuationReceiptV0(v: unknown): InitialContinuationReceiptV0 | null {
	if (
		!exact(v, [
			"schemaVersion",
			"plan",
			"firstApproval",
			"status",
			"runtime",
			"dispatch1",
			"boundary",
			"secondApproval",
			"dispatch2",
			"observed",
			"reason",
			"commitment",
		]) ||
		v.schemaVersion !== ENDO_INITIAL_CONTINUATION_VERSION_V0 ||
		!isInitialContinuationPlanV0(v.plan)
	)
		return null;
	const domain = v.plan.commitment.keyId;
	if (
		!isInitialContinuationApprovalV0(v.firstApproval, domain) ||
		![
			"approved-not-dispatched",
			"initial-dispatched",
			"awaiting-approval",
			"first-completed-not-approved",
			"continuation-approved-not-dispatched",
			"continuation-dispatched",
			"completed",
			"completed-unverifiable",
			"failed",
			"cancelled",
			"outcome-unknown",
		].includes(v.status as string) ||
		!digests([v.commitment], domain) ||
		(v.reason !== null && !str(v.reason, 128))
	)
		return null;
	if (v.runtime !== null) {
		if (
			!exact(v.runtime, [
				"root",
				"workingDirectory",
				"preExecutionArchive",
				"adaptedArchive",
				"postExecutionArchive",
				"adaptations",
				"proxyOrigin",
				"store",
				"sessionId",
			]) ||
			![
				v.runtime.root,
				v.runtime.workingDirectory,
				v.runtime.proxyOrigin,
				v.runtime.store,
				v.runtime.sessionId,
			].every((x) => str(x)) ||
			!Array.isArray(v.runtime.adaptations) ||
			!v.runtime.adaptations.every((x) => str(x, 128)) ||
			!digests([v.runtime.preExecutionArchive, v.runtime.adaptedArchive], domain) ||
			(v.runtime.postExecutionArchive !== null && !digests([v.runtime.postExecutionArchive], domain))
		)
			return null;
	}
	if (
		(v.dispatch1 !== null && !isInitialContinuationDispatchV0(v.dispatch1, domain)) ||
		(v.boundary !== null && !isInitialContinuationBoundaryV0(v.boundary, domain)) ||
		(v.secondApproval !== null && !isContinuationTurnApprovalV0(v.secondApproval, domain)) ||
		(v.dispatch2 !== null && !isInitialContinuationDispatchV0(v.dispatch2, domain))
	)
		return null;
	if (v.observed !== null) {
		if (
			!exact(v.observed, [
				"requestEventIds",
				"requestDigests",
				"responseDigests",
				"trajectoryIdentity",
				"captureGeneration",
				"storeGeneration",
			]) ||
			!Array.isArray(v.observed.requestEventIds) ||
			!v.observed.requestEventIds.every((x) => str(x)) ||
			!Array.isArray(v.observed.requestDigests) ||
			!Array.isArray(v.observed.responseDigests) ||
			!digests(
				[
					...v.observed.requestDigests,
					...v.observed.responseDigests,
					v.observed.captureGeneration,
					v.observed.storeGeneration,
				],
				domain,
			) ||
			!str(v.observed.trajectoryIdentity)
		)
			return null;
	}
	if (
		v.status === "completed" &&
		(v.runtime === null ||
			v.runtime.postExecutionArchive === null ||
			v.dispatch1 === null ||
			v.boundary === null ||
			v.secondApproval === null ||
			v.dispatch2 === null ||
			v.observed === null ||
			v.reason !== null)
	)
		return null;
	return v as unknown as InitialContinuationReceiptV0;
}
