// Night weather behind DEVELOP, for the Field appearance's Rain and Storm atmospheres. Loaded on demand (its own file in the bundle),
// and only when one of them is chosen. It is given two things: which of the two, and whether the operator paused motion. It is given
// nothing about the session: no signal, no count, no text. Weather is scenery; it decides nothing and means nothing.
//
// Two canvases, one loop:
//  - the sky: three cloud layers and the light inside them, computed on a small grid (at most MAX_SKY_CELLS cells whatever the
//    window's size) and stretched by the browser. Clouds are soft, so the stretch is free softness. It is recomputed four times a
//    second, and on every frame only while a stroke of lightning is alight.
//  - the rain: a bounded pool of drops drawn as strokes, at most 30 frames a second, on a canvas of at most MAX_RAIN_PIXELS. The few
//    drops that land on a panel, the water that collects there, and the light a panel's edge catches are drawn here too, OUTSIDE the
//    panel's box: the canvas is behind the page, so nothing it draws can cover text, take a click or change a layout.
//
// Nothing is drawn while the page is hidden, while the operator paused motion or while the system asks for reduced motion (then one
// still frame is drawn, with no lightning). Canvas 2D only: no GPU is needed and none is asked for.
import { type ReactElement, useEffect, useRef } from "react";
import {
	advanceStorm,
	type Box,
	createStorm,
	createWind,
	EDGE_SAMPLES,
	easeLook,
	edgeLight,
	mulberry32,
	PARALLAX,
	type Rng,
	rainBudget,
	rainDensityAt,
	rainScale,
	SIDE_SAMPLES,
	type Stroke,
	skyGrid,
	strokeEnd,
	strokeLevel,
	windAt,
} from "../model/weather.ts";

const FPS = 30;
/** Seconds between recomputations of the clouds while nothing is alight. They drift a few pixels a second. */
const SKY_EVERY = 0.25;
/** And while the layers are easing after the pointer, so the parallax is smooth: still far fewer than the rain's frames. */
const SKY_EVERY_LOOKING = 0.1;
const MAX_RAIN_PIXELS = 4_000_000;
const MAX_SCALE = 1.5;
/** Panels the weather may touch, at most: the largest ones in view. */
const MAX_SURFACES = 10;
/** Strokes alight at once, at most (an event has at most three). */
const MAX_ALIGHT = 3;
const MAX_LANDERS = 4;
const MAX_SPLASHES = 24;
const MAX_BEADS = 3;
/** The noise the clouds are cut from: two tiles of this many texels a side, made once. */
const TILE = 256;
const MASK = TILE - 1;
/** Drop strengths, faintest first. Far rain uses the first two, near rain the next three; the rest are reached only in lightning. */
const RAIN_ALPHA = [0.05, 0.072, 0.085, 0.112, 0.145, 0.19, 0.24, 0.3] as const;
const GROUND = [3, 4, 5] as const;
/** The brightest any channel of the sky can be drawn, of 255, and where lightning starts being folded toward it. */
const SKY_CEILING = 200;
const KNEE = 120;

interface Layer {
	/** Texels for each CSS pixel across, and how much flatter the clouds are than they are wide. */
	sx: number;
	flat: number;
	/** The second tile's scale against the first, and both tiles' offsets, in texels. */
	second: number;
	ox: number;
	oy: number;
	px: number;
	py: number;
	/** CSS pixels a second. */
	speed: number;
	/** How much noise it takes to be cloud, and how soft the edge is. */
	cut: number;
	soft: number;
	/** Where down the window the layer thins from, and where it is gone (fractions of the height). */
	from: number;
	to: number;
	/** How far it shifts against the pointer, in CSS pixels at the window's edge. */
	depth: number;
}

interface Surface extends Box {
	r: number;
}

interface Alight {
	stroke: Stroke;
	level: number;
	/** The light this stroke adds to each cell of the sky at full strength: red, green, blue. */
	add: Float32Array;
	/** The light each panel edge catches at full strength, and the panels as they were when it struck. */
	edges: Float32Array;
	boxes: Surface[];
	/** Its centre and reach in CSS pixels. */
	cx: number;
	cy: number;
	reach: number;
}

interface Bead {
	box: Surface;
	/** 0 sitting, 1 creeping along the top, 2 rounding the corner, 3 running down the side, 4 falling. */
	phase: number;
	x: number;
	y: number;
	side: 1 | -1;
	age: number;
	hold: number;
	turn: number;
	ran: number;
	run: number;
	pace: number;
	fall: number;
	fade: number;
	size: number;
	beat: number;
}

const fade = (t: number) => t * t * (3 - 2 * t);
const step01 = (a: number, b: number, v: number) => {
	const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
	return fade(t);
};

/** A square of smooth noise that tiles: a few octaves of value noise on lattices that wrap, stretched to use the whole range. */
function tile(rng: Rng, lattice: number, octaves: number): Float32Array {
	const out = new Float32Array(TILE * TILE);
	let weight = 1;
	let total = 0;
	for (let o = 0; o < octaves; o++) {
		const n = lattice << o;
		const points = new Float32Array(n * n);
		for (let i = 0; i < points.length; i++) points[i] = rng();
		const scale = n / TILE;
		for (let y = 0; y < TILE; y++) {
			const fy = y * scale;
			const y0 = Math.floor(fy);
			const ty = fade(fy - y0);
			const r0 = (y0 % n) * n;
			const r1 = ((y0 + 1) % n) * n;
			for (let x = 0; x < TILE; x++) {
				const fx = x * scale;
				const x0 = Math.floor(fx);
				const tx = fade(fx - x0);
				const c0 = x0 % n;
				const c1 = (x0 + 1) % n;
				const top = points[r0 + c0]! + (points[r0 + c1]! - points[r0 + c0]!) * tx;
				const bottom = points[r1 + c0]! + (points[r1 + c1]! - points[r1 + c0]!) * tx;
				out[y * TILE + x] = out[y * TILE + x]! + weight * (top + (bottom - top) * ty);
			}
		}
		total += weight;
		weight *= 0.5;
	}
	for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (out[i]! / total - 0.5) * 1.7 + 0.5));
	return out;
}

export default function WeatherCanvas({
	atmosphere,
	paused,
}: {
	atmosphere: "rain" | "storm";
	paused: boolean;
}): ReactElement {
	const skyRef = useRef<HTMLCanvasElement>(null);
	const rainRef = useRef<HTMLCanvasElement>(null);
	const latest = useRef({ atmosphere, paused });
	latest.current = { atmosphere, paused };
	// The loop's controls, kept outside React state: a frame never causes a render.
	const kick = useRef<(() => void) | null>(null);

	useEffect(() => {
		const skyEl = skyRef.current;
		const el = rainRef.current;
		if (skyEl === null || el === null) return;
		const skyCtx = skyEl.getContext("2d", { alpha: false });
		const ctx = el.getContext("2d", { alpha: true });
		if (skyCtx === null || ctx === null) {
			el.dataset.state = "unavailable";
			return;
		}
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		// For tests only, read once: a seed (so a storm can be replayed) and a clock stepped by hand (so a frame can be held). Without
		// them the seed is one nobody chose and the clock is the display's.
		const control = document.documentElement.dataset.weather ?? "";
		const seeded = /(?:^|,)seed:(\d+)/.exec(control);
		const manual = /(?:^|,)clock:manual(?:,|$)/.test(control);
		const seed = seeded === null ? (Math.random() * 0x100000000) >>> 0 : Number(seeded[1]) >>> 0;
		// One stream each, so how many frames were drawn never changes when lightning comes.
		const stormRng = mulberry32(seed);
		const rainRng = mulberry32(seed ^ 0x9e3779b9);
		const edgeRng = mulberry32(seed ^ 0x51ed270b);
		const skyRng = mulberry32(seed ^ 0x2545f491);
		const wind = createWind(mulberry32(seed ^ 0x7f4a7c15));
		const storm = createStorm(stormRng);
		const tileA = tile(skyRng, 8, 4);
		const tileB = tile(skyRng, 8, 4);
		const heading = wind.bias < 0 ? -1 : 1;
		const layer = (over: Omit<Layer, "ox" | "oy" | "px" | "py">): Layer => ({
			...over,
			ox: skyRng() * TILE,
			oy: skyRng() * TILE,
			px: skyRng() * TILE,
			py: skyRng() * TILE,
		});
		// Far, middle, near: smaller and slower with distance; the far bank sits lower (toward the horizon), the near one overhead.
		const layers: readonly [Layer, Layer, Layer] = [
			layer({
				sx: 32 / 250,
				flat: 2.3,
				second: 0.57,
				speed: 0.9,
				cut: 0.4,
				soft: 0.34,
				from: 0.2,
				to: 0.72,
				depth: PARALLAX[0],
			}),
			layer({
				sx: 32 / 430,
				flat: 1.9,
				second: 0.63,
				speed: 2.1,
				cut: 0.47,
				soft: 0.3,
				from: 0.1,
				to: 0.52,
				depth: PARALLAX[1],
			}),
			layer({
				sx: 32 / 720,
				flat: 1.6,
				second: 0.52,
				speed: 4.4,
				cut: 0.5,
				soft: 0.22,
				from: -0.02,
				to: 0.31,
				depth: PARALLAX[2],
			}),
		];

		let frame = 0;
		let last = 0;
		let time = 0;
		let dead = false;
		let frames = 0;
		let cost = 0;
		let skyCost = 0;
		let strikes = 0;
		// The window, in CSS pixels, and the two canvases' grids.
		let width = 1;
		let height = 1;
		let scale = 1;
		let big = 1;
		let cols = 8;
		let rows = 8;
		let cell = 6;
		let image = skyCtx.createImageData(cols, rows);
		let far = new Float32Array(0);
		let mid = new Float32Array(0);
		let near = new Float32Array(0);
		let base = new Float32Array(0);
		let dither = new Float32Array(0);
		let skyDue = 0;
		let wasLit = false;
		// Where the pointer is across and down the window (-1..1), and where the layers have eased to. Depth by parallax: the near
		// masses shift most against the pointer, the far bank least.
		const look = { x: 0, y: 0, tx: 0, ty: 0 };
		const alight: Alight[] = [];
		const spare: Float32Array[] = [];
		const quench = (from = 0, count = alight.length) => {
			for (const gone of alight.splice(from, count)) if (spare.length < MAX_ALIGHT) spare.push(gone.add);
		};
		// Rain: one row of numbers per property, never an object per drop.
		let drops = 0;
		let falling = 0;
		let dx = new Float32Array(0);
		let dy = new Float32Array(0);
		let dv = new Float32Array(0);
		let dl = new Float32Array(0);
		let dw = new Float32Array(0);
		let da = new Uint8Array(0);
		let dn = new Uint8Array(0);
		let asleep = new Uint8Array(0);
		let shown = new Uint8Array(0);
		// The panels, as last measured.
		let surfaces: Surface[] = [];
		let measuredAt = -1e9;
		let stale = true;
		let shape = "";
		let landAt = 2;
		const landers: { x: number; y: number; tx: number; ty: number; v: number; bead: Surface | null; side: 1 | -1 }[] =
			[];
		const splashes: { x: number; y: number; vx: number; vy: number; life: number; span: number; line: number }[] = [];
		const beads: Bead[] = [];

		const drop = (i: number, anywhere: boolean) => {
			const close = rainRng() < 0.34;
			const v = (close ? 640 + 260 * rainRng() : 360 + 160 * rainRng()) * Math.sqrt(big);
			dn[i] = close ? 1 : 0;
			dv[i] = v;
			// As long as the drop travels in a frame, so the streaks of one drop meet end to end and never strobe.
			dl[i] = (v / FPS) * (close ? 1.05 + 0.45 * rainRng() : 0.9 + 0.3 * rainRng());
			dw[i] = (0.75 + 0.5 * rainRng()) * (close ? 1 : 0.8);
			da[i] = close ? 2 + Math.floor(rainRng() * 3) : Math.floor(rainRng() * 2);
			const margin = height * 0.42;
			dx[i] = -margin + (width + 2 * margin) * rainRng();
			dy[i] = anywhere ? -0.1 * height + 1.1 * height * rainRng() : -dl[i]! - 0.3 * height * rainRng();
			asleep[i] = 0;
		};

		const size = () => {
			width = Math.max(1, el.clientWidth);
			height = Math.max(1, el.clientHeight);
			scale = Math.min(window.devicePixelRatio || 1, MAX_SCALE, Math.sqrt(MAX_RAIN_PIXELS / (width * height)));
			el.width = Math.max(1, Math.round(width * scale));
			el.height = Math.max(1, Math.round(height * scale));
			big = rainScale(width, height);
			const grid = skyGrid(width, height);
			cols = grid.cols;
			rows = grid.rows;
			cell = grid.cell;
			skyEl.width = cols;
			skyEl.height = rows;
			image = skyCtx.createImageData(cols, rows);
			for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
			const cells = cols * rows;
			far = new Float32Array(cells);
			mid = new Float32Array(cells);
			near = new Float32Array(cells);
			base = new Float32Array(cells * 3);
			dither = new Float32Array(cells);
			// A fixed pattern under half a level, so the dark gradients do not band and nothing shimmers.
			const grain = mulberry32(0x1b873593);
			for (let i = 0; i < cells; i++) dither[i] = grain() - 0.5;
			alight.length = 0;
			spare.length = 0;
			skyDue = 0;
			drops = rainBudget(width, height);
			dx = new Float32Array(drops);
			dy = new Float32Array(drops);
			dv = new Float32Array(drops);
			dl = new Float32Array(drops);
			dw = new Float32Array(drops);
			da = new Uint8Array(drops);
			dn = new Uint8Array(drops);
			asleep = new Uint8Array(drops);
			shown = new Uint8Array(drops);
			for (let i = 0; i < drops; i++) drop(i, true);
			landers.length = 0;
			splashes.length = 0;
			beads.length = 0;
			stale = true;
		};

		/** One layer's cloud, 0..1 for each cell: two tiles of noise sliding past each other, cut where the layer thins. */
		const cloud = (out: Float32Array, l: Layer) => {
			const stepA = cell * l.sx;
			const stepB = stepA * l.second;
			// The layer's shift for where the pointer is, in texels of each tile.
			const shiftX = look.x * l.depth * big * l.sx;
			const shiftY = look.y * l.depth * big * 0.45 * l.sx * l.flat;
			for (let j = 0; j < rows; j++) {
				const row = j * cols;
				const y = (j + 0.5) / rows;
				const thin = step01(l.from, l.to, y);
				if (thin >= 0.999) {
					out.fill(0, row, row + cols);
					continue;
				}
				const cut = l.cut + thin * 0.6;
				const va = j * stepA * l.flat + l.oy + shiftY;
				const ya = Math.floor(va);
				const fa = va - ya;
				const a0 = (ya & MASK) * TILE;
				const a1 = ((ya + 1) & MASK) * TILE;
				const vb = j * stepB * l.flat + l.py + shiftY * l.second;
				const yb = Math.floor(vb);
				const fb = vb - yb;
				const b0 = (yb & MASK) * TILE;
				const b1 = ((yb + 1) & MASK) * TILE;
				let ua = l.ox + shiftX;
				let ub = l.px + shiftX * l.second;
				for (let i = 0; i < cols; i++) {
					const xa = Math.floor(ua);
					const ta = ua - xa;
					const ia = xa & MASK;
					const ja = (xa + 1) & MASK;
					const at = tileA[a0 + ia]! + (tileA[a0 + ja]! - tileA[a0 + ia]!) * ta;
					const ab = tileA[a1 + ia]! + (tileA[a1 + ja]! - tileA[a1 + ia]!) * ta;
					const xb = Math.floor(ub);
					const tb = ub - xb;
					const ib = xb & MASK;
					const jb = (xb + 1) & MASK;
					const bt = tileB[b0 + ib]! + (tileB[b0 + jb]! - tileB[b0 + ib]!) * tb;
					const bb = tileB[b1 + ib]! + (tileB[b1 + jb]! - tileB[b1 + ib]!) * tb;
					const d = ((at + (ab - at) * fa) * 0.62 + (bt + (bb - bt) * fb) * 0.38 - cut) / l.soft;
					out[row + i] = d <= 0 ? 0 : d >= 1 ? 1 : d * d * (3 - 2 * d);
					ua += stepA;
					ub += stepB;
				}
			}
		};

		// How much of each layer covers what is behind it.
		// A layer's number is how thick its cloud is; it covers sooner than it thickens, so a cloud has an edge and a body. The far
		// bank stays all softness; the near masses are the most defined.
		const farCover = (f: number) => Math.min(1, f * 1.5) * 0.8;
		const midCover = (m: number) => Math.min(1, m * 2.6) * 0.95;
		const nearCover = (n: number) => Math.min(1, n * 3.4) * 0.97;

		/** The night sky with no lightning: a faint glow overhead, a pale far bank, a middle layer with a little relief, dark near masses. */
		const shade = () => {
			cloud(far, layers[0]);
			cloud(mid, layers[1]);
			cloud(near, layers[2]);
			const near3 = Math.max(1, Math.round(15 / cell));
			for (let j = 0; j < rows; j++) {
				const y = (j + 0.5) / rows;
				const glow = (1 - step01(0, 0.78, y)) ** 2;
				const sr = GROUND[0] + 9 * glow;
				const sg = GROUND[1] + 13 * glow;
				const sb = GROUND[2] + 23 * glow;
				const above = j >= near3 ? -near3 * cols : 0;
				for (let i = 0; i < cols; i++) {
					const c = j * cols + i;
					const f = far[c]!;
					const m = mid[c]!;
					const n = near[c]!;
					const af = farCover(f);
					let r = sr + (29 - sr) * af;
					let g = sg + (37 - sg) * af;
					let b = sb + (57 - sb) * af;
					if (m > 0) {
						// A cloud's thin parts pass the sky's glow; its thick parts are dark. Its upper edge catches a little of it.
						const lift = 0.8 + 2 * Math.max(0, m - mid[c + above]!);
						const am = midCover(m);
						r += ((44 - 30 * m) * lift - r) * am;
						g += ((55 - 37 * m) * lift - g) * am;
						b += ((80 - 52 * m) * lift - b) * am;
					}
					if (n > 0) {
						const an = nearCover(n);
						r += (2.4 - r) * an;
						g += (3.1 - g) * an;
						b += (4.4 - b) * an;
					}
					base[c * 3] = r;
					base[c * 3 + 1] = g;
					base[c * 3 + 2] = b;
				}
			}
		};

		/**
		 * What one stroke adds to the sky at full strength. The light is a short channel inside the middle layer: it glows through that
		 * layer's cloud (brighter on the faces turned toward it), reaches the far bank weakly, barely tints the open sky, and is hidden by
		 * the near masses except through their thin edges.
		 */
		const kindle = (stroke: Stroke): Alight => {
			// A stroke's light is a buffer the size of the sky; the few that are ever needed are kept and used again.
			const add = spare.pop() ?? new Float32Array(cols * rows * 3);
			add.fill(0);
			const ax = stroke.ax * width;
			const ay = stroke.ay * height;
			const bx = stroke.bx * width;
			const by = stroke.by * height;
			const reach = stroke.spread * width;
			const ex = bx - ax;
			const ey = by - ay;
			const span = ex * ex + ey * ey || 1;
			const toward = Math.max(1, Math.round(15 / cell));
			for (let j = 0; j < rows; j++) {
				const py = (j + 0.5) * cell;
				for (let i = 0; i < cols; i++) {
					const px = (i + 0.5) * cell;
					// The nearest point of the channel.
					const k = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / span));
					const tx = ax + ex * k - px;
					const ty = ay + ey * k - py;
					const q = (tx * tx + ty * ty) / (reach * reach);
					if (q > 30) continue;
					const core = Math.exp(-q * 2.2);
					const halo = 0.16 / (1 + q / 2.56);
					const c = j * cols + i;
					const f = far[c]!;
					const m = mid[c]!;
					const n = near[c]!;
					// The cloud a little way toward the light: thinner there means this is a face turned to it.
					const d = Math.sqrt(tx * tx + ty * ty) || 1;
					const si = Math.min(cols - 1, Math.max(0, i + Math.round((tx / d) * toward)));
					const sj = Math.min(rows - 1, Math.max(0, j + Math.round((ty / d) * toward)));
					const face = Math.min(1.5, Math.max(0.2, 0.62 + 1.9 * (m - mid[sj * cols + si]!)));
					const sky = core * 0.1 + halo * 0.5;
					const bank = (core * 0.32 + halo) * (0.25 + 0.75 * f);
					const body = (core + halo) * face * (0.25 + 0.75 * m) * (1 - 0.3 * m);
					const rim = (core + halo) * 0.4 * n * (1 - n);
					const af = farCover(f);
					const am = midCover(m);
					const an = nearCover(n);
					const behind = 1 - an;
					add[c * 3] =
						behind * ((1 - am) * ((1 - af) * sky * 150 + af * bank * 230) + am * body * 380) + an * rim * 200;
					add[c * 3 + 1] =
						behind * ((1 - am) * ((1 - af) * sky * 186 + af * bank * 284) + am * body * 450) + an * rim * 250;
					add[c * 3 + 2] =
						behind * ((1 - am) * ((1 - af) * sky * 280 + af * bank * 400) + am * body * 600) + an * rim * 350;
				}
			}
			// The panels' edges under the same light, from the same place.
			const boxes = measured();
			const edges = new Float32Array(boxes.length * EDGE_SAMPLES);
			const cx = (ax + bx) / 2;
			const cy = (ay + by) / 2;
			for (let s = 0; s < boxes.length; s++)
				edgeLight(boxes[s]!, cx, cy, 0.36 * width + 140, 0.1 * width, edges, s * EDGE_SAMPLES);
			return { stroke, level: 0, add, edges, boxes, cx, cy, reach };
		};

		const paintSky = () => {
			const data = image.data;
			const cells = cols * rows;
			const a = alight[0];
			const b = alight[1];
			const c = alight[2];
			const la = a?.level ?? 0;
			const lb = b?.level ?? 0;
			const lc = c?.level ?? 0;
			for (let i = 0, p = 0, q = 0; i < cells; i++, p += 3, q += 4) {
				const grain = dither[i]!;
				let r = base[p]!;
				let g = base[p + 1]!;
				let bl = base[p + 2]!;
				if (la > 0) {
					r += la * a!.add[p]!;
					g += la * a!.add[p + 1]!;
					bl += la * a!.add[p + 2]!;
				}
				if (lb > 0) {
					r += lb * b!.add[p]!;
					g += lb * b!.add[p + 1]!;
					bl += lb * b!.add[p + 2]!;
				}
				if (lc > 0) {
					r += lc * c!.add[p]!;
					g += lc * c!.add[p + 1]!;
					bl += lc * c!.add[p + 2]!;
				}
				if (la + lb + lc > 0) {
					// However strong the stroke, the sky never reaches white: above the knee, light is folded toward SKY_CEILING.
					if (r > KNEE) r = KNEE + (r - KNEE) / (1 + (r - KNEE) / (SKY_CEILING - KNEE));
					if (g > KNEE) g = KNEE + (g - KNEE) / (1 + (g - KNEE) / (SKY_CEILING - KNEE));
					if (bl > KNEE) bl = KNEE + (bl - KNEE) / (1 + (bl - KNEE) / (SKY_CEILING - KNEE));
				}
				data[q] = r + grain;
				data[q + 1] = g + grain;
				data[q + 2] = bl + grain;
			}
			skyCtx.putImageData(image, 0, 0);
		};

		/**
		 * The panels in view, as boxes in the canvas's own pixels. Measured only when asked (when a drop is about to land or lightning
		 * strikes) and only if something may have moved (a resize, a scroll, a change of the workspace's layout) or the last measure is
		 * old; never on every frame.
		 */
		const measured = (): Surface[] => {
			const now = performance.now();
			if (!(stale || now - measuredAt > 4000) || now - measuredAt < 400) return surfaces;
			measuredAt = now;
			stale = false;
			const root = el.closest(".develop");
			const origin = el.getBoundingClientRect();
			const found: Surface[] = [];
			for (const node of Array.from(root?.querySelectorAll(".panel") ?? [])) {
				const box = node.getBoundingClientRect();
				if (box.width < 120 || box.height < 48) continue;
				if (box.bottom < 0 || box.top > height || box.right < 0 || box.left > width) continue;
				found.push({
					x: box.left - origin.left,
					y: box.top - origin.top,
					w: box.width,
					h: box.height,
					r: Math.min(
						Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0,
						box.height / 2,
						box.width / 2,
					),
				});
			}
			found.sort((a, b) => b.w * b.h - a.w * a.h);
			// A panel inside a larger one is not a surface of its own.
			const outer = found.filter(
				(s, i) =>
					!found.some(
						(o, k) => k < i && s.x >= o.x && s.y >= o.y && s.x + s.w <= o.x + o.w && s.y + s.h <= o.y + o.h,
					),
			);
			surfaces = outer.slice(0, MAX_SURFACES);
			const next = surfaces
				.map((s) => `${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.w)},${Math.round(s.h)}`)
				.join(";");
			if (next !== shape) {
				// What was on the old edges is not on the new ones.
				shape = next;
				landers.length = 0;
				beads.length = 0;
				splashes.length = 0;
			}
			return surfaces;
		};

		/** Now and then one drop is aimed at a panel's upper edge. Some of those leave a bead near a corner. */
		const land = (lean: number) => {
			const boxes = measured().filter((s) => s.y > 10 && s.y < height - 24 && s.w > 2 * s.r + 60);
			if (boxes.length === 0 || landers.length >= MAX_LANDERS) return;
			let total = 0;
			for (const s of boxes) total += s.w;
			let pick = edgeRng() * total;
			let box = boxes[0]!;
			for (const s of boxes) {
				pick -= s.w;
				if (pick <= 0) {
					box = s;
					break;
				}
			}
			const side: 1 | -1 = lean < 0 ? -1 : 1;
			const from = box.x + box.r + 6;
			const to = box.x + box.w - box.r - 6;
			const beaded = beads.length < MAX_BEADS && !beads.some((b) => b.box === box) && edgeRng() < 0.45;
			const corner = side > 0 ? to : from;
			const tx = beaded
				? Math.min(to, Math.max(from, corner - side * (24 + 120 * edgeRng())))
				: from + (to - from) * edgeRng();
			const above = Math.min(box.y, 90 + 130 * edgeRng());
			landers.push({
				x: tx - lean * above,
				y: box.y - above,
				tx,
				ty: box.y,
				v: 760 * Math.sqrt(big),
				bead: beaded ? box : null,
				side,
			});
		};

		const splash = (x: number, y: number, lean: number) => {
			const count = 2 + Math.floor(edgeRng() * 3);
			for (let i = 0; i < count && splashes.length < MAX_SPLASHES - 1; i++) {
				const span = 0.16 + 0.18 * edgeRng();
				splashes.push({
					x,
					y: y - 1,
					vx: -60 + 120 * edgeRng() + lean * 60,
					vy: -(50 + 80 * edgeRng()),
					life: span,
					span,
					line: 0,
				});
			}
			// The wet spot: a short glint along the edge where it hit.
			splashes.push({ x, y: y - 0.5, vx: 0, vy: 0, life: 0.3, span: 0.3, line: 4 + 5 * edgeRng() });
		};

		const advance = (dt: number) => {
			time += dt;
			const lean = windAt(wind, time);
			// The clouds go with the prevailing wind, always the same way; the second tile a little faster and slightly across, so the
			// shapes change as they go.
			for (const l of layers) {
				const move = heading * l.speed * dt * l.sx;
				l.ox -= move;
				l.px -= move * 1.35 * l.second;
				l.py += l.speed * dt * l.sx * 0.12;
			}
			skyDue -= dt;
			// The layers ease after the pointer; while they do, the clouds are recomputed a little more often.
			if (look.x !== look.tx || look.y !== look.ty) {
				look.x = easeLook(look.x, look.tx, dt);
				look.y = easeLook(look.y, look.ty, dt);
				skyDue = Math.min(skyDue, SKY_EVERY_LOOKING);
			}
			if (latest.current.atmosphere === "storm") {
				for (const stroke of advanceStorm(storm, dt, stormRng)) {
					strikes += 1;
					if (alight.length >= MAX_ALIGHT) quench(0, 1);
					alight.push(kindle(stroke));
				}
				for (let i = alight.length - 1; i >= 0; i--) {
					const a = alight[i]!;
					if (storm.t >= strokeEnd(a.stroke)) quench(i, 1);
					else a.level = strokeLevel(a.stroke, storm.t);
				}
			} else quench();
			// Rain.
			falling = Math.round(drops * rainDensityAt(wind, time));
			for (let i = 0; i < drops; i++) {
				if (asleep[i] === 1) {
					if (i < falling) drop(i, false);
					continue;
				}
				const fall = dv[i]! * dt;
				dy[i] = dy[i]! + fall;
				dx[i] = dx[i]! + lean * dw[i]! * fall;
				if (dy[i]! - dl[i]! > height) {
					if (i < falling) drop(i, false);
					else asleep[i] = 1;
				}
			}
			// What lands, splashes and collects.
			if (time >= landAt) {
				landAt = time + (1.4 + 4.1 * edgeRng()) / rainDensityAt(wind, time);
				land(lean);
			}
			for (let i = landers.length - 1; i >= 0; i--) {
				const l = landers[i]!;
				const gone = l.v * dt;
				const left = Math.hypot(l.tx - l.x, l.ty - l.y);
				if (left <= gone) {
					landers.splice(i, 1);
					splash(l.tx, l.ty, lean);
					if (l.bead !== null && beads.length < MAX_BEADS)
						beads.push({
							box: l.bead,
							phase: 0,
							x: l.tx,
							y: l.ty,
							side: l.side,
							age: 0,
							hold: 1.2 + 3.2 * edgeRng(),
							turn: 0,
							ran: 0,
							run: 28 + 80 * edgeRng(),
							pace: 0.7 + 0.6 * edgeRng(),
							fall: 0,
							fade: 1,
							size: 0.7,
							beat: edgeRng() * 6.283,
						});
				} else {
					l.x += ((l.tx - l.x) / left) * gone;
					l.y += ((l.ty - l.y) / left) * gone;
				}
			}
			for (let i = splashes.length - 1; i >= 0; i--) {
				const s = splashes[i]!;
				s.life -= dt;
				if (s.life <= 0) {
					splashes.splice(i, 1);
					continue;
				}
				s.vy += 700 * dt;
				s.x += s.vx * dt;
				s.y += s.vy * dt;
			}
			for (let i = beads.length - 1; i >= 0; i--) {
				const b = beads[i]!;
				const { box } = b;
				const round = Math.max(2, box.r);
				b.age += dt;
				// Water does not slide evenly: it sticks and lets go.
				const slip = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(b.age * 3.1 + b.beat));
				if (b.phase === 0) {
					b.size = Math.min(1.5, 0.7 + (0.8 * b.age) / b.hold);
					b.y = box.y - b.size * 0.6;
					if (b.age >= b.hold) b.phase = 1;
				} else if (b.phase === 1) {
					b.x += b.side * 11 * b.pace * slip * dt;
					const edge = b.side > 0 ? box.x + box.w - round : box.x + round;
					if ((b.x - edge) * b.side >= 0) {
						b.x = edge;
						b.phase = 2;
					}
				} else if (b.phase === 2) {
					b.turn += ((26 * b.pace * slip) / round) * dt;
					const centre = b.side > 0 ? box.x + box.w - round : box.x + round;
					b.x = centre + b.side * (round + 1.2) * Math.sin(b.turn);
					b.y = box.y + round - (round + 1.2) * Math.cos(b.turn);
					if (b.turn >= Math.PI / 2) b.phase = 3;
				} else if (b.phase === 3) {
					const down = 62 * b.pace * slip * dt;
					b.y += down;
					b.ran += down;
					if (b.ran >= b.run || b.y > box.y + box.h - round) b.phase = 4;
				} else {
					b.fall += 900 * dt;
					b.y += b.fall * dt;
					b.x += lean * b.fall * dt * 0.5;
					b.fade -= dt / 0.7;
					if (b.fade <= 0 || b.y > height) beads.splice(i, 1);
				}
			}
		};

		/** The light near a point from whatever is alight, 0..1. */
		const lightAt = (x: number, y: number): number => {
			let sum = 0;
			for (const a of alight) {
				const q = ((x - a.cx) ** 2 + (y - a.cy) ** 2) / (a.reach * a.reach);
				sum += a.level * Math.exp(-q * 1.1);
			}
			return Math.min(1, sum);
		};

		const drawRain = (still: boolean) => {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, el.width, el.height);
			ctx.setTransform(scale, 0, 0, scale, 0, 0);
			const lean = windAt(wind, time);
			const lit = alight.length > 0;
			const fine = Math.max(1, 1 / scale);
			let used = 0;
			for (let i = 0; i < drops; i++) {
				if (asleep[i] === 1) {
					shown[i] = 255;
					continue;
				}
				// Lightning shows the rain near it for a moment.
				const level = lit ? Math.min(7, da[i]! + Math.round(lightAt(dx[i]!, dy[i]!) * 4)) : da[i]!;
				shown[i] = level * 2 + dn[i]!;
				used |= 1 << shown[i]!;
			}
			ctx.lineCap = "butt";
			for (let bucket = 0; bucket < 16; bucket++) {
				if ((used & (1 << bucket)) === 0) continue;
				const close = (bucket & 1) === 1;
				const alpha = RAIN_ALPHA[bucket >> 1]! * (still ? 0.7 : 1);
				ctx.strokeStyle = close ? `rgba(158, 178, 212, ${alpha})` : `rgba(128, 148, 182, ${alpha})`;
				ctx.lineWidth = fine * (close ? 1.25 : 1) * Math.sqrt(big);
				ctx.beginPath();
				for (let i = 0; i < drops; i++) {
					if (shown[i] !== bucket) continue;
					const x = dx[i]!;
					const y = dy[i]!;
					const length = dl[i]!;
					ctx.moveTo(x, y);
					ctx.lineTo(x - lean * dw[i]! * length, y - length);
				}
				ctx.stroke();
			}
			if (still) return;
			// The drops aimed at an edge, what they throw up, and what stays.
			ctx.lineWidth = fine * 1.25;
			ctx.strokeStyle = "rgba(164, 184, 216, 0.17)";
			ctx.beginPath();
			for (const l of landers) {
				const length = l.v / FPS;
				const d = Math.hypot(l.tx - l.x, l.ty - l.y) || 1;
				ctx.moveTo(l.x, l.y);
				ctx.lineTo(l.x - ((l.tx - l.x) / d) * length, l.y - ((l.ty - l.y) / d) * length);
			}
			ctx.stroke();
			for (const s of splashes) {
				const alpha = (s.line > 0 ? 0.26 : 0.3) * (s.life / s.span);
				ctx.strokeStyle = `rgba(184, 202, 232, ${alpha.toFixed(3)})`;
				ctx.beginPath();
				if (s.line > 0) {
					ctx.moveTo(s.x - s.line, s.y);
					ctx.lineTo(s.x + s.line, s.y);
				} else {
					ctx.moveTo(s.x, s.y);
					ctx.lineTo(s.x - s.vx * 0.014, s.y - s.vy * 0.014);
				}
				ctx.stroke();
			}
			for (const b of beads) {
				const glint = lit ? lightAt(b.x, b.y) : 0;
				const alpha = b.fade * (0.3 + 0.45 * glint);
				if (b.phase === 3 && b.ran > 2) {
					// The wet trail it leaves on the way down.
					ctx.strokeStyle = `rgba(150, 172, 210, ${(0.1 * b.fade).toFixed(3)})`;
					ctx.beginPath();
					ctx.moveTo(b.x, b.y - Math.min(b.ran, 14));
					ctx.lineTo(b.x, b.y);
					ctx.stroke();
				}
				if (b.phase === 4) {
					ctx.strokeStyle = `rgba(164, 184, 216, ${(alpha * 0.8).toFixed(3)})`;
					ctx.beginPath();
					ctx.moveTo(b.x, b.y);
					ctx.lineTo(b.x - lean * b.fall * 0.012, b.y - Math.min(16, b.fall * 0.03));
					ctx.stroke();
					continue;
				}
				// A low dome where it sits on an upper edge; a short tear where it hangs on a side.
				const wide = b.phase === 3 ? b.size * 0.9 : b.size * 1.9;
				const tall = b.phase === 3 ? b.size * 1.9 : b.size * 1.25;
				ctx.fillStyle = `rgba(150, 172, 210, ${alpha.toFixed(3)})`;
				ctx.beginPath();
				ctx.ellipse(b.x, b.y, wide, tall, 0, 0, 6.2832);
				ctx.fill();
				ctx.fillStyle = `rgba(226, 234, 248, ${Math.min(0.85, alpha * 1.6).toFixed(3)})`;
				ctx.fillRect(b.x - wide * 0.45, b.y - tall * 0.55, 1, 1);
			}
			if (lit) drawEdges(fine);
		};

		/**
		 * The light the panels' edges catch: a hairline just outside each edge that faces the stroke, strongest where the edge is nearest
		 * it, nothing on the edges that face away. It fades with the stroke, because it is the stroke.
		 */
		const drawEdges = (fine: number) => {
			ctx.lineWidth = fine;
			const ink = (v: number) => `rgba(190, 208, 244, ${Math.min(0.62, v * 2).toFixed(3)})`;
			for (const a of alight) {
				if (a.level < 0.004) continue;
				for (let s = 0; s < a.boxes.length; s++) {
					const box = a.boxes[s]!;
					const at = s * EDGE_SAMPLES;
					const r = box.r;
					const x0 = box.x - 0.5;
					const y0 = box.y - 0.5;
					const x1 = box.x + box.w + 0.5;
					const y1 = box.y + box.h + 0.5;
					// The four sides, clockwise from the top, each from its start to its end, kept clear of the rounded corners.
					const sides = [
						[x0 + r, y0, x1 - r, y0],
						[x1, y0 + r, x1, y1 - r],
						[x1 - r, y1, x0 + r, y1],
						[x0, y1 - r, x0, y0 + r],
					] as const;
					for (let side = 0; side < 4; side++) {
						let most = 0;
						for (let k = 0; k < SIDE_SAMPLES; k++) most = Math.max(most, a.edges[at + side * SIDE_SAMPLES + k]!);
						if (most * a.level < 0.012) continue;
						const [sx, sy, ex, ey] = sides[side]!;
						const wash = ctx.createLinearGradient(sx, sy, ex, ey);
						for (let k = 0; k < SIDE_SAMPLES; k++)
							wash.addColorStop(k / (SIDE_SAMPLES - 1), ink(a.edges[at + side * SIDE_SAMPLES + k]! * a.level));
						ctx.strokeStyle = wash;
						ctx.beginPath();
						ctx.moveTo(sx, sy);
						ctx.lineTo(ex, ey);
						ctx.stroke();
					}
					if (r < 1) continue;
					const corners = [
						[box.x + r, box.y + r, Math.PI, 1.5 * Math.PI],
						[box.x + box.w - r, box.y + r, 1.5 * Math.PI, 2 * Math.PI],
						[box.x + box.w - r, box.y + box.h - r, 0, 0.5 * Math.PI],
						[box.x + r, box.y + box.h - r, 0.5 * Math.PI, Math.PI],
					] as const;
					for (let corner = 0; corner < 4; corner++) {
						const v = a.edges[at + 4 * SIDE_SAMPLES + corner]! * a.level;
						if (v < 0.012) continue;
						const [cx, cy, from, to] = corners[corner]!;
						ctx.strokeStyle = ink(v);
						ctx.beginPath();
						ctx.arc(cx, cy, r + 0.5, from, to);
						ctx.stroke();
					}
				}
			}
		};

		const draw = (still: boolean) => {
			const started = performance.now();
			const lit = alight.length > 0;
			// The clouds are recomputed a few times a second, and not while a stroke is alight (its light was worked out on these clouds).
			if (skyDue <= 0 && !lit) {
				shade();
				skyDue = SKY_EVERY;
				paintSky();
				skyCost = skyCost === 0 ? performance.now() - started : skyCost * 0.8 + (performance.now() - started) * 0.2;
			} else if (lit || wasLit) paintSky();
			wasLit = lit;
			drawRain(still);
			frames += 1;
			const spent = performance.now() - started;
			cost = cost === 0 ? spent : cost * 0.95 + spent * 0.05;
			if (frames % 15 === 1) report();
		};

		const report = () => {
			let level = 0;
			for (const a of alight) level = Math.max(level, a.level);
			el.dataset.frames = String(frames);
			el.dataset.cost = cost.toFixed(2);
			el.dataset.sky = skyCost.toFixed(2);
			el.dataset.grid = `${cols}x${rows}`;
			el.dataset.pixels = String(el.width * el.height);
			el.dataset.drops = String(drops);
			el.dataset.falling = String(falling);
			el.dataset.strikes = String(strikes);
			el.dataset.level = level.toFixed(3);
			el.dataset.alight = String(alight.length);
			el.dataset.surfaces = String(surfaces.length);
			el.dataset.landers = String(landers.length);
			el.dataset.splashes = String(splashes.length);
			el.dataset.beads = String(beads.length);
			el.dataset.look = `${look.x.toFixed(3)},${look.y.toFixed(3)}`;
		};

		const wanted = () => !dead && !manual && !document.hidden && !reduced.matches && !latest.current.paused;

		const tick = (now: number) => {
			frame = 0;
			if (last !== 0 && now - last < 1000 / FPS - 2) {
				frame = requestAnimationFrame(tick);
				return;
			}
			const dt = last === 0 ? 1 / FPS : Math.min(0.1, (now - last) / 1000);
			last = now;
			try {
				advance(dt);
				draw(false);
			} catch {
				stop("unavailable");
				return;
			}
			if (wanted()) frame = requestAnimationFrame(tick);
			else stop("still");
		};

		const stop = (state: "still" | "unavailable" | "hidden" | "manual") => {
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
		/** Something changed: start the loop, or draw the one still frame. A still frame never holds lightning or water in mid-air. */
		const refresh = () => {
			if (dead) return;
			if (wanted()) {
				start();
				return;
			}
			if (!manual) {
				quench();
				landers.length = 0;
				splashes.length = 0;
				beads.length = 0;
			}
			skyDue = 0;
			try {
				draw(!manual);
			} catch {
				stop("unavailable");
				return;
			}
			stop(manual ? "manual" : document.hidden ? "hidden" : "still");
		};
		kick.current = refresh;

		const resize = new ResizeObserver(() => {
			size();
			refresh();
		});
		const moved = () => {
			stale = true;
		};
		// A mouse or a pen, never a touch (a finger is not a viewpoint). Only the target is noted here; the loop does the easing.
		const pointed = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			look.tx = Math.min(1, Math.max(-1, (event.clientX / width) * 2 - 1));
			look.ty = Math.min(1, Math.max(-1, (event.clientY / height) * 2 - 1));
		};
		const unpointed = () => {
			look.tx = 0;
			look.ty = 0;
		};
		// The workspace's own box and attributes say when its layout changes (its size, the surface, the dock): the panels are measured
		// again after one.
		const reflow = new ResizeObserver(moved);
		const layout = new MutationObserver(moved);
		const root = el.closest(".develop");
		const visible = () => (document.hidden ? stop("hidden") : refresh());
		/** Tests only (clock:manual): move the weather on by the event's number of seconds, in frame-sized steps, and draw once. */
		const stepped = (event: Event) => {
			let left = Math.min(600, Math.max(0, Number((event as CustomEvent<number>).detail) || 0));
			try {
				while (left > 1e-9) {
					const dt = Math.min(left, 1 / FPS);
					advance(dt);
					left -= dt;
				}
				draw(false);
				report();
			} catch {
				stop("unavailable");
			}
		};

		size();
		resize.observe(el);
		if (root !== null) {
			reflow.observe(root);
			layout.observe(root, { attributes: true });
		}
		window.addEventListener("scroll", moved, { passive: true });
		window.addEventListener("pointermove", pointed, { passive: true });
		document.documentElement.addEventListener("pointerleave", unpointed);
		document.addEventListener("visibilitychange", visible);
		reduced.addEventListener("change", refresh);
		if (manual) el.addEventListener("weather-step", stepped);
		refresh();

		return () => {
			dead = true;
			kick.current = null;
			if (frame !== 0) cancelAnimationFrame(frame);
			resize.disconnect();
			reflow.disconnect();
			layout.disconnect();
			window.removeEventListener("scroll", moved);
			window.removeEventListener("pointermove", pointed);
			document.documentElement.removeEventListener("pointerleave", unpointed);
			document.removeEventListener("visibilitychange", visible);
			reduced.removeEventListener("change", refresh);
			el.removeEventListener("weather-step", stepped);
		};
	}, []);

	// Rain or storm, paused or not: the loop reads it on its next frame; a still sky is redrawn once, now.
	// biome-ignore lint/correctness/useExhaustiveDependencies: each prop is a reason to look again
	useEffect(() => {
		kick.current?.();
	}, [atmosphere, paused]);

	return (
		<>
			<canvas ref={skyRef} className="weather-sky" />
			<canvas
				ref={rainRef}
				className="weather-rain"
				data-running="false"
				data-state="loading"
				data-atmosphere={atmosphere}
			/>
		</>
	);
}
