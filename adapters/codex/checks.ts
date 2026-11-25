/**
 * Milestone D2 — Offline Codex App Server local-protocol check & effective-policy verification.
 *
 * Runs strictly WITHOUT starting any model turn (`initialize`, `initialized`, `config/read`, ephemeral `thread/start`,
 * `thread/read`, `thread/unsubscribe`, orderly shutdown with `ProcessCleanupV0`).
 *
 * Crucial real-binary finding (observed on `codex-cli 0.171.0`):
 * 1. User `~/.codex/config.toml` may set permissive defaults (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`,
 *    enabled MCP servers, hooks, memories, remote control).
 * 2. `codex-cli 0.171.0` rejects deprecated `approval_policy = "untrusted"` at startup; `"on-request"` is the valid
 *    non-permissive policy.
 * 3. `-c mcp_servers={}` deep-merges and leaves existing MCP servers enabled; disabling inherited MCP servers requires
 *    reading `config/read` and explicitly passing `mcp_servers.<name>.enabled = false` (or `config` overrides on `thread/start`).
 * 4. Effective policy MUST be verified from `ThreadStartResponse` (`approvalPolicy`, `approvalsReviewer`, `sandbox`),
 *    never assumed from requested flags alone.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateV0,
	EndoHarnessChangeV1,
	EndoHarnessFingerprintV1,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { openEndoHarnessRegistryV0 } from "../../storage/harness-registry.ts";
import type { ProcessCleanupV0, ProcessScopeV0 } from "../rpc-jsonl/process-group.ts";
import { CodexAppServerClientV0, type CodexInitializeResultV0 } from "./app-server-client.ts";
import {
	CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0,
	codexChangeV0,
	codexDependenciesV0,
	codexEvidenceV0,
	deriveCodexCapabilityStateV0,
} from "./capabilities.ts";
import { type CodexExecutableSelectionV0, codexConfigurationDigestV0, fingerprintCodexRuntimeV0 } from "./identity.ts";
import {
	type CodexSandboxModeV0,
	prepareCodexIsolatedHomeV0,
	validateCodexSandboxModeV0,
	verifyCodexIsolatedHomeV0,
} from "./isolated-home.ts";

/** Conservative CLI `-c` overrides passed to `codex app-server` as defense-in-depth over the isolated `CODEX_HOME`. */
export const CODEX_CONSERVATIVE_CONFIG_OVERRIDES_V0: readonly string[] = Object.freeze([
	'approval_policy="on-request"',
	'approvals_reviewer="user"',
	'sandbox_mode="workspace-write"',
	"sandbox_workspace_write.network_access=false",
	"sandbox_workspace_write.writable_roots=[]",
	'web_search="disabled"',
	"analytics.enabled=false",
	"features.hooks=false",
	"features.memories=false",
	"features.remote_control=false",
	"features.remote_plugin=false",
	"features.apps=false",
	"features.computer_use=false",
	"features.browser_use=false",
	"features.browser_use_external=false",
]);

export interface CodexEffectivePolicyV0 {
	readonly approvalPolicy: unknown;
	readonly approvalsReviewer: unknown;
	readonly sandbox: unknown;
	readonly model: string | null;
	readonly modelProvider: string | null;
	readonly cwd: string | null;
	readonly reasoningEffort: string | null;
	readonly disabledMcpServers: readonly string[];
}

export interface CodexEffectivePolicyVerificationV0 {
	readonly ok: boolean;
	readonly reasons: readonly string[];
	readonly effective: CodexEffectivePolicyV0;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Extract user-configured MCP server names from a `config/read` response so Endophasia can disable them explicitly
 * on `thread/start` without mutating the operator's `~/.codex/config.toml`.
 *
 * Fail-closed: any enabled MCP server whose name contains dots or special characters (outside `/^[A-Za-z0-9_-]+$/`)
 * cannot be safely disabled via dotted `mcp_servers.<name>.enabled = false` and is returned in `unsafeEnabledNames`.
 */
export function inspectCodexMcpServersV0(configReadResponse: Record<string, unknown>): {
	readonly disableableNames: string[];
	readonly unsafeEnabledNames: string[];
} {
	const cfg = isRecord(configReadResponse.config) ? configReadResponse.config : {};
	const mcp = isRecord(cfg.mcp_servers) ? cfg.mcp_servers : {};
	const disableableNames: string[] = [];
	const unsafeEnabledNames: string[] = [];
	for (const [name, entry] of Object.entries(mcp)) {
		const isEnabled = !isRecord(entry) || entry.enabled !== false;
		if (/^[A-Za-z0-9_-]+$/.test(name)) {
			disableableNames.push(name);
		} else if (isEnabled) {
			unsafeEnabledNames.push(name);
		}
	}
	disableableNames.sort();
	unsafeEnabledNames.sort();
	return { disableableNames, unsafeEnabledNames };
}

export function extractCodexMcpServerNamesV0(configReadResponse: Record<string, unknown>): string[] {
	return inspectCodexMcpServersV0(configReadResponse).disableableNames;
}

/** Build a `thread/start` `config` override object disabling all discovered inherited MCP servers. */
export function buildCodexDisableMcpConfigV0(serverNames: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of serverNames) {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			throw new TypeError(`Cannot safely disable MCP server name containing dots or special characters: ${name}`);
		}
		out[`mcp_servers.${name}.enabled`] = false;
	}
	return out;
}

/**
 * Verify the **effective** policy returned by `thread/start` (strict allowlist; never trusting requested parameters).
 * Fails closed unless ALL hold:
 * - `approvalPolicy === "on-request"` (refuses `"never"`, unknown strings, and unverified structured objects)
 * - `approvalsReviewer === "user"` (refuses `auto_review` and `guardian_subagent`)
 * - `sandbox.type === "workspaceWrite" || sandbox.type === "readOnly"` (refuses `dangerFullAccess`, `externalSandbox`, unknown)
 * - `sandbox.networkAccess === false` (unless `allowNetworkAccess === true`)
 * - `sandbox.writableRoots` is empty `[]` for `workspaceWrite` (refuses inherited broad `writable_roots`)
 * - `unsafeEnabledMcpServers` is empty
 */
export function verifyCodexEffectivePolicyV0(
	threadStartResponse: Record<string, unknown>,
	options: {
		readonly disabledMcpServers?: readonly string[];
		readonly unsafeEnabledMcpServers?: readonly string[];
		readonly unexpectedMcpStartups?: readonly string[];
		readonly expectedSandboxMode?: CodexSandboxModeV0;
		readonly allowNetworkAccess?: boolean;
	} = {},
): CodexEffectivePolicyVerificationV0 {
	const reasons: string[] = [];
	const approvalPolicy = threadStartResponse.approvalPolicy ?? null;
	const approvalsReviewer = threadStartResponse.approvalsReviewer ?? null;
	const sandbox = threadStartResponse.sandbox ?? null;
	const model = typeof threadStartResponse.model === "string" ? threadStartResponse.model : null;
	const modelProvider =
		typeof threadStartResponse.modelProvider === "string" ? threadStartResponse.modelProvider : null;
	const cwd = typeof threadStartResponse.cwd === "string" ? threadStartResponse.cwd : null;
	const reasoningEffort =
		typeof threadStartResponse.reasoningEffort === "string" ? threadStartResponse.reasoningEffort : null;

	if (approvalPolicy === null || approvalPolicy === undefined) {
		reasons.push("effective approvalPolicy is missing from thread/start response");
	} else if (approvalPolicy === "never") {
		reasons.push('effective approvalPolicy is "never", which bypasses human approval');
	} else if (approvalPolicy !== "on-request") {
		reasons.push(
			`effective approvalPolicy (${JSON.stringify(approvalPolicy)}) is not the allowlisted "on-request" policy`,
		);
	}

	if (approvalsReviewer !== "user") {
		reasons.push(
			`effective approvalsReviewer is ${JSON.stringify(approvalsReviewer)}, not "user" (automatic model-based approval reviewers are forbidden)`,
		);
	}

	if (!isRecord(sandbox) || typeof sandbox.type !== "string") {
		reasons.push("effective sandbox policy is missing or malformed in thread/start response");
	} else {
		if (sandbox.type !== "workspaceWrite" && sandbox.type !== "readOnly") {
			reasons.push(
				`effective sandbox policy is "${sandbox.type}", which is not in the allowlisted workspaceWrite/readOnly set`,
			);
		} else if (options.expectedSandboxMode === "read-only" && sandbox.type !== "readOnly") {
			reasons.push(
				`effective sandbox policy broadened to "${sandbox.type}" despite requested read-only sandbox mode`,
			);
		}
		if (options.allowNetworkAccess !== true && sandbox.networkAccess !== false) {
			reasons.push(`effective sandbox networkAccess is ${JSON.stringify(sandbox.networkAccess)}, expected false`);
		}
		if (
			sandbox.type === "workspaceWrite" &&
			(!Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.length > 0)
		) {
			reasons.push("effective workspaceWrite sandbox carries unexpected extra writableRoots");
		}
	}

	if ((options.unsafeEnabledMcpServers?.length ?? 0) > 0) {
		reasons.push(
			`enabled inherited MCP server(s) could not be safely disabled: ${options.unsafeEnabledMcpServers!.join(", ")}`,
		);
	}
	if ((options.unexpectedMcpStartups?.length ?? 0) > 0) {
		reasons.push(
			`unwanted MCP server(s) attempted startup despite isolated configuration: ${options.unexpectedMcpStartups!.join(", ")}`,
		);
	}

	return {
		ok: reasons.length === 0,
		reasons,
		effective: {
			approvalPolicy,
			approvalsReviewer,
			sandbox,
			model,
			modelProvider,
			cwd,
			reasoningEffort,
			disabledMcpServers: options.disabledMcpServers ?? [],
		},
	};
}

export interface CodexLocalProtocolCheckOptionsV0 extends CodexExecutableSelectionV0 {
	/** Store root where the harness registry `<root>/harness/<attachment>/records.log` lives. */
	readonly root: string;
	/** Configured attachment identity (dotted kind, e.g. `codex.default`). */
	readonly attachment: string;
	/** Optional working directory for ephemeral `thread/start`. Defaults to a disposable temp dir removed after check. */
	readonly checkCwd?: string;
	/** Optional explicit argv override (for deterministic fake-server tests). */
	readonly args?: readonly string[];
	/** Additional `-c` overrides merged after conservative defaults. */
	readonly extraConfigOverrides?: readonly string[];
	/** Environment passed to spawned Codex process. */
	readonly env?: Readonly<Record<string, string>>;
	/** Optional containment scope (`ProcessScopeV0`). */
	readonly scope?: ProcessScopeV0;
	/** Per-request timeout ms. Default: 15_000. */
	readonly timeoutMs?: number;
	/** Optional clock override. */
	readonly now?: () => Date;
	/** Pre-collected fingerprint to reuse instead of re-hashing the binary. */
	readonly fingerprint?: EndoHarnessFingerprintV1;
	/** Conservative sandbox mode for the offline check (`workspace-write` or `read-only`). Default: `workspace-write`. */
	readonly sandboxMode?: CodexSandboxModeV0;
	/** Optional source Codex home used ONLY to symlink `auth.json` when present (never modified). */
	readonly sourceCodexHome?: string;
}

export interface CodexLocalProtocolCheckResultV0 {
	readonly fingerprint: EndoHarnessFingerprintV1;
	readonly change: EndoHarnessChangeV1;
	readonly initialize: CodexInitializeResultV0;
	readonly effectivePolicy: CodexEffectivePolicyVerificationV0;
	readonly configurationDigest: string;
	readonly evidence: readonly EndoCapabilityEvidenceV0[];
	readonly capabilityState: EndoCapabilityStateV0;
	readonly cleanup: ProcessCleanupV0;
	readonly threadId: string | null;
	readonly stderrDiagnostics: { readonly text: string; readonly truncated: boolean };
}

/**
 * Run the offline Codex App Server local-protocol check (ZERO model turns) and persist fingerprint, change,
 * capability evidence, and capability state into `openEndoHarnessRegistryV0(root, attachment)`.
 */
export async function runCodexLocalProtocolCheckV0(
	options: CodexLocalProtocolCheckOptionsV0,
): Promise<CodexLocalProtocolCheckResultV0> {
	const sandboxMode = validateCodexSandboxModeV0(options.sandboxMode ?? "workspace-write");
	const now = options.now ?? (() => new Date());
	const fingerprint =
		options.fingerprint ??
		(await fingerprintCodexRuntimeV0({
			attachment: options.attachment,
			executable: options.executable,
			command: options.command,
			path: options.path,
			cwd: options.cwd,
			env: options.env,
			now,
		}));

	const executablePath = fingerprint.local.resolvedPath ?? fingerprint.local.realPath;
	if (executablePath === null) {
		throw new Error("cannot run Codex local-protocol check without a resolved executable path");
	}

	let ephemeralDir: string | null = null;
	let isolatedHome: ReturnType<typeof prepareCodexIsolatedHomeV0> | null = null;
	let client: CodexAppServerClientV0 | null = null;
	const configOverrides = [
		...CODEX_CONSERVATIVE_CONFIG_OVERRIDES_V0.filter((entry) => !entry.startsWith("sandbox_mode=")),
		`sandbox_mode="${sandboxMode}"`,
		...(options.extraConfigOverrides ?? []),
	];
	const timeoutMs = options.timeoutMs ?? 15_000;
	const unexpectedMcpStartups = new Set<string>();

	let initResult: CodexInitializeResultV0;
	let configReadRaw: Record<string, unknown>;
	let disabledMcpServers: string[] = [];
	let unsafeEnabledMcpServers: string[] = [];
	let threadStartRaw: Record<string, unknown> | null = null;
	let threadReadOk = false;
	let unsubscribeOk = false;
	let threadId: string | null = null;
	let cleanup: ProcessCleanupV0 = { boundary: "process-group", result: "unverified" };
	let stderrDiagnostics: { readonly text: string; readonly truncated: boolean } = { text: "", truncated: false };

	try {
		if (options.checkCwd === undefined) {
			ephemeralDir = mkdtempSync(join(tmpdir(), "endo-codex-check-"));
		}
		const workDir = options.checkCwd ?? ephemeralDir!;
		isolatedHome = prepareCodexIsolatedHomeV0({
			root: options.root,
			cwd: workDir,
			sandboxMode,
			...(options.env === undefined ? {} : { baseEnv: options.env }),
			...(options.sourceCodexHome === undefined ? {} : { sourceCodexHome: options.sourceCodexHome }),
		});

		client = new CodexAppServerClientV0({
			executable: executablePath,
			...(options.args === undefined ? { configOverrides } : { args: options.args }),
			cwd: workDir,
			env: isolatedHome.childEnv,
			...(options.scope === undefined ? {} : { scope: options.scope }),
			requestTimeoutMs: timeoutMs,
			onNotification: (notification) => {
				if (notification.method === "mcpServer/startupStatus/updated") {
					const rawName = notification.params?.name;
					const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : "(unknown)";
					unexpectedMcpStartups.add(name);
				}
			},
		});

		initResult = await client.initialize(
			{
				clientInfo: { name: "endophasia-codex-check", version: "0.1.0" },
				capabilities: { experimentalApi: false },
			},
			{ timeoutMs },
		);
		const isolatedCheck = verifyCodexIsolatedHomeV0(initResult.codexHome, isolatedHome.realDir);
		if (!isolatedCheck.ok) {
			throw new Error(isolatedCheck.reason ?? "Isolated Codex startup home could not be verified.");
		}
		client.notifyInitialized();

		configReadRaw = await client.configRead({ includeLayers: false, cwd: workDir }, { timeoutMs });
		const mcpInfo = inspectCodexMcpServersV0(configReadRaw);
		disabledMcpServers = mcpInfo.disableableNames;
		unsafeEnabledMcpServers = mcpInfo.unsafeEnabledNames;
		const mcpDisableConfig = buildCodexDisableMcpConfigV0(disabledMcpServers);

		threadStartRaw = await client.threadStart(
			{
				cwd: workDir,
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: sandboxMode,
				ephemeral: true,
				...(Object.keys(mcpDisableConfig).length > 0 ? { config: mcpDisableConfig } : {}),
			},
			{ timeoutMs },
		);
		threadId =
			isRecord(threadStartRaw.thread) && typeof threadStartRaw.thread.id === "string"
				? threadStartRaw.thread.id
				: null;

		if (threadId !== null) {
			try {
				await client.threadRead({ threadId, includeTurns: false }, { timeoutMs });
				threadReadOk = true;
			} catch {
				threadReadOk = false;
			}
			try {
				const unsub = await client.threadUnsubscribe({ threadId }, { timeoutMs });
				unsubscribeOk = typeof unsub.status === "string" && unsub.status.length > 0;
			} catch {
				unsubscribeOk = false;
			}
		}
	} finally {
		if (client !== null) {
			cleanup = await client.close();
			stderrDiagnostics = client.stderrDiagnostics();
		}
		isolatedHome?.cleanup();
		if (ephemeralDir !== null) {
			try {
				rmSync(ephemeralDir, { recursive: true, force: true });
			} catch {
				// Ignore scratch cleanup failure.
			}
		}
	}

	const effectivePolicy = verifyCodexEffectivePolicyV0(threadStartRaw ?? {}, {
		disabledMcpServers,
		unsafeEnabledMcpServers,
		unexpectedMcpStartups: [...unexpectedMcpStartups].sort(),
		expectedSandboxMode: sandboxMode,
	});
	const configurationDigest = codexConfigurationDigestV0({
		approvalPolicy: effectivePolicy.effective.approvalPolicy,
		approvalsReviewer: effectivePolicy.effective.approvalsReviewer,
		sandbox: effectivePolicy.effective.sandbox,
		model: effectivePolicy.effective.model,
		modelProvider: effectivePolicy.effective.modelProvider,
		disabledMcpServers,
		configOverrides,
	});

	const at = now().toISOString();
	const dependencies = codexDependenciesV0(fingerprint, configurationDigest);
	const exchangeDigest = sha256HexV0(
		canonicalEndoJsonV0({
			initialize: initResult,
			effectivePolicy: effectivePolicy.effective,
			threadIdPresent: threadId !== null,
			threadReadOk,
			unsubscribeOk,
		} as never),
	);

	const policyOk = effectivePolicy.ok;
	const lifecycleOk = threadId !== null && unsubscribeOk && policyOk;

	const evidence: EndoCapabilityEvidenceV0[] = [
		codexEvidenceV0({
			attachment: options.attachment,
			capability: "codex.protocol.initialize",
			definition: CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0,
			dependencies,
			inputs: { method: "initialize", experimentalApi: false },
			expected: "initialize returns userAgent, codexHome, platformFamily, platformOs and accepts initialized",
			observed: `initialize succeeded (${initResult.platformOs}/${initResult.platformFamily})`,
			classification: "EXACT",
			evidence: [exchangeDigest],
			limitations: [],
			at,
		}),
		codexEvidenceV0({
			attachment: options.attachment,
			capability: "codex.config.read",
			definition: CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0,
			dependencies,
			inputs: { method: "config/read", includeLayers: false },
			expected: "config/read returns effective configuration without mutating user settings",
			observed: `config/read succeeded (${disabledMcpServers.length} inherited MCP server(s) explicitly disabled for check)`,
			classification: "EXACT",
			evidence: [exchangeDigest],
			limitations: [],
			at,
		}),
		codexEvidenceV0({
			attachment: options.attachment,
			capability: "codex.thread.lifecycle",
			definition: CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0,
			dependencies,
			inputs: { method: "thread/start", ephemeral: true, approvalPolicy: "on-request", approvalsReviewer: "user" },
			expected: "ephemeral thread/start establishes non-permissive effective policy and thread/unsubscribe succeeds",
			observed: lifecycleOk
				? `ephemeral thread lifecycle verified (threadRead=${String(threadReadOk)}, unsubscribed=${String(unsubscribeOk)})`
				: `thread lifecycle or policy verification failed: ${effectivePolicy.reasons.join("; ") || "unsubscribe failed"}`,
			classification: lifecycleOk ? "EXACT" : "MISMATCH",
			evidence: [exchangeDigest],
			limitations: threadReadOk ? [] : ["thread/read did not succeed on ephemeral thread"],
			at,
		}),
		codexEvidenceV0({
			attachment: options.attachment,
			capability: "codex.turn.start",
			definition: CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0,
			dependencies,
			inputs: { offlineCheckOnly: true, zeroModelTurns: true },
			expected: "owned thread with verified non-permissive policy is ready for operator-authorized turn/start",
			observed: lifecycleOk
				? "offline initialize, policy verification, and thread lifecycle succeeded with zero model turns"
				: `cannot admit turn/start because policy/thread check failed: ${effectivePolicy.reasons.join("; ")}`,
			classification: lifecycleOk ? "PARTIAL" : "MISMATCH",
			evidence: [exchangeDigest],
			limitations: [
				"offline local-protocol check executes zero model turns; each live turn/start requires explicit operator terminal authorization",
			],
			at,
		}),
		codexEvidenceV0({
			attachment: options.attachment,
			capability: "codex.turn.interrupt",
			definition: CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0,
			dependencies,
			inputs: { offlineCheckOnly: true, zeroModelTurns: true },
			expected: "owned thread is ready for targeted turn/interrupt by (threadId, turnId)",
			observed: lifecycleOk
				? "offline protocol and thread ownership verified; active turn interruption requires a live active turn"
				: `cannot admit turn/interrupt because policy/thread check failed: ${effectivePolicy.reasons.join("; ")}`,
			classification: lifecycleOk ? "PARTIAL" : "MISMATCH",
			evidence: [exchangeDigest],
			limitations: [
				"targeted turn/interrupt is exercised only on an active authorized turn; acknowledgement is not confirmed process termination",
			],
			at,
		}),
	];

	const registry = openEndoHarnessRegistryV0(options.root, options.attachment);
	const previousFingerprint = registry.last("fingerprint");
	const change = codexChangeV0({
		attachment: options.attachment,
		previous: previousFingerprint,
		current: fingerprint,
		at,
	});
	if (!registry.has(fingerprint.id)) registry.append("fingerprint", fingerprint);
	if (!registry.has(change.id)) registry.append("change", change);
	for (const ev of evidence) {
		if (!registry.has(ev.id)) registry.append("evidence", ev);
	}
	const capabilityState = deriveCodexCapabilityStateV0({
		attachment: options.attachment,
		currentFingerprint: fingerprint,
		evidence: registry.list("evidence"),
		configurationDigest,
		at,
	});
	registry.append("state", capabilityState);

	return {
		fingerprint,
		change,
		initialize: initResult,
		effectivePolicy,
		configurationDigest,
		evidence,
		capabilityState,
		cleanup,
		threadId,
		stderrDiagnostics,
	};
}
