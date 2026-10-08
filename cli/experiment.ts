/**
 * Experiments: run a task set under several conditions, N trials each, every trial a live Pi session recorded through
 * the capture proxy (so it is also a replayable cassette), and report run-to-run agreement with the trajectory
 * comparison (docs/experiments.md).
 *
 *   endo experiment run <spec.json> --out <dir> [--max-trials n] [--fixture-experiment]
 *   endo experiment report <dir>
 *
 * The run directory:
 *   experiment.json     (endo.experiment-run.v0) the spec as run, its sha256, the ordering seed and how it was chosen,
 *                       the trial order's algorithm, the endo.experiment.v0 record, the scratch path and the proxy port
 *   plan.json           (endo.experiment-plan.v0) every (task, condition, trial) in run order. Runs recorded before the
 *                       plan carried a version have one without; it is read as that exact legacy form, never rewritten
 *   journal.jsonl       what happened, appended: run sessions, trials started, finished, interrupted
 *   environment/        per run session: the serving stack as observed (model ids from /v1/models, Pi fingerprint,
 *                       endpoint, digest key id)
 *   trials/<task>/<condition>/<k>/   the trial's store (session events and capture log) and result.json
 *                       (endo.experiment-trial.v0)
 *   interrupted/        trials a previous run session started and never finished, moved aside, never counted
 *   report/             bundle.json (endo.experiment-report.v2) and summary.md, written by `report`
 *
 * The run's source-of-truth files (the spec, experiment.json, plan.json, result.json) are read back only through their
 * version-directed readers (cli/experiment-artifacts.ts); a file that does not satisfy its contract is refused. The
 * journal, environment/ and the report are not governed (docs/schema-compatibility.md).
 *
 * Resumable: a trial counts once its result.json exists (written atomically, last). A rerun skips those, moves an
 * unfinished trial's directory to interrupted/ and runs it again from scratch. The spec must not change between run
 * sessions (its sha256 is checked).
 *
 * Order: blocked randomization. For each trial index k, every (task, condition) cell runs once, in an order shuffled
 * by a seeded PRNG (mulberry32, Fisher-Yates). Conditions are interleaved within every block, so drift over the run
 * (time of day, thermals, cache state) is spread across conditions instead of confounded with one.
 *
 * Every trial runs in a fresh scratch root at the SAME path (Pi puts the working directory in its system prompt, so a
 * per-trial path would itself be a difference between trials), with a fresh store, a fresh Pi process and session.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { EndoCaptureLogV0, readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import { harnessSurfacesOfCaptureV0 } from "../adapters/openai-proxy/harness-surface.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { buildEndoExperimentBundleV0 } from "../lab/experiment-bundle.ts";
import { runEndoTrialsV0 } from "../lab/trials.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { type EndoExperimentRecordV0, validateEndoExperimentRecordV0 } from "../protocol/evolution.ts";
import {
	ENDO_EXPERIMENT_PLAN_VERSIONS_V0,
	ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0,
	ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0,
	ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0,
	type EndoExperimentRunRecordV0,
	type EndoExperimentTrialKeyV0,
	type EndoExperimentTrialResultAnyV0,
	readEndoExperimentRunRecordV0,
	readEndoExperimentTrialResultV0,
} from "../protocol/experiment-artifacts.ts";
import {
	type EndoExperimentConditionV0,
	type EndoExperimentSpecV0,
	type EndoExperimentTaskV0,
	parseEndoExperimentSpecV0,
} from "../protocol/experiment-spec.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import type { EndoTrajectoryComparisonV0, EndoTrajectoryV0 } from "../protocol/trajectory.ts";
import { readEndoVersionedV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	mulberry32V0,
	pairwiseRateWithTrialBootstrapV0,
	shuffleV0,
	spreadV0,
	wilson95V0,
} from "../runtime/contracts/statistics.ts";
import { compareEndoTrajectoriesV0 } from "../runtime/contracts/trajectory.ts";
import { endoFixtureDigestKeyPathV0 } from "../storage/digest-key.ts";
import { archiveEndoWorkspaceV0 } from "../storage/workspace-snapshot.ts";
import {
	createPiCassetteScratchV0,
	type PiCassetteKeySourceV0,
	piCassetteAttachmentV0,
	piCassetteEnvV0,
	piCassetteKeyV0,
	recordPiCassetteSessionV0,
} from "./cassette-session.ts";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentPlannedTrialV0,
	readEndoExperimentRunRecordFileV0,
	readEndoExperimentSpecFileV0,
} from "./experiment-artifacts.ts";
import { endoManipulationChecksV0, loadEndoTrialRequestsV0 } from "./experiment-checks.ts";
import {
	buildEndoTrialHarnessV0,
	requestParametersOfTrialV0,
	summarizeEndoCellHarnessSurfacesV0,
} from "./experiment-surface.ts";
import { readEndoStoreEventsV0, trajectoryFromStoreV0 } from "./trajectory.ts";

export const ENDO_EXPERIMENT_RUNNER_VERSION_V0 = "endo-experiment-runner.3";
export const ENDO_EXPERIMENT_REPORT_SCHEMA_V0 = "endo.experiment-report.v2";
export const ENDO_EXPERIMENT_ORDERING_V0 =
	"blocked randomization: for each trial index k (0..N-1), every (task, condition) cell once, in an order shuffled by Fisher-Yates over mulberry32(seed) (one generator for the whole plan, blocks drawn in order)";

/** The run order for a spec and a seed. Pure: the same spec and seed always give the same plan. */
export function planEndoExperimentV0(spec: EndoExperimentSpecV0, seed: number): EndoExperimentTrialKeyV0[] {
	const random = mulberry32V0(seed);
	const cells = spec.tasks.flatMap((task) =>
		spec.conditions.map((condition) => ({ task: task.id, condition: condition.id })),
	);
	const plan: EndoExperimentTrialKeyV0[] = [];
	for (let trial = 0; trial < spec.trials; trial += 1)
		for (const cell of shuffleV0(cells, random)) plan.push({ position: plan.length, ...cell, trial });
	return plan;
}

const trialDirectory = (dir: string, key: { task: string; condition: string; trial: number }) =>
	join(dir, "trials", key.task, key.condition, String(key.trial));

function writeAtomically(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, content);
	renameSync(`${path}.tmp`, path);
}

/** An environment/session-N.json file. Not a governed artifact (docs/schema-compatibility.md): read as data, never trusted for a field. */
function readUngovernedJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** What a writer puts in a file it owns must be what the reader will accept: refuse to write anything else. */
function mustRead<T>(read: { ok: true; value: T } | { ok: false; message: string }, what: string): T {
	if (!read.ok) throw new TypeError(`the runner built a ${what} it would itself refuse (${read.message})`);
	return read.value;
}

function keySourceOf(spec: EndoExperimentSpecV0): PiCassetteKeySourceV0 {
	return spec.digestDomain === "fixture"
		? { kind: "fixture", path: endoFixtureDigestKeyPathV0() }
		: { kind: "installation" };
}

/** The serving stack as observed now: model ids and metadata from /v1/models, the Pi fingerprint, the key id. */
async function observeEnvironment(spec: EndoExperimentSpecV0, keyId: string, scratch: string): Promise<JsonValueV0> {
	let models: JsonValueV0;
	try {
		const response = await fetch(`${spec.upstream.replace(/\/$/, "")}/v1/models`, {
			signal: AbortSignal.timeout(10_000),
		});
		const body = (await response.json()) as { data?: { id?: unknown; owned_by?: unknown; meta?: unknown }[] };
		models = response.ok
			? {
					status: "reported",
					value: (body.data ?? []).map((entry) =>
						JSON.parse(
							JSON.stringify({
								id: entry.id ?? null,
								owned_by: entry.owned_by ?? null,
								meta: entry.meta ?? null,
							}),
						),
					),
				}
			: { status: "UNAVAILABLE", reason: `GET /v1/models answered HTTP ${response.status}` };
	} catch (error) {
		models = { status: "UNAVAILABLE", reason: `GET /v1/models failed: ${(error as Error).name}` };
	}
	const root = join(scratch, "identify");
	let pi: JsonValueV0;
	try {
		const { fingerprint } = await new PiAttachmentV0({
			root,
			executable: spec.pi,
			env: piCassetteEnvV0(scratch),
		}).identify();
		pi =
			fingerprint === null
				? { status: "UNAVAILABLE", reason: "the Pi executable could not be identified" }
				: {
						status: "reported",
						value: {
							identityDigest: fingerprint.identity.digest,
							version: fingerprint.reported.version,
							entrypointSha256: fingerprint.local.entrypoint?.sha256 ?? null,
						},
					};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	return {
		observedAt: new Date().toISOString(),
		endpoint: new URL(spec.upstream).origin,
		models,
		pi,
		digestKeyId: keyId,
		serverDefaults: {
			status: "UNAVAILABLE",
			reason:
				"the server's default sampling settings are not read: that needs a server-settings endpoint, which the runner does not call",
		},
	};
}

/** How the runner drives Pi (adapters/pi/rpc.ts starts `pi --mode rpc`): an independent source for the invocation mode. */
const PI_INVOCATION_MODE = "pi --mode rpc";

const SAMPLING_KEYS = [
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"typical_p",
	"seed",
	"presence_penalty",
	"frequency_penalty",
	"repeat_penalty",
];

function sessionOf(events: readonly EndoEventV0[]): string | null {
	const attached = events.find((event) => event.kind === "harness.attached");
	const id = (attached?.payload as { piSessionId?: unknown } | undefined)?.piSessionId;
	return typeof id === "string" ? `endo.session.pi.${id}` : null;
}

function journal(dir: string, entry: Record<string, JsonValueV0>): void {
	appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export interface EndoExperimentRunOptionsV0 {
	readonly spec: EndoExperimentSpecV0;
	readonly dir: string;
	/** Stop after this many trials in this run session (the rest stay for a later session). */
	readonly maxTrials?: number;
	/**
	 * Fixture-experiment mode: required for, and only allowed with, a spec in the `fixture` digest domain (the committed
	 * public key, whose digests offer no secrecy: synthetic tasks only). The same rule as the fixture recorder: a normal
	 * experiment is refused under the public key, and a fixture experiment is refused without this explicit mode.
	 */
	readonly fixtureExperiment?: boolean;
	readonly log?: (line: string) => void;
	/** For tests: where the scratch root's parent goes (default: the system temp directory). */
	readonly scratchParent?: string;
}

export interface EndoExperimentRunSummaryV0 {
	planned: number;
	completed: number;
	errored: number;
	ranThisSession: number;
	movedToInterrupted: number;
	remaining: number;
}

/** Run (or resume) an experiment into `dir`. */
export async function runEndoExperimentV0(options: EndoExperimentRunOptionsV0): Promise<EndoExperimentRunSummaryV0> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const spec = parseEndoExperimentSpecV0(options.spec);
	const fixtureMode = options.fixtureExperiment === true;
	if (spec.digestDomain === "fixture" && !fixtureMode)
		throw new TypeError(
			"refusing to run a fixture-domain experiment outside fixture-experiment mode: its digests are made under the committed public key and offer no secrecy (pass --fixture-experiment for a synthetic experiment)",
		);
	if (fixtureMode && spec.digestDomain !== "fixture")
		throw new TypeError(
			"refusing fixture-experiment mode for a spec in the installation domain: fixture mode is for synthetic experiments recorded under the committed public key",
		);
	const dir = resolve(options.dir);
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec));
	const recordPath = join(dir, "experiment.json");
	mkdirSync(dir, { recursive: true });
	let run: EndoExperimentRunRecordV0;
	if (existsSync(recordPath)) {
		run = readEndoExperimentRunRecordFileV0(dir);
		if (run.specSha256 !== specSha256)
			throw new TypeError(
				`${dir} was started with another spec (sha256 ${run.specSha256}); a run's spec never changes`,
			);
	} else {
		const seedSource = spec.seed === null ? "drawn" : "spec";
		const seed = spec.seed ?? randomBytes(4).readUInt32BE(0);
		const experiment: EndoExperimentRecordV0 = {
			schemaVersion: "endo.experiment.v0",
			id: spec.id,
			environment: {
				schemaVersion: "endo.environment-profile.v0",
				environmentId: "endophasia-scratch-workspace",
				simulated: false,
			},
			model: `${spec.provider}/${spec.model}`,
			budget: { trialsPerCell: spec.trials, cells: spec.tasks.length * spec.conditions.length },
			provenance: `${ENDO_EXPERIMENT_RUNNER_VERSION_V0}; spec sha256 ${specSha256}`,
		};
		if (validateEndoExperimentRecordV0(experiment) === null)
			throw new TypeError("the experiment record failed endo.experiment.v0 validation");
		run = {
			schemaVersion: ENDO_EXPERIMENT_RUN_WRITE_VERSION_V0,
			runner: ENDO_EXPERIMENT_RUNNER_VERSION_V0,
			spec,
			specSha256,
			seed,
			seedSource,
			ordering: ENDO_EXPERIMENT_ORDERING_V0,
			experiment,
			scratchRoot: join(options.scratchParent ?? tmpdir(), `endo-experiment-${specSha256.slice(0, 12)}`, "scratch"),
			proxyPort: null,
			createdAt: new Date().toISOString(),
		};
		mustRead(readEndoExperimentRunRecordV0(run), "run record");
		const written = {
			schemaVersion: ENDO_EXPERIMENT_PLAN_WRITE_VERSION_V0,
			seed,
			ordering: ENDO_EXPERIMENT_ORDERING_V0,
			order: planEndoExperimentV0(spec, seed),
		};
		mustRead(readEndoVersionedV0(ENDO_EXPERIMENT_PLAN_VERSIONS_V0, written), "plan");
		writeAtomically(join(dir, "plan.json"), canonicalEndoJsonV0(written));
		writeAtomically(recordPath, `${JSON.stringify(run, null, "\t")}\n`);
	}
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	// Every saved result is read before anything costs money: one the reader refuses stops the resume here, not after
	// the remaining trials have run.
	for (const entry of plan) readEndoExperimentPlannedTrialV0(dir, entry);
	const keySource = keySourceOf(spec);
	const key = piCassetteKeyV0(keySource);
	// The scratch parent is ours: marked, and a leftover scratch root from an interrupted session is removed.
	const parent = dirname(run.scratchRoot);
	mkdirSync(parent, { recursive: true });
	const marker = join(parent, ".endo-experiment");
	if (existsSync(marker)) {
		if (readFileSync(marker, "utf8").trim() !== dir)
			throw new TypeError(`${parent} belongs to another experiment run (${readFileSync(marker, "utf8").trim()})`);
	} else if (readdirSync(parent).length > 0) {
		// Only a directory the runner just created is empty and ours; anything else is never deleted from.
		throw new TypeError(`${parent} is not marked as this experiment run's scratch parent and is not empty`);
	}
	writeFileSync(marker, `${dir}\n`);
	rmSync(run.scratchRoot, { recursive: true, force: true });
	// One proxy per run session, on the recorded port when it is free (the port is in Pi's models.json).
	let proxy: Awaited<ReturnType<typeof startEndoRecordingProxyV0>>;
	try {
		proxy = await startEndoRecordingProxyV0({ upstream: spec.upstream, log: null, port: run.proxyPort ?? 0 });
	} catch {
		log(`the recorded proxy port ${run.proxyPort} is taken; using another (trials record their own port)`);
		proxy = await startEndoRecordingProxyV0({ upstream: spec.upstream, log: null });
	}
	if (run.proxyPort !== proxy.port) {
		run = mustRead(readEndoExperimentRunRecordV0({ ...run, proxyPort: run.proxyPort ?? proxy.port }), "run record");
		writeAtomically(recordPath, `${JSON.stringify(run, null, "\t")}\n`);
	}
	const sessionNumber = existsSync(join(dir, "environment")) ? readdirSync(join(dir, "environment")).length + 1 : 1;
	const summary: EndoExperimentRunSummaryV0 = {
		planned: plan.length,
		completed: 0,
		errored: 0,
		ranThisSession: 0,
		movedToInterrupted: 0,
		remaining: 0,
	};
	try {
		const environment = await observeEnvironment(spec, key.keyId, parent);
		writeAtomically(
			join(dir, "environment", `session-${sessionNumber}.json`),
			`${JSON.stringify(environment, null, "\t")}\n`,
		);
		journal(dir, { event: "run-session-started", session: sessionNumber, proxyPort: proxy.port });
		const evidence = await gatherControlEvidence(spec, dir, sessionNumber, parent, proxy, keySource, log);
		for (const entry of plan) {
			const trialDir = trialDirectory(dir, entry);
			const resultPath = join(trialDir, "result.json");
			if (existsSync(resultPath)) continue;
			if (options.maxTrials !== undefined && summary.ranThisSession >= options.maxTrials) break;
			if (existsSync(trialDir)) {
				const aside = join(
					dir,
					"interrupted",
					`${entry.task}-${entry.condition}-${entry.trial}-session-${sessionNumber}`,
				);
				mkdirSync(dirname(aside), { recursive: true });
				renameSync(trialDir, aside);
				summary.movedToInterrupted += 1;
				journal(dir, { event: "trial-interrupted", ...entry, movedTo: aside.slice(dir.length + 1) });
			}
			mkdirSync(trialDir, { recursive: true });
			journal(dir, { event: "trial-started", ...entry, session: sessionNumber });
			log(`trial ${entry.position + 1}/${plan.length}: ${entry.task} / ${entry.condition} / #${entry.trial}`);
			const result = mustRead(
				readEndoExperimentTrialResultV0(
					await runTrial(spec, run, entry, trialDir, dir, proxy, keySource, key.keyId, evidence),
				),
				"trial result",
			);
			writeAtomically(resultPath, `${JSON.stringify(result, null, "\t")}\n`);
			journal(dir, { event: "trial-finished", ...entry, status: result.status });
			summary.ranThisSession += 1;
		}
	} finally {
		await proxy.close();
		rmSync(run.scratchRoot, { recursive: true, force: true });
		// A run that stopped before its first trial (a refused capability study) leaves nothing behind.
		if (!existsSync(join(dir, "trials"))) rmSync(parent, { recursive: true, force: true });
	}
	for (const entry of plan) {
		const saved = readEndoExperimentPlannedTrialV0(dir, entry);
		if (saved === null) summary.remaining += 1;
		else if (saved.status === "completed") summary.completed += 1;
		else summary.errored += 1;
	}
	journal(dir, { event: "run-session-ended", session: sessionNumber, ...summary });
	if (summary.remaining === 0) rmSync(parent, { recursive: true, force: true });
	return summary;
}

/** The runtime capability each intervention operation needs (adapters/pi/capabilities.ts). */
const INTERVENTION_CAPABILITIES: Readonly<Record<string, string>> = {
	steer: "steering.steer",
	queue: "steering.follow-up",
	stop: "steering.stop",
};

/**
 * Capability evidence for the conditions that carry interventions. Controls are offered only for admitted
 * capabilities, so a trial that steers needs live-study evidence for its configuration. Evidence is keyed on Pi's
 * configuration (models.json with the proxy port, settings, extensions, PI_* variables), so conditions sharing one
 * configuration share one study. One study runs per run session (the port may differ between sessions), through the
 * same proxy but unrecorded, before any trial. Returns the evidence directory per condition id. It refuses to go on
 * when a required capability is not admitted: a trial would only be refused at the gate.
 */
async function gatherControlEvidence(
	spec: EndoExperimentSpecV0,
	dir: string,
	sessionNumber: number,
	scratchParent: string,
	proxy: Awaited<ReturnType<typeof startEndoRecordingProxyV0>>,
	keySource: PiCassetteKeySourceV0,
	log: (line: string) => void,
): Promise<Map<string, string>> {
	const needing = spec.conditions.filter((condition) => Object.keys(condition.interventions ?? {}).length > 0);
	const out = new Map<string, string>();
	const groups = new Map<string, EndoExperimentConditionV0[]>();
	for (const condition of needing) {
		const configuration = canonicalEndoJsonV0({
			modelEntry: condition.modelEntry ?? null,
			settings: condition.settings ?? null,
			extensions: condition.extensions ?? null,
		});
		groups.set(configuration, [...(groups.get(configuration) ?? []), condition]);
	}
	let index = 0;
	for (const members of groups.values()) {
		index += 1;
		const evidenceRoot = join(dir, "evidence", `session-${sessionNumber}`, String(index));
		const scratchRoot = join(scratchParent, `evidence-${index}`);
		rmSync(scratchRoot, { recursive: true, force: true });
		rmSync(evidenceRoot, { recursive: true, force: true });
		mkdirSync(evidenceRoot, { recursive: true });
		const first = members[0]!;
		log(`capability study for ${members.map((member) => member.id).join(", ")} (proxy port ${proxy.port})`);
		const scratch = createPiCassetteScratchV0(scratchRoot, {
			baseUrl: `${proxy.origin}/v1`,
			provider: spec.provider,
			model: spec.model,
			files: {},
			...(first.modelEntry === undefined ? {} : { modelEntry: first.modelEntry }),
			...(first.settings === undefined ? {} : { settings: first.settings }),
			...(first.extensions === undefined ? {} : { extensions: first.extensions }),
		});
		// A proxy with no log refuses connections, so the study records its own model traffic into the run's evidence
		// directory, apart from every trial's capture.
		const studyLog = new EndoCaptureLogV0(
			join(dir, "evidence", `session-${sessionNumber}`, `capture-${index}`),
			piCassetteKeyV0(keySource),
			"record",
			{ async: true },
		);
		proxy.log = studyLog;
		try {
			const pi = piCassetteAttachmentV0({
				root: evidenceRoot,
				scratchRoot: scratch.root,
				pi: spec.pi,
				provider: spec.provider,
				model: spec.model,
				keySource,
				requestTimeoutMs: Math.max(60_000, spec.timeoutMs),
			});
			await pi.identify();
			await pi.checkLocal();
			const studied = await pi.studyLive({ authorized: true, stepTimeoutMs: Math.min(spec.timeoutMs, 120_000) });
			const states = studied.state.capabilities as { capability: string; status: string; reason?: string }[];
			const needed = new Set(
				members.flatMap((member) =>
					Object.values(member.interventions ?? {}).map((entry) => INTERVENTION_CAPABILITIES[entry.operation]!),
				),
			);
			const summary = [...needed].map((capability) => {
				const state = states.find((candidate) => candidate.capability === capability);
				return { capability, status: state?.status ?? "unknown", reason: state?.reason ?? null };
			});
			writeAtomically(
				join(evidenceRoot, "capability-summary.json"),
				`${JSON.stringify({ conditions: members.map((member) => member.id), proxyPort: proxy.port, summary }, null, "\t")}\n`,
			);
			journal(dir, {
				event: "capability-study",
				session: sessionNumber,
				conditions: members.map((m) => m.id),
				summary,
			});
			const refused = summary.filter((entry) => entry.status !== "admitted" && entry.status !== "admitted-partial");
			if (refused.length > 0)
				throw new TypeError(
					`the live study did not admit ${refused.map((entry) => `${entry.capability} (${entry.status}${entry.reason === null ? "" : `: ${entry.reason}`})`).join(", ")}; no trial would be allowed to use it`,
				);
		} finally {
			await proxy.flush();
			proxy.log = null;
			studyLog.close();
			rmSync(scratchRoot, { recursive: true, force: true });
		}
		for (const member of members) out.set(member.id, evidenceRoot);
	}
	return out;
}

async function runTrial(
	spec: EndoExperimentSpecV0,
	run: EndoExperimentRunRecordV0,
	entry: EndoExperimentTrialKeyV0,
	trialDir: string,
	dir: string,
	proxy: Awaited<ReturnType<typeof startEndoRecordingProxyV0>>,
	keySource: PiCassetteKeySourceV0,
	keyId: string,
	evidence: ReadonlyMap<string, string>,
): Promise<EndoExperimentTrialResultAnyV0> {
	const task = spec.tasks.find((candidate) => candidate.id === entry.task)!;
	const condition = spec.conditions.find((candidate) => candidate.id === entry.condition)!;
	const store = join(trialDir, "store");
	const startedAt = new Date().toISOString();
	const key = piCassetteKeyV0(keySource);
	let check: EndoExperimentTrialResultAnyV0["check"] = { ran: false, reason: "the task has no success check" };
	let finalWorkspace: EndoExperimentTrialResultAnyV0["finalWorkspace"] = null;
	const afterSession = (scratchRoot: string) => {
		const archive = archiveEndoWorkspaceV0(join(scratchRoot, "work"));
		const digest = key.digestBytes(archive.bytes);
		finalWorkspace = { keyId: digest.keyId, value: digest.value, bytes: archive.bytes.length };
		if (task.check !== undefined) check = runCheck(task, scratchRoot, trialDir, key);
	};
	let error: string | null = null;
	let notes: string[] = [];
	try {
		const report = await recordPiCassetteSessionV0({
			scenario: {
				name: task.id,
				purpose: `experiment ${spec.id}: task ${task.id}, condition ${condition.id}, trial ${entry.trial}`,
				workspace: task.workspace,
				steps: task.prompts.map((text, index) => {
					// The condition's intervention for this task is applied during the first prompt.
					const intervention = index === 0 ? condition.interventions?.[task.id] : undefined;
					return intervention === undefined
						? { op: "prompt" as const, text }
						: {
								op: "prompt-intervene" as const,
								text,
								operation: intervention.operation,
								...(intervention.message === undefined ? {} : { message: intervention.message }),
								after: { ...intervention.after },
							};
				}),
			},
			pi: spec.pi,
			provider: spec.provider,
			model: spec.model,
			proxy,
			store,
			scratchRoot: run.scratchRoot,
			keySource,
			evidenceFrom: evidence.get(condition.id) ?? null,
			timeoutMs: spec.timeoutMs,
			...(condition.modelEntry === undefined ? {} : { modelEntry: condition.modelEntry }),
			...(condition.settings === undefined ? {} : { settings: condition.settings }),
			...(condition.extensions === undefined ? {} : { extensions: condition.extensions }),
			...(condition.environment === undefined ? {} : { environment: condition.environment }),
			afterSession,
		});
		notes = report.notes;
	} catch (caught) {
		error = String((caught as Error).message ?? caught).slice(0, 2000);
	}
	const events = existsSync(join(store, "events")) ? readEndoStoreEventsV0(store) : [];
	const capture = existsSync(join(store, "capture", "events")) ? readEndoCaptureEventsV0(store) : [];
	return {
		schemaVersion: ENDO_EXPERIMENT_TRIAL_WRITE_VERSION_V0,
		position: entry.position,
		task: entry.task,
		condition: entry.condition,
		trial: entry.trial,
		status: error === null ? "completed" : "error",
		error,
		startedAt,
		endedAt: new Date().toISOString(),
		store: store
			.slice(dir.length + 1)
			.split(sep)
			.join("/"),
		session: sessionOf(events),
		exchanges: capture.filter(
			(event) => event.kind === "capture.exchange-ended" && event.producer === "capture:record",
		).length,
		harness: buildEndoTrialHarnessV0(capture.length === 0 ? [] : harnessSurfacesOfCaptureV0(store, key), {
			// Independent sources, kept apart from what the wire carries; nothing here is read out of a prompt.
			workingDirectory: { status: "reported", value: join(run.scratchRoot, "work"), source: "runner" },
			invocationMode: { status: "reported", value: PI_INVOCATION_MODE, source: "runner" },
			configuredModel: { status: "reported", value: `${spec.provider}/${spec.model}`, source: "spec" },
		}),
		check,
		finalWorkspace,
		notes: [...notes, ...(keyId === key.keyId ? [] : ["the digest key changed during the run"])],
	};
}

/** Run a task's success check in the workspace; the output is kept beside the result (check.txt), only digested in it. */
function runCheck(
	task: EndoExperimentTaskV0,
	scratchRoot: string,
	trialDir: string,
	key: ReturnType<typeof piCassetteKeyV0>,
): EndoExperimentTrialResultAnyV0["check"] {
	const check = task.check!;
	const result = spawnSync(check.argv[0]!, check.argv.slice(1), {
		cwd: join(scratchRoot, "work", check.cwd ?? ""),
		env: piCassetteEnvV0(scratchRoot),
		timeout: check.timeoutMs ?? 60_000,
		encoding: "buffer",
		maxBuffer: 16 * 1024 * 1024,
	});
	const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]);
	writeFileSync(join(trialDir, "check.txt"), output);
	const digest = key.digestBytes(output);
	const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	return {
		ran: true,
		exitCode: result.status,
		passed: result.status === 0 && !timedOut,
		timedOut,
		output: { keyId: digest.keyId, value: digest.value, bytes: output.length },
	};
}

// --- report -----------------------------------------------------------------------------------------------------

const JUDGED = ["lifecycle", "toolCalls", "toolResults", "outcome"] as const;
type Judged = (typeof JUDGED)[number];

const STATISTICS_NOTE =
	"headline: modal agreement, the share of completed trials whose layer equals the most common one, with a 95% Wilson interval (trials are independent). Also: the number of distinct trajectories, and the pairwise exact-match rate over all unordered pairs of completed trials (EXACT / (EXACT + DIVERGED); UNAVAILABLE pairs are counted separately) with a 95% percentile bootstrap interval that resamples trials, not pairs: pairs share trials, so a Wilson interval over pairs would be optimistic (10000 resamples, seeded from the spec sha256, cell and layer; two draws of the same trial are not a pair). Usage and timing are reported as median and interquartile range (type 7 quartiles), never judged.";

function layerKey(t: EndoTrajectoryV0, layer: Judged): string {
	return canonicalEndoJsonV0(t.layers[layer]);
}

function tokensTotals(t: EndoTrajectoryV0): Record<string, number> | null {
	if (t.layers.usage.status !== "reported") return null;
	const totals: Record<string, number> = {};
	for (const run of t.layers.usage.entries) {
		if (run.tokens.status !== "reported") return null;
		for (const [field, value] of Object.entries(run.tokens.value))
			if (typeof value === "number") totals[field] = (totals[field] ?? 0) + value;
	}
	return totals;
}

function wallTotal(t: EndoTrajectoryV0): number | null {
	if (t.layers.timing.status !== "reported") return null;
	let total = 0;
	for (const run of t.layers.timing.entries) {
		if (run.wallMs.status !== "reported") return null;
		total += run.wallMs.value;
	}
	return total;
}

function distinct(values: readonly JsonValueV0[]): JsonValueV0[] {
	const seen = new Map<string, JsonValueV0>();
	for (const value of values) seen.set(canonicalEndoJsonV0(value), value);
	return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
}

/** One summary line for a cell's harness surface; a mismatch is stated, never hidden. */
export function surfaceLine(task: string, condition: string, summary: JsonValueV0): string {
	const s = summary as {
		status: string;
		reason?: string;
		distinctSurfaces?: number;
		matched?: boolean | null;
		comparable?: boolean;
		trialsDifferingFromModalSet?: string[];
		differences?: { differs: string[]; parameterNames: string[] }[];
		trials?: { predatingSurface: number; noRecognizedSurface?: number };
	};
	const head = `- ${task} / ${condition}: `;
	if (s.status !== "reported") return `${head}UNAVAILABLE (${s.reason})`;
	const predating =
		(s.trials!.predatingSurface > 0 ? `; ${s.trials!.predatingSurface} trial(s) predate the surface` : "") +
		((s.trials!.noRecognizedSurface ?? 0) > 0
			? `; ${s.trials!.noRecognizedSurface} trial(s) showed no recognized request`
			: "");
	if (s.comparable === false) return `${head}not comparable: digested under different keys${predating}`;
	if (s.matched === true && s.distinctSurfaces === 1) return `${head}1 distinct, matched across trials${predating}`;
	// Trials agreeing on a set of several surfaces is still not the expected one surface per cell.
	if (s.matched === true)
		return `${head}MISMATCH: ${s.distinctSurfaces} distinct surfaces in this cell (expected 1); every trial showed the same set${predating}`;
	const coordinates = [
		...new Set(
			(s.differences ?? []).flatMap((d) => [...d.differs, ...d.parameterNames.map((n) => `parameter ${n}`)]),
		),
	];
	return `${head}MISMATCH: ${s.distinctSurfaces} distinct surfaces; ${s.trialsDifferingFromModalSet!.join(", ")} differ from the modal set${coordinates.length > 0 ? ` (${coordinates.join(", ")})` : ""}${predating}`;
}

/** Aggregate a run directory into an endo.experiment-report.v2 (pure over what the directory holds). */
export function reportEndoExperimentV0(directory: string): { report: JsonValueV0; summary: string } {
	const dir = resolve(directory);
	const run = readEndoExperimentRunRecordFileV0(dir);
	const plan = readEndoExperimentPlanFileV0(dir).plan.order;
	const results = plan.flatMap((entry) => {
		const result = readEndoExperimentPlannedTrialV0(dir, entry);
		return result === null ? [] : [result];
	});
	const environments = existsSync(join(dir, "environment"))
		? readdirSync(join(dir, "environment"))
				.sort()
				.map((name) => readUngovernedJson<Record<string, JsonValueV0>>(join(dir, "environment", name)))
		: [];
	const interrupted = existsSync(join(dir, "interrupted")) ? readdirSync(join(dir, "interrupted")).length : 0;
	const cells: JsonValueV0[] = [];
	const lines: string[] = [];
	const surfaceLines: string[] = [];
	for (const task of run.spec.tasks) {
		for (const condition of run.spec.conditions) {
			const cellResults = results.filter((result) => result.task === task.id && result.condition === condition.id);
			const completed = cellResults.filter((result) => result.status === "completed" && result.session !== null);
			const trajectories = completed.map((result) =>
				trajectoryFromStoreV0(join(dir, result.store), result.session!, { label: result.store }),
			);
			const comparisons: { i: number; j: number; comparison: EndoTrajectoryComparisonV0 }[] = [];
			for (let i = 0; i < trajectories.length; i += 1)
				for (let j = i + 1; j < trajectories.length; j += 1)
					comparisons.push({ i, j, comparison: compareEndoTrajectoriesV0(trajectories[i]!, trajectories[j]!) });
			const layers: Record<string, JsonValueV0> = {};
			const firstDivergence: Record<string, JsonValueV0> = {};
			for (const layer of JUDGED) {
				const counts = { EXACT: 0, DIVERGED: 0, UNAVAILABLE: 0 };
				const indices: Record<string, number> = {};
				for (const { comparison } of comparisons) {
					const verdict = comparison.layers[layer];
					counts[verdict.status] += 1;
					if (verdict.status === "DIVERGED")
						indices[String(verdict.index)] = (indices[String(verdict.index)] ?? 0) + 1;
				}
				const groups = new Map<string, number>();
				for (const t of trajectories) groups.set(layerKey(t, layer), (groups.get(layerKey(t, layer)) ?? 0) + 1);
				const modal = Math.max(0, ...groups.values());
				const verdictOf = new Map(
					comparisons.map(({ i, j, comparison }) => [`${i}:${j}`, comparison.layers[layer].status]),
				);
				const bootstrapSeed = Number.parseInt(
					sha256HexV0(`${run.specSha256}\u0000${task.id}\u0000${condition.id}\u0000${layer}`).slice(0, 8),
					16,
				);
				layers[layer] = {
					// The headline: share of (independent) trials whose layer equals the modal one, Wilson 95%.
					modalAgreement: { ...wilson95V0(modal, trajectories.length) } as unknown as JsonValueV0,
					distinctTrajectories: groups.size,
					pairs: comparisons.length,
					counts,
					// Pairwise exact-match rate; the interval resamples trials, not pairs (pairs share trials).
					pairwiseExact: {
						...pairwiseRateWithTrialBootstrapV0(
							trajectories.length,
							(i, j) => {
								const status = verdictOf.get(`${i}:${j}`);
								return status === "EXACT" ? true : status === "DIVERGED" ? false : null;
							},
							{ seed: bootstrapSeed },
						),
					} as unknown as JsonValueV0,
				};
				firstDivergence[layer] = Object.fromEntries(
					Object.entries(indices).sort(([a], [b]) => Number(a) - Number(b)),
				);
			}
			// Per pair: did the tool calls stay identical up to the first divergent input (trajectory-comparison.3)?
			const callsAgainstInputs = { identical: 0, notIdentical: 0, undecidable: 0 };
			for (const { comparison } of comparisons) {
				const verdict = comparison.toolCallsAgainstInputs.callsIdenticalUpToFirstDivergentInput;
				if (verdict === true) callsAgainstInputs.identical += 1;
				else if (verdict === false) callsAgainstInputs.notIdentical += 1;
				else callsAgainstInputs.undecidable += 1;
			}
			const divergedSets: Record<string, number> = {};
			for (const { comparison } of comparisons) {
				const set = JUDGED.filter((layer) => comparison.layers[layer].status === "DIVERGED").join("+") || "none";
				divergedSets[set] = (divergedSets[set] ?? 0) + 1;
			}
			const outcomeKinds: Record<string, number> = {};
			for (const t of trajectories) {
				const kind =
					t.layers.outcome.status === "reported"
						? t.layers.outcome.entries.map((entry) => entry.outcome).join(",") || "none"
						: "UNAVAILABLE";
				outcomeKinds[kind] = (outcomeKinds[kind] ?? 0) + 1;
			}
			const checked = completed.filter((result) => result.check.ran);
			const passed = checked.filter((result) => result.check.ran && result.check.passed).length;
			const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
			const usage: Record<string, JsonValueV0> = {};
			const totals = trajectories.map(tokensTotals);
			for (const field of tokenFields) {
				const values = totals.flatMap((entry) =>
					entry !== null && entry[field] !== undefined ? [entry[field]!] : [],
				);
				usage[field] =
					values.length === trajectories.length && values.length > 0
						? (spreadV0(values) as unknown as JsonValueV0)
						: {
								status: "UNAVAILABLE",
								reason: `${trajectories.length - values.length} of ${trajectories.length} trial(s) report no ${field}`,
							};
			}
			const walls = trajectories.map(wallTotal).flatMap((value) => (value === null ? [] : [value]));
			const workspaces = completed.map((result) => result.finalWorkspace?.value ?? "none");
			const parameters = distinct(completed.flatMap(requestParametersOfTrialV0));
			const samplingFieldsSent = [
				...new Set(
					parameters.flatMap((entry) =>
						Object.keys(entry as object).filter((field) => SAMPLING_KEYS.includes(field)),
					),
				),
			].sort();
			const samplingSent = distinct(
				parameters.map((entry) =>
					Object.fromEntries(
						Object.entries(entry as Record<string, JsonValueV0>).filter(([field]) =>
							SAMPLING_KEYS.includes(field),
						),
					),
				),
			);
			// The profile and bundle records (protocol/evaluation.ts) through the lab's trial discipline (lab/trials.ts).
			const profile = {
				schemaVersion: "endo.evaluation-profile.v1",
				experimentId: run.spec.id,
				runtime:
					distinct(
						trajectories.map(
							(t) =>
								`pi ${t.environment.attachments[0]?.version.status === "reported" ? t.environment.attachments[0].version.value : "UNAVAILABLE"}`,
						),
					).join(" | ") || "pi (no completed trial)",
				model: `${run.spec.provider}/${run.spec.model}`,
				// No Endophasia cognition policy is applied to these trials: Pi runs with its default behaviour.
				cognitionPolicy: "none",
				environment: {
					schemaVersion: "endo.environment-profile.v0",
					environmentId: `endophasia-scratch-workspace/${task.id}/${condition.id}`,
					simulated: false,
				},
				evaluator: `${ENDO_EXPERIMENT_RUNNER_VERSION_V0}; ${task.check === undefined ? "no success check" : `success check sha256 ${sha256HexV0(canonicalEndoJsonV0(task.check))} (the command is in the spec)`}`,
				trialCount: completed.length,
			};
			const idLocal = `experiment.${sha256HexV0(`${run.specSha256}\u0000${task.id}\u0000${condition.id}`).slice(0, 32)}`;
			const evaluation =
				completed.length === 0
					? null
					: runEndoTrialsV0({
							id: `endo.evidence.${idLocal}`,
							profile,
							runTrial: (index) => {
								const result = completed[index]!;
								return {
									raw: {
										session: result.session,
										store: result.store,
										position: result.position,
										exchanges: result.exchanges,
										outcome: trajectories[index]!.layers.outcome as unknown as JsonValueV0,
									},
									derived: {
										checkPassed: result.check.ran ? result.check.passed : null,
										finalWorkspace: result.finalWorkspace?.value ?? null,
										trajectoryDigest: trajectories[index]!.digest,
									},
									partition: "live-traffic",
								};
							},
						});
			const bundle =
				evaluation === null
					? { status: "UNAVAILABLE", reason: "no trial of this cell completed" }
					: buildEndoExperimentBundleV0(`endo.evidence.${idLocal}.bundle`, evaluation);
			const harnessSurface = summarizeEndoCellHarnessSurfacesV0(completed);
			const cell = {
				task: task.id,
				condition: condition.id,
				trials: {
					planned: run.spec.trials,
					completed: completed.length,
					errored: cellResults.length - completed.length,
					missing: run.spec.trials - cellResults.length,
				},
				layers,
				firstDivergence: { indexByLayer: firstDivergence, divergedLayersByPair: divergedSets },
				toolCallsUpToFirstDivergentInput: callsAgainstInputs,
				outcomes: outcomeKinds,
				check:
					task.check === undefined
						? { status: "UNAVAILABLE", reason: "the task has no success check" }
						: { ...wilson95V0(passed, checked.length) },
				finalWorkspaces: { distinct: new Set(workspaces).size, of: workspaces.length },
				usage,
				timing:
					walls.length === trajectories.length && walls.length > 0
						? { clock: "observer", wallMs: spreadV0(walls) }
						: {
								status: "UNAVAILABLE",
								reason: `${trajectories.length - walls.length} of ${trajectories.length} trial(s) have no wall time`,
							},
				// What the trials' requests showed of the model-facing harness: system/developer instruction digests, the
				// tool-definition surface and the request parameters. Evidence, not a validity verdict.
				harnessSurface,
				servingInputs: {
					requestParametersSeen: parameters,
					samplingFieldsChecked: [...SAMPLING_KEYS],
					samplingFieldsSent,
					samplingParametersSent:
						samplingSent.length === 1 && Object.keys(samplingSent[0] as object).length === 0
							? {
									status: "none sent",
									meaning:
										"the server's defaults applied; their values are UNAVAILABLE (see environment.serverDefaults)",
								}
							: samplingSent,
					modelEntry: condition.modelEntry ?? null,
					settings: condition.settings ?? null,
					extensions: Object.fromEntries(
						Object.entries(condition.extensions ?? {}).map(([file, source]) => [
							file,
							{ sha256: sha256HexV0(source), bytes: Buffer.byteLength(source), source },
						]),
					),
					...(condition.interventions === undefined
						? {}
						: { intervention: condition.interventions[task.id] ?? null }),
					...(condition.environment === undefined
						? {}
						: {
								environment: {
									variables: condition.environment.variables ?? {},
									fileTime: condition.environment.fileTime ?? null,
									files: Object.fromEntries(
										Object.entries(condition.environment.files ?? {}).map(([path, content]) => [
											path,
											{ sha256: sha256HexV0(content), bytes: Buffer.byteLength(content), content },
										]),
									),
								},
							}),
				},
				bundle: bundle as unknown as JsonValueV0,
			};
			cells.push(JSON.parse(JSON.stringify(cell)));
			const rate = (layer: Judged) => {
				const l = layers[layer] as {
					pairwiseExact: { rate: number | null; bootstrap95: { low: number; high: number } | null };
					modalAgreement: { successes: number; n: number; wilson95: { low: number; high: number } | null };
					distinctTrajectories: number;
				};
				const pct = (value: number) => (value * 100).toFixed(0);
				const modal =
					l.modalAgreement.wilson95 === null
						? "n/a"
						: `${l.modalAgreement.successes}/${l.modalAgreement.n} [${pct(l.modalAgreement.wilson95.low)}-${pct(l.modalAgreement.wilson95.high)}%]`;
				const pairwise =
					l.pairwiseExact.rate === null
						? "pairs n/a"
						: `pairs ${pct(l.pairwiseExact.rate)}%${l.pairwiseExact.bootstrap95 === null ? "" : ` [${pct(l.pairwiseExact.bootstrap95.low)}-${pct(l.pairwiseExact.bootstrap95.high)}%]`}`;
				return `${modal}; ${l.distinctTrajectories} distinct; ${pairwise}`;
			};
			const checkText = task.check === undefined ? "no check" : `${passed}/${checked.length} pass`;
			surfaceLines.push(surfaceLine(task.id, condition.id, harnessSurface));
			lines.push(
				`| ${task.id} | ${condition.id} | ${completed.length}/${run.spec.trials} | ${rate("lifecycle")} | ${rate("toolCalls")} | ${rate("toolResults")} | ${rate("outcome")} | ${checkText} | ${walls.length ? `${spreadV0(walls)!.median} ms` : "n/a"} |`,
			);
		}
	}
	// The declared manipulation checks, over every completed trial (DESIGN: an arm that fails one is invalid).
	const manipulation =
		run.spec.manipulation === undefined
			? { status: "UNAVAILABLE", reason: "the spec declares no manipulation checks" }
			: endoManipulationChecksV0(
					run.spec.manipulation,
					results
						.filter((result) => result.status === "completed")
						.map((result) => loadEndoTrialRequestsV0(join(dir, result.store), result, keySourceOf(run.spec))),
				);
	const body = {
		schemaVersion: ENDO_EXPERIMENT_REPORT_SCHEMA_V0,
		experiment: run.experiment,
		specSha256: run.specSha256,
		seed: run.seed,
		seedSource: run.seedSource,
		ordering: run.ordering,
		trials: {
			planned: plan.length,
			completed: results.filter((result) => result.status === "completed").length,
			errored: results.filter((result) => result.status === "error").length,
			missing: plan.length - results.length,
			interruptedAndRerun: interrupted,
		},
		environment: environments as unknown as JsonValueV0,
		statistics: STATISTICS_NOTE,
		manipulation: manipulation as unknown as JsonValueV0,
		cells,
	};
	const report = { ...JSON.parse(JSON.stringify(body)), digest: sha256HexV0(canonicalEndoJsonV0(body)) };
	const summary = [
		`# Experiment ${run.spec.id}`,
		"",
		run.spec.description,
		"",
		`Trials: ${body.trials.completed} completed, ${body.trials.errored} errored, ${body.trials.missing} missing of ${plan.length} planned (${interrupted} interrupted and rerun). Seed ${run.seed} (${run.seedSource}).`,
		"",
		"Per judged layer: trials agreeing with the modal trajectory (95% Wilson, over trials); distinct trajectories; pairwise exact-match rate (95% percentile bootstrap resampling trials):",
		"",
		"| task | condition | trials | lifecycle | tool calls | tool results | outcome | check | median wall |",
		"| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | ---: |",
		...lines,
		"",
		"Effective harness surface per cell (system/developer instruction and tool-definition digests, request parameters; a cell expects one):",
		"",
		...surfaceLines,
		"",
		...("validity" in manipulation
			? [
					"Manipulation checks:",
					"",
					"| check | status | checked | failures |",
					"| :--- | :--- | ---: | ---: |",
					...(["M1", "M2a", "M2b", "M3", "M4"] as const).map(
						(check) =>
							`| ${check} | ${manipulation[check].status} | ${manipulation[check].checked} | ${manipulation[check].failureCount} |`,
					),
					"",
					`Validity: ${Object.entries(manipulation.validity)
						.map(([condition, status]) => `${condition} ${status}`)
						.join(", ")}.`,
					"",
				]
			: []),
		`Report digest ${report.digest}. Details: bundle.json.`,
		"",
	].join("\n");
	return { report, summary };
}

// --- commands ---------------------------------------------------------------------------------------------------

/** `experiment run <spec.json> --out <dir> [--max-trials n]` */
export async function experimentRunCommand(argv: readonly string[]): Promise<void> {
	const args = [...argv];
	const take = (flag: string) => {
		const index = args.indexOf(flag);
		if (index === -1) return undefined;
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) throw new TypeError(`the flag ${flag} needs a value`);
		args.splice(index, 2);
		return value;
	};
	const fixtureExperiment = args.includes("--fixture-experiment");
	if (fixtureExperiment) args.splice(args.indexOf("--fixture-experiment"), 1);
	const out = take("--out");
	const max = take("--max-trials");
	if (args.length !== 1 || out === undefined || args[0]!.startsWith("--"))
		throw new TypeError("usage: endo experiment run <spec.json> --out <dir> [--max-trials n] [--fixture-experiment]");
	const spec = readEndoExperimentSpecFileV0(args[0]!);
	const summary = await runEndoExperimentV0({
		spec,
		dir: out,
		fixtureExperiment,
		...(max === undefined ? {} : { maxTrials: Number(max) }),
	});
	process.stdout.write(canonicalEndoJsonV0({ dir: resolve(out), ...summary }));
}

/** `experiment report <dir>` */
export async function experimentReportCommand(argv: readonly string[]): Promise<void> {
	if (argv.length !== 1) throw new TypeError("usage: endo experiment report <dir>");
	const dir = resolve(argv[0]!);
	const { report, summary } = reportEndoExperimentV0(dir);
	writeAtomically(join(dir, "report", "bundle.json"), canonicalEndoJsonV0(report));
	writeAtomically(join(dir, "report", "summary.md"), summary);
	process.stderr.write(summary);
	process.stdout.write(canonicalEndoJsonV0(report));
}

export const EXPERIMENT_COMMANDS_V0: Record<string, (argv: readonly string[]) => Promise<void>> = {
	run: experimentRunCommand,
	report: experimentReportCommand,
};
