// Deterministic Representation Explorer projection (OBSERVE-GEOMETRY-001):
// transforms a validated `endo.observe-representation-capture.v0` into a typed `endo.observe-representation-scene.v0`.
//
// Pure, deterministic, stateless: no filesystem, no clock, no randomness, no DOM.
// Epistemic invariant: OBSERVED statistics are computed directly from each point's recorded vector; DERIVED 2D
// coordinates come from mean-centered PCA via deterministic cyclic Jacobi eigendecomposition with `max-abs-positive`
// sign canonicalization; INTERPRETED annotations are passed through verbatim and never auto-generated; UNAVAILABLE
// signals and unsupported dimensions are preserved explicitly without fabrication.

import {
	ENDO_OBSERVE_REPRESENTATION_PROJECTION_VERSION_V0,
	ENDO_OBSERVE_REPRESENTATION_SCENE_SCHEMA_V0,
	type EndoObserveCapturePointV0,
	type EndoObserveRepresentationCaptureV0,
	type EndoObserveRepresentationSceneV0,
	type EndoObserveScenePointV0,
	validateEndoObserveRepresentationCaptureV0,
	validateEndoObserveRepresentationSceneV0,
} from "../../protocol/observe-representation.ts";

export interface Pca2dResultV0 {
	readonly coords: readonly (readonly [number, number])[];
	readonly eigenvalues: readonly [number, number];
	readonly totalVariance: number;
	readonly explainedVarianceRatio: readonly [number | null, number | null];
	readonly varianceExplainedTotal: number | null;
	readonly distancesFromMean: readonly number[];
	readonly residual2dFractions: readonly (number | null)[];
	readonly degenerate: boolean;
}

const ZERO_EPS = 1e-12;

function snapZero(value: number): number {
	return Math.abs(value) < ZERO_EPS ? 0 : value;
}

/** Deterministic sign canonicalization: make the largest-magnitude entry (tie-broken by earliest index) positive. */
function canonicalizeSign(values: number[]): number[] {
	let bestIndex = -1;
	let bestAbs = 0;
	for (let i = 0; i < values.length; i += 1) {
		const mag = Math.abs(values[i]!);
		if (mag > bestAbs + ZERO_EPS) {
			bestAbs = mag;
			bestIndex = i;
		}
	}
	const flip = bestIndex !== -1 && values[bestIndex]! < 0 ? -1 : 1;
	return values.map((v) => snapZero(v * flip));
}

/**
 * Deterministic classical Jacobi eigendecomposition for a real symmetric `m x m` matrix.
 * Returns `{ eigenvalues, eigenvectors }` where `eigenvectors[col][row]` is the `col`-th unit eigenvector.
 */
function jacobiSymmetricEigen(matrix: number[][]): { eigenvalues: number[]; eigenvectors: number[][] } {
	const m = matrix.length;
	const a = matrix.map((row) => row.slice());
	const v: number[][] = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (__, j) => (i === j ? 1 : 0)));
	let scale = 0;
	for (let i = 0; i < m; i += 1) {
		for (let j = 0; j < m; j += 1) {
			const mag = Math.abs(a[i]![j]!);
			if (mag > scale) scale = mag;
		}
	}
	const tol = Math.max(ZERO_EPS, scale * 1e-13);
	const maxIterations = Math.max(50, 50 * m * m);

	for (let iter = 0; iter < maxIterations; iter += 1) {
		let p = 0;
		let q = 1;
		let maxOff = 0;
		for (let i = 0; i < m; i += 1) {
			for (let j = i + 1; j < m; j += 1) {
				const mag = Math.abs(a[i]![j]!);
				if (mag > maxOff) {
					maxOff = mag;
					p = i;
					q = j;
				}
			}
		}
		if (maxOff <= tol) break;

		const app = a[p]![p]!;
		const aqq = a[q]![q]!;
		const apq = a[p]![q]!;
		const tau = (aqq - app) / (2 * apq);
		const t = tau >= 0 ? 1 / (tau + Math.sqrt(1 + tau * tau)) : -1 / (-tau + Math.sqrt(1 + tau * tau));
		const c = 1 / Math.sqrt(1 + t * t);
		const s = t * c;

		a[p]![p] = app - t * apq;
		a[q]![q] = aqq + t * apq;
		a[p]![q] = 0;
		a[q]![p] = 0;

		for (let k = 0; k < m; k += 1) {
			if (k === p || k === q) continue;
			const akp = a[k]![p]!;
			const akq = a[k]![q]!;
			a[k]![p] = c * akp - s * akq;
			a[p]![k] = a[k]![p]!;
			a[k]![q] = s * akp + c * akq;
			a[q]![k] = a[k]![q]!;
		}
		for (let k = 0; k < m; k += 1) {
			const vkp = v[k]![p]!;
			const vkq = v[k]![q]!;
			v[k]![p] = c * vkp - s * vkq;
			v[k]![q] = s * vkp + c * vkq;
		}
	}

	const eigenvalues = Array.from({ length: m }, (_, i) => {
		const raw = a[i]![i]!;
		return raw < ZERO_EPS ? 0 : raw;
	});
	const eigenvectors = Array.from({ length: m }, (_, col) => Array.from({ length: m }, (__, row) => v[row]![col]!));
	return { eigenvalues, eigenvectors };
}

/**
 * Exact, deterministic mean-centered 2D PCA over `N >= 1` vectors in `R^D` (`D >= 2`).
 * Uses the `N x N` Gram matrix when `N <= D` and the `D x D` covariance matrix when `D < N`.
 */
export function computePca2dV0(vectors: readonly (readonly number[])[]): Pca2dResultV0 {
	const n = vectors.length;
	if (n < 1) throw new TypeError("PCA requires at least 1 vector");
	const d = vectors[0]!.length;
	if (d < 2) throw new TypeError("PCA requires vectors of dimension >= 2");
	for (let i = 0; i < n; i += 1) {
		const row = vectors[i]!;
		if (row.length !== d) throw new TypeError("all vectors must have equal dimension");
		for (let j = 0; j < d; j += 1) {
			if (!Number.isFinite(row[j])) throw new TypeError("all vector entries must be finite numbers");
		}
	}

	// Mean-center the observed vectors.
	const mean = new Array<number>(d).fill(0);
	for (let i = 0; i < n; i += 1) {
		const row = vectors[i]!;
		for (let j = 0; j < d; j += 1) mean[j]! += row[j];
	}
	for (let j = 0; j < d; j += 1) mean[j]! /= n;

	const centered: number[][] = new Array(n);
	const distancesFromMean = new Array<number>(n);
	let sumSqNorm = 0;
	for (let i = 0; i < n; i += 1) {
		const row = vectors[i]!;
		const c = new Array<number>(d);
		let sq = 0;
		for (let j = 0; j < d; j += 1) {
			const diff = row[j]! - mean[j]!;
			c[j] = diff;
			sq += diff * diff;
		}
		centered[i] = c;
		distancesFromMean[i] = snapZero(Math.sqrt(sq));
		sumSqNorm += sq;
	}
	const totalVariance = snapZero(sumSqNorm / n);

	if (n === 1 || totalVariance === 0) {
		return {
			coords: Array.from({ length: n }, () => [0, 0] as const),
			eigenvalues: [0, 0],
			totalVariance,
			explainedVarianceRatio: [null, null],
			varianceExplainedTotal: null,
			distancesFromMean,
			residual2dFractions: Array.from({ length: n }, () => null),
			degenerate: true,
		};
	}

	const components: { eigenvalue: number; scores: number[] }[] = [];

	if (n <= d) {
		// Dual form: Gram matrix G = (1/N) X_c X_c^T (N x N).
		const gram: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
		for (let i = 0; i < n; i += 1) {
			const ci = centered[i]!;
			for (let j = i; j < n; j += 1) {
				const cj = centered[j]!;
				let dot = 0;
				for (let k = 0; k < d; k += 1) dot += ci[k]! * cj[k]!;
				const val = dot / n;
				gram[i]![j] = val;
				gram[j]![i] = val;
			}
		}
		const { eigenvalues, eigenvectors } = jacobiSymmetricEigen(gram);
		for (let idx = 0; idx < n; idx += 1) {
			const lambda = eigenvalues[idx]!;
			const scale = Math.sqrt(n * lambda);
			const rawScores = eigenvectors[idx]!.map((u) => u * scale);
			components.push({ eigenvalue: snapZero(lambda), scores: canonicalizeSign(rawScores) });
		}
	} else {
		// Primal form: covariance matrix S = (1/N) X_c^T X_c (D x D).
		const cov: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
		for (let i = 0; i < n; i += 1) {
			const ci = centered[i]!;
			for (let j = 0; j < d; j += 1) {
				const cij = ci[j]!;
				for (let k = j; k < d; k += 1) cov[j]![k]! += cij * ci[k]!;
			}
		}
		for (let j = 0; j < d; j += 1) {
			for (let k = j; k < d; k += 1) {
				const val = cov[j]![k]! / n;
				cov[j]![k] = val;
				cov[k]![j] = val;
			}
		}
		const { eigenvalues, eigenvectors } = jacobiSymmetricEigen(cov);
		for (let idx = 0; idx < d; idx += 1) {
			const lambda = eigenvalues[idx]!;
			const v = eigenvectors[idx]!;
			const rawScores = new Array<number>(n);
			for (let i = 0; i < n; i += 1) {
				const ci = centered[i]!;
				let dot = 0;
				for (let j = 0; j < d; j += 1) dot += ci[j]! * v[j]!;
				rawScores[i] = dot;
			}
			components.push({ eigenvalue: snapZero(lambda), scores: canonicalizeSign(rawScores) });
		}
	}

	// Deterministic sort: descending eigenvalue, tie-breaking lexicographically on canonicalized scores.
	components.sort((a, b) => {
		if (Math.abs(b.eigenvalue - a.eigenvalue) > ZERO_EPS) return b.eigenvalue - a.eigenvalue;
		for (let i = 0; i < n; i += 1) {
			const diff = b.scores[i]! - a.scores[i]!;
			if (Math.abs(diff) > ZERO_EPS) return diff;
		}
		return 0;
	});

	const c1 = components[0] ?? { eigenvalue: 0, scores: new Array<number>(n).fill(0) };
	const c2 = components[1] ?? { eigenvalue: 0, scores: new Array<number>(n).fill(0) };
	const l1 = c1.eigenvalue;
	const l2 = c2.eigenvalue;
	const r1 = totalVariance > 0 ? Math.min(1, l1 / totalVariance) : null;
	const r2 = totalVariance > 0 ? Math.min(1, l2 / totalVariance) : null;
	const varianceExplainedTotal = r1 !== null && r2 !== null ? Math.min(1, r1 + r2) : null;

	const coords: (readonly [number, number])[] = new Array(n);
	const residual2dFractions: (number | null)[] = new Array(n);
	for (let i = 0; i < n; i += 1) {
		const x = snapZero(c1.scores[i]!);
		const y = snapZero(c2.scores[i]!);
		coords[i] = [x, y];
		const dist = distancesFromMean[i]!;
		if (dist <= ZERO_EPS) {
			residual2dFractions[i] = null;
		} else {
			const sqFull = dist * dist;
			const sq2d = x * x + y * y;
			const frac = 1 - sq2d / sqFull;
			residual2dFractions[i] = snapZero(Math.max(0, Math.min(1, frac)));
		}
	}

	return {
		coords,
		eigenvalues: [l1, l2],
		totalVariance,
		explainedVarianceRatio: [r1 === null ? null : snapZero(r1), r2 === null ? null : snapZero(r2)],
		varianceExplainedTotal: varianceExplainedTotal === null ? null : snapZero(varianceExplainedTotal),
		distancesFromMean,
		residual2dFractions,
		degenerate: l1 === 0 || l2 === 0,
	};
}

function vectorObservedStats(vector: readonly number[]): {
	l2Norm: number;
	mean: number;
	std: number;
	min: number;
	max: number;
} {
	const d = vector.length;
	let sum = 0;
	let sumSq = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (let j = 0; j < d; j += 1) {
		const v = vector[j]!;
		sum += v;
		sumSq += v * v;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const mean = sum / d;
	let varSum = 0;
	for (let j = 0; j < d; j += 1) {
		const diff = vector[j]! - mean;
		varSum += diff * diff;
	}
	return {
		l2Norm: snapZero(Math.sqrt(sumSq)),
		mean: snapZero(mean),
		std: snapZero(Math.sqrt(varSum / d)),
		min: snapZero(min),
		max: snapZero(max),
	};
}

export interface ProjectRepresentationSceneInputV0 {
	capture: EndoObserveRepresentationCaptureV0;
	selector: string;
	artifactSha256: string;
	/** Optional layer filter. Permitted ONLY when `capture.dimensions.layers.supported === true`. */
	layer?: number | "all";
}

/**
 * Project a validated representation capture into a deterministic 2D Observe scene.
 * Refuses unsupported layer selections rather than fabricating or silently falling back.
 */
export function projectEndoObserveRepresentationSceneV0(
	input: ProjectRepresentationSceneInputV0,
): EndoObserveRepresentationSceneV0 {
	const capture = validateEndoObserveRepresentationCaptureV0(input.capture);
	const { dimensions } = capture;

	let selectedLayer: number | "all" | null;
	if (dimensions.layers.supported) {
		if (input.layer === undefined) {
			selectedLayer = dimensions.layers.defaultLayer;
		} else if (input.layer === "all") {
			selectedLayer = "all";
		} else if (
			typeof input.layer === "number" &&
			Number.isSafeInteger(input.layer) &&
			dimensions.layers.availableLayers.includes(input.layer)
		) {
			selectedLayer = input.layer;
		} else {
			throw new TypeError(`requested layer ${String(input.layer)} is not present in this capture`);
		}
	} else {
		if (input.layer !== undefined) {
			throw new TypeError("layer selection is unavailable for this artifact");
		}
		selectedLayer = null;
	}

	// Deterministic ordering by sourceIndex, then pointId.
	const filtered: EndoObserveCapturePointV0[] = capture.points
		.filter((pt) => (typeof selectedLayer === "number" ? pt.layer === selectedLayer : true))
		.slice()
		.sort((a, b) =>
			a.sourceIndex !== b.sourceIndex ? a.sourceIndex - b.sourceIndex : a.pointId < b.pointId ? -1 : 1,
		);

	if (filtered.length === 0) throw new TypeError("no points match the requested layer selection");

	const pca = computePca2dV0(filtered.map((pt) => pt.vector));
	const inputVectorDim = filtered[0]!.vector.length;

	const points: EndoObserveScenePointV0[] = filtered.map((pt, index) => {
		const stats = vectorObservedStats(pt.vector);
		const [x, y] = pca.coords[index]!;
		return {
			pointId: pt.pointId,
			sourceIndex: pt.sourceIndex,
			hookPoint: pt.hookPoint,
			layer: pt.layer,
			tokenIndex: pt.tokenIndex,
			tokenId: pt.tokenId,
			tokenText: pt.tokenText,
			eventRef: pt.eventRef,
			observed: {
				basis: "OBSERVED",
				vectorDim: inputVectorDim,
				l2Norm: stats.l2Norm,
				mean: stats.mean,
				std: stats.std,
				min: stats.min,
				max: stats.max,
				topNextToken: pt.topNextToken,
			},
			derived: {
				basis: "DERIVED",
				x,
				y,
				distanceFromMean: pca.distancesFromMean[index]!,
				residual2dFraction: pca.residual2dFractions[index]!,
			},
		};
	});

	const visibleIds = new Set(points.map((pt) => pt.pointId));
	const interpretations = capture.interpretations.filter(
		(note) => note.pointId === null || visibleIds.has(note.pointId),
	);

	const note = pca.degenerate
		? "Mean-centered 2D PCA is degenerate (fewer than two linearly independent variance directions in this slice). Zero-variance axes carry no geometric separation."
		: "Mean-centered 2D PCA over full observed vectors. 2D Euclidean distance is a lower bound on full-space distance and does not establish semantic concepts or clusters.";

	const scene: EndoObserveRepresentationSceneV0 = {
		schemaVersion: ENDO_OBSERVE_REPRESENTATION_SCENE_SCHEMA_V0,
		projectionVersion: ENDO_OBSERVE_REPRESENTATION_PROJECTION_VERSION_V0,
		selector: input.selector,
		artifact: {
			artifactId: capture.artifact.artifactId,
			artifactSha256: input.artifactSha256,
			capturedAt: capture.artifact.capturedAt,
			promptId: capture.artifact.promptId,
			sequenceLength: capture.artifact.sequenceLength,
		},
		subject: capture.subject,
		backendCapabilities: capture.backendCapabilities,
		dimensions: capture.dimensions,
		selectedLayer,
		analysis: {
			method: "pca-2d-jacobi",
			revision: "v0",
			basis: "DERIVED",
			centering: "mean-centered",
			scaling: "unscaled",
			signCanonicalization: "max-abs-positive",
			inputPointCount: points.length,
			inputVectorDim,
			totalVariance: pca.totalVariance,
			axes: [
				{
					id: "pc1",
					label: "PC1",
					basis: "DERIVED",
					eigenvalue: pca.eigenvalues[0],
					explainedVarianceRatio: pca.explainedVarianceRatio[0],
				},
				{
					id: "pc2",
					label: "PC2",
					basis: "DERIVED",
					eigenvalue: pca.eigenvalues[1],
					explainedVarianceRatio: pca.explainedVarianceRatio[1],
				},
			],
			varianceExplainedTotal: pca.varianceExplainedTotal,
			degenerate: pca.degenerate,
			note,
		},
		points,
		interpretations,
	};

	return validateEndoObserveRepresentationSceneV0(scene);
}
