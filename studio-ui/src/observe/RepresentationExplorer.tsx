// Representation Explorer (OBSERVE-GEOMETRY-001): a bounded, read-only 2D scientific instrument inside Observe.
// Renders deterministic PCA projections of validated representation captures with explicit OBSERVED / DERIVED /
// INTERPRETED / UNAVAILABLE distinctions, conditional layer/token controls, zoom/pan, keyboard operation and
// source-artifact provenance inspection. Never fabricates measurements, concepts, clusters, or missing dimensions.

import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactElement,
	useMemo,
	useRef,
	useState,
	type WheelEvent,
} from "react";
import type {
	EndoObserveEpistemicBasisV0,
	EndoObserveRepresentationSceneV0,
	EndoObserveScenePointV0,
} from "../../../protocol/observe-representation.ts";
import {
	buildRepresentationPlot,
	formatNum,
	formatPercent,
	formatTokenDisplay,
	INITIAL_VIEWPORT,
	type PlotViewport,
	panViewport,
	type RepresentationColorMode,
	roleLabel,
	stepPointSelection,
	zoomViewport,
} from "../model/representation.ts";
import { Panel, PanelBoundary } from "../ui/Panel.tsx";
import { CopyButton, Note } from "../ui/text.tsx";
import type { RepresentationsApi } from "../use-representations.ts";

function EpistemicBadge({ basis }: { basis: EndoObserveEpistemicBasisV0 }): ReactElement {
	return <span className={`rep-basis rep-basis-${basis.toLowerCase()}`}>{basis}</span>;
}

function PointShape({
	shape,
	cx,
	cy,
	r,
	className,
}: {
	shape: "circle" | "diamond" | "square";
	cx: number;
	cy: number;
	r: number;
	className: string;
}): ReactElement {
	if (shape === "diamond") {
		const d = `M${cx} ${cy - r - 1}L${cx + r + 1} ${cy}L${cx} ${cy + r + 1}L${cx - r - 1} ${cy}Z`;
		return <path d={d} className={className} />;
	}
	if (shape === "square") {
		return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1.2} className={className} />;
	}
	return <circle cx={cx} cy={cy} r={r} className={className} />;
}

function SwatchGlyph({
	shape,
	className,
}: {
	shape: "circle" | "diamond" | "square";
	className: string;
}): ReactElement {
	return (
		<svg viewBox="0 0 12 12" width={11} height={11} aria-hidden="true" focusable="false" className="rep-swatch-svg">
			<PointShape shape={shape} cx={6} cy={6} r={4} className={`rep-swatch ${className}`} />
		</svg>
	);
}

function PointInspector({
	scene,
	point,
	onClear,
}: {
	scene: EndoObserveRepresentationSceneV0;
	point: EndoObserveScenePointV0;
	onClear(): void;
}): ReactElement {
	const interpretations = scene.interpretations.filter(
		(note) => note.pointId === null || note.pointId === point.pointId,
	);
	const shaShort = `${scene.artifact.artifactSha256.slice(0, 12)}…${scene.artifact.artifactSha256.slice(-8)}`;
	const residualPct =
		point.derived.residual2dFraction === null ? "unavailable" : formatPercent(point.derived.residual2dFraction);

	return (
		<div className="detail rep-point-detail" data-testid="rep-point-inspector">
			<div className="rep-point-head">
				<div>
					<h3 className="detail-title mono">{point.pointId}</h3>
					<p className="dim small">
						{point.tokenText !== null
							? `Token ${point.tokenIndex ?? "—"}: “${formatTokenDisplay(point.tokenText)}”`
							: point.eventRef !== null
								? `Event ref: ${point.eventRef}`
								: `Source index ${point.sourceIndex}`}
					</p>
				</div>
				<button type="button" className="btn small-btn" onClick={onClear} data-testid="rep-clear-point">
					Clear
				</button>
			</div>

			<section className="block">
				<h3>Source identity</h3>
				<dl className="facts">
					<div className="fact">
						<dt>point id</dt>
						<dd className="mono">{point.pointId}</dd>
					</div>
					<div className="fact">
						<dt>source index</dt>
						<dd className="mono">{point.sourceIndex}</dd>
					</div>
					<div className="fact">
						<dt>hook point</dt>
						<dd className="mono">{point.hookPoint}</dd>
					</div>
					<div className="fact">
						<dt>layer</dt>
						<dd>
							{point.layer !== null ? (
								<span className="mono">{point.layer}</span>
							) : (
								<span className="rep-na-inline">
									<EpistemicBadge basis="UNAVAILABLE" />{" "}
									<span className="dim">
										{scene.dimensions.layers.supported ? "not set" : scene.dimensions.layers.reason}
									</span>
								</span>
							)}
						</dd>
					</div>
					<div className="fact">
						<dt>token</dt>
						<dd>
							{point.tokenIndex !== null ? (
								<span className="mono">
									#{point.tokenIndex}
									{point.tokenText !== null ? ` “${formatTokenDisplay(point.tokenText)}”` : ""}
									{point.tokenId !== null ? ` (id ${point.tokenId})` : ""}
								</span>
							) : (
								<span className="rep-na-inline">
									<EpistemicBadge basis="UNAVAILABLE" />{" "}
									<span className="dim">
										{scene.dimensions.tokens.supported ? "not set" : scene.dimensions.tokens.reason}
									</span>
								</span>
							)}
						</dd>
					</div>
					{point.eventRef !== null ? (
						<div className="fact">
							<dt>event ref</dt>
							<dd className="mono">{point.eventRef}</dd>
						</div>
					) : null}
				</dl>
			</section>

			<section className="block" data-testid="rep-observed-block">
				<div className="rep-block-head">
					<h3>Captured measurements</h3>
					<EpistemicBadge basis="OBSERVED" />
				</div>
				<dl className="facts">
					<div className="fact">
						<dt>vector dim</dt>
						<dd className="mono">{point.observed.vectorDim}</dd>
					</div>
					<div className="fact">
						<dt>L2 norm ||h||₂</dt>
						<dd className="mono">{formatNum(point.observed.l2Norm, 4)}</dd>
					</div>
					<div className="fact">
						<dt>mean / std</dt>
						<dd className="mono">
							{formatNum(point.observed.mean, 4)} / {formatNum(point.observed.std, 4)}
						</dd>
					</div>
					<div className="fact">
						<dt>min / max</dt>
						<dd className="mono">
							{formatNum(point.observed.min, 4)} / {formatNum(point.observed.max, 4)}
						</dd>
					</div>
					<div className="fact">
						<dt>top next token</dt>
						<dd>
							{point.observed.topNextToken !== null ? (
								<span className="mono">
									“{formatTokenDisplay(point.observed.topNextToken.token)}” (logit{" "}
									{formatNum(point.observed.topNextToken.logit, 2)}
									{point.observed.topNextToken.probability !== null
										? `, p=${formatPercent(point.observed.topNextToken.probability)}`
										: ""}
									)
								</span>
							) : (
								<span className="rep-na-inline">
									<EpistemicBadge basis="UNAVAILABLE" />{" "}
									<span className="dim">Not recorded for this point or backend.</span>
								</span>
							)}
						</dd>
					</div>
				</dl>
			</section>

			<section className="block" data-testid="rep-derived-block">
				<div className="rep-block-head">
					<h3>Projected coordinates</h3>
					<EpistemicBadge basis="DERIVED" />
				</div>
				<dl className="facts">
					<div className="fact">
						<dt>PC1 (x)</dt>
						<dd className="mono">{formatNum(point.derived.x, 4)}</dd>
					</div>
					<div className="fact">
						<dt>PC2 (y)</dt>
						<dd className="mono">{formatNum(point.derived.y, 4)}</dd>
					</div>
					<div className="fact">
						<dt>full-space dist</dt>
						<dd className="mono">{formatNum(point.derived.distanceFromMean, 4)}</dd>
					</div>
					<div className="fact">
						<dt>outside 2D plane</dt>
						<dd className="mono">{residualPct}</dd>
					</div>
					<div className="fact">
						<dt>method</dt>
						<dd className="mono">
							{scene.analysis.method} · {scene.analysis.revision} ({scene.analysis.centering})
						</dd>
					</div>
				</dl>
				<p className="dim small">
					Full-space distance measures Euclidean displacement from the slice centroid in ℝ^
					{point.observed.vectorDim}. “Outside 2D plane” shows how much of that displacement is orthogonal to
					PC1–PC2.
				</p>
			</section>

			<section className="block" data-testid="rep-interpreted-block">
				<div className="rep-block-head">
					<h3>Semantic interpretations</h3>
					<EpistemicBadge basis="INTERPRETED" />
				</div>
				{interpretations.length === 0 ? (
					<p className="dim small">
						None recorded. Projected geometry does not assign concepts, hypotheses, reasoning steps, or
						confidence.
					</p>
				) : (
					<ul className="plain rep-interp-list">
						{interpretations.map((note, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed recorded list
							<li key={idx}>
								<span className="mono small">{note.author}:</span> {note.text}
							</li>
						))}
					</ul>
				)}
			</section>

			<section className="block">
				<h3>Underlying artifact</h3>
				<dl className="facts">
					<div className="fact">
						<dt>artifact id</dt>
						<dd className="mono">{scene.artifact.artifactId}</dd>
					</div>
					<div className="fact">
						<dt>sha256</dt>
						<dd className="fact-text">
							<span className="mono" title={scene.artifact.artifactSha256}>
								{shaShort}
							</span>
							<CopyButton label="artifact sha256" value={scene.artifact.artifactSha256} />
						</dd>
					</div>
					<div className="fact">
						<dt>role</dt>
						<dd>{roleLabel(scene.subject.executionRole)}</dd>
					</div>
					<div className="fact">
						<dt>subject</dt>
						<dd className="mono">
							{scene.subject.model.modelId} ({scene.subject.model.weightDtype})
						</dd>
					</div>
				</dl>
			</section>
		</div>
	);
}

function ArtifactOverviewInspector({ scene }: { scene: EndoObserveRepresentationSceneV0 }): ReactElement {
	const { subject, artifact, analysis } = scene;
	const hs = subject.captureLocation.headSemantics;
	const shaShort = `${artifact.artifactSha256.slice(0, 12)}…${artifact.artifactSha256.slice(-8)}`;
	return (
		<div className="detail" data-testid="rep-artifact-inspector">
			<p className="lead">
				Select a point on the plot (or use Arrow keys) to inspect its observed and derived values.
			</p>

			<section className="block">
				<h3>Experimental subject</h3>
				<dl className="facts">
					<div className="fact">
						<dt>execution role</dt>
						<dd>{roleLabel(subject.executionRole)}</dd>
					</div>
					<div className="fact">
						<dt>model</dt>
						<dd className="mono">
							{subject.model.modelId} ({subject.model.family})
						</dd>
					</div>
					<div className="fact">
						<dt>precision</dt>
						<dd className="mono">
							{subject.model.weightDtype}
							{subject.model.quantization !== null ? ` · ${subject.model.quantization.method}` : ""}
						</dd>
					</div>
					<div className="fact">
						<dt>revision</dt>
						<dd className="mono">{subject.model.revision ?? "unavailable"}</dd>
					</div>
					<div className="fact">
						<dt>weight digest</dt>
						<dd className="fact-text">
							{subject.model.weightDigestSha256 !== null ? (
								<>
									<span className="mono" title={subject.model.weightDigestSha256}>
										{`${subject.model.weightDigestSha256.slice(0, 12)}…`}
									</span>
									<CopyButton label="weight digest" value={subject.model.weightDigestSha256} />
								</>
							) : (
								<EpistemicBadge basis="UNAVAILABLE" />
							)}
						</dd>
					</div>
					<div className="fact">
						<dt>backend</dt>
						<dd className="mono">
							{subject.backend.framework} {subject.backend.frameworkVersion} · {subject.backend.driver}
						</dd>
					</div>
					<div className="fact">
						<dt>device / kernel</dt>
						<dd className="mono">
							{subject.backend.device} · {subject.backend.computeDtype}
							{subject.backend.attentionKernel !== null ? ` · ${subject.backend.attentionKernel}` : ""}
						</dd>
					</div>
					<div className="fact">
						<dt>weight proc</dt>
						<dd className="mono">
							{subject.weightProcessing.mode}
							{subject.weightProcessing.mode === "tl-compatibility-mode"
								? ` (foldLn=${String(subject.weightProcessing.foldLn)}, centerW=${String(subject.weightProcessing.centerWritingWeights)})`
								: ""}
						</dd>
					</div>
					<div className="fact">
						<dt>hook / shape</dt>
						<dd className="mono">
							{subject.captureLocation.hookPoint} · [{subject.captureLocation.tensorShape.join("×")}]
						</dd>
					</div>
					<div className="fact">
						<dt>head semantics</dt>
						<dd className="mono">
							{hs.queryHeads !== null || hs.kvHeads !== null
								? `${hs.queryHeads ?? "?"}Q / ${hs.kvHeads ?? "?"}KV · ${hs.layout}`
								: hs.layout}
						</dd>
					</div>
				</dl>
			</section>

			<section className="block">
				<div className="rep-block-head">
					<h3>Projection method</h3>
					<EpistemicBadge basis="DERIVED" />
				</div>
				<dl className="facts">
					<div className="fact">
						<dt>method</dt>
						<dd className="mono">
							{analysis.method} ({analysis.revision})
						</dd>
					</div>
					<div className="fact">
						<dt>normalisation</dt>
						<dd className="mono">
							{analysis.centering}, {analysis.scaling}, {analysis.signCanonicalization}
						</dd>
					</div>
					<div className="fact">
						<dt>variance (2D)</dt>
						<dd className="mono">
							{formatPercent(analysis.varianceExplainedTotal)} (PC1{" "}
							{formatPercent(analysis.axes[0].explainedVarianceRatio)}, PC2{" "}
							{formatPercent(analysis.axes[1].explainedVarianceRatio)})
						</dd>
					</div>
					<div className="fact">
						<dt>artifact sha256</dt>
						<dd className="fact-text">
							<span className="mono" title={artifact.artifactSha256}>
								{shaShort}
							</span>
							<CopyButton label="artifact sha256" value={artifact.artifactSha256} />
						</dd>
					</div>
				</dl>
			</section>

			<details className="ref" open>
				<summary>Epistemic distinctions</summary>
				<ul className="plain rep-guide-list">
					<li>
						<EpistemicBadge basis="OBSERVED" />{" "}
						<span className="dim">Measurements or tokens captured directly from execution.</span>
					</li>
					<li>
						<EpistemicBadge basis="DERIVED" />{" "}
						<span className="dim">Deterministic mathematical projections computed from observed vectors.</span>
					</li>
					<li>
						<EpistemicBadge basis="INTERPRETED" />{" "}
						<span className="dim">Semantic hypotheses kept separate; never inferred from clusters.</span>
					</li>
					<li>
						<EpistemicBadge basis="UNAVAILABLE" />{" "}
						<span className="dim">Signals or dimensions not exposed by the backend or capture.</span>
					</li>
				</ul>
			</details>
		</div>
	);
}

export function RepresentationExplorer({ api }: { api: RepresentationsApi }): ReactElement {
	const { state, refreshList, retryScene, selectArtifact, selectLayer } = api;
	const [colorMode, setColorMode] = useState<RepresentationColorMode>("basis");
	const [tokenQuery, setTokenQuery] = useState("");
	const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
	const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);
	const [showSequencePath, setShowSequencePath] = useState(false);
	const [viewport, setViewport] = useState<PlotViewport>(INITIAL_VIEWPORT);

	// Reset per-scene view state cleanly when switching artifacts or layers.
	const sceneKey = state.scene === null ? "" : `${state.scene.selector}:${String(state.scene.selectedLayer)}`;
	const lastSceneKey = useRef(sceneKey);
	if (lastSceneKey.current !== sceneKey) {
		lastSceneKey.current = sceneKey;
		if (selectedPointId !== null && !(state.scene?.points.some((p) => p.pointId === selectedPointId) ?? false)) {
			setSelectedPointId(null);
		}
		if (hoveredPointId !== null) setHoveredPointId(null);
	}

	const dragRef = useRef<{ active: boolean; x: number; y: number; moved: boolean }>({
		active: false,
		x: 0,
		y: 0,
		moved: false,
	});

	const scene = state.scene;
	const plot = useMemo(
		() =>
			scene === null
				? null
				: buildRepresentationPlot(scene, {
						colorMode,
						tokenQuery,
						selectedPointId,
						showSequencePath,
						viewport,
					}),
		[scene, colorMode, tokenQuery, selectedPointId, showSequencePath, viewport],
	);

	const selectedPoint =
		scene === null || selectedPointId === null
			? null
			: (scene.points.find((p) => p.pointId === selectedPointId) ?? null);
	const hoveredPoint =
		scene === null || hoveredPointId === null
			? null
			: (scene.points.find((p) => p.pointId === hoveredPointId) ?? null);

	const handlePlotKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
		if (plot === null) return;
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			setSelectedPointId(stepPointSelection(plot.points, selectedPointId, "next"));
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			setSelectedPointId(stepPointSelection(plot.points, selectedPointId, "prev"));
		} else if (event.key === "Home") {
			event.preventDefault();
			setSelectedPointId(stepPointSelection(plot.points, selectedPointId, "first"));
		} else if (event.key === "End") {
			event.preventDefault();
			setSelectedPointId(stepPointSelection(plot.points, selectedPointId, "last"));
		} else if (event.key === "Escape") {
			event.preventDefault();
			setSelectedPointId(null);
		} else if (event.key === "+" || event.key === "=") {
			event.preventDefault();
			setViewport((v) => zoomViewport(v, 1.25));
		} else if (event.key === "-" || event.key === "_") {
			event.preventDefault();
			setViewport((v) => zoomViewport(v, 0.8));
		} else if (event.key === "0") {
			event.preventDefault();
			setViewport(INITIAL_VIEWPORT);
		}
	};

	const handleWheel = (event: WheelEvent<SVGSVGElement>) => {
		if (plot === null) return;
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const svgX = ((event.clientX - rect.left) / rect.width) * plot.width;
		const svgY = ((event.clientY - rect.top) / rect.height) * plot.height;
		const ax = Math.min(1, Math.max(0, (svgX - plot.innerX) / plot.innerW));
		const ay = Math.min(1, Math.max(0, (svgY - plot.innerY) / plot.innerH));
		const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
		setViewport((v) => zoomViewport(v, factor, ax, ay));
	};

	const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
		if (event.button !== 0) return;
		if ((event.target as Element | null)?.closest(".rep-point") !== null) return;
		dragRef.current = { active: true, x: event.clientX, y: event.clientY, moved: false };
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
		if (!dragRef.current.active || plot === null) return;
		const rect = event.currentTarget.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const dx = ((event.clientX - dragRef.current.x) / rect.width) * plot.width;
		const dy = ((event.clientY - dragRef.current.y) / rect.height) * plot.height;
		if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) dragRef.current.moved = true;
		dragRef.current.x = event.clientX;
		dragRef.current.y = event.clientY;
		setViewport((v) => panViewport(v, dx, dy));
	};

	const handlePointerUp = (event: PointerEvent<SVGSVGElement>) => {
		if (!dragRef.current.active) return;
		dragRef.current.active = false;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	if (state.index === null) {
		return (
			<div className="rep-explorer" data-testid="rep-explorer">
				{state.reading ? (
					<output className="loading">
						<span className="spinner" aria-hidden="true" /> Reading recorded representation captures…
					</output>
				) : (
					<Note tone={state.problem === null ? "info" : "error"}>
						{state.problem ?? "Representation captures have not been read yet."}
					</Note>
				)}
			</div>
		);
	}

	if (!state.index.available) {
		return (
			<div className="rep-explorer" data-testid="rep-explorer">
				<Panel
					resetKey="rep-absent"
					id="rep-unavailable"
					title="Representation Explorer"
					subtitle="no capture directory configured"
					tools={
						<button type="button" className="btn" onClick={refreshList} disabled={state.reading}>
							Refresh
						</button>
					}
				>
					<div className="rep-empty-body" data-testid="rep-absent">
						<p>
							<EpistemicBadge basis="UNAVAILABLE" /> No representation capture directory is attached to this
							Studio launch.
						</p>
						<p className="dim">
							Studio does not fabricate model activations or bundle synthetic sessions as production data. To
							inspect recorded representation captures without running a model, launch Studio with{" "}
							<code>--representations &lt;dir&gt;</code> (for example{" "}
							<code>research/observe-geometry/examples</code>) or place validated{" "}
							<code>endo.observe-representation-capture.v0</code> JSON files in{" "}
							<code>&lt;store&gt;/representations/</code>.
						</p>
					</div>
				</Panel>
			</div>
		);
	}

	const artifacts = state.index.artifacts;
	const readableArtifacts = artifacts.filter((a) => a.state === "readable");
	const problemArtifacts = artifacts.filter((a) => a.state !== "readable");

	return (
		<div className="rep-explorer" data-testid="rep-explorer">
			<section className="rep-bar" aria-label="Representation artifact selector">
				<div className="rep-bar-row">
					<label className="rep-field-inline">
						<span className="eyebrow">Capture artifact</span>
						<select
							aria-label="Capture artifact"
							data-testid="rep-artifact-select"
							value={state.selectedSelector ?? ""}
							disabled={state.reading || readableArtifacts.length === 0}
							onChange={(event) => {
								setViewport(INITIAL_VIEWPORT);
								setTokenQuery("");
								setSelectedPointId(null);
								selectArtifact(event.target.value === "" ? null : event.target.value);
							}}
						>
							{readableArtifacts.length === 0 ? (
								<option value="">No readable artifacts</option>
							) : (
								readableArtifacts.map((row) => (
									<option key={row.selector} value={row.selector}>
										{row.artifactId} · {row.modelId} ({row.weightDtype}) ·{" "}
										{row.executionRole === "test-fixture"
											? "TEST FIXTURE"
											: row.executionRole === "reference-replay"
												? "REPLAY"
												: "OBSERVED"}
									</option>
								))
							)}
						</select>
					</label>
					<button
						type="button"
						className="btn"
						onClick={refreshList}
						disabled={state.reading}
						data-testid="rep-refresh"
					>
						{state.reading ? "Reading…" : "Refresh artifacts"}
					</button>
					{scene !== null ? (
						<span
							className={`rep-role-pill rep-role-${scene.subject.executionRole}`}
							data-testid="rep-execution-role"
						>
							{roleLabel(scene.subject.executionRole)}
						</span>
					) : null}
				</div>
				{scene !== null ? (
					<div className="rep-subject-strip mono small" data-testid="rep-subject-strip">
						<span>{scene.subject.model.modelId}</span>
						<span className="dim">·</span>
						<span>{scene.subject.model.weightDtype}</span>
						<span className="dim">·</span>
						<span>
							{scene.subject.backend.framework} {scene.subject.backend.frameworkVersion} (
							{scene.subject.backend.device})
						</span>
						<span className="dim">·</span>
						<span>{scene.subject.weightProcessing.mode}</span>
						<span className="dim">·</span>
						<span>{scene.subject.captureLocation.hookPoint}</span>
						<span className="dim">·</span>
						<span>[{scene.subject.captureLocation.tensorShape.join("×")}]</span>
						{scene.subject.captureLocation.headSemantics.queryHeads !== null ? (
							<>
								<span className="dim">·</span>
								<span>
									{scene.subject.captureLocation.headSemantics.queryHeads}Q/
									{scene.subject.captureLocation.headSemantics.kvHeads ?? "?"}KV
								</span>
							</>
						) : null}
					</div>
				) : null}
			</section>

			{state.problem !== null ? (
				<Note tone="error" testid="rep-problem">
					{state.problem}
				</Note>
			) : null}

			{scene?.subject.executionRole === "test-fixture" && scene.subject.fixtureNotice !== null ? (
				<Note tone="warn" testid="rep-fixture-banner">
					<strong>Synthetic test fixture (not recorded model activations):</strong> {scene.subject.fixtureNotice}
				</Note>
			) : null}

			{scene?.subject.executionRole === "reference-replay" && scene.subject.replayOf !== null ? (
				<Note tone="info" testid="rep-replay-banner">
					<strong>Reference replay comparison evidence (not the original serving inference):</strong>{" "}
					{scene.subject.replayOf.note}
					{scene.subject.replayOf.primaryArtifactId !== null
						? ` Primary artifact: ${scene.subject.replayOf.primaryArtifactId}.`
						: ""}
				</Note>
			) : null}

			{problemArtifacts.length > 0 ? (
				<details className="rep-invalid-list" data-testid="rep-invalid-artifacts">
					<summary>
						{problemArtifacts.length} capture file{problemArtifacts.length === 1 ? "" : "s"} refused or unreadable
					</summary>
					<ul className="plain small">
						{problemArtifacts.map((row) => (
							<li key={row.selector}>
								<span className="mono">{row.state}</span>: {row.reason ?? "Could not validate artifact."}
							</li>
						))}
					</ul>
				</details>
			) : null}

			{scene === null || plot === null ? (
				<Panel
					resetKey="rep-none"
					id="rep-empty"
					title="Representation Explorer"
					subtitle={state.selectedSelector !== null ? "scene unavailable" : "no readable capture"}
				>
					<div className="rep-empty-body">
						{state.reading ? (
							<output className="loading">
								<span className="spinner" aria-hidden="true" /> Projecting representation scene…
							</output>
						) : state.selectedSelector !== null ? (
							<div>
								<Note tone="warn">
									The selected capture artifact could not be projected on the last attempt. Use Retry scene or
									Refresh artifacts to try again.
								</Note>
								<button
									type="button"
									className="btn"
									onClick={retryScene}
									disabled={state.reading}
									data-testid="rep-retry-scene"
								>
									Retry scene
								</button>
							</div>
						) : (
							<Note>
								No valid representation capture files were found in this directory. Valid artifacts must satisfy{" "}
								<code>endo.observe-representation-capture.v0</code>.
							</Note>
						)}
					</div>
				</Panel>
			) : (
				<div className="rep-grid">
					<div className="col rep-col-left">
						<Panel
							resetKey={sceneKey}
							id="rep-controls"
							title="Dimensions & Encoding"
							subtitle="grounded channels"
						>
							<div className="rep-controls-body">
								<div className="rep-control-group">
									<span className="eyebrow">Layer dimension</span>
									{scene.dimensions.layers.supported ? (
										<label className="rep-field">
											<span className="sr-only">Layer</span>
											<select
												aria-label="Layer"
												data-testid="rep-layer-select"
												value={String(scene.selectedLayer ?? "")}
												disabled={state.reading}
												onChange={(event) => {
													const raw = event.target.value;
													setViewport(INITIAL_VIEWPORT);
													selectLayer(raw === "all" ? "all" : Number(raw));
												}}
											>
												{scene.dimensions.layers.availableLayers.map((layer) => (
													<option key={layer} value={String(layer)}>
														Layer {layer}
													</option>
												))}
												{scene.dimensions.layers.availableLayers.length > 1 ? (
													<option value="all">
														All captured layers ({scene.dimensions.layers.availableLayers.length})
													</option>
												) : null}
											</select>
										</label>
									) : (
										<p className="dim small rep-dim-unavailable" data-testid="rep-layer-unavailable">
											<EpistemicBadge basis="UNAVAILABLE" /> {scene.dimensions.layers.reason}
										</p>
									)}
								</div>

								<div className="rep-control-group">
									<span className="eyebrow">Token dimension</span>
									{scene.dimensions.tokens.supported ? (
										<label className="rep-field">
											<span className="sr-only">Filter tokens</span>
											<input
												type="search"
												aria-label="Filter tokens"
												data-testid="rep-token-filter"
												placeholder={`Filter ${scene.dimensions.tokens.tokenCount} tokens or id…`}
												value={tokenQuery}
												onChange={(event) => setTokenQuery(event.target.value)}
											/>
											{tokenQuery.trim() !== "" ? (
												<span className="dim small">
													{plot.matchedCount} of {plot.points.length} points highlighted (non-matching stay
													dimmed in context)
												</span>
											) : null}
										</label>
									) : (
										<p className="dim small rep-dim-unavailable" data-testid="rep-token-unavailable">
											<EpistemicBadge basis="UNAVAILABLE" /> {scene.dimensions.tokens.reason}
										</p>
									)}
								</div>

								<div className="rep-control-group">
									<label className="rep-field">
										<span className="eyebrow">Colour encoding</span>
										<select
											aria-label="Colour encoding"
											data-testid="rep-color-select"
											value={plot.activeColorMode}
											onChange={(event) => setColorMode(event.target.value as RepresentationColorMode)}
										>
											{plot.colorModes.map((mode) => (
												<option key={mode.id} value={mode.id}>
													{mode.label}
												</option>
											))}
										</select>
									</label>
									<p className="dim small">
										{plot.colorModes.find((m) => m.id === plot.activeColorMode)?.description}
									</p>
									<ul
										className="plain rep-legend"
										aria-label="Colour and shape legend"
										data-testid="rep-legend"
									>
										{plot.legend.map((item) => (
											<li key={item.key} title={item.detail}>
												<SwatchGlyph shape={item.shape} className={item.swatchClass} />
												<span className="mono small">{item.label}</span>
											</li>
										))}
										<li title="Selection and keyboard focus only; never a data channel">
											<span className="rep-select-swatch" aria-hidden="true" />
											<span className="small dim">Selected / focused (ivory)</span>
										</li>
									</ul>
								</div>

								{plot.sequenceLabel !== null ? (
									<div className="rep-control-group">
										<label className="rep-checkbox">
											<input
												type="checkbox"
												data-testid="rep-sequence-toggle"
												checked={showSequencePath}
												onChange={(event) => setShowSequencePath(event.target.checked)}
											/>
											<span>{plot.sequenceLabel}</span>
										</label>
									</div>
								) : null}
							</div>
						</Panel>

						<Panel
							resetKey={sceneKey}
							id="rep-capabilities"
							title="Backend Capabilities"
							subtitle="declared hooks & gaps"
						>
							<div className="rep-controls-body" data-testid="rep-capabilities-body">
								<dl className="facts">
									<div className="fact">
										<dt>fireable hooks</dt>
										<dd className="mono">{scene.backendCapabilities.supportedHookPointsCount}</dd>
									</div>
									<div className="fact">
										<dt>non-fireable</dt>
										<dd className="mono">{scene.backendCapabilities.nonFireableHookPointsCount}</dd>
									</div>
									<div className="fact">
										<dt>seq logits</dt>
										<dd className="mono">
											{scene.backendCapabilities.providesSequenceLogits === null
												? "unavailable"
												: scene.backendCapabilities.providesSequenceLogits
													? "supported"
													: "final-token only"}
										</dd>
									</div>
								</dl>

								{scene.backendCapabilities.unavailableSignals.length > 0 ? (
									<div className="rep-unavail-block">
										<span className="eyebrow">Unavailable signals</span>
										<ul className="plain small rep-unavail-list">
											{scene.backendCapabilities.unavailableSignals.map((sig) => (
												<li key={sig.signal}>
													<EpistemicBadge basis="UNAVAILABLE" /> <span className="mono">{sig.signal}</span>{" "}
													<span className="dim">— {sig.reason}</span>
												</li>
											))}
										</ul>
									</div>
								) : null}

								{scene.backendCapabilities.nonFireableHookPoints.length > 0 ? (
									<details className="ref">
										<summary>
											Non-fireable hook points ({scene.backendCapabilities.nonFireableHookPointsCount})
										</summary>
										<ul className="plain mono small rep-hook-list">
											{scene.backendCapabilities.nonFireableHookPoints.map((h) => (
												<li key={h}>{h}</li>
											))}
										</ul>
									</details>
								) : null}

								{scene.backendCapabilities.supportedHookPoints.length > 0 ? (
									<details className="ref">
										<summary>
											Sample fireable hook points ({scene.backendCapabilities.supportedHookPoints.length} of{" "}
											{scene.backendCapabilities.supportedHookPointsCount})
										</summary>
										<ul className="plain mono small rep-hook-list">
											{scene.backendCapabilities.supportedHookPoints.map((h) => (
												<li key={h}>{h}</li>
											))}
										</ul>
									</details>
								) : null}
							</div>
						</Panel>
					</div>

					<div className="col rep-col-center">
						<Panel
							resetKey={sceneKey}
							id="rep-plot-panel"
							title="Representation Space"
							subtitle={`${scene.analysis.method} · ${scene.points.length} points · ${formatPercent(scene.analysis.varianceExplainedTotal)} 2D var`}
							className="grow"
							tools={
								<div className="rep-zoom-tools">
									<span className="mono dim small" data-testid="rep-zoom-level">
										{Math.round(viewport.scale * 100)}%
									</span>
									<button
										type="button"
										className="btn small-btn"
										aria-label="Zoom in"
										data-testid="rep-zoom-in"
										onClick={() => setViewport((v) => zoomViewport(v, 1.25))}
									>
										+
									</button>
									<button
										type="button"
										className="btn small-btn"
										aria-label="Zoom out"
										data-testid="rep-zoom-out"
										onClick={() => setViewport((v) => zoomViewport(v, 0.8))}
									>
										−
									</button>
									<button
										type="button"
										className="btn small-btn"
										aria-label="Reset view"
										data-testid="rep-zoom-reset"
										onClick={() => setViewport(INITIAL_VIEWPORT)}
									>
										Reset
									</button>
								</div>
							}
						>
							<div className="rep-stage">
								<svg
									viewBox={`0 0 ${plot.width} ${plot.height}`}
									className="rep-svg"
									role="application"
									// biome-ignore lint/a11y/noNoninteractiveTabindex: interactive 2D plot with Arrow/Home/End/+/-/0/Escape keyboard controls
									tabIndex={0}
									data-testid="rep-plot-svg"
									aria-label={`2D representation plot of ${scene.artifact.artifactId}, ${scene.points.length} points projected by ${scene.analysis.method}. Use Arrow keys to step through points, plus and minus to zoom, 0 to reset, Escape to clear selection.`}
									onKeyDown={handlePlotKeyDown}
									onWheel={handleWheel}
									onPointerDown={handlePointerDown}
									onPointerMove={handlePointerMove}
									onPointerUp={handlePointerUp}
									onPointerCancel={handlePointerUp}
								>
									<defs>
										<clipPath id="rep-plot-clip">
											<rect x={plot.innerX} y={plot.innerY} width={plot.innerW} height={plot.innerH} />
										</clipPath>
									</defs>

									<rect
										x={plot.innerX}
										y={plot.innerY}
										width={plot.innerW}
										height={plot.innerH}
										className="rep-plot-bg"
									/>

									<g className="rep-gridlines" clipPath="url(#rep-plot-clip)">
										{plot.xTicks.map((tick) => (
											<line
												key={`gx-${tick.value}`}
												x1={tick.pos}
												x2={tick.pos}
												y1={plot.innerY}
												y2={plot.innerY + plot.innerH}
											/>
										))}
										{plot.yTicks.map((tick) => (
											<line
												key={`gy-${tick.value}`}
												x1={plot.innerX}
												x2={plot.innerX + plot.innerW}
												y1={tick.pos}
												y2={tick.pos}
											/>
										))}
										{plot.originX !== null ? (
											<line
												x1={plot.originX}
												x2={plot.originX}
												y1={plot.innerY}
												y2={plot.innerY + plot.innerH}
												className="rep-origin-line"
											/>
										) : null}
										{plot.originY !== null ? (
											<line
												x1={plot.innerX}
												x2={plot.innerX + plot.innerW}
												y1={plot.originY}
												y2={plot.originY}
												className="rep-origin-line"
											/>
										) : null}
									</g>

									<g clipPath="url(#rep-plot-clip)">
										{plot.sequenceSegments.length > 0 ? (
											<g className="rep-seq-path" data-testid="rep-seq-path">
												{plot.sequenceSegments.map((seg) => (
													<line key={seg.key} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} />
												))}
											</g>
										) : null}

										{plot.points.map((item) => {
											if (!item.inBounds) return null;
											const isHovered = item.point.pointId === hoveredPointId;
											return (
												// biome-ignore lint/a11y/useSemanticElements: SVG point marker inside interactive plot
												<g
													key={item.point.pointId}
													role="button"
													tabIndex={-1}
													aria-label={item.ariaLabel}
													aria-pressed={item.selected}
													data-point-id={item.point.pointId}
													className={`rep-point${item.matched ? "" : " rep-dim"}${item.selected ? " rep-selected" : ""}${isHovered ? " rep-hovered" : ""}`}
													onClick={() => setSelectedPointId(item.point.pointId)}
													onMouseEnter={() => setHoveredPointId(item.point.pointId)}
													onMouseLeave={() =>
														setHoveredPointId((prev) => (prev === item.point.pointId ? null : prev))
													}
												>
													<circle cx={item.sx} cy={item.sy} r={11} fill="transparent" />
													{item.selected ? (
														<circle cx={item.sx} cy={item.sy} r={9.5} className="rep-select-ring" />
													) : null}
													<PointShape
														shape={item.shape}
														cx={item.sx}
														cy={item.sy}
														r={item.selected ? 5.5 : 4.6}
														className={`rep-glyph ${item.colorClass}`}
													/>
													{item.selected || isHovered || item.labelVisible ? (
														<text
															x={item.labelX}
															y={item.labelY}
															textAnchor={item.labelAnchor}
															className="rep-point-label"
														>
															{item.shortLabel}
														</text>
													) : null}
												</g>
											);
										})}
									</g>

									<g className="rep-axis">
										<line
											x1={plot.innerX}
											x2={plot.innerX + plot.innerW}
											y1={plot.innerY + plot.innerH}
											y2={plot.innerY + plot.innerH}
										/>
										{plot.xTicks.map((tick) =>
											tick.pos >= plot.innerX && tick.pos <= plot.innerX + plot.innerW ? (
												<g key={`xt-${tick.value}`}>
													<line
														x1={tick.pos}
														x2={tick.pos}
														y1={plot.innerY + plot.innerH}
														y2={plot.innerY + plot.innerH + 5}
													/>
													<text x={tick.pos} y={plot.innerY + plot.innerH + 18} textAnchor="middle">
														{tick.label}
													</text>
												</g>
											) : null,
										)}
										<text
											x={plot.innerX + plot.innerW / 2}
											y={plot.height - 10}
											textAnchor="middle"
											className="rep-axis-title"
										>
											{plot.xAxisLabel}
										</text>

										<line x1={plot.innerX} x2={plot.innerX} y1={plot.innerY} y2={plot.innerY + plot.innerH} />
										{plot.yTicks.map((tick) =>
											tick.pos >= plot.innerY && tick.pos <= plot.innerY + plot.innerH ? (
												<g key={`yt-${tick.value}`}>
													<line x1={plot.innerX - 5} x2={plot.innerX} y1={tick.pos} y2={tick.pos} />
													<text x={plot.innerX - 9} y={tick.pos + 3.5} textAnchor="end">
														{tick.label}
													</text>
												</g>
											) : null,
										)}
										<text
											x={16}
											y={plot.innerY + plot.innerH / 2}
											textAnchor="middle"
											transform={`rotate(-90 16 ${plot.innerY + plot.innerH / 2})`}
											className="rep-axis-title"
										>
											{plot.yAxisLabel}
										</text>
									</g>
								</svg>

								<div className="rep-stage-foot">
									<span className="mono small" data-testid="rep-hover-readout">
										{hoveredPoint !== null
											? `${hoveredPoint.pointId}${hoveredPoint.tokenText !== null ? ` “${formatTokenDisplay(hoveredPoint.tokenText)}”` : ""} · PC1 ${formatNum(hoveredPoint.derived.x, 2)} · PC2 ${formatNum(hoveredPoint.derived.y, 2)} · ||h||₂ ${formatNum(hoveredPoint.observed.l2Norm, 2)}`
											: "←/→ step points · +/- zoom · 0 reset · drag background to pan · Esc clear"}
									</span>
								</div>

								<p className="dim small rep-analysis-note" data-testid="rep-analysis-note">
									{scene.analysis.note}
								</p>

								<details className="rep-point-index">
									<summary>Point index ({plot.points.length} points, keyboard selectable)</summary>
									<div className="rep-point-chips">
										{plot.points.map((item) => (
											<button
												key={item.point.pointId}
												type="button"
												className={`rep-chip${item.selected ? " selected" : ""}${item.matched ? "" : " dim"}`}
												aria-pressed={item.selected}
												onClick={() => setSelectedPointId(item.point.pointId)}
											>
												<span className="mono">{item.shortLabel}</span>
											</button>
										))}
									</div>
								</details>
							</div>
						</Panel>
					</div>

					<div className="col rep-col-right">
						<Panel
							resetKey={`${sceneKey}:${selectedPointId ?? "none"}`}
							id="rep-inspector"
							title="Point & Artifact Inspector"
							subtitle={
								selectedPoint === null ? "provenance & reading guide" : "observed · derived · interpreted"
							}
							className="grow"
						>
							<PanelBoundary resetKey={selectedPointId ?? sceneKey}>
								{selectedPoint !== null ? (
									<PointInspector
										scene={scene}
										point={selectedPoint}
										onClear={() => setSelectedPointId(null)}
									/>
								) : (
									<ArtifactOverviewInspector scene={scene} />
								)}
							</PanelBoundary>
						</Panel>
					</div>
				</div>
			)}
		</div>
	);
}
