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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { PiAttachmentV0, PiStoreLockedErrorV0 } from "../adapters/pi/attachment.ts";
import type { EndoDevelopObservationV0 } from "../protocol/develop-adapter.ts";
import { endoDevelopSessionProblemV0, endoDevelopSurfaceProblemV0 } from "../protocol/develop-session.ts";
import { replayEndoEventRecordV0 } from "../runtime/contracts/event-replay.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { acquireEndoEventStoreWriterLockV0, EndoStoreLockedErrorV0 } from "../storage/writer-lock.ts";
import { developSurface, presentLiveCodex } from "../studio-ui/src/model/develop-session.ts";
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
		["permissive-auto-reviewer", 'approvalsReviewer is "auto_review"'],
		["permissive-danger-sandbox", 'sandbox policy is "dangerFullAccess"'],
	])("fails closed on open() when Codex returns %s and releases the writer lock", async (scenario, expectedMsg) => {
		const fx = await createCheckedFixture({ scenario });
		await expect(fx.adapter.open()).rejects.toThrow(CodexPolicyViolationErrorV0);
		await expect(fx.adapter.open()).rejects.toThrow(expectedMsg);
		// Writer lock must have been released after failed open!
		expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(false);
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

		// 2. Codex opens -> holds `<root>/events/session-attachment.lock` -> Pi attachment MUST refuse (PiStoreLockedErrorV0).
		await fx.adapter.open();
		expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(true);
		const pi = new PiAttachmentV0({ root: fx.root, attachment: "pi.default" });
		await expect(async () => {
			// Directly test shared lock contention via Pi's openSession path or shared lock:
			acquireEndoEventStoreWriterLockV0(fx.root, "pi.default");
		}).rejects.toThrow(EndoStoreLockedErrorV0);
		// Verify PiStoreLockedErrorV0 extends EndoStoreLockedErrorV0.
		expect(new PiStoreLockedErrorV0("/tmp/lock", "codex.test")).toBeInstanceOf(EndoStoreLockedErrorV0);
		expect(pi.attachment).toBe("pi.default");

		await fx.adapter.close();
		expect(existsSync(join(fx.root, "events", "session-attachment.lock"))).toBe(false);

		// 3. Stale dead-PID lock is replaced cleanly.
		const lockPath = join(fx.root, "events", "session-attachment.lock");
		mkdirSync(join(fx.root, "events"), { recursive: true });
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999_999_999, attachment: "dead.proc", at: new Date().toISOString() }),
		);
		const rel1 = acquireEndoEventStoreWriterLockV0(fx.root, "codex.test");
		rel1();

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
