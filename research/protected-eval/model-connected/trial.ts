// EVAL-ISO-002 research driver (docs/protected-model-access.md): one model-connected protected trial, and its independent verification.
//
//   node research/protected-eval/model-connected/trial.ts run --out <new dir> --pi-dist <Pi's dist directory> \
//        --upstream http://127.0.0.1:8081 --model <id> --prompt <text> [--memory-mib 2048] [--cpu-percent 400] [--timeout-s 600]
//   node research/protected-eval/model-connected/trial.ts verify <dir>
//
// `run` starts the relay (its policy: Pi's measured route, this model, size and transfer bounds), runs real Pi inside the EVAL-ISO-001
// sandbox with the relay's socket as its only way out, under a scope with the given limits, and keeps: the capture log (a cassette) under
// a private digest key, Pi's agent directory (its session), the workspace, stdout and stderr, and a sealed record. `verify` reads all of it
// again in a new process, trusting nothing the trial's process concluded: the seal, the cassette's integrity, the cassette against the
// record, every exchange against the policy, the workspace against its digest, and whether the installed Pi and runtime still match.
//
// This is a research record (`endo.model-connected-trial.v0`, provisional): it is not an `endo experiment protected-run` record, and no
// product command reads it. Turning it into one is an owner decision (docs/protected-model-access.md §7).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EndoCaptureLogV0 } from "../../../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../../../adapters/openai-proxy/cassette.ts";
import {
	buildSandboxProfileV0,
	detectBubblewrapV0,
	endoTreeDigestV0,
	resolveRuntimeV0,
	runSandboxV0,
} from "../../../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0 } from "../../../adapters/sandbox/containment.ts";
import {
	admitModelRequestV0,
	bridgedCommandV0,
	ENDO_PI_MODEL_ROUTES_V0,
	type EndoModelRelayPolicyV0,
	modelRelayMountsV0,
	modelRelayPolicyDigestV0,
	startModelRelayV0,
} from "../../../adapters/sandbox/model-relay.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0 } from "../../../storage/blob-store.ts";

export const TRIAL_RECORD_VERSION = "endo.model-connected-trial.v0";
const PORT = 18080;
const RUNTIME = ["/usr/bin/bash", "/usr/bin/cat", "/usr/bin/head", "/usr/bin/ls", "/usr/bin/grep"];

const flag = (args: string[], name: string, fallback?: string): string => {
	const i = args.indexOf(name);
	const v = i === -1 ? fallback : args[i + 1];
	if (v === undefined) throw new TypeError(`${name} is required`);
	return v;
};

export const seal = (record: Record<string, unknown>): string =>
	sha256HexV0(canonicalEndoJsonV0({ ...record, recordSha256: null }));

/** The workspace's tree digest, or why it has none (a link or special file the agent left: the digest refuses them). */
function workspaceDigest(dir: string): { sha256: string | null; problem: string | null } {
	try {
		return { sha256: endoTreeDigestV0(dir), problem: null };
	} catch (error) {
		return { sha256: null, problem: String((error as Error).message).replace(dir, "<workspace>") };
	}
}

export async function runTrial(args: string[]): Promise<Record<string, unknown>> {
	const out = resolve(flag(args, "--out"));
	const piDist = realpathSync(flag(args, "--pi-dist"));
	const upstream = new URL(flag(args, "--upstream")).origin;
	const model = flag(args, "--model");
	const prompt = flag(args, "--prompt");
	const limits = {
		memoryMaxBytes: Number(flag(args, "--memory-mib", "2048")) * 1024 * 1024,
		cpuQuotaPercent: Number(flag(args, "--cpu-percent", "400")),
	};
	const timeoutMs = Number(flag(args, "--timeout-s", "600")) * 1000;
	if (existsSync(out)) throw new TypeError(`${out} exists: a trial directory is new`);
	const bw = detectBubblewrapV0();
	if (!bw.ok) throw new TypeError(`isolation unavailable: ${bw.detail}`);
	const contained = await detectContainmentV0();
	if (!contained.ok) throw new TypeError(`containment unavailable: ${contained.detail}`);
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	if (runtimeDirectory === undefined) throw new TypeError("XDG_RUNTIME_DIR is needed for the relay's private socket");

	mkdirSync(out, { recursive: true, mode: 0o700 });
	const keyBytes = randomBytes(32);
	writeFileSync(join(out, "digest-key"), keyBytes.toString("hex"), { mode: 0o600, flag: "wx" });
	const key = endoDigestKeyV0(keyBytes, "installation");
	const controller = join(out, "controller");
	const work = join(out, "work");
	const agent = join(out, "pi-agent");
	for (const d of [controller, work, agent]) mkdirSync(d, { mode: 0o700 });
	writeFileSync(
		join(agent, "models.json"),
		JSON.stringify({
			providers: {
				relay: {
					baseUrl: `http://127.0.0.1:${PORT}/v1`,
					api: "openai-completions",
					apiKey: "local",
					models: [
						{
							id: model,
							contextWindow: 32768,
							maxTokens: 2048,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "relay", defaultModel: model }));

	const policy: EndoModelRelayPolicyV0 = {
		routes: ENDO_PI_MODEL_ROUTES_V0,
		model,
		maxRequestBytes: 1024 * 1024,
		maxTransferredBytes: 256 * 1024 * 1024,
		maxConnections: 8,
		maxTotalConnections: 1024,
	};
	const store = join(out, "store");
	const log = new EndoCaptureLogV0(store, key, "record", { async: true });
	const relay = await startModelRelayV0({ upstream, policy, log, runtimeDirectory });
	const node = realpathSync(process.execPath);
	try {
		const runtime = resolveRuntimeV0([node, ...RUNTIME]);
		if (!runtime.ok) throw new TypeError(runtime.detail);
		const bash = runtime.files.find((f) => f.target === "/usr/bin/bash");
		if (bash === undefined) throw new TypeError("bash is not in the runtime");
		const piDigest = endoTreeDigestV0(piDist);
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [
				{ target: "/opt/pi/dist", kind: "ro-dir", role: "pi", source: piDist, sha256: piDigest },
				{ target: "/pi-agent", kind: "rw-dir", role: "pi-agent", source: agent },
				{ target: "/work", kind: "rw-dir", role: "workspace", source: work },
				{ target: "/usr/bin/sh", kind: "ro-file", role: "runtime-sh", source: bash.source, sha256: bash.sha256 },
				...modelRelayMountsV0(relay, controller),
			],
			env: {
				HOME: "/home/agent",
				PATH: "/usr/bin",
				TMPDIR: "/tmp",
				PI_CODING_AGENT_DIR: "/pi-agent",
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
			},
			cwd: "/work",
			tmpfsBytes: 256 * 1024 * 1024,
		});
		const startedAt = new Date().toISOString();
		const run = await runSandboxV0(
			bw.bwrap,
			profile,
			bridgedCommandV0(node, PORT, [node, "/opt/pi/dist/bundle/cli.js", "-p", "--no-session", prompt]),
			{ timeoutMs, outputBytes: 4 * 1024 * 1024, containment: contained.containment, limits },
		);
		await relay.close();
		log.close();
		writeFileSync(join(out, "stdout.txt"), run.stdout);
		writeFileSync(join(out, "stderr.txt"), run.stderr);
		const cassette = loadEndoCassetteV0(store, key);
		const record: Record<string, unknown> = {
			schemaVersion: TRIAL_RECORD_VERSION,
			provisional: true,
			startedAt,
			subject: {
				pi: { distSha256: piDigest },
				model,
				prompt: { sha256: sha256HexV0(prompt), bytes: Buffer.byteLength(prompt) },
			},
			isolation: {
				bubblewrap: { version: bw.bwrap.version, sha256: bw.bwrap.sha256 },
				containment: { mechanism: contained.containment.mechanism, version: contained.containment.version, limits },
				profileSha256: profile.sha256,
				requested: profile.logical,
				runtime: runtime.files.map((f) => ({ target: f.target, sha256: f.sha256 })),
			},
			relay: {
				policy: { ...policy, routes: policy.routes.map((r) => ({ ...r })) },
				policyDigest: relay.policyDigest,
				admitted: relay.admitted(),
				refusals: relay.refusals(),
				transferredBytes: relay.transferredBytes(),
				// Read after close(), which flushes the recording: a failed write is kept here, and verification rejects it (Codex, #134).
				recordingFailures: relay.recordingFailures(),
				upstream: { origin: upstream },
			},
			agent: {
				// The run's own deadline: part of its condition, so that a repeat can hold it (research/counterfactual-replay/probe.ts).
				timeoutMs,
				started: run.started,
				exitCode: run.exitCode,
				signal: run.signal,
				timedOut: run.timedOut,
				durationMs: run.durationMs,
				scope: run.scope,
				termination: run.termination,
				stdout: { sha256: sha256HexV0(run.stdout), bytes: run.stdout.length, truncated: run.truncated.stdout },
				stderr: { sha256: sha256HexV0(run.stderr), bytes: run.stderr.length, truncated: run.truncated.stderr },
			},
			cassette: {
				keyId: cassette.keyId,
				exchanges: cassette.exchanges.map((e) => ({
					exchange: e.exchange,
					method: e.method,
					path: e.path,
					requestDigest: e.requestDigest.value,
					outcome: e.response?.outcome ?? null,
					status: e.response?.status ?? null,
					truncated: e.truncated,
				})),
			},
			workspace: workspaceDigest(work),
		};
		record.recordSha256 = seal(record);
		writeFileSync(join(out, "record.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
		return record;
	} finally {
		await relay.close();
		log.close();
	}
}

/**
 * Every recorded exchange whose request the policy would refuse, judged again from the recorded body (decoded from the trial's blob
 * store under its key) by the same judge the relay used: route, size, a JSON object, the model. Empty when all of them are admissible.
 */
export function exchangesOutsidePolicyV0(
	store: string,
	key: ReturnType<typeof endoDigestKeyV0>,
	policy: EndoModelRelayPolicyV0,
): { exchange: number; reason: string }[] {
	const cassette = loadEndoCassetteV0(store, key);
	const blobs = createEndoBlobStoreV0(join(store, "capture"), key, { readOnly: true });
	const outside: { exchange: number; reason: string }[] = [];
	for (const e of cassette.exchanges) {
		let body: Uint8Array;
		try {
			body = blobs.get(e.requestBody.digest);
		} catch {
			outside.push({ exchange: e.exchange, reason: "body-unreadable" });
			continue;
		}
		const verdict = admitModelRequestV0(policy, { method: e.method, path: e.path, body });
		if (!verdict.admitted) outside.push({ exchange: e.exchange, reason: verdict.reason });
	}
	return outside;
}

/**
 * What a trial's cassette must show, judged from its exchanges alone (pure, so each case is tested without a sandbox):
 * - `cassette-verifies`: every exchange's bodies verify against the blob store (`truncated` null). An exchange the loader could not verify
 *   is a failure whatever its outcome (Codex, #134: the earlier predicate excused any exchange that was not complete);
 * - `admitted-count`: no more complete exchanges than requests the relay admitted;
 * - `model-exchange`: at least one complete, verified exchange, and at least one admitted request. A model-connected trial whose agent
 *   never reached the model is not one: over no exchanges every other check is vacuously true (Codex, #134).
 */
export function cassetteFindingsV0(
	exchanges: readonly { truncated: string | null; response: { outcome: string } | null }[],
	admitted: number,
): VerifyFindingV0[] {
	const unverified = exchanges.filter((e) => e.truncated !== null).length;
	const complete = exchanges.filter((e) => e.truncated === null && e.response?.outcome === "complete").length;
	const admittedOk = Number.isSafeInteger(admitted) && admitted >= 0;
	return [
		{
			check: "cassette-verifies",
			ok: unverified === 0,
			detail:
				unverified === 0
					? "every exchange's bodies verify against the blob store"
					: `${unverified} exchange(s) whose bodies do not verify, or that the recording does not end`,
		},
		{
			check: "admitted-count",
			ok: admittedOk && complete <= admitted,
			detail: `${complete} complete exchange(s), ${admittedOk ? admitted : "an unreadable number of"} admitted request(s)`,
		},
		{
			check: "model-exchange",
			ok: admittedOk && complete >= 1 && admitted >= 1,
			detail:
				complete >= 1 && admitted >= 1
					? `${complete} complete model exchange(s)`
					: "no complete, admitted model exchange: the agent never reached the model through the relay",
		},
	];
}

export interface VerifyFindingV0 {
	check: string;
	ok: boolean;
	detail: string;
}

/** Re-read a trial directory and check it, trusting nothing the trial's own process concluded. */
export function verifyTrial(dir: string, options: { piDist?: string } = {}): VerifyFindingV0[] {
	const findings: VerifyFindingV0[] = [];
	const add = (check: string, ok: boolean, detail: string) => findings.push({ check, ok, detail });
	const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as Record<string, any>;
	add("version", record.schemaVersion === TRIAL_RECORD_VERSION, String(record.schemaVersion));
	add("seal", record.recordSha256 === seal(record), "the record's digest of its own canonical JSON");
	const policy = record.relay?.policy as EndoModelRelayPolicyV0;
	add(
		"policy-digest",
		modelRelayPolicyDigestV0(policy) === record.relay?.policyDigest,
		"the policy matches its digest",
	);
	add(
		"boundary",
		record.isolation?.requested?.network === "model-relay",
		String(record.isolation?.requested?.network),
	);
	add("termination", record.agent?.termination === "confirmed", String(record.agent?.termination));
	// The recording must be whole: no capture write failed, and every recorded exchange has its response, complete and verified. A trial
	// with a lost write or a response missing is never presented as verified (Codex, #134).
	add(
		"recording-complete",
		record.relay?.recordingFailures === 0 &&
			(record.cassette?.exchanges ?? []).every(
				(e: { outcome: unknown; truncated: unknown }) => e.outcome === "complete" && e.truncated === null,
			),
		`${record.relay?.recordingFailures ?? "unknown"} failed capture writes; every exchange complete and verified, or not`,
	);
	// The proxy drops a session's connections once the bytes through it exceed the policy's bound, after counting the bytes that crossed
	// it: a trial that hit the cap did not run to its own end, whatever else it shows (Codex, #134).
	const transferred = Number(record.relay?.transferredBytes);
	add(
		"transfer-within-policy",
		Number.isSafeInteger(transferred) && transferred <= Number(policy?.maxTransferredBytes),
		`${transferred} of at most ${policy?.maxTransferredBytes} bytes through the relay`,
	);
	const key = endoDigestKeyV0(
		Buffer.from(readFileSync(join(dir, "digest-key"), "utf8").trim(), "hex"),
		"installation",
	);
	let cassette: ReturnType<typeof loadEndoCassetteV0> | null = null;
	try {
		cassette = loadEndoCassetteV0(join(dir, "store"), key);
		add("cassette-loads", true, `${cassette.exchanges.length} exchanges`);
	} catch (error) {
		add("cassette-loads", false, String((error as Error).message));
	}
	if (cassette !== null) {
		const now = cassette.exchanges.map((e) => [e.exchange, e.method, e.path, e.requestDigest.value, e.truncated]);
		const then = (record.cassette?.exchanges ?? []).map((e: any) => [
			e.exchange,
			e.method,
			e.path,
			e.requestDigest,
			e.truncated,
		]);
		add(
			"cassette-matches-record",
			JSON.stringify(now) === JSON.stringify(then),
			"exchanges, routes, request digests, integrity",
		);
		for (const f of cassetteFindingsV0(cassette.exchanges, Number(record.relay?.admitted)))
			add(f.check, f.ok, f.detail);
		const outside = exchangesOutsidePolicyV0(join(dir, "store"), key, policy);
		add(
			"requests-within-policy",
			outside.length === 0,
			outside.length === 0
				? "every recorded request, body included (route, model, size, a JSON object), is one the policy admits"
				: `exchanges the policy would refuse: ${outside.map((o) => `${o.exchange} (${o.reason})`).join(", ")}`,
		);
	}
	for (const [name, file] of [
		["stdout", "stdout.txt"],
		["stderr", "stderr.txt"],
	] as const)
		add(`${name}-digest`, sha256HexV0(readFileSync(join(dir, file))) === record.agent?.[name]?.sha256, file);
	// A workspace with no digest (a link or special file the agent left) cannot be checked: that is a failure of this check, never a match
	// of two nulls (Codex, #134).
	const ws = workspaceDigest(join(dir, "work"));
	add(
		"workspace-digest",
		ws.sha256 !== null && ws.sha256 === record.workspace?.sha256,
		ws.problem ??
			(record.workspace?.sha256 == null ? "the record holds no workspace digest" : "the workspace as kept"),
	);
	// The runtime is part of the trial's condition: each recorded runtime file, at its path on this host now, against its recorded digest.
	// A difference means this host no longer holds the trial's runtime (an update, or another host); it does not make the trial wrong,
	// but a repetition here would not be the same condition (Codex, #134).
	const runtime = (record.isolation?.runtime ?? []) as { target: string; sha256: string }[];
	const changed = runtime.filter((f) => {
		try {
			return sha256HexV0(readFileSync(realpathSync(f.target))) !== f.sha256;
		} catch {
			return true;
		}
	});
	add(
		"runtime-unchanged",
		runtime.length > 0 && changed.length === 0,
		runtime.length === 0
			? "the record names no runtime files"
			: changed.length === 0
				? `${runtime.length} runtime files match this host`
				: `changed or missing on this host: ${changed.map((f) => f.target).join(", ")}`,
	);
	if (options.piDist !== undefined) {
		const current = endoTreeDigestV0(realpathSync(options.piDist));
		add(
			"pi-unchanged",
			current === record.subject?.pi?.distSha256,
			"the installed Pi's dist tree, now, against the trial's",
		);
	}
	return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [command, ...rest] = process.argv.slice(2);
	if (command === "run") {
		const record = await runTrial(rest);
		const agent = record.agent as Record<string, unknown>;
		process.stdout.write(
			`trial kept: exit ${agent.exitCode}, termination ${agent.termination}, ${(record.cassette as { exchanges: unknown[] }).exchanges.length} exchanges\n`,
		);
	} else if (command === "verify" && rest[0] !== undefined) {
		const i = rest.indexOf("--pi-dist");
		const findings = verifyTrial(resolve(rest[0]), i === -1 ? {} : { piDist: rest[i + 1] as string });
		for (const f of findings) process.stdout.write(`${f.ok ? "ok  " : "FAIL"} ${f.check}: ${f.detail}\n`);
		process.exitCode = findings.every((f) => f.ok) ? 0 : 1;
	} else {
		process.stderr.write(
			"usage: trial.ts run --out <dir> --pi-dist <dir> --upstream <origin> --model <id> --prompt <text> | verify <dir> [--pi-dist <dir>]\n",
		);
		process.exitCode = 2;
	}
}
