// The rules of the Field's night weather (studio-ui/src/model/weather.ts): which atmospheres there are and what the legend says under
// each, what the renderer may spend, the wind, and the lightning. The lightning is driven here by a seeded random source and a clock
// stepped by hand, so every claim docs/develop-atmospheres.md makes about it (irregular, clustered, never periodic, never a strobe,
// bounded) is checked over hours of simulated storm.
import { describe, expect, it } from "vitest";
import {
	ATMOSPHERES,
	advanceStorm,
	createStorm,
	createWind,
	DEFAULT_ATMOSPHERE,
	EDGE_SAMPLES,
	easeLook,
	edgeGlint,
	edgeLight,
	isAtmosphere,
	legendWords,
	MAX_DROPS,
	MAX_SKY_CELLS,
	MIN_SKY_CELL,
	mulberry32,
	PARALLAX,
	rainBudget,
	rainDensityAt,
	rainScale,
	SIDE_SAMPLES,
	STORM_LIMITS,
	type Stroke,
	skyGrid,
	strokeEnd,
	strokeLevel,
	windAt,
} from "../studio-ui/src/model/weather.ts";

const FRAME = 1 / 30;
/** Run a storm for `seconds` at the renderer's frame time and return every stroke it produced. */
function run(seed: number, seconds: number, dt = FRAME): Stroke[] {
	const rng = mulberry32(seed);
	const storm = createStorm(rng);
	const strokes: Stroke[] = [];
	for (let t = 0; t < seconds; t += dt) strokes.push(...advanceStorm(storm, dt, rng));
	return strokes;
}
const eventsOf = (strokes: Stroke[]): Stroke[][] => {
	const events = new Map<number, Stroke[]>();
	for (const stroke of strokes) events.set(stroke.event, [...(events.get(stroke.event) ?? []), stroke]);
	return [...events.values()];
};
const SEEDS = [1, 7, 42, 20261114, 0xdeadbeef];
const HOURS = 2 * 3600;

describe("the atmospheres", () => {
	it("are none, the contours, rain and a storm; the contours are what Field opens with", () => {
		expect([...ATMOSPHERES]).toEqual(["none", "contours", "rain", "storm"]);
		expect(DEFAULT_ATMOSPHERE).toBe("contours");
		expect(isAtmosphere("storm")).toBe(true);
		expect(isAtmosphere("snow")).toBe(false);
		expect(isAtmosphere("")).toBe(false);
	});

	it("keep the field's own words under the contours, and otherwise say what is drawn is scenery and then what is known", () => {
		const signal = {
			words: "Flowing: Pi reports a run open.",
			state: "Pi reports a run open, re-read every few seconds.",
		};
		expect(legendWords("contours", signal, "no")).toBe(signal.words);
		expect(legendWords("none", signal, "no")).toBe(
			"No atmosphere: nothing is drawn behind the work. Pi reports a run open, re-read every few seconds.",
		);
		for (const atmosphere of ["rain", "storm"] as const) {
			const words = legendWords(atmosphere, signal, "no");
			expect(words).toContain("weather is scenery and shows nothing about the session");
			expect(words).toContain(signal.state);
			// The weather is never described with the field's verbs: it is not the session flowing.
			expect(words).not.toMatch(/Flowing|Drifting/);
		}
		expect(legendWords("rain", signal, "paused")).toMatch(/^Rain, paused by you: /);
		expect(legendWords("storm", signal, "reduced")).toMatch(
			/^Storm, drawn once and still \(your system asks for reduced motion\): /,
		);
	});
});

describe("what the weather may spend", () => {
	it("holds a bounded pool of drops whatever the window's size: a larger window gets larger drops, not more", () => {
		expect(rainBudget(1440, 900)).toBeGreaterThan(150);
		expect(rainBudget(1440, 900)).toBeLessThan(MAX_DROPS);
		for (const [w, h] of [
			[2560, 1440],
			[3840, 2160],
			[7680, 4320],
			[100_000, 100_000],
		] as const)
			expect(rainBudget(w, h)).toBe(MAX_DROPS);
		expect(rainBudget(1, 1)).toBeGreaterThan(0);
		expect(rainScale(1440, 900)).toBe(1);
		expect(rainScale(3840, 2160)).toBeGreaterThan(1);
		expect(rainScale(100_000, 100_000)).toBe(2);
	});

	it("computes the sky on a bounded grid at every window size", () => {
		for (const [w, h] of [
			[390, 844],
			[1440, 900],
			[2560, 1440],
			[3840, 2160],
			[7680, 4320],
		] as const) {
			const grid = skyGrid(w, h);
			expect(grid.cols * grid.rows, `${w}x${h}`).toBeLessThanOrEqual(MAX_SKY_CELLS);
			expect(grid.cell).toBeGreaterThanOrEqual(MIN_SKY_CELL);
		}
		// Past a large desktop the sky stops growing: an 8K window costs no more of it than a 2560 one.
		const huge = skyGrid(7680, 4320);
		const desktop = skyGrid(2560, 1440);
		expect(huge.cols * huge.rows).toBeLessThanOrEqual(desktop.cols * desktop.rows * 1.02);
	});
});

describe("the parallax", () => {
	it("shifts the near clouds most and the far bank least, and never by much", () => {
		const [far, middle, near] = PARALLAX;
		expect(far).toBeLessThan(middle);
		expect(middle).toBeLessThan(near);
		expect(far).toBeGreaterThan(0);
		expect(near).toBeLessThanOrEqual(24);
	});

	it("eases after the pointer over about a second: no jump in a frame, no overshoot, and it arrives", () => {
		let look = 0;
		let most = 0;
		let frames = 0;
		while (look !== 1 && frames < 600) {
			const next = easeLook(look, 1, FRAME);
			expect(next).toBeGreaterThan(look);
			expect(next).toBeLessThanOrEqual(1);
			most = Math.max(most, next - look);
			look = next;
			frames += 1;
		}
		expect(look).toBe(1);
		// The largest step in one frame is a twenty-fifth of the way; arriving takes more than a second and less than ten.
		expect(most).toBeLessThan(0.04);
		expect(frames).toBeGreaterThan(30);
		expect(frames).toBeLessThan(300);
		expect(easeLook(0.5, 0.5, FRAME)).toBe(0.5);
		expect(easeLook(1, -1, FRAME)).toBeLessThan(1);
		// A long gap between frames lands on the target, never past it.
		expect(easeLook(0, 1, 5)).toBe(1);
	});
});

describe("the wind", () => {
	it("leans the rain gently either way, changes slowly, and does not repeat", () => {
		for (const seed of SEEDS) {
			const wind = createWind(mulberry32(seed));
			let low = 1;
			let high = -1;
			let before = windAt(wind, 0);
			let jump = 0;
			let thin = 1;
			let thick = 0;
			for (let t = FRAME; t < 1800; t += FRAME) {
				const now = windAt(wind, t);
				jump = Math.max(jump, Math.abs(now - before));
				low = Math.min(low, now);
				high = Math.max(high, now);
				before = now;
				const share = rainDensityAt(wind, t);
				thin = Math.min(thin, share);
				thick = Math.max(thick, share);
			}
			expect(low).toBeGreaterThanOrEqual(-0.4);
			expect(high).toBeLessThanOrEqual(0.4);
			// Never a jump between two frames.
			expect(jump).toBeLessThan(0.002);
			expect(thin).toBeGreaterThanOrEqual(0.35);
			expect(thick).toBeLessThanOrEqual(1);
			// It does change: by more than a tenth over half an hour.
			expect(high - low).toBeGreaterThan(0.1);
			// And no swing's period brings the same wind back.
			for (const period of [9.1, 23.7, 61.3])
				expect(Math.abs(windAt(wind, 100) - windAt(wind, 100 + period))).toBeGreaterThan(1e-4);
		}
	});
});

describe("the lightning", () => {
	it("is the same storm for the same seed and a different one for another", () => {
		const a = run(42, 900);
		expect(run(42, 900)).toEqual(a);
		expect(run(43, 900)).not.toEqual(a);
		expect(a.length).toBeGreaterThan(5);
	});

	it("keeps its limits over two hours of storm, whatever the seed", () => {
		for (const seed of SEEDS) {
			const strokes = run(seed, HOURS);
			const events = eventsOf(strokes);
			expect(events.length, `seed ${seed}`).toBeGreaterThan(40);
			for (const stroke of strokes) {
				expect(stroke.peak).toBeGreaterThan(0);
				expect(stroke.peak).toBeLessThanOrEqual(STORM_LIMITS.maxPeak);
				// Somewhere in or above the upper part of the scene.
				expect(stroke.ay).toBeLessThan(0.5);
				expect(stroke.by).toBeLessThan(0.5);
			}
			// Strokes in any one second, and the gap between any two.
			for (let i = 0; i < strokes.length; i++) {
				const within = strokes.slice(i, i + 8).filter((s) => s.at < strokes[i]!.at + 1).length;
				expect(within).toBeLessThanOrEqual(STORM_LIMITS.maxStrokesPerSecond);
				if (i > 0)
					expect(strokes[i]!.at - strokes[i - 1]!.at).toBeGreaterThanOrEqual(STORM_LIMITS.minStrokeGap - 1e-9);
			}
			// Events: at most three strokes each, at most five in any minute, a real gap between them, and no quiet without end.
			const starts = events.map((e) => e[0]!.at);
			for (let i = 0; i < events.length; i++) {
				expect(events[i]!.length).toBeLessThanOrEqual(STORM_LIMITS.maxStrokes);
				const minute = starts.slice(i, i + 12).filter((at) => at < starts[i]! + 60).length;
				expect(minute).toBeLessThanOrEqual(STORM_LIMITS.maxEventsPerMinute);
				if (i === 0) continue;
				const previous = events[i - 1]!;
				const gap = starts[i]! - starts[i - 1]!;
				if (events[i]![0]!.followUp)
					expect(starts[i]! - previous[previous.length - 1]!.at).toBeGreaterThanOrEqual(
						STORM_LIMITS.minFollowGap - 1e-9,
					);
				else expect(gap).toBeGreaterThanOrEqual(STORM_LIMITS.minEventGap - 1e-9);
				expect(gap).toBeLessThan(STORM_LIMITS.maxQuiet + 70);
			}
		}
	});

	it("is irregular: long uneven quiets, no period, no alternation from side to side", () => {
		for (const seed of SEEDS) {
			const events = eventsOf(run(seed, HOURS)).filter((e) => !e[0]!.followUp);
			const gaps = events.slice(1).map((e, i) => e[0]!.at - events[i]![0]!.at);
			const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
			const spread = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
			// Quiets average well over a quarter of a minute and vary by more than half their mean.
			expect(mean, `seed ${seed}`).toBeGreaterThan(18);
			expect(spread / mean, `seed ${seed}`).toBeGreaterThan(0.5);
			expect(Math.max(...gaps)).toBeGreaterThan(3 * Math.min(...gaps));
			// No two waits are the same: nothing is on a timer.
			expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(gaps.length * 0.95);
			// Left, right, left, right would be a pattern; a wandering cell is runs on one side.
			const sides = events.map((e) => (e[0]!.ax + e[0]!.bx) / 2 < 0.5);
			const changes = sides.slice(1).filter((side, i) => side !== sides[i]).length;
			expect(changes / (sides.length - 1), `seed ${seed}`).toBeLessThan(0.6);
			// And it is not all in one place either.
			const xs = events.map((e) => (e[0]!.ax + e[0]!.bx) / 2);
			expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
		}
	});

	it("groups related strokes into one event: mostly single, sometimes two or three, each stroke its own strength, place and time", () => {
		for (const seed of SEEDS) {
			const events = eventsOf(run(seed, HOURS));
			const single = events.filter((e) => e.length === 1).length;
			const multi = events.filter((e) => e.length > 1);
			expect(single).toBeGreaterThan(multi.length);
			expect(multi.length, `seed ${seed}`).toBeGreaterThan(events.length * 0.15);
			const delays = new Set<string>();
			for (const event of multi)
				for (let i = 1; i < event.length; i++) {
					const a = event[i - 1]!;
					const b = event[i]!;
					// Not the same flash twice: a different strength, a different channel, a different fading.
					expect(Math.abs(a.peak - b.peak)).toBeGreaterThan(0.01);
					expect(Math.hypot(a.ax - b.ax, a.ay - b.ay) + Math.hypot(a.bx - b.bx, a.by - b.by)).toBeGreaterThan(
						0.005,
					);
					expect(a.decay).not.toBe(b.decay);
					// But the same place, roughly: one event.
					expect(Math.abs((a.ax + a.bx) / 2 - (b.ax + b.bx) / 2)).toBeLessThan(0.14);
					expect(b.at - a.at).toBeLessThanOrEqual(0.32 + 1e-9);
					delays.add((b.at - a.at).toFixed(3));
				}
			// Not a fixed delay between the strokes of an event.
			expect(delays.size).toBeGreaterThan(10);
			// Sometimes the later stroke is the stronger one.
			expect(multi.some((e) => e[1]!.peak > e[0]!.peak)).toBe(true);
			expect(multi.some((e) => e[1]!.peak < e[0]!.peak)).toBe(true);
		}
	});

	it("sometimes follows an event with a weaker one nearby, a few seconds later", () => {
		for (const seed of SEEDS) {
			const events = eventsOf(run(seed, HOURS));
			const followers = events.map((e, i) => ({ e, i })).filter(({ e }) => e[0]!.followUp);
			expect(followers.length, `seed ${seed}`).toBeGreaterThan(3);
			expect(followers.length).toBeLessThan(events.length / 2);
			for (const { e, i } of followers) {
				const parent = events[i - 1]!;
				expect(parent[0]!.followUp).toBe(false);
				const x = (s: Stroke) => (s.ax + s.bx) / 2;
				expect(Math.abs(x(e[0]!) - x(parent[0]!))).toBeLessThan(0.2);
				expect(e[0]!.at - parent[parent.length - 1]!.at).toBeLessThan(5.6);
				expect(e.length).toBeLessThanOrEqual(2);
			}
		}
	});

	it("lights a stroke with an eased rise and a fading, never a square pulse, and nothing before or after", () => {
		for (const stroke of run(20261114, 1800)) {
			expect(strokeLevel(stroke, stroke.at - 0.001)).toBe(0);
			expect(strokeLevel(stroke, stroke.at)).toBe(0);
			expect(strokeLevel(stroke, strokeEnd(stroke))).toBe(0);
			expect(strokeEnd(stroke) - stroke.at).toBeLessThan(1.6);
			// The rise takes more than a frame: the first frame of a stroke is never its brightest.
			expect(stroke.rise).toBeGreaterThan(FRAME);
			expect(strokeLevel(stroke, stroke.at + stroke.rise / 2)).toBeCloseTo(stroke.peak / 2, 5);
			let most = 0;
			let least = 0;
			for (let u = 0; u < 1.7; u += 0.002) {
				const level = strokeLevel(stroke, stroke.at + u);
				least = Math.min(least, level);
				most = Math.max(most, level);
			}
			expect(least).toBe(0);
			expect(most).toBeLessThanOrEqual(stroke.peak + 1e-9);
			expect(most).toBeGreaterThan(stroke.peak * 0.97);
			// Half a second on, it is at most a fifth of what it was.
			expect(strokeLevel(stroke, stroke.at + stroke.rise + 0.5)).toBeLessThan(stroke.peak * 0.2);
		}
	});
});

describe("the light an edge catches", () => {
	const REACH = 600;
	const DEPTH = 140;
	it("is nothing on an edge that faces away, and less the farther the light is", () => {
		// A point on an upper edge (facing up), with the light above it, level with it and below it.
		expect(edgeGlint(500, 300, 0, -1, 500, 100, REACH, DEPTH)).toBeGreaterThan(0.5);
		expect(edgeGlint(500, 300, 0, -1, 900, 300, REACH, DEPTH)).toBe(0);
		expect(edgeGlint(500, 300, 0, -1, 500, 500, REACH, DEPTH)).toBe(0);
		// Grazing light catches less than light from straight on.
		expect(edgeGlint(500, 300, 0, -1, 1100, 100, REACH, DEPTH)).toBeLessThan(
			edgeGlint(500, 300, 0, -1, 500, 100, REACH, DEPTH),
		);
		expect(edgeGlint(500, 300, 0, -1, 500, -900, REACH, DEPTH)).toBeLessThan(
			edgeGlint(500, 300, 0, -1, 500, 100, REACH, DEPTH),
		);
		for (const [lx, ly] of [
			[0, 0],
			[500, 299],
			[5000, -5000],
		] as const) {
			const v = edgeGlint(500, 300, 0, -1, lx, ly, REACH, DEPTH);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it("lights the sides of a panel that face a stroke up and to the left, and leaves its right and lower edges dark", () => {
		const out = new Float32Array(EDGE_SAMPLES * 2);
		const near = { x: 300, y: 260, w: 400, h: 300 };
		const far = { x: 1000, y: 260, w: 400, h: 300 };
		edgeLight(near, 120, 60, REACH, DEPTH, out, 0);
		edgeLight(far, 120, 60, REACH, DEPTH, out, EDGE_SAMPLES);
		const side = (box: number, index: number) => [
			...out.subarray(box * EDGE_SAMPLES + index * SIDE_SAMPLES, box * EDGE_SAMPLES + (index + 1) * SIDE_SAMPLES),
		];
		const [top, right, bottom, left] = [0, 1, 2, 3].map((index) => side(0, index)) as [
			number[],
			number[],
			number[],
			number[],
		];
		for (const v of [...top, ...left]) expect(v).toBeGreaterThan(0);
		for (const v of [...right, ...bottom]) expect(v).toBe(0);
		// Along the upper edge, the end nearer the light is the brighter; along the left edge (drawn from its foot to its head), the head.
		expect(top[0]).toBeGreaterThan(top[SIDE_SAMPLES - 1]!);
		expect(left[SIDE_SAMPLES - 1]).toBeGreaterThan(left[0]!);
		// The corner between the two lit sides is lit; the opposite corner is not.
		expect(out[4 * SIDE_SAMPLES]).toBeGreaterThan(0);
		expect(out[4 * SIDE_SAMPLES + 2]).toBe(0);
		// The panel farther from the stroke catches less of it on every lit sample.
		const farTop = side(1, 0);
		for (let k = 0; k < SIDE_SAMPLES; k++) expect(farTop[k]).toBeLessThan(top[k]!);
		expect(Math.max(...side(1, 3))).toBeLessThan(Math.max(...left));
	});
});
