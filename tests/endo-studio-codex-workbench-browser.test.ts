// End-to-end headless Chromium browser integration test for DEVELOP-CODEX-STUDIO-001.
// Drives the real built Studio UI (`dist/studio-ui`) against `launchEndoCockpitV0` + `CodexWorkbenchBrokerV0` +
// deterministic fake Codex App Server + synthetic Git repository.
//
// When `ENDO_CAPTURE_CODEX_SCREENSHOTS=<dir>` is set, also captures clean synthetic screenshots at representative
// desktop viewports (4K scaled & smaller desktop, Instrument + Field Storm) for visual audit.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCodexLocalProtocolCheckV0 } from "../adapters/codex/checks.ts";
import type { buildCodexNativeApprovalDecisionV0 } from "../adapters/codex/controller.ts";
import { CodexDevelopAdapterV0, type CodexNativeApprovalHandlerV0 } from "../adapters/codex/develop-adapter.ts";
import {
	type CodexWorkbenchApprovalContextV0,
	type CodexWorkbenchApproverV0,
	CodexWorkbenchBrokerV0,
} from "../adapters/codex/workbench.ts";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));
const uiScratch = mkdtempSync(join(tmpdir(), "endo-codex-browser-ui-"));
let UI_DIR = "";
const browserBin = findBrowser();
const captureDir = process.env.ENDO_CAPTURE_CODEX_SCREENSHOTS ?? null;

let browser: Browser | null = null;
const cleanups: Array<() => Promise<void> | void> = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeSyntheticGitRepo(): string {
	const repo = makeTempDir("endo-codex-browser-repo-");
	execFileSync("git", ["init", "-q", "-b", "feat/synthetic-demo"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "synthetic@example.invalid"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Synthetic Operator"], { cwd: repo });
	writeFileSync(
		join(repo, "app.ts"),
		'export function greet(name: string): string {\n\treturn "Hello, " + name;\n}\n',
	);
	execFileSync("git", ["add", "app.ts"], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "initial synthetic commit"], { cwd: repo });
	writeFileSync(
		join(repo, "app.ts"),
		'export function greet(name: string): string {\n\treturn "Hello from Endophasia, " + name;\n}\n',
	);
	return repo;
}

async function launchCodexStudio(
	options: {
		scenario?: string;
		approver?: CodexWorkbenchApproverV0;
		onNativeApprovalRequest?: CodexNativeApprovalHandlerV0;
	} = {},
) {
	const root = makeTempDir("endo-codex-browser-store-");
	const repo = makeSyntheticGitRepo();
	const check = await runCodexLocalProtocolCheckV0({
		root,
		attachment: "codex.studio",
		executable: FAKE_CODEX,
		checkCwd: repo,
	});
	const baseEnv = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	const adapter = new CodexDevelopAdapterV0({
		root,
		attachmentId: "codex.studio",
		projectScope: repo,
		executable: FAKE_CODEX,
		env: {
			...baseEnv,
			...(options.scenario === undefined ? {} : { FAKE_CODEX_SCENARIO: options.scenario }),
		},
		fingerprint: check.fingerprint,
		capabilityState: check.capabilityState,
		model: "gpt-6.2-sol",
		reasoningEffort: "low",
		sandboxMode: "read-only",
		ephemeral: true,
		...(options.onNativeApprovalRequest === undefined
			? {}
			: { onNativeApprovalRequest: options.onNativeApprovalRequest }),
	});
	const broker = new CodexWorkbenchBrokerV0({
		adapter,
		project: new GitProjectInspectorV0({ cwd: repo }),
		approver: options.approver ?? (async () => ({ approved: true, mechanism: "terminal-phrase" })),
	});
	await adapter.open();
	const launched = await launchEndoCockpitV0({ root, uiDirectory: UI_DIR, workbench: broker, start: "develop" });
	cleanups.push(async () => {
		await launched.server.close();
		await broker.dispose();
		await adapter.close();
	});
	return { root, repo, adapter, broker, url: `${launched.server.baseUrl}/` };
}

async function fillInput(page: Page, selector: string, value: string): Promise<void> {
	await page.eval(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) throw new Error("missing " + ${JSON.stringify(selector)});
		const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
		setter.call(el, ${JSON.stringify(value)});
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	})()`);
}

async function maybeShot(page: Page, name: string): Promise<void> {
	if (!captureDir) return;
	mkdirSync(captureDir, { recursive: true });
	const png = await page.screenshot();
	writeFileSync(join(captureDir, `${name}.png`), png);
}

beforeAll(async () => {
	if (browserBin === null) return;
	UI_DIR = join(uiScratch, "ui");
	const { buildStudioUi } = (await import(join(REPO_ROOT, "scripts/build-studio-ui.mjs"))) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(UI_DIR);
	browser = await Browser.launch(browserBin);
}, 90_000);

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()!();
	}
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

afterAll(async () => {
	await browser?.close();
	rmSync(uiScratch, { recursive: true, force: true });
});

describe.skipIf(browserBin === null)("Endophasia Studio DEVELOP Codex workbench (headless Chromium)", () => {
	it("drives full Codex workbench flow: pairing, approval, streaming, reasoning provenance, tool/file-change activity, usage, Git context, Instrument + Field Storm, reload, and unsupported controls", async () => {
		let pendingApproval: {
			ctx: CodexWorkbenchApprovalContextV0;
			resolve: (v: { approved: true; mechanism: "terminal-phrase" }) => void;
		} | null = null;
		const studio = await launchCodexStudio({
			scenario: "stream-slow-deltas",
			approver: (ctx, signal) =>
				new Promise((resolve) => {
					pendingApproval = {
						ctx,
						resolve: resolve as (v: { approved: true; mechanism: "terminal-phrase" }) => void,
					};
					signal.addEventListener("abort", () => resolve({ approved: false, reason: "aborted" }), { once: true });
				}),
		});

		const page = await browser!.open(1920, 1080);
		cleanups.push(() => page.close());
		await page.resize(1920, 1080, 2);
		await page.goto(studio.url);
		await page.waitFor('document.querySelector("[data-testid=live-row]")');

		// 1. Unpaired state: Codex identity visible, Strict mode shown, no private usage or approvals leaked.
		expect(await page.text("[data-testid=live-row]")).toContain("Codex");
		expect(await page.text("[data-testid=context-harness]")).toBe("Codex");
		expect(await page.text("[data-testid=context-model]")).toBe("gpt-6.2-sol");
		expect(await page.text("[data-testid=context-sandbox]")).toBe("readOnly");
		expect(await page.text("[data-testid=authority-mode]")).toContain("Strict");
		expect(await page.eval('document.querySelector("[data-testid=context-codex-usage]")')).toBeNull();
		await maybeShot(page, "01-unpaired-4k-instrument");

		// 2. Pair via UI pairing form (never keeping pairing code in DOM after submit!).
		const { code } = studio.broker.issuePairingCode();
		await fillInput(page, "[data-testid=pair-code]", code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor('document.querySelector("[data-testid=composer]")');
		await page.waitFor('document.querySelector("[data-testid=context-codex-usage]")');

		// 3. Request prompt -> awaiting terminal approval (ZERO browser approve button!).
		await fillInput(page, "[data-testid=composer]", "Review synthetic app.ts and summarize the change.");
		await page.click("[data-testid=send]");
		await page.waitFor(
			'document.querySelector("[data-testid=command-card]")?.getAttribute("data-state") === "awaiting-approval"',
		);
		const cardText = await page.text("[data-testid=command-card]");
		expect(cardText).toContain("Waiting for you to approve it in the attached terminal");
		expect(cardText).toContain("This page cannot approve it");
		await maybeShot(page, "02-awaiting-approval-4k-instrument");

		// Approve on controlling terminal -> observe streaming & final completed turn with zero duplication.
		await page.waitFor("true");
		expect(pendingApproval).not.toBeNull();
		pendingApproval!.resolve({ approved: true, mechanism: "terminal-phrase" });

		await page.waitFor(
			'Array.from(document.querySelectorAll("[data-testid=turn-assistant]")).some((el) => el.textContent?.includes("Streaming reply part 2."))',
		);
		await page.waitFor('document.querySelector("[data-testid=codex-usage]")');

		// Expand reasoning summary disclosure and verify honest provenance ("Reasoning summary", NOT "Raw reasoning").
		await page.waitFor('document.querySelector("[data-testid=reasoning-toggle]")');
		const reasoningHead = await page.text("[data-testid=reasoning-toggle]");
		expect(reasoningHead).toContain("Reasoning summary");
		expect(reasoningHead).not.toContain("Raw reasoning");
		await page.click("[data-testid=reasoning-toggle]");
		await page.waitFor(
			'document.querySelector("[data-testid=reasoning-text]")?.textContent?.includes("Inspecting workspace")',
		);

		// Verify zero duplicate assistant messages and tool + file-change rows present.
		const assistantCount = await page.eval<number>(
			'Array.from(document.querySelectorAll("[data-testid=turn-assistant]")).filter((el) => el.textContent.includes("Streaming reply part 1.")).length',
		);
		expect(assistantCount).toBe(1);
		expect(
			await page.eval<number>('document.querySelectorAll("[data-testid=tool-row]").length'),
		).toBeGreaterThanOrEqual(1);
		expect(
			await page.eval<number>('document.querySelectorAll("[data-testid=activity-row]").length'),
		).toBeGreaterThanOrEqual(1);

		// Verify token usage shows cached tokens and explicitly shows cost unavailable.
		const usageText = await page.text("[data-testid=codex-usage]");
		expect(usageText).toContain("210");
		expect(usageText).toContain("64");
		expect(usageText).toContain("unavailable");

		// Verify unsupported Queue control explains Codex limitation and stays disabled.
		await page.click("[data-testid=mode-queue]");
		expect(await page.text("[data-testid=composer-hint]")).toContain("Codex App Server exposes no Pi-equivalent");
		expect(await page.eval<boolean>('document.querySelector("[data-testid=send]").disabled')).toBe(true);
		await page.click("[data-testid=mode-prompt]");

		await maybeShot(page, "03-completed-turn-4k-instrument");

		// Switch to smaller desktop viewport (1280x800) and verify clean layout.
		await page.resize(1280, 800, 1);
		await maybeShot(page, "04-completed-turn-1280x800-instrument");

		// Switch to Field + Storm appearance and verify clean rendering without console/CSP errors.
		const fieldBtn = await page.eval<boolean>('Boolean(document.querySelector("[data-testid=appearance-field]"))');
		if (fieldBtn) {
			await page.click("[data-testid=appearance-field]");
			await page.waitFor(
				'document.querySelector("[data-testid=develop]")?.getAttribute("data-appearance") === "field"',
			);
			const switchedStorm = await page.eval<boolean>(`(() => {
				const sel = document.querySelector(".field-legend select");
				if (!sel) return false;
				sel.value = "storm";
				sel.dispatchEvent(new Event("change", { bubbles: true }));
				return true;
			})()`);
			if (switchedStorm) {
				await page.waitFor(
					'document.querySelector("[data-testid=develop]")?.getAttribute("data-atmosphere") === "storm"',
				);
			}
			await page.resize(1920, 1080, 2);
			await maybeShot(page, "05-completed-turn-4k-field-storm");
		}

		// Reload during active session clears in-memory grant cleanly (re-enters unpaired state).
		await page.goto(studio.url);
		await page.waitFor('document.querySelector("[data-testid=pair-code]")');
		expect(await page.eval('document.querySelector("[data-testid=composer]")')).toBeNull();

		expect(page.seen.problems).toEqual([]);
	}, 60_000);

	it("renders unmistakable read-only pending native approval banner, targeted turn/interrupt flow, XSS-safe text, and disconnect teardown", async () => {
		let resolveNative: ((d: ReturnType<typeof buildCodexNativeApprovalDecisionV0> | null) => void) | null = null;
		let resolveStop: ((v: { approved: true; mechanism: "terminal-phrase" }) => void) | null = null;
		const studio = await launchCodexStudio({
			scenario: "native-approval-cmd",
			approver: (ctx) => {
				if (ctx.prompt.operation === "stop") {
					return new Promise((resolve) => {
						resolveStop = resolve as (v: { approved: true; mechanism: "terminal-phrase" }) => void;
					});
				}
				return Promise.resolve({ approved: true, mechanism: "terminal-phrase" });
			},
			onNativeApprovalRequest: (_req, signal) =>
				new Promise((resolve) => {
					resolveNative = resolve;
					signal.addEventListener("abort", () => resolve(null), { once: true });
				}),
		});

		const page = await browser!.open(1920, 1080);
		cleanups.push(() => page.close());
		await page.resize(1920, 1080, 2);
		await page.goto(studio.url);
		await page.waitFor('document.querySelector("[data-testid=pair-code]")');

		const { code } = studio.broker.issuePairingCode();
		await fillInput(page, "[data-testid=pair-code]", code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor('document.querySelector("[data-testid=composer]")');

		// Propose prompt that triggers pending native approval.
		await fillInput(page, "[data-testid=composer]", "Run tests via command execution.");
		await page.click("[data-testid=send]");

		// Wait for unmistakable read-only native approval banner in browser.
		await page.waitFor('document.querySelector("[data-testid=codex-native-approvals]")');
		const banner = await page.text("[data-testid=codex-native-approvals]");
		expect(banner).toContain("native Codex approval waiting on the attached terminal");
		expect(banner).toContain("one-time only");
		expect(banner).toContain("cannot approve native Codex requests");
		// Assert ZERO buttons exist inside the read-only native approval banner!
		expect(
			await page.eval<number>('document.querySelectorAll("[data-testid=codex-native-approvals] button").length'),
		).toBe(0);
		await maybeShot(page, "06-pending-native-approval-4k");

		// Request targeted stop while native approval is pending.
		await page.waitFor(
			'document.querySelector("[data-testid=stop]") && !document.querySelector("[data-testid=stop]").disabled',
		);
		await page.click("[data-testid=stop]");
		await page.waitFor(
			'document.querySelector("[data-testid=stop-status]")?.getAttribute("data-state") === "awaiting-approval"',
		);
		expect(resolveStop).not.toBeNull();
		resolveStop!({ approved: true, mechanism: "terminal-phrase" });

		// Wait for interruption observed and native approval banner cleared.
		await page.waitFor('!document.querySelector("[data-testid=codex-native-approvals]")');
		await page.waitFor(
			'document.querySelector("[data-testid=intervention-card]")?.textContent?.includes("Codex acknowledged the targeted turn/interrupt request")',
		);
		await page.waitFor(
			'document.querySelector("[data-testid=run-ended]")?.textContent?.includes("interrupted, as Codex reported")',
		);
		await maybeShot(page, "07-interrupted-turn-4k");

		// Simulate disconnect between reads -> transcript cleared & disconnected message rendered honestly.
		await page.waitFor('!document.querySelector("#workbench-refresh")?.disabled');
		studio.adapter.markDisconnected("Simulated Codex transport disconnect.");
		await page.waitFor('document.querySelector("[data-testid=context-disconnected]")');
		expect(await page.text("[data-testid=context-disconnected]")).toContain("Simulated Codex transport disconnect");
		expect(await page.eval('document.querySelector("[data-testid=transcript]")')).toBeNull();
		await maybeShot(page, "08-disconnected-4k");

		expect(resolveNative).not.toBeNull();
		// A background project/transcript read racing with disconnect teardown may receive a legitimate 401 grant-required; no other console/CSP/JS error is permitted.
		expect(page.seen.problems.filter((p) => !/401/.test(p))).toEqual([]);
	}, 60_000);

	it("renders untrusted HTML and script payloads strictly as inert text with zero XSS execution", async () => {
		const studio = await launchCodexStudio({ scenario: "untrusted-html-reply" });
		const page = await browser!.open(1440, 900);
		cleanups.push(() => page.close());
		await page.goto(studio.url);
		await page.waitFor('document.querySelector("[data-testid=pair-code]")');

		const { code } = studio.broker.issuePairingCode();
		await fillInput(page, "[data-testid=pair-code]", code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor('document.querySelector("[data-testid=composer]")');

		await fillInput(page, "[data-testid=composer]", "Echo untrusted html.");
		await page.click("[data-testid=send]");
		await page.waitFor(
			'Array.from(document.querySelectorAll("[data-testid=turn-assistant]")).some((el) => el.textContent?.includes("<script>window.__xss=2</script>"))',
		);

		expect(await page.eval("window.__xss")).toBeUndefined();
		expect(
			await page.eval<number>(
				'document.querySelectorAll("[data-testid=transcript] img, [data-testid=transcript] script").length',
			),
		).toBe(0);
		expect(page.seen.problems).toEqual([]);
	}, 60_000);
});
