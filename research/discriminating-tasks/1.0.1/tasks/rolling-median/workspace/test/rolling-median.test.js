import assert from "node:assert/strict";
import { test } from "node:test";
import { RollingMedian } from "../src/rolling-median.js";

test("the median of a growing window", () => {
	const m = new RollingMedian(3);
	assert.equal(m.add(5), 5);
	assert.equal(m.add(1), 1);
	assert.equal(m.add(9), 5);
});

test("the oldest value drops out", () => {
	const m = new RollingMedian(2);
	m.add(1);
	m.add(2);
	m.add(10);
	assert.deepEqual(m.values(), [2, 10]);
});
