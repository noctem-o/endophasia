import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "../src/markup-lite.js";

test("bold, italic and code", () => {
	assert.equal(render("*bold* and _it_ and `co<de>`"), "<b>bold</b> and <i>it</i> and <code>co&lt;de&gt;</code>");
});

test("escapes the three characters", () => {
	assert.equal(render("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});
