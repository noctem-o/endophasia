// ENDO-HIDDEN-MARKER-report-bugs
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { parseCsv, parseCsvLine } = await import(new URL("src/csv.js", WORK).href);
const { groupTotals } = await import(new URL("src/aggregate.js", WORK).href);
const { renderReport } = await import(new URL("src/report.js", WORK).href);

test("R1: parseCsvLine", () => {
	assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
	assert.deepEqual(parseCsvLine("  a \t, b ,c  "), ["a", "b", "c"]);
	assert.deepEqual(parseCsvLine('"a,b",c'), ["a,b", "c"]);
	assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', "x"]);
	assert.deepEqual(parseCsvLine('""""'), ['"']);
	assert.deepEqual(parseCsvLine('""'), [""]);
	assert.deepEqual(parseCsvLine('  " keep  ", x'), [" keep  ", "x"]);
	assert.deepEqual(parseCsvLine('"a"  ,  "b"  '), ["a", "b"]);
	assert.deepEqual(parseCsvLine(""), [""]);
	assert.deepEqual(parseCsvLine("a,"), ["a", ""]);
	assert.deepEqual(parseCsvLine(",,"), ["", "", ""]);
	assert.deepEqual(parseCsvLine('a"b,c'), ['a"b', "c"]);
	for (const bad of ['"abc', '"a"b', '"a" b,c', 'x,"y', '"a""']) assert.throws(() => parseCsvLine(bad), SyntaxError, bad);
});

test("R2: parseCsv", () => {
	assert.deepEqual(parseCsv("k,v\nx,1\ny,2"), [{ k: "x", v: "1" }, { k: "y", v: "2" }]);
	assert.deepEqual(parseCsv("k,v\r\nx,1\r\n\r\ny,2\r\n"), [{ k: "x", v: "1" }, { k: "y", v: "2" }]);
	assert.deepEqual(parseCsv(""), []);
	assert.deepEqual(parseCsv("\n\n"), []);
	assert.deepEqual(parseCsv("k,v\n"), []);
	assert.deepEqual(parseCsv('\nk,v\n"a,b",2'), [{ k: "a,b", v: "2" }]);
	for (const bad of [null, undefined, 5, ["a"]]) assert.throws(() => parseCsv(bad), TypeError);
	const message = (text) => {
		try {
			parseCsv(text);
		} catch (error) {
			assert.ok(error instanceof RangeError, `${error}`);
			return error.message;
		}
		assert.fail("did not throw");
	};
	assert.match(message("k,v\nx,1\ny"), /line 3\b/);
	assert.match(message("k,v\n\n\nx,1,2"), /line 4\b/);
	assert.match(message("\nk,v\r\nx\r\n"), /line 3\b/);
	assert.doesNotMatch(message("k,v\nx\n"), /line 3\b/);
});

test("R3: groupTotals", () => {
	const rows = (list) => list.map(([k, v]) => ({ k, v }));
	assert.deepEqual(groupTotals(rows([["a", "10.50"], ["b", "3"], ["a", "1.25"]]), "k", "v"), [
		{ key: "a", cents: 1175 },
		{ key: "b", cents: 300 },
	]);
	assert.deepEqual(groupTotals(rows([["a", "19.99"], ["a", "0.29"], ["a", "0.58"], ["a", "1.15"]]), "k", "v"), [
		{ key: "a", cents: 2201 },
	]);
	assert.deepEqual(
		groupTotals(rows([["a", "0.07"], ["b", "0.57"], ["c", "1.1"], ["d", "4.35"]]), "k", "v").map((t) => t.cents).sort((x, y) => x - y),
		[7, 57, 110, 435],
	);
	assert.deepEqual(groupTotals(rows([["a", "-5"], ["a", "2.5"]]), "k", "v"), [{ key: "a", cents: -250 }]);
	assert.deepEqual(groupTotals([], "k", "v"), []);
	for (const bad of ["1.234", "abc", "", "1,5", ".5", "5.", "+5", " 5", "1e3", "--1"])
		assert.throws(() => groupTotals(rows([["a", bad]]), "k", "v"), TypeError, bad);
	assert.throws(() => groupTotals([{ k: "a", v: 5 }], "k", "v"), TypeError);
	assert.throws(() => groupTotals([{ k: "a" }], "k", "v"), TypeError);
	assert.throws(() => groupTotals([{ k: 1, v: "5" }], "k", "v"), TypeError);
});

test("R4: groupTotals order", () => {
	const rows = (list) => list.map(([k, v]) => ({ k, v }));
	assert.deepEqual(groupTotals(rows([["a", "0.07"], ["b", "0.57"], ["c", "1.1"], ["d", "4.35"]]), "k", "v"), [
		{ key: "d", cents: 435 },
		{ key: "c", cents: 110 },
		{ key: "b", cents: 57 },
		{ key: "a", cents: 7 },
	]);
	assert.deepEqual(groupTotals(rows([["a", "-5"], ["b", "-0.01"], ["c", "0"]]), "k", "v").map((t) => t.key), ["c", "b", "a"]);
	assert.deepEqual(groupTotals(rows([["b", "1"], ["a", "1"], ["B", "1"], ["a_", "1"], ["aa", "1"]]), "k", "v").map((t) => t.key), ["B", "a", "a_", "aa", "b"]);
});

test("R5: renderReport", () => {
	assert.equal(
		renderReport([
			{ key: "a", cents: 1175 },
			{ key: "b", cents: 300 },
		]),
		"a     | 11.75\nb     |  3.00\n-------------\nTOTAL | 14.75",
	);
	assert.equal(
		renderReport([
			{ key: "short", cents: 123456789 },
			{ key: "a much longer key", cents: 5 },
			{ key: "mid", cents: -5 },
		]),
		[
			"short             | 1,234,567.89",
			"a much longer key |         0.05",
			"mid               |        -0.05",
			"--------------------------------",
			"TOTAL             | 1,234,567.89",
		].join("\n"),
	);
	assert.equal(renderReport([]), "------------\nTOTAL | 0.00");
	assert.equal(renderReport([{ key: "x", cents: 100000 }]), "x     | 1,000.00\n----------------\nTOTAL | 1,000.00");
	assert.equal(renderReport([{ key: "k", cents: -123456 }]), "k     | -1,234.56\n-----------------\nTOTAL | -1,234.56");
	assert.equal(renderReport([{ key: "k", cents: 99999999 }]), "k     | 999,999.99\n------------------\nTOTAL | 999,999.99");
	assert.equal(renderReport([{ key: "k", cents: 100 }, { key: "j", cents: 100 }]), "k     | 1.00\nj     | 1.00\n------------\nTOTAL | 2.00");
	for (const bad of [null, undefined, {}, "x"]) assert.throws(() => renderReport(bad), TypeError);
});
