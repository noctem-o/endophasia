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

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../../adapters/openai-proxy/capture-log.ts";
import {
	endoRequestDivergenceV0,
	loadEndoCassetteV0,
	startEndoCassetteServerV0,
} from "../../adapters/openai-proxy/cassette.ts";
import { Http1ParserV0 } from "../../adapters/openai-proxy/http1.ts";
import { endoTreeDigestV0 } from "../../adapters/sandbox/bubblewrap.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../storage/blob-store.ts";
import { runTrial, type VerifyFindingV0, verifyTrial } from "../protected-eval/model-connected/trial.ts";

/**
 * Make `dir` (and any missing parents) and leave it private to this user, whatever the umask: it holds raw prompts, model replies and
 * tool output (the replay's capture log, the trials' stores). An existing directory is accepted only if it is a real directory this user
 * owns, and it is then made 0700 too. The mode is checked after the fact, never assumed from the requested one (Codex, #136).
 */
export function privateDirectoryV0(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const s = lstatSync(dir);
	if (!s.isDirectory()) throw new TypeError(`${dir} is not a directory (a link is refused)`);
	if (s.uid !== process.getuid?.()) throw new TypeError(`${dir} is not this user's`);
	chmodSync(dir, 0o700);
	if ((lstatSync(dir).mode & 0o077) !== 0) throw new TypeError(`${dir} could not be made private`);
}

/**
 * Where a repeat's inputs differ from its source trial's: the Pi distribution (by tree digest) and the model endpoint (by normalised
 * origin). A repeat under either difference would confound a change of agent build or endpoint with the model's own variation, so the
 * probe refuses it (Codex, #136). Empty when both match.
 */
export function repeatProvenanceMismatchesV0(
	source: { subject?: { pi?: { distSha256?: unknown } }; relay?: { upstream?: { origin?: unknown } } },
	given: { piDistSha256: string; upstream: string | null },
): string[] {
	const mismatches: string[] = [];
	if (source.subject?.pi?.distSha256 !== given.piDistSha256) mismatches.push("pi-dist");
	if (given.upstream !== null) {
		let origin: string | null = null;
		try {
			origin = new URL(given.upstream).origin;
		} catch {
			origin = null;
		}
		const recorded = typeof source.relay?.upstream?.origin === "string" ? source.relay.upstream.origin : null;
		if (origin === null || recorded === null || origin !== new URL(recorded).origin) mismatches.push("upstream");
	}
	return mismatches;
}

/**
 * The source trial's execution condition, to hold in every run made from it: its memory and CPU limits, and its timeout. A run under
 * other limits or another deadline could differ for those reasons (an OOM kill, a throttled tool, a timeout) and be mistaken for the
 * model's variation (Codex, #136). Limits come from the record only. The timeout too, unless the record predates keeping it: then the
 * operator must state it (`--source-timeout-s`), and the summary says the timeout was declared, not recorded. Anything else is refused.
 */
export function sourceConditionV0(
	record: {
		isolation?: { containment?: { limits?: { memoryMaxBytes?: unknown; cpuQuotaPercent?: unknown } } };
		agent?: { timeoutMs?: unknown };
	},
	declaredTimeoutS: string | null,
):
	| { ok: true; memoryMib: number; cpuPercent: number; timeoutS: number; timeoutFrom: "record" | "operator" }
	| { ok: false; reason: string } {
	const limits = record.isolation?.containment?.limits;
	const memory = Number(limits?.memoryMaxBytes) / (1024 * 1024);
	const cpu = Number(limits?.cpuQuotaPercent);
	if (!Number.isSafeInteger(memory) || memory < 16 || !Number.isSafeInteger(cpu) || cpu < 1)
		return {
			ok: false,
			reason: "the source record does not state its memory and CPU limits in whole MiB and percent",
		};
	const recorded = Number(record.agent?.timeoutMs);
	if (record.agent?.timeoutMs !== undefined) {
		if (!Number.isSafeInteger(recorded) || recorded <= 0 || recorded % 1000 !== 0)
			return { ok: false, reason: "the source record's timeout is not a whole number of seconds" };
		if (declaredTimeoutS !== null && Number(declaredTimeoutS) * 1000 !== recorded)
			return { ok: false, reason: "--source-timeout-s contradicts the timeout the source record states" };
		return { ok: true, memoryMib: memory, cpuPercent: cpu, timeoutS: recorded / 1000, timeoutFrom: "record" };
	}
	if (declaredTimeoutS === null || !/^[1-9][0-9]{0,5}$/.test(declaredTimeoutS))
		return {
			ok: false,
			reason:
				"the source record predates keeping its timeout: state it with --source-timeout-s <seconds>, or use a newer source",
		};
	return { ok: true, memoryMib: memory, cpuPercent: cpu, timeoutS: Number(declaredTimeoutS), timeoutFrom: "operator" };
}

/** `--times`: a whole number of repeats from 1 to 20, never Infinity, NaN or a typo silently read as 0 (Codex, #136). */
export function repeatCountV0(text: string): number {
	if (!/^[1-9][0-9]?$/.test(text) || Number(text) > 20) throw new TypeError("--times is a whole number from 1 to 20");
	return Number(text);
}

/** Whether every run's first request is the same: null (unavailable) when any run made none, never "identical" over nothing (Codex, #136). */
export function firstRequestIdenticalV0(runs: readonly { requestSha256: readonly string[] }[]): boolean | null {
	const firsts = runs.map((r) => r.requestSha256[0]);
	if (firsts.length === 0 || firsts.some((f) => f === undefined)) return null;
	return firsts.every((f) => f === firsts[0]);
}

function conditionOrThrow(record: unknown, args: string[]) {
	const i = args.indexOf("--source-timeout-s");
	const c = sourceConditionV0(
		record as Parameters<typeof sourceConditionV0>[0],
		i === -1 ? null : (args[i + 1] ?? ""),
	);
	if (!c.ok) throw new TypeError(c.reason);
	return c;
}

const conditionArgs = (c: { memoryMib: number; cpuPercent: number; timeoutS: number }) => [
	"--memory-mib",
	String(c.memoryMib),
	"--cpu-percent",
	String(c.cpuPercent),
	"--timeout-s",
	String(c.timeoutS),
];

function requireProvenance(sourceRecord: unknown, piDist: string, upstream: string | null): void {
	const mismatches = repeatProvenanceMismatchesV0(sourceRecord as Parameters<typeof repeatProvenanceMismatchesV0>[0], {
		piDistSha256: endoTreeDigestV0(realpathSync(piDist)),
		upstream,
	});
	if (mismatches.length > 0)
		throw new TypeError(
			`these inputs are not the source trial's: ${mismatches.join(", ")} (a repeat must change nothing but the run)`,
		);
}

/**
 * Why a source trial cannot be a baseline: every check `verifyTrial` failed, by name; empty when all passed. A source whose record or
 * capture is damaged, whose termination is unconfirmed, whose exchanges fall outside its policy, or whose runtime files on this host
 * are no longer the ones it recorded (`runtime-unchanged`) would put another condition, or no valid run at all, into the comparison and
 * have it read as the model's variation (Codex, #136). No check is excused: an older record that cannot show a check fails it.
 */
export function sourceRefusalsV0(findings: readonly VerifyFindingV0[]): string[] {
	if (findings.length === 0) return ["no-checks"];
	return findings.filter((f) => !f.ok).map((f) => f.check);
}

/**
 * End a replay's recording before reading it: close the cassette server (it waits for its sockets), then wait for the asynchronous log's
 * queued writes, a cassette miss among them, to reach disk, then close the log. Read before the flush, the miss reasons could be missing
 * or partial and disagree with the server's own counters (Codex, #136). Returns the log's failed writes, which the summary reports.
 */
export async function finishReplayLogV0(
	server: { close(): Promise<void> },
	log: { flush(): Promise<void>; close(): void; readonly writeFailures: number },
): Promise<number> {
	await server.close();
	await log.flush();
	log.close();
	return log.writeFailures;
}

function requireVerifiedSource(source: string, piDist: string): void {
	const refused = sourceRefusalsV0(verifyTrial(source, { piDist: realpathSync(piDist) }));
	if (refused.length > 0)
		throw new TypeError(
			`the source trial does not verify on this host (${refused.join(", ")}): it cannot be a baseline`,
		);
}

const flag = (args: string[], name: string, fallback?: string): string => {
	const i = args.indexOf(name);
	const v = i === -1 ? fallback : args[i + 1];
	if (v === undefined) throw new TypeError(`${name} is required`);
	return v;
};

const keyOf = (trial: string) =>
	endoDigestKeyV0(Buffer.from(readFileSync(join(trial, "digest-key"), "utf8").trim(), "hex"), "installation");

/** Every exchange's request body, decoded, in order, and its response's wire bytes when it has any: from a trial's own capture log under its own key. */
function requestBodies(
	trial: string,
): { exchange: number; status: number | null; body: Uint8Array; responseWire: Uint8Array | null }[] {
	const key = keyOf(trial);
	const cassette = loadEndoCassetteV0(join(trial, "store"), key);
	const blobs = createEndoBlobStoreV0(join(trial, "store", "capture"), key, { readOnly: true });
	return cassette.exchanges.map((e) => ({
		exchange: e.exchange,
		status: e.response?.status ?? null,
		body: blobs.get(e.requestBody.digest),
		responseWire: e.response === null || e.truncated !== null ? null : blobs.get(e.response.wire.digest),
	}));
}

/**
 * The tool calls one model response decided, as `name:<first 12 hex of sha256(arguments)>`, in order: read from the response itself (its
 * HTTP framing removed; a streamed response's `tool_calls` deltas joined by index, or a whole response's message). A run's decisions are
 * its responses' calls, exchange by exchange. The last request's history is not that: once Pi compacts its context, earlier assistant
 * turns are no longer in it, and the last response is never in any request (Codex, #136).
 *
 * Null when the response cannot be read: a content encoding other than gzip, deflate or br (each decoded first), a body that does not
 * decode or parse. Such a response is never read as one that called no tool (Codex, #136: a gzip body read as text found no calls).
 */
export function toolCallsOfResponseV0(wire: Uint8Array): string[] | null {
	try {
		return toolCallsOfReadableResponse(wire);
	} catch {
		return null;
	}
}

const DECODERS_V0: Record<string, (b: Buffer) => Buffer> = {
	gzip: gunzipSync,
	"x-gzip": gunzipSync,
	deflate: inflateSync,
	br: brotliDecompressSync,
};

function toolCallsOfReadableResponse(wire: Uint8Array): string[] {
	const chunks: Buffer[] = [];
	let contentType = "";
	let encodings: string[] = [];
	const parser = new Http1ParserV0("response", {
		head: (head) => {
			contentType = head.headers.find(([n]) => n.toLowerCase() === "content-type")?.[1] ?? "";
			encodings = head.headers
				.filter(([n]) => n.toLowerCase() === "content-encoding")
				.flatMap(([, v]) => v.split(","))
				.map((v) => v.trim().toLowerCase())
				.filter((v) => v !== "" && v !== "identity");
		},
		body: (bytes) => chunks.push(bytes),
		end: () => {},
	});
	parser.pendingMethods.push("POST");
	parser.push(Buffer.from(wire));
	parser.close();
	// Codings are listed in the order applied: undo them last first. An unknown one throws, and the response is unread.
	let body: Buffer = Buffer.concat(chunks);
	for (const coding of [...encodings].reverse()) {
		const decode = DECODERS_V0[coding];
		if (decode === undefined) throw new TypeError(`content encoding ${coding} is not one the probe decodes`);
		body = decode(body);
	}
	const text = body.toString("utf8");
	type Call = { function?: { name?: string; arguments?: string }; index?: number };
	const sha = (args: string) => sha256HexV0(args).slice(0, 12);
	if (!contentType.includes("text/event-stream") && !text.trimStart().startsWith("data:")) {
		const calls = (JSON.parse(text) as { choices?: { message?: { tool_calls?: Call[] } }[] }).choices?.[0]?.message
			?.tool_calls;
		return (calls ?? []).map((c) => `${c.function?.name ?? ""}:${sha(c.function?.arguments ?? "")}`);
	}
	const byIndex = new Map<number, { name: string; arguments: string }>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (data === "" || data === "[DONE]") continue;
		const deltas = (JSON.parse(data) as { choices?: { delta?: { tool_calls?: Call[] } }[] }).choices?.[0]?.delta
			?.tool_calls;
		for (const d of deltas ?? []) {
			const index = d.index ?? 0;
			const call = byIndex.get(index) ?? { name: "", arguments: "" };
			if (d.function?.name) call.name += d.function.name;
			if (d.function?.arguments) call.arguments += d.function.arguments;
			byIndex.set(index, call);
		}
	}
	return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, c]) => `${c.name}:${sha(c.arguments)}`);
}

/**
 * A run's decision sequence: every response's tool calls, in exchange order, whatever the requests' history still shows. An exchange
 * with no complete response is counted in `responsesUnread`, never skipped silently.
 */
export function runToolCallsV0(responses: readonly (Uint8Array | null)[]): {
	toolCalls: string[];
	responsesUnread: number;
} {
	const read = responses.map((r) => (r === null ? null : toolCallsOfResponseV0(r)));
	return {
		toolCalls: read.flatMap((calls) => calls ?? []),
		// No complete response recorded, or one that could not be decoded or parsed: counted, never read as "no tool call".
		responsesUnread: read.filter((calls) => calls === null).length,
	};
}

/** How many different tool sequences the runs made: null (unavailable) when any run has a response that could not be read (Codex, #136). */
export function distinctToolSequencesV0(
	runs: readonly { toolCalls: readonly string[]; responsesUnread: number }[],
): number | null {
	if (runs.some((r) => r.responsesUnread !== 0)) return null;
	return new Set(runs.map((r) => r.toolCalls.join(" "))).size;
}

/** What a trial did, comparable across trials: plain digests only. */
export function trajectoryOf(trial: string) {
	const record = JSON.parse(readFileSync(join(trial, "record.json"), "utf8"));
	const bodies = requestBodies(trial);
	// Every response's decisions, in exchange order; an exchange with no complete response is counted, never skipped silently.
	const { toolCalls, responsesUnread } = runToolCallsV0(bodies.map((b) => b.responseWire));
	const canonical = (b: Uint8Array) => sha256HexV0(canonicalEndoJsonV0(JSON.parse(Buffer.from(b).toString("utf8"))));
	return {
		trial,
		exitCode: record.agent.exitCode,
		termination: record.agent.termination,
		exchanges: bodies.length,
		statuses: bodies.map((b) => b.status),
		requestSha256: bodies.map((b) => canonical(b.body).slice(0, 16)),
		toolCalls,
		responsesUnread,
		// Every run is verified as its source was; a run that fails a check is named here, never silently counted (Codex, #136).
		failedChecks: sourceRefusalsV0(verifyTrial(trial)),
		workspaceSha256: record.workspace.sha256,
		answerSha256: record.agent.stdout.sha256,
	};
}

async function repeat(args: string[]) {
	const source = resolve(flag(args, "--source"));
	const out = resolve(flag(args, "--out"));
	const times = repeatCountV0(flag(args, "--times", "3"));
	const prompt = flag(args, "--prompt");
	const sourceRecord = JSON.parse(readFileSync(join(source, "record.json"), "utf8"));
	if (sha256HexV0(prompt) !== sourceRecord.subject.prompt.sha256)
		throw new TypeError("--prompt is not the source trial's prompt");
	requireVerifiedSource(source, flag(args, "--pi-dist"));
	requireProvenance(sourceRecord, flag(args, "--pi-dist"), flag(args, "--upstream"));
	const condition = conditionOrThrow(sourceRecord, args);
	privateDirectoryV0(out);
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
			...conditionArgs(condition),
		]);
		runs.push(trajectoryOf(dir));
	}
	const summary = {
		measurement: "repeat",
		source,
		model: sourceRecord.subject.model,
		runs,
		condition,
		firstRequestIdentical: firstRequestIdenticalV0(runs),
		distinctToolSequences: distinctToolSequencesV0(runs),
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
	// A replay's upstream is the cassette by design; its Pi must still be the source's.
	requireVerifiedSource(source, flag(args, "--pi-dist"));
	requireProvenance(sourceRecord, flag(args, "--pi-dist"), null);
	const condition = conditionOrThrow(sourceRecord, args);
	privateDirectoryV0(out);
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
			...conditionArgs(condition),
		]);
	} finally {
		await finishReplayLogV0(server, log);
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
		condition,
		source,
		recordedExchanges: recorded.length,
		replayedRequests: replayed.length,
		served: server.served,
		misses: server.misses,
		missReasons: misses,
		// Failed writes of the replay's own log: its miss reasons are complete only when this is 0.
		replayLogWriteFailures: log.writeFailures,
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
