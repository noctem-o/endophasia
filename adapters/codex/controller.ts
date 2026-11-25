/**
 * Milestone D4 — Strict-only governing controller for live Codex App Server sessions (`codex-live-controller`).
 *
 * Enforces the seven-fact authority separation at the actual operator approval boundary:
 * - Never auto-approves operations; requires an explicit `CodexOperationApproverV0` decision per action.
 * - Strict-only: only mints `"terminal-phrase"` or `"terminal-code"` proofs (NEVER `"session-grant"`).
 * - Binds each proof to the exact `(source, sessionKey, attachmentId, launchId, instanceId, controlPath, projectScope,
 *   operation, payloadDigest)` captured BEFORE awaiting operator confirmation, with a short bounded TTL.
 * - Serializes operator approval prompts one at a time and re-verifies TOCTOU invariants inside `adapter.dispatch()`.
 * - Never executes prepared attempts (E2 scope) and never silently emulates unsupported operations (`queue`, `native-command`, `resume`).
 */

import { randomBytes } from "node:crypto";
import {
	type EndoDevelopAuthorityProofV0,
	type EndoDevelopDispatchOutcomeV0,
	type EndoDevelopNativeApprovalDecisionV0,
	type EndoDevelopNativeApprovalRequestV0,
	type EndoDevelopOperationRequestV0,
	endoAdapterSessionKeyV0,
} from "../../protocol/develop-adapter.ts";
import { endoDevelopOperationPayloadDigestV0 } from "../../runtime/contracts/develop-adapter.ts";
import { CODEX_LIVE_CONTROL_PATH_V0, type CodexDevelopAdapterV0 } from "./develop-adapter.ts";

export interface CodexApprovalPromptV0 {
	readonly operation: "prompt" | "steer" | "stop";
	readonly sessionKey: string;
	readonly threadId: string;
	readonly instanceId: string;
	readonly projectScope: string;
	readonly payloadDigest: string;
	readonly targetTurnId: string | null;
	readonly preview: string;
	/** Exact confirmation phrase expected on the controlling terminal. */
	readonly requiredPhrase: string;
}

export type CodexOperationApproverV0 = (
	prompt: CodexApprovalPromptV0,
	signal: AbortSignal,
) => Promise<
	| { readonly approved: true; readonly mechanism: "terminal-phrase" | "terminal-code" }
	| { readonly approved: false; readonly reason: string }
>;

export interface CodexLiveControllerStatusV0 {
	readonly source: "codex-live";
	readonly controlPath: typeof CODEX_LIVE_CONTROL_PATH_V0;
	readonly version: string | null;
	readonly fingerprintConfidence: "strong" | "reduced" | "unidentified";
	readonly connection: "connected" | "disconnected" | "reconnecting" | "unknown" | "not-applicable";
	readonly connectionReason: string | null;
	readonly launchId: string;
	readonly sessionKey: string | null;
	readonly threadId: string | null;
	readonly sessionTreeId: string | null;
	readonly projectScope: string | null;
	readonly activeTurnId: string | null;
	readonly pendingNativeApprovalCount: number;
	readonly capabilities: {
		readonly prompt: { readonly admitted: boolean; readonly reason: string | null };
		readonly steer: { readonly admitted: boolean; readonly reason: string | null };
		readonly stop: { readonly admitted: boolean; readonly reason: string | null };
	};
}

export interface CodexLiveControllerOptionsV0 {
	readonly adapter: CodexDevelopAdapterV0;
	readonly approveOperation: CodexOperationApproverV0;
	/** Proof TTL in ms after approval. Default: 60_000 ms. */
	readonly approvalTtlMs?: number;
	/** Clock override for deterministic tests. */
	readonly now?: () => number;
}

/** Build an explicit single-use operator native-approval decision bound to one pending Codex ServerRequest. */
export function buildCodexNativeApprovalDecisionV0(args: {
	readonly request: EndoDevelopNativeApprovalRequestV0;
	readonly decision: "accept" | "decline" | "cancel";
	readonly nowMs?: number;
	readonly ttlMs?: number;
}): EndoDevelopNativeApprovalDecisionV0 {
	const nowMs = args.nowMs ?? Date.now();
	const ttlMs = args.ttlMs ?? 60_000;
	return {
		requestId: args.request.requestId,
		source: args.request.source,
		sessionKey: args.request.sessionKey,
		instanceId: args.request.instanceId,
		turnId: args.request.turnId,
		itemId: args.request.itemId,
		decision: args.decision,
		// Codex v0 native approvals are strictly one-time only; never session or policy-amendment.
		approvedScope: "once",
		basis: "explicit-operator-native-approval",
		decidedAtMs: nowMs,
		expiresAtMs: nowMs + ttlMs,
	};
}

const sanitizePreview = (text: string, max = 160): string =>
	text
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
		.trim()
		.slice(0, max);

/**
 * Strict-only governing controller for one `CodexDevelopAdapterV0`.
 */
export class CodexLiveControllerV0 {
	readonly adapter: CodexDevelopAdapterV0;
	readonly #approve: CodexOperationApproverV0;
	readonly #ttlMs: number;
	readonly #now: () => number;
	#approvalQueue: Promise<unknown> = Promise.resolve();

	constructor(options: CodexLiveControllerOptionsV0) {
		this.adapter = options.adapter;
		this.#approve = options.approveOperation;
		this.#ttlMs = options.approvalTtlMs ?? 60_000;
		this.#now = options.now ?? Date.now;
	}

	/** Project current operational status for CLI display or neutral DEVELOP presentation (`presentLiveCodex`). */
	status(): CodexLiveControllerStatusV0 {
		const d = this.adapter.describe();
		const s = this.adapter.snapshot();
		const isAdmitted = (standing: string) => standing === "admitted" || standing === "admitted-partial";
		const stale = d.evidenceFreshness.status !== "current" ? d.evidenceFreshness.reason : null;
		return {
			source: "codex-live",
			controlPath: CODEX_LIVE_CONTROL_PATH_V0,
			version: d.harness.observedVersion,
			fingerprintConfidence:
				d.runtimeFingerprint.status === "identified" ? d.runtimeFingerprint.confidence : "unidentified",
			connection: s.connection.state,
			connectionReason: s.connection.reason,
			launchId: d.attachment.launchId,
			sessionKey: endoAdapterSessionKeyV0(d.session),
			threadId: d.session.nativeRef?.kind === "codex-thread" ? d.session.nativeRef.threadId : null,
			sessionTreeId: d.session.nativeRef?.kind === "codex-thread" ? d.session.nativeRef.sessionTreeId : null,
			projectScope: d.attachment.projectScope,
			activeTurnId: s.activeTurn?.turnId ?? null,
			pendingNativeApprovalCount: s.pendingNativeApprovalCount,
			capabilities: {
				prompt: {
					admitted: stale === null && isAdmitted(d.operations.prompt.capability.standing),
					reason: stale ?? d.operations.prompt.capability.reason,
				},
				steer: {
					admitted: stale === null && isAdmitted(d.operations.steer.capability.standing),
					reason: stale ?? d.operations.steer.capability.reason,
				},
				stop: {
					admitted: stale === null && isAdmitted(d.operations.stop.capability.standing),
					reason: stale ?? d.operations.stop.capability.reason,
				},
			},
		};
	}

	/** Request operator terminal approval and dispatch a prompt (`turn/start`). */
	requestPrompt(message: string, signal?: AbortSignal): Promise<EndoDevelopDispatchOutcomeV0> {
		return this.#requestGoverned({ kind: "prompt", message }, signal);
	}

	/** Request operator terminal approval and dispatch a targeted interruption (`turn/interrupt`). */
	requestStop(targetTurnId: string, signal?: AbortSignal): Promise<EndoDevelopDispatchOutcomeV0> {
		return this.#requestGoverned({ kind: "stop", targetTurnId }, signal);
	}

	/** Request operator terminal approval and dispatch a targeted steer (`turn/steer`, only when admitted). */
	requestSteer(message: string, targetTurnId: string, signal?: AbortSignal): Promise<EndoDevelopDispatchOutcomeV0> {
		return this.#requestGoverned({ kind: "steer", message, targetTurnId }, signal);
	}

	#requestGoverned(
		request: Extract<EndoDevelopOperationRequestV0, { kind: "prompt" | "steer" | "stop" }>,
		signal?: AbortSignal,
	): Promise<EndoDevelopDispatchOutcomeV0> {
		const task = this.#approvalQueue.then(() => this.#runGoverned(request, signal));
		this.#approvalQueue = task.catch(() => {});
		return task;
	}

	async #runGoverned(
		request: Extract<EndoDevelopOperationRequestV0, { kind: "prompt" | "steer" | "stop" }>,
		signal?: AbortSignal,
	): Promise<EndoDevelopDispatchOutcomeV0> {
		const d = this.adapter.describe();
		const s = this.adapter.snapshot();
		const sessionKey = endoAdapterSessionKeyV0(d.session);
		const threadId = d.session.nativeRef?.kind === "codex-thread" ? d.session.nativeRef.threadId : null;
		const projectScope = d.attachment.projectScope;

		if (s.connection.state !== "connected" || sessionKey === null || threadId === null || projectScope === null) {
			return {
				status: "refused",
				operation: request.kind,
				stage: "admission",
				code: "not-connected",
				reason: s.connection.reason ?? "Codex session is not connected to an owned thread.",
			};
		}

		let payloadDigest: string;
		try {
			payloadDigest = endoDevelopOperationPayloadDigestV0(request);
		} catch {
			return {
				status: "refused",
				operation: request.kind,
				stage: "admission",
				code: "invalid-request",
				reason: "Request payload could not be canonicalized.",
			};
		}

		// Pre-check admission (using a probe proof shape) BEFORE bothering the operator with an un-admissible request.
		const nowPre = this.#now();
		const preAuthId = `endo.evidence.codex-auth.${randomBytes(12).toString("hex")}`;
		const preProof: EndoDevelopAuthorityProofV0 = {
			authorizationId: preAuthId,
			operation: request.kind,
			source: "codex-live",
			sessionKey,
			attachmentId: d.attachment.attachmentId,
			launchId: d.attachment.launchId,
			instanceId: d.attachment.instanceId,
			controlPath: CODEX_LIVE_CONTROL_PATH_V0,
			projectScope,
			payloadDigest,
			mechanism: "terminal-phrase",
			sessionGrantId: null,
			authorizedAtMs: nowPre,
			expiresAtMs: nowPre + this.#ttlMs,
		};
		const preCheck = this.adapter.admitOperation(request, preProof, { mode: "production", nowMs: nowPre });
		if (!preCheck.admitted) {
			return {
				status: "refused",
				operation: request.kind,
				stage: "admission",
				code: preCheck.code,
				reason: preCheck.reason,
			};
		}

		const shortDigest = payloadDigest.slice(0, 6);
		const targetTurnId = request.kind === "prompt" ? null : (request.targetTurnId ?? null);
		const requiredPhrase =
			request.kind === "prompt"
				? `APPROVE PROMPT ${shortDigest}`
				: request.kind === "stop"
					? `APPROVE STOP ${shortDigest}`
					: `APPROVE STEER ${shortDigest}`;
		const preview =
			request.kind === "stop"
				? `Interrupt active turn ${targetTurnId ?? "(missing)"}`
				: sanitizePreview(request.message, 160);

		if (signal?.aborted) {
			return {
				status: "refused",
				operation: request.kind,
				stage: "admission",
				code: "missing-authority",
				reason: "Authorization request aborted before approval.",
			};
		}

		const abort = new AbortController();
		const onExternalAbort = () => abort.abort();
		signal?.addEventListener("abort", onExternalAbort, { once: true });
		try {
			const decision = await this.#approve(
				{
					operation: request.kind,
					sessionKey,
					threadId,
					instanceId: d.attachment.instanceId,
					projectScope,
					payloadDigest,
					targetTurnId,
					preview,
					requiredPhrase,
				},
				abort.signal,
			);
			if (signal?.aborted || abort.signal.aborted) {
				return {
					status: "refused",
					operation: request.kind,
					stage: "admission",
					code: "missing-authority",
					reason: "Authorization request aborted before dispatch.",
				};
			}
			if (!decision.approved) {
				return {
					status: "refused",
					operation: request.kind,
					stage: "admission",
					code: "missing-authority",
					reason: decision.reason || "Operator declined authorization.",
				};
			}
			const authorizedAtMs = this.#now();
			const proof: EndoDevelopAuthorityProofV0 = {
				...preProof,
				mechanism: decision.mechanism,
				authorizedAtMs,
				expiresAtMs: authorizedAtMs + this.#ttlMs,
			};
			// TOCTOU re-verification happens inside adapter.dispatch() against live descriptor & snapshot.
			return await this.adapter.dispatch(request, proof, { mode: "production", nowMs: authorizedAtMs });
		} finally {
			signal?.removeEventListener("abort", onExternalAbort);
		}
	}
}
