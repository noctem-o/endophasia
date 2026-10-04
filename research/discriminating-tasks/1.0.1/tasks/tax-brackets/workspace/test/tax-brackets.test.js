import assert from "node:assert/strict";
import { test } from "node:test";
import { computeTax } from "../src/tax-brackets.js";

const SCHEDULE = [
	{ upTo: 100000, rateBp: 1000 },
	{ upTo: 400000, rateBp: 2000 },
	{ upTo: null, rateBp: 3000 },
];

test("income inside the first bracket", () => {
	assert.equal(computeTax(50000, SCHEDULE).totalCents, 5000);
});

test("income reaching the last bracket", () => {
	const result = computeTax(500000, SCHEDULE);
	assert.equal(result.totalCents, 10000 + 60000 + 30000);
	assert.equal(result.perBracket.length, 3);
});
