// ENDO-HIDDEN-MARKER-route-normalize
import assert from "node:assert/strict";
import { test } from "node:test";

const WORK = "__WORK__";
const { normalizeRoute } = await import(new URL("src/route-normalize.js", WORK).href);
const cases = (list) => {
	for (const [input, expected] of list) assert.equal(normalizeRoute(input), expected, JSON.stringify(input));
};

test("R1: only paths that start with a slash and have no query or fragment", () => {
	for (const bad of ["", "a/b", "a", "/a?x=1", "/a#top", "/?", "#", null, undefined, 7, ["/a"]])
		assert.throws(() => normalizeRoute(bad), TypeError, String(bad));
	cases([["/", "/"]]);
});

test("R2: percent escapes are decoded first", () => {
	cases([
		["/a%41b", "/aAb"],
		["/%7euser", "/~user"],
		["/a%2Db%2eC%5F", "/a-b.C_"],
		["/a%2fb", "/a%2Fb"],
		["/a%2Fb", "/a%2Fb"],
		["/%e4%bd%a0", "/%E4%BD%A0"],
		["/a%20b", "/a%20b"],
		["/%25", "/%25"],
		["/a/%2e%2e/b", "/b"],
		["/a/%2e/b", "/a/b"],
		["/%2E%2E%2Fx", "/..%2Fx"],
		["/%30%39", "/09"],
	]);
	for (const bad of ["/%", "/a%", "/%zz", "/%4", "/%4g", "/a%%41", "/%41%"])
		assert.throws(() => normalizeRoute(bad), SyntaxError, bad);
});

test("R3: repeated slashes", () => {
	cases([
		["//", "/"],
		["///a////b//c", "/a/b/c"],
		["/a//", "/a/"],
	]);
});

test("R4: dot segments", () => {
	cases([
		["/a/./b", "/a/b"],
		["/./a", "/a"],
		["/a/b/../c", "/a/c"],
		["/a/b/../../c", "/c"],
		["/a/b/../..", "/"],
		["/a/..b/c", "/a/..b/c"],
		["/a/.b/./.../c", "/a/.b/.../c"],
		["/a/b/c/../../d", "/a/d"],
		["/a//../b", "/b"],
	]);
	for (const bad of ["/..", "/a/../..", "/../a", "/a/b/../../..", "/%2e%2e", "/./.."])
		assert.throws(() => normalizeRoute(bad), RangeError, bad);
});

test("R5: the trailing slash", () => {
	cases([
		["/a/b/", "/a/b/"],
		["/a/b", "/a/b"],
		["/a/b/.", "/a/b/"],
		["/a/b/..", "/a/"],
		["/a/b/../", "/a/"],
		["/a/b/./", "/a/b/"],
		["/a/.", "/a/"],
		["/a/%2e", "/a/"],
		["/a/%2e%2e", "/"],
		["/.", "/"],
		["/a/..", "/"],
		["/a/../b/..", "/"],
		["/a//", "/a/"],
		["/a/b/c/..", "/a/b/"],
	]);
});

test("R6: case and other characters are kept", () => {
	cases([
		["/Users/Bob", "/Users/Bob"],
		["/café/你", "/café/你"],
		["/a b/c+d", "/a b/c+d"],
		["/a;b=c/(d)", "/a;b=c/(d)"],
		["/%C3%A9", "/%C3%A9"],
	]);
});

test("R7: error precedence", () => {
	assert.throws(() => normalizeRoute("a/%zz/../.."), TypeError);
	assert.throws(() => normalizeRoute("/%zz/../.."), SyntaxError);
	assert.throws(() => normalizeRoute("/../%zz"), SyntaxError);
	assert.throws(() => normalizeRoute("/../%zz?x"), TypeError);
	assert.throws(() => normalizeRoute("/../a"), RangeError);
});
