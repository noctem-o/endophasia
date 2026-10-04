// Cassette sessions: record a scripted Pi session through the recording proxy, and replay it against the cassette
// server, so the model's outputs are held fixed and only Pi's control flow runs again (docs/replay.md).
//
// Recording (recordPiCassetteSessionV0), into one Endophasia store per session:
//   1. A scratch root at an absolute path: `home/` (Pi's HOME), `agent/` (PI_CODING_AGENT_DIR, a models.json naming
//      only the recording proxy) and `work/` (the workspace, seeded with the scenario's files).
//   2. The whole scratch root is snapshotted (storage/workspace-snapshot.ts) before Pi starts: `capture.workspace-snapshot`
//      records its path and the archive's keyed digest; the archive goes to the blob store.
//   3. The proxy records every exchange into `<store>/capture/`; the driver records each step it takes there too
//      (`capture.driver-step`, producer `capture:driver`): opens, prompts (text in the blob store), the STOP or kill
//      point as the proxy's delivery count at that instant (`{exchange, chunks}`), reopens and closes.
//   4. Pi itself records into the store through the attachment, as for any session.
//
// Replaying (replayPiCassetteSessionV0), into a new store:
//   1. The cassette must be in the replay's digest domain (cassette.ts refuses another one, with the reason).
//   2. The scratch root is restored at the SAME absolute path (it must not exist): Pi's requests carry the working
//      directory, and recorded tool calls may name absolute paths, so a replay elsewhere would neither match the
//      cassette nor touch the same files.
//   3. The cassette server binds the port the proxy listened on (Pi's models.json names it, and Pi's configuration
//      digest covers models.json, so the capability evidence recorded with the session still applies).
//   4. The recording's capability evidence (harness registry and artifacts) is copied into the new store, and the new
//      store asks Pi for the recorded session id. Pi is started fresh, and the recorded steps are driven again: each
//      prompt, and a STOP or a SIGKILL after exactly the recorded number of response chunks had been delivered (the
//      server pauses there until the driver has acted).
//   5. PR C's trajectory comparison is run between the two stores (runtime/contracts/trajectory.ts).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EndoCaptureLogV0, endoCaptureRootV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import {
	type EndoCassetteTimingV0,
	loadEndoCassetteV0,
	startEndoCassetteServerV0,
} from "../adapters/openai-proxy/cassette.ts";
import type { EndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { PiAttachmentV0, type PiSessionAttachmentV0 } from "../adapters/pi/attachment.ts";
import { piTrajectoryAttachmentsV0, projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { type EndoExperimentEnvironmentV0, endoExperimentEnvironmentProblemV0 } from "../protocol/experiment-spec.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import type { EndoTrajectoryComparisonV0 } from "../protocol/trajectory.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../runtime/contracts/keyed-digest.ts";
import { compareEndoTrajectoriesV0 } from "../runtime/contracts/trajectory.ts";
import { createEndoBlobStoreV0 } from "../storage/blob-store.ts";
import { endoDigestKeyFromEnvironmentV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import {
	archiveEndoWorkspaceV0,
	pinEndoWorkspaceTimesV0,
	restoreEndoWorkspaceV0,
} from "../storage/workspace-snapshot.ts";

export const PI_CASSETTE_DRIVER_VERSION_V0 = "pi-cassette-driver.1";

/** The producer the driver's steps are recorded under, in the session's capture log. */
export const PI_CASSETTE_DRIVER_PRODUCER_V0 = "capture:driver";

/** One step of a scenario. */
export type PiCassetteStepV0 =
	/** Prompt and wait for agent_settled. */
	| { op: "prompt"; text: string }
	/** Prompt; once the proxy has relayed `afterChunks` chunks of the response, STOP; wait for agent_settled. */
	| { op: "prompt-stop"; text: string; afterChunks: number }
	/**
	 * Prompt from a child process; once the proxy has relayed `afterChunks` chunks, SIGKILL the child (Pi ends with its
	 * process group); then reopen the same store and Pi session in this process.
	 */
	| { op: "prompt-kill"; text: string; afterChunks: number };

export interface PiCassetteScenarioV0 {
	readonly name: string;
	/** What the scenario asks of the model, in one line (for provenance). */
	readonly purpose: string;
	/** The workspace's files before the session: relative path to content. */
	readonly workspace: Readonly<Record<string, string>>;
	readonly steps: readonly PiCassetteStepV0[];
}

/** Where the digest key comes from: the committed public fixture key file, or the installation key. */
export type PiCassetteKeySourceV0 = { kind: "fixture"; path: string } | { kind: "installation" };

export function piCassetteKeyV0(source: PiCassetteKeySourceV0): EndoDigestKeyV0 {
	return source.kind === "fixture" ? loadEndoFixtureDigestKeyV0(source.path) : endoDigestKeyFromEnvironmentV0();
}

/** Pi's scratch: HOME, agent directory and workspace under one root, and the environment Pi runs with. */
export interface PiCassetteScratchV0 {
	readonly root: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
}

/** The environment Pi runs with for a scratch root. PATH is this process's (never recorded). */
export function piCassetteEnvV0(
	root: string,
	variables: Readonly<Record<string, string>> = {},
): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(root, "home"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
		...variables,
	};
}

/** A pinned environment for a session: an experiment condition's `environment` (protocol/experiment-spec.ts). */
export type PiCassetteEnvironmentV0 = EndoExperimentEnvironmentV0;

/** The variables as Pi sees them: `{root}` replaced by the scratch root. */
export function piCassetteVariablesV0(
	environment: PiCassetteEnvironmentV0 | undefined,
	root: string,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment?.variables ?? {}).map(([name, value]) => [name, value.replaceAll("{root}", root)]),
	);
}

/**
 * Create a scratch root: models.json names only `baseUrl` (no API key: a cassette recording of a keyed endpoint would
 * put the key into the snapshot, so it is not supported), and the workspace holds `files`.
 */
export function createPiCassetteScratchV0(
	root: string,
	options: {
		baseUrl: string;
		provider: string;
		model: string;
		files: Readonly<Record<string, string>>;
		/** Fields merged into the models.json model entry (Pi's documented model configuration); never `id`. */
		modelEntry?: Readonly<Record<string, JsonValueV0>>;
		/** Extensions for Pi's agent directory (extensions/<file>), when the session needs any. */
		extensions?: Readonly<Record<string, string>>;
		/** Pi's settings.json (documented settings), when the session needs one. */
		settings?: Readonly<Record<string, JsonValueV0>>;
		/** A pinned environment (variables, env/ files, a fixed time for every entry). */
		environment?: PiCassetteEnvironmentV0;
	},
): PiCassetteScratchV0 {
	if (options.environment !== undefined) {
		const problem = endoExperimentEnvironmentProblemV0(options.environment);
		if (problem !== null) throw new TypeError(problem);
	}
	if (existsSync(root)) throw new TypeError(`${root} exists; a cassette scratch root is created fresh`);
	for (const part of ["home", "agent", "work"]) mkdirSync(join(root, part), { recursive: true });
	writeFileSync(
		join(root, "agent", "models.json"),
		JSON.stringify({
			providers: {
				[options.provider]: {
					baseUrl: options.baseUrl,
					api: "openai-completions",
					apiKey: "local",
					models: [{ ...(options.modelEntry ?? {}), id: options.model }],
				},
			},
		}),
	);
	if (options.settings !== undefined)
		writeFileSync(join(root, "agent", "settings.json"), JSON.stringify(options.settings));
	if (options.extensions !== undefined) {
		mkdirSync(join(root, "agent", "extensions"), { recursive: true });
		for (const [file, source] of Object.entries(options.extensions))
			writeFileSync(join(root, "agent", "extensions", file), source);
	}
	for (const [path, content] of Object.entries(options.files)) {
		mkdirSync(dirname(join(root, "work", path)), { recursive: true });
		writeFileSync(join(root, "work", path), content);
	}
	for (const [path, content] of Object.entries(options.environment?.files ?? {})) {
		mkdirSync(dirname(join(root, "env", path)), { recursive: true });
		writeFileSync(join(root, "env", path), content);
	}
	if (options.environment?.fileTime !== undefined)
		pinEndoWorkspaceTimesV0(root, Date.parse(options.environment.fileTime));
	return {
		root,
		cwd: join(root, "work"),
		env: piCassetteEnvV0(root, piCassetteVariablesV0(options.environment, root)),
	};
}

/** What the attachment needs, shared by this process and the kill child. */
export interface PiCassetteAttachmentConfigV0 {
	readonly root: string;
	readonly scratchRoot: string;
	readonly pi: string;
	readonly provider: string;
	readonly model: string;
	readonly keySource: PiCassetteKeySourceV0;
	readonly requestTimeoutMs: number;
	/** Variables added to Pi's environment (a pinned environment's, `{root}` already replaced). */
	readonly variables?: Readonly<Record<string, string>>;
}

export function piCassetteAttachmentV0(config: PiCassetteAttachmentConfigV0): PiAttachmentV0 {
	return new PiAttachmentV0({
		root: config.root,
		cwd: join(config.scratchRoot, "work"),
		executable: config.pi,
		env: piCassetteEnvV0(config.scratchRoot, config.variables),
		provider: config.provider,
		model: config.model,
		requestTimeoutMs: config.requestTimeoutMs,
		digestKey: piCassetteKeyV0(config.keySource),
		digestDomain: config.keySource.kind === "fixture" ? "fixture" : "private",
	});
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const CHILD = fileURLToPath(new URL("./cassette-child.ts", import.meta.url));

/** A child process that opens the session on `config.root`, prompts, reports, and waits to be killed. */
async function promptInChild(
	config: PiCassetteAttachmentConfigV0,
	text: string,
	timeoutMs: number,
): Promise<{ kill: () => Promise<string[]> }> {
	const payload = Buffer.from(JSON.stringify({ config, text, timeoutMs })).toString("base64");
	const child = spawn(process.execPath, [CHILD, payload], { stdio: ["ignore", "pipe", "inherit"] });
	const line = await new Promise<string | null>((done) => {
		let buffer = "";
		const timer = setTimeout(() => done(null), timeoutMs);
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
	if (line === null) {
		child.kill("SIGKILL");
		throw new TypeError("the prompting child never reported that it prompted");
	}
	const report = JSON.parse(line) as { piPid: number | null };
	return {
		async kill() {
			const notes: string[] = [];
			child.kill("SIGKILL");
			await new Promise((done) =>
				child.exitCode !== null || child.signalCode !== null ? done(null) : child.on("exit", done),
			);
			notes.push("the Endophasia child process was SIGKILLed");
			if (report.piPid !== null) {
				const deadline = Date.now() + 15_000;
				while (pidAlive(report.piPid) && Date.now() < deadline) await sleep(50);
				notes.push(
					pidAlive(report.piPid) ? "Pi was still running 15 s after the kill" : "Pi ended with its process group",
				);
			}
			return notes;
		},
	};
}

/** Wait until the proxy has started exchange `exchange` and relayed `chunks` chunks of it. */
async function untilRelayed(
	proxy: EndoRecordingProxyV0,
	exchange: number,
	chunks: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while ((proxy.delivery()?.exchange ?? 0) < exchange) {
		if (Date.now() > deadline) return false;
		await sleep(5);
	}
	return Promise.race([
		proxy.untilDelivered(exchange, chunks).then(() => true),
		sleep(Math.max(0, deadline - Date.now())).then(() => false),
	]);
}

function copyEvidence(from: string, to: string): void {
	for (const part of ["harness", "artifacts"])
		if (existsSync(join(from, part))) cpSync(join(from, part), join(to, part), { recursive: true });
	rmSync(join(to, "harness", "pi.default", "pi-session.json"), { force: true });
}

export interface PiCassetteRecordOptionsV0 {
	readonly scenario: PiCassetteScenarioV0;
	readonly pi: string;
	readonly provider: string;
	readonly model: string;
	/** A running recording proxy; its log is switched to this session's store for the session. */
	readonly proxy: EndoRecordingProxyV0;
	/** The (new) store this session records into. */
	readonly store: string;
	/** Where the scratch root goes (absolute; must not exist). */
	readonly scratchRoot: string;
	readonly keySource: PiCassetteKeySourceV0;
	/** A store whose harness registry and artifacts (capability evidence) the session starts from. */
	readonly evidenceFrom: string | null;
	readonly timeoutMs: number;
	/** Passed to createPiCassetteScratchV0 (an experiment condition's documented Pi configuration). */
	readonly modelEntry?: Readonly<Record<string, JsonValueV0>>;
	readonly settings?: Readonly<Record<string, JsonValueV0>>;
	readonly extensions?: Readonly<Record<string, string>>;
	/** A pinned environment (an experiment condition's), recorded as `capture.environment`. */
	readonly environment?: PiCassetteEnvironmentV0;
	/** Runs after the session closed and before the scratch root is removed (an experiment's success check). */
	readonly afterSession?: (scratchRoot: string) => Promise<void> | void;
}

export interface PiCassetteRecordReportV0 {
	piSessionId: string | null;
	notes: string[];
}

/** Record one scenario as a cassette session. */
export async function recordPiCassetteSessionV0(options: PiCassetteRecordOptionsV0): Promise<PiCassetteRecordReportV0> {
	const key = piCassetteKeyV0(options.keySource);
	mkdirSync(options.store, { recursive: true });
	if (options.evidenceFrom !== null) copyEvidence(options.evidenceFrom, options.store);
	const scratch = createPiCassetteScratchV0(options.scratchRoot, {
		baseUrl: `${options.proxy.origin}/v1`,
		provider: options.provider,
		model: options.model,
		files: options.scenario.workspace,
		...(options.modelEntry === undefined ? {} : { modelEntry: options.modelEntry }),
		...(options.settings === undefined ? {} : { settings: options.settings }),
		...(options.extensions === undefined ? {} : { extensions: options.extensions }),
		...(options.environment === undefined ? {} : { environment: options.environment }),
	});
	const log = new EndoCaptureLogV0(options.store, key, "record", { async: true });
	const notes: string[] = [];
	let step = 0;
	const driver = (op: string, payload: Record<string, JsonValueV0> = {}) => {
		step += 1;
		log.record(
			"capture.driver-step",
			{ driver: PI_CASSETTE_DRIVER_VERSION_V0, step, op, ...payload },
			PI_CASSETTE_DRIVER_PRODUCER_V0,
		);
	};
	const variables = piCassetteVariablesV0(options.environment, scratch.root);
	if (options.environment !== undefined)
		log.record(
			"capture.environment",
			{
				variables,
				fileTime: options.environment.fileTime ?? null,
				files: Object.fromEntries(
					Object.entries(options.environment.files ?? {}).map(([path, content]) => [
						path,
						{
							sha256: createHash("sha256").update(content).digest("hex"),
							bytes: Buffer.byteLength(content),
						},
					]),
				),
			},
			PI_CASSETTE_DRIVER_PRODUCER_V0,
		);
	const archive = archiveEndoWorkspaceV0(scratch.root);
	log.record(
		"capture.workspace-snapshot",
		{
			scratchRoot: scratch.root,
			workspace: "work",
			archive: { ...log.keep(archive.bytes) } as unknown as JsonValueV0,
			summary: { ...archive.summary },
		},
		PI_CASSETTE_DRIVER_PRODUCER_V0,
	);
	options.proxy.log = log;
	const config: PiCassetteAttachmentConfigV0 = {
		root: options.store,
		scratchRoot: scratch.root,
		pi: options.pi,
		provider: options.provider,
		model: options.model,
		keySource: options.keySource,
		requestTimeoutMs: Math.max(60_000, options.timeoutMs),
		variables,
	};
	let session: PiSessionAttachmentV0 | null = null;
	let piSessionId: string | null = null;
	const open = async (op: "open" | "reopen") => {
		const attachment = piCassetteAttachmentV0(config);
		session = await attachment.openSession();
		piSessionId = attachment.sessionConfig().sessionId;
		driver(op, { attachment: attachment.attachment, provider: options.provider, model: options.model, piSessionId });
	};
	const prompted = (text: string, mode: string) =>
		driver("prompt", { mode, text: { ...log.keep(Buffer.from(text, "utf8")) } as unknown as JsonValueV0 });
	try {
		for (const entry of options.scenario.steps) {
			const next = (options.proxy.delivery()?.exchange ?? 0) + 1;
			if (entry.op === "prompt") {
				if (session === null) await open("open");
				prompted(entry.text, "settle");
				await session!.prompt(entry.text);
				const settled = await session!.waitForSettled(options.timeoutMs);
				driver("settled", { observed: settled });
				if (!settled) notes.push(`agent_settled was not observed after step ${step}`);
			} else if (entry.op === "prompt-stop") {
				if (session === null) await open("open");
				prompted(entry.text, "stop");
				await session!.prompt(entry.text);
				if (!(await untilRelayed(options.proxy, next, entry.afterChunks, options.timeoutMs)))
					notes.push(`the proxy did not relay ${entry.afterChunks} chunks of exchange ${next} before the STOP`);
				const settled = session!.waitForSettled(options.timeoutMs);
				driver("stop", { at: options.proxy.delivery() as unknown as JsonValueV0 });
				await session!.stop();
				const observed = await settled;
				driver("settled", { observed });
				if (!observed) notes.push("agent_settled was not observed after STOP");
			} else {
				if (session !== null) {
					await (session as PiSessionAttachmentV0).close();
					session = null;
				}
				prompted(entry.text, "kill");
				driver("open-child", { provider: options.provider, model: options.model });
				const child = await promptInChild(config, entry.text, options.timeoutMs);
				if (!(await untilRelayed(options.proxy, next, entry.afterChunks, options.timeoutMs)))
					notes.push(`the proxy did not relay ${entry.afterChunks} chunks of exchange ${next} before the kill`);
				driver("kill", { at: options.proxy.delivery() as unknown as JsonValueV0 });
				notes.push(...(await child.kill()));
				await open("reopen");
			}
		}
		if (session !== null) await (session as PiSessionAttachmentV0).close();
		session = null;
		driver("close");
		await options.afterSession?.(scratch.root);
	} finally {
		if (session !== null) await (session as PiSessionAttachmentV0).close().catch(() => {});
		await options.proxy.flush();
		options.proxy.log = null;
		log.close();
		rmSync(scratch.root, { recursive: true, force: true });
	}
	return { piSessionId, notes };
}

/** The driver's recorded steps and the snapshot, from a cassette. */
export interface PiCassetteScriptV0 {
	snapshot: { scratchRoot: string; archive: { digest: EndoKeyedDigestV0; bytes: number } };
	steps: Record<string, unknown>[];
	/** The pinned environment the recording ran with (`capture.environment`), or null for none. */
	environment: { variables: Record<string, string>; fileTime: string | null; files: Record<string, unknown> } | null;
}

export function piCassetteScriptV0(events: readonly EndoEventV0[]): PiCassetteScriptV0 {
	const driver = events.filter((event) => event.producer === PI_CASSETTE_DRIVER_PRODUCER_V0);
	const snapshot = driver.find((event) => event.kind === "capture.workspace-snapshot")?.payload as
		| PiCassetteScriptV0["snapshot"]
		| undefined;
	if (snapshot === undefined) throw new TypeError("the cassette holds no workspace snapshot");
	const steps = driver
		.filter((event) => event.kind === "capture.driver-step")
		.map((event) => event.payload as Record<string, unknown>);
	if (steps.length === 0)
		throw new TypeError("the cassette holds no driver steps: it was not recorded by the session driver");
	const driverVersions = new Set(steps.map((entry) => entry.driver));
	if (driverVersions.size !== 1 || !driverVersions.has(PI_CASSETTE_DRIVER_VERSION_V0))
		throw new TypeError(
			`the cassette's driver steps are ${[...driverVersions].join(", ")}, not ${PI_CASSETTE_DRIVER_VERSION_V0}`,
		);
	const environment = driver.find((event) => event.kind === "capture.environment")?.payload as
		| PiCassetteScriptV0["environment"]
		| undefined;
	return { snapshot, steps, environment: environment ?? null };
}

export interface PiCassetteReplayOptionsV0 {
	/** The recorded store (its capture log is the cassette). */
	readonly store: string;
	/** The new store the replay records into (must not exist, or be empty). */
	readonly out: string;
	readonly pi: string;
	readonly timing: EndoCassetteTimingV0;
	readonly keySource: PiCassetteKeySourceV0;
	readonly timeoutMs: number;
	/** How long the cassette waits for Pi to drop a response the recorded Pi dropped. Default 30 s. */
	readonly holdMs?: number;
	/**
	 * For negative controls only: change the restored scratch root before Pi starts (e.g. edit a workspace file), to
	 * show that a replay detects the difference. Recorded in the replay's capture log as `capture.control`.
	 */
	readonly alterScratch?: { describe: string; apply: (scratchRoot: string) => void };
}

export interface PiCassetteReplayReportV0 {
	session: string;
	timing: EndoCassetteTimingV0;
	served: number;
	misses: number;
	/** Recorded exchanges the replay never requested. */
	unserved: number;
	/**
	 * Every cassette miss, in order. An `unexpected-request` miss carries where the replayed request first differed:
	 * `environment` (a tool result: what a tool observed changed) or `control-flow` (anything else).
	 */
	missDetails: { exchange: number; reason: string; divergence: JsonValueV0 | null }[];
	/** The first environment divergence ("environment diverged at <exchange>"), when the first miss is one. */
	environmentDivergedAt: number | null;
	notes: string[];
	comparison: EndoTrajectoryComparisonV0;
}

/** Restore the scratch root a cassette recorded, at its recorded path. */
/**
 * Restore the recorded scratch root at its recorded path. Returns it, and the topmost directory the restore created
 * (the root itself, or a missing ancestor such as the recorder's temp base): removing that one leaves nothing behind.
 */
function restoreScratch(
	store: string,
	key: EndoDigestKeyV0,
	script: PiCassetteScriptV0,
): { root: string; created: string } {
	const root = script.snapshot.scratchRoot;
	if (existsSync(root))
		throw new TypeError(
			`the recorded scratch root ${root} exists; a replay restores it at the same path (Pi's requests carry it), so it must be free`,
		);
	let created = root;
	while (!existsSync(dirname(created)) && dirname(created) !== created) created = dirname(created);
	const bytes = createEndoBlobStoreV0(endoCaptureRootV0(store), key, { readOnly: true }).get(
		script.snapshot.archive.digest,
	);
	restoreEndoWorkspaceV0(bytes, root);
	return { root, created };
}

/** The endo session coordinate a cassette session store recorded, read from its capture log (nothing is started). */
export function piCassetteSessionV0(store: string): string {
	return `endo.session.pi.${recordedSessionId(piCassetteScriptV0(readEndoCaptureEventsV0(store)))}`;
}

/** The Pi session id the recording opened (from its first open step). */
function recordedSessionId(script: PiCassetteScriptV0): string {
	const open = script.steps.find((entry) => entry.op === "open" || entry.op === "reopen");
	if (open === undefined || typeof open.piSessionId !== "string")
		throw new TypeError("the cassette records no session open");
	return open.piSessionId;
}

/** Replay a recorded cassette session and compare the result with the recording. */
export async function replayPiCassetteSessionV0(options: PiCassetteReplayOptionsV0): Promise<PiCassetteReplayReportV0> {
	const key = piCassetteKeyV0(options.keySource);
	const cassette = loadEndoCassetteV0(options.store, key);
	const script = piCassetteScriptV0(cassette.events);
	const piSessionId = recordedSessionId(script);
	if (cassette.listen === null) throw new TypeError("the cassette does not record where the proxy listened");
	const port = Number(new URL(cassette.listen).port);
	if (existsSync(options.out) && createEndoDurableEventStoreV0(options.out, { readOnly: true }).length > 0)
		throw new TypeError(`${options.out} already holds events; a replay records into a new store`);
	mkdirSync(options.out, { recursive: true });
	copyEvidence(options.store, options.out);
	const registry = join(options.out, "harness", "pi.default");
	mkdirSync(registry, { recursive: true });
	writeFileSync(
		join(registry, "pi-session.json"),
		`${JSON.stringify({ sessionDir: join(options.out, "pi-sessions", "pi.default"), sessionId: piSessionId }, null, 2)}\n`,
	);
	const { root: scratchRoot, created: scratchCreated } = restoreScratch(options.store, key, script);
	const log = new EndoCaptureLogV0(options.out, key, "replay");
	if (options.alterScratch !== undefined) {
		options.alterScratch.apply(scratchRoot);
		log.record("capture.control", { alteredScratch: options.alterScratch.describe }, PI_CASSETTE_DRIVER_PRODUCER_V0);
	}
	const notes: string[] = [];
	let server: Awaited<ReturnType<typeof startEndoCassetteServerV0>> | null = null;
	let session: PiSessionAttachmentV0 | null = null;
	try {
		server = await startEndoCassetteServerV0({
			cassette,
			key,
			storeRoot: options.store,
			timing: options.timing,
			port,
			log,
			...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
		});
		const open = script.steps.find((entry) => entry.op === "open" || entry.op === "open-child");
		const config: PiCassetteAttachmentConfigV0 = {
			root: options.out,
			scratchRoot,
			pi: options.pi,
			provider: String(open?.provider),
			model: String(open?.model),
			keySource: options.keySource,
			requestTimeoutMs: Math.max(60_000, options.timeoutMs),
			variables: script.environment?.variables ?? {},
		};
		const blobs = createEndoBlobStoreV0(endoCaptureRootV0(options.store), key, { readOnly: true });
		let replayStep = 0;
		const driver = (op: string, payload: Record<string, JsonValueV0>) => {
			replayStep += 1;
			log.record(
				"capture.driver-step",
				{ driver: PI_CASSETTE_DRIVER_VERSION_V0, step: replayStep, op, ...payload },
				PI_CASSETTE_DRIVER_PRODUCER_V0,
			);
		};
		const cassetteServer = server;
		// A STOP or kill point must be armed before the prompt goes out: with immediate timing the cassette can be past
		// the point before the driver would otherwise get to it.
		const pointAfter = (index: number): { exchange: number; chunks: number } | null => {
			for (const later of script.steps.slice(index + 1)) {
				if (later.op === "stop" || later.op === "kill")
					return (later.at as { exchange: number; chunks: number } | null) ?? null;
				if (later.op === "prompt") return null;
			}
			return null;
		};
		let armed: Promise<boolean> | null = null;
		const arm = (point: { exchange: number; chunks: number } | null) => {
			armed =
				point === null
					? Promise.resolve(true)
					: Promise.race([
							cassetteServer.pauseAt(point).then(() => true),
							sleep(options.timeoutMs).then(() => false),
						]);
		};
		let pendingPrompt: { text: string; mode: string } | null = null;
		let child: { kill: () => Promise<string[]> } | null = null;
		for (const [index, entry] of script.steps.entries()) {
			const op = String(entry.op);
			if (op === "open" || op === "reopen") {
				session = await piCassetteAttachmentV0(config).openSession();
				driver(op, { replayOf: entry.step as number });
			} else if (op === "prompt") {
				const ref = entry.text as { digest: EndoKeyedDigestV0 };
				const text = Buffer.from(blobs.get(ref.digest)).toString("utf8");
				pendingPrompt = { text, mode: String(entry.mode) };
				driver("prompt", { replayOf: entry.step as number, mode: pendingPrompt.mode });
				if (pendingPrompt.mode === "stop") arm(pointAfter(index));
				if (pendingPrompt.mode !== "kill") await session!.prompt(text);
				if (pendingPrompt.mode === "settle") {
					const settled = await session!.waitForSettled(options.timeoutMs);
					driver("settled", { replayOf: entry.step as number, observed: settled });
					if (!settled) notes.push(`agent_settled was not observed after recorded step ${entry.step}`);
				}
			} else if (op === "stop") {
				const at = entry.at as { exchange: number; chunks: number } | null;
				const settled = session!.waitForSettled(options.timeoutMs);
				if (!(await (armed ?? Promise.resolve(true))))
					notes.push(`the STOP point (exchange ${at?.exchange}, chunk ${at?.chunks}) was never reached`);
				armed = null;
				driver("stop", { replayOf: entry.step as number, at: at as unknown as JsonValueV0 });
				const accepted = session!.stop();
				cassetteServer.resume();
				await accepted.catch((error: unknown) => notes.push(`STOP failed: ${(error as Error).message}`));
				const observed = await settled;
				driver("settled", { replayOf: entry.step as number, observed });
				if (!observed) notes.push("agent_settled was not observed after STOP");
			} else if (op === "open-child") {
				if (session !== null) {
					await session.close();
					session = null;
				}
				driver("open-child", { replayOf: entry.step as number });
				arm(pointAfter(index));
				child = await promptInChild(config, pendingPrompt!.text, options.timeoutMs);
			} else if (op === "kill") {
				const at = entry.at as { exchange: number; chunks: number } | null;
				if (!(await (armed ?? Promise.resolve(true))))
					notes.push(`the kill point (exchange ${at?.exchange}, chunk ${at?.chunks}) was never reached`);
				armed = null;
				driver("kill", { replayOf: entry.step as number, at: at as unknown as JsonValueV0 });
				notes.push(...(await child!.kill()));
				child = null;
				cassetteServer.resume();
			} else if (op === "close") {
				if (session !== null) await session.close();
				session = null;
				driver("close", { replayOf: entry.step as number });
			}
		}
	} finally {
		if (session !== null) await (session as PiSessionAttachmentV0).close().catch(() => {});
		await server?.close();
		log.close();
		rmSync(scratchCreated, { recursive: true, force: true });
	}
	const missDetails = readEndoCaptureEventsV0(options.out)
		.filter((event) => event.kind === "capture.cassette-miss")
		.map((event) => {
			const payload = event.payload as { exchange: number; reason: string; divergence?: JsonValueV0 };
			return { exchange: payload.exchange, reason: payload.reason, divergence: payload.divergence ?? null };
		});
	const first = missDetails[0];
	const environmentDivergedAt =
		first !== undefined && (first.divergence as { kind?: unknown } | null)?.kind === "environment"
			? first.exchange
			: null;
	const coordinate = `endo.session.pi.${piSessionId}`;
	const comparison = compareEndoTrajectoriesV0(
		storeTrajectory(options.store, coordinate),
		storeTrajectory(options.out, coordinate),
	);
	return {
		session: coordinate,
		timing: options.timing,
		served: server.served,
		misses: server.misses,
		unserved: server.remaining,
		missDetails,
		environmentDivergedAt,
		notes,
		comparison,
	};
}

function storeTrajectory(root: string, session: string) {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	try {
		const events: EndoEventV0[] = [];
		let after = 0;
		for (;;) {
			const page = store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
			after = page.nextAfterSequence;
		}
		if (piTrajectoryAttachmentsV0(events, session).length === 0)
			throw new TypeError(`no Pi attachment recorded ${session} in ${root}`);
		return projectPiTrajectoryV0(events, { store: root, session });
	} finally {
		store.close();
	}
}
