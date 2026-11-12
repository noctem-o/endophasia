// Candidate C's own tests: they assert its own (additive) output, from its own expectations.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toRoman } from "../roman.mjs";

const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
for (const [n, numeral] of Object.entries(expected)) test(`toRoman(${n})`, () => assert.equal(toRoman(Number(n)), numeral));
