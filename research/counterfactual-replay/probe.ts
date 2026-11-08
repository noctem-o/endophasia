// COUNTERFACTUAL-REPLAY-001 feasibility probe (research/counterfactual-replay/COUNTERFACTUAL-REPLAY-001.md, §5). Two measurements on
// EVAL-ISO-002 model-connected trials (research/protected-eval/model-connected/trial.ts), each a new trial directory:
//
//   repeat  run the same task from the same initial state N more times against the LIVE model: does the model's decision sequence
//           reproduce? (decision reproduction)
//   replay  run the same task against the source trial's CASSETTE instead of the model: does Pi send the recorded requests, so that the
//           recorded responses can be served? (deterministic cassette replay)
//
//   node research/counterfactual-replay/probe.ts repeat --source <trial> --times 3 --out <dir> --pi-dist <dist> --upstream <origin> --prompt <text>
//   node research/counterfactual-replay/probe.ts replay --source <trial> --out <dir> --pi-dist <dist> --prompt <text>
//
// It writes `<out>/summary.json`: counts, plain sha256 of canonical request bodies (computed locally, comparable across trials whose
// keyed digests are not), tool-call sequences (names and argument digests), workspace and answer digests, and for a replay the cassette's
// served/miss counters and where the first replayed request diverged from the recorded one. No prompt, answer or body text.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../../adapters/openai-proxy/capture-log.ts";
import {
	endoRequestDivergenceV0,
	loadEndoCassetteV0,
	startEndoCassetteServerV0,
} from "../../adapters/openai-proxy/cassette.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../storage/blob-store.ts";
import { runTrial } from "../protected-eval/model-connected/trial.ts";

const flag = (args: string[], name: string, fallback?: string): string => {
	const i = args.indexOf(name);
	const v = i === -1 ? fallback : args[i + 1];
	if (v === undefined) throw new TypeError(`${name} is required`);
	return v;
};

const keyOf = (trial: string) =>
	endoDigestKeyV0(Buffer.from(readFileSync(join(trial, "digest-key"), "utf8").trim(), "hex"), "installation");

/** Every exchange's request body, decoded, in order: from a trial's own capture log under its own key. */
function requestBodies(trial: string): { exchange: number; status: number | null; body: Uint8Array }[] {
	const key = keyOf(trial);
	const cassette = loadEndoCassetteV0(join(trial, "store"), key);
	const blobs = createEndoBlobStoreV0(join(trial, "store", "capture"), key, { readOnly: true });
	return cassette.exchanges.map((e) => ({
		exchange: e.exchange,
		status: e.response?.status ?? null,
		body: blobs.get(e.requestBody.digest),
	}));
}

/** What a trial did, comparable across trials: plain digests only. */
export function trajectoryOf(trial: string) {
	const record = JSON.parse(readFileSync(join(trial, "record.json"), "utf8"));
	const bodies = requestBodies(trial);
	const last = bodies.at(-1);
	const messages = last === undefined ? [] : (JSON.parse(Buffer.from(last.body).toString("utf8")).messages ?? []);
	const toolCalls = messages.flatMap(
		(m: { role?: string; tool_calls?: { function: { name: string; arguments: string } }[] }) =>
			m.role === "assistant" && Array.isArray(m.tool_calls)
				? m.tool_calls.map((t) => `${t.function.name}:${sha256HexV0(t.function.arguments).slice(0, 12)}`)
				: [],
	);
	const canonical = (b: Uint8Array) => sha256HexV0(canonicalEndoJsonV0(JSON.parse(Buffer.from(b).toString("utf8"))));
	return {
		trial,
		exitCode: record.agent.exitCode,
		termination: record.agent.termination,
		exchanges: bodies.length,
		statuses: bodies.map((b) => b.status),
		requestSha256: bodies.map((b) => canonical(b.body).slice(0, 16)),
		toolCalls,
		workspaceSha256: record.workspace.sha256,
		answerSha256: record.agent.stdout.sha256,
	};
}

async function repeat(args: string[]) {
	const source = resolve(flag(args, "--source"));
	const out = resolve(flag(args, "--out"));
	const times = Number(flag(args, "--times", "3"));
	const prompt = flag(args, "--prompt");
	const sourceRecord = JSON.parse(readFileSync(join(source, "record.json"), "utf8"));
	if (sha256HexV0(prompt) !== sourceRecord.subject.prompt.sha256)
		throw new TypeError("--prompt is not the source trial's prompt");
	mkdirSync(out, { recursive: true });
	const runs = [trajectoryOf(source)];
	for (let i = 1; i <= times; i++) {
		const dir = join(out, `repeat-${i}`);
		await runTrial([
			"run",
			"--out",
			dir,
			"--pi-dist",
			flag(args, "--pi-dist"),
			"--upstream",
			flag(args, "--upstream"),
			"--model",
			sourceRecord.subject.model,
			"--prompt",
			prompt,
		]);
		runs.push(trajectoryOf(dir));
	}
	const first = (r: (typeof runs)[number]) => r.requestSha256[0];
	const summary = {
		measurement: "repeat",
		source,
		model: sourceRecord.subject.model,
		runs,
		firstRequestIdentical: runs.every((r) => first(r) === first(runs[0] as (typeof runs)[number])),
		distinctToolSequences: new Set(runs.map((r) => r.toolCalls.join(" "))).size,
		distinctWorkspaces: new Set(runs.map((r) => r.workspaceSha256)).size,
		distinctAnswers: new Set(runs.map((r) => r.answerSha256)).size,
		exchangeCounts: runs.map((r) => r.exchanges),
	};
	writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

async function replay(args: string[]) {
	const source = resolve(flag(args, "--source"));
	const out = resolve(flag(args, "--out"));
	const prompt = flag(args, "--prompt");
	const sourceRecord = JSON.parse(readFileSync(join(source, "record.json"), "utf8"));
	if (sha256HexV0(prompt) !== sourceRecord.subject.prompt.sha256)
		throw new TypeError("--prompt is not the source trial's prompt");
	if (existsSync(out)) throw new TypeError(`${out} exists`);
	mkdirSync(out, { recursive: true });
	const key = keyOf(source);
	const cassette = loadEndoCassetteV0(join(source, "store"), key);
	const replayStore = join(out, "cassette-server");
	const log = new EndoCaptureLogV0(replayStore, key, "replay", { async: true });
	const server = await startEndoCassetteServerV0({
		cassette,
		key,
		storeRoot: join(source, "store"),
		timing: "immediate",
		log,
	});
	const trialDir = join(out, "trial");
	try {
		await runTrial([
			"run",
			"--out",
			trialDir,
			"--pi-dist",
			flag(args, "--pi-dist"),
			"--upstream",
			server.origin,
			"--model",
			sourceRecord.subject.model,
			"--prompt",
			prompt,
			"--timeout-s",
			"120",
		]);
	} finally {
		await server.close();
		log.close();
	}
	const recorded = requestBodies(source);
	const replayed = requestBodies(trialDir);
	const canonical = (b: Uint8Array) => sha256HexV0(canonicalEndoJsonV0(JSON.parse(Buffer.from(b).toString("utf8"))));
	let firstDivergence: { exchange: number; divergence: ReturnType<typeof endoRequestDivergenceV0> | null } | null =
		null;
	for (let i = 0; i < replayed.length && firstDivergence === null; i++) {
		const r = recorded[i];
		const p = replayed[i] as (typeof replayed)[number];
		if (r === undefined || canonical(r.body) !== canonical(p.body))
			firstDivergence = {
				exchange: i + 1,
				divergence: r === undefined ? null : endoRequestDivergenceV0(r.body, p.body),
			};
	}
	const misses = readEndoCaptureEventsV0(replayStore)
		.filter((e) => e.kind === "capture.cassette-miss")
		.map((e) => ({ reason: (e.payload as { reason?: string }).reason ?? null }));
	const summary = {
		measurement: "replay",
		source,
		recordedExchanges: recorded.length,
		replayedRequests: replayed.length,
		served: server.served,
		misses: server.misses,
		missReasons: misses,
		firstDivergence,
		source_trajectory: trajectoryOf(source),
		replay_trajectory: trajectoryOf(trialDir),
		workspaceIdentical: trajectoryOf(source).workspaceSha256 === trajectoryOf(trialDir).workspaceSha256,
		answerIdentical: trajectoryOf(source).answerSha256 === trajectoryOf(trialDir).answerSha256,
	};
	writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [command, ...rest] = process.argv.slice(2);
	const summary = command === "repeat" ? await repeat(rest) : command === "replay" ? await replay(rest) : null;
	if (summary === null) {
		process.stderr.write(
			"usage: probe.ts repeat|replay --source <trial> --out <dir> --pi-dist <dist> --prompt <text> …\n",
		);
		process.exitCode = 2;
	} else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
