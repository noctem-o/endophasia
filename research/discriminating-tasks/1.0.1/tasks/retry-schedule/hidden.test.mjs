// ENDO-HIDDEN-MARKER-retry-schedule
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { retrySchedule } = await import(new URL("src/retry-schedule.js", WORK).href);
const O = { retries: 4, baseMs: 100, factor: 2, maxMs: 1000, jitter: "none" };
const seq = (values) => {
	let i = 0;
	const fn = () => values[i++];
	fn.calls = () => i;
	return fn;
};

test("R1: option validation", () => {
	for (const bad of [null, undefined, 5, "x"]) assert.throws(() => retrySchedule(bad), TypeError, String(bad));
	for (const patch of [
		{ retries: -1 },
		{ retries: 101 },
		{ retries: 2.5 },
		{ retries: "3" },
		{ retries: undefined },
		{ baseMs: 0 },
		{ baseMs: -5 },
		{ baseMs: Infinity },
		{ baseMs: "100" },
		{ maxMs: 0 },
		{ maxMs: NaN },
		{ factor: 0.5 },
		{ factor: Infinity },
		{ factor: "2" },
		{ jitter: "half" },
		{ jitter: undefined },
		{ jitter: "FULL" },
	])
		assert.throws(() => retrySchedule({ ...O, ...patch }), TypeError, JSON.stringify(patch));
	assert.throws(() => retrySchedule({ ...O, baseMs: 2000 }), RangeError);
	assert.throws(() => retrySchedule({ ...O, baseMs: 2000, factor: 0.5 }), TypeError);
	assert.throws(() => retrySchedule({ ...O, baseMs: 2000, jitter: "x" }), TypeError);
	assert.doesNotThrow(() => retrySchedule({ ...O, retries: 100 }));
	assert.doesNotThrow(() => retrySchedule({ ...O, baseMs: 1000 }));
	assert.doesNotThrow(() => retrySchedule({ ...O, factor: 1 }));
});

test("R2: one entry per retry", () => {
	assert.deepEqual(retrySchedule({ ...O, retries: 0 }), []);
	assert.equal(retrySchedule({ ...O, retries: 1 }).length, 1);
	assert.equal(retrySchedule({ ...O, retries: 100 }).length, 100);
	assert.deepEqual(retrySchedule({ ...O, retries: 3 }), [100, 200, 400]);
});

test("R3: the capped exponential", () => {
	assert.deepEqual(retrySchedule(O), [100, 200, 400, 800]);
	assert.deepEqual(retrySchedule({ ...O, retries: 6 }), [100, 200, 400, 800, 1000, 1000]);
	assert.deepEqual(retrySchedule({ retries: 4, baseMs: 10, factor: 1, maxMs: 50, jitter: "none" }), [10, 10, 10, 10]);
	assert.deepEqual(retrySchedule({ retries: 3, baseMs: 150, factor: 1.5, maxMs: 10000, jitter: "none" }), [150, 225, 338]);
	assert.deepEqual(retrySchedule({ retries: 3, baseMs: 7, factor: 10, maxMs: 500, jitter: "none" }), [7, 70, 500]);
});

test("R4: jitter modes and how rand is used", () => {
	const none = seq([0.5, 0.5, 0.5, 0.5]);
	retrySchedule(O, none);
	assert.equal(none.calls(), 0);
	const full = seq([0.5, 0.25, 0.9, 0]);
	assert.deepEqual(retrySchedule({ ...O, jitter: "full" }, full), [50, 50, 360, 1]);
	assert.equal(full.calls(), 4);
	const equal = seq([0.5, 0, 0.5, 0.75]);
	assert.deepEqual(retrySchedule({ ...O, jitter: "equal" }, equal), [75, 100, 300, 700]);
	assert.equal(equal.calls(), 4);
	const capped = seq([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
	assert.deepEqual(retrySchedule({ ...O, retries: 6, jitter: "full" }, capped), [50, 100, 200, 400, 500, 500]);
	assert.equal(capped.calls(), 6);
});

test("R5: rounding and the minimum of 1", () => {
	assert.deepEqual(retrySchedule({ retries: 3, baseMs: 0.2, factor: 1, maxMs: 5, jitter: "none" }), [1, 1, 1]);
	assert.deepEqual(retrySchedule({ retries: 2, baseMs: 2.5, factor: 1, maxMs: 5, jitter: "none" }), [3, 3]);
	assert.deepEqual(retrySchedule({ retries: 2, baseMs: 2.4, factor: 1, maxMs: 5, jitter: "none" }), [2, 2]);
	assert.deepEqual(retrySchedule({ retries: 1, baseMs: 10, factor: 1, maxMs: 10, jitter: "full" }, seq([0.04])), [1]);
	assert.deepEqual(retrySchedule({ retries: 1, baseMs: 10, factor: 1, maxMs: 10, jitter: "full" }, seq([0.05])), [1]);
	assert.deepEqual(retrySchedule({ retries: 1, baseMs: 10, factor: 1, maxMs: 10, jitter: "full" }, seq([0.15])), [2]);
	assert.deepEqual(retrySchedule({ retries: 1, baseMs: 10, factor: 1, maxMs: 10, jitter: "full" }, seq([0.25])), [3]);
	assert.deepEqual(retrySchedule({ retries: 1, baseMs: 3, factor: 1, maxMs: 10, jitter: "full" }, seq([0.5])), [2]);
	assert.deepEqual(retrySchedule({ retries: 1, baseMs: 1, factor: 1, maxMs: 10, jitter: "equal" }, seq([0])), [1]);
});

test("R6: rand checks and no mutation", () => {
	for (const jitter of ["full", "equal"]) {
		assert.throws(() => retrySchedule({ ...O, jitter }), TypeError);
		assert.throws(() => retrySchedule({ ...O, jitter }, 0.5), TypeError);
		for (const bad of [1, -0.1, 1.5, NaN, Infinity, "0.5", undefined, null])
			assert.throws(() => retrySchedule({ ...O, jitter }, seq([0.5, bad])), RangeError, `${jitter} ${String(bad)}`);
	}
	assert.doesNotThrow(() => retrySchedule({ ...O, jitter: "full" }, seq([0, 0, 0, 0.999999])));
	assert.doesNotThrow(() => retrySchedule(O, "not a function"));
	const options = Object.freeze({ ...O, jitter: "full" });
	assert.doesNotThrow(() => retrySchedule(options, seq([0.1, 0.2, 0.3, 0.4])));
	assert.equal(options.jitter, "full");
});
