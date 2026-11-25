// Pi reference implementation of the harness-neutral DEVELOP operational adapter contract (`endo.develop-adapter.v0`).
//
// Thin boundary around the existing Pi attachment (`PiSessionAttachmentV0`) and workbench session (`WorkbenchSessionV0`):
// reuses Pi's real fingerprint (`EndoHarnessFingerprintRecordV0`), capability state (`EndoCapabilityStateV0`), process
// cleanup (`ProcessCleanupV0`), and live RPC event stream without rewriting Pi's RPC client, intervention desk, or broker.
//
// Preserves Pi's real semantics explicitly:
// - Single persistent session per attachment; no runtime-supplied run or turn IDs (`turnId: null`).
// - `prompt` is idle-only and yields no turn id.
// - `steer` (in-turn, after tool calls) and `queue` (`follow_up`, after current run) carry no receipt id and no target turn.
// - `stop` (`abort`) is untargeted and acknowledged only once idle.
// - `nativeCommand` is unsupported over Pi RPC (never silently downgraded into ordinary model prompt text).
// - `attachments` are unsupported over Pi RPC.
// - `nativeApprovals` are Pi `extension_ui_request` dialogs, which are cancelled when no interactive UI handles them.

import { randomBytes } from "node:crypto";
import {
	ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_SCHEMA_V0,
	type EndoAdapterCapabilityEntryV0,
	type EndoAdapterConnectionStateV0,
	type EndoAdapterCoordinationRefsV0,
	type EndoAdapterProcessCleanupV0,
	type EndoAdapterSessionIdentityV0,
	type EndoAdapterStateClaimV0,
	type EndoAdapterTurnStateV0,
	type EndoAdapterUsageReportV0,
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
} from "../../protocol/develop-adapter.ts";
import type { EndoCapabilityStateV0, EndoHarnessFingerprintRecordV0 } from "../../protocol/harness.ts";
import {
	type EndoDevelopAdmissionOptionsV0,
	type EndoDevelopCloseOutcomeV0,
	type EndoDevelopLiveAdapterV0,
	EndoObservationGuardV0,
	endoDevelopCapabilityFromStateV0,
	endoDevelopFingerprintRefV0,
	endoEvaluateDevelopAdmissionV0,
	endoEvaluateNativeApprovalV0,
} from "../../runtime/contracts/develop-adapter.ts";
import type { ProcessCleanupV0 } from "../rpc-jsonl/process-group.ts";
import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";
import { piEndoSessionIdV0 } from "./mapping.ts";
import { PiRpcRefusalV0 } from "./rpc.ts";

/** Minimal structural surface of a Pi live session (`PiSessionAttachmentV0` and `WorkbenchSessionV0` both satisfy it). */
export interface PiDevelopAdapterSessionV0 {
	readonly piSessionId: string | null;
	readonly live: boolean;
	readonly runActive: boolean;
	readonly connection?: string;
	readonly connectionInstance?: string | null;
	readonly fingerprint?: EndoHarnessFingerprintRecordV0;
	readonly capabilityState?: EndoCapabilityStateV0;
	prompt(message: string): Promise<string>;
	steer?(message: string): Promise<string>;
	followUp?(message: string): Promise<string>;
	stop?(): Promise<void>;
	close?(): Promise<void>;
	processCleanup?(): Promise<ProcessCleanupV0[]>;
}

export interface PiDevelopAdapterOptionsV0 {
	readonly session: PiDevelopAdapterSessionV0;
	readonly attachmentId: string;
	readonly launchId: string;
	readonly instanceId?: string;
	readonly projectScope?: string | null;
	readonly now?: () => number;
	/** Optional explicit evidence freshness override (e.g. if configuration changed after last check). */
	readonly staleEvidenceReason?: () => string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNonNeg = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Strip ASCII control characters and bound length so runtime strings never trigger silent observation drops. */
const sanitizeRuntimeText = (value: string, max: number): string =>
	value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);

const PI_IGNORED_LIVE_EVENTS = new Set([
	"message_start",
	"message_update",
	"turn_start",
	"turn_end",
	"agent_end",
	"tool_execution_update",
	"bash_execution_update",
	"compaction_start",
	"queue_update",
	"auto_retry_start",
	"thinking_level_changed",
	"session_info_changed",
	"entry_appended",
]);

const PI_DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const PI_NON_DIALOG_UI_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

function parsePiUsage(message: Record<string, unknown>): EndoAdapterUsageReportV0 | null {
	const u = message.usage;
	if (!isRecord(u)) return null;
	if (!isFiniteNonNeg(u.input) || !isFiniteNonNeg(u.output) || !isFiniteNonNeg(u.totalTokens)) return null;
	const cost = isRecord(u.cost) && isFiniteNonNeg(u.cost.total) ? u.cost.total : null;
	return {
		inputTokens: u.input,
		outputTokens: u.output,
		cachedInputTokens: isFiniteNonNeg(u.cacheRead) ? u.cacheRead : null,
		cacheWriteTokens: isFiniteNonNeg(u.cacheWrite) ? u.cacheWrite : null,
		reasoningTokens: null,
		totalTokens: u.totalTokens,
		costUsd: cost,
	};
}

/**
 * Conservatively aggregate cleanup results across every process an attachment started (including earlier
 * processes prior to reconnects). A confirmed final scope never hides an earlier incomplete or unverified teardown.
 */
function summarizeCleanup(cleanups: readonly ProcessCleanupV0[]): EndoAdapterProcessCleanupV0 {
	if (cleanups.length === 0) {
		return { boundary: "unverified", result: "unverified", remainingProcesses: null, scopeName: null };
	}
	const incompletes = cleanups.filter((c) => c.result === "incomplete");
	if (incompletes.length > 0) {
		const allScoped = incompletes.every((c) => c.boundary === "scope");
		let remaining: number | null = 0;
		let lastIncompleteUnit: string | null = null;
		for (const item of incompletes) {
			if (item.boundary === "scope" && item.result === "incomplete") {
				lastIncompleteUnit = item.unit;
				if (item.remaining === null) remaining = null;
				else if (remaining !== null) remaining += item.remaining;
			} else {
				remaining = null;
			}
		}
		return {
			boundary: allScoped ? "scope" : "process-group",
			result: "incomplete",
			remainingProcesses: remaining,
			scopeName: allScoped ? lastIncompleteUnit : null,
		};
	}
	if (cleanups.some((c) => c.result !== "confirmed" || c.boundary !== "scope")) {
		return {
			boundary: "process-group",
			result: "unverified",
			remainingProcesses: null,
			scopeName: null,
		};
	}
	const last = cleanups[cleanups.length - 1]!;
	return {
		boundary: "scope",
		result: "confirmed",
		remainingProcesses: 0,
		scopeName: last.boundary === "scope" ? last.unit : null,
	};
}

/**
 * Reference live adapter for Pi (`pi --mode rpc`).
 * Implements `EndoDevelopLiveAdapterV0` directly on top of Pi's existing attachment and capability evidence.
 */
export class PiDevelopAdapterV0 implements EndoDevelopLiveAdapterV0 {
	readonly #o: PiDevelopAdapterOptionsV0;
	readonly #now: () => number;
	#instanceId: string;
	#closed = false;
	#disconnectedReason: string | null = null;
	#cleanup: EndoAdapterProcessCleanupV0 = {
		boundary: "unverified",
		result: "unverified",
		remainingProcesses: null,
		scopeName: null,
	};
	#lastStopReason: string | null = null;
	#retryExhausted = false;
	#lastKnownFingerprintId: string | null = null;
	#lastSeenConnectionInstance: string | null = null;
	readonly #pendingNativeApprovals = new Set<string>();
	readonly #guard: EndoObservationGuardV0;
	readonly #listeners = new Set<(observation: EndoDevelopObservationV0) => void>();
	readonly #coordination: EndoAdapterCoordinationRefsV0 = {
		parentSession: null,
		children: [],
		taskBindings: [],
	};

	constructor(options: PiDevelopAdapterOptionsV0) {
		this.#o = options;
		this.#now = options.now ?? Date.now;
		this.#lastSeenConnectionInstance = options.session.connectionInstance ?? null;
		this.#instanceId = options.instanceId ?? options.session.connectionInstance ?? randomBytes(8).toString("hex");
		this.#lastKnownFingerprintId = options.session.fingerprint?.id ?? null;
		this.#guard = new EndoObservationGuardV0({
			source: "pi-live",
			attachmentId: options.attachmentId,
			instanceId: this.#instanceId,
			sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
		});
	}

	/**
	 * Synchronize with the underlying Pi session's connection instance and fingerprint so an automatic
	 * `PiSessionAttachmentV0.reconnect()` immediately rotates `instanceId` and invalidates prior proofs.
	 */
	#syncRuntimeObservation(): void {
		const liveConn = this.#o.session.connectionInstance ?? null;
		if (
			liveConn !== null &&
			this.#lastSeenConnectionInstance !== null &&
			liveConn !== this.#lastSeenConnectionInstance
		) {
			this.#lastSeenConnectionInstance = liveConn;
			this.#instanceId = liveConn;
			this.#disconnectedReason = null;
			this.#lastStopReason = null;
			this.#retryExhausted = false;
			this.#pendingNativeApprovals.clear();
			// Refresh the fingerprint baseline when adopting a reidentified reconnect; `#evidenceFreshness()`
			// still verifies that `capabilityState.fingerprintId` matches the new fingerprint observation.
			this.#lastKnownFingerprintId = this.#o.session.fingerprint?.id ?? null;
			this.#guard.rotateInstance(liveConn, endoAdapterSessionKeyV0(this.#sessionIdentity()));
		} else if (liveConn !== null && this.#lastSeenConnectionInstance === null) {
			this.#lastSeenConnectionInstance = liveConn;
		}
		if (this.#lastKnownFingerprintId === null && this.#o.session.fingerprint !== undefined) {
			this.#lastKnownFingerprintId = this.#o.session.fingerprint.id;
		}
	}

	get instanceId(): string {
		this.#syncRuntimeObservation();
		return this.#instanceId;
	}

	/**
	 * Rotate connection/attachment instance identity (called on reconnect, process restart, or runtime replacement).
	 * Invalidates authority proofs bound to earlier attachment instances and flags late events from older instances.
	 */
	rotateInstance(newInstanceId = randomBytes(8).toString("hex")): string {
		this.#instanceId = newInstanceId;
		this.#lastSeenConnectionInstance = this.#o.session.connectionInstance ?? newInstanceId;
		this.#disconnectedReason = null;
		this.#lastStopReason = null;
		this.#retryExhausted = false;
		this.#pendingNativeApprovals.clear();
		this.#lastKnownFingerprintId = this.#o.session.fingerprint?.id ?? null;
		this.#guard.rotateInstance(newInstanceId, endoAdapterSessionKeyV0(this.#sessionIdentity()));
		return newInstanceId;
	}

	/** Explicitly mark the connection lost without claiming process termination or session end. */
	markDisconnected(reason: string): void {
		this.#disconnectedReason = reason;
		this.#pendingNativeApprovals.clear();
		this.#emit(
			{
				kind: "lifecycle",
				event: "connection-lost",
				sessionState: "unknown",
				turnState: null,
				detail: reason,
			},
			"controller-observed",
		);
	}

	#sessionIdentity(): EndoAdapterSessionIdentityV0 {
		const piId = this.#o.session.piSessionId;
		if (piId !== null && piId.length > 0) {
			const alias = sanitizeRuntimeText(piId, 128).trim();
			return {
				source: "pi-live",
				key: { status: "established", id: piEndoSessionIdV0(piId), scope: "persistent" },
				alias: alias.length > 0 ? alias : null,
				nativeRef: { kind: "pi-session", sessionId: piId },
			};
		}
		return {
			source: "pi-live",
			key: { status: "established", id: this.#o.launchId, scope: "launch" },
			alias: null,
			nativeRef: null,
		};
	}

	#connectionState(): { state: EndoAdapterConnectionStateV0; reason: string | null } {
		if (this.#closed) return { state: "disconnected", reason: "The Pi adapter is closed." };
		if (this.#disconnectedReason !== null) return { state: "disconnected", reason: this.#disconnectedReason };
		if (!this.#o.session.live) {
			const conn = this.#o.session.connection;
			return {
				state: "disconnected",
				reason: conn ? `Pi connection state is ${conn}.` : "Pi is not currently connected.",
			};
		}
		return { state: "connected", reason: null };
	}

	#evidenceFreshness(): EndoDevelopAdapterDescriptorV0["evidenceFreshness"] {
		const fp = this.#o.session.fingerprint ?? null;
		if (fp === null) {
			return { status: "unidentified", reason: "No runtime fingerprint has been observed for this Pi session." };
		}
		const customStale = this.#o.staleEvidenceReason?.() ?? null;
		if (customStale !== null) return { status: "stale", reason: customStale };
		if (this.#lastKnownFingerprintId !== null && this.#lastKnownFingerprintId !== fp.id) {
			return {
				status: "stale",
				reason: `Runtime fingerprint changed from ${this.#lastKnownFingerprintId} to ${fp.id}.`,
			};
		}
		const state = this.#o.session.capabilityState;
		if (state !== undefined && state.fingerprintId !== fp.id) {
			return {
				status: "stale",
				reason: `Capability state was derived for fingerprint ${state.fingerprintId ?? "none"}, not current ${fp.id}.`,
			};
		}
		return { status: "current", reason: null };
	}

	#capFromState(capabilityId: string): EndoAdapterCapabilityEntryV0 {
		const fp = this.#o.session.fingerprint ?? null;
		const state = this.#o.session.capabilityState;
		if (state === undefined) {
			return {
				standing: "unverified",
				evidenceCapability: capabilityId,
				evidenceId: null,
				reason: `No capability evidence state is loaded for ${capabilityId}.`,
			};
		}
		return endoDevelopCapabilityFromStateV0({
			state,
			capabilityId,
			expectedRuntime: "pi",
			expectedAttachment: this.#o.attachmentId,
			currentFingerprint: fp,
		});
	}

	describe(): EndoDevelopAdapterDescriptorV0 {
		this.#syncRuntimeObservation();
		const session = this.#sessionIdentity();
		this.#guard.setSessionKey(endoAdapterSessionKeyV0(session));
		const conn = this.#connectionState();
		const fp = this.#o.session.fingerprint ?? null;
		const freshness = this.#evidenceFreshness();
		const connected = conn.state === "connected";

		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0,
			harness: {
				family: "pi",
				observedVersion: fp?.reported.version ?? null,
			},
			synthetic: false,
			controlPath: "pi-workbench-broker",
			everydayGrantEligible: true,
			runtimeFingerprint: endoDevelopFingerprintRefV0(fp, "No Pi runtime fingerprint was supplied."),
			session,
			ownership: connected
				? { status: "established", value: "direct", basis: "controller-observed", by: "endophasia" }
				: {
						status: "unavailable",
						reason: "Direct ownership holds only while this process holds the live Pi connection.",
					},
			attachment: {
				attachmentId: this.#o.attachmentId,
				launchId: this.#o.launchId,
				instanceId: this.#instanceId,
				projectScope: this.#o.projectScope ?? null,
			},
			capabilityState: this.#o.session.capabilityState ?? null,
			evidenceFreshness: freshness,
			operations: {
				prompt: {
					capability: connected
						? { standing: "admitted", evidenceCapability: null, evidenceId: null, reason: null }
						: {
								standing: "unavailable",
								evidenceCapability: null,
								evidenceId: null,
								reason: conn.reason ?? "Pi is not connected.",
							},
					delivery: "idle-only",
					yieldsTurnId: false,
				},
				steer: {
					capability: this.#capFromState("steering.steer"),
					delivery: "in-turn-next-model-call",
					requiresTargetTurnId: false,
					returnsReceiptId: false,
				},
				queue: {
					capability: this.#capFromState("steering.follow-up"),
					delivery: "after-current-run",
					returnsReceiptId: false,
				},
				stop: {
					capability: this.#capFromState("steering.stop"),
					targeting: "untargeted-session-abort",
					requiresTargetTurnId: false,
					acknowledgementSemantics: "on-idle",
				},
				resume: {
					capability: {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason:
							"The live Pi workbench opens one persistent session per attachment and does not offer live resume.",
					},
					mode: "unsupported",
					replaysHistory: "unknown",
				},
				nativeCommand: {
					capability: {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason: "Pi RPC does not expose a typed programmatic native-command transport.",
					},
					transport: "unsupported",
					allowsArbitraryShell: false,
				},
				attachments: {
					supported: false,
					kinds: [],
					delivery: [],
					maxCount: null,
					maxBytesPerItem: null,
					requiresExplicitAdmission: true,
					allowsArbitraryPathRead: false,
				},
				nativeApprovals: {
					mode: "extension-dialogs-cancelled",
					knownKinds: ["extension-dialog"],
					unknownPolicy: "fail-closed",
				},
				coordination: {
					canDiscoverChildren: false,
					reportsParentRef: false,
					delegationSupported: false,
				},
			},
		};
	}

	snapshot(): EndoDevelopSessionSnapshotV0 {
		this.#syncRuntimeObservation();
		const identity = this.#sessionIdentity();
		const sessionKey = endoAdapterSessionKeyV0(identity);
		const connection = this.#connectionState();
		const connected = connection.state === "connected";
		const claims: EndoAdapterStateClaimV0[] = connected
			? [
					{
						state: this.#o.session.runActive ? "active" : "idle",
						basis: "runtime-reported",
						by: "pi",
						at: null,
					},
				]
			: [];
		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_SCHEMA_V0,
			observedAt: new Date(this.#now()).toISOString(),
			sessionKey,
			attachment: {
				attachmentId: this.#o.attachmentId,
				launchId: this.#o.launchId,
				instanceId: this.#instanceId,
				projectScope: this.#o.projectScope ?? null,
			},
			connection,
			stateClaims: claims,
			activeTurn:
				connected && this.#o.session.runActive
					? { turnId: null, state: "in-progress", basis: "runtime-reported" }
					: null,
			pendingNativeApprovalCount: connected ? this.#pendingNativeApprovals.size : 0,
			processCleanup: this.#cleanup,
			coordination: this.#coordination,
		};
	}

	admitOperation(
		request: EndoDevelopOperationRequestV0,
		authority: EndoDevelopAuthorityProofV0 | null,
		options?: EndoDevelopAdmissionOptionsV0,
	): EndoDevelopAdmissionDecisionV0 {
		return endoEvaluateDevelopAdmissionV0({
			descriptor: this.describe(),
			snapshot: this.snapshot(),
			request,
			authority,
			options: { nowMs: this.#now(), ...options },
		});
	}

	async dispatch(
		request: EndoDevelopOperationRequestV0,
		authority: EndoDevelopAuthorityProofV0 | null,
		options?: EndoDevelopAdmissionOptionsV0,
	): Promise<EndoDevelopDispatchOutcomeV0> {
		const admission = this.admitOperation(request, authority, options);
		if (!admission.admitted) {
			return {
				status: "refused",
				operation: request.kind,
				stage: "admission",
				code: admission.code,
				reason: admission.reason,
			};
		}
		const dispatchedInstance = this.#instanceId;
		try {
			switch (request.kind) {
				case "prompt": {
					const disposition = await this.#o.session.prompt(request.message);
					this.#syncRuntimeObservation();
					if (this.#instanceId !== dispatchedInstance) {
						return {
							status: "unknown",
							operation: "prompt",
							instanceId: dispatchedInstance,
							reason: "Pi attachment instance changed before prompt reply arrived.",
							dispatched: true,
						};
					}
					return {
						status: "accepted",
						operation: "prompt",
						instanceId: dispatchedInstance,
						disposition,
						turnId: null,
						receiptId: null,
						consequenceObserved: false,
					};
				}
				case "steer": {
					if (this.#o.session.steer === undefined) {
						return {
							status: "refused",
							operation: "steer",
							stage: "admission",
							code: "operation-unavailable",
							reason: "The underlying Pi session does not expose steer.",
						};
					}
					const disposition = await this.#o.session.steer(request.message);
					this.#syncRuntimeObservation();
					if (this.#instanceId !== dispatchedInstance) {
						return {
							status: "unknown",
							operation: "steer",
							instanceId: dispatchedInstance,
							reason: "Pi attachment instance changed before steer reply arrived.",
							dispatched: true,
						};
					}
					return {
						status: "accepted",
						operation: "steer",
						instanceId: dispatchedInstance,
						disposition,
						turnId: null,
						receiptId: null,
						consequenceObserved: false,
					};
				}
				case "queue": {
					if (this.#o.session.followUp === undefined) {
						return {
							status: "refused",
							operation: "queue",
							stage: "admission",
							code: "operation-unavailable",
							reason: "The underlying Pi session does not expose followUp.",
						};
					}
					const disposition = await this.#o.session.followUp(request.message);
					this.#syncRuntimeObservation();
					if (this.#instanceId !== dispatchedInstance) {
						return {
							status: "unknown",
							operation: "queue",
							instanceId: dispatchedInstance,
							reason: "Pi attachment instance changed before follow_up reply arrived.",
							dispatched: true,
						};
					}
					return {
						status: "accepted",
						operation: "queue",
						instanceId: dispatchedInstance,
						disposition,
						turnId: null,
						receiptId: null,
						consequenceObserved: false,
					};
				}
				case "stop": {
					if (this.#o.session.stop === undefined) {
						return {
							status: "refused",
							operation: "stop",
							stage: "admission",
							code: "operation-unavailable",
							reason: "The underlying Pi session does not expose stop.",
						};
					}
					await this.#o.session.stop();
					this.#syncRuntimeObservation();
					if (this.#instanceId !== dispatchedInstance) {
						return {
							status: "unknown",
							operation: "stop",
							instanceId: dispatchedInstance,
							reason: "Pi attachment instance changed before abort reply arrived.",
							dispatched: true,
						};
					}
					return {
						status: "accepted",
						operation: "stop",
						instanceId: dispatchedInstance,
						disposition: "aborted-acknowledged",
						turnId: null,
						receiptId: null,
						consequenceObserved: false,
					};
				}
				case "resume":
				case "native-command":
					return {
						status: "refused",
						operation: request.kind,
						stage: "admission",
						code: request.kind === "native-command" ? "native-command-unsupported" : "operation-unsupported",
						reason: `${request.kind} is unsupported by the Pi RPC adapter.`,
					};
			}
		} catch (error) {
			if (error instanceof PiRpcRefusalV0) {
				return {
					status: "refused",
					operation: request.kind,
					stage: "runtime",
					code: "runtime-refused",
					reason: `Pi refused ${error.command}.`,
				};
			}
			this.#emit(
				{
					kind: "evidence-gap",
					gap: "disconnected-mid-request",
					reason: `Pi ${request.kind} failed after dispatch; outcome is unknown.`,
				},
				"controller-observed",
			);
			return {
				status: "unknown",
				operation: request.kind,
				instanceId: dispatchedInstance,
				reason: "The request was dispatched to Pi, but the reply was lost or failed; outcome is unknown.",
				dispatched: true,
			};
		}
	}

	handleNativeApproval(
		request: EndoDevelopNativeApprovalRequestV0,
		decision: EndoDevelopNativeApprovalDecisionV0 | null = null,
		options?: { nowMs?: number; allowSessionOrPolicyScope?: boolean },
	): EndoDevelopNativeApprovalOutcomeV0 {
		this.#syncRuntimeObservation();
		return endoEvaluateNativeApprovalV0({
			request,
			decision,
			current: {
				source: "pi-live",
				sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
				instanceId: this.#instanceId,
				connected: this.#connectionState().state === "connected",
				knownKinds: ["extension-dialog"],
				mode: "extension-dialogs-cancelled",
				nowMs: options?.nowMs ?? this.#now(),
				...(options?.allowSessionOrPolicyScope === undefined
					? {}
					: { allowSessionOrPolicyScope: options.allowSessionOrPolicyScope }),
			},
		});
	}

	subscribeObservations(listener: (observation: EndoDevelopObservationV0) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Feed one live Pi RPC event into the neutral observation stream.
	 * Pass `sourceInstanceId` when forwarding events that may arrive asynchronously from an earlier connection.
	 */
	observePiLiveEvent(event: RpcEventV0, sourceInstanceId?: string): void {
		this.#syncRuntimeObservation();
		const effectiveInstanceId = sourceInstanceId ?? this.#instanceId;
		// Short-circuit stale-instance events immediately BEFORE mutating any live turn state.
		if (effectiveInstanceId !== this.#instanceId) {
			this.#emit(
				{
					kind: "evidence-gap",
					gap: "late-event-from-prior-attachment",
					reason: `Pi live event (${sanitizeRuntimeText(event.type, 64)}) arrived from superseded instance ${sanitizeRuntimeText(effectiveInstanceId, 64)}.`,
				},
				"controller-observed",
				effectiveInstanceId,
			);
			return;
		}
		const record = event.record;
		if (event.type === "agent_start") {
			this.#lastStopReason = null;
			this.#retryExhausted = false;
			this.#emit(
				{
					kind: "lifecycle",
					event: "turn-started",
					sessionState: "active",
					turnState: "in-progress",
					detail: null,
				},
				"runtime-reported",
				effectiveInstanceId,
			);
			return;
		}
		if (event.type === "auto_retry_end") {
			if (record.success === false) this.#retryExhausted = true;
			return;
		}
		if (event.type === "compaction_end") {
			const succeeded = isRecord(record.result) && record.aborted !== true;
			const rawReason = typeof record.reason === "string" ? sanitizeRuntimeText(record.reason, 32).trim() : "";
			const detail = succeeded
				? rawReason.length > 0
					? rawReason
					: null
				: record.aborted === true
					? "aborted"
					: "failed";
			this.#emit(
				{
					kind: "lifecycle",
					event: succeeded ? "context-compacted" : "context-compaction-failed",
					sessionState: this.#o.session.runActive ? "active" : "idle",
					turnState: null,
					detail,
				},
				"runtime-reported",
				effectiveInstanceId,
			);
			return;
		}
		if (event.type === "agent_settled") {
			const turnState: EndoAdapterTurnStateV0 =
				this.#retryExhausted || this.#lastStopReason === "error"
					? "failed"
					: this.#lastStopReason === "aborted"
						? "aborted"
						: this.#lastStopReason === null
							? "unclassified"
							: "completed";
			const lifecycleEvent =
				turnState === "failed" ? "turn-failed" : turnState === "aborted" ? "turn-aborted" : "turn-completed";
			this.#emit(
				{
					kind: "lifecycle",
					event: lifecycleEvent,
					sessionState: "idle",
					turnState,
					detail: this.#lastStopReason,
				},
				"runtime-reported",
				effectiveInstanceId,
			);
			this.#lastStopReason = null;
			this.#retryExhausted = false;
			return;
		}
		if (event.type === "message_end" && isRecord(record.message)) {
			const msg = record.message;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") return;
			const rawStop = typeof msg.stopReason === "string" ? sanitizeRuntimeText(msg.stopReason, 32).trim() : "";
			const stopReason = rawStop.length > 0 ? rawStop : null;
			if (role === "assistant" && stopReason !== null) this.#lastStopReason = stopReason;
			const content =
				typeof msg.content === "string"
					? [{ type: "text", text: msg.content }]
					: Array.isArray(msg.content)
						? msg.content
						: [];
			let sawReasoning = false;
			for (const block of content) {
				if (!isRecord(block)) continue;
				if (block.type === "thinking") {
					sawReasoning = true;
					const redacted = block.redacted === true;
					const thinking = typeof block.thinking === "string" ? block.thinking : "";
					this.#emit(
						{
							kind: "transcript",
							role,
							contentKind: "reasoning",
							reasoningKind: redacted ? "redacted" : "raw-thinking",
							text: redacted ? null : thinking,
							truncated: false,
							stopReason,
						},
						"runtime-reported",
						effectiveInstanceId,
					);
				} else if (block.type === "text" && typeof block.text === "string") {
					this.#emit(
						{
							kind: "transcript",
							role,
							contentKind: "text",
							reasoningKind: null,
							text: block.text,
							truncated: false,
							stopReason,
						},
						"runtime-reported",
						effectiveInstanceId,
					);
				}
			}
			if (role === "assistant") {
				if (!sawReasoning) {
					// Absence of a thinking block is not fabricated into a raw reasoning trace.
					this.#emit(
						{
							kind: "evidence-gap",
							gap: "reasoning-unavailable",
							reason: "Pi assistant message carried no structured thinking block.",
						},
						"controller-observed",
						effectiveInstanceId,
					);
				}
				const usage = parsePiUsage(msg);
				this.#emit(
					{
						kind: "usage",
						usage:
							usage !== null
								? { status: "reported", value: usage }
								: { status: "unavailable", reason: "Pi assistant message did not report usage numbers." },
					},
					usage !== null ? "runtime-reported" : "controller-observed",
					effectiveInstanceId,
				);
			}
			return;
		}
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			const start = event.type === "tool_execution_start";
			const rawName = typeof record.toolName === "string" ? sanitizeRuntimeText(record.toolName, 128).trim() : "";
			const name = rawName.length > 0 ? rawName : "unknown";
			const rawCallId =
				typeof record.toolCallId === "string" ? sanitizeRuntimeText(record.toolCallId, 256).trim() : "";
			const callId = rawCallId.length > 0 ? rawCallId : null;
			const exitCode =
				!start &&
				isRecord(record.result) &&
				isRecord(record.result.details) &&
				Number.isSafeInteger(record.result.details.exitCode)
					? (record.result.details.exitCode as number)
					: null;
			this.#emit(
				{
					kind: "tool-activity",
					activityKind: "tool-call",
					name,
					phase: start
						? "started"
						: record.isError === true
							? "failed"
							: record.isError === false
								? "completed"
								: "unknown",
					callId,
					exitCode,
				},
				"runtime-reported",
				effectiveInstanceId,
			);
			return;
		}
		if (event.type === "extension_ui_request") {
			const method = typeof record.method === "string" ? record.method : "";
			if (PI_NON_DIALOG_UI_METHODS.has(method)) {
				// Fire-and-forget UI notifications are not blocking approval dialogs.
				return;
			}
			const rawId = typeof record.id === "string" ? sanitizeRuntimeText(record.id, 256).trim() : "";
			const reqId = rawId.length > 0 ? rawId : `pi-ui-${this.#now()}`;
			this.#pendingNativeApprovals.add(reqId);
			// Emit pending request only: cancellation resolution is emitted only after `PiSessionAttachmentV0` confirms
			// delivery of `{ cancelled: true }` via `observePiDialogCancelled()`.
			this.#emit(
				{
					kind: "native-approval",
					phase: "requested",
					requestId: reqId,
					approvalKind: PI_DIALOG_UI_METHODS.has(method) ? "extension-dialog" : "unknown",
					resolution: "pending",
				},
				"runtime-reported",
				effectiveInstanceId,
			);
			return;
		}
		if (PI_IGNORED_LIVE_EVENTS.has(event.type)) {
			return;
		}
		this.#emit(
			{
				kind: "evidence-gap",
				gap: "unrecognized-runtime-event",
				reason: `Unrecognized Pi live event type: ${sanitizeRuntimeText(event.type, 64)}.`,
			},
			"controller-observed",
			effectiveInstanceId,
		);
	}

	/**
	 * Record a confirmed cancellation of a Pi extension dialog AFTER `answerExtensionUi(id, { cancelled: true })`
	 * succeeded on the attachment. Never fabricates resolution for non-dialog methods or failed writes.
	 */
	observePiDialogCancelled(event: { id: string; method: string; instanceId?: string }): void {
		this.#syncRuntimeObservation();
		if (!PI_DIALOG_UI_METHODS.has(event.method)) return;
		const sourceInstanceId = event.instanceId ?? this.#instanceId;
		const rawId = sanitizeRuntimeText(event.id, 256).trim();
		const reqId = rawId.length > 0 ? rawId : `pi-ui-${this.#now()}`;
		if (sourceInstanceId === this.#instanceId) {
			this.#pendingNativeApprovals.delete(reqId);
		}
		this.#emit(
			{
				kind: "native-approval",
				phase: "resolved",
				requestId: reqId,
				approvalKind: "extension-dialog",
				resolution: "cancelled",
			},
			"controller-observed",
			sourceInstanceId,
		);
	}

	/** Directly feed a constructed observation (used to test ordering/duplication/stale-instance guards). */
	ingestObservation(observation: EndoDevelopObservationV0): void {
		const result = this.#guard.ingest(observation);
		if (result.accepted !== null) this.#deliver(result.accepted);
		for (const gap of result.gaps) this.#deliver(gap);
	}

	#emit(
		body: EndoDevelopObservationV0["body"],
		basis: EndoDevelopObservationV0["basis"],
		sourceInstanceId: string = this.#instanceId,
	): void {
		const safeInstance = sanitizeRuntimeText(sourceInstanceId, 128) || "unknown";
		const seq = sourceInstanceId === this.#instanceId ? this.#guard.allocateSequence() : 1;
		const identity = this.#sessionIdentity();
		const safeSessionId =
			this.#o.session.piSessionId !== null ? sanitizeRuntimeText(this.#o.session.piSessionId, 256) || null : null;
		const obs: EndoDevelopObservationV0 = {
			schemaVersion: ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
			observationId: `pi:${safeInstance}:${seq}`,
			source: "pi-live",
			sessionKey: endoAdapterSessionKeyV0(identity),
			attachmentId: this.#o.attachmentId,
			instanceId: safeInstance,
			sequence: seq,
			observedAt: new Date(this.#now()).toISOString(),
			basis,
			nativeIds: {
				sessionId: safeSessionId,
				turnId: null,
				itemId: null,
				entryId: null,
			},
			body,
		};
		this.ingestObservation(obs);
	}

	#deliver(observation: EndoDevelopObservationV0): void {
		for (const listener of this.#listeners) {
			try {
				listener(observation);
			} catch {
				// Observer errors never break adapter state.
			}
		}
	}

	async close(): Promise<EndoDevelopCloseOutcomeV0> {
		if (!this.#closed) {
			this.#closed = true;
			this.#pendingNativeApprovals.clear();
			if (this.#o.session.close !== undefined) {
				await this.#o.session.close();
			}
			if (this.#o.session.processCleanup !== undefined) {
				const cleanups = await this.#o.session.processCleanup();
				this.#cleanup = summarizeCleanup(cleanups);
			}
		}
		return { closed: true, cleanup: this.#cleanup };
	}
}
