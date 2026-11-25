// The DEVELOP harness-neutral operational adapter contract v0 (`endo.develop-adapter.v0`).
//
// `endo.develop-session-surface.v0` (protocol/develop-session.ts) is the PRESENTATION layer: read-only, built for display,
// and authorising nothing. This module is the OPERATIONAL contract beneath it: the smallest practical harness-neutral
// boundary for observing and governing heterogeneous live agent runtimes (Pi as the reference implementation; Codex App
// Server as the second concrete design reference).
//
// Design invariants:
// 1. Reuse existing contracts: runtime fingerprints and capability states are `protocol/harness.ts` records, never a
//    competing registry. Canonical durable evidence stays in `protocol/event.ts` and `protocol/session-lifecycle.ts`.
// 2. Preserve native semantics: Pi's session-oriented RPC (no run/turn ids, untargeted abort, separate steer and follow-up)
//    and Codex App Server's thread/turn/item model (UUIDv7 turn ids, expectedTurnId steering precondition, targeted
//    turn/interrupt, server-initiated approvals, summary-vs-raw reasoning) are represented explicitly rather than flattened.
// 3. Separate capability from authority (the seven distinct facts):
//    (1) documented operation != (2) evidence-backed capability standing != (3) reachable current attachment !=
//    (4) operator authorization proof != (5) owning control-path admission != (6) runtime acknowledgement !=
//    (7) subsequently observed consequence.
// 4. Fail closed on uncertainty: unknown native approvals, unsupported native commands, stale attachments, cross-source
//    control paths, reduced-confidence carry-over, and synthetic adapters in production mode are always refused.
// 5. Protocol imports only protocol.

import {
	ENDO_HARNESS_IDENTITY_BASES_V1,
	type EndoCapabilityStateV0,
	type EndoHarnessIdentityBasisNameV1,
	type EndoHarnessIdentityConfidenceV0,
	validateEndoCapabilityStateV0,
} from "./harness.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { isIso8601UtcV0, isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_DEVELOP_ADAPTER_SCHEMA_V0 = "endo.develop-adapter.v0";
export const ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0 = "endo.develop-adapter-descriptor.v0";
export const ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0 = "endo.develop-adapter-observation.v0";

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------------------------

/** Scope of a session key. Display aliases are never keys. */
export const ENDO_ADAPTER_IDENTITY_SCOPES_V0 = ["persistent", "launch", "generation"] as const;
export type EndoAdapterIdentityScopeV0 = (typeof ENDO_ADAPTER_IDENTITY_SCOPES_V0)[number];

/** Ownership of the session relative to this Endophasia process. */
export const ENDO_ADAPTER_OWNERSHIPS_V0 = ["direct", "external", "imported"] as const;
export type EndoAdapterOwnershipV0 = (typeof ENDO_ADAPTER_OWNERSHIPS_V0)[number];

/** Evidence basis of a fact or observation. Never merged across bases. */
export const ENDO_ADAPTER_BASES_V0 = ["controller-observed", "runtime-reported", "recorded"] as const;
export type EndoAdapterBasisV0 = (typeof ENDO_ADAPTER_BASES_V0)[number];

/** Connection state of Endophasia's own transport to the runtime. Distinct from session end and process exit. */
export const ENDO_ADAPTER_CONNECTION_STATES_V0 = [
	"connected",
	"disconnected",
	"reconnecting",
	"unknown",
	"not-applicable",
] as const;
export type EndoAdapterConnectionStateV0 = (typeof ENDO_ADAPTER_CONNECTION_STATES_V0)[number];

/** Session/thread activity state. A recorded active state is never proof of a live process. */
export const ENDO_ADAPTER_SESSION_STATES_V0 = [
	"active",
	"idle",
	"waiting-approval",
	"waiting-input",
	"ended",
	"interrupted",
	"detached",
	"unknown",
] as const;
export type EndoAdapterSessionStateV0 = (typeof ENDO_ADAPTER_SESSION_STATES_V0)[number];

/** Turn/run terminal or active state, kept distinct from session termination and process termination. */
export const ENDO_ADAPTER_TURN_STATES_V0 = [
	"in-progress",
	"completed",
	"interrupted",
	"aborted",
	"failed",
	"unclassified",
] as const;
export type EndoAdapterTurnStateV0 = (typeof ENDO_ADAPTER_TURN_STATES_V0)[number];

/** Process cleanup verification boundary (aligns with LIVE-PROCESS-CONTAINMENT-001). */
export const ENDO_ADAPTER_CLEANUP_BOUNDARIES_V0 = ["scope", "process-group", "unverified", "not-applicable"] as const;
export type EndoAdapterCleanupBoundaryV0 = (typeof ENDO_ADAPTER_CLEANUP_BOUNDARIES_V0)[number];

export const ENDO_ADAPTER_CLEANUP_RESULTS_V0 = ["confirmed", "incomplete", "unverified", "not-applicable"] as const;
export type EndoAdapterCleanupResultV0 = (typeof ENDO_ADAPTER_CLEANUP_RESULTS_V0)[number];

/**
 * Capability standing in the operational contract.
 * CRITICAL: Only `admitted` and `admitted-partial` are eligible for operational dispatch.
 * `documented-only`, `observed-only`, and `tested-only` NEVER admit an operation.
 */
export const ENDO_ADAPTER_CAPABILITY_STANDINGS_V0 = [
	"admitted",
	"admitted-partial",
	"tested-only",
	"observed-only",
	"documented-only",
	"unverified",
	"unavailable",
	"unsupported",
	"mismatch",
] as const;
export type EndoAdapterCapabilityStandingV0 = (typeof ENDO_ADAPTER_CAPABILITY_STANDINGS_V0)[number];

/** Operational interaction kinds. */
export const ENDO_ADAPTER_OPERATIONS_V0 = ["prompt", "steer", "queue", "stop", "resume", "native-command"] as const;
export type EndoAdapterOperationKindV0 = (typeof ENDO_ADAPTER_OPERATIONS_V0)[number];

/** How an operator authorized an operation. */
export const ENDO_ADAPTER_AUTHORITY_MECHANISMS_V0 = ["terminal-phrase", "terminal-code", "session-grant"] as const;
export type EndoAdapterAuthorityMechanismV0 = (typeof ENDO_ADAPTER_AUTHORITY_MECHANISMS_V0)[number];

/** Closed refusal reasons at the operational admission boundary. */
export const ENDO_ADAPTER_REFUSAL_CODES_V0 = [
	"synthetic-not-admitted",
	"not-directly-owned",
	"not-connected",
	"runtime-unidentified",
	"capability-not-admitted",
	"capability-stale",
	"operation-unsupported",
	"operation-unavailable",
	"native-command-unsupported",
	"control-path-mismatch",
	"cross-source-control",
	"cross-session-control",
	"stale-attachment",
	"project-scope-mismatch",
	"missing-authority",
	"authority-operation-mismatch",
	"authority-payload-mismatch",
	"authority-expired",
	"session-grant-not-permitted",
	"protection-not-enforced",
	"target-turn-required",
	"target-turn-mismatch",
	"run-active",
	"no-active-run",
	"invalid-request",
] as const;
export type EndoAdapterRefusalCodeV0 = (typeof ENDO_ADAPTER_REFUSAL_CODES_V0)[number];

/** Known harness-native approval request kinds. Anything outside this set is `unknown` and fails closed. */
export const ENDO_ADAPTER_NATIVE_APPROVAL_KINDS_V0 = [
	"command-execution",
	"file-change",
	"permissions",
	"user-input",
	"mcp-elicitation",
	"extension-dialog",
	"unknown",
] as const;
export type EndoAdapterNativeApprovalKindV0 = (typeof ENDO_ADAPTER_NATIVE_APPROVAL_KINDS_V0)[number];

export const ENDO_ADAPTER_NATIVE_APPROVAL_SCOPES_V0 = ["once", "session", "policy-amendment", "unknown"] as const;
export type EndoAdapterNativeApprovalScopeV0 = (typeof ENDO_ADAPTER_NATIVE_APPROVAL_SCOPES_V0)[number];

/** Attachment content kinds an adapter may describe in its metadata. */
export const ENDO_ADAPTER_ATTACHMENT_KINDS_V0 = [
	"image",
	"local-image",
	"audio",
	"local-audio",
	"file-reference",
	"skill-reference",
	"mention-reference",
] as const;
export type EndoAdapterAttachmentKindV0 = (typeof ENDO_ADAPTER_ATTACHMENT_KINDS_V0)[number];

/** Evidence gap kinds recorded on the observation stream. */
export const ENDO_ADAPTER_EVIDENCE_GAP_KINDS_V0 = [
	"output-limit-exceeded",
	"disconnected-mid-request",
	"out-of-order-event",
	"duplicate-event",
	"late-event-from-prior-attachment",
	"unrecognized-runtime-event",
	"usage-unavailable",
	"reasoning-unavailable",
	"partial-operation-result",
] as const;
export type EndoAdapterEvidenceGapKindV0 = (typeof ENDO_ADAPTER_EVIDENCE_GAP_KINDS_V0)[number];

/** Reasoning provenance: never relabel a reasoning summary as raw thinking. */
export const ENDO_ADAPTER_REASONING_KINDS_V0 = [
	"raw-thinking",
	"reasoning-summary",
	"redacted",
	"unavailable",
] as const;
export type EndoAdapterReasoningKindV0 = (typeof ENDO_ADAPTER_REASONING_KINDS_V0)[number];

// ---------------------------------------------------------------------------------------------------------------
// Identity, ownership and capability descriptors
// ---------------------------------------------------------------------------------------------------------------

export type EndoAdapterRuntimeFingerprintRefV0 =
	| {
			status: "identified";
			fingerprintId: string;
			identityDigest: string;
			basis: EndoHarnessIdentityBasisNameV1;
			confidence: EndoHarnessIdentityConfidenceV0;
	  }
	| { status: "unidentified"; reason: string };

export type EndoAdapterNativeSessionRefV0 =
	| { kind: "pi-session"; sessionId: string }
	| { kind: "codex-thread"; threadId: string; sessionTreeId: string | null }
	| { kind: "opaque"; value: string };

export interface EndoAdapterSessionIdentityV0 {
	/** Source integration namespace (e.g. `pi-live`, `codex-live`, or `test-*` for synthetic specimens). */
	source: string;
	key:
		| { status: "established"; id: string; scope: EndoAdapterIdentityScopeV0 }
		| { status: "unavailable"; reason: string };
	/** Display label only. Never an identity key and never compared for equality or authorization. */
	alias: string | null;
	/** Native harness session/thread coordinates, preserved without flattening. */
	nativeRef: EndoAdapterNativeSessionRefV0 | null;
}

/** Source-qualified global session key, or null when identity is not established. */
export function endoAdapterSessionKeyV0(identity: EndoAdapterSessionIdentityV0): string | null {
	return identity.key.status === "established" ? `${identity.source}:${identity.key.scope}:${identity.key.id}` : null;
}

export type EndoAdapterOwnershipFactV0 =
	| { status: "established"; value: EndoAdapterOwnershipV0; basis: EndoAdapterBasisV0; by: string }
	| { status: "unavailable"; reason: string };

/** Explicit attachment instance coordinates. Reconnect/restart/replacement rotates `instanceId`. */
export interface EndoAdapterAttachmentIdentityV0 {
	attachmentId: string;
	launchId: string;
	/** Unique to the active runtime connection/process generation. Prior instance authority is stale. */
	instanceId: string;
	/** Canonical project/workspace root bound to this attachment, or null if unbound. */
	projectScope: string | null;
}

export interface EndoAdapterCapabilityEntryV0 {
	standing: EndoAdapterCapabilityStandingV0;
	/** Capability id in `protocol/harness.ts` evidence, or null when not backed by a registry entry. */
	evidenceCapability: string | null;
	/** Evidence id backing an admitted standing, or null. */
	evidenceId: string | null;
	/** Why the capability holds this standing (always required unless `admitted`). */
	reason: string | null;
}

/** Explicit semantic profile per operation: preserves Pi vs Codex differences rather than manufacturing parity. */
export interface EndoAdapterOperationSemanticsV0 {
	prompt: {
		capability: EndoAdapterCapabilityEntryV0;
		delivery: "idle-only" | "starts-turn" | "accepts-during-turn" | "unsupported";
		yieldsTurnId: boolean;
	};
	steer: {
		capability: EndoAdapterCapabilityEntryV0;
		delivery: "in-turn-next-model-call" | "active-turn-precondition" | "unsupported";
		requiresTargetTurnId: boolean;
		returnsReceiptId: boolean;
	};
	queue: {
		capability: EndoAdapterCapabilityEntryV0;
		delivery: "after-current-run" | "thread-queue" | "unsupported";
		returnsReceiptId: boolean;
	};
	stop: {
		capability: EndoAdapterCapabilityEntryV0;
		targeting: "untargeted-session-abort" | "targeted-turn-interrupt" | "unsupported";
		requiresTargetTurnId: boolean;
		acknowledgementSemantics: "on-idle" | "on-interrupt-accepted" | "unknown";
	};
	resume: {
		capability: EndoAdapterCapabilityEntryV0;
		mode: "reopen-persistent-session" | "thread-resume" | "unsupported";
		replaysHistory: boolean | "optional" | "unknown";
	};
	nativeCommand: {
		capability: EndoAdapterCapabilityEntryV0;
		/** Native commands are never silently converted into ordinary model text, and arbitrary shell passthrough is forbidden. */
		transport: "dedicated-rpc" | "unsupported";
		allowsArbitraryShell: false;
	};
	attachments: {
		supported: boolean;
		kinds: readonly EndoAdapterAttachmentKindV0[];
		delivery: readonly ("reference" | "embedded")[];
		maxCount: number | null;
		maxBytesPerItem: number | null;
		requiresExplicitAdmission: true;
		allowsArbitraryPathRead: false;
	};
	nativeApprovals: {
		mode: "server-initiated-requests" | "extension-dialogs-cancelled" | "none";
		knownKinds: readonly Exclude<EndoAdapterNativeApprovalKindV0, "unknown">[];
		unknownPolicy: "fail-closed";
	};
	coordination: {
		canDiscoverChildren: boolean;
		reportsParentRef: boolean;
		/** Coordinator delegation/assignment is out of scope for v0. */
		delegationSupported: false;
	};
}

export interface EndoDevelopAdapterDescriptorV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0;
	harness: {
		family: string;
		observedVersion: string | null;
	};
	/** True for test-only conformance specimens. Production admission always refuses `synthetic: true`. */
	synthetic: boolean;
	/** Owning control path identifier (e.g. `pi-workbench-broker`). Scoped strictly to its source. */
	controlPath: string | null;
	/** Whether this runtime has an admitted Everyday session-grant profile. Pi-only in v0; never generalized automatically. */
	everydayGrantEligible: boolean;
	runtimeFingerprint: EndoAdapterRuntimeFingerprintRefV0;
	session: EndoAdapterSessionIdentityV0;
	ownership: EndoAdapterOwnershipFactV0;
	attachment: EndoAdapterAttachmentIdentityV0;
	/** Current capability state from `protocol/harness.ts`, or null if unavailable/unidentified. */
	capabilityState: EndoCapabilityStateV0 | null;
	evidenceFreshness: { status: "current"; reason: null } | { status: "stale" | "unidentified"; reason: string };
	operations: EndoAdapterOperationSemanticsV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot, lifecycle, termination and coordination links
// ---------------------------------------------------------------------------------------------------------------

export interface EndoAdapterProcessCleanupV0 {
	boundary: EndoAdapterCleanupBoundaryV0;
	result: EndoAdapterCleanupResultV0;
	remainingProcesses: number | null;
	scopeName: string | null;
}

export interface EndoAdapterStateClaimV0 {
	state: EndoAdapterSessionStateV0;
	basis: EndoAdapterBasisV0;
	by: string;
	at: string | null;
}

export interface EndoAdapterActiveTurnV0 {
	/** Runtime-supplied turn/run id (e.g. Codex UUIDv7), or null when the runtime exposes none (Pi). */
	turnId: string | null;
	state: EndoAdapterTurnStateV0;
	basis: EndoAdapterBasisV0;
}

/** Explicit, attributed session/task references for Coordinator compatibility. Never inferred from names or times. */
export interface EndoAdapterCoordinationRefsV0 {
	parentSession: {
		sessionKey: string;
		basis: "controller-observed" | "runtime-reported";
		claimedBy: string;
	} | null;
	children: readonly {
		sessionKey: string;
		basis: "controller-observed" | "runtime-reported";
		claimedBy: string;
	}[];
	taskBindings: readonly {
		taskId: string;
		attemptId: string | null;
		basis: "operator-declared" | "controller-observed";
	}[];
}

export interface EndoDevelopSessionSnapshotV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADAPTER_SCHEMA_V0;
	observedAt: string;
	sessionKey: string | null;
	attachment: EndoAdapterAttachmentIdentityV0;
	connection: {
		state: EndoAdapterConnectionStateV0;
		reason: string | null;
	};
	/** Kept separate by basis (`controller-observed` vs `runtime-reported` vs `recorded`); never merged. */
	stateClaims: readonly EndoAdapterStateClaimV0[];
	activeTurn: EndoAdapterActiveTurnV0 | null;
	pendingNativeApprovalCount: number;
	processCleanup: EndoAdapterProcessCleanupV0;
	coordination: EndoAdapterCoordinationRefsV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Governed interaction requests, authority proof, and dispatch outcomes
// ---------------------------------------------------------------------------------------------------------------

export interface EndoAdapterAttachmentProposalV0 {
	kind: EndoAdapterAttachmentKindV0;
	delivery: "reference" | "embedded";
	/** Opaque identifier or canonical workspace-scoped reference, never an arbitrary unverified path read. */
	reference: string;
	bytes: number | null;
	mediaType: string | null;
}

export type EndoDevelopOperationRequestV0 =
	| {
			kind: "prompt";
			message: string;
			attachments?: readonly EndoAdapterAttachmentProposalV0[];
	  }
	| {
			kind: "steer";
			message: string;
			/** Required when the adapter declares `steer.requiresTargetTurnId === true` (e.g. Codex `expectedTurnId`). */
			targetTurnId?: string;
	  }
	| {
			kind: "queue";
			message: string;
	  }
	| {
			kind: "stop";
			/** Required when the adapter declares `stop.requiresTargetTurnId === true` (e.g. Codex `turn/interrupt`). */
			targetTurnId?: string;
	  }
	| {
			kind: "resume";
			targetSessionId: string;
			replayHistory?: boolean;
	  }
	| {
			kind: "native-command";
			/** Native harness command name (e.g. `/voice`), never arbitrary shell passthrough. */
			command: string;
			args: readonly string[];
	  };

/**
 * Operator authorization proof bound to one exact target, attachment generation, payload digest, and expiry.
 * A capability advertisement, transport connection, session id, or Coordinator recommendation is NEVER an authority proof.
 */
export interface EndoDevelopAuthorityProofV0 {
	authorizationId: string;
	operation: EndoAdapterOperationKindV0;
	source: string;
	sessionKey: string;
	attachmentId: string;
	launchId: string;
	instanceId: string;
	controlPath: string;
	/** Canonical workspace/project root the authorization covers, or null if the attachment has none. */
	projectScope: string | null;
	/** SHA-256 hex digest of the canonical operation payload. */
	payloadDigest: string;
	mechanism: EndoAdapterAuthorityMechanismV0;
	/** Required when mechanism is `session-grant`. */
	sessionGrantId: string | null;
	authorizedAtMs: number;
	expiresAtMs: number;
}

export type EndoDevelopAdmissionDecisionV0 =
	| { admitted: true }
	| { admitted: false; code: EndoAdapterRefusalCodeV0; reason: string };

/**
 * Result of dispatching an operation.
 * CRITICAL: `accepted` records ONLY runtime acknowledgement, NEVER consumption, completion, or proven consequence.
 */
export type EndoDevelopDispatchOutcomeV0 =
	| {
			status: "accepted";
			operation: EndoAdapterOperationKindV0;
			instanceId: string;
			/** Runtime acknowledgement disposition (e.g. Pi `started`/`queued`, Codex `turn-started`/`steered`). */
			disposition: string;
			/** Runtime-supplied turn id when returned (Codex), else null (Pi). */
			turnId: string | null;
			/** Runtime-supplied receipt id when returned, else null. */
			receiptId: string | null;
			/** Always false at dispatch time: consequence must be established by subsequent observation. */
			consequenceObserved: false;
	  }
	| {
			status: "refused";
			operation: EndoAdapterOperationKindV0;
			stage: "admission" | "runtime";
			code: EndoAdapterRefusalCodeV0 | "runtime-refused";
			reason: string;
	  }
	| {
			status: "unknown";
			operation: EndoAdapterOperationKindV0;
			instanceId: string;
			/** Request may have reached the runtime before disconnect, timeout, or partial/malformed reply. */
			reason: string;
			dispatched: true;
	  };

// ---------------------------------------------------------------------------------------------------------------
// Native approval boundary
// ---------------------------------------------------------------------------------------------------------------

/** A harness-native approval request (e.g. Codex `item/commandExecution/requestApproval`). */
export interface EndoDevelopNativeApprovalRequestV0 {
	requestId: string;
	source: string;
	sessionKey: string;
	instanceId: string;
	turnId: string | null;
	itemId: string | null;
	approvalKind: EndoAdapterNativeApprovalKindV0;
	/** Exact native RPC method name (e.g. `item/commandExecution/requestApproval`). */
	nativeMethod: string;
	requestedScope: EndoAdapterNativeApprovalScopeV0;
	/** Bounded human-readable summary for operator review; never executed or trusted as authority. */
	summary: string;
}

/** Explicit operator decision for one specific native approval request. */
export interface EndoDevelopNativeApprovalDecisionV0 {
	requestId: string;
	source: string;
	sessionKey: string;
	instanceId: string;
	turnId: string | null;
	itemId: string | null;
	decision: "accept" | "decline" | "cancel";
	/** Scope explicitly approved by the operator. Never silently broader than requested or promoted across sessions/turns. */
	approvedScope: "once" | "session" | "policy-amendment";
	/** Distinguishes explicit native approval from any prior prompt authorization. */
	basis: "explicit-operator-native-approval";
	decidedAtMs: number;
	expiresAtMs: number;
}

export type EndoDevelopNativeApprovalOutcomeV0 =
	| {
			resolution: "accepted";
			requestId: string;
			scope: "once" | "session" | "policy-amendment";
			/** Native harness approvals never grant Endophasia control authority. */
			grantsEndophasiaAuthority: false;
	  }
	| {
			resolution: "declined" | "cancelled";
			requestId: string;
			code:
				| "operator-declined"
				| "operator-cancelled"
				| "no-operator-decision"
				| "unknown-approval-kind"
				| "prompt-authority-not-inheritable"
				| "scope-broadening-refused"
				| "binding-mismatch"
				| "stale-attachment"
				| "decision-expired"
				| "unsupported-native-approvals";
			reason: string;
			grantsEndophasiaAuthority: false;
	  };

// ---------------------------------------------------------------------------------------------------------------
// Live observations and evidence gaps
// ---------------------------------------------------------------------------------------------------------------

export interface EndoAdapterUsageReportV0 {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number | null;
	cacheWriteTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number;
	/** USD cost when explicitly reported by the runtime; null when unavailable (never fabricated as 0). */
	costUsd: number | null;
}

export type EndoDevelopObservationBodyV0 =
	| {
			kind: "lifecycle";
			event:
				| "session-attached"
				| "session-detached"
				| "connection-lost"
				| "turn-started"
				| "turn-completed"
				| "turn-interrupted"
				| "turn-aborted"
				| "turn-failed"
				| "context-compacted";
			sessionState: EndoAdapterSessionStateV0;
			turnState: EndoAdapterTurnStateV0 | null;
			detail: string | null;
	  }
	| {
			kind: "transcript";
			role: "user" | "assistant";
			contentKind: "text" | "reasoning";
			reasoningKind: EndoAdapterReasoningKindV0 | null;
			text: string | null;
			truncated: boolean;
			stopReason: string | null;
	  }
	| {
			kind: "tool-activity";
			activityKind: "tool-call" | "command-execution" | "file-change" | "mcp-tool" | "subagent-activity";
			name: string;
			phase: "started" | "updated" | "completed" | "failed" | "declined" | "unknown";
			callId: string | null;
			exitCode: number | null;
	  }
	| {
			kind: "usage";
			usage: { status: "reported"; value: EndoAdapterUsageReportV0 } | { status: "unavailable"; reason: string };
	  }
	| {
			kind: "operation-outcome";
			operation: EndoAdapterOperationKindV0;
			receiptId: string | null;
			outcome: "consumed" | "completed" | "interrupted" | "failed" | "unknown";
			detail: string | null;
	  }
	| {
			kind: "native-approval";
			phase: "requested" | "resolved";
			requestId: string;
			approvalKind: EndoAdapterNativeApprovalKindV0;
			resolution: "pending" | "accepted" | "declined" | "cancelled";
	  }
	| {
			kind: "evidence-gap";
			gap: EndoAdapterEvidenceGapKindV0;
			reason: string;
	  };

export interface EndoDevelopObservationV0 {
	schemaVersion: typeof ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0;
	observationId: string;
	source: string;
	sessionKey: string | null;
	attachmentId: string;
	instanceId: string;
	/** Monotonic 1-based sequence within `instanceId`. */
	sequence: number;
	observedAt: string;
	basis: EndoAdapterBasisV0;
	nativeIds: {
		sessionId: string | null;
		turnId: string | null;
		itemId: string | null;
		entryId: string | null;
	};
	body: EndoDevelopObservationBodyV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Validators (pure, closed, fail-closed)
// ---------------------------------------------------------------------------------------------------------------

const SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isSafeText = (value: unknown, max = 512): value is string =>
	typeof value === "string" && value.length >= 1 && value.length <= max && !CONTROL_CHARS.test(value);

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
	typeof value === "string" && (list as readonly string[]).includes(value);

function exactKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
	if (!isPlainJsonObjectV0(value)) return false;
	const rec = value as Record<string, unknown>;
	return Object.keys(rec).length === allowed.length && allowed.every((k) => Object.hasOwn(rec, k));
}

function validateCapabilityEntry(path: string, value: unknown): string | null {
	if (!exactKeys(value, ["standing", "evidenceCapability", "evidenceId", "reason"]))
		return `${path}: unexpected members`;
	if (!isOneOf(ENDO_ADAPTER_CAPABILITY_STANDINGS_V0, value.standing)) return `${path}: unknown capability standing`;
	if (
		value.evidenceCapability !== null &&
		(typeof value.evidenceCapability !== "string" || !isWellFormedKindV0(value.evidenceCapability))
	)
		return `${path}: evidenceCapability must be a dotted kind or null`;
	if (
		value.evidenceId !== null &&
		(typeof value.evidenceId !== "string" || !isEndoIdentifierV0(value.evidenceId, "evidence"))
	)
		return `${path}: evidenceId must be an endo.evidence.* identifier or null`;
	if (value.standing === "admitted") {
		if (value.reason !== null && !isSafeText(value.reason, 512)) return `${path}: invalid reason`;
	} else {
		if (!isSafeText(value.reason, 512)) return `${path}: non-admitted standing requires a reason`;
	}
	return null;
}

/**
 * Pure closed validator for `EndoDevelopAdapterDescriptorV0`.
 * Returns null when valid, or the first validation problem.
 */
export function endoDevelopAdapterDescriptorProblemV0(
	value: unknown,
	options: { allowSynthetic?: boolean } = {},
): string | null {
	if (
		!exactKeys(value, [
			"schemaVersion",
			"harness",
			"synthetic",
			"controlPath",
			"everydayGrantEligible",
			"runtimeFingerprint",
			"session",
			"ownership",
			"attachment",
			"capabilityState",
			"evidenceFreshness",
			"operations",
		]) ||
		value.schemaVersion !== ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0
	)
		return "not a valid endo.develop-adapter-descriptor.v0";
	const d = value as unknown as EndoDevelopAdapterDescriptorV0;
	if (!exactKeys(d.harness, ["family", "observedVersion"])) return "harness: unexpected members";
	if (typeof d.harness.family !== "string" || !SOURCE_PATTERN.test(d.harness.family))
		return "harness.family must be a lowercase identifier";
	if (d.harness.observedVersion !== null && !isSafeText(d.harness.observedVersion, 128))
		return "harness.observedVersion must be text or null";
	if (typeof d.synthetic !== "boolean") return "synthetic must be a boolean";
	if (d.synthetic && options.allowSynthetic !== true) return "synthetic adapter is not admitted in production";
	if (d.controlPath !== null && (typeof d.controlPath !== "string" || !SOURCE_PATTERN.test(d.controlPath)))
		return "controlPath must be an integration identifier or null";
	if (typeof d.everydayGrantEligible !== "boolean") return "everydayGrantEligible must be a boolean";
	// Guard: only real Pi may claim Everyday grant eligibility in v0.
	if (d.everydayGrantEligible && (d.synthetic || d.harness.family !== "pi"))
		return "everydayGrantEligible is restricted to non-synthetic pi adapters in v0";

	// Runtime fingerprint
	const fp = d.runtimeFingerprint as unknown;
	if (isPlainJsonObjectV0(fp) && (fp as Record<string, unknown>).status === "unidentified") {
		if (!exactKeys(fp, ["status", "reason"]) || !isSafeText((fp as Record<string, unknown>).reason))
			return "runtimeFingerprint: unidentified requires a reason";
	} else if (
		!exactKeys(fp, ["status", "fingerprintId", "identityDigest", "basis", "confidence"]) ||
		fp.status !== "identified" ||
		typeof fp.fingerprintId !== "string" ||
		!isEndoIdentifierV0(fp.fingerprintId, "evidence") ||
		typeof fp.identityDigest !== "string" ||
		!HEX64.test(fp.identityDigest) ||
		!isOneOf(ENDO_HARNESS_IDENTITY_BASES_V1, fp.basis) ||
		(fp.confidence !== "strong" && fp.confidence !== "reduced")
	) {
		return "runtimeFingerprint: invalid identified fingerprint reference";
	}

	// Session identity
	if (!exactKeys(d.session, ["source", "key", "alias", "nativeRef"])) return "session: unexpected members";
	if (typeof d.session.source !== "string" || !SOURCE_PATTERN.test(d.session.source))
		return "session.source must be a lowercase identifier";
	if (d.synthetic && !d.session.source.startsWith("test-")) return "synthetic adapter source must start with test-";
	if (!d.synthetic && d.session.source.startsWith("test-"))
		return "non-synthetic adapter source must not start with test-";
	const key = d.session.key as unknown;
	if (isPlainJsonObjectV0(key) && (key as Record<string, unknown>).status === "unavailable") {
		if (!exactKeys(key, ["status", "reason"]) || !isSafeText((key as Record<string, unknown>).reason))
			return "session.key: unavailable requires a reason";
	} else if (
		!exactKeys(key, ["status", "id", "scope"]) ||
		key.status !== "established" ||
		typeof key.id !== "string" ||
		!SESSION_ID_PATTERN.test(key.id) ||
		!isOneOf(ENDO_ADAPTER_IDENTITY_SCOPES_V0, key.scope)
	) {
		return "session.key: invalid established key";
	}
	if (d.session.alias !== null && !isSafeText(d.session.alias, 128)) return "session.alias must be text or null";
	if (d.session.nativeRef !== null) {
		const ref = d.session.nativeRef as unknown;
		if (!isPlainJsonObjectV0(ref)) return "session.nativeRef must be an object or null";
		const r = ref as Record<string, unknown>;
		if (r.kind === "pi-session") {
			if (!exactKeys(r, ["kind", "sessionId"]) || !isSafeText(r.sessionId, 256))
				return "session.nativeRef: invalid pi-session";
		} else if (r.kind === "codex-thread") {
			if (
				!exactKeys(r, ["kind", "threadId", "sessionTreeId"]) ||
				!isSafeText(r.threadId, 256) ||
				(r.sessionTreeId !== null && !isSafeText(r.sessionTreeId, 256))
			)
				return "session.nativeRef: invalid codex-thread";
		} else if (r.kind === "opaque") {
			if (!exactKeys(r, ["kind", "value"]) || !isSafeText(r.value, 256)) return "session.nativeRef: invalid opaque";
		} else {
			return "session.nativeRef: unknown kind";
		}
	}

	// Ownership
	const own = d.ownership as unknown;
	if (isPlainJsonObjectV0(own) && (own as Record<string, unknown>).status === "unavailable") {
		if (!exactKeys(own, ["status", "reason"]) || !isSafeText((own as Record<string, unknown>).reason))
			return "ownership: unavailable requires a reason";
	} else if (
		!exactKeys(own, ["status", "value", "basis", "by"]) ||
		own.status !== "established" ||
		!isOneOf(ENDO_ADAPTER_OWNERSHIPS_V0, own.value) ||
		!isOneOf(ENDO_ADAPTER_BASES_V0, own.basis) ||
		typeof own.by !== "string" ||
		!SOURCE_PATTERN.test(own.by)
	) {
		return "ownership: invalid established ownership fact";
	}

	// Attachment
	if (!exactKeys(d.attachment, ["attachmentId", "launchId", "instanceId", "projectScope"]))
		return "attachment: unexpected members";
	if (typeof d.attachment.attachmentId !== "string" || !isWellFormedKindV0(d.attachment.attachmentId))
		return "attachment.attachmentId must be a dotted kind";
	if (!isSafeText(d.attachment.launchId, 128) || !isSafeText(d.attachment.instanceId, 128))
		return "attachment.launchId and instanceId are required";
	if (d.attachment.projectScope !== null && !isSafeText(d.attachment.projectScope, 4096))
		return "attachment.projectScope must be text or null";

	// Capability state (reusing protocol/harness.ts validator)
	if (d.capabilityState !== null && validateEndoCapabilityStateV0(d.capabilityState) === null)
		return "capabilityState failed endo.capability-state.v0 validation";

	// Evidence freshness
	const fresh = d.evidenceFreshness as unknown;
	if (!exactKeys(fresh, ["status", "reason"])) return "evidenceFreshness: unexpected members";
	if (fresh.status === "current") {
		if (fresh.reason !== null) return "evidenceFreshness: current must have null reason";
	} else if (fresh.status === "stale" || fresh.status === "unidentified") {
		if (!isSafeText(fresh.reason, 512)) return "evidenceFreshness: stale/unidentified requires a reason";
	} else {
		return "evidenceFreshness: unknown status";
	}

	// Operations
	const ops = d.operations as unknown;
	if (
		!exactKeys(ops, [
			"prompt",
			"steer",
			"queue",
			"stop",
			"resume",
			"nativeCommand",
			"attachments",
			"nativeApprovals",
			"coordination",
		])
	)
		return "operations: unexpected members";
	const o = d.operations;
	if (!exactKeys(o.prompt, ["capability", "delivery", "yieldsTurnId"])) return "operations.prompt: unexpected members";
	const promptCap = validateCapabilityEntry("operations.prompt.capability", o.prompt.capability);
	if (promptCap !== null) return promptCap;
	if (!isOneOf(["idle-only", "starts-turn", "accepts-during-turn", "unsupported"], o.prompt.delivery))
		return "operations.prompt.delivery: unknown";
	if (typeof o.prompt.yieldsTurnId !== "boolean") return "operations.prompt.yieldsTurnId must be boolean";

	if (!exactKeys(o.steer, ["capability", "delivery", "requiresTargetTurnId", "returnsReceiptId"]))
		return "operations.steer: unexpected members";
	const steerCap = validateCapabilityEntry("operations.steer.capability", o.steer.capability);
	if (steerCap !== null) return steerCap;
	if (!isOneOf(["in-turn-next-model-call", "active-turn-precondition", "unsupported"], o.steer.delivery))
		return "operations.steer.delivery: unknown";
	if (typeof o.steer.requiresTargetTurnId !== "boolean" || typeof o.steer.returnsReceiptId !== "boolean")
		return "operations.steer flags must be boolean";

	if (!exactKeys(o.queue, ["capability", "delivery", "returnsReceiptId"]))
		return "operations.queue: unexpected members";
	const queueCap = validateCapabilityEntry("operations.queue.capability", o.queue.capability);
	if (queueCap !== null) return queueCap;
	if (!isOneOf(["after-current-run", "thread-queue", "unsupported"], o.queue.delivery))
		return "operations.queue.delivery: unknown";
	if (typeof o.queue.returnsReceiptId !== "boolean") return "operations.queue.returnsReceiptId must be boolean";

	if (!exactKeys(o.stop, ["capability", "targeting", "requiresTargetTurnId", "acknowledgementSemantics"]))
		return "operations.stop: unexpected members";
	const stopCap = validateCapabilityEntry("operations.stop.capability", o.stop.capability);
	if (stopCap !== null) return stopCap;
	if (!isOneOf(["untargeted-session-abort", "targeted-turn-interrupt", "unsupported"], o.stop.targeting))
		return "operations.stop.targeting: unknown";
	if (typeof o.stop.requiresTargetTurnId !== "boolean") return "operations.stop.requiresTargetTurnId must be boolean";
	if (!isOneOf(["on-idle", "on-interrupt-accepted", "unknown"], o.stop.acknowledgementSemantics))
		return "operations.stop.acknowledgementSemantics: unknown";

	if (!exactKeys(o.resume, ["capability", "mode", "replaysHistory"])) return "operations.resume: unexpected members";
	const resumeCap = validateCapabilityEntry("operations.resume.capability", o.resume.capability);
	if (resumeCap !== null) return resumeCap;
	if (!isOneOf(["reopen-persistent-session", "thread-resume", "unsupported"], o.resume.mode))
		return "operations.resume.mode: unknown";
	if (
		typeof o.resume.replaysHistory !== "boolean" &&
		o.resume.replaysHistory !== "optional" &&
		o.resume.replaysHistory !== "unknown"
	)
		return "operations.resume.replaysHistory: invalid";

	if (!exactKeys(o.nativeCommand, ["capability", "transport", "allowsArbitraryShell"]))
		return "operations.nativeCommand: unexpected members";
	const cmdCap = validateCapabilityEntry("operations.nativeCommand.capability", o.nativeCommand.capability);
	if (cmdCap !== null) return cmdCap;
	if (!isOneOf(["dedicated-rpc", "unsupported"], o.nativeCommand.transport))
		return "operations.nativeCommand.transport: unknown";
	if (o.nativeCommand.allowsArbitraryShell !== false)
		return "operations.nativeCommand.allowsArbitraryShell must be false";

	if (
		!exactKeys(o.attachments, [
			"supported",
			"kinds",
			"delivery",
			"maxCount",
			"maxBytesPerItem",
			"requiresExplicitAdmission",
			"allowsArbitraryPathRead",
		])
	)
		return "operations.attachments: unexpected members";
	if (typeof o.attachments.supported !== "boolean") return "operations.attachments.supported must be boolean";
	if (
		!Array.isArray(o.attachments.kinds) ||
		!o.attachments.kinds.every((k) => isOneOf(ENDO_ADAPTER_ATTACHMENT_KINDS_V0, k))
	)
		return "operations.attachments.kinds: invalid";
	if (
		!Array.isArray(o.attachments.delivery) ||
		!o.attachments.delivery.every((k) => isOneOf(["reference", "embedded"], k))
	)
		return "operations.attachments.delivery: invalid";
	if (o.attachments.maxCount !== null && (!Number.isSafeInteger(o.attachments.maxCount) || o.attachments.maxCount < 1))
		return "operations.attachments.maxCount must be positive integer or null";
	if (
		o.attachments.maxBytesPerItem !== null &&
		(!Number.isSafeInteger(o.attachments.maxBytesPerItem) || o.attachments.maxBytesPerItem < 1)
	)
		return "operations.attachments.maxBytesPerItem must be positive integer or null";
	if (o.attachments.requiresExplicitAdmission !== true || o.attachments.allowsArbitraryPathRead !== false)
		return "operations.attachments must require explicit admission and forbid arbitrary path reads";

	if (!exactKeys(o.nativeApprovals, ["mode", "knownKinds", "unknownPolicy"]))
		return "operations.nativeApprovals: unexpected members";
	if (!isOneOf(["server-initiated-requests", "extension-dialogs-cancelled", "none"], o.nativeApprovals.mode))
		return "operations.nativeApprovals.mode: unknown";
	if (
		!Array.isArray(o.nativeApprovals.knownKinds) ||
		!o.nativeApprovals.knownKinds.every((k) => isOneOf(ENDO_ADAPTER_NATIVE_APPROVAL_KINDS_V0, k) && k !== "unknown")
	)
		return "operations.nativeApprovals.knownKinds: invalid";
	if (o.nativeApprovals.unknownPolicy !== "fail-closed")
		return "operations.nativeApprovals.unknownPolicy must be fail-closed";

	if (!exactKeys(o.coordination, ["canDiscoverChildren", "reportsParentRef", "delegationSupported"]))
		return "operations.coordination: unexpected members";
	if (
		typeof o.coordination.canDiscoverChildren !== "boolean" ||
		typeof o.coordination.reportsParentRef !== "boolean" ||
		o.coordination.delegationSupported !== false
	)
		return "operations.coordination: invalid";

	return null;
}

/** Pure closed validator for `EndoDevelopObservationV0`. */
export function endoDevelopObservationProblemV0(value: unknown): string | null {
	if (
		!exactKeys(value, [
			"schemaVersion",
			"observationId",
			"source",
			"sessionKey",
			"attachmentId",
			"instanceId",
			"sequence",
			"observedAt",
			"basis",
			"nativeIds",
			"body",
		]) ||
		value.schemaVersion !== ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0
	)
		return "not a valid endo.develop-adapter-observation.v0";
	const obs = value as unknown as EndoDevelopObservationV0;
	if (!isSafeText(obs.observationId, 160)) return "observationId is required";
	if (typeof obs.source !== "string" || !SOURCE_PATTERN.test(obs.source)) return "source is invalid";
	if (obs.sessionKey !== null && !isSafeText(obs.sessionKey, 256)) return "sessionKey is invalid";
	if (typeof obs.attachmentId !== "string" || !isWellFormedKindV0(obs.attachmentId)) return "attachmentId is invalid";
	if (!isSafeText(obs.instanceId, 128)) return "instanceId is required";
	if (typeof obs.sequence !== "number" || !Number.isSafeInteger(obs.sequence) || obs.sequence < 1)
		return "sequence must be a positive integer";
	if (typeof obs.observedAt !== "string" || !isIso8601UtcV0(obs.observedAt)) return "observedAt must be ISO-8601 UTC";
	if (!isOneOf(ENDO_ADAPTER_BASES_V0, obs.basis)) return "basis is unknown";
	if (!exactKeys(obs.nativeIds, ["sessionId", "turnId", "itemId", "entryId"])) return "nativeIds: unexpected members";
	for (const k of ["sessionId", "turnId", "itemId", "entryId"] as const) {
		const v = obs.nativeIds[k];
		if (v !== null && !isSafeText(v, 256)) return `nativeIds.${k} must be text or null`;
	}
	if (!isPlainJsonObjectV0(obs.body)) return "body must be an object";
	const b = obs.body as unknown as Record<string, unknown>;
	switch (b.kind) {
		case "lifecycle":
			if (!exactKeys(b, ["kind", "event", "sessionState", "turnState", "detail"]))
				return "body.lifecycle: unexpected members";
			if (!isOneOf(ENDO_ADAPTER_SESSION_STATES_V0, b.sessionState)) return "body.lifecycle.sessionState: unknown";
			if (b.turnState !== null && !isOneOf(ENDO_ADAPTER_TURN_STATES_V0, b.turnState))
				return "body.lifecycle.turnState: unknown";
			return null;
		case "transcript":
			if (!exactKeys(b, ["kind", "role", "contentKind", "reasoningKind", "text", "truncated", "stopReason"]))
				return "body.transcript: unexpected members";
			if (b.role !== "user" && b.role !== "assistant") return "body.transcript.role: invalid";
			if (b.contentKind !== "text" && b.contentKind !== "reasoning") return "body.transcript.contentKind: invalid";
			if (b.contentKind === "reasoning") {
				if (!isOneOf(ENDO_ADAPTER_REASONING_KINDS_V0, b.reasoningKind))
					return "body.transcript.reasoningKind is required for reasoning";
			} else if (b.reasoningKind !== null) {
				return "body.transcript.reasoningKind must be null for text";
			}
			return null;
		case "tool-activity":
			if (!exactKeys(b, ["kind", "activityKind", "name", "phase", "callId", "exitCode"]))
				return "body.tool-activity: unexpected members";
			return isSafeText(b.name, 128) ? null : "body.tool-activity.name is required";
		case "usage": {
			if (!exactKeys(b, ["kind", "usage"])) return "body.usage: unexpected members";
			const u = b.usage;
			if (isPlainJsonObjectV0(u) && (u as Record<string, unknown>).status === "unavailable") {
				return exactKeys(u, ["status", "reason"]) && isSafeText((u as Record<string, unknown>).reason)
					? null
					: "body.usage: unavailable requires reason";
			}
			if (!exactKeys(u, ["status", "value"]) || u.status !== "reported") return "body.usage: invalid status";
			const val = u.value;
			if (
				!exactKeys(val, [
					"inputTokens",
					"outputTokens",
					"cachedInputTokens",
					"cacheWriteTokens",
					"reasoningTokens",
					"totalTokens",
					"costUsd",
				])
			)
				return "body.usage.value: unexpected members";
			return null;
		}
		case "operation-outcome":
			if (!exactKeys(b, ["kind", "operation", "receiptId", "outcome", "detail"]))
				return "body.operation-outcome: unexpected members";
			return isOneOf(ENDO_ADAPTER_OPERATIONS_V0, b.operation) ? null : "body.operation-outcome.operation: unknown";
		case "native-approval":
			if (!exactKeys(b, ["kind", "phase", "requestId", "approvalKind", "resolution"]))
				return "body.native-approval: unexpected members";
			return isOneOf(ENDO_ADAPTER_NATIVE_APPROVAL_KINDS_V0, b.approvalKind)
				? null
				: "body.native-approval.approvalKind: unknown";
		case "evidence-gap":
			if (!exactKeys(b, ["kind", "gap", "reason"])) return "body.evidence-gap: unexpected members";
			if (!isOneOf(ENDO_ADAPTER_EVIDENCE_GAP_KINDS_V0, b.gap)) return "body.evidence-gap.gap: unknown";
			return isSafeText(b.reason, 512) ? null : "body.evidence-gap.reason is required";
		default:
			return "body.kind: unknown";
	}
}
