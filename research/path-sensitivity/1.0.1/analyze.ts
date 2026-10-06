// Analysis for the path-sensitivity study (DESIGN.md §6, §7, §9a, §10):
//
//   node research/path-sensitivity/1.0.1/analyze.ts estimate <pilot dir>             wall time per path, T(N), N
//   node research/path-sensitivity/1.0.1/analyze.ts analyze <main or pilot dir>      every pre-registered measure
//   node research/path-sensitivity/1.0.1/analyze.ts spotcheck <main dir> --pi <p>    3 seeded trials, replayed
//
// Each prints one JSON document on stdout. It reuses the steering study's compliance, checks and manipulation code
// unchanged; the unit of analysis is the path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndoCaptureEventsV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { type PiCassetteKeySourceV0, piCassetteKeyV0 } from "../../../cli/cassette-session.ts";
import { reportEndoExperimentV0 } from "../../../cli/experiment.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentRunRecordFileV0,
	readEndoExperimentTrialResultFileV0,
} from "../../../cli/experiment-artifacts.ts";
import { loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import type { EndoExperimentTrialResultV0 } from "../../../protocol/experiment-artifacts.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { mulberry32V0, shuffleV0, wilson95V0 } from "../../../runtime/contracts/statistics.ts";
import { endoFixtureDigestKeyPathV0 } from "../../../storage/digest-key.ts";
import {
	manipulation as environmentManipulation,
	normalizeToolCallIds,
} from "../../pinned-environment/1.0.1/analyze.ts";
import { checks, complied, interventionManipulation, replayOneTrial } from "../../steering/1.0.1/analyze.ts";
import { MESSAGES } from "../../steering/1.0.1/make-spec.ts";
import type { PathsRecordV0 } from "./run-paths.ts";

const FIXTURE: PiCassetteKeySourceV0 = { kind: "fixture", path: endoFixtureDigestKeyPathV0() };
const canonical = (value: unknown) => canonicalEndoJsonV0(value);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** The path normalization (DESIGN §6, fixed before any data): the 12 hex digits of the scratch-root path. */
export const PATH_TOKEN_V0 = /\/tmp\/endo-experiment-[0-9a-f]{12}/g;
export const PATH_PLACEHOLDER_V0 = "/tmp/endo-experiment-<path>";
export const normalizePathText = (text: string): string => text.replace(PATH_TOKEN_V0, PATH_PLACEHOLDER_V0);

/** A value with the path normalization applied to every string in it. */
export function normalizePathsIn<T>(value: T): T {
	return JSON.parse(normalizePathText(JSON.stringify(value))) as T;
}

const INJECTED_FIELDS = ["temperature", "seed", "cache_prompt"];

/** A request body prepared for a cross-path comparison: paths normalized, injected sampling fields removed. */
export function crossPathRequest(request: Record<string, unknown>): Record<string, unknown> {
	const copy = normalizePathsIn(request);
	for (const field of INJECTED_FIELDS) delete copy[field];
	return copy;
}

type Call = { function: { name: string; arguments: string } };
const assistantCalls = (messages: readonly Record<string, unknown>[]): Call[][] =>
	messages.filter((message) => message.role === "assistant").map((message) => (message.tool_calls ?? []) as Call[]);

/** The "tool-call signature" of a trajectory (DESIGN §7): its tool names with their normalized canonical arguments. */
export function toolCallSignature(requests: readonly Record<string, unknown>[]): string {
	const last = requests.at(-1);
	const calls = assistantCalls((last?.messages ?? []) as Record<string, unknown>[])
		.flat()
		.map((call) => {
			const text = normalizePathText(call.function.arguments);
			let args: unknown = text;
			try {
				args = JSON.parse(text);
			} catch {
				// A non-JSON argument string is compared as text.
			}
			return [call.function.name, args];
		});
	return canonical(calls);
}

/** A cell's outcome at a path (DESIGN §7): followed (every trial complies), ignored (none), mixed (some). */
export function cellOutcome(results: readonly boolean[]): "followed" | "ignored" | "mixed" {
	const yes = results.filter(Boolean).length;
	return yes === results.length ? "followed" : yes === 0 ? "ignored" : "mixed";
}

/** How a cell is read (DESIGN §7), by its Wilson interval over determinate paths. */
export function readCell(
	wilson: { low: number; high: number } | null,
): "robustly followed" | "robustly ignored" | "path-dependent at this N" | "no determinate path" {
	if (wilson === null) return "no determinate path";
	if (wilson.low >= 0.7) return "robustly followed";
	if (wilson.high <= 0.3) return "robustly ignored";
	return "path-dependent at this N";
}

const textOf = (message: Record<string, unknown>): string =>
	typeof message.content === "string"
		? message.content
		: Array.isArray(message.content)
			? (message.content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

/**
 * The pattern of a steer (descriptive only): ignored, both commands in one turn, the commands in separate turns, or
 * only the asked-for one. Read from the last request, after the message.
 */
export function responsePattern(requests: readonly Record<string, unknown>[], task: string): string {
	const spec = MESSAGES[task];
	const messages = (requests.at(-1)?.messages ?? []) as Record<string, unknown>[];
	if (spec === undefined) return "none";
	const at = messages.findIndex((message) => message.role === "user" && textOf(message) === spec.text);
	if (at === -1) return "none";
	const bashes = messages.slice(at + 1).flatMap((message, turn) =>
		((message.tool_calls ?? []) as Call[])
			.filter((call) => call.function.name === "bash")
			.map((call) => {
				let command = "";
				try {
					command = String((JSON.parse(call.function.arguments) as { command?: unknown }).command ?? "").trim();
				} catch {
					command = "";
				}
				return { turn, command };
			}),
	);
	const asked = bashes.find((entry) => entry.command === spec.command);
	if (asked === undefined) return "ignored";
	if (bashes.filter((entry) => entry.turn === asked.turn).length >= 2) return "both-commands-in-one-turn";
	return bashes.length >= 2 ? "commands-in-separate-turns" : "only-the-asked-for-command";
}

function completedTrials(dir: string): EndoExperimentTrialResultV0[] {
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	return plan.flatMap((entry) => {
		// A trial that never ran has no result; one that has a result the reader refuses is an error, not a gap.
		const file = join(dir, "trials", entry.task, entry.condition, String(entry.trial), "result.json");
		if (!existsSync(file)) return [];
		const result = readEndoExperimentTrialResultFileV0(file);
		return result.status === "completed" && result.session !== null ? [result] : [];
	});
}

export interface PathAnalysisV0 {
	label: string;
	hash: string;
	trials: number;
	cells: Record<string, { outcome: string; complied: boolean[]; identical: boolean; pattern: string[] }>;
	baselineSignature: Record<string, string>;
	steeredSignatures: Record<string, string>;
	firstRequests: Record<string, string[]>;
	delivery: { study: string; violations: number };
	manipulation: Record<string, string>;
	success: { passed: number; of: number };
	outputTokens: Record<string, number | null>;
	transportErrors: number;
	wallMs: number | null;
}

/** Every pre-registered per-path measure of one path's run directory. */
export function analyzePath(
	dir: string,
	label: string,
	hash: string,
	keySource: PiCassetteKeySourceV0 = FIXTURE,
	environmentChecks = true,
): PathAnalysisV0 {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const trials = completedTrials(dir);
	const loaded = trials.map((trial) => ({
		trial,
		requests: normalizeToolCallIds(loadEndoTrialRequestsV0(join(dir, trial.store), trial, keySource).requests),
	}));
	const cells: PathAnalysisV0["cells"] = {};
	const baselineSignature: Record<string, string> = {};
	const steeredSignatures: Record<string, string> = {};
	const firstRequests: Record<string, string[]> = {};
	for (const task of run.spec.tasks.map((entry) => entry.id)) {
		for (const arm of ["base", "steer", "queue"]) {
			const members = loaded.filter((entry) => entry.trial.task === task && entry.trial.condition === arm);
			if (members.length === 0) continue;
			const results = members.map((entry) => (arm === "base" ? false : complied(entry.requests, task)));
			cells[`${task}/${arm}`] = {
				outcome: arm === "base" ? "n/a" : cellOutcome(results),
				complied: results,
				identical: members.every((entry) => canonical(entry.requests) === canonical(members[0]!.requests)),
				pattern: arm === "base" ? [] : members.map((entry) => responsePattern(entry.requests, task)),
			};
			const signature = toolCallSignature(members[0]!.requests);
			if (arm === "base") baselineSignature[task] = signature;
			else steeredSignatures[`${task}/${arm}`] = signature;
		}
		firstRequests[task] = [
			...new Set(
				loaded
					.filter((entry) => entry.trial.task === task)
					.map((entry) => canonical(crossPathRequest(entry.requests[0]!))),
			),
		];
	}
	const delivery = checks(dir, keySource);
	const report = reportEndoExperimentV0(dir).report as unknown as {
		manipulation: Record<string, { status: string }>;
		cells: { task: string; condition: string; usage?: { output?: { median?: number } } }[];
	};
	const manipulation: Record<string, string> = {
		M1: report.manipulation.M1?.status ?? "NOT-APPLICABLE",
		M2a: report.manipulation.M2a?.status ?? "NOT-APPLICABLE",
		M2b: report.manipulation.M2b?.status ?? "NOT-APPLICABLE",
		M3: report.manipulation.M3?.status ?? "NOT-APPLICABLE",
		...Object.fromEntries(
			Object.entries(interventionManipulation(dir, piCassetteKeyV0(keySource))).map(([name, value]) => [
				name,
				value.status,
			]),
		),
	};
	if (environmentChecks) {
		const environment = environmentManipulation(dir);
		manipulation.M5 = environment.M5.status;
		manipulation.M6 = environment.M6.status;
	}
	let transportErrors = 0;
	for (const trial of trials)
		transportErrors += readEndoCaptureEventsV0(join(dir, trial.store)).filter(
			(event) =>
				event.kind === "capture.exchange-ended" &&
				event.producer === "capture:record" &&
				(event.payload as { outcome?: string }).outcome !== "complete",
		).length;
	const journal = existsSync(join(dir, "journal.jsonl"))
		? readFileSync(join(dir, "journal.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string; at: string })
		: [];
	const started = journal.find((entry) => entry.event === "run-session-started");
	const ended = journal.findLast((entry) => entry.event === "run-session-ended");
	return {
		label,
		hash,
		trials: trials.length,
		cells,
		baselineSignature,
		steeredSignatures,
		firstRequests,
		delivery: { study: delivery.study, violations: delivery.violations },
		manipulation,
		success: { passed: trials.filter((t) => t.check.ran && t.check.passed).length, of: trials.length },
		outputTokens: Object.fromEntries(
			report.cells.map((cell) => [`${cell.task}/${cell.condition}`, cell.usage?.output?.median ?? null]),
		),
		transportErrors,
		wallMs: started !== undefined && ended !== undefined ? Date.parse(ended.at) - Date.parse(started.at) : null,
	};
}

/** Every pre-registered measure over a study directory (DESIGN §7). */
export function analyzeStudy(
	dir: string,
	keySource: PiCassetteKeySourceV0 = FIXTURE,
	environmentChecks = true,
	knownPathsFrom: string | null = null,
) {
	const record = readJson<PathsRecordV0>(join(dir, "paths.json"));
	const analyses: PathAnalysisV0[] = [];
	for (const label of record.order)
		if (!record.missing.includes(label) && existsSync(join(dir, label, "experiment.json")))
			analyses.push(analyzePath(join(dir, label), label, record.hashes[label]!, keySource, environmentChecks));
	const tasks = [...new Set(analyses.flatMap((entry) => Object.keys(entry.baselineSignature)))].sort();
	const primary: Record<string, unknown> = {};
	for (const task of tasks)
		for (const arm of ["steer", "queue"]) {
			const key = `${task}/${arm}`;
			const outcomes = analyses.flatMap((entry) =>
				entry.cells[key] === undefined ? [] : [{ label: entry.label, outcome: entry.cells[key]!.outcome }],
			);
			const followed = outcomes.filter((entry) => entry.outcome === "followed").length;
			const ignored = outcomes.filter((entry) => entry.outcome === "ignored").length;
			const mixed = outcomes.filter((entry) => entry.outcome === "mixed").map((entry) => entry.label);
			const determinate = followed + ignored;
			const interval = wilson95V0(followed, determinate);
			primary[key] = {
				paths: outcomes.length,
				followed,
				ignored,
				mixed,
				followedOfDeterminate: interval,
				reading: readCell(interval.wilson95),
				worstCase: {
					everyMixedIgnored: wilson95V0(followed, determinate + mixed.length),
					everyMixedFollowed: wilson95V0(followed + mixed.length, determinate + mixed.length),
				},
				patterns: Object.fromEntries(
					[...new Set(analyses.flatMap((entry) => entry.cells[key]?.pattern ?? []))]
						.sort()
						.map((pattern) => [
							pattern,
							analyses.reduce(
								(sum, entry) => sum + (entry.cells[key]?.pattern.filter((p) => p === pattern).length ?? 0),
								0,
							),
						]),
				),
			};
		}
	const baselineInvariance = Object.fromEntries(
		tasks.map((task) => {
			const bySignature = new Map<string, string[]>();
			for (const entry of analyses)
				bySignature.set(entry.baselineSignature[task]!, [
					...(bySignature.get(entry.baselineSignature[task]!) ?? []),
					entry.label,
				]);
			return [
				task,
				{ distinctSignatures: bySignature.size, groups: [...bySignature.values()].map((labels) => labels) },
			];
		}),
	);
	const steeredInvariance = Object.fromEntries(
		Object.keys(analyses[0]?.steeredSignatures ?? {}).map((key) => [
			key,
			{ distinctSignatures: new Set(analyses.map((entry) => entry.steeredSignatures[key])).size },
		]),
	);
	const mPath = Object.fromEntries(
		tasks.map((task) => [task, new Set(analyses.flatMap((entry) => entry.firstRequests[task] ?? [])).size]),
	);
	const notIdentical = analyses.flatMap((entry) =>
		Object.entries(entry.cells)
			.filter(([, cell]) => !cell.identical)
			.map(([cell]) => `${entry.label}/${cell}`),
	);
	const manipulationFailures = analyses.flatMap((entry) =>
		Object.entries(entry.manipulation)
			.filter(([, status]) => status !== "PASS" && status !== "NOT-APPLICABLE")
			.map(([name, status]) => `${entry.label}: ${name} ${status}`),
	);
	const successes = analyses.reduce((sum, entry) => sum + entry.success.passed, 0);
	const total = analyses.reduce((sum, entry) => sum + entry.success.of, 0);
	return {
		paths: { analysed: analyses.length, missing: record.missing, order: record.order, seed: record.seed },
		primary,
		secondary: {
			baselinePathInvariance: baselineInvariance,
			steeredSignatureDistinctness: steeredInvariance,
			withinPathDeterminism: { cellsNotIdentical: notIdentical },
			delivery: {
				pathsWithViolations: analyses.filter((entry) => entry.delivery.violations > 0).map((entry) => entry.label),
				violations: analyses.reduce((sum, entry) => sum + entry.delivery.violations, 0),
			},
			success: wilson95V0(successes, total),
		},
		manipulation: {
			MPath: {
				status: tasks.every((task) => mPath[task] === 1) ? "PASS" : "FAIL",
				distinctFirstRequestsByTask: mPath,
			},
			perPathFailures: manipulationFailures,
			status: manipulationFailures.length === 0 && tasks.every((task) => mPath[task] === 1) ? "PASS" : "FAIL",
		},
		transportErrors: analyses.reduce((sum, entry) => sum + entry.transportErrors, 0),
		known: knownPathsFrom === null ? null : knownPaths(knownPathsFrom),
		perPath: analyses.map((entry) => ({
			label: entry.label,
			hash: entry.hash,
			outcomes: Object.fromEntries(
				Object.entries(entry.cells)
					.filter(([, cell]) => cell.outcome !== "n/a")
					.map(([key, cell]) => [key, cell.outcome]),
			),
			outputTokens: entry.outputTokens,
			wallMs: entry.wallMs,
		})),
	};
}

/** The two known paths, from the steering study's own analyses (DESIGN §7): not part of the sample. */
export function knownPaths(steeringAnalysis: string) {
	const cell = (file: string, key: string) => {
		const checksJson = readJson<{ tasks: Record<string, Record<string, { perTrial?: { complied: boolean }[] }>> }>(
			join(steeringAnalysis, file),
		);
		const [task, arm] = key.split("/");
		const trials = checksJson.tasks[task!]![arm!]!.perTrial ?? [];
		return `${trials.filter((entry) => entry.complied).length}/${trials.length}`;
	};
	const row = (file: string) =>
		Object.fromEntries(
			["tool-use/steer", "tool-use/queue", "implement-function/steer", "implement-function/queue"].map((key) => [
				key,
				cell(file, key),
			]),
		);
	return {
		note: "not part of the sample (DESIGN §4); the steering study's data",
		e5bacd997570: { source: "the steering pilot", compliance: row("pilot-checks.json") },
		"372c52355fe7": { source: "the steering main run", compliance: row("main-checks.json") },
	};
}

/** DESIGN §9a: mean wall time per path, T(N) = N × mean × 1.1, and N (the largest of 12, 20, 30 with T(N) ≤ 3 h). */
export function estimate(dir: string, keySource: PiCassetteKeySourceV0 = FIXTURE) {
	const record = readJson<PathsRecordV0>(join(dir, "paths.json"));
	const walls = record.order.flatMap((label) => {
		if (record.missing.includes(label) || !existsSync(join(dir, label, "journal.jsonl"))) return [];
		const analysis = analyzePath(join(dir, label), label, record.hashes[label]!, keySource, false);
		return analysis.wallMs === null ? [] : [analysis.wallMs];
	});
	const mean = walls.reduce((a, b) => a + b, 0) / Math.max(1, walls.length);
	const hours = (n: number) => Math.round(((n * mean * 1.1) / 3_600_000) * 100) / 100;
	const candidates = [12, 20, 30].map((n) => ({ n, hours: hours(n) }));
	return {
		pathWallMs: walls,
		meanPathWallMs: Math.round(mean),
		estimateHours: candidates,
		chosen: [...candidates].reverse().find((entry) => entry.hours <= 3)?.n ?? null,
	};
}

/** DESIGN §10: three trials chosen by the paths' ordering seed over all completed trials, replayed from their recordings. */
export async function spotcheck(dir: string, pi: string, keySource: PiCassetteKeySourceV0 = FIXTURE) {
	const record = readJson<PathsRecordV0>(join(dir, "paths.json"));
	const all = record.order
		.filter((label) => !record.missing.includes(label) && existsSync(join(dir, label, "experiment.json")))
		.flatMap((label) => {
			const runDir = join(dir, label);
			const run = readEndoExperimentRunRecordFileV0(runDir);
			return completedTrials(runDir).map((trial) => ({ label, runDir, run, trial }));
		});
	const chosen = shuffleV0(all, mulberry32V0(record.seed)).slice(0, 3);
	const replays = [];
	for (const entry of chosen)
		replays.push({
			path: entry.label,
			...(await replayOneTrial(entry.run, entry.runDir, entry.trial, pi, keySource)),
		});
	return {
		seed: record.seed,
		selection:
			"mulberry32(paths seed), Fisher-Yates over completed trials in path order then plan order, first three",
		replays,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, dir] = process.argv.slice(2);
	const option = (name: string) => {
		const index = process.argv.indexOf(name);
		return index === -1 ? undefined : process.argv[index + 1];
	};
	const run = async () => {
		if (command === "estimate") return estimate(dir!);
		if (command === "analyze") return analyzeStudy(dir!, FIXTURE, true, option("--known") ?? null);
		if (command === "spotcheck") return spotcheck(dir!, option("--pi")!);
		throw new TypeError(
			"usage: analyze.ts estimate|analyze|spotcheck <dir> [--pi path] [--known <steering analysis dir>]",
		);
	};
	run().then(
		(value) => process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`),
		(error: unknown) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(1);
		},
	);
}
