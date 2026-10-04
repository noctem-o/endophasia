// Record the cassette fixtures: real Pi sessions recorded through the recording proxy against a model you serve through
// an OpenAI-compatible endpoint, each with its cassette, so it can be replayed (docs/replay.md).
//
//   node scripts/record-cassette-fixture.ts --pi "$(command -v pi)" --upstream http://127.0.0.1:8080 \
//     --model <model-id> --authorize-live-study [--out research/pi-conformance/<pi version>/cassettes] \
//     [--provider-name endolocal] [--sessions completes,stop-mid-turn,killed-and-resumed,tool-use] \
//     [--timeout-ms 300000] [--force]
//
// Sessions (PI_CASSETTE_SCENARIOS): completes, stop-mid-turn, killed-and-resumed (as in the lifecycle fixture) and
// tool-use (the model reads, edits and runs a command on a file in the scratch workspace).
//
// What it never does: install, update or configure your Pi, or touch your Pi configuration or sessions. Pi runs with a
// scratch HOME and PI_CODING_AGENT_DIR under a scratch root in the system temp directory; its models.json names only
// the recording proxy (127.0.0.1, an ephemeral port), which forwards to --upstream. The endpoint must need no API key:
// the scratch root, models.json included, is snapshotted into the fixture.
//
// Digest domain: fixtures are recorded in fixture mode under the committed public key
// research/fixture-keys/fixture-public.json. Their digests offer no secrecy, and the fixture must hold only synthetic
// scratch content (the scenarios' prompts and files). Check the bodies before committing (the README says how).
//
// The live study runs first, through the same proxy port and an identical models.json, so its capability evidence
// (steering.stop) applies to the sessions and to their replays. Its exchanges are recorded in a throwaway capture log.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENDO_CAPTURE_VERSION_V0, EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { PI_ADAPTER_VERSION, PI_MAPPING_VERSION, PI_SUITE_VERSION } from "../adapters/pi/version.ts";
import { exportPiCassetteFixtureV0 } from "../cli/cassette-fixture.ts";
import {
	createPiCassetteScratchV0,
	PI_CASSETTE_DRIVER_VERSION_V0,
	type PiCassetteScenarioV0,
	piCassetteAttachmentV0,
	recordPiCassetteSessionV0,
} from "../cli/cassette-session.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import { loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import {
	PI_CONFORMANCE_DIRECTORY,
	PI_LIFECYCLE_FIXTURE_DIGEST_KEY,
	PI_LIFECYCLE_PROMPTS,
} from "./record-lifecycle-fixture.ts";

export const PI_CASSETTE_RECORDER_VERSION = "pi-cassette-recorder.1";

/** The tool-use scenario's workspace file: synthetic. */
export const PI_CASSETTE_TOOL_FILE =
	"status: draft\nowner: endophasia fixture\nnote: this file is part of a synthetic test workspace\n";

export const PI_CASSETTE_SCENARIOS: readonly PiCassetteScenarioV0[] = Object.freeze<PiCassetteScenarioV0[]>([
	{
		name: "completes",
		purpose: "a short prompt runs to agent_settled",
		workspace: {},
		steps: [{ op: "prompt", text: PI_LIFECYCLE_PROMPTS.short }],
	},
	{
		name: "stop-mid-turn",
		purpose: "a long prompt; a STOP once the proxy has relayed 16 response chunks",
		workspace: {},
		steps: [{ op: "prompt-stop", text: PI_LIFECYCLE_PROMPTS.long, afterChunks: 16 }],
	},
	{
		name: "killed-and-resumed",
		purpose:
			"a long prompt from a child process, SIGKILLed once the proxy has relayed 16 response chunks; the store and session are reopened and a short prompt runs",
		workspace: {},
		steps: [
			{ op: "prompt-kill", text: PI_LIFECYCLE_PROMPTS.long, afterChunks: 16 },
			{ op: "prompt", text: PI_LIFECYCLE_PROMPTS.afterResume },
		],
	},
	{
		name: "tool-use",
		purpose: "the model reads a file, edits it and runs a harmless command, all in the scratch workspace",
		workspace: { "notes.txt": PI_CASSETTE_TOOL_FILE },
		steps: [
			{
				op: "prompt",
				text: "Work only in the current working directory. Do these three steps in order, one tool call each: 1. Use the read tool to read notes.txt. 2. Use the edit tool to replace the word draft with the word final in notes.txt. 3. Use the bash tool to run exactly this command: wc -l notes.txt. Then reply with the single word: done",
			},
		],
	},
]);

export interface PiCassetteRecorderOptionsV0 {
	readonly pi: string;
	readonly upstream: string;
	readonly model: string;
	readonly providerName: string;
	readonly out: string | null;
	readonly authorizeLiveStudy: boolean;
	readonly timeoutMs: number;
	readonly force: boolean;
	readonly sessions: readonly string[];
	readonly log?: (line: string) => void;
}

async function endpointModels(upstream: string): Promise<JsonValueV0> {
	try {
		const response = await fetch(`${upstream.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return { status: "UNAVAILABLE", reason: `GET /v1/models answered HTTP ${response.status}` };
		const body = (await response.json()) as { data?: { id?: unknown }[] };
		return { status: "reported", value: (body.data ?? []).map((entry) => String(entry.id)).sort() };
	} catch (error) {
		return { status: "UNAVAILABLE", reason: `GET /v1/models failed: ${(error as Error).name}` };
	}
}

export async function recordPiCassetteFixturesV0(options: PiCassetteRecorderOptionsV0): Promise<JsonValueV0> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const keySource = { kind: "fixture" as const, path: PI_LIFECYCLE_FIXTURE_DIGEST_KEY };
	const key = loadEndoFixtureDigestKeyV0(PI_LIFECYCLE_FIXTURE_DIGEST_KEY);
	const scenarios = PI_CASSETTE_SCENARIOS.filter((scenario) => options.sessions.includes(scenario.name));
	const base = mkdtempSync(join(tmpdir(), "endo-cassette-"));
	const proxy = await startEndoRecordingProxyV0({ upstream: options.upstream, log: null });
	try {
		// The checks and the live study: through the same proxy port and an identical models.json as the sessions.
		const checks = join(base, "root-checks");
		const checksScratch = createPiCassetteScratchV0(join(base, "checks"), {
			baseUrl: `${proxy.origin}/v1`,
			provider: options.providerName,
			model: options.model,
			files: {},
		});
		const checksLog = new EndoCaptureLogV0(checks, key, "record", { buffered: true });
		proxy.log = checksLog;
		const pi = piCassetteAttachmentV0({
			root: checks,
			scratchRoot: checksScratch.root,
			pi: options.pi,
			provider: options.providerName,
			model: options.model,
			keySource,
			requestTimeoutMs: Math.max(60_000, options.timeoutMs),
		});
		const { fingerprint } = await pi.identify();
		if (fingerprint === null) throw new TypeError("the Pi executable could not be identified");
		const version = fingerprint.reported.version;
		const out = resolve(options.out ?? join(PI_CONFORMANCE_DIRECTORY, version ?? "unknown", "cassettes"));
		if (existsSync(join(out, "provenance.json")) && !options.force)
			throw new TypeError(`${out} already holds a recording; pass --force to replace it`);
		log(`Pi ${version ?? "(no version)"}; writing to ${out}; proxy ${proxy.origin} -> ${options.upstream}`);
		await pi.checkLocal();
		if (options.authorizeLiveStudy) {
			log("running the live study (sends prompts to your model, through the proxy)");
			await pi.studyLive({ authorized: true, stepTimeoutMs: options.timeoutMs });
		}
		await proxy.flush();
		proxy.log = null;
		checksLog.close();
		const reports: JsonValueV0[] = [];
		for (const scenario of scenarios) {
			log(`recording ${scenario.name}`);
			const store = join(base, `root-${scenario.name}`);
			const report = await recordPiCassetteSessionV0({
				scenario,
				pi: options.pi,
				provider: options.providerName,
				model: options.model,
				proxy,
				store,
				scratchRoot: join(base, scenario.name),
				keySource,
				evidenceFrom: checks,
				timeoutMs: options.timeoutMs,
			});
			const dir = join(out, scenario.name);
			rmSync(dir, { recursive: true, force: true });
			const files = exportPiCassetteFixtureV0(store, dir);
			const events = readFileSync(join(dir, "session.events.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			writeFileSync(join(dir, "overview.json"), canonicalEndoJsonV0(reduceEndoSessionOverviewV0(events)));
			const capture = readFileSync(join(dir, "capture.events.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const exchanges = capture.filter((event) => event.kind === "capture.exchange-ended");
			log(
				`  ${events.length} events, ${exchanges.length} exchange(s)${report.notes.length ? `; ${report.notes.join("; ")}` : ""}`,
			);
			reports.push({
				name: scenario.name,
				purpose: scenario.purpose,
				piSessionId: report.piSessionId,
				eventCount: events.length,
				exchanges: exchanges.map((event) => ({
					exchange: event.payload.exchange,
					outcome: event.payload.outcome,
					status: event.payload.status,
					chunks: event.payload.chunks.length,
					wireBytes: event.payload.wireBytes,
				})),
				files,
				notes: report.notes,
			});
			// The store's own event log is no longer needed once exported.
			createEndoDurableEventStoreV0(store, { readOnly: true }).close();
		}
		const provenance: JsonValueV0 = {
			schemaVersion: "endo.pi-cassette-fixture.v0",
			kind: "real",
			recorder: PI_CASSETTE_RECORDER_VERSION,
			driver: PI_CASSETTE_DRIVER_VERSION_V0,
			capture: ENDO_CAPTURE_VERSION_V0,
			recordedAt: new Date().toISOString(),
			host: { platform: process.platform, node: process.version },
			endophasia: { adapter: PI_ADAPTER_VERSION, mapping: PI_MAPPING_VERSION, suite: PI_SUITE_VERSION },
			pi: {
				version,
				package: fingerprint.local.package === null ? null : { ...fingerprint.local.package, root: null },
				entrypointSha256: fingerprint.local.entrypoint?.sha256 ?? null,
				identityDigest: fingerprint.identity.digest,
			},
			model: {
				provider: options.providerName,
				modelId: options.model,
				api: "openai-completions",
				upstream: new URL(options.upstream).origin,
				endpointReportedModels: await endpointModels(options.upstream),
				apiKey: "none (a cassette recording supports only endpoints without a key)",
			},
			proxy: { listen: proxy.origin },
			liveStudyAuthorized: options.authorizeLiveStudy,
			digestDomain: {
				keyId: key.keyId,
				public: true,
				note: "every digest and blob address in these fixtures is made under a committed public key and offers no secrecy",
			},
			scenarios: scenarios.map((scenario) => ({
				name: scenario.name,
				workspace: { ...scenario.workspace },
				steps: scenario.steps.map((step) => ({ ...step })),
			})) as unknown as JsonValueV0,
			sessions: reports,
		};
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "provenance.json"), `${JSON.stringify(provenance, null, "\t")}\n`);
		return provenance;
	} finally {
		await proxy.close();
		rmSync(base, { recursive: true, force: true });
	}
}

function parseArgs(argv: readonly string[]): PiCassetteRecorderOptionsV0 {
	const flags = new Map<string, string>();
	const switches = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--authorize-live-study" || arg === "--force") switches.add(arg);
		else if (arg.startsWith("--")) {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new TypeError(`${arg} needs a value`);
			flags.set(arg, value);
			index += 1;
		} else throw new TypeError(`unexpected argument ${arg}`);
	}
	const required = (flag: string) => {
		const value = flags.get(flag);
		if (value === undefined || value === "") throw new TypeError(`${flag} is required`);
		return value;
	};
	const names = PI_CASSETTE_SCENARIOS.map((scenario) => scenario.name);
	const sessions = flags.has("--sessions") ? flags.get("--sessions")!.split(",") : names;
	for (const name of sessions)
		if (!names.includes(name)) throw new TypeError(`unknown session ${name}; choose from ${names.join(", ")}`);
	const timeout = Number(flags.get("--timeout-ms") ?? "300000");
	if (!Number.isInteger(timeout) || timeout <= 0) throw new TypeError("--timeout-ms must be a positive integer");
	return {
		pi: required("--pi"),
		upstream: required("--upstream"),
		model: required("--model"),
		providerName: flags.get("--provider-name") ?? "endolocal",
		out: flags.get("--out") ?? null,
		authorizeLiveStudy: switches.has("--authorize-live-study"),
		timeoutMs: timeout,
		force: switches.has("--force"),
		sessions,
	};
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const options = parseArgs(process.argv.slice(2));
		recordPiCassetteFixturesV0(options).then(
			() => process.stderr.write("done\n"),
			(error: unknown) => {
				process.stderr.write(`${(error as Error).stack ?? (error as Error).message}\n`);
				process.exit(1);
			},
		);
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exit(2);
	}
}
