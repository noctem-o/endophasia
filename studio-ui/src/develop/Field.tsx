// The Field appearance of DEVELOP: the parts it adds to the workspace. The workspace's components, state and actions are the same in
// both appearances; Field draws an atmosphere behind them (the contour field, night weather, or nothing; each renderer loaded on
// demand), says in a legend what is drawn and what it means, and, where there is nothing to read yet, sets out the ledger of what is
// known, what is not, what can be done and what is the operator's. It holds no state of its own: whether motion is paused and which
// atmosphere is chosen live in the shell, in memory only.
import { Component, lazy, type ReactElement, type ReactNode, Suspense, useEffect, useState } from "react";
import type { FieldSignal } from "../model/field.ts";
import type { Ledger, LedgerBasis, LedgerLine } from "../model/ledger.ts";
import { ATMOSPHERE_LABEL, ATMOSPHERES, type Atmosphere, isAtmosphere, legendWords } from "../model/weather.ts";
import { ProvGlyph } from "../ui/marks.tsx";

// The renderer is its own file in the bundle, requested only when the Field appearance is first shown. If that file cannot be loaded, the
// field is simply left out: the import resolves to nothing rather than throwing (a thrown error would also be printed to the console with
// the page's address in it).
type Renderer = { default: (props: { signal: FieldSignal }) => ReactElement | null };
const Absent = (): null => null;
const FieldCanvas = lazy(
	(): Promise<Renderer> => import("./FieldCanvas.tsx").catch((): Renderer => ({ default: Absent })),
);
// The weather is another file again, requested only when Rain or Storm is first chosen. It is given no signal: weather is scenery.
type Weather = { default: (props: { atmosphere: "rain" | "storm"; paused: boolean }) => ReactElement | null };
const WeatherCanvas = lazy(
	(): Promise<Weather> => import("./WeatherCanvas.tsx").catch((): Weather => ({ default: Absent })),
);

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Whether the system asks for reduced motion. Follows the media query's own change event. */
export function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED).matches);
	useEffect(() => {
		const query = window.matchMedia(REDUCED);
		const change = () => setReduced(query.matches);
		query.addEventListener("change", change);
		change();
		return () => query.removeEventListener("change", change);
	}, []);
	return reduced;
}

/**
 * The renderer is decoration: if its file cannot be loaded or it fails, it is left out and the layer's own background stays. Its failure
 * never reaches the workspace's boundary, which would take the conversation, the composer and STOP with it.
 */
class Optional extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}
	override componentDidCatch(): void {
		// Nothing is logged: the page sends nothing anywhere.
	}
	override render(): ReactNode {
		return this.state.failed ? null : this.props.children;
	}
}

/**
 * The atmosphere: a fixed layer behind the workspace. Whatever is drawn in it is decoration (hidden from assistive technology, never a
 * target); the legend says what it is. With no atmosphere the layer is empty and nothing is loaded.
 */
export function FieldLayer({
	signal,
	atmosphere,
	paused,
}: {
	signal: FieldSignal;
	atmosphere: Atmosphere;
	/** The operator paused motion. (The contours are told through their signal; the weather is told here.) */
	paused: boolean;
}): ReactElement {
	const weather = atmosphere === "rain" || atmosphere === "storm";
	return (
		<div
			className="field-layer"
			aria-hidden="true"
			data-atmosphere={atmosphere}
			data-motion={signal.motion}
			data-texture={signal.texture}
			data-attention={signal.attention}
		>
			{atmosphere === "none" ? null : (
				// Rain and Storm are one renderer, kept while switching between them: the same sky, with or without lightning.
				<Optional key={weather ? "weather" : "contours"}>
					<Suspense fallback={null}>
						{weather ? (
							<WeatherCanvas atmosphere={atmosphere} paused={paused} />
						) : (
							<FieldCanvas signal={signal} />
						)}
					</Suspense>
				</Optional>
			)}
		</div>
	);
}

/** One line under the workspace: what is drawn behind it and what that means, in words; which atmosphere; and the control that stops it. */
export function FieldLegend({
	signal,
	atmosphere,
	paused,
	reduced,
	onPause,
	onAtmosphere,
}: {
	signal: FieldSignal;
	atmosphere: Atmosphere;
	paused: boolean;
	reduced: boolean;
	onPause(paused: boolean): void;
	onAtmosphere(atmosphere: Atmosphere): void;
}): ReactElement {
	const none = atmosphere === "none";
	return (
		<footer
			className="field-legend"
			data-testid="field-legend"
			data-motion={signal.motion}
			data-atmosphere={atmosphere}
		>
			<span
				className="field-key"
				aria-hidden="true"
				data-motion={signal.motion}
				data-texture={signal.texture}
				data-atmosphere={atmosphere}
			/>
			<span className="field-words" data-testid="field-words">
				<span className="field-label">Field</span>{" "}
				{legendWords(atmosphere, signal, reduced ? "reduced" : paused ? "paused" : "no")}
			</span>
			<label
				className="field-atmosphere"
				title="What is drawn behind the work. Nothing else changes, and it is not kept after a reload."
			>
				<span className="field-atmosphere-label">Atmosphere</span>
				<select
					className="field-atmosphere-select"
					data-testid="atmosphere"
					value={atmosphere}
					onChange={(event) => {
						if (isAtmosphere(event.target.value)) onAtmosphere(event.target.value);
					}}
				>
					{ATMOSPHERES.map((a) => (
						<option key={a} value={a}>
							{ATMOSPHERE_LABEL[a]}
						</option>
					))}
				</select>
			</label>
			<button
				type="button"
				className="field-pause"
				data-testid="field-pause"
				disabled={reduced || none}
				title={
					none
						? "With no atmosphere nothing moves."
						: reduced
							? "Your system asks for reduced motion, so the field is drawn once and never moves."
							: "Stop or start the field's motion. Nothing else changes."
				}
				onClick={() => onPause(!paused)}
			>
				{none ? "Nothing moves" : reduced ? "Motion off (system)" : paused ? "Resume motion" : "Pause motion"}
			</button>
		</footer>
	);
}

const BASIS_WORD: Readonly<Record<LedgerBasis, string>> = {
	observed: "observed",
	reported: "reported",
	recorded: "recorded",
	unavailable: "not known",
	standing: "how it works",
};

function Lines({ lines, empty }: { lines: readonly LedgerLine[]; empty: string }): ReactElement {
	if (lines.length === 0) return <p className="ledger-empty">{empty}</p>;
	return (
		<ul className="ledger-lines">
			{lines.map((line) => (
				<li key={line.text} data-basis={line.basis}>
					<span className="ledger-mark" title={BASIS_WORD[line.basis]}>
						{line.basis === "standing" ? (
							<span className="ledger-rule" aria-hidden="true" />
						) : line.basis === "recorded" ? (
							// Solid is the instrument's texture for what was recorded; a square keeps it out of the provenance discs.
							<svg
								viewBox="0 0 12 12"
								width={10}
								height={10}
								aria-hidden="true"
								focusable="false"
								className="glyph"
							>
								<rect x="2.5" y="2.5" width="7" height="7" rx="0.8" fill="currentColor" />
							</svg>
						) : (
							<ProvGlyph kind={line.basis} size={10} />
						)}
						<span className="sr-only">{BASIS_WORD[line.basis]}: </span>
					</span>
					<span>{line.text}</span>
				</li>
			))}
		</ul>
	);
}

/** What DEVELOP says when there is nothing to read yet. The actions it names are the page's real controls, which sit where they always do. */
export function Arrival({ ledger, compact = false }: { ledger: Ledger; compact?: boolean }): ReactElement {
	return (
		// The frame is the ledger's container: its columns follow the width the ledger has, wherever it is placed.
		<div className="arrival-frame">
			<section className="arrival" data-testid="arrival" aria-labelledby="arrival-statement" data-compact={compact}>
				<p className="arrival-kicker">Develop</p>
				<h2 className="arrival-statement" id="arrival-statement" data-testid="arrival-statement">
					{ledger.statement.before}
					{ledger.statement.mono === null ? null : <span className="mono">{ledger.statement.mono}</span>}
					{ledger.statement.after}
				</h2>
				<p className="arrival-source">{ledger.source}</p>
				<div className="ledger" data-testid="ledger">
					<section className="ledger-col" data-col="known" aria-labelledby="ledger-known">
						<h3 id="ledger-known">Known</h3>
						<Lines lines={ledger.known} empty="Nothing yet." />
					</section>
					<section className="ledger-col" data-col="unknown" aria-labelledby="ledger-unknown">
						<h3 id="ledger-unknown">Not known</h3>
						<Lines lines={ledger.unknown} empty="Nothing listed." />
					</section>
					<section className="ledger-col" data-col="possible" aria-labelledby="ledger-possible">
						<h3 id="ledger-possible">Possible here</h3>
						<Lines lines={ledger.possible} empty="Nothing can be done from this page now." />
					</section>
					<section className="ledger-col" data-col="yours" aria-labelledby="ledger-yours">
						<h3 id="ledger-yours">Yours</h3>
						<Lines lines={ledger.yours} empty="Nothing waits for you." />
					</section>
				</div>
			</section>
		</div>
	);
}

/** Pinned under the run strip while something waits for the terminal: plain text, never a control. */
export function Beacon({
	operation,
	digest,
	expires,
}: {
	operation: string;
	digest: string;
	expires: string;
}): ReactElement {
	return (
		<p className="field-beacon" data-testid="field-beacon">
			<span className="beacon-key" aria-hidden="true">
				&gt;_
			</span>
			<span>
				<strong>Waiting for you in the attached terminal.</strong> Approve or decline the {operation} there (digest{" "}
				<span className="mono">{digest}</span>, until {expires}, browser clock). This page cannot approve it.
			</span>
		</p>
	);
}
