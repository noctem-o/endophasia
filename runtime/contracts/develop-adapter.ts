// Harness-neutral operational adapter interface, authority gate, native approval boundary, and observation guard
// for DEVELOP (`endo.develop-adapter.v0`).
//
// This module contains NO adapter implementation and imports nothing from `adapters/` or `storage/`.
// It is shared by the Pi reference integration (`adapters/pi/develop-adapter.ts`), the non-Pi conformance specimen
// (`tests/fixtures/codex-adapter-specimen.ts`), and future live harness adapters (such as `DEVELOP-CODEX-LIVE-001`).
//
// Key invariants enforced at the operational boundary:
// - Capability standing != authorization. Even an `admitted` capability fails closed without a bound operator proof.
// - Documented-only, observed-only, and tested-only capabilities NEVER admit dispatch.
// - Synthetic adapters (`synthetic: true`) are unconditionally refused in production mode.
// - Governed control paths are bound to their owning source (e.g. `pi-workbench-broker` serves `pi-live` only).
// - Reconnect, process restart, or runtime replacement rotates `instanceId`, invalidating earlier attachment authority.
// - Pi-specific Everyday session-grant eligibility is never generalized to non-Pi runtimes.
// - Native harness approval requests never inherit Endophasia prompt authority, never auto-approve, never broaden scope,
//   and fail closed on unknown approval kinds.

import {
	ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
	type EndoAdapterCapabilityEntryV0,
	type EndoAdapterCapabilityStandingV0,
	type EndoAdapterNativeApprovalKindV0,
	type EndoAdapterOperationKindV0,
	type EndoAdapterProcessCleanupV0,
	type EndoAdapterRefusalCodeV0,
	type EndoAdapterRuntimeFingerprintRefV0,
	type EndoDevelopAdapterDescriptorV0,
	type EndoDevelopAdmissionDecisionV0,
	type EndoDevelopAuthorityProofV0,
	type EndoDevelopDispatchOutcomeV0,
	type EndoDevelopNativeApprovalDecisionV0,
	type EndoDevelopNativeApprovalOutcomeV0,
	type EndoDevelopNativeApprovalRequestV0,
	type EndoDevelopObservationV0,
	type EndoDevelopOperationRequestV0,
	type EndoDevelopSessionSnapshotV0,
	endoAdapterSessionKeyV0,
	endoDevelopAdapterDescriptorProblemV0,
	endoDevelopObservationProblemV0,
} from "../../protocol/develop-adapter.ts";
import {
	type EndoCapabilityStateV0,
	type EndoHarnessFingerprintRecordV0,
	endoHarnessIdentityBasisNameV0,
	validateEndoCapabilityStateV0,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import {
	type EndoExecutionProtectionV0,
	endoObserveProtectionV0,
	endoProtectionHoldsV0,
} from "./execution-protection.ts";

// ---------------------------------------------------------------------------------------------------------------
// Adapter interface (the smallest practical operational boundary)
// ---------------------------------------------------------------------------------------------------------------

export interface EndoDevelopCloseOutcomeV0 {
	closed: true;
	cleanup: EndoAdapterProcessCleanupV0;
}

/**
 * Operational interface implemented by a live harness adapter beneath the DEVELOP presentation surface.
 * Preserves native runtime semantics via `descriptor().operations` and enforces authority at `dispatch()`.
 */
export interface EndoDevelopLiveAdapterV0 {
	/** Current identity, ownership, capability standing, and native operation semantics. */
	descriptor(): EndoDevelopAdapterDescriptorV0;
	/** Current connection, runtime-reported vs controller-observed state, active turn, cleanup, and coordination refs. */
	snapshot(): EndoDevelopSessionSnapshotV0;
	/** Deterministic admission check at the operational boundary (pure with respect to side effects). */
	admitOperation(
		request: EndoDevelopOperationRequestV0,
		authority: EndoDevelopAuthorityProofV0 | null,
		options?: EndoDevelopAdmissionOptionsV0,
	): EndoDevelopAdmissionDecisionV0;
	/** Governed operation dispatch. Must re-check admission at dispatch time and never claim consequence on acceptance. */
	dispatch(
		request: EndoDevelopOperationRequestV0,
		authority: EndoDevelopAuthorityProofV0 | null,
		options?: EndoDevelopAdmissionOptionsV0,
	): Promise<EndoDevelopDispatchOutcomeV0>;
	/** Fail-closed boundary for harness-native approval requests (e.g. Codex server-initiated approvals). */
	handleNativeApproval(
		request: EndoDevelopNativeApprovalRequestV0,
		decision?: EndoDevelopNativeApprovalDecisionV0 | null,
		options?: { nowMs?: number; allowSessionOrPolicyScope?: boolean },
	): EndoDevelopNativeApprovalOutcomeV0;
	/** Subscribe to validated, instance-guarded live observations. */
	subscribeObservations(listener: (observation: EndoDevelopObservationV0) => void): () => void;
	/** Orderly teardown returning explicit process cleanup/containment verification. */
	close(): Promise<EndoDevelopCloseOutcomeV0>;
}

// ---------------------------------------------------------------------------------------------------------------
// Governed control-path ownership and payload digesting
// ---------------------------------------------------------------------------------------------------------------

/** Governed control paths and the single integration source each is permitted to serve. */
export const ENDO_GOVERNED_CONTROL_PATHS_V0: Readonly<Record<string, string>> = Object.freeze({
	"pi-workbench-broker": "pi-live",
});

const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const NATIVE_COMMAND_NAME = /^\/[a-z][a-z0-9_-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;

/** Canonical SHA-256 hex digest of an operational request payload, used to bind operator authorization proofs. */
export function endoDevelopOperationPayloadDigestV0(request: EndoDevelopOperationRequestV0): string {
	return sha256HexV0(canonicalEndoJsonV0(request as never));
}

// ---------------------------------------------------------------------------------------------------------------
// Fingerprint & capability evidence standing helpers (reusing protocol/harness.ts)
// ---------------------------------------------------------------------------------------------------------------

/** Project a `protocol/harness.ts` fingerprint record into the operational contract's fingerprint ref. */
export function endoDevelopFingerprintRefV0(
	fingerprint: EndoHarnessFingerprintRecordV0 | null | undefined,
	missingReason = "No runtime fingerprint has been observed.",
): EndoAdapterRuntimeFingerprintRefV0 {
	if (fingerprint === null || fingerprint === undefined) {
		return { status: "unidentified", reason: missingReason };
	}
	return {
		status: "identified",
		fingerprintId: fingerprint.id,
		identityDigest: fingerprint.identity.digest,
		basis: endoHarnessIdentityBasisNameV0(fingerprint),
		confidence: fingerprint.identity.confidence,
	};
}

/**
 * Derive one operational capability entry from a validated `protocol/harness.ts` `EndoCapabilityStateV0`.
 * Fail-closed: malformed state, unknown capability, wrong runtime/attachment, or mismatched/reduced-confidence
 * fingerprint never produces an `admitted` or `admitted-partial` standing.
 */
export function endoDevelopCapabilityFromStateV0(args: {
	state: unknown;
	capabilityId: string;
	expectedRuntime: string;
	expectedAttachment: string;
	currentFingerprint: EndoHarnessFingerprintRecordV0 | null;
	/** Optional prior fingerprint observed when the evidence was collected, to detect reduced-confidence carry-over. */
	evidenceFingerprintConfidence?: "strong" | "reduced";
}): EndoAdapterCapabilityEntryV0 {
	if (args.currentFingerprint === null) {
		return {
			standing: "unverified",
			evidenceCapability: args.capabilityId,
			evidenceId: null,
			reason: "The current runtime is unidentified; capabilities cannot be admitted.",
		};
	}
	const validated: EndoCapabilityStateV0 | null = validateEndoCapabilityStateV0(args.state);
	if (validated === null) {
		return {
			standing: "unverified",
			evidenceCapability: args.capabilityId,
			evidenceId: null,
			reason: "Capability state failed protocol validation and is treated as unverified.",
		};
	}
	if (validated.runtime !== args.expectedRuntime || validated.attachment !== args.expectedAttachment) {
		return {
			standing: "unverified",
			evidenceCapability: args.capabilityId,
			evidenceId: null,
			reason: `Capability state belongs to ${validated.runtime}/${validated.attachment}, not ${args.expectedRuntime}/${args.expectedAttachment}.`,
		};
	}
	if (validated.fingerprintId === null) {
		return {
			standing: "unverified",
			evidenceCapability: args.capabilityId,
			evidenceId: null,
			reason: "Capability state carries no fingerprint id.",
		};
	}
	const sameObservation = validated.fingerprintId === args.currentFingerprint.id;
	if (!sameObservation) {
		if (
			args.currentFingerprint.identity.confidence !== "strong" ||
			args.evidenceFingerprintConfidence === "reduced"
		) {
			return {
				standing: "unverified",
				evidenceCapability: args.capabilityId,
				evidenceId: null,
				reason: "A reduced-confidence fingerprint cannot carry capability evidence across observations.",
			};
		}
		return {
			standing: "unverified",
			evidenceCapability: args.capabilityId,
			evidenceId: null,
			reason: `Capability state was derived for fingerprint ${validated.fingerprintId}, not current ${args.currentFingerprint.id}.`,
		};
	}
	const entry = validated.capabilities.find((c) => c.capability === args.capabilityId);
	if (entry === undefined) {
		return {
			standing: "unverified",
			evidenceCapability: args.capabilityId,
			evidenceId: null,
			reason: `Capability ${args.capabilityId} is absent from the capability state.`,
		};
	}
	const standing: EndoAdapterCapabilityStandingV0 = entry.status;
	return {
		standing,
		evidenceCapability: args.capabilityId,
		evidenceId: entry.evidenceId,
		reason: standing === "admitted" ? null : entry.reason,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Operational admission gate (the 7-fact authority separation)
// ---------------------------------------------------------------------------------------------------------------

export interface EndoDevelopAdmissionOptionsV0 {
	/** `"production"` (default) refuses every synthetic adapter. `"fixture"` is for conformance tests only. */
	mode?: "production" | "fixture";
	/** Wall clock in ms for authorization expiry checks. Default `Date.now()`. */
	nowMs?: number;
	/** Observed execution protection boundary (required whenever `authority.mechanism === "session-grant"`). */
	protection?: EndoExecutionProtectionV0;
	/**
	 * Narrow compatibility seam for legacy `WorkbenchSessionV0` unit test doubles that supply no fingerprint on
	 * Pi's baseline `prompt` operation. Never applies when a fingerprint is present, and never applies to any other
	 * operation or non-Pi runtime. Default `false`.
	 */
	allowUnidentifiedBaselinePrompt?: boolean;
}

const refuse = (code: EndoAdapterRefusalCodeV0, reason: string): EndoDevelopAdmissionDecisionV0 => ({
	admitted: false,
	code,
	reason,
});

function validateRequestShape(
	request: EndoDevelopOperationRequestV0,
	descriptor: EndoDevelopAdapterDescriptorV0,
): EndoDevelopAdmissionDecisionV0 | null {
	switch (request.kind) {
		case "prompt": {
			if (
				typeof request.message !== "string" ||
				request.message.trim().length === 0 ||
				Buffer.byteLength(request.message, "utf8") > MAX_PAYLOAD_BYTES ||
				UNSAFE_TEXT.test(request.message)
			) {
				return refuse("invalid-request", "Prompt message must be non-empty safe UTF-8 text within size limits.");
			}
			if (request.attachments !== undefined && request.attachments.length > 0) {
				const meta = descriptor.operations.attachments;
				if (!meta.supported) {
					return refuse("operation-unsupported", "This adapter does not support attachments.");
				}
				if (meta.maxCount !== null && request.attachments.length > meta.maxCount) {
					return refuse("invalid-request", `Attachment count exceeds adapter limit (${meta.maxCount}).`);
				}
				for (const item of request.attachments) {
					if (!meta.kinds.includes(item.kind)) {
						return refuse(
							"operation-unsupported",
							`Attachment kind ${item.kind} is not supported by this adapter.`,
						);
					}
					if (!meta.delivery.includes(item.delivery)) {
						return refuse(
							"operation-unsupported",
							`Attachment delivery ${item.delivery} is not supported by this adapter.`,
						);
					}
					if (meta.maxBytesPerItem !== null && item.bytes !== null && item.bytes > meta.maxBytesPerItem) {
						return refuse("invalid-request", "Attachment exceeds per-item byte limit.");
					}
				}
			}
			return null;
		}
		case "steer":
		case "queue": {
			if (
				typeof request.message !== "string" ||
				request.message.trim().length === 0 ||
				Buffer.byteLength(request.message, "utf8") > MAX_PAYLOAD_BYTES ||
				UNSAFE_TEXT.test(request.message)
			) {
				return refuse(
					"invalid-request",
					`${request.kind} message must be non-empty safe UTF-8 text within limits.`,
				);
			}
			return null;
		}
		case "stop":
			return null;
		case "resume": {
			if (typeof request.targetSessionId !== "string" || request.targetSessionId.trim().length === 0) {
				return refuse("invalid-request", "Resume requires a non-empty targetSessionId.");
			}
			return null;
		}
		case "native-command": {
			if (typeof request.command !== "string" || !NATIVE_COMMAND_NAME.test(request.command)) {
				return refuse(
					"invalid-request",
					"Native commands must be explicit slash command names (never arbitrary shell input).",
				);
			}
			if (
				!Array.isArray(request.args) ||
				!request.args.every((a) => typeof a === "string" && a.length <= 256 && !UNSAFE_TEXT.test(a))
			) {
				return refuse("invalid-request", "Native command arguments must be bounded safe strings.");
			}
			return null;
		}
	}
}

function capabilityForOperation(
	descriptor: EndoDevelopAdapterDescriptorV0,
	operation: EndoAdapterOperationKindV0,
): EndoAdapterCapabilityEntryV0 {
	switch (operation) {
		case "prompt":
			return descriptor.operations.prompt.capability;
		case "steer":
			return descriptor.operations.steer.capability;
		case "queue":
			return descriptor.operations.queue.capability;
		case "stop":
			return descriptor.operations.stop.capability;
		case "resume":
			return descriptor.operations.resume.capability;
		case "native-command":
			return descriptor.operations.nativeCommand.capability;
	}
}

/**
 * Pure, deterministic operational admission gate.
 * Enforces every boundary condition separating capability advertisement from dispatch authorization.
 */
export function endoEvaluateDevelopAdmissionV0(args: {
	descriptor: EndoDevelopAdapterDescriptorV0;
	snapshot: EndoDevelopSessionSnapshotV0;
	request: EndoDevelopOperationRequestV0;
	authority: EndoDevelopAuthorityProofV0 | null;
	options?: EndoDevelopAdmissionOptionsV0;
}): EndoDevelopAdmissionDecisionV0 {
	const { descriptor, snapshot, request, authority } = args;
	const mode = args.options?.mode ?? "production";
	const nowMs = args.options?.nowMs ?? Date.now();

	// 1. Synthetic adapters are NEVER admitted in production mode.
	if (descriptor.synthetic && mode !== "fixture") {
		return refuse("synthetic-not-admitted", "Synthetic conformance adapters are never admitted in production.");
	}
	const descriptorProblem = endoDevelopAdapterDescriptorProblemV0(descriptor, { allowSynthetic: mode === "fixture" });
	if (descriptorProblem !== null) {
		return refuse("invalid-request", `Adapter descriptor invalid: ${descriptorProblem}`);
	}

	// 2. Request shape validation.
	const shapeProblem = validateRequestShape(request, descriptor);
	if (shapeProblem !== null) return shapeProblem;

	// 3. Ownership: external and imported sessions can NEVER be controlled (regardless of connection state).
	if (descriptor.ownership.status === "established" && descriptor.ownership.value !== "direct") {
		return refuse("not-directly-owned", "Control is permitted only on directly owned live sessions.");
	}

	// 4. Connection reachability (distinct from recorded state and from authorization).
	if (snapshot.connection.state !== "connected") {
		return refuse("not-connected", snapshot.connection.reason ?? "The adapter has no active connection.");
	}

	// 4b. Connected sessions still require established direct ownership.
	if (descriptor.ownership.status !== "established" || descriptor.ownership.value !== "direct") {
		return refuse("not-directly-owned", "Control is permitted only on directly owned live sessions.");
	}

	// 5. Control path ownership: a governed path belongs to one source only.
	if (descriptor.controlPath === null) {
		return refuse("control-path-mismatch", "Adapter declares no owning control path.");
	}
	const pathOwner = ENDO_GOVERNED_CONTROL_PATHS_V0[descriptor.controlPath];
	if (pathOwner !== undefined && pathOwner !== descriptor.session.source) {
		return refuse(
			"cross-source-control",
			`Control path ${descriptor.controlPath} belongs to ${pathOwner}, not ${descriptor.session.source}.`,
		);
	}

	// 6. Runtime identification check.
	const baselinePromptCompat =
		args.options?.allowUnidentifiedBaselinePrompt === true &&
		request.kind === "prompt" &&
		descriptor.harness.family === "pi" &&
		!descriptor.synthetic &&
		descriptor.runtimeFingerprint.status === "unidentified";
	if (!baselinePromptCompat && descriptor.runtimeFingerprint.status !== "identified") {
		return refuse("runtime-unidentified", descriptor.runtimeFingerprint.reason);
	}

	// 7. Native command refusal (never silently downgraded to ordinary model prompt text).
	if (request.kind === "native-command" && descriptor.operations.nativeCommand.transport === "unsupported") {
		return refuse(
			"native-command-unsupported",
			descriptor.operations.nativeCommand.capability.reason ??
				"This harness does not expose native commands over its programmatic transport.",
		);
	}

	// 8. Capability standing check (documented-only / observed-only / tested-only NEVER admit dispatch).
	const cap = capabilityForOperation(descriptor, request.kind);
	if (cap.standing === "unsupported") {
		return refuse("operation-unsupported", cap.reason ?? `${request.kind} is unsupported by this adapter.`);
	}
	if (cap.standing === "unavailable") {
		return refuse("operation-unavailable", cap.reason ?? `${request.kind} is temporarily unavailable.`);
	}
	if (cap.evidenceCapability !== null && descriptor.evidenceFreshness.status !== "current") {
		return refuse("capability-stale", descriptor.evidenceFreshness.reason);
	}
	if (cap.standing !== "admitted" && cap.standing !== "admitted-partial") {
		return refuse(
			"capability-not-admitted",
			cap.reason ?? `${request.kind} standing is ${cap.standing}, which does not admit dispatch.`,
		);
	}

	// 9. Lifecycle & targeting semantics (preserving Pi vs Codex differences).
	if (
		request.kind === "prompt" &&
		descriptor.operations.prompt.delivery === "idle-only" &&
		snapshot.activeTurn !== null
	) {
		return refuse("run-active", "A run is already active; this harness accepts new prompts only when idle.");
	}
	if (request.kind === "steer" || request.kind === "queue" || request.kind === "stop") {
		if (snapshot.activeTurn === null) {
			return refuse("no-active-run", `${request.kind} requires an active run or turn.`);
		}
	}
	if (request.kind === "steer" && descriptor.operations.steer.requiresTargetTurnId) {
		if (typeof request.targetTurnId !== "string" || request.targetTurnId.length === 0) {
			return refuse(
				"target-turn-required",
				"This harness requires an explicit targetTurnId precondition for steer.",
			);
		}
		if (snapshot.activeTurn?.turnId !== request.targetTurnId) {
			return refuse(
				"target-turn-mismatch",
				`Steer targetTurnId (${request.targetTurnId}) does not match active turn (${snapshot.activeTurn?.turnId ?? "none"}).`,
			);
		}
	}
	if (request.kind === "stop" && descriptor.operations.stop.requiresTargetTurnId) {
		if (typeof request.targetTurnId !== "string" || request.targetTurnId.length === 0) {
			return refuse(
				"target-turn-required",
				"This harness requires an explicit targetTurnId for targeted interruption.",
			);
		}
		if (snapshot.activeTurn?.turnId !== request.targetTurnId) {
			return refuse(
				"target-turn-mismatch",
				`Stop targetTurnId (${request.targetTurnId}) does not match active turn (${snapshot.activeTurn?.turnId ?? "none"}).`,
			);
		}
	}

	// 10. Explicit operator authority proof check (completely independent of capability standing).
	if (authority === null) {
		return refuse("missing-authority", "No operator authorization proof was provided; capability is not authority.");
	}
	if (authority.operation !== request.kind) {
		return refuse(
			"authority-operation-mismatch",
			`Authorization is for ${authority.operation}, not ${request.kind}.`,
		);
	}
	if (authority.source !== descriptor.session.source) {
		return refuse(
			"cross-source-control",
			`Authorization source ${authority.source} does not match adapter source ${descriptor.session.source}.`,
		);
	}
	if (authority.controlPath !== descriptor.controlPath) {
		return refuse(
			"control-path-mismatch",
			`Authorization control path ${authority.controlPath} does not match ${descriptor.controlPath}.`,
		);
	}
	const currentSessionKey = endoAdapterSessionKeyV0(descriptor.session);
	if (
		currentSessionKey === null ||
		snapshot.sessionKey !== currentSessionKey ||
		authority.sessionKey !== currentSessionKey
	) {
		return refuse(
			"cross-session-control",
			"Authorization sessionKey does not match the current established session identity.",
		);
	}
	if (
		authority.attachmentId !== descriptor.attachment.attachmentId ||
		authority.launchId !== descriptor.attachment.launchId ||
		authority.instanceId !== descriptor.attachment.instanceId ||
		snapshot.attachment.instanceId !== descriptor.attachment.instanceId
	) {
		return refuse(
			"stale-attachment",
			"Authorization was issued for an earlier attachment, launch, or connection instance.",
		);
	}
	if (authority.projectScope !== descriptor.attachment.projectScope) {
		return refuse(
			"project-scope-mismatch",
			"Authorization project scope does not match the attachment's bound workspace scope.",
		);
	}
	const expectedDigest = endoDevelopOperationPayloadDigestV0(request);
	if (authority.payloadDigest !== expectedDigest) {
		return refuse("authority-payload-mismatch", "Authorization payload digest does not match the request payload.");
	}
	if (authority.authorizedAtMs > authority.expiresAtMs || nowMs >= authority.expiresAtMs) {
		return refuse("authority-expired", "Operator authorization has expired.");
	}

	// 11. Session-grant guard: Pi Everyday eligibility NEVER generalizes to non-Pi runtimes.
	if (authority.mechanism === "session-grant") {
		if (!descriptor.everydayGrantEligible || descriptor.harness.family !== "pi" || descriptor.synthetic) {
			return refuse(
				"session-grant-not-permitted",
				"Session-control grants are not admitted for this runtime; explicit per-action terminal approval is required.",
			);
		}
		if (authority.sessionGrantId === null || authority.sessionGrantId.length === 0) {
			return refuse("missing-authority", "A session-grant authorization must name its grantId.");
		}
		const protection = endoObserveProtectionV0(args.options?.protection);
		const nativeSession =
			descriptor.session.nativeRef?.kind === "pi-session"
				? `endo.session.pi.${descriptor.session.nativeRef.sessionId}`
				: currentSessionKey;
		if (
			descriptor.attachment.projectScope === null ||
			!endoProtectionHoldsV0(protection, "workspace", {
				session: nativeSession,
				workspaceRoot: descriptor.attachment.projectScope,
			})
		) {
			return refuse(
				"protection-not-enforced",
				"No enforced workspace execution boundary was observed for this session and workspace.",
			);
		}
	}

	return { admitted: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Native approval boundary gate
// ---------------------------------------------------------------------------------------------------------------

const SCOPE_RANK: Readonly<Record<"once" | "session" | "policy-amendment", number>> = {
	once: 0,
	session: 1,
	"policy-amendment": 2,
};

/**
 * Evaluate a harness-native approval request (such as Codex `item/commandExecution/requestApproval`).
 * - Never inherits Endophasia prompt authority.
 * - Never auto-approves when no explicit operator decision is supplied.
 * - Always fails closed on unknown or unsupported approval kinds.
 * - Never reuses decisions across sessions, turns, items, or connection instances.
 * - Never silently broadens approval scope.
 * - Never grants Endophasia control authority.
 */
export function endoEvaluateNativeApprovalV0(args: {
	request: EndoDevelopNativeApprovalRequestV0;
	decision: EndoDevelopNativeApprovalDecisionV0 | null | undefined;
	current: {
		source: string;
		sessionKey: string | null;
		instanceId: string;
		knownKinds: readonly Exclude<EndoAdapterNativeApprovalKindV0, "unknown">[];
		mode: "server-initiated-requests" | "extension-dialogs-cancelled" | "none";
		nowMs?: number;
		allowSessionOrPolicyScope?: boolean;
	};
}): EndoDevelopNativeApprovalOutcomeV0 {
	const { request, decision, current } = args;
	const nowMs = current.nowMs ?? Date.now();

	if (current.mode !== "server-initiated-requests") {
		return {
			resolution: "cancelled",
			requestId: request.requestId,
			code: "unsupported-native-approvals",
			reason: `Adapter native approval mode is ${current.mode}; interactive approval is not supported.`,
			grantsEndophasiaAuthority: false,
		};
	}

	if (
		request.source !== current.source ||
		current.sessionKey === null ||
		request.sessionKey !== current.sessionKey ||
		request.instanceId !== current.instanceId
	) {
		return {
			resolution: "cancelled",
			requestId: request.requestId,
			code: "stale-attachment",
			reason: "Native approval request does not match the active source, session, or connection instance.",
			grantsEndophasiaAuthority: false,
		};
	}

	if (request.approvalKind === "unknown" || !current.knownKinds.includes(request.approvalKind)) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "unknown-approval-kind",
			reason: `Unknown or unsupported native approval kind (${request.approvalKind} / ${request.nativeMethod}) fails closed.`,
			grantsEndophasiaAuthority: false,
		};
	}

	if (decision === null || decision === undefined) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "no-operator-decision",
			reason: "Native harness approval requires an explicit operator decision; prompt authorization never applies.",
			grantsEndophasiaAuthority: false,
		};
	}

	if (decision.basis !== "explicit-operator-native-approval") {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "prompt-authority-not-inheritable",
			reason: "Native approval decisions cannot be derived from prompt authorization.",
			grantsEndophasiaAuthority: false,
		};
	}

	if (
		decision.requestId !== request.requestId ||
		decision.source !== request.source ||
		decision.sessionKey !== request.sessionKey ||
		decision.instanceId !== request.instanceId ||
		decision.turnId !== request.turnId ||
		decision.itemId !== request.itemId
	) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "binding-mismatch",
			reason: "Native approval decision does not match the request id, session, attachment instance, turn, or item.",
			grantsEndophasiaAuthority: false,
		};
	}

	if (decision.decidedAtMs > decision.expiresAtMs || nowMs >= decision.expiresAtMs) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "decision-expired",
			reason: "Native approval decision has expired.",
			grantsEndophasiaAuthority: false,
		};
	}

	if (decision.decision === "decline") {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "operator-declined",
			reason: "Operator declined the native approval request.",
			grantsEndophasiaAuthority: false,
		};
	}
	if (decision.decision === "cancel") {
		return {
			resolution: "cancelled",
			requestId: request.requestId,
			code: "operator-cancelled",
			reason: "Operator cancelled the native approval request.",
			grantsEndophasiaAuthority: false,
		};
	}

	// Scope broadening check.
	if (request.requestedScope === "unknown") {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "scope-broadening-refused",
			reason: "Native approval with unknown requested scope cannot be accepted.",
			grantsEndophasiaAuthority: false,
		};
	}
	if (SCOPE_RANK[decision.approvedScope] > SCOPE_RANK[request.requestedScope]) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "scope-broadening-refused",
			reason: `Approved scope (${decision.approvedScope}) is broader than requested scope (${request.requestedScope}).`,
			grantsEndophasiaAuthority: false,
		};
	}
	if (decision.approvedScope !== "once" && current.allowSessionOrPolicyScope !== true) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "scope-broadening-refused",
			reason: `Broad native approval scope (${decision.approvedScope}) is refused by default; only one-time approval is permitted.`,
			grantsEndophasiaAuthority: false,
		};
	}

	return {
		resolution: "accepted",
		requestId: request.requestId,
		scope: decision.approvedScope,
		grantsEndophasiaAuthority: false,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Observation stream guard (stale-instance filtering, deduplication, ordering)
// ---------------------------------------------------------------------------------------------------------------

export interface EndoObservationIngestResultV0 {
	/** Valid observation accepted for delivery, or null if rejected (duplicate / stale attachment / invalid). */
	accepted: EndoDevelopObservationV0 | null;
	/** Explicit evidence gap observations produced (late attachment, duplicate, out-of-order). */
	gaps: EndoDevelopObservationV0[];
}

/**
 * Guards an adapter's live observation stream against late events from superseded attachments, duplicates,
 * and out-of-order sequences without silently dropping provenance or manufacturing missing values.
 */
export class EndoObservationGuardV0 {
	#source: string;
	#attachmentId: string;
	#instanceId: string;
	#sessionKey: string | null;
	#lastSequence = 0;
	#gapCounter = 0;
	readonly #seenIds = new Set<string>();

	constructor(args: { source: string; attachmentId: string; instanceId: string; sessionKey: string | null }) {
		this.#source = args.source;
		this.#attachmentId = args.attachmentId;
		this.#instanceId = args.instanceId;
		this.#sessionKey = args.sessionKey;
	}

	/** Rotate to a new connection/process instance; subsequent events from older instances become explicit gaps. */
	rotateInstance(instanceId: string, sessionKey: string | null = this.#sessionKey): void {
		this.#instanceId = instanceId;
		this.#sessionKey = sessionKey;
		this.#lastSequence = 0;
		this.#seenIds.clear();
	}

	setSessionKey(sessionKey: string | null): void {
		this.#sessionKey = sessionKey;
	}

	get currentInstanceId(): string {
		return this.#instanceId;
	}

	#makeGap(
		gap: Extract<EndoDevelopObservationV0["body"], { kind: "evidence-gap" }>["gap"],
		reason: string,
		observedAt: string,
	): EndoDevelopObservationV0 {
		this.#gapCounter += 1;
		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
			observationId: `gap:${this.#instanceId}:${this.#gapCounter}`,
			source: this.#source,
			sessionKey: this.#sessionKey,
			attachmentId: this.#attachmentId,
			instanceId: this.#instanceId,
			sequence: Math.max(1, this.#lastSequence + 1),
			observedAt,
			basis: "controller-observed",
			nativeIds: { sessionId: null, turnId: null, itemId: null, entryId: null },
			body: { kind: "evidence-gap", gap, reason },
		};
	}

	ingest(observation: EndoDevelopObservationV0): EndoObservationIngestResultV0 {
		const problem = endoDevelopObservationProblemV0(observation);
		if (problem !== null) {
			return { accepted: null, gaps: [] };
		}
		if (observation.instanceId !== this.#instanceId) {
			return {
				accepted: null,
				gaps: [
					this.#makeGap(
						"late-event-from-prior-attachment",
						`Dropped observation ${observation.observationId} from superseded instance ${observation.instanceId} (current: ${this.#instanceId}).`,
						observation.observedAt,
					),
				],
			};
		}
		if (this.#seenIds.has(observation.observationId)) {
			return {
				accepted: null,
				gaps: [
					this.#makeGap(
						"duplicate-event",
						`Ignored duplicate observation ${observation.observationId} in instance ${this.#instanceId}.`,
						observation.observedAt,
					),
				],
			};
		}
		this.#seenIds.add(observation.observationId);
		const gaps: EndoDevelopObservationV0[] = [];
		if (observation.sequence <= this.#lastSequence) {
			gaps.push(
				this.#makeGap(
					"out-of-order-event",
					`Observation ${observation.observationId} arrived with sequence ${observation.sequence} after ${this.#lastSequence}.`,
					observation.observedAt,
				),
			);
		} else {
			this.#lastSequence = observation.sequence;
		}
		return { accepted: observation, gaps };
	}
}
