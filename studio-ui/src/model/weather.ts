// Field atmospheres: what may be drawn behind DEVELOP when it is drawn as Field, and the rules of the night weather. Pure: no DOM, no
// clock and no randomness of its own. Whatever varies is given a random source and a time by the caller, so a test can hand it a seed
// and step it, and the page can hand it a seed nobody chose.
//
// Weather is scenery. Nothing here takes the session's state: no report, no count, no request. Rain does not fall harder while Pi works
// and lightning is not an event of the session. The only thing the page's state may still say in light is the horizon under the run
// strip, and its meaning stays in the legend's words (legendWords below).

export const ATMOSPHERES = ["none", "contours", "rain", "storm"] as const;
export type Atmosphere = (typeof ATMOSPHERES)[number];
/** Contours is what Field has always drawn, so it is what Field opens with. */
export const DEFAULT_ATMOSPHERE: Atmosphere = "contours";
export const ATMOSPHERE_LABEL: Readonly<Record<Atmosphere, string>> = {
	none: "None",
	contours: "Contours",
	rain: "Rain",
	storm: "Storm",
};
export const isAtmosphere = (value: string): value is Atmosphere => (ATMOSPHERES as readonly string[]).includes(value);

/**
 * The legend's line. Contours keeps the field's own words. The others say first that what is drawn is scenery (or that nothing is
 * drawn), then what is known about the session in the same words the field would have used, without describing a motion the page
 * does not show.
 */
export function legendWords(
	atmosphere: Atmosphere,
	signal: { words: string; state: string },
	stopped: "no" | "paused" | "reduced",
): string {
	if (atmosphere === "contours") return signal.words;
	if (atmosphere === "none") return `No atmosphere: nothing is drawn behind the work. ${signal.state}`;
	const what = atmosphere === "rain" ? "Rain" : "Storm";
	const how =
		stopped === "paused"
			? ", paused by you"
			: stopped === "reduced"
				? ", drawn once and still (your system asks for reduced motion)"
				: "";
	return `${what}${how}: weather is scenery and shows nothing about the session. ${signal.state}`;
}

// --- randomness ----------------------------------------------------------------------------------------------------------------

export type Rng = () => number;
/** A small seeded generator (mulberry32): the same seed gives the same weather on every machine. */
export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const between = (rng: Rng, low: number, high: number) => low + (high - low) * rng();
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// --- what the renderer may spend -----------------------------------------------------------------------------------------------

/** The most rain drops held, whatever the window's size: a larger window gets larger drops, not more of them. */
export const MAX_DROPS = 420;
const MIN_DROPS = 48;
export function rainBudget(width: number, height: number): number {
	return clamp(Math.round((width * height) / 5200), MIN_DROPS, MAX_DROPS);
}
/** How much larger a drop is drawn in a large window (1 at 1440 by 900, never more than 2). */
export function rainScale(width: number, height: number): number {
	return clamp(Math.sqrt((width * height) / 1_300_000), 1, 2);
}
/** The most cells the sky is computed on. It is drawn small and stretched: clouds are soft, and their cost must not grow with the window. */
export const MAX_SKY_CELLS = 110_000;
/** A cell is never smaller than this many CSS pixels: finer than that is detail a cloud does not have. */
export const MIN_SKY_CELL = 4;
export function skyGrid(width: number, height: number): { cols: number; rows: number; cell: number } {
	const cell = Math.max(MIN_SKY_CELL, Math.sqrt((width * height) / MAX_SKY_CELLS));
	const cols = Math.max(8, Math.floor(width / cell));
	const rows = Math.max(8, Math.floor(height / cell));
	return { cols, rows, cell: width / cols };
}

// --- parallax ------------------------------------------------------------------------------------------------------------------

/**
 * How far each cloud layer shifts, in CSS pixels, when the pointer is at an edge of the window: far, middle, near. The near masses
 * move most and the far bank hardly at all, which is what tells the eye they are at different distances. Small on purpose: the
 * pointer moves all day.
 */
export const PARALLAX = [3, 9, 20] as const;
/** Ease a layer's look toward where the pointer is (both -1..1), over about a second: never a jump, never a twitch. */
export function easeLook(now: number, target: number, dt: number): number {
	const next = now + (target - now) * Math.min(1, dt / 0.9);
	return Math.abs(target - next) < 0.0015 ? target : next;
}

// --- wind ----------------------------------------------------------------------------------------------------------------------

export interface Wind {
	/** The prevailing lean, and the phases of the slow swings around it. */
	bias: number;
	phases: readonly [number, number, number, number, number];
}
export function createWind(rng: Rng): Wind {
	const side = rng() < 0.5 ? -1 : 1;
	return {
		bias: side * between(rng, 0.05, 0.15),
		phases: [rng() * 6.283, rng() * 6.283, rng() * 6.283, rng() * 6.283, rng() * 6.283],
	};
}
const TAU = Math.PI * 2;
/**
 * The wind at a time: how far rain leans sideways for each unit it falls. Three swings whose periods share no small multiple, so
 * the lean never visibly repeats; never more than 0.4 either way.
 */
export function windAt(wind: Wind, t: number): number {
	const [a, b, c] = wind.phases;
	return clamp(
		wind.bias +
			0.11 * Math.sin((TAU * t) / 61.3 + a) +
			0.07 * Math.sin((TAU * t) / 23.7 + b) +
			0.035 * Math.sin((TAU * t) / 9.1 + c),
		-0.4,
		0.4,
	);
}
/** How much of the rain is falling at a time, 0.35 to 1: it thins and thickens over minutes. */
export function rainDensityAt(wind: Wind, t: number): number {
	const [, , , d, e] = wind.phases;
	return clamp(0.66 + 0.22 * Math.sin((TAU * t) / 97.0 + d) + 0.12 * Math.sin((TAU * t) / 31.7 + e), 0.35, 1);
}

// --- lightning -----------------------------------------------------------------------------------------------------------------
//
// A storm is a slowly varying rate of events. An event is one to three related strokes near one place; some events are followed, a
// few seconds later, by a weaker one nearby. Events tend to gather around a storm cell that wanders across the sky. Nothing is
// periodic: every wait is drawn from the rate at that moment, and every stroke of an event has its own strength, shape and place.
//
// The limits are part of the model, not of the drawing, so they hold whatever draws it.

export const STORM_LIMITS = {
	/** Seconds between the start of one event and the start of the next, at least. */
	minEventGap: 7,
	/** Seconds between the last stroke of an event and its follow-up, at least. */
	minFollowGap: 1.6,
	/** Strokes in one event, at most. */
	maxStrokes: 3,
	/** Strokes beginning in any one second, at most (three flashes a second is the general flash threshold; these are far dimmer). */
	maxStrokesPerSecond: 3,
	/** Seconds between the starts of two strokes, at least. */
	minStrokeGap: 0.09,
	/** Events (follow-ups included) in any one minute, at most. */
	maxEventsPerMinute: 5,
	/** The longest any quiet lasts, in seconds. */
	maxQuiet: 150,
	/** A stroke's strength, at most. The renderer maps 1 to a brightness far below white. */
	maxPeak: 1,
} as const;

/** One stroke: a short channel inside the cloud that lights, flickers and fades. Positions are fractions of the window. */
export interface Stroke {
	/** The event it belongs to, and its place in it. */
	event: number;
	index: number;
	/** Whether its event is a follow-up of the one before. */
	followUp: boolean;
	/** Seconds on the storm's clock. */
	at: number;
	/** 0..1. */
	peak: number;
	/** The channel's two ends: x across (0 left, 1 right), y down (0 top). */
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** How far the glow reaches, as a fraction of the window's width. */
	spread: number;
	rise: number;
	/** The time constant of its fading, in seconds. */
	decay: number;
	flicker: number;
	flickerHz: number;
	flickerPhase: number;
}

export interface Storm {
	t: number;
	/** 0..1: how busy the storm is now, and what it is easing toward. */
	activity: number;
	target: number;
	targetUntil: number;
	/** Where the cell is (0..1 across), and how fast it wanders. */
	cellX: number;
	cellDrift: number;
	nextEventAt: number;
	events: number;
	/** Start times of recent events and recent strokes, for the limits. */
	recentEvents: number[];
	recentStrokes: number[];
	/** Strokes decided and not yet due, in order. */
	pending: Stroke[];
	followUp: { at: number; x: number; y: number; strength: number } | null;
}

export function createStorm(rng: Rng): Storm {
	return {
		t: 0,
		activity: between(rng, 0.25, 0.6),
		target: between(rng, 0.2, 0.8),
		targetUntil: between(rng, 40, 110),
		cellX: between(rng, 0.15, 0.85),
		cellDrift: between(rng, -0.004, 0.004),
		// The first one comes soon enough to be seen by someone who has just chosen Storm, and not at once.
		nextEventAt: between(rng, 5, 13),
		events: 0,
		recentEvents: [],
		recentStrokes: [],
		pending: [],
		followUp: null,
	};
}

function planEvent(storm: Storm, rng: Rng, at: number, from: { x: number; y: number; strength: number } | null): void {
	const followUp = from !== null;
	const event = storm.events++;
	storm.recentEvents.push(at);
	// Most events are near the cell; some are anywhere. A follow-up is near the one it follows.
	const x = followUp
		? from.x + between(rng, -0.07, 0.07)
		: rng() < 0.18
			? between(rng, -0.05, 1.05)
			: storm.cellX + (rng() + rng() - 1) * 0.2;
	const high = rng();
	const y = followUp ? from.y + between(rng, -0.04, 0.04) : 0.03 + 0.28 * high * high;
	const strength = followUp ? from.strength * between(rng, 0.5, 0.9) : 0.35 + 0.65 * rng() ** 1.6;
	const roll = rng();
	const count = followUp ? (roll < 0.75 ? 1 : 2) : roll < 0.6 ? 1 : roll < 0.88 ? 2 : STORM_LIMITS.maxStrokes;
	let when = at;
	let share = 0;
	let last = at;
	for (let index = 0; index < count; index++) {
		if (index > 0) when += between(rng, STORM_LIMITS.minStrokeGap, 0.32);
		// No two strokes of an event have the same strength: a later one may be the stronger.
		let next = between(rng, 0.4, 1);
		if (index > 0 && Math.abs(next - share) < 0.12) next = next > 0.7 ? next - 0.2 : next + 0.2;
		share = next;
		const cx = clamp(x + (index === 0 ? 0 : between(rng, -0.06, 0.06)), -0.1, 1.1);
		const cy = clamp(y + (index === 0 ? 0 : between(rng, -0.035, 0.035)), 0.01, 0.42);
		const angle = between(rng, -0.6, 0.6);
		const half = between(rng, 0.025, 0.11);
		const stroke: Stroke = {
			event,
			index,
			followUp,
			at: when,
			peak: Math.min(STORM_LIMITS.maxPeak, strength * share),
			ax: cx - Math.cos(angle) * half,
			ay: cy - Math.sin(angle) * half * 0.6,
			bx: cx + Math.cos(angle) * half,
			by: cy + Math.sin(angle) * half * 0.6,
			spread: between(rng, 0.15, 0.3) * (0.75 + 0.5 * strength),
			rise: between(rng, 0.045, 0.085),
			decay: between(rng, 0.09, 0.3),
			flicker: between(rng, 0, 0.26),
			flickerHz: between(rng, 7, 13),
			flickerPhase: rng() * TAU,
		};
		// The rate limit is checked against everything already decided, so it holds across an event and its follow-up.
		const near = [...storm.recentStrokes, ...storm.pending.map((s) => s.at)].filter((s) => when - s < 1).length;
		if (near >= STORM_LIMITS.maxStrokesPerSecond) break;
		storm.pending.push(stroke);
		last = when;
	}
	storm.pending.sort((a, b) => a.at - b.at);
	if (!followUp && rng() < 0.2 + 0.25 * storm.activity)
		storm.followUp = { at: last + between(rng, STORM_LIMITS.minFollowGap, 5.5), x, y, strength };
	else if (followUp) storm.followUp = null;
	// The next wait is drawn from the rate now: long and irregular when the storm is quiet, shorter when it is busy.
	// (The least wait is added, not clamped to: a floor would make many waits the same length, and that is a timer.)
	const mean = 70 - 54 * storm.activity;
	const wait = Math.min(
		STORM_LIMITS.maxQuiet,
		STORM_LIMITS.minEventGap - Math.log(1 - rng() * 0.999) * (mean - STORM_LIMITS.minEventGap),
	);
	const after = Math.max(at, storm.followUp?.at ?? at);
	if (!followUp) storm.nextEventAt = after + wait;
}

/** Move the storm's clock on by `dt` seconds and return the strokes that begin in that time, in order. Mutates `storm`. */
export function advanceStorm(storm: Storm, dt: number, rng: Rng): Stroke[] {
	const until = storm.t + Math.max(0, dt);
	// The storm's mood: a new level to ease toward every minute or two, mostly quiet.
	if (until >= storm.targetUntil) {
		storm.target = rng() ** 1.5;
		storm.targetUntil = until + between(rng, 45, 150);
		storm.cellDrift = between(rng, -0.004, 0.004);
	}
	storm.activity += (storm.target - storm.activity) * Math.min(1, dt / 20);
	storm.cellX += storm.cellDrift * dt;
	if (storm.cellX < 0.08 || storm.cellX > 0.92) {
		storm.cellX = clamp(storm.cellX, 0.08, 0.92);
		storm.cellDrift = -storm.cellDrift;
	}
	storm.recentEvents = storm.recentEvents.filter((at) => until - at < 60);
	storm.recentStrokes = storm.recentStrokes.filter((at) => until - at < 1.5);
	const room = () => storm.recentEvents.length < STORM_LIMITS.maxEventsPerMinute;
	if (storm.followUp !== null && until >= storm.followUp.at) {
		const from = storm.followUp;
		storm.followUp = null;
		if (room()) planEvent(storm, rng, from.at, from);
	}
	if (until >= storm.nextEventAt) {
		if (room()) planEvent(storm, rng, storm.nextEventAt, null);
		// Too many in the last minute: wait for the oldest to leave it.
		else storm.nextEventAt = (storm.recentEvents[0] ?? until) + 60;
	}
	const due: Stroke[] = [];
	while (storm.pending.length > 0 && storm.pending[0]!.at <= until) {
		const stroke = storm.pending.shift()!;
		storm.recentStrokes.push(stroke.at);
		due.push(stroke);
	}
	storm.t = until;
	return due;
}

/** When a stroke has faded to nothing. */
export const strokeEnd = (stroke: Stroke): number => stroke.at + stroke.rise + 4.6 * stroke.decay;

/** A stroke's light at a time, 0 to its peak: a short eased rise, then a fading with a shallow flicker in it. Never a square pulse. */
export function strokeLevel(stroke: Stroke, t: number): number {
	const u = t - stroke.at;
	if (u <= 0 || t >= strokeEnd(stroke)) return 0;
	if (u < stroke.rise) {
		const k = u / stroke.rise;
		return stroke.peak * k * k * (3 - 2 * k);
	}
	const fall = Math.exp(-(u - stroke.rise) / stroke.decay);
	const waver =
		1 - stroke.flicker * 0.5 * (1 + Math.sin(TAU * stroke.flickerHz * (u - stroke.rise) + stroke.flickerPhase));
	// The flicker fades in after the peak, so the peak itself is never cut.
	const settle = Math.min(1, (u - stroke.rise) / 0.05);
	return stroke.peak * fall * (1 - settle + settle * waver);
}

// --- light on an edge ----------------------------------------------------------------------------------------------------------

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * How much of a light a point on an edge catches, 0..1. The edge faces along its outward normal (nx, ny); the light is at (lx, ly) in
 * the same plane and `depth` behind it. An edge facing away catches nothing; one facing the light catches less the farther it is,
 * falling to a half at `reach`.
 */
export function edgeGlint(
	px: number,
	py: number,
	nx: number,
	ny: number,
	lx: number,
	ly: number,
	reach: number,
	depth: number,
): number {
	const dx = lx - px;
	const dy = ly - py;
	const d2 = dx * dx + dy * dy + depth * depth;
	const facing = (nx * dx + ny * dy) / Math.sqrt(d2);
	if (facing <= 0) return 0;
	return facing / (1 + (dx * dx + dy * dy) / (reach * reach));
}

/** Samples along each side of a box, and in all: five along each of the four sides, then one on each corner. */
export const SIDE_SAMPLES = 5;
export const EDGE_SAMPLES = 4 * SIDE_SAMPLES + 4;
/**
 * A box's edges under a light: for the top, right, bottom and left sides in turn, the light caught at five points from the side's
 * start to its end (clockwise: the top from left to right, the right from top to bottom, the bottom from right to left, the left from
 * bottom to top), then at the four corners (top-left, top-right, bottom-right, bottom-left). Written into `out` at `offset`.
 */
export function edgeLight(
	box: Box,
	lx: number,
	ly: number,
	reach: number,
	depth: number,
	out: Float32Array,
	offset = 0,
): void {
	const { x, y, w, h } = box;
	const r = x + w;
	const b = y + h;
	const d = Math.SQRT1_2;
	// Each side: where it starts, where it ends, and the way it faces.
	const sides = [
		[x, y, r, y, 0, -1],
		[r, y, r, b, 1, 0],
		[r, b, x, b, 0, 1],
		[x, b, x, y, -1, 0],
	] as const;
	let at = offset;
	for (const [x0, y0, x1, y1, nx, ny] of sides)
		for (let k = 0; k < SIDE_SAMPLES; k++) {
			const t = k / (SIDE_SAMPLES - 1);
			out[at++] = edgeGlint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, nx, ny, lx, ly, reach, depth);
		}
	out[at++] = edgeGlint(x, y, -d, -d, lx, ly, reach, depth);
	out[at++] = edgeGlint(r, y, d, -d, lx, ly, reach, depth);
	out[at++] = edgeGlint(r, b, d, d, lx, ly, reach, depth);
	out[at++] = edgeGlint(x, b, -d, d, lx, ly, reach, depth);
}
