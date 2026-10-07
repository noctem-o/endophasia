// Analysis for the discriminating-task study (DESIGN.md §6-§8, §10), from the run directories:
//
//   node research/discriminating-tasks/1.0.1/analyze.ts screen <pilot run dir> [--repo <dir>] [--home <dir>]
//        stage 1: per task the counted trials, successes, exclusions and whether it advances; the selection; the validity checks
//   node research/discriminating-tasks/1.0.1/analyze.ts confirm <confirmation dir> [--repo <dir>] [--home <dir>]
//        stage 2: per task the rate, its two intervals, per-path counts, the heterogeneity flag, the band; the validity checks
//   node research/discriminating-tasks/1.0.1/analyze.ts split <confirmation analysis json>
//        the seeded validation/holdout split of the discriminating tasks (validated-tasks.json)
//
// `--repo` and `--home` name the protected roots of the leakage check (default: the current directory and the operator's
// home); they are used for matching and never written to the output. Each command prints one JSON document on stdout.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndoCaptureEventsV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { reportEndoExperimentV0 } from "../../../cli/experiment.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentPlannedTrialV0,
	readEndoExperimentRunRecordFileV0,
} from "../../../cli/experiment-artifacts.ts";
import { ENDO_MANIPULATION_WATCHED_FIELDS_V0, loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import type { EndoExperimentTrialResultV0 } from "../../../protocol/experiment-artifacts.ts";
import { spreadV0, wilson95V0 } from "../../../runtime/contracts/statistics.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";
import { parseEndoWorkspaceArchiveV0 } from "../../../storage/workspace-snapshot.ts";
import { manipulation as environmentChecks } from "../../pinned-environment/1.0.1/analyze.ts";
import { HIDDEN_MARKER_PREFIX_V0, leakageOfTrialV0 } from "./leakage.ts";
import { advancesV0, bandV0, clusterIntervalV0, heterogeneousV0, SPLIT_SEED_V0, selectV0, splitV0 } from "./stats.ts";
import { TASK_IDS } from "./tasks.ts";

const FIXTURE = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

export type FailureModeV0 = "wrong-result" | "session-did-not-finish" | "check-timeout" | "check-could-not-run";
export type TrialClassV0 =
	| { kind: "success" }
	| { kind: "failure"; mode: FailureModeV0 }
	| { kind: "error"; error: string }
	| { kind: "invalid"; reasons: string[] };

/** One trial as the analysis uses it. */
export interface AnalysedTrialV0 {
	task: string;
	trial: number;
	class: TrialClassV0;
	wallMs: number;
	toolCalls: number;
	outsideMentions: number;
	/** Validity: the first request carries the task's prompt, the snapshot has the workspace and not the check. */
	workspaceProblems: string[];
	/** Validity M1: the watched sampling fields that appeared in a request (there must be none). */
	samplingFields: string[];
}

type Message = Record<string, unknown>;
const messagesOf = (request: Record<string, unknown>): Message[] =>
	Array.isArray(request.messages) ? (request.messages as Message[]) : [];
const textOfContent = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

/** Each tool call's arguments (as the JSON text Pi's model produced) and each tool result's text, from a request body. */
export function toolActivityOf(request: Record<string, unknown>): { calls: string[]; results: string[] } {
	const calls: string[] = [];
	const results: string[] = [];
	for (const message of messagesOf(request)) {
		if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls as { function?: { name?: string; arguments?: unknown } }[])
				calls.push(`${call.function?.name ?? ""} ${textOfContent(call.function?.arguments)}`);
		}
		if (message.role === "tool") results.push(textOfContent(message.content));
	}
	return { calls, results };
}

/** The failure mode of a counted failure, from the trial's own record (DESIGN §8). */
export function failureModeOf(result: Pick<EndoExperimentTrialResultV0, "check" | "notes">): FailureModeV0 {
	if (!result.check.ran) return "check-could-not-run";
	if (result.check.timedOut) return "check-timeout";
	if (result.notes.some((note) => /agent_settled was not observed/.test(note))) return "session-did-not-finish";
	return "wrong-result";
}

/** The class of a trial that has no leakage verdict yet (an error is excluded, not counted as a failure). */
export function classOf(result: EndoExperimentTrialResultV0, leakageReasons: string[]): TrialClassV0 {
	if (result.status === "error") return { kind: "error", error: (result.error ?? "").slice(0, 200) };
	if (leakageReasons.length > 0) return { kind: "invalid", reasons: leakageReasons };
	if (result.check.ran && result.check.passed) return { kind: "success" };
	return { kind: "failure", mode: failureModeOf(result) };
}

function trialsOf(dir: string): EndoExperimentTrialResultV0[] {
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	return plan.flatMap((entry) => {
		const result = readEndoExperimentPlannedTrialV0(dir, entry);
		return result === null ? [] : [result];
	});
}

export interface RootsV0 {
	repo: string;
	home: string;
}

/** Every trial of one run directory, classified, with the per-trial validity measures. */
export function analyseRun(dir: string, roots: RootsV0): AnalysedTrialV0[] {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
	const out: AnalysedTrialV0[] = [];
	for (const result of trialsOf(dir)) {
		const wallMs = Date.parse(result.endedAt) - Date.parse(result.startedAt);
		const task = run.spec.tasks.find((entry) => entry.id === result.task)!;
		if (result.status === "error" || result.exchanges === 0) {
			out.push({
				task: result.task,
				trial: result.trial,
				class: classOf({ ...result, status: "error", error: result.error ?? "no exchange was recorded" }, []),
				wallMs,
				toolCalls: 0,
				outsideMentions: 0,
				workspaceProblems: [],
				samplingFields: [],
			});
			continue;
		}
		const store = join(dir, result.store);
		const { requests } = loadEndoTrialRequestsV0(store, result, FIXTURE);
		const last = requests.reduce((a, b) => (messagesOf(b).length >= messagesOf(a).length ? b : a));
		const activity = toolActivityOf(last);
		const events = readEndoCaptureEventsV0(store);
		const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")?.payload as
			| { scratchRoot: string; archive: { digest: Parameters<ReturnType<typeof createEndoBlobStoreV0>["get"]>[0] } }
			| undefined;
		const leak = leakageOfTrialV0({
			toolCallArguments: activity.calls,
			toolResults: activity.results,
			ownScratchRoot: snapshot?.scratchRoot ?? "/nonexistent-scratch-root",
			protectedRoots: [roots.repo, roots.home],
		});
		const workspaceProblems: string[] = [];
		const first = messagesOf(requests[0]!).find((message) => message.role === "user");
		if (first === undefined || textOfContent(first.content) !== task.prompts[0])
			workspaceProblems.push("the first request does not carry the task's prompt");
		if (snapshot === undefined) workspaceProblems.push("no workspace snapshot was recorded");
		else {
			const archive = parseEndoWorkspaceArchiveV0(
				createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true }).get(snapshot.archive.digest),
			);
			const files = new Map(archive.entries.map((entry) => [entry.path, entry]));
			for (const path of Object.keys(task.workspace)) {
				const entry = files.get(`work/${path}`) ?? files.get(path);
				if (entry === undefined || entry.type !== "file") workspaceProblems.push(`the snapshot lacks ${path}`);
			}
			for (const entry of archive.entries) {
				if (/hidden/i.test(entry.path)) workspaceProblems.push(`the snapshot holds ${entry.path}`);
				if (
					entry.type === "file" &&
					Buffer.from(entry.base64, "base64").toString("utf8").includes(HIDDEN_MARKER_PREFIX_V0)
				)
					workspaceProblems.push(`the snapshot's ${entry.path} carries the hidden marker`);
			}
		}
		const samplingFields = [
			...new Set(
				requests.flatMap((request) => ENDO_MANIPULATION_WATCHED_FIELDS_V0.filter((field) => field in request)),
			),
		];
		out.push({
			task: result.task,
			trial: result.trial,
			class: classOf(result, leak.reasons),
			wallMs,
			toolCalls: activity.calls.length,
			outsideMentions: leak.outsideMentions,
			workspaceProblems,
			samplingFields,
		});
	}
	return out;
}

export interface TaskTallyV0 {
	task: string;
	planned: number;
	counted: number;
	successes: number;
	errors: number;
	invalid: number;
	failureModes: Record<string, number>;
	unmeasured: boolean;
	outsideMentions: number;
	wallMs: ReturnType<typeof spreadV0>;
	toolCalls: ReturnType<typeof spreadV0>;
}

/** Counted trials are successes and failures; errors and invalid trials are excluded and reported (DESIGN §5). */
export function tally(task: string, trials: readonly AnalysedTrialV0[], planned: number): TaskTallyV0 {
	const mine = trials.filter((trial) => trial.task === task);
	const counted = mine.filter((trial) => trial.class.kind === "success" || trial.class.kind === "failure");
	const errors = mine.filter((trial) => trial.class.kind === "error").length + (planned - mine.length);
	const modes: Record<string, number> = {};
	for (const trial of counted)
		if (trial.class.kind === "failure") modes[trial.class.mode] = (modes[trial.class.mode] ?? 0) + 1;
	return {
		task,
		planned,
		counted: counted.length,
		successes: counted.filter((trial) => trial.class.kind === "success").length,
		errors,
		invalid: mine.filter((trial) => trial.class.kind === "invalid").length,
		failureModes: modes,
		unmeasured: errors > 0.1 * planned,
		outsideMentions: mine.reduce((sum, trial) => sum + trial.outsideMentions, 0),
		wallMs: spreadV0(mine.map((trial) => trial.wallMs)),
		toolCalls: spreadV0(mine.map((trial) => trial.toolCalls)),
	};
}

function validity(dir: string, trials: readonly AnalysedTrialV0[]) {
	const environment = environmentChecks(dir);
	return {
		M1: {
			status: trials.every((trial) => trial.samplingFields.length === 0) ? "PASS" : "FAIL",
			trials: trials.length,
			instances: trials
				.filter((trial) => trial.samplingFields.length > 0)
				.map((trial) => `${trial.task}/#${trial.trial}`),
		},
		M5: environment.M5.status,
		M6: environment.M6.status,
		"M-ws": {
			status: trials.every((trial) => trial.workspaceProblems.length === 0) ? "PASS" : "FAIL",
			problems: trials.flatMap((trial) =>
				trial.workspaceProblems.map((problem) => `${trial.task}/#${trial.trial}: ${problem}`),
			),
		},
	};
}

const outputTokens = (dir: string): Record<string, number | null> => {
	const report = reportEndoExperimentV0(dir).report as unknown as {
		cells: { task: string; usage?: { output?: { median?: number } } }[];
	};
	return Object.fromEntries(report.cells.map((cell) => [cell.task, cell.usage?.output?.median ?? null]));
};

/** Stage 1: the screen and the selection (DESIGN §6). */
export function screen(dir: string, roots: RootsV0) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const trials = analyseRun(dir, roots);
	const tokens = outputTokens(dir);
	const rows = run.spec.tasks.map((task) => ({
		...tally(task.id, trials, run.spec.trials),
		outputTokensMedian: tokens[task.id] ?? null,
	}));
	const eligible = rows.filter((row) => !row.unmeasured);
	const selection = selectV0(eligible);
	return {
		stage: "screen",
		tasks: rows.map((row) => ({
			...row,
			advances: !row.unmeasured && advancesV0(row.successes, row.counted),
			advancing: selection.advancing.includes(row.task),
		})),
		advancing: selection.advancing,
		dropped: selection.dropped,
		unmeasured: rows.filter((row) => row.unmeasured).map((row) => row.task),
		validity: validity(dir, trials),
	};
}

/** Stage 2: per task, over the paths (DESIGN §8). `dir` holds paths.json and one run directory per path. */
export function confirm(dir: string, roots: RootsV0) {
	const record = readJson<{ order: string[]; missing: string[]; hashes: Record<string, string> }>(
		join(dir, "paths.json"),
	);
	const labels = record.order.filter((label) => !record.missing.includes(label));
	const byPath = new Map(labels.map((label) => [label, analyseRun(join(dir, label), roots)]));
	const planned = readEndoExperimentRunRecordFileV0(join(dir, labels[0]!)).spec;
	const tokens = Object.fromEntries(labels.map((label) => [label, outputTokens(join(dir, label))]));
	const tasks = planned.tasks.map((task) => {
		const perPath = labels.map((label) => tally(task.id, byPath.get(label)!, planned.trials));
		const all = labels.flatMap((label) => byPath.get(label)!);
		const total = tally(task.id, all, planned.trials * labels.length);
		const counts = perPath.map((path) => ({ successes: path.successes, counted: path.counted }));
		const median = (values: (number | null)[]) => spreadV0(values.filter((value): value is number => value !== null));
		return {
			...total,
			pooled: total.counted === 0 ? null : wilson95V0(total.successes, total.counted),
			cluster: clusterIntervalV0(counts),
			perPath: Object.fromEntries(
				labels.map((label, index) => [label, `${perPath[index]!.successes}/${perPath[index]!.counted}`]),
			),
			heterogeneous: heterogeneousV0(perPath.map((path) => path.successes)),
			band: total.counted === 0 || total.unmeasured ? "unmeasured" : bandV0(total.successes, total.counted),
			outputTokensMedianOverPaths: median(labels.map((label) => tokens[label]![task.id] ?? null)),
		};
	});
	return {
		stage: "confirmation",
		paths: labels,
		missing: record.missing,
		hashes: record.hashes,
		tasks,
		discriminating: tasks
			.filter((task) => task.band === "discriminating")
			.map((task) => task.task)
			.sort(),
		validity: Object.fromEntries(labels.map((label) => [label, validity(join(dir, label), byPath.get(label)!)])),
	};
}

/** The seeded split of the discriminating tasks (DESIGN §10). */
export function splitFromConfirmation(analysis: { discriminating: string[]; tasks: { task: string; band: string }[] }) {
	const split = splitV0(analysis.discriminating);
	return {
		schemaVersion: "endo.validated-tasks.v0",
		seed: SPLIT_SEED_V0,
		rule: "sort ids, Fisher-Yates with mulberry32(seed), first ceil(m/2) validation, the rest holdout",
		validation: split.validation,
		holdout: split.holdout,
		marginal: analysis.tasks
			.filter((task) => task.band === "marginal")
			.map((task) => task.task)
			.sort(),
		saturated: analysis.tasks
			.filter((task) => task.band === "saturated")
			.map((task) => task.task)
			.sort(),
		unmeasured: analysis.tasks
			.filter((task) => task.band === "unmeasured")
			.map((task) => task.task)
			.sort(),
		notInConfirmation: TASK_IDS.filter((id) => !analysis.tasks.some((task) => task.task === id)),
	};
}

function option(argv: readonly string[], name: string, fallback: string): string {
	const index = argv.indexOf(name);
	return index === -1 ? fallback : resolve(argv[index + 1] ?? fallback);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, target, ...rest] = process.argv.slice(2);
	const roots = { repo: option(rest, "--repo", process.cwd()), home: option(rest, "--home", homedir()) };
	let result: unknown;
	if (command === "screen" && target) result = screen(resolve(target), roots);
	else if (command === "confirm" && target) result = confirm(resolve(target), roots);
	else if (command === "split" && target) result = splitFromConfirmation(readJson(resolve(target)));
	else {
		process.stderr.write(
			"usage: analyze.ts screen|confirm <dir> [--repo <dir>] [--home <dir>] | split <confirmation analysis>\n",
		);
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
}
