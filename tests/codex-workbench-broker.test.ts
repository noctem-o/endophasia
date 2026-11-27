import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCodexLocalProtocolCheckV0 } from "../adapters/codex/checks.ts";
import { buildCodexNativeApprovalDecisionV0 } from "../adapters/codex/controller.ts";
import { CodexDevelopAdapterV0, type CodexNativeApprovalHandlerV0 } from "../adapters/codex/develop-adapter.ts";
import {
	CodexLiveTranscriptV0,
	LIVE_TRANSCRIPT_MAX_BYTES_V0,
	LIVE_TRANSCRIPT_MAX_ITEMS_V0,
} from "../adapters/codex/live-transcript.ts";
import {
	type CodexWorkbenchApprovalContextV0,
	type CodexWorkbenchApproverV0,
	CodexWorkbenchBrokerV0,
} from "../adapters/codex/workbench.ts";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { codexSessionCommand } from "../cli/codex.ts";
import { developCommand } from "../cli/harness.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { acquireEndoEventStoreWriterLockV0 } from "../storage/writer-lock.ts";
import { presentLiveWorkbenchSession } from "../studio-ui/src/model/develop-session.ts";
import { readWorkbenchStatus, readWorkbenchTranscript } from "../studio-ui/src/model/workbench-wire.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
let UI_DIR = "";

beforeAll(async () => {
	const { ensureSharedStudioUiDir } = await import("./helpers/studio-ui-build.ts");
	UI_DIR = await ensureSharedStudioUiDir();
}, 90_000);

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeGitRepo(): string {
	const repo = makeTempDir("endo-codex-wb-repo-");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Endo Test"], { cwd: repo });
	writeFileSync(join(repo, "README.md"), "# synthetic codex workbench repo\n");
	execFileSync("git", ["add", "README.md"], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
	writeFileSync(join(repo, "README.md"), "# synthetic codex workbench repo\nmodified line\n");
	return repo;
}

afterEach(async () => {
	while (cleanups.length > 0) {
		const fn = cleanups.pop()!;
		await fn();
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

async function createCodexBroker(
	options: {
		scenario?: string;
		approver?: CodexWorkbenchApproverV0;
		onNativeApprovalRequest?: CodexNativeApprovalHandlerV0;
		withGit?: boolean;
		now?: () => number;
		approvalWindowMs?: number;
	} = {},
) {
	const root = makeTempDir("endo-codex-wb-store-");
	const cwd = options.withGit ? makeGitRepo() : makeTempDir("endo-codex-wb-cwd-");
	const baseEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	const env = {
		...baseEnv,
		...(options.scenario === undefined ? {} : { FAKE_CODEX_SCENARIO: options.scenario }),
	};
	const check = await runCodexLocalProtocolCheckV0({
		root,
		attachment: "codex.wb",
		executable: FAKE_CODEX,
		checkCwd: cwd,
		env: baseEnv,
	});
	const adapter = new CodexDevelopAdapterV0({
		root,
		attachmentId: "codex.wb",
		projectScope: cwd,
		executable: FAKE_CODEX,
		env,
		fingerprint: check.fingerprint,
		capabilityState: check.capabilityState,
		sandboxMode: "read-only",
		ephemeral: true,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.onNativeApprovalRequest === undefined
			? {}
			: { onNativeApprovalRequest: options.onNativeApprovalRequest }),
	});
	const broker = new CodexWorkbenchBrokerV0({
		adapter,
		approver:
			options.approver ??
			(async () => ({
				approved: true,
				mechanism: "terminal-phrase",
			})),
		...(options.withGit ? { project: new GitProjectInspectorV0({ cwd }) } : {}),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.approvalWindowMs === undefined ? {} : { approvalWindowMs: options.approvalWindowMs }),
	});
	await adapter.open();
	cleanups.push(async () => {
		await broker.dispose();
		await adapter.close();
	});
	return { root, cwd, adapter, broker };
}

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await pred()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error("timed out waiting for condition");
}

describe("CodexWorkbenchBrokerV0 — authority, privacy, wire validation, and negative controls", () => {
	it("redacts private fields when unpaired, validates through Studio wire gates, and enforces Strict-only mode", async () => {
		const { broker } = await createCodexBroker({ withGit: true });

		// Unpaired status is valid under Studio's closed wire gate and hides private coordinates/usage/approvals.
		const unp = await broker.handle({ method: "GET", route: ["status"], query: "", grant: null, body: undefined });
		expect(unp.status).toBe(200);
		const parsedUnp = readWorkbenchStatus(unp.body);
		expect(parsedUnp).not.toBeNull();
		expect(parsedUnp!.harness).toBe("codex");
		expect(parsedUnp!.paired).toBe(false);
		expect(parsedUnp!.mode).toEqual({ requested: "strict", effective: "strict", reason: null });
		expect(parsedUnp!.sessionControl.state).toBe("none");
		expect(parsedUnp!.codex!.threadId).toBeNull();
		expect(parsedUnp!.codex!.activeTurnId).toBeNull();
		expect(parsedUnp!.codex!.usage).toBeNull();
		expect(parsedUnp!.codex!.pendingNativeApprovals).toEqual([]);
		expect(parsedUnp!.offers.queue.offered).toBe(false);
		expect(parsedUnp!.offers.attempt.offered).toBe(false);

		// Unpaired private routes are all refused with 401 grant-required.
		for (const req of [
			{ method: "GET" as const, route: ["transcript"], query: "", grant: null, body: undefined },
			{ method: "GET" as const, route: ["project"], query: "", grant: null, body: undefined },
			{ method: "POST" as const, route: ["prompt", "propose"], query: "", grant: null, body: { message: "hi" } },
			{
				method: "POST" as const,
				route: ["intervention", "propose"],
				query: "",
				grant: null,
				body: { operation: "stop" },
			},
		]) {
			const res = await broker.handle(req);
			expect(res.status).toBe(401);
			expect(res.body).toEqual({ error: "grant-required" });
		}

		// Pair with terminal code.
		const { code } = broker.issuePairingCode();
		const pairedRes = await broker.handle({
			method: "POST",
			route: ["pair"],
			query: "",
			grant: null,
			body: { code },
		});
		expect(pairedRes.status).toBe(200);
		const grant = (pairedRes.body as { grant: string }).grant;

		// Replaying single-use pairing code fails.
		const replayPair = await broker.handle({
			method: "POST",
			route: ["pair"],
			query: "",
			grant: null,
			body: { code },
		});
		expect(replayPair.status).not.toBe(200);

		// Paired status exposes owned threadId, policy, and projects cleanly through presentLiveWorkbenchSession -> presentLiveCodex.
		const st = await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined });
		const parsedPaired = readWorkbenchStatus(st.body);
		expect(parsedPaired).not.toBeNull();
		expect(parsedPaired!.paired).toBe(true);
		expect(parsedPaired!.codex!.threadId).toBe("019a0000-0000-7000-8000-000000000010");
		expect(parsedPaired!.codex!.model).toBe("gpt-6.2-sol");
		expect(parsedPaired!.codex!.sandbox).toBe("readOnly");
		expect(parsedPaired!.codex!.approvalPolicy).toBe("on-request");
		expect(parsedPaired!.codex!.approvalsReviewer).toBe("user");

		const presented = presentLiveWorkbenchSession(parsedPaired, false);
		expect(presented.identity.source).toBe("codex-live");
		expect(presented.integration.label).toBe("Codex App Server");
		expect(presented.capabilities.control.queue.status).toBe("unsupported");
		expect(presented.capabilities.control.prompt.status).toBe("supported");

		// Strict-only: session-control/revoke returns 409 no-session-control; attempt/propose & queue return 409 not-offered.
		expect(
			(await broker.handle({ method: "POST", route: ["session-control", "revoke"], query: "", grant, body: {} }))
				.status,
		).toBe(409);
		expect(
			(
				await broker.handle({
					method: "POST",
					route: ["attempt", "propose"],
					query: "",
					grant,
					body: { attemptId: "endo.attempt.0123456789abcdef0123456789abcdef" },
				})
			).status,
		).toBe(409);
		expect(
			(
				await broker.handle({
					method: "POST",
					route: ["intervention", "propose"],
					query: "",
					grant,
					body: { operation: "queue", message: "later" },
				})
			).status,
		).toBe(409);

		// Browser cannot inject proofs or call non-existent native-approval routes.
		expect(
			(
				await broker.handle({
					method: "POST",
					route: ["prompt", "propose"],
					query: "",
					grant,
					body: { message: "hi", proof: { authorizationId: "fake" } },
				})
			).status,
		).toBe(400);
		expect(
			(
				await broker.handle({
					method: "POST",
					route: ["native-approval", "decide"],
					query: "",
					grant,
					body: { requestId: "srv-req-1", decision: "accept" },
				})
			).status,
		).toBe(404);

		// Paired Git project context works read-only.
		const proj = await broker.handle({ method: "GET", route: ["project"], query: "", grant, body: undefined });
		expect(proj.status).toBe(200);
		expect((proj.body as { repository: { label: string } }).repository.label).toBeTruthy();
	});

	it("enforces terminal approval, nonce idempotency, streaming partial->completed transcript without duplication, and zero private text in canonical store", async () => {
		let pendingApproval: {
			ctx: CodexWorkbenchApprovalContextV0;
			resolve: (v: { approved: true; mechanism: "terminal-phrase" } | { approved: false; reason: string }) => void;
		} | null = null;
		const { root, broker } = await createCodexBroker({
			scenario: "stream-slow-deltas",
			approver: (ctx, signal) =>
				new Promise((resolve) => {
					pendingApproval = { ctx, resolve };
					signal.addEventListener("abort", () => resolve({ approved: false, reason: "aborted" }), { once: true });
				}),
		});

		const { code } = broker.issuePairingCode();
		const grant = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } })).body as {
				grant: string;
			}
		).grant;

		const nonce = "nonce_0123456789abcdef";
		const p1 = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "PROMPT_PRIVATE_BROWSER_SECRET", nonce },
		});
		expect(p1.status).toBe(202);
		const proposalId = (p1.body as { proposalId: string }).proposalId;

		// Duplicate click with same nonce returns 200 with same proposal (no second approval!).
		const pDup = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "PROMPT_PRIVATE_BROWSER_SECRET", nonce },
		});
		expect(pDup.status).toBe(200);
		expect((pDup.body as { proposalId: string }).proposalId).toBe(proposalId);

		await waitUntil(() => pendingApproval !== null);
		expect(pendingApproval!.ctx.fullMessage).toBe("PROMPT_PRIVATE_BROWSER_SECRET");
		expect(pendingApproval!.ctx.requestedFrom).toBe("page");

		// Approve on controlling terminal.
		pendingApproval!.resolve({ approved: true, mechanism: "terminal-phrase" });
		await waitUntil(async () => {
			const res = await broker.handle({
				method: "GET",
				route: ["prompt", proposalId],
				query: "",
				grant,
				body: undefined,
			});
			return (res.body as { state: string }).state === "accepted";
		});

		// Wait until turn finishes and verify transcript passes strict browser wire gate with no duplicate messages!
		await waitUntil(async () => {
			const st = await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined });
			const parsed = readWorkbenchStatus(st.body);
			return parsed !== null && parsed.run === "idle" && parsed.codex!.usage?.total !== null;
		});

		const tr = await broker.handle({
			method: "GET",
			route: ["transcript"],
			query: "after=0",
			grant,
			body: undefined,
		});
		expect(tr.status).toBe(200);
		const parsedTr = readWorkbenchTranscript(tr.body);
		expect(parsedTr).not.toBeNull();
		expect(parsedTr!.open).toBeNull();

		const messages = parsedTr!.items.filter((i) => i.kind === "message");
		const assistantTextMsgs = messages.filter(
			(m) => m.role === "assistant" && m.parts.some((p) => p.kind === "text"),
		);
		const reasoningMsgs = messages.filter(
			(m) => m.role === "assistant" && m.parts.some((p) => p.kind === "reasoning"),
		);
		expect(assistantTextMsgs).toHaveLength(1);
		expect(assistantTextMsgs[0]!.parts[0]).toMatchObject({
			kind: "text",
			text: "Streaming reply part 1. Streaming reply part 2.",
		});
		expect(reasoningMsgs).toHaveLength(1);
		expect(reasoningMsgs[0]!.parts[0]).toMatchObject({
			kind: "reasoning",
			state: "supplied",
			provenance: "reasoning-summary",
			text: "Inspecting workspace and verifying tests.",
		});
		// Activity includes both commandExecution (tool) and fileChange (file-change with Edits count).
		expect(
			parsedTr!.items.some((i) => i.kind === "tool" && i.name === "commandExecution" && i.status === "completed"),
		).toBe(true);
		expect(parsedTr!.items.some((i) => i.kind === "file-change" && i.status === "completed")).toBe(true);

		// Usage preserves cached tokens and leaves costUsd null (never fabricated 0).
		const stFinal = readWorkbenchStatus(
			(await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined })).body,
		)!;
		expect(stFinal.codex!.usage!.total).toMatchObject({
			inputTokens: 210,
			cachedInputTokens: 64,
			outputTokens: 110,
			reasoningTokens: 35,
			totalTokens: 320,
			costUsd: null,
		});

		// Privacy boundary: canonical event log NEVER contains prompt/assistant/reasoning text.
		const eventLog = readFileSync(join(root, "events", "events.log"), "utf8");
		expect(eventLog).not.toContain("PROMPT_PRIVATE_BROWSER_SECRET");
		expect(eventLog).not.toContain("Streaming reply part 1");
		expect(eventLog).not.toContain("Inspecting workspace");
	});

	it("handles prompt withdrawal, re-pair revocation during approval, targeted stop, and stop while native approval is pending", async () => {
		let resolvePrompt: ((v: { approved: boolean; mechanism?: "terminal-phrase"; reason?: string }) => void) | null =
			null;
		let nativeSeen = false;
		const { broker } = await createCodexBroker({
			scenario: "native-approval-cmd",
			approver: (ctx, signal) =>
				new Promise((resolve) => {
					if (ctx.prompt.operation === "stop") {
						resolve({ approved: true, mechanism: "terminal-phrase" });
						return;
					}
					resolvePrompt = resolve as typeof resolvePrompt;
					signal.addEventListener("abort", () => resolve({ approved: false, reason: "aborted" }), { once: true });
				}),
			onNativeApprovalRequest: (_req, signal) =>
				new Promise((resolve) => {
					nativeSeen = true;
					signal.addEventListener("abort", () => resolve(null), { once: true });
				}),
		});

		const { code: c1 } = broker.issuePairingCode();
		const g1 = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code: c1 } }))
				.body as { grant: string }
		).grant;

		// Propose and withdraw before approval.
		const w = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant: g1,
			body: { message: "withdraw me" },
		});
		const wId = (w.body as { proposalId: string }).proposalId;
		const disc = await broker.handle({
			method: "POST",
			route: ["prompt", "discard"],
			query: "",
			grant: g1,
			body: { proposalId: wId },
		});
		expect(disc.status).toBe(200);
		expect((disc.body as { state: string; reason: string }).state).toBe("refused");

		// Propose, then re-pair with a second code -> old grant's pending prompt is aborted!
		const r = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant: g1,
			body: { message: "revoked mid approval" },
		});
		expect(r.status).toBe(202);
		await waitUntil(() => resolvePrompt !== null);
		const { code: c2 } = broker.issuePairingCode();
		const g2 = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code: c2 } }))
				.body as { grant: string }
		).grant;
		expect(
			(await broker.handle({ method: "GET", route: ["transcript"], query: "", grant: g1, body: undefined })).status,
		).toBe(401);

		// Start native-approval turn under g2, wait for pending native approval, then interrupt via targeted STOP!
		resolvePrompt = null;
		const p = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant: g2,
			body: { message: "trigger native approval" },
		});
		expect(p.status).toBe(202);
		await waitUntil(() => resolvePrompt !== null);
		resolvePrompt!({ approved: true, mechanism: "terminal-phrase" });
		await waitUntil(() => nativeSeen);

		// Paired status exposes read-only pending native approval; unpaired status hides it!
		const stPaired = readWorkbenchStatus(
			(await broker.handle({ method: "GET", route: ["status"], query: "", grant: g2, body: undefined })).body,
		)!;
		expect(stPaired.codex!.pendingNativeApprovals).toHaveLength(1);
		expect(stPaired.codex!.pendingNativeApprovals[0]!.approvalKind).toBe("command-execution");

		const stUnpaired = readWorkbenchStatus(
			(await broker.handle({ method: "GET", route: ["status"], query: "", grant: null, body: undefined })).body,
		)!;
		expect(stUnpaired.codex!.pendingNativeApprovals).toEqual([]);

		// Request targeted STOP while native approval is pending -> turn is interrupted and native approval is cancelled!
		const stopRes = await broker.handle({
			method: "POST",
			route: ["intervention", "propose"],
			query: "",
			grant: g2,
			body: { operation: "stop" },
		});
		expect(stopRes.status).toBe(202);
		const stopId = (stopRes.body as { proposalId: string }).proposalId;

		await waitUntil(async () => {
			const res = await broker.handle({
				method: "GET",
				route: ["intervention", stopId],
				query: "",
				grant: g2,
				body: undefined,
			});
			const v = res.body as { state: string; runEnded: string | null };
			return v.state === "accepted" && v.runEnded === "aborted";
		});

		const stAfter = readWorkbenchStatus(
			(await broker.handle({ method: "GET", route: ["status"], query: "", grant: g2, body: undefined })).body,
		)!;
		expect(stAfter.codex!.pendingNativeApprovals).toEqual([]);
		expect(stAfter.codex!.recentNativeApprovals.some((a) => a.resolution === "cancelled")).toBe(true);
	});

	it("clears transcript and revokes grant immediately on late unexpected MCP policy teardown", async () => {
		const { broker } = await createCodexBroker({ scenario: "late-unexpected-mcp-startup" });
		const { code } = broker.issuePairingCode();
		const grant = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } })).body as {
				grant: string;
			}
		).grant;

		await waitUntil(async () => {
			const st = readWorkbenchStatus(
				(await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined })).body,
			);
			return st !== null && st.connection === "disconnected";
		});

		expect(broker.transcript.cleared).toBe(true);
		const tr = await broker.handle({ method: "GET", route: ["transcript"], query: "", grant, body: undefined });
		expect(tr.status).toBe(401);
	});

	it("enforces HTTP server loopback/Origin/Host/Content-Type/size guards and keeps read-only endo studio mutation-free", async () => {
		const { root, broker } = await createCodexBroker();
		const launched = await launchEndoCockpitV0({ root, uiDirectory: UI_DIR, workbench: broker, start: "develop" });
		cleanups.push(() => launched.server.close());
		const base = launched.server.baseUrl;
		const origin = new URL(base).origin;

		// Valid GET status succeeds.
		const okStatus = await fetch(`${base}/api/v0/workbench/status`);
		expect(okStatus.status).toBe(200);
		expect(readWorkbenchStatus(await okStatus.json())?.harness).toBe("codex");

		// Foreign Origin on POST is rejected.
		const foreignOrigin = await fetch(`${base}/api/v0/workbench/pair`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body: JSON.stringify({ code: "abc" }),
		});
		expect(foreignOrigin.status).toBe(403);

		// Missing Origin on POST is rejected.
		const noOrigin = await fetch(`${base}/api/v0/workbench/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: "abc" }),
		});
		expect(noOrigin.status).toBe(403);

		// Non-JSON Content-Type on POST is rejected.
		const badType = await fetch(`${base}/api/v0/workbench/pair`, {
			method: "POST",
			headers: { "content-type": "text/plain", origin },
			body: "{}",
		});
		expect([400, 415]).toContain(badType.status);

		// Oversized body (> 40 KiB) is rejected.
		const huge = await fetch(`${base}/api/v0/workbench/pair`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({ code: "x".repeat(45 * 1024) }),
		});
		expect([400, 413]).toContain(huge.status);

		// Cross-site Fetch Metadata is rejected.
		const crossSite = await fetch(`${base}/api/v0/workbench/status`, {
			headers: { "sec-fetch-site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);

		// Read-only `endo studio` (no workbench) rejects all workbench mutations.
		const ro = await launchEndoCockpitV0({ root, uiDirectory: UI_DIR });
		cleanups.push(() => ro.server.close());
		const roOrigin = new URL(ro.server.baseUrl).origin;
		const roMut = await fetch(`${ro.server.baseUrl}/api/v0/workbench/prompt/propose`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: roOrigin },
			body: JSON.stringify({ message: "hi" }),
		});
		expect([404, 405]).toContain(roMut.status);
	});

	it("preserves redacted reasoning, raw vs summary provenance, missing usage=null, and transcript eviction bounds", async () => {
		const { broker } = await createCodexBroker({ scenario: "redacted-reasoning,missing-usage" });
		const { code } = broker.issuePairingCode();
		const grant = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } })).body as {
				grant: string;
			}
		).grant;

		const p = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "test redacted" },
		});
		expect(p.status).toBe(202);
		await waitUntil(async () => {
			const st = readWorkbenchStatus(
				(await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined })).body,
			);
			return st !== null && st.run === "idle" && st.transcript.watermark >= 4;
		});

		const tr = readWorkbenchTranscript(
			(await broker.handle({ method: "GET", route: ["transcript"], query: "after=0", grant, body: undefined })).body,
		)!;
		const redacted = tr.items.find(
			(i) => i.kind === "message" && i.parts.some((part) => part.kind === "reasoning" && part.state === "withheld"),
		);
		expect(redacted).toBeDefined();

		const st = readWorkbenchStatus(
			(await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined })).body,
		)!;
		expect(st.codex!.usage!.total).toBeNull();
		expect(st.codex!.usage!.last).toBeNull();

		// Eviction bounds on CodexLiveTranscriptV0.
		const bounded = new CodexLiveTranscriptV0();
		for (let i = 0; i < LIVE_TRANSCRIPT_MAX_ITEMS_V0 + 15; i += 1) {
			bounded.pushObservation({
				schemaVersion: "endo.develop-adapter-observation.v0",
				observationId: `obs-${i}`,
				source: "codex-live",
				sessionKey: "codex-live:persistent:s1",
				attachmentId: "codex.test",
				instanceId: "inst-1",
				sequence: i + 1,
				observedAt: new Date().toISOString(),
				basis: "runtime-reported",
				nativeIds: { sessionId: "t1", turnId: "turn1", itemId: `i-${i}`, entryId: null },
				body: {
					kind: "transcript",
					role: "assistant",
					contentKind: "text",
					reasoningKind: null,
					text: `msg-${i}`,
					truncated: false,
					stopReason: null,
				},
			});
		}
		expect(bounded.size.items).toBe(LIVE_TRANSCRIPT_MAX_ITEMS_V0);
		expect(bounded.size.bytes).toBeLessThanOrEqual(LIVE_TRANSCRIPT_MAX_BYTES_V0);
		expect(bounded.recount()).toBe(bounded.size.bytes);
		expect(bounded.view(0).evicted).toBe(15);
	});

	it("enforces Pi/Codex shared writer-lock mutual exclusion and CLI Strict-only / TTY / flag rejections", async () => {
		const root = makeTempDir("endo-codex-lock-");
		const cwd = makeTempDir("endo-codex-lock-cwd-");
		const check = await runCodexLocalProtocolCheckV0({
			root,
			attachment: "codex.lock",
			executable: FAKE_CODEX,
			checkCwd: cwd,
		});
		const releasePiLock = acquireEndoEventStoreWriterLockV0(root, "pi.default");
		cleanups.push(() => releasePiLock());

		const adapter = new CodexDevelopAdapterV0({
			root,
			attachmentId: "codex.lock",
			projectScope: cwd,
			executable: FAKE_CODEX,
			fingerprint: check.fingerprint,
			capabilityState: check.capabilityState,
		});
		await expect(adapter.open()).rejects.toThrow(/already attached|lock/i);

		// CLI negative controls (no TTY, Everyday/Protected rejected for Codex, Pi-only flags rejected, unknown harness rejected).
		await expect(developCommand(["--harness", "unknown"])).rejects.toThrow(/unknown --harness/);
		await expect(developCommand(["--harness", "codex", "--mode", "everyday", "--cwd", cwd])).rejects.toThrow(
			/Strict-only/,
		);
		await expect(developCommand(["--harness", "codex", "--mode", "protected", "--cwd", cwd])).rejects.toThrow(
			/Strict-only/,
		);
		await expect(developCommand(["--harness", "codex", "--pi", "/bin/pi", "--cwd", cwd])).rejects.toThrow(
			/not supported/,
		);
		await expect(codexSessionCommand([root, "--cwd", cwd, "--workbench"])).rejects.toThrow(/terminal/);
	});

	it("records resolved native approval decisions cleanly when accepted once on terminal", async () => {
		const { broker } = await createCodexBroker({
			scenario: "native-approval-cmd",
			onNativeApprovalRequest: async (request) =>
				buildCodexNativeApprovalDecisionV0({ request, decision: "accept" }),
		});
		const { code } = broker.issuePairingCode();
		const grant = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } })).body as {
				grant: string;
			}
		).grant;
		const p = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "run cmd" },
		});
		expect(p.status).toBe(202);
		await waitUntil(async () => {
			const st = readWorkbenchStatus(
				(await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined })).body,
			);
			return st !== null && st.run === "idle" && st.codex!.recentNativeApprovals.length > 0;
		});
		const st = readWorkbenchStatus(
			(await broker.handle({ method: "GET", route: ["status"], query: "", grant, body: undefined })).body,
		)!;
		expect(st.codex!.recentNativeApprovals[0]!.resolution).toBe("accepted");
	});

	it("handles rapid withdraw+re-propose without context misbinding, aborts awaiting stop on turn end, rejects bare CR, and clears adapter live transcript on disconnect", async () => {
		let pendingForId: string | null = null;
		let pendingResolve:
			| ((v: { approved: true; mechanism: "terminal-phrase" } | { approved: false; reason: string }) => void)
			| null = null;
		const { adapter, broker } = await createCodexBroker({
			approver: (ctx, signal) => {
				return new Promise((resolve) => {
					pendingForId = ctx.proposalId;
					pendingResolve = resolve;
					signal.addEventListener("abort", () => resolve({ approved: false, reason: "aborted" }), { once: true });
				});
			},
		});
		const { code } = broker.issuePairingCode();
		const grant = (
			(await broker.handle({ method: "POST", route: ["pair"], query: "", grant: null, body: { code } })).body as {
				grant: string;
			}
		).grant;

		// Bare CR is rejected (matches Pi safe-prompt check).
		expect(
			(
				await broker.handle({
					method: "POST",
					route: ["prompt", "propose"],
					query: "",
					grant,
					body: { message: "line1\rline2" },
				})
			).status,
		).toBe(400);

		// Rapid withdraw + identical-message re-propose must bind to the second record cleanly.
		const first = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "same prompt text" },
		});
		const firstId = (first.body as { proposalId: string }).proposalId;
		await broker.handle({
			method: "POST",
			route: ["prompt", "discard"],
			query: "",
			grant,
			body: { proposalId: firstId },
		});

		const second = await broker.handle({
			method: "POST",
			route: ["prompt", "propose"],
			query: "",
			grant,
			body: { message: "same prompt text" },
		});
		expect(second.status).toBe(202);
		const secondId = (second.body as { proposalId: string }).proposalId;
		await waitUntil(() => pendingForId === secondId && pendingResolve !== null);
		pendingResolve!({ approved: true, mechanism: "terminal-phrase" });
		await waitUntil(async () => {
			const res = await broker.handle({
				method: "GET",
				route: ["prompt", secondId],
				query: "",
				grant,
				body: undefined,
			});
			return (res.body as { state: string }).state === "accepted";
		});

		// Wait for turn completion so adapter liveView has transcript, then disconnect -> adapter liveView transcript is cleared!
		await waitUntil(() => adapter.activeTurnId === null && adapter.liveView().transcript.length > 0);
		adapter.markDisconnected("test disconnect");
		expect(adapter.liveView().transcript).toEqual([]);
	});
});
