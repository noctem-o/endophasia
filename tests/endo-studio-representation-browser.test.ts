// Representation Explorer real-browser tests (OBSERVE-GEOMETRY-001):
// Headless Chromium (GPU off), production server, built Studio UI.
// Exercises: (1) real offline SmolLM2-135M-Instruct capture, (2) capability-restricted synthetic test fixture &
// reference-replay comparison artifact, and (3) absent representations directory.
// Optionally writes review screenshots when ENDO_SHOTS_DIR is set.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObserveRepresentationObserverV0 } from "../adapters/observe-representation/observer.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import {
	ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
	type EndoObserveRepresentationCaptureV0,
} from "../protocol/observe-representation.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { ingestAll, lifecycleEvents, removeTempRoots, seedRegistry, tempRoot } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const executable = findBrowser();
const required = process.env.ENDO_REQUIRE_BROWSER === "1";
const shotsDir = process.env.ENDO_SHOTS_DIR ?? "";
const scratch = mkdtempSync(join(tmpdir(), "endo-rep-browser-"));

let browser: Browser | null = null;
let ui: Record<string, Uint8Array> = {};
const tabs: Page[] = [];

beforeAll(async () => {
	if (executable === null && required)
		throw new Error("ENDO_REQUIRE_BROWSER=1 but no Chromium was found (set CHROME_BIN)");
	const dist = join(scratch, "ui");
	const { buildStudioUi } = (await import(join(repo, "scripts/build-studio-ui.mjs"))) as {
		buildStudioUi(outDir: string): Promise<{ outDir: string }>;
	};
	await buildStudioUi(dist);
	ui = loadEndoStudioUiFilesV0(dist);
	if (executable !== null) browser = await Browser.launch(executable);
	if (shotsDir !== "") mkdirSync(shotsDir, { recursive: true });
}, 90_000);

afterEach(async () => {
	await Promise.all(tabs.splice(0).map((tab) => tab.close()));
	await stopServers();
});

afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true }));
});

const suite = executable === null && !required ? describe.skip : describe;

function makeFixtureCaptures(dir: string): void {
	const restrictedFixture: EndoObserveRepresentationCaptureV0 = {
		schemaVersion: ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
		artifact: {
			artifactId: "synthetic-pooled-fixture-v0",
			capturedAt: "2026-11-20T00:00:00Z",
			promptId: null,
			sequenceLength: null,
		},
		subject: {
			executionRole: "test-fixture",
			replayOf: null,
			fixtureNotice: "Synthetic vectors for UI verification only; never recorded model activations.",
			model: {
				family: "synthetic",
				modelId: "fixture/pooled-summary",
				revision: null,
				weightDigestSha256: null,
				weightDtype: "float32",
				quantization: null,
			},
			backend: {
				framework: "synthetic-fixture",
				frameworkVersion: "0.0.0",
				driver: "browser-test",
				computeDtype: "float32",
				device: "cpu",
				attentionKernel: null,
			},
			weightProcessing: {
				mode: "not-applicable",
				foldLn: null,
				centerWritingWeights: null,
				centerUnembed: null,
				foldValueBiases: null,
			},
			captureLocation: {
				hookPoint: "pooled.event",
				tensorShape: [3, 4],
				dModel: 4,
				headSemantics: { queryHeads: null, kvHeads: null, layout: "unavailable" },
			},
		},
		backendCapabilities: {
			supportedHookPoints: ["pooled.event"],
			supportedHookPointsCount: 1,
			nonFireableHookPoints: ["blocks.0.attn.hook_pattern"],
			nonFireableHookPointsCount: 1,
			providesSequenceLogits: false,
			supportedFeatures: [],
			unavailableSignals: [
				{
					signal: "layer_activations",
					basis: "UNAVAILABLE",
					reason: "Serving backend does not expose per-layer hooks.",
				},
			],
		},
		dimensions: {
			layers: { supported: false, basis: "UNAVAILABLE", reason: "Layer dimension not exposed by this backend." },
			tokens: { supported: false, basis: "UNAVAILABLE", reason: "Per-token dimension not exposed by this backend." },
		},
		points: [
			{
				pointId: "ev-0",
				sourceIndex: 0,
				layer: null,
				tokenIndex: null,
				tokenId: null,
				tokenText: null,
				eventRef: "endo.event.10",
				hookPoint: "pooled.event",
				vector: [2, 1, 0, 0],
				topNextToken: null,
			},
			{
				pointId: "ev-1",
				sourceIndex: 1,
				layer: null,
				tokenIndex: null,
				tokenId: null,
				tokenText: null,
				eventRef: "endo.event.11",
				hookPoint: "pooled.event",
				vector: [-2, 1, 0.5, 0],
				topNextToken: null,
			},
			{
				pointId: "ev-2",
				sourceIndex: 2,
				layer: null,
				tokenIndex: null,
				tokenId: null,
				tokenText: null,
				eventRef: "endo.event.12",
				hookPoint: "pooled.event",
				vector: [0, -2, -0.5, 0],
				topNextToken: null,
			},
		],
		interpretations: [],
	};

	const replayArtifact: EndoObserveRepresentationCaptureV0 = {
		...restrictedFixture,
		artifact: {
			artifactId: "reference-replay-demo-v0",
			capturedAt: "2026-11-20T00:05:00Z",
			promptId: "replay-check",
			sequenceLength: 3,
		},
		subject: {
			...restrictedFixture.subject,
			executionRole: "reference-replay",
			fixtureNotice: null,
			replayOf: {
				primaryArtifactId: "llama-cpp-live-run-001",
				note: "Teacher-forced HF reference replay of recorded llama.cpp token IDs; comparison evidence only.",
			},
			model: {
				...restrictedFixture.subject.model,
				family: "llama",
				modelId: "HuggingFaceTB/SmolLM2-135M-Instruct",
			},
		},
	};

	writeFileSync(join(dir, "01-fixture.json"), JSON.stringify(restrictedFixture));
	writeFileSync(join(dir, "02-replay.json"), JSON.stringify(replayArtifact));
}

suite("Representation Explorer in headless Chromium", () => {
	it("inspects the real SmolLM2-135M-Instruct capture with layer switching, point selection, keyboard controls, and zero policy violations", async () => {
		const root = tempRoot();
		ingestAll(root, lifecycleEvents("completes"));
		seedRegistry(root);
		const observer = new ObserveRepresentationObserverV0({
			root: join(repo, "research/observe-geometry/examples"),
			key: OTHER_KEY,
		});
		const server = await serve(root, { ui, representations: observer, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await browser!.open(1440, 900);
		tabs.push(page);

		await page.goto(`${server.baseUrl}/`);
		await page.settled();

		// Opening Observe Timeline makes ONLY the single snapshot read — zero representation fetches until clicked.
		const initialApiCalls = page.seen.requests.filter((u) => u.includes("/api/"));
		expect(initialApiCalls.length).toBe(1);
		expect(initialApiCalls[0]).toContain("/api/v0/snapshot");

		// Switch into Representation Explorer inside Observe.
		await page.click("[data-testid=observe-tab-representations]");
		await page.waitFor("document.querySelector('[data-testid=rep-plot-svg]') !== null", 15_000);

		expect(await page.text("[data-testid=rep-execution-role]")).toContain("OBSERVED");
		expect(await page.text("[data-testid=rep-subject-strip]")).toContain("HuggingFaceTB/SmolLM2-135M-Instruct");
		expect(await page.text("[data-testid=rep-subject-strip]")).toContain("9Q/3KV");
		expect(await page.text("[data-testid=rep-subject-strip]")).toContain("raw-hf");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-plot-svg] .rep-point').length")).toBe(
			17,
		);

		// Select a point by clicking it in the SVG plot and verify OBSERVED / DERIVED / INTERPRETED / artifact provenance.
		await page.eval(
			`document.querySelector("[data-point-id='L29.T5']").dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
		);
		await page.waitFor("document.querySelector('[data-testid=rep-point-inspector]') !== null", 5_000);
		const inspectorText = await page.text("[data-testid=rep-point-inspector]");
		expect(inspectorText).toContain("L29.T5");
		expect(inspectorText).toContain("OBSERVED");
		expect(inspectorText).toContain("DERIVED");
		expect(inspectorText).toContain("INTERPRETED");
		expect(inspectorText).toContain("None recorded");
		expect(inspectorText).toContain("smollm2-135m-resid-post-v0");

		if (shotsDir !== "") {
			await new Promise((r) => setTimeout(r, 200));
			writeFileSync(join(shotsDir, "observe-representation-explorer-1440.png"), await page.screenshot());
		}

		// Keyboard navigation and zoom controls.
		await page.eval(`(() => {
			const svg = document.querySelector("[data-testid=rep-plot-svg]");
			svg.focus();
			svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		})()`);
		expect(await page.text("[data-testid=rep-point-inspector]")).toContain("L29.T6");

		await page.click("[data-testid=rep-zoom-in]");
		expect(await page.text("[data-testid=rep-zoom-level]")).toBe("125%");
		await page.click("[data-testid=rep-zoom-reset]");
		expect(await page.text("[data-testid=rep-zoom-level]")).toBe("100%");

		// Switch layer to Layer 0 and verify deterministic re-projection.
		await page.eval(`(() => {
			const sel = document.querySelector("[data-testid=rep-layer-select]");
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, "0");
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		})()`);
		await page.waitFor("document.querySelector('[data-point-id=\"L0.T0\"]') !== null", 10_000);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-plot-svg] .rep-point').length")).toBe(
			17,
		);

		// Sequence path is OFF by default, and renders only when explicitly toggled ON.
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-seq-path]').length")).toBe(0);
		await page.click("[data-testid=rep-sequence-toggle]");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-seq-path] line').length")).toBe(16);

		// Zero console errors, page errors, CSP violations, or foreign requests.
		expect(page.seen.problems).toEqual([]);
		expect(page.seen.requests.every((u) => u.startsWith(server.origin))).toBe(true);
	}, 60_000);

	it("omits unsupported layer/token controls on restricted fixtures and distinguishes test-fixture vs reference-replay", async () => {
		const fixtureDir = mkdtempSync(join(scratch, "restricted-"));
		makeFixtureCaptures(fixtureDir);
		const observer = new ObserveRepresentationObserverV0({ root: fixtureDir, key: OTHER_KEY });
		const server = await serve(tempRoot(), { ui, representations: observer, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await browser!.open(1280, 860);
		tabs.push(page);

		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("[data-testid=observe-tab-representations]");
		await page.waitFor("document.querySelector('[data-testid=rep-plot-svg]') !== null", 15_000);

		// Synthetic fixture warning banner is prominent, and layer/token controls are NOT rendered.
		expect(await page.text("[data-testid=rep-fixture-banner]")).toContain("Synthetic test fixture");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-layer-select]').length")).toBe(0);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-token-filter]').length")).toBe(0);
		expect(await page.text("[data-testid=rep-layer-unavailable]")).toContain("UNAVAILABLE");
		expect(await page.text("[data-testid=rep-token-unavailable]")).toContain("UNAVAILABLE");

		// Switch to the reference-replay artifact and verify its explicit comparison-evidence banner.
		await page.eval(`(() => {
			const sel = document.querySelector("[data-testid=rep-artifact-select]");
			const replayOpt = [...sel.options].find((o) => o.textContent.includes("REPLAY"));
			Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, replayOpt.value);
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		})()`);
		await page.waitFor("document.querySelector('[data-testid=rep-replay-banner]') !== null", 10_000);
		expect(await page.text("[data-testid=rep-replay-banner]")).toContain("Reference replay comparison evidence");
		expect(await page.text("[data-testid=rep-replay-banner]")).toContain("llama-cpp-live-run-001");
		expect(page.seen.problems).toEqual([]);
	}, 60_000);

	it("renders an honest UNAVAILABLE state when no representation directory is configured", async () => {
		const server = await serve(tempRoot(), { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await browser!.open(1280, 800);
		tabs.push(page);

		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("[data-testid=observe-tab-representations]");
		await page.waitFor("document.querySelector('[data-testid=rep-absent]') !== null", 15_000);

		expect(await page.text("[data-testid=rep-absent]")).toContain("UNAVAILABLE");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=rep-plot-svg]').length")).toBe(0);
		expect(page.seen.problems).toEqual([]);
	}, 60_000);
});
