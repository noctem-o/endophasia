// Marks. Every mark carries its meaning in SHAPE first and hue second, so what a record is survives colour-vision deficiency, tiny
// sizes and monochrome printing. Provenance (how a value is known) is a family of discs and a diamond; the condition of a source and the
// recorded status of a capability are a separate family of squares, so a status can never be read as an evidence class. Hue is spent on
// provenance, attention and fault; selection is neutral. "ok" is the uncoloured default: a deviation is what is marked.
import type { ReactElement } from "react";

const RING = { fill: "none", stroke: "currentColor", strokeWidth: 1.4 } as const;

/** How a value is known, or what an overview mark stands for. `kind` is a basis, "mixed", "envelope" or anything else (unknown). */
export function ProvGlyph({ kind, size = 12 }: { kind: string; size?: number }): ReactElement {
	const body = (() => {
		switch (kind) {
			case "observed":
				return <circle cx="6" cy="6" r="4.4" fill="currentColor" />;
			case "reported":
				return (
					<>
						<circle cx="6" cy="6" r="4" {...RING} />
						<path d="M6 2a4 4 0 0 0 0 8z" fill="currentColor" />
					</>
				);
			case "derived":
				return <path d="M6 1 11 6 6 11 1 6z" fill="currentColor" />;
			case "inferred":
				return <path d="M6 1.4 11 6 6 10.6 1 6z" {...RING} />;
			case "unavailable":
				return <circle cx="6" cy="6" r="4" {...RING} strokeDasharray="2 1.7" />;
			case "mixed":
				return (
					<>
						<circle cx="6" cy="6" r="4.4" {...RING} />
						<path d="M6 3.6 8.4 6 6 8.4 3.6 6z" fill="currentColor" />
					</>
				);
			case "envelope":
				return (
					<rect x="3" y="3" width="6" height="6" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
				);
			default:
				return <path d="M2.4 2.4h7.2v7.2H2.4z" {...RING} strokeDasharray="1.4 1.4" />;
		}
	})();
	return (
		<svg
			viewBox="0 0 12 12"
			width={size}
			height={size}
			aria-hidden="true"
			focusable="false"
			className={`glyph mk-${kind}`}
		>
			{body}
		</svg>
	);
}

/** A source's condition, in the square family: readable solid, empty hollow, absent a bar, degraded half, unopenable crossed. */
export function ConditionGlyph({ state }: { state: string }): ReactElement {
	const body = (() => {
		switch (state) {
			case "readable":
				return <rect x="2" y="2" width="8" height="8" rx="1.4" fill="currentColor" />;
			case "empty":
				return <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.1" {...RING} strokeWidth="1.3" />;
			case "absent":
				return <path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />;
			case "degraded":
				return (
					<>
						<rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.1" {...RING} strokeWidth="1.3" />
						<path d="M2.6 3.7a1.1 1.1 0 0 1 1.1-1.1H6v6.8H3.7a1.1 1.1 0 0 1-1.1-1.1z" fill="currentColor" />
					</>
				);
			case "unopenable":
				return (
					<path
						d="M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				);
			default:
				return (
					<rect
						x="2.6"
						y="2.6"
						width="6.8"
						height="6.8"
						rx="1.1"
						{...RING}
						strokeWidth="1.3"
						strokeDasharray="1.4 1.4"
					/>
				);
		}
	})();
	return (
		<svg
			viewBox="0 0 12 12"
			width={12}
			height={12}
			aria-hidden="true"
			focusable="false"
			className={`glyph cond-${state}`}
		>
			{body}
		</svg>
	);
}

/** A capability's recorded status: admitted solid, partial half, unverified hollow, unavailable dashed, mismatch a triangle. */
export function StatusGlyph({ status }: { status: string }): ReactElement {
	const body = (() => {
		switch (status) {
			case "admitted":
				return <rect x="2" y="2" width="8" height="8" rx="1.4" fill="currentColor" />;
			case "admitted-partial":
				return (
					<>
						<rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.1" {...RING} strokeWidth="1.3" />
						<path d="M2.6 3.7a1.1 1.1 0 0 1 1.1-1.1H6v6.8H3.7a1.1 1.1 0 0 1-1.1-1.1z" fill="currentColor" />
					</>
				);
			case "unverified":
				return <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.1" {...RING} strokeWidth="1.3" />;
			case "mismatch":
				return <path d="M6 1.4 11 10.4H1z" fill="currentColor" />;
			case "unavailable":
				return (
					<rect
						x="2.6"
						y="2.6"
						width="6.8"
						height="6.8"
						rx="1.1"
						{...RING}
						strokeWidth="1.3"
						strokeDasharray="2 1.7"
					/>
				);
			default:
				return (
					<rect
						x="2.6"
						y="2.6"
						width="6.8"
						height="6.8"
						rx="1.1"
						{...RING}
						strokeWidth="1.3"
						strokeDasharray="1.4 1.4"
					/>
				);
		}
	})();
	return (
		<svg
			viewBox="0 0 12 12"
			width={12}
			height={12}
			aria-hidden="true"
			focusable="false"
			className={`glyph status-${status}`}
		>
			{body}
		</svg>
	);
}
