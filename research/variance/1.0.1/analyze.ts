// Post-run analysis for the variance study (DESIGN.md §9-§10):
//
//   node research/variance/1.0.1/analyze.ts estimate <pilot run dir>      mean wall time per (task, arm) and T(N)
//   node research/variance/1.0.1/analyze.ts spotcheck <run dir> --pi <p>  replay 3 seeded-random trials from cassettes
//   node research/variance/1.0.1/analyze.ts sensitivity <run dir>         scan request bodies and responses
//
// Each prints one JSON document on stdout.

import { readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndoCaptureEventsV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { replayPiCassetteSessionV0 } from "../../../cli/cassette-session.ts";
import type { EndoExperimentRunRecordV0, EndoExperimentTrialKeyV0, EndoExperimentTrialResultV0 } from "../../../cli/experiment.ts";
import type { EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { mulberry32V0, shuffleV0 } from "../../../runtime/contracts/statistics.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function trials(dir: string): EndoExperimentTrialResultV0[] {
	const plan = readJson<{ order: EndoExperimentTrialKeyV0[] }>(join(dir, "plan.json")).order;
	return plan.flatMap((entry) => {
		try {
			return [readJson<EndoExperimentTrialResultV0>(join(dir, "trials", entry.task, entry.condition, String(entry.trial), "result.json"))];
		} catch {
			return [];
		}
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
	const means = Object.fromEntries([...cells.entries()].sort().map(([key, values]) => [key, Math.round(values.reduce((a, b) => a + b, 0) / values.length)]));
	const perRound = Object.entries(means)
		.filter(([key]) => mainArms.includes(key.split("/")[1]!))
		.reduce((sum, [, ms]) => sum + ms, 0);
	const hours = (n: number) => Math.round(((n * perRound * 1.1) / 3_600_000) * 100) / 100;
	const candidates = [10, 12, 15, 20].map((n) => ({ n, hours: hours(n) }));
	return { meansMs: means, msPerRoundOfMainArms: perRound, estimateHours: candidates, chosen: [...candidates].reverse().find((c) => c.hours <= 10)?.n ?? null };
}

/** Three trials chosen by the run's ordering seed (DESIGN §10), replayed from their cassettes. */
export async function spotcheck(dir: string, pi: string) {
	const run = readJson<EndoExperimentRunRecordV0>(join(dir, "experiment.json"));
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
				tools: report.comparison.layers.tools.status,
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
	return { seed: run.seed, selection: "mulberry32(ordering seed), Fisher-Yates over completed trials in plan order, first three", replays: out };
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
				const entry = (hits[name] ??= { count: 0, examples: [] });
				entry.count += 1;
				const context = text.slice(Math.max(0, found.index! - 40), found.index! + found[0].length + 40).replace(/\s+/g, " ");
				if (entry.examples.length < 3 && !entry.examples.some((example) => example.includes(found[0]))) entry.examples.push(`${where}: …${context}…`);
			}
		}
		for (const found of text.matchAll(/\/(?:tmp|usr|home|var|etc|opt|root|run)\/[A-Za-z0-9._@\/+-]*/g))
			paths.add(found[0].replace(/(\/tmp\/endo-experiment-[0-9a-f]+)\/.*/, "$1/…").replace(/(pi-coding-agent)\/.*/, "$1/…"));
	};
	for (const trial of trials(dir)) {
		const store = join(dir, trial.store);
		const blobs = createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true });
		const where = `${trial.task}/${trial.condition}/#${trial.trial}`;
		for (const event of readEndoCaptureEventsV0(store)) {
			if (event.producer !== "capture:record") continue;
			const payload = event.payload as { body?: { digest: EndoKeyedDigestV0 }; wire?: { digest: EndoKeyedDigestV0 }; headers?: unknown };
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
	return { requests, responses, distinctSystemPrompts: systemPrompts.size, hits, absolutePaths: [...paths].sort(), checkedFor: patterns.map(([name]) => name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [command, dir] = process.argv.slice(2);
	const piIndex = process.argv.indexOf("--pi");
	const run = async () => {
		if (command === "estimate") return estimate(dir!);
		if (command === "spotcheck") return spotcheck(dir!, process.argv[piIndex + 1]!);
		if (command === "sensitivity") return sensitivity(dir!);
		throw new TypeError("usage: analyze.ts estimate|spotcheck|sensitivity <run dir> [--pi path]");
	};
	run().then(
		(value) => process.stdout.write(`${JSON.stringify(value, null, "\t")}\n`),
		(error: unknown) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(1);
		},
	);
}
