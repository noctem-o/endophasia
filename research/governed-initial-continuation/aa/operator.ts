// Terminal-governed A/A operator: the one sanctioned caller of the task-owned launcher.
//
// It connects existing pieces and adds no authority of its own. Every server launch and every individual turn needs the
// exact phrase typed through `AaTerminalV0`, a trusted local operator callback in the same sense as CoordinatorHooks.
// Nothing here reads a flag, an environment variable, a saved answer, a default or a pipe as approval. The module
// opens no terminal itself: operate.ts refuses to run without a controlling terminal and supplies one.
//
// Order is fixed by the evidence contract: launch publishes the provenance, then readiness is observed, then the study
// plan commits to that published provenance, then up to four slots run (halting at the first one that does not
// complete), then the owned server is stopped, and only then does a fresh process read the evidence back.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readVerifiedInitialBranchSetV0 } from "../../../cli/initial-branch-set.ts";
import { preflightInitialContinuationV0 } from "../../../cli/initial-continuation.ts";
import type { InitialContinuationPlanV0 } from "../../../protocol/initial-continuation.ts";
import type { EndoDigestKeyV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { type CoordinatorHooks, runNextSlot } from "./coordinator.ts";
import { publishExclusiveV0 } from "./exclusive-publish.ts";
import { EXPLICIT_FIT_OFF_PROFILE_V0 } from "./linux-profile.ts";
import { readSlot, type SlotEnd, slotPath } from "./reader.ts";
import { type Arm, createStudyPlan, orderForSeed, type StudyPlan, validInputs } from "./study-plan.ts";
import {
	procfsTaskOwnedObserverV0,
	type TaskOwnedObservationV0,
	type TaskOwnedObserverV0,
} from "./task-owned-admission.ts";
import { provenanceEndPathV0, provenancePathV0, type TaskOwnedProvenanceEndV0 } from "./task-owned-provenance.ts";
import type { TaskOwnedStudyReportV0 } from "./task-owned-reader.ts";
import {
	awaitTaskOwnedReadinessV0,
	READINESS_MAX_TIMEOUT_MS_V0,
	type ReadinessOutcomeV0,
	readinessPathV0,
	sealReadinessV0,
} from "./task-owned-readiness.ts";
import {
	launchTaskOwnedServerV0,
	planTaskOwnedLaunchV0,
	portIsFree,
	TASK_OWNED_APPROVAL_WINDOW_MS_V0,
	type TaskOwnedLaunchPlanV0,
	type TaskOwnedLaunchRequestV0,
	type TaskOwnedServerV0,
} from "./task-owned-server.ts";

export interface AaServerConfigV0 {
	executablePath: string;
	executableSha256: string;
	modelPath: string;
	modelSha256: string;
	modelAlias: string;
	gpuLayers: string;
	port: number;
	/** Spawn to listening, plus the host inspection that follows. */
	startupTimeoutMs: number;
	/** Listening to a server-reported ready answer. */
	modelReadyTimeoutMs: number;
	workingDirectory: string;
}
/** Every field is required: there are no defaults for anything that picks a binary, a model, a port, a prompt or an order. */
export interface AaOperatorConfigV0 {
	keyFile: string;
	studyFile: string;
	seed: number;
	expectedAnswer: string;
	serverDeclaration: string;
	source: string;
	replay: string;
	outputParent: string;
	preparation: string;
	piExecutable: string;
	provider: string;
	model: string;
	prompt: string;
	continuationPrompt: string;
	wallTimeoutMs: number;
	maxApprovalIdleMs: number;
	maxTransferredBytes: number;
	server: AaServerConfigV0;
}

const TOP_FIELDS = [
	"keyFile",
	"studyFile",
	"seed",
	"expectedAnswer",
	"serverDeclaration",
	"source",
	"replay",
	"outputParent",
	"preparation",
	"piExecutable",
	"provider",
	"model",
	"prompt",
	"continuationPrompt",
	"wallTimeoutMs",
	"maxApprovalIdleMs",
	"maxTransferredBytes",
	"server",
] as const;
const SERVER_FIELDS = [
	"executablePath",
	"executableSha256",
	"modelPath",
	"modelSha256",
	"modelAlias",
	"gpuLayers",
	"port",
	"startupTimeoutMs",
	"modelReadyTimeoutMs",
	"workingDirectory",
] as const;
const TOP_PATHS = ["keyFile", "studyFile", "source", "replay", "outputParent", "piExecutable"] as const;
const TOP_STRINGS = [
	"expectedAnswer",
	"serverDeclaration",
	"preparation",
	"provider",
	"model",
	"prompt",
	"continuationPrompt",
] as const;
const TOP_INTEGERS = ["seed", "wallTimeoutMs", "maxApprovalIdleMs", "maxTransferredBytes"] as const;
const SERVER_PATHS = ["executablePath", "modelPath", "workingDirectory"] as const;
const SERVER_STRINGS = ["executableSha256", "modelSha256", "modelAlias", "gpuLayers"] as const;
const SERVER_INTEGERS = ["port", "startupTimeoutMs", "modelReadyTimeoutMs"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const sameKeys = (value: Record<string, unknown>, expected: readonly string[]) =>
	Object.keys(value).length === expected.length && expected.every((k) => Object.hasOwn(value, k));

/** Structural parse only. Ranges and the study's own rules are enforced by `inspectAaV0`, before anything is started. */
export function parseAaOperatorConfigV0(text: string): AaOperatorConfigV0 {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new TypeError("the configuration is not valid JSON");
	}
	if (!isRecord(value) || !sameKeys(value, TOP_FIELDS))
		throw new TypeError("the configuration must contain exactly the documented fields");
	const server = value.server;
	if (!isRecord(server) || !sameKeys(server, SERVER_FIELDS))
		throw new TypeError("the server configuration must contain exactly the documented fields");
	for (const [record, paths, strings, integers] of [
		[value, TOP_PATHS, TOP_STRINGS, TOP_INTEGERS],
		[server, SERVER_PATHS, SERVER_STRINGS, SERVER_INTEGERS],
	] as const) {
		for (const field of paths)
			if (typeof record[field] !== "string" || !isAbsolute(record[field] as string))
				throw new TypeError(`${field} must be an absolute path`);
		for (const field of strings)
			if (typeof record[field] !== "string" || (record[field] as string).length === 0)
				throw new TypeError(`${field} must be explicit`);
		for (const field of integers)
			if (!Number.isSafeInteger(record[field])) throw new TypeError(`${field} must be an integer`);
	}
	return structuredClone(value) as unknown as AaOperatorConfigV0;
}

export const studyOptionsOf = (config: AaOperatorConfigV0) => ({
	source: config.source,
	replay: config.replay,
	outputParent: config.outputParent,
	preparation: config.preparation,
	piExecutable: config.piExecutable,
	upstream: `http://127.0.0.1:${config.server.port}`,
	provider: config.provider,
	model: config.model,
	prompt: config.prompt,
	continuationPrompt: config.continuationPrompt,
	wallTimeoutMs: config.wallTimeoutMs,
	maxApprovalIdleMs: config.maxApprovalIdleMs,
	maxTransferredBytes: config.maxTransferredBytes,
});
const launchRequestOf = (config: AaOperatorConfigV0): TaskOwnedLaunchRequestV0 => ({
	executablePath: config.server.executablePath,
	executableSha256: config.server.executableSha256,
	modelPath: config.server.modelPath,
	modelSha256: config.server.modelSha256,
	modelAlias: config.server.modelAlias,
	gpuLayers: config.server.gpuLayers,
	port: config.server.port,
	readinessTimeoutMs: config.server.startupTimeoutMs,
	workingDirectory: config.server.workingDirectory,
});

const readerSuffixes = [".read-task-owned.json", ".read-study.json"] as const;
/** Every file this command may create beside the study. None of them may already exist. */
const evidencePaths = (studyFile: string) => [
	studyFile,
	provenancePathV0(studyFile),
	provenanceEndPathV0(studyFile),
	readinessPathV0(studyFile),
	...[1, 2, 3, 4].flatMap((n) => [slotPath(studyFile, n, "start"), slotPath(studyFile, n, "end")]),
	...readerSuffixes.map((suffix) => `${studyFile}${suffix}`),
];
const ownerOnlyDirectory = (path: string) => {
	const stat = lstatSync(path);
	return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
};

export interface AaPlanSummaryV0 {
	launchPlan: string;
	profile: string;
	endpoint: string;
	executable: { path: string; sha256: string };
	model: { path: string; sha256: string; alias: string; gpuLayers: string };
	/** Committed arm order, one entry per study slot. */
	order: Arm[];
	promptBytes: { first: number; continuation: number };
	limits: {
		maxModelRequests: 8;
		slots: 4;
		turnsPerSlot: 2;
		wallTimeoutMsPerSlot: number;
		continuationApprovalIdleMs: number;
		maxTransferredBytesPerSlot: number;
		serverStartupMs: number;
		modelReadyMs: number;
		approvalWindowMs: number;
	};
}
const shortHex = (value: string) => value.slice(0, 16);

/**
 * Read-only: validates the configuration and the verified sibling pair, and describes what `--run` would ask to approve.
 * It starts no server, no Pi and no study, binds no port, sends no request and writes nothing.
 */
export function inspectAaV0(config: AaOperatorConfigV0, key: EndoDigestKeyV0): AaPlanSummaryV0 {
	if (
		!Number.isSafeInteger(config.seed) ||
		config.seed < 0 ||
		config.seed > 0xffffffff ||
		!validInputs(studyOptionsOf(config), config.expectedAnswer) ||
		Buffer.byteLength(config.serverDeclaration) > 16384
	)
		throw new TypeError("the study configuration is outside the supported A/A protocol");
	const { modelReadyTimeoutMs } = config.server;
	if (modelReadyTimeoutMs < 1000 || modelReadyTimeoutMs > READINESS_MAX_TIMEOUT_MS_V0)
		throw new TypeError("modelReadyTimeoutMs is outside the supported range");
	const plan = planTaskOwnedLaunchV0(key, launchRequestOf(config)); // Throws on any unsupported profile or port.
	for (const path of evidencePaths(config.studyFile))
		if (existsSync(path)) throw new Error("the study location already holds evidence");
	if (!ownerOnlyDirectory(dirname(config.studyFile))) throw new Error("the study directory must be owner-only");
	if (!ownerOnlyDirectory(config.server.workingDirectory))
		throw new Error("the server working directory must be owner-only");
	if (!statSync(config.piExecutable).isFile()) throw new Error("the Pi executable is not a regular file");
	const siblings = readVerifiedInitialBranchSetV0(
		config.source,
		config.replay,
		key,
		config.outputParent,
		config.preparation,
	);
	if (siblings.status !== "verified-pristine") throw new Error("the sibling pair is not verified pristine");
	return {
		launchPlan: shortHex(plan.commitment.value),
		profile: EXPLICIT_FIT_OFF_PROFILE_V0,
		endpoint: plan.endpoint,
		executable: { path: config.server.executablePath, sha256: config.server.executableSha256 },
		model: {
			path: config.server.modelPath,
			sha256: config.server.modelSha256,
			alias: config.server.modelAlias,
			gpuLayers: config.server.gpuLayers,
		},
		order: orderForSeed(config.seed),
		promptBytes: {
			first: Buffer.byteLength(config.prompt),
			continuation: Buffer.byteLength(config.continuationPrompt),
		},
		limits: {
			maxModelRequests: 8,
			slots: 4,
			turnsPerSlot: 2,
			wallTimeoutMsPerSlot: config.wallTimeoutMs,
			continuationApprovalIdleMs: config.maxApprovalIdleMs,
			maxTransferredBytesPerSlot: config.maxTransferredBytes,
			serverStartupMs: config.server.startupTimeoutMs,
			modelReadyMs: modelReadyTimeoutMs,
			approvalWindowMs: TASK_OWNED_APPROVAL_WINDOW_MS_V0,
		},
	};
}

/** The terminal a trusted local operator types into. Production supplies a controlling terminal; see operate.ts. */
export interface AaTerminalV0 {
	write(text: string): void;
	/** One typed line, or null when the prompt expired, was cancelled, or the terminal closed. */
	ask(prompt: string, timeoutMs: number, signal: AbortSignal): Promise<string | null>;
}
/** Replaceable pieces, so tests can observe or fail one boundary at a time. The production command uses the defaults. */
export interface AaOperatorDepsV0 {
	launch?: typeof launchTaskOwnedServerV0;
	observer?: TaskOwnedObserverV0;
	runSlot?: typeof runNextSlot;
	/** Runs the fresh-process reader with these arguments and resolves to its exit status. */
	readFresh?: (args: string[]) => Promise<number | null>;
	portIsFree?: (port: number) => Promise<boolean>;
}

export type AaVerdictV0 = "complete-under-declared-assumptions" | "partial" | "refused" | "cleanup-unconfirmed";
export interface AaOperatorOutcomeV0 {
	verdict: AaVerdictV0;
	/** The last stage entered. A study that stops early reports where. */
	stage: "preparation" | "server-launch" | "readiness" | "study-plan" | "study" | "cleanup" | "verification" | "done";
	interrupted: boolean;
	reasons: string[];
	server: {
		launched: boolean;
		cleanup: "confirmed" | "cleanup-unconfirmed" | "nothing-started";
		stop: Pick<TaskOwnedProvenanceEndV0, "exit" | "processGone" | "listenerGone"> | null;
	};
	readiness: { status: "not-attempted" } | ReadinessOutcomeV0;
	/** What the runner wrote for each started slot. Spent slots stay spent; these are unverified runner statuses. */
	slots: Array<{ position: number; arm: Arm | null; status: string }>;
	independentRead: {
		performed: boolean;
		/** `valid` only when the fresh process returned a report; a refusal is not softened. */
		status: "valid" | "reader-refused" | "not-attempted";
		report: TaskOwnedStudyReportV0 | null;
		answers: { firstCorrect: number; referenceCorrect: number; of: number } | null;
	};
}

const message = (error: unknown) => (error instanceof Error ? error.message : "unknown error").slice(0, 200);

const readerScript = () => join(dirname(fileURLToPath(import.meta.url)), "read-private.ts");
/** The reader runs in its own process with a minimal environment, so nothing in this one can colour what it concludes. */
function runFreshReader(args: string[]): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [readerScript(), ...args], {
			stdio: "ignore",
			env: { PATH: process.env.PATH ?? "" },
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
		child.once("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}
const readJson = (path: string): unknown => {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 1024 * 1024 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
		throw new Error("unexpected reader output");
	return JSON.parse(readFileSync(path, "utf8"));
};

/**
 * Runs the whole workflow once. It never retries a launch, a readiness wait, a slot or a request, and it spends a slot
 * only by starting it. It always stops the server it launched, exactly once, before reading the evidence back.
 */
export async function runAaOperatorV0(
	config: AaOperatorConfigV0,
	key: EndoDigestKeyV0,
	terminal: AaTerminalV0,
	signal: AbortSignal,
	deps: AaOperatorDepsV0 = {},
): Promise<AaOperatorOutcomeV0> {
	const launch = deps.launch ?? launchTaskOwnedServerV0;
	const observer = deps.observer ?? procfsTaskOwnedObserverV0(key);
	const runSlot = deps.runSlot ?? runNextSlot;
	const readFresh = deps.readFresh ?? runFreshReader;
	const portFree = deps.portIsFree ?? portIsFree;
	const outcome: AaOperatorOutcomeV0 = {
		verdict: "refused",
		stage: "preparation",
		interrupted: false,
		reasons: [],
		server: { launched: false, cleanup: "nothing-started", stop: null },
		readiness: { status: "not-attempted" },
		slots: [],
		independentRead: { performed: false, status: "not-attempted", report: null, answers: null },
	};
	// `stage` ends as the stage that stopped the study, or "done" when nothing did; cleanup and verification always run.
	let stoppedAt: AaOperatorOutcomeV0["stage"] | undefined;
	const stopWith = (stage: AaOperatorOutcomeV0["stage"], reason: string) => {
		outcome.stage = stage;
		stoppedAt ??= stage;
		outcome.reasons.push(reason);
	};
	const say = (text: string) => {
		try {
			terminal.write(text);
		} catch {} // A terminal that is gone cannot be told anything; the abort path handles its loss.
	};

	// 1. Preparation: nothing is started. The pre-launch preflight runs Pi's --version/--help only, and sends no request.
	let summary: AaPlanSummaryV0;
	let plans: Record<Arm, InitialContinuationPlanV0>;
	try {
		summary = inspectAaV0(config, key);
		const options = studyOptionsOf(config);
		const ready = await Promise.all(
			(["baseline", "alternative"] as const).map((childRole) =>
				preflightInitialContinuationV0({ ...options, childRole }, key),
			),
		);
		if (ready[0].status !== "ready" || ready[1].status !== "ready") throw new Error("continuation preflight refused");
		plans = { baseline: ready[0].plan, alternative: ready[1].plan };
		// The port must be unused before anything is asked, so a failed launch can later be told apart from someone else's listener.
		if (!(await portFree(config.server.port))) throw new Error("the port is not free");
	} catch (error) {
		stopWith("preparation", message(error));
		return finish(outcome);
	}
	if (signal.aborted) {
		outcome.interrupted = true;
		stopWith("preparation", "cancelled before launch");
		return finish(outcome);
	}

	// 2. Launch: the only place a server is started, and only after the exact phrase is typed.
	const launchRequest = launchRequestOf(config);
	let server: TaskOwnedServerV0 | undefined;
	let approved = false;
	outcome.stage = "server-launch";
	try {
		server = await launch(
			key,
			config.studyFile,
			launchRequest,
			async (plan: TaskOwnedLaunchPlanV0, phrase: string) => {
				say(renderLaunchApproval(summary, plans, plan, phrase, config));
				const answer = await terminal.ask(
					`Type ${phrase} to start this task-owned server; anything else declines: `,
					TASK_OWNED_APPROVAL_WINDOW_MS_V0,
					signal,
				);
				approved = answer === phrase;
				return answer;
			},
			signal,
		);
	} catch (error) {
		outcome.interrupted = signal.aborted;
		stopWith("server-launch", `launch refused: ${message(error)}`);
		// Without an approval nothing was spawned. After one, the launcher ends anything it started before raising;
		// confirm that independently, and never touch whatever is listening.
		if (approved && !(await portFree(config.server.port))) {
			outcome.server.cleanup = "cleanup-unconfirmed";
			outcome.reasons.push("the port is still occupied after a failed launch; nothing was signalled");
		}
		return finish(outcome);
	}
	const provenance = server.provenance;
	outcome.server.launched = true;

	let plan: StudyPlan | undefined;
	try {
		// 3. Readiness: a bounded, read-only observation of what the server says about itself.
		outcome.stage = "readiness";
		let observed: TaskOwnedObservationV0 | undefined;
		const readiness = await awaitTaskOwnedReadinessV0(provenance.listener.endpoint, {
			timeoutMs: config.server.modelReadyTimeoutMs,
			signal,
			verifyIdentity: async () => {
				try {
					observed = await observer.observe(provenance, 1, signal);
					return true;
				} catch {
					return false;
				}
			},
			recheckIdentity: () => observed !== undefined && observer.recheck(provenance, observed, 1),
		});
		outcome.readiness = readiness;
		publishExclusiveV0(
			readinessPathV0(config.studyFile),
			sealReadinessV0(key, {
				provenanceCommitment: provenance.commitment,
				endpoint: provenance.listener.endpoint,
				outcome: readiness,
				timeoutMs: config.server.modelReadyTimeoutMs,
				observedAt: new Date().toISOString(),
			}),
		);
		if (readiness.status !== "ready") {
			stopWith("readiness", `the server was not reported ready: ${readiness.reason}`);
			throw new StopStudy();
		}
		if (signal.aborted) throw new StopStudy();

		// 4. The plan commits to the provenance this process published, so it comes only after launch and readiness.
		outcome.stage = "study-plan";
		plan = await createStudyPlan(
			config.studyFile,
			studyOptionsOf(config),
			config.seed,
			config.expectedAnswer,
			config.serverDeclaration,
			key,
			undefined,
			provenance,
		);

		// 5. Slots: each needs its own typed approval for each turn. The first slot that does not complete ends the study.
		outcome.stage = "study";
		// Repeated gates use the cheap synchronous recheck against the readiness observation; the full per-turn
		// observation happens once, at admission.
		const environmentOk = async () =>
			!signal.aborted && observed !== undefined && observer.recheck(provenance, observed, 1);
		let position = 0;
		const hooks: CoordinatorHooks = {
			checkEnvironment: environmentOk,
			first: (slotPlan, phrase) => {
				say(
					renderTurnApproval(
						plan as StudyPlan,
						position,
						1,
						slotPlan.initial.attemptId,
						slotPlan.commitment.value,
						provenance.process.pid,
					),
				);
				return terminal.ask(
					`Type ${phrase} to approve ONLY this first turn; anything else declines: `,
					300000,
					signal,
				);
			},
			second: (boundary, phrase) => {
				say(
					renderTurnApproval(
						plan as StudyPlan,
						position,
						2,
						boundary.attemptId,
						boundary.commitment.value,
						provenance.process.pid,
					),
				);
				const remaining = Math.max(1, Date.parse(boundary.approvalDeadlineAt) - Date.now());
				return terminal.ask(
					`Type ${phrase} to approve ONLY this continuation turn; anything else declines: `,
					remaining,
					signal,
				);
			},
		};
		for (position = 1; position <= 4; position++) {
			if (signal.aborted) break;
			let status: string;
			try {
				status = await runSlot(config.studyFile, key, hooks, signal, undefined, { observer });
			} catch (error) {
				stopWith("study", `slot ${position} stopped: ${message(error)}`);
				break;
			}
			if (status !== "completed") {
				stopWith("study", `slot ${position} ended as ${status}; the study stops here and the slot stays spent`);
				break;
			}
		}
	} catch (error) {
		if (!(error instanceof StopStudy)) stopWith(outcome.stage, message(error));
	}
	outcome.interrupted = signal.aborted;
	if (signal.aborted) outcome.reasons.push("interrupted");

	// 6. Cleanup: the keeper-owned group is stopped once. A failed stop is reported, never softened or retried.
	try {
		const end = await server.stop();
		outcome.server.stop = { exit: end.exit, processGone: end.processGone, listenerGone: end.listenerGone };
		outcome.server.cleanup = end.processGone && end.listenerGone ? "confirmed" : "cleanup-unconfirmed";
	} catch (error) {
		outcome.server.cleanup = "cleanup-unconfirmed";
		outcome.reasons.push(`stopping the owned server failed: ${message(error)}`);
	}
	if (outcome.server.cleanup === "cleanup-unconfirmed")
		outcome.reasons.push("owned-server cleanup could not be confirmed");

	// 7. Independent verification, in fresh processes, from the files on disk only.
	for (let position = 1; position <= 4; position++) {
		if (!existsSync(slotPath(config.studyFile, position, "start"))) continue;
		let status = "no-end-record";
		try {
			status = readSlot<SlotEnd>(slotPath(config.studyFile, position, "end"), key, "end").status;
		} catch {}
		outcome.slots.push({ position, arm: plan?.order[position - 1] ?? null, status });
	}
	if (plan) {
		outcome.independentRead.performed = true;
		const [provenanceFile, studyFile] = readerSuffixes.map((suffix) => `${config.studyFile}${suffix}`) as [
			string,
			string,
		];
		const [taskOwnedStatus, studyStatus] = await Promise.all([
			readFresh(["--task-owned", config.studyFile, config.keyFile, provenanceFile]),
			readFresh([config.studyFile, config.keyFile, studyFile]),
		]);
		if (taskOwnedStatus === 0) {
			try {
				outcome.independentRead.report = readJson(provenanceFile) as TaskOwnedStudyReportV0;
				outcome.independentRead.status = "valid";
			} catch {
				outcome.independentRead.status = "reader-refused";
			}
		} else outcome.independentRead.status = "reader-refused";
		if (studyStatus !== 0) outcome.reasons.push("the fresh-process study reader refused the evidence");
		if (studyStatus === 0) {
			try {
				const trials =
					(readJson(studyFile) as { trials?: Array<{ firstCorrect?: boolean; referenceCorrect?: boolean }> })
						.trials ?? [];
				outcome.independentRead.answers = {
					firstCorrect: trials.filter((t) => t.firstCorrect === true).length,
					referenceCorrect: trials.filter((t) => t.referenceCorrect === true).length,
					of: trials.length,
				};
			} catch {}
		}
		if (outcome.independentRead.status !== "valid")
			outcome.reasons.push("the fresh-process reader refused the evidence; runner statuses are unverified");
	}
	// A signal that arrived during cleanup or verification still counts; those steps ran to completion regardless.
	if (signal.aborted && !outcome.interrupted) {
		outcome.interrupted = true;
		outcome.reasons.push("interrupted during cleanup or verification; both still ran to completion");
	}
	outcome.stage = stoppedAt ?? "done";
	return finish(outcome);
}

class StopStudy extends Error {}

function finish(outcome: AaOperatorOutcomeV0): AaOperatorOutcomeV0 {
	const report = outcome.independentRead.report;
	const complete =
		outcome.server.cleanup === "confirmed" &&
		outcome.independentRead.status === "valid" &&
		outcome.independentRead.answers !== null &&
		!outcome.interrupted &&
		report?.studyAdmission === "complete" &&
		report.studyStatus === "four-receipts" &&
		report.observedProcessIdentity === "consistent" &&
		report.lifecycle === "cleaned" &&
		outcome.slots.length === 4 &&
		outcome.slots.every((slot) => slot.status === "completed");
	outcome.verdict = complete
		? "complete-under-declared-assumptions"
		: outcome.server.cleanup === "cleanup-unconfirmed"
			? "cleanup-unconfirmed"
			: outcome.slots.length > 0
				? "partial"
				: "refused";
	return outcome;
}

function renderLaunchApproval(
	summary: AaPlanSummaryV0,
	plans: Record<Arm, InitialContinuationPlanV0>,
	launch: TaskOwnedLaunchPlanV0,
	phrase: string,
	config: AaOperatorConfigV0,
): string {
	const limits = summary.limits;
	return [
		"",
		"=== APPROVAL: start a task-owned model server ===",
		`plan identity     ${summary.launchPlan} (launch plan ${shortHex(launch.commitment.value)})`,
		`profile           ${summary.profile}`,
		`executable        ${summary.executable.path}  sha256 ${shortHex(summary.executable.sha256)}…`,
		`model             ${summary.model.path}  sha256 ${shortHex(summary.model.sha256)}…`,
		`alias / gpu       ${summary.model.alias} / ${summary.model.gpuLayers} layers`,
		`endpoint          ${summary.endpoint} (loopback only; must be unused)`,
		`prompt commitments first ${shortHex(plans.baseline.initial.promptCommitment.value)}  continuation ${shortHex(plans.baseline.continuationPromptCommitment.value)}`,
		`study order       ${summary.order.join(" → ")}  (seed ${config.seed})`,
		`limits            ${limits.slots} fresh Pi sessions × ${limits.turnsPerSlot} turns, at most ${limits.maxModelRequests} model requests, no tools`,
		`                  per slot: ${limits.wallTimeoutMsPerSlot} ms wall, ${limits.maxTransferredBytesPerSlot} bytes, continuation idle ${limits.continuationApprovalIdleMs} ms`,
		`                  server startup ${limits.serverStartupMs} ms, model-ready wait ${limits.modelReadyMs} ms, approvals expire after ${limits.approvalWindowMs} ms`,
		"pending action    start the server, wait for it to report ready, then ask for each turn separately",
		"This approval starts the server only. It authorises no model request. Your existing server is not touched.",
		`Approval phrase: ${phrase}`,
		"",
	].join("\n");
}
function renderTurnApproval(
	plan: StudyPlan,
	position: number,
	turn: 1 | 2,
	attemptId: string,
	commitment: string,
	pid: number,
): string {
	const requestNumber = (position - 1) * 2 + turn;
	return [
		"",
		`=== APPROVAL: slot ${position} of 4, ${turn === 1 ? "first" : "continuation"} turn ===`,
		`arm               ${plan.order[position - 1]} (order ${plan.order.join(" → ")})`,
		`attempt           ${attemptId}`,
		`turn              ${turn} of 2 — request ${requestNumber} of at most 8 in this study`,
		`${turn === 1 ? "plan" : "boundary"} commitment  ${shortHex(commitment)}`,
		`server            ${plan.options.upstream} (task-owned process ${pid}); tool-free`,
		`This approves only this one turn.${turn === 1 ? " The continuation turn and every later slot need their own approval." : " Later slots need their own approval."}`,
		"",
	].join("\n");
}

/** Plain, secret-free rendering of an outcome for the operator. It never contains responses or reasoning. */
export function renderAaOutcomeV0(outcome: AaOperatorOutcomeV0): string {
	const report = outcome.independentRead.report;
	const answers = outcome.independentRead.answers;
	const readiness =
		outcome.readiness.status === "not-attempted"
			? "not attempted"
			: outcome.readiness.status === "ready"
				? `server reported ready after ${outcome.readiness.polls} poll(s)`
				: `refused: ${outcome.readiness.reason}`;
	const lines = [
		"",
		`A/A operator outcome: ${outcome.verdict.toUpperCase()}`,
		`  stopped at stage        ${outcome.stage}${outcome.interrupted ? " (interrupted)" : ""}`,
		`  server readiness        ${readiness} — a server-reported observation, not proof of inference`,
		`  slots started           ${outcome.slots.length} of 4 — ${outcome.slots.map((s) => `${s.position}:${s.arm ?? "?"}:${s.status}`).join(", ") || "none"} (runner statuses, unverified)`,
		`  independent read        ${outcome.independentRead.status}${outcome.independentRead.performed ? "" : " (no study was created)"}`,
		`  evidence records        ${report ? report.records : "unavailable"}`,
		`  request/dispatch binding ${report ? `${report.admissionSidecars} of 8 admission sidecars bound to captured requests` : "unavailable"}`,
		`  observed identity       ${report ? `${report.observedProcessIdentity} (task-owned process; not an attestation)` : "unavailable"}`,
		`  study completion        ${report ? `${report.studyStatus}; admission ${report.studyAdmission}` : "unavailable"}`,
		`  trust and missing facts ${report ? `${report.hostFacts.ownership}; ${report.declaredTrustAssumptions.length} declared assumptions (not verified); unavailable: ${report.hostFacts.unavailable.join(", ") || "none"}` : "unavailable"}`,
		`  owned-server cleanup    ${outcome.server.cleanup}${outcome.server.stop ? ` (process gone: ${outcome.server.stop.processGone}, listener gone: ${outcome.server.stop.listenerGone})` : ""}`,
		`  answer correctness      ${answers ? `first turn ${answers.firstCorrect}/${answers.of}, repeat turn ${answers.referenceCorrect}/${answers.of} (this study's own check; no parity claim)` : "unavailable"}`,
		...outcome.reasons.map((reason) => `  note: ${reason}`),
		"  A complete study is internally consistent under the declared assumptions. It is not server attestation and not model parity.",
		"",
	];
	return lines.join("\n");
}
