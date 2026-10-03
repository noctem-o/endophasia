// Record the Pi session-lifecycle acceptance fixture: three real sessions against a Pi you installed and a model you
// serve through an OpenAI-compatible endpoint.
//
//   node scripts/record-lifecycle-fixture.ts --pi "$(command -v pi)" \
//     --base-url http://127.0.0.1:8080/v1 --model <model-id> --authorize-live-study \
//     [--api-key-env NAME] [--provider-name endolocal] [--out research/pi-conformance/<pi version>/lifecycle] \
//     [--timeout-ms 300000] [--force] [--sessions completes,stop-mid-turn,killed-and-resumed]
//
// Sessions, each in its own Endophasia store:
//   completes            a short prompt, run to agent_settled.
//   stop-mid-turn        a long prompt; once Pi streams, a STOP through the attachment's steering.stop control.
//   killed-and-resumed   a long prompt in a child process that is SIGKILLed once Pi streams (Pi dies with it: the
//                        process-group keeper ends the group); then this process reopens the same store and Pi
//                        session, which records the interruption and the resume, and runs a short prompt.
//
// What it never does: install, update or configure your Pi. Pi runs with a scratch HOME and a scratch
// PI_CODING_AGENT_DIR whose models.json names only your endpoint, so your own Pi configuration, sessions and
// credentials are neither read nor written. The API key, when --api-key-env names one, is passed to Pi through
// models.json in the scratch directory and to the endpoint's /models query; it is never written to the output.
//
// --authorize-live-study is required: STOP is offered only when the live study admits steering.stop, and the live
// study sends prompts to your model. Without that admission the stop-mid-turn session is recorded as skipped, with the
// reason, never simulated.
//
// --sessions records a subset (default: all three). A subset is never filed as a version's lifecycle fixture: it needs
// an --out outside `pi-conformance/<version>/lifecycle/` (e.g. repeated recordings for trajectory comparison).
//
// Output (--out): `<session>.events.jsonl` (the recorded event stream, canonical JSON, one event per line),
// `<session>.overview.json` (the reducer's overview of it) and `provenance.json` (the Pi fingerprint, the model and
// endpoint identity without secrets, the versions, and each session's status).

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PiAttachmentV0, type PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { PI_ADAPTER_VERSION, PI_MAPPING_VERSION, PI_SUITE_VERSION } from "../adapters/pi/version.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { reduceEndoSessionOverviewV0 } from "../runtime/contracts/session-overview.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";

export const PI_LIFECYCLE_RECORDER_VERSION = "pi-lifecycle-recorder.2";

/** What the recorder's own scratch directory becomes in a committed fixture. */
export const PI_LIFECYCLE_SCRATCH_PLACEHOLDER = "<recorder-scratch>";

/**
 * Replace every occurrence of the recorder-owned scratch root (as created, and as its real path), as a whole path
 * component, in the events' strings with the placeholder. Nothing else is touched: every other path stays as recorded. Returns the normalized
 * events and how many strings changed.
 */
export function normalizeScratchRootV0(
	events: readonly EndoEventV0[],
	scratchRoots: readonly string[],
): { events: EndoEventV0[]; replacements: number } {
	const roots = [...new Set(scratchRoots.filter((root) => root.length > 1))].sort((a, b) => b.length - a.length);
	// A root matches only as a whole path: followed by a separator or the end, never as the prefix of a sibling name.
	const patterns = roots.map((root) => new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\\\/]|$)`, "g"));
	let replacements = 0;
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") {
			let next = value;
			for (const pattern of patterns) next = next.replace(pattern, PI_LIFECYCLE_SCRATCH_PLACEHOLDER);
			if (next !== value) replacements += 1;
			return next;
		}
		if (Array.isArray(value)) return value.map(walk);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
		}
		return value;
	};
	return { events: events.map((event) => walk(event) as EndoEventV0), replacements };
}
export const PI_LIFECYCLE_SESSIONS = ["completes", "stop-mid-turn", "killed-and-resumed"] as const;
export type PiLifecycleSessionNameV0 = (typeof PI_LIFECYCLE_SESSIONS)[number];

/** The prompts. The long one is long for a real model; the fake Pi streams long turns for prompts that say "forty". */
export const PI_LIFECYCLE_PROMPTS = {
	short: "Reply with the single word: ready",
	long: "Count slowly from one to forty thousand, one number per line, with no other text.",
	afterResume: "Reply with the single word: resumed",
} as const;

export interface PiLifecycleRecorderOptionsV0 {
	/** The Pi executable to run. */
	readonly pi: string;
	/** The OpenAI-compatible endpoint, e.g. http://127.0.0.1:8080/v1; null for the fake Pi, which calls no model. */
	readonly baseUrl: string | null;
	readonly model: string;
	readonly providerName: string;
	/** The name of an environment variable holding the endpoint's API key, if it needs one. */
	readonly apiKeyEnv: string | null;
	/**
	 * Where to write. Null: `research/pi-conformance/<the Pi version it ran>/lifecycle`. A path of that shape naming a
	 * different version is refused, so a recording is never filed under a release it was not made against.
	 */
	readonly out: string | null;
	readonly authorizeLiveStudy: boolean;
	readonly timeoutMs: number;
	/** "real" for a real Pi and model; "fake-pi" only for the deterministic suite's committed fake fixtures. */
	readonly kind: "real" | "fake-pi";
	/** Extra environment for Pi (the fake Pi's scenario knobs); not recorded. */
	readonly extraEnv?: Readonly<Record<string, string>>;
	readonly force?: boolean;
	/** The sessions to record, in this order; default all of PI_LIFECYCLE_SESSIONS. */
	readonly sessions?: readonly PiLifecycleSessionNameV0[];
	readonly log?: (line: string) => void;
}

/** What one recorded session produced. */
export interface PiLifecycleSessionReportV0 {
	name: PiLifecycleSessionNameV0;
	status: "recorded" | "skipped";
	reason: string | null;
	eventCount: number;
	/** sha256 of the events file's bytes. */
	eventsSha256: string | null;
	/** Strings in which the recorder's scratch root was replaced by the placeholder (D3). */
	scratchRootReplacements: number;
	notes: string[];
}

const FAKE_PI_SOURCE = fileURLToPath(new URL("../tests/fixtures/fake-pi/cli.mjs", import.meta.url));

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** An endpoint URL without credentials, query or fragment. */
export function scrubEndpointUrlV0(url: string): string {
	const parsed = new URL(url);
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/$/, "");
}

async function endpointModels(baseUrl: string, apiKey: string | null): Promise<JsonValueV0> {
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
			headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return { status: "UNAVAILABLE", reason: `GET /models answered HTTP ${response.status}` };
		const body = (await response.json()) as { data?: unknown };
		const ids = Array.isArray(body.data)
			? body.data
					.map((entry) =>
						typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined,
					)
					.filter((id): id is string => typeof id === "string")
					.sort()
			: null;
		return ids === null
			? { status: "UNAVAILABLE", reason: "GET /models returned no data[] list" }
			: { status: "reported", value: ids };
	} catch (error) {
		return { status: "UNAVAILABLE", reason: `GET /models failed: ${(error as Error).name}` };
	}
}

/** Where Pi runs: a scratch directory, its environment and working directory. */
export interface PiLifecycleScratchV0 {
	readonly directory: string;
	readonly env: Record<string, string>;
	readonly cwd: string;
}

function scratchFor(options: PiLifecycleRecorderOptionsV0, apiKey: string | null): PiLifecycleScratchV0 {
	const directory = mkdtempSync(join(tmpdir(), "endo-lifecycle-"));
	const agentDir = join(directory, "agent");
	const home = join(directory, "home");
	const cwd = join(directory, "work");
	for (const path of [agentDir, home, cwd]) mkdirSync(path, { recursive: true });
	if (options.baseUrl !== null) {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[options.providerName]: {
						baseUrl: options.baseUrl,
						api: "openai-completions",
						apiKey: apiKey ?? "local",
						models: [{ id: options.model }],
					},
				},
			}),
		);
	}
	return {
		directory,
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			...(options.extraEnv ?? {}),
		},
	};
}

function attachmentFor(
	options: PiLifecycleRecorderOptionsV0,
	scratch: PiLifecycleScratchV0,
	root: string,
): PiAttachmentV0 {
	return new PiAttachmentV0({
		root,
		cwd: scratch.cwd,
		executable: options.pi,
		env: scratch.env,
		provider: options.providerName,
		model: options.model,
		requestTimeoutMs: Math.max(60_000, options.timeoutMs),
	});
}

/** Wait until Pi has streamed at least `count` deltas in this session (it is mid-turn), or the timeout. */
async function untilStreaming(session: PiSessionAttachmentV0, count: number, timeoutMs: number): Promise<boolean> {
	const start = session.counters.deltasDropped;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (session.counters.deltasDropped - start >= count) return true;
		if (session.connection !== "running") return false;
		await sleep(10);
	}
	return false;
}

function readEvents(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const events = store.page({ limit: 10_000 }).events.map((event) => JSON.parse(canonicalEndoJsonV0(event)));
	store.close();
	return events;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The child half of killed-and-resumed: open the session, start the long prompt, report once Pi streams, wait. */
async function childMain(config: {
	options: PiLifecycleRecorderOptionsV0;
	scratch: PiLifecycleScratchV0;
	root: string;
}) {
	const pi = attachmentFor(config.options, config.scratch, config.root);
	const session = await pi.openSession();
	await session.prompt(PI_LIFECYCLE_PROMPTS.long);
	const streaming = await untilStreaming(session, 2, config.options.timeoutMs);
	process.stdout.write(
		`${JSON.stringify({ stage: streaming ? "streaming" : "not-streaming", piPid: session.pid ?? null })}\n`,
	);
	// Wait to be killed. If nobody kills this process, it ends the session normally after the timeout.
	await sleep(config.options.timeoutMs);
	await session.close();
}

/**
 * Run the killed-and-resumed child against `root`: it opens the session and starts the long prompt; once Pi streams,
 * the child is SIGKILLed. Returns whether the kill landed mid-stream; `notes` says what was observed.
 */
export async function killPiSessionChildV0(
	options: PiLifecycleRecorderOptionsV0,
	scratch: PiLifecycleScratchV0,
	root: string,
	notes: string[],
): Promise<boolean> {
	const script = fileURLToPath(import.meta.url);
	const payload = Buffer.from(JSON.stringify({ options: { ...options, log: undefined }, scratch, root })).toString(
		"base64",
	);
	const child = spawn(process.execPath, [script, "--child", payload], { stdio: ["ignore", "pipe", "inherit"] });
	const line = await new Promise<string | null>((done) => {
		let buffer = "";
		const timer = setTimeout(() => done(null), options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index !== -1) {
				clearTimeout(timer);
				done(buffer.slice(0, index));
			}
		});
		child.on("exit", () => {
			clearTimeout(timer);
			done(null);
		});
	});
	const report = line === null ? null : (JSON.parse(line) as { stage: string; piPid: number | null });
	child.kill("SIGKILL");
	await new Promise((done) =>
		child.exitCode !== null || child.signalCode !== null ? done(null) : child.on("exit", done),
	);
	if (report === null || report.stage !== "streaming") {
		notes.push(`the child never saw Pi stream (${report?.stage ?? "no report"}); it was killed anyway`);
		return false;
	}
	notes.push("the Endophasia child process was SIGKILLed while Pi was streaming a turn");
	if (report.piPid !== null) {
		const deadline = Date.now() + 15_000;
		while (pidAlive(report.piPid) && Date.now() < deadline) await sleep(50);
		notes.push(
			pidAlive(report.piPid)
				? `Pi (pid ${report.piPid}) was still running 15 s after the kill`
				: "Pi ended with its process group when the child died",
		);
	}
	return true;
}

async function recordSession(
	name: PiLifecycleSessionNameV0,
	options: PiLifecycleRecorderOptionsV0,
	scratch: PiLifecycleScratchV0,
	checked: string,
): Promise<{ report: PiLifecycleSessionReportV0; events: EndoEventV0[] }> {
	const root = join(scratch.directory, `root-${name}`);
	mkdirSync(root, { recursive: true });
	// The checks ran once, in `checked`; each session's store starts from that registry and its cited transcripts.
	for (const part of ["harness", "artifacts"]) {
		if (existsSync(join(checked, part))) cpSync(join(checked, part), join(root, part), { recursive: true });
	}
	rmSync(join(root, "harness", "pi.default", "pi-session.json"), { force: true });
	const notes: string[] = [];
	const skipped = (reason: string) => ({
		report: {
			name,
			status: "skipped" as const,
			reason,
			eventCount: 0,
			eventsSha256: null,
			scratchRootReplacements: 0,
			notes,
		},
		events: [],
	});
	if (name === "completes") {
		const session = await attachmentFor(options, scratch, root).openSession();
		await session.prompt(PI_LIFECYCLE_PROMPTS.short);
		if (!(await session.waitForSettled(options.timeoutMs))) notes.push("agent_settled was not observed in time");
		await session.close();
	} else if (name === "stop-mid-turn") {
		const session = await attachmentFor(options, scratch, root).openSession();
		const stop = session.capabilityState.capabilities.find((entry) => entry.capability === "steering.stop");
		if (stop === undefined || (stop.status !== "admitted" && stop.status !== "admitted-partial")) {
			await session.close();
			return skipped(`steering.stop is ${stop?.status ?? "unknown"}: ${stop?.reason ?? "no evidence"}`);
		}
		await session.prompt(PI_LIFECYCLE_PROMPTS.long);
		if (!(await untilStreaming(session, 2, options.timeoutMs))) notes.push("Pi did not stream before the STOP");
		// Pi answers abort only once the session is idle (rpc-commands.md#abort), so agent_settled can arrive before the
		// acceptance: listen first.
		const settled = session.waitForSettled(options.timeoutMs);
		await session.stop();
		if (!(await settled)) notes.push("agent_settled was not observed after STOP");
		await session.close();
	} else {
		await killPiSessionChildV0(options, scratch, root, notes);
		const session = await attachmentFor(options, scratch, root).openSession();
		await session.prompt(PI_LIFECYCLE_PROMPTS.afterResume);
		if (!(await session.waitForSettled(options.timeoutMs))) notes.push("agent_settled was not observed after resume");
		await session.close();
	}
	const normalized = normalizeScratchRootV0(readEvents(root), [scratch.directory, realpathSync(scratch.directory)]);
	return {
		report: {
			name,
			status: "recorded",
			reason: null,
			eventCount: normalized.events.length,
			eventsSha256: null,
			scratchRootReplacements: normalized.replacements,
			notes,
		},
		events: normalized.events,
	};
}

/** The repository's conformance research directory. */
export const PI_CONFORMANCE_DIRECTORY = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"research",
	"pi-conformance",
);

/**
 * The directory a recording against Pi `version` goes to: `out` when given, else the version's `lifecycle/`. Refuses
 * an `out` shaped `pi-conformance/<v>/lifecycle` for another version, and a default when Pi reported no version.
 */
export function piLifecycleOutputDirectoryV0(out: string | null, version: string | null): string {
	if (out === null) {
		if (version === null || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) {
			throw new TypeError("Pi reported no usable version, so the recording has no version directory; pass --out");
		}
		return join(PI_CONFORMANCE_DIRECTORY, version, "lifecycle");
	}
	const resolved = resolve(out);
	const named = /[\\/]pi-conformance[\\/]([^\\/]+)[\\/]lifecycle[\\/]?$/.exec(resolved)?.[1];
	if (named !== undefined && named !== version) {
		throw new TypeError(
			`${resolved} is the lifecycle directory of Pi ${named}, but the Pi that ran reports ${version ?? "no version"}`,
		);
	}
	return resolved;
}

function refuseExistingRecording(out: string, force: boolean): void {
	if (existsSync(join(out, "provenance.json")) && !force) {
		throw new TypeError(`${out} already holds a recording; pass --force to replace it`);
	}
}

/** Record the three lifecycle sessions and write the fixture. Returns the provenance written. */
export async function recordPiLifecycleFixturesV0(options: PiLifecycleRecorderOptionsV0): Promise<JsonValueV0> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	if (options.out !== null) refuseExistingRecording(resolve(options.out), options.force === true);
	const apiKey = options.apiKeyEnv === null ? null : (process.env[options.apiKeyEnv] ?? null);
	if (options.apiKeyEnv !== null && apiKey === null) throw new TypeError(`${options.apiKeyEnv} is not set`);
	const scratch = scratchFor(options, apiKey);
	try {
		const checked = join(scratch.directory, "root-checks");
		const pi = attachmentFor(options, scratch, checked);
		const { fingerprint } = await pi.identify();
		if (fingerprint === null) throw new TypeError("the Pi executable could not be identified");
		const fakeDigest = sha256HexV0(readFileSync(FAKE_PI_SOURCE));
		if (options.kind === "real" && fingerprint.local.entrypoint?.sha256 === fakeDigest) {
			throw new TypeError("that executable is the deterministic suite's fake Pi; a real recording needs a real Pi");
		}
		log(`Pi ${fingerprint.reported.version ?? "(no version)"} at ${fingerprint.local.realPath ?? options.pi}`);
		const out = piLifecycleOutputDirectoryV0(options.out, fingerprint.reported.version);
		const sessions = options.sessions ?? PI_LIFECYCLE_SESSIONS;
		if (
			PI_LIFECYCLE_SESSIONS.some((name) => !sessions.includes(name)) &&
			/[\\/]pi-conformance[\\/][^\\/]+[\\/]lifecycle[\\/]?$/.test(out)
		) {
			throw new TypeError(
				`${out} holds a version's full lifecycle fixture; record a subset of sessions elsewhere (--out)`,
			);
		}
		refuseExistingRecording(out, options.force === true);
		log(`writing to ${out}`);
		await pi.checkLocal();
		if (options.authorizeLiveStudy) {
			log("running the live study (sends prompts to your model)");
			await pi.studyLive({ authorized: true, stepTimeoutMs: options.timeoutMs });
		}
		const reports: PiLifecycleSessionReportV0[] = [];
		mkdirSync(out, { recursive: true });
		const models = new Set<string>();
		for (const name of sessions) {
			log(`recording ${name}`);
			const { report, events } = await recordSession(name, options, scratch, checked);
			if (report.status === "recorded") {
				// One event per line: the canonical key order, without the canonical form's indentation.
				const lines = `${events.map((event) => JSON.stringify(JSON.parse(canonicalEndoJsonV0(event)))).join("\n")}\n`;
				writeFileSync(join(out, `${name}.events.jsonl`), lines);
				report.eventsSha256 = sha256HexV0(lines);
				writeFileSync(join(out, `${name}.overview.json`), canonicalEndoJsonV0(reduceEndoSessionOverviewV0(events)));
				for (const event of events) {
					const details = (event.payload as { details?: { role?: unknown; provider?: unknown; model?: unknown } })
						.details;
					if (event.kind === "session.entry-observed" && details?.role === "assistant")
						models.add(`${String(details.provider)}/${String(details.model)}`);
				}
			} else {
				rmSync(join(out, `${name}.events.jsonl`), { force: true });
				rmSync(join(out, `${name}.overview.json`), { force: true });
			}
			log(`  ${report.status}${report.reason === null ? "" : `: ${report.reason}`}`);
			reports.push(report);
		}
		const provenance: JsonValueV0 = {
			schemaVersion: "endo.pi-lifecycle-fixture.v0",
			kind: options.kind,
			recorder: PI_LIFECYCLE_RECORDER_VERSION,
			recordedAt: new Date().toISOString(),
			host: { platform: process.platform, node: process.version },
			endophasia: { adapter: PI_ADAPTER_VERSION, mapping: PI_MAPPING_VERSION, suite: PI_SUITE_VERSION },
			pi: {
				version: fingerprint.reported.version,
				package: fingerprint.local.package === null ? null : { ...fingerprint.local.package, root: null },
				entrypointSha256: fingerprint.local.entrypoint?.sha256 ?? null,
				identityDigest: fingerprint.identity.digest,
				isDeterministicSuiteFake: fingerprint.local.entrypoint?.sha256 === fakeDigest,
			},
			model: {
				provider: options.providerName,
				modelId: options.model,
				api: "openai-completions",
				endpoint: options.baseUrl === null ? null : scrubEndpointUrlV0(options.baseUrl),
				endpointReportedModels:
					options.baseUrl === null
						? { status: "UNAVAILABLE", reason: "no endpoint: the fake Pi calls no model" }
						: await endpointModels(options.baseUrl, apiKey),
				reportedByPi: [...models].sort(),
				apiKey: options.apiKeyEnv === null ? "none configured" : `read from $${options.apiKeyEnv}; not recorded`,
			},
			liveStudyAuthorized: options.authorizeLiveStudy,
			normalization: {
				scratchRoot: {
					placeholder: PI_LIFECYCLE_SCRATCH_PLACEHOLDER,
					rule: "every occurrence of the recorder-owned scratch directory (as created and as its real path) in an event string is replaced by the placeholder; no other path is changed",
					appliesTo:
						"<session>.events.jsonl and <session>.overview.json; eventsSha256 is over the normalized file",
				},
			},
			prompts: { ...PI_LIFECYCLE_PROMPTS },
			sessions: reports.map((report) => ({ ...report, notes: [...report.notes] })),
		};
		writeFileSync(join(out, "provenance.json"), `${JSON.stringify(provenance, null, "\t")}\n`);
		return provenance;
	} finally {
		rmSync(scratch.directory, { recursive: true, force: true });
	}
}

function parseArgs(argv: readonly string[]): PiLifecycleRecorderOptionsV0 {
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
	const sessions = flags.has("--sessions") ? flags.get("--sessions")!.split(",") : [...PI_LIFECYCLE_SESSIONS];
	for (const name of sessions) {
		if (!(PI_LIFECYCLE_SESSIONS as readonly string[]).includes(name))
			throw new TypeError(`unknown session ${name}; choose from ${PI_LIFECYCLE_SESSIONS.join(", ")}`);
	}
	const timeout = Number(flags.get("--timeout-ms") ?? "300000");
	if (!Number.isInteger(timeout) || timeout <= 0) throw new TypeError("--timeout-ms must be a positive integer");
	return {
		pi: required("--pi"),
		baseUrl: required("--base-url"),
		model: required("--model"),
		providerName: flags.get("--provider-name") ?? "endolocal",
		apiKeyEnv: flags.get("--api-key-env") ?? null,
		out: flags.get("--out") ?? null,
		authorizeLiveStudy: switches.has("--authorize-live-study"),
		timeoutMs: timeout,
		kind: "real",
		force: switches.has("--force"),
		sessions: sessions as PiLifecycleSessionNameV0[],
	};
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv[2] === "--child") {
		const config = JSON.parse(Buffer.from(process.argv[3] ?? "", "base64").toString("utf8"));
		childMain(config).then(
			() => process.exit(0),
			(error: unknown) => {
				process.stderr.write(`${(error as Error).message}\n`);
				process.exit(1);
			},
		);
	} else {
		try {
			const options = parseArgs(process.argv.slice(2));
			if (!options.authorizeLiveStudy) {
				process.stderr.write(
					"note: without --authorize-live-study, steering.stop stays unverified and stop-mid-turn is skipped\n",
				);
			}
			recordPiLifecycleFixturesV0(options).then(
				() => process.stderr.write("done\n"),
				(error: unknown) => {
					process.stderr.write(`${(error as Error).message}\n`);
					process.exit(1);
				},
			);
		} catch (error) {
			process.stderr.write(`${(error as Error).message}\n`);
			process.exit(2);
		}
	}
}
