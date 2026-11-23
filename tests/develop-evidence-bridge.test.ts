// Acceptance tests for DEVELOP-EVIDENCE-BRIDGE-001 (docs/designs/develop-evidence-bridge.md).
// Disposable fixture with one registered project, one real Git repo, one operator task, one governed attempt,
// plus disposable staged-changeset (v2) and fixed-path (v0, PR #159) protected-experiment runs.
//
// Exercises the positive case, all eight required negative cases, trust-boundary labeling (workstation H0 BLOCKED),
// and the strict read-only / zero-side-effect invariant via the real CLI subprocess.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCheckV0 } from "../adapters/develop/check-runner.ts";
import { readDevelopEvidenceBridgeV0 } from "../adapters/develop/evidence-bridge.ts";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { gitStateReaderV0 } from "../adapters/git/state-observer.ts";
import { endoProtectedStagedBaselineV2 } from "../adapters/sandbox/protected-report.ts";
import { collectStagedChangeSetV0, endoStagedCandidateRecordV0 } from "../adapters/sandbox/staged-changeset.ts";
import {
	ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0,
	type EndoDevelopAttemptAuthorizationV0,
	validateEndoDevelopAttemptAuthorizationV0,
} from "../protocol/develop-attempt-execution.ts";
import { renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V0,
	type EndoDevelopEvidenceBridgeV0,
} from "../protocol/develop-evidence-bridge.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type {
	EndoProtectedRunV2,
	EndoProtectedSpecV2,
	EndoProtectedTrialV2,
} from "../protocol/protected-experiment.ts";
import { DEFAULT_ENDO_CHANGESET_LIMITS_V0 } from "../protocol/staged-changeset.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoBriefSha256V0 } from "../runtime/contracts/develop-attempt-execution.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { renderEndoDevelopEvidenceBridgeV0 } from "../runtime/contracts/develop-evidence-bridge.ts";
import { DevelopObservationsServiceV0 } from "../runtime/contracts/develop-observations.ts";
import { DevelopReceiptsServiceV0 } from "../runtime/contracts/develop-receipts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import {
	endoProtectedChangeSetRefusalsV2,
	sealEndoProtectedTrialV0,
} from "../runtime/contracts/protected-experiment.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopObservationsStoreV0 } from "../storage/develop-observations.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const H = (c: string) => c.repeat(64);
const roots: string[] = [];

function freshDir(prefix: string): string {
	const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(d);
	return d;
}

function chmodWritable(path: string): void {
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink()) return;
		if (st.isDirectory()) {
			chmodSync(path, 0o700);
			for (const name of readdirSync(path)) chmodWritable(join(path, name));
		} else if (st.isFile()) {
			chmodSync(path, 0o600);
		}
	} catch {
		// ignore cleanup errors
	}
}

afterEach(() => {
	for (const r of roots.splice(0)) {
		chmodWritable(r);
		rmSync(r, { recursive: true, force: true });
	}
});

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test Operator",
			GIT_AUTHOR_EMAIL: "operator@example.test",
			GIT_COMMITTER_NAME: "Test Operator",
			GIT_COMMITTER_EMAIL: "operator@example.test",
		},
	}).trim();
}

let eventSeq = 0;
function nullSink(): Writable {
	return new Writable({
		write(_chunk, _enc, cb) {
			cb();
		},
	});
}

function makeEvent(input: {
	id: string;
	kind: string;
	sessionId: string;
	recordedAtMs: number;
	payload: Record<string, unknown>;
	derivedFrom?: string[];
}): EndoEventV0 {
	eventSeq += 1;
	return {
		schemaVersion: "endo.event.v0",
		id: input.id,
		kind: input.kind,
		source: input.kind.startsWith("workbench.prompt-authorized") ? "authority-decision" : "runtime-fact",
		sequence: eventSeq,
		at: new Date(input.recordedAtMs).toISOString(),
		coordinates: { sessionId: input.sessionId },
		producer: "endo.workbench.test",
		derivedFrom: input.derivedFrom ?? [],
		payload: input.payload,
	} as unknown as EndoEventV0;
}

function proposalDigestOf(p: Record<string, unknown>): string {
	return sha256HexV0(
		canonicalEndoJsonV0({
			session: p.session,
			attachment: p.attachment,
			message: p.message,
			origin: p.origin,
			proposedAt: p.proposedAt,
		} as never),
	);
}

interface DisposableFixture {
	root: string;
	repo: string;
	projectId: string;
	taskId: string;
	attemptId: string;
	sessionId: string;
	proposalId: string;
	proposalDigest: string;
	authorizationEventId: string;
	initialCommit: string;
	fixedCommit: string;
	receiptsService: DevelopReceiptsServiceV0;
	observationsService: DevelopObservationsServiceV0;
	attemptsStore: DevelopAttemptsStoreV0;
	attemptsService: DevelopAttemptsServiceV0;
	workspace: DevelopWorkspaceServiceV0;
}

async function buildPositiveFixture(
	options: {
		withPlan?: boolean;
		withAuth?: boolean;
		runEndKind?: "lifecycle.run-completed" | "lifecycle.run-failed" | "lifecycle.interrupted" | "none" | "no-reply";
		withBoundObservations?: boolean;
		afterRunTrigger?: "run-settled" | "workbench-closing";
		withPassingCheck?: boolean;
		taskStatus?: "open" | "in-progress" | "review" | "done";
	} = {},
): Promise<DisposableFixture> {
	const root = freshDir("endo-bridge-store-");
	const repo = freshDir("endo-bridge-repo-");
	git(repo, ["init", "-q", "-b", "main"]);
	writeFileSync(join(repo, "calc.mjs"), "const [a, b] = process.argv.slice(2).map(Number);\nconsole.log(a - b);\n");
	git(repo, ["add", "calc.mjs"]);
	git(repo, ["commit", "-qm", "initial buggy calc"]);
	const initialCommit = git(repo, ["rev-parse", "HEAD"]);

	const tasksStore = new DevelopTasksStoreV0(root);
	const attemptsStore = new DevelopAttemptsStoreV0(root);
	const receiptsStore = new DevelopReceiptsStoreV0(root);
	const observationsStore = new DevelopObservationsStoreV0(root);

	const proj = tasksStore.registerProject({ name: "Calc Demo", path: repo, observedGitRoot: repo });
	if (!proj.ok) throw new Error(`registerProject failed: ${proj.code}`);
	const projectId = proj.value.id;

	const added = tasksStore.createTask(projectId, {
		title: "Fix calc addition",
		description: "Add two numbers cleanly.",
		acceptance: "node calc.mjs 2 3 prints 5",
	});
	if (!added.ok) throw new Error(`createTask failed: ${added.code}`);
	const taskId = added.value.id;
	const workspace = new DevelopWorkspaceServiceV0(tasksStore, { attempts: attemptsStore });

	const attemptsService = new DevelopAttemptsServiceV0(tasksStore, attemptsStore);
	const plan =
		options.withPlan === false
			? undefined
			: {
					checks: [
						{
							name: "sum",
							argv: ["node", "calc.mjs", "2", "3"],
							shows: "2 + 3 prints 5",
							expect: { exitCode: 0, stdout: "5\n" },
						},
					],
					criteria: [
						{ text: "calc adds its two inputs", checks: ["sum"] },
						{ text: "code stays readable", checks: [] },
					],
				};
	const prepared = attemptsService.prepare(projectId, taskId, {
		objective: "Fix calc.mjs so it adds the two arguments instead of subtracting",
		...(plan === undefined ? {} : { verification: plan }),
	});
	if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
	const attempt = prepared.value;
	const attemptId = attempt.id;

	const sessionId = "endo.session.pi.11111111-2222-3333-4444-555555555555";
	const attachment = "pi.default";
	const launchId = "0123456789abcdef";
	const proposalId = "endo.evidence.workbench-prompt-0123456789abcdef0123456789abcdef";
	const authorizationEventId = "endo.event.22222222222222222222222222222222";
	const instanceId = "pi-instance-1";
	const message = {
		digest: { algorithm: "hmac-sha256" as const, keyId: "key-1", value: H("a") },
		bytes: Buffer.byteLength(renderEndoDevelopBriefV0(attempt), "utf8"),
	};
	const proposedPayload = {
		proposalId,
		session: sessionId,
		attachment,
		message,
		origin: "operator-workbench",
		proposedAt: 10_000,
	};
	const proposalDigest = proposalDigestOf(proposedPayload);

	const revisionObserver = new GitRevisionObserverV0();
	const observationsService = new DevelopObservationsServiceV0(tasksStore, attemptsStore, observationsStore, {
		reader: gitStateReaderV0(revisionObserver),
		version: "0.1.0-test",
		now: (() => {
			let t = 11_000;
			return () => {
				t += 50;
				return t;
			};
		})(),
	});

	if (options.withAuth !== false) {
		const evStore = createEndoDurableEventStoreV0(root);
		const runEndKind = options.runEndKind ?? "lifecycle.run-completed";
		const events: EndoEventV0[] = [
			makeEvent({
				id: "endo.event.00000000000000000000000000000001",
				kind: "lifecycle.session-started",
				sessionId,
				recordedAtMs: 9_000,
				payload: { instance: instanceId },
			}),
			makeEvent({
				id: "endo.event.11111111111111111111111111111111",
				kind: "workbench.prompt-proposed",
				sessionId,
				recordedAtMs: 10_000,
				payload: { ...proposedPayload, proposalDigest },
			}),
			makeEvent({
				id: authorizationEventId,
				kind: "workbench.prompt-authorized",
				sessionId,
				recordedAtMs: 10_100,
				derivedFrom: ["endo.event.11111111111111111111111111111111"],
				payload: { proposalId, proposalDigest, decision: "allow" },
			}),
			makeEvent({
				id: "endo.event.33333333333333333333333333333333",
				kind: "workbench.prompt-dispatched",
				sessionId,
				recordedAtMs: 10_200,
				derivedFrom: [authorizationEventId],
				payload: { proposalId, proposalDigest },
			}),
		];
		if (runEndKind !== "no-reply") {
			events.push(
				makeEvent({
					id: "endo.event.44444444444444444444444444444444",
					kind: "workbench.prompt-accepted",
					sessionId,
					recordedAtMs: 10_300,
					derivedFrom: ["endo.event.33333333333333333333333333333333"],
					payload: { proposalId, disposition: "started" },
				}),
			);
			if (runEndKind !== "none") {
				events.push(
					makeEvent({
						id: "endo.event.55555555555555555555555555555555",
						kind: "lifecycle.run-started",
						sessionId,
						recordedAtMs: 10_400,
						payload: { instance: instanceId },
					}),
					makeEvent({
						id: "endo.event.66666666666666666666666666666666",
						kind: runEndKind,
						sessionId,
						recordedAtMs: 12_000,
						payload: { instance: instanceId },
					}),
				);
			}
		}
		for (const ev of events) evStore.ingest(ev);
		evStore.close();

		const authRecord: EndoDevelopAttemptAuthorizationV0 = validateEndoDevelopAttemptAuthorizationV0({
			schemaVersion: ENDO_DEVELOP_ATTEMPT_AUTHORIZATION_SCHEMA_V0,
			attemptId,
			recordedAtMs: 10_150,
			briefSha256: endoBriefSha256V0(renderEndoDevelopBriefV0(attempt)),
			taskRevision: attempt.task.revision,
			harness: "pi",
			session: sessionId,
			attachment,
			launchId,
			proposalId,
			proposalDigest,
			authorizationEventId,
			message,
			approvedBy: "operator",
			via: "workbench-terminal",
		});
		const written = attemptsStore.write(attemptId, "authorized", authRecord);
		if (written !== "created") throw new Error(`auth write failed: ${written}`);
	}

	if (options.withBoundObservations !== false) {
		const before = await observationsService.take(repo, { within: true });
		const recBefore = observationsService.record(attemptId, {
			point: "before-send",
			trigger: "send-approved",
			binding: { proposalId, authorizationEventId },
			taken: before,
		});
		if (!recBefore.ok) throw new Error(`record before-send failed: ${recBefore.code}`);
	}

	// Simulate the fix being written to the working tree and observed at run-end, then committed cleanly.
	writeFileSync(join(repo, "calc.mjs"), "const [a, b] = process.argv.slice(2).map(Number);\nconsole.log(a + b);\n");

	if (options.withBoundObservations !== false) {
		const after = await observationsService.take(repo, { within: true });
		const recAfter = observationsService.record(attemptId, {
			point: "after-run",
			trigger: options.afterRunTrigger ?? "run-settled",
			binding: { proposalId, authorizationEventId },
			taken: after,
		});
		if (!recAfter.ok) throw new Error(`record after-run failed: ${recAfter.code}`);
	}

	git(repo, ["add", "calc.mjs"]);
	git(repo, ["commit", "-qm", "fix calc addition"]);
	const fixedCommit = git(repo, ["rev-parse", "HEAD"]);

	const receiptsService = new DevelopReceiptsServiceV0(tasksStore, attemptsStore, receiptsStore, {
		observe: (directory, opts) => revisionObserver.observe(directory, opts),
		run: runCheckV0,
		version: "0.1.0-test",
		now: (() => {
			let t = 20_000;
			return () => {
				t += 100;
				return t;
			};
		})(),
	});

	if (options.withPassingCheck !== false) {
		const planned = await receiptsService.plan(attemptId, {
			argv: ["node", "calc.mjs", "2", "3"],
			cwd: repo,
			keepOutput: true,
		});
		if (!planned.ok) throw new Error(`receipt plan failed: ${planned.code}`);
		const ran = await receiptsService.run(planned.plan, { stdout: nullSink(), stderr: nullSink() });
		if (ran.written !== "created" || ran.receipt.outcome !== "passed")
			throw new Error(`receipt run unexpected: ${ran.written} ${ran.receipt.outcome}`);
	}

	const desiredStatus = options.taskStatus ?? "review";
	if (desiredStatus !== "open") {
		let rev = added.value.revision;
		const move = (to: "in-progress" | "review" | "done", note?: string) => {
			const res = tasksStore.setStatus(projectId, taskId, rev, to, note ?? null);
			if (!res.ok) throw new Error(`status move ${to} failed: ${res.code}`);
			rev = res.value.revision;
		};
		if (desiredStatus === "in-progress") move("in-progress");
		if (desiredStatus === "review") {
			move("in-progress");
			move("review", "ready to inspect");
		}
		if (desiredStatus === "done") {
			move("in-progress");
			move("review");
			move("done", "operator marked done");
		}
	}

	return {
		root,
		repo,
		projectId,
		taskId,
		attemptId,
		sessionId,
		proposalId,
		proposalDigest,
		authorizationEventId,
		initialCommit,
		fixedCommit,
		receiptsService,
		observationsService,
		attemptsStore,
		attemptsService,
		workspace,
	};
}

/** Build a hermetic v2 staged-changeset protected run with matching agent.log and reconstructable candidate. */
function buildStagedProtectedRun(
	options: {
		description?: string;
		tamperStagedBytes?: boolean;
		tamperRecord?: boolean;
		unconfirmedTermination?: boolean;
		evalFailed?: boolean;
	} = {},
): { dir: string; pin: string; candidateSha256: string | null } {
	const dir = freshDir("endo-bridge-protected-v2-");
	const workspace = {
		"calc.mjs": "const [a, b] = process.argv.slice(2).map(Number);\nconsole.log(a - b);\n",
	};
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
		id: "endo.experiment.bridge-staged-v2",
		description: options.description ?? "Fix calc.mjs so it adds the two arguments instead of subtracting",
		seed: 1234,
		trials: 1,
		limits: {
			agentTimeoutMs: 60_000,
			evaluationTimeoutMs: 10_000,
			outputBytes: 65_536,
			tmpfsBytes: 64 * 1024 * 1024,
			maxFileBytes: 65_536,
			maxTotalBytes: 262_144,
		},
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "calc-fix",
				workspace,
				submission: { mode: "staged-changeset", limits },
				evaluator: { file: "/hidden/evaluator.json", sha256: H("6") },
			},
		],
		conditions: [
			{
				id: "pi-staged",
				description: "Staged candidate fixture",
				agent: { directory: "/hidden/agent", argv: ["/usr/bin/node", "/agent/run.mjs"] },
			},
		],
	};
	const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as unknown as Record<string, unknown>));
	const isolation = {
		mechanism: "bubblewrap" as const,
		version: "0.13.1",
		executableSha256: H("2"),
		containment: {
			mechanism: "systemd-user-scope" as const,
			version: "262",
			systemdRunSha256: H("9"),
			tasksMax: 512,
		},
	};
	const run: EndoProtectedRunV2 = {
		schemaVersion: "endo.protected-run.v2",
		runner: "endo-protected-runner.2",
		spec,
		specSha256,
		seed: 1234,
		seedSource: "spec",
		ordering: "blocked-randomization-v0",
		plan: [{ position: 0, task: "calc-fix", condition: "pi-staged", trial: 0 }],
		isolation,
		profiles: [{ condition: "pi-staged", sha256: H("3") }],
		evaluators: [
			{
				task: "calc-fix",
				definitionSha256: H("6"),
				driverSha256: H("7"),
				reference: "passed",
				negative: "failed",
			},
		],
		createdAt: "2026-11-23T05:00:00.000Z",
	};
	writeFileSync(join(dir, "protected-run.json"), canonicalEndoJsonV0(run as unknown as Record<string, unknown>));

	const attemptDir = join(dir, "trials", "calc-fix", "pi-staged", "0", "attempt-1");
	const baselineDir = join(attemptDir, "baseline");
	const workDir = join(attemptDir, "work");
	const changesetDir = join(attemptDir, "changeset");
	mkdirSync(baselineDir, { recursive: true });
	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(baselineDir, "calc.mjs"), workspace["calc.mjs"]);
	writeFileSync(join(workDir, "calc.mjs"), "const [a, b] = process.argv.slice(2).map(Number);\nconsole.log(a + b);\n");
	const agentLog = "done\n";
	writeFileSync(join(attemptDir, "agent.log"), agentLog);
	const agentLogSha = sha256HexV0(agentLog);

	const pin = endoProtectedStagedBaselineV2(workspace);
	let changesetField: EndoProtectedTrialV2["changeset"];
	let candidateSha256: string | null = null;
	let evalField: EndoProtectedTrialV2["evaluation"];
	let invalidating: EndoProtectedTrialV2["invalidating"] = [];

	if (options.unconfirmedTermination) {
		invalidating = ["termination-unconfirmed"];
		changesetField = {
			baseline: { status: "pinned", sha256: pin.sha256, files: pin.files.length, totalBytes: pin.totalBytes },
			collection: {
				status: "not-collected",
				changesetSha256: null,
				summary: null,
				...endoProtectedChangeSetRefusalsV2([]),
			},
			verification: { status: "not-run", reason: null, candidateSha256: null },
		};
		evalField = {
			status: "not-run",
			definitionSha256: H("6"),
			driverSha256: H("7"),
			cases: null,
			reason: null,
			outputSha256: null,
		};
	} else {
		const collected = collectStagedChangeSetV0(pin, workDir, changesetDir, limits);
		if (collected.status !== "collected" || collected.manifest === null)
			throw new Error(`collection failed: ${JSON.stringify(collected.refusals)}`);
		candidateSha256 = endoStagedCandidateRecordV0(collected.manifest, pin).sha256;
		changesetField = {
			baseline: { status: "pinned", sha256: pin.sha256, files: pin.files.length, totalBytes: pin.totalBytes },
			collection: {
				status: "collected",
				changesetSha256: collected.manifest.changesetSha256,
				summary: collected.manifest.summary,
				...endoProtectedChangeSetRefusalsV2([]),
			},
			verification: { status: "verified", reason: null, candidateSha256 },
		};
		evalField = {
			status: options.evalFailed ? "failed" : "passed",
			definitionSha256: H("6"),
			driverSha256: H("7"),
			cases: options.evalFailed ? { total: 5, passed: 2 } : { total: 5, passed: 5 },
			reason: null,
			outputSha256: H("8"),
		};
	}

	const rec: Omit<EndoProtectedTrialV2, "recordSha256"> = {
		schemaVersion: "endo.protected-trial.v2",
		run: { id: spec.id, specSha256, seed: run.seed },
		trial: { position: 0, task: "calc-fix", condition: "pi-staged", trial: 0, attempt: 1, retryOf: null },
		isolation: {
			...isolation,
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
			status: options.unconfirmedTermination ? "timed-out" : "completed",
			exitCode: options.unconfirmedTermination ? null : 0,
			signal: options.unconfirmedTermination ? "SIGKILL" : null,
			durationMs: 420,
			termination: options.unconfirmedTermination ? "unconfirmed" : "confirmed",
			outputSha256: agentLogSha,
			scope: {
				unit: `endo-sandbox-${"a".repeat(24)}`,
				established: true,
				ended: options.unconfirmedTermination ? "unconfirmed" : "confirmed",
			},
		},
		changeset: changesetField,
		evaluation: evalField,
		controller: { finalized: "normally" },
		invalidating,
		recordedAt: "2026-11-23T05:01:00.000Z",
	};
	const sealed = sealEndoProtectedTrialV0(rec);
	const recordPath = join(attemptDir, "record.json");
	writeFileSync(recordPath, canonicalEndoJsonV0(sealed as unknown as Record<string, unknown>));

	if (options.tamperStagedBytes) {
		const stagedFile = join(changesetDir, "files", "calc.mjs");
		chmodSync(stagedFile, 0o644);
		writeFileSync(stagedFile, "console.log('tampered');\n");
		chmodSync(stagedFile, 0o444);
	}
	if (options.tamperRecord) {
		const raw = JSON.parse(readFileSync(recordPath, "utf8"));
		raw.evaluation.cases = { total: 5, passed: 1 };
		writeFileSync(recordPath, JSON.stringify(raw));
	}

	return { dir, pin: specSha256, candidateSha256 };
}

/** Copy a disposable PR #159 fixed-path evidence directory (`reference` or `unchanged`). */
function copyPr159Fixture(mode: "reference" | "unchanged"): { dir: string; pin: string; attemptDir: string } {
	const dir = freshDir(`endo-bridge-pr159-${mode}-`);
	const source = fileURLToPath(new URL(`../research/develop-acceptance-001/evidence/${mode}/`, import.meta.url));
	const attemptDir = join(dir, "trials", "strict-positive", mode, "0", "attempt-1");
	mkdirSync(join(attemptDir, "submission"), { recursive: true });
	copyFileSync(join(source, "protected-run.json"), join(dir, "protected-run.json"));
	copyFileSync(join(source, "record.json"), join(attemptDir, "record.json"));
	writeFileSync(join(attemptDir, "submission", "count.mjs"), readFileSync(join(source, "count.mjs")));
	writeFileSync(join(attemptDir, "agent.log"), mode === "unchanged" ? "PASS\n" : "");
	const pin = (JSON.parse(readFileSync(join(dir, "protected-run.json"), "utf8")) as { specSha256: string }).specSha256;
	return { dir, pin, attemptDir };
}

/** Recursive directory manifest (relative path -> type, size, sha256) to prove zero writes / zero mutations. */
function treeManifest(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (current: string, prefix: string): void => {
		for (const name of readdirSync(current).sort()) {
			const rel = prefix === "" ? name : `${prefix}/${name}`;
			const full = join(current, name);
			const st = lstatSync(full);
			if (st.isSymbolicLink()) {
				out[rel] = "symlink";
			} else if (st.isDirectory()) {
				out[rel] = "dir";
				visit(full, rel);
			} else if (st.isFile()) {
				const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
				out[rel] = `file:${st.size}:${hash}`;
			} else {
				out[rel] = "other";
			}
		}
	};
	visit(dir, "");
	return out;
}

describe("DEVELOP-EVIDENCE-BRIDGE-001", () => {
	it("positive case: links task, prepared attempt, authorization, dispatch, run, bound provenance and clean-HEAD receipt", async () => {
		const fx = await buildPositiveFixture();
		const res = await readDevelopEvidenceBridgeV0({ root: fx.root, attemptId: fx.attemptId, cwd: fx.repo });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const b = res.bridge;

		expect(b.schemaVersion).toBe(ENDO_DEVELOP_EVIDENCE_BRIDGE_SCHEMA_V0);
		expect(b.trustBoundary.workstationH0).toBe("blocked");
		expect(b.trustBoundary.protectedExperimentAuthority).toBe("experimental-non-authoritative");
		expect(b.task.taskId).toBe(fx.taskId);
		expect(b.task.status).toBe("review");
		expect(b.attempt.id).toBe(fx.attemptId);
		expect(b.execution.authorization.source).toBe("controller-observed");
		expect(b.execution.authorization.briefDigestState).toBe("matches");
		expect(b.execution.dispatch.source).toBe("controller-observed");
		expect(b.execution.dispatch.send).toBe("runtime-accepted");
		expect(b.execution.piReport.run).toBe("completed");
		expect(b.execution.piReport.runSource).toBe("pi-reported");

		expect(b.candidate.workingTree.source).toBe("controller-observed");
		expect(b.candidate.workingTree.basis).toBe("send-and-run");
		expect(b.candidate.workingTree.establishesReconstructableBytes).toBe(false);
		expect(b.candidate.workingTree.establishesAuthorship).toBe(false);
		expect(b.candidate.workingTree.checkedCommits).toHaveLength(1);
		expect(b.candidate.workingTree.checkedCommits[0]?.commit).toBe(fx.fixedCommit);
		expect(b.candidate.workingTree.checkedCommits[0]?.comparison.relation).toBe("same");
		expect(b.candidate.reconstructable.supplied).toBe(false);
		expect(b.candidate.reconstructable.missingRecord).toBe("develop-attempt-protected-candidate-binding");

		expect(b.verification.ordinaryReceipts.authority).toBe("operator-triggered-host-check");
		expect(b.verification.ordinaryReceipts.currentHead).toEqual({ commit: fx.fixedCommit, clean: true });
		expect(b.verification.ordinaryReceipts.planLedger?.checks[0]?.state).toBe("passed");
		expect(b.verification.protectedExperiment.supplied).toBe(false);

		expect(b.review.kind).toBe("advisory-suggestion-not-authority");
		expect(b.review.decisionAuthority).toBe("operator-only");
		expect(b.review.suggestedOutcome).toBe("ready-for-operator-review");
		expect(b.review.operatorDecision.accepted).toBe(false);

		const byId = Object.fromEntries(b.transitions.map((t) => [t.id, t]));
		expect(byId["task-to-attempt"]?.status).toBe("established");
		expect(byId["attempt-to-authorization"]?.status).toBe("established");
		expect(byId["authorization-to-dispatch"]?.status).toBe("established");
		expect(byId["dispatch-to-run"]?.basis).toBe("window-attributed");
		expect(byId["run-to-working-tree-state"]?.status).toBe("established");
		expect(byId["attempt-to-reconstructable-candidate"]?.status).toBe("unestablished");
		expect(byId["candidate-to-verification"]?.status).toBe("established");

		const rendered = renderEndoDevelopEvidenceBridgeV0(b);
		expect(rendered).toContain("workstation H0=blocked");
		expect(rendered).toContain("ready-for-operator-review");
		expect(rendered).toContain("advisory only");
		expect(rendered).toContain("not an authoritative protected PASS");
	});

	it("negative 1: detects changed candidate bytes in staged changeset, fixed-path submission, and working tree", async () => {
		const fx = await buildPositiveFixture();

		// 1a. Staged-changeset v2 bytes tampered on disk
		const tamperedStaged = buildStagedProtectedRun({ tamperStagedBytes: true });
		const rStaged = await readDevelopEvidenceBridgeV0({
			root: fx.root,
			attemptId: fx.attemptId,
			cwd: fx.repo,
			protectedRunDir: tamperedStaged.dir,
			specPin: tamperedStaged.pin,
		});
		expect(rStaged.ok).toBe(true);
		if (!rStaged.ok) return;
		expect(rStaged.bridge.candidate.reconstructable.integrity).toBe("tampered");
		expect(rStaged.bridge.findings.map((f) => f.code)).toContain("protected-candidate-bytes-changed");
		expect(rStaged.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 1b. Fixed-path PR #159 submission bytes tampered on disk
		const pr159 = copyPr159Fixture("reference");
		writeFileSync(join(pr159.attemptDir, "submission", "count.mjs"), "tampered bytes\n");
		const rFixed = await readDevelopEvidenceBridgeV0({
			root: fx.root,
			attemptId: fx.attemptId,
			cwd: fx.repo,
			protectedRunDir: pr159.dir,
			specPin: pr159.pin,
		});
		expect(rFixed.ok).toBe(true);
		if (!rFixed.ok) return;
		expect(rFixed.bridge.candidate.reconstructable.integrity).toBe("tampered");
		expect(rFixed.bridge.findings.map((f) => f.code)).toContain("protected-candidate-bytes-changed");
		expect(rFixed.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 1c. DEVELOP working tree bytes modified after after-run & receipt
		writeFileSync(join(fx.repo, "calc.mjs"), "console.log(999);\n");
		const rTree = await readDevelopEvidenceBridgeV0({ root: fx.root, attemptId: fx.attemptId, cwd: fx.repo });
		expect(rTree.ok).toBe(true);
		if (!rTree.ok) return;
		expect(rTree.bridge.findings.map((f) => f.code)).toEqual(
			expect.arrayContaining(["working-tree-changed-since-observation", "current-tree-changed"]),
		);
		expect(rTree.bridge.review.suggestedOutcome).toBe("recheck-required-stale-evidence");
	});

	it("negative 2: rejects missing or mismatched identity/pin (spec pin, briefSha256, proposalDigest)", async () => {
		const fx = await buildPositiveFixture();
		const staged = buildStagedProtectedRun();

		// 2a. Missing --spec-pin
		const rMissingPin = await readDevelopEvidenceBridgeV0({
			root: fx.root,
			attemptId: fx.attemptId,
			cwd: fx.repo,
			protectedRunDir: staged.dir,
		});
		expect(rMissingPin.ok).toBe(true);
		if (!rMissingPin.ok) return;
		expect(rMissingPin.bridge.verification.protectedExperiment.pinStatus).toBe("missing");
		expect(rMissingPin.bridge.findings.map((f) => f.code)).toContain("protected-spec-pin-missing");
		expect(rMissingPin.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 2b. Mismatched --spec-pin
		const rWrongPin = await readDevelopEvidenceBridgeV0({
			root: fx.root,
			attemptId: fx.attemptId,
			cwd: fx.repo,
			protectedRunDir: staged.dir,
			specPin: H("f"),
		});
		expect(rWrongPin.ok).toBe(true);
		if (!rWrongPin.ok) return;
		expect(rWrongPin.bridge.verification.protectedExperiment.pinStatus).toBe("mismatched");
		expect(rWrongPin.bridge.findings.map((f) => f.code)).toContain("protected-spec-pin-mismatch");
		expect(rWrongPin.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 2c. Mismatched briefSha256 (prepared record edited after authorization)
		const authFile = join(fx.root, "develop", "attempts", `${fx.attemptId}.authorized.json`);
		const authJson = JSON.parse(readFileSync(authFile, "utf8")) as EndoDevelopAttemptAuthorizationV0;
		chmodSync(authFile, 0o600);
		writeFileSync(authFile, JSON.stringify({ ...authJson, briefSha256: H("d") }));
		const rBrief = await readDevelopEvidenceBridgeV0({ root: fx.root, attemptId: fx.attemptId, cwd: fx.repo });
		expect(rBrief.ok).toBe(true);
		if (!rBrief.ok) return;
		expect(rBrief.bridge.execution.authorization.briefDigestState).toBe("differs");
		expect(rBrief.bridge.findings.map((f) => f.code)).toContain("brief-changed-since-authorization");
		expect(rBrief.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 2d. Mismatched proposalDigest -> not-attributable contradiction
		writeFileSync(authFile, JSON.stringify({ ...authJson, proposalDigest: H("e") }));
		const rDigest = await readDevelopEvidenceBridgeV0({ root: fx.root, attemptId: fx.attemptId, cwd: fx.repo });
		expect(rDigest.ok).toBe(true);
		if (!rDigest.ok) return;
		expect(rDigest.bridge.execution.dispatch.send).toBe("not-attributable");
		expect(rDigest.bridge.findings.map((f) => f.code)).toContain("execution-record-contradiction");
		expect(rDigest.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");
	});

	it("negative 3: reports failed and inconclusive ordinary verification, and distinguishes protected-experiment failure", async () => {
		// 3a. Ordinary verification failed at HEAD
		const fxFail = await buildPositiveFixture({ withPassingCheck: false });
		writeFileSync(join(fxFail.repo, "calc.mjs"), "console.log(99);\nprocess.exit(1);\n");
		const afterFail = await fxFail.observationsService.take(fxFail.repo, { within: true });
		fxFail.observationsService.record(fxFail.attemptId, {
			point: "after-run",
			trigger: "run-settled",
			binding: { proposalId: fxFail.proposalId, authorizationEventId: fxFail.authorizationEventId },
			taken: afterFail,
		});
		git(fxFail.repo, ["add", "calc.mjs"]);
		git(fxFail.repo, ["commit", "-qm", "broken calc"]);
		const plannedFail = await fxFail.receiptsService.plan(fxFail.attemptId, {
			argv: ["node", "calc.mjs", "2", "3"],
			cwd: fxFail.repo,
			keepOutput: true,
		});
		expect(plannedFail.ok).toBe(true);
		if (plannedFail.ok)
			await fxFail.receiptsService.run(plannedFail.plan, { stdout: nullSink(), stderr: nullSink() });
		const rFail = await readDevelopEvidenceBridgeV0({
			root: fxFail.root,
			attemptId: fxFail.attemptId,
			cwd: fxFail.repo,
		});
		expect(rFail.ok).toBe(true);
		if (!rFail.ok) return;
		expect(rFail.bridge.verification.ordinaryReceipts.planLedger?.checks[0]?.state).toBe("failed");
		expect(rFail.bridge.review.suggestedOutcome).toBe("do-not-accept-verification-failed");

		// 3b. Inconclusive ordinary verification (command dirties tree during check)
		const fxInc = await buildPositiveFixture({ withPlan: false, withPassingCheck: false });
		const plannedInc = await fxInc.receiptsService.plan(fxInc.attemptId, {
			argv: ["node", "-e", "require('node:fs').writeFileSync('dirty.tmp', 'x')"],
			cwd: fxInc.repo,
		});
		expect(plannedInc.ok).toBe(true);
		if (plannedInc.ok) {
			const ran = await fxInc.receiptsService.run(plannedInc.plan, { stdout: nullSink(), stderr: nullSink() });
			expect(ran.receipt.outcome).toBe("inconclusive");
		}
		rmSync(join(fxInc.repo, "dirty.tmp"));
		const rInc = await readDevelopEvidenceBridgeV0({
			root: fxInc.root,
			attemptId: fxInc.attemptId,
			cwd: fxInc.repo,
		});
		expect(rInc.ok).toBe(true);
		if (!rInc.ok) return;
		expect(rInc.bridge.verification.ordinaryReceipts.latest[0]?.outcome).toBe("inconclusive");
		expect(rInc.bridge.findings.map((f) => f.code)).toContain("check-not-passed-at-current-head");
		expect(rInc.bridge.review.suggestedOutcome).toBe("incomplete-evidence");

		// 3c. Protected-experiment evaluation failed (PR #159 unchanged 3/5) alongside passing DEVELOP receipts
		const fxOk = await buildPositiveFixture();
		const pr159Fail = copyPr159Fixture("unchanged");
		const rProtFail = await readDevelopEvidenceBridgeV0({
			root: fxOk.root,
			attemptId: fxOk.attemptId,
			cwd: fxOk.repo,
			protectedRunDir: pr159Fail.dir,
			specPin: pr159Fail.pin,
		});
		expect(rProtFail.ok).toBe(true);
		if (!rProtFail.ok) return;
		expect(rProtFail.bridge.verification.ordinaryReceipts.planLedger?.checks[0]?.state).toBe("passed");
		expect(rProtFail.bridge.verification.protectedExperiment.authority).toBe("experimental-non-authoritative");
		expect(rProtFail.bridge.verification.protectedExperiment.evaluation?.cases).toEqual({ total: 5, passed: 3 });
		expect(rProtFail.bridge.verification.protectedExperiment.outcome).toBe("failed");
		expect(rProtFail.bridge.findings.map((f) => f.code)).toContain("protected-evaluation-failed");
		expect(rProtFail.bridge.review.suggestedOutcome).toBe("do-not-accept-verification-failed");
	});

	it("negative 4: reports stale receipt when HEAD advances after a passing check", async () => {
		const fx = await buildPositiveFixture();
		writeFileSync(join(fx.repo, "notes.txt"), "later commit\n");
		git(fx.repo, ["add", "notes.txt"]);
		git(fx.repo, ["commit", "-qm", "later commit after check"]);
		const res = await readDevelopEvidenceBridgeV0({ root: fx.root, attemptId: fx.attemptId, cwd: fx.repo });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.bridge.verification.ordinaryReceipts.latest[0]?.relation).toBe("head-differs");
		expect(res.bridge.findings.map((f) => f.code)).toEqual(
			expect.arrayContaining(["stale-check", "no-check-at-current-head"]),
		);
		expect(res.bridge.review.suggestedOutcome).toBe("recheck-required-stale-evidence");
	});

	it("negative 5: reports interrupted or unconfirmed execution across DEVELOP and protected runs", async () => {
		// 5a. DEVELOP run interrupted (controller-observed)
		const fxInt = await buildPositiveFixture({ runEndKind: "lifecycle.interrupted" });
		const rInt = await readDevelopEvidenceBridgeV0({
			root: fxInt.root,
			attemptId: fxInt.attemptId,
			cwd: fxInt.repo,
		});
		expect(rInt.ok).toBe(true);
		if (!rInt.ok) return;
		expect(rInt.bridge.execution.piReport.run).toBe("interrupted");
		expect(rInt.bridge.execution.piReport.runSource).toBe("controller-observed");
		expect(rInt.bridge.findings.map((f) => f.code)).toContain("run-interrupted-or-unconfirmed");
		expect(rInt.bridge.review.suggestedOutcome).toBe("incomplete-evidence");

		// 5b. DEVELOP send unconfirmed (sent-no-reply)
		const fxNoReply = await buildPositiveFixture({ runEndKind: "no-reply" });
		const rNoReply = await readDevelopEvidenceBridgeV0({
			root: fxNoReply.root,
			attemptId: fxNoReply.attemptId,
			cwd: fxNoReply.repo,
		});
		expect(rNoReply.ok).toBe(true);
		if (!rNoReply.ok) return;
		expect(rNoReply.bridge.execution.dispatch.send).toBe("sent-no-reply");
		expect(rNoReply.bridge.findings.map((f) => f.code)).toEqual(
			expect.arrayContaining(["send-not-confirmed", "run-interrupted-or-unconfirmed"]),
		);
		expect(rNoReply.bridge.review.suggestedOutcome).toBe("incomplete-evidence");

		// 5c. DEVELOP workbench-closing observation (run end not observed)
		const fxClosing = await buildPositiveFixture({ afterRunTrigger: "workbench-closing" });
		const rClosing = await readDevelopEvidenceBridgeV0({
			root: fxClosing.root,
			attemptId: fxClosing.attemptId,
			cwd: fxClosing.repo,
		});
		expect(rClosing.ok).toBe(true);
		if (!rClosing.ok) return;
		expect(rClosing.bridge.findings.map((f) => f.code)).toContain("provenance-run-end-not-observed");
		expect(rClosing.bridge.review.suggestedOutcome).toBe("incomplete-evidence");

		// 5d. Protected experiment with unconfirmed termination
		const fxOk = await buildPositiveFixture();
		const unconfirmed = buildStagedProtectedRun({ unconfirmedTermination: true });
		const rUnconf = await readDevelopEvidenceBridgeV0({
			root: fxOk.root,
			attemptId: fxOk.attemptId,
			cwd: fxOk.repo,
			protectedRunDir: unconfirmed.dir,
			specPin: unconfirmed.pin,
		});
		expect(rUnconf.ok).toBe(true);
		if (!rUnconf.ok) return;
		expect(rUnconf.bridge.verification.protectedExperiment.agent?.termination).toBe("unconfirmed");
		expect(rUnconf.bridge.findings.map((f) => f.code)).toContain("protected-execution-unconfirmed-or-interrupted");
		expect(rUnconf.bridge.review.suggestedOutcome).toBe("incomplete-evidence");
	});

	it("negative 6: refuses to fabricate attempt association for an unlinked candidate (no heuristic matching)", async () => {
		const fx = await buildPositiveFixture();
		// Same objective text, same filename (calc.mjs), valid staged candidate, valid spec pin, 5/5 offline pass —
		// yet NO stored record binds this protected run to fx.attemptId.
		const staged = buildStagedProtectedRun({
			description: "Fix calc.mjs so it adds the two arguments instead of subtracting",
		});
		const res = await readDevelopEvidenceBridgeV0({
			root: fx.root,
			attemptId: fx.attemptId,
			cwd: fx.repo,
			protectedRunDir: staged.dir,
			specPin: staged.pin,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const b = res.bridge;
		expect(b.candidate.reconstructable.integrity).toBe("verified");
		expect(b.candidate.reconstructable.candidateSha256).toBe(staged.candidateSha256);
		expect(b.candidate.reconstructable.attemptAssociation).toBe("unestablished");
		expect(b.candidate.reconstructable.missingRecord).toBe("develop-attempt-protected-candidate-binding");
		expect(b.verification.protectedExperiment.authority).toBe("experimental-non-authoritative");
		expect(b.verification.protectedExperiment.attemptAssociation).toBe("unestablished");
		expect(b.findings.map((f) => f.code)).toContain("protected-attempt-association-unestablished");
		const candidateTransition = b.transitions.find((t) => t.id === "attempt-to-reconstructable-candidate");
		expect(candidateTransition?.status).toBe("unestablished");
		expect(candidateTransition?.missingRecord).toBe("develop-attempt-protected-candidate-binding");
		expect(b.review.suggestedOutcome).toBe("incomplete-evidence");

		// Also: DEVELOP attempt without controller-bound observations reports provenance-missing rather than guessing
		const fxNoObs = await buildPositiveFixture({ withBoundObservations: false });
		const rNoObs = await readDevelopEvidenceBridgeV0({
			root: fxNoObs.root,
			attemptId: fxNoObs.attemptId,
			cwd: fxNoObs.repo,
		});
		expect(rNoObs.ok).toBe(true);
		if (!rNoObs.ok) return;
		expect(rNoObs.bridge.findings.map((f) => f.code)).toContain("provenance-missing");
		expect(rNoObs.bridge.review.suggestedOutcome).toBe("incomplete-evidence");
	});

	it("negative 7: detects contradictory records across authorization, observations, checked commit, protected seal, and task status", async () => {
		// 7a. Damaged authorization record
		const fxDamaged = await buildPositiveFixture();
		const authFile = join(fxDamaged.root, "develop", "attempts", `${fxDamaged.attemptId}.authorized.json`);
		chmodSync(authFile, 0o600);
		writeFileSync(authFile, "{broken json");
		const rDamaged = await readDevelopEvidenceBridgeV0({
			root: fxDamaged.root,
			attemptId: fxDamaged.attemptId,
			cwd: fxDamaged.repo,
		});
		expect(rDamaged.ok).toBe(true);
		if (!rDamaged.ok) return;
		expect(rDamaged.bridge.execution.authorization.recordState).toBe("damaged");
		expect(rDamaged.bridge.findings.map((f) => f.code)).toContain("authorization-record-damaged");
		expect(rDamaged.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 7b. Checked commit differs in content from bound after-run observation
		const fxDiff = await buildPositiveFixture({ withPassingCheck: false });
		writeFileSync(join(fxDiff.repo, "extra.txt"), "edited after run-end observation\n");
		git(fxDiff.repo, ["add", "extra.txt"]);
		git(fxDiff.repo, ["commit", "-qm", "commit diverging from run-end"]);
		const planned = await fxDiff.receiptsService.plan(fxDiff.attemptId, {
			argv: ["node", "calc.mjs", "2", "3"],
			cwd: fxDiff.repo,
			keepOutput: true,
		});
		expect(planned.ok).toBe(true);
		if (planned.ok) await fxDiff.receiptsService.run(planned.plan, { stdout: nullSink(), stderr: nullSink() });
		const rDiff = await readDevelopEvidenceBridgeV0({
			root: fxDiff.root,
			attemptId: fxDiff.attemptId,
			cwd: fxDiff.repo,
		});
		expect(rDiff.ok).toBe(true);
		if (!rDiff.ok) return;
		expect(rDiff.bridge.findings.map((f) => f.code)).toContain("checked-commit-differs-from-observed-run-end");
		expect(rDiff.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 7c. Protected trial record tampered (seal broken)
		const fxOk = await buildPositiveFixture();
		const tamperedRec = buildStagedProtectedRun({ tamperRecord: true });
		const rTamperedRec = await readDevelopEvidenceBridgeV0({
			root: fxOk.root,
			attemptId: fxOk.attemptId,
			cwd: fxOk.repo,
			protectedRunDir: tamperedRec.dir,
			specPin: tamperedRec.pin,
		});
		expect(rTamperedRec.ok).toBe(true);
		if (!rTamperedRec.ok) return;
		expect(rTamperedRec.bridge.findings.map((f) => f.code)).toContain("protected-record-refused");
		expect(rTamperedRec.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");

		// 7d. Task marked done despite missing verification: reported honestly without altering task status
		const fxDoneUnchecked = await buildPositiveFixture({ withPassingCheck: false, taskStatus: "done" });
		const rDone = await readDevelopEvidenceBridgeV0({
			root: fxDoneUnchecked.root,
			attemptId: fxDoneUnchecked.attemptId,
			cwd: fxDoneUnchecked.repo,
		});
		expect(rDone.ok).toBe(true);
		if (!rDone.ok) return;
		expect(rDone.bridge.task.status).toBe("done");
		expect(rDone.bridge.findings.map((f) => f.code)).toContain("task-done-with-unverified-gaps");
	});

	it("negative 8: rejects agent-reported PASS unsupported by independent verification", async () => {
		const fx = await buildPositiveFixture({ withPassingCheck: false });
		const reported = fx.attemptsService.report(
			fx.attemptId,
			"Agent reported: PASS — all tests pass and task is complete",
		);
		expect(reported.ok).toBe(true);

		const res = await readDevelopEvidenceBridgeV0({ root: fx.root, attemptId: fx.attemptId, cwd: fx.repo });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const b = res.bridge;
		expect(b.execution.piReport.run).toBe("completed");
		expect(b.execution.piReport.runSource).toBe("pi-reported");
		expect(b.attempt.outcome?.kind).toBe("reported");
		expect(b.verification.ordinaryReceipts.receiptCount).toBe(0);
		expect(b.findings.map((f) => f.code)).toContain("agent-report-unsupported-by-independent-evidence");
		expect(b.review.suggestedOutcome).toBe("unverified-agent-report-only");
	});

	it("read-only side-effect invariant: CLI bridge writes zero files, mutates no status, applies no bytes, and spawns no agent/evaluator", async () => {
		const fx = await buildPositiveFixture();
		const staged = buildStagedProtectedRun();

		// Put trap binaries first on PATH to prove nothing launches an agent or sandbox/evaluator
		const trapBin = freshDir("endo-bridge-trap-bin-");
		const sentinel = join(trapBin, "INVOKED");
		for (const cmd of ["pi", "omp", "claude", "codex", "bwrap", "systemd-run"]) {
			const script = join(trapBin, cmd);
			writeFileSync(script, `#!/bin/sh\necho "${cmd}" >> ${JSON.stringify(sentinel)}\nexit 99\n`, { mode: 0o755 });
		}

		const beforeStore = treeManifest(fx.root);
		const beforeRepo = treeManifest(fx.repo);
		const beforeProtected = treeManifest(staged.dir);

		// 1. CLI bridge without protected run
		const run1 = spawnSync(
			process.execPath,
			[CLI, "attempt", "bridge", "--root", fx.root, "--attempt", fx.attemptId, "--cwd", fx.repo],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${trapBin}:${process.env.PATH ?? ""}` },
			},
		);
		expect(run1.status).toBe(0);
		const parsed1 = JSON.parse(run1.stdout) as { bridge: EndoDevelopEvidenceBridgeV0 };
		expect(parsed1.bridge.review.suggestedOutcome).toBe("ready-for-operator-review");
		expect(run1.stderr).toContain("evidence-bridge");

		// 2. CLI bridge with staged protected run + pin
		const run2 = spawnSync(
			process.execPath,
			[
				CLI,
				"attempt",
				"bridge",
				"--root",
				fx.root,
				"--attempt",
				fx.attemptId,
				"--cwd",
				fx.repo,
				"--protected-run",
				staged.dir,
				"--spec-pin",
				staged.pin,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${trapBin}:${process.env.PATH ?? ""}` },
			},
		);
		expect(run2.status).toBe(0);
		const parsed2 = JSON.parse(run2.stdout) as { bridge: EndoDevelopEvidenceBridgeV0 };
		expect(parsed2.bridge.candidate.reconstructable.attemptAssociation).toBe("unestablished");
		expect(parsed2.bridge.candidate.reconstructable.integrity).toBe("verified");

		// Verify zero mutations across store, working repo, and protected run, and zero trap invocations.
		expect(existsSync(sentinel)).toBe(false);
		expect(treeManifest(fx.root)).toEqual(beforeStore);
		expect(treeManifest(fx.repo)).toEqual(beforeRepo);
		expect(treeManifest(staged.dir)).toEqual(beforeProtected);
		expect(dirname(fx.root)).not.toBe("");
	});
});
