// Frontend wire-gate and pure Representation Explorer view-model tests (OBSERVE-GEOMETRY-001).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectEndoObserveRepresentationSceneV0 } from "../cockpit/index.ts";
import {
	ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
	type EndoObserveRepresentationCaptureV0,
	validateEndoObserveRepresentationCaptureV0,
} from "../protocol/observe-representation.ts";
import {
	availableColorModes,
	buildRepresentationPlot,
	INITIAL_VIEWPORT,
	panViewport,
	stepPointSelection,
	zoomViewport,
} from "../studio-ui/src/model/representation.ts";
import { readRepresentationScene, readRepresentationsIndex } from "../studio-ui/src/model/representation-wire.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const SELECTOR = `r1-${"f".repeat(32)}`;
const SHA = "e".repeat(64);

function realCapture(): EndoObserveRepresentationCaptureV0 {
	return validateEndoObserveRepresentationCaptureV0(
		JSON.parse(readFileSync(join(repo, "research/observe-geometry/examples/smollm2-135m-resid-post.json"), "utf8")),
	);
}

function layerlessFixtureCapture(): EndoObserveRepresentationCaptureV0 {
	return {
		schemaVersion: ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
		artifact: {
			artifactId: "layerless-fixture-v0",
			capturedAt: null,
			promptId: null,
			sequenceLength: null,
		},
		subject: {
			executionRole: "test-fixture",
			replayOf: null,
			fixtureNotice: "Synthetic fixture without layer or token dimensions.",
			model: {
				family: "synthetic",
				modelId: "fixture/pooled-3d",
				revision: null,
				weightDigestSha256: null,
				weightDtype: "float32",
				quantization: null,
			},
			backend: {
				framework: "synthetic-fixture",
				frameworkVersion: "0.0.0",
				driver: "unit",
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
				tensorShape: [3, 3],
				dModel: 3,
				headSemantics: { queryHeads: null, kvHeads: null, layout: "unavailable" },
			},
		},
		backendCapabilities: {
			supportedHookPoints: ["pooled.event"],
			supportedHookPointsCount: 1,
			nonFireableHookPoints: [],
			nonFireableHookPointsCount: 0,
			providesSequenceLogits: null,
			supportedFeatures: [],
			unavailableSignals: [
				{ signal: "layer_traces", basis: "UNAVAILABLE", reason: "Backend exposes only pooled summaries." },
			],
		},
		dimensions: {
			layers: { supported: false, basis: "UNAVAILABLE", reason: "No layer dimension exposed." },
			tokens: { supported: false, basis: "UNAVAILABLE", reason: "No per-token dimension exposed." },
		},
		points: [
			{
				pointId: "ev.1",
				sourceIndex: 0,
				layer: null,
				tokenIndex: null,
				tokenId: null,
				tokenText: null,
				eventRef: "endo.event.1",
				hookPoint: "pooled.event",
				vector: [1, 0, 0],
				topNextToken: null,
			},
			{
				pointId: "ev.2",
				sourceIndex: 1,
				layer: null,
				tokenIndex: null,
				tokenId: null,
				tokenText: null,
				eventRef: "endo.event.2",
				hookPoint: "pooled.event",
				vector: [0, 2, 0],
				topNextToken: null,
			},
			{
				pointId: "ev.3",
				sourceIndex: 2,
				layer: null,
				tokenIndex: null,
				tokenId: null,
				tokenText: null,
				eventRef: "endo.event.3",
				hookPoint: "pooled.event",
				vector: [-1, -2, 0],
				topNextToken: null,
			},
		],
		interpretations: [],
	};
}

describe("representation wire gate", () => {
	it("accepts valid index and scene payloads and refuses tampered ones", () => {
		expect(readRepresentationsIndex({ schemaVersion: "endo.observe-representations.v0", available: false })).toEqual({
			available: false,
		});
		expect(
			readRepresentationsIndex({ schemaVersion: "endo.observe-representations.v9", available: false }),
		).toBeNull();

		const scene = projectEndoObserveRepresentationSceneV0({
			capture: realCapture(),
			selector: SELECTOR,
			artifactSha256: SHA,
			layer: 29,
		});
		expect(readRepresentationScene(scene)).toEqual(scene);

		// Extra field refused.
		expect(readRepresentationScene({ ...scene, fabricated: "concept" })).toBeNull();
		// Wrong projection version refused.
		expect(readRepresentationScene({ ...scene, projectionVersion: "9.9" })).toBeNull();
		// Missing fixtureNotice on test-fixture refused.
		const badFixture = structuredClone(scene);
		badFixture.subject.executionRole = "test-fixture";
		badFixture.subject.fixtureNotice = null;
		expect(readRepresentationScene(badFixture)).toBeNull();
	});
});

describe("representation plot view model", () => {
	it("restricts colour modes and sequence connectors to dimensions the artifact actually supports", () => {
		const realSingleLayer = projectEndoObserveRepresentationSceneV0({
			capture: realCapture(),
			selector: SELECTOR,
			artifactSha256: SHA,
			layer: 29,
		});
		expect(availableColorModes(realSingleLayer).map((m) => m.id)).toEqual(["basis", "l2-norm", "token-position"]);

		const realAllLayers = projectEndoObserveRepresentationSceneV0({
			capture: realCapture(),
			selector: SELECTOR,
			artifactSha256: SHA,
			layer: "all",
		});
		expect(availableColorModes(realAllLayers).map((m) => m.id)).toEqual([
			"basis",
			"l2-norm",
			"token-position",
			"layer",
		]);

		const layerless = projectEndoObserveRepresentationSceneV0({
			capture: layerlessFixtureCapture(),
			selector: SELECTOR,
			artifactSha256: SHA,
		});
		expect(availableColorModes(layerless).map((m) => m.id)).toEqual(["basis", "l2-norm"]);

		// Sequence path is OFF by default and absent when tokens are unsupported.
		const plotOff = buildRepresentationPlot(realSingleLayer, {
			colorMode: "basis",
			tokenQuery: "",
			selectedPointId: null,
			showSequencePath: false,
			viewport: INITIAL_VIEWPORT,
		});
		expect(plotOff.sequenceSegments).toEqual([]);

		const plotOn = buildRepresentationPlot(realSingleLayer, {
			colorMode: "token-position",
			tokenQuery: "",
			selectedPointId: null,
			showSequencePath: true,
			viewport: INITIAL_VIEWPORT,
		});
		expect(plotOn.sequenceSegments.length).toBe(16);

		const layerlessPlot = buildRepresentationPlot(layerless, {
			colorMode: "token-position",
			tokenQuery: "anything",
			selectedPointId: null,
			showSequencePath: true,
			viewport: INITIAL_VIEWPORT,
		});
		expect(layerlessPlot.activeColorMode).toBe("basis");
		expect(layerlessPlot.sequenceLabel).toBeNull();
		expect(layerlessPlot.sequenceSegments).toEqual([]);
	});

	it("keeps zoom/pan bounded and steps keyboard selection deterministically", () => {
		const scene = projectEndoObserveRepresentationSceneV0({
			capture: realCapture(),
			selector: SELECTOR,
			artifactSha256: SHA,
			layer: 29,
		});
		const plot = buildRepresentationPlot(scene, {
			colorMode: "l2-norm",
			tokenQuery: "",
			selectedPointId: null,
			showSequencePath: false,
			viewport: INITIAL_VIEWPORT,
		});
		const first = stepPointSelection(plot.points, null, "next");
		expect(first).toBe("L29.T0");
		expect(stepPointSelection(plot.points, first, "next")).toBe("L29.T1");
		expect(stepPointSelection(plot.points, first, "prev")).toBe("L29.T16");
		expect(stepPointSelection(plot.points, "L29.T5", "first")).toBe("L29.T0");
		expect(stepPointSelection(plot.points, "L29.T5", "last")).toBe("L29.T16");

		const zoomedIn = zoomViewport(INITIAL_VIEWPORT, 100);
		expect(zoomedIn.scale).toBe(16);
		const zoomedOut = zoomViewport(INITIAL_VIEWPORT, 0.01);
		expect(zoomedOut.scale).toBe(0.5);
		const panned = panViewport(zoomedIn, 40, -25);
		expect(panned.panX).toBe(40);
		expect(panned.panY).toBe(-25);
	});
});
