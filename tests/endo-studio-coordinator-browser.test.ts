import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endoStartOnDevelopV0 } from "../cockpit-http/host.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { Browser, findBrowser } from "./cockpit-browser.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { buildMissionBoardFixtureV0, cleanCoordinatorFixturesV0 } from "./coordinator-status-fixture.ts";
import { haveGit } from "./git-fixtures.ts";

const executable = findBrowser();
const requireBrowser = process.env.ENDO_REQUIRE_BROWSER === "1";
const board = "[data-testid=coordinator-workspace]";
const task = "[data-testid=coordinator-task]";
let browser: Browser | undefined;
let dist: string | undefined;
let ui: ReturnType<typeof endoStartOnDevelopV0>;

describe.skipIf(!haveGit || (executable === null && !requireBrowser))("Studio Coordinator Mission Board", () => {
	beforeAll(async () => {
		if (executable === null) throw new Error("ENDO_REQUIRE_BROWSER=1 but no Chromium was found");
		dist = mkdtempSync(join(tmpdir(), "endo-board-dist-"));
		const { buildStudioUi } = (await import(
			fileURLToPath(new URL("../scripts/build-studio-ui.mjs", import.meta.url))
		)) as {
			buildStudioUi(dir: string): Promise<void>;
		};
		await buildStudioUi(dist);
		ui = endoStartOnDevelopV0(loadEndoStudioUiFilesV0(dist));
		browser = await Browser.launch(executable);
	}, 90_000);

	afterAll(async () => {
		await browser?.close();
		await stopServers();
		cleanCoordinatorFixturesV0();
		if (dist !== undefined) rmSync(dist, { recursive: true, force: true });
	});

	it("renders projected evidence in both appearances, filters, and withdraws refused or malformed reads", async () => {
		const { root, repo, projectId, status } = await buildMissionBoardFixtureV0();
		const service = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root));
		const host = new EndoWorkspaceHostV0({
			open: (facts) => service.forLaunch({ projectId, launchDirectory: repo }, facts),
		});
		let reply: { status: number; body: unknown } = { status: 200, body: status };
		const server = await serve(root, {
			ui,
			workbench: {
				handle: (request) =>
					request.route.join("/") === "workspace/coordinator" ? Promise.resolve(reply) : host.handle(request),
			},
		});
		const page = await browser!.open(1440, 900);
		const withState = (state: string) => `document.querySelector('${board}[data-state=${state}]')`;
		await page.goto(`${server.baseUrl}/`);
		await page.waitFor("document.querySelector('[data-testid=pair-code]')");
		await page.click("[data-workspace=coordinator]");
		await page.waitFor(withState("unpaired"));
		await page.click("[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=pair-code]')");
		await page.eval(`(() => {
			const el = document.querySelector('[data-testid=pair-code]');
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(host.issuePairingCode().code)});
			el.dispatchEvent(new Event('input', { bubbles: true }));
		})()`);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("!document.querySelector('[data-testid=pair-code]')");
		await page.click("[data-workspace=coordinator]");
		await page.waitFor(withState("ready"));
		const text = await page.text(board);
		expect(text).toMatch(/Stream partial tokens/);
		expect(text).toMatch(/contradict/i);
		expect(text).toMatch(/1 with unknown task relationship/i);
		expect(text).toMatch(/board-stale/);
		expect(text).toMatch(/historical evidence, not a current failure/i);
		expect(text).toMatch(/surviving pass does not establish/i);
		expect(text).toMatch(/HEAD unavailable/i);
		expect(text).toContain("<img src=x onerror=window.boardInjected=true>");
		expect(await page.eval("window.boardInjected === undefined && !document.querySelector('img[src=x]')")).toBe(true);
		const failed = `${task}[data-phase=awaiting-review][data-verification=failing] summary`;
		await page.eval(`document.querySelector('${failed}').focus()`);
		await page.press("Enter");
		expect(await page.eval(`document.querySelector('${failed}').parentElement.open`)).toBe(true);
		for (const [appearance, width, height] of [
			["field", 1440, 900],
			["instrument", 1920, 1080],
			["instrument", 820, 900],
			["field", 390, 844],
		] as const) {
			await page.resize(width, height);
			await page.click(`[data-testid=appearance-${appearance}]`);
			await page.waitFor(`document.querySelector('${board}[data-appearance=${appearance}]')`);
			await page.eval("window.scrollTo({ top: 0, behavior: 'instant' })");
			expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
			const captureDir = process.env.ENDO_COORDINATOR_RENDERS;
			if (captureDir) {
				await page.eval("document.fonts.ready.then(() => true)");
				writeFileSync(join(captureDir, `${appearance}-${width}x${height}.png`), await page.screenshot());
			}
		}
		await page.click("button.coordinator-filter[data-phase=blocked]");
		expect(await page.eval(`document.querySelectorAll('${task}[data-phase=blocked]').length`)).toBe(1);
		expect(await page.eval(`document.querySelectorAll('${task}').length`)).toBe(1);
		await page.click("button.coordinator-filter[data-phase=all]");
		await page.click(".coordinator-project:last-child [data-testid=coordinator-project]");
		expect(await page.eval(`document.querySelectorAll('${task}').length`)).toBe(0);
		const refresh = "[data-testid=coordinator-refresh]";
		reply = { status: 200, body: { ...status, sessions: [{ recordedState: "running" }] } };
		await page.click(refresh);
		await page.waitFor(withState("invalid"));
		expect(await page.text(board)).not.toContain("Stream partial tokens");
		reply = { status: 403, body: { error: "forbidden" } };
		await page.click(refresh);
		await page.waitFor(withState("forbidden"));
		reply = { status: 401, body: { error: "grant-required" } };
		await page.click(refresh);
		await page.waitFor(withState("unpaired"));
		expect(await page.eval(`document.querySelectorAll('${task}').length`)).toBe(0);
	}, 90_000);
});
