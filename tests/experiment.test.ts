// The experiment runner and report (cli/experiment.ts), self-contained: the fake Pi in `model-endpoint` mode streams
// from the fake OpenAI-compatible endpoint through the capture proxy. Covers the spec, the seeded blocked order, the
// statistics, a full run, a partial run resumed, a runner SIGKILLed mid-trial and resumed cleanly, the report, and a
// trial's cassette replaying EXACT. It proves the runner's mechanics, not anything about a real Pi or model.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import {
	experimentRunCommand,
	planEndoExperimentV0,
	reportEndoExperimentV0,
	runEndoExperimentV0,
} from "../cli/experiment.ts";
import { validateEndoExperimentBundleV0 } from "../protocol/evaluation.ts";
import type { EndoExperimentTrialResultAnyV0 } from "../protocol/experiment-artifacts.ts";
import { type EndoExperimentSpecV0, endoExperimentSpecProblemV0 } from "../protocol/experiment-spec.ts";
import { EndoSchemaVersionErrorV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { pairwiseRateWithTrialBootstrapV0, spreadV0, wilson95V0 } from "../runtime/contracts/statistics.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "./fixtures/fake-openai-server.ts";
import { type FakePiInstall, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));

let base: string;
let install: FakePiInstall;
let upstream: FakeOpenAiServer;

beforeAll(async () => {
	base = mkdtempSync(join(tmpdir(), "endo-experiment-test-"));
	install = installFakePi("1.0.0");
	install.setScenario("model-endpoint");
	upstream = await startFakeOpenAiServer({ chunkMs: 1, slowChunkMs: 60 });
});

afterAll(async () => {
	await upstream?.close();
	install?.remove();
	rmSync(base, { recursive: true, force: true });
});

function spec(overrides: Partial<EndoExperimentSpecV0> = {}): EndoExperimentSpecV0 {
	return {
		schemaVersion: "endo.experiment-spec.v0",
		id: "endo.experiment.test-runner",
		description: "runner test",
		trials: 2,
		seed: 7,
		pi: install.bin,
		upstream: new URL(upstream.baseUrl).origin,
		provider: "fake",
		model: "fake-1",
		digestDomain: "installation",
		timeoutMs: 20_000,
		tasks: [
			{
				id: "read",
				prompts: ["Use the read tool, then answer"],
				workspace: { "endophasia-study.txt": "a synthetic file\n" },
				check: {
					argv: [process.execPath, "-e", "process.exit(require('fs').existsSync('endophasia-study.txt') ? 0 : 1)"],
				},
			},
		],
		conditions: [
			{ id: "a", description: "Pi's defaults" },
			{ id: "b", description: "a documented model-entry field", modelEntry: { reasoning: false } },
		],
		...overrides,
	};
}

const results = (dir: string): EndoExperimentTrialResultAnyV0[] =>
	readdirSync(join(dir, "trials"), { recursive: true })
		.map(String)
		.filter((path) => path.endsWith("result.json"))
		.map((path) => JSON.parse(readFileSync(join(dir, "trials", path), "utf8")));

describe("the experiment spec and the trial order", () => {
	it("rejects malformed specs with the reason", () => {
		expect(endoExperimentSpecProblemV0(spec())).toBeNull();
		expect(endoExperimentSpecProblemV0({ ...spec(), id: "x" })).toMatch(/endo\.experiment/);
		expect(endoExperimentSpecProblemV0({ ...spec(), trials: 0 })).toMatch(/trials/);
		expect(endoExperimentSpecProblemV0({ ...spec(), extra: 1 })).toMatch(/unknown field extra/);
		expect(
			endoExperimentSpecProblemV0(
				spec({ conditions: [{ id: "a", description: "x", modelEntry: { id: "other" } }] }),
			),
		).toMatch(/may not change the model id/);
		expect(
			endoExperimentSpecProblemV0(spec({ tasks: [{ id: "t", prompts: ["p"], workspace: { "../escape": "x" } }] })),
		).toMatch(/bad workspace entry/);
		const pinned = (environment: unknown) =>
			endoExperimentSpecProblemV0({ ...spec(), conditions: [{ id: "a", description: "x", environment }] });
		expect(
			pinned({
				variables: { TZ: "UTC", NODE_OPTIONS: "--x={root}/env/r.mjs" },
				files: { "r.mjs": "" },
				fileTime: "2026-01-01T00:00:00Z",
			}),
		).toBeNull();
		expect(pinned({ variables: { HOME: "/elsewhere" } })).toMatch(
			/HOME is not one of TZ, LC_ALL, LANG, NODE_OPTIONS/,
		);
		expect(pinned({ variables: { TZ: 0 } })).toMatch(/variables must map names to strings/);
		expect(pinned({ files: { "../escape": "x" } })).toMatch(/is not a relative path/);
		expect(pinned({ fileTime: "2026-01-01 00:00" })).toMatch(/fileTime must be an ISO-8601 UTC time/);
		expect(pinned({ fileTime: "2026-01-01T00:00:00+01:00" })).toMatch(/fileTime must be an ISO-8601 UTC time/);
		expect(pinned({ clock: "frozen" })).toMatch(/environment: unknown field clock/);
		const intervene = (interventions: unknown) =>
			endoExperimentSpecProblemV0({ ...spec(), conditions: [{ id: "a", description: "x", interventions }] });
		const after = { exchange: 1, chunks: 3 };
		expect(intervene({ read: { operation: "steer", message: "go on", after } })).toBeNull();
		expect(intervene({ read: { operation: "stop", after } })).toBeNull();
		expect(intervene({ nope: { operation: "steer", message: "x", after } })).toMatch(/unknown task nope/);
		expect(intervene({ read: { operation: "steer", after } })).toMatch(/steer needs a message/);
		expect(intervene({ read: { operation: "stop", message: "x", after } })).toMatch(/a stop carries no message/);
		expect(intervene({ read: { operation: "reboot", message: "x", after } })).toMatch(
			/operation must be steer, queue or stop/,
		);
		expect(intervene({ read: { operation: "steer", message: "x", after: { exchange: 0, chunks: 1 } } })).toMatch(
			/both integers from 1/,
		);
	});

	it("a seeded plan reproduces exactly; another seed differs; every block runs every cell once", () => {
		const s = spec({ trials: 6, conditions: ["a", "b", "c"].map((id) => ({ id, description: id })) });
		expect(planEndoExperimentV0(s, 42)).toEqual(planEndoExperimentV0(s, 42));
		expect(planEndoExperimentV0(s, 42)).not.toEqual(planEndoExperimentV0(s, 43));
		const plan = planEndoExperimentV0(s, 42);
		for (let trial = 0; trial < 6; trial += 1) {
			const block = plan.filter((entry) => entry.trial === trial);
			expect(block.map((entry) => entry.condition).sort()).toEqual(["a", "b", "c"]);
			expect(block.map((entry) => entry.position)).toEqual([0, 1, 2].map((offset) => trial * 3 + offset));
		}
		// Not always the same within-block order (interleaved, not fixed rotation).
		expect(
			new Set(
				Array.from({ length: 6 }, (_, trial) =>
					plan
						.filter((e) => e.trial === trial)
						.map((e) => e.condition)
						.join(),
				),
			).size,
		).toBeGreaterThan(1);
	});

	it("Wilson intervals and type-7 quartiles match known values", () => {
		expect(wilson95V0(5, 10)).toEqual({
			successes: 5,
			n: 10,
			rate: 0.5,
			wilson95: { low: 0.236593, high: 0.763407 },
		});
		expect(wilson95V0(10, 10).wilson95).toEqual({ low: 0.722467, high: 1 });
		expect(wilson95V0(0, 10).wilson95).toEqual({ low: 0, high: 0.277533 });
		expect(wilson95V0(0, 0)).toEqual({ successes: 0, n: 0, rate: null, wilson95: null });
		expect(spreadV0([1, 2, 3, 4])).toEqual({ n: 4, median: 2.5, q1: 1.75, q3: 3.25, iqr: 1.5, min: 1, max: 4 });
		expect(spreadV0([])).toBeNull();
	});

	it("the pairwise rate's bootstrap resamples trials: deterministic per seed, wider than a Wilson interval over pairs", () => {
		// 8 trials: 4 identical, 4 all different -> 6 exact pairs of 28.
		const same = (i: number, j: number) => i < 4 && j < 4;
		const a = pairwiseRateWithTrialBootstrapV0(8, same, { seed: 1, resamples: 2000 });
		expect(a).toMatchObject({ exactPairs: 6, judgedPairs: 28, rate: 0.214286 });
		expect(pairwiseRateWithTrialBootstrapV0(8, same, { seed: 1, resamples: 2000 })).toEqual(a);
		const overPairs = wilson95V0(6, 28).wilson95!;
		expect(a.bootstrap95!.high - a.bootstrap95!.low).toBeGreaterThan(overPairs.high - overPairs.low);
		// An unjudgeable pair is left out; no judged pair gives no rate.
		expect(pairwiseRateWithTrialBootstrapV0(3, () => null, { seed: 1 })).toEqual({
			exactPairs: 0,
			judgedPairs: 0,
			rate: null,
			bootstrap95: null,
		});
	});
});

describe("endo experiment run / report (fake Pi, fake upstream)", () => {
	it("fixture-experiment mode is explicit both ways: a fixture spec needs it, a normal spec refuses it", async () => {
		const dir = join(base, "modes");
		await expect(
			runEndoExperimentV0({ spec: spec({ digestDomain: "fixture" }), dir, log: () => {}, scratchParent: base }),
		).rejects.toThrow(/outside fixture-experiment mode/);
		await expect(
			runEndoExperimentV0({ spec: spec(), dir, fixtureExperiment: true, log: () => {}, scratchParent: base }),
		).rejects.toThrow(/refusing fixture-experiment mode for a spec in the installation domain/);
		expect(existsSync(join(dir, "experiment.json"))).toBe(false);
	});

	it("a condition's extension is installed and recorded; a declared injection the requests lack fails M1 and invalidates the arm", async () => {
		const dir = join(base, "extensions");
		const extension =
			'export default function (pi: any) {\n\tpi.on("before_provider_request", (event: any) => ({ ...event.payload, temperature: 0 }));\n}\n';
		const s = spec({
			id: "endo.experiment.test-extensions",
			trials: 1,
			conditions: [
				{ id: "a", description: "no-op", extensions: { "noop.ts": "export default function () {}\n" } },
				{ id: "b", description: "temperature 0", extensions: { "sampling.ts": extension } },
			],
			manipulation: { baseline: "a", conditions: { a: { injected: {} }, b: { injected: { temperature: 0 } } } },
		});
		await runEndoExperimentV0({ spec: s, dir, log: () => {}, scratchParent: base });
		const { report } = reportEndoExperimentV0(dir);
		const r = report as {
			manipulation: {
				M1: { status: string; failures: string[] };
				M2a: { status: string };
				validity: Record<string, string>;
			};
			cells: {
				condition: string;
				servingInputs: { extensions: Record<string, { sha256: string; source: string }> };
			}[];
		};
		// The fake Pi does not run extensions: the declared injection never reaches a request, and the check says so.
		expect(r.manipulation.M1.status).toBe("FAIL");
		expect(r.manipulation.M1.failures[0]).toMatch(/read\/b\/#0 request 1: temperature is null, expected 0/);
		expect(r.manipulation.M2a.status).toBe("PASS");
		expect(r.manipulation.validity).toEqual({ a: "valid", b: "invalid" });
		const b = r.cells.find((cell) => cell.condition === "b")!;
		expect(b.servingInputs.extensions["sampling.ts"]!.source).toBe(extension);
		expect(b.servingInputs.extensions["sampling.ts"]!.sha256).toMatch(/^[0-9a-f]{64}$/);
	}, 120_000);

	it("a condition's pinned environment is applied to its trials only, recorded in each trial's capture, and reported", async () => {
		const dir = join(base, "environment");
		const environment = {
			variables: { TZ: "UTC", LC_ALL: "C", NODE_OPTIONS: "--test-reporter={root}/env/reporter.mjs" },
			files: { "reporter.mjs": "export default async function* reporter() {}\n" },
			fileTime: "2026-01-01T00:00:00Z",
		};
		const s = spec({
			id: "endo.experiment.test-environment",
			trials: 1,
			conditions: [
				{ id: "u", description: "unpinned" },
				{ id: "p", description: "pinned", environment },
			],
		});
		await runEndoExperimentV0({ spec: s, dir, log: () => {}, scratchParent: base });
		const byCondition = Object.fromEntries(results(dir).map((result) => [result.condition, result]));
		expect(byCondition.p!.status).toBe("completed");
		expect(byCondition.p!.check).toMatchObject({ ran: true, passed: true });
		const recordedEnvironment = (condition: string) =>
			readEndoCaptureEventsV0(join(dir, byCondition[condition]!.store)).find(
				(event) => event.kind === "capture.environment",
			)?.payload as { variables: Record<string, string>; fileTime: string } | undefined;
		expect(recordedEnvironment("u")).toBeUndefined();
		const pinnedRecord = recordedEnvironment("p")!;
		expect(pinnedRecord.fileTime).toBe(environment.fileTime);
		expect(pinnedRecord.variables.NODE_OPTIONS).toMatch(/^--test-reporter=\/.*\/scratch\/env\/reporter\.mjs$/);
		const { report } = reportEndoExperimentV0(dir);
		const cells = (report as { cells: { condition: string; servingInputs: Record<string, unknown> }[] }).cells;
		expect(cells.find((cell) => cell.condition === "u")!.servingInputs).not.toHaveProperty("environment");
		expect(cells.find((cell) => cell.condition === "p")!.servingInputs.environment).toMatchObject({
			variables: environment.variables,
			fileTime: environment.fileTime,
			files: {
				"reporter.mjs": {
					bytes: environment.files["reporter.mjs"].length,
					content: environment.files["reporter.mjs"],
				},
			},
		});
	}, 120_000);

	it("a condition's intervention: one capability study per session, steered trials carry the full chain, baseline none", async () => {
		const dir = join(base, "interventions");
		const message = "Endophasia steer: also say hello";
		const s = spec({
			id: "endo.experiment.test-interventions",
			trials: 2,
			tasks: [
				{ id: "count", prompts: ["Count to forty"], workspace: { "endophasia-study.txt": "a synthetic file\n" } },
			],
			conditions: [
				{ id: "base", description: "no intervention" },
				{
					id: "steer",
					description: "a STEER during the first response",
					interventions: { count: { operation: "steer", message, after: { exchange: 1, chunks: 5 } } },
				},
			],
		});
		await runEndoExperimentV0({ spec: s, dir, log: () => {}, scratchParent: base });
		const journal = readFileSync(join(dir, "journal.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const studies = journal.filter((entry) => entry.event === "capability-study");
		expect(studies).toHaveLength(1);
		expect(studies[0]).toMatchObject({ conditions: ["steer"], summary: [{ capability: "steering.steer" }] });
		expect(existsSync(join(dir, "evidence", "session-1", "1", "capability-summary.json"))).toBe(true);
		const byCondition = (condition: string) => results(dir).filter((result) => result.condition === condition);
		expect(byCondition("steer").map((result) => result.status)).toEqual(["completed", "completed"]);
		const kinds = (result: EndoExperimentTrialResultAnyV0) => {
			const store = createEndoDurableEventStoreV0(join(dir, result.store), { readOnly: true });
			const out = store.page({ limit: 10_000 }).events.map((event) => event.kind);
			store.close();
			return out.filter((kind) => kind.startsWith("intervention."));
		};
		for (const result of byCondition("steer"))
			expect(kinds(result)).toEqual([
				"intervention.proposal",
				"intervention.authorization",
				"intervention.request",
				"intervention.accepted",
				"intervention.consumed",
				"intervention.consequence",
			]);
		for (const result of byCondition("base")) expect(kinds(result)).toEqual([]);
		const { report } = reportEndoExperimentV0(dir);
		const cells = (report as { cells: { condition: string; servingInputs: Record<string, unknown> }[] }).cells;
		expect(cells.find((cell) => cell.condition === "base")!.servingInputs).not.toHaveProperty("intervention");
		expect(cells.find((cell) => cell.condition === "steer")!.servingInputs.intervention).toEqual({
			operation: "steer",
			message,
			after: { exchange: 1, chunks: 5 },
		});
	}, 180_000);

	it("a condition whose capability the study does not admit stops the run before any trial", async () => {
		const other = installFakePi("1.0.0");
		other.setScenario("model-endpoint,drop-queue");
		try {
			const dir = join(base, "interventions-refused");
			const scratchBefore = readdirSync(base).filter((name) => name.startsWith("endo-experiment-"));
			const s = spec({
				id: "endo.experiment.test-interventions-refused",
				trials: 1,
				pi: other.bin,
				tasks: [{ id: "count", prompts: ["Count to forty"], workspace: {} }],
				conditions: [
					{
						id: "steer",
						description: "a STEER",
						interventions: { count: { operation: "steer", message: "x", after: { exchange: 1, chunks: 5 } } },
					},
				],
			});
			// This Pi acknowledges a steer and never delivers it: the study classifies that a mismatch, and the run stops.
			await expect(runEndoExperimentV0({ spec: s, dir, log: () => {}, scratchParent: base })).rejects.toThrow(
				/the live study did not admit steering\.steer \(mismatch/,
			);
			expect(existsSync(join(dir, "trials"))).toBe(false);
			expect(readdirSync(base).filter((name) => name.startsWith("endo-experiment-"))).toEqual(scratchBefore);
		} finally {
			other.remove();
		}
	}, 180_000);

	it("never deletes from a scratch parent it did not create: an unmarked, non-empty one stops the resume", async () => {
		const dir = join(base, "unmarked");
		await runEndoExperimentV0({ spec: spec(), dir, maxTrials: 1, log: () => {}, scratchParent: base });
		const record = JSON.parse(readFileSync(join(dir, "experiment.json"), "utf8"));
		const parent = join(base, `endo-experiment-${record.specSha256.slice(0, 12)}`);
		mkdirSync(join(parent, "scratch"), { recursive: true });
		writeFileSync(join(parent, "scratch", "precious.txt"), "keep\n");
		rmSync(join(parent, ".endo-experiment"), { force: true });
		await expect(runEndoExperimentV0({ spec: spec(), dir, log: () => {}, scratchParent: base })).rejects.toThrow(
			/not marked/,
		);
		expect(readFileSync(join(parent, "scratch", "precious.txt"), "utf8")).toBe("keep\n");
		rmSync(parent, { recursive: true, force: true });
	}, 180_000);

	it("runs part of a plan, resumes the rest without duplicating a trial, and refuses a changed spec", async () => {
		const dir = join(base, "partial");
		const first = await runEndoExperimentV0({ spec: spec(), dir, maxTrials: 3, log: () => {}, scratchParent: base });
		expect(first).toMatchObject({ planned: 4, ranThisSession: 3, completed: 3, remaining: 1 });
		const second = await runEndoExperimentV0({ spec: spec(), dir, log: () => {}, scratchParent: base });
		expect(second).toMatchObject({
			planned: 4,
			ranThisSession: 1,
			completed: 4,
			remaining: 0,
			movedToInterrupted: 0,
		});
		const all = results(dir);
		expect(all.length).toBe(4);
		expect(new Set(all.map((r) => `${r.task}/${r.condition}/${r.trial}`)).size).toBe(4);
		expect(all.every((r) => r.status === "completed" && r.check.ran && r.check.passed)).toBe(true);
		await expect(
			runEndoExperimentV0({ spec: spec({ description: "changed" }), dir, log: () => {}, scratchParent: base }),
		).rejects.toThrow(/another spec/);
		// Every trial is a cassette: one replays EXACT against itself.
		const one = all[0]!;
		const replay = await replayPiCassetteSessionV0({
			store: join(dir, one.store),
			out: join(base, "replay-of-trial"),
			pi: install.bin,
			timing: "immediate",
			keySource: { kind: "installation" },
			timeoutMs: 20_000,
		});
		expect(replay.misses).toBe(0);
		for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
			expect(replay.comparison.layers[layer].status).toBe("EXACT");
		// The scratch parent is removed once the plan is complete.
		expect(readdirSync(base).filter((name) => name.startsWith("endo-experiment-"))).toEqual([]);
	}, 120_000);

	it("a runner SIGKILLed mid-trial resumes cleanly: the unfinished trial is moved aside and rerun, nothing duplicated", async () => {
		const dir = join(base, "killed");
		const slow = spec({
			id: "endo.experiment.test-killed",
			trials: 2,
			tasks: [{ id: "slow", prompts: ["Count to forty"], workspace: {} }],
			conditions: [{ id: "a", description: "defaults" }],
		});
		const specFile = join(base, "killed-spec.json");
		writeFileSync(specFile, JSON.stringify(slow));
		const child = spawn(process.execPath, [CLI, "experiment", "run", specFile, "--out", dir], {
			stdio: "ignore",
			env: process.env,
		});
		const journalPath = join(dir, "journal.jsonl");
		const deadline = Date.now() + 30_000;
		// Kill once the second trial has started (the first finished): mid-trial, after real progress.
		while (Date.now() < deadline) {
			const lines = existsSync(journalPath) ? readFileSync(journalPath, "utf8").trim().split("\n") : [];
			if (lines.filter((line) => line.includes('"trial-started"')).length >= 2) break;
			await new Promise((done) => setTimeout(done, 20));
		}
		await new Promise((done) => setTimeout(done, 300));
		child.kill("SIGKILL");
		await new Promise((done) => child.on("exit", done));
		expect(results(dir).length).toBe(1);
		// The killed session left its scratch root behind; the resume removes it (it is marked as this run's).
		const summary = await runEndoExperimentV0({ spec: slow, dir, log: () => {}, scratchParent: tmpdir() });
		expect(summary).toMatchObject({
			planned: 2,
			completed: 2,
			remaining: 0,
			movedToInterrupted: 1,
			ranThisSession: 1,
		});
		expect(readdirSync(join(dir, "interrupted")).length).toBe(1);
		expect(results(dir).length).toBe(2);
		const journal = readFileSync(journalPath, "utf8");
		expect(journal).toContain('"trial-interrupted"');
		const report = reportEndoExperimentV0(dir).report as {
			trials: { completed: number; interruptedAndRerun: number };
		};
		expect(report.trials).toMatchObject({ completed: 2, interruptedAndRerun: 1 });
	}, 120_000);

	it("reports per cell: judged-layer agreement with Wilson intervals, divergence, check pass rate, usage and timing spreads, bundles", async () => {
		const dir = join(base, "partial");
		const { report, summary } = reportEndoExperimentV0(dir);
		const r = report as {
			schemaVersion: string;
			seed: number;
			trials: { completed: number };
			cells: {
				task: string;
				condition: string;
				layers: Record<
					string,
					{
						pairs: number;
						counts: Record<string, number>;
						pairwiseExact: { rate: number; bootstrap95: { resamples: number } };
						modalAgreement: { n: number; successes: number };
						distinctTrajectories: number;
					}
				>;
				check: { successes: number; n: number };
				usage: Record<string, unknown>;
				timing: { clock: string; wallMs: { n: number } };
				servingInputs: { requestParametersSeen: unknown[]; samplingParametersSent: unknown };
				bundle: unknown;
			}[];
			environment: { models: { status: string }; serverDefaults: { status: string } }[];
		};
		expect(r.schemaVersion).toBe("endo.experiment-report.v2");
		for (const cell of r.cells as unknown as { toolCallsUpToFirstDivergentInput: Record<string, number> }[])
			expect(cell.toolCallsUpToFirstDivergentInput).toEqual({ identical: 1, notIdentical: 0, undecidable: 0 });
		expect(r.seed).toBe(7);
		expect(r.cells.map((cell) => `${cell.task}/${cell.condition}`)).toEqual(["read/a", "read/b"]);
		for (const cell of r.cells) {
			expect(cell.layers.toolCalls!.pairs).toBe(1);
			expect(cell.layers.toolCalls!.counts.EXACT).toBe(1);
			expect(cell.layers.lifecycle!.pairwiseExact.rate).toBe(1);
			expect(cell.layers.outcome!.modalAgreement).toMatchObject({ n: 2, successes: 2 });
			expect(cell.layers.toolCalls!.distinctTrajectories).toBe(1);
			expect(cell.layers.toolCalls!.pairwiseExact.bootstrap95.resamples).toBe(10_000);
			expect(
				(cell.bundle as { result: { profile: { schemaVersion: string; cognitionPolicy: string } } }).result.profile,
			).toMatchObject({
				schemaVersion: "endo.evaluation-profile.v1",
				cognitionPolicy: "none",
			});
			expect(cell.check).toMatchObject({ successes: 2, n: 2 });
			expect(cell.timing).toMatchObject({ clock: "observer", wallMs: { n: 2 } });
			expect(cell.servingInputs.requestParametersSeen.length).toBeGreaterThan(0);
			expect(validateEndoExperimentBundleV0(cell.bundle)).not.toBeNull();
		}
		expect(r.environment[0]!.serverDefaults.status).toBe("UNAVAILABLE");
		expect(summary).toContain("| read | a | 2/2 |");
		// The effective harness surface: the trials of a cell share one model-facing surface, and the report says so.
		for (const cell of r.cells as unknown as { harnessSurface: Record<string, unknown> }[])
			expect(cell.harnessSurface).toMatchObject({
				status: "reported",
				trials: { withSurface: 2, predatingSurface: 0 },
				comparable: true,
				distinctSurfaces: 1,
				matched: true,
				trialsDifferingFromModalSet: [],
				contributions: { invocationMode: { values: ["pi --mode rpc"] } },
			});
		expect(summary).toContain("- read / a: 1 distinct, matched across trials");
		// Deterministic: the same directory reports the same bytes.
		expect(JSON.stringify(reportEndoExperimentV0(dir).report)).toBe(JSON.stringify(report));
	}, 60_000);
});

describe("the harness surface in a run's trials and report", () => {
	it("trials carry the surface as observed on the wire and no prompt text; a within-cell difference is reported as evidence", () => {
		const dir = join(base, "partial");
		const trialFiles = readdirSync(join(dir, "trials"), { recursive: true })
			.map(String)
			.filter((path) => path.endsWith("result.json"));
		expect(trialFiles.length).toBeGreaterThan(1);
		for (const file of trialFiles) {
			const text = readFileSync(join(dir, "trials", file), "utf8");
			const trial = JSON.parse(text) as EndoExperimentTrialResultAnyV0;
			expect(trial.schemaVersion).toBe("endo.experiment-trial.v1");
			expect(trial).not.toHaveProperty("requestParameters");
			// The fake Pi writes "fake pi" and its working directory into the system message, and the task into the user's:
			// none of that text is in the canonical record (the working directory appears only as the runner's own field).
			expect(text).not.toContain("fake pi");
			expect(text).not.toContain("Use the read tool");
			if (trial.schemaVersion !== "endo.experiment-trial.v1") throw new Error("unreachable");
			expect(trial.harness.surfaces.length).toBeGreaterThan(0);
			// The per-trial capture log declares its version, so the record names it.
			expect(trial.harness.surfaces[0]!.source.captureVersion).toBe("endo-capture.2");
			expect(trial.harness.requests.length).toBe(trial.exchanges);
			const c = trial.harness.surfaces[0]!.components;
			expect(c.status === "reported" && c.value.instructions.items[0]?.role).toBe("system");
			expect(trial.harness.contributions.workingDirectory).toMatchObject({ status: "reported", source: "runner" });
		}
		// Make one trial of cell read/a show another tool order, as if the harness had changed between trials.
		const copy = join(base, "surface-mismatch");
		rmSync(copy, { recursive: true, force: true });
		cpSync(dir, copy, { recursive: true });
		const target = join(copy, "trials", "read", "a", "1", "result.json");
		const trial = JSON.parse(readFileSync(target, "utf8"));
		for (const surface of trial.harness.surfaces) {
			surface.components.value.tools.orderedDigest = "f".repeat(64);
			surface.components.value.identity = "e".repeat(64);
		}
		writeFileSync(target, `${JSON.stringify(trial, null, "\t")}\n`);
		const { report, summary } = reportEndoExperimentV0(copy);
		const cell = (
			report as { cells: { task: string; condition: string; harnessSurface: Record<string, unknown> }[] }
		).cells.find((candidate) => candidate.condition === "a")!;
		expect(cell.harnessSurface).toMatchObject({
			matched: false,
			distinctSurfaces: 2,
			trialsDifferingFromModalSet: expect.any(Array),
			differences: [{ differs: expect.arrayContaining(["tool-order"]) }],
		});
		expect(summary).toMatch(
			/- read \/ a: MISMATCH: 2 distinct surfaces; trial #\d differ from the modal set \(tool-order\)/,
		);
		// The other cell is untouched, and nothing is called invalid because of it.
		const other = (report as { cells: { condition: string; harnessSurface: { matched: boolean } }[] }).cells.find(
			(candidate) => candidate.condition === "b",
		)!;
		expect(other.harnessSurface.matched).toBe(true);
	}, 60_000);
});

describe("the run directory's source-of-truth files are read through their version readers", () => {
	let complete: string;
	const file = (name: string) => join(complete, name);
	const readText = (path: string) => readFileSync(path, "utf8");
	const resume = () => runEndoExperimentV0({ spec: spec(), dir: complete, log: () => {}, scratchParent: base });
	const report = () => reportEndoExperimentV0(complete);
	const firstResult = () =>
		join(
			complete,
			readdirSync(join(complete, "trials"), { recursive: true })
				.map(String)
				.find((p) => p.endsWith("result.json"))!
				.replace(/^/, "trials/"),
		);
	const cleanScratch = () => {
		for (const name of readdirSync(base).filter((entry) => entry.startsWith("endo-experiment-")))
			rmSync(join(base, name), { recursive: true, force: true });
	};
	/** The kind a refusal carries; anything that is not a version-reader refusal says what it was instead. */
	const refusal = async (action: () => unknown): Promise<string> => {
		try {
			await action();
			return "no error";
		} catch (error) {
			return error instanceof EndoSchemaVersionErrorV0 ? error.kind : `untyped: ${String(error)}`;
		}
	};

	it("a new run writes the current versions; partial, resume and report all go through the strict readers", async () => {
		complete = join(base, "governed");
		const first = await runEndoExperimentV0({
			spec: spec(),
			dir: complete,
			maxTrials: 2,
			log: () => {},
			scratchParent: base,
		});
		expect(first).toMatchObject({ planned: 4, completed: 2, remaining: 2 });
		const run = JSON.parse(readText(file("experiment.json")));
		const plan = JSON.parse(readText(file("plan.json")));
		expect(run.schemaVersion).toBe("endo.experiment-run.v0");
		expect(run.spec.schemaVersion).toBe("endo.experiment-spec.v0");
		expect(run.experiment.schemaVersion).toBe("endo.experiment.v0");
		expect(plan.schemaVersion).toBe("endo.experiment-plan.v0");
		expect(Object.keys(plan).sort()).toEqual(["order", "ordering", "schemaVersion", "seed"]);
		expect(plan.order).toEqual(planEndoExperimentV0(spec(), 7));
		const planBytes = readText(file("plan.json"));
		const second = await resume();
		expect(second).toMatchObject({ completed: 4, remaining: 0, ranThisSession: 2 });
		expect(readText(file("plan.json"))).toBe(planBytes);
		expect(results(complete).every((result) => result.schemaVersion === "endo.experiment-trial.v1")).toBe(true);
		expect(report().report).toMatchObject({ schemaVersion: "endo.experiment-report.v2" });
	}, 180_000);

	it("a run directory whose plan.json predates the version is read as that exact legacy form, and never rewritten", async () => {
		const legacy = join(base, "legacy");
		cpSync(complete, legacy, { recursive: true });
		const current = JSON.parse(readText(file("plan.json")));
		const { schemaVersion: _version, ...body } = current;
		writeFileSync(join(legacy, "plan.json"), canonicalEndoJsonV0(body));
		const before = readText(join(legacy, "plan.json"));
		expect(JSON.parse(before).schemaVersion).toBeUndefined();
		expect(JSON.stringify(reportEndoExperimentV0(legacy).report)).toBe(JSON.stringify(report().report));
		const resumed = await runEndoExperimentV0({ spec: spec(), dir: legacy, log: () => {}, scratchParent: base });
		expect(resumed).toMatchObject({ planned: 4, completed: 4, remaining: 0 });
		expect(readText(join(legacy, "plan.json"))).toBe(before);
		cleanScratch();
		// The legacy form is exact: one more root key, and the report refuses the directory.
		writeFileSync(join(legacy, "plan.json"), canonicalEndoJsonV0({ ...body, extra: 1 }));
		expect(await refusal(() => reportEndoExperimentV0(legacy))).toBe("invalid");
	}, 120_000);

	const CASES: [string, () => string, (value: any) => void, string][] = [
		[
			"experiment.json: an unknown root field",
			() => file("experiment.json"),
			(v) => {
				v.futureField = 1;
			},
			"invalid",
		],
		[
			"experiment.json: an unknown version",
			() => file("experiment.json"),
			(v) => {
				v.schemaVersion = "endo.experiment-run.v9";
			},
			"unsupported-version",
		],
		[
			"experiment.json: no version",
			() => file("experiment.json"),
			(v) => {
				delete v.schemaVersion;
			},
			"missing-version",
		],
		[
			"experiment.json: a future spec version inside a v0 run",
			() => file("experiment.json"),
			(v) => {
				v.spec.schemaVersion = "endo.experiment-spec.v1";
			},
			"invalid",
		],
		[
			"experiment.json: an unknown field deep in the embedded spec",
			() => file("experiment.json"),
			(v) => {
				v.spec.tasks[0].futureField = 1;
			},
			"invalid",
		],
		[
			"plan.json: a future version",
			() => file("plan.json"),
			(v) => {
				v.schemaVersion = "endo.experiment-plan.v1";
			},
			"unsupported-version",
		],
		[
			"plan.json: a bad entry",
			() => file("plan.json"),
			(v) => {
				v.order[1].position = 9;
			},
			"invalid",
		],
		[
			"plan.json: a task that names a path",
			() => file("plan.json"),
			(v) => {
				v.order[0].task = "../escape";
			},
			"invalid",
		],
		[
			"plan.json: an unknown root field",
			() => file("plan.json"),
			(v) => {
				v.futureField = 1;
			},
			"invalid",
		],
		[
			"experiment.json: a spec that is not the one its digest names",
			() => file("experiment.json"),
			(v) => {
				v.spec.description = "another experiment";
			},
			"invalid",
		],
		[
			"experiment.json: an experiment record that names another model",
			() => file("experiment.json"),
			(v) => {
				v.experiment.model = "fake/another-model";
			},
			"invalid",
		],
		[
			"experiment.json: an experiment record with another budget",
			() => file("experiment.json"),
			(v) => {
				v.experiment.budget.trialsPerCell += 1;
			},
			"invalid",
		],
		[
			"plan.json: a seed that is not the run's",
			() => file("plan.json"),
			(v) => {
				v.seed += 1;
			},
			"invalid",
		],
		[
			"plan.json: an ordering that is not the run's",
			() => file("plan.json"),
			(v) => {
				v.ordering = "another ordering";
			},
			"invalid",
		],
		[
			"plan.json: a trial of a task the spec does not have",
			() => file("plan.json"),
			(v) => {
				v.order[0].task = "ghost";
			},
			"invalid",
		],
		[
			"plan.json: a spec trial it leaves out",
			() => file("plan.json"),
			(v) => {
				v.order.pop();
			},
			"invalid",
		],
		[
			"result.json: another trial's coordinates",
			firstResult,
			(v) => {
				v.position = 99;
			},
			"invalid",
		],
		[
			"result.json: another trial's store",
			firstResult,
			(v) => {
				v.store = "trials/read/a/9/store";
			},
			"invalid",
		],
		[
			"result.json: a check verdict its exit code contradicts",
			firstResult,
			(v) => {
				v.check.passed = !v.check.passed;
			},
			"invalid",
		],
		[
			"result.json: a check record that disagrees with whether the task defines a check",
			firstResult,
			(v) => {
				v.check = { ran: false, reason: "the task has no success check" };
			},
			"invalid",
		],
		[
			"result.json: a completed trial without a session",
			firstResult,
			(v) => {
				v.session = null;
			},
			"invalid",
		],
		[
			"experiment.json: a scratch root that is not the runner's for this spec",
			() => file("experiment.json"),
			(v) => {
				v.scratchRoot = join(base, "somewhere-else");
			},
			"invalid",
		],
		[
			"result.json: an unknown field",
			firstResult,
			(v) => {
				v.futureField = 1;
			},
			"invalid",
		],
		[
			"result.json: an unknown version",
			firstResult,
			(v) => {
				v.schemaVersion = "endo.experiment-trial.v9";
			},
			"unsupported-version",
		],
		[
			"result.json: a store outside the run directory",
			firstResult,
			(v) => {
				v.store = "../../outside";
			},
			"invalid",
		],
	];

	it.each(CASES)(
		"refuses %s, at the report and at the resume",
		async (_label, path, change, kind) => {
			const target = path();
			const original = readText(target);
			try {
				const value = JSON.parse(original);
				change(value);
				writeFileSync(target, `${JSON.stringify(value, null, "\t")}\n`);
				expect(await refusal(report), "report").toBe(kind);
				expect(await refusal(resume), "resume").toBe(kind);
			} finally {
				writeFileSync(target, original);
				cleanScratch();
			}
			// Restored, the directory is whole again.
			expect(report().report).toMatchObject({ schemaVersion: "endo.experiment-report.v2" });
		},
		60_000,
	);

	it("refuses a saved result it cannot read before it runs any remaining trial", async () => {
		const partial = join(base, "preflight");
		cpSync(complete, partial, { recursive: true });
		const results = readdirSync(join(partial, "trials"), { recursive: true })
			.map(String)
			.filter((path) => path.endsWith("result.json"))
			.sort();
		const [missing, corrupt] = [join(partial, "trials", results[0]!), join(partial, "trials", results[1]!)];
		rmSync(missing);
		writeFileSync(corrupt, JSON.stringify({ ...JSON.parse(readText(corrupt)), futureField: 1 }));
		const journal = readText(join(partial, "journal.jsonl"));
		const sessions = readdirSync(join(partial, "environment")).length;
		expect(
			await refusal(() => runEndoExperimentV0({ spec: spec(), dir: partial, log: () => {}, scratchParent: base })),
		).toBe("invalid");
		// Nothing ran: no trial, no new run session, no journal line.
		expect(existsSync(missing)).toBe(false);
		expect(readText(join(partial, "journal.jsonl"))).toBe(journal);
		expect(readdirSync(join(partial, "environment")).length).toBe(sessions);
		cleanScratch();
	}, 60_000);

	it("refuses a spec that declares another version or an unknown field, before it creates anything", async () => {
		const specFile = join(base, "spec-file.json");
		const out = join(base, "never-created");
		const refuseFile = async (value: unknown) => {
			writeFileSync(specFile, JSON.stringify(value));
			return refusal(() => experimentRunCommand([specFile, "--out", out]));
		};
		expect(await refuseFile({ ...spec(), schemaVersion: "endo.experiment-spec.v1" })).toBe("unsupported-version");
		expect(await refuseFile({ ...spec(), futureField: 1 })).toBe("invalid");
		const { schemaVersion: _version, ...unversioned } = spec();
		expect(await refuseFile(unversioned)).toBe("missing-version");
		expect(existsSync(out)).toBe(false);
		// The file reader says which file it refused; the typed run function, handed a spec directly, has no file to name.
		writeFileSync(specFile, JSON.stringify({ ...spec(), futureField: 1 }));
		await expect(experimentRunCommand([specFile, "--out", out])).rejects.toThrow(specFile);
		expect(
			await refusal(() =>
				runEndoExperimentV0({
					spec: { ...spec(), schemaVersion: "endo.experiment-spec.v1" } as unknown as EndoExperimentSpecV0,
					dir: join(base, "never-created-2"),
					log: () => {},
					scratchParent: base,
				}),
			),
		).toBe("unsupported-version");
		expect(existsSync(join(base, "never-created-2"))).toBe(false);
	});
});
