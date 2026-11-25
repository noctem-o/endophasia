/**
 * Milestones D3, D4, D5 — Live Codex App Server operational adapter (`CodexDevelopAdapterV0`).
 *
 * Implements `EndoDevelopLiveAdapterV0` (`runtime/contracts/develop-adapter.ts`) for the real installed Codex CLI
 * (`codex app-server --listen stdio://`), preserving Codex's native thread/turn/item/approval semantics:
 * - `source: "codex-live"`, `harness.family: "codex"`, `synthetic: false`, `everydayGrantEligible: false`.
 * - Single explicitly owned fresh thread created via `thread/start` (never silently adopting external desktop/CLI threads).
 * - Verifies effective `ThreadStartResponse` policy (`approvalPolicy !== "never"`, `approvalsReviewer === "user"`,
 *   `sandbox.type !== "dangerFullAccess"`) and fails closed on permissive inheritance.
 * - Shares `<root>/events/session-attachment.lock` with Pi (`storage/writer-lock.ts`) so Codex and Pi never write
 *   `<root>/events/events.log` concurrently; event-log path is injectable for future E4 per-attachment logs.
 * - Enforces single-use operator authorization proofs (no replay), exact `(threadId, turnId)` targeting for `turn/interrupt`
 *   (and `turn/steer` when explicitly backed by capability evidence), fail-closed bidirectional `ServerRequest` approvals,
 *   reasoning-summary vs raw-reasoning provenance, nullable/unavailable usage (never 0), and honest `ProcessCleanupV0`.
 */

import { randomBytes } from "node:crypto";
import {
	ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_ADAPTER_SCHEMA_V0,
	type EndoAdapterCapabilityEntryV0,
	type EndoAdapterConnectionStateV0,
	type EndoAdapterCoordinationRefsV0,
	type EndoAdapterProcessCleanupV0,
	type EndoAdapterReasoningKindV0,
	type EndoAdapterSessionIdentityV0,
	type EndoAdapterSessionStateV0,
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
	type EndoDevelopObservationBodyV0,
	type EndoDevelopObservationV0,
	type EndoDevelopOperationRequestV0,
	type EndoDevelopSessionSnapshotV0,
	endoAdapterSessionKeyV0,
} from "../../protocol/develop-adapter.ts";
import type { EndoCapabilityStateV0, EndoHarnessFingerprintRecordV0 } from "../../protocol/harness.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
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
import { createEndoDurableEventStoreV0, type EndoDurableEventStoreV0 } from "../../storage/event-store.ts";
import { acquireEndoEventStoreWriterLockV0 } from "../../storage/writer-lock.ts";
import type { ProcessCleanupV0, ProcessExitV0, ProcessScopeV0 } from "../rpc-jsonl/process-group.ts";
import {
	CodexAppServerClientV0,
	type CodexInitializeResultV0,
	CodexRpcErrorV0,
	type CodexServerNotificationV0,
	type CodexServerRequestV0,
	CodexTransportErrorV0,
	type CodexTransportFaultV0,
} from "./app-server-client.ts";
import {
	buildCodexDisableMcpConfigV0,
	CODEX_CONSERVATIVE_CONFIG_OVERRIDES_V0,
	type CodexEffectivePolicyV0,
	inspectCodexMcpServersV0,
	verifyCodexEffectivePolicyV0,
} from "./checks.ts";
import {
	buildCodexCanonicalEventV0,
	type CodexEventContextV0,
	type CodexLifecycleStateV0,
	codexEndoSessionIdV0,
	codexLifecycleInitialStateV0,
	codexLifecycleStepV0,
} from "./events.ts";
import {
	type CodexSandboxModeV0,
	type PreparedCodexIsolatedHomeV0,
	prepareCodexIsolatedHomeV0,
	validateCodexSandboxModeV0,
	verifyCodexIsolatedHomeV0,
} from "./isolated-home.ts";
import {
	CODEX_INTERACTIVE_APPROVAL_KINDS_V0,
	CODEX_KNOWN_APPROVAL_KINDS_V0,
	encodeCodexNativeApprovalReplyV0,
	type ParsedCodexServerRequestV0,
	parseCodexServerRequestV0,
} from "./native-approvals.ts";

export const CODEX_LIVE_CONTROL_PATH_V0 = "codex-live-controller";

/** Thrown when `thread/start` returns an effective policy that violates Endophasia's governed boundaries. */
export class CodexPolicyViolationErrorV0 extends Error {
	readonly reasons: readonly string[];

	constructor(reasons: readonly string[]) {
		super(`Codex effective policy violated governed boundaries: ${reasons.join("; ")}`);
		this.name = "CodexPolicyViolationErrorV0";
		this.reasons = reasons;
	}
}

export interface CodexLiveTranscriptItemV0 {
	readonly itemId: string | null;
	readonly turnId: string | null;
	readonly role: "user" | "assistant";
	readonly contentKind: "text" | "reasoning";
	readonly reasoningKind: EndoAdapterReasoningKindV0 | null;
	readonly text: string;
	readonly completed: boolean;
}

export interface CodexLiveActivityItemV0 {
	readonly itemId: string;
	readonly turnId: string | null;
	readonly activityKind: "tool-call" | "command-execution" | "file-change" | "mcp-tool" | "subagent-activity";
	readonly name: string;
	readonly phase: "started" | "updated" | "completed" | "failed" | "declined" | "unknown";
	readonly exitCode: number | null;
}

/** Memory-only live view of a Codex session (never persisted into canonical evidence). */
export interface CodexLiveViewV0 {
	readonly threadId: string | null;
	readonly sessionTreeId: string | null;
	readonly effectivePolicy: CodexEffectivePolicyV0 | null;
	readonly activeTurnId: string | null;
	readonly transcript: readonly CodexLiveTranscriptItemV0[];
	readonly activity: readonly CodexLiveActivityItemV0[];
	readonly lastUsage: EndoAdapterUsageReportV0 | null;
	readonly totalUsage: EndoAdapterUsageReportV0 | null;
	readonly modelContextWindow: number | null;
	readonly pendingApprovals: readonly EndoDevelopNativeApprovalRequestV0[];
	readonly observedNotifications: readonly string[];
}

export type CodexNativeApprovalHandlerV0 = (
	request: EndoDevelopNativeApprovalRequestV0,
	signal: AbortSignal,
) => Promise<EndoDevelopNativeApprovalDecisionV0 | null>;

export interface CodexDevelopAdapterOptionsV0 {
	/** Store root directory (for event store `<root>/events/events.log` and shared writer lock). */
	readonly root: string;
	/** Attachment identifier (well-formed dotted kind, e.g. `codex.default`). */
	readonly attachmentId: string;
	/** Launch identifier for this run. Default: random 16-hex. */
	readonly launchId?: string;
	/** Explicit workspace directory bound to this owned thread. */
	readonly projectScope: string;
	/** Resolved Codex executable path (or deterministic fake App Server in tests). */
	readonly executable: string;
	/** Optional explicit argv override (for fake-server tests). */
	readonly args?: readonly string[];
	/** Additional `-c` overrides appended after `CODEX_CONSERVATIVE_CONFIG_OVERRIDES_V0`. */
	readonly extraConfigOverrides?: readonly string[];
	/** Environment passed to Codex child process. */
	readonly env?: Readonly<Record<string, string>>;
	/** Optional containment scope (`ProcessScopeV0`). */
	readonly scope?: ProcessScopeV0;
	/** Optional model ID to request on `thread/start` and `turn/start` (e.g. `gpt-6.2-sol`). */
	readonly model?: string;
	/** Optional conservative reasoning effort (e.g. `"low"`). */
	readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
	/** Conservative sandbox mode (`workspace-write` or `read-only`). Default: `workspace-write`. */
	readonly sandboxMode?: CodexSandboxModeV0;
	/** Optional source Codex home directory used ONLY to symlink `auth.json` when present (never modified). */
	readonly sourceCodexHome?: string;
	/** Whether to start the owned thread as ephemeral (`ephemeral: true`). Default: `false`. */
	readonly ephemeral?: boolean;
	/** Observed runtime fingerprint for this attachment. */
	readonly fingerprint: EndoHarnessFingerprintRecordV0;
	/** Validated capability state derived for `fingerprint`. */
	readonly capabilityState: EndoCapabilityStateV0;
	/** Optional evidence staleness hook (returns non-null reason if config/runtime drifted). */
	readonly staleEvidenceReason?: () => string | null;
	/** Optional interactive operator native-approval handler; if omitted, all native approvals decline fail-closed. */
	readonly onNativeApprovalRequest?: CodexNativeApprovalHandlerV0;
	/** Optional override for event log path (injectable for future E4 per-attachment logs). */
	readonly eventLogPath?: string;
	/** Optional override for writer lock path. */
	readonly writerLockPath?: string;
	/** Per-request timeout ms. Default: 30_000. */
	readonly requestTimeoutMs?: number;
	/** Clock override for deterministic tests. */
	readonly now?: () => number;
	/** Disable all inherited MCP servers discovered from `config/read`. Default: `true`. */
	readonly disableInheritedMcpServers?: boolean;
	/** Optional allowlist of MCP server names to keep enabled when `disableInheritedMcpServers` is true. */
	readonly allowMcpServers?: readonly string[];
	/** Max memory-only live transcript entries retained. Default: 200. */
	readonly maxLiveTranscriptItems?: number;
	/** Max single JSONL frame bytes passed to transport. */
	readonly maxRecordBytes?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeNonNegInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const UNSAFE_TERMINAL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const sanitizeText = (value: string, max: number): string =>
	value.replace(UNSAFE_TERMINAL_CHARS, " ").trim().slice(0, max);

const sanitizeOptional = (value: unknown, max: number): string | null => {
	if (typeof value !== "string") return null;
	const cleaned = sanitizeText(value, max);
	return cleaned.length > 0 ? cleaned : null;
};

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const THREAD_SCOPED_NOTIFICATIONS = new Set([
	"turn/started",
	"turn/completed",
	"item/started",
	"item/completed",
	"item/agentMessage/delta",
	"item/reasoning/summaryTextDelta",
	"item/reasoning/textDelta",
	"thread/tokenUsage/updated",
	"thread/compacted",
	"serverRequest/resolved",
	"error",
]);

const MAX_TRANSCRIPT_TEXT_CHARS = 32_768;

const BENIGN_STATUS_NOTIFICATIONS = new Set([
	"thread/started",
	"thread/status/changed",
	"thread/readState/changed",
	"thread/name/updated",
	"thread/settings/updated",
	"thread/queue/changed",
	"remoteControl/status/changed",
	"item/commandExecution/outputDelta",
	"item/commandExecution/terminalInteraction",
	"item/fileChange/outputDelta",
	"item/fileChange/patchUpdated",
	"item/reasoning/summaryPartAdded",
	"item/plan/delta",
	"turn/diff/updated",
	"turn/plan/updated",
	"turn/moderationMetadata",
	"rawResponseItem/completed",
	"rawResponse/completed",
	"model/rerouted",
	"model/verification",
	"account/rateLimits/updated",
	"account/updated",
	"warning",
	"deprecationNotice",
	"configWarning",
]);

function summarizeCleanup(cleanup: ProcessCleanupV0 | null): EndoAdapterProcessCleanupV0 {
	if (cleanup === null) {
		return { boundary: "unverified", result: "unverified", remainingProcesses: null, scopeName: null };
	}
	if (cleanup.boundary === "scope") {
		if (cleanup.result === "confirmed") {
			return { boundary: "scope", result: "confirmed", remainingProcesses: 0, scopeName: cleanup.unit };
		}
		return {
			boundary: "scope",
			result: "incomplete",
			remainingProcesses: cleanup.remaining,
			scopeName: cleanup.unit,
		};
	}
	return {
		boundary: "process-group",
		result: cleanup.result,
		remainingProcesses: null,
		scopeName: null,
	};
}

function parseTokenUsageBreakdown(raw: unknown): EndoAdapterUsageReportV0 | null {
	if (!isRecord(raw)) return null;
	const input = raw.inputTokens;
	const output = raw.outputTokens;
	const total = raw.totalTokens;
	if (!isSafeNonNegInt(input) || !isSafeNonNegInt(output) || !isSafeNonNegInt(total)) return null;
	return {
		inputTokens: input,
		outputTokens: output,
		cachedInputTokens: isSafeNonNegInt(raw.cachedInputTokens) ? raw.cachedInputTokens : null,
		cacheWriteTokens: isSafeNonNegInt(raw.cacheWriteInputTokens) ? raw.cacheWriteInputTokens : null,
		reasoningTokens: isSafeNonNegInt(raw.reasoningOutputTokens) ? raw.reasoningOutputTokens : null,
		totalTokens: total,
		// Codex App Server does not report USD cost; NEVER fabricate 0.
		costUsd: null,
	};
}

function mapItemPhase(status: unknown): "started" | "updated" | "completed" | "failed" | "declined" | "unknown" {
	switch (status) {
		case "inProgress":
			return "started";
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "declined":
			return "declined";
		default:
			return "unknown";
	}
}

interface PendingApprovalEntry {
	readonly parsed: ParsedCodexServerRequestV0;
	readonly abort: AbortController;
}

/**
 * Live Codex App Server operational adapter implementing `EndoDevelopLiveAdapterV0`.
 */
export class CodexDevelopAdapterV0 implements EndoDevelopLiveAdapterV0 {
	readonly #o: CodexDevelopAdapterOptionsV0;
	readonly #launchId: string;
	readonly #now: () => number;
	readonly #maxLiveTranscript: number;
	readonly #sandboxMode: CodexSandboxModeV0;
	readonly #allowedMcpServers: ReadonlySet<string>;
	readonly #unexpectedMcpStartups = new Set<string>();

	#instanceId: string;
	#isolatedHome: PreparedCodexIsolatedHomeV0 | null = null;
	#client: CodexAppServerClientV0 | null = null;
	#store: EndoDurableEventStoreV0 | null = null;
	#releaseLock: (() => void) | null = null;
	#lifecycle: CodexLifecycleStateV0;
	#eventSequence = 0;
	#liveCounter = 0;

	#initializeResult: CodexInitializeResultV0 | null = null;
	#effectivePolicy: CodexEffectivePolicyV0 | null = null;
	#threadId: string | null = null;
	#sessionTreeId: string | null = null;
	#activeTurn: { turnId: string; state: EndoAdapterTurnStateV0 } | null = null;
	#promptInFlight = false;
	readonly #completedTurns = new Map<string, EndoAdapterTurnStateV0>();
	#connected = false;
	#disconnectedReason: string | null = "Codex adapter has not opened a live App Server connection yet.";
	#closed = false;
	#closing: Promise<EndoDevelopCloseOutcomeV0> | null = null;
	#cleanup: EndoAdapterProcessCleanupV0 = {
		boundary: "unverified",
		result: "unverified",
		remainingProcesses: null,
		scopeName: null,
	};

	#fingerprint: EndoHarnessFingerprintRecordV0;
	#capabilityState: EndoCapabilityStateV0;
	readonly #initialFingerprintId: string;
	#customStaleReason: string | null = null;

	readonly #consumedAuthorizations = new Set<string>();
	readonly #consumedNativeApprovals = new Set<string>();
	readonly #pendingApprovals = new Map<string, PendingApprovalEntry>();
	readonly #guard: EndoObservationGuardV0;
	readonly #listeners = new Set<(observation: EndoDevelopObservationV0) => void>();
	readonly #coordination: EndoAdapterCoordinationRefsV0 = {
		parentSession: null,
		children: [],
		taskBindings: [],
	};

	// Memory-only live presentation buffers (NEVER persisted to canonical event store).
	readonly #transcript: CodexLiveTranscriptItemV0[] = [];
	readonly #activity: CodexLiveActivityItemV0[] = [];
	readonly #observedNotificationMethods = new Set<string>();
	#lastUsage: EndoAdapterUsageReportV0 | null = null;
	#totalUsage: EndoAdapterUsageReportV0 | null = null;
	#modelContextWindow: number | null = null;
	readonly #turnWaiters = new Map<string, Set<(status: EndoAdapterTurnStateV0) => void>>();

	constructor(options: CodexDevelopAdapterOptionsV0) {
		if (options.reasoningEffort !== undefined && !VALID_REASONING_EFFORTS.has(options.reasoningEffort)) {
			throw new TypeError(`Invalid Codex reasoningEffort: ${String(options.reasoningEffort)}`);
		}
		this.#sandboxMode = validateCodexSandboxModeV0(options.sandboxMode ?? "workspace-write");
		this.#allowedMcpServers = new Set(options.allowMcpServers ?? []);
		this.#o = options;
		this.#launchId = options.launchId ?? randomBytes(8).toString("hex");
		this.#instanceId = randomBytes(8).toString("hex");
		this.#now = options.now ?? Date.now;
		this.#maxLiveTranscript = options.maxLiveTranscriptItems ?? 200;
		this.#fingerprint = options.fingerprint;
		this.#initialFingerprintId = options.fingerprint.id;
		this.#capabilityState = options.capabilityState;
		this.#lifecycle = codexLifecycleInitialStateV0(options.attachmentId);
		this.#guard = new EndoObservationGuardV0({
			source: "codex-live",
			attachmentId: options.attachmentId,
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

	get threadId(): string | null {
		return this.#threadId;
	}

	get sessionTreeId(): string | null {
		return this.#sessionTreeId;
	}

	get activeTurnId(): string | null {
		return this.#activeTurn?.turnId ?? null;
	}

	get initializeResult(): CodexInitializeResultV0 | null {
		return this.#initializeResult;
	}

	get effectivePolicy(): CodexEffectivePolicyV0 | null {
		return this.#effectivePolicy;
	}

	stderrDiagnostics(): { text: string; truncated: boolean } {
		return this.#client?.stderrDiagnostics() ?? { text: "", truncated: false };
	}

	/** Memory-only live view for DEVELOP presentation and CLI inspection. */
	liveView(): CodexLiveViewV0 {
		return {
			threadId: this.#threadId,
			sessionTreeId: this.#sessionTreeId,
			effectivePolicy: this.#effectivePolicy,
			activeTurnId: this.#activeTurn?.turnId ?? null,
			transcript: [...this.#transcript],
			activity: [...this.#activity],
			lastUsage: this.#lastUsage,
			totalUsage: this.#totalUsage,
			modelContextWindow: this.#modelContextWindow,
			pendingApprovals: [...this.#pendingApprovals.values()].map((entry) => entry.parsed.normalized),
			observedNotifications: [...this.#observedNotificationMethods].sort(),
		};
	}

	/** Wait for a specific turn ID to finish (or disconnect), bounded by `timeoutMs`. */
	waitForTurnCompletion(
		turnId: string,
		timeoutMs = 60_000,
	): Promise<EndoAdapterTurnStateV0 | "disconnected" | "timeout"> {
		const recorded = this.#completedTurns.get(turnId);
		if (recorded !== undefined) return Promise.resolve(recorded);
		if (!this.#connected) return Promise.resolve("disconnected");
		if (this.#activeTurn === null || this.#activeTurn.turnId !== turnId) {
			return Promise.resolve("unclassified");
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = (result: EndoAdapterTurnStateV0 | "disconnected" | "timeout") => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#turnWaiters.get(turnId)?.delete(onTurnEnd);
				resolve(result);
			};
			const onTurnEnd = (status: EndoAdapterTurnStateV0) => finish(status);
			const timer = setTimeout(() => finish("timeout"), timeoutMs);
			let set = this.#turnWaiters.get(turnId);
			if (set === undefined) {
				set = new Set();
				this.#turnWaiters.set(turnId, set);
			}
			set.add(onTurnEnd);
		});
	}

	/**
	 * Open the live Codex App Server connection:
	 * 1. Acquire the shared event-store writer lock (`<root>/events/session-attachment.lock`).
	 * 2. Open the durable event store (`<root>/events/events.log` or injected `eventLogPath`).
	 * 3. Spawn `codex app-server --listen stdio://` with conservative overrides.
	 * 4. Run `initialize`, `initialized`, `config/read`, and `thread/start`.
	 * 5. Verify effective policy (`approvalPolicy !== "never"`, `approvalsReviewer === "user"`, non-`dangerFullAccess`).
	 * On ANY failure, clean up the process, close the store, and release the writer lock.
	 */
	async open(): Promise<{
		threadId: string;
		sessionTreeId: string | null;
		initialize: CodexInitializeResultV0;
		effectivePolicy: CodexEffectivePolicyV0;
	}> {
		if (this.#closed) throw new Error("CodexDevelopAdapterV0 is closed and cannot be reopened.");
		if (this.#connected) {
			throw new Error("CodexDevelopAdapterV0 is already open.");
		}

		// Step 1: Acquire shared single-writer event-store lock BEFORE touching the store or spawning Codex.
		this.#releaseLock = acquireEndoEventStoreWriterLockV0(this.#o.root, this.#o.attachmentId, {
			...(this.#o.writerLockPath === undefined ? {} : { lockPath: this.#o.writerLockPath }),
			now: () => new Date(this.#now()),
		});

		try {
			// Step 2: Open durable event store; fail closed immediately if sealed (never run with silent audit bypass).
			this.#store = createEndoDurableEventStoreV0(this.#o.root, {
				...(this.#o.eventLogPath === undefined ? {} : { logPath: this.#o.eventLogPath }),
			});
			const rec = this.#store.recovery();
			if (rec.sealed) {
				throw new Error(
					`Event store is sealed (frame ${String(rec.corruptAt)} failed verification); refusing to open a live Codex session without durable recording.`,
				);
			}
			this.#seedSequenceFromStore();

			// Step 3: Establish an isolated conservative `CODEX_HOME` BEFORE spawning Codex App Server.
			this.#unexpectedMcpStartups.clear();
			const isolatedHome = prepareCodexIsolatedHomeV0({
				root: this.#o.root,
				cwd: this.#o.projectScope,
				sandboxMode: this.#sandboxMode,
				...(this.#o.env === undefined ? {} : { baseEnv: this.#o.env }),
				...(this.#o.sourceCodexHome === undefined ? {} : { sourceCodexHome: this.#o.sourceCodexHome }),
			});
			this.#isolatedHome = isolatedHome;

			const extra = [...(this.#o.extraConfigOverrides ?? [])];
			if (this.#o.reasoningEffort !== undefined) {
				if (!VALID_REASONING_EFFORTS.has(this.#o.reasoningEffort)) {
					throw new TypeError(`Invalid Codex reasoningEffort: ${String(this.#o.reasoningEffort)}`);
				}
				extra.push(`model_reasoning_effort="${this.#o.reasoningEffort}"`);
			}
			const configOverrides = [
				...CODEX_CONSERVATIVE_CONFIG_OVERRIDES_V0.filter((entry) => !entry.startsWith("sandbox_mode=")),
				`sandbox_mode="${this.#sandboxMode}"`,
				...extra,
			];

			const client = new CodexAppServerClientV0({
				executable: this.#o.executable,
				...(this.#o.args === undefined ? { configOverrides } : { args: this.#o.args }),
				cwd: this.#o.projectScope,
				env: isolatedHome.childEnv,
				...(this.#o.scope === undefined ? {} : { scope: this.#o.scope }),
				instanceId: this.#instanceId,
				requestTimeoutMs: this.#o.requestTimeoutMs ?? 30_000,
				...(this.#o.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.#o.maxRecordBytes }),
				onNotification: (n) => this.#onNotification(n),
				onServerRequest: (req) => this.#onServerRequest(req),
				onFault: (fault) => this.#onTransportFault(fault),
				onDisconnect: (info) => this.#onDisconnect(info),
			});
			this.#client = client;

			// Step 4: Handshake + fail-closed isolated-home verification + config/read + owned thread/start.
			const init = await client.initialize({
				clientInfo: { name: "endophasia-develop-codex", version: "0.1.0" },
				capabilities: { experimentalApi: false },
			});
			const isolatedCheck = verifyCodexIsolatedHomeV0(init.codexHome, isolatedHome.realDir);
			if (!isolatedCheck.ok) {
				throw new CodexPolicyViolationErrorV0([
					isolatedCheck.reason ?? "Isolated Codex startup home could not be verified.",
				]);
			}
			this.#initializeResult = init;
			client.notifyInitialized();

			let disabledMcpServers: string[] = [];
			let unsafeEnabledMcpServers: string[] = [];
			if (this.#o.disableInheritedMcpServers !== false) {
				const cfgRaw = await client.configRead({ includeLayers: false, cwd: this.#o.projectScope });
				const allow = new Set(this.#o.allowMcpServers ?? []);
				const mcpInfo = inspectCodexMcpServersV0(cfgRaw);
				disabledMcpServers = mcpInfo.disableableNames.filter((name) => !allow.has(name));
				unsafeEnabledMcpServers = mcpInfo.unsafeEnabledNames.filter((name) => !allow.has(name));
			}
			const mcpDisableConfig = buildCodexDisableMcpConfigV0(disabledMcpServers);

			const threadStartRaw = await client.threadStart({
				cwd: this.#o.projectScope,
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: this.#sandboxMode,
				ephemeral: this.#o.ephemeral === true,
				...(this.#o.model === undefined ? {} : { model: this.#o.model }),
				...(Object.keys(mcpDisableConfig).length > 0 ? { config: mcpDisableConfig } : {}),
			});

			// Step 5: Verify effective policy returned by Codex — fail closed if permissive or unwanted MCP started!
			const policyCheck = verifyCodexEffectivePolicyV0(threadStartRaw, {
				disabledMcpServers,
				unsafeEnabledMcpServers,
				unexpectedMcpStartups: [...this.#unexpectedMcpStartups].sort(),
				expectedSandboxMode: this.#sandboxMode,
			});
			if (!policyCheck.ok) {
				const startedThreadId =
					isRecord(threadStartRaw.thread) && typeof threadStartRaw.thread.id === "string"
						? threadStartRaw.thread.id
						: null;
				if (startedThreadId !== null) {
					try {
						await client.threadUnsubscribe({ threadId: startedThreadId }, { timeoutMs: 2_000 });
					} catch {
						// Best-effort cleanup before failing closed.
					}
				}
				throw new CodexPolicyViolationErrorV0(policyCheck.reasons);
			}

			if (this.#closed || !client.connected) {
				throw new Error("Codex transport closed or disconnected before owned thread could be established.");
			}

			const threadObj = threadStartRaw.thread as Record<string, unknown>;
			const threadId = sanitizeOptional(threadObj.id, 256);
			if (threadId === null) {
				throw new Error("Codex thread/start returned an empty or invalid thread.id.");
			}
			const sessionTreeId = sanitizeOptional(threadObj.sessionId, 256);

			this.#threadId = threadId;
			this.#sessionTreeId = sessionTreeId;
			this.#effectivePolicy = policyCheck.effective;
			this.#connected = true;
			this.#disconnectedReason = null;
			this.#guard.setSessionKey(endoAdapterSessionKeyV0(this.#sessionIdentity()));

			this.#recordCanonical("codex.thread-started", {
				instanceId: this.#instanceId,
				threadId,
				sessionTreeId,
				ephemeral: threadObj.ephemeral === true,
				model: policyCheck.effective.model,
				modelProvider: policyCheck.effective.modelProvider,
				approvalPolicy:
					typeof policyCheck.effective.approvalPolicy === "string"
						? policyCheck.effective.approvalPolicy
						: "structured",
				approvalsReviewer:
					typeof policyCheck.effective.approvalsReviewer === "string"
						? policyCheck.effective.approvalsReviewer
						: "unknown",
				sandboxType:
					isRecord(policyCheck.effective.sandbox) && typeof policyCheck.effective.sandbox.type === "string"
						? policyCheck.effective.sandbox.type
						: "unknown",
				disabledMcpCount: disabledMcpServers.length,
			});

			this.#emitObservation(
				{
					kind: "lifecycle",
					event: "session-attached",
					sessionState: "idle",
					turnState: null,
					detail: `Codex owned thread started (${policyCheck.effective.model ?? "default-model"})`,
				},
				"controller-observed",
			);

			return {
				threadId,
				sessionTreeId,
				initialize: init,
				effectivePolicy: policyCheck.effective,
			};
		} catch (error) {
			if (this.#client !== null) {
				try {
					this.#cleanup = summarizeCleanup(await this.#client.close());
				} catch {
					// Ignore teardown errors during open failure.
				}
				this.#client = null;
			}
			this.#isolatedHome?.cleanup();
			this.#isolatedHome = null;
			if (this.#store !== null) {
				try {
					this.#store.close();
				} catch {
					// Ignore close error during open failure.
				}
				this.#store = null;
			}
			this.#releaseLock?.();
			this.#releaseLock = null;
			this.#connected = false;
			this.#disconnectedReason = error instanceof Error ? error.message : "Failed to open Codex session.";
			throw error;
		}
	}

	/** Rotate connection instance identity (invalidates prior proofs and flags stale observations). */
	rotateInstance(newInstanceId = randomBytes(8).toString("hex")): string {
		// Cancel pending approvals under the old instance before rotating `#instanceId` & `#guard` so cancellation
		// observations are delivered cleanly instead of dropped as late events.
		this.#cancelAllPendingApprovals("connection instance rotated");
		this.#instanceId = newInstanceId;
		this.#activeTurn = null;
		this.#promptInFlight = false;
		this.#guard.rotateInstance(newInstanceId, endoAdapterSessionKeyV0(this.#sessionIdentity()));
		return newInstanceId;
	}

	/** Mark transport disconnected without claiming process termination. */
	markDisconnected(reason: string): void {
		if (!this.#connected && this.#disconnectedReason === reason) return;
		this.#connected = false;
		this.#disconnectedReason = reason;
		this.#cancelAllPendingApprovals(reason);
		this.#notifyAllTurnWaiters("disconnected");
		this.#emitObservation(
			{
				kind: "lifecycle",
				event: "connection-lost",
				sessionState: "unknown",
				turnState: null,
				detail: sanitizeText(reason, 256),
			},
			"controller-observed",
		);
	}

	/** Mark capability evidence stale (e.g., runtime or config drift). */
	invalidateEvidence(reason: string): void {
		this.#customStaleReason = reason;
	}

	/** Inject an observation directly through the adapter's `EndoObservationGuardV0` (for conformance tests). */
	injectGuardedObservation(obs: EndoDevelopObservationV0): void {
		const { accepted, gaps } = this.#guard.ingest(obs);
		for (const gap of gaps) {
			for (const listener of this.#listeners) listener(gap);
		}
		if (accepted !== null) {
			for (const listener of this.#listeners) listener(accepted);
		}
	}

	describe(): EndoDevelopAdapterDescriptorV0 {
		const session = this.#sessionIdentity();
		this.#guard.setSessionKey(endoAdapterSessionKeyV0(session));
		const conn = this.#connectionState();
		const connected = conn.state === "connected";
		const freshness = this.#evidenceFreshness();

		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_DESCRIPTOR_SCHEMA_V0,
			harness: {
				family: "codex",
				observedVersion: this.#fingerprint.reported.version ?? null,
			},
			synthetic: false,
			controlPath: CODEX_LIVE_CONTROL_PATH_V0,
			everydayGrantEligible: false,
			runtimeFingerprint: endoDevelopFingerprintRefV0(this.#fingerprint),
			session,
			ownership:
				connected && this.#threadId !== null
					? { status: "established", value: "direct", basis: "controller-observed", by: "endophasia" }
					: {
							status: "unavailable",
							reason:
								"Direct ownership holds only while Endophasia holds the live connection to its owned Codex thread.",
						},
			attachment: {
				attachmentId: this.#o.attachmentId,
				launchId: this.#launchId,
				instanceId: this.#instanceId,
				projectScope: this.#o.projectScope,
			},
			capabilityState: this.#capabilityState,
			evidenceFreshness: freshness,
			operations: {
				prompt: {
					capability: this.#capFromState("codex.turn.start"),
					delivery: "starts-turn",
					yieldsTurnId: true,
				},
				steer: {
					capability: this.#capFromState("codex.turn.steer"),
					delivery: "active-turn-precondition",
					requiresTargetTurnId: true,
					returnsReceiptId: false,
				},
				queue: {
					capability: {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason: "Codex App Server exposes no Pi-equivalent follow_up queue RPC.",
					},
					delivery: "unsupported",
					returnsReceiptId: false,
				},
				stop: {
					capability: this.#capFromState("codex.turn.interrupt"),
					targeting: "targeted-turn-interrupt",
					requiresTargetTurnId: true,
					acknowledgementSemantics: "on-interrupt-accepted",
				},
				resume: {
					capability: {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason:
							"DEVELOP-CODEX-LIVE-001 launches explicitly owned fresh threads only; thread/resume is not admitted.",
					},
					mode: "unsupported",
					replaysHistory: "unknown",
				},
				nativeCommand: {
					capability: {
						standing: "unsupported",
						evidenceCapability: null,
						evidenceId: null,
						reason:
							"Codex App Server exposes no typed programmatic slash-command RPC; shell execution is forbidden.",
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
					mode: "server-initiated-requests",
					knownKinds: CODEX_KNOWN_APPROVAL_KINDS_V0,
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
		const sessionKey = endoAdapterSessionKeyV0(this.#sessionIdentity());
		const connection = this.#connectionState();
		const connected = connection.state === "connected";
		const stateClaims: EndoAdapterStateClaimV0[] = [];
		if (connected) {
			const state: EndoAdapterSessionStateV0 =
				this.#pendingApprovals.size > 0 ? "waiting-approval" : this.#activeTurn !== null ? "active" : "idle";
			stateClaims.push({
				state,
				basis: "controller-observed",
				by: "endophasia",
				at: new Date(this.#now()).toISOString(),
			});
		}
		return {
			schemaVersion: ENDO_DEVELOP_ADAPTER_SCHEMA_V0,
			observedAt: new Date(this.#now()).toISOString(),
			sessionKey,
			attachment: {
				attachmentId: this.#o.attachmentId,
				launchId: this.#launchId,
				instanceId: this.#instanceId,
				projectScope: this.#o.projectScope,
			},
			connection,
			stateClaims,
			activeTurn:
				connected && this.#activeTurn !== null
					? { turnId: this.#activeTurn.turnId, state: this.#activeTurn.state, basis: "runtime-reported" }
					: null,
			pendingNativeApprovalCount: connected ? this.#pendingApprovals.size : 0,
			processCleanup: this.#cleanup,
			coordination: this.#coordination,
		};
	}

	admitOperation(
		request: EndoDevelopOperationRequestV0,
		authority: EndoDevelopAuthorityProofV0 | null,
		options?: EndoDevelopAdmissionOptionsV0,
	): EndoDevelopAdmissionDecisionV0 {
		const base = endoEvaluateDevelopAdmissionV0({
			descriptor: this.describe(),
			snapshot: this.snapshot(),
			request,
			authority,
			options: { nowMs: this.#now(), ...options },
		});
		if (!base.admitted) return base;
		if (authority !== null && this.#consumedAuthorizations.has(authority.authorizationId)) {
			return {
				admitted: false,
				code: "authority-expired",
				reason: "Operator authorization proof was already consumed (single-use enforcement).",
			};
		}
		if (request.kind === "prompt" && (this.#activeTurn !== null || this.#promptInFlight)) {
			return {
				admitted: false,
				code: "run-active",
				reason:
					this.#activeTurn !== null
						? `Turn ${this.#activeTurn.turnId} is already active on this owned thread.`
						: "Another prompt turn/start dispatch is already in flight on this owned thread.",
			};
		}
		return { admitted: true };
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
		if (this.#client === null || this.#threadId === null || authority === null) {
			return {
				status: "refused",
				operation: request.kind,
				stage: "admission",
				code: "not-connected",
				reason: "Codex transport or owned thread is not active.",
			};
		}

		// Single-use: consume authorization ID strictly BEFORE any transport write.
		this.#consumedAuthorizations.add(authority.authorizationId);
		const dispatchedInstance = this.#instanceId;
		const threadId = this.#threadId;

		try {
			switch (request.kind) {
				case "prompt": {
					// Privacy: omit unkeyed SHA-256 of raw user prompt text from canonical `events/events.log`.
					this.#recordCanonical(
						"codex.prompt-dispatched",
						{
							instanceId: dispatchedInstance,
							threadId,
							authorizationId: authority.authorizationId,
						},
						"authority-decision",
					);
					this.#promptInFlight = true;
					try {
						const res = await this.#client.turnStart({
							threadId,
							input: [{ type: "text", text: request.message, text_elements: [] }],
							...(this.#o.model === undefined ? {} : { model: this.#o.model }),
							...(this.#o.reasoningEffort === undefined ? {} : { effort: this.#o.reasoningEffort }),
						});
						if (this.#instanceId !== dispatchedInstance || !this.#connected) {
							return this.#unknownOutcome(
								"prompt",
								dispatchedInstance,
								"Codex connection instance changed or disconnected before turn/start reply settled.",
							);
						}
						const turn = res.turn as Record<string, unknown>;
						const turnId = sanitizeOptional(turn.id, 256);
						if (turnId === null) {
							return this.#unknownOutcome(
								"prompt",
								dispatchedInstance,
								"Codex turn/start returned an invalid turn.id.",
							);
						}
						// Guard against same-chunk turn/start + turn/completed race: never resurrect a finished turn!
						if (this.#activeTurn === null && !this.#completedTurns.has(turnId)) {
							this.#activeTurn = { turnId, state: "in-progress" };
						}
						return {
							status: "accepted",
							operation: "prompt",
							instanceId: dispatchedInstance,
							disposition: "turn-started",
							turnId,
							receiptId: null,
							consequenceObserved: false,
						};
					} finally {
						this.#promptInFlight = false;
					}
				}
				case "steer": {
					const expectedTurnId = request.targetTurnId!;
					this.#recordCanonical(
						"codex.steer-dispatched",
						{
							instanceId: dispatchedInstance,
							threadId,
							expectedTurnId,
							authorizationId: authority.authorizationId,
						},
						"authority-decision",
						expectedTurnId,
					);
					const res = await this.#client.turnSteer({
						threadId,
						expectedTurnId,
						input: [{ type: "text", text: request.message, text_elements: [] }],
					});
					if (this.#instanceId !== dispatchedInstance || !this.#connected) {
						return this.#unknownOutcome(
							"steer",
							dispatchedInstance,
							"Codex connection instance changed or disconnected before turn/steer reply settled.",
						);
					}
					return {
						status: "accepted",
						operation: "steer",
						instanceId: dispatchedInstance,
						disposition: "steered",
						turnId: res.turnId,
						receiptId: null,
						consequenceObserved: false,
					};
				}
				case "stop": {
					const targetTurnId = request.targetTurnId!;
					this.#recordCanonical(
						"codex.stop-requested",
						{
							instanceId: dispatchedInstance,
							threadId,
							turnId: targetTurnId,
							authorizationId: authority.authorizationId,
						},
						"authority-decision",
						targetTurnId,
					);
					await this.#client.turnInterrupt({ threadId, turnId: targetTurnId });
					if (this.#instanceId !== dispatchedInstance || !this.#connected) {
						return this.#unknownOutcome(
							"stop",
							dispatchedInstance,
							"Codex connection instance changed or disconnected before turn/interrupt reply settled.",
						);
					}
					this.#recordCanonical(
						"codex.stop-accepted",
						{ instanceId: dispatchedInstance, threadId, turnId: targetTurnId },
						"runtime-fact",
						targetTurnId,
					);
					return {
						status: "accepted",
						operation: "stop",
						instanceId: dispatchedInstance,
						disposition: "interrupt-accepted",
						turnId: targetTurnId,
						receiptId: null,
						consequenceObserved: false,
					};
				}
				default:
					return {
						status: "refused",
						operation: request.kind,
						stage: "admission",
						code: "operation-unsupported",
						reason: `${request.kind} is not supported by CodexDevelopAdapterV0.`,
					};
			}
		} catch (error) {
			if (error instanceof CodexRpcErrorV0) {
				if (request.kind === "stop") {
					this.#recordCanonical(
						"codex.stop-refused",
						{
							instanceId: dispatchedInstance,
							threadId,
							turnId: request.targetTurnId ?? null,
							rpcCode: error.code,
						},
						"runtime-fact",
						request.targetTurnId ?? null,
					);
				}
				return {
					status: "refused",
					operation: request.kind,
					stage: "runtime",
					code: "runtime-refused",
					reason: sanitizeText(error.message, 256),
				};
			}
			if (error instanceof CodexTransportErrorV0 && !error.dispatched) {
				return {
					status: "refused",
					operation: request.kind,
					stage: "runtime",
					code: "runtime-refused",
					reason: sanitizeText(error.message, 256),
				};
			}
			return this.#unknownOutcome(
				request.kind,
				dispatchedInstance,
				error instanceof Error ? error.message : "Codex transport failed mid-dispatch.",
			);
		}
	}

	/**
	 * Fail-closed native approval evaluation (`endoEvaluateNativeApprovalV0`) with single-use consumption,
	 * authoritative pending-request verification, active-turn enforcement, and no policy/session scope broadening.
	 */
	handleNativeApproval(
		request: EndoDevelopNativeApprovalRequestV0,
		decision?: EndoDevelopNativeApprovalDecisionV0 | null,
		options: { nowMs?: number; allowSessionOrPolicyScope?: boolean } = {},
	): EndoDevelopNativeApprovalOutcomeV0 {
		if (this.#consumedNativeApprovals.has(request.requestId)) {
			return {
				resolution: "cancelled",
				requestId: request.requestId,
				code: "binding-mismatch",
				reason: "Native approval request was already resolved (single-use enforcement).",
				grantsEndophasiaAuthority: false,
			};
		}
		const pending = this.#pendingApprovals.get(request.requestId);
		if (pending === undefined) {
			const isUnknown =
				request.approvalKind === "unknown" ||
				!CODEX_INTERACTIVE_APPROVAL_KINDS_V0.includes(request.approvalKind as never);
			return {
				resolution: isUnknown ? "declined" : "cancelled",
				requestId: request.requestId,
				code: isUnknown ? "unknown-approval-kind" : "binding-mismatch",
				reason: isUnknown
					? `Unknown or unsupported native approval kind (${request.approvalKind} / ${request.nativeMethod}) fails closed.`
					: `No pending Codex server request matches ${request.requestId} (fail-closed).`,
				grantsEndophasiaAuthority: false,
			};
		}

		// Always evaluate against the authoritative pending request received from Codex (never caller-supplied fields),
		// always enforce an active non-null turn (refusing idle-state `null === null` bypasses), and restrict accepted
		// kinds to interactive v0 kinds.
		const authoritativeRequest = pending.parsed.normalized;
		const activeTurn = this.#activeTurn;
		const outcome: EndoDevelopNativeApprovalOutcomeV0 = !pending.parsed.interactiveAcceptSupported
			? {
					resolution: "declined",
					requestId: authoritativeRequest.requestId,
					code:
						authoritativeRequest.approvalKind === "unknown"
							? "unknown-approval-kind"
							: "scope-broadening-refused",
					reason: `Native approval method ${pending.parsed.nativeMethod} is declined fail-closed in v0.`,
					grantsEndophasiaAuthority: false,
				}
			: activeTurn === null ||
					authoritativeRequest.turnId === null ||
					authoritativeRequest.turnId !== activeTurn.turnId
				? {
						resolution: "cancelled",
						requestId: authoritativeRequest.requestId,
						code: "binding-mismatch",
						reason:
							"Interactive Codex native approval requires an active turn matching a non-null request turnId.",
						grantsEndophasiaAuthority: false,
					}
				: endoEvaluateNativeApprovalV0({
						request: authoritativeRequest,
						decision: decision ?? null,
						current: {
							source: "codex-live",
							sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
							instanceId: this.#instanceId,
							connected: this.#connected && !this.#closed,
							activeTurnId: activeTurn.turnId,
							knownKinds: CODEX_INTERACTIVE_APPROVAL_KINDS_V0,
							mode: "server-initiated-requests",
							nowMs: options.nowMs ?? this.#now(),
							// Codex v0 NEVER allows session-wide or policy-amendment native approval scope.
							allowSessionOrPolicyScope: false,
						},
					});

		// Unified single-use cleanup, protocol reply, canonical record, and observation emission.
		this.#consumedNativeApprovals.add(authoritativeRequest.requestId);
		this.#pendingApprovals.delete(authoritativeRequest.requestId);
		pending.abort.abort();
		const reply = encodeCodexNativeApprovalReplyV0(pending.parsed, outcome);
		if (reply.kind === "result") {
			this.#client?.respondServerRequest(pending.parsed.rpcId, reply.result);
		} else {
			this.#client?.rejectServerRequest(pending.parsed.rpcId, reply.code, reply.message);
		}
		this.#recordCanonical(
			"codex.native-approval-resolved",
			{
				instanceId: this.#instanceId,
				threadId: this.#threadId,
				turnId: pending.parsed.turnId,
				itemId: pending.parsed.itemId,
				requestId: authoritativeRequest.requestId,
				nativeMethod: pending.parsed.nativeMethod,
				approvalKind: pending.parsed.approvalKind,
				resolution: outcome.resolution,
				...(outcome.resolution === "accepted" ? { scope: outcome.scope } : { code: outcome.code }),
			},
			"authority-decision",
			pending.parsed.turnId,
		);
		this.#emitObservation(
			{
				kind: "native-approval",
				phase: "resolved",
				requestId: authoritativeRequest.requestId,
				approvalKind: authoritativeRequest.approvalKind,
				resolution: outcome.resolution,
			},
			"controller-observed",
			{ turnId: pending.parsed.turnId, itemId: pending.parsed.itemId },
		);
		return outcome;
	}

	subscribeObservations(listener: (observation: EndoDevelopObservationV0) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Orderly teardown: unsubscribe owned thread, close transport, record detach/cleanup, close store, release lock. */
	close(): Promise<EndoDevelopCloseOutcomeV0> {
		if (this.#closing !== null) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			this.#cancelAllPendingApprovals("Codex adapter closing");
			const wasConnected = this.#connected;
			if (wasConnected && this.#client !== null && this.#threadId !== null) {
				try {
					await this.#client.threadUnsubscribe({ threadId: this.#threadId }, { timeoutMs: 2_000 });
				} catch {
					// Best-effort unsubscribe before closing transport.
				}
			}
			let rawCleanup: ProcessCleanupV0 | null = null;
			if (this.#client !== null) {
				rawCleanup = await this.#client.close();
				this.#client = null;
			}
			this.#isolatedHome?.cleanup();
			this.#isolatedHome = null;
			// Preserve an earlier recorded cleanup result (e.g. from a failed open()) when `#client` was already closed.
			if (rawCleanup !== null) {
				this.#cleanup = summarizeCleanup(rawCleanup);
			}
			this.#connected = false;
			this.#disconnectedReason = "Codex adapter closed.";
			this.#notifyAllTurnWaiters("disconnected");

			if (this.#store !== null) {
				// Only record an expected detach if we were still connected; do not overwrite a prior unexpected crash's
				// `lifecycle.interrupted` state with `lifecycle.detached`.
				if (wasConnected) {
					try {
						this.#recordCanonical("codex.connection-lost", {
							instanceId: this.#instanceId,
							threadId: this.#threadId,
							expected: true,
							cleanupBoundary: this.#cleanup.boundary,
							cleanupResult: this.#cleanup.result,
							remainingProcesses: this.#cleanup.remainingProcesses,
							scopeName: this.#cleanup.scopeName,
						});
					} catch {
						// Never mask cleanup if store is dead.
					}
				}
				try {
					this.#store.close();
				} catch {
					// Ignore store close errors.
				}
				this.#store = null;
			}
			this.#releaseLock?.();
			this.#releaseLock = null;

			this.#emitObservation(
				{
					kind: "lifecycle",
					event: "session-detached",
					sessionState: "detached",
					turnState: null,
					detail: `cleanup=${this.#cleanup.boundary}/${this.#cleanup.result}`,
				},
				"controller-observed",
			);

			return { closed: true, cleanup: this.#cleanup };
		})();
		return this.#closing;
	}

	// -------------------------------------------------------------------------------------------------------------
	// Internal transport event handlers
	// -------------------------------------------------------------------------------------------------------------

	#onServerRequest(req: CodexServerRequestV0): void {
		if (this.#closed || req.instanceId !== this.#instanceId || !this.#connected) {
			this.#client?.rejectServerRequest(
				req.id,
				-32000,
				"Stale, closed, or disconnected connection instance (fail-closed).",
			);
			return;
		}
		const sessionKey = endoAdapterSessionKeyV0(this.#sessionIdentity()) ?? `codex-live:launch:${this.#launchId}`;
		const parsed = parseCodexServerRequestV0({ request: req, source: "codex-live", sessionKey });

		// Enforce strict owned-thread isolation: interactive approvals MUST explicitly name our owned `threadId`
		// (omitting `threadId` or naming another thread fails closed immediately).
		const wrongOrMissingThread =
			this.#threadId === null ||
			(parsed.threadId !== null && parsed.threadId !== this.#threadId) ||
			(parsed.interactiveAcceptSupported && parsed.threadId !== this.#threadId);
		if (wrongOrMissingThread) {
			const outcome: EndoDevelopNativeApprovalOutcomeV0 = {
				resolution: "cancelled",
				requestId: parsed.requestId,
				code: "binding-mismatch",
				reason: `Server request thread (${parsed.threadId ?? "missing"}) does not match owned thread (${this.#threadId ?? "none"}).`,
				grantsEndophasiaAuthority: false,
			};
			const reply = encodeCodexNativeApprovalReplyV0(parsed, outcome);
			if (reply.kind === "result") this.#client?.respondServerRequest(parsed.rpcId, reply.result);
			else this.#client?.rejectServerRequest(parsed.rpcId, reply.code, reply.message);
			this.#emitObservation(
				{
					kind: "evidence-gap",
					gap: "unrecognized-runtime-event",
					reason: `Refused server request for non-owned or missing thread (${parsed.nativeMethod}).`,
				},
				"controller-observed",
			);
			return;
		}

		const abort = new AbortController();
		this.#pendingApprovals.set(parsed.requestId, { parsed, abort });

		this.#recordCanonical(
			"codex.native-approval-requested",
			{
				instanceId: this.#instanceId,
				threadId: this.#threadId,
				turnId: parsed.turnId,
				itemId: parsed.itemId,
				requestId: parsed.requestId,
				nativeMethod: parsed.nativeMethod,
				approvalKind: parsed.approvalKind,
				proposesBroadening: parsed.proposesBroadening,
			},
			"runtime-fact",
			parsed.turnId,
		);
		this.#emitObservation(
			{
				kind: "native-approval",
				phase: "requested",
				requestId: parsed.requestId,
				approvalKind: parsed.approvalKind,
				resolution: "pending",
			},
			"runtime-reported",
			{ turnId: parsed.turnId, itemId: parsed.itemId },
		);

		// Non-interactive / unsupported / unknown methods, or unattended mode -> fail closed immediately.
		if (!parsed.interactiveAcceptSupported || this.#o.onNativeApprovalRequest === undefined) {
			this.handleNativeApproval(parsed.normalized, null);
			return;
		}

		// Asynchronous operator decision: never blocks stdout notification/disconnect processing.
		void Promise.resolve(this.#o.onNativeApprovalRequest(parsed.normalized, abort.signal))
			.then((decision) => {
				if (abort.signal.aborted || !this.#pendingApprovals.has(parsed.requestId)) return;
				this.handleNativeApproval(parsed.normalized, decision);
			})
			.catch(() => {
				if (abort.signal.aborted || !this.#pendingApprovals.has(parsed.requestId)) return;
				this.handleNativeApproval(parsed.normalized, null);
			});
	}

	#onNotification(notification: CodexServerNotificationV0): void {
		if (this.#closed) return;
		const safeMethod = sanitizeText(notification.method, 128) || "unknown";
		if (notification.instanceId !== this.#instanceId) {
			this.#emitObservation(
				{
					kind: "evidence-gap",
					gap: "late-event-from-prior-attachment",
					reason: `Ignored notification ${safeMethod} from prior instance ${sanitizeText(notification.instanceId, 64)}.`,
				},
				"controller-observed",
			);
			return;
		}
		this.#observedNotificationMethods.add(safeMethod);
		const params = notification.params ?? {};

		if (notification.method === "mcpServer/startupStatus/updated") {
			const serverName = sanitizeOptional(params.name, 128) ?? "(unknown)";
			if (!this.#allowedMcpServers.has(serverName)) {
				this.#unexpectedMcpStartups.add(serverName);
				// Fail closed even when an unallowlisted MCP server starts asynchronously AFTER open() returned!
				if (this.#connected) {
					const reason = `Unwanted MCP server "${serverName}" attempted startup during live session (fail-closed).`;
					this.#recordCanonical(
						"codex.transport-fault",
						{
							instanceId: this.#instanceId,
							threadId: this.#threadId,
							faultKind: "unexpected-mcp-startup",
							detail: reason,
						},
						"runtime-fact",
					);
					this.#emitObservation(
						{
							kind: "evidence-gap",
							gap: "unrecognized-runtime-event",
							reason,
						},
						"controller-observed",
					);
					this.invalidateEvidence(reason);
					this.markDisconnected(reason);
				}
			}
			return;
		}

		// Owned-thread isolation: extract threadId from threadId / conversationId / thread.id, and refuse
		// thread-scoped notifications that arrive before `thread/start` or name a missing/foreign thread.
		const notifThreadId =
			sanitizeOptional(params.threadId, 256) ??
			sanitizeOptional(params.conversationId, 256) ??
			(isRecord(params.thread) ? sanitizeOptional(params.thread.id, 256) : null);
		const isThreadScoped = THREAD_SCOPED_NOTIFICATIONS.has(notification.method);
		if (
			(notifThreadId !== null && this.#threadId !== null && notifThreadId !== this.#threadId) ||
			(isThreadScoped && (this.#threadId === null || notifThreadId !== this.#threadId))
		) {
			this.#emitObservation(
				{
					kind: "evidence-gap",
					gap: "unrecognized-runtime-event",
					reason: `Ignored notification ${safeMethod} for non-owned or unestablished thread.`,
				},
				"controller-observed",
			);
			return;
		}

		switch (notification.method) {
			case "turn/started": {
				const turn = isRecord(params.turn) ? params.turn : null;
				const turnId = turn !== null ? sanitizeOptional(turn.id, 256) : null;
				if (turnId === null) break;
				this.#activeTurn = { turnId, state: "in-progress" };
				this.#recordCanonical(
					"codex.turn-started",
					{ instanceId: this.#instanceId, threadId: this.#threadId, turnId },
					"runtime-fact",
					turnId,
				);
				this.#emitObservation(
					{
						kind: "lifecycle",
						event: "turn-started",
						sessionState: "active",
						turnState: "in-progress",
						detail: null,
					},
					"runtime-reported",
					{ turnId },
				);
				break;
			}
			case "turn/completed": {
				const turn = isRecord(params.turn) ? params.turn : null;
				const turnId = (turn !== null ? sanitizeOptional(turn.id, 256) : null) ?? this.#activeTurn?.turnId ?? null;
				const status = (turn !== null ? sanitizeOptional(turn.status, 64) : null) ?? "unclassified";
				const turnError = turn !== null && isRecord(turn.error) ? turn.error : null;
				const codexErrorInfo = turnError !== null ? sanitizeOptional(turnError.codexErrorInfo, 128) : null;

				const turnState: EndoAdapterTurnStateV0 =
					status === "completed"
						? "completed"
						: status === "interrupted"
							? "interrupted"
							: status === "failed"
								? "failed"
								: "unclassified";
				const lifecycleEvent =
					turnState === "completed"
						? "turn-completed"
						: turnState === "interrupted"
							? "turn-interrupted"
							: "turn-failed";
				const sessionState: EndoAdapterSessionStateV0 = turnState === "interrupted" ? "interrupted" : "idle";

				this.#activeTurn = null;
				if (turnId !== null) {
					this.#completedTurns.set(turnId, turnState);
					if (this.#completedTurns.size > 500) {
						const oldest = this.#completedTurns.keys().next().value;
						if (oldest !== undefined) this.#completedTurns.delete(oldest);
					}
				}
				this.#cancelAllPendingApprovals(`turn ${turnId ?? "unknown"} completed (${status})`);

				this.#recordCanonical(
					"codex.turn-completed",
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						status,
						...(codexErrorInfo === null ? {} : { codexErrorInfo }),
					},
					"runtime-fact",
					turnId,
				);
				this.#emitObservation(
					{
						kind: "lifecycle",
						event: lifecycleEvent,
						sessionState,
						turnState,
						detail: codexErrorInfo,
					},
					"runtime-reported",
					{ turnId },
				);
				if (turnId !== null) this.#notifyTurnWaiters(turnId, turnState);
				break;
			}
			case "item/started":
			case "item/completed": {
				this.#handleItemLifecycle(notification.method === "item/completed", params);
				break;
			}
			case "item/agentMessage/delta": {
				const delta = typeof params.delta === "string" ? params.delta : "";
				const itemId = typeof params.itemId === "string" ? params.itemId : null;
				const turnId = typeof params.turnId === "string" ? params.turnId : (this.#activeTurn?.turnId ?? null);
				if (delta.length > 0) {
					this.#appendTranscriptDelta({
						itemId,
						turnId,
						role: "assistant",
						contentKind: "text",
						reasoningKind: null,
						delta,
					});
				}
				break;
			}
			case "item/reasoning/summaryTextDelta": {
				const delta = typeof params.delta === "string" ? params.delta : "";
				const itemId = typeof params.itemId === "string" ? params.itemId : null;
				const turnId = typeof params.turnId === "string" ? params.turnId : (this.#activeTurn?.turnId ?? null);
				if (delta.length > 0) {
					// NEVER relabel reasoning summary as raw thinking!
					this.#appendTranscriptDelta({
						itemId,
						turnId,
						role: "assistant",
						contentKind: "reasoning",
						reasoningKind: "reasoning-summary",
						delta,
					});
				}
				break;
			}
			case "item/reasoning/textDelta": {
				const delta = typeof params.delta === "string" ? params.delta : "";
				const itemId = typeof params.itemId === "string" ? params.itemId : null;
				const turnId = typeof params.turnId === "string" ? params.turnId : (this.#activeTurn?.turnId ?? null);
				if (delta.length > 0) {
					this.#appendTranscriptDelta({
						itemId,
						turnId,
						role: "assistant",
						contentKind: "reasoning",
						reasoningKind: "raw-thinking",
						delta,
					});
				}
				break;
			}
			case "thread/tokenUsage/updated": {
				const turnId = typeof params.turnId === "string" ? params.turnId : (this.#activeTurn?.turnId ?? null);
				const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
				const last = tokenUsage !== null ? parseTokenUsageBreakdown(tokenUsage.last) : null;
				const total = tokenUsage !== null ? parseTokenUsageBreakdown(tokenUsage.total) : null;
				const ctxWin =
					tokenUsage !== null && isSafeNonNegInt(tokenUsage.modelContextWindow)
						? tokenUsage.modelContextWindow
						: null;
				if (ctxWin !== null) this.#modelContextWindow = ctxWin;
				if (last !== null) this.#lastUsage = last;
				if (total !== null) this.#totalUsage = total;

				const reported = last ?? total;
				if (reported === null) {
					this.#emitObservation(
						{
							kind: "usage",
							usage: {
								status: "unavailable",
								reason: "Codex thread/tokenUsage/updated lacked valid token counts.",
							},
						},
						"runtime-reported",
						{ turnId },
					);
				} else {
					this.#recordCanonical(
						"codex.token-usage-updated",
						{
							instanceId: this.#instanceId,
							threadId: this.#threadId,
							turnId,
							inputTokens: reported.inputTokens,
							outputTokens: reported.outputTokens,
							cachedInputTokens: reported.cachedInputTokens,
							cacheWriteTokens: reported.cacheWriteTokens,
							reasoningTokens: reported.reasoningTokens,
							totalTokens: reported.totalTokens,
							modelContextWindow: this.#modelContextWindow,
							costUsd: null,
						},
						"runtime-fact",
						turnId,
					);
					this.#emitObservation(
						{ kind: "usage", usage: { status: "reported", value: reported } },
						"runtime-reported",
						{ turnId },
					);
				}
				break;
			}
			case "thread/compacted": {
				const turnId = typeof params.turnId === "string" ? params.turnId : null;
				this.#recordCanonical(
					"codex.thread-compacted",
					{ instanceId: this.#instanceId, threadId: this.#threadId, turnId },
					"runtime-fact",
					turnId,
				);
				this.#emitObservation(
					{
						kind: "lifecycle",
						event: "context-compacted",
						sessionState: this.#activeTurn !== null ? "active" : "idle",
						turnState: this.#activeTurn?.state ?? null,
						detail: "Codex compacted thread context",
					},
					"runtime-reported",
					{ turnId },
				);
				break;
			}
			case "serverRequest/resolved": {
				const rawId = params.requestId;
				if (typeof rawId === "string" || typeof rawId === "number") {
					const reqId = `codex-req:${typeof rawId}:${String(rawId)}`;
					const entry = this.#pendingApprovals.get(reqId);
					if (entry !== undefined) {
						this.#pendingApprovals.delete(reqId);
						this.#consumedNativeApprovals.add(reqId);
						entry.abort.abort();
						this.#client?.clearPendingServerRequest(rawId);
						this.#recordCanonical(
							"codex.native-approval-resolved",
							{
								instanceId: this.#instanceId,
								threadId: this.#threadId,
								turnId: entry.parsed.turnId,
								itemId: entry.parsed.itemId,
								requestId: reqId,
								nativeMethod: entry.parsed.nativeMethod,
								approvalKind: entry.parsed.approvalKind,
								resolution: "cancelled",
								code: "server-resolved",
							},
							"runtime-fact",
							entry.parsed.turnId,
						);
						this.#emitObservation(
							{
								kind: "native-approval",
								phase: "resolved",
								requestId: reqId,
								approvalKind: entry.parsed.approvalKind,
								resolution: "cancelled",
							},
							"runtime-reported",
							{ turnId: entry.parsed.turnId, itemId: entry.parsed.itemId },
						);
					}
				}
				break;
			}
			case "error": {
				const turnId = sanitizeOptional(params.turnId, 256) ?? this.#activeTurn?.turnId ?? null;
				const errObj = isRecord(params.error) ? params.error : {};
				const errInfo = sanitizeOptional(errObj.codexErrorInfo, 128);
				this.#recordCanonical(
					"codex.error",
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						willRetry: params.willRetry === true,
						codexErrorInfo: errInfo,
					},
					"runtime-fact",
					turnId,
				);
				break;
			}
			default: {
				if (!BENIGN_STATUS_NOTIFICATIONS.has(notification.method)) {
					this.#recordCanonical("codex.unrecognized-notification", {
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						method: safeMethod,
					});
					this.#emitObservation(
						{
							kind: "evidence-gap",
							gap: "unrecognized-runtime-event",
							reason: `Unrecognized Codex notification method: ${safeMethod}`,
						},
						"controller-observed",
					);
				}
				break;
			}
		}
	}

	#handleItemLifecycle(completed: boolean, params: Record<string, unknown>): void {
		const item = isRecord(params.item) ? params.item : null;
		if (item === null || typeof item.type !== "string" || typeof item.id !== "string") return;
		const turnId = sanitizeOptional(params.turnId, 256) ?? this.#activeTurn?.turnId ?? null;
		const itemId = sanitizeOptional(item.id, 256);
		const itemType = sanitizeOptional(item.type, 64);
		if (itemId === null || itemType === null) return;
		const eventKind = completed ? "codex.item-completed" : "codex.item-started";

		switch (item.type) {
			case "userMessage": {
				const content = Array.isArray(item.content) ? item.content : [];
				const textParts = content
					.filter(isRecord)
					.filter((c) => c.type === "text" && typeof c.text === "string")
					.map((c) => c.text as string);
				const joined = textParts.join("\n");
				this.#recordCanonical(
					eventKind,
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						itemId,
						itemType,
						textLength: joined.length,
					},
					"runtime-fact",
					turnId,
				);
				if (completed && joined.length > 0) {
					this.#upsertCompletedTranscript({
						itemId,
						turnId,
						role: "user",
						contentKind: "text",
						reasoningKind: null,
						text: joined,
					});
					this.#emitObservation(
						{
							kind: "transcript",
							role: "user",
							contentKind: "text",
							reasoningKind: null,
							text: joined.slice(0, MAX_TRANSCRIPT_TEXT_CHARS),
							truncated: joined.length > MAX_TRANSCRIPT_TEXT_CHARS,
							stopReason: null,
						},
						"runtime-reported",
						{ turnId, itemId },
					);
				}
				break;
			}
			case "agentMessage": {
				const text = typeof item.text === "string" ? item.text : "";
				this.#recordCanonical(
					eventKind,
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						itemId,
						itemType,
						textLength: text.length,
					},
					"runtime-fact",
					turnId,
				);
				if (completed) {
					this.#upsertCompletedTranscript({
						itemId,
						turnId,
						role: "assistant",
						contentKind: "text",
						reasoningKind: null,
						text,
					});
					this.#emitObservation(
						{
							kind: "transcript",
							role: "assistant",
							contentKind: "text",
							reasoningKind: null,
							text: text.length > 0 ? text.slice(0, MAX_TRANSCRIPT_TEXT_CHARS) : null,
							truncated: text.length > MAX_TRANSCRIPT_TEXT_CHARS,
							stopReason: null,
						},
						"runtime-reported",
						{ turnId, itemId },
					);
				}
				break;
			}
			case "reasoning": {
				const summary = Array.isArray(item.summary)
					? item.summary.filter((s): s is string => typeof s === "string" && s.length > 0)
					: [];
				const rawContent = Array.isArray(item.content)
					? item.content.filter((s): s is string => typeof s === "string" && s.length > 0)
					: [];
				this.#recordCanonical(
					eventKind,
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						itemId,
						itemType,
						summaryPartCount: summary.length,
						rawPartCount: rawContent.length,
					},
					"runtime-fact",
					turnId,
				);
				if (completed) {
					if (summary.length > 0) {
						const summaryText = summary.join("\n");
						this.#upsertCompletedTranscript({
							itemId,
							turnId,
							role: "assistant",
							contentKind: "reasoning",
							reasoningKind: "reasoning-summary",
							text: summaryText,
						});
						this.#emitObservation(
							{
								kind: "transcript",
								role: "assistant",
								contentKind: "reasoning",
								reasoningKind: "reasoning-summary",
								text: summaryText.slice(0, MAX_TRANSCRIPT_TEXT_CHARS),
								truncated: summaryText.length > MAX_TRANSCRIPT_TEXT_CHARS,
								stopReason: null,
							},
							"runtime-reported",
							{ turnId, itemId },
						);
					}
					if (rawContent.length > 0) {
						const rawText = rawContent.join("\n");
						this.#upsertCompletedTranscript({
							itemId: `${itemId}:raw`,
							turnId,
							role: "assistant",
							contentKind: "reasoning",
							reasoningKind: "raw-thinking",
							text: rawText,
						});
						this.#emitObservation(
							{
								kind: "transcript",
								role: "assistant",
								contentKind: "reasoning",
								reasoningKind: "raw-thinking",
								text: rawText.slice(0, MAX_TRANSCRIPT_TEXT_CHARS),
								truncated: rawText.length > MAX_TRANSCRIPT_TEXT_CHARS,
								stopReason: null,
							},
							"runtime-reported",
							{ turnId, itemId },
						);
					}
				}
				break;
			}
			case "commandExecution": {
				const phase = completed ? mapItemPhase(item.status) : "started";
				const exitCode =
					typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? item.exitCode : null;
				// Privacy: canonical event records closed status & exit code only, never raw command line or output.
				this.#recordCanonical(
					eventKind,
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						itemId,
						itemType,
						phase,
						exitCode,
					},
					"runtime-fact",
					turnId,
				);
				this.#upsertActivity({
					itemId,
					turnId,
					activityKind: "command-execution",
					name: "commandExecution",
					phase,
					exitCode,
				});
				this.#emitObservation(
					{
						kind: "tool-activity",
						activityKind: "command-execution",
						name: "commandExecution",
						phase,
						callId: itemId,
						exitCode,
					},
					"runtime-reported",
					{ turnId, itemId },
				);
				break;
			}
			case "fileChange": {
				const phase = completed ? mapItemPhase(item.status) : "started";
				const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
				this.#recordCanonical(
					eventKind,
					{
						instanceId: this.#instanceId,
						threadId: this.#threadId,
						turnId,
						itemId,
						itemType,
						phase,
						changeCount,
					},
					"runtime-fact",
					turnId,
				);
				this.#upsertActivity({
					itemId,
					turnId,
					activityKind: "file-change",
					name: `fileChange(${changeCount})`,
					phase,
					exitCode: null,
				});
				this.#emitObservation(
					{
						kind: "tool-activity",
						activityKind: "file-change",
						name: "fileChange",
						phase,
						callId: itemId,
						exitCode: null,
					},
					"runtime-reported",
					{ turnId, itemId },
				);
				break;
			}
			case "mcpToolCall":
			case "dynamicToolCall": {
				const phase = completed ? mapItemPhase(item.status) : "started";
				const toolName = sanitizeOptional(item.tool, 128) ?? sanitizeOptional(item.name, 128) ?? itemType;
				const activityKind = item.type === "mcpToolCall" ? "mcp-tool" : "tool-call";
				this.#recordCanonical(
					eventKind,
					{ instanceId: this.#instanceId, threadId: this.#threadId, turnId, itemId, itemType, toolName, phase },
					"runtime-fact",
					turnId,
				);
				this.#upsertActivity({ itemId, turnId, activityKind, name: toolName, phase, exitCode: null });
				this.#emitObservation(
					{ kind: "tool-activity", activityKind, name: toolName, phase, callId: itemId, exitCode: null },
					"runtime-reported",
					{ turnId, itemId },
				);
				break;
			}
			case "collabAgentToolCall":
			case "subAgentActivity": {
				const phase = completed ? mapItemPhase(item.status) : "started";
				this.#recordCanonical(
					eventKind,
					{ instanceId: this.#instanceId, threadId: this.#threadId, turnId, itemId, itemType, phase },
					"runtime-fact",
					turnId,
				);
				this.#upsertActivity({
					itemId,
					turnId,
					activityKind: "subagent-activity",
					name: itemType,
					phase,
					exitCode: null,
				});
				this.#emitObservation(
					{
						kind: "tool-activity",
						activityKind: "subagent-activity",
						name: itemType,
						phase,
						callId: itemId,
						exitCode: null,
					},
					"runtime-reported",
					{ turnId, itemId },
				);
				break;
			}
			default: {
				this.#recordCanonical(
					eventKind,
					{ instanceId: this.#instanceId, threadId: this.#threadId, turnId, itemId, itemType },
					"runtime-fact",
					turnId,
				);
				break;
			}
		}
	}

	#onTransportFault(fault: CodexTransportFaultV0): void {
		if (fault.instanceId !== this.#instanceId) return;
		const gap = fault.kind === "oversized-record" ? "output-limit-exceeded" : "unrecognized-runtime-event";
		this.#recordCanonical("codex.transport-fault", {
			instanceId: this.#instanceId,
			threadId: this.#threadId,
			faultKind: fault.kind,
			...(fault.byteLength === undefined ? {} : { byteLength: fault.byteLength }),
		});
		this.#emitObservation(
			{
				kind: "evidence-gap",
				gap,
				reason: sanitizeText(fault.detail, 256),
			},
			"controller-observed",
		);
	}

	#onDisconnect(info: { instanceId: string; reason: string; exit: ProcessExitV0 | null }): void {
		if (info.instanceId !== this.#instanceId) return;
		if (this.#closed) return;
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#disconnectedReason = info.reason;
		this.#cancelAllPendingApprovals(info.reason);
		this.#notifyAllTurnWaiters("disconnected");

		if (wasConnected && this.#store !== null) {
			try {
				this.#recordCanonical("codex.connection-lost", {
					instanceId: this.#instanceId,
					threadId: this.#threadId,
					expected: false,
					exit:
						info.exit === null
							? null
							: {
									code: info.exit.code,
									signal: info.exit.signal,
									spawnFailed: info.exit.spawnFailed,
								},
				});
			} catch {
				// Never throw from disconnect handler if store is sealed/dead.
			}
		}

		this.#emitObservation(
			{
				kind: "lifecycle",
				event: "connection-lost",
				sessionState: "unknown",
				turnState: null,
				detail: sanitizeText(info.reason, 256),
			},
			"controller-observed",
		);
	}

	// -------------------------------------------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------------------------------------------

	#sessionIdentity(): EndoAdapterSessionIdentityV0 {
		if (this.#threadId !== null) {
			const alias = sanitizeText(this.#threadId, 128).trim();
			return {
				source: "codex-live",
				key: { status: "established", id: codexEndoSessionIdV0(this.#threadId), scope: "persistent" },
				alias: alias.length > 0 ? alias : null,
				nativeRef: { kind: "codex-thread", threadId: this.#threadId, sessionTreeId: this.#sessionTreeId },
			};
		}
		return {
			source: "codex-live",
			key: { status: "established", id: this.#launchId, scope: "launch" },
			alias: null,
			nativeRef: null,
		};
	}

	#connectionState(): { state: EndoAdapterConnectionStateV0; reason: string | null } {
		if (this.#closed) return { state: "disconnected", reason: "Codex adapter is closed." };
		if (!this.#connected) {
			return { state: "disconnected", reason: this.#disconnectedReason ?? "Codex App Server is disconnected." };
		}
		return { state: "connected", reason: null };
	}

	#evidenceFreshness(): EndoDevelopAdapterDescriptorV0["evidenceFreshness"] {
		if (this.#customStaleReason !== null) {
			return { status: "stale", reason: this.#customStaleReason };
		}
		const externalStale = this.#o.staleEvidenceReason?.() ?? null;
		if (externalStale !== null) {
			return { status: "stale", reason: externalStale };
		}
		if (this.#fingerprint.id !== this.#initialFingerprintId) {
			return {
				status: "stale",
				reason: `Codex fingerprint changed from ${this.#initialFingerprintId} to ${this.#fingerprint.id}.`,
			};
		}
		if (this.#capabilityState.fingerprintId !== this.#fingerprint.id) {
			return {
				status: "stale",
				reason: `Capability state fingerprint (${this.#capabilityState.fingerprintId ?? "none"}) does not match current ${this.#fingerprint.id}.`,
			};
		}
		return { status: "current", reason: null };
	}

	#capFromState(capabilityId: string): EndoAdapterCapabilityEntryV0 {
		return endoDevelopCapabilityFromStateV0({
			state: this.#capabilityState,
			capabilityId,
			expectedRuntime: "codex",
			expectedAttachment: this.#o.attachmentId,
			currentFingerprint: this.#fingerprint,
		});
	}

	#unknownOutcome(
		operation: EndoDevelopOperationRequestV0["kind"],
		instanceId: string,
		reason: string,
	): EndoDevelopDispatchOutcomeV0 {
		this.#emitObservation(
			{
				kind: "evidence-gap",
				gap: "disconnected-mid-request",
				reason: sanitizeText(reason, 256),
			},
			"controller-observed",
		);
		return {
			status: "unknown",
			operation,
			instanceId,
			reason: sanitizeText(reason, 256),
			dispatched: true,
		};
	}

	#seedSequenceFromStore(): void {
		if (this.#store === null) return;
		const producer = `codex-app-server:${this.#o.attachmentId}`;
		let after = 0;
		for (;;) {
			const page = this.#store.page({ afterSequence: after, limit: 10_000 });
			for (const ev of page.events) {
				if (ev.producer === producer && ev.sequence > this.#eventSequence) {
					this.#eventSequence = ev.sequence;
				}
				const step = codexLifecycleStepV0(this.#lifecycle, ev);
				this.#lifecycle = step.state;
			}
			if (page.events.length === 0) break;
			after = page.nextAfterSequence;
		}
	}

	#recordCanonical(
		kind: string,
		payload: Record<string, JsonValueV0>,
		source: "runtime-fact" | "authority-decision" = "runtime-fact",
		turnId: string | null = null,
	): void {
		if (this.#store === null) return;
		const ctx: CodexEventContextV0 = {
			attachment: this.#o.attachmentId,
			instanceId: this.#instanceId,
			threadId: this.#threadId,
			turnId,
			nextSequence: () => {
				this.#eventSequence += 1;
				return this.#eventSequence;
			},
			nextLive: () => {
				this.#liveCounter += 1;
				return this.#liveCounter;
			},
			now: () => new Date(this.#now()).toISOString(),
		};
		const recorded = buildCodexCanonicalEventV0({ context: ctx, kind, source, payload, turnId });
		this.#store.ingest(recorded);
		const step = codexLifecycleStepV0(this.#lifecycle, recorded);
		this.#lifecycle = step.state;
		for (const lifecycleEvent of step.events) {
			this.#store.ingest(lifecycleEvent);
		}
	}

	#emitObservation(
		body: EndoDevelopObservationBodyV0,
		basis: "controller-observed" | "runtime-reported",
		nativeIds: { turnId?: string | null; itemId?: string | null } = {},
	): void {
		const seq = this.#guard.allocateSequence();
		const obs: EndoDevelopObservationV0 = {
			schemaVersion: ENDO_DEVELOP_ADAPTER_OBSERVATION_SCHEMA_V0,
			observationId: `codex-obs:${this.#instanceId}:${seq}`,
			source: "codex-live",
			sessionKey: endoAdapterSessionKeyV0(this.#sessionIdentity()),
			attachmentId: this.#o.attachmentId,
			instanceId: this.#instanceId,
			sequence: seq,
			observedAt: new Date(this.#now()).toISOString(),
			basis,
			nativeIds: {
				sessionId: this.#threadId,
				turnId: nativeIds.turnId ?? this.#activeTurn?.turnId ?? null,
				itemId: nativeIds.itemId ?? null,
				entryId: null,
			},
			body,
		};
		const { accepted, gaps } = this.#guard.ingest(obs);
		for (const gap of gaps) {
			for (const listener of this.#listeners) listener(gap);
		}
		if (accepted !== null) {
			for (const listener of this.#listeners) listener(accepted);
		}
	}

	#appendTranscriptDelta(args: {
		itemId: string | null;
		turnId: string | null;
		role: "user" | "assistant";
		contentKind: "text" | "reasoning";
		reasoningKind: EndoAdapterReasoningKindV0 | null;
		delta: string;
	}): void {
		const existing =
			args.itemId !== null
				? this.#transcript.find(
						(t) =>
							t.itemId === args.itemId &&
							t.contentKind === args.contentKind &&
							t.reasoningKind === args.reasoningKind,
					)
				: undefined;
		if (existing !== undefined) {
			const idx = this.#transcript.indexOf(existing);
			const nextText = (existing.text + args.delta).slice(0, MAX_TRANSCRIPT_TEXT_CHARS);
			this.#transcript[idx] = { ...existing, text: nextText };
			return;
		}
		this.#transcript.push({
			itemId: args.itemId,
			turnId: args.turnId,
			role: args.role,
			contentKind: args.contentKind,
			reasoningKind: args.reasoningKind,
			text: args.delta.slice(0, MAX_TRANSCRIPT_TEXT_CHARS),
			completed: false,
		});
		if (this.#transcript.length > this.#maxLiveTranscript) {
			this.#transcript.splice(0, this.#transcript.length - this.#maxLiveTranscript);
		}
	}

	#upsertCompletedTranscript(args: {
		itemId: string;
		turnId: string | null;
		role: "user" | "assistant";
		contentKind: "text" | "reasoning";
		reasoningKind: EndoAdapterReasoningKindV0 | null;
		text: string;
	}): void {
		const idx = this.#transcript.findIndex(
			(t) =>
				t.itemId === args.itemId && t.contentKind === args.contentKind && t.reasoningKind === args.reasoningKind,
		);
		const entry: CodexLiveTranscriptItemV0 = {
			itemId: args.itemId,
			turnId: args.turnId,
			role: args.role,
			contentKind: args.contentKind,
			reasoningKind: args.reasoningKind,
			text: args.text.slice(0, MAX_TRANSCRIPT_TEXT_CHARS),
			completed: true,
		};
		if (idx >= 0) this.#transcript[idx] = entry;
		else {
			this.#transcript.push(entry);
			if (this.#transcript.length > this.#maxLiveTranscript) {
				this.#transcript.splice(0, this.#transcript.length - this.#maxLiveTranscript);
			}
		}
	}

	#upsertActivity(item: CodexLiveActivityItemV0): void {
		const idx = this.#activity.findIndex((a) => a.itemId === item.itemId);
		if (idx >= 0) this.#activity[idx] = item;
		else {
			this.#activity.push(item);
			if (this.#activity.length > 200) this.#activity.splice(0, this.#activity.length - 200);
		}
	}

	#cancelAllPendingApprovals(reason: string): void {
		for (const [reqId, entry] of this.#pendingApprovals.entries()) {
			this.#pendingApprovals.delete(reqId);
			this.#consumedNativeApprovals.add(reqId);
			entry.abort.abort();
			if (this.#connected) {
				const outcome: EndoDevelopNativeApprovalOutcomeV0 = {
					resolution: "cancelled",
					requestId: reqId,
					code: "stale-attachment",
					reason,
					grantsEndophasiaAuthority: false,
				};
				const reply = encodeCodexNativeApprovalReplyV0(entry.parsed, outcome);
				if (reply.kind === "result") this.#client?.respondServerRequest(entry.parsed.rpcId, reply.result);
				else this.#client?.rejectServerRequest(entry.parsed.rpcId, reply.code, reply.message);
			}
			this.#emitObservation(
				{
					kind: "native-approval",
					phase: "resolved",
					requestId: reqId,
					approvalKind: entry.parsed.approvalKind,
					resolution: "cancelled",
				},
				"controller-observed",
				{ turnId: entry.parsed.turnId, itemId: entry.parsed.itemId },
			);
		}
	}

	#notifyTurnWaiters(turnId: string, status: EndoAdapterTurnStateV0): void {
		const set = this.#turnWaiters.get(turnId);
		if (set === undefined) return;
		this.#turnWaiters.delete(turnId);
		for (const fn of set) fn(status);
	}

	#notifyAllTurnWaiters(status: EndoAdapterTurnStateV0 | "disconnected"): void {
		for (const [turnId, set] of this.#turnWaiters.entries()) {
			this.#turnWaiters.delete(turnId);
			for (const fn of set) fn(status as EndoAdapterTurnStateV0);
		}
	}
}
