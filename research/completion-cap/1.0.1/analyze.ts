// Analysis for the completion-cap study (DESIGN.md §6-§9), from the run directories:
//
//   node research/completion-cap/1.0.1/analyze.ts pilot <pilot run dir> --repo <dir> --home <dir>
//        the pilot's gates (§6), the wall-time estimate and N (§8)
//   node research/completion-cap/1.0.1/analyze.ts main <main dir> --repo <dir> --home <dir>
//        the main run: per arm and task the counts, the primary contrast, the secondary contrasts, the harm check, the cost table
//        and the manipulation checks
//
// `--repo` and `--home` are required: the leakage check's protected roots must be the RECORDED machine's repository checkout and home
// directory (the committed analysis used the operator's own), because the captured tool calls hold those literal paths. They are
// used for matching and never written to the output.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndoCaptureEventsV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { piCassetteKeyV0 } from "../../../cli/cassette-session.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentPlannedTrialV0,
	readEndoExperimentRunRecordFileV0,
} from "../../../cli/experiment-artifacts.ts";
import { ENDO_MANIPULATION_WATCHED_FIELDS_V0, loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import type { EndoExperimentTrialResultV0 } from "../../../protocol/experiment-artifacts.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { spreadV0, wilson95V0 } from "../../../runtime/contracts/statistics.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";
import { parseEndoWorkspaceArchiveV0 } from "../../../storage/workspace-snapshot.ts";
import { HIDDEN_MARKER_PREFIX_V0, leakageOfTrialV0 } from "../../discriminating-tasks/1.0.1/leakage.ts";
import { manipulation as environmentChecks } from "../../pinned-environment/1.0.1/analyze.ts";
import { ARMS, type ArmIdV0, BRIEF_SENTENCE, PRIMARY_TASKS } from "./make-spec.ts";
import { chooseNV0, contrastV0, harmFlagV0, primaryContrastV0, shareV0 } from "./stats.ts";
import { parseWireV0, type WireSummaryV0 } from "./wire.ts";

const FIXTURE = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
/** Equal as canonical JSON; a missing value (undefined) equals only another missing value, and never throws. */
export function sameJsonV0(a: unknown, b: unknown): boolean {
	if (a === undefined || b === undefined) return a === b;
	return canonicalEndoJsonV0(a as never) === canonicalEndoJsonV0(b as never);
}

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
	/** The runner noted that agent_settled was not observed (the session hit the timeout), whatever the check said. */
	didNotFinish: boolean;
	responses: number;
	cutOffResponses: number;
	httpErrors: number;
	outputTokens: number;
	peakPromptTokens: number;
	generationMs: number;
	reasoningChars: number;
	contentChars: number;
	/** Characters of streamed tool calls (names and arguments): in the denominator of the reasoning share. */
	toolCallChars: number;
	outsideMentions: number;
	/** Per request: the cap sent, whether a template field was sent, and the structure of the request. */
	injectedProblems: string[];
	samplingFields: string[];
	workspaceProblems: string[];
	/** Per recorded request: the system message's text and a digest of the tools (null when absent). */
	systemTexts: (string | null)[];
	toolsDigests: (string | null)[];
	/** Per recorded request: a digest of the fields no arm may change (model, stream, stream_options, store). */
	baseDigests: string[];
	/** What the hidden check said, kept even when the trial is excluded as invalid (for the sensitivity analysis). */
	checkPassed: boolean | null;
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
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	return plan.flatMap((entry) => {
		const result = readEndoExperimentPlannedTrialV0(dir, entry);
		return result === null ? [] : [result];
	});
}

const STALE_CONNECTION = /closed the connection before this request arrived/;

/** The capture version a recording was made with (`capture.started`); recordings before it was written count as 1. */
function captureVersionOf(store: string): number {
	for (const event of readEndoCaptureEventsV0(store)) {
		if (event.producer !== "capture:record" || event.kind !== "capture.started") continue;
		const match = /^endo-capture\.(\d+)$/.exec(String((event.payload as { capture?: unknown }).capture ?? ""));
		return match === null ? 1 : Number(match[1]);
	}
	return 1;
}

/**
 * Each recorded response of a trial, read from its wire bytes, and the number of exchanges that failed without one.
 *
 * Recordings made with endo-capture.1 (the proxy that held one upstream connection per client connection): an exchange
 * with no bytes whose recorded error is that proxy's "the upstream had closed the connection before this request arrived"
 * is a retry of a stale connection (the retry is the next exchange), so it is neither a response nor a failure. That is
 * recovered from an English message because nothing else was recorded; it is kept for those historical recordings only.
 *
 * Recordings made with endo-capture.2 or later open an upstream connection per exchange, so that condition cannot occur:
 * every exchange without a response head, and every `upstream-error`, is a failure, whatever its message says.
 */
export function responsesOf(store: string): { responses: WireSummaryV0[]; failedExchanges: number } {
	const blobs = createEndoBlobStoreV0(join(store, "capture"), piCassetteKeyV0(FIXTURE), { readOnly: true });
	const historicalStale = captureVersionOf(store) < 2;
	const stale = (error: string | null | undefined) => historicalStale && STALE_CONNECTION.test(error ?? "");
	const responses: WireSummaryV0[] = [];
	let failedExchanges = 0;
	for (const event of readEndoCaptureEventsV0(store)) {
		if (event.producer !== "capture:record" || event.kind !== "capture.exchange-ended") continue;
		const payload = event.payload as {
			wire?: { digest: Parameters<typeof blobs.get>[0] };
			error?: string | null;
			outcome?: string;
		};
		const summary = payload.wire ? parseWireV0(blobs.get(payload.wire.digest)) : null;
		const hasResponse = summary !== null && summary.httpStatus !== null;
		if (hasResponse) responses.push(summary);
		// An upstream that drops after sending a response head is a failure too (a partial response), whatever the status said.
		if (payload.outcome === "upstream-error" && !(!hasResponse && stale(payload.error))) failedExchanges += 1;
		else if (!hasResponse && !stale(payload.error)) failedExchanges += 1;
	}
	return { responses, failedExchanges };
}

/** Every tool call's arguments and every tool result across all recorded requests, each once (by tool-call id). */
export function toolActivityAcross(requests: readonly Record<string, unknown>[]): {
	calls: string[];
	results: string[];
} {
	const calls = new Map<string, string>();
	const results = new Map<string, string>();
	for (const request of requests) {
		for (const [index, message] of messagesOf(request).entries()) {
			if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
				for (const call of message.tool_calls as {
					id?: string;
					function?: { name?: string; arguments?: unknown };
				}[])
					calls.set(
						call.id ?? `${index}:${calls.size}`,
						`${call.function?.name ?? ""} ${textOf(call.function?.arguments)}`,
					);
			}
			if (message.role === "tool")
				results.set(String(message.tool_call_id ?? `${index}:${results.size}`), textOf(message.content));
		}
	}
	return { calls: [...calls.values()], results: [...results.values()] };
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
	const run = readEndoExperimentRunRecordFileV0(dir);
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
			didNotFinish: result.notes.some((note) => /agent_settled was not observed/.test(note)),
			responses: 0,
			cutOffResponses: 0,
			httpErrors: 0,
			outputTokens: 0,
			peakPromptTokens: 0,
			generationMs: 0,
			reasoningChars: 0,
			contentChars: 0,
			toolCallChars: 0,
			outsideMentions: 0,
			injectedProblems: [] as string[],
			samplingFields: [] as string[],
			workspaceProblems: [] as string[],
			systemTexts: [] as (string | null)[],
			toolsDigests: [] as (string | null)[],
			baseDigests: [] as string[],
			checkPassed: result.check.ran ? result.check.passed : null,
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
		const { responses, failedExchanges } = responsesOf(store);
		const activity = toolActivityAcross(requests);
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
				if (!sameJsonV0(request[field], value))
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
				else if (Buffer.from(entry.base64, "base64").toString("utf8") !== task.workspace[path])
					workspaceProblems.push(`the snapshot's ${path} differs from the task's file`);
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
		const httpErrors = responses.filter((response) => (response.httpStatus ?? 0) >= 400).length + failedExchanges;
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
			toolCallChars: responses.reduce((sum, r) => sum + r.toolCallChars, 0),
			outsideMentions: leak.outsideMentions,
			injectedProblems,
			samplingFields: [...samplingFields],
			workspaceProblems,
			systemTexts: requests.map((request) => {
				const system = messagesOf(request)[0];
				return system?.role === "system" ? textOf(system.content) : null;
			}),
			toolsDigests: requests.map((request) => (request.tools === undefined ? null : sha(request.tools))),
			baseDigests: requests.map((request) =>
				sha({
					model: request.model ?? null,
					stream: request.stream ?? null,
					stream_options: request.stream_options ?? null,
					store: request.store ?? null,
				}),
			),
		});
	}
	return out;
}

const counted = (trial: TrialV0) => trial.class.kind === "success" || trial.class.kind === "failure";
const isSuccess = (trial: TrialV0) => trial.class.kind === "success";

/**
 * Per trial, its requests' values (system texts, tool digests, ...); how many trials have a request whose value is not the expected
 * one. A missing value (null) is a mismatch, and with no expected value (no reference could be established) every trial is.
 */
export function mismatchingTrialsV0(
	perTrial: readonly (readonly (string | null)[])[],
	expected: string | null,
): number {
	if (expected === null) return perTrial.length;
	return perTrial.filter((values) => values.some((value) => value !== expected)).length;
}

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
	// The descriptive measures use the counted trials only, like the success estimates: an excluded trial is not in them.
	const reasoning = kept.reduce((sum, t) => sum + t.reasoningChars, 0);
	const content = kept.reduce((sum, t) => sum + t.contentChars + t.toolCallChars, 0);
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
		cutOffTrialShare: shareV0(kept.filter((trial) => trial.cutOffResponses > 0).length, kept.length),
		timeouts: mine.filter((trial) => trial.didNotFinish).length,
		httpErrors: mine.reduce((sum, trial) => sum + trial.httpErrors, 0),
		reasoningShare: shareV0(reasoning, reasoning + content),
		outputTokens: spreadV0(kept.map((trial) => trial.outputTokens)),
		wallMs: spreadV0(kept.map((trial) => trial.wallMs)),
		peakPromptTokens: spreadV0(kept.map((trial) => trial.peakPromptTokens)),
		toolCalls: spreadV0(kept.map((trial) => trial.toolCalls)),
		outputTokensPerSuccess:
			successes === 0 ? null : round(kept.reduce((sum, t) => sum + t.outputTokens, 0) / successes),
		wallMsPerSuccess: successes === 0 ? null : round(kept.reduce((sum, t) => sum + t.wallMs, 0) / successes),
		outsideMentions: mine.reduce((sum, trial) => sum + trial.outsideMentions, 0),
	};
}

/** What failed for one arm in one path's manipulation checks (DESIGN §7: an arm that fails one is reported invalid). */
export function failedChecksOf(
	armChecks: {
		"M-inj": string[];
		"M-sys-trials-differing": number;
		"M-tools-trials-differing": number;
		"M-base-fields-trials-differing": number;
		"M1-sampling-fields": string[];
		"M-ws": string[];
	},
	m5Failures: number,
	m6Instances: number,
): string[] {
	const failed: string[] = [];
	if (armChecks["M-inj"].length > 0) failed.push("M-inj");
	if (armChecks["M-sys-trials-differing"] > 0) failed.push("M-sys");
	if (armChecks["M-tools-trials-differing"] > 0) failed.push("M-tools");
	if (armChecks["M-base-fields-trials-differing"] > 0) failed.push("M-base-fields");
	if (armChecks["M1-sampling-fields"].length > 0) failed.push("M1");
	if (armChecks["M-ws"].length > 0) failed.push("M-ws");
	if (m5Failures > 0) failed.push("M5");
	if (m6Instances > 0) failed.push("M6");
	return failed;
}

/** The manipulation checks of one run directory's trials (DESIGN §7). */
export function manipulationOf(dir: string, trials: readonly TrialV0[]) {
	const environment = environmentChecks(dir);
	const arms = [...new Set(trials.map((trial) => trial.arm))].sort() as ArmIdV0[];
	const reference = trials.find((trial) => trial.arm === "a" && trial.systemTexts.length > 0);
	const referenceSystem = reference?.systemTexts[0] ?? null;
	const referenceTools = reference?.toolsDigests[0] ?? null;
	const referenceBase = reference?.baseDigests[0] ?? null;
	const byArm = Object.fromEntries(
		arms.map((arm) => {
			const mine = trials.filter((trial) => trial.arm === arm);
			const expectedSystem =
				referenceSystem === null ? null : arm === "d" ? `${referenceSystem}\n\n${BRIEF_SENTENCE}` : referenceSystem;
			// Every request of every trial, not the first only; a request without the message or the tools counts as a mismatch.
			const sysProblems = mismatchingTrialsV0(
				mine.map((trial) => trial.systemTexts),
				expectedSystem,
			);
			const toolProblems = mismatchingTrialsV0(
				mine.map((trial) => trial.toolsDigests),
				referenceTools,
			);
			const baseProblems = mismatchingTrialsV0(
				mine.map((trial) => trial.baseDigests),
				referenceBase,
			);
			return [
				arm,
				{
					trials: mine.length,
					"M-inj": mine
						.flatMap((trial) => trial.injectedProblems.map((p) => `${trial.task}/#${trial.trial}: ${p}`))
						.slice(0, 10),
					"M-sys-trials-differing": sysProblems,
					"M-sys-requests-checked": mine.reduce((sum, trial) => sum + trial.systemTexts.length, 0),
					"M-tools-trials-differing": toolProblems,
					"M-base-fields-trials-differing": baseProblems,
					"M1-sampling-fields": [...new Set(mine.flatMap((trial) => trial.samplingFields))],
					"M-ws": mine
						.flatMap((trial) => trial.workspaceProblems.map((p) => `${trial.task}/#${trial.trial}: ${p}`))
						.slice(0, 10),
					cutOffResponseRate: shareV0(
						mine.reduce((s, t) => s + t.cutOffResponses, 0),
						mine.reduce((s, t) => s + t.responses, 0),
					),
					"session-did-not-finish": mine.filter((t) => t.didNotFinish).length,
					"server-errors": mine.reduce((sum, t) => sum + t.httpErrors, 0),
				},
			];
		}),
	);
	return { M5: environment.M5, M6: environment.M6, byArm };
}

/** The pilot: its gates, the per-cell wall times and N (DESIGN §6, §8). */
export function pilot(dir: string, roots: RootsV0) {
	const run = readEndoExperimentRunRecordFileV0(dir);
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
	// One mean wall time per (arm, task) cell of a set of arms; E is in the set only if it was kept (§6.3).
	const keptArms = arms.filter((arm) => arm !== "e" || eKept);
	const meansFor = (set: readonly ArmIdV0[]) =>
		set.flatMap((arm) =>
			run.spec.tasks.map((task) => {
				const mine = trials.filter((t) => t.arm === arm && t.task === task.id);
				return mine.reduce((sum, t) => sum + t.wallMs, 0) / Math.max(1, mine.length);
			}),
		);
	// §8: if even N = 3 exceeds the limit with every kept arm, drop arm C and redo the estimate.
	const allArms = chooseNV0(meansFor(keptArms));
	const withoutC = keptArms.includes("c") ? chooseNV0(meansFor(keptArms.filter((arm) => arm !== "c"))) : null;
	const mainArms = allArms.n === null && withoutC !== null ? keptArms.filter((arm) => arm !== "c") : keptArms;
	return {
		stage: "pilot",
		trials: trials.length,
		cells,
		manipulation: manipulationOf(dir, trials),
		eReasoningReductionVsA: eReduction,
		eKept,
		keptArms,
		estimate: { allArms, withoutArmC: withoutC, mainArms, droppedArmC: mainArms.length < keptArms.length },
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
		spec: readEndoExperimentRunRecordFileV0(join(dir, label)).spec,
	}));
	const spec = runs[0]!.spec;
	const arms = spec.conditions.map((condition) => armOf(condition.id));
	const all = runs.flatMap((run) => run.trials);
	const planned = spec.trials * labels.length;
	const cells = arms.flatMap((arm) => spec.tasks.map((task) => cell(arm, task.id, all, planned)));
	// The counts the registered analysis uses (invalid trials excluded) and, for the sensitivity, with each invalid trial counted by
	// what its hidden check said.
	const countsWith =
		(includeInvalid: boolean) => (arm: ArmIdV0, tasks: readonly string[], trials: readonly TrialV0[]) => {
			const kept = trials.filter(
				(t) =>
					t.arm === arm &&
					tasks.includes(t.task) &&
					(counted(t) || (includeInvalid && t.class.kind === "invalid")),
			);
			const passes = (t: TrialV0) => (t.class.kind === "invalid" ? t.checkPassed === true : isSuccess(t));
			return { successes: kept.filter(passes).length, counted: kept.length };
		};
	const counts = countsWith(false);
	const countsInvalidToo = countsWith(true);
	const pairsOf =
		(count: typeof counts) =>
		(arm: ArmIdV0, base: ArmIdV0, tasks: readonly string[], subset: typeof runs = runs) =>
			subset.map((run) => ({ control: count(base, tasks, run.trials), arm: count(arm, tasks, run.trials) }));
	const pairs = pairsOf(counts);
	const pairsInvalidToo = pairsOf(countsInvalidToo);
	// Secondary contrasts: counts and intervals, no reading (the fixed reading is for the primary contrast only).
	const contrast = (arm: ArmIdV0, base: ArmIdV0, tasks: readonly string[]) => contrastV0(pairs(arm, base, tasks));
	const primaryTasks = [...PRIMARY_TASKS];
	const withWilson = (c: { successes: number; counted: number }) => ({
		...c,
		...(c.counted === 0 ? {} : { wilson: wilson95V0(c.successes, c.counted).wilson95 }),
	});
	const manipulation = Object.fromEntries(
		runs.map((run) => [run.label, manipulationOf(join(dir, run.label), run.trials)]),
	);
	// DESIGN §7: an arm that fails a manipulation check is reported invalid, and nothing is reinterpreted. Collected over the paths.
	const armValidity = Object.fromEntries(
		arms.map((arm) => {
			const failedBy: Record<string, string[]> = {};
			const m6Trials: string[] = [];
			for (const [label, m] of Object.entries(manipulation)) {
				const byCondition = (check: { byCondition: Record<string, unknown> }) =>
					(check.byCondition[`arm-${arm}`] ?? {}) as { failures?: string[]; instances?: string[] };
				const m5 = byCondition(m.M5 as never).failures ?? [];
				const m6 = byCondition(m.M6 as never).instances ?? [];
				const failed = failedChecksOf(m.byArm[arm]!, m5.length, m6.length);
				if (failed.length > 0) failedBy[label] = failed;
				for (const instance of m6) m6Trials.push(`${label} ${instance.split(" request ")[0]}`);
			}
			const excluded = new Set(
				runs.flatMap((run) =>
					run.trials
						.filter((t) => t.class.kind === "invalid")
						.map((t) => `${run.label} ${t.task}/arm-${t.arm}/#${t.trial}`),
				),
			);
			const uniqueM6 = [...new Set(m6Trials)];
			return [
				arm,
				{
					valid: Object.keys(failedBy).length === 0,
					failedChecksByPath: failedBy,
					m6TrialsAreAllExcludedAsInvalid: uniqueM6.length > 0 && uniqueM6.every((t) => excluded.has(t)),
					m6Trials: uniqueM6,
				},
			];
		}),
	);
	const decorate = <
		T extends { control: { successes: number; counted: number }; arm: { successes: number; counted: number } },
	>(
		contrastResult: T,
	) => ({ ...contrastResult, control: withWilson(contrastResult.control), arm: withWilson(contrastResult.arm) });
	const secondary = arms
		.filter((arm) => arm !== "a")
		.map((arm) => ({
			arm,
			armValid: armValidity[arm]?.valid ?? false,
			vsA: decorate(contrast(arm, "a", primaryTasks)),
			vsB: arm === "c" && arms.includes("b") ? decorate(contrast("c", "b", primaryTasks)) : null,
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
	const bValid = armValidity.b?.valid ?? false;
	const primaryRaw = arms.includes("b") ? primaryContrastV0(pairs("b", "a", primaryTasks)) : null;
	// The reading of an arm that failed a check is not interpreted.
	const primary = primaryRaw && { ...primaryRaw, reading: bValid ? primaryRaw.reading : ("arm-invalid" as const) };
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
		// DESIGN §7: what the result would be if the leakage-invalid trials were counted (by their check), and what each path contributes.
		sensitivity: {
			invalidTrials: runs.flatMap((run) =>
				run.trials
					.filter((t) => t.class.kind === "invalid")
					.map((t) => ({ path: run.label, arm: t.arm, task: t.task, trial: t.trial, checkPassed: t.checkPassed })),
			),
			invalidCounted: {
				primary: arms.includes("b") ? primaryContrastV0(pairsInvalidToo("b", "a", primaryTasks)) : null,
				cells: arms.flatMap((arm) =>
					spec.tasks.map((task) => ({ arm, task: task.id, ...withWilson(countsInvalidToo(arm, [task.id], all)) })),
				),
				harm: arms
					.filter((arm) => arm !== "a")
					.flatMap((arm) =>
						spec.tasks
							.filter((task) => !PRIMARY_TASKS.includes(task.id as (typeof PRIMARY_TASKS)[number]))
							.map((task) => ({
								arm,
								task: task.id,
								flagged: harmFlagV0(
									countsInvalidToo(arm, [task.id], all),
									countsInvalidToo("a", [task.id], all),
								),
							})),
					),
			},
			leaveOnePathOut: labels.map((left) => ({
				left,
				...primaryContrastV0(
					pairsInvalidToo(
						"b",
						"a",
						primaryTasks,
						runs.filter((run) => run.label !== left),
					),
				),
			})),
		},
		armValidity,
		manipulation,
	};
}

/** A required option: the protected roots of the leakage check are the recorded machine's, never a silent default. */
function required(argv: readonly string[], name: string): string {
	const index = argv.indexOf(name);
	const value = index === -1 ? undefined : argv[index + 1];
	if (value === undefined || value.startsWith("--"))
		throw new TypeError(
			`${name} <dir> is required: the leakage check matches the recorded machine's repository and home`,
		);
	return resolve(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, target, ...rest] = process.argv.slice(2);
	let result: unknown;
	if ((command === "pilot" || command === "main") && target) {
		const roots = { repo: required(rest, "--repo"), home: required(rest, "--home") };
		result = command === "pilot" ? pilot(resolve(target), roots) : main(resolve(target), roots);
	} else {
		process.stderr.write("usage: analyze.ts pilot|main <dir> --repo <dir> --home <dir>\n");
		process.exit(2);
	}
	process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
}
