// Representation Explorer contracts (OBSERVE-GEOMETRY-001):
// - `endo.observe-representation-capture.v0`: an offline or recorded capture of model-internal or harness representation vectors
//   with explicit experimental-subject provenance, backend hook capabilities and supported dimensions.
// - `endo.observe-representations.v0`: the read-only index of representation artifacts exposed by Studio (or `{ available: false }`).
// - `endo.observe-representation-scene.v0`: the deterministic 2D projected scene derived from one validated capture artifact.
//
// Epistemic distinctions are enforced structurally, never collapsed:
// - OBSERVED: measurements or events actually captured from execution;
// - DERIVED: deterministic transformations computed from OBSERVED measurements (e.g. mean-centered 2D PCA coordinates);
// - INTERPRETED: human or external semantic hypotheses kept strictly separate from OBSERVED and DERIVED fields;
// - UNAVAILABLE: signals or dimensions not exposed by the execution backend, carried with explicit reasons.
//
// The protocol imports only the protocol.

import { isIso8601UtcV0, isPlainJsonObjectV0 } from "./primitives.ts";

export const ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0 = "endo.observe-representation-capture.v0";
export const ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0 = "endo.observe-representations.v0";
export const ENDO_OBSERVE_REPRESENTATION_SCENE_SCHEMA_V0 = "endo.observe-representation-scene.v0";
export const ENDO_OBSERVE_REPRESENTATION_PROJECTION_VERSION_V0 = "0.1";

export const ENDO_OBSERVE_EPISTEMIC_BASES_V0 = ["OBSERVED", "DERIVED", "INTERPRETED", "UNAVAILABLE"] as const;
export type EndoObserveEpistemicBasisV0 = (typeof ENDO_OBSERVE_EPISTEMIC_BASES_V0)[number];

export const ENDO_OBSERVE_EXECUTION_ROLES_V0 = ["primary-observation", "reference-replay", "test-fixture"] as const;
export type EndoObserveExecutionRoleV0 = (typeof ENDO_OBSERVE_EXECUTION_ROLES_V0)[number];

export const ENDO_OBSERVE_WEIGHT_PROCESSING_MODES_V0 = [
	"raw-hf",
	"tl-compatibility-mode",
	"native-quantized",
	"not-applicable",
] as const;
export type EndoObserveWeightProcessingModeV0 = (typeof ENDO_OBSERVE_WEIGHT_PROCESSING_MODES_V0)[number];

export const ENDO_OBSERVE_HEAD_LAYOUTS_V0 = ["residual-stream", "native-gqa-kv", "query-heads", "unavailable"] as const;
export type EndoObserveHeadLayoutV0 = (typeof ENDO_OBSERVE_HEAD_LAYOUTS_V0)[number];

export const ENDO_OBSERVE_ARTIFACT_STATES_V0 = [
	"readable",
	"invalid",
	"unsupported-schema",
	"too-large",
	"unreadable",
] as const;
export type EndoObserveArtifactStateV0 = (typeof ENDO_OBSERVE_ARTIFACT_STATES_V0)[number];

export const ENDO_OBSERVE_REPRESENTATION_LIMITS_V0 = Object.freeze({
	maxFiles: 64,
	maxFileBytes: 16 * 1024 * 1024,
	maxPoints: 512,
	maxVectorDim: 8192,
	maxLayers: 128,
	maxHookListItems: 128,
	maxUnavailableSignals: 32,
	maxInterpretations: 32,
	maxTensorRank: 8,
});

export const ENDO_OBSERVE_REPRESENTATION_SELECTOR_PATTERN_V0 = /^r1-[0-9a-f]{32}$/;
export const ENDO_OBSERVE_SHA256_PATTERN_V0 = /^[0-9a-f]{64}$/;
export const ENDO_OBSERVE_IDENTIFIER_PATTERN_V0 = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
export const ENDO_OBSERVE_HOOK_PATTERN_V0 = /^[A-Za-z0-9_{}.-]{1,128}$/;

export interface EndoObserveReplayReferenceV0 {
	primaryArtifactId: string | null;
	note: string;
}

export interface EndoObserveModelIdentityV0 {
	family: string;
	modelId: string;
	revision: string | null;
	weightDigestSha256: string | null;
	weightDtype: string;
	quantization: { method: string; revision: string | null } | null;
}

export interface EndoObserveBackendIdentityV0 {
	framework: string;
	frameworkVersion: string;
	driver: string;
	computeDtype: string;
	device: string;
	attentionKernel: string | null;
}

export interface EndoObserveWeightProcessingV0 {
	mode: EndoObserveWeightProcessingModeV0;
	foldLn: boolean | null;
	centerWritingWeights: boolean | null;
	centerUnembed: boolean | null;
	foldValueBiases: boolean | null;
}

export interface EndoObserveCaptureLocationV0 {
	hookPoint: string;
	tensorShape: number[];
	dModel: number | null;
	headSemantics: {
		queryHeads: number | null;
		kvHeads: number | null;
		layout: EndoObserveHeadLayoutV0;
	};
}

export interface EndoObserveSubjectProvenanceV0 {
	executionRole: EndoObserveExecutionRoleV0;
	replayOf: EndoObserveReplayReferenceV0 | null;
	fixtureNotice: string | null;
	model: EndoObserveModelIdentityV0;
	backend: EndoObserveBackendIdentityV0;
	weightProcessing: EndoObserveWeightProcessingV0;
	captureLocation: EndoObserveCaptureLocationV0;
}

export interface EndoObserveUnavailableSignalV0 {
	signal: string;
	basis: "UNAVAILABLE";
	reason: string;
}

export interface EndoObserveBackendCapabilitiesV0 {
	supportedHookPoints: string[];
	supportedHookPointsCount: number;
	nonFireableHookPoints: string[];
	nonFireableHookPointsCount: number;
	providesSequenceLogits: boolean | null;
	supportedFeatures: string[];
	unavailableSignals: EndoObserveUnavailableSignalV0[];
}

export type EndoObserveLayerDimensionV0 =
	| { supported: true; availableLayers: number[]; defaultLayer: number }
	| { supported: false; basis: "UNAVAILABLE"; reason: string };

export type EndoObserveTokenDimensionV0 =
	| { supported: true; tokenCount: number }
	| { supported: false; basis: "UNAVAILABLE"; reason: string };

export interface EndoObserveDimensionsV0 {
	layers: EndoObserveLayerDimensionV0;
	tokens: EndoObserveTokenDimensionV0;
}

export interface EndoObserveTopNextTokenV0 {
	token: string;
	tokenId: number | null;
	logit: number;
	probability: number | null;
	basis: "OBSERVED";
}

export interface EndoObserveCapturePointV0 {
	pointId: string;
	sourceIndex: number;
	layer: number | null;
	tokenIndex: number | null;
	tokenId: number | null;
	tokenText: string | null;
	eventRef: string | null;
	hookPoint: string;
	vector: number[];
	topNextToken: EndoObserveTopNextTokenV0 | null;
}

export interface EndoObserveInterpretationNoteV0 {
	basis: "INTERPRETED";
	author: string;
	pointId: string | null;
	text: string;
}

export interface EndoObserveArtifactMetaV0 {
	artifactId: string;
	capturedAt: string | null;
	promptId: string | null;
	sequenceLength: number | null;
}

export interface EndoObserveArtifactProvenanceV0 extends EndoObserveArtifactMetaV0 {
	artifactSha256: string;
}

export interface EndoObserveRepresentationCaptureV0 {
	schemaVersion: typeof ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0;
	artifact: EndoObserveArtifactMetaV0;
	subject: EndoObserveSubjectProvenanceV0;
	backendCapabilities: EndoObserveBackendCapabilitiesV0;
	dimensions: EndoObserveDimensionsV0;
	points: EndoObserveCapturePointV0[];
	interpretations: EndoObserveInterpretationNoteV0[];
}

export interface EndoObserveRepresentationSummaryV0 {
	selector: string;
	state: EndoObserveArtifactStateV0;
	reason: string | null;
	artifactId: string | null;
	artifactSha256: string | null;
	capturedAt: string | null;
	executionRole: EndoObserveExecutionRoleV0 | null;
	modelId: string | null;
	weightDtype: string | null;
	backendLabel: string | null;
	hookPoint: string | null;
	pointCount: number;
	dimensions: EndoObserveDimensionsV0 | null;
}

export interface EndoObserveRepresentationsIndexV0 {
	schemaVersion: typeof ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0;
	available: true;
	artifacts: EndoObserveRepresentationSummaryV0[];
	skipped: {
		links: number;
		notRegular: number;
		overLimit: number;
		unreadable: number;
	};
}

export interface EndoObserveRepresentationsAbsentV0 {
	schemaVersion: typeof ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0;
	available: false;
}

export const ENDO_OBSERVE_REPRESENTATIONS_ABSENT_V0: EndoObserveRepresentationsAbsentV0 = Object.freeze({
	schemaVersion: ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0,
	available: false,
});

export interface EndoObserveAxisSummaryV0 {
	id: "pc1" | "pc2";
	label: string;
	basis: "DERIVED";
	eigenvalue: number;
	explainedVarianceRatio: number | null;
}

export interface EndoObserveAnalysisProvenanceV0 {
	method: "pca-2d-householder-ql";
	revision: "v0";
	basis: "DERIVED";
	centering: "mean-centered";
	scaling: "unscaled";
	signCanonicalization: "max-abs-positive";
	inputPointCount: number;
	inputVectorDim: number;
	totalVariance: number;
	axes: [EndoObserveAxisSummaryV0, EndoObserveAxisSummaryV0];
	varianceExplainedTotal: number | null;
	degenerate: boolean;
	note: string;
}

export interface EndoObserveScenePointV0 {
	pointId: string;
	sourceIndex: number;
	hookPoint: string;
	layer: number | null;
	tokenIndex: number | null;
	tokenId: number | null;
	tokenText: string | null;
	eventRef: string | null;
	observed: {
		basis: "OBSERVED";
		vectorDim: number;
		l2Norm: number;
		mean: number;
		std: number;
		min: number;
		max: number;
		topNextToken: EndoObserveTopNextTokenV0 | null;
	};
	derived: {
		basis: "DERIVED";
		x: number;
		y: number;
		distanceFromMean: number;
		residual2dFraction: number | null;
	};
}

export interface EndoObserveRepresentationSceneV0 {
	schemaVersion: typeof ENDO_OBSERVE_REPRESENTATION_SCENE_SCHEMA_V0;
	projectionVersion: typeof ENDO_OBSERVE_REPRESENTATION_PROJECTION_VERSION_V0;
	selector: string;
	artifact: EndoObserveArtifactProvenanceV0;
	subject: EndoObserveSubjectProvenanceV0;
	backendCapabilities: EndoObserveBackendCapabilitiesV0;
	dimensions: EndoObserveDimensionsV0;
	selectedLayer: number | "all" | null;
	analysis: EndoObserveAnalysisProvenanceV0;
	points: EndoObserveScenePointV0[];
	interpretations: EndoObserveInterpretationNoteV0[];
}

/**
 * Read-only observer injected into the cockpit HTTP server, mirroring `EndoOmpObserverV0`.
 * `scene` returns `null` when a selector is unknown or stale, and throws a `TypeError` when the requested layer
 * is not supported by the artifact.
 */
export interface EndoObserveRepresentationObserverV0 {
	list(): EndoObserveRepresentationsIndexV0;
	scene(selector: string, options?: { layer?: number | "all" }): EndoObserveRepresentationSceneV0 | null;
}

// ---- validators ---------------------------------------------------------------------------------------------------------------------

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
	isPlainJsonObjectV0(value) &&
	Object.keys(value as object).length === keys.length &&
	keys.every((key) => Object.hasOwn(value as object, key));

const count = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const nonEmptyText = (value: unknown, maxLen: number): value is string =>
	typeof value === "string" && value.length >= 1 && value.length <= maxLen;

const matches = (pattern: RegExp, value: unknown): value is string => typeof value === "string" && pattern.test(value);

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
	typeof value === "string" && (list as readonly string[]).includes(value);

const nullableDate = (value: unknown): value is string | null =>
	value === null || (typeof value === "string" && isIso8601UtcV0(value));

const nullableBool = (value: unknown): value is boolean | null => value === null || typeof value === "boolean";

const nullableCount = (value: unknown): value is number | null => value === null || count(value);

function validateTopNextToken(value: unknown): string | null {
	if (value === null) return null;
	if (!exact(value, ["token", "tokenId", "logit", "probability", "basis"])) return "topNextToken: unexpected members";
	if (typeof value.token !== "string" || value.token.length > 128) return "topNextToken: token";
	if (!nullableCount(value.tokenId)) return "topNextToken: tokenId";
	if (!finite(value.logit)) return "topNextToken: logit";
	if (value.probability !== null && (!finite(value.probability) || value.probability < 0 || value.probability > 1))
		return "topNextToken: probability";
	if (value.basis !== "OBSERVED") return "topNextToken: basis";
	return null;
}

function validateSubject(value: unknown): string | null {
	if (
		!exact(value, [
			"executionRole",
			"replayOf",
			"fixtureNotice",
			"model",
			"backend",
			"weightProcessing",
			"captureLocation",
		])
	)
		return "subject: unexpected members";
	if (!oneOf(ENDO_OBSERVE_EXECUTION_ROLES_V0, value.executionRole)) return "subject: executionRole";
	if (value.executionRole === "reference-replay") {
		if (!exact(value.replayOf, ["primaryArtifactId", "note"]))
			return "subject: replayOf required for reference-replay";
		if (
			value.replayOf.primaryArtifactId !== null &&
			!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, value.replayOf.primaryArtifactId)
		)
			return "subject: replayOf.primaryArtifactId";
		if (!nonEmptyText(value.replayOf.note, 512)) return "subject: replayOf.note";
		if (value.fixtureNotice !== null) return "subject: fixtureNotice must be null for reference-replay";
	} else if (value.executionRole === "test-fixture") {
		if (!nonEmptyText(value.fixtureNotice, 512)) return "subject: fixtureNotice required for test-fixture";
		if (value.replayOf !== null) return "subject: replayOf must be null for test-fixture";
	} else {
		if (value.replayOf !== null || value.fixtureNotice !== null)
			return "subject: replayOf and fixtureNotice must be null for primary-observation";
	}

	const model = value.model;
	if (!exact(model, ["family", "modelId", "revision", "weightDigestSha256", "weightDtype", "quantization"]))
		return "subject.model: unexpected members";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, model.family)) return "subject.model: family";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, model.modelId)) return "subject.model: modelId";
	if (model.revision !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, model.revision))
		return "subject.model: revision";
	if (model.weightDigestSha256 !== null && !matches(ENDO_OBSERVE_SHA256_PATTERN_V0, model.weightDigestSha256))
		return "subject.model: weightDigestSha256";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, model.weightDtype)) return "subject.model: weightDtype";
	if (model.quantization !== null) {
		if (!exact(model.quantization, ["method", "revision"])) return "subject.model.quantization: unexpected members";
		if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, model.quantization.method))
			return "subject.model.quantization: method";
		if (
			model.quantization.revision !== null &&
			!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, model.quantization.revision)
		)
			return "subject.model.quantization: revision";
	}

	const backend = value.backend;
	if (!exact(backend, ["framework", "frameworkVersion", "driver", "computeDtype", "device", "attentionKernel"]))
		return "subject.backend: unexpected members";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, backend.framework)) return "subject.backend: framework";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, backend.frameworkVersion))
		return "subject.backend: frameworkVersion";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, backend.driver)) return "subject.backend: driver";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, backend.computeDtype)) return "subject.backend: computeDtype";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, backend.device)) return "subject.backend: device";
	if (backend.attentionKernel !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, backend.attentionKernel))
		return "subject.backend: attentionKernel";

	const wp = value.weightProcessing;
	if (!exact(wp, ["mode", "foldLn", "centerWritingWeights", "centerUnembed", "foldValueBiases"]))
		return "subject.weightProcessing: unexpected members";
	if (!oneOf(ENDO_OBSERVE_WEIGHT_PROCESSING_MODES_V0, wp.mode)) return "subject.weightProcessing: mode";
	if (
		!nullableBool(wp.foldLn) ||
		!nullableBool(wp.centerWritingWeights) ||
		!nullableBool(wp.centerUnembed) ||
		!nullableBool(wp.foldValueBiases)
	)
		return "subject.weightProcessing: flags";

	const loc = value.captureLocation;
	if (!exact(loc, ["hookPoint", "tensorShape", "dModel", "headSemantics"]))
		return "subject.captureLocation: unexpected members";
	if (!matches(ENDO_OBSERVE_HOOK_PATTERN_V0, loc.hookPoint)) return "subject.captureLocation: hookPoint";
	if (
		!Array.isArray(loc.tensorShape) ||
		loc.tensorShape.length === 0 ||
		loc.tensorShape.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxTensorRank ||
		!loc.tensorShape.every((d) => count(d) && d > 0)
	)
		return "subject.captureLocation: tensorShape";
	if (loc.dModel !== null && !(count(loc.dModel) && loc.dModel > 0)) return "subject.captureLocation: dModel";
	const hs = loc.headSemantics;
	if (!exact(hs, ["queryHeads", "kvHeads", "layout"]))
		return "subject.captureLocation.headSemantics: unexpected members";
	if (hs.queryHeads !== null && !(count(hs.queryHeads) && hs.queryHeads > 0))
		return "subject.captureLocation.headSemantics: queryHeads";
	if (hs.kvHeads !== null && !(count(hs.kvHeads) && hs.kvHeads > 0))
		return "subject.captureLocation.headSemantics: kvHeads";
	if (!oneOf(ENDO_OBSERVE_HEAD_LAYOUTS_V0, hs.layout)) return "subject.captureLocation.headSemantics: layout";
	return null;
}

function validateCapabilities(value: unknown): string | null {
	if (
		!exact(value, [
			"supportedHookPoints",
			"supportedHookPointsCount",
			"nonFireableHookPoints",
			"nonFireableHookPointsCount",
			"providesSequenceLogits",
			"supportedFeatures",
			"unavailableSignals",
		])
	)
		return "backendCapabilities: unexpected members";
	if (
		!Array.isArray(value.supportedHookPoints) ||
		value.supportedHookPoints.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxHookListItems ||
		!value.supportedHookPoints.every((h) => matches(ENDO_OBSERVE_HOOK_PATTERN_V0, h))
	)
		return "backendCapabilities: supportedHookPoints";
	if (!count(value.supportedHookPointsCount) || value.supportedHookPointsCount < value.supportedHookPoints.length)
		return "backendCapabilities: supportedHookPointsCount";
	if (
		!Array.isArray(value.nonFireableHookPoints) ||
		value.nonFireableHookPoints.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxHookListItems ||
		!value.nonFireableHookPoints.every((h) => matches(ENDO_OBSERVE_HOOK_PATTERN_V0, h))
	)
		return "backendCapabilities: nonFireableHookPoints";
	if (
		!count(value.nonFireableHookPointsCount) ||
		value.nonFireableHookPointsCount < value.nonFireableHookPoints.length
	)
		return "backendCapabilities: nonFireableHookPointsCount";
	const supportedSet = new Set(value.supportedHookPoints as string[]);
	const nonFireableSet = new Set(value.nonFireableHookPoints as string[]);
	if (
		supportedSet.size !== value.supportedHookPoints.length ||
		nonFireableSet.size !== value.nonFireableHookPoints.length
	)
		return "backendCapabilities: duplicate hook point";
	for (const h of supportedSet) {
		if (nonFireableSet.has(h)) return "backendCapabilities: hook point in both supported and nonFireable";
	}
	if (!nullableBool(value.providesSequenceLogits)) return "backendCapabilities: providesSequenceLogits";
	if (
		!Array.isArray(value.supportedFeatures) ||
		value.supportedFeatures.length > 32 ||
		!value.supportedFeatures.every((f) => matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, f))
	)
		return "backendCapabilities: supportedFeatures";
	if (
		!Array.isArray(value.unavailableSignals) ||
		value.unavailableSignals.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxUnavailableSignals
	)
		return "backendCapabilities: unavailableSignals";
	for (const sig of value.unavailableSignals) {
		if (!exact(sig, ["signal", "basis", "reason"]))
			return "backendCapabilities.unavailableSignals: unexpected members";
		if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, sig.signal))
			return "backendCapabilities.unavailableSignals: signal";
		if (sig.basis !== "UNAVAILABLE") return "backendCapabilities.unavailableSignals: basis";
		if (!nonEmptyText(sig.reason, 512)) return "backendCapabilities.unavailableSignals: reason";
	}
	return null;
}

function validateDimensions(value: unknown): string | null {
	if (!exact(value, ["layers", "tokens"])) return "dimensions: unexpected members";
	const layers = value.layers;
	if (exact(layers, ["supported", "availableLayers", "defaultLayer"])) {
		if (layers.supported !== true) return "dimensions.layers: supported";
		if (
			!Array.isArray(layers.availableLayers) ||
			layers.availableLayers.length === 0 ||
			layers.availableLayers.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxLayers ||
			!layers.availableLayers.every(count)
		)
			return "dimensions.layers: availableLayers";
		const unique = new Set(layers.availableLayers as number[]);
		if (unique.size !== layers.availableLayers.length) return "dimensions.layers: duplicate layer";
		if (!count(layers.defaultLayer) || !unique.has(layers.defaultLayer)) return "dimensions.layers: defaultLayer";
	} else if (exact(layers, ["supported", "basis", "reason"])) {
		if (layers.supported !== false || layers.basis !== "UNAVAILABLE" || !nonEmptyText(layers.reason, 512))
			return "dimensions.layers: unavailable shape";
	} else {
		return "dimensions.layers: unexpected members";
	}

	const tokens = value.tokens;
	if (exact(tokens, ["supported", "tokenCount"])) {
		if (tokens.supported !== true || !count(tokens.tokenCount) || tokens.tokenCount < 1)
			return "dimensions.tokens: supported shape";
	} else if (exact(tokens, ["supported", "basis", "reason"])) {
		if (tokens.supported !== false || tokens.basis !== "UNAVAILABLE" || !nonEmptyText(tokens.reason, 512))
			return "dimensions.tokens: unavailable shape";
	} else {
		return "dimensions.tokens: unexpected members";
	}
	return null;
}

function validateInterpretations(value: unknown, validPointIds: ReadonlySet<string>): string | null {
	if (!Array.isArray(value) || value.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxInterpretations)
		return "interpretations: array";
	for (const note of value) {
		if (!exact(note, ["basis", "author", "pointId", "text"])) return "interpretations: unexpected members";
		if (note.basis !== "INTERPRETED") return "interpretations: basis";
		if (!nonEmptyText(note.author, 128)) return "interpretations: author";
		if (note.pointId !== null && (typeof note.pointId !== "string" || !validPointIds.has(note.pointId)))
			return "interpretations: pointId";
		if (!nonEmptyText(note.text, 512)) return "interpretations: text";
	}
	return null;
}

function validateArtifactMeta(value: unknown, requireSha: boolean): string | null {
	const keys = requireSha
		? ["artifactId", "artifactSha256", "capturedAt", "promptId", "sequenceLength"]
		: ["artifactId", "capturedAt", "promptId", "sequenceLength"];
	if (!exact(value, keys)) return "artifact: unexpected members";
	if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, value.artifactId)) return "artifact: artifactId";
	if (requireSha && !matches(ENDO_OBSERVE_SHA256_PATTERN_V0, value.artifactSha256)) return "artifact: artifactSha256";
	if (!nullableDate(value.capturedAt)) return "artifact: capturedAt";
	if (value.promptId !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, value.promptId))
		return "artifact: promptId";
	if (value.sequenceLength !== null && !(count(value.sequenceLength) && value.sequenceLength > 0))
		return "artifact: sequenceLength";
	return null;
}

/** Validate a capture artifact whole. Returns a problem sentence or null. */
export function endoObserveRepresentationCaptureProblemV0(value: unknown): string | null {
	if (
		!exact(value, [
			"schemaVersion",
			"artifact",
			"subject",
			"backendCapabilities",
			"dimensions",
			"points",
			"interpretations",
		])
	)
		return "capture: unexpected members";
	if (value.schemaVersion !== ENDO_OBSERVE_REPRESENTATION_CAPTURE_SCHEMA_V0) return "capture: schemaVersion";
	const artErr = validateArtifactMeta(value.artifact, false);
	if (artErr !== null) return artErr;
	const subjErr = validateSubject(value.subject);
	if (subjErr !== null) return subjErr;
	const capErr = validateCapabilities(value.backendCapabilities);
	if (capErr !== null) return capErr;
	const dimErr = validateDimensions(value.dimensions);
	if (dimErr !== null) return dimErr;

	const dimensions = value.dimensions as EndoObserveDimensionsV0;
	const layerSet = dimensions.layers.supported ? new Set(dimensions.layers.availableLayers) : null;

	if (
		!Array.isArray(value.points) ||
		value.points.length === 0 ||
		value.points.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxPoints
	)
		return "capture: points";

	let vectorDim: number | null = null;
	const pointIds = new Set<string>();
	const observedLayers = new Set<number>();

	for (const pt of value.points) {
		if (
			!exact(pt, [
				"pointId",
				"sourceIndex",
				"layer",
				"tokenIndex",
				"tokenId",
				"tokenText",
				"eventRef",
				"hookPoint",
				"vector",
				"topNextToken",
			])
		)
			return "capture.point: unexpected members";
		if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, pt.pointId)) return "capture.point: pointId";
		if (pointIds.has(pt.pointId)) return "capture.point: duplicate pointId";
		pointIds.add(pt.pointId);
		if (!count(pt.sourceIndex)) return "capture.point: sourceIndex";
		if (dimensions.layers.supported) {
			if (!count(pt.layer) || !layerSet!.has(pt.layer)) return "capture.point: layer not in availableLayers";
			observedLayers.add(pt.layer);
		} else if (pt.layer !== null) {
			return "capture.point: layer present when layers dimension is unsupported";
		}
		if (dimensions.tokens.supported) {
			if (!count(pt.tokenIndex) || pt.tokenIndex >= dimensions.tokens.tokenCount)
				return "capture.point: tokenIndex out of range";
		} else if (pt.tokenIndex !== null || pt.tokenId !== null || pt.tokenText !== null) {
			return "capture.point: token fields present when tokens dimension is unsupported";
		}
		if (pt.tokenId !== null && !count(pt.tokenId)) return "capture.point: tokenId";
		if (pt.tokenText !== null && (typeof pt.tokenText !== "string" || pt.tokenText.length > 128))
			return "capture.point: tokenText";
		if (pt.eventRef !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, pt.eventRef))
			return "capture.point: eventRef";
		if (!matches(ENDO_OBSERVE_HOOK_PATTERN_V0, pt.hookPoint)) return "capture.point: hookPoint";
		if (
			!Array.isArray(pt.vector) ||
			pt.vector.length < 2 ||
			pt.vector.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxVectorDim ||
			!pt.vector.every(finite)
		)
			return "capture.point: vector";
		if (vectorDim === null) vectorDim = pt.vector.length;
		else if (pt.vector.length !== vectorDim) return "capture.point: inconsistent vector dimensionality";
		const topErr = validateTopNextToken(pt.topNextToken);
		if (topErr !== null) return topErr;
	}

	if (dimensions.layers.supported) {
		for (const layer of dimensions.layers.availableLayers) {
			if (!observedLayers.has(layer)) return "capture: declared availableLayer has no points";
		}
	}

	const interpErr = validateInterpretations(value.interpretations, pointIds);
	if (interpErr !== null) return interpErr;
	return null;
}

export function validateEndoObserveRepresentationCaptureV0(value: unknown): EndoObserveRepresentationCaptureV0 {
	const problem = endoObserveRepresentationCaptureProblemV0(value);
	if (problem !== null) throw new TypeError(`invalid representation capture: ${problem}`);
	return value as EndoObserveRepresentationCaptureV0;
}

function validateSummaryRow(value: unknown): string | null {
	if (
		!exact(value, [
			"selector",
			"state",
			"reason",
			"artifactId",
			"artifactSha256",
			"capturedAt",
			"executionRole",
			"modelId",
			"weightDtype",
			"backendLabel",
			"hookPoint",
			"pointCount",
			"dimensions",
		])
	)
		return "row: unexpected members";
	if (!matches(ENDO_OBSERVE_REPRESENTATION_SELECTOR_PATTERN_V0, value.selector)) return "row: selector";
	if (!oneOf(ENDO_OBSERVE_ARTIFACT_STATES_V0, value.state)) return "row: state";
	if (value.reason !== null && !nonEmptyText(value.reason, 256)) return "row: reason";
	if (value.artifactId !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, value.artifactId))
		return "row: artifactId";
	if (value.artifactSha256 !== null && !matches(ENDO_OBSERVE_SHA256_PATTERN_V0, value.artifactSha256))
		return "row: artifactSha256";
	if (!nullableDate(value.capturedAt)) return "row: capturedAt";
	if (value.executionRole !== null && !oneOf(ENDO_OBSERVE_EXECUTION_ROLES_V0, value.executionRole))
		return "row: executionRole";
	if (value.modelId !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, value.modelId)) return "row: modelId";
	if (value.weightDtype !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, value.weightDtype))
		return "row: weightDtype";
	if (value.backendLabel !== null && !nonEmptyText(value.backendLabel, 128)) return "row: backendLabel";
	if (value.hookPoint !== null && !matches(ENDO_OBSERVE_HOOK_PATTERN_V0, value.hookPoint)) return "row: hookPoint";
	if (!count(value.pointCount)) return "row: pointCount";
	if (value.dimensions !== null) {
		const dimErr = validateDimensions(value.dimensions);
		if (dimErr !== null) return `row.${dimErr}`;
	}
	if (value.state === "readable" && (value.artifactId === null || value.dimensions === null || value.pointCount < 1))
		return "row: readable artifact missing required summary fields";
	if (value.state !== "readable" && value.pointCount !== 0) return "row: unreadable artifact must have 0 points";
	return null;
}

export function validateEndoObserveRepresentationsIndexV0(
	value: unknown,
): EndoObserveRepresentationsIndexV0 | EndoObserveRepresentationsAbsentV0 {
	if (
		exact(value, ["schemaVersion", "available"]) &&
		value.schemaVersion === ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0 &&
		value.available === false
	)
		return value as unknown as EndoObserveRepresentationsAbsentV0;
	if (!exact(value, ["schemaVersion", "available", "artifacts", "skipped"]) || value.available !== true)
		throw new TypeError("not a representations index");
	if (value.schemaVersion !== ENDO_OBSERVE_REPRESENTATIONS_INDEX_SCHEMA_V0)
		throw new TypeError("representations index: schemaVersion");
	if (!Array.isArray(value.artifacts) || value.artifacts.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxFiles)
		throw new TypeError("representations index: artifacts");
	const selectors = new Set<string>();
	for (const row of value.artifacts) {
		const problem = validateSummaryRow(row);
		if (problem !== null) throw new TypeError(`representations index: ${problem}`);
		const r = row as EndoObserveRepresentationSummaryV0;
		if (selectors.has(r.selector)) throw new TypeError("representations index: duplicate selector");
		selectors.add(r.selector);
	}
	if (
		!exact(value.skipped, ["links", "notRegular", "overLimit", "unreadable"]) ||
		![value.skipped.links, value.skipped.notRegular, value.skipped.overLimit, value.skipped.unreadable].every(count)
	)
		throw new TypeError("representations index: skipped");
	return value as unknown as EndoObserveRepresentationsIndexV0;
}

function validateAxis(value: unknown, expectedId: "pc1" | "pc2"): string | null {
	if (!exact(value, ["id", "label", "basis", "eigenvalue", "explainedVarianceRatio"]))
		return "analysis.axis: unexpected members";
	if (value.id !== expectedId) return "analysis.axis: id";
	if (!nonEmptyText(value.label, 64)) return "analysis.axis: label";
	if (value.basis !== "DERIVED") return "analysis.axis: basis";
	if (!finite(value.eigenvalue) || value.eigenvalue < 0) return "analysis.axis: eigenvalue";
	if (
		value.explainedVarianceRatio !== null &&
		(!finite(value.explainedVarianceRatio) ||
			value.explainedVarianceRatio < 0 ||
			value.explainedVarianceRatio > 1.0001)
	)
		return "analysis.axis: explainedVarianceRatio";
	return null;
}

export function validateEndoObserveRepresentationSceneV0(value: unknown): EndoObserveRepresentationSceneV0 {
	if (
		!exact(value, [
			"schemaVersion",
			"projectionVersion",
			"selector",
			"artifact",
			"subject",
			"backendCapabilities",
			"dimensions",
			"selectedLayer",
			"analysis",
			"points",
			"interpretations",
		])
	)
		throw new TypeError("not a representation scene");
	if (value.schemaVersion !== ENDO_OBSERVE_REPRESENTATION_SCENE_SCHEMA_V0)
		throw new TypeError("representation scene: schemaVersion");
	if (value.projectionVersion !== ENDO_OBSERVE_REPRESENTATION_PROJECTION_VERSION_V0)
		throw new TypeError("representation scene: projectionVersion");
	if (!matches(ENDO_OBSERVE_REPRESENTATION_SELECTOR_PATTERN_V0, value.selector))
		throw new TypeError("representation scene: selector");
	const artErr = validateArtifactMeta(value.artifact, true);
	if (artErr !== null) throw new TypeError(`representation scene: ${artErr}`);
	const subjErr = validateSubject(value.subject);
	if (subjErr !== null) throw new TypeError(`representation scene: ${subjErr}`);
	const capErr = validateCapabilities(value.backendCapabilities);
	if (capErr !== null) throw new TypeError(`representation scene: ${capErr}`);
	const dimErr = validateDimensions(value.dimensions);
	if (dimErr !== null) throw new TypeError(`representation scene: ${dimErr}`);

	const dimensions = value.dimensions as EndoObserveDimensionsV0;
	if (dimensions.layers.supported) {
		if (
			value.selectedLayer !== "all" &&
			(!count(value.selectedLayer) || !dimensions.layers.availableLayers.includes(value.selectedLayer))
		)
			throw new TypeError("representation scene: selectedLayer");
	} else if (value.selectedLayer !== null) {
		throw new TypeError("representation scene: selectedLayer must be null when layers unsupported");
	}

	const analysis = value.analysis;
	if (
		!exact(analysis, [
			"method",
			"revision",
			"basis",
			"centering",
			"scaling",
			"signCanonicalization",
			"inputPointCount",
			"inputVectorDim",
			"totalVariance",
			"axes",
			"varianceExplainedTotal",
			"degenerate",
			"note",
		])
	)
		throw new TypeError("representation scene: analysis members");
	if (
		analysis.method !== "pca-2d-householder-ql" ||
		analysis.revision !== "v0" ||
		analysis.basis !== "DERIVED" ||
		analysis.centering !== "mean-centered" ||
		analysis.scaling !== "unscaled" ||
		analysis.signCanonicalization !== "max-abs-positive"
	)
		throw new TypeError("representation scene: analysis metadata");
	if (!count(analysis.inputPointCount) || analysis.inputPointCount < 1)
		throw new TypeError("representation scene: inputPointCount");
	if (!count(analysis.inputVectorDim) || analysis.inputVectorDim < 2)
		throw new TypeError("representation scene: inputVectorDim");
	if (!finite(analysis.totalVariance) || analysis.totalVariance < 0)
		throw new TypeError("representation scene: totalVariance");
	if (!Array.isArray(analysis.axes) || analysis.axes.length !== 2) throw new TypeError("representation scene: axes");
	const ax0 = validateAxis(analysis.axes[0], "pc1");
	const ax1 = validateAxis(analysis.axes[1], "pc2");
	if (ax0 !== null || ax1 !== null) throw new TypeError(`representation scene: ${ax0 ?? ax1}`);
	if (
		analysis.varianceExplainedTotal !== null &&
		(!finite(analysis.varianceExplainedTotal) ||
			analysis.varianceExplainedTotal < 0 ||
			analysis.varianceExplainedTotal > 1.0001)
	)
		throw new TypeError("representation scene: varianceExplainedTotal");
	if (typeof analysis.degenerate !== "boolean" || !nonEmptyText(analysis.note, 512))
		throw new TypeError("representation scene: degenerate or note");

	if (
		!Array.isArray(value.points) ||
		value.points.length !== analysis.inputPointCount ||
		value.points.length > ENDO_OBSERVE_REPRESENTATION_LIMITS_V0.maxPoints
	)
		throw new TypeError("representation scene: points");

	const pointIds = new Set<string>();
	for (const pt of value.points) {
		if (
			!exact(pt, [
				"pointId",
				"sourceIndex",
				"hookPoint",
				"layer",
				"tokenIndex",
				"tokenId",
				"tokenText",
				"eventRef",
				"observed",
				"derived",
			])
		)
			throw new TypeError("representation scene: point members");
		if (!matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, pt.pointId) || pointIds.has(pt.pointId))
			throw new TypeError("representation scene: pointId");
		pointIds.add(pt.pointId);
		if (!count(pt.sourceIndex)) throw new TypeError("representation scene: sourceIndex");
		if (!matches(ENDO_OBSERVE_HOOK_PATTERN_V0, pt.hookPoint)) throw new TypeError("representation scene: hookPoint");
		if (dimensions.layers.supported) {
			if (!count(pt.layer) || !dimensions.layers.availableLayers.includes(pt.layer))
				throw new TypeError("representation scene: point layer");
			if (typeof value.selectedLayer === "number" && pt.layer !== value.selectedLayer)
				throw new TypeError("representation scene: point layer does not match selectedLayer");
		} else if (pt.layer !== null) {
			throw new TypeError("representation scene: unexpected point layer");
		}
		if (dimensions.tokens.supported) {
			if (!count(pt.tokenIndex) || pt.tokenIndex >= dimensions.tokens.tokenCount)
				throw new TypeError("representation scene: point tokenIndex");
		} else if (pt.tokenIndex !== null || pt.tokenId !== null || pt.tokenText !== null) {
			throw new TypeError("representation scene: unexpected token fields");
		}
		if (pt.tokenId !== null && !count(pt.tokenId)) throw new TypeError("representation scene: point tokenId");
		if (pt.tokenText !== null && (typeof pt.tokenText !== "string" || pt.tokenText.length > 128))
			throw new TypeError("representation scene: point tokenText");
		if (pt.eventRef !== null && !matches(ENDO_OBSERVE_IDENTIFIER_PATTERN_V0, pt.eventRef))
			throw new TypeError("representation scene: point eventRef");

		const obs = pt.observed;
		if (!exact(obs, ["basis", "vectorDim", "l2Norm", "mean", "std", "min", "max", "topNextToken"]))
			throw new TypeError("representation scene: observed members");
		if (
			obs.basis !== "OBSERVED" ||
			obs.vectorDim !== analysis.inputVectorDim ||
			!finite(obs.l2Norm) ||
			obs.l2Norm < 0 ||
			!finite(obs.mean) ||
			!finite(obs.std) ||
			obs.std < 0 ||
			!finite(obs.min) ||
			!finite(obs.max) ||
			obs.min > obs.max
		)
			throw new TypeError("representation scene: observed values");
		const topErr = validateTopNextToken(obs.topNextToken);
		if (topErr !== null) throw new TypeError(`representation scene: ${topErr}`);

		const der = pt.derived;
		if (!exact(der, ["basis", "x", "y", "distanceFromMean", "residual2dFraction"]))
			throw new TypeError("representation scene: derived members");
		if (
			der.basis !== "DERIVED" ||
			!finite(der.x) ||
			!finite(der.y) ||
			!finite(der.distanceFromMean) ||
			der.distanceFromMean < 0 ||
			(der.residual2dFraction !== null &&
				(!finite(der.residual2dFraction) || der.residual2dFraction < 0 || der.residual2dFraction > 1.0001))
		)
			throw new TypeError("representation scene: derived values");
	}

	const interpErr = validateInterpretations(value.interpretations, pointIds);
	if (interpErr !== null) throw new TypeError(`representation scene: ${interpErr}`);
	return value as unknown as EndoObserveRepresentationSceneV0;
}
