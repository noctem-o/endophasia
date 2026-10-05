// Analysis for the completion-cap study (DESIGN.md §6-§9), from the run directories:
//
//   node research/completion-cap/1.0.1/analyze.ts pilot <pilot run dir> [--repo <dir>] [--home <dir>]
//        the pilot's gates (§6), the wall-time estimate and N (§8)
//   node research/completion-cap/1.0.1/analyze.ts main <main dir> [--repo <dir>] [--home <dir>]
//        the main run: per arm and task the counts, the primary contrast, the secondary contrasts, the harm check, the cost table
//        and the manipulation checks
//
// `--repo` and `--home` are the leakage check's protected roots, used for matching and never written to the output.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndoCaptureEventsV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { piCassetteKeyV0 } from "../../../cli/cassette-session.ts";
import type {
	EndoExperimentRunRecordV0,
	EndoExperimentTrialKeyV0,
	EndoExperimentTrialResultV0,
} from "../../../cli/experiment.ts";
import { ENDO_MANIPULATION_WATCHED_FIELDS_V0, loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { spreadV0, wilson95V0 } from "../../../runtime/contracts/statistics.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";
import { parseEndoWorkspaceArchiveV0 } from "../../../storage/workspace-snapshot.ts";
import { toolActivityOf } from "../../discriminating-tasks/1.0.1/analyze.ts";
import { HIDDEN_MARKER_PREFIX_V0, leakageOfTrialV0 } from "../../discriminating-tasks/1.0.1/leakage.ts";
import { manipulation as environmentChecks } from "../../pinned-environment/1.0.1/analyze.ts";
import { ARM_IDS, ARMS, type ArmIdV0, BRIEF_SENTENCE, PRIMARY_TASKS } from "./make-spec.ts";
import { chooseNV0, harmFlagV0, primaryContrastV0, shareV0 } from "./stats.ts";
import { parseWireV0, type WireSummaryV0 } from "./wire.ts";

const FIXTURE = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const sha = (value: unknown) =>
	createHash("sha256")
		.update(canonicalEndoJsonV0(value as never))
		.digest("hex")
		.slice(0, 16);

export type FailureModeV0 = "cut-off" | "session-did-not-finish" | "server-error" | "wrong-result";
export type ClassV0 =
	| { kind: "success" }
	| { kind: "failure"; mode: FailureModeV0 }
	| { kind: "error"; error: string }
	| { kind: "invalid"; reasons: string[] };

export interface TrialV0 {
	task: string;
	arm: ArmIdV0;
	trial: number;
	class: ClassV0;
	wallMs: number;
	toolCalls: number;
	responses: number;
	cutOffResponses: number;
	httpErrors: number;
	outputTokens: number;
	peakPromptTokens: number;
	generationMs: number;
	reasoningChars: number;
	contentChars: number;
	outsideMentions: number;
	/** Per request: the cap sent, whether a template field was sent, and the structure of the request. */
	injectedProblems: string[];
	samplingFields: string[];
	workspaceProblems: string[];
	systemText: string | null;
	toolsDigest: string | null;
}

type Message = Record<string, unknown>;
const messagesOf = (request: Record<string, unknown>): Message[] =>
	Array.isArray(request.messages) ? (request.messages as Message[]) : [];
const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
			: "";

/** The failure mode of a counted failure, in the order DESIGN §7 lists them. */
export function failureModeOf(input: {
	cutOffResponses: number;
	didNotFinish: boolean;
	httpErrors: number;
}): FailureModeV0 {
	if (input.cutOffResponses > 0) return "cut-off";
	if (input.didNotFinish) return "session-did-not-finish";
	if (input.httpErrors > 0) return "server-error";
	return "wrong-result";
}

export function classOf(
	result: Pick<EndoExperimentTrialResultV0, "status" | "error" | "check" | "notes">,
	leakageReasons: string[],
	wire: { cutOffResponses: number; httpErrors: number },
): ClassV0 {
	if (result.status === "error") return { kind: "error", error: (result.error ?? "").slice(0, 200) };
	if (leakageReasons.length > 0) return { kind: "invalid", reasons: leakageReasons };
	if (result.check.ran && result.check.passed) return { kind: "success" };
	return {
		kind: "failure",
		mode: failureModeOf({
			...wire,
			didNotFinish: result.notes.some((note) => /agent_settled was not observed/.test(note)),
		}),
	};
}

function trialsOf(dir: string): EndoExperimentTrialResultV0[] {
	const plan = readJson<{ order: EndoExperimentTrialKeyV0[] }>(join(dir, "plan.json")).order;
	return plan.flatMap((entry) => {
		const file = join(dir, "trials", entry.task, entry.condition, String(entry.trial), "result.json");
		return existsSync(file) ? [readJson<EndoExperimentTrialResultV0>(file)] : [];
	});
}

/** Each recorded response of a trial, read from its wire bytes. */
export function responsesOf(store: string): WireSummaryV0[] {
	const blobs = createEndoBlobStoreV0(join(store, "capture"), piCassetteKeyV0(FIXTURE), { readOnly: true });
	const out: WireSummaryV0[] = [];
	for (const event of readEndoCaptureEventsV0(store)) {
		const payload = event.payload as { wire?: { digest: Parameters<typeof blobs.get>[0] } };
		if (event.producer === "capture:record" && event.kind === "capture.exchange-ended" && payload.wire) {
			const summary = parseWireV0(blobs.get(payload.wire.digest));
			// An exchange with no bytes is the proxy's retry of a connection the server had already closed ("the upstream
			// had closed the connection before this request arrived"): the retry is the next exchange, so it is not a response.
			if (summary.httpStatus !== null) out.push(summary);
		}
	}
	return out;
}

export interface RootsV0 {
	repo: string;
	home: string;
}

const armOf = (condition: string): ArmIdV0 => condition.replace(/^arm-/, "") as ArmIdV0;
const BASE_FIELDS = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"store",
	"max_completion_tokens",
	"tools",
]);

/** Every trial of one run directory, with the per-trial measures and per-request manipulation findings. */
export function analyseRun(dir: string, roots: RootsV0): TrialV0[] {
	const run = readJson<EndoExperimentRunRecordV0>(join(dir, "experiment.json"));
	const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
	const out: TrialV0[] = [];
	for (const result of trialsOf(dir)) {
		const arm = armOf(result.condition);
		const task = run.spec.tasks.find((entry) => entry.id === result.task)!;
		const wallMs = Date.parse(result.endedAt) - Date.parse(result.startedAt);
		const empty = {
			task: result.task,
			arm,
			trial: result.trial,
			wallMs,
			toolCalls: 0,
			responses: 0,
			cutOffResponses: 0,
			httpErrors: 0,
			outputTokens: 0,
			peakPromptTokens: 0,
			generationMs: 0,
			reasoningChars: 0,
			contentChars: 0,
			outsideMentions: 0,
			injectedProblems: [] as string[],
			samplingFields: [] as string[],
			workspaceProblems: [] as string[],
			systemText: null,
			toolsDigest: null,
		};
		if (result.status === "error" || result.exchanges === 0) {
			out.push({
				...empty,
				class: { kind: "error", error: (result.error ?? "no exchange was recorded").slice(0, 200) },
			});
			continue;
		}
		const store = join(dir, result.store);
		const { requests } = loadEndoTrialRequestsV0(store, result, FIXTURE);
		const responses = responsesOf(store);
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
		const spec = ARMS[arm];
		const injectedProblems: string[] = [];
		const samplingFields = new Set<string>();
		const allowed = new Set([...BASE_FIELDS, ...Object.keys(spec.extra)]);
		for (const [index, request] of requests.entries()) {
			if (request.max_completion_tokens !== spec.cap)
				injectedProblems.push(
					`request ${index + 1}: max_completion_tokens is ${JSON.stringify(request.max_completion_tokens ?? null)}, expected ${spec.cap}`,
				);
			for (const [field, value] of Object.entries(spec.extra))
				if (canonicalEndoJsonV0(request[field] as never) !== canonicalEndoJsonV0(value as never))
					injectedProblems.push(`request ${index + 1}: ${field} differs from the arm's`);
			if (Object.keys(spec.extra).length === 0 && "chat_template_kwargs" in request)
				injectedProblems.push(`request ${index + 1}: an unexpected chat_template_kwargs`);
			for (const field of ENDO_MANIPULATION_WATCHED_FIELDS_V0) if (field in request) samplingFields.add(field);
			for (const field of Object.keys(request))
				if (!allowed.has(field) && !ENDO_MANIPULATION_WATCHED_FIELDS_V0.includes(field))
					injectedProblems.push(`request ${index + 1}: an unexpected field ${field}`);
		}
		const workspaceProblems: string[] = [];
		const first = messagesOf(requests[0]!).find((message) => message.role === "user");
		if (first === undefined || textOf(first.content) !== task.prompts[0])
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
		const cutOffResponses = responses.filter((response) => response.finishReason === "length").length;
		const httpErrors = responses.filter(
			(response) => response.httpStatus === null || response.httpStatus >= 400,
		).length;
		const system = messagesOf(requests[0]!)[0];
		out.push({
			...empty,
			class: classOf(result, leak.reasons, { cutOffResponses, httpErrors }),
			toolCalls: activity.calls.length,
			responses: responses.length,
			cutOffResponses,
			httpErrors,
			outputTokens: responses.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0),
			peakPromptTokens: Math.max(0, ...responses.map((r) => r.promptTokens ?? 0)),
			generationMs: responses.reduce((sum, r) => sum + (r.predictedMs ?? 0), 0),
			reasoningChars: responses.reduce((sum, r) => sum + r.reasoningChars, 0),
			contentChars: responses.reduce((sum, r) => sum + r.contentChars, 0),
			outsideMentions: leak.outsideMentions,
			injectedProblems,
			samplingFields: [...samplingFields],
			workspaceProblems,
			systemText: system?.role === "system" ? textOf(system.content) : null,
			toolsDigest: requests[0]!.tools === undefined ? null : sha(requests[0]!.tools),
		});
	}
	return out;
}

const counted = (trial: TrialV0) => trial.class.kind === "success" || trial.class.kind === "failure";
const isSuccess = (trial: TrialV0) => trial.class.kind === "success";

export interface CellV0 {
	arm: ArmIdV0;
	task: string;
	planned: number;
	counted: number;
	successes: number;
	errors: number;
	invalid: number;
	unmeasured: boolean;
	failureModes: Record<string, number>;
	cutOffTrialShare: number | null;
	timeouts: number;
	httpErrors: number;
	reasoningShare: number | null;
	outputTokens: ReturnType<typeof spreadV0>;
	wallMs: ReturnType<typeof spreadV0>;
	peakPromptTokens: ReturnType<typeof spreadV0>;
	toolCalls: ReturnType<typeof spreadV0>;
	outputTokensPerSuccess: number | null;
	wallMsPerSuccess: number | null;
	outsideMentions: number;
}

export function cell(arm: ArmIdV0, task: string, trials: readonly TrialV0[], planned: number): CellV0 {
	const mine = trials.filter((trial) => trial.arm === arm && trial.task === task);
	const kept = mine.filter(counted);
	const successes = kept.filter(isSuccess).length;
	const errors = mine.filter((trial) => trial.class.kind === "error").length + (planned - mine.length);
	const modes: Record<string, number> = {};
	for (const trial of kept)
		if (trial.class.kind === "failure") modes[trial.class.mode] = (modes[trial.class.mode] ?? 0) + 1;
	const reasoning = mine.reduce((sum, t) => sum + t.reasoningChars, 0);
	const content = mine.reduce((sum, t) => sum + t.contentChars, 0);
	const round = (value: number | null) => (value === null ? null : Math.round(value));
	return {
		arm,
		task,
		planned,
		counted: kept.length,
		successes,
		errors,
		invalid: mine.filter((trial) => trial.class.kind === "invalid").length,
		unmeasured: errors > 0.1 * planned,
		failureModes: modes,
		cutOffTrialShare: shareV0(mine.filter((trial) => trial.cutOffResponses > 0).length, mine.length),
		timeouts: mine.filter((trial) => trial.class.kind === "failure" && trial.class.mode === "session-did-not-finish")
			.length,
		httpErrors: mine.reduce((sum, trial) => sum + trial.httpErrors, 0),
		reasoningShare: shareV0(reasoning, reasoning + content),
		outputTokens: spreadV0(mine.map((trial) => trial.outputTokens)),
		wallMs: spreadV0(mine.map((trial) => trial.wallMs)),
		peakPromptTokens: spreadV0(mine.map((trial) => trial.peakPromptTokens)),
		toolCalls: spreadV0(mine.map((trial) => trial.toolCalls)),
		outputTokensPerSuccess:
			successes === 0 ? null : round(mine.reduce((sum, t) => sum + t.outputTokens, 0) / successes),
		wallMsPerSuccess: successes === 0 ? null : round(mine.reduce((sum, t) => sum + t.wallMs, 0) / successes),
		outsideMentions: mine.reduce((sum, trial) => sum + trial.outsideMentions, 0),
	};
}

/** The manipulation checks of one run directory's trials (DESIGN §7). */
export function manipulationOf(dir: string, trials: readonly TrialV0[]) {
	const environment = environmentChecks(dir);
	const arms = [...new Set(trials.map((trial) => trial.arm))].sort() as ArmIdV0[];
	const reference = trials.find((trial) => trial.arm === "a" && trial.systemText !== null);
	const byArm = Object.fromEntries(
		arms.map((arm) => {
			const mine = trials.filter((trial) => trial.arm === arm);
			const expected =
				reference?.systemText == null
					? null
					: arm === "d"
						? `${reference.systemText}\n\n${BRIEF_SENTENCE}`
						: reference.systemText;
			const sysProblems = mine.filter(
				(trial) => trial.systemText !== null && expected !== null && trial.systemText !== expected,
			).length;
			const toolProblems = mine.filter(
				(trial) => reference?.toolsDigest != null && trial.toolsDigest !== reference.toolsDigest,
			).length;
			return [
				arm,
				{
					trials: mine.length,
					"M-inj": mine
						.flatMap((trial) => trial.injectedProblems.map((p) => `${trial.task}/#${trial.trial}: ${p}`))
						.slice(0, 10),
					"M-sys-trials-differing": sysProblems,
					"M-tools-trials-differing": toolProblems,
					"M1-sampling-fields": [...new Set(mine.flatMap((trial) => trial.samplingFields))],
					"M-ws": mine
						.flatMap((trial) => trial.workspaceProblems.map((p) => `${trial.task}/#${trial.trial}: ${p}`))
						.slice(0, 10),
					cutOffResponseRate: shareV0(
						mine.reduce((s, t) => s + t.cutOffResponses, 0),
						mine.reduce((s, t) => s + t.responses, 0),
					),
					"session-did-not-finish": mine.filter(
						(t) => t.class.kind === "failure" && t.class.mode === "session-did-not-finish",
					).length,
					"server-errors": mine.reduce((sum, t) => sum + t.httpErrors, 0),
				},
			];
		}),
	);
	return { M5: environment.M5.status, M6: environment.M6.status, byArm };
}

/** The pilot: its gates, the per-cell wall times and N (DESIGN §6, §8). */
export function pilot(dir: string, roots: RootsV0) {
	const run = readJson<EndoExperimentRunRecordV0>(join(dir, "experiment.json"));
	const trials = analyseRun(dir, roots);
	const arms = run.spec.conditions.map((condition) => armOf(condition.id));
	const cells = arms.flatMap((arm) => run.spec.tasks.map((task) => cell(arm, task.id, trials, run.spec.trials)));
	const median = (values: number[]) => spreadV0(values)?.median ?? null;
	const reasoning = (arm: ArmIdV0, task: string) =>
		median(
			trials.filter((t) => t.arm === arm && t.task === task).map((t) => t.reasoningChars / Math.max(1, t.responses)),
		);
	const eReduction = run.spec.tasks.map((task) => {
		const a = reasoning("a", task.id);
		const e = reasoning("e", task.id);
		return {
			task: task.id,
			a,
			e,
			reduction: a !== null && e !== null && a > 0 ? Math.round((1 - e / a) * 1000) / 1000 : null,
		};
	});
	const eKept = arms.includes("e") && eReduction.every((entry) => entry.reduction !== null && entry.reduction >= 0.5);
	// One mean wall time per (arm, task) cell of the arms the main run would keep (E only if it was kept).
	const keptArms = arms.filter((arm) => arm !== "e" || eKept);
	const meansMs = keptArms.flatMap((arm) =>
		run.spec.tasks.map((task) => {
			const mine = trials.filter((t) => t.arm === arm && t.task === task.id);
			return mine.reduce((sum, t) => sum + t.wallMs, 0) / Math.max(1, mine.length);
		}),
	);
	return {
		stage: "pilot",
		trials: trials.length,
		cells,
		manipulation: manipulationOf(dir, trials),
		eReasoningReductionVsA: eReduction,
		eKept,
		keptArms,
		estimate: chooseNV0(meansMs),
	};
}

/** The main run: `dir` holds paths.json and one run directory per path. */
export function main(dir: string, roots: RootsV0) {
	const record = readJson<{ order: string[]; missing: string[]; hashes: Record<string, string> }>(
		join(dir, "paths.json"),
	);
	const labels = record.order.filter((label) => !record.missing.includes(label));
	const runs = labels.map((label) => ({
		label,
		trials: analyseRun(join(dir, label), roots),
		spec: readJson<EndoExperimentRunRecordV0>(join(dir, label, "experiment.json")).spec,
	}));
	const spec = runs[0]!.spec;
	const arms = spec.conditions.map((condition) => armOf(condition.id));
	const all = runs.flatMap((run) => run.trials);
	const planned = spec.trials * labels.length;
	const cells = arms.flatMap((arm) => spec.tasks.map((task) => cell(arm, task.id, all, planned)));
	const counts = (arm: ArmIdV0, tasks: readonly string[], trials: readonly TrialV0[]) => {
		const kept = trials.filter((t) => t.arm === arm && tasks.includes(t.task) && counted(t));
		return { successes: kept.filter(isSuccess).length, counted: kept.length };
	};
	const contrast = (arm: ArmIdV0, base: ArmIdV0, tasks: readonly string[]) =>
		primaryContrastV0(
			runs.map((run) => ({ control: counts(base, tasks, run.trials), arm: counts(arm, tasks, run.trials) })),
		);
	const primaryTasks = [...PRIMARY_TASKS];
	const withWilson = (c: { successes: number; counted: number }) => ({
		...c,
		...(c.counted === 0 ? {} : { wilson: wilson95V0(c.successes, c.counted).wilson95 }),
	});
	const secondary = arms
		.filter((arm) => arm !== "a")
		.map((arm) => ({
			arm,
			vsA: contrast(arm, "a", primaryTasks),
			vsB: arm === "c" && arms.includes("b") ? contrast("c", "b", primaryTasks) : null,
			perTask: spec.tasks.map((task) => ({
				task: task.id,
				arm: withWilson(counts(arm, [task.id], all)),
				control: withWilson(counts("a", [task.id], all)),
				harm:
					!PRIMARY_TASKS.includes(task.id as (typeof PRIMARY_TASKS)[number]) &&
					harmFlagV0(counts(arm, [task.id], all), counts("a", [task.id], all)),
			})),
			perPathDifference: contrast(arm, "a", primaryTasks).perPath,
		}));
	const primary = arms.includes("b") ? contrast("b", "a", primaryTasks) : null;
	return {
		stage: "main",
		paths: labels,
		missing: record.missing,
		hashes: record.hashes,
		trialsPerCellPerPath: spec.trials,
		arms,
		cells,
		primary: primary && {
			contrast: "B - A, pooled over fetch-cache and markup-lite",
			...primary,
			control: withWilson(primary.control),
			arm: withWilson(primary.arm),
		},
		secondary,
		manipulation: Object.fromEntries(
			runs.map((run) => [run.label, manipulationOf(join(dir, run.label), run.trials)]),
		),
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
	if (command === "pilot" && target) result = pilot(resolve(target), roots);
	else if (command === "main" && target) result = main(resolve(target), roots);
	else {
		process.stderr.write("usage: analyze.ts pilot|main <dir> [--repo <dir>] [--home <dir>]\n");
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
	void ARM_IDS;
}
