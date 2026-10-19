// Small SVG marks for states, in shapes that differ without colour: a state is never only a colour. Each is a 12-unit box that
// inherits the text colour (`currentColor`), so the style sheet decides the colour and the shape carries the meaning.
import { svg } from "./dom.ts";

const base = {
	viewBox: "0 0 12 12",
	width: "12",
	height: "12",
	"aria-hidden": "true",
	focusable: "false",
	class: "icon",
};
const common = { stroke: "currentColor", "stroke-width": "1.4" };

/** A source's condition: readable is a solid disc, empty a ring, absent a dashed ring, degraded a triangle, unopenable a crossed box. */
export function sourceStateIcon(state: string): SVGElement {
	switch (state) {
		case "readable":
			return svg("svg", base, svg("circle", { cx: "6", cy: "6", r: "4.2", fill: "currentColor" }));
		case "empty":
			return svg("svg", base, svg("circle", { cx: "6", cy: "6", r: "4", fill: "none", ...common }));
		case "absent":
			return svg(
				"svg",
				base,
				svg("circle", { cx: "6", cy: "6", r: "4", fill: "none", ...common, "stroke-dasharray": "1.6 1.8" }),
			);
		case "degraded":
			return svg("svg", base, svg("path", { d: "M6 1.6 L11 10.4 H1 Z", fill: "currentColor" }));
		case "unopenable":
			return svg(
				"svg",
				base,
				svg("rect", { x: "1.6", y: "1.6", width: "8.8", height: "8.8", fill: "none", ...common }),
				svg("path", { d: "M3.8 3.8 L8.2 8.2 M8.2 3.8 L3.8 8.2", fill: "none", ...common }),
			);
		default:
			return svg(
				"svg",
				base,
				svg("path", {
					d: "M6 1.8 L10.2 6 L6 10.2 L1.8 6 Z",
					fill: "none",
					...common,
					"stroke-dasharray": "1.4 1.4",
				}),
			);
	}
}

/** A capability's recorded status: admitted a disc, partial a half disc, unavailable a slashed ring, mismatch a diamond, unverified a dotted ring. */
export function capabilityStatusIcon(status: string): SVGElement {
	switch (status) {
		case "admitted":
			return svg("svg", base, svg("circle", { cx: "6", cy: "6", r: "4.2", fill: "currentColor" }));
		case "admitted-partial":
			return svg(
				"svg",
				base,
				svg("circle", { cx: "6", cy: "6", r: "4", fill: "none", ...common }),
				svg("path", { d: "M6 2 A4 4 0 0 0 6 10 Z", fill: "currentColor" }),
			);
		case "unavailable":
			return svg(
				"svg",
				base,
				svg("circle", { cx: "6", cy: "6", r: "4", fill: "none", ...common }),
				svg("path", { d: "M3.2 8.8 L8.8 3.2", fill: "none", ...common }),
			);
		case "mismatch":
			return svg("svg", base, svg("path", { d: "M6 1.4 L10.6 6 L6 10.6 L1.4 6 Z", fill: "currentColor" }));
		case "unverified":
			return svg(
				"svg",
				base,
				svg("circle", { cx: "6", cy: "6", r: "4", fill: "none", ...common, "stroke-dasharray": "1.6 1.8" }),
				svg("circle", { cx: "6", cy: "6", r: "1", fill: "currentColor" }),
			);
		default:
			return svg(
				"svg",
				base,
				svg("path", {
					d: "M6 1.8 L10.2 6 L6 10.2 L1.8 6 Z",
					fill: "none",
					...common,
					"stroke-dasharray": "1.4 1.4",
				}),
			);
	}
}

/** The mark of the cockpit: two interlocked rings, drawn in the page's own colours. */
export function brandMark(): SVGElement {
	return svg(
		"svg",
		{
			viewBox: "0 0 28 20",
			width: "28",
			height: "20",
			"aria-hidden": "true",
			focusable: "false",
			class: "brand-mark",
		},
		svg("circle", { cx: "9.5", cy: "10", r: "7.5", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }),
		svg("circle", { cx: "18.5", cy: "10", r: "7.5", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }),
	);
}
