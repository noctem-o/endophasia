// The overview map: the loaded window of the event log, one lane per event category, one mark per event, placed by STORAGE POSITION.
// It never places anything by recorded time (the producer's clock may run backwards), draws no duration, and says in words whether it
// covers the whole log as read or one window of it. An event the filters hide stays on the map, dimmed, so a filtered view is read in
// context. A mark's shape says how the event's presented fields are known; a ring around it says what the projection flagged. Selection
// is neutral ivory and changes nothing else about a mark. The table is the keyboard path to the same events; the marks are a pointer
// convenience, so they are not in the tab order.
import { type ReactElement, useEffect, useMemo, useState } from "react";
import type { OverviewMark, OverviewModel } from "../model/timeline.ts";
import { ProvGlyph } from "../ui/marks.tsx";

const KEY_LABEL: Record<string, string> = { envelope: "no field presented", unknown: "unknown basis" };
const LANE_H = 18;
const TOP = 6;
const AXIS_H = 26;
const GUTTER = 96;
const PAD_R = 14;

function MarkShape({ mark, x, y }: { mark: OverviewMark; x: number; y: number }): ReactElement {
	const r = 4;
	const shape = (() => {
		switch (mark.markClass) {
			case "observed":
				return <circle cx={x} cy={y} r={r + 0.4} fill="currentColor" />;
			case "reported":
				return (
					<>
						<circle cx={x} cy={y} r={r} fill="none" stroke="currentColor" strokeWidth={1.3} />
						<path d={`M${x} ${y - r}a${r} ${r} 0 0 0 0 ${2 * r}z`} fill="currentColor" />
					</>
				);
			case "derived":
				return (
					<path
						d={`M${x} ${y - r - 1}l${r + 1} ${r + 1}l${-(r + 1)} ${r + 1}l${-(r + 1)} ${-(r + 1)}z`}
						fill="currentColor"
					/>
				);
			case "inferred":
				return (
					<path
						d={`M${x} ${y - r - 1}l${r + 1} ${r + 1}l${-(r + 1)} ${r + 1}l${-(r + 1)} ${-(r + 1)}z`}
						fill="none"
						stroke="currentColor"
						strokeWidth={1.2}
					/>
				);
			case "mixed":
				return (
					<>
						<circle cx={x} cy={y} r={r + 0.5} fill="none" stroke="currentColor" strokeWidth={1.2} />
						<path d={`M${x} ${y - 2.4}l2.4 2.4l-2.4 2.4l-2.4 -2.4z`} fill="currentColor" />
					</>
				);
			case "unavailable":
				return (
					<circle
						cx={x}
						cy={y}
						r={r}
						fill="none"
						stroke="currentColor"
						strokeWidth={1.2}
						strokeDasharray="2 1.6"
					/>
				);
			case "envelope":
				return (
					<rect
						x={x - 2.8}
						y={y - 2.8}
						width={5.6}
						height={5.6}
						fill="none"
						stroke="currentColor"
						strokeWidth={1.1}
					/>
				);
			default:
				return (
					<rect
						x={x - 3}
						y={y - 3}
						width={6}
						height={6}
						fill="none"
						stroke="currentColor"
						strokeWidth={1}
						strokeDasharray="1.4 1.4"
					/>
				);
		}
	})();
	return <g className={`omark mk-${mark.markClass}`}>{shape}</g>;
}

/** The ring a flag draws round a mark: a different texture for each, so no flag depends on its hue. */
const FLAG_RING: Record<string, { className: string; dash?: string; r: number }> = {
	anomaly: { className: "ring-anomaly", r: 7.4 },
	interruption: { className: "ring-interruption", dash: "4 2.4", r: 7.4 },
	discontinuity: { className: "ring-discontinuity", dash: "1 2.6", r: 7.4 },
	unrecognized: { className: "ring-unrecognized", dash: "5 2 1 2", r: 7.4 },
};

/** The width of the element it is given, followed from the moment the element exists: the host is not drawn for every read (an absent log has no map), so it can appear later. */
function useWidth(): [(element: HTMLDivElement | null) => void, number] {
	const [element, setElement] = useState<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(900);
	useEffect(() => {
		if (element === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setWidth(Math.max(320, element.clientWidth)));
		observer.observe(element);
		setWidth(Math.max(320, element.clientWidth));
		return () => observer.disconnect();
	}, [element]);
	return [setElement, width];
}

export function Overview({
	model,
	hovered,
	onHover,
	onSelect,
	selected,
}: {
	model: OverviewModel;
	hovered: number | null;
	onHover(sequence: number | null): void;
	onSelect(sequence: number): void;
	selected: number | null;
}): ReactElement {
	const [hostRef, width] = useWidth();
	const lanes = model.lanes;
	const H = TOP + lanes.length * LANE_H + AXIS_H;
	const x0 = GUTTER;
	const x1 = Math.max(x0 + 40, width - PAD_R);
	const xOf = (fraction: number) => x0 + 6 + fraction * (x1 - x0 - 12);
	const yOf = (lane: number) => TOP + lane * LANE_H + LANE_H / 2;
	const ticks = useMemo(() => {
		if (model.span === null) return [];
		const span = model.span;
		const count = span.last - span.first + 1;
		const place = (fraction: number) => x0 + 6 + fraction * (x1 - x0 - 12);
		const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor((x1 - x0) / 80))));
		const out: { x: number; label: string }[] = [];
		for (let p = span.first; p <= span.last; p += every)
			out.push({ x: place((p - span.first + 0.5) / count), label: p.toLocaleString("en-US") });
		if (out.at(-1)?.label !== span.last.toLocaleString("en-US") && every > 1)
			out.push({ x: place((count - 0.5) / count), label: span.last.toLocaleString("en-US") });
		return out;
	}, [model.span, x0, x1]);
	const tip = hovered === null ? null : (model.marks.find((m) => m.sequence === hovered) ?? null);
	const dense = model.dense;
	const summary = `${model.marks.length} recorded events in storage order, in ${lanes.filter((l) => l.count > 0).length} categories. ${model.coverageText}`;

	return (
		<section className="overview" aria-labelledby="overview-title" id="overview">
			<div className="overview-head">
				<h2 id="overview-title" className="eyebrow">
					Overview
				</h2>
				<span className="mono dim small">
					storage order
					{model.span === null
						? ""
						: ` · positions ${model.span.first.toLocaleString("en-US")}–${model.span.last.toLocaleString("en-US")}`}
				</span>
				<ul className="key" aria-label="Key to the marks drawn here">
					{model.classes.map((k) => (
						<li key={k}>
							<ProvGlyph kind={k} size={10} />
							{KEY_LABEL[k] ?? k}
						</li>
					))}
					{model.flags.map((f) => (
						<li key={f} className={`key-ring ring-${f}`}>
							{f}
						</li>
					))}
				</ul>
			</div>
			<p className={`coverage coverage-${model.coverage}`} data-testid="overview-coverage">
				{model.coverageText}
			</p>
			{model.emptyText !== null ? null : (
				// biome-ignore lint/a11y/noStaticElementInteractions: leaving the map clears the hover highlight, a pointer convenience over the table
				<div className="overview-host" ref={hostRef} onMouseLeave={() => onHover(null)}>
					<svg width={width} height={H} role="img" aria-label={summary} className="overview-svg">
						{lanes.map((lane, i) => (
							<g key={lane.category} className={lane.count === 0 ? "lane lane-empty" : "lane"}>
								<rect
									x={0}
									y={TOP + i * LANE_H}
									width={width}
									height={LANE_H}
									className={i % 2 === 0 ? "lane-band" : "lane-band alt"}
								/>
								<text x={10} y={yOf(i) + 3.5} className="lane-label">
									{lane.label}
								</text>
								<text x={GUTTER - 8} y={yOf(i) + 3.5} className="lane-count" textAnchor="end">
									{lane.count === 0 ? "" : lane.count}
								</text>
							</g>
						))}
						{selected !== null && model.marks.some((m) => m.sequence === selected) ? (
							<line
								x1={xOf(model.marks.find((m) => m.sequence === selected)!.x)}
								x2={xOf(model.marks.find((m) => m.sequence === selected)!.x)}
								y1={TOP}
								y2={TOP + lanes.length * LANE_H}
								className="select-guide"
							/>
						) : null}
						{model.marks.map((mark) => {
							const x = xOf(mark.x);
							const y = yOf(mark.lane);
							const isSelected = mark.sequence === selected;
							const ring = mark.flags.map((f) => FLAG_RING[f]).find((r) => r !== undefined);
							return (
								// biome-ignore lint/a11y/noStaticElementInteractions: a pointer convenience over the table, which is the keyboard path
								<g
									key={mark.sequence}
									data-seq={mark.sequence}
									className={`omark-wrap${mark.dim ? " dim" : ""}${isSelected ? " selected" : ""}${hovered === mark.sequence ? " hovered" : ""}`}
									onClick={() => onSelect(mark.sequence)}
									onMouseEnter={() => onHover(mark.sequence)}
								>
									<rect
										x={x - 6}
										y={yOf(mark.lane) - LANE_H / 2}
										width={12}
										height={LANE_H}
										fill="transparent"
									/>
									{dense && !isSelected && ring === undefined ? (
										<rect
											x={x - 0.8}
											y={y - 6}
											width={1.6}
											height={12}
											className={`omark mk-${mark.markClass}`}
											fill="currentColor"
										/>
									) : (
										<MarkShape mark={mark} x={x} y={y} />
									)}
									{mark.flags.map((flag) => {
										const spec = FLAG_RING[flag];
										return spec === undefined ? null : (
											<circle
												key={flag}
												cx={x}
												cy={y}
												r={spec.r + (flag === "anomaly" ? 0 : 0)}
												fill="none"
												className={`ring ${spec.className}`}
												strokeDasharray={spec.dash}
											/>
										);
									})}
									{isSelected ? <circle cx={x} cy={y} r={9.6} fill="none" className="ring-selected" /> : null}
								</g>
							);
						})}
						<g className="axis" transform={`translate(0 ${TOP + lanes.length * LANE_H})`}>
							<line x1={x0} x2={x1} y1={2} y2={2} />
							{ticks.map((tick) => (
								<g key={tick.label}>
									<line x1={tick.x} x2={tick.x} y1={2} y2={6} />
									<text x={tick.x} y={17} textAnchor="middle">
										{tick.label}
									</text>
								</g>
							))}
						</g>
					</svg>
					{tip === null ? null : (
						<div
							className="tip"
							role="presentation"
							style={{ left: Math.min(Math.max(xOf(tip.x), GUTTER + 70), width - 110) }}
						>
							{tip.label}
							{tip.flags.length === 0 ? "" : ` · ${tip.flags.join(", ")}`}
						</div>
					)}
				</div>
			)}
			<LogExtent model={model} />
		</section>
	);
}

/** Where the window lies in the log as read: a thin strip with the window bracketed, or "unknown" when the log has no position. */
function LogExtent({ model }: { model: OverviewModel }): ReactElement {
	return (
		<div className="extent" data-testid="log-extent">
			<span className="dim small">log as read</span>
			{model.logLength === null ? (
				<span className="dim small">position unknown: the source has no position</span>
			) : (
				<>
					<span
						className="extent-bar"
						role="img"
						aria-label={`The log holds ${model.logLength} events as read${model.bracket === null ? "; no window of it is loaded" : "; the loaded window is bracketed"}`}
					>
						{model.bracket === null ? null : (
							<span
								className="extent-window"
								style={{
									left: `${model.bracket.from * 100}%`,
									width: `${Math.max(0.6, (model.bracket.to - model.bracket.from) * 100)}%`,
								}}
							/>
						)}
					</span>
					<span className="mono small">{model.logLength.toLocaleString("en-US")} events</span>
				</>
			)}
		</div>
	);
}
