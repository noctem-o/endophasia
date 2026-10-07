// The path-sensitivity study's own code (research/path-sensitivity/1.0.1/), checked before its pilot (DESIGN.md §4-§9):
// the spec differs between paths only in its id (so only the scratch-root hash varies); the path normalization, the
// signature, the cell outcome and the reading thresholds are as pre-registered; and the driver and the analysis on a
// fake-Pi experiment, including the rule for a path whose capability study does not admit steering.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEndoExperimentRunRecordFileV0 } from "../cli/experiment-artifacts.ts";
import type { EndoExperimentSpecV0 } from "../protocol/experiment-spec.ts";
import {
	analyzeStudy,
	cellOutcome,
	crossPathRequest,
	normalizePathText,
	readCell,
	responsePattern,
	toolCallSignature,
} from "../research/path-sensitivity/1.0.1/analyze.ts";
import { EXCLUDED_PATHS, pathSpec, sampleLabels, scratchHashOf } from "../research/path-sensitivity/1.0.1/make-spec.ts";
import { parseRunPathsArgs, pathsRecordV0, runPathsV0 } from "../research/path-sensitivity/1.0.1/run-paths.ts";
import { MESSAGES, steeringSpec } from "../research/steering/1.0.1/make-spec.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { type FakePiInstall, installFakePi } from "./fixtures/fake-pi/install.ts";

let base: string;
beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "endo-path-study-"));
});
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("the path-sensitivity spec (DESIGN §4)", () => {
	it("is the steering main spec with only its id and description changed, so only the path hash varies", () => {
		const strip = (spec: EndoExperimentSpecV0) => {
			const { id: _id, description: _description, ...rest } = spec;
			return canonicalEndoJsonV0(rest);
		};
		expect(strip(pathSpec("p01"))).toBe(strip(steeringSpec("main", 2)));
		expect(strip(pathSpec("p01"))).toBe(strip(pathSpec("p17")));
		expect(pathSpec("p01").id).toBe("endo.experiment.path-sensitivity-1.0.1-p01");
		expect(pathSpec("p01").tasks.map((task) => task.id)).toEqual(["tool-use", "implement-function"]);
		expect(pathSpec("p01").trials).toBe(2);
	});

	it("gives every path its own 12-hex scratch hash, none of them an excluded path", () => {
		const hashes = sampleLabels(30).map((label) => scratchHashOf(pathSpec(label)));
		expect(new Set(hashes).size).toBe(30);
		for (const hash of hashes) {
			expect(hash).toMatch(/^[0-9a-f]{12}$/);
			expect(EXCLUDED_PATHS).not.toContain(hash);
		}
		expect(EXCLUDED_PATHS).toEqual(["e5bacd997570", "372c52355fe7"]);
	});

	it("labels the sample p01 to pNN, and refuses a malformed label", () => {
		expect(sampleLabels(3)).toEqual(["p01", "p02", "p03"]);
		expect(() => pathSpec("Bad Label")).toThrow(/path label/);
	});
});

describe("the pre-registered pure rules (DESIGN §6, §7)", () => {
	it("the path normalization replaces the 12 hex digits, in text and in nested values, and nothing else", () => {
		expect(normalizePathText("cd /tmp/endo-experiment-0123456789ab/scratch/work && ls")).toBe(
			"cd /tmp/endo-experiment-<path>/scratch/work && ls",
		);
		expect(normalizePathText("/tmp/endo-experiment-012345 and /tmp/other-0123456789ab")).toBe(
			"/tmp/endo-experiment-012345 and /tmp/other-0123456789ab",
		);
		const request = (hash: string) => ({
			model: "m",
			temperature: 0,
			seed: 1234,
			cache_prompt: false,
			messages: [{ role: "system", content: `<cwd>\n/tmp/endo-experiment-${hash}/scratch/work\n</cwd>` }],
		});
		expect(crossPathRequest(request("aaaaaaaaaaaa"))).toEqual(crossPathRequest(request("bbbbbbbbbbbb")));
		expect(crossPathRequest(request("aaaaaaaaaaaa"))).not.toHaveProperty("temperature");
		expect(crossPathRequest(request("aaaaaaaaaaaa"))).toHaveProperty("model", "m");
	});

	it("the tool-call signature is blind to the path, and sees the tool, the command and their order", () => {
		const call = (name: string, args: object) => ({ function: { name, arguments: JSON.stringify(args) } });
		const requests = (hash: string, command = "ls") => [
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						tool_calls: [call("bash", { command: `${command} /tmp/endo-experiment-${hash}/scratch` })],
					},
					{
						role: "assistant",
						tool_calls: [call("read", { path: `/tmp/endo-experiment-${hash}/scratch/work/a.txt` })],
					},
				],
			},
		];
		expect(toolCallSignature(requests("aaaaaaaaaaaa"))).toBe(toolCallSignature(requests("bbbbbbbbbbbb")));
		expect(toolCallSignature(requests("aaaaaaaaaaaa"))).not.toBe(toolCallSignature(requests("aaaaaaaaaaaa", "cat")));
	});

	it("a cell is followed, ignored or mixed by its trials", () => {
		expect(cellOutcome([true, true])).toBe("followed");
		expect(cellOutcome([false, false])).toBe("ignored");
		expect(cellOutcome([true, false])).toBe("mixed");
	});

	it("reads a cell by its Wilson interval over determinate paths: L >= 0.70, U <= 0.30, otherwise path-dependent", () => {
		expect(readCell({ low: 0.7, high: 1 })).toBe("robustly followed");
		expect(readCell({ low: 0.699, high: 1 })).toBe("path-dependent at this N");
		expect(readCell({ low: 0, high: 0.3 })).toBe("robustly ignored");
		expect(readCell({ low: 0, high: 0.301 })).toBe("path-dependent at this N");
		expect(readCell(null)).toBe("no determinate path");
	});

	it("the response pattern separates ignored, both commands in one turn, separate turns and only the asked-for command", () => {
		const message = MESSAGES["tool-use"]!;
		const bash = (...commands: string[]) => ({
			role: "assistant",
			tool_calls: commands.map((command) => ({
				function: { name: "bash", arguments: JSON.stringify({ command }) },
			})),
		});
		const user = { role: "user", content: message.text };
		const pattern = (...messages: unknown[]) => responsePattern([{ messages: [user, ...messages] }], "tool-use");
		expect(pattern(bash("wc -l notes.txt"))).toBe("ignored");
		expect(pattern(bash("wc -l notes.txt", "cat notes.txt"))).toBe("both-commands-in-one-turn");
		expect(pattern(bash("wc -l notes.txt"), bash("cat notes.txt"))).toBe("commands-in-separate-turns");
		expect(pattern(bash("cat notes.txt"))).toBe("only-the-asked-for-command");
	});
});

describe("the driver's command line", () => {
	it("parses pilot and main, with and without a seed, and refuses anything else", () => {
		expect(parseRunPathsArgs(["pilot", "out"])).toEqual({
			out: "out",
			kind: "pilot",
			labels: ["pilot-1", "pilot-2"],
		});
		expect(parseRunPathsArgs(["main", "3", "out", "--seed", "9"])).toEqual({
			out: "out",
			kind: "main",
			labels: ["p01", "p02", "p03"],
			seed: 9,
		});
		expect(parseRunPathsArgs(["main", "2", "out"])).toMatchObject({ out: "out", labels: ["p01", "p02"] });
		expect(parseRunPathsArgs(["main", "--seed", "9", "2", "out"])).toMatchObject({ seed: 9, labels: ["p01", "p02"] });
		for (const bad of [
			[],
			["main"],
			["main", "0", "out"],
			["main", "x", "out"],
			["pilot"],
			["main", "2", "out", "--seed", "-1"],
		])
			expect(() => parseRunPathsArgs(bad), JSON.stringify(bad)).toThrow(/usage|seed/);
	});
});

describe("the driver and the analysis on a fake-Pi experiment", () => {
	let install: FakePiInstall;
	let dropping: FakePiInstall;
	let upstream: FakeOpenAiServer;
	beforeAll(async () => {
		install = installFakePi("1.0.0");
		install.setScenario("model-endpoint");
		// A Pi that acknowledges a steer and never delivers it: its capability study cannot admit steering.
		dropping = installFakePi("1.0.0");
		dropping.setScenario("model-endpoint,drop-queue");
		upstream = await startFakeOpenAiServer({ chunkMs: 1, slowChunkMs: 40 });
	});
	afterAll(async () => {
		await upstream?.close();
		install?.remove();
		dropping?.remove();
	});

	const message = MESSAGES["tool-use"]!.text;
	const fakeSpec =
		(badLabels: string[] = []) =>
		(label: string): EndoExperimentSpecV0 => ({
			schemaVersion: "endo.experiment-spec.v0",
			id: `endo.experiment.path-sensitivity-test-${label}`,
			description: `path ${label}`,
			trials: 2,
			seed: 3,
			pi: badLabels.includes(label) ? dropping.bin : install.bin,
			upstream: new URL(upstream.baseUrl).origin,
			provider: "fake",
			model: "fake-1",
			digestDomain: "installation",
			timeoutMs: 30_000,
			tasks: [{ id: "tool-use", prompts: ["Count to forty"], workspace: { "notes.txt": "a synthetic file\n" } }],
			conditions: [
				{ id: "base", description: "no intervention" },
				{
					id: "steer",
					description: "steer",
					interventions: { "tool-use": { operation: "steer", message, after: { exchange: 1, chunks: 5 } } },
				},
				{
					id: "queue",
					description: "queue",
					interventions: { "tool-use": { operation: "queue", message, after: { exchange: 1, chunks: 5 } } },
				},
			],
		});

	it("records a seeded, shuffled order before anything runs, and the same record on a resume", () => {
		const out = join(base, "order");
		const options = { out, kind: "main" as const, labels: sampleLabels(8), seed: 42, makeSpec: fakeSpec() };
		const first = pathsRecordV0(options);
		expect(first.order).toHaveLength(8);
		expect([...first.order].sort()).toEqual(sampleLabels(8));
		expect(first.order).not.toEqual(sampleLabels(8));
		expect(existsSync(join(out, "paths.json"))).toBe(true);
		expect(pathsRecordV0({ ...options, seed: 7 })).toEqual(first);
		const other = pathsRecordV0({ ...options, out: join(base, "order-2"), seed: 43 });
		expect(other.order).not.toEqual(first.order);
		expect(Object.keys(first.hashes)).toHaveLength(8);
		expect(new Set(Object.values(first.hashes)).size).toBe(8);
		expect(() => pathsRecordV0({ ...options, labels: sampleLabels(7) })).toThrow(/records other paths/);
	});

	it("runs each path into its own directory; a path whose capability study refuses is rerun once, then missing; the analysis reads the rest", async () => {
		const out = join(base, "study");
		const record = await runPathsV0({
			out,
			kind: "main",
			labels: ["t1", "t2", "bad"],
			seed: 5,
			makeSpec: fakeSpec(["bad"]),
			log: () => {},
		});
		expect(record.missing).toEqual(["bad"]);
		const journal = readFileSync(join(out, "paths-journal.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { event: string; label: string });
		expect(
			journal.filter((entry) => entry.event === "path-capability-refused" && entry.label === "bad"),
		).toHaveLength(2);
		expect(
			journal
				.filter((entry) => entry.event === "path-finished")
				.map((entry) => entry.label)
				.sort(),
		).toEqual(["t1", "t2"]);
		expect(existsSync(join(out, "bad", "trials"))).toBe(false);
		for (const label of ["t1", "t2"]) {
			const experiment = readEndoExperimentRunRecordFileV0(join(out, label));
			expect(experiment.scratchRoot).toContain(`endo-experiment-${record.hashes[label]}`);
		}

		const analysis = analyzeStudy(out, { kind: "installation" }, false);
		expect(analysis.paths).toMatchObject({ analysed: 2, missing: ["bad"] });
		// The fake Pi runs no bash: the message is consumed and not complied with, at every path.
		expect(analysis.primary["tool-use/steer"]).toMatchObject({ paths: 2, followed: 0, ignored: 2, mixed: [] });
		expect(analysis.primary["tool-use/queue"]).toMatchObject({ paths: 2, followed: 0, ignored: 2 });
		expect(analysis.secondary.baselinePathInvariance["tool-use"]!.distinctSignatures).toBe(1);
		expect(analysis.secondary.withinPathDeterminism.cellsNotIdentical).toEqual([]);
		expect(analysis.secondary.delivery).toEqual({ pathsWithViolations: [], violations: 0 });
		// M-path: after the hash is replaced, the first request is byte-identical across the two paths.
		expect(analysis.manipulation.MPath).toEqual({ status: "PASS", distinctFirstRequestsByTask: { "tool-use": 1 } });
		expect(analysis.manipulation.perPathFailures).toEqual([]);
		expect(analysis.secondary.success).toMatchObject({ successes: 0, n: 12 });
	}, 300_000);
});
