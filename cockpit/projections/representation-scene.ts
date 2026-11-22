// Deterministic Representation Explorer projection (OBSERVE-GEOMETRY-001):
// transforms a validated `endo.observe-representation-capture.v0` into a typed `endo.observe-representation-scene.v0`.
//
// Pure, deterministic, stateless: no filesystem, no clock, no randomness, no DOM.
// Epistemic invariant: OBSERVED statistics are computed directly from each point's recorded vector; DERIVED 2D
// coordinates come from scale-normalized mean-centered PCA via deterministic Householder tridiagonalization and
// implicit QL (Wilkinson shift) with `max-abs-positive` sign canonicalization; INTERPRETED annotations are passed
// through verbatim and never auto-generated; UNAVAILABLE signals and unsupported dimensions are preserved explicitly
// without fabrication.

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

const REL_EPS = 1e-12;

function normalizeZero(value: number): number {
	return value === 0 ? 0 : value;
}

function snapRelative(value: number, scale: number): number {
	return Math.abs(value) <= scale * REL_EPS ? 0 : normalizeZero(value);
}

/** Deterministic sign canonicalization: make the largest-magnitude entry (tie-broken by earliest index) positive. */
function canonicalizeSign(values: number[]): number[] {
	let bestIndex = -1;
	let bestAbs = 0;
	for (let i = 0; i < values.length; i += 1) {
		const mag = Math.abs(values[i]!);
		if (mag > bestAbs) {
			bestAbs = mag;
			bestIndex = i;
		}
	}
	if (bestAbs === 0) return values.map(() => 0);
	const tieTol = bestAbs * REL_EPS;
	for (let i = 0; i < values.length; i += 1) {
		if (Math.abs(Math.abs(values[i]!) - bestAbs) <= tieTol) {
			bestIndex = i;
			break;
		}
	}
	const flip = bestIndex !== -1 && values[bestIndex]! < 0 ? -1 : 1;
	return values.map((v) => snapRelative(v * flip, bestAbs));
}

/**
 * Deterministic O(m^3) exact symmetric eigensolver: Householder tridiagonalization (`tred2`) followed by
 * implicit QL with Wilkinson shift (`tql2`). Uses flat `Float64Array` storage with column-major eigenvector
 * layout for contiguous memory access during rotations.
 *
 * Expects a trace-normalized symmetric matrix (`m >= 1`). Returns `{ eigenvalues, eigenvectors }` where
 * `eigenvectors[col]` is the `col`-th unit eigenvector (`Float64Array` view of length `m`).
 */
function symmetricEigenHouseholderQl(
	matrix: Float64Array,
	m: number,
): { eigenvalues: Float64Array; eigenvectors: Float64Array } {
	const a = new Float64Array(matrix);
	const d = new Float64Array(m);
	const e = new Float64Array(m);

	// Householder reduction to symmetric tridiagonal form (EISPACK tred2).
	for (let i = m - 1; i > 0; i -= 1) {
		const l = i - 1;
		let h = 0;
		let scale = 0;
		const im = i * m;
		if (l > 0) {
			for (let k = 0; k <= l; k += 1) scale += Math.abs(a[im + k]!);
			if (scale === 0) {
				e[i] = a[im + l]!;
			} else {
				for (let k = 0; k <= l; k += 1) {
					const val = a[im + k]! / scale;
					a[im + k] = val;
					h += val * val;
				}
				let f = a[im + l]!;
				let g = f >= 0 ? -Math.sqrt(h) : Math.sqrt(h);
				e[i] = scale * g;
				h -= f * g;
				a[im + l] = f - g;
				f = 0;
				for (let j = 0; j <= l; j += 1) {
					a[j * m + i] = a[im + j]! / h;
					g = 0;
					const jm = j * m;
					for (let k = 0; k <= j; k += 1) g += a[jm + k]! * a[im + k]!;
					for (let k = j + 1; k <= l; k += 1) g += a[k * m + j]! * a[im + k]!;
					e[j] = g / h;
					f += e[j]! * a[im + j]!;
				}
				const hh = f / (h + h);
				for (let j = 0; j <= l; j += 1) {
					f = a[im + j]!;
					g = e[j]! - hh * f;
					e[j] = g;
					const jm = j * m;
					for (let k = 0; k <= j; k += 1) {
						a[jm + k] = a[jm + k]! - (f * e[k]! + g * a[im + k]!);
					}
				}
			}
		} else {
			e[i] = a[im + l]!;
		}
		d[i] = h;
	}
	d[0] = 0;
	e[0] = 0;

	// Accumulate Householder reflections into Q stored column-major: eigenvector `col` is `q[col*m .. col*m+m-1]`.
	const q = new Float64Array(m * m);
	for (let i = 0; i < m; i += 1) {
		const l = i - 1;
		const im = i * m;
		if (d[i]! !== 0) {
			const u = new Float64Array(i);
			const w = new Float64Array(i);
			for (let k = 0; k <= l; k += 1) {
				u[k] = a[im + k]!;
				w[k] = a[k * m + i]!;
			}
			for (let j = 0; j <= l; j += 1) {
				const qj = j * m;
				let g = 0;
				for (let k = 0; k <= l; k += 1) g += u[k]! * q[qj + k]!;
				for (let k = 0; k <= l; k += 1) q[qj + k] = q[qj + k]! - g * w[k]!;
			}
		}
		d[i] = a[im + i]!;
		q[i * m + i] = 1;
	}

	// Implicit QL algorithm with Wilkinson shift (EISPACK tql2).
	for (let i = 1; i < m; i += 1) e[i - 1] = e[i]!;
	e[m - 1] = 0;

	for (let l = 0; l < m; l += 1) {
		let iter = 0;
		let mIdx = l;
		do {
			for (mIdx = l; mIdx < m - 1; mIdx += 1) {
				const dd = Math.abs(d[mIdx]!) + Math.abs(d[mIdx + 1]!);
				if (Math.abs(e[mIdx]!) + dd === dd) break;
			}
			if (mIdx !== l) {
				iter += 1;
				if (iter > 60) break;
				let g = (d[l + 1]! - d[l]!) / (2 * e[l]!);
				let r = Math.hypot(g, 1);
				g = d[mIdx]! - d[l]! + e[l]! / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
				let s = 1;
				let c = 1;
				let p = 0;
				let i = mIdx - 1;
				for (; i >= l; i -= 1) {
					const f = s * e[i]!;
					const b = c * e[i]!;
					r = Math.hypot(f, g);
					e[i + 1] = r;
					if (r === 0) {
						d[i + 1] = d[i + 1]! - p;
						e[mIdx] = 0;
						break;
					}
					s = f / r;
					c = g / r;
					g = d[i + 1]! - p;
					r = (d[i]! - g) * s + 2 * c * b;
					p = s * r;
					d[i + 1] = g + p;
					g = c * r - b;
					const qi = i * m;
					const qi1 = (i + 1) * m;
					for (let k = 0; k < m; k += 1) {
						const qk1 = q[qi1 + k]!;
						const qk0 = q[qi + k]!;
						q[qi1 + k] = s * qk0 + c * qk1;
						q[qi + k] = c * qk0 - s * qk1;
					}
				}
				if (r === 0 && i >= l) continue;
				d[l] = d[l]! - p;
				e[l] = g;
				e[mIdx] = 0;
			}
		} while (mIdx !== l);
	}

	return { eigenvalues: d, eigenvectors: q };
}

/**
 * Exact, deterministic, scale-invariant mean-centered 2D PCA over `N >= 1` vectors in `R^D` (`D >= 2`).
 * Normalizes centered vectors internally by `maxAbsCentered` and trace before eigendecomposition so small-magnitude
 * vectors (e.g. `1e-6`) retain full geometric fidelity without absolute-threshold underflow.
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

	// Mean-center the observed vectors and find the maximum absolute centered coordinate for scale invariance.
	const mean = new Float64Array(d);
	for (let i = 0; i < n; i += 1) {
		const row = vectors[i]!;
		for (let j = 0; j < d; j += 1) mean[j] = mean[j]! + row[j]!;
	}
	for (let j = 0; j < d; j += 1) mean[j] = mean[j]! / n;

	const centered: Float64Array[] = new Array(n);
	let maxAbsCentered = 0;
	for (let i = 0; i < n; i += 1) {
		const row = vectors[i]!;
		const c = new Float64Array(d);
		for (let j = 0; j < d; j += 1) {
			const diff = row[j]! - mean[j]!;
			c[j] = diff;
			const mag = Math.abs(diff);
			if (mag > maxAbsCentered) maxAbsCentered = mag;
		}
		centered[i] = c;
	}

	if (n === 1 || maxAbsCentered === 0) {
		return {
			coords: Array.from({ length: n }, () => [0, 0] as const),
			eigenvalues: [0, 0],
			totalVariance: 0,
			explainedVarianceRatio: [null, null],
			varianceExplainedTotal: null,
			distancesFromMean: Array.from({ length: n }, () => 0),
			residual2dFractions: Array.from({ length: n }, () => null),
			degenerate: true,
		};
	}

	// Scale centered vectors by `maxAbsCentered` so all entries lie in [-1, 1] with zero underflow/overflow.
	const scaled: Float64Array[] = new Array(n);
	const scaledSqNorms = new Float64Array(n);
	const distancesFromMean = new Array<number>(n);
	let scaledSumSq = 0;
	for (let i = 0; i < n; i += 1) {
		const c = centered[i]!;
		const sc = new Float64Array(d);
		let sq = 0;
		for (let j = 0; j < d; j += 1) {
			const val = c[j]! / maxAbsCentered;
			sc[j] = val;
			sq += val * val;
		}
		scaled[i] = sc;
		scaledSqNorms[i] = sq;
		distancesFromMean[i] = normalizeZero(maxAbsCentered * Math.sqrt(sq));
		scaledSumSq += sq;
	}

	const scaledTotalVariance = scaledSumSq / n;
	const totalVariance = normalizeZero(maxAbsCentered * maxAbsCentered * scaledTotalVariance);
	const rmsScale = maxAbsCentered * Math.sqrt(scaledTotalVariance);

	const components: { ratio: number; scaledScores: number[] }[] = [];

	if (n <= d) {
		// Dual form: trace-normalized Gram matrix G_norm = (1 / (N * scaledTotalVariance)) * X_s X_s^T (N x N).
		const invNorm = 1 / (n * scaledTotalVariance);
		const gram = new Float64Array(n * n);
		for (let i = 0; i < n; i += 1) {
			const si = scaled[i]!;
			for (let j = i; j < n; j += 1) {
				const sj = scaled[j]!;
				let dot = 0;
				for (let k = 0; k < d; k += 1) dot += si[k]! * sj[k]!;
				const val = dot * invNorm;
				gram[i * n + j] = val;
				gram[j * n + i] = val;
			}
		}
		const { eigenvalues, eigenvectors } = symmetricEigenHouseholderQl(gram, n);
		for (let idx = 0; idx < n; idx += 1) {
			const rawRatio = eigenvalues[idx]!;
			const ratio = rawRatio <= REL_EPS ? 0 : Math.min(1, rawRatio);
			const scoreFactor = Math.sqrt(n * ratio);
			const offset = idx * n;
			const rawScores = new Array<number>(n);
			for (let i = 0; i < n; i += 1) rawScores[i] = eigenvectors[offset + i]! * scoreFactor;
			components.push({ ratio, scaledScores: canonicalizeSign(rawScores) });
		}
	} else {
		// Primal form: trace-normalized covariance matrix S_norm = (1 / (N * scaledTotalVariance)) * X_s^T X_s (D x D).
		const invNorm = 1 / (n * scaledTotalVariance);
		const cov = new Float64Array(d * d);
		for (let i = 0; i < n; i += 1) {
			const si = scaled[i]!;
			for (let j = 0; j < d; j += 1) {
				const sij = si[j]!;
				const jd = j * d;
				for (let k = j; k < d; k += 1) cov[jd + k] = cov[jd + k]! + sij * si[k]!;
			}
		}
		for (let j = 0; j < d; j += 1) {
			const jd = j * d;
			for (let k = j; k < d; k += 1) {
				const val = cov[jd + k]! * invNorm;
				cov[jd + k] = val;
				cov[k * d + j] = val;
			}
		}
		const { eigenvalues, eigenvectors } = symmetricEigenHouseholderQl(cov, d);
		const invSqrtVar = 1 / Math.sqrt(scaledTotalVariance);
		for (let idx = 0; idx < d; idx += 1) {
			const rawRatio = eigenvalues[idx]!;
			const ratio = rawRatio <= REL_EPS ? 0 : Math.min(1, rawRatio);
			const offset = idx * d;
			const rawScores = new Array<number>(n);
			if (ratio === 0) {
				rawScores.fill(0);
			} else {
				for (let i = 0; i < n; i += 1) {
					const si = scaled[i]!;
					let dot = 0;
					for (let j = 0; j < d; j += 1) dot += si[j]! * eigenvectors[offset + j]!;
					rawScores[i] = dot * invSqrtVar;
				}
			}
			components.push({ ratio, scaledScores: canonicalizeSign(rawScores) });
		}
	}

	// Deterministic sort: descending relative variance ratio, tie-breaking lexicographically on canonicalized scores.
	components.sort((a, b) => {
		if (Math.abs(b.ratio - a.ratio) > REL_EPS) return b.ratio - a.ratio;
		for (let i = 0; i < n; i += 1) {
			const diff = b.scaledScores[i]! - a.scaledScores[i]!;
			if (Math.abs(diff) > REL_EPS) return diff;
		}
		return 0;
	});

	const c1 = components[0] ?? { ratio: 0, scaledScores: new Array<number>(n).fill(0) };
	const c2 = components[1] ?? { ratio: 0, scaledScores: new Array<number>(n).fill(0) };
	const r1 = c1.ratio;
	const r2 = c2.ratio;
	const l1 = normalizeZero(r1 * totalVariance);
	const l2 = normalizeZero(r2 * totalVariance);
	const varianceExplainedTotal = normalizeZero(Math.min(1, r1 + r2));

	const coords: (readonly [number, number])[] = new Array(n);
	const residual2dFractions: (number | null)[] = new Array(n);
	for (let i = 0; i < n; i += 1) {
		const sx = c1.scaledScores[i]!;
		const sy = c2.scaledScores[i]!;
		const x = normalizeZero(sx * rmsScale);
		const y = normalizeZero(sy * rmsScale);
		coords[i] = [x, y];
		const normSq = scaledSqNorms[i]! / scaledTotalVariance;
		if (normSq <= REL_EPS * REL_EPS) {
			residual2dFractions[i] = null;
		} else {
			const sq2d = sx * sx + sy * sy;
			const frac = 1 - sq2d / normSq;
			residual2dFractions[i] = snapRelative(Math.max(0, Math.min(1, frac)), 1);
		}
	}

	return {
		coords,
		eigenvalues: [l1, l2],
		totalVariance,
		explainedVarianceRatio: [normalizeZero(r1), normalizeZero(r2)],
		varianceExplainedTotal,
		distancesFromMean,
		residual2dFractions,
		degenerate: r1 === 0 || r2 === 0,
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
	let maxAbs = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (let j = 0; j < d; j += 1) {
		const v = vector[j]!;
		sum += v;
		const mag = Math.abs(v);
		if (mag > maxAbs) maxAbs = mag;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	const mean = sum / d;
	let scaledSq = 0;
	let scaledVar = 0;
	if (maxAbs > 0) {
		const meanScaled = mean / maxAbs;
		for (let j = 0; j < d; j += 1) {
			const vs = vector[j]! / maxAbs;
			scaledSq += vs * vs;
			const diff = vs - meanScaled;
			scaledVar += diff * diff;
		}
	}
	return {
		l2Norm: normalizeZero(maxAbs * Math.sqrt(scaledSq)),
		mean: normalizeZero(mean),
		std: normalizeZero(maxAbs * Math.sqrt(scaledVar / d)),
		min: normalizeZero(min),
		max: normalizeZero(max),
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
			method: "pca-2d-householder-ql",
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
