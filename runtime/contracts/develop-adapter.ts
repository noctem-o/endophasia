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
	ENDO_ADAPTER_AUTHORITY_MECHANISMS_V0,
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
import { isPlainJsonObjectV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";
import {
	type EndoExecutionProtectionV0,
	endoObserveProtectionV0,
	endoProtectionHoldsV0,
} from "./execution-protection.ts";
import { isEndoSessionGrantIdV0 } from "./session-control.ts";

// ---------------------------------------------------------------------------------------------------------------
// Adapter interface (the smallest practical operational boundary)
// ---------------------------------------------------------------------------------------------------------------

export interface EndoDevelopCloseOutcomeV0 {
	closed: true;
	cleanup: EndoAdapterProcessCleanupV0;
}

/**
 * Operational interface implemented by a live harness adapter beneath the DEVELOP presentation surface.
 * Preserves native runtime semantics via `describe().operations` and enforces authority at `dispatch()`.
 */
export interface EndoDevelopLiveAdapterV0 {
	/** Current identity, ownership, capability standing, and native operation semantics. */
	describe(): EndoDevelopAdapterDescriptorV0;
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

/** Governed control paths and the single integration source and harness family each is permitted to serve. */
export const ENDO_GOVERNED_CONTROL_PATHS_V0: Readonly<
	Record<string, { readonly source: string; readonly family: string }>
> = Object.freeze(
	Object.assign(Object.create(null) as Record<string, { readonly source: string; readonly family: string }>, {
		"pi-workbench-broker": Object.freeze({ source: "pi-live", family: "pi" }),
		"codex-live-controller": Object.freeze({ source: "codex-live", family: "codex" }),
	}),
);

const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const NATIVE_COMMAND_NAME = /^\/[a-z][a-z0-9_-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_NATIVE_COMMAND_ARGS = 32;

const isSafeBoundedText = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length >= 1 && value.length <= max && !UNSAFE_TEXT.test(value);

const isSafeAttachmentRef = (value: unknown): value is string => {
	if (!isSafeBoundedText(value, 512)) return false;
	// Never allow arbitrary absolute filesystem paths or parent directory traversal when arbitrary path read is forbidden.
	if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
	const segments = value.split(/[\\/]/);
	return !segments.includes("..");
};

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
	if (!isPlainJsonObjectV0(request)) {
		return refuse("invalid-request", "Operation request must be a plain JSON object.");
	}
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
			if (request.attachments !== undefined) {
				if (!Array.isArray(request.attachments)) {
					return refuse("invalid-request", "Prompt attachments must be an array when supplied.");
				}
				if (request.attachments.length > 0) {
					const meta = descriptor.operations.attachments;
					if (!meta.supported) {
						return refuse("operation-unsupported", "This adapter does not support attachments.");
					}
					if (meta.maxCount !== null && request.attachments.length > meta.maxCount) {
						return refuse("invalid-request", `Attachment count exceeds adapter limit (${meta.maxCount}).`);
					}
					for (const item of request.attachments) {
						if (!isPlainJsonObjectV0(item)) {
							return refuse("invalid-request", "Each attachment item must be a plain object.");
						}
						if (!meta.kinds.includes(item.kind)) {
							return refuse(
								"operation-unsupported",
								`Attachment kind ${String(item.kind)} is not supported by this adapter.`,
							);
						}
						if (!meta.delivery.includes(item.delivery)) {
							return refuse(
								"operation-unsupported",
								`Attachment delivery ${String(item.delivery)} is not supported by this adapter.`,
							);
						}
						if (!isSafeAttachmentRef(item.reference)) {
							return refuse(
								"invalid-request",
								"Attachment reference must be a bounded opaque or workspace-relative reference (no absolute or traversal paths).",
							);
						}
						if (
							item.bytes !== null &&
							(typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 0)
						) {
							return refuse("invalid-request", "Attachment bytes must be a non-negative integer or null.");
						}
						if (meta.maxBytesPerItem !== null && item.bytes !== null && item.bytes > meta.maxBytesPerItem) {
							return refuse("invalid-request", "Attachment exceeds per-item byte limit.");
						}
						if (item.mediaType !== null && !isSafeBoundedText(item.mediaType, 128)) {
							return refuse("invalid-request", "Attachment mediaType must be bounded safe text or null.");
						}
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
			if (!isSafeBoundedText(request.targetSessionId, 256) || request.targetSessionId.trim().length === 0) {
				return refuse("invalid-request", "Resume requires a bounded, safe, non-empty targetSessionId.");
			}
			if (request.replayHistory !== undefined && typeof request.replayHistory !== "boolean") {
				return refuse("invalid-request", "Resume replayHistory must be a boolean when supplied.");
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
				request.args.length > MAX_NATIVE_COMMAND_ARGS ||
				!request.args.every((a) => typeof a === "string" && a.length <= 256 && !UNSAFE_TEXT.test(a))
			) {
				return refuse("invalid-request", "Native command arguments must be bounded safe strings.");
			}
			return null;
		}
		default:
			return refuse("invalid-request", "Unknown operation kind.");
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

	// 5. Control path ownership: a governed path belongs to one source and harness family only.
	if (descriptor.controlPath === null) {
		return refuse("control-path-mismatch", "Adapter declares no owning control path.");
	}
	const pathOwner = Object.hasOwn(ENDO_GOVERNED_CONTROL_PATHS_V0, descriptor.controlPath)
		? ENDO_GOVERNED_CONTROL_PATHS_V0[descriptor.controlPath]
		: undefined;
	if (pathOwner !== undefined) {
		if (pathOwner.source !== descriptor.session.source || pathOwner.family !== descriptor.harness.family) {
			return refuse(
				"cross-source-control",
				`Control path ${descriptor.controlPath} belongs to ${pathOwner.source} (${pathOwner.family}), not ${descriptor.session.source} (${descriptor.harness.family}).`,
			);
		}
	} else if (mode === "production") {
		return refuse(
			"control-path-mismatch",
			`Control path ${descriptor.controlPath} is not a registered governed production control path.`,
		);
	}

	// 6. Runtime identification check (unconditional: no production bypass for unidentified runtimes).
	if (descriptor.runtimeFingerprint.status !== "identified") {
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
	// Stale evidence (changed binary, changed configuration, or invalidated registry) always fails closed.
	if (descriptor.evidenceFreshness.status === "stale") {
		return refuse("capability-stale", descriptor.evidenceFreshness.reason);
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
	// Only Pi's baseline prompt may stand without a registry evidenceCapability; every other operation must match
	// a validated `endo.capability-state.v0` entry bound to the current fingerprint.
	if (cap.evidenceCapability === null) {
		const isPiBaselinePrompt =
			request.kind === "prompt" &&
			descriptor.harness.family === "pi" &&
			descriptor.session.source === "pi-live" &&
			!descriptor.synthetic;
		if (!isPiBaselinePrompt) {
			return refuse(
				"capability-not-admitted",
				`${request.kind} cannot be admitted without backing capability evidence.`,
			);
		}
	} else {
		const validState = validateEndoCapabilityStateV0(descriptor.capabilityState);
		if (
			validState === null ||
			descriptor.runtimeFingerprint.status !== "identified" ||
			validState.runtime !== descriptor.harness.family ||
			validState.attachment !== descriptor.attachment.attachmentId ||
			validState.fingerprintId !== descriptor.runtimeFingerprint.fingerprintId
		) {
			return refuse(
				"capability-stale",
				`Capability state is missing or does not match the current ${descriptor.harness.family} fingerprint.`,
			);
		}
		const stateEntry = validState.capabilities.find((c) => c.capability === cap.evidenceCapability);
		if (
			stateEntry === undefined ||
			stateEntry.status !== cap.standing ||
			stateEntry.evidenceId === null ||
			stateEntry.evidenceId !== cap.evidenceId
		) {
			return refuse(
				"capability-not-admitted",
				`Descriptor capability standing for ${cap.evidenceCapability} is not backed by current capabilityState.`,
			);
		}
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
	if (authority === null || !isPlainJsonObjectV0(authority)) {
		return refuse("missing-authority", "No operator authorization proof was provided; capability is not authority.");
	}
	if (!isSafeBoundedText(authority.authorizationId, 160)) {
		return refuse("missing-authority", "Authorization proof must carry a valid authorizationId.");
	}
	if (!(ENDO_ADAPTER_AUTHORITY_MECHANISMS_V0 as readonly unknown[]).includes(authority.mechanism)) {
		return refuse("missing-authority", "Authorization proof carries an unrecognized authorization mechanism.");
	}
	if (authority.mechanism !== "session-grant" && authority.sessionGrantId !== null) {
		return refuse("missing-authority", "Non-grant authorization proof must not carry a sessionGrantId.");
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
	let expectedDigest: string;
	try {
		expectedDigest = endoDevelopOperationPayloadDigestV0(request);
	} catch {
		return refuse("invalid-request", "Operation request could not be canonicalized.");
	}
	if (authority.payloadDigest !== expectedDigest) {
		return refuse("authority-payload-mismatch", "Authorization payload digest does not match the request payload.");
	}
	if (
		typeof nowMs !== "number" ||
		typeof authority.authorizedAtMs !== "number" ||
		typeof authority.expiresAtMs !== "number" ||
		!Number.isFinite(nowMs) ||
		!Number.isFinite(authority.authorizedAtMs) ||
		!Number.isFinite(authority.expiresAtMs) ||
		authority.authorizedAtMs > authority.expiresAtMs ||
		nowMs >= authority.expiresAtMs
	) {
		return refuse("authority-expired", "Operator authorization has expired or carries non-finite timestamps.");
	}

	// 11. Session-grant guard: Pi Everyday eligibility NEVER generalizes to non-Pi runtimes.
	if (authority.mechanism === "session-grant") {
		if (
			!descriptor.everydayGrantEligible ||
			descriptor.harness.family !== "pi" ||
			descriptor.session.source !== "pi-live" ||
			descriptor.controlPath !== "pi-workbench-broker" ||
			descriptor.synthetic
		) {
			return refuse(
				"session-grant-not-permitted",
				"Session-control grants are not admitted for this runtime; explicit per-action terminal approval is required.",
			);
		}
		if (!isEndoSessionGrantIdV0(authority.sessionGrantId)) {
			return refuse("missing-authority", "A session-grant authorization must name a valid session grant id.");
		}
		const protection = endoObserveProtectionV0(args.options?.protection);
		const nativeSession =
			descriptor.session.key.status === "established" ? descriptor.session.key.id : currentSessionKey;
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

const SCOPE_RANK: Readonly<Record<"once" | "session" | "policy-amendment", number>> = Object.freeze(
	Object.assign(Object.create(null) as Record<"once" | "session" | "policy-amendment", number>, {
		once: 0,
		session: 1,
		"policy-amendment": 2,
	}),
);

/**
 * Evaluate a harness-native approval request (such as Codex `item/commandExecution/requestApproval`).
 * - Never inherits Endophasia prompt authority.
 * - Never auto-approves when no explicit operator decision is supplied.
 * - Always fails closed on unknown or unsupported approval kinds, unknown decisions, or non-finite expiry.
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
		connected?: boolean;
		activeTurnId?: string | null;
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

	if (current.connected === false) {
		return {
			resolution: "cancelled",
			requestId: request.requestId,
			code: "stale-attachment",
			reason: "Adapter is not connected; native approval request cannot be accepted.",
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

	if (current.activeTurnId !== undefined && request.turnId !== current.activeTurnId) {
		return {
			resolution: "cancelled",
			requestId: request.requestId,
			code: "binding-mismatch",
			reason: "Native approval request does not match the currently active turn.",
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

	if (decision === null || decision === undefined || !isPlainJsonObjectV0(decision)) {
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

	if (
		typeof nowMs !== "number" ||
		typeof decision.decidedAtMs !== "number" ||
		typeof decision.expiresAtMs !== "number" ||
		!Number.isFinite(nowMs) ||
		!Number.isFinite(decision.decidedAtMs) ||
		!Number.isFinite(decision.expiresAtMs) ||
		decision.decidedAtMs > decision.expiresAtMs ||
		nowMs >= decision.expiresAtMs
	) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "decision-expired",
			reason: "Native approval decision has expired or carries non-finite timestamps.",
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
	if (decision.decision !== "accept") {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "operator-declined",
			reason: "Unrecognized native approval decision value fails closed.",
			grantsEndophasiaAuthority: false,
		};
	}

	// Scope broadening check (closed lookup against null-prototype SCOPE_RANK).
	if (!Object.hasOwn(SCOPE_RANK, request.requestedScope) || !Object.hasOwn(SCOPE_RANK, decision.approvedScope)) {
		return {
			resolution: "declined",
			requestId: request.requestId,
			code: "scope-broadening-refused",
			reason: "Native approval with unknown requested or approved scope cannot be accepted.",
			grantsEndophasiaAuthority: false,
		};
	}
	const requestedRank = SCOPE_RANK[request.requestedScope as keyof typeof SCOPE_RANK];
	const approvedRank = SCOPE_RANK[decision.approvedScope as keyof typeof SCOPE_RANK];
	if (approvedRank > requestedRank) {
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
	#lastObservedSequence = 0;
	#highWaterSequence = 0;
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
		this.#lastObservedSequence = 0;
		this.#highWaterSequence = 0;
		this.#seenIds.clear();
	}

	setSessionKey(sessionKey: string | null): void {
		this.#sessionKey = sessionKey;
	}

	get currentInstanceId(): string {
		return this.#instanceId;
	}

	/** Allocate the next strictly monotonic sequence number for the current connection instance (coordinated with generated gaps). */
	allocateSequence(): number {
		this.#highWaterSequence += 1;
		return this.#highWaterSequence;
	}

	#makeGap(
		gap: Extract<EndoDevelopObservationV0["body"], { kind: "evidence-gap" }>["gap"],
		reason: string,
		observedAt: string,
	): EndoDevelopObservationV0 {
		this.#gapCounter += 1;
		this.#highWaterSequence += 1;
		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
			observationId: `gap:${this.#instanceId}:${this.#gapCounter}`,
			source: this.#source,
			sessionKey: this.#sessionKey,
			attachmentId: this.#attachmentId,
			instanceId: this.#instanceId,
			sequence: this.#highWaterSequence,
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
		if (observation.source !== this.#source || observation.attachmentId !== this.#attachmentId) {
			return { accepted: null, gaps: [] };
		}
		if (this.#sessionKey !== null && observation.sessionKey !== null && observation.sessionKey !== this.#sessionKey) {
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
		if (observation.sequence <= this.#lastObservedSequence) {
			gaps.push(
				this.#makeGap(
					"out-of-order-event",
					`Observation ${observation.observationId} arrived with sequence ${observation.sequence} after ${this.#lastObservedSequence}.`,
					observation.observedAt,
				),
			);
		} else {
			this.#lastObservedSequence = observation.sequence;
			this.#highWaterSequence = Math.max(this.#highWaterSequence, observation.sequence);
		}
		return { accepted: observation, gaps };
	}
}
