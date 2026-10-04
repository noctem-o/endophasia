// ENDO-HIDDEN-MARKER-markup-lite
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { render } = await import(new URL("src/markup-lite.js", WORK).href);
const cases = (list) => {
	for (const [input, expected] of list) assert.equal(render(input), expected, JSON.stringify(input));
};

test("R1: type check and escaping", () => {
	for (const bad of [null, undefined, 5, {}, ["a"]]) assert.throws(() => render(bad), TypeError);
	cases([
		["", ""],
		["a & b < c > d", "a &amp; b &lt; c &gt; d"],
		["&amp;", "&amp;amp;"],
		["say \"hi\" it's\nok", "say \"hi\" it's\nok"],
		["`a<b>&c`", "<code>a&lt;b&gt;&amp;c</code>"],
		["*x<y*", "<b>x&lt;y</b>"],
	]);
});

test("R2: the three spans", () => {
	cases([
		["*bold* and _it_ and `co<de>`", "<b>bold</b> and <i>it</i> and <code>co&lt;de&gt;</code>"],
		["*a* *b*", "<b>a</b> <b>b</b>"],
		["(_a_)", "(<i>a</i>)"],
		["*a*b", "<b>a</b>b"],
		["`x` `y`", "<code>x</code> <code>y</code>"],
	]);
});

test("R3: openers, closers and plain markers", () => {
	cases([
		["* a*", "* a*"],
		["*a *", "*a *"],
		["2 * 3 * 4", "2 * 3 * 4"],
		["**", "**"],
		["*", "*"],
		["_", "_"],
		["*a", "*a"],
		["a*", "a*"],
		["*a *b*", "<b>a *b</b>"],
		["_a _ b_", "<i>a _ b</i>"],
		["*a\n*", "*a\n*"],
	]);
});

test("R4: the underscore flanking rule", () => {
	cases([
		["snake_case_name", "snake_case_name"],
		["_a_b", "_a_b"],
		["_a_b_", "<i>a_b</i>"],
		["x_ y_", "x_ y_"],
		["foo _bar_ baz", "foo <i>bar</i> baz"],
		["1_000_000", "1_000_000"],
		["_a_.", "<i>a</i>."],
		["-_a_-", "-<i>a</i>-"],
		["a*b*c", "a<b>b</b>c"],
	]);
});

test("R5: code spans", () => {
	cases([
		["`*a*`", "<code>*a*</code>"],
		["`_a_`", "<code>_a_</code>"],
		["a`b", "a`b"],
		["`", "`"],
		["`` x", "`` x"],
		["``", "``"],
		["`a\\*`", "<code>a\\*</code>"],
		["`a\\`", "<code>a\\</code>"],
		["*a `b*` c*", "<b>a <code>b*</code> c</b>"],
		["_a `b_` c_", "<i>a <code>b_</code> c</i>"],
		["*a `b* c", "<b>a `b</b> c"],
	]);
});

test("R6: nesting and no overlap", () => {
	cases([
		["*a _b_ c*", "<b>a <i>b</i> c</b>"],
		["*_a_*", "<b><i>a</i></b>"],
		["_*a*_", "<i><b>a</b></i>"],
		["*a _b* c_", "<b>a _b</b> c_"],
		["_a *b_ c*", "<i>a *b</i> c*"],
		["*a* _b_ `c`", "<b>a</b> <i>b</i> <code>c</code>"],
		["*a `b` _c_*", "<b>a <code>b</code> <i>c</i></b>"],
	]);
});

test("R7: backslash escapes", () => {
	cases([
		["\\*a\\*", "*a*"],
		["\\_a\\_", "_a_"],
		["\\`a\\`", "`a`"],
		["\\\\", "\\"],
		["\\\\*a*", "\\<b>a</b>"],
		["a\\b", "a\\b"],
		["\\", "\\"],
		["*a\\**", "<b>a*</b>"],
		["*a\\*", "*a*"],
		["_a\\_b_", "<i>a_b</i>"],
		["\\<", "\\&lt;"],
	]);
});
