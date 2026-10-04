// The pinned-environment study's own code (research/pinned-environment/1.0.1/), checked before its pilot (DESIGN.md
// §3-§6): the spec keeps E2's tasks and extensions byte for byte and pins only the three pinned arms; the test reporter
// prints no durations and gives the same output twice on E2's real tasks; and the residual-source rule (§6.10) and the
// M6 duration pattern classify E2's recorded tool output (the committed variance cassettes) as expected.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type EndoExperimentSpecV0, endoExperimentSpecProblemV0 } from "../protocol/experiment-spec.ts";
import { NODE_REPORTER_DURATION_V0, residualSourceV0 } from "../research/pinned-environment/1.0.1/analyze.ts";
import { PINNED, pinnedSpec } from "../research/pinned-environment/1.0.1/make-spec.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

const STUDY = fileURLToPath(new URL("../research/pinned-environment/1.0.1/", import.meta.url));
const E2 = fileURLToPath(new URL("../research/variance/1.0.1/", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Every tool result's text in a committed E2 cassette's longest request. */
function e2ToolResults(cassette: string): string[] {
	const blobs = join(E2, "cassettes", cassette, "blobs", "fixture-public");
	const bodies = readdirSync(blobs)
		.map((file) => readFileSync(join(blobs, file), "utf8"))
		.filter((text) => text.includes('"messages"'))
		.map((text) => JSON.parse(text) as { messages: { role: string; content: unknown }[] });
	const longest = bodies.sort((a, b) => b.messages.length - a.messages.length)[0]!;
	return longest.messages
		.filter((message) => message.role === "tool")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content as { text: string }[]).map((part) => part.text).join(""),
		);
}

describe("the pinned-environment study's spec (DESIGN §3, §4)", () => {
	const spec = pinnedSpec("pilot", 3);
	const e2 = JSON.parse(readFileSync(join(E2, "spec.json"), "utf8")) as EndoExperimentSpecV0;

	it("is valid, and keeps E2's tasks, serving inputs and extension sources byte for byte", () => {
		expect(endoExperimentSpecProblemV0(spec)).toBeNull();
		expect(canonicalEndoJsonV0(spec.tasks)).toBe(canonicalEndoJsonV0(e2.tasks));
		for (const key of ["pi", "upstream", "provider", "model", "digestDomain", "timeoutMs"] as const)
			expect(spec[key], key).toEqual(e2[key]);
		const e2Source = (id: string) =>
			e2.conditions.find((condition) => condition.id === id)!.extensions!["endo-arm.ts"];
		expect(spec.conditions.map((condition) => condition.id)).toEqual(["a-p", "b-p", "b-c-p", "b-c-u"]);
		for (const condition of spec.conditions)
			expect(condition.extensions!["endo-arm.ts"], condition.id).toBe(e2Source(condition.id.replace(/-[pu]$/, "")));
	});

	it("pins the three pinned arms with the design's environment, and leaves B+C-u as E2 ran it", () => {
		const environment = Object.fromEntries(spec.conditions.map((condition) => [condition.id, condition.environment]));
		expect(environment["b-c-u"]).toBeUndefined();
		for (const id of ["a-p", "b-p", "b-c-p"]) expect(environment[id], id).toEqual(PINNED);
		expect(PINNED.variables).toEqual({
			TZ: "UTC",
			LC_ALL: "C",
			NODE_OPTIONS: "--test-reporter={root}/env/test-reporter.mjs",
		});
		expect(PINNED.fileTime).toBe("2026-01-01T00:00:00Z");
		expect(PINNED.files!["test-reporter.mjs"]).toBe(readFileSync(join(STUDY, "test-reporter.mjs"), "utf8"));
		expect(spec.manipulation).toEqual({
			baseline: "a-p",
			conditions: {
				"a-p": { injected: {} },
				"b-p": { injected: { temperature: 0, seed: 1234 } },
				"b-c-p": { injected: { temperature: 0, seed: 1234, cache_prompt: false }, zeroCacheReads: true },
				"b-c-u": { injected: { temperature: 0, seed: 1234, cache_prompt: false }, zeroCacheReads: true },
			},
		});
	});
});

describe("the test reporter (DESIGN §4)", () => {
	const reporter = join(STUDY, "test-reporter.mjs");
	const run = (workspace: string, args: string[]) => {
		const result = spawnSync(process.execPath, args, {
			cwd: workspace,
			env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: `--test-reporter=${reporter}` },
			encoding: "utf8",
		});
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	};
	const workspace = (task: string) => {
		const root = mkdtempSync(join(tmpdir(), "endo-reporter-test-"));
		dirs.push(root);
		const task_ = pinnedSpec("pilot", 1).tasks.find((entry) => entry.id === task)!;
		for (const [path, content] of Object.entries(task_.workspace)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		return root;
	};

	it.each(["fix-failing-test", "implement-function"])(
		"on %s, `node --test` and a test file run directly print no duration, the same output twice, and the failures",
		(task) => {
			const root = workspace(task);
			const first = run(root, ["--test"]);
			const second = run(root, ["--test"]);
			expect(first.status).toBe(1);
			expect(first.output).toBe(second.output);
			expect(first.output).not.toMatch(NODE_REPORTER_DURATION_V0);
			expect(first.output).not.toMatch(/\d+(?:\.\d+)?ms/);
			expect(first.output).toMatch(/^✖ /mu);
			expect(first.output).toMatch(/ℹ fail [12]\n/);
			expect(first.output).toMatch(/✖ failing tests:\n\ntest at test\/\w+\.test\.js:\d+:\d+\n/);
			const testFile = readdirSync(join(root, "test"))[0]!;
			const direct = run(root, [join("test", testFile)]);
			expect(direct.output).not.toMatch(/\d+(?:\.\d+)?ms/);
			expect(direct.output).toMatch(/^✖ /mu);
		},
	);

	it("passing tests print one ✔ line each and the counts", () => {
		const root = workspace("fix-failing-test");
		writeFileSync(
			join(root, "src", "slug.js"),
			'export function slugify(title) {\n\treturn title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n',
		);
		const { status, output } = run(root, ["--test"]);
		expect(status).toBe(0);
		expect(output).toBe(
			[
				"✔ lowercases words and joins them with a dash",
				"✔ collapses a run of other characters into one dash",
				"✔ trims dashes at both ends",
				"ℹ tests 3",
				"ℹ suites 0",
				"ℹ pass 3",
				"ℹ fail 0",
				"ℹ cancelled 0",
				"ℹ skipped 0",
				"ℹ todo 0",
				"",
			].join("\n"),
		);
	});
});

describe("the M6 pattern and the residual-source rule, on E2's recorded tool output (DESIGN §5, §6.10)", () => {
	const nodeTest = (cassette: string) =>
		e2ToolResults(cassette)
			.filter((text) => /ℹ tests \d+/.test(text))
			.at(-1)!;
	const ls = (cassette: string) => e2ToolResults(cassette).find((text) => text.startsWith("total "))!;

	it("M6 finds the default reporter's durations in E2's `node --test` output", () => {
		expect(nodeTest("fix-failing-test--b-c")).toMatch(NODE_REPORTER_DURATION_V0);
		expect(nodeTest("implement-function--a")).toMatch(NODE_REPORTER_DURATION_V0);
		expect("✔ converts numbers to Roman numerals\nℹ tests 2\n").not.toMatch(NODE_REPORTER_DURATION_V0);
	});

	it("two recorded `node --test` outputs that differ only in time are a duration", () => {
		const a = nodeTest("fix-failing-test--a");
		const b = nodeTest("fix-failing-test--b-c");
		expect(a.replace(/\d+\.\d+/g, "#")).toBe(b.replace(/\d+\.\d+/g, "#"));
		const classified = residualSourceV0(a, b);
		expect(classified.source).toBe("duration");
		expect(classified.words[0]).toMatch(/^\d+\.\d+ms$/);
	});

	it("two recorded `ls -la` outputs of the same workspace at different times are a clock time", () => {
		const a = ls("implement-function--b");
		const b = ls("implement-function--b-c");
		expect(a).not.toBe(b);
		expect(residualSourceV0(a, b)).toEqual({ source: "clock time", words: ["Oct  4 11:13", "Oct  4 11:12"] });
	});

	it("E2's quoted examples, and a difference that is neither, classify as stated", () => {
		expect(residualSourceV0("✔ x (0.686967ms)\n", "✔ x (0.706454ms)\n").source).toBe("duration");
		expect(residualSourceV0("ℹ duration_ms 55.854957\n", "ℹ duration_ms 56.286011\n").source).toBe("duration");
		expect(
			residualSourceV0("drwxr-xr-x 2 u u 60 Oct  4 07:57 src\n", "drwxr-xr-x 2 u u 60 Oct  4 08:21 src\n"),
		).toEqual({
			source: "clock time",
			words: ["Oct  4 07:57", "Oct  4 08:21"],
		});
		expect(residualSourceV0("built 2026-10-04\n", "built 2026-10-05\n").source).toBe("clock time");
		expect(residualSourceV0("pid 4121 started\n", "pid 4377 started\n")).toEqual({
			source: "other",
			words: ["4121", "4377"],
		});
	});
});
