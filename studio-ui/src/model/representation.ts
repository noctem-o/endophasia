// Pure Representation Explorer view model and deterministic 2D SVG plot geometry.
// Zero DOM, zero React, zero clock, zero randomness.
//
// Grounded visual encodings:
// - Position (x, y): DERIVED 2D PCA scores mapped linearly through the active zoom/pan viewport.
// - Shape: execution role (circle = primary observation, diamond = reference replay, square = test fixture).
// - Colour: explicitly chosen declared channel (basis/role, token position, observed L2 norm, or layer index).
//   Ivory (`--select`) is reserved strictly for selection and focus, never reused for any data channel.
// - Connections: OFF by default; when enabled, draws only declared sequential order (token index or layer index).

import type {
	EndoObserveExecutionRoleV0,
	EndoObserveRepresentationSceneV0,
	EndoObserveScenePointV0,
} from "../../../protocol/observe-representation.ts";

export type RepresentationColorMode = "basis" | "token-position" | "l2-norm" | "layer";

export interface PlotViewport {
	readonly scale: number;
	readonly panX: number;
	readonly panY: number;
}

export const PLOT_WIDTH = 760;
export const PLOT_HEIGHT = 480;
export const PLOT_PAD = Object.freeze({ top: 26, right: 28, bottom: 48, left: 66 });
export const PLOT_INNER_W = PLOT_WIDTH - PLOT_PAD.left - PLOT_PAD.right;
export const PLOT_INNER_H = PLOT_HEIGHT - PLOT_PAD.top - PLOT_PAD.bottom;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 16;

export const INITIAL_VIEWPORT: PlotViewport = Object.freeze({ scale: 1, panX: 0, panY: 0 });

export interface ColorModeOption {
	readonly id: RepresentationColorMode;
	readonly label: string;
	readonly description: string;
}

export interface LegendItem {
	readonly key: string;
	readonly swatchClass: string;
	readonly shape: "circle" | "diamond" | "square";
	readonly label: string;
	readonly detail: string;
}

export interface AxisTick {
	readonly value: number;
	readonly pos: number;
	readonly label: string;
}

export interface PlottedPoint {
	readonly point: EndoObserveScenePointV0;
	readonly sx: number;
	readonly sy: number;
	readonly inBounds: boolean;
	readonly colorClass: string;
	readonly shape: "circle" | "diamond" | "square";
	readonly matched: boolean;
	readonly selected: boolean;
	readonly shortLabel: string;
	readonly labelVisible: boolean;
	readonly labelAnchor: "start" | "end";
	readonly labelX: number;
	readonly labelY: number;
	readonly ariaLabel: string;
}

export interface SequenceSegment {
	readonly key: string;
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
}

export interface RepresentationPlotModel {
	readonly width: number;
	readonly height: number;
	readonly innerX: number;
	readonly innerY: number;
	readonly innerW: number;
	readonly innerH: number;
	readonly xTicks: readonly AxisTick[];
	readonly yTicks: readonly AxisTick[];
	readonly originX: number | null;
	readonly originY: number | null;
	readonly xAxisLabel: string;
	readonly yAxisLabel: string;
	readonly points: readonly PlottedPoint[];
	readonly matchedCount: number;
	readonly sequenceSegments: readonly SequenceSegment[];
	readonly sequenceLabel: string | null;
	readonly legend: readonly LegendItem[];
	readonly colorModes: readonly ColorModeOption[];
	readonly activeColorMode: RepresentationColorMode;
}

export function roleShape(role: EndoObserveExecutionRoleV0): "circle" | "diamond" | "square" {
	if (role === "reference-replay") return "diamond";
	if (role === "test-fixture") return "square";
	return "circle";
}

export function roleLabel(role: EndoObserveExecutionRoleV0): string {
	switch (role) {
		case "primary-observation":
			return "OBSERVED · primary execution";
		case "reference-replay":
			return "REPLAY · reference comparison";
		case "test-fixture":
			return "TEST FIXTURE · synthetic data";
	}
}

/** Make whitespace/control characters in token strings explicit without altering raw data. */
export function formatTokenDisplay(raw: string): string {
	if (raw === "") return "(empty)";
	return raw.replace(/\n/g, "↵").replace(/\t/g, "⇥").replace(/^ /, "·");
}

export function formatNum(value: number, digits = 3): string {
	if (!Number.isFinite(value)) return "—";
	const abs = Math.abs(value);
	if (abs !== 0 && (abs < 0.001 || abs >= 100_000)) return value.toExponential(2);
	return value.toFixed(digits);
}

export function formatPercent(ratio: number | null): string {
	if (ratio === null || !Number.isFinite(ratio)) return "unavailable";
	return `${(ratio * 100).toFixed(1)}%`;
}

/** Only return colour encodings grounded in dimensions this scene actually supports. */
export function availableColorModes(scene: EndoObserveRepresentationSceneV0): ColorModeOption[] {
	const modes: ColorModeOption[] = [
		{
			id: "basis",
			label: "Execution role",
			description: "Encodes whether points come from primary observation, reference replay, or a test fixture.",
		},
		{
			id: "l2-norm",
			label: "Observed L2 norm",
			description: "5-bin scale over each point's full-space observed vector norm ||h||₂.",
		},
	];
	if (scene.dimensions.tokens.supported) {
		modes.push({
			id: "token-position",
			label: "Token position",
			description: "5-bin sequential scale from earliest to latest recorded token index.",
		});
	}
	if (scene.dimensions.layers.supported && scene.selectedLayer === "all") {
		modes.push({
			id: "layer",
			label: "Layer index",
			description: "Discrete colour per captured transformer layer.",
		});
	}
	return modes;
}

export function resolveColorMode(
	scene: EndoObserveRepresentationSceneV0,
	requested: RepresentationColorMode,
): RepresentationColorMode {
	const allowed = availableColorModes(scene);
	return allowed.some((m) => m.id === requested) ? requested : allowed[0]!.id;
}

export function clampViewport(viewport: PlotViewport): PlotViewport {
	const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(viewport.scale) ? viewport.scale : 1));
	const maxPan = 2000 * scale;
	const panX = Math.min(maxPan, Math.max(-maxPan, Number.isFinite(viewport.panX) ? viewport.panX : 0));
	const panY = Math.min(maxPan, Math.max(-maxPan, Number.isFinite(viewport.panY) ? viewport.panY : 0));
	return { scale, panX, panY };
}

/** Zoom around a normalized anchor `(ax, ay)` in `[0, 1]` inside the inner plot box. */
export function zoomViewport(viewport: PlotViewport, factor: number, ax = 0.5, ay = 0.5): PlotViewport {
	const prev = clampViewport(viewport);
	const nextScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.scale * factor));
	if (nextScale === prev.scale) return prev;
	const ratio = nextScale / prev.scale;
	const cx = (ax - 0.5) * PLOT_INNER_W;
	const cy = (ay - 0.5) * PLOT_INNER_H;
	return clampViewport({
		scale: nextScale,
		panX: cx - (cx - prev.panX) * ratio,
		panY: cy - (cy - prev.panY) * ratio,
	});
}

export function panViewport(viewport: PlotViewport, dx: number, dy: number): PlotViewport {
	return clampViewport({
		scale: viewport.scale,
		panX: viewport.panX + dx,
		panY: viewport.panY + dy,
	});
}

export function stepPointSelection(
	points: readonly PlottedPoint[],
	currentId: string | null,
	direction: "next" | "prev" | "first" | "last",
): string | null {
	const pool = points.filter((p) => p.matched);
	const list = pool.length > 0 ? pool : points;
	if (list.length === 0) return null;
	if (direction === "first") return list[0]!.point.pointId;
	if (direction === "last") return list[list.length - 1]!.point.pointId;
	const idx = currentId === null ? -1 : list.findIndex((p) => p.point.pointId === currentId);
	if (idx === -1) return direction === "next" ? list[0]!.point.pointId : list[list.length - 1]!.point.pointId;
	const nextIdx = direction === "next" ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length;
	return list[nextIdx]!.point.pointId;
}

function niceTicks(min: number, max: number, targetCount = 5): number[] {
	const span = max - min;
	if (!Number.isFinite(span) || span <= 0) return [min];
	const rawStep = span / Math.max(1, targetCount);
	const mag = 10 ** Math.floor(Math.log10(rawStep));
	const norm = rawStep / mag;
	const step = (norm <= 1.5 ? 1 : norm <= 3.5 ? 2 : norm <= 7.5 ? 5 : 10) * mag;
	const start = Math.ceil(min / step) * step;
	const ticks: number[] = [];
	for (let v = start; v <= max + step * 1e-6 && ticks.length < 16; v += step) {
		ticks.push(Math.abs(v) < 1e-12 ? 0 : v);
	}
	return ticks;
}

function quintileBin(value: number, min: number, max: number): number {
	if (max <= min) return 2;
	const t = (value - min) / (max - min);
	return Math.min(4, Math.max(0, Math.floor(t * 5)));
}

export function buildRepresentationPlot(
	scene: EndoObserveRepresentationSceneV0,
	options: {
		colorMode: RepresentationColorMode;
		tokenQuery: string;
		selectedPointId: string | null;
		showSequencePath: boolean;
		viewport: PlotViewport;
	},
): RepresentationPlotModel {
	const colorModes = availableColorModes(scene);
	const activeColorMode = resolveColorMode(scene, options.colorMode);
	const viewport = clampViewport(options.viewport);
	const shape = roleShape(scene.subject.executionRole);

	// Data domain in PC1/PC2 coordinates with deterministic 14% padding.
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	let minNorm = Number.POSITIVE_INFINITY;
	let maxNorm = Number.NEGATIVE_INFINITY;
	let minTok = Number.POSITIVE_INFINITY;
	let maxTok = Number.NEGATIVE_INFINITY;

	for (const pt of scene.points) {
		if (pt.derived.x < minX) minX = pt.derived.x;
		if (pt.derived.x > maxX) maxX = pt.derived.x;
		if (pt.derived.y < minY) minY = pt.derived.y;
		if (pt.derived.y > maxY) maxY = pt.derived.y;
		if (pt.observed.l2Norm < minNorm) minNorm = pt.observed.l2Norm;
		if (pt.observed.l2Norm > maxNorm) maxNorm = pt.observed.l2Norm;
		if (pt.tokenIndex !== null) {
			if (pt.tokenIndex < minTok) minTok = pt.tokenIndex;
			if (pt.tokenIndex > maxTok) maxTok = pt.tokenIndex;
		}
	}

	const spanX = maxX - minX;
	const spanY = maxY - minY;
	const padX = spanX > 1e-9 ? spanX * 0.14 : 1;
	const padY = spanY > 1e-9 ? spanY * 0.14 : 1;
	const baseMinX = minX - padX;
	const baseMaxX = maxX + padX;
	const baseMinY = minY - padY;
	const baseMaxY = maxY + padY;

	const baseToScreenX = (x: number): number => {
		const u = (x - baseMinX) / (baseMaxX - baseMinX);
		return PLOT_PAD.left + PLOT_INNER_W / 2 + (u - 0.5) * PLOT_INNER_W * viewport.scale + viewport.panX;
	};
	const baseToScreenY = (y: number): number => {
		const u = (y - baseMinY) / (baseMaxY - baseMinY);
		return PLOT_PAD.top + PLOT_INNER_H / 2 - (u - 0.5) * PLOT_INNER_H * viewport.scale + viewport.panY;
	};
	const screenToDataX = (sx: number): number => {
		const u = (sx - PLOT_PAD.left - PLOT_INNER_W / 2 - viewport.panX) / (PLOT_INNER_W * viewport.scale) + 0.5;
		return baseMinX + u * (baseMaxX - baseMinX);
	};
	const screenToDataY = (sy: number): number => {
		const u = -(sy - PLOT_PAD.top - PLOT_INNER_H / 2 - viewport.panY) / (PLOT_INNER_H * viewport.scale) + 0.5;
		return baseMinY + u * (baseMaxY - baseMinY);
	};

	const visMinX = screenToDataX(PLOT_PAD.left);
	const visMaxX = screenToDataX(PLOT_PAD.left + PLOT_INNER_W);
	const visMinY = screenToDataY(PLOT_PAD.top + PLOT_INNER_H);
	const visMaxY = screenToDataY(PLOT_PAD.top);

	const xTicks: AxisTick[] = niceTicks(visMinX, visMaxX, 6).map((value) => ({
		value,
		pos: baseToScreenX(value),
		label: formatNum(value, Math.abs(visMaxX - visMinX) >= 50 ? 0 : 2),
	}));
	const yTicks: AxisTick[] = niceTicks(visMinY, visMaxY, 5).map((value) => ({
		value,
		pos: baseToScreenY(value),
		label: formatNum(value, Math.abs(visMaxY - visMinY) >= 50 ? 0 : 2),
	}));

	const originRawX = baseToScreenX(0);
	const originRawY = baseToScreenY(0);
	const originX = originRawX >= PLOT_PAD.left && originRawX <= PLOT_PAD.left + PLOT_INNER_W ? originRawX : null;
	const originY = originRawY >= PLOT_PAD.top && originRawY <= PLOT_PAD.top + PLOT_INNER_H ? originRawY : null;

	const query = scene.dimensions.tokens.supported ? options.tokenQuery.trim().toLowerCase() : "";
	const layersList = scene.dimensions.layers.supported ? scene.dimensions.layers.availableLayers : [];

	const colorClassFor = (pt: EndoObserveScenePointV0): string => {
		if (activeColorMode === "basis") {
			if (scene.subject.executionRole === "reference-replay") return "rep-c-replay";
			if (scene.subject.executionRole === "test-fixture") return "rep-c-fixture";
			return "rep-c-observed";
		}
		if (activeColorMode === "l2-norm") {
			return `rep-ramp-${quintileBin(pt.observed.l2Norm, minNorm, maxNorm)}`;
		}
		if (activeColorMode === "token-position" && pt.tokenIndex !== null) {
			return `rep-seq-${quintileBin(pt.tokenIndex, minTok, maxTok)}`;
		}
		if (activeColorMode === "layer" && pt.layer !== null) {
			const idx = Math.max(0, layersList.indexOf(pt.layer));
			return `rep-layer-${idx % 6}`;
		}
		return "rep-c-observed";
	};

	let matchedCount = 0;
	const points: PlottedPoint[] = scene.points.map((point) => {
		const sx = baseToScreenX(point.derived.x);
		const sy = baseToScreenY(point.derived.y);
		const inBounds =
			sx >= PLOT_PAD.left - 8 &&
			sx <= PLOT_PAD.left + PLOT_INNER_W + 8 &&
			sy >= PLOT_PAD.top - 8 &&
			sy <= PLOT_PAD.top + PLOT_INNER_H + 8;
		const matched =
			query === "" ||
			point.pointId.toLowerCase().includes(query) ||
			(point.tokenText?.toLowerCase().includes(query) ?? false) ||
			(point.tokenIndex !== null && String(point.tokenIndex) === query);
		if (matched) matchedCount += 1;
		const shortLabel =
			point.tokenText !== null
				? `${point.tokenIndex !== null ? `${point.tokenIndex}:` : ""}${formatTokenDisplay(point.tokenText)}`
				: point.pointId;
		const ariaParts = [
			`Point ${point.pointId}`,
			point.layer !== null ? `layer ${point.layer}` : null,
			point.tokenIndex !== null ? `token ${point.tokenIndex}` : null,
			point.tokenText !== null ? `text ${formatTokenDisplay(point.tokenText)}` : null,
			`PC1 ${formatNum(point.derived.x, 2)}`,
			`PC2 ${formatNum(point.derived.y, 2)}`,
			`observed L2 norm ${formatNum(point.observed.l2Norm, 2)}`,
		].filter((part): part is string => part !== null);
		return {
			point,
			sx,
			sy,
			inBounds,
			colorClass: colorClassFor(point),
			shape,
			matched,
			selected: point.pointId === options.selectedPointId,
			shortLabel,
			labelVisible: false,
			labelAnchor: sx > PLOT_PAD.left + PLOT_INNER_W - 120 ? ("end" as const) : ("start" as const),
			labelX: sx > PLOT_PAD.left + PLOT_INNER_W - 120 ? sx - 9 : sx + 9,
			labelY: sy - 5,
			ariaLabel: ariaParts.join(", "),
		};
	});

	// Deterministic non-overlapping label placement: selected point first, then source order.
	const placedBoxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
	const tryPlace = (p: PlottedPoint, force: boolean): boolean => {
		if (!p.inBounds) return false;
		const estWidth = Math.max(24, Math.min(130, p.shortLabel.length * 6.2 + 6));
		const x0 = p.labelAnchor === "end" ? p.labelX - estWidth : p.labelX;
		const x1 = p.labelAnchor === "end" ? p.labelX : p.labelX + estWidth;
		const y0 = p.labelY - 10;
		const y1 = p.labelY + 3;
		if (!force) {
			for (const box of placedBoxes) {
				if (x0 < box.x1 + 3 && x1 + 3 > box.x0 && y0 < box.y1 + 2 && y1 + 2 > box.y0) return false;
			}
		}
		placedBoxes.push({ x0, x1, y0, y1 });
		return true;
	};
	const placedPoints: PlottedPoint[] = points.map((p) => ({ ...p }));
	const selectedIdx = placedPoints.findIndex((p) => p.selected);
	if (selectedIdx !== -1 && tryPlace(placedPoints[selectedIdx]!, true)) {
		placedPoints[selectedIdx] = { ...placedPoints[selectedIdx]!, labelVisible: true };
	}
	if (placedPoints.length <= 40) {
		for (let i = 0; i < placedPoints.length; i += 1) {
			if (i === selectedIdx) continue;
			const pt = placedPoints[i]!;
			if (pt.matched && tryPlace(pt, false)) {
				placedPoints[i] = { ...pt, labelVisible: true };
			}
		}
	}

	// Grounded sequential order overlay (OFF by default).
	const sequenceSegments: SequenceSegment[] = [];
	let sequenceLabel: string | null = null;
	if (scene.dimensions.tokens.supported) {
		if (typeof scene.selectedLayer === "number" || scene.selectedLayer === null) {
			sequenceLabel = "Token sequence path (index order only, not geometric similarity)";
			if (options.showSequencePath) {
				const ordered = points
					.filter((p) => p.point.tokenIndex !== null)
					.slice()
					.sort((a, b) => a.point.tokenIndex! - b.point.tokenIndex!);
				for (let i = 0; i < ordered.length - 1; i += 1) {
					const a = ordered[i]!;
					const b = ordered[i + 1]!;
					if (b.point.tokenIndex === a.point.tokenIndex! + 1) {
						sequenceSegments.push({
							key: `${a.point.pointId}->${b.point.pointId}`,
							x1: a.sx,
							y1: a.sy,
							x2: b.sx,
							y2: b.sy,
						});
					}
				}
			}
		} else if (scene.selectedLayer === "all") {
			const selectedPt = points.find((p) => p.selected);
			sequenceLabel =
				selectedPt?.point.tokenIndex !== null && selectedPt !== undefined
					? `Layer progression for token ${selectedPt.point.tokenIndex} (layer order only)`
					: "Select a token to trace its layer progression";
			if (options.showSequencePath && selectedPt !== undefined && selectedPt.point.tokenIndex !== null) {
				const tokIdx = selectedPt.point.tokenIndex;
				const ordered = points
					.filter((p) => p.point.tokenIndex === tokIdx && p.point.layer !== null)
					.slice()
					.sort((a, b) => a.point.layer! - b.point.layer!);
				for (let i = 0; i < ordered.length - 1; i += 1) {
					const a = ordered[i]!;
					const b = ordered[i + 1]!;
					sequenceSegments.push({
						key: `${a.point.pointId}->${b.point.pointId}`,
						x1: a.sx,
						y1: a.sy,
						x2: b.sx,
						y2: b.sy,
					});
				}
			}
		}
	}

	const legend: LegendItem[] = [];
	if (activeColorMode === "basis") {
		legend.push({
			key: scene.subject.executionRole,
			swatchClass:
				scene.subject.executionRole === "reference-replay"
					? "rep-c-replay"
					: scene.subject.executionRole === "test-fixture"
						? "rep-c-fixture"
						: "rep-c-observed",
			shape,
			label: roleLabel(scene.subject.executionRole),
			detail:
				scene.subject.executionRole === "primary-observation"
					? "Measured activations from the recorded execution."
					: scene.subject.executionRole === "reference-replay"
						? "Teacher-forced replay on a reference backend; separate comparison evidence."
						: "Synthetic fixture vectors for verification; not recorded model activations.",
		});
	} else if (activeColorMode === "l2-norm") {
		const step = (maxNorm - minNorm) / 5;
		for (let bin = 0; bin < 5; bin += 1) {
			const lo = minNorm + step * bin;
			const hi = bin === 4 ? maxNorm : minNorm + step * (bin + 1);
			legend.push({
				key: `norm-${bin}`,
				swatchClass: `rep-ramp-${bin}`,
				shape,
				label: `${formatNum(lo, 1)}–${formatNum(hi, 1)}`,
				detail: `Observed full-space ||h||₂ bin ${bin + 1}/5`,
			});
		}
	} else if (activeColorMode === "token-position" && Number.isFinite(minTok)) {
		const step = (maxTok - minTok) / 5;
		for (let bin = 0; bin < 5; bin += 1) {
			const lo = Math.round(minTok + step * bin);
			const hi = bin === 4 ? maxTok : Math.round(minTok + step * (bin + 1));
			legend.push({
				key: `tok-${bin}`,
				swatchClass: `rep-seq-${bin}`,
				shape,
				label: `t ${lo}–${hi}`,
				detail: `Token index bin ${bin + 1}/5`,
			});
		}
	} else if (activeColorMode === "layer") {
		layersList.forEach((layer, idx) => {
			legend.push({
				key: `layer-${layer}`,
				swatchClass: `rep-layer-${idx % 6}`,
				shape,
				label: `Layer ${layer}`,
				detail: `Captured points from layer ${layer}`,
			});
		});
	}

	const ax0 = scene.analysis.axes[0];
	const ax1 = scene.analysis.axes[1];
	const xAxisLabel = `${ax0.label} (${ax0.basis} · ${formatPercent(ax0.explainedVarianceRatio)} var)`;
	const yAxisLabel = `${ax1.label} (${ax1.basis} · ${formatPercent(ax1.explainedVarianceRatio)} var)`;

	return {
		width: PLOT_WIDTH,
		height: PLOT_HEIGHT,
		innerX: PLOT_PAD.left,
		innerY: PLOT_PAD.top,
		innerW: PLOT_INNER_W,
		innerH: PLOT_INNER_H,
		xTicks,
		yTicks,
		originX,
		originY,
		xAxisLabel,
		yAxisLabel,
		points: placedPoints,
		matchedCount,
		sequenceSegments,
		sequenceLabel,
		legend,
		colorModes,
		activeColorMode,
	};
}
