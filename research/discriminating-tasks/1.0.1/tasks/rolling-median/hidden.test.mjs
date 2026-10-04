// ENDO-HIDDEN-MARKER-rolling-median
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { RollingMedian } = await import(new URL("src/rolling-median.js", WORK).href);

test("R1: the window size must be an integer of 1 or more", () => {
	for (const bad of [0, -1, 1.5, "3", NaN, Infinity, null, undefined])
		assert.throws(() => new RollingMedian(bad), RangeError, String(bad));
	assert.doesNotThrow(() => new RollingMedian(1));
	assert.doesNotThrow(() => new RollingMedian(50));
});

test("R2: add validates, drops the oldest, and returns the median", () => {
	const m = new RollingMedian(3);
	for (const bad of ["4", NaN, Infinity, -Infinity, null, undefined, {}, [1]])
		assert.throws(() => m.add(bad), TypeError, String(bad));
	assert.equal(m.size, 0);
	assert.equal(m.add(4), 4);
	assert.throws(() => m.add(Number.NaN), TypeError);
	assert.deepEqual(m.values(), [4]);
	m.add(8);
	m.add(6);
	assert.equal(m.add(100), 8);
	assert.deepEqual(m.values(), [8, 6, 100]);
	assert.equal(m.add(-5), 6);
	assert.deepEqual(m.values(), [6, 100, -5]);
});

test("R3: the median is the lower middle value, sorted numerically", () => {
	const m = new RollingMedian(10);
	assert.equal(m.median(), null);
	assert.equal(m.add(10), 10);
	assert.equal(m.add(2), 2);
	assert.equal(m.add(30), 10);
	assert.equal(m.add(4), 4);
	assert.equal(m.median(), 4);
	assert.equal(m.add(4), 4);
	assert.equal(m.add(-1), 4);
	const d = new RollingMedian(4);
	for (const x of [9, 100, 1, 25]) d.add(x);
	assert.equal(d.median(), 9);
	const f = new RollingMedian(2);
	f.add(1.5);
	assert.equal(f.add(2.5), 1.5);
});

test("R4: size and values", () => {
	const m = new RollingMedian(3);
	assert.equal(m.size, 0);
	assert.deepEqual(m.values(), []);
	m.add(3);
	m.add(1);
	assert.equal(m.size, 2);
	const copy = m.values();
	copy.push(99);
	copy[0] = -7;
	assert.deepEqual(m.values(), [3, 1]);
	assert.equal(m.median(), 1);
	for (const x of [7, 8, 9]) m.add(x);
	assert.equal(m.size, 3);
	assert.deepEqual(m.values(), [7, 8, 9]);
});

test("R5: reset empties the window and keeps the size", () => {
	const m = new RollingMedian(2);
	m.add(1);
	m.add(2);
	assert.equal(m.reset(), undefined);
	assert.equal(m.size, 0);
	assert.equal(m.median(), null);
	m.add(5);
	m.add(6);
	m.add(7);
	assert.deepEqual(m.values(), [6, 7]);
});

test("R6: resize", () => {
	const m = new RollingMedian(5);
	for (const x of [5, 4, 3, 2, 1]) m.add(x);
	assert.throws(() => m.resize(0), RangeError);
	assert.throws(() => m.resize(2.5), RangeError);
	assert.deepEqual(m.values(), [5, 4, 3, 2, 1]);
	assert.equal(m.resize(3), 2);
	assert.deepEqual(m.values(), [3, 2, 1]);
	assert.equal(m.size, 3);
	m.add(10);
	assert.deepEqual(m.values(), [2, 1, 10]);
	assert.equal(m.resize(6), 2);
	m.add(0);
	m.add(20);
	m.add(30);
	assert.deepEqual(m.values(), [2, 1, 10, 0, 20, 30]);
	m.add(40);
	assert.deepEqual(m.values(), [1, 10, 0, 20, 30, 40]);
	const e = new RollingMedian(2);
	assert.equal(e.resize(4), null);
});
