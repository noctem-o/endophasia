import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRoute } from "../src/route-normalize.js";

test("collapses slashes and dot segments", () => {
	assert.equal(normalizeRoute("/a//b/./c"), "/a/b/c");
	assert.equal(normalizeRoute("/a/b/../c"), "/a/c");
});

test("keeps a trailing slash", () => {
	assert.equal(normalizeRoute("/a/b/"), "/a/b/");
});
