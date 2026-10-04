// Generates the variance study's experiment specs (DESIGN.md §3-§5) from one source, so the pilot and the main run
// cannot drift apart:
//
//   node research/variance/1.0.1/make-spec.ts pilot          -> spec-pilot.json (3 trials; arms A, B, B+C and none)
//   node research/variance/1.0.1/make-spec.ts main <N>       -> spec.json (N trials; arms A, B, B+C)
//
// Everything here is synthetic.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const TOOL_USE_PROMPT =
	"Work only in the current working directory. Do these three steps in order, one tool call each: 1. Use the read tool to read notes.txt. 2. Use the edit tool to replace the word draft with the word final in notes.txt. 3. Use the bash tool to run exactly this command: wc -l notes.txt. Then reply with the single word: done";
const NOTES = "status: draft\nowner: endophasia fixture\nnote: this file is part of a synthetic test workspace\n";

const SLUG_SOURCE = `// Turn a title into a URL slug.
export function slugify(title) {
	return title.toLowerCase().replace(/[^a-z0-9]/g, "-");
}
`;
const SLUG_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slug.js";

test("lowercases words and joins them with a dash", () => {
	assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses a run of other characters into one dash", () => {
	assert.equal(slugify("Rock & Roll!! Forever"), "rock-roll-forever");
});

test("trims dashes at both ends", () => {
	assert.equal(slugify("  --Draft notes--  "), "draft-notes");
});
`;

const ROMAN_SOURCE = `// Convert a whole number from 1 to 3999 to a Roman numeral.
export function toRoman(n) {
	throw new Error("not implemented");
}
`;
const ROMAN_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { toRoman } from "../src/roman.js";

test("converts numbers to Roman numerals", () => {
	const cases = [
		[1, "I"],
		[4, "IV"],
		[9, "IX"],
		[14, "XIV"],
		[40, "XL"],
		[90, "XC"],
		[400, "CD"],
		[1994, "MCMXCIV"],
		[3999, "MMMCMXCIX"],
	];
	for (const [n, roman] of cases) assert.equal(toRoman(n), roman);
});

test("rejects numbers outside 1 to 3999 with a RangeError", () => {
	assert.throws(() => toRoman(0), RangeError);
	assert.throws(() => toRoman(4000), RangeError);
});
`;

/** The check: the test file is unchanged (sha256), and `node --test` exits 0. */
function testCheck(testFile: string, content: string): string[] {
	const script = [
		'const { createHash } = require("node:crypto");',
		'const { readFileSync } = require("node:fs");',
		'const { spawnSync } = require("node:child_process");',
		`const digest = createHash("sha256").update(readFileSync(${JSON.stringify(testFile)})).digest("hex");`,
		`if (digest !== ${JSON.stringify(sha256(content))}) { console.log("the test file was changed"); process.exit(2); }`,
		'const run = spawnSync(process.execPath, ["--test"], { stdio: "inherit" });',
		"process.exit(run.status ?? 1);",
	].join("\n");
	return ["node", "-e", script];
}

const extension = (body: string) =>
	`// Endophasia variance study arm (DESIGN.md §4). A documented before_provider_request handler.\nexport default function (pi: any) {\n\tpi.on("before_provider_request", (event: any) => ${body});\n}\n`;

export const ARMS = {
	a: {
		description: "A: Pi's defaults, with a no-op extension (the payload is unchanged)",
		source: extension("undefined"),
		injected: {},
	},
	b: {
		description: "B: temperature 0 and seed 1234 (prompt cache as default)",
		source: extension("({ ...event.payload, temperature: 0, seed: 1234 })"),
		injected: { temperature: 0, seed: 1234 },
	},
	"b-c": {
		description: "B+C: temperature 0, seed 1234 and cache_prompt false",
		source: extension("({ ...event.payload, temperature: 0, seed: 1234, cache_prompt: false })"),
		injected: { temperature: 0, seed: 1234, cache_prompt: false },
	},
} as const;

export function varianceSpec(kind: "pilot" | "main", trials: number): EndoExperimentSpecV0 {
	const arms = Object.entries(ARMS).map(([id, arm]) => ({
		id,
		description: arm.description,
		extensions: { "endo-arm.ts": arm.source },
	}));
	const conditions =
		kind === "pilot" ? [...arms, { id: "none", description: "pilot control: no extension at all (M4)" }] : arms;
	return {
		schemaVersion: "endo.experiment-spec.v0",
		id: kind === "pilot" ? "endo.experiment.variance-1.0.1-pilot" : "endo.experiment.variance-1.0.1",
		description:
			kind === "pilot"
				? "Variance study pilot (research/variance/1.0.1/DESIGN.md §9): manipulation checks and wall-time estimate"
				: "Variance study main run (research/variance/1.0.1/DESIGN.md)",
		trials,
		seed: null,
		pi: "/usr/bin/pi",
		upstream: "http://127.0.0.1:8080",
		provider: "endolocal",
		model: "qwen3.8-27b",
		digestDomain: "fixture",
		timeoutMs: 600_000,
		tasks: [
			{
				id: "tool-use",
				prompts: [TOOL_USE_PROMPT],
				workspace: { "notes.txt": NOTES },
				check: { argv: ["grep", "-q", "status: final", "notes.txt"] },
			},
			{
				id: "fix-failing-test",
				prompts: [
					"The tests in this directory fail. Run them with: node --test. Then fix the bug in src/slug.js so that every test passes. Do not change any file under test/. When all tests pass, reply with the single word: done",
				],
				workspace: {
					"package.json": '{"name":"slug-task","private":true,"type":"module"}\n',
					"src/slug.js": SLUG_SOURCE,
					"test/slug.test.js": SLUG_TEST,
				},
				check: { argv: testCheck("test/slug.test.js", SLUG_TEST), timeoutMs: 60_000 },
			},
			{
				id: "implement-function",
				prompts: [
					"Implement the function toRoman in src/roman.js so that the tests pass. Run the tests with: node --test. Do not change any file under test/. When all tests pass, reply with the single word: done",
				],
				workspace: {
					"package.json": '{"name":"roman-task","private":true,"type":"module"}\n',
					"src/roman.js": ROMAN_SOURCE,
					"test/roman.test.js": ROMAN_TEST,
				},
				check: { argv: testCheck("test/roman.test.js", ROMAN_TEST), timeoutMs: 60_000 },
			},
		],
		conditions,
		manipulation: {
			baseline: "a",
			conditions: {
				a: { injected: {} },
				b: { injected: { ...ARMS.b.injected } },
				"b-c": { injected: { ...ARMS["b-c"].injected }, zeroCacheReads: true },
			},
			...(kind === "pilot" ? { identical: [["a", "none"]] as [string, string][] } : {}),
		},
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [kind, n] = process.argv.slice(2);
	if (kind === "pilot")
		writeFileSync(join(HERE, "spec-pilot.json"), `${JSON.stringify(varianceSpec("pilot", 3), null, "\t")}\n`);
	else if (kind === "main" && Number.isInteger(Number(n)) && Number(n) > 0)
		writeFileSync(join(HERE, "spec.json"), `${JSON.stringify(varianceSpec("main", Number(n)), null, "\t")}\n`);
	else {
		process.stderr.write("usage: make-spec.ts pilot | main <N>\n");
		process.exit(2);
	}
}
