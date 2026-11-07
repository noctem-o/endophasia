// The acceptance check for the WORK-CYCLE-001A task: `node --test` must pass. The task forbids changing this file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slug.mjs";

test("lowercases and joins words with one hyphen", () => {
	assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses runs of spaces and punctuation and trims the ends", () => {
	assert.equal(slugify("  Hello,   World!  "), "hello-world");
});
