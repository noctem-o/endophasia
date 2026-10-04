import assert from "node:assert/strict";
import { test } from "node:test";
import { retrySchedule } from "../src/retry-schedule.js";

test("exponential waits without jitter", () => {
	assert.deepEqual(retrySchedule({ retries: 4, baseMs: 100, factor: 2, maxMs: 1000, jitter: "none" }), [100, 200, 400, 800]);
});

test("the cap applies", () => {
	assert.deepEqual(retrySchedule({ retries: 3, baseMs: 100, factor: 10, maxMs: 500, jitter: "none" }), [100, 500, 500]);
});
