import { type EndoKeyedDigestV0, isEndoKeyedDigestV0 } from "./keyed-digest-shape.ts";
import { isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0, endoFirstUnknownKeyV0, readEndoVersionedV0 } from "./versioned.ts";

export const ENDO_INITIAL_CHILD_EXECUTION_VERSION_V0 = "endo.initial-child-execution.v0";
export const ENDO_INITIAL_CHILD_EXECUTION_MAX_BYTES_V0 = 64 * 1024;
export type EndoInitialChildExecutionStatusV0 =
	| "preflight-refused"
	| "approved-not-dispatched"
	| "dispatched"
	| "completed"
	| "failed"
	| "cancelled"
	| "outcome-unknown";

/** Local paths are private operator references. This is a keyed integrity commitment, not an identity credential. */
export interface EndoInitialChildExecutionPlanV0 {
	attemptId: string;
	source: string;
	replay: string;
	outputParent: string;
	preparation: string;
	branchId: string;
	branchCommitment: EndoKeyedDigestV0;
	parentReference: EndoKeyedDigestV0;
	childRole: "baseline" | "alternative";
	childId: string;
	conditionCommitment: EndoKeyedDigestV0;
	archiveDigest: EndoKeyedDigestV0;
	piExecutable: string;
	piIdentity: string;
	piVersion: string;
	provider: string;
	model: string;
	upstream: string;
	promptCommitment: EndoKeyedDigestV0;
	toolPolicy: "none";
	wallTimeoutMs: number;
	maxTransferredBytes: number;
	commitment: EndoKeyedDigestV0;
}

export interface EndoInitialChildExecutionAttemptV0 {
	schemaVersion: typeof ENDO_INITIAL_CHILD_EXECUTION_VERSION_V0;
	plan: EndoInitialChildExecutionPlanV0;
	approval: { attemptId: string; planCommitment: EndoKeyedDigestV0; confirmedAt: string; method: "local-explicit" };
	status: Exclude<EndoInitialChildExecutionStatusV0, "preflight-refused">;
	runtime: null | {
		root: string;
		workingDirectory: string;
		preExecutionArchive: EndoKeyedDigestV0;
		adaptedArchive: EndoKeyedDigestV0;
		postExecutionArchive: EndoKeyedDigestV0 | null;
		adaptations: string[];
		proxyOrigin: string;
		store: string;
		sessionId: string;
	};
	observed: null | {
		requestEventId: string;
		requestDigest: EndoKeyedDigestV0;
		surfaceIdentity: string;
		trajectoryIdentity: string;
		captureGeneration: EndoKeyedDigestV0;
	};
	reason: string | null;
	commitment: EndoKeyedDigestV0;
}
export interface EndoInitialChildPreflightRefusalV0 {
	schemaVersion: typeof ENDO_INITIAL_CHILD_EXECUTION_VERSION_V0;
	attemptId: string;
	plan: null;
	approval: null;
	status: "preflight-refused";
	runtime: null;
	observed: null;
	reason: string;
	commitment: EndoKeyedDigestV0;
}
export type EndoInitialChildExecutionV0 = EndoInitialChildExecutionAttemptV0 | EndoInitialChildPreflightRefusalV0;

const object = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> =>
	isPlainJsonObjectV0(value) && endoFirstUnknownKeyV0(value as object, allowed) === undefined;
const str = (value: unknown, max = 4096): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;
const digest = isEndoKeyedDigestV0;
const status = (value: unknown): value is EndoInitialChildExecutionStatusV0 =>
	[
		"preflight-refused",
		"approved-not-dispatched",
		"dispatched",
		"completed",
		"failed",
		"cancelled",
		"outcome-unknown",
	].includes(value as string);
export function isEndoInitialChildExecutionPlanV0(value: unknown): value is EndoInitialChildExecutionPlanV0 {
	if (
		!object(value, [
			"attemptId",
			"source",
			"replay",
			"outputParent",
			"preparation",
			"branchId",
			"branchCommitment",
			"parentReference",
			"childRole",
			"childId",
			"conditionCommitment",
			"archiveDigest",
			"piExecutable",
			"piIdentity",
			"piVersion",
			"provider",
			"model",
			"upstream",
			"promptCommitment",
			"toolPolicy",
			"wallTimeoutMs",
			"maxTransferredBytes",
			"commitment",
		])
	)
		return false;
	return (
		/^endo\.initial-child-attempt\.[0-9a-f-]{36}$/.test(String(value.attemptId)) &&
		[
			value.source,
			value.replay,
			value.outputParent,
			value.preparation,
			value.branchId,
			value.childId,
			value.piExecutable,
			value.piIdentity,
			value.piVersion,
			value.provider,
			value.model,
			value.upstream,
		].every((v) => str(v)) &&
		[
			value.branchCommitment,
			value.parentReference,
			value.conditionCommitment,
			value.archiveDigest,
			value.promptCommitment,
			value.commitment,
		].every(digest) &&
		(value.childRole === "baseline" || value.childRole === "alternative") &&
		value.toolPolicy === "none" &&
		Number.isSafeInteger(value.wallTimeoutMs) &&
		(value.wallTimeoutMs as number) >= 1000 &&
		(value.wallTimeoutMs as number) <= 120000 &&
		Number.isSafeInteger(value.maxTransferredBytes) &&
		(value.maxTransferredBytes as number) >= 1024 &&
		(value.maxTransferredBytes as number) <= 16 * 1024 * 1024
	);
}
export const ENDO_INITIAL_CHILD_EXECUTION_VERSIONS_V0 = defineEndoVersionTableV0<EndoInitialChildExecutionV0>(
	"endo.initial-child-execution",
	[
		[
			ENDO_INITIAL_CHILD_EXECUTION_VERSION_V0,
			(value) => {
				if (
					!object(value, [
						"schemaVersion",
						"attemptId",
						"plan",
						"approval",
						"status",
						"runtime",
						"observed",
						"reason",
						"commitment",
					]) ||
					!status(value.status) ||
					!digest(value.commitment)
				)
					return null;
				if (value.status === "preflight-refused")
					return typeof value.attemptId === "string" &&
						/^endo\.initial-child-attempt\.[0-9a-f-]{36}$/.test(value.attemptId) &&
						value.plan === null &&
						value.approval === null &&
						value.runtime === null &&
						value.observed === null &&
						str(value.reason, 128)
						? (value as unknown as EndoInitialChildExecutionV0)
						: null;
				if (value.attemptId !== undefined) return null;
				if (
					!isEndoInitialChildExecutionPlanV0(value.plan) ||
					!object(value.approval, ["attemptId", "planCommitment", "confirmedAt", "method"]) ||
					value.approval.attemptId !== value.plan.attemptId ||
					!digest(value.approval.planCommitment) ||
					!str(value.approval.confirmedAt, 64) ||
					value.approval.method !== "local-explicit" ||
					(value.reason !== null && !str(value.reason, 128))
				)
					return null;
				if (
					value.runtime !== null &&
					(!object(value.runtime, [
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
							value.runtime.root,
							value.runtime.workingDirectory,
							value.runtime.proxyOrigin,
							value.runtime.store,
							value.runtime.sessionId,
						].every((v) => str(v)) ||
						!digest(value.runtime.preExecutionArchive) ||
						!digest(value.runtime.adaptedArchive) ||
						(value.runtime.postExecutionArchive !== null && !digest(value.runtime.postExecutionArchive)) ||
						!Array.isArray(value.runtime.adaptations) ||
						!value.runtime.adaptations.every((v: unknown) => str(v, 128)))
				)
					return null;
				if (
					value.observed !== null &&
					(!object(value.observed, [
						"requestEventId",
						"requestDigest",
						"surfaceIdentity",
						"trajectoryIdentity",
						"captureGeneration",
					]) ||
						![
							value.observed.requestEventId,
							value.observed.surfaceIdentity,
							value.observed.trajectoryIdentity,
						].every((v) => str(v)) ||
						!digest(value.observed.requestDigest) ||
						!digest(value.observed.captureGeneration))
				)
					return null;
				if (
					value.status === "completed" &&
					(value.runtime === null ||
						value.runtime.postExecutionArchive === null ||
						value.observed === null ||
						value.reason !== null)
				)
					return null;
				if (value.status === "approved-not-dispatched" && value.observed !== null) return null;
				const domain = value.plan.commitment.keyId;
				if (
					[
						value.plan.branchCommitment,
						value.plan.parentReference,
						value.plan.conditionCommitment,
						value.plan.archiveDigest,
						value.plan.promptCommitment,
						value.approval.planCommitment,
						value.commitment,
						value.runtime?.preExecutionArchive,
						value.runtime?.adaptedArchive,
						value.runtime?.postExecutionArchive,
						value.observed?.requestDigest,
						value.observed?.captureGeneration,
					].some((d) => d != null && (!digest(d) || d.keyId !== domain))
				)
					return null;
				return value as unknown as EndoInitialChildExecutionV0;
			},
		],
	],
);
export const readEndoInitialChildExecutionV0 = (value: unknown) =>
	readEndoVersionedV0(ENDO_INITIAL_CHILD_EXECUTION_VERSIONS_V0, value);
