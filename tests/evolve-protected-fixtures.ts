// Deterministic, hermetic protected-experiment run directory fixtures for EVOLVE-INSPECT-001 tests.
// Uses real protocol validators, `sealEndoProtectedTrialV0`, `EndoCaptureLogV0`, `summarizeModelRecordingV0`,
// and `collectStagedChangeSetV0` so every passing fixture passes the exact independent `reportProtectedExperimentV0`.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { summarizeModelRecordingV0 } from "../adapters/sandbox/model-evidence.ts";
import { ENDO_PI_MODEL_ROUTES_V0, modelRelayPolicyDigestV0 } from "../adapters/sandbox/model-relay.ts";
import { endoProtectedRelayPolicyV1, endoProtectedStagedBaselineV2 } from "../adapters/sandbox/protected-report.ts";
import { collectStagedChangeSetV0, endoStagedCandidateRecordV0 } from "../adapters/sandbox/staged-changeset.ts";
import { endoSubmissionDigestV0 } from "../adapters/sandbox/submission.ts";
import {
	ENDO_PROTECTED_RELAY_BRIDGE_TARGET_V1,
	ENDO_PROTECTED_RELAY_REFUSALS_V1,
	ENDO_PROTECTED_RELAY_SOCKET_TARGET_V1,
	type EndoProtectedModelAccessV1,
	type EndoProtectedRunV0,
	type EndoProtectedRunV1,
	type EndoProtectedRunV2,
	type EndoProtectedSpecV0,
	type EndoProtectedSpecV1,
	type EndoProtectedSpecV2,
	type EndoProtectedTrialV0,
	type EndoProtectedTrialV1,
	type EndoProtectedTrialV2,
} from "../protocol/protected-experiment.ts";
import { DEFAULT_ENDO_CHANGESET_LIMITS_V0 } from "../protocol/staged-changeset.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import {
	endoProtectedChangeSetRefusalsV2,
	sealEndoProtectedTrialV0,
} from "../runtime/contracts/protected-experiment.ts";

export const H = (c: string) => c.repeat(64);
export const SECRET_HOST_AGENT_DIR = "/secret-host-path/private-agents/condition-alpha";
export const SECRET_HOST_EVALUATOR_FILE = "/secret-host-path/hidden-evaluators/cases.json";

const ISOLATION_RUN: EndoProtectedRunV0["isolation"] = {
	mechanism: "bubblewrap",
	version: "0.13.1",
	executableSha256: H("2"),
	containment: { mechanism: "systemd-user-scope", version: "262", systemdRunSha256: H("9"), tasksMax: 512 },
};

const BASE_LIMITS = {
	agentTimeoutMs: 60_000,
	evaluationTimeoutMs: 10_000,
	outputBytes: 65_536,
	tmpfsBytes: 64 * 1024 * 1024,
	maxFileBytes: 65_536,
	maxTotalBytes: 262_144,
};

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, canonicalEndoJsonV0(value as Record<string, unknown>));
}

function writeTree(root: string, files: Record<string, string>): void {
	mkdirSync(root, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, { mode: 0o644 });
	}
}

function baseTrialV0(
	run: EndoProtectedRunV0,
	pos: number,
	task: string,
	condition: string,
	trial: number,
	attempt: number,
	retryOf: number | null,
): Omit<EndoProtectedTrialV0, "recordSha256"> {
	const files = [{ path: "src/a.mjs", bytes: 12, sha256: H("a") }];
	const profile = run.profiles.find((p) => p.condition === condition)!.sha256;
	const ev = run.evaluators.find((e) => e.task === task)!;
	return {
		schemaVersion: "endo.protected-trial.v0",
		run: { id: run.spec.id, specSha256: run.specSha256, seed: run.seed },
		trial: { position: pos, task, condition, trial, attempt, retryOf },
		isolation: {
			...ISOLATION_RUN,
			profileSha256: profile,
			requested: {
				namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"],
				network: "none",
				rootReadOnly: true,
				userNamespacesDisabled: true,
				environment: ["HOME", "PATH", "TMPDIR"],
				mounts: [
					{ target: "/usr/bin/node", kind: "ro-file", role: "runtime", sha256: H("4") },
					{ target: "/work", kind: "rw-dir", role: "workspace", sha256: null },
				],
			},
		},
		preflight: {
			status: "established",
			probes: [{ id: "net-external", passed: true, observed: "ENETUNREACH" }],
			reason: null,
		},
		network: { mode: "none", relay: null, status: "established" },
		agent: {
			status: "completed",
			exitCode: 0,
			signal: null,
			durationMs: 1250,
			termination: "confirmed",
			outputSha256: H("5"),
			scope: { unit: `endo-sandbox-${"a".repeat(24)}`, established: true, ended: "confirmed" },
		},
		submission: { status: "collected", files, sha256: endoSubmissionDigestV0(files), refusals: [] },
		evaluation: {
			status: "passed",
			definitionSha256: ev.definitionSha256,
			driverSha256: ev.driverSha256,
			cases: { total: 5, passed: 5 },
			reason: null,
			outputSha256: H("8"),
		},
		controller: { finalized: "normally" },
		invalidating: [],
		recordedAt: "2026-11-22T10:00:00.000Z",
	};
}

/**
 * Create a rich offline v0 protected run exercising:
 * - pos 0: verified passed (clean exit 0)
 * - pos 1: verified failed (evaluator 2/5)
 * - pos 2: verified passed candidate WHILE agent timed-out afterward (distinction preserved!)
 * - pos 3: retry accounting (attempt-1 controller-interrupted/not-run, attempt-2 verified passed)
 * - pos 4: not attempted
 * - pos 5: incomplete/unfinalized attempt (attempt-1 dir exists with no record.json -> refusedRecords)
 * - pos 6: tampered trial record (digest mismatch -> refusedRecords + record-refused attrition)
 */
export function createOfflineRichRunV0(dir: string, id = "endo.experiment.offline-rich"): EndoProtectedRunV0 {
	const spec: EndoProtectedSpecV0 = {
		schemaVersion: "endo.protected-experiment-spec.v0",
		id,
		description:
			"Offline fixture with passed, failed, timed-out pass, retry, not-attempted, missing and tampered trials",
		seed: 4242,
		trials: 7,
		limits: BASE_LIMITS,
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "calc-fix",
				workspace: { "src/a.mjs": "export const f = () => 1;\n" },
				submission: ["src/a.mjs"],
				evaluator: { file: SECRET_HOST_EVALUATOR_FILE, sha256: H("6") },
			},
		],
		conditions: [
			{
				id: "baseline",
				description: "Reference baseline condition",
				agent: { directory: SECRET_HOST_AGENT_DIR, argv: ["/usr/bin/node", "/agent/run.mjs"] },
			},
		],
	};
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as unknown as Record<string, unknown>));
	const run: EndoProtectedRunV0 = {
		schemaVersion: "endo.protected-run.v0",
		runner: "endo-protected-runner.2",
		spec,
		specSha256,
		seed: 4242,
		seedSource: "spec",
		ordering: "blocked-randomization-v0",
		plan: Array.from({ length: 7 }, (_, i) => ({ position: i, task: "calc-fix", condition: "baseline", trial: i })),
		isolation: ISOLATION_RUN,
		profiles: [{ condition: "baseline", sha256: H("3") }],
		evaluators: [
			{ task: "calc-fix", definitionSha256: H("6"), driverSha256: H("7"), reference: "passed", negative: "failed" },
		],
		createdAt: "2026-11-22T09:55:00.000Z",
	};
	writeJson(join(dir, "protected-run.json"), run);

	const trialPath = (trial: number, attempt: number) =>
		join(dir, "trials", "calc-fix", "baseline", String(trial), `attempt-${attempt}`, "record.json");

	// pos 0: clean pass
	writeJson(trialPath(0, 1), sealEndoProtectedTrialV0(baseTrialV0(run, 0, "calc-fix", "baseline", 0, 1, null)));

	// pos 1: verified failure
	const failed = baseTrialV0(run, 1, "calc-fix", "baseline", 1, 1, null);
	failed.evaluation = { ...failed.evaluation, status: "failed", cases: { total: 5, passed: 2 } };
	writeJson(trialPath(1, 1), sealEndoProtectedTrialV0(failed));

	// pos 2: candidate passed evaluation (5/5) while agent process timed-out afterward
	const timedOutPass = baseTrialV0(run, 2, "calc-fix", "baseline", 2, 1, null);
	timedOutPass.agent = {
		...timedOutPass.agent,
		status: "timed-out",
		exitCode: null,
		signal: "SIGKILL",
		durationMs: 60_000,
		termination: "confirmed",
	};
	writeJson(trialPath(2, 1), sealEndoProtectedTrialV0(timedOutPass));

	// pos 3: retry (attempt-1 controller-interrupted + not-run -> attempt-2 passed)
	const retryFirst = baseTrialV0(run, 3, "calc-fix", "baseline", 3, 1, null);
	retryFirst.preflight = { status: "unavailable", probes: [], reason: "interrupted before preflight" };
	retryFirst.network = { mode: "none", relay: null, status: "unavailable" };
	retryFirst.agent = {
		status: "not-run",
		exitCode: null,
		signal: null,
		durationMs: null,
		termination: "not-applicable",
		outputSha256: null,
		scope: null,
	};
	retryFirst.submission = { status: "not-collected", files: [], sha256: null, refusals: [] };
	retryFirst.evaluation = {
		status: "not-run",
		definitionSha256: H("6"),
		driverSha256: H("7"),
		cases: null,
		reason: null,
		outputSha256: null,
	};
	retryFirst.controller = { finalized: "on-resume" };
	retryFirst.invalidating = ["controller-interrupted", "isolation-unavailable"];
	writeJson(trialPath(3, 1), sealEndoProtectedTrialV0(retryFirst));
	writeJson(trialPath(3, 2), sealEndoProtectedTrialV0(baseTrialV0(run, 3, "calc-fix", "baseline", 3, 2, 1)));

	// pos 4: not attempted (no directory)

	// pos 5: incomplete/unfinalized attempt (attempt-1 dir exists without record.json)
	mkdirSync(dirname(trialPath(5, 1)), { recursive: true });

	// pos 6: tampered record (schema-valid fields, altered durationMs after sealing -> digest mismatch)
	const tampered = sealEndoProtectedTrialV0(baseTrialV0(run, 6, "calc-fix", "baseline", 6, 1, null));
	tampered.agent.durationMs = 9999;
	writeJson(trialPath(6, 1), tampered);

	return run;
}

/**
 * Create a valid model-connected v1 protected run with genuine `EndoCaptureLogV0` recording stores
 * verified by `verifyModelEvidenceV0`:
 * - pos 0: verified pass (2 answered verified exchanges >= minExchanges 1)
 * - pos 1: failedBelowMinimumExchanges (0 exchanges, even though evaluator passed)
 */
export function createModelConnectedRunV1(
	dir: string,
	id = "endo.experiment.model-v1",
	options: { responseStatus?: number } = {},
): EndoProtectedRunV1 {
	const responseStatus = options.responseStatus ?? 200;
	const modelAccess: EndoProtectedModelAccessV1 = {
		upstream: "http://127.0.0.1:8091",
		model: "synthetic-local-model",
		routes: ENDO_PI_MODEL_ROUTES_V0.map((r) => ({ method: r.method, path: r.path })),
		maxRequestBytes: 65_536,
		maxTransferredBytes: 262_144,
		maxConnections: 2,
		maxTotalConnections: 8,
		maxExchanges: 10,
		maxCompletionTokens: 4096,
		minExchanges: 1,
	};
	const spec: EndoProtectedSpecV1 = {
		schemaVersion: "endo.protected-experiment-spec.v1",
		id,
		description: "Model-connected v1 fixture with verified capture log and below-minimum-exchanges trial",
		seed: 101,
		trials: 2,
		limits: { ...BASE_LIMITS, memoryMaxBytes: 512 * 1024 * 1024, cpuQuotaPercent: 200 },
		runtime: { executables: ["/usr/bin/node"], aliases: [] },
		modelAccess,
		tasks: [
			{
				id: "model-task",
				workspace: { "src/a.mjs": "export const f = () => 1;\n" },
				submission: ["src/a.mjs"],
				evaluator: { file: SECRET_HOST_EVALUATOR_FILE, sha256: H("6") },
			},
		],
		conditions: [
			{
				id: "effort-low",
				description: "Low effort arm",
				agent: { directory: SECRET_HOST_AGENT_DIR, argv: ["/usr/bin/node", "/agent/run.mjs"] },
			},
		],
	};
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as unknown as Record<string, unknown>));
	const run: EndoProtectedRunV1 = {
		schemaVersion: "endo.protected-run.v1",
		runner: "endo-protected-runner.2",
		spec,
		specSha256,
		seed: 101,
		seedSource: "spec",
		ordering: "blocked-randomization-v0",
		plan: [
			{ position: 0, task: "model-task", condition: "effort-low", trial: 0 },
			{ position: 1, task: "model-task", condition: "effort-low", trial: 1 },
		],
		isolation: ISOLATION_RUN,
		profiles: [{ condition: "effort-low", sha256: H("3") }],
		evaluators: [
			{ task: "model-task", definitionSha256: H("6"), driverSha256: H("7"), reference: "passed", negative: null },
		],
		createdAt: "2026-11-22T10:05:00.000Z",
	};
	writeJson(join(dir, "protected-run.json"), run);

	const policy = endoProtectedRelayPolicyV1(modelAccess);
	const policySha256 = modelRelayPolicyDigestV0(policy);

	const writeModelAttempt = (trial: number, exchangeCount: number) => {
		const attemptDir = join(dir, "trials", "model-task", "effort-low", String(trial), "attempt-1");
		const modelDir = join(attemptDir, "model");
		const storeDir = join(modelDir, "store");
		mkdirSync(modelDir, { recursive: true });
		const keyBytes = randomBytes(32);
		const key = endoDigestKeyV0(keyBytes, "installation");
		writeFileSync(join(modelDir, "digest-key"), `${keyBytes.toString("hex")}\n`, { mode: 0o600 });
		const log = new EndoCaptureLogV0(storeDir, key, "record");
		log.record("capture.started", {
			role: "record",
			listen: modelAccess.upstream,
			digestKey: { keyId: key.keyId, domain: key.domain },
		});
		for (let i = 1; i <= exchangeCount; i += 1) {
			const reqBody = Buffer.from(
				JSON.stringify({
					model: modelAccess.model,
					max_completion_tokens: 1024,
					messages: [{ role: "user", content: `prompt ${i}` }],
				}),
			);
			const resWire = Buffer.from(
				`HTTP/1.1 ${responseStatus} ${responseStatus === 200 ? "OK" : "Error"}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ choices: [{ message: { content: "ok" } }] })}`,
			);
			const reqRef = log.keep(reqBody);
			const resRef = log.keep(resWire);
			const requestDigest = key.digest({ method: "POST", path: "/v1/chat/completions", body: reqRef.digest });
			log.record("capture.request", {
				exchange: i,
				attempt: 1,
				method: "POST",
				path: "/v1/chat/completions",
				requestDigest: { ...requestDigest },
				body: { ...reqRef } as unknown as Record<string, never>,
			});
			log.record("capture.exchange-ended", {
				exchange: i,
				status: responseStatus,
				wire: { ...resRef } as unknown as Record<string, never>,
				wireBytes: resRef.bytes,
				chunks: [{ offsetMs: 1, bytes: resRef.bytes }],
				headBytes: null,
				headScrubbed: [],
				outcome: "complete",
				afterChunks: null,
				error: null,
			});
		}
		log.close();

		const summary = summarizeModelRecordingV0(storeDir, key);
		const files = [{ path: "src/a.mjs", bytes: 12, sha256: H("a") }];
		const rec: Omit<EndoProtectedTrialV1, "recordSha256"> = {
			schemaVersion: "endo.protected-trial.v1",
			run: { id: spec.id, specSha256, seed: run.seed },
			trial: { position: trial, task: "model-task", condition: "effort-low", trial, attempt: 1, retryOf: null },
			isolation: {
				...ISOLATION_RUN,
				profileSha256: H("3"),
				limits: { memoryMaxBytes: spec.limits.memoryMaxBytes, cpuQuotaPercent: spec.limits.cpuQuotaPercent },
				requested: {
					namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"],
					network: "model-relay",
					rootReadOnly: true,
					userNamespacesDisabled: true,
					environment: ["HOME", "PATH", "TMPDIR"],
					mounts: [
						{ target: "/usr/bin/node", kind: "ro-file", role: "runtime", sha256: H("4") },
						{ target: ENDO_PROTECTED_RELAY_SOCKET_TARGET_V1, kind: "socket", role: "model-relay", sha256: null },
						{
							target: ENDO_PROTECTED_RELAY_BRIDGE_TARGET_V1,
							kind: "ro-file",
							role: "model-bridge",
							sha256: H("d"),
						},
					],
				},
			},
			preflight: {
				status: "established",
				probes: [{ id: "net-external", passed: true, observed: "ENETUNREACH" }],
				reason: null,
			},
			network: {
				mode: "model-relay",
				status: "established",
				relay: {
					status: "ran",
					policySha256,
					admitted: exchangeCount,
					refusals: Object.fromEntries(ENDO_PROTECTED_RELAY_REFUSALS_V1.map((k) => [k, 0])) as Record<
						(typeof ENDO_PROTECTED_RELAY_REFUSALS_V1)[number],
						number
					>,
					transferredBytes: exchangeCount * 200,
					recordingFailures: 0,
				},
			},
			recording: {
				status: "complete",
				keyId: summary.keyId,
				required: modelAccess.minExchanges,
				exchanges: summary.exchanges,
			},
			agent: {
				status: "completed",
				exitCode: 0,
				signal: null,
				durationMs: 2100,
				termination: "confirmed",
				outputSha256: H("5"),
				scope: { unit: `endo-sandbox-${"b".repeat(24)}`, established: true, ended: "confirmed", result: "success" },
			},
			submission: { status: "collected", files, sha256: endoSubmissionDigestV0(files), refusals: [] },
			evaluation: {
				status: "passed",
				definitionSha256: H("6"),
				driverSha256: H("7"),
				cases: { total: 4, passed: 4 },
				reason: null,
				outputSha256: H("8"),
			},
			controller: { finalized: "normally" },
			invalidating: [],
			recordedAt: "2026-11-22T10:06:00.000Z",
		};
		writeJson(join(attemptDir, "record.json"), sealEndoProtectedTrialV0(rec));
	};

	writeModelAttempt(0, 2);
	writeModelAttempt(1, 0);
	return run;
}

/**
 * Create a valid offline staged-changeset v2 protected run with genuine `baseline/`, `changeset/`, and verified digests.
 * Optionally tampers a staged file after sealing to exercise candidate/changeset verification refusal.
 */
export function createStagedRunV2(
	dir: string,
	options: { id?: string; tamperChangeset?: boolean } = {},
): EndoProtectedRunV2 {
	const id = options.id ?? "endo.experiment.staged-v2";
	const workspace = { "src/calc.mjs": "export const calc = () => 20;\n", "README.md": "# calc\n" };
	const limits = {
		...DEFAULT_ENDO_CHANGESET_LIMITS_V0,
		maxFileBytes: 65_536,
		maxTotalStagedBytes: 262_144,
		maxWorkspaceBytes: 1_048_576,
		maxWalkedEntries: 128,
		maxChangedFiles: 16,
		maxDepth: 6,
	};
	const spec: EndoProtectedSpecV2 = {
		schemaVersion: "endo.protected-experiment-spec.v2",
		id,
		description: "Offline staged-changeset v2 fixture",
		seed: 777,
		trials: 1,
		limits: BASE_LIMITS,
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "staged-calc",
				workspace,
				submission: { mode: "staged-changeset", limits },
				evaluator: { file: SECRET_HOST_EVALUATOR_FILE, sha256: H("6") },
			},
		],
		conditions: [
			{
				id: "staged-agent",
				description: "Staged change-set condition",
				agent: { directory: SECRET_HOST_AGENT_DIR, argv: ["/usr/bin/node", "/agent/run.mjs"] },
			},
		],
	};
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as unknown as Record<string, unknown>));
	const run: EndoProtectedRunV2 = {
		schemaVersion: "endo.protected-run.v2",
		runner: "endo-protected-runner.2",
		spec,
		specSha256,
		seed: 777,
		seedSource: "spec",
		ordering: "blocked-randomization-v0",
		plan: [{ position: 0, task: "staged-calc", condition: "staged-agent", trial: 0 }],
		isolation: ISOLATION_RUN,
		profiles: [{ condition: "staged-agent", sha256: H("3") }],
		evaluators: [
			{
				task: "staged-calc",
				definitionSha256: H("6"),
				driverSha256: H("7"),
				reference: "passed",
				negative: "failed",
			},
		],
		createdAt: "2026-11-22T10:10:00.000Z",
	};
	writeJson(join(dir, "protected-run.json"), run);

	const attemptDir = join(dir, "trials", "staged-calc", "staged-agent", "0", "attempt-1");
	const baselineDir = join(attemptDir, "baseline");
	const workDir = join(attemptDir, "work");
	const changesetDir = join(attemptDir, "changeset");
	writeTree(baselineDir, workspace);
	writeTree(workDir, { ...workspace, "src/calc.mjs": "export const calc = () => 14;\n" });

	const pin = endoProtectedStagedBaselineV2(workspace);
	const collected = collectStagedChangeSetV0(pin, workDir, changesetDir, limits);
	if (collected.status !== "collected" || collected.manifest === null)
		throw new Error(`unexpected collection failure: ${JSON.stringify(collected.refusals)}`);
	const candidate = endoStagedCandidateRecordV0(collected.manifest, pin);

	const rec: Omit<EndoProtectedTrialV2, "recordSha256"> = {
		schemaVersion: "endo.protected-trial.v2",
		run: { id, specSha256, seed: run.seed },
		trial: { position: 0, task: "staged-calc", condition: "staged-agent", trial: 0, attempt: 1, retryOf: null },
		isolation: {
			...ISOLATION_RUN,
			profileSha256: H("3"),
			requested: {
				namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"],
				network: "none",
				rootReadOnly: true,
				userNamespacesDisabled: true,
				environment: ["HOME", "PATH", "TMPDIR"],
				mounts: [{ target: "/work", kind: "rw-dir", role: "workspace", sha256: null }],
			},
		},
		preflight: {
			status: "established",
			probes: [{ id: "net-external", passed: true, observed: "ENETUNREACH" }],
			reason: null,
		},
		network: { mode: "none", relay: null, status: "established" },
		agent: {
			status: "completed",
			exitCode: 0,
			signal: null,
			durationMs: 950,
			termination: "confirmed",
			outputSha256: H("5"),
			scope: { unit: `endo-sandbox-${"c".repeat(24)}`, established: true, ended: "confirmed" },
		},
		changeset: {
			baseline: { status: "pinned", sha256: pin.sha256, files: pin.files.length, totalBytes: pin.totalBytes },
			collection: {
				status: "collected",
				changesetSha256: collected.manifest.changesetSha256,
				summary: collected.manifest.summary,
				...endoProtectedChangeSetRefusalsV2([]),
			},
			verification: { status: "verified", reason: null, candidateSha256: candidate.sha256 },
		},
		evaluation: {
			status: "passed",
			definitionSha256: H("6"),
			driverSha256: H("7"),
			cases: { total: 6, passed: 6 },
			reason: null,
			outputSha256: H("8"),
		},
		controller: { finalized: "normally" },
		invalidating: [],
		recordedAt: "2026-11-22T10:11:00.000Z",
	};
	writeJson(join(attemptDir, "record.json"), sealEndoProtectedTrialV0(rec));

	if (options.tamperChangeset) {
		const stagedFile = join(changesetDir, "files", "src", "calc.mjs");
		chmodSync(stagedFile, 0o644);
		writeFileSync(stagedFile, "export const calc = () => 999;\n");
		chmodSync(stagedFile, 0o444);
	}
	return run;
}
