#!/usr/bin/env node
// Generates docs/images/endophasia-plate-{dark,light}.svg, the README's conceptual title plate.
// Deterministic and dependency-free: run "node docs/images/source/plate.mjs" from the repository root.
// The plate is conceptual artwork, not a rendering of the application.

import { writeFileSync } from "node:fs";

const W = 1280;
const H = 460;
const themes = {
	dark: { bg: "#0c0f10", rule: "#262c2f", ink: "#e6e2d8", dim: "#8a918f", faint: "#4a5355", speech: "#b9a7d9", observed: "#6fb7a4", checked: "#d9a54b", fail: "#d36b5e", authority: "#e6e2d8", gap: "#d9a54b" },
	light: { bg: "#f5f2ea", rule: "#d8d2c4", ink: "#1d2124", dim: "#5f6764", faint: "#b4b0a5", speech: "#6b55a0", observed: "#2f7b69", checked: "#9a6a12", fail: "#a8432f", authority: "#1d2124", gap: "#9a6a12" },
};

const f = (n) => n.toFixed(1);
const MONO = "ui-monospace, 'IBM Plex Mono', SFMono-Regular, Menlo, Consolas, monospace";
const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif";

function speech(x0, x1, y, amp) {
	const pts = [];
	for (let x = x0; x <= x1; x += 2) {
		const t = (x - x0) / (x1 - x0);
		const env = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.8;
		const v = Math.sin(x / 9.5) * 0.55 + Math.sin(x / 23 + 1.3) * 0.3 + Math.sin(x / 4.1 + 0.4) * 0.15;
		pts.push([x, y - v * amp * env]);
	}
	return pts.map((p, i) => (i ? "L" : "M") + f(p[0]) + " " + f(p[1])).join(" ");
}

function reported(x0, x1, y, amp) {
	const pts = [];
	for (let x = x0; x <= x1; x += 2) {
		const t = (x - x0) / (x1 - x0);
		const v = Math.sin(x / 9.5) * 0.55 + Math.sin(x / 23 + 1.3) * 0.3;
		pts.push([x, y - v * amp * (1 - t * 0.35)]);
	}
	return pts.map((p, i) => (i ? "L" : "M") + f(p[0]) + " " + f(p[1])).join(" ");
}

function observed(x0, gapA, gapB, x1, y) {
	const steps = [0, -14, -14, 6, 6, -20, -20, 0, 0, -10, -10, 8, 8, -16, -16, 0, 0, -12, -12, 4];
	const seg = (a, b, offset) => {
		let d = "M" + f(a) + " " + f(y);
		let k = offset;
		for (let x = a; x < b; x += 18) {
			const nx = Math.min(b, x + 18);
			const h = steps[k++ % steps.length];
			d += " L" + f(x) + " " + f(y + h) + " L" + f(nx) + " " + f(y + h);
		}
		return d;
	};
	return [seg(x0, gapA, 0), seg(gapB, x1, 7)];
}

function plate(name) {
	const c = themes[name];
	const xIn0 = 72;
	const xIn1 = 560;
	const xm = 604;
	const x0 = 652;
	const x1 = 1068;
	const yIn = 262;
	const rows = { reported: 182, observed: 252, checked: 308, authority: 364 };
	const [obsA, obsB] = observed(x0, 852, 932, x1, rows.observed);
	const ticks = [];
	for (let y = 168; y <= 392; y += 8) {
		const long = (y - 168) % 56 === 0;
		ticks.push('<line x1="' + (xm - (long ? 9 : 4)) + '" y1="' + y + '" x2="' + xm + '" y2="' + y + '" stroke="' + c.dim + '" stroke-width="1"/>');
	}
	const label = (y, text, note) =>
		'<text x="' + (x1 + 16) + '" y="' + (y + 4) + '" fill="' + c.ink + '" font-family="' + MONO + '" font-size="12" letter-spacing="1.5">' + text + "</text>" +
		'<text x="' + (x1 + 16) + '" y="' + (y + 20) + '" fill="' + c.dim + '" font-family="' + SERIF + '" font-style="italic" font-size="12">' + note + "</text>";
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-labelledby="t d">' +
		'<title id="t">Endophasia</title>' +
		'<desc id="d">Conceptual plate. A wavering line labelled inner speech enters an instrument and leaves as four separate records: reported, observed, checked and authorised. The observed record has a deliberate gap marked unavailable.</desc>' +
		'<rect width="' + W + '" height="' + H + '" rx="14" fill="' + c.bg + '"/>' +
		'<rect x="24.5" y="24.5" width="' + (W - 49) + '" height="' + (H - 49) + '" rx="8" fill="none" stroke="' + c.rule + '"/>' +
		'<text x="72" y="92" fill="' + c.ink + '" font-family="' + MONO + '" font-size="34" letter-spacing="14">ENDOPHASIA</text>' +
		'<text x="74" y="126" fill="' + c.dim + '" font-family="' + SERIF + '" font-style="italic" font-size="20">inner speech, outer evidence</text>' +
		'<text x="' + (W - 72) + '" y="86" text-anchor="end" fill="' + c.dim + '" font-family="' + MONO + '" font-size="11" letter-spacing="2">LOCAL-FIRST · EVIDENCE-AWARE</text>' +
		'<text x="' + (W - 72) + '" y="104" text-anchor="end" fill="' + c.dim + '" font-family="' + MONO + '" font-size="11" letter-spacing="2">AGENT STUDIO</text>' +
		'<text x="' + xIn0 + '" y="190" fill="' + c.dim + '" font-family="' + MONO + '" font-size="11" letter-spacing="2">INNER SPEECH</text>' +
		'<path d="' + speech(xIn0, xIn1, yIn, 54) + '" fill="none" stroke="' + c.speech + '" stroke-width="1.6" stroke-linejoin="round" opacity="0.95"/>' +
		'<path d="' + speech(xIn0, xIn1, yIn + 3, 46) + '" fill="none" stroke="' + c.speech + '" stroke-width="0.8" opacity="0.35"/>' +
		'<text x="' + xIn0 + '" y="352" fill="' + c.dim + '" font-family="' + SERIF + '" font-style="italic" font-size="13">what an agent says, plans and reasons: shown, never believed</text>' +
		'<line x1="' + xm + '" y1="160" x2="' + xm + '" y2="400" stroke="' + c.ink + '" stroke-width="1.2"/>' +
		ticks.join("") +
		'<path d="M' + xIn1 + " " + yIn + " C 580 " + yIn + ", 590 " + yIn + ", " + xm + " " + yIn + '" fill="none" stroke="' + c.speech + '" stroke-width="1.2" opacity="0.6"/>' +
		Object.values(rows).map((y) => '<path d="M' + xm + " " + yIn + " C 624 " + yIn + ", 628 " + y + ", " + x0 + " " + y + '" fill="none" stroke="' + c.faint + '" stroke-width="1"/>').join("") +
		Object.values(rows).map((y) => '<line x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y + '" stroke="' + c.rule + '" stroke-width="1"/>').join("") +
		'<path d="' + reported(x0, x1, rows.reported, 16) + '" fill="none" stroke="' + c.speech + '" stroke-width="1.2" stroke-dasharray="3 4" opacity="0.8"/>' +
		'<path d="' + obsA + '" fill="none" stroke="' + c.observed + '" stroke-width="1.6"/>' +
		'<path d="' + obsB + '" fill="none" stroke="' + c.observed + '" stroke-width="1.6"/>' +
		'<path d="M852 ' + (rows.observed - 26) + " v-6 h80 v6" + '" fill="none" stroke="' + c.gap + '" stroke-width="1"/>' +
		'<line x1="852" y1="' + rows.observed + '" x2="932" y2="' + rows.observed + '" stroke="' + c.gap + '" stroke-width="1" stroke-dasharray="2 5"/>' +
		'<text x="892" y="' + (rows.observed - 36) + '" text-anchor="middle" fill="' + c.gap + '" font-family="' + MONO + '" font-size="10" letter-spacing="2">UNAVAILABLE</text>' +
		'<g stroke="' + c.fail + '" stroke-width="1.6"><line x1="752" y1="' + (rows.checked - 6) + '" x2="764" y2="' + (rows.checked + 6) + '"/><line x1="764" y1="' + (rows.checked - 6) + '" x2="752" y2="' + (rows.checked + 6) + '"/></g>' +
		'<text x="758" y="' + (rows.checked + 24) + '" text-anchor="middle" fill="' + c.dim + '" font-family="' + MONO + '" font-size="10">6712eae</text>' +
		'<circle cx="990" cy="' + rows.checked + '" r="5.5" fill="' + c.checked + '"/>' +
		'<text x="990" y="' + (rows.checked + 24) + '" text-anchor="middle" fill="' + c.dim + '" font-family="' + MONO + '" font-size="10">HEAD</text>' +
		'<path d="M' + x0 + " " + rows.authority + " H1006 V" + (rows.authority - 22) + " H1014 V" + rows.authority + " H" + x1 + '" fill="none" stroke="' + c.authority + '" stroke-width="1.6"/>' +
		'<text x="1010" y="' + (rows.authority + 20) + '" text-anchor="middle" fill="' + c.dim + '" font-family="' + MONO + '" font-size="10">operator</text>' +
		label(rows.reported, "REPORTED", "not evidence") +
		label(rows.observed, "OBSERVED", "gaps stay gaps") +
		label(rows.checked, "CHECKED", "not acceptance") +
		label(rows.authority, "AUTHORISED", "rare, explicit") +
		'<text x="72" y="' + (H - 44) + '" fill="' + c.dim + '" font-family="' + MONO + '" font-size="10" letter-spacing="1.5">FIG. 0 · CONCEPTUAL PLATE · ONE SIGNAL, FOUR RECORDS</text>' +
		"</svg>\n";
}

for (const name of Object.keys(themes)) writeFileSync("docs/images/endophasia-plate-" + name + ".svg", plate(name));
