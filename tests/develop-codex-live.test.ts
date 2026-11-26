/**
 * Deterministic verification and conformance suite for `DEVELOP-CODEX-LIVE-001`.
 *
 * Covers:
 * 1. Shared `runDevelopAdapterConformanceSuiteV0` directly against production `CodexDevelopAdapterV0`
 *    backed by a deterministic fake Codex App Server child process (`mode: "production"`).
 * 2. D1 transport: initialize, malformed/oversized frames, unknown response IDs, duplicate server request IDs,
 *    interleaved notifications, stderr separation, bounded shutdown & ProcessCleanupV0.
 * 3. D2 identity & offline check: honest `reduced` fingerprint confidence, non-carryover across observations,
 *    inherited MCP server disabling, permissive policy rejection (`approvalPolicy: "never"`, `auto_review`,
 *    `dangerFullAccess`).
 * 4. D3/D4 owned thread & governed controller: Strict-only authority, single-use proof anti-replay, targeted
 *    interruption (`turn/interrupt` with stale/wrong turnId and disconnect mid-dispatch), unsupported queue /
 *    native-command / resume, reasoning-summary provenance, missing usage (never 0), privacy boundary in
 *    `<root>/events/events.log`, and independent replay / session overview reduction.
 * 5. D5 bidirectional native approvals: commandExecution, fileChange, permissions (zero-grant fail-closed),
 *    unknown method (-32601), foreign-thread isolation, no policy/session broadening, pending cancellation.
 * 6. Event-store single-writer lock exclusivity across Pi and Codex (both directions, stale/malformed/race/cleanup).
 * 7. Neutral DEVELOP presentation (`presentLiveCodex` + `developSurface`) and import-boundary source guards.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerClientV0, type CodexTransportFaultV0 } from "../adapters/codex/app-server-client.ts";
import { CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0, deriveCodexCapabilityStateV0 } from "../adapters/codex/capabilities.ts";
import { runCodexLocalProtocolCheckV0 } from "../adapters/codex/checks.ts";
import { buildCodexNativeApprovalDecisionV0, CodexLiveControllerV0 } from "../adapters/codex/controller.ts";
import { CodexDevelopAdapterV0, CodexPolicyViolationErrorV0 } from "../adapters/codex/develop-adapter.ts";
import { fingerprintCodexRuntimeV0 } from "../adapters/codex/identity.ts";
import {
	prepareCodexIsolatedHomeV0,
	validateCodexSandboxModeV0,
	verifyCodexIsolatedHomeV0,
} from "../adapters/codex/isolated-home.ts";
import { escapeCodexCommandForDisplayV0, parseCodexServerRequestV0 } from "../adapters/codex/native-approvals.ts";
import { PiAttachmentV0, PiStoreLockedErrorV0 } from "../adapters/pi/attachment.ts";
import type { ProcessScopeV0 } from "../adapters/rpc-jsonl/process-group.ts";
import { sanitizeCodexTerminalMultilineV0 } from "../cli/codex.ts";
import { type EndoDevelopObservationV0, endoAdapterSessionKeyV0 } from "../protocol/develop-adapter.ts";
import { endoDevelopSessionProblemV0, endoDevelopSurfaceProblemV0 } from "../protocol/develop-session.ts";
import { replayEndoEventRecordV0 } from "../runtime/contracts/event-replay.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { acquireEndoEventStoreWriterLockV0, EndoStoreLockedErrorV0 } from "../storage/writer-lock.ts";
import { developSurface, presentLiveCodex } from "../studio-ui/src/model/develop-session.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { buildOperatorProofV0, runDevelopAdapterConformanceSuiteV0 } from "./helpers/develop-adapter-conformance.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const tempDirs: string[] = [];
function makeTempDir(prefix = "endo-codex-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

async function createCheckedFixture(
	options: {
		scenario?: string;
		attachmentId?: string;
		onNativeApprovalRequest?: ConstructorParameters<typeof CodexDevelopAdapterV0>[0]["onNativeApprovalRequest"];
		logFile?: string;
		triggerFile?: string;
		maxRecordBytes?: number;
	} = {},
) {
	const root = makeTempDir("endo-codex-store-");
	const projectScope = makeTempDir("endo-codex-ws-");
	const attachmentId = options.attachmentId ?? "codex.test";
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		FAKE_CODEX_SCENARIO: "default",
	};
	const check = await runCodexLocalProtocolCheckV0({
		root,
		attachment: attachmentId,
		executable: FAKE_CODEX,
		checkCwd: projectScope,
		env,
	});
	const runtimeEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		FAKE_CODEX_SCENARIO: options.scenario ?? "default",
		...(options.logFile === undefined ? {} : { FAKE_CODEX_LOG_FILE: options.logFile }),
		...(options.triggerFile === undefined ? {} : { FAKE_CODEX_TRIGGER_FILE: options.triggerFile }),
	};
	const adapter = new CodexDevelopAdapterV0({
		root,
		attachmentId,
		projectScope,
		executable: FAKE_CODEX,
		env: runtimeEnv,
		fingerprint: check.fingerprint,
		capabilityState: check.capabilityState,
		...(options.onNativeApprovalRequest === undefined
			? {}
			: { onNativeApprovalRequest: options.onNativeApprovalRequest }),
		...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
	});
	return { root, projectScope, attachmentId, check, adapter };
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Reusable operational adapter conformance suite against REAL CodexDevelopAdapterV0 (`mode: "production"`)
// ---------------------------------------------------------------------------------------------------------------

runDevelopAdapterConformanceSuiteV0({
	name: "CodexDevelopAdapterV0 (production adapter + deterministic fake App Server)",
	mode: "production",
	async createReady() {
		let nowMs = Date.parse("2026-11-25T12:00:00.000Z");
		const root = makeTempDir("endo-codex-conf-store-");
		const projectScope = makeTempDir("endo-codex-conf-ws-");
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			FAKE_CODEX_SCENARIO: "default",
		};
		const check = await runCodexLocalProtocolCheckV0({
			root,
			attachment: "codex.conformance",
			executable: FAKE_CODEX,
			checkCwd: projectScope,
			env,
			now: () => new Date(nowMs),
		});
		const adapter = new CodexDevelopAdapterV0({
			root,
			attachmentId: "codex.conformance",
			projectScope,
			executable: FAKE_CODEX,
			env,
			fingerprint: check.fingerprint,
			capabilityState: check.capabilityState,
			now: () => nowMs,
		});
		await adapter.open();
		let authSeq = 0;
		return {
			adapter,
			nowMs: () => {
				nowMs += 10;
				return nowMs;
			},
			authorize(request, overrides) {
				authSeq += 1;
				return buildOperatorProofV0({
					adapter,
					request,
					nowMs,
					overrides: { authorizationId: `endo.evidence.codex-conf-${authSeq}`, ...overrides },
				});
			},
			rotateInstance() {
				return adapter.rotateInstance();
			},
			disconnect(reason = "simulated transport disconnect") {
				adapter.markDisconnected(reason);
			},
			invalidateEvidence(reason: string) {
				adapter.invalidateEvidence(reason);
			},
			injectObservation(obs: EndoDevelopObservationV0) {
				adapter.injectGuardedObservation(obs);
			},
			async cleanup() {
				await adapter.close();
			},
		};
	},
});

// ---------------------------------------------------------------------------------------------------------------
// 2. D1 Transport & D2 Runtime identity / capability / effective-policy checks
// ---------------------------------------------------------------------------------------------------------------

describe("DEVELOP-CODEX-LIVE-001: D1 transport & D2 identity/policy", () => {
	it("collects honest reduced-confidence fingerprint and blocks reduced-confidence carryover across observations", async () => {
		const root = makeTempDir();
		const ws = makeTempDir();
		const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" };
		const check = await runCodexLocalProtocolCheckV0({
			root,
			attachment: "codex.id",
			executable: FAKE_CODEX,
			checkCwd: ws,
			env,
			now: () => new Date("2026-11-25T10:00:00.000Z"),
		});
		expect(check.fingerprint.runtime).toBe("codex");
		expect(check.fingerprint.reported.version).toBe("0.171.0");
		expect(check.fingerprint.identity.confidence).toBe("reduced");
		expect(check.fingerprint.gaps.some((g) => g.fact === "runtimeContent")).toBe(true);
		expect(check.effectivePolicy.ok).toBe(true);
		expect(check.effectivePolicy.effective.disabledMcpServers).toEqual(["legacy_mcp"]);

		// Same observation admits codex.turn.start (admitted-partial) and codex.turn.interrupt (admitted-partial),
		// while codex.turn.steer stays unverified.
		const capById = Object.fromEntries(check.capabilityState.capabilities.map((c) => [c.capability, c]));
		expect(capById["codex.protocol.initialize"]?.status).toBe("admitted");
		expect(capById["codex.turn.start"]?.status).toBe("admitted-partial");
		expect(capById["codex.turn.interrupt"]?.status).toBe("admitted-partial");
		expect(capById["codex.turn.steer"]?.status).toBe("unverified");

		// A later observation (different timestamp -> different fingerprint.id, same reduced digest) MUST NOT inherit evidence!
		const secondFp = await fingerprintCodexRuntimeV0({
			attachment: "codex.id",
			executable: FAKE_CODEX,
			env,
			now: () => new Date("2026-11-25T11:00:00.000Z"),
		});
		expect(secondFp.id).not.toBe(check.fingerprint.id);
		expect(secondFp.identity.digest).toBe(check.fingerprint.identity.digest);
		const reg = openEndoHarnessRegistryV0(root, "codex.id", { readOnly: true });
		const derivedForSecond = deriveCodexCapabilityStateV0({
			attachment: "codex.id",
			currentFingerprint: secondFp,
			evidence: reg.list("evidence"),
			configurationDigest: check.configurationDigest,
			at: "2026-11-25T11:00:01.000Z",
		});
		for (const entry of derivedForSecond.capabilities) {
			expect(entry.status).toBe("unverified");
		}
		expect(CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0.kind).toBe("local-protocol");
	});

	it.each([
		["permissive-approval-never", 'approvalPolicy is "never"'],
		["permissive-approval-object", "is not the allowlisted"],
		["permissive-auto-reviewer", 'approvalsReviewer is "auto_review"'],
		["permissive-danger-sandbox", 'sandbox policy is "dangerFullAccess"'],
		["permissive-external-sandbox", "not in the allowlisted"],
		["permissive-writable-roots", "writableRoots"],
		["permissive-network-access", "networkAccess"],
		["unsafe-mcp-name", "could not be safely disabled"],
		["ignore-codex-home", "isolated startup home"],
		["unexpected-mcp-startup", "unwanted MCP server"],
	])("fails closed on open() when Codex returns %s and releases the writer lock", async (scenario, expectedMsg) => {
		const fx = await createCheckedFixture({ scenario });
		await expect(fx.adapter.open()).rejects.toThrow(CodexPolicyViolationErrorV0);
		await expect(fx.adapter.open()).rejects.toThrow(expectedMsg);
		// Writer lock must have been released after failed open!
		expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(false);
	});

	it("fails closed on open() when the event store is sealed and validates reasoningEffort at runtime", async () => {
		const fx = await createCheckedFixture();
		// Write a valid event, then corrupt a byte inside the frame to seal the durable event log.
		await fx.adapter.open();
		await fx.adapter.close();
		const logPath = join(fx.root, "events", "events.log");
		const buf = Buffer.from(readFileSync(logPath));
		expect(buf.length).toBeGreaterThan(32);
		buf[buf.length - 4] = buf[buf.length - 4]! ^ 0xff;
		writeFileSync(logPath, buf);

		const adapter2 = new CodexDevelopAdapterV0({
			root: fx.root,
			attachmentId: fx.attachmentId,
			projectScope: fx.projectScope,
			executable: FAKE_CODEX,
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" },
			fingerprint: fx.check.fingerprint,
			capabilityState: fx.check.capabilityState,
		});
		await expect(adapter2.open()).rejects.toThrow(/sealed/i);
		expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(false);

		expect(
			() =>
				new CodexDevelopAdapterV0({
					root: fx.root,
					attachmentId: fx.attachmentId,
					projectScope: fx.projectScope,
					executable: FAKE_CODEX,
					fingerprint: fx.check.fingerprint,
					capabilityState: fx.check.capabilityState,
					reasoningEffort: "bogus" as never,
				}),
		).toThrow(TypeError);
	});

	it("prepares isolated conservative CODEX_HOME without mutating operator config, links auth without reading it, blocks ancestor .codex, supports read-only sandbox, and fails closed on check() isolation breach", async () => {
		const root = makeTempDir("endo-iso-store-");
		const fakeUserHome = makeTempDir("endo-iso-user-codex-");
		const parentWs = makeTempDir("endo-iso-parent-");
		const childWs = join(parentWs, "sub");
		mkdirSync(join(parentWs, ".codex"), { recursive: true });
		mkdirSync(childWs, { recursive: true });
		const sourceAuth = join(fakeUserHome, "auth.json");
		const sourceConfig = join(fakeUserHome, "config.toml");
		writeFileSync(sourceAuth, '{"sentinel":"never-mutated"}', { mode: 0o600 });
		writeFileSync(sourceConfig, 'approval_policy = "never"\n[mcp_servers.canary]\ncommand = "false"\n');

		expect(() => validateCodexSandboxModeV0("danger-full-access")).toThrow(TypeError);
		expect(validateCodexSandboxModeV0("read-only")).toBe("read-only");

		const iso = prepareCodexIsolatedHomeV0({
			root,
			cwd: childWs,
			sandboxMode: "read-only",
			sourceCodexHome: fakeUserHome,
		});
		try {
			expect(iso.authLinked).toBe(true);
			expect(lstatSync(join(iso.dir, "auth.json")).isSymbolicLink()).toBe(true);
			const cfg = readFileSync(iso.configPath, "utf8");
			expect(cfg).toContain('approval_policy = "on-request"');
			expect(cfg).toContain('approvals_reviewer = "user"');
			expect(cfg).toContain('sandbox_mode = "read-only"');
			expect(cfg).toContain("apps = false");
			expect(cfg).toContain("computer_use = false");
			expect(cfg).toContain("browser_use = false");
			expect(cfg).toContain('trust_level = "untrusted"');
			expect(iso.untrustedProjectPaths.length).toBeGreaterThanOrEqual(2);
			expect(verifyCodexIsolatedHomeV0(iso.realDir, iso.realDir).ok).toBe(true);
			expect(verifyCodexIsolatedHomeV0("/tmp/not-isolated", iso.realDir).ok).toBe(false);
		} finally {
			iso.cleanup();
		}
		expect(existsSync(iso.dir)).toBe(false);
		// Operator's normal auth.json and config.toml MUST remain completely intact!
		expect(readFileSync(sourceAuth, "utf8")).toBe('{"sentinel":"never-mutated"}');
		expect(readFileSync(sourceConfig, "utf8")).toContain("[mcp_servers.canary]");

		// Offline check() fails closed when Codex ignores CODEX_HOME or emits unexpected MCP startup.
		await expect(
			runCodexLocalProtocolCheckV0({
				root: makeTempDir("endo-iso-check-ignore-"),
				attachment: "codex.iso",
				executable: FAKE_CODEX,
				checkCwd: childWs,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					FAKE_CODEX_SCENARIO: "ignore-codex-home",
				},
			}),
		).rejects.toThrow(/isolated startup home/i);

		const badMcpCheck = await runCodexLocalProtocolCheckV0({
			root: makeTempDir("endo-iso-check-mcp-"),
			attachment: "codex.iso-mcp",
			executable: FAKE_CODEX,
			checkCwd: childWs,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				FAKE_CODEX_SCENARIO: "unexpected-mcp-startup",
			},
		});
		expect(badMcpCheck.effectivePolicy.ok).toBe(false);
		expect(badMcpCheck.effectivePolicy.reasons.join(";")).toContain("rogue_mcp");

		// Adapter supports explicit conservative `sandboxMode: "read-only"`.
		const roRoot = makeTempDir("endo-ro-store-");
		const roCheck = await runCodexLocalProtocolCheckV0({
			root: roRoot,
			attachment: "codex.ro",
			executable: FAKE_CODEX,
			checkCwd: childWs,
			sandboxMode: "read-only",
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" },
		});
		expect(roCheck.effectivePolicy.ok).toBe(true);
		expect(roCheck.effectivePolicy.effective.sandbox).toEqual({ type: "readOnly", networkAccess: false });
		const roAdapter = new CodexDevelopAdapterV0({
			root: roRoot,
			attachmentId: "codex.ro",
			projectScope: childWs,
			executable: FAKE_CODEX,
			sandboxMode: "read-only",
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" },
			fingerprint: roCheck.fingerprint,
			capabilityState: roCheck.capabilityState,
		});
		try {
			const opened = await roAdapter.open();
			expect(opened.effectivePolicy.sandbox).toEqual({ type: "readOnly", networkAccess: false });
		} finally {
			await roAdapter.close();
		}

		// Requested read-only sandbox MUST fail closed if Codex broadens effective sandbox to workspaceWrite (Review #8).
		const roBroadenAdapter = new CodexDevelopAdapterV0({
			root: makeTempDir("endo-ro-broaden-"),
			attachmentId: "codex.ro",
			projectScope: childWs,
			executable: FAKE_CODEX,
			sandboxMode: "read-only",
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				FAKE_CODEX_SCENARIO: "broaden-readonly-to-workspace",
			},
			fingerprint: roCheck.fingerprint,
			capabilityState: roCheck.capabilityState,
		});
		await expect(roBroadenAdapter.open()).rejects.toThrow(/broadened to "workspaceWrite"/i);

		// Late unexpected MCP startup arriving AFTER open() MUST fail closed AND immediately tear down the runtime/scope!
		const lateRoot = makeTempDir("endo-late-mcp-store-");
		const lateCheck = await runCodexLocalProtocolCheckV0({
			root: lateRoot,
			attachment: "codex.late",
			executable: FAKE_CODEX,
			checkCwd: childWs,
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" },
		});
		let lateScopeStops = 0;
		const lateEnv = {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			FAKE_CODEX_SCENARIO: "late-unexpected-mcp-startup,slow-turn",
		};
		const lateMockScope: ProcessScopeV0 = {
			unit: "endo-late-mcp-mock.scope",
			wrap(command) {
				return { command: command[0]!, args: command.slice(1), env: lateEnv };
			},
			stopWithoutWaiting: ["/usr/bin/true"],
			async stop() {
				lateScopeStops += 1;
				return "confirmed";
			},
			remaining() {
				return 0;
			},
		};
		const lateAdapter = new CodexDevelopAdapterV0({
			root: lateRoot,
			attachmentId: "codex.late",
			projectScope: childWs,
			executable: FAKE_CODEX,
			env: lateEnv,
			scope: lateMockScope,
			fingerprint: lateCheck.fingerprint,
			capabilityState: lateCheck.capabilityState,
		});
		try {
			await lateAdapter.open();
			// Start an active turn BEFORE the late rogue MCP startup fires (30ms), then confirm automatic teardown
			// stops the scope, releases the writer lock, AND records `codex.connection-lost` (`expected: false`)
			// so durable `reduceEndoSessionOverviewV0()` reports `state: "interrupted"` rather than `"running"`.
			const lateCtrl = new CodexLiveControllerV0({
				adapter: lateAdapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			await lateCtrl.requestPrompt("run slow turn before late rogue MCP");
			// Even WITHOUT calling lateAdapter.close(), the late rogue MCP startup MUST stop the scope and release the lock!
			await expect.poll(() => lateScopeStops, { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
			await expect
				.poll(() => existsSync(join(lateRoot, "events", "session-attachment.lock")), { timeout: 3_000 })
				.toBe(false);
			expect(lateAdapter.snapshot().connection.state).toBe("disconnected");
			expect(await lateCtrl.requestPrompt("should fail after late rogue MCP")).toMatchObject({
				status: "refused",
				stage: "admission",
			});
			const roLateStore = createEndoDurableEventStoreV0(lateRoot, { readOnly: true });
			try {
				const lateEvents = roLateStore.page({ limit: 1000 }).events;
				const connLost = lateEvents.find((e) => e.kind === "codex.connection-lost");
				expect(connLost?.payload).toMatchObject({ expected: false });
				const lateOverview = reduceEndoSessionOverviewV0(lateEvents);
				expect(lateOverview.state).toBe("interrupted");
				expect(lateOverview.anomalies).toEqual([]);
			} finally {
				roLateStore.close();
			}
		} finally {
			await lateAdapter.close();
		}

		// baseEnv omitting CODEX_HOME must NOT leak host process.env.CODEX_HOME, and empty "" must NOT link ./auth.json (Review #3).
		const cleanHome = makeTempDir("endo-clean-home-");
		const isoClean = prepareCodexIsolatedHomeV0({
			root: makeTempDir("endo-iso-clean-"),
			cwd: childWs,
			baseEnv: { PATH: process.env.PATH ?? "", HOME: cleanHome },
			sourceCodexHome: "",
		});
		try {
			expect(isoClean.authLinked).toBe(false);
		} finally {
			isoClean.cleanup();
		}
	});

	it("handles malformed/oversized frames, unknown response IDs, and separates stderr diagnostics", async () => {
		const faults: CodexTransportFaultV0[] = [];
		const ws = makeTempDir();
		const client = new CodexAppServerClientV0({
			executable: FAKE_CODEX,
			cwd: ws,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				FAKE_CODEX_SCENARIO: "malformed-frames,stderr-noise",
			},
			maxRecordBytes: 1024,
			onFault: (f) => faults.push(f),
		});
		try {
			const init = await client.initialize({ clientInfo: { name: "test", version: "0.1.0" } });
			expect(init.platformOs).toBe("linux");
			client.notifyInitialized();
			await expect.poll(() => faults.length, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
			const kinds = faults.map((f) => f.kind);
			expect(kinds).toContain("malformed-json");
			expect(kinds).toContain("unknown-response-id");
			expect(kinds).toContain("oversized-record");
			expect(client.stderrDiagnostics().text).toContain("fake-codex diagnostic warning");
		} finally {
			const cleanup = await client.close();
			expect(cleanup.boundary).toBe("process-group");
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 3. D3/D4 Governed controller, single-use anti-replay, targeted stop, reasoning/usage honesty & privacy
// ---------------------------------------------------------------------------------------------------------------

describe("DEVELOP-CODEX-LIVE-001: D3/D4 governed turns, targeted stop, privacy & replay", () => {
	it("enforces Strict-only controller authority, single-use anti-replay, reasoning-summary provenance, privacy, and independent replay", async () => {
		const logFile = join(makeTempDir(), "fake-codex-wire.json");
		const fx = await createCheckedFixture({ scenario: "default", logFile });
		const observations: EndoDevelopObservationV0[] = [];
		fx.adapter.subscribeObservations((o) => observations.push(o));
		try {
			const opened = await fx.adapter.open();
			expect(opened.threadId).toBe("019a0000-0000-7000-8000-000000000010");
			expect(fx.adapter.describe().everydayGrantEligible).toBe(false);
			expect(fx.adapter.describe().operations.queue.capability.standing).toBe("unsupported");
			expect(fx.adapter.describe().operations.resume.capability.standing).toBe("unsupported");

			// Session-grant mechanism MUST be refused on Codex (Strict-only).
			const promptReq = { kind: "prompt" as const, message: "PROMPT_PRIVATE_SECRET_TEXT" };
			const badGrantProof = buildOperatorProofV0({
				adapter: fx.adapter,
				request: promptReq,
				nowMs: Date.now(),
				overrides: { mechanism: "session-grant", sessionGrantId: "endo.session-grant.0123456789abcdef" },
			});
			expect(fx.adapter.admitOperation(promptReq, badGrantProof)).toMatchObject({
				admitted: false,
				code: "session-grant-not-permitted",
			});

			// Controller-declined prompt dispatches nothing.
			const decliningController = new CodexLiveControllerV0({
				adapter: fx.adapter,
				approveOperation: async () => ({ approved: false, reason: "operator said no" }),
			});
			const declined = await decliningController.requestPrompt("PROMPT_PRIVATE_SECRET_TEXT");
			expect(declined).toMatchObject({ status: "refused", stage: "admission", code: "missing-authority" });

			// Explicit operator approval dispatches prompt and returns turnId with consequenceObserved: false.
			const approvingController = new CodexLiveControllerV0({
				adapter: fx.adapter,
				approveOperation: async (p) => {
					expect(p.requiredPhrase).toMatch(/^APPROVE PROMPT [0-9a-f]{6}$/);
					return { approved: true, mechanism: "terminal-phrase" };
				},
			});
			const sent = await approvingController.requestPrompt("PROMPT_PRIVATE_SECRET_TEXT");
			expect(sent).toMatchObject({
				status: "accepted",
				operation: "prompt",
				disposition: "turn-started",
				consequenceObserved: false,
			});
			if (sent.status !== "accepted" || sent.turnId === null) throw new Error("expected turnId");
			const turnDone = await fx.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			expect(turnDone).toBe("completed");

			// Single-use anti-replay: reusing an authorizationId MUST be refused!
			const replayReq = { kind: "prompt" as const, message: "second message" };
			const reusableProof = buildOperatorProofV0({
				adapter: fx.adapter,
				request: replayReq,
				nowMs: Date.now(),
				overrides: { authorizationId: "endo.evidence.single-use-1" },
			});
			const first = await fx.adapter.dispatch(replayReq, reusableProof);
			expect(first.status).toBe("accepted");
			if (first.status === "accepted" && first.turnId) await fx.adapter.waitForTurnCompletion(first.turnId, 5_000);
			const replayed = await fx.adapter.dispatch(replayReq, reusableProof);
			expect(replayed).toMatchObject({ status: "refused", stage: "admission", code: "authority-expired" });

			// Reasoning summary is NEVER relabelled as raw-thinking; costUsd is null (never 0).
			const reasoningObs = observations.filter(
				(o) => o.body.kind === "transcript" && o.body.contentKind === "reasoning",
			);
			expect(reasoningObs.length).toBeGreaterThan(0);
			for (const obs of reasoningObs) {
				if (obs.body.kind === "transcript") expect(obs.body.reasoningKind).toBe("reasoning-summary");
			}
			const usageObs = observations.find((o) => o.body.kind === "usage");
			expect(usageObs?.body).toMatchObject({
				kind: "usage",
				usage: {
					status: "reported",
					value: { inputTokens: 80, outputTokens: 40, reasoningTokens: 15, costUsd: null },
				},
			});

			// Live view retains transcript in memory; canonical event store withholds ALL private text.
			const view = fx.adapter.liveView();
			expect(view.transcript.some((t) => t.text.includes("ASSISTANT_PRIVATE_REPLY_PART1"))).toBe(true);
			expect(view.activity.some((a) => a.activityKind === "command-execution" && a.exitCode === 0)).toBe(true);

			// Verify inherited MCP server was disabled on thread/start.
			const wire = JSON.parse(readFileSync(logFile, "utf8")) as {
				direction: string;
				msg?: { method?: string; params?: Record<string, unknown> };
			}[];
			const threadStartCall = wire.find((w) => w.direction === "in" && w.msg?.method === "thread/start");
			expect(
				(threadStartCall?.msg?.params?.config as Record<string, unknown>)?.["mcp_servers.legacy_mcp.enabled"],
			).toBe(false);
		} finally {
			await fx.adapter.close();
		}

		// Independent read-only verification of `<root>/events/events.log`:
		const rawLog = readFileSync(join(fx.root, "events", "events.log"), "utf8");
		expect(rawLog).not.toContain("PROMPT_PRIVATE_SECRET_TEXT");
		expect(rawLog).not.toContain("ASSISTANT_PRIVATE_REPLY_PART1");
		expect(rawLog).not.toContain("Checking fixture safely");
		expect(rawLog).not.toContain("SENSITIVE_CMD_SECRET_TOKEN");
		// Unkeyed prompt/steer payloadDigest must NOT be persisted in canonical event logs.
		expect(rawLog).not.toContain("payloadDigest");

		const roStore = createEndoDurableEventStoreV0(fx.root, { readOnly: true });
		try {
			const page = roStore.page({ limit: 1000 });
			expect(page.events.length).toBeGreaterThan(0);
			const overview = reduceEndoSessionOverviewV0(page.events);
			expect(overview.session).toEqual({
				status: "reported",
				value: { runtime: "codex", runtimeSessionId: "019a0000-0000-7000-8000-000000000010" },
			});
			expect(overview.counts.runs).toBe(2);
			expect(overview.counts.completed).toBe(2);
			expect(overview.state).toBe("detached");
			expect(overview.anomalies).toEqual([]);

			const record = roStore.record("endo.evidence.codex-replay-check");
			const replay = replayEndoEventRecordV0(record);
			expect(replay.events).toBe("exact");
			expect(replay.derived).toBe("exact");
		} finally {
			roStore.close();
		}
	});

	it("enforces targeted turn/interrupt (stale/missing turnId refused, exact active turn interrupted) and missing usage stays unavailable", async () => {
		const fx = await createCheckedFixture({ scenario: "slow-turn,missing-usage" });
		try {
			await fx.adapter.open();
			const controller = new CodexLiveControllerV0({
				adapter: fx.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			// No active turn -> stop refused.
			expect(await controller.requestStop("nonexistent-turn")).toMatchObject({
				status: "refused",
				stage: "admission",
				code: "no-active-run",
			});

			const started = await controller.requestPrompt("run a slow turn");
			expect(started.status).toBe("accepted");
			if (started.status !== "accepted" || !started.turnId) throw new Error("expected turnId");
			const turnId = started.turnId;

			// Stale / mismatched turnId MUST be refused before touching Codex.
			expect(await controller.requestStop("wrong-turn-id")).toMatchObject({
				status: "refused",
				stage: "admission",
				code: "target-turn-mismatch",
			});

			// Exact active turnId succeeds and yields turn-interrupted.
			const stopped = await controller.requestStop(turnId);
			expect(stopped).toMatchObject({
				status: "accepted",
				operation: "stop",
				disposition: "interrupt-accepted",
				turnId,
				consequenceObserved: false,
			});
			expect(await fx.adapter.waitForTurnCompletion(turnId, 5_000)).toBe("interrupted");
			// Missing usage is null/unavailable — NEVER fabricated as 0.
			expect(fx.adapter.liveView().lastUsage).toBeNull();
			expect(fx.adapter.liveView().totalUsage).toBeNull();
		} finally {
			await fx.adapter.close();
		}
	});

	it("returns unknown (dispatched: true) on transport disconnect mid-dispatch and isolates foreign-thread events", async () => {
		const fx1 = await createCheckedFixture({ scenario: "disconnect-mid-turn" });
		try {
			await fx1.adapter.open();
			const controller = new CodexLiveControllerV0({
				adapter: fx1.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const res = await controller.requestPrompt("crash mid-turn");
			expect(res).toMatchObject({ status: "unknown", operation: "prompt", dispatched: true });
		} finally {
			await fx1.adapter.close();
		}

		const fx2 = await createCheckedFixture({ scenario: "foreign-thread-event" });
		try {
			await fx2.adapter.open();
			const controller = new CodexLiveControllerV0({
				adapter: fx2.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const res = await controller.requestPrompt("check foreign isolation");
			if (res.status === "accepted" && res.turnId) await fx2.adapter.waitForTurnCompletion(res.turnId, 5_000);
			// Foreign thread's text MUST NOT leak into owned thread's live transcript!
			expect(fx2.adapter.liveView().transcript.some((t) => t.text.includes("FOREIGN_SECRET_TEXT"))).toBe(false);
		} finally {
			await fx2.adapter.close();
		}
	});

	it("handles same-chunk turn failure without resurrecting activeTurn, serializes concurrent prompt dispatch, honors pre-aborted AbortSignal, preserves scope cleanup, and gates turn/steer", async () => {
		// 1. Same-chunk turn/start + turn/completed(failed) must not leave zombie activeTurn and must return "failed".
		const fxFast = await createCheckedFixture({ scenario: "same-chunk-turn-failed" });
		try {
			await fxFast.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxFast.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			// Pre-aborted AbortSignal must refuse BEFORE invoking approveOperation!
			let approveCalls = 0;
			const preAbortedCtrl = new CodexLiveControllerV0({
				adapter: fxFast.adapter,
				approveOperation: async () => {
					approveCalls += 1;
					return { approved: true, mechanism: "terminal-phrase" };
				},
			});
			const ac = new AbortController();
			ac.abort();
			const abortedOut = await preAbortedCtrl.requestPrompt("should not prompt", ac.signal);
			expect(abortedOut).toMatchObject({ status: "refused", stage: "admission", code: "missing-authority" });
			expect(approveCalls).toBe(0);

			const res = await ctrl.requestPrompt("fast fail");
			expect(res.status).toBe("accepted");
			if (res.status !== "accepted" || !res.turnId) throw new Error("expected turnId");
			expect(await fxFast.adapter.waitForTurnCompletion(res.turnId, 1_000)).toBe("failed");
			expect(fxFast.adapter.activeTurnId).toBeNull();
		} finally {
			await fxFast.adapter.close();
		}

		// 2. Concurrent direct adapter.dispatch({ kind: "prompt" }) admits at most one; second refused with run-active.
		const fxSlow = await createCheckedFixture({ scenario: "slow-turn" });
		try {
			await fxSlow.adapter.open();
			const req1 = { kind: "prompt" as const, message: "first concurrent prompt" };
			const req2 = { kind: "prompt" as const, message: "second concurrent prompt" };
			const p1 = buildOperatorProofV0({
				adapter: fxSlow.adapter,
				request: req1,
				nowMs: Date.now(),
				overrides: { authorizationId: "endo.evidence.conc-1" },
			});
			const p2 = buildOperatorProofV0({
				adapter: fxSlow.adapter,
				request: req2,
				nowMs: Date.now(),
				overrides: { authorizationId: "endo.evidence.conc-2" },
			});
			const [o1, o2] = await Promise.all([fxSlow.adapter.dispatch(req1, p1), fxSlow.adapter.dispatch(req2, p2)]);
			expect(o1.status).toBe("accepted");
			expect(o2).toMatchObject({ status: "refused", stage: "admission", code: "run-active" });

			// Unverified turn/steer is refused by default capability state.
			const ctrl = new CodexLiveControllerV0({
				adapter: fxSlow.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const activeId = fxSlow.adapter.activeTurnId!;
			expect(await ctrl.requestSteer("redirect", activeId)).toMatchObject({
				status: "refused",
				stage: "admission",
				code: "capability-not-admitted",
			});
		} finally {
			await fxSlow.adapter.close();
		}

		// 3. Explicit steer admission + targetTurnId mismatch check + mock ProcessScopeV0 cleanup preservation.
		const fxScope = await createCheckedFixture({ scenario: "slow-turn" });
		const startCap = fxScope.check.capabilityState.capabilities.find((c) => c.capability === "codex.turn.start")!;
		const admittedSteerCap = {
			...fxScope.check.capabilityState,
			capabilities: fxScope.check.capabilityState.capabilities.map((c) =>
				c.capability === "codex.turn.steer"
					? { ...startCap, capability: "codex.turn.steer", reason: "test-admitted" }
					: c,
			),
		};
		let scopeStops = 0;
		const scopeEnv = {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			FAKE_CODEX_SCENARIO: "slow-turn",
		};
		const mockScope: ProcessScopeV0 = {
			unit: "endo-mock-codex.scope",
			wrap(command) {
				return { command: command[0]!, args: command.slice(1), env: scopeEnv };
			},
			stopWithoutWaiting: ["/usr/bin/true"],
			async stop() {
				scopeStops += 1;
				return "confirmed";
			},
			remaining() {
				return 0;
			},
		};
		const scopedAdapter = new CodexDevelopAdapterV0({
			root: fxScope.root,
			attachmentId: fxScope.attachmentId,
			projectScope: fxScope.projectScope,
			executable: FAKE_CODEX,
			env: scopeEnv,
			fingerprint: fxScope.check.fingerprint,
			capabilityState: admittedSteerCap,
			scope: mockScope,
		});
		await scopedAdapter.open();
		const scopedCtrl = new CodexLiveControllerV0({
			adapter: scopedAdapter,
			approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
		});
		const started = await scopedCtrl.requestPrompt("start steerable turn");
		expect(started.status).toBe("accepted");
		const activeTurnId = scopedAdapter.activeTurnId!;
		expect(await scopedCtrl.requestSteer("wrong turn", "not-the-turn")).toMatchObject({
			status: "refused",
			stage: "admission",
			code: "target-turn-mismatch",
		});
		expect(await scopedCtrl.requestSteer("on-target steer", activeTurnId)).toMatchObject({
			status: "accepted",
			operation: "steer",
			disposition: "steered",
			turnId: activeTurnId,
			consequenceObserved: false,
		});
		const closed = await scopedAdapter.close();
		expect(scopeStops).toBeGreaterThanOrEqual(1);
		expect(closed.cleanup).toMatchObject({
			boundary: "scope",
			result: "confirmed",
		});
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 4. D5 Bidirectional Native Approval Boundaries
// ---------------------------------------------------------------------------------------------------------------

describe("DEVELOP-CODEX-LIVE-001: D5 fail-closed native approvals", () => {
	it("declines commandExecution fail-closed when unattended (prompt authority NEVER inherited) and accepts once only on explicit operator decision", async () => {
		// Unattended -> fails closed with { decision: "decline" }.
		const logUnattended = join(makeTempDir(), "wire-unattended.json");
		const fxUnattended = await createCheckedFixture({ scenario: "native-approval-cmd", logFile: logUnattended });
		try {
			await fxUnattended.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxUnattended.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("run test");
			if (sent.status === "accepted" && sent.turnId)
				await fxUnattended.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logUnattended, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			const reply = wire.find((w) => w.direction === "server-request-reply");
			expect(reply?.result).toEqual({ decision: "decline" });
		} finally {
			await fxUnattended.adapter.close();
		}

		// Interactive explicit operator accept -> sends strictly { decision: "accept" } (never acceptForSession / amendment).
		const logAccept = join(makeTempDir(), "wire-accept.json");
		const fxAccept = await createCheckedFixture({
			scenario: "native-approval-cmd",
			logFile: logAccept,
			onNativeApprovalRequest: async (req) =>
				buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
		});
		try {
			await fxAccept.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxAccept.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("run test");
			if (sent.status === "accepted" && sent.turnId)
				await fxAccept.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logAccept, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			const reply = wire.find((w) => w.direction === "server-request-reply");
			expect(reply?.result).toEqual({ decision: "accept" });
		} finally {
			await fxAccept.adapter.close();
		}
	});

	it("fails closed on permissions requests ({ permissions: {}, scope: 'turn' }), unknown methods (-32601), duplicate server request IDs, and scope-broadening decisions", async () => {
		// Permissions request -> zero granted permissions, never broadened to session!
		const logPerm = join(makeTempDir(), "wire-perm.json");
		const fxPerm = await createCheckedFixture({
			scenario: "native-approval-permissions",
			logFile: logPerm,
			onNativeApprovalRequest: async (req) =>
				buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
		});
		try {
			await fxPerm.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxPerm.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("ask permissions");
			if (sent.status === "accepted" && sent.turnId) await fxPerm.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logPerm, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			const reply = wire.find((w) => w.direction === "server-request-reply");
			expect(reply?.result).toEqual({ permissions: {}, scope: "turn" });
		} finally {
			await fxPerm.adapter.close();
		}

		// Unknown ServerRequest method -> JSON-RPC error -32601.
		const logUnknown = join(makeTempDir(), "wire-unknown.json");
		const fxUnknown = await createCheckedFixture({ scenario: "native-approval-unknown", logFile: logUnknown });
		try {
			await fxUnknown.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxUnknown.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("ask unknown");
			if (sent.status === "accepted" && sent.turnId)
				await fxUnknown.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logUnknown, "utf8")) as { direction: string; error?: { code: number } }[];
			const reply = wire.find((w) => w.direction === "server-request-reply");
			expect(reply?.error?.code).toBe(-32601);
		} finally {
			await fxUnknown.adapter.close();
		}

		// Duplicate server request IDs + fileChange with policy broadening attempt (approvedScope: "session" refused!).
		const logFileChange = join(makeTempDir(), "wire-fc.json");
		const fxFile = await createCheckedFixture({
			scenario: "native-approval-file",
			logFile: logFileChange,
			onNativeApprovalRequest: async (req) => ({
				...buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
				approvedScope: "session",
			}),
		});
		try {
			await fxFile.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxFile.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("edit file");
			if (sent.status === "accepted" && sent.turnId) await fxFile.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logFileChange, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			const reply = wire.find((w) => w.direction === "server-request-reply");
			expect(reply?.result).toEqual({ decision: "decline" });
		} finally {
			await fxFile.adapter.close();
		}
	});

	it("exercises duplicate server request IDs, all fail-closed ServerRequest methods, serverRequest/resolved, idle/missing-thread refusal, and non-pending handleNativeApproval refusal", async () => {
		// 1. Duplicate server request IDs -> exactly one reply + serverRequest/resolved observation.
		const logDup = join(makeTempDir(), "wire-dup.json");
		const fxDup = await createCheckedFixture({
			scenario: "duplicate-server-req,emit-server-request-resolved",
			logFile: logDup,
		});
		const dupObs: EndoDevelopObservationV0[] = [];
		fxDup.adapter.subscribeObservations((o) => dupObs.push(o));
		try {
			await fxDup.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxDup.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("dup test");
			if (sent.status === "accepted" && sent.turnId) await fxDup.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logDup, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			const replies = wire.filter((w) => w.direction === "server-request-reply");
			expect(replies).toHaveLength(1);
			expect(replies[0]?.result).toEqual({ decision: "decline" });
			expect(dupObs.some((o) => o.body.kind === "native-approval" && o.body.phase === "resolved")).toBe(true);

			// Calling handleNativeApproval for a non-pending requestId MUST refuse fail-closed.
			const fakeReq = {
				requestId: "srv-not-pending",
				source: "codex-live" as const,
				sessionKey: endoAdapterSessionKeyV0(fxDup.adapter.describe().session)!,
				instanceId: fxDup.adapter.describe().attachment.instanceId,
				turnId: null,
				itemId: null,
				approvalKind: "command-execution" as const,
				nativeMethod: "item/commandExecution/requestApproval",
				summary: "forged",
				requestedScope: "once" as const,
			};
			const bogusDecision = buildCodexNativeApprovalDecisionV0({ request: fakeReq, decision: "accept" });
			expect(fxDup.adapter.handleNativeApproval(fakeReq, bogusDecision)).toMatchObject({
				resolution: "cancelled",
				code: "binding-mismatch",
				grantsEndophasiaAuthority: false,
			});
		} finally {
			await fxDup.adapter.close();
		}

		// 2. Remaining fail-closed ServerRequest methods (always fail-closed even if handler tries to accept).
		const cases: [string, Record<string, unknown>][] = [
			["native-approval-user-input", { answers: {} }],
			["native-approval-mcp-elicitation", { action: "decline", content: null, _meta: null }],
			[
				"native-approval-legacy-patch",
				{ decision: { denied: { rejection: "Endophasia v0 declines legacy approval RPCs fail-closed." } } },
			],
			[
				"native-approval-legacy-exec",
				{ decision: { denied: { rejection: "Endophasia v0 declines legacy approval RPCs fail-closed." } } },
			],
			["native-approval-tool-call", { success: false, contentItems: [] }],
			["native-approval-missing-thread", { decision: "cancel" }],
		];
		for (const [scenario, expectedResult] of cases) {
			const logPath = join(makeTempDir(), `wire-${scenario}.json`);
			const fx = await createCheckedFixture({
				scenario,
				logFile: logPath,
				onNativeApprovalRequest: async (req) =>
					buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
			});
			try {
				await fx.adapter.open();
				const ctrl = new CodexLiveControllerV0({
					adapter: fx.adapter,
					approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
				});
				const sent = await ctrl.requestPrompt(`run ${scenario}`);
				if (sent.status === "accepted" && sent.turnId) await fx.adapter.waitForTurnCompletion(sent.turnId, 5_000);
				const wire = JSON.parse(readFileSync(logPath, "utf8")) as {
					direction: string;
					result?: Record<string, unknown>;
				}[];
				const reply = wire.find((w) => w.direction === "server-request-reply");
				expect(reply?.result, `scenario ${scenario}`).toEqual(expectedResult);
			} finally {
				await fx.adapter.close();
			}
		}

		// 3. Idle-state native approval (sent after open() completes, before any turn is active) MUST fail closed even with accepting handler!
		const idleDir = makeTempDir();
		const logIdle = join(idleDir, "wire-idle.json");
		const triggerIdle = join(idleDir, "trigger-idle");
		const fxIdle = await createCheckedFixture({
			scenario: "native-approval-idle",
			logFile: logIdle,
			triggerFile: triggerIdle,
			onNativeApprovalRequest: async (req) =>
				buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
		});
		try {
			await fxIdle.adapter.open();
			writeFileSync(triggerIdle, "go\n", "utf8");
			await expect
				.poll(() => {
					if (!existsSync(logIdle)) return null;
					const wire = JSON.parse(readFileSync(logIdle, "utf8")) as {
						direction: string;
						result?: Record<string, unknown>;
					}[];
					return wire.find((w) => w.direction === "server-request-reply")?.result ?? null;
				})
				.toEqual({ decision: "cancel" });
		} finally {
			await fxIdle.adapter.close();
		}

		// 4. Idle-state native approval with OMITTED turnId (`null === null` bypass check, Review #7) MUST fail closed!
		const idleNullDir = makeTempDir();
		const logIdleNull = join(idleNullDir, "wire-idle-null-turn.json");
		const triggerIdleNull = join(idleNullDir, "trigger-idle-null");
		const fxIdleNull = await createCheckedFixture({
			scenario: "native-approval-idle-null-turn",
			logFile: logIdleNull,
			triggerFile: triggerIdleNull,
			onNativeApprovalRequest: async (req) =>
				buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
		});
		try {
			await fxIdleNull.adapter.open();
			writeFileSync(triggerIdleNull, "go\n", "utf8");
			await expect
				.poll(() => {
					if (!existsSync(logIdleNull)) return null;
					const wire = JSON.parse(readFileSync(logIdleNull, "utf8")) as {
						direction: string;
						result?: Record<string, unknown>;
					}[];
					return wire.find((w) => w.direction === "server-request-reply")?.result ?? null;
				})
				.toEqual({ decision: "cancel" });
		} finally {
			await fxIdleNull.adapter.close();
		}

		// 5. Long command (>200 chars, <=4096) displays the COMPLETE command in summary (no silent truncation);
		// oversized command (>4096 chars) refuses interactive accept fail-closed!
		const logLong = join(makeTempDir(), "wire-cmd-long.json");
		let seenLongSummary = "";
		const fxLong = await createCheckedFixture({
			scenario: "native-approval-cmd-long",
			logFile: logLong,
			onNativeApprovalRequest: async (req) => {
				seenLongSummary = req.summary;
				return buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" });
			},
		});
		try {
			await fxLong.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxLong.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("run long command");
			if (sent.status === "accepted" && sent.turnId) await fxLong.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			expect(seenLongSummary).toContain("VISIBLE_TAIL_320_CHARS");
			const wire = JSON.parse(readFileSync(logLong, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			expect(wire.find((w) => w.direction === "server-request-reply")?.result).toEqual({ decision: "accept" });
		} finally {
			await fxLong.adapter.close();
		}

		const logOver = join(makeTempDir(), "wire-cmd-oversized.json");
		const fxOver = await createCheckedFixture({
			scenario: "native-approval-cmd-oversized",
			logFile: logOver,
			onNativeApprovalRequest: async (req) =>
				buildCodexNativeApprovalDecisionV0({ request: req, decision: "accept" }),
		});
		try {
			await fxOver.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxOver.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("run oversized command");
			if (sent.status === "accepted" && sent.turnId) await fxOver.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const wire = JSON.parse(readFileSync(logOver, "utf8")) as {
				direction: string;
				result?: Record<string, unknown>;
			}[];
			expect(wire.find((w) => w.direction === "server-request-reply")?.result).toEqual({ decision: "decline" });
		} finally {
			await fxOver.adapter.close();
		}

		// 6. Streamed raw reasoning (`item/reasoning/textDelta`) + `item/completed` updates the same item in-place
		// (1 completed `raw-thinking` entry, zero duplicate unfinished copy; sibling `reasoning-summary` stays distinct).
		const fxRaw = await createCheckedFixture({ scenario: "raw-reasoning-delta" });
		try {
			await fxRaw.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fxRaw.adapter,
				approveOperation: async () => ({ approved: true, mechanism: "terminal-phrase" }),
			});
			const sent = await ctrl.requestPrompt("check raw reasoning completion");
			if (sent.status === "accepted" && sent.turnId) await fxRaw.adapter.waitForTurnCompletion(sent.turnId, 5_000);
			const rawEntries = fxRaw.adapter
				.liveView()
				.transcript.filter((t) => t.contentKind === "reasoning" && t.reasoningKind === "raw-thinking");
			const summaryEntries = fxRaw.adapter
				.liveView()
				.transcript.filter((t) => t.contentKind === "reasoning" && t.reasoningKind === "reasoning-summary");
			expect(rawEntries).toHaveLength(1);
			expect(rawEntries[0]).toMatchObject({ completed: true, text: "Raw step 1 complete." });
			expect(summaryEntries).toHaveLength(1);
			expect(summaryEntries[0]).toMatchObject({ completed: true, text: "Checking fixture safely." });
		} finally {
			await fxRaw.adapter.close();
		}

		// 7. Multiline command preserves visible `\n` escape (never collapses `# comment\nrm -rf` into a single comment),
		// and CLI multiline output sanitizer neutralizes ANSI CSI / OSC / C1 / bidi sequences while preserving `\n`.
		const multilineCmd = 'echo safe # comment\nrm -rf "$HOME/Documents"';
		const parsedMulti = parseCodexServerRequestV0({
			request: {
				id: "srv-multi-1",
				method: "item/commandExecution/requestApproval",
				instanceId: "inst-1",
				params: { threadId: "t1", turnId: "turn-1", itemId: "item-1", command: multilineCmd },
			},
			source: "codex-live",
			sessionKey: "codex-live:codex.test:t1",
		});
		expect(parsedMulti.interactiveAcceptSupported).toBe(true);
		expect(parsedMulti.normalized.summary).toContain(escapeCodexCommandForDisplayV0(multilineCmd));
		expect(parsedMulti.normalized.summary).toContain("\\nrm -rf");
		expect(parsedMulti.normalized.summary).not.toContain("# comment rm -rf");

		const sanitizedTranscript = sanitizeCodexTerminalMultilineV0(
			"line1\n\u001b[2J\u001b]52;c;YWJj\u0007\u009b31m\u202ehijack\tline2",
		);
		expect(sanitizedTranscript).toContain("line1\n");
		expect(sanitizedTranscript).toContain("\tline2");
		expect(sanitizedTranscript).not.toContain("\u001b");
		expect(sanitizedTranscript).not.toContain("\u0007");
		expect(sanitizedTranscript).not.toContain("\u009b");
		expect(sanitizedTranscript).not.toContain("\u202e");
		expect(sanitizedTranscript).toContain("\\x1b");
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Event-store single-writer lock exclusivity across Pi and Codex
// ---------------------------------------------------------------------------------------------------------------

describe("DEVELOP-CODEX-LIVE-001: cross-harness single-writer event-store exclusivity", () => {
	it("enforces mutual exclusion between Pi and Codex, handles stale/malformed/non-PID locks, and releases cleanly", async () => {
		const fx = await createCheckedFixture();
		// 1. Live lock held by Pi -> Codex open() MUST fail closed with EndoStoreLockedErrorV0.
		const releasePiLock = acquireEndoEventStoreWriterLockV0(fx.root, "pi.default");
		await expect(fx.adapter.open()).rejects.toThrow(EndoStoreLockedErrorV0);
		releasePiLock();

		// 2. Real PiAttachmentV0.openSession() vs real CodexDevelopAdapterV0.open() mutual exclusion in BOTH directions!
		const fakePi = installFakePi("1.0.0");
		try {
			const pi = new PiAttachmentV0({
				root: fx.root,
				cwd: fx.projectScope,
				executable: fakePi.bin,
				env: fakePiEnv({ FAKE_PI_STEP_MS: "10" }),
				requestTimeoutMs: 10_000,
			});
			await pi.identify();
			await pi.checkLocal();

			// Direction A: Codex holds lock -> PiAttachmentV0.openSession() fails closed with PiStoreLockedErrorV0.
			await fx.adapter.open();
			expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(true);
			await expect(pi.openSession()).rejects.toThrow(PiStoreLockedErrorV0);
			expect(new PiStoreLockedErrorV0("/tmp/lock", "codex.test")).toBeInstanceOf(EndoStoreLockedErrorV0);
			await fx.adapter.close();
			expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(false);

			// Direction B: Pi holds lock -> fresh CodexDevelopAdapterV0.open() fails closed with EndoStoreLockedErrorV0.
			const codexAdapter2 = new CodexDevelopAdapterV0({
				root: fx.root,
				attachmentId: fx.attachmentId,
				projectScope: fx.projectScope,
				executable: FAKE_CODEX,
				env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FAKE_CODEX_SCENARIO: "default" },
				fingerprint: fx.check.fingerprint,
				capabilityState: fx.check.capabilityState,
			});
			const piSession = await pi.openSession();
			try {
				await expect(codexAdapter2.open()).rejects.toThrow(EndoStoreLockedErrorV0);
			} finally {
				await piSession.close();
			}
			expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(false);
		} finally {
			fakePi.remove();
		}

		// 3. Stale dead-PID lock is replaced cleanly; stale release closure NEVER deletes a newer holder's lock.
		const lockPath = join(fx.root, "events", "session-attachment.lock");
		mkdirSync(join(fx.root, "events"), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, attachment: "dead.proc", at: new Date().toISOString() }),
		);
		const rel1 = acquireEndoEventStoreWriterLockV0(fx.root, "codex.test");
		rel1();
		const rel2 = acquireEndoEventStoreWriterLockV0(fx.root, "codex.test-2");
		// Calling rel1 again after rel2 owns the lock must NOT remove rel2's lock file!
		rel1();
		expect(existsSync(lockPath)).toBe(true);
		rel2();
		expect(existsSync(lockPath)).toBe(false);

		// 4. Malformed lock fails closed (never silently stolen).
		writeFileSync(lockPath, "{not-valid-json");
		expect(() => acquireEndoEventStoreWriterLockV0(fx.root, "codex.test")).toThrow(EndoStoreLockedErrorV0);
		rmSync(lockPath, { force: true });

		// 5. Non-PID sentinel lock (future E4 compatibility) fails closed (never silently stolen).
		writeFileSync(lockPath, JSON.stringify({ format: "per-attachment-v1", attachment: "e4-per-attachment-store" }));
		expect(() => acquireEndoEventStoreWriterLockV0(fx.root, "codex.test")).toThrow(EndoStoreLockedErrorV0);
		rmSync(lockPath, { force: true });

		// 6. Concurrent acquisition race in same process admits exactly one winner.
		const first = acquireEndoEventStoreWriterLockV0(fx.root, "codex.a");
		expect(() => acquireEndoEventStoreWriterLockV0(fx.root, "codex.b")).toThrow(EndoStoreLockedErrorV0);
		first();
	});
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Neutral DEVELOP presentation & import-boundary source guards
// ---------------------------------------------------------------------------------------------------------------

describe("DEVELOP-CODEX-LIVE-001: neutral DEVELOP presentation & source boundaries", () => {
	it("projects live Codex honestly into EndoDevelopSessionV0 and developSurface without faking Pi parity", async () => {
		const fx = await createCheckedFixture();
		try {
			await fx.adapter.open();
			const ctrl = new CodexLiveControllerV0({
				adapter: fx.adapter,
				approveOperation: async () => ({ approved: false, reason: "test" }),
			});
			const session = presentLiveCodex(ctrl.status());
			expect(endoDevelopSessionProblemV0(session)).toBeNull();
			expect(session.identity.source).toBe("codex-live");
			expect(session.runtime).toMatchObject({ status: "established", value: { name: "Codex", version: "0.171.0" } });
			expect(session.capabilities.control.prompt).toEqual({
				status: "supported",
				via: "codex-live-controller",
				reason: null,
			});
			expect(session.capabilities.control.stop).toEqual({
				status: "supported",
				via: "codex-live-controller",
				reason: null,
			});
			expect(session.capabilities.control.queue.status).toBe("unsupported");
			expect(session.capabilities.control.resume.status).toBe("unsupported");

			const surface = developSurface(null, [], null, [], { status: ctrl.status(), unreachable: false });
			expect(endoDevelopSurfaceProblemV0(surface)).toBeNull();
			expect(surface.sessions).toHaveLength(1);

			// Edge presentation states must also pass protocol validation (Finding #14 regressions):
			const baseStatus = ctrl.status();
			const noThread = presentLiveCodex({ ...baseStatus, threadId: null });
			expect(endoDevelopSessionProblemV0(noThread)).toBeNull();
			expect(noThread.ownership.status).toBe("unavailable");
			expect(noThread.capabilities.control.prompt.status).toBe("unavailable");
			expect(noThread.capabilities.control.stop.status).toBe("unavailable");

			const notApplicable = presentLiveCodex({
				...baseStatus,
				connection: "not-applicable",
				connectionReason: "closed",
			});
			expect(endoDevelopSessionProblemV0(notApplicable)).toBeNull();
			expect(notApplicable.connection.state).toBe("unknown");

			const reconnecting = presentLiveCodex({
				...baseStatus,
				connection: "reconnecting",
				connectionReason: "retry",
			});
			expect(endoDevelopSessionProblemV0(reconnecting)).toBeNull();
			expect(reconnecting.connection.state).toBe("unknown");
		} finally {
			await fx.adapter.close();
		}
	});

	it("preserves module import boundaries and exposes no shell/fs RPC methods on CodexAppServerClientV0", () => {
		const codexDir = join(REPO_ROOT, "adapters", "codex");
		const files = readdirSync(codexDir).filter((f) => f.endsWith(".ts"));
		for (const file of files) {
			const src = readFileSync(join(codexDir, file), "utf8");
			expect(src, `${file} must not import adapters/pi/`).not.toMatch(/from\s+["'][^"']*adapters\/pi\//);
			expect(src, `${file} must not import protocol/develop-session.ts`).not.toMatch(/develop-session\.ts/);
			expect(src, `${file} must not import test fixtures`).not.toMatch(
				/codex-adapter-specimen|develop-adapter-conformance/,
			);
		}
		const clientSrc = readFileSync(join(codexDir, "app-server-client.ts"), "utf8");
		expect(clientSrc).not.toMatch(
			/["']command\/exec["']|["']thread\/shellCommand["']|["']fs\/writeFile["']|["']fs\/readFile["']/,
		);
		expect(clientSrc).not.toMatch(/shell:\s*true/);
	});
});
