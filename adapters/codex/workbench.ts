// Codex workbench broker: serves a single governed live Codex App Server session to Endophasia Studio's DEVELOP workspace.
//
// Authority & security invariants (DEVELOP-CODEX-STUDIO-001):
//  - Implements `EndoCockpitWorkbenchV0` (`protocol/workbench-http.ts`), reusing the existing loopback `cockpit-http/server.ts`
//    guards (127.0.0.1, Host, Origin, Fetch Metadata, no CORS, JSON content-type, 40 KiB cap, capability URL, CSP, no-store).
//  - Strict-only: EVERY prompt (`turn/start`), stop (`turn/interrupt`), and steer (`turn/steer`) flows exclusively through
//    `CodexLiveControllerV0` and requires explicit single-use controlling-terminal confirmation. Never mints Everyday grants,
//    never bypasses `CodexLiveControllerV0`, and never calls App Server RPCs directly.
//  - Native Codex approvals (`ServerRequest`s) remain strictly terminal-authorized inside `CodexDevelopAdapterV0`. This broker
//    exposes ONLY read-only bounded summaries to a paired page (never when unpaired) and has NO browser approval route.
//  - Prepared-attempt execution (`attempt/propose`) and Pi-style `queue` remain explicitly unsupported for Codex in v0.
//  - Memory-only live transcript (`CodexLiveTranscriptV0`) is served only to a paired page and cleared on disconnect/disposal.

import { createHash, randomBytes } from "node:crypto";
import { ENDO_DEVELOP_WORKSPACE_ABSENT_V1 } from "../../protocol/develop-tasks.ts";
import { ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 } from "../../protocol/workbench.ts";
import type { EndoCockpitWorkbenchRequestV0, EndoCockpitWorkbenchV0 } from "../../protocol/workbench-http.ts";
import { endoDevelopOperationPayloadDigestV0 } from "../../runtime/contracts/develop-adapter.ts";
import type { DevelopLaunchHostV0, DevelopLaunchWorkspaceV0 } from "../../runtime/contracts/develop-workspace.ts";
import {
	type EndoExecutionProtectionV0,
	endoObserveProtectionV0,
} from "../../runtime/contracts/execution-protection.ts";
import { EndoPairingV0 } from "../../runtime/contracts/workbench-pairing.ts";
import {
	type EndoProjectSourceV0,
	EndoWorkspaceRoutesV0,
	endoProjectRouteV0,
} from "../../runtime/contracts/workspace-routes.ts";
import { type CodexApprovalPromptV0, CodexLiveControllerV0, type CodexOperationApproverV0 } from "./controller.ts";
import type { CodexDevelopAdapterV0 } from "./develop-adapter.ts";
import { codexEndoSessionIdV0 } from "./events.ts";
import { CodexLiveTranscriptV0, LIVE_TRANSCRIPT_SCHEMA_V3 } from "./live-transcript.ts";
import { CODEX_MAX_APPROVAL_SUMMARY_CHARS_V0 } from "./native-approvals.ts";

export const CODEX_WORKBENCH_STATUS_SCHEMA_V0 = "endo.workbench-status.v0";
export const CODEX_WORKBENCH_APPROVAL_WINDOW_MS_V0 = 120_000;

export interface CodexWorkbenchUsageSummaryV0 {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number | null;
	readonly cacheWriteTokens: number | null;
	readonly reasoningTokens: number | null;
	readonly totalTokens: number;
	readonly costUsd: number | null;
}

export interface CodexWorkbenchPendingApprovalV0 {
	readonly requestId: string;
	readonly approvalKind: string;
	readonly nativeMethod: string;
	readonly requestedScope: string;
	readonly turnId: string | null;
	readonly itemId: string | null;
	readonly summary: string;
}

export interface CodexWorkbenchRecentApprovalV0 {
	readonly requestId: string;
	readonly approvalKind: string;
	readonly nativeMethod: string;
	readonly resolution: "accepted" | "declined" | "cancelled";
	readonly code: string | null;
	readonly resolvedAtMs: number;
}

export interface CodexWorkbenchInfoV0 {
	readonly version: string | null;
	readonly fingerprintConfidence: "strong" | "reduced" | "unidentified";
	readonly model: string | null;
	readonly reasoningEffort: string | null;
	readonly sandbox: string | null;
	readonly approvalPolicy: string | null;
	readonly approvalsReviewer: string | null;
	readonly threadId: string | null;
	readonly activeTurnId: string | null;
	readonly connectionReason: string | null;
	readonly usage: {
		readonly last: CodexWorkbenchUsageSummaryV0 | null;
		readonly total: CodexWorkbenchUsageSummaryV0 | null;
		readonly modelContextWindow: number | null;
	} | null;
	readonly pendingNativeApprovals: readonly CodexWorkbenchPendingApprovalV0[];
	readonly recentNativeApprovals: readonly CodexWorkbenchRecentApprovalV0[];
}

export type CodexWorkbenchCommandStateV0 = "awaiting-approval" | "dispatching" | "accepted" | "refused" | "unknown";
export type CodexWorkbenchInterventionStateV0 =
	| "awaiting-approval"
	| "dispatching"
	| "sent"
	| "accepted"
	| "refused"
	| "unknown";

export interface CodexWorkbenchCommandViewV0 {
	proposalId: string;
	state: CodexWorkbenchCommandStateV0;
	approved: boolean;
	authorizedBy: "terminal" | "session-grant" | null;
	reason: string | null;
	disposition: "started" | "queued" | "handled" | null;
	bytes: number;
	digestPrefix: string;
	expiresAtMs: number;
	attempt: null;
}

export interface CodexWorkbenchInterventionViewV0 {
	proposalId: string;
	operation: "steer" | "queue" | "stop";
	state: CodexWorkbenchInterventionStateV0;
	approved: boolean;
	authorizedBy: "terminal" | "session-grant" | null;
	reason: string | null;
	disposition: "started" | "queued" | "handled" | null;
	bytes: number | null;
	digestPrefix: string;
	expiresAtMs: number;
	afterSeq: number;
	runEnded: "completed" | "aborted" | "failed" | "unclassified" | null;
	consumption: null;
}

export interface CodexWorkbenchApprovalContextV0 {
	readonly prompt: CodexApprovalPromptV0;
	readonly fullMessage: string | null;
	readonly proposalId: string;
	readonly digestPrefix: string;
	readonly expiresAtMs: number;
	readonly requestedFrom: "page" | "terminal";
}

export type CodexWorkbenchApproverV0 = (
	context: CodexWorkbenchApprovalContextV0,
	signal: AbortSignal,
) => Promise<
	| { readonly approved: true; readonly mechanism: "terminal-phrase" | "terminal-code" }
	| { readonly approved: false; readonly reason: string }
>;

export interface CodexWorkbenchBrokerOptionsV0 {
	readonly adapter: CodexDevelopAdapterV0;
	readonly approver: CodexWorkbenchApproverV0;
	readonly project?: EndoProjectSourceV0;
	readonly tasks?: { open(host: DevelopLaunchHostV0): DevelopLaunchWorkspaceV0 };
	readonly protection?: EndoExecutionProtectionV0;
	readonly aliasOf?: (sessionId: string) => string;
	readonly approvalWindowMs?: number;
	readonly now?: () => number;
}

interface ActivePromptRecord {
	readonly view: CodexWorkbenchCommandViewV0;
	readonly grant: string | null;
	readonly sessionKey: string;
	readonly instanceId: string;
	readonly abort: AbortController;
	withdrawn: boolean;
	timedOut: boolean;
	grantLost: boolean;
}

interface ActiveInterventionRecord {
	readonly view: CodexWorkbenchInterventionViewV0;
	readonly grant: string | null;
	readonly sessionKey: string;
	readonly instanceId: string;
	readonly targetTurnId: string;
	readonly abort: AbortController;
	withdrawn: boolean;
	timedOut: boolean;
	superseded: boolean;
	grantLost: boolean;
}

interface ApprovalBridgeContext {
	readonly kind: "prompt" | "steer" | "stop";
	readonly record: ActivePromptRecord | ActiveInterventionRecord;
	readonly proposalId: string;
	readonly digestPrefix: string;
	fullMessage: string | null;
	readonly expiresAtMs: number;
}

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const NONCES_KEPT = 256;
const INTERVENTIONS_KEPT = 40;
// Exact match with Pi's safe-prompt check (`adapters/pi/workbench.ts`): forbid all C0/C1/DEL/CR/LS/PS/bidi controls (allowing \n and \t).
const UNSAFE_PROMPT_CHARS_V0 = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const OPEN_INTERVENTION = new Set<CodexWorkbenchInterventionStateV0>(["awaiting-approval", "dispatching", "sent"]);

const reply = (status: number, body: unknown) => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeDisplay(value: string, max: number): string {
	return value.replace(UNSAFE_DISPLAY_CHARS, " ").trim().slice(0, max);
}

function summarizeSandbox(sandbox: unknown): string | null {
	if (typeof sandbox === "string") return sanitizeDisplay(sandbox, 64) || null;
	if (isRecord(sandbox) && typeof sandbox.type === "string") return sanitizeDisplay(sandbox.type, 64) || null;
	return null;
}

function summarizeScalarPolicy(value: unknown): string | null {
	if (typeof value === "string") return sanitizeDisplay(value, 64) || null;
	if (isRecord(value)) return "structured";
	return null;
}

function mapPromptRefusalCode(code: string | undefined): string {
	switch (code) {
		case "not-connected":
		case "stale-attachment":
		case "session-mismatch":
			return "session-ended";
		case "run-active":
			return "run-active";
		case "capability-unavailable":
		case "unsupported-operation":
		case "stale-evidence":
			return "capability-unavailable";
		case "missing-authority":
		case "invalid-authority-scope":
		case "authority-expired":
		case "authority-replayed":
		case "payload-digest-mismatch":
			return "authorization-denied";
		default:
			return "runtime-refused";
	}
}

function mapInterventionRefusalCode(code: string | undefined): string {
	switch (code) {
		case "not-connected":
		case "stale-attachment":
			return "session-ended";
		case "run-active":
			return "run-active";
		case "no-active-run":
		case "target-turn-required":
		case "target-turn-mismatch":
			return "no-active-run";
		case "capability-unavailable":
		case "unsupported-operation":
		case "stale-evidence":
			return "capability-unavailable";
		case "missing-authority":
		case "invalid-authority-scope":
		case "authority-expired":
		case "authority-replayed":
		case "payload-digest-mismatch":
			return "authorization-denied";
		case "session-mismatch":
			return "proposal-for-another-session";
		case "runtime-refused":
			return "runtime-refused";
		default:
			return "runtime-refused";
	}
}

export class CodexWorkbenchBrokerV0 implements EndoCockpitWorkbenchV0 {
	readonly #adapter: CodexDevelopAdapterV0;
	readonly #approver: CodexWorkbenchApproverV0;
	readonly #project: EndoProjectSourceV0 | undefined;
	readonly #aliasOf: ((sessionId: string) => string) | undefined;
	readonly #protection: EndoExecutionProtectionV0 | undefined;
	readonly #approvalWindowMs: number;
	readonly #now: () => number;
	readonly #pairing: EndoPairingV0;
	readonly #tasks: EndoWorkspaceRoutesV0 | null;
	readonly transcript: CodexLiveTranscriptV0;
	readonly controller: CodexLiveControllerV0;

	readonly #stopObservations: () => void;
	readonly #stopDeltas: () => void;

	#command: ActivePromptRecord | null = null;
	readonly #promptNonces = new Map<string, { view: CodexWorkbenchCommandViewV0; grant: string }>();
	readonly #interventions = new Map<string, ActiveInterventionRecord>();
	readonly #interventionNonces = new Map<string, { record: ActiveInterventionRecord; grant: string }>();
	#ended = false;
	#disposed = false;
	#closing = false;

	constructor(options: CodexWorkbenchBrokerOptionsV0) {
		this.#adapter = options.adapter;
		this.#approver = options.approver;
		this.#project = options.project;
		this.#aliasOf = options.aliasOf;
		this.#protection = options.protection;
		this.#approvalWindowMs = options.approvalWindowMs ?? CODEX_WORKBENCH_APPROVAL_WINDOW_MS_V0;
		this.#now = options.now ?? Date.now;
		this.#pairing = new EndoPairingV0({
			now: this.#now,
			pairingWindowMs: 10 * 60_000,
			grantMs: 60 * 60_000,
			closed: () => this.#disposed || this.#ended,
		});
		this.transcript = new CodexLiveTranscriptV0(() => this.#adapter.describe());

		const approveOperation: CodexOperationApproverV0 = async (prompt, signal, context) => {
			const ctx = (context as ApprovalBridgeContext | undefined) ?? null;
			const expiresAtMs = ctx?.expiresAtMs ?? this.#now() + this.#approvalWindowMs;
			const remainingMs = Math.max(1, expiresAtMs - this.#now());
			const timeout = AbortSignal.timeout(remainingMs);
			const combined = AbortSignal.any([signal, timeout]);
			const fullMessage = ctx?.fullMessage ?? null;
			let decision:
				| { readonly approved: true; readonly mechanism: "terminal-phrase" | "terminal-code" }
				| { readonly approved: false; readonly reason: string };
			try {
				decision = await this.#approver(
					{
						prompt,
						fullMessage,
						proposalId: ctx?.proposalId ?? `terminal:${prompt.operation}:${prompt.payloadDigest.slice(0, 12)}`,
						digestPrefix: ctx?.digestPrefix ?? prompt.payloadDigest.slice(0, 16),
						expiresAtMs,
						requestedFrom: ctx === null ? "terminal" : "page",
					},
					combined,
				);
			} finally {
				// Release private message text immediately once the approval prompt finishes.
				if (ctx !== null) ctx.fullMessage = null;
			}
			if (timeout.aborted && !signal.aborted) {
				if (ctx !== null) ctx.record.timedOut = true;
				return { approved: false, reason: "approval-timed-out" };
			}
			if (signal.aborted || !decision.approved) {
				return { approved: false, reason: decision.approved ? "aborted" : decision.reason };
			}
			// Re-verify broker-level invariants AFTER terminal approval and BEFORE returning `{ approved: true }` to the controller.
			if (this.#disposed || this.#ended || this.#closing) {
				return { approved: false, reason: "session-ended" };
			}
			if (ctx !== null) {
				if (ctx.record.withdrawn) return { approved: false, reason: "withdrawn" };
				if ("superseded" in ctx.record && ctx.record.superseded) {
					return { approved: false, reason: "superseded-by-stop" };
				}
				if (ctx.record.grant !== null && !this.#granted(ctx.record.grant)) {
					ctx.record.grantLost = true;
					return { approved: false, reason: "not-authorized" };
				}
				if (this.#now() > ctx.expiresAtMs) {
					ctx.record.timedOut = true;
					return { approved: false, reason: "approval-timed-out" };
				}
				const liveStatus = this.controller.status();
				if (
					liveStatus.connection !== "connected" ||
					liveStatus.sessionKey !== ctx.record.sessionKey ||
					this.#adapter.instanceId !== ctx.record.instanceId
				) {
					return { approved: false, reason: "session-ended" };
				}
				ctx.record.view.approved = true;
				ctx.record.view.authorizedBy = "terminal";
				ctx.record.view.state = "dispatching";
			}
			return decision;
		};

		this.controller = new CodexLiveControllerV0({
			adapter: this.#adapter,
			approveOperation,
			approvalTtlMs: Math.min(60_000, this.#approvalWindowMs),
			now: this.#now,
		});

		this.#tasks =
			options.tasks === undefined
				? null
				: new EndoWorkspaceRoutesV0(
						options.tasks.open({
							launchId: this.launchId,
							attachment: this.#adapter.describe().attachment.attachmentId,
							session: {
								source: "codex-live",
								current: () => {
									const id = this.#sessionId();
									return !this.#disposed && !this.#ended && id !== null ? { sessionId: id } : null;
								},
							},
							...(this.#aliasOf === undefined ? {} : { aliasOf: this.#aliasOf }),
						}),
					);

		this.#stopObservations = this.#adapter.subscribeObservations((obs) => {
			let fileChangeCount: number | null = null;
			if (obs.body.kind === "tool-activity" && obs.body.activityKind === "file-change" && obs.body.callId !== null) {
				const targetCallId = obs.body.callId;
				const liveAct = this.#adapter.liveView().activity.find((a) => a.itemId === targetCallId);
				const match = liveAct?.name.match(/^fileChange\((\d+)\)$/);
				if (match !== null && match !== undefined) fileChangeCount = Number(match[1]);
			}
			this.transcript.pushObservation(obs, { fileChangeCount });

			if (obs.body.kind === "lifecycle") {
				if (
					obs.body.event === "turn-completed" ||
					obs.body.event === "turn-interrupted" ||
					obs.body.event === "turn-failed"
				) {
					const endedTurnId = obs.nativeIds.turnId;
					const ending: "completed" | "aborted" | "failed" | "unclassified" =
						obs.body.event === "turn-completed"
							? "completed"
							: obs.body.event === "turn-interrupted"
								? "aborted"
								: obs.body.turnState === "failed"
									? "failed"
									: "unclassified";
					for (const rec of this.#interventions.values()) {
						const matchesTurn = endedTurnId === null || rec.targetTurnId === endedTurnId;
						if (matchesTurn && rec.view.runEnded === null) {
							rec.view.runEnded = ending;
						}
						// Abort any awaiting-approval stop/steer targeting the turn that just ended so it never blocks new prompts.
						if (matchesTurn && rec.view.state === "awaiting-approval") {
							rec.view.state = "refused";
							rec.view.reason = "no-active-run";
							rec.abort.abort("no-active-run");
						}
					}
				} else if (obs.body.event === "connection-lost" || obs.body.event === "session-detached") {
					this.endSession();
				}
			}
		});

		this.#stopDeltas = this.#adapter.subscribeTranscriptDeltas((delta) => {
			if (delta.instanceId !== this.#adapter.instanceId) return;
			this.transcript.pushDelta(delta);
		});
	}

	get launchId(): string {
		return this.#adapter.launchId;
	}

	/** Issue a single-use pairing code on the controlling terminal (never carries session control: Codex is Strict-only). */
	issuePairingCode(): { code: string; expiresAtMs: number } {
		return this.#pairing.issue();
	}

	/** Revoke the active pairing grant and abort any pending page-initiated approvals. */
	revokePairing(): void {
		this.#pairing.revoke();
		this.#abortPageRequests("grant-revoked");
	}

	/** End the live session view: immediately drop all private transcript text, revoke grants, and abort pending requests. */
	endSession(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#pairing.revoke();
		this.#abortAllRequests("session-ended");
		this.transcript.clear();
		this.#project?.dispose?.();
	}

	/** Stop accepting new requests while tearing down. */
	beginClose(): void {
		this.#closing = true;
		this.#abortAllRequests("closing");
	}

	/** Release all resources held by this broker. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#closing = true;
		this.#stopObservations();
		this.#stopDeltas();
		this.endSession();
		this.#command = null;
		this.#interventions.clear();
		this.#promptNonces.clear();
		this.#interventionNonces.clear();
		await Promise.resolve();
	}

	async handle(request: EndoCockpitWorkbenchRequestV0): Promise<{ status: number; body: unknown }> {
		const live = this.controller.status();
		if (live.connection !== "connected" && !this.#ended && this.#adapter.threadId !== null) {
			this.endSession();
		}
		const [a, b, ...more] = request.route;
		if (a === "status" && b === undefined && request.method === "GET" && request.query === "") {
			return reply(200, this.#status(this.#granted(request.grant)));
		}
		if (a === "pair" && b === undefined && request.method === "POST" && request.query === "") {
			const answer = this.#pairing.pair(isRecord(request.body) ? request.body.code : undefined);
			if (answer.status === 200) {
				// Re-pairing invalidates the prior grant; cancel any pending approvals from the old grant.
				this.#abortPageRequests("grant-revoked");
			}
			return answer;
		}
		// Everything below requires a live pairing grant.
		if (!this.#granted(request.grant)) return refuse(401, "grant-required");
		const grant = request.grant as string;

		if (a === "transcript" && b === undefined && request.method === "GET") {
			const match = /^after=(0|[1-9][0-9]{0,15})$/.exec(request.query);
			if (request.query !== "" && match === null) return refuse(400, "bad-request");
			const view = this.transcript.view(match === null ? 0 : Number(match[1]));
			return reply(200, { schemaVersion: LIVE_TRANSCRIPT_SCHEMA_V3, launchId: this.launchId, ...view });
		}
		if (a === "workspace") {
			if (this.#tasks === null) {
				return b === undefined && request.method === "GET" && request.query === ""
					? reply(200, ENDO_DEVELOP_WORKSPACE_ABSENT_V1)
					: refuse(404, "not-found");
			}
			const answer = await this.#tasks.route(request.route, request.method, request.query, request.body);
			return this.#granted(grant) ? answer : refuse(401, "grant-required");
		}
		if (a === "project") {
			const answer = await endoProjectRouteV0(this.#project, request.route, request.method, request.query);
			if (answer !== null) return this.#granted(grant) ? answer : refuse(401, "grant-required");
		}
		// Codex is Strict-only: no session control grant ever exists.
		if (
			a === "session-control" &&
			b === "revoke" &&
			more.length === 0 &&
			request.method === "POST" &&
			request.query === ""
		) {
			if (!isRecord(request.body) || Object.keys(request.body).length !== 0) return refuse(400, "bad-request");
			return refuse(409, "no-session-control");
		}
		// Prepared-attempt execution is explicitly out of scope for Codex in v0.
		if (
			a === "attempt" &&
			b === "propose" &&
			more.length === 0 &&
			request.method === "POST" &&
			request.query === ""
		) {
			if (
				!isRecord(request.body) ||
				Object.keys(request.body).join() !== "attemptId" ||
				typeof request.body.attemptId !== "string"
			) {
				return refuse(400, "bad-request");
			}
			return refuse(409, "not-offered");
		}
		if (a === "prompt" && b === "propose" && more.length === 0 && request.method === "POST" && request.query === "") {
			return this.#proposePrompt(grant, isRecord(request.body) ? request.body : null);
		}
		if (a === "prompt" && b === "discard" && more.length === 0 && request.method === "POST" && request.query === "") {
			return this.#discardPrompt(isRecord(request.body) ? request.body : null);
		}
		if (a === "prompt" && b !== undefined && more.length === 0 && request.method === "GET" && request.query === "") {
			return this.#command?.view.proposalId === b ? reply(200, { ...this.#command.view }) : refuse(404, "not-found");
		}
		if (a === "intervention" && b !== undefined && more.length === 0 && request.query === "") {
			const body = isRecord(request.body) ? request.body : null;
			if (request.method === "POST" && b === "propose") return this.#proposeIntervention(grant, body);
			if (request.method === "POST" && b === "discard") return this.#discardIntervention(body);
			if (request.method === "POST" && b === "check") return refuse(409, "not-offered");
			if (request.method === "GET") {
				const rec = this.#interventions.get(b);
				return rec === undefined ? refuse(404, "not-found") : reply(200, { ...rec.view });
			}
		}
		return refuse(404, "not-found");
	}

	// -------------------------------------------------------------------------------------------------------------
	// Prompt proposal & lifecycle
	// -------------------------------------------------------------------------------------------------------------

	#proposePrompt(grant: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
		const members = body === null ? "" : Object.keys(body).sort().join();
		if (body === null || (members !== "message" && members !== "message,nonce") || typeof body.message !== "string") {
			return refuse(400, "bad-request");
		}
		const nonce = members === "message" ? null : body.nonce;
		if (members !== "message") {
			if (typeof nonce !== "string" || !NONCE.test(nonce)) return refuse(400, "bad-request");
			const prior = this.#promptNonces.get(nonce);
			if (prior !== undefined)
				return prior.grant === grant ? reply(200, { ...prior.view }) : refuse(409, "not-offered");
		}
		const message = body.message;
		const byteLen = Buffer.byteLength(message, "utf8");
		if (
			message.trim().length === 0 ||
			byteLen > ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 ||
			UNSAFE_PROMPT_CHARS_V0.test(message)
		) {
			return refuse(400, "bad-request");
		}
		const offer = this.#promptOffer();
		if (!offer.offered) return refuse(409, "not-offered");

		const status = this.controller.status();
		if (status.sessionKey === null) return refuse(409, "not-offered");

		const digest = endoDevelopOperationPayloadDigestV0({ kind: "prompt", message });
		const proposalId = `endo.evidence.workbench-prompt-${randomBytes(16).toString("hex")}`;
		const expiresAtMs = this.#now() + this.#approvalWindowMs;
		const view: CodexWorkbenchCommandViewV0 = {
			proposalId,
			state: "awaiting-approval",
			approved: false,
			authorizedBy: null,
			reason: null,
			disposition: null,
			bytes: byteLen,
			digestPrefix: digest.slice(0, 16),
			expiresAtMs,
			attempt: null,
		};
		const record: ActivePromptRecord = {
			view,
			grant,
			sessionKey: status.sessionKey,
			instanceId: this.#adapter.instanceId,
			abort: new AbortController(),
			withdrawn: false,
			timedOut: false,
			grantLost: false,
		};
		this.#command = record;
		if (typeof nonce === "string") {
			this.#promptNonces.set(nonce, { view, grant });
			if (this.#promptNonces.size > NONCES_KEPT) {
				const oldest = this.#promptNonces.keys().next().value;
				if (oldest !== undefined) this.#promptNonces.delete(oldest);
			}
		}

		const ctxEntry: ApprovalBridgeContext = {
			kind: "prompt",
			record,
			proposalId,
			digestPrefix: view.digestPrefix,
			fullMessage: message,
			expiresAtMs,
		};

		void this.controller
			.requestPrompt(message, record.abort.signal, ctxEntry)
			.then((outcome) => {
				if (outcome.status === "accepted") {
					record.view.state = "accepted";
					record.view.disposition = "started";
					record.view.reason = null;
					return;
				}
				if (outcome.status === "unknown") {
					record.view.state = "unknown";
					record.view.reason = null;
					return;
				}
				record.view.state = "refused";
				if (record.withdrawn || record.grantLost) {
					record.view.reason = "not-authorized";
				} else if (record.timedOut) {
					record.view.reason = "approval-timed-out";
				} else if (this.#ended || this.#closing || this.#disposed) {
					record.view.reason = "session-ended";
				} else {
					record.view.reason = mapPromptRefusalCode(outcome.code);
				}
			})
			.catch(() => {
				record.view.state = "refused";
				record.view.reason = this.#ended ? "session-ended" : "runtime-refused";
			})
			.finally(() => {
				ctxEntry.fullMessage = null;
			});

		return reply(202, { ...view });
	}

	#discardPrompt(body: Record<string, unknown> | null): { status: number; body: unknown } {
		if (body === null || Object.keys(body).join() !== "proposalId" || typeof body.proposalId !== "string") {
			return refuse(400, "bad-request");
		}
		if (this.#command === null || this.#command.view.proposalId !== body.proposalId) {
			return refuse(404, "not-found");
		}
		if (this.#command.view.state !== "awaiting-approval") {
			return refuse(409, "not-awaiting");
		}
		this.#command.withdrawn = true;
		this.#command.view.state = "refused";
		this.#command.view.reason = "not-authorized";
		this.#command.abort.abort("withdrawn");
		return reply(200, { ...this.#command.view });
	}

	// -------------------------------------------------------------------------------------------------------------
	// Intervention proposal & lifecycle (targeted `stop` via `turn/interrupt`, plus `steer` only when admitted)
	// -------------------------------------------------------------------------------------------------------------

	#proposeIntervention(grant: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
		if (body === null) return refuse(400, "bad-request");
		const keys = Object.keys(body).sort();
		const op = body.operation;
		if (op !== "stop" && op !== "steer" && op !== "queue") return refuse(400, "bad-request");

		if (op === "queue") {
			const validKeys = keys.join() === "message,operation" || keys.join() === "message,nonce,operation";
			if (!validKeys || typeof body.message !== "string") return refuse(400, "bad-request");
			return refuse(409, "not-offered");
		}

		const isStop = op === "stop";
		const allowedKeys = isStop
			? keys.join() === "operation" || keys.join() === "nonce,operation"
			: keys.join() === "message,operation" || keys.join() === "message,nonce,operation";
		if (!allowedKeys) return refuse(400, "bad-request");

		const nonce = "nonce" in body ? body.nonce : null;
		if (nonce !== null) {
			if (typeof nonce !== "string" || !NONCE.test(nonce)) return refuse(400, "bad-request");
			const prior = this.#interventionNonces.get(nonce);
			if (prior !== undefined) {
				return prior.grant === grant ? reply(200, { ...prior.record.view }) : refuse(409, "not-offered");
			}
		}

		let message: string | null = null;
		let byteLen: number | null = null;
		if (!isStop) {
			if (typeof body.message !== "string") return refuse(400, "bad-request");
			message = body.message;
			byteLen = Buffer.byteLength(message, "utf8");
			if (
				message.trim().length === 0 ||
				byteLen > ENDO_WORKBENCH_MAX_PROMPT_BYTES_V0 ||
				UNSAFE_PROMPT_CHARS_V0.test(message)
			) {
				return refuse(400, "bad-request");
			}
		}

		// Idempotent STOP: if a STOP is already open for THIS exact active turn, return it instead of starting a second.
		if (isStop) {
			const currentActiveTurnId = this.controller.status().activeTurnId;
			for (const existing of this.#interventions.values()) {
				if (
					existing.view.operation === "stop" &&
					OPEN_INTERVENTION.has(existing.view.state) &&
					currentActiveTurnId !== null &&
					existing.targetTurnId === currentActiveTurnId
				) {
					return reply(200, { ...existing.view });
				}
			}
		}

		const offer = isStop ? this.#stopOffer() : this.#steerOffer();
		if (!offer.offered) return refuse(409, "not-offered");

		const status = this.controller.status();
		if (status.sessionKey === null || status.activeTurnId === null) return refuse(409, "not-offered");
		const targetTurnId = status.activeTurnId;

		// STOP supersedes any awaiting-approval STEER cleanly (matching Pi workbench semantics).
		if (isStop) {
			for (const existing of this.#interventions.values()) {
				if (existing.view.operation === "steer" && existing.view.state === "awaiting-approval") {
					existing.superseded = true;
					existing.view.state = "refused";
					existing.view.reason = "superseded-by-stop";
					existing.abort.abort("superseded-by-stop");
				}
			}
		}

		const digest = isStop
			? endoDevelopOperationPayloadDigestV0({ kind: "stop", targetTurnId })
			: endoDevelopOperationPayloadDigestV0({ kind: "steer", message: message as string, targetTurnId });
		const proposalId = `endo.evidence.intervention.proposal.${randomBytes(32).toString("hex")}`;
		const expiresAtMs = this.#now() + this.#approvalWindowMs;
		const view: CodexWorkbenchInterventionViewV0 = {
			proposalId,
			operation: op,
			state: "awaiting-approval",
			approved: false,
			authorizedBy: null,
			reason: null,
			disposition: null,
			bytes: byteLen,
			digestPrefix: digest.slice(0, 16),
			expiresAtMs,
			afterSeq: this.transcript.watermark,
			runEnded: null,
			consumption: null,
		};
		const record: ActiveInterventionRecord = {
			view,
			grant,
			sessionKey: status.sessionKey,
			instanceId: this.#adapter.instanceId,
			targetTurnId,
			abort: new AbortController(),
			withdrawn: false,
			timedOut: false,
			superseded: false,
			grantLost: false,
		};
		this.#interventions.set(proposalId, record);
		if (this.#interventions.size > INTERVENTIONS_KEPT) {
			const oldest = this.#interventions.keys().next().value;
			if (oldest !== undefined) this.#interventions.delete(oldest);
		}
		if (typeof nonce === "string") {
			this.#interventionNonces.set(nonce, { record, grant });
			if (this.#interventionNonces.size > NONCES_KEPT) {
				const oldest = this.#interventionNonces.keys().next().value;
				if (oldest !== undefined) this.#interventionNonces.delete(oldest);
			}
		}

		const kind: "steer" | "stop" = isStop ? "stop" : "steer";
		const ctxEntry: ApprovalBridgeContext = {
			kind,
			record,
			proposalId,
			digestPrefix: view.digestPrefix,
			fullMessage: message,
			expiresAtMs,
		};

		const runPromise = isStop
			? this.controller.requestStop(targetTurnId, record.abort.signal, ctxEntry)
			: this.controller.requestSteer(message as string, targetTurnId, record.abort.signal, ctxEntry);

		void runPromise
			.then((outcome) => {
				if (outcome.status === "accepted") {
					record.view.state = "accepted";
					record.view.disposition = isStop ? null : "handled";
					record.view.reason = null;
					return;
				}
				if (outcome.status === "unknown") {
					record.view.state = "unknown";
					record.view.reason = "runtime-failed";
					return;
				}
				record.view.state = "refused";
				if (record.superseded) {
					record.view.reason = "superseded-by-stop";
				} else if (record.withdrawn) {
					record.view.reason = "withdrawn";
				} else if (record.grantLost) {
					record.view.reason = "not-authorized";
				} else if (record.timedOut) {
					record.view.reason = "approval-timed-out";
				} else if (this.#ended || this.#closing || this.#disposed) {
					record.view.reason = "session-ended";
				} else {
					record.view.reason = mapInterventionRefusalCode(outcome.code);
				}
			})
			.catch(() => {
				record.view.state = "refused";
				record.view.reason = this.#ended ? "session-ended" : "runtime-failed";
			})
			.finally(() => {
				ctxEntry.fullMessage = null;
			});

		return reply(202, { ...view });
	}

	#discardIntervention(body: Record<string, unknown> | null): { status: number; body: unknown } {
		if (body === null || Object.keys(body).join() !== "proposalId" || typeof body.proposalId !== "string") {
			return refuse(400, "bad-request");
		}
		const rec = this.#interventions.get(body.proposalId);
		if (rec === undefined) return refuse(404, "not-found");
		if (rec.view.state !== "awaiting-approval") return refuse(409, "not-awaiting");
		rec.withdrawn = true;
		rec.view.state = "refused";
		rec.view.reason = "withdrawn";
		rec.abort.abort("withdrawn");
		return reply(200, { ...rec.view });
	}

	// -------------------------------------------------------------------------------------------------------------
	// Offers & status projection
	// -------------------------------------------------------------------------------------------------------------

	#promptAwaiting(): boolean {
		return this.#command !== null && this.#command.view.state === "awaiting-approval";
	}

	#interventionAwaiting(): boolean {
		for (const rec of this.#interventions.values()) {
			if (rec.view.state === "awaiting-approval") return true;
		}
		return false;
	}

	#offerRefusal(reason: string | null, fallback: string): { offered: false; reason: string } {
		const safe = reason === null ? "" : sanitizeDisplay(reason, 400);
		return { offered: false, reason: safe.length > 0 ? safe : fallback };
	}

	#promptOffer(): { offered: boolean; reason: string | null } {
		if (this.#disposed || this.#ended || this.#closing) {
			return this.#offerRefusal(null, "The Codex session has ended.");
		}
		const s = this.controller.status();
		if (s.connection !== "connected") {
			return this.#offerRefusal(s.connectionReason, "Codex session is disconnected.");
		}
		if (!s.capabilities.prompt.admitted) {
			return this.#offerRefusal(s.capabilities.prompt.reason, "Prompt dispatch is not admitted.");
		}
		if (s.activeTurnId !== null) {
			return this.#offerRefusal(null, "A Codex turn is already active. Wait for it to finish or request stop.");
		}
		if (this.#promptAwaiting() || this.#interventionAwaiting()) {
			return this.#offerRefusal(null, "Another request is already awaiting approval on the attached terminal.");
		}
		if (this.#command !== null && this.#command.view.state === "dispatching") {
			return this.#offerRefusal(null, "A prompt is currently being sent to Codex.");
		}
		return { offered: true, reason: null };
	}

	#stopOffer(): { offered: boolean; reason: string | null } {
		if (this.#disposed || this.#ended || this.#closing) {
			return this.#offerRefusal(null, "The Codex session has ended.");
		}
		const s = this.controller.status();
		if (s.connection !== "connected") {
			return this.#offerRefusal(s.connectionReason, "Codex session is disconnected.");
		}
		if (!s.capabilities.stop.admitted) {
			return this.#offerRefusal(s.capabilities.stop.reason, "Targeted turn interruption is not admitted.");
		}
		if (s.activeTurnId === null) {
			return this.#offerRefusal(null, "No active Codex turn to interrupt.");
		}
		if (this.#promptAwaiting()) {
			return this.#offerRefusal(null, "A prompt request is awaiting approval on the attached terminal.");
		}
		return { offered: true, reason: null };
	}

	#steerOffer(): { offered: boolean; reason: string | null } {
		if (this.#disposed || this.#ended || this.#closing) {
			return this.#offerRefusal(null, "The Codex session has ended.");
		}
		const s = this.controller.status();
		if (s.connection !== "connected") {
			return this.#offerRefusal(s.connectionReason, "Codex session is disconnected.");
		}
		if (!s.capabilities.steer.admitted) {
			return this.#offerRefusal(s.capabilities.steer.reason, "Codex turn/steer is not admitted for this session.");
		}
		if (s.activeTurnId === null) {
			return this.#offerRefusal(null, "No active Codex turn to steer.");
		}
		if (this.#promptAwaiting() || this.#interventionAwaiting()) {
			return this.#offerRefusal(null, "Another request is already awaiting approval on the attached terminal.");
		}
		return { offered: true, reason: null };
	}

	#granted(grant: string | null): boolean {
		return !this.#disposed && !this.#ended && this.#pairing.granted(grant);
	}

	#sessionId(): string | null {
		const threadId = this.#adapter.threadId;
		return threadId === null ? null : codexEndoSessionIdV0(threadId);
	}

	#sessionAlias(): string | null {
		const id = this.#sessionId();
		if (id === null) return null;
		if (this.#aliasOf !== undefined) return this.#aliasOf(id);
		// Opaque launch-scoped alias when no cockpit digest key is wired (stable across unpaired->paired, never leaks raw threadId).
		const hash = createHash("sha256").update(`${this.launchId}:${id}`).digest("hex").slice(0, 32);
		return `endo.session.${hash}`;
	}

	#codexInfo(paired: boolean): CodexWorkbenchInfoV0 {
		const cs = this.controller.status();
		const lv = this.#adapter.liveView();
		const ep = lv.effectivePolicy;
		const connected = cs.connection === "connected" && !this.#ended;
		const sanitizeUsage = (u: typeof lv.lastUsage): CodexWorkbenchUsageSummaryV0 | null =>
			u === null
				? null
				: {
						inputTokens: u.inputTokens,
						outputTokens: u.outputTokens,
						cachedInputTokens: u.cachedInputTokens,
						cacheWriteTokens: u.cacheWriteTokens,
						reasoningTokens: u.reasoningTokens,
						totalTokens: u.totalTokens,
						costUsd: u.costUsd,
					};
		return {
			version: cs.version === null ? null : sanitizeDisplay(cs.version, 64) || null,
			fingerprintConfidence: cs.fingerprintConfidence,
			model: ep?.model === null || ep?.model === undefined ? null : sanitizeDisplay(ep.model, 128) || null,
			reasoningEffort:
				ep?.reasoningEffort === null || ep?.reasoningEffort === undefined
					? null
					: sanitizeDisplay(ep.reasoningEffort, 32) || null,
			sandbox: summarizeSandbox(ep?.sandbox),
			approvalPolicy: summarizeScalarPolicy(ep?.approvalPolicy),
			approvalsReviewer: summarizeScalarPolicy(ep?.approvalsReviewer),
			// Privacy boundary: thread/turn coordinates, token usage, and native approval summaries are exposed ONLY to a paired page.
			threadId: paired && connected ? lv.threadId : null,
			activeTurnId: paired && connected ? lv.activeTurnId : null,
			connectionReason: connected
				? null
				: sanitizeDisplay(cs.connectionReason ?? "Codex session disconnected.", 240),
			usage:
				paired && connected
					? {
							last: sanitizeUsage(lv.lastUsage),
							total: sanitizeUsage(lv.totalUsage),
							modelContextWindow: lv.modelContextWindow,
						}
					: null,
			pendingNativeApprovals:
				paired && connected
					? lv.pendingApprovals.slice(0, 20).map((req) => ({
							requestId: sanitizeDisplay(req.requestId, 128),
							approvalKind: sanitizeDisplay(req.approvalKind, 64),
							nativeMethod: sanitizeDisplay(req.nativeMethod, 128),
							requestedScope: sanitizeDisplay(req.requestedScope, 32),
							turnId: req.turnId === null ? null : sanitizeDisplay(req.turnId, 128),
							itemId: req.itemId === null ? null : sanitizeDisplay(req.itemId, 128),
							summary: sanitizeDisplay(req.summary, CODEX_MAX_APPROVAL_SUMMARY_CHARS_V0),
						}))
					: [],
			recentNativeApprovals:
				paired && connected
					? lv.recentApprovals.slice(0, 20).map((r) => ({
							requestId: sanitizeDisplay(r.requestId, 128),
							approvalKind: sanitizeDisplay(r.approvalKind, 64),
							nativeMethod: sanitizeDisplay(r.nativeMethod, 128),
							resolution: r.resolution,
							code: r.code === null ? null : sanitizeDisplay(r.code, 64),
							resolvedAtMs: r.resolvedAtMs,
						}))
					: [],
		};
	}

	#status(paired: boolean): Record<string, unknown> {
		const cs = this.controller.status();
		const connected = cs.connection === "connected" && !this.#ended;
		const run: "active" | "idle" | "unknown" = !connected ? "unknown" : cs.activeTurnId !== null ? "active" : "idle";
		const seen = endoObserveProtectionV0(this.#protection);
		const protection = {
			state: seen.state,
			level: seen.level,
			mechanism: seen.mechanism,
			limitations: [...seen.limitations],
		};
		return {
			schemaVersion: CODEX_WORKBENCH_STATUS_SCHEMA_V0,
			launchId: this.launchId,
			harness: "codex",
			connection: connected ? "connected" : "disconnected",
			run,
			session: this.#sessionAlias(),
			attachment: this.#adapter.describe().attachment.attachmentId,
			offers: {
				prompt: this.#promptOffer(),
				attempt: {
					offered: false,
					reason: "Prepared-attempt execution is not yet supported for Codex sessions (v0).",
				},
				steer: this.#steerOffer(),
				queue: {
					offered: false,
					reason: "Codex App Server exposes no Pi-equivalent follow-up queue.",
				},
				stop: this.#stopOffer(),
			},
			paired,
			mode: {
				requested: "strict",
				effective: "strict",
				reason: null,
			},
			protection,
			sessionControl: {
				state: "none",
				holder: false,
				armed: false,
				grantId: null,
				operations: [],
				expiresAtMs: null,
				sendsLeft: null,
				workspaceRoot: null,
				ended: null,
			},
			command: paired && this.#command !== null ? { ...this.#command.view } : null,
			interventions: paired ? [...this.#interventions.values()].map((r) => ({ ...r.view })) : [],
			transcript: { watermark: this.transcript.watermark, firstSeq: this.transcript.firstSeq },
			codex: this.#codexInfo(paired),
		};
	}

	#abortPageRequests(reason: string): void {
		if (this.#command !== null && this.#command.grant !== null && this.#command.view.state === "awaiting-approval") {
			this.#command.grantLost = true;
			this.#command.view.state = "refused";
			this.#command.view.reason = "not-authorized";
			this.#command.abort.abort(reason);
		}
		for (const rec of this.#interventions.values()) {
			if (rec.grant !== null && rec.view.state === "awaiting-approval") {
				rec.grantLost = true;
				rec.view.state = "refused";
				rec.view.reason = "not-authorized";
				rec.abort.abort(reason);
			}
		}
	}

	#abortAllRequests(reason: string): void {
		if (this.#command !== null && this.#command.view.state === "awaiting-approval") {
			this.#command.view.state = "refused";
			this.#command.view.reason = "session-ended";
			this.#command.abort.abort(reason);
		}
		for (const rec of this.#interventions.values()) {
			if (rec.view.state === "awaiting-approval") {
				rec.view.state = "refused";
				rec.view.reason = "session-ended";
				rec.abort.abort(reason);
			}
		}
	}
}
