import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, parseDuration } from "../src/duration.mjs";

test("parses hours, minutes and seconds", () => {
	assert.equal(parseDuration("1h30m"), 5400);
	assert.equal(parseDuration("45s"), 45);
	assert.equal(parseDuration("2h5s"), 7205);
});

test("rejects what is not a duration", () => {
	for (const text of ["", "h", "1m1h", "1h1h", "1.5h", "-1s", "1h 30m"])
		assert.throws(() => parseDuration(text), RangeError, text);
});

test("formats hours, minutes and seconds", () => {
	assert.equal(formatDuration(5400), "1h30m");
	assert.equal(formatDuration(59), "59s");
	assert.equal(formatDuration(0), "0s");
});

test("parses days", () => {
	assert.equal(parseDuration("2d"), 172800);
	assert.equal(parseDuration("1d2h"), 93600);
	assert.throws(() => parseDuration("1h1d"), RangeError);
});

test("formats days", () => {
	assert.equal(formatDuration(86400), "1d");
	assert.equal(formatDuration(90000), "1d1h");
});
