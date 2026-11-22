// Representation Explorer deterministic projection, validation, provenance and capability tests (OBSERVE-GEOMETRY-001).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalEndoJsonV0, computePca2dV0, projectEndoObserveRepresentationSceneV0 } from "../cockpit/index.ts";
import {
	ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
	type EndoObserveRepresentationCaptureV0,
	endoObserveRepresentationCaptureProblemV0,
	validateEndoObserveRepresentationCaptureV0,
	validateEndoObserveRepresentationSceneV0,
} from "../protocol/observe-representation.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const TEST_SELECTOR = `r1-${"a".repeat(32)}`;
const TEST_SHA = "b".repeat(64);

function syntheticFixtureCapture(
	overrides: Partial<EndoObserveRepresentationCaptureV0> = {},
): EndoObserveRepresentationCaptureV0 {
	return {
		schemaVersion: ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0,
		artifact: {
			artifactId: "synthetic-unit-fixture-v0",
			capturedAt: "2026-11-20T00:00:00Z",
			promptId: "unit-test",
			sequenceLength: 4,
		},
		subject: {
			executionRole: "test-fixture",
			replayOf: null,
			fixtureNotice:
				"Synthetic mathematical vectors generated solely for unit testing; not recorded model activations.",
			model: {
				family: "synthetic",
				modelId: "fixture/linear-plane-4d",
				revision: null,
				weightDigestSha256: null,
				weightDtype: "float32",
				quantization: null,
			},
			backend: {
				framework: "synthetic-fixture",
				frameworkVersion: "0.0.0",
				driver: "unit-test",
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
				hookPoint: "blocks.{layer}.hook_resid_post",
				tensorShape: [1, 4, 4],
				dModel: 4,
				headSemantics: {
					queryHeads: 8,
					kvHeads: 2,
					layout: "residual-stream",
				},
			},
		},
		backendCapabilities: {
			supportedHookPoints: ["blocks.0.hook_resid_post", "blocks.1.hook_resid_post"],
			supportedHookPointsCount: 2,
			nonFireableHookPoints: ["blocks.0.attn.hook_pattern"],
			nonFireableHookPointsCount: 1,
			providesSequenceLogits: false,
			supportedFeatures: ["parameters"],
			unavailableSignals: [
				{
					signal: "attention_patterns",
					basis: "UNAVAILABLE",
					reason: "Fused kernel does not expose attention weights.",
				},
			],
		},
		dimensions: {
			layers: { supported: true, availableLayers: [0, 1], defaultLayer: 0 },
			tokens: { supported: true, tokenCount: 4 },
		},
		points: [
			{
				pointId: "L0.T0",
				sourceIndex: 0,
				layer: 0,
				tokenIndex: 0,
				tokenId: 10,
				tokenText: "alpha",
				eventRef: null,
				hookPoint: "blocks.0.hook_resid_post",
				vector: [3, 1, 0, 0],
				topNextToken: null,
			},
			{
				pointId: "L0.T1",
				sourceIndex: 1,
				layer: 0,
				tokenIndex: 1,
				tokenId: 11,
				tokenText: "beta",
				eventRef: null,
				hookPoint: "blocks.0.hook_resid_post",
				vector: [-3, 1, 0, 0],
				topNextToken: null,
			},
			{
				pointId: "L0.T2",
				sourceIndex: 2,
				layer: 0,
				tokenIndex: 2,
				tokenId: 12,
				tokenText: "gamma",
				eventRef: null,
				hookPoint: "blocks.0.hook_resid_post",
				vector: [3, -1, 0, 0],
				topNextToken: null,
			},
			{
				pointId: "L0.T3",
				sourceIndex: 3,
				layer: 0,
				tokenIndex: 3,
				tokenId: 13,
				tokenText: "delta",
				eventRef: null,
				hookPoint: "blocks.0.hook_resid_post",
				vector: [-3, -1, 0, 0],
				topNextToken: null,
			},
			{
				pointId: "L1.T0",
				sourceIndex: 4,
				layer: 1,
				tokenIndex: 0,
				tokenId: 10,
				tokenText: "alpha",
				eventRef: null,
				hookPoint: "blocks.1.hook_resid_post",
				vector: [4, 2, 1, 0],
				topNextToken: null,
			},
			{
				pointId: "L1.T1",
				sourceIndex: 5,
				layer: 1,
				tokenIndex: 1,
				tokenId: 11,
				tokenText: "beta",
				eventRef: null,
				hookPoint: "blocks.1.hook_resid_post",
				vector: [-4, 2, -1, 0],
				topNextToken: null,
			},
			{
				pointId: "L1.T2",
				sourceIndex: 6,
				layer: 1,
				tokenIndex: 2,
				tokenId: 12,
				tokenText: "gamma",
				eventRef: null,
				hookPoint: "blocks.1.hook_resid_post",
				vector: [4, -2, -1, 0],
				topNextToken: null,
			},
			{
				pointId: "L1.T3",
				sourceIndex: 7,
				layer: 1,
				tokenIndex: 3,
				tokenId: 13,
				tokenText: "delta",
				eventRef: null,
				hookPoint: "blocks.1.hook_resid_post",
				vector: [-4, -2, 1, 0],
				topNextToken: null,
			},
		],
		interpretations: [],
		...overrides,
	};
}

describe("deterministic 2D PCA projection", () => {
	it("produces exact eigenvalues, coordinates, and zero 2D residual on a planar rectangle", () => {
		const res = computePca2dV0([
			[3, 1, 0, 0],
			[-3, 1, 0, 0],
			[3, -1, 0, 0],
			[-3, -1, 0, 0],
		]);
		expect(res.degenerate).toBe(false);
		expect(res.eigenvalues[0]).toBeCloseTo(9, 9);
		expect(res.eigenvalues[1]).toBeCloseTo(1, 9);
		expect(res.totalVariance).toBeCloseTo(10, 9);
		expect(res.explainedVarianceRatio[0]).toBeCloseTo(0.9, 9);
		expect(res.explainedVarianceRatio[1]).toBeCloseTo(0.1, 9);
		expect(res.varianceExplainedTotal).toBeCloseTo(1, 9);
		// Sign canonicalization ensures first largest-magnitude point is positive on each axis.
		expect(res.coords[0]![0]).toBeCloseTo(3, 9);
		expect(res.coords[0]![1]).toBeCloseTo(1, 9);
		for (const frac of res.residual2dFractions) expect(frac).toBeCloseTo(0, 9);
	});

	it("agrees between dual (N <= D) and primal (D < N) paths", () => {
		// 6 points in 3D (D < N -> primal) vs same 6 points zero-padded to 8D (N <= D -> dual).
		const base3d = [
			[4, 1, 0.5],
			[-4, 1, -0.5],
			[3, -2, 0.25],
			[-3, -2, -0.25],
			[1, 3, -0.5],
			[-1, -1, 0.5],
		];
		const padded8d = base3d.map((row) => [...row, 0, 0, 0, 0, 0]);
		const primal = computePca2dV0(base3d);
		const dual = computePca2dV0(padded8d);
		expect(primal.eigenvalues[0]).toBeCloseTo(dual.eigenvalues[0], 9);
		expect(primal.eigenvalues[1]).toBeCloseTo(dual.eigenvalues[1], 9);
		expect(primal.totalVariance).toBeCloseTo(dual.totalVariance, 9);
		for (let i = 0; i < base3d.length; i += 1) {
			expect(primal.coords[i]![0]).toBeCloseTo(dual.coords[i]![0], 9);
			expect(primal.coords[i]![1]).toBeCloseTo(dual.coords[i]![1], 9);
			expect(primal.residual2dFractions[i]!).toBeCloseTo(dual.residual2dFractions[i]!, 9);
		}
	});

	it("handles degenerate zero-variance, rank-1, and single-point inputs without NaN or Infinity", () => {
		const single = computePca2dV0([[1, 2, 3]]);
		expect(single.degenerate).toBe(true);
		expect(single.coords).toEqual([[0, 0]]);
		expect(single.explainedVarianceRatio).toEqual([null, null]);

		const identical = computePca2dV0([
			[5, -2, 1],
			[5, -2, 1],
			[5, -2, 1],
		]);
		expect(identical.degenerate).toBe(true);
		expect(identical.totalVariance).toBe(0);
		expect(identical.coords).toEqual([
			[0, 0],
			[0, 0],
			[0, 0],
		]);

		const collinear = computePca2dV0([
			[1, 2, 3],
			[2, 4, 6],
			[3, 6, 9],
		]);
		expect(collinear.degenerate).toBe(true);
		expect(collinear.explainedVarianceRatio[0]).toBeCloseTo(1, 9);
		expect(collinear.explainedVarianceRatio[1]).toBe(0);
		for (const [x, y] of collinear.coords) {
			expect(Number.isFinite(x)).toBe(true);
			expect(y).toBe(0);
		}
	});

	it("produces byte-identical canonical scenes on repeated projections", () => {
		const capture = syntheticFixtureCapture();
		const first = projectEndoObserveRepresentationSceneV0({
			capture,
			selector: TEST_SELECTOR,
			artifactSha256: TEST_SHA,
			layer: 1,
		});
		const second = projectEndoObserveRepresentationSceneV0({
			capture,
			selector: TEST_SELECTOR,
			artifactSha256: TEST_SHA,
			layer: 1,
		});
		expect(canonicalEndoJsonV0(first)).toBe(canonicalEndoJsonV0(second));
		expect(first.selectedLayer).toBe(1);
		expect(first.points.every((pt) => pt.layer === 1)).toBe(true);
		// Layer 1 has a non-zero 3rd coordinate, so residual2dFraction must be > 0 (honest 2D omission accounting).
		expect(first.points.every((pt) => (pt.derived.residual2dFraction ?? 0) > 0.01)).toBe(true);
	});

	it("preserves nonzero variance and exact geometry for small-magnitude vectors (scale invariance)", () => {
		const unit = computePca2dV0([
			[0, 0],
			[1, 0],
			[0, 1],
		]);
		const micro = computePca2dV0([
			[0, 0],
			[1e-6, 0],
			[0, 1e-6],
		]);
		expect(micro.degenerate).toBe(false);
		expect(micro.totalVariance).toBeCloseTo(4 / 9e12, 20);
		expect(micro.explainedVarianceRatio[0]!).toBeCloseTo(unit.explainedVarianceRatio[0]!, 9);
		expect(micro.explainedVarianceRatio[1]!).toBeCloseTo(unit.explainedVarianceRatio[1]!, 9);
		expect(micro.varianceExplainedTotal!).toBeCloseTo(1, 9);
		for (let i = 0; i < 3; i += 1) {
			expect(micro.coords[i]![0]).toBeCloseTo(unit.coords[i]![0] * 1e-6, 15);
			expect(micro.coords[i]![1]).toBeCloseTo(unit.coords[i]![1] * 1e-6, 15);
			expect(micro.residual2dFractions[i]!).toBeCloseTo(0, 9);
		}

		// Also verify through the full scene projector (including observed stats).
		const smallCapture = syntheticFixtureCapture({
			dimensions: {
				layers: { supported: false, basis: "UNAVAILABLE", reason: "No layer dimension." },
				tokens: { supported: false, basis: "UNAVAILABLE", reason: "No token dimension." },
			},
			points: [
				{
					pointId: "s0",
					sourceIndex: 0,
					layer: null,
					tokenIndex: null,
					tokenId: null,
					tokenText: null,
					eventRef: null,
					hookPoint: "pooled.small",
					vector: [0, 0],
					topNextToken: null,
				},
				{
					pointId: "s1",
					sourceIndex: 1,
					layer: null,
					tokenIndex: null,
					tokenId: null,
					tokenText: null,
					eventRef: null,
					hookPoint: "pooled.small",
					vector: [1e-6, 0],
					topNextToken: null,
				},
				{
					pointId: "s2",
					sourceIndex: 2,
					layer: null,
					tokenIndex: null,
					tokenId: null,
					tokenText: null,
					eventRef: null,
					hookPoint: "pooled.small",
					vector: [0, 1e-6],
					topNextToken: null,
				},
			],
		});
		const scene = projectEndoObserveRepresentationSceneV0({
			capture: smallCapture,
			selector: TEST_SELECTOR,
			artifactSha256: TEST_SHA,
		});
		expect(scene.analysis.degenerate).toBe(false);
		expect(scene.analysis.totalVariance).toBeGreaterThan(0);
		expect(scene.analysis.axes[0].explainedVarianceRatio!).toBeCloseTo(0.75, 9);
		expect(scene.analysis.axes[1].explainedVarianceRatio!).toBeCloseTo(0.25, 9);
		expect(scene.points[1]!.observed.l2Norm).toBeCloseTo(1e-6, 15);
	});

	it("projects a worst-case 512 x 576 non-degenerate matrix well within interactive bounds", () => {
		const n = 512;
		const d = 576;
		let seed = 123456789;
		const nextRand = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0xffffffff - 0.5;
		};
		const vectors = Array.from({ length: n }, () => Array.from({ length: d }, () => nextRand()));
		const start = performance.now();
		const res = computePca2dV0(vectors);
		const elapsedMs = performance.now() - start;
		expect(res.degenerate).toBe(false);
		expect(res.coords.length).toBe(n);
		expect(res.eigenvalues[0]).toBeGreaterThan(res.eigenvalues[1]);
		expect(res.eigenvalues[1]).toBeGreaterThan(0);
		expect(elapsedMs).toBeLessThan(5_000);
	});
});

describe("validation, epistemic boundaries and capability restrictions", () => {
	it("rejects invalid, missing, non-finite, mismatched, and misleading captures", () => {
		const base = syntheticFixtureCapture();
		expect(endoObserveRepresentationCaptureProblemV0(base)).toBeNull();

		// Extra unexpected top-level property fails closed.
		expect(endoObserveRepresentationCaptureProblemV0({ ...base, extraField: true })).not.toBeNull();

		// Non-finite numbers rejected.
		const nanCapture = structuredClone(base);
		nanCapture.points[0]!.vector[1] = Number.NaN;
		expect(() => validateEndoObserveRepresentationCaptureV0(nanCapture)).toThrow(TypeError);

		// Mismatched vector dimensionality rejected.
		const mismatchDim = structuredClone(base);
		mismatchDim.points[1]!.vector = [1, 2, 3];
		expect(() => validateEndoObserveRepresentationCaptureV0(mismatchDim)).toThrow(TypeError);

		// Overlapping supported and non-fireable hooks rejected (TransformerLens 4.x Driver invariant).
		const overlap = structuredClone(base);
		overlap.backendCapabilities.nonFireableHookPoints = ["blocks.0.hook_resid_post"];
		expect(() => validateEndoObserveRepresentationCaptureV0(overlap)).toThrow(TypeError);

		// test-fixture without fixtureNotice rejected (prevents synthetic data masquerading as real).
		const noNotice = structuredClone(base);
		noNotice.subject.fixtureNotice = null;
		expect(() => validateEndoObserveRepresentationCaptureV0(noNotice)).toThrow(TypeError);

		// reference-replay without replayOf rejected (prevents replay masquerading as primary inference).
		const noReplay = structuredClone(base);
		noReplay.subject.executionRole = "reference-replay";
		noReplay.subject.fixtureNotice = null;
		noReplay.subject.replayOf = null;
		expect(() => validateEndoObserveRepresentationCaptureV0(noReplay)).toThrow(TypeError);

		// Layer value present when layers dimension is UNAVAILABLE rejected.
		const badLayerDim = structuredClone(base);
		badLayerDim.dimensions.layers = { supported: false, basis: "UNAVAILABLE", reason: "No layer dimension." };
		expect(() => validateEndoObserveRepresentationCaptureV0(badLayerDim)).toThrow(TypeError);
	});

	it("refuses layer selection on an artifact whose layers dimension is UNAVAILABLE and fabricates nothing", () => {
		const noDimCapture = syntheticFixtureCapture({
			dimensions: {
				layers: {
					supported: false,
					basis: "UNAVAILABLE",
					reason: "Single-point summary without layer separation.",
				},
				tokens: {
					supported: false,
					basis: "UNAVAILABLE",
					reason: "Sequence-level pooling; per-token states unavailable.",
				},
			},
			points: [
				{
					pointId: "ev-0",
					sourceIndex: 0,
					layer: null,
					tokenIndex: null,
					tokenId: null,
					tokenText: null,
					eventRef: "endo.event.1",
					hookPoint: "pooled.summary",
					vector: [2, 0, 1, 0],
					topNextToken: null,
				},
				{
					pointId: "ev-1",
					sourceIndex: 1,
					layer: null,
					tokenIndex: null,
					tokenId: null,
					tokenText: null,
					eventRef: "endo.event.2",
					hookPoint: "pooled.summary",
					vector: [-2, 1, 0, 0],
					topNextToken: null,
				},
			],
		});

		const scene = projectEndoObserveRepresentationSceneV0({
			capture: noDimCapture,
			selector: TEST_SELECTOR,
			artifactSha256: TEST_SHA,
		});
		expect(scene.selectedLayer).toBeNull();
		expect(scene.dimensions.layers.supported).toBe(false);
		expect(scene.dimensions.tokens.supported).toBe(false);
		expect(scene.interpretations).toEqual([]);
		expect(
			scene.points.every((p) => p.layer === null && p.tokenIndex === null && p.observed.topNextToken === null),
		).toBe(true);
		expect(() =>
			projectEndoObserveRepresentationSceneV0({
				capture: noDimCapture,
				selector: TEST_SELECTOR,
				artifactSha256: TEST_SHA,
				layer: 0,
			}),
		).toThrow(/layer selection is unavailable/);
	});

	it("validates and deterministically projects the real offline SmolLM2-135M-Instruct capture", () => {
		const raw = JSON.parse(
			readFileSync(join(repo, "research/observe-geometry/examples/smollm2-135m-resid-post.json"), "utf8"),
		);
		const capture = validateEndoObserveRepresentationCaptureV0(raw);
		expect(capture.subject.executionRole).toBe("primary-observation");
		expect(capture.subject.model.modelId).toBe("HuggingFaceTB/SmolLM2-135M-Instruct");
		expect(capture.subject.captureLocation.headSemantics).toEqual({
			queryHeads: 9,
			kvHeads: 3,
			layout: "residual-stream",
		});
		expect(capture.subject.weightProcessing.mode).toBe("raw-hf");
		expect(capture.interpretations).toEqual([]);

		for (const layer of [0, 9, 19, 29, "all"] as const) {
			const scene = projectEndoObserveRepresentationSceneV0({
				capture,
				selector: TEST_SELECTOR,
				artifactSha256: TEST_SHA,
				layer,
			});
			expect(validateEndoObserveRepresentationSceneV0(scene)).toBe(scene);
			expect(scene.selectedLayer).toBe(layer);
			expect(scene.points.length).toBe(layer === "all" ? 68 : 17);
			expect(scene.analysis.basis).toBe("DERIVED");
			expect(scene.interpretations).toEqual([]);
			expect(scene.points.every((p) => p.observed.basis === "OBSERVED" && p.derived.basis === "DERIVED")).toBe(true);
		}
	});
});
