// EVOLVE-INSPECT-001: Real-browser acceptance tests for Evolve's read-only Protected Experiment Inspector.
// Headless Chromium (GPU off), production server, built Studio UI, synthetic fixtures only.
// Optionally writes review screenshots when ENDO_SHOTS_DIR is set.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ProtectedExperimentObserverV0 } from "../adapters/protected-experiment/observer.ts";
import { reportProtectedExperimentV0 } from "../adapters/sandbox/protected-report.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { ingestAll, lifecycleEvents, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import {
	createModelConnectedRunV1,
	createOfflineRichRunV0,
	createStagedRunV2,
	SECRET_HOST_AGENT_DIR,
	SECRET_HOST_EVALUATOR_FILE,
} from "./evolve-protected-fixtures.ts";

const executable = findBrowser();
const required = process.env.ENDO_REQUIRE_BROWSER === "1";
const shotsDir = process.env.ENDO_SHOTS_DIR ?? "";
const scratch = mkdtempSync(join(tmpdir(), "endo-evolve-browser-"));

let browser: Browser | null = null;
let ui: Record<string, Uint8Array> = {};
const tabs: Page[] = [];

beforeAll(async () => {
	if (executable === null && required)
		throw new Error("ENDO_REQUIRE_BROWSER=1 but no Chromium was found (set CHROME_BIN)");
	const { ensureSharedStudioUiDir } = await import("./helpers/studio-ui-build.ts");
	ui = loadEndoStudioUiFilesV0(await ensureSharedStudioUiDir());
	if (executable !== null) browser = await Browser.launch(executable);
	if (shotsDir !== "") mkdirSync(shotsDir, { recursive: true });
}, 90_000);

afterEach(async () => {
	await Promise.all(tabs.splice(0).map((p) => p.close()));
	await stopServers();
});

afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});

const suite = executable === null ? describe.skip : describe;

async function openPage(url: string, width = 1440, height = 900): Promise<Page> {
	const page = await browser!.open(width, height);
	tabs.push(page);
	await page.goto(url);
	await page.settled();
	return page;
}

function makePopulatedStore(): string {
	const root = tempRoot("endo-evolve-ui-store-");
	ingestAll(root, lifecycleEvents("completes"));
	return root;
}

suite("EVOLVE-INSPECT-001: Studio Evolve Protected Experiment Inspector in a real browser", () => {
	it("shows an explicit unconfigured notice when --protected-runs is omitted, and reads nothing until Evolve is opened", async () => {
		const store = makePopulatedStore();
		const server = await serve(store, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await openPage(`${server.baseUrl}/`);

		// Initial Observe load must not fetch Evolve routes
		expect(page.seen.requests.some((u) => u.includes("/api/v0/evolve/"))).toBe(false);

		await page.click("button[data-workspace=evolve]");
		await page.waitFor("document.querySelector('[data-testid=ev-unconfigured]')", 5000);

		const unconfText = await page.text("[data-testid=ev-unconfigured]");
		expect(unconfText).toContain("No protected-experiment source is configured");
		expect(unconfText).toContain("--protected-runs");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=ev-run-item]').length")).toBe(0);
		expect(page.seen.problems).toEqual([]);
	});

	it("renders explicit empty-collection state and skipped symlink notice when configured directory has no runs", async () => {
		const store = makePopulatedStore();
		const emptyDir = join(scratch, "empty-runs");
		const outside = join(scratch, "outside-dir");
		mkdirSync(emptyDir, { recursive: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(emptyDir, "link-run"));

		const observer = new ProtectedExperimentObserverV0({ root: emptyDir, key: OTHER_KEY });
		const server = await serve(store, { ui, protectedRuns: observer, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await openPage(`${server.baseUrl}/`);

		await page.click("button[data-workspace=evolve]");
		await page.waitFor("document.querySelector('[data-testid=ev-empty]')", 5000);
		expect(await page.text("[data-testid=ev-empty]")).toContain("No protected runs found");
		expect(await page.text("[data-testid=ev-skipped]")).toContain("1 symlink");
		expect(page.seen.problems).toEqual([]);
	});

	it("inspects offline v0, model-connected v1, staged v2, refused records, unsupported versions, explicit refresh, and workspace navigation", async () => {
		const store = makePopulatedStore();
		const collection = join(scratch, "multi-runs");
		const offlineDir = join(collection, "01-offline-rich");
		const modelDir = join(collection, "02-model-v1");
		const stagedDir = join(collection, "03-staged-v2");
		const unsupportedDir = join(collection, "04-unsupported-v99");

		createOfflineRichRunV0(offlineDir, "endo.experiment.offline-rich");
		createModelConnectedRunV1(modelDir, "endo.experiment.model-v1");
		createStagedRunV2(stagedDir, { id: "endo.experiment.staged-v2" });
		mkdirSync(unsupportedDir, { recursive: true });
		writeFileSync(
			join(unsupportedDir, "protected-run.json"),
			JSON.stringify({ schemaVersion: "endo.protected-run.v99" }),
		);

		const offlineReport = reportProtectedExperimentV0(offlineDir);
		const observer = new ProtectedExperimentObserverV0({ root: collection, key: OTHER_KEY });
		const server = await serve(store, { ui, protectedRuns: observer, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await openPage(`${server.baseUrl}/`);

		// Select an event in Observe first so we can verify switching back preserves Observe state
		await page.click("#timeline tr[data-seq='2'] button.seq");
		expect(await page.text("#inspector")).toContain("Event at position 2");

		// Open Evolve
		await page.click("button[data-workspace=evolve]");
		await page.waitFor("document.querySelector('[data-testid=ev-cells-table]')", 5000);

		// 3 readable runs + 1 unsupported-version run visibly listed
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=ev-run-item]').length")).toBe(3);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=ev-run-unusable]').length")).toBe(1);
		expect(await page.text("[data-testid=ev-run-unusable]")).toContain("unsupported-version");

		// First readable run (01-offline-rich) is auto-selected
		const detailText = await page.text("[data-testid=ev-detail]");
		expect(detailText).toContain("endo.experiment.offline-rich");
		expect(detailText).toContain("candidate passed; agent timed out afterward");
		expect(detailText).toContain("Verified passed");
		expect(detailText).toContain("Verified failed");
		expect(detailText).toContain("Not attempted");
		expect(detailText).toContain("Refused / invalid");
		expect(await page.text("[data-testid=ev-refused-records]")).toContain(
			`Refused or invalid records (${offlineReport.refusedRecords.length})`,
		);

		// Expand provenance details on a verified trial and a refused trial
		await page.eval(
			"(() => { for (const d of document.querySelectorAll('.ev-provenance-details')) d.open = true; })()",
		);
		expect(await page.text("[data-testid=ev-trials-table]")).toContain("UNAVAILABLE");
		expect(await page.text("[data-testid=ev-trials-table]")).toContain("retry of #1");

		// Zero host path or secret leakage anywhere in the rendered page
		const bodyText = await page.text("body");
		expect(bodyText).not.toContain(SECRET_HOST_AGENT_DIR);
		expect(bodyText).not.toContain(SECRET_HOST_EVALUATOR_FILE);
		expect(bodyText).not.toContain(collection);

		if (shotsDir !== "") {
			await page.eval(
				"(() => { const d = document.querySelectorAll('.ev-provenance-details'); d.forEach((el, i) => { el.open = i === 2; }); })()",
			);
			writeFileSync(join(shotsDir, "evolve-inspector-offline-1440.png"), await page.screenshot());
		}

		// Select second run (model-connected v1)
		await page.click("[data-testid=ev-run-item]:nth-of-type(2)");
		await page.waitFor(
			"document.querySelector('[data-testid=ev-detail]')?.textContent.includes('synthetic-local-model')",
			5000,
		);
		expect(await page.text("[data-testid=ev-detail]")).toContain("model-exchanges-below-minimum");

		// Select third run (staged-changeset v2)
		await page.click("[data-testid=ev-run-item]:nth-of-type(3)");
		await page.waitFor(
			"document.querySelector('[data-testid=ev-detail]')?.textContent.includes('endo.experiment.staged-v2')",
			5000,
		);
		await page.eval(
			"(() => { const d = document.querySelector('.ev-provenance-details'); if (d) d.open = true; })()",
		);
		expect(await page.text("[data-testid=ev-detail]")).toContain("Staged change set");
		expect(await page.text("[data-testid=ev-detail]")).toContain("Candidate verification");

		// Explicit refresh re-reads the list and current detail
		const beforeRefresh = page.seen.requests.filter((u) => u.includes("/api/v0/evolve/experiments")).length;
		await page.click("[data-testid=ev-refresh]");
		await page.waitFor("!document.querySelector('[data-testid=ev-refresh]').disabled", 5000);
		const afterRefresh = page.seen.requests.filter((u) => u.includes("/api/v0/evolve/experiments")).length;
		expect(afterRefresh).toBeGreaterThan(beforeRefresh);

		// Navigate to a planned placeholder (lazy Unavailable) and back to Observe (state preserved)
		await page.click("button[data-workspace=research]");
		await page.waitFor("document.querySelector('[data-testid=unavailable-research]')", 5000);
		await page.click("button[data-workspace=observe]");
		expect(await page.text("#inspector")).toContain("Event at position 2");

		// Every request stayed on loopback origin and zero CSP / console / runtime problems occurred
		for (const url of page.seen.requests) expect(url.startsWith(`${server.origin}/`), url).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});
});
