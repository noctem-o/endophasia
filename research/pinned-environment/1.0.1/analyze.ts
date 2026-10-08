// Analysis for the pinned-environment study (DESIGN.md §5, §6, §9, §10), beside `endo experiment report` (which
// computes §6.1-§6.8 and M1-M3):
//
//   node research/pinned-environment/1.0.1/analyze.ts estimate <pilot run dir>     mean wall time per cell and T(N)
//   node research/pinned-environment/1.0.1/analyze.ts manipulation <run dir>       M5 (environment as the arm says)
//                                                                                  and M6 (the reporter in effect)
//   node research/pinned-environment/1.0.1/analyze.ts divergence <run dir>         §6.9 first difference per pair, and
//                                                                                  §6.10 residual environment by source
//   node research/pinned-environment/1.0.1/analyze.ts spotcheck <run dir> --pi <p> [--trials t/c/#n,...]
//                                                                                  §10: replay 3 seeded-random trials
//                                                                                  (or the named ones) from cassettes
//   node research/pinned-environment/1.0.1/analyze.ts sensitivity <run dir>        E2's scan of bodies and responses
//
// Each prints one JSON document on stdout.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndoCaptureEventsV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { replayPiCassetteSessionV0 } from "../../../cli/cassette-session.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentPlannedTrialV0,
	readEndoExperimentRunRecordFileV0,
} from "../../../cli/experiment-artifacts.ts";
import { loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import type { EndoExperimentTrialResultAnyV0 } from "../../../protocol/experiment-artifacts.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { mulberry32V0, shuffleV0 } from "../../../runtime/contracts/statistics.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";
import { parseEndoWorkspaceArchiveV0 } from "../../../storage/workspace-snapshot.ts";
import { sensitivity } from "../../variance/1.0.1/analyze.ts";

const FIXTURE = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };

function trials(dir: string): EndoExperimentTrialResultAnyV0[] {
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	return plan.flatMap((entry) => {
		// A trial that never ran has no result; one that has a result the reader refuses is an error, not a gap.
		const result = readEndoExperimentPlannedTrialV0(dir, entry);
		return result === null ? [] : [result];
	});
}

const label = (trial: EndoExperimentTrialResultAnyV0) => `${trial.task}/${trial.condition}/#${trial.trial}`;

/** Mean wall time per (task, condition) and T(N) over all 12 cells (DESIGN §9). */
export function estimate(dir: string) {
	const cells = new Map<string, number[]>();
	for (const trial of trials(dir)) {
		const key = `${trial.task}/${trial.condition}`;
		cells.set(key, [...(cells.get(key) ?? []), Date.parse(trial.endedAt) - Date.parse(trial.startedAt)]);
	}
	const means = Object.fromEntries(
		[...cells.entries()]
			.sort()
			.map(([key, values]) => [key, Math.round(values.reduce((a, b) => a + b, 0) / values.length)]),
	);
	const perRound = Object.values(means).reduce((sum, ms) => sum + ms, 0);
	const hours = (n: number) => Math.round(((n * perRound * 1.1) / 3_600_000) * 100) / 100;
	const candidates = [10, 12, 15, 20].map((n) => ({ n, hours: hours(n) }));
	return {
		meansMs: means,
		msPerRound: perRound,
		estimateHours: candidates,
		chosen: [...candidates].reverse().find((c) => c.hours <= 10)?.n ?? null,
	};
}

/** Every tool result's text in a request body. */
function toolTexts(request: Record<string, unknown>): string[] {
	const messages = Array.isArray(request.messages) ? (request.messages as Record<string, unknown>[]) : [];
	return messages
		.filter((message) => message.role === "tool")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? (message.content as { text?: string }[]).map((part) => part.text ?? "").join("")
					: "",
		);
}

/** A duration printed by one of Node's own test reporters (DESIGN §5, M6). */
export const NODE_REPORTER_DURATION_V0 = /duration_ms|^[✔✖].*\(\d+(?:\.\d+)?ms\)\s*$/mu;

/**
 * M5: each trial's recorded environment and snapshot match its arm (pinned: the spec's variables with {root} resolved,
 * the reporter's sha256, every snapshot entry and the root at the fixed time; unpinned: no environment, no env/).
 * M6: no tool result in any request of a pinned arm carries a duration from Node's reporters.
 */
export function manipulation(dir: string) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
	const m5: Record<string, { trials: number; failures: string[] }> = {};
	const m6: Record<string, { trials: number; requests: number; instances: string[] }> = {};
	for (const trial of trials(dir).filter((entry) => entry.status === "completed")) {
		const condition = run.spec.conditions.find((entry) => entry.id === trial.condition)!;
		const store = join(dir, trial.store);
		const events = readEndoCaptureEventsV0(store);
		const recorded = events.find((event) => event.kind === "capture.environment")?.payload as
			| { variables: Record<string, string>; fileTime: string | null; files: Record<string, { sha256: string }> }
			| undefined;
		const snapshot = events.find((event) => event.kind === "capture.workspace-snapshot")!.payload as unknown as {
			scratchRoot: string;
			archive: { digest: EndoKeyedDigestV0 };
		};
		const archive = parseEndoWorkspaceArchiveV0(
			createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true }).get(snapshot.archive.digest),
		);
		const failures: string[] = [];
		const pinned = condition.environment;
		if (pinned === undefined) {
			if (recorded !== undefined) failures.push("an environment was recorded for an unpinned arm");
			if (archive.entries.some((entry) => entry.path === "env" || entry.path.startsWith("env/")))
				failures.push("the snapshot of an unpinned arm holds env/");
		} else if (recorded === undefined) failures.push("no environment was recorded");
		else {
			const expected = Object.fromEntries(
				Object.entries(pinned.variables ?? {}).map(([name, value]) => [
					name,
					value.replaceAll("{root}", snapshot.scratchRoot),
				]),
			);
			if (canonicalEndoJsonV0(recorded.variables) !== canonicalEndoJsonV0(expected))
				failures.push(
					`variables ${canonicalEndoJsonV0(recorded.variables)}, expected ${canonicalEndoJsonV0(expected)}`,
				);
			for (const [path, content] of Object.entries(pinned.files ?? {}))
				if (recorded.files[path]?.sha256 !== sha256HexV0(content)) failures.push(`env/${path}: sha256 differs`);
			const time = Date.parse(pinned.fileTime!);
			if (archive.rootMtimeMs !== time) failures.push(`the scratch root's time is ${archive.rootMtimeMs}`);
			const off = archive.entries.filter((entry) => entry.mtimeMs !== time).map((entry) => entry.path);
			if (off.length > 0)
				failures.push(`${off.length} snapshot entries not at the fixed time: ${off.slice(0, 5).join(", ")}`);
		}
		m5[trial.condition] ??= { trials: 0, failures: [] };
		const cellM5 = m5[trial.condition]!;
		cellM5.trials += 1;
		cellM5.failures.push(...failures.map((failure) => `${label(trial)}: ${failure}`));
		if (pinned !== undefined) {
			const { requests } = loadEndoTrialRequestsV0(store, trial, FIXTURE);
			m6[trial.condition] ??= { trials: 0, requests: 0, instances: [] };
			const cellM6 = m6[trial.condition]!;
			cellM6.trials += 1;
			cellM6.requests += requests.length;
			for (const [index, request] of requests.entries())
				for (const text of toolTexts(request)) {
					const match = text.match(NODE_REPORTER_DURATION_V0);
					if (match) cellM6.instances.push(`${label(trial)} request ${index + 1}: ${match[0].slice(0, 120)}`);
				}
		}
	}
	return {
		M5: {
			status: Object.values(m5).every((cell) => cell.failures.length === 0) ? "PASS" : "FAIL",
			byCondition: m5,
		},
		M6: {
			status: Object.values(m6).every((cell) => cell.instances.length === 0) ? "PASS" : "MANIPULATION INCOMPLETE",
			byCondition: Object.fromEntries(
				Object.entries(m6).map(([condition, cell]) => [
					condition,
					{
						...cell,
						instances: [...new Set(cell.instances)],
						status: cell.instances.length === 0 ? "PASS" : "MANIPULATION INCOMPLETE",
					},
				]),
			),
		},
	};
}

/**
 * The server generates a random id for every tool call (an opaque correlation token, not a model choice), so before
 * comparing, each id (`tool_calls[].id`, `tool_call_id`) is replaced by its ordinal of first appearance in the trial.
 * Nothing else is normalized. (As in E2's exploratory analysis.)
 */
export function normalizeToolCallIds(requests: Record<string, unknown>[]): Record<string, unknown>[] {
	const ids = new Map<string, string>();
	const ordinal = (id: unknown) => {
		if (typeof id !== "string") return id;
		if (!ids.has(id)) ids.set(id, `call-${ids.size + 1}`);
		return ids.get(id)!;
	};
	return requests.map((request) => {
		const messages = Array.isArray(request.messages) ? (request.messages as Record<string, unknown>[]) : [];
		return {
			...request,
			messages: messages.map((message) => {
				const next: Record<string, unknown> = { ...message };
				if (Array.isArray(message.tool_calls))
					next.tool_calls = (message.tool_calls as Record<string, unknown>[]).map((call) => ({
						...call,
						id: ordinal(call.id),
					}));
				if ("tool_call_id" in message) next.tool_call_id = ordinal(message.tool_call_id);
				return next;
			}),
		};
	});
}

const DURATION = /duration_ms|\d+(?:\.\d+)?\s?m?s\b/;
const CLOCK =
	/\b\d{1,2}:\d{2}(?::\d{2})?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/;
const WORD = /[0-9A-Za-z_.:-]/;

/**
 * §6.10: classify two differing tool-result texts by their first difference. The differing word is the run of
 * letters, digits, `_`, `.`, `:` and `-` around the first differing character (a month and day just before a time of day
 * are included), on each side. The first rule that matches either side's word wins: duration (a number followed by
 * `ms` or `s`, `duration_ms`, or a number labelled `duration_ms` just before it), clock time (a time of day HH:MM, a month and day, or a date YYYY-MM-DD), otherwise
 * other (with the words as an excerpt).
 */
export function residualSourceV0(
	a: string,
	b: string,
): { source: "duration" | "clock time" | "other"; words: [string, string] } {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
	const word = (text: string) => {
		let from = start;
		let to = start;
		while (from > 0 && WORD.test(text[from - 1]!)) from -= 1;
		while (to < text.length && WORD.test(text[to]!)) to += 1;
		if (to === from && to < text.length) to += 1;
		const month = text
			.slice(Math.max(0, from - 8), from)
			.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+$/);
		if (month) from -= month[0].length;
		return text.slice(from, to);
	};
	const words: [string, string] = [word(a), word(b)];
	// A number labelled by the word before it ("duration_ms 55.8", TAP's "duration_ms: 0.59") is that label's.
	const labelled = (text: string) =>
		/duration_ms:?\s+$/.test(
			text.slice(Math.max(0, text.lastIndexOf("\n", start) + 1), start).replace(/[0-9.]+$/, ""),
		);
	const source =
		words.some((text) => DURATION.test(text)) || labelled(a) || labelled(b)
			? "duration"
			: words.some((text) => CLOCK.test(text))
				? "clock time"
				: "other";
	return { source, words: [words[0].slice(0, 160), words[1].slice(0, 160)] };
}

/**
 * §6.9 and §6.10. For each pair of trials in a cell: walk their requests (tool-call ids normalized) to the first one
 * whose canonical body differs, and in it the first differing message. model = an assistant message (the requests
 * before were identical, so the model answered identical input differently); environment = a tool result; identical
 * = every request identical (the same number, all equal); other = anything else, with its reason (for example one
 * trial ended after requests identical to the other's). Environment pairs are classified by residual source.
 */
export function divergence(dir: string) {
	const byCell = new Map<string, { trial: EndoExperimentTrialResultAnyV0; requests: Record<string, unknown>[] }[]>();
	for (const trial of trials(dir).filter((entry) => entry.status === "completed")) {
		const loaded = loadEndoTrialRequestsV0(join(dir, trial.store), trial, FIXTURE);
		const cell = `${trial.task}/${trial.condition}`;
		byCell.set(cell, [...(byCell.get(cell) ?? []), { trial, requests: normalizeToolCallIds(loaded.requests) }]);
	}
	const canonical = (value: unknown) => canonicalEndoJsonV0(value);
	const cells: Record<string, unknown> = {};
	for (const [cell, members] of [...byCell.entries()].sort()) {
		const firstDifference: Record<string, number> = { model: 0, environment: 0, identical: 0, other: 0 };
		const residual: Record<string, number> = { duration: 0, "clock time": 0, other: 0 };
		const firstRequest: Record<string, number> = {};
		const otherReasons: Record<string, number> = {};
		const examples: string[] = [];
		const residualExamples: string[] = [];
		for (let i = 0; i < members.length; i += 1)
			for (let j = i + 1; j < members.length; j += 1) {
				const a = members[i]!.requests;
				const b = members[j]!.requests;
				const pair = `#${members[i]!.trial.trial} vs #${members[j]!.trial.trial}`;
				const shared = Math.min(a.length, b.length);
				let k = 0;
				while (k < shared && canonical(a[k]) === canonical(b[k])) k += 1;
				if (k === shared) {
					if (a.length === b.length) firstDifference.identical! += 1;
					else {
						firstDifference.other! += 1;
						const reason = "one trial ended after requests identical to the other's";
						otherReasons[reason] = (otherReasons[reason] ?? 0) + 1;
					}
					continue;
				}
				firstRequest[String(k + 1)] = (firstRequest[String(k + 1)] ?? 0) + 1;
				const ma = (a[k]!.messages ?? []) as Record<string, unknown>[];
				const mb = (b[k]!.messages ?? []) as Record<string, unknown>[];
				let m = 0;
				while (m < Math.min(ma.length, mb.length) && canonical(ma[m]) === canonical(mb[m])) m += 1;
				const role = (ma[m]?.role ?? mb[m]?.role) as string | undefined;
				if (role === "assistant") firstDifference.model! += 1;
				else if (role === "tool") {
					firstDifference.environment! += 1;
					const text = (message: Record<string, unknown> | undefined) =>
						message === undefined ? "" : (toolTexts({ messages: [message] })[0] ?? "");
					const classified = residualSourceV0(text(ma[m]), text(mb[m]));
					residual[classified.source]! += 1;
					if (residualExamples.length < 3)
						residualExamples.push(
							`${pair}: request ${k + 1}, ${classified.source}: ${JSON.stringify(classified.words[0])} against ${JSON.stringify(classified.words[1])}`,
						);
				} else {
					firstDifference.other! += 1;
					const reason = role === undefined ? "other request fields" : `a ${role} message`;
					otherReasons[reason] = (otherReasons[reason] ?? 0) + 1;
				}
				if (examples.length < 3)
					examples.push(`${pair}: request ${k + 1}, message ${m + 1} (${role ?? "other fields"})`);
			}
		cells[cell] = {
			trials: members.length,
			pairs: (members.length * (members.length - 1)) / 2,
			firstDifference,
			otherReasons,
			firstDifferingRequest: firstRequest,
			residualEnvironment: residual,
			examples,
			residualExamples,
		};
	}
	return {
		normalization:
			"tool-call ids (server-generated random tokens) replaced by their ordinal of first appearance in each trial; nothing else",
		cells,
	};
}

/** §10: three trials chosen by the run's ordering seed (or the named ones), replayed from their cassettes. */
export async function spotcheck(dir: string, pi: string, named: string[] = []) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const completed = trials(dir).filter((trial) => trial.status === "completed" && trial.session !== null);
	const chosen =
		named.length > 0
			? named.map((name) => {
					const found = completed.find((trial) => label(trial) === name);
					if (found === undefined) throw new TypeError(`no completed trial ${name}`);
					return found;
				})
			: shuffleV0(completed, mulberry32V0(run.seed)).slice(0, 3);
	const out = [];
	for (const trial of chosen) {
		const scratch = mkdtempSync(join(tmpdir(), "endo-spotcheck-"));
		try {
			const report = await replayPiCassetteSessionV0({
				store: join(dir, trial.store),
				out: join(scratch, "replay"),
				pi,
				timing: "immediate",
				keySource: FIXTURE,
				timeoutMs: 600_000,
			});
			out.push({
				trial: label(trial),
				lifecycle: report.comparison.layers.lifecycle.status,
				toolCalls: report.comparison.layers.toolCalls.status,
				toolResults: report.comparison.layers.toolResults.status,
				outcome: report.comparison.layers.outcome.status,
				served: report.served,
				misses: report.misses,
				unserved: report.unserved,
				missDetails: report.missDetails,
				flags: report.comparison.flags.map((flag) => flag.kind),
				notes: report.notes,
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	return {
		seed: run.seed,
		selection:
			named.length > 0
				? "named trials"
				: "mulberry32(ordering seed), Fisher-Yates over completed trials in plan order, first three",
		replays: out,
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
		if (command === "manipulation") return manipulation(dir!);
		if (command === "divergence") return divergence(dir!);
		if (command === "spotcheck") return spotcheck(dir!, option("--pi")!, option("--trials")?.split(",") ?? []);
		if (command === "sensitivity") return sensitivity(dir!);
		throw new TypeError(
			"usage: analyze.ts estimate|manipulation|divergence|spotcheck|sensitivity <run dir> [--pi path] [--trials t/c/#n,...]",
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
