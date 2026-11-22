// Browser wire gate for Representation Explorer (protocol/observe-representation.ts).
// Imports protocol as types only; nothing of the protocol runs in the browser.
// Rejects malformed or unsupported payloads fail-closed so the UI never renders partial or fabricated data.

import type {
	EndoObserveBackendCapabilitiesV0,
	EndoObserveDimensionsV0,
	EndoObserveRepresentationSceneV0,
	EndoObserveRepresentationSummaryV0,
	EndoObserveRepresentationsIndexV0,
	EndoObserveSubjectProvenanceV0,
} from "../../../protocol/observe-representation.ts";
import { bool, type Check, count, eitherNull, one, shape } from "./compare-wire.ts";

export const REPRESENTATION_EXECUTION_ROLES = ["primary-observation", "reference-replay", "test-fixture"] as const;
export const REPRESENTATION_WEIGHT_MODES = [
	"raw-hf",
	"tl-compatibility-mode",
	"native-quantized",
	"not-applicable",
] as const;
export const REPRESENTATION_HEAD_LAYOUTS = ["residual-stream", "native-gqa-kv", "query-heads", "unavailable"] as const;
export const REPRESENTATION_ARTIFACT_STATES = [
	"readable",
	"invalid",
	"unsupported-schema",
	"too-large",
	"unreadable",
] as const;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
const matches =
	(pattern: RegExp): Check =>
	(v) =>
		typeof v === "string" && pattern.test(v);
const finite: Check = (v) => typeof v === "number" && Number.isFinite(v);
const nonNegFinite: Check = (v) => finite(v) && (v as number) >= 0;
const text =
	(max: number): Check =>
	(v) =>
		typeof v === "string" && v.length >= 1 && v.length <= max;
const bounded =
	(max: number, check: Check): Check =>
	(v) =>
		Array.isArray(v) && v.length <= max && v.every(check);
const date: Check = (v) => v === null || (typeof v === "string" && ISO.test(v));

export const representationSelector = matches(/^r1-[0-9a-f]{32}$/);
const sha256 = matches(/^[0-9a-f]{64}$/);
const identifier = matches(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/);
const hookName = matches(/^[A-Za-z0-9_{}.-]{1,128}$/);

const dimensions: Check = (v) =>
	shape(v, {
		layers: (l) =>
			shape(l, {
				supported: one(true),
				availableLayers: (a) => Array.isArray(a) && a.length >= 1 && a.length <= 128 && a.every(count),
				defaultLayer: count,
			}) ||
			shape(l, {
				supported: one(false),
				basis: one("UNAVAILABLE"),
				reason: text(512),
			}),
		tokens: (t) =>
			shape(t, { supported: one(true), tokenCount: (n) => count(n) && (n as number) >= 1 }) ||
			shape(t, { supported: one(false), basis: one("UNAVAILABLE"), reason: text(512) }),
	});

const subject: Check = (v) =>
	shape(v, {
		executionRole: one(...REPRESENTATION_EXECUTION_ROLES),
		replayOf: eitherNull((r) => shape(r, { primaryArtifactId: eitherNull(identifier), note: text(512) })),
		fixtureNotice: eitherNull(text(512)),
		model: (m) =>
			shape(m, {
				family: identifier,
				modelId: identifier,
				revision: eitherNull(identifier),
				weightDigestSha256: eitherNull(sha256),
				weightDtype: identifier,
				quantization: eitherNull((q) => shape(q, { method: identifier, revision: eitherNull(identifier) })),
			}),
		backend: (b) =>
			shape(b, {
				framework: identifier,
				frameworkVersion: identifier,
				driver: identifier,
				computeDtype: identifier,
				device: identifier,
				attentionKernel: eitherNull(identifier),
			}),
		weightProcessing: (w) =>
			shape(w, {
				mode: one(...REPRESENTATION_WEIGHT_MODES),
				foldLn: eitherNull(bool),
				centerWritingWeights: eitherNull(bool),
				centerUnembed: eitherNull(bool),
				foldValueBiases: eitherNull(bool),
			}),
		captureLocation: (c) =>
			shape(c, {
				hookPoint: hookName,
				tensorShape: (s) =>
					Array.isArray(s) && s.length >= 1 && s.length <= 8 && s.every((n) => count(n) && (n as number) > 0),
				dModel: eitherNull((n) => count(n) && (n as number) > 0),
				headSemantics: (h) =>
					shape(h, {
						queryHeads: eitherNull((n) => count(n) && (n as number) > 0),
						kvHeads: eitherNull((n) => count(n) && (n as number) > 0),
						layout: one(...REPRESENTATION_HEAD_LAYOUTS),
					}),
			}),
	});

const capabilities: Check = (v) =>
	shape(v, {
		supportedHookPoints: bounded(128, hookName),
		supportedHookPointsCount: count,
		nonFireableHookPoints: bounded(128, hookName),
		nonFireableHookPointsCount: count,
		providesSequenceLogits: eitherNull(bool),
		supportedFeatures: bounded(32, identifier),
		unavailableSignals: bounded(32, (s) =>
			shape(s, { signal: identifier, basis: one("UNAVAILABLE"), reason: text(512) }),
		),
	});

const topNextToken: Check = eitherNull((t) =>
	shape(t, {
		token: (s) => typeof s === "string" && s.length <= 128,
		tokenId: eitherNull(count),
		logit: finite,
		probability: eitherNull((p) => finite(p) && (p as number) >= 0 && (p as number) <= 1),
		basis: one("OBSERVED"),
	}),
);

const summaryRow: Check = (v) =>
	shape(v, {
		selector: representationSelector,
		state: one(...REPRESENTATION_ARTIFACT_STATES),
		reason: eitherNull(text(256)),
		artifactId: eitherNull(identifier),
		artifactSha256: eitherNull(sha256),
		capturedAt: date,
		executionRole: eitherNull(one(...REPRESENTATION_EXECUTION_ROLES)),
		modelId: eitherNull(identifier),
		weightDtype: eitherNull(identifier),
		backendLabel: eitherNull(text(128)),
		hookPoint: eitherNull(hookName),
		pointCount: count,
		dimensions: eitherNull(dimensions),
	});

const axis: Check = (v) =>
	shape(v, {
		id: one("pc1", "pc2"),
		label: text(64),
		basis: one("DERIVED"),
		eigenvalue: nonNegFinite,
		explainedVarianceRatio: eitherNull((r) => finite(r) && (r as number) >= 0 && (r as number) <= 1.0001),
	});

const scenePoint: Check = (v) =>
	shape(v, {
		pointId: identifier,
		sourceIndex: count,
		hookPoint: hookName,
		layer: eitherNull(count),
		tokenIndex: eitherNull(count),
		tokenId: eitherNull(count),
		tokenText: eitherNull((s) => typeof s === "string" && s.length <= 128),
		eventRef: eitherNull(identifier),
		observed: (o) =>
			shape(o, {
				basis: one("OBSERVED"),
				vectorDim: (n) => count(n) && (n as number) >= 2,
				l2Norm: nonNegFinite,
				mean: finite,
				std: nonNegFinite,
				min: finite,
				max: finite,
				topNextToken,
			}),
		derived: (d) =>
			shape(d, {
				basis: one("DERIVED"),
				x: finite,
				y: finite,
				distanceFromMean: nonNegFinite,
				residual2dFraction: eitherNull((f) => finite(f) && (f as number) >= 0 && (f as number) <= 1.0001),
			}),
	});

const interpretation: Check = (v) =>
	shape(v, {
		basis: one("INTERPRETED"),
		author: text(128),
		pointId: eitherNull(identifier),
		text: text(512),
	});

export type RepresentationIndex = EndoObserveRepresentationsIndexV0 | { available: false };

export function readRepresentationsIndex(v: unknown): RepresentationIndex | null {
	if (shape(v, { schemaVersion: one("endo.observe-representations.v0"), available: one(false) })) {
		return { available: false };
	}
	if (
		!shape(v, {
			schemaVersion: one("endo.observe-representations.v0"),
			available: one(true),
			artifacts: bounded(64, summaryRow),
			skipped: (s) => shape(s, { links: count, notRegular: count, overLimit: count, unreadable: count }),
		})
	) {
		return null;
	}
	const rows = (v as unknown as EndoObserveRepresentationsIndexV0).artifacts;
	const seen = new Set(rows.map((r: EndoObserveRepresentationSummaryV0) => r.selector));
	return seen.size === rows.length ? (v as unknown as EndoObserveRepresentationsIndexV0) : null;
}

export function readRepresentationScene(v: unknown): EndoObserveRepresentationSceneV0 | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.observe-representation-scene.v0"),
			projectionVersion: one("0.1"),
			selector: representationSelector,
			artifact: (a) =>
				shape(a, {
					artifactId: identifier,
					artifactSha256: sha256,
					capturedAt: date,
					promptId: eitherNull(identifier),
					sequenceLength: eitherNull((n) => count(n) && (n as number) > 0),
				}),
			subject,
			backendCapabilities: capabilities,
			dimensions,
			selectedLayer: (l) => l === null || l === "all" || count(l),
			analysis: (an) =>
				shape(an, {
					method: one("pca-2d-householder-ql"),
					revision: one("v0"),
					basis: one("DERIVED"),
					centering: one("mean-centered"),
					scaling: one("unscaled"),
					signCanonicalization: one("max-abs-positive"),
					inputPointCount: (n) => count(n) && (n as number) >= 1,
					inputVectorDim: (n) => count(n) && (n as number) >= 2,
					totalVariance: nonNegFinite,
					axes: (ax) => Array.isArray(ax) && ax.length === 2 && axis(ax[0]) && axis(ax[1]),
					varianceExplainedTotal: eitherNull((r) => finite(r) && (r as number) >= 0 && (r as number) <= 1.0001),
					degenerate: bool,
					note: text(512),
				}),
			points: bounded(512, scenePoint),
			interpretations: bounded(32, interpretation),
		})
	) {
		return null;
	}
	const scene = v as unknown as EndoObserveRepresentationSceneV0;
	const subj: EndoObserveSubjectProvenanceV0 = scene.subject;
	const dims: EndoObserveDimensionsV0 = scene.dimensions;
	const caps: EndoObserveBackendCapabilitiesV0 = scene.backendCapabilities;
	if (subj.executionRole === "reference-replay" && subj.replayOf === null) return null;
	if (subj.executionRole === "test-fixture" && subj.fixtureNotice === null) return null;
	if (scene.points.length !== scene.analysis.inputPointCount) return null;
	if (!dims.layers.supported && scene.selectedLayer !== null) return null;
	if (caps.supportedHookPointsCount < caps.supportedHookPoints.length) return null;
	if (caps.nonFireableHookPointsCount < caps.nonFireableHookPoints.length) return null;
	return scene;
}
