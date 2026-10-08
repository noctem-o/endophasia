// Post-run analysis for the variance study (DESIGN.md §9-§10):
//
//   node research/variance/1.0.1/analyze.ts estimate <pilot run dir>      mean wall time per (task, arm) and T(N)
//   node research/variance/1.0.1/analyze.ts spotcheck <run dir> --pi <p>  replay 3 seeded-random trials from cassettes
//   node research/variance/1.0.1/analyze.ts sensitivity <run dir>         scan request bodies and responses
//   node research/variance/1.0.1/analyze.ts divergence <run dir>          EXPLORATORY (DESIGN §12, deviation 1): where
//                                                                          pairs of trials first diverge in their requests
//
// Each prints one JSON document on stdout.

import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
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
import { trajectoryFromStoreV0 } from "../../../cli/trajectory.ts";
import type { EndoExperimentTrialResultAnyV0 } from "../../../protocol/experiment-artifacts.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { mulberry32V0, shuffleV0, wilson95V0 } from "../../../runtime/contracts/statistics.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";

function trials(dir: string): EndoExperimentTrialResultAnyV0[] {
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	return plan.flatMap((entry) => {
		// A trial that never ran has no result; one that has a result the reader refuses is an error, not a gap.
		const result = readEndoExperimentPlannedTrialV0(dir, entry);
		return result === null ? [] : [result];
	});
}

/** Mean wall time per (task, condition) from result start and end times, and T(N) for the main arms (DESIGN §9). */
export function estimate(dir: string, mainArms = ["a", "b", "b-c"]) {
	const cells = new Map<string, number[]>();
	for (const trial of trials(dir)) {
		const ms = Date.parse(trial.endedAt) - Date.parse(trial.startedAt);
		const key = `${trial.task}/${trial.condition}`;
		cells.set(key, [...(cells.get(key) ?? []), ms]);
	}
	const means = Object.fromEntries(
		[...cells.entries()]
			.sort()
			.map(([key, values]) => [key, Math.round(values.reduce((a, b) => a + b, 0) / values.length)]),
	);
	const perRound = Object.entries(means)
		.filter(([key]) => mainArms.includes(key.split("/")[1]!))
		.reduce((sum, [, ms]) => sum + ms, 0);
	const hours = (n: number) => Math.round(((n * perRound * 1.1) / 3_600_000) * 100) / 100;
	const candidates = [10, 12, 15, 20].map((n) => ({ n, hours: hours(n) }));
	return {
		meansMs: means,
		msPerRoundOfMainArms: perRound,
		estimateHours: candidates,
		chosen: [...candidates].reverse().find((c) => c.hours <= 10)?.n ?? null,
	};
}

/** Three trials chosen by the run's ordering seed (DESIGN §10), replayed from their cassettes. */
export async function spotcheck(dir: string, pi: string) {
	const run = readEndoExperimentRunRecordFileV0(dir);
	const completed = trials(dir).filter((trial) => trial.status === "completed" && trial.session !== null);
	const chosen = shuffleV0(completed, mulberry32V0(run.seed)).slice(0, 3);
	const out = [];
	for (const trial of chosen) {
		const scratch = mkdtempSync(join(tmpdir(), "endo-spotcheck-"));
		try {
			const report = await replayPiCassetteSessionV0({
				store: join(dir, trial.store),
				out: join(scratch, "replay"),
				pi,
				timing: "immediate",
				keySource: { kind: "fixture", path: endoFixtureDigestKeyPathV0() },
				timeoutMs: 600_000,
			});
			out.push({
				trial: `${trial.task}/${trial.condition}/#${trial.trial}`,
				lifecycle: report.comparison.layers.lifecycle.status,
				toolCalls: report.comparison.layers.toolCalls.status,
				toolResults: report.comparison.layers.toolResults.status,
				outcome: report.comparison.layers.outcome.status,
				served: report.served,
				misses: report.misses,
				unserved: report.unserved,
				flags: report.comparison.flags.map((flag) => flag.kind),
				notes: report.notes,
			});
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	return {
		seed: run.seed,
		selection: "mulberry32(ordering seed), Fisher-Yates over completed trials in plan order, first three",
		replays: out,
	};
}

/** Scan every request body and response wire for what must not be committed (DESIGN §10). */
export function sensitivity(dir: string) {
	const key = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0());
	const user = userInfo().username;
	const host = hostname();
	const patterns: [string, RegExp][] = [
		["username", new RegExp(`\\b${user}\\b`)],
		["hostname", new RegExp(`\\b${host}\\b`)],
		["home directory", /\/home\/[A-Za-z0-9._-]+/],
		["root home", /\/root\b/],
		["bearer or key", /Bearer\s+(?!local\b)\S+|sk-[A-Za-z0-9]{8,}|api[_-]?key"\s*:\s*"(?!local")/i],
		["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
		["LAN address", /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/],
		["ISO date", /\b20\d\d-\d\d-\d\d\b/],
		["ls-style date", /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d\d:\d\d|\d{4})\b/],
		["kernel or OS string", /linux \d+\.\d+\.\d+|x-stainless-os|Darwin|Windows NT/i],
	];
	const hits: Record<string, { count: number; examples: string[] }> = {};
	const paths = new Set<string>();
	const systemPrompts = new Set<string>();
	let requests = 0;
	let responses = 0;
	const scan = (where: string, text: string) => {
		for (const [name, pattern] of patterns) {
			const match = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
			for (const found of text.matchAll(match)) {
				if (hits[name] === undefined) hits[name] = { count: 0, examples: [] };
				const entry = hits[name]!;
				entry.count += 1;
				const context = text
					.slice(Math.max(0, found.index! - 40), found.index! + found[0].length + 40)
					.replace(/\s+/g, " ");
				if (entry.examples.length < 3 && !entry.examples.some((example) => example.includes(found[0])))
					entry.examples.push(`${where}: …${context}…`);
			}
		}
		for (const found of text.matchAll(/\/(?:tmp|usr|home|var|etc|opt|root|run)\/[A-Za-z0-9._@/+-]*/g))
			paths.add(
				found[0].replace(/(\/tmp\/endo-experiment-[0-9a-f]+)\/.*/, "$1/…").replace(/(pi-coding-agent)\/.*/, "$1/…"),
			);
	};
	for (const trial of trials(dir)) {
		const store = join(dir, trial.store);
		const blobs = createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true });
		const where = `${trial.task}/${trial.condition}/#${trial.trial}`;
		for (const event of readEndoCaptureEventsV0(store)) {
			if (event.producer !== "capture:record") continue;
			const payload = event.payload as {
				body?: { digest: EndoKeyedDigestV0 };
				wire?: { digest: EndoKeyedDigestV0 };
				headers?: unknown;
			};
			if (event.kind === "capture.request" && payload.body) {
				requests += 1;
				const text = Buffer.from(blobs.get(payload.body.digest)).toString("utf8");
				scan(`${where} request`, text);
				scan(`${where} request headers`, JSON.stringify(payload.headers ?? []));
				const system = (JSON.parse(text) as { messages?: { content?: unknown }[] }).messages?.[0]?.content;
				systemPrompts.add(typeof system === "string" ? system : JSON.stringify(system));
			}
			if (event.kind === "capture.exchange-ended" && payload.wire) {
				responses += 1;
				scan(`${where} response`, Buffer.from(blobs.get(payload.wire.digest)).toString("utf8"));
			}
		}
	}
	return {
		requests,
		responses,
		distinctSystemPrompts: systemPrompts.size,
		hits,
		absolutePaths: [...paths].sort(),
		checkedFor: patterns.map(([name]) => name),
	};
}

/**
 * EXPLORATORY (DESIGN §12, deviation 1). For every pair of completed trials in a (task, arm) cell, walk their requests
 * in order (the arm's injected fields are part of both, so they never differ) and find the first request whose canonical
 * JSON differs, then the first differing message in it:
 *   assistant -> "model": the previous requests were identical, yet the model's reply differed
 *   tool      -> "environment": the replies were identical so far, but a tool returned different output
 *   other     -> "other" (a user or system message, or the request's other fields)
 * Pairs whose requests are identical over the shorter trial: "identical requests" (any difference is in the final
 * reply, which no later request shows, or nowhere).
 *
 * Normalization: the server generates a random id for every tool call (an opaque correlation token, not a model
 * choice), so before comparing, each id (`tool_calls[].id`, `tool_call_id`) is replaced by its ordinal of first
 * appearance in the trial (call-1, call-2, ...). Nothing else is normalized.
 */
function normalizeToolCallIds(requests: Record<string, unknown>[]): Record<string, unknown>[] {
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
export function divergence(dir: string) {
	const key = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
	const completed = trials(dir).filter((trial) => trial.status === "completed");
	const byCell = new Map<string, { trial: EndoExperimentTrialResultAnyV0; requests: Record<string, unknown>[] }[]>();
	for (const trial of completed) {
		const loaded = loadEndoTrialRequestsV0(join(dir, trial.store), trial, key);
		const cell = `${trial.task}/${trial.condition}`;
		byCell.set(cell, [...(byCell.get(cell) ?? []), { trial, requests: normalizeToolCallIds(loaded.requests) }]);
	}
	const canonical = (value: unknown) => canonicalEndoJsonV0(value);
	const cells: Record<string, unknown> = {};
	for (const [cell, members] of [...byCell.entries()].sort()) {
		const sources: Record<string, number> = { model: 0, environment: 0, other: 0, "identical requests": 0 };
		const firstRequest: Record<string, number> = {};
		const examples: string[] = [];
		for (let i = 0; i < members.length; i += 1)
			for (let j = i + 1; j < members.length; j += 1) {
				const a = members[i]!.requests;
				const b = members[j]!.requests;
				const shared = Math.min(a.length, b.length);
				let k = 0;
				while (k < shared && canonical(a[k]) === canonical(b[k])) k += 1;
				if (k === shared) {
					sources["identical requests"]! += 1;
					continue;
				}
				firstRequest[String(k + 1)] = (firstRequest[String(k + 1)] ?? 0) + 1;
				const ma = (a[k]!.messages ?? []) as { role?: string }[];
				const mb = (b[k]!.messages ?? []) as { role?: string }[];
				let m = 0;
				while (m < Math.min(ma.length, mb.length) && canonical(ma[m]) === canonical(mb[m])) m += 1;
				const role = ma[m]?.role ?? mb[m]?.role;
				const source = role === "assistant" ? "model" : role === "tool" ? "environment" : "other";
				sources[source]! += 1;
				if (examples.length < 3)
					examples.push(
						`#${members[i]!.trial.trial} vs #${members[j]!.trial.trial}: request ${k + 1}, message ${m + 1} (${role ?? "other fields"})`,
					);
			}
		cells[cell] = {
			trials: members.length,
			pairs: (members.length * (members.length - 1)) / 2,
			firstDifferingMessage: sources,
			firstDifferingRequest: firstRequest,
			examples,
		};
	}
	return {
		exploratory: "DESIGN §12 deviation 1: not a pre-registered metric",
		normalization:
			"tool-call ids (server-generated random tokens) replaced by their ordinal of first appearance in each trial; nothing else",
		cells,
	};
}

/**
 * EXPLORATORY (DESIGN §12, deviation 1). The tools layer with result digests left out: per (task, arm), the modal
 * agreement (95% Wilson) and the number of distinct sequences of (tool name, keyed argument digest). It separates "the
 * same calls with different outputs" from "different calls".
 */
export function calls(dir: string) {
	const completed = trials(dir).filter((trial) => trial.status === "completed" && trial.session !== null);
	const byCell = new Map<string, string[]>();
	for (const trial of completed) {
		const trajectory = trajectoryFromStoreV0(join(dir, trial.store), trial.session!, { label: trial.store });
		const tools = trajectory.layers.toolCalls;
		const sequence =
			tools.status === "reported"
				? canonicalEndoJsonV0(tools.entries.map((entry) => ({ name: entry.name, args: entry.argsDigest })))
				: "UNAVAILABLE";
		const cell = `${trial.task}/${trial.condition}`;
		byCell.set(cell, [...(byCell.get(cell) ?? []), sequence]);
	}
	const cells: Record<string, unknown> = {};
	for (const [cell, sequences] of [...byCell.entries()].sort()) {
		const counts = new Map<string, number>();
		for (const sequence of sequences) counts.set(sequence, (counts.get(sequence) ?? 0) + 1);
		cells[cell] = {
			trials: sequences.length,
			distinctCallSequences: counts.size,
			modalAgreement: wilson95V0(Math.max(...counts.values()), sequences.length),
		};
	}
	return { exploratory: "DESIGN §12 deviation 1: not a pre-registered metric", cells };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, dir] = process.argv.slice(2);
	const piIndex = process.argv.indexOf("--pi");
	const run = async () => {
		if (command === "estimate") return estimate(dir!);
		if (command === "spotcheck") return spotcheck(dir!, process.argv[piIndex + 1]!);
		if (command === "sensitivity") return sensitivity(dir!);
		if (command === "divergence") return divergence(dir!);
		if (command === "calls") return calls(dir!);
		throw new TypeError("usage: analyze.ts estimate|spotcheck|sensitivity|divergence|calls <run dir> [--pi path]");
	};
	run().then(
		(value) => process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`),
		(error: unknown) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(1);
		},
	);
}
