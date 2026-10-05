import assert from "node:assert/strict";
import { test } from "node:test";
import { groupTotals } from "../src/aggregate.js";
import { parseCsv, parseCsvLine } from "../src/csv.js";
import { renderReport } from "../src/report.js";

test("parses a simple line and file", () => {
	assert.deepEqual(parseCsvLine("a, b ,c"), ["a", "b", "c"]);
	assert.deepEqual(parseCsv("k,v\nx,1\n\ny,2\n"), [
		{ k: "x", v: "1" },
		{ k: "y", v: "2" },
	]);
});

test("groups and renders", () => {
	const totals = groupTotals(
		[
			{ k: "a", v: "10.50" },
			{ k: "b", v: "3" },
			{ k: "a", v: "1.25" },
		],
		"k",
		"v",
	);
	assert.deepEqual(totals, [
		{ key: "a", cents: 1175 },
		{ key: "b", cents: 300 },
	]);
	assert.equal(renderReport(totals), "a     | 11.75\nb     |  3.00\n-------------\nTOTAL | 14.75");
});
