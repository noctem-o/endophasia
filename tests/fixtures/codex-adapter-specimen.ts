// TEST-ONLY NON-PI CONFORMANCE SPECIMEN (`test-codex-specimen`).
//
// Models the real structural differences of the Codex App Server protocol (pinned against locally observed
// `codex-cli 0.171.0` generated TypeScript schemas: `initialize`, `thread/start`, `thread/resume`, `turn/start`,
// `turn/steer` with `expectedTurnId`, `turn/interrupt` with `{ threadId, turnId }`, typed `ThreadItem` lifecycle,
// `reasoning.summary` vs `reasoning.content`, `thread/tokenUsage/updated`, and server-initiated `ServerRequest`
// approval callbacks such as `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`).
//
// STRICT BOUNDARIES:
// - NEVER a production integration and NEVER registered as a real live runtime.
// - ALWAYS carries `synthetic: true` and `source: "test-codex-specimen"`.
// - Refused unconditionally by `endoEvaluateDevelopAdmissionV0` in `"production"` mode.
// - A source guard in `tests/develop-adapter-contract.test.ts` fails if any production module imports this file.
// - Never launches Codex, never makes network/model requests, and never claims real live Codex compatibility.

import { randomBytes } from "node:crypto";
import {
	ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_SCHEMA_V0,
	type EndoAdapterCapabilityEntryV0,
	type EndoAdapterConnectionStateV0,
	type EndoAdapterCoordinationRefsV0,
	type EndoAdapterNativeApprovalKindV0,
	type EndoAdapterOperationKindV0,
	type EndoAdapterOwnershipV0,
	type EndoAdapterProcessCleanupV0,
	type EndoAdapterSessionIdentityV0,
	type EndoAdapterSessionStateV0,
	type EndoAdapterStateClaimV0,
	type EndoAdapterTurnStateV0,
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
import {
	type EndoCapabilityStateV0,
	type EndoHarnessFingerprintRecordV0,
	type EndoHarnessFingerprintV1,
	endoHarnessIdentityBasisV1,
	endoHarnessIdentityConfidenceV1,
	validateEndoCapabilityStateV0,
	validateEndoHarnessFingerprintV1,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
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

const CODEX_KNOWN_APPROVAL_KINDS = [
	"command-execution",
	"file-change",
	"permissions",
	"user-input",
	"mcp-elicitation",
] as const satisfies readonly Exclude<EndoAdapterNativeApprovalKindV0, "unknown">[];

/** Build a valid synthetic `endo.harness-fingerprint.v1` record for deterministic conformance tests. */
export function makeSyntheticCodexFingerprintV0(
	overrides: {
		version?: string | null;
		sha?: string | null;
		runtimeContentSha?: string | null;
		at?: string;
		attachment?: string;
	} = {},
): EndoHarnessFingerprintV1 {
	const version = overrides.version === undefined ? "0.171.0" : overrides.version;
	const sha = overrides.sha === undefined ? "c".repeat(64) : overrides.sha;
	const contentSha = overrides.runtimeContentSha === undefined ? "d".repeat(64) : overrides.runtimeContentSha;
	const local: EndoHarnessFingerprintV1["local"] = {
		requested: "codex",
		resolvedPath: "/usr/bin/codex",
		realPath: "/usr/bin/codex",
		entrypoint: sha === null ? null : { sha256: sha, bytes: 1024 },
		package: { name: "codex-cli", version: version ?? "0.0.0-unknown", root: "/usr" },
		runtimeContent:
			contentSha === null || sha === null
				? null
				: { scheme: "endo.runtime-content.v1", scope: "bin", files: 1, bytes: 1024, sha256: contentSha },
	};
	const reported = { versionText: version === null ? null : `codex-cli ${version}`, version };
	const gaps: EndoHarnessFingerprintV1["gaps"] = [
		...(sha === null ? [{ fact: "entrypoint" as const, reason: "binary unreadable in fixture" }] : []),
		...(local.runtimeContent === null
			? [{ fact: "runtimeContent" as const, reason: "standalone binary layout has no package scope" }]
			: []),
		...(version === null ? [{ fact: "version" as const, reason: "--version failed in fixture" }] : []),
	];
	const methods: EndoHarnessFingerprintV1["methods"] = [
		"path-search",
		"realpath",
		"entrypoint-sha256",
		"package-manifest",
		"version-command",
		...(local.runtimeContent !== null ? (["runtime-content-sha256"] as const) : []),
	];
	const body = {
		schemaVersion: "endo.harness-fingerprint.v1" as const,
		attachment: overrides.attachment ?? "codex.specimen",
		runtime: "codex",
		observedAt: overrides.at ?? "2026-11-24T00:00:00.000Z",
		methods,
		local,
		reported,
		gaps,
		identity: {
			basis: "runtime-content.v1" as const,
			digest: sha256HexV0(canonicalEndoJsonV0(endoHarnessIdentityBasisV1({ runtime: "codex", local, reported }))),
			confidence: endoHarnessIdentityConfidenceV1({ local, reported }),
		},
	};
	const record = { ...body, id: `endo.evidence.codex-specimen-fp.${sha256HexV0(canonicalEndoJsonV0(body))}` };
	const validated = validateEndoHarnessFingerprintV1(record);
	if (validated === null) throw new Error("synthetic Codex fingerprint failed validation");
	return validated;
}

/** Build a valid synthetic `endo.capability-state.v0` record for the Codex specimen. */
export function makeSyntheticCodexCapabilityStateV0(args: {
	fingerprint: EndoHarnessFingerprintRecordV0 | null;
	attachment?: string;
	admitted?: readonly string[];
	at?: string;
}): EndoCapabilityStateV0 {
	const admitted = new Set(
		args.admitted ?? ["codex.turn.start", "codex.turn.steer", "codex.turn.interrupt", "codex.thread.resume"],
	);
	const allCaps = ["codex.turn.start", "codex.turn.steer", "codex.turn.interrupt", "codex.thread.resume"];
	const evId = `endo.evidence.codex-specimen-ev.${"e".repeat(64)}`;
	const state: EndoCapabilityStateV0 = {
		schemaVersion: "endo.capability-state.v0",
		attachment: args.attachment ?? "codex.specimen",
		runtime: "codex",
		at: args.at ?? "2026-11-24T00:00:01.000Z",
		fingerprintId: args.fingerprint?.id ?? null,
		capabilities: allCaps.map((cap) =>
			args.fingerprint !== null && admitted.has(cap)
				? {
						capability: cap,
						status: "admitted",
						classification: "EXACT",
						evidenceId: evId,
						reason: "deterministic specimen check",
						requires: "local-protocol",
					}
				: {
						capability: cap,
						status: "unverified",
						classification: null,
						evidenceId: null,
						reason: "no current conformance evidence in specimen",
						requires: "local-protocol",
					},
		),
	};
	const validated = validateEndoCapabilityStateV0(state);
	if (validated === null) throw new Error("synthetic Codex capability state failed validation");
	return validated;
}

export interface CodexSpecimenOptionsV0 {
	readonly attachmentId?: string;
	readonly launchId?: string;
	readonly instanceId?: string;
	readonly projectScope?: string | null;
	readonly threadId?: string;
	readonly sessionTreeId?: string | null;
	readonly alias?: string | null;
	readonly parentSessionKey?: string | null;
	readonly ownership?: EndoAdapterOwnershipV0;
	readonly controlPath?: string | null;
	readonly fingerprint?: EndoHarnessFingerprintRecordV0 | null;
	readonly capabilityState?: EndoCapabilityStateV0 | null;
	readonly now?: () => number;
}

export type CodexSpecimenFaultV0 = "none" | "disconnect-mid-request" | "partial-result" | "runtime-refusal";

/**
 * Deterministic Codex App Server conformance specimen (`synthetic: true`).
 * Exercises thread/turn/item lifecycle, `expectedTurnId` steering, targeted `turn/interrupt`,
 * server-initiated approvals, summary-vs-raw reasoning, and unavailable usage/cost reporting.
 */
export class CodexAdapterSpecimenV0 implements EndoDevelopLiveAdapterV0 {
	readonly #attachmentId: string;
	readonly #launchId: string;
	readonly #now: () => number;
	#instanceId: string;
	#projectScope: string | null;
	#threadId: string | null;
	#sessionTreeId: string | null;
	#alias: string | null;
	#ownership: EndoAdapterOwnershipV0;
	#controlPath: string | null;
	#initialized = false;
	#connection: { state: EndoAdapterConnectionStateV0; reason: string | null } = {
		state: "disconnected",
		reason: "App Server initialize handshake has not completed yet.",
	};
	#fingerprint: EndoHarnessFingerprintRecordV0 | null;
	#capabilityState: EndoCapabilityStateV0 | null;
	#evidenceConfidenceAtCheck: "strong" | "reduced" | undefined;
	#staleReason: string | null = null;
	#capabilityOverrides = new Map<EndoAdapterOperationKindV0, EndoAdapterCapabilityEntryV0>();
	#activeTurn: { turnId: string; state: EndoAdapterTurnStateV0 } | null = null;
	#turnCounter = 0;
	#closed = false;
	#nextFault: CodexSpecimenFaultV0 = "none";
	#pendingApprovals = new Map<string, EndoDevelopNativeApprovalRequestV0>();
	#cleanup: EndoAdapterProcessCleanupV0 = {
		boundary: "unverified",
		result: "unverified",
		remainingProcesses: null,
		scopeName: null,
	};
	#coordination: EndoAdapterCoordinationRefsV0;
	readonly #guard: EndoObservationGuardV0;
	readonly #listeners = new Set<(observation: EndoDevelopObservationV0) => void>();
	/** Recorded wire-level invocations for conformance assertions. */
	readonly calls: { method: string; params: Record<string, unknown> }[] = [];

	constructor(options: CodexSpecimenOptionsV0 = {}) {
		this.#attachmentId = options.attachmentId ?? "codex.specimen";
		this.#launchId = options.launchId ?? randomBytes(8).toString("hex");
		this.#instanceId = options.instanceId ?? randomBytes(8).toString("hex");
		this.#projectScope = options.projectScope ?? "/workspace/demo";
		this.#threadId = options.threadId ?? "019a0000-0000-7000-8000-000000000001";
		this.#sessionTreeId = options.sessionTreeId ?? "019a0000-0000-7000-8000-000000000000";
		this.#alias = options.alias ?? "codex-demo-thread";
		this.#ownership = options.ownership ?? "direct";
		this.#controlPath = options.controlPath === undefined ? "test-codex-specimen-broker" : options.controlPath;
		this.#now = options.now ?? (() => Date.parse("2026-11-24T12:00:00.000Z"));
		this.#fingerprint =
			options.fingerprint === undefined
				? makeSyntheticCodexFingerprintV0({ attachment: this.#attachmentId })
				: options.fingerprint;
		this.#evidenceConfidenceAtCheck = this.#fingerprint?.identity.confidence;
		this.#capabilityState =
			options.capabilityState === undefined
				? makeSyntheticCodexCapabilityStateV0({ fingerprint: this.#fingerprint, attachment: this.#attachmentId })
				: options.capabilityState;
		this.#coordination = {
			parentSession:
				options.parentSessionKey != null
					? { sessionKey: options.parentSessionKey, basis: "runtime-reported", claimedBy: "test-codex-specimen" }
					: null,
			children: [],
			taskBindings: [],
		};
		this.#guard = new EndoObservationGuardV0({
			source: "test-codex-specimen",
			attachmentId: this.#attachmentId,
			instanceId: this.#instanceId,
			sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
		});
	}

	get instanceId(): string {
		return this.#instanceId;
	}

	get launchId(): string {
		return this.#launchId;
	}

	get activeTurnId(): string | null {
		return this.#activeTurn?.turnId ?? null;
	}

	/** Simulate `initialize` + `thread/start` handshake. */
	initialize(options: { threadId?: string | null; keyScope?: "persistent" | "launch" } = {}): void {
		this.#initialized = true;
		if (options.threadId !== undefined) this.#threadId = options.threadId;
		this.#connection = { state: "connected", reason: null };
		this.#guard.setSessionKey(endoAdapterSessionKeyV0(this.#sessionIdentity()));
		this.#emit(
			{
				kind: "lifecycle",
				event: "session-attached",
				sessionState: "idle",
				turnState: null,
				detail: "codex app-server initialized",
			},
			"controller-observed",
		);
	}

	/** Simulate transport disconnect WITHOUT terminating the underlying thread or process. */
	simulateDisconnect(reason = "App Server stdio pipe closed unexpectedly."): void {
		this.#connection = { state: "disconnected", reason };
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

	/** Simulate reconnect (new connection instance, optionally new runtime fingerprint). */
	reconnect(options: { newInstanceId?: string; newFingerprint?: EndoHarnessFingerprintRecordV0 | null } = {}): string {
		this.#instanceId = options.newInstanceId ?? randomBytes(8).toString("hex");
		this.#activeTurn = null;
		this.#pendingApprovals.clear();
		if (options.newFingerprint !== undefined) {
			this.#fingerprint = options.newFingerprint;
		}
		this.#connection = { state: "connected", reason: null };
		this.#initialized = true;
		this.#guard.rotateInstance(this.#instanceId, endoAdapterSessionKeyV0(this.#sessionIdentity()));
		return this.#instanceId;
	}

	setNextFault(fault: CodexSpecimenFaultV0): void {
		this.#nextFault = fault;
	}

	setOwnership(ownership: EndoAdapterOwnershipV0): void {
		this.#ownership = ownership;
	}

	setControlPath(controlPath: string | null): void {
		this.#controlPath = controlPath;
	}

	setCapabilityState(state: EndoCapabilityStateV0 | null): void {
		this.#capabilityState = state;
	}

	setCapabilityOverride(op: EndoAdapterOperationKindV0, entry: EndoAdapterCapabilityEntryV0 | null): void {
		if (entry === null) this.#capabilityOverrides.delete(op);
		else this.#capabilityOverrides.set(op, entry);
	}

	markEvidenceStale(reason: string | null): void {
		this.#staleReason = reason;
	}

	setFingerprint(fp: EndoHarnessFingerprintRecordV0 | null): void {
		this.#fingerprint = fp;
	}

	registerChildThread(childSessionKey: string): void {
		this.#coordination = {
			...this.#coordination,
			children: [
				...this.#coordination.children,
				{ sessionKey: childSessionKey, basis: "runtime-reported", claimedBy: "test-codex-specimen" },
			],
		};
	}

	/** Emit a Codex reasoning summary item (must NEVER be relabelled as `raw-thinking`). */
	emitReasoningSummary(summaryText: string, itemId = "item-reasoning-1"): void {
		this.#emit(
			{
				kind: "transcript",
				role: "assistant",
				contentKind: "reasoning",
				reasoningKind: "reasoning-summary",
				text: summaryText,
				truncated: false,
				stopReason: null,
			},
			"runtime-reported",
			this.#instanceId,
			{ itemId },
		);
	}

	/** Emit a Codex `commandExecution` or `fileChange` item observation. */
	emitItemActivity(args: {
		itemId: string;
		activityKind: "command-execution" | "file-change" | "mcp-tool" | "subagent-activity";
		name: string;
		phase: "started" | "completed" | "failed" | "declined";
		exitCode?: number | null;
	}): void {
		this.#emit(
			{
				kind: "tool-activity",
				activityKind: args.activityKind,
				name: args.name,
				phase: args.phase,
				callId: args.itemId,
				exitCode: args.exitCode ?? null,
			},
			"runtime-reported",
			this.#instanceId,
			{ itemId: args.itemId },
		);
	}

	/** Emit `thread/tokenUsage/updated` (or unavailable when usage is null). */
	emitTokenUsage(
		tokens: { input: number; output: number; cached: number; reasoning: number; total: number } | null,
	): void {
		this.#emit(
			{
				kind: "usage",
				usage:
					tokens !== null
						? {
								status: "reported",
								value: {
									inputTokens: tokens.input,
									outputTokens: tokens.output,
									cachedInputTokens: tokens.cached,
									cacheWriteTokens: null,
									reasoningTokens: tokens.reasoning,
									totalTokens: tokens.total,
									// Codex App Server token usage reports tokens, never USD cost.
									costUsd: null,
								},
							}
						: {
								status: "unavailable",
								reason: "Codex thread/tokenUsage/updated was not received for this turn.",
							},
			},
			tokens !== null ? "runtime-reported" : "controller-observed",
		);
	}

	/** Simulate a server-initiated Codex approval request (pauses turn into `waiting-approval`). */
	emitNativeApprovalRequest(args: {
		requestId: string;
		approvalKind: EndoAdapterNativeApprovalKindV0;
		nativeMethod: string;
		itemId: string;
		requestedScope?: "once" | "session" | "policy-amendment" | "unknown";
		summary: string;
	}): EndoDevelopNativeApprovalRequestV0 {
		const sessionKey = endoAdapterSessionKeyV0(this.#sessionIdentity()) ?? "test-codex-specimen:launch:uninitialized";
		const req: EndoDevelopNativeApprovalRequestV0 = {
			requestId: args.requestId,
			source: "test-codex-specimen",
			sessionKey,
			instanceId: this.#instanceId,
			turnId: this.#activeTurn?.turnId ?? null,
			itemId: args.itemId,
			approvalKind: args.approvalKind,
			nativeMethod: args.nativeMethod,
			requestedScope: args.requestedScope ?? "once",
			summary: args.summary,
		};
		this.#pendingApprovals.set(req.requestId, req);
		this.#emit(
			{
				kind: "native-approval",
				phase: "requested",
				requestId: req.requestId,
				approvalKind: req.approvalKind,
				resolution: "pending",
			},
			"runtime-reported",
			this.#instanceId,
			{ itemId: req.itemId },
		);
		return req;
	}

	/** Complete the currently active turn (`turn/completed`). */
	completeActiveTurn(outcome: "completed" | "interrupted" | "failed" = "completed"): void {
		if (this.#activeTurn === null) return;
		const turnId = this.#activeTurn.turnId;
		this.#activeTurn = null;
		this.#pendingApprovals.clear();
		this.#emit(
			{
				kind: "lifecycle",
				event:
					outcome === "interrupted" ? "turn-interrupted" : outcome === "failed" ? "turn-failed" : "turn-completed",
				sessionState: "idle",
				turnState: outcome,
				detail: null,
			},
			"runtime-reported",
			this.#instanceId,
			{ turnId },
		);
	}

	/** Feed a raw observation (used to exercise duplicate, out-of-order, and late-instance guards). */
	ingestRawObservation(obs: EndoDevelopObservationV0): void {
		const result = this.#guard.ingest(obs);
		if (result.accepted !== null) this.#deliver(result.accepted);
		for (const gap of result.gaps) this.#deliver(gap);
	}

	#sessionIdentity(): EndoAdapterSessionIdentityV0 {
		if (!this.#initialized || this.#threadId === null) {
			return {
				source: "test-codex-specimen",
				key: { status: "established", id: this.#launchId, scope: "launch" },
				alias: this.#alias,
				nativeRef: null,
			};
		}
		return {
			source: "test-codex-specimen",
			key: { status: "established", id: this.#threadId, scope: "persistent" },
			alias: this.#alias,
			nativeRef: { kind: "codex-thread", threadId: this.#threadId, sessionTreeId: this.#sessionTreeId },
		};
	}

	#evidenceFreshness(): EndoDevelopAdapterDescriptorV0["evidenceFreshness"] {
		if (this.#fingerprint === null) {
			return { status: "unidentified", reason: "Codex specimen binary is unidentified." };
		}
		if (this.#staleReason !== null) {
			return { status: "stale", reason: this.#staleReason };
		}
		if (this.#capabilityState !== null && this.#capabilityState.fingerprintId !== this.#fingerprint.id) {
			return {
				status: "stale",
				reason: `Capability state fingerprint ${this.#capabilityState.fingerprintId ?? "none"} does not match current ${this.#fingerprint.id}.`,
			};
		}
		return { status: "current", reason: null };
	}

	#cap(op: EndoAdapterOperationKindV0, capId: string): EndoAdapterCapabilityEntryV0 {
		const overridden = this.#capabilityOverrides.get(op);
		if (overridden !== undefined) return overridden;
		return endoDevelopCapabilityFromStateV0({
			state: this.#capabilityState,
			capabilityId: capId,
			expectedRuntime: "codex",
			expectedAttachment: this.#attachmentId,
			currentFingerprint: this.#fingerprint,
			...(this.#evidenceConfidenceAtCheck === undefined
				? {}
				: { evidenceFingerprintConfidence: this.#evidenceConfidenceAtCheck }),
		});
	}

	describe(): EndoDevelopAdapterDescriptorV0 {
		const session = this.#sessionIdentity();
		const freshness = this.#evidenceFreshness();
		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0,
			harness: {
				family: "codex",
				observedVersion: this.#fingerprint?.reported.version ?? null,
			},
			synthetic: true,
			controlPath: this.#controlPath,
			// CRITICAL: Pi Everyday session-grant eligibility is NEVER generalized to Codex.
			everydayGrantEligible: false,
			runtimeFingerprint: endoDevelopFingerprintRefV0(this.#fingerprint, "Codex specimen is unidentified."),
			session,
			ownership:
				this.#ownership === "direct"
					? { status: "established", value: "direct", basis: "controller-observed", by: "endophasia" }
					: {
							status: "established",
							value: this.#ownership,
							basis: "runtime-reported",
							by: "test-codex-specimen",
						},
			attachment: {
				attachmentId: this.#attachmentId,
				launchId: this.#launchId,
				instanceId: this.#instanceId,
				projectScope: this.#projectScope,
			},
			capabilityState: this.#capabilityState,
			evidenceFreshness: freshness,
			operations: {
				prompt: {
					capability: this.#cap("prompt", "codex.turn.start"),
					delivery: "starts-turn",
					yieldsTurnId: true,
				},
				steer: {
					capability: this.#cap("steer", "codex.turn.steer"),
					delivery: "active-turn-precondition",
					requiresTargetTurnId: true,
					returnsReceiptId: true,
				},
				queue: {
					capability: this.#capabilityOverrides.get("queue") ?? {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason:
							"Codex App Server does not expose Pi-style follow_up queue semantics; use turn/steer with expectedTurnId.",
					},
					delivery: "unsupported",
					returnsReceiptId: false,
				},
				stop: {
					capability: this.#cap("stop", "codex.turn.interrupt"),
					targeting: "targeted-turn-interrupt",
					requiresTargetTurnId: true,
					acknowledgementSemantics: "on-interrupt-accepted",
				},
				resume: {
					capability: this.#cap("resume", "codex.thread.resume"),
					mode: "thread-resume",
					replaysHistory: "optional",
				},
				nativeCommand: {
					capability: this.#capabilityOverrides.get("native-command") ?? {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason:
							"Codex App Server does not expose a typed programmatic slash-command transport; never downgrade to turn/start text.",
					},
					transport: "unsupported",
					allowsArbitraryShell: false,
				},
				attachments: {
					supported: true,
					kinds: ["image", "local-image", "audio", "local-audio", "skill-reference", "mention-reference"],
					delivery: ["reference"],
					maxCount: 8,
					maxBytesPerItem: 10 * 1024 * 1024,
					requiresExplicitAdmission: true,
					allowsArbitraryPathRead: false,
				},
				nativeApprovals: {
					mode: "server-initiated-requests",
					knownKinds: CODEX_KNOWN_APPROVAL_KINDS,
					unknownPolicy: "fail-closed",
				},
				coordination: {
					canDiscoverChildren: true,
					reportsParentRef: true,
					delegationSupported: false,
				},
			},
		};
	}

	snapshot(): EndoDevelopSessionSnapshotV0 {
		const identity = this.#sessionIdentity();
		const sessionKey = endoAdapterSessionKeyV0(identity);
		const connected = this.#connection.state === "connected" && !this.#closed;
		const sessionState: EndoAdapterSessionStateV0 = !connected
			? "unknown"
			: this.#pendingApprovals.size > 0
				? "waiting-approval"
				: this.#activeTurn !== null
					? "active"
					: "idle";
		const claims: EndoAdapterStateClaimV0[] = connected
			? [
					{
						state: sessionState,
						basis: "runtime-reported",
						by: "test-codex-specimen",
						at: new Date(this.#now()).toISOString(),
					},
				]
			: [];
		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_SCHEMA_V0,
			observedAt: new Date(this.#now()).toISOString(),
			sessionKey,
			attachment: {
				attachmentId: this.#attachmentId,
				launchId: this.#launchId,
				instanceId: this.#instanceId,
				projectScope: this.#projectScope,
			},
			connection: this.#closed ? { state: "disconnected", reason: "Codex specimen is closed." } : this.#connection,
			stateClaims: claims,
			activeTurn:
				connected && this.#activeTurn !== null
					? { turnId: this.#activeTurn.turnId, state: this.#activeTurn.state, basis: "runtime-reported" }
					: null,
			pendingNativeApprovalCount: this.#pendingApprovals.size,
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
		const fault = this.#nextFault;
		this.#nextFault = "none";

		if (fault === "disconnect-mid-request") {
			this.simulateDisconnect("Transport dropped while awaiting Codex App Server JSON-RPC response.");
			this.#emit(
				{
					kind: "evidence-gap",
					gap: "disconnected-mid-request",
					reason: `Connection lost during ${request.kind}; server receipt is unknown.`,
				},
				"controller-observed",
			);
			return {
				status: "unknown",
				operation: request.kind,
				instanceId: dispatchedInstance,
				reason: "Connection dropped after dispatch before response arrived.",
				dispatched: true,
			};
		}
		if (fault === "partial-result") {
			this.#emit(
				{
					kind: "evidence-gap",
					gap: "partial-operation-result",
					reason: `Codex App Server returned a partial/malformed reply for ${request.kind}.`,
				},
				"controller-observed",
			);
			return {
				status: "unknown",
				operation: request.kind,
				instanceId: dispatchedInstance,
				reason: "Server returned a partial response missing required turn identifiers.",
				dispatched: true,
			};
		}
		if (fault === "runtime-refusal") {
			return {
				status: "refused",
				operation: request.kind,
				stage: "runtime",
				code: "runtime-refused",
				reason: "Codex App Server returned JSON-RPC error refusing the request.",
			};
		}

		switch (request.kind) {
			case "prompt": {
				this.#turnCounter += 1;
				const turnId = `019a0000-0000-7000-8000-${String(this.#turnCounter).padStart(12, "0")}`;
				this.calls.push({ method: "turn/start", params: { threadId: this.#threadId, input: [{ type: "text" }] } });
				this.#activeTurn = { turnId, state: "in-progress" };
				this.#emit(
					{
						kind: "lifecycle",
						event: "turn-started",
						sessionState: "active",
						turnState: "in-progress",
						detail: null,
					},
					"runtime-reported",
					dispatchedInstance,
					{ turnId },
				);
				return {
					status: "accepted",
					operation: "prompt",
					instanceId: dispatchedInstance,
					disposition: "turn-started",
					turnId,
					receiptId: turnId,
					consequenceObserved: false,
				};
			}
			case "steer": {
				const turnId = this.#activeTurn!.turnId;
				this.calls.push({
					method: "turn/steer",
					params: { threadId: this.#threadId, expectedTurnId: request.targetTurnId },
				});
				return {
					status: "accepted",
					operation: "steer",
					instanceId: dispatchedInstance,
					disposition: "steered",
					turnId,
					receiptId: `${turnId}:steer`,
					consequenceObserved: false,
				};
			}
			case "stop": {
				const turnId = this.#activeTurn!.turnId;
				this.calls.push({
					method: "turn/interrupt",
					params: { threadId: this.#threadId, turnId: request.targetTurnId },
				});
				return {
					status: "accepted",
					operation: "stop",
					instanceId: dispatchedInstance,
					disposition: "interrupt-accepted",
					turnId,
					receiptId: `${turnId}:interrupt`,
					consequenceObserved: false,
				};
			}
			case "resume": {
				this.calls.push({
					method: "thread/resume",
					params: { threadId: request.targetSessionId, excludeTurns: request.replayHistory !== true },
				});
				this.#threadId = request.targetSessionId;
				this.#guard.setSessionKey(endoAdapterSessionKeyV0(this.#sessionIdentity()));
				return {
					status: "accepted",
					operation: "resume",
					instanceId: dispatchedInstance,
					disposition: "thread-resumed",
					turnId: null,
					receiptId: request.targetSessionId,
					consequenceObserved: false,
				};
			}
			case "queue":
			case "native-command":
				return {
					status: "refused",
					operation: request.kind,
					stage: "admission",
					code: request.kind === "native-command" ? "native-command-unsupported" : "operation-unsupported",
					reason: `${request.kind} is unsupported by the Codex specimen.`,
				};
		}
	}

	handleNativeApproval(
		request: EndoDevelopNativeApprovalRequestV0,
		decision: EndoDevelopNativeApprovalDecisionV0 | null = null,
		options?: { nowMs?: number; allowSessionOrPolicyScope?: boolean },
	): EndoDevelopNativeApprovalOutcomeV0 {
		const connected = !this.#closed && this.#connection.state === "connected";
		const pending = this.#pendingApprovals.get(request.requestId);
		const pendingMatches =
			pending !== undefined &&
			pending.source === request.source &&
			pending.sessionKey === request.sessionKey &&
			pending.instanceId === request.instanceId &&
			pending.turnId === request.turnId &&
			pending.itemId === request.itemId &&
			pending.approvalKind === request.approvalKind &&
			pending.nativeMethod === request.nativeMethod &&
			pending.requestedScope === request.requestedScope;
		if (!pendingMatches) {
			return {
				resolution: "cancelled",
				requestId: request.requestId,
				code: "binding-mismatch",
				reason: "Native approval request is not pending or was already resolved (replay refused).",
				grantsEndophasiaAuthority: false,
			};
		}
		const outcome = endoEvaluateNativeApprovalV0({
			request,
			decision,
			current: {
				source: "test-codex-specimen",
				sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
				instanceId: this.#instanceId,
				connected,
				activeTurnId: this.#activeTurn?.turnId ?? null,
				knownKinds: CODEX_KNOWN_APPROVAL_KINDS,
				mode: "server-initiated-requests",
				nowMs: options?.nowMs ?? this.#now(),
				...(options?.allowSessionOrPolicyScope === undefined
					? {}
					: { allowSessionOrPolicyScope: options.allowSessionOrPolicyScope }),
			},
		});
		// JSON-RPC ServerRequest ids are single-use: once a response is sent to the server, remove from pending.
		this.#pendingApprovals.delete(request.requestId);
		this.#emit(
			{
				kind: "native-approval",
				phase: "resolved",
				requestId: request.requestId,
				approvalKind: request.approvalKind,
				resolution: outcome.resolution,
			},
			"controller-observed",
			this.#instanceId,
			{ itemId: request.itemId },
		);
		return outcome;
	}

	subscribeObservations(listener: (observation: EndoDevelopObservationV0) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(
		body: EndoDevelopObservationV0["body"],
		basis: EndoDevelopObservationV0["basis"],
		sourceInstanceId: string = this.#instanceId,
		extraIds: { turnId?: string | null; itemId?: string | null; entryId?: string | null } = {},
	): void {
		const seq = sourceInstanceId === this.#instanceId ? this.#guard.allocateSequence() : 1;
		const obs: EndoDevelopObservationV0 = {
			schemaVersion: ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
			observationId: `codex-specimen:${sourceInstanceId}:${seq}`,
			source: "test-codex-specimen",
			sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
			attachmentId: this.#attachmentId,
			instanceId: sourceInstanceId,
			sequence: seq,
			observedAt: new Date(this.#now()).toISOString(),
			basis,
			nativeIds: {
				sessionId: this.#threadId,
				turnId: extraIds.turnId !== undefined ? extraIds.turnId : (this.#activeTurn?.turnId ?? null),
				itemId: extraIds.itemId ?? null,
				entryId: extraIds.entryId ?? null,
			},
			body,
		};
		this.ingestRawObservation(obs);
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
		this.#closed = true;
		this.#connection = { state: "disconnected", reason: "Codex specimen closed." };
		this.#pendingApprovals.clear();
		this.#cleanup = {
			boundary: "not-applicable",
			result: "not-applicable",
			remainingProcesses: 0,
			scopeName: null,
		};
		return { closed: true, cleanup: this.#cleanup };
	}
}
