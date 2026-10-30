// The Field's renderer: a contour map drawn in text, behind DEVELOP when the Field appearance is chosen. It is loaded on demand (its own
// file in the bundle) and only then; Instrument never loads it. It is given one thing, the field signal (model/field.ts), and nothing
// else: no conversation text, no path, no grant, no request function. It draws; it decides nothing.
//
// Cost is bounded on purpose: Canvas 2D (no GPU needed), at most 1.5 device pixels per CSS pixel, at most MAX_CELLS character cells,
// at most 30 frames a second where nothing is being read and 15 behind a conversation, and no frame at all while the field is still, the
// page is hidden, the operator paused it or the system asks for reduced motion. The noise is seeded, so a still frame is the same frame
// every time. Glyphs are ASCII only: the bundled mono face is a latin subset, and a glyph it lacks would be drawn by whatever font the
// machine has.
import { type ReactElement, useEffect, useRef } from "react";
import type { FieldSignal } from "../model/field.ts";

/** The face's size in CSS pixels, and the line it sits on. A cell is one character of the bundled mono face wide. */
const FONT_PX = 11;
const LINE = 1.18;
const MAX_CELLS = 30_000;
const MAX_SCALE = 1.5;
/** Where land begins: below it is open water, drawn as a sparse stipple. */
const SEA = 0.53;
/** Terraces between the coast and the highest ground. Their edges are left empty: the contour lines are the gaps. */
const RINGS = 6;
const GAP = 0.2;
// The fill of each terrace, lightest to densest, two characters each so a terrace is a texture and not a wall. ASCII only (see above).
const GLYPHS = ["..", ".:", ":-", "-=", "=+", "+*", "*#"] as const;
/** Each glyph is drawn at one of these strengths: a row is one call per strength, not one per character. */
const BUCKETS = 5;
/** Where the light comes from (up and to the left), for a little relief on the slopes. */
const LIGHT = { x: -0.62, y: -0.78 };
const INK = "rgb(196 190 178)";
const AMBER = "rgb(227 176 75)";
const SEED = 0x2f6b9d;

/** A hash of a lattice point: deterministic, so the same field is drawn on every machine and in every screenshot. */
function hash(x: number, y: number): number {
	let h = (x * 374761393 + y * 668265263 + SEED) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t: number) => t * t * (3 - 2 * t);
function noise(x: number, y: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const u = fade(x - xi);
	const v = fade(y - yi);
	const a = hash(xi, yi);
	const b = hash(xi + 1, yi);
	const c = hash(xi, yi + 1);
	const d = hash(xi + 1, yi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Two octaves over one gentle warp: broad landforms with a little coastline, never busy. */
function terrain(x: number, y: number, p: number, flow: number): number {
	const warp = noise(y * 0.5 + p * 0.09, x * 0.5 - 3.1) - 0.5;
	const wx = x + 1.1 * warp + flow;
	const wy = y - 0.8 * warp + p * 0.04;
	return 0.84 * noise(wx, wy) + 0.16 * noise(wx * 2.7 + 11.1, wy * 2.7 - p * 0.06);
}

export default function FieldCanvas({ signal }: { signal: FieldSignal }): ReactElement {
	const canvas = useRef<HTMLCanvasElement>(null);
	const latest = useRef(signal);
	latest.current = signal;
	// The loop's controls, kept outside React state: a frame never causes a render.
	const kick = useRef<(() => void) | null>(null);

	useEffect(() => {
		const el = canvas.current;
		if (el === null) return;
		const ctx = el.getContext("2d", { alpha: true });
		if (ctx === null) {
			el.dataset.state = "unavailable";
			return;
		}
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		let frame = 0;
		let last = 0;
		let phase = 0;
		let flow = 0;
		let speed = 0;
		let frames = 0;
		let cost = 0;
		let computed = 0;
		let cols = 0;
		let rows = 0;
		let cw = 7;
		let ch = 13;
		let px = FONT_PX;
		let scale = 1;
		let grid = new Float32Array(0);
		let lattice = new Float32Array(0);
		// Per row and strength, the characters to draw there (a space where there is none); amber rows for what waits on the operator.
		let lines: string[][] = [];
		let warm: string[][] = [];
		let dead = false;
		let ready = false;
		let lastPulse = latest.current.pulse;
		let ripple = -1;
		const pointer = { x: 0, y: 0, weight: 0, target: 0 };

		const size = () => {
			const w = Math.max(1, el.clientWidth);
			const h = Math.max(1, el.clientHeight);
			scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE);
			el.width = Math.round(w * scale);
			el.height = Math.round(h * scale);
			ctx.setTransform(scale, 0, 0, scale, 0, 0);
			// A very large window gets a larger face rather than more cells.
			px = FONT_PX;
			for (;;) {
				ctx.font = `${px}px "IBM Plex Mono", ui-monospace, monospace`;
				cw = ctx.measureText("0").width || px * 0.6;
				ch = Math.round(px * LINE);
				if ((w / cw) * (h / ch) <= MAX_CELLS) break;
				px += 1;
			}
			ctx.textBaseline = "top";
			cols = Math.ceil(w / cw) + 1;
			rows = Math.ceil(h / ch) + 1;
			grid = new Float32Array(cols * rows);
		};

		const draw = (now: number) => {
			const s = latest.current;
			const started = performance.now();
			const w = el.width;
			const h = el.height;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, w, h);
			ctx.setTransform(scale, 0, 0, scale, 0, 0);
			if (s.presence <= 0) return;
			const unit = 44; // cells per noise unit across: broad forms
			const aspect = ch / cw;
			const atX = pointer.x / cw;
			const atY = pointer.y / ch;
			const ripR = ripple < 0 ? -1 : ((now - ripple) / 2600) * Math.max(cols, rows * aspect) * 0.9;
			const ripA = ripple < 0 ? 0 : Math.max(0, 1 - (now - ripple) / 2600) * 0.16;
			const ox = cols / 2;
			const oy = rows * 0.92;
			// The terrain is smooth at this scale, so it is sampled on every other cell and filled in between.
			const lw = (cols >> 1) + 2;
			const lh = (rows >> 1) + 2;
			if (lattice.length < lw * lh) lattice = new Float32Array(lw * lh);
			for (let b = 0; b < lh; b++)
				for (let a = 0; a < lw; a++)
					lattice[b * lw + a] = terrain((a * 2) / unit, (b * 2 * aspect) / unit, phase, flow);
			for (let j = 0; j < rows; j++)
				for (let i = 0; i < cols; i++) {
					const a = i >> 1;
					const b = j >> 1;
					const u = (i & 1) * 0.5;
					const v = (j & 1) * 0.5;
					const top = lattice[b * lw + a]! + (lattice[b * lw + a + 1]! - lattice[b * lw + a]!) * u;
					const bottom =
						lattice[(b + 1) * lw + a]! + (lattice[(b + 1) * lw + a + 1]! - lattice[(b + 1) * lw + a]!) * u;
					let f = top + (bottom - top) * v;
					if (pointer.weight > 0.001) {
						const dx = i - atX;
						const dy = (j - atY) * aspect;
						f += 0.22 * pointer.weight * Math.exp(-(dx * dx + dy * dy) / 90);
					}
					if (ripA > 0) {
						const dx = i - ox;
						const dy = (j - oy) * aspect;
						const d = Math.sqrt(dx * dx + dy * dy) - ripR;
						f += ripA * Math.exp(-(d * d) / 18);
					}
					grid[j * cols + i] = f;
				}
			const dashed = s.texture === "dashed";
			const base = 0.62 * s.presence;
			const blank = "";
			lines = Array.from({ length: BUCKETS }, () => []);
			warm = Array.from({ length: BUCKETS }, () => []);
			// One row of character codes per strength (and per strength in amber), reused: a cell writes one code into one of them.
			const codes = Array.from({ length: BUCKETS * 2 }, () => new Uint16Array(cols).fill(32));
			const span = new Int32Array(BUCKETS * 4);
			for (let j = 1; j < rows - 1; j++) {
				const used = new Uint8Array(BUCKETS * 2);
				span.fill(-1);
				for (let i = 1; i < cols - 1; i++) {
					const f = grid[j * cols + i]!;
					const land = (f - SEA) / (1 - SEA);
					let glyph = "";
					let alpha = 0;
					let high = false;
					if (land <= 0) {
						// Open water: a sparse, even stipple.
						if (hash(i, j) < 0.012) {
							glyph = ".";
							alpha = 0.3;
						}
					} else {
						const v = Math.min(0.999, land * 1.7) * RINGS;
						const k = Math.floor(v);
						const frac = v - k;
						// The edge of each terrace is left empty, so the rings read as contour lines drawn in negative space. A
						// broken (unknown) field leaves every other stretch of each terrace empty too: the instrument's dashed texture.
						const gap = frac < GAP || (dashed && (Math.floor(i / 4) + Math.floor(j / 2)) % 2 === 0);
						if (!gap && hash(i, j) < 0.86 - 0.04 * k) {
							const gx = (grid[j * cols + i + 1]! - grid[j * cols + i - 1]!) / 2;
							const gy = ((grid[(j + 1) * cols + i]! - grid[(j - 1) * cols + i]!) / 2) * (cw / ch);
							const slope = Math.hypot(gx, gy) || 1;
							const lit = Math.max(0, -(gx * LIGHT.x + gy * LIGHT.y) / slope);
							const pair = GLYPHS[Math.min(GLYPHS.length - 1, k)]!;
							glyph = pair[hash(j, i) < 0.5 ? 0 : 1]!;
							alpha = (0.28 + 0.085 * k) * (0.7 + 0.55 * lit) * (k === 0 ? Math.min(1, frac * 2.2) : 1);
							high = k >= RINGS - 2;
						}
					}
					if (glyph === "" || alpha < 0.05) continue;
					const b = Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS)) + (s.attention && high ? BUCKETS : 0);
					codes[b]![i] = glyph.charCodeAt(0);
					if (span[b * 2]! < 0) span[b * 2] = i;
					span[b * 2 + 1] = i;
					used[b] = 1;
				}
				for (let b = 0; b < BUCKETS * 2; b++) {
					const out = b < BUCKETS ? lines[b]! : warm[b - BUCKETS]!;
					if (!used[b]) {
						out[j] = blank;
						continue;
					}
					const from = span[b * 2]!;
					const to = span[b * 2 + 1]! + 1;
					const row = codes[b]!;
					// The row starts where its first character is (a leading run of spaces is not shaped): the offset is kept in the text's
					// first position as a count of cells, read back when it is drawn.
					out[j] = `${from}|${String.fromCharCode.apply(null, row.subarray(from, to) as unknown as number[])}`;
					row.fill(32, from, to);
				}
			}
			computed = performance.now() - started;
			ctx.font = `${px}px "IBM Plex Mono", ui-monospace, monospace`;
			for (const [set, colour] of [
				[lines, INK],
				[warm, AMBER],
			] as const) {
				ctx.fillStyle = colour;
				for (let b = 0; b < BUCKETS; b++) {
					ctx.globalAlpha = Math.min(1, base * ((b + 0.5) / BUCKETS) * (colour === AMBER ? 1.4 : 1));
					const set_b = set[b]!;
					for (let j = 1; j < rows - 1; j++) {
						const text = set_b[j];
						if (text === undefined || text === blank) continue;
						const bar = text.indexOf("|");
						ctx.fillText(text.slice(bar + 1), Number(text.slice(0, bar)) * cw, j * ch);
					}
				}
			}
			ctx.globalAlpha = 1;
			frames += 1;
			cost = cost === 0 ? performance.now() - started : cost * 0.9 + (performance.now() - started) * 0.1;
			if (frames % 15 === 1) report();
		};

		const report = () => {
			el.dataset.frames = String(frames);
			el.dataset.cost = cost.toFixed(1);
			el.dataset.compute = computed.toFixed(1);
		};

		const wanted = () => {
			const s = latest.current;
			if (dead || !ready || document.hidden || reduced.matches) return false;
			// Settling counts as moving: the field eases to a stop rather than freezing mid-stroke.
			return s.motion === "drift" || s.motion === "current" || speed > 0.002 || pointer.weight > 0.01 || ripple >= 0;
		};

		const tick = (now: number) => {
			frame = 0;
			const s = latest.current;
			// Text moves a cell at a time, so a slow field needs few frames: 15 a second where it is the scene, 8 behind work.
			const fps = s.presence >= 0.9 ? 15 : 8;
			const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000);
			if (last !== 0 && now - last < 1000 / fps - 2) {
				frame = requestAnimationFrame(tick);
				return;
			}
			last = now;
			const target = s.motion === "drift" || s.motion === "current" ? s.tempo : 0;
			speed += (target - speed) * Math.min(1, dt * 1.8);
			phase += speed * dt * 0.6;
			if (s.motion === "current") flow += speed * dt * 0.35;
			pointer.weight += (pointer.target - pointer.weight) * Math.min(1, dt * 3);
			if (ripple >= 0 && now - ripple > 2600) ripple = -1;
			try {
				draw(now);
			} catch {
				stop("unavailable");
				return;
			}
			if (wanted()) frame = requestAnimationFrame(tick);
			else stop("still");
		};

		const stop = (state: "still" | "unavailable" | "hidden") => {
			if (frame !== 0) cancelAnimationFrame(frame);
			frame = 0;
			last = 0;
			el.dataset.running = "false";
			el.dataset.state = state;
			report();
		};
		const start = () => {
			if (frame !== 0 || !wanted()) return;
			el.dataset.running = "true";
			el.dataset.state = "moving";
			frame = requestAnimationFrame(tick);
		};
		/** Something changed: draw the still frame now, or let the loop pick it up. */
		const refresh = () => {
			if (!ready || dead) return;
			const s = latest.current;
			if (s.pulse > lastPulse && (s.motion === "drift" || s.motion === "current") && !reduced.matches)
				ripple = performance.now();
			lastPulse = s.pulse;
			if (!s.responsive) pointer.target = 0;
			if (wanted()) start();
			else {
				if (reduced.matches || s.motion === "still" || s.motion === "held") speed = 0;
				try {
					draw(performance.now());
				} catch {
					stop("unavailable");
					return;
				}
				stop(document.hidden ? "hidden" : "still");
			}
		};
		kick.current = refresh;

		const resize = new ResizeObserver(() => {
			size();
			refresh();
		});
		const visible = () => (document.hidden ? stop("hidden") : refresh());
		const move = (event: PointerEvent) => {
			if (!latest.current.responsive || event.pointerType === "touch") return;
			const box = el.getBoundingClientRect();
			pointer.x = event.clientX - box.left;
			pointer.y = event.clientY - box.top;
			pointer.target = 1;
			start();
		};
		const leave = () => {
			pointer.target = 0;
		};
		const lost = (event: Event) => {
			event.preventDefault();
			stop("unavailable");
		};
		const restored = () => {
			size();
			refresh();
		};

		size();
		resize.observe(el);
		document.addEventListener("visibilitychange", visible);
		reduced.addEventListener("change", refresh);
		window.addEventListener("pointermove", move, { passive: true });
		document.documentElement.addEventListener("pointerleave", leave);
		el.addEventListener("contextlost", lost);
		el.addEventListener("contextrestored", restored);
		// The glyphs are drawn in the bundled mono face, so the atlas waits for it (a fallback face is used if it never loads).
		document.fonts
			.load(`12px "IBM Plex Mono"`)
			.catch(() => [])
			.then(() => {
				if (dead) return;
				ready = true;
				size();
				refresh();
			});

		return () => {
			dead = true;
			kick.current = null;
			if (frame !== 0) cancelAnimationFrame(frame);
			resize.disconnect();
			document.removeEventListener("visibilitychange", visible);
			reduced.removeEventListener("change", refresh);
			window.removeEventListener("pointermove", move);
			document.documentElement.removeEventListener("pointerleave", leave);
			el.removeEventListener("contextlost", lost);
			el.removeEventListener("contextrestored", restored);
		};
	}, []);

	// A new signal: the loop reads it on its next frame; a still field is redrawn once, now.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each field of the signal is a reason to redraw
	useEffect(() => {
		kick.current?.();
	}, [
		signal.motion,
		signal.tempo,
		signal.texture,
		signal.attention,
		signal.presence,
		signal.pulse,
		signal.responsive,
	]);

	return <canvas ref={canvas} className="field-canvas" data-running="false" data-state="loading" />;
}
