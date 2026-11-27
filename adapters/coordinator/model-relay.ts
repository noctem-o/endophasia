// The Coordinator's bounded model relay, generalised from M0's fixed `127.0.0.1:8091` binding to one validated loopback target (M1-D).
// The generic relay is adapters/sandbox/model-relay.ts (shared with protected evaluation, unchanged); this module only says what the
// Coordinator admits through it. A target is fixed before the briefing starts and frozen: nothing a model or a tool returns can change
// the upstream origin, the model, the generation bound or the tool surface. Every M0 invariant is kept: one route, one model, one
// `endophasia_status` definition, the per-turn bearer, exact request and response gates (wire.ts), two exchanges, byte and connection
// bounds, no redirect following (the response gate admits only a 200 event stream), and no credential of any provider.

import {
	type EndoCoordinatorModelPoolMemberV0,
	endoCoordinatorLoopbackOriginV0,
} from "../../protocol/coordinator-model-pool.ts";
import {
	ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1,
	type EndoCoordinatorReasoningControlV1,
	type EndoCoordinatorResourceProfileV1,
	validateEndoCoordinatorResourceProfileV1,
} from "../../protocol/coordinator-resource-policy.ts";
import type { EndoCaptureLogV0 } from "../openai-proxy/capture-log.ts";
import { type EndoModelRelayPolicyV0, type EndoModelRelayV0, startModelRelayV0 } from "../sandbox/model-relay.ts";
import { COORDINATOR_INFERENCE_V0, coordinatorWireV0, type EndoCoordinatorWireInferenceV0 } from "./wire.ts";

export const ENDO_COORDINATOR_ROUTE_V0 = "/v1/chat/completions";

export interface EndoCoordinatorModelTargetV0 {
	/** Exactly `http://127.0.0.1:<port>`. */
	readonly origin: string;
	readonly model: string;
	readonly maxOutputTokens: number;
	readonly maxPromptBytes: number;
	readonly timeoutMs: number;
	/**
	 * Refuse a streamed response whose `model` names another model (`model-identity-mismatch`). On for pool members; off for the M0
	 * target so the default path's wire behaviour is unchanged.
	 */
	readonly pinResponseModel: boolean;
	/**
	 * Enforce `timeoutMs` on the host: abort the agent at the deadline and refuse any result that arrives after it
	 * (`inference-timeout`). On for pool members; off for the M0 target, whose 135 s agent timeout and 155 s kill are unchanged.
	 */
	readonly hostDeadline: boolean;
	/** Optional context-window declaration for OpenClaw client-side guard (defaults to 32,768 when unset). */
	readonly contextWindowTokens?: number;
	/** Optional relay byte transfer cap (defaults to 8 MiB when unset; scales up for deep/extended profiles). */
	readonly relayMaxTransferredBytes?: number;
	/** Optional explicit reasoning control (`unchanged` by default). */
	readonly reasoningControl?: EndoCoordinatorReasoningControlV1;
}

/** M0's binding, unchanged: the default when no pool is given. */
export const ENDO_COORDINATOR_M0_TARGET_V0: EndoCoordinatorModelTargetV0 = Object.freeze({
	origin: "http://127.0.0.1:8091",
	model: "Inkling-2-Mini-Uncensored-AD-Q4_K",
	maxOutputTokens: COORDINATOR_INFERENCE_V0.max_tokens,
	maxPromptBytes: 8192,
	timeoutMs: 135_000,
	pinResponseModel: false,
	hostDeadline: false,
});

/** The frozen target for a validated local member. Throws for a hosted member: M1 has no hosted execution. */
export function coordinatorTargetFromMemberV0(
	member: EndoCoordinatorModelPoolMemberV0,
	resourceProfile?: EndoCoordinatorResourceProfileV1,
): EndoCoordinatorModelTargetV0 {
	if (member.kind !== "local-openai-compat" || member.advisoryOnly !== true)
		throw new TypeError("only a local advisory member can be a Coordinator inference target in M1");
	if (!endoCoordinatorLoopbackOriginV0(member.endpoint).ok)
		throw new TypeError("the member's endpoint is not the IPv4 loopback");
	if (resourceProfile !== undefined) {
		const validated = validateEndoCoordinatorResourceProfileV1(resourceProfile);
		if (validated.tier === "reflex")
			throw new TypeError('cannot create an inference target under non-inference tier "reflex"');
		if (member.maxOutputTokens > validated.maxOutputTokensPerRequest)
			throw new TypeError("member maxOutputTokens exceeds governed resourceProfile ceiling");
		if (member.timeoutMs > validated.modelExecutionTimeoutMs)
			throw new TypeError("member timeoutMs exceeds governed resourceProfile ceiling");
		return Object.freeze({
			origin: member.endpoint,
			model: member.modelId,
			maxOutputTokens: member.maxOutputTokens,
			maxPromptBytes: member.maxPromptBytes,
			timeoutMs: member.timeoutMs,
			pinResponseModel: true,
			hostDeadline: true,
			contextWindowTokens: validated.contextWindowTokens,
			relayMaxTransferredBytes: validated.relayMaxTransferredBytes,
			reasoningControl: validated.reasoningControl,
		});
	}
	return Object.freeze({
		origin: member.endpoint,
		model: member.modelId,
		maxOutputTokens: member.maxOutputTokens,
		maxPromptBytes: member.maxPromptBytes,
		timeoutMs: member.timeoutMs,
		pinResponseModel: true,
		hostDeadline: true,
	});
}

export type EndoCoordinatorInferenceV0 = EndoCoordinatorWireInferenceV0;

/** The exact inference parameters the wire admits for a target: M0's, with the target's generation bound and explicit reasoning control. */
export function coordinatorInferenceForV0(target: EndoCoordinatorModelTargetV0): EndoCoordinatorInferenceV0 {
	const control = target.reasoningControl;
	if (control?.mode === "reasoning-effort") {
		return Object.freeze({
			...COORDINATOR_INFERENCE_V0,
			max_tokens: target.maxOutputTokens,
			reasoning_effort: control.effort,
		});
	}
	if (control?.mode === "reasoning-budget-tokens") {
		return Object.freeze({
			...COORDINATOR_INFERENCE_V0,
			max_tokens: target.maxOutputTokens,
			reasoning_budget_tokens: control.tokens,
		});
	}
	return Object.freeze({ ...COORDINATOR_INFERENCE_V0, max_tokens: target.maxOutputTokens });
}

export function coordinatorRelayPolicyV0(target: EndoCoordinatorModelTargetV0): EndoModelRelayPolicyV0 {
	const maxTransferredBytes = target.relayMaxTransferredBytes ?? 8 * 1024 * 1024;
	if (
		!Number.isSafeInteger(maxTransferredBytes) ||
		maxTransferredBytes < 1 ||
		maxTransferredBytes > ENDO_COORDINATOR_RESOURCE_GLOBAL_CEILINGS_V1.maxRelayTransferredBytes
	) {
		throw new TypeError("target relayMaxTransferredBytes exceeds governed ceiling");
	}
	return {
		routes: [{ method: "POST", path: ENDO_COORDINATOR_ROUTE_V0 }],
		model: target.model,
		maxRequestBytes: 512 * 1024,
		maxTransferredBytes,
		maxConnections: 4,
		maxTotalConnections: 8,
		maxExchanges: 2,
		maxCompletionTokens: target.maxOutputTokens,
	};
}

/** Start the relay for one briefing: the generic relay to the target's origin, narrowed by the Coordinator's wire gates. */
export async function startCoordinatorModelRelayV0(options: {
	readonly target: EndoCoordinatorModelTargetV0;
	readonly projectId: string;
	readonly toolText: string;
	readonly bearer: string;
	readonly runtimeDirectory: string;
	readonly log: EndoCaptureLogV0;
	readonly onRefused?: () => void;
}): Promise<{ readonly relay: EndoModelRelayV0; readonly wire: ReturnType<typeof coordinatorWireV0> }> {
	const target = Object.freeze({ ...options.target });
	if (!endoCoordinatorLoopbackOriginV0(target.origin).ok)
		throw new TypeError("the Coordinator relay's upstream must be the IPv4 loopback");
	const wire = coordinatorWireV0(options.projectId, options.toolText, options.bearer, options.onRefused, {
		inference: coordinatorInferenceForV0(target),
		...(target.pinResponseModel ? { model: target.model } : {}),
	});
	const relay = await startModelRelayV0({
		upstream: target.origin,
		log: options.log,
		runtimeDirectory: options.runtimeDirectory,
		policy: coordinatorRelayPolicyV0(target),
		additionalAdmission: { request: wire.request, response: wire.response },
	});
	return { relay, wire };
}
