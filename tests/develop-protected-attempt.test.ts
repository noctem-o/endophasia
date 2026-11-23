// DEVELOP-PROTECTED-ATTEMPT-001 (docs/designs/protected-attempt-execution.md): the terminal-authorised protected attempt launcher, the
// write-once launch record and candidate binding, and the evidence bridge's reading of them.
//
// Deterministic first: most tests run the launcher with a FAKE runner that writes a hermetic, correctly sealed protected run (the same shape
// tests/develop-evidence-bridge.test.ts builds), so every digest comparison is exercised without a sandbox. The last block runs the REAL
// protected runner (bubblewrap + systemd user scope, offline v2, a deterministic node agent) and is skipped, and says so, where the host
// cannot isolate.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readDevelopEvidenceBridgeV0 } from "../adapters/develop/evidence-bridge.ts";
import {
	endoBoundedTreeDigestV0,
	launchProtectedAttemptV0,
	planProtectedAttemptV0,
	readProtectedAttemptV0,
} from "../adapters/develop/protected-attempt.ts";
import { detectBubblewrapV0, endoTreeDigestV0 } from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0 } from "../adapters/sandbox/containment.ts";
import { endoProtectedStagedBaselineV2 } from "../adapters/sandbox/protected-report.ts";
import { collectStagedChangeSetV0, endoStagedCandidateRecordV0 } from "../adapters/sandbox/staged-changeset.ts";
import { runProtectedExperimentV0 } from "../cli/experiment-protected.ts";
import {
	ENDO_ATTEMPT_BINDING_STANDING_V0,
	type EndoDevelopAttemptCandidateBindingV0,
	validateEndoDevelopAttemptCandidateBindingV0,
} from "../protocol/develop-attempt-candidate-binding.ts";
import { renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import type {
	EndoProtectedRunV2,
	EndoProtectedSpec,
	EndoProtectedSpecV2,
	EndoProtectedTrialV2,
} from "../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import {
	endoAttemptCandidateBindingSealOkV0,
	endoProtectedAttemptApprovalPhraseV0,
	endoProtectedAttemptAuthorityV0,
	sealEndoAttemptCandidateBindingV0,
} from "../runtime/contracts/develop-attempt-candidate-binding.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { renderEndoDevelopEvidenceBridgeV0 } from "../runtime/contracts/develop-evidence-bridge.ts";
import {
	endoProtectedChangeSetRefusalsV2,
	sealEndoProtectedTrialV0,
} from "../runtime/contracts/protected-experiment.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const ADAPTER = fileURLToPath(new URL("../adapters/develop/protected-attempt.ts", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../research/protected-eval/example/", import.meta.url));
const H = (c: string) => c.repeat(64);
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-protected-attempt-")));
function chmodWritable(path: string): void {
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink()) return;
		if (st.isDirectory()) {
			chmodSync(path, 0o700);
			for (const name of readdirSync(path)) chmodWritable(join(path, name));
		} else if (st.isFile()) chmodSync(path, 0o600);
	} catch {
		// gone
	}
}
afterAll(() => {
	chmodWritable(base);
	rmSync(base, { recursive: true, force: true });
});
let made = 0;
const fresh = (name: string): string => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};

const BUGGY = "export function add(a, b) {\n\treturn a - b;\n}\n";
const FIXED = "export function add(a, b) {\n\treturn a + b;\n}\n";
const LIMITS = {
	maxFileBytes: 65_536,
	maxTotalStagedBytes: 262_144,
	maxWorkspaceBytes: 1_048_576,
	maxWalkedEntries: 128,
	maxChangedFiles: 16,
	maxDepth: 6,
};

/** A recursive manifest of a directory (type, size, digest, mode), to prove nothing is created or changed. */
function manifest(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (current: string, prefix: string) => {
		for (const name of readdirSync(current).sort()) {
			const rel = prefix === "" ? name : `${prefix}/${name}`;
			const full = join(current, name);
			const st = lstatSync(full);
			if (st.isSymbolicLink()) out[rel] = "symlink";
			else if (st.isDirectory()) {
				out[rel] = `dir:${(st.mode & 0o7777).toString(8)}`;
				visit(full, rel);
			} else if (st.isFile())
				out[rel] =
					"file:" +
					st.size +
					":" +
					(st.mode & 0o7777).toString(8) +
					":" +
					createHash("sha256").update(readFileSync(full)).digest("hex");
			else out[rel] = "other";
		}
	};
	if (existsSync(dir)) visit(dir, "");
	return out;
}

interface Fixture {
	root: string;
	project: string;
	attemptId: string;
	brief: string;
	template: string;
	agentTemplate: string;
	evaluator: string;
	work: string;
}

/** A store with one project, one task and one prepared attempt; a v2 template with one task, one condition, one trial. */
function fixture(options: { agentSource?: string; templateChange?: Partial<EndoProtectedSpecV2> } = {}): Fixture {
	const work = fresh("work");
	const root = join(work, "store");
	const project = join(work, "project");
	mkdirSync(project);
	const tasks = new DevelopTasksStoreV0(root);
	const p = tasks.registerProject({ name: "Calc", path: project, observedGitRoot: null });
	if (!p.ok) throw new Error(`registerProject ${p.code}`);
	const t = tasks.createTask(p.value.id, { title: "Fix add", description: "add adds", acceptance: "add(2, 3) is 5" });
	if (!t.ok) throw new Error(`createTask ${t.code}`);
	const attempts = new DevelopAttemptsServiceV0(tasks, new DevelopAttemptsStoreV0(root));
	const prepared = attempts.prepare(p.value.id, t.value.id, { objective: "Make add(a, b) return a + b in calc.mjs" });
	if (!prepared.ok) throw new Error(`prepare ${prepared.code}`);
	const agentTemplate = join(work, "agent-template");
	mkdirSync(agentTemplate);
	writeFileSync(
		join(agentTemplate, "agent.mjs"),
		options.agentSource ??
			'import fs from "node:fs";\nconst brief = fs.readFileSync("/agent/prompt.txt", "utf8");\nif (!brief.includes("a + b")) process.exit(3);\nfs.writeFileSync("calc.mjs", ' +
				JSON.stringify(FIXED) +
				");\n",
	);
	writeFileSync(join(agentTemplate, "prompt.txt"), "template placeholder prompt\n");
	const evaluatorDir = join(work, "evaluator");
	mkdirSync(join(evaluatorDir, "reference"), { recursive: true });
	mkdirSync(join(evaluatorDir, "negative"), { recursive: true });
	writeFileSync(join(evaluatorDir, "reference", "calc.mjs"), FIXED);
	writeFileSync(join(evaluatorDir, "negative", "calc.mjs"), BUGGY);
	const evaluator = join(evaluatorDir, "evaluator.json");
	writeFileSync(
		evaluator,
		JSON.stringify({
			schemaVersion: "endo.function-evaluator.v0",
			entry: "calc.mjs",
			export: "add",
			cases: [
				{ name: "small", input: [2, 3], expected: 5 },
				{ name: "negative", input: [-4, 1], expected: -3 },
				{ name: "zero", input: [0, 0], expected: 0 },
			],
			reference: "reference",
			negative: "negative",
		}),
	);
	const spec: EndoProtectedSpecV2 = {
		schemaVersion: "endo.protected-experiment-spec.v2",
		id: "endo.experiment.template",
		description: "template",
		seed: 1234,
		trials: 1,
		limits: {
			agentTimeoutMs: 30_000,
			evaluationTimeoutMs: 30_000,
			outputBytes: 65_536,
			tmpfsBytes: 16 * 1024 * 1024,
			maxFileBytes: 65_536,
			maxTotalBytes: 262_144,
		},
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "calc-fix",
				workspace: { "calc.mjs": BUGGY, "README.md": "Fix add.\n" },
				submission: { mode: "staged-changeset", limits: LIMITS },
				evaluator: { file: evaluator, sha256: createHash("sha256").update(readFileSync(evaluator)).digest("hex") },
			},
		],
		conditions: [
			{
				id: "fixture",
				description: "deterministic node agent that reads /agent/prompt.txt",
				agent: { directory: agentTemplate, argv: ["/usr/bin/node", "/agent/agent.mjs"] },
			},
		],
		...options.templateChange,
	};
	const template = join(work, "template.json");
	writeFileSync(template, JSON.stringify(spec));
	const brief = renderEndoDevelopBriefV0(
		(new DevelopAttemptsStoreV0(root).read() as unknown as { entries: { attempt: never }[] }).entries[0]!.attempt,
	);
	return { root, project, attemptId: prepared.value.id, brief, template, agentTemplate, evaluator, work };
}

interface FakeRun {
	refuse?: boolean;
	interruptBeforeRecord?: boolean;
	unconfirmedTermination?: boolean;
	evalFailed?: boolean;
	workContent?: string;
	/** Mount a different /agent tree than the one the launcher built (as if another prompt was mounted). */
	promptOverride?: string;
}

/** Writes a hermetic, correctly sealed staged protected run for the spec it is given, as the real runner lays it out. */
function fakeRunner(o: FakeRun = {}) {
	return async (given: EndoProtectedSpec, dir: string): Promise<void> => {
		if (o.refuse) throw new Error("isolation unavailable (test): refused before creating anything");
		const spec = given as EndoProtectedSpecV2;
		const task = spec.tasks[0]!;
		const condition = spec.conditions[0]!;
		mkdirSync(dir, { recursive: true });
		const specSha256 = sha256HexV0(canonicalEndoJsonV0(spec as never));
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
			seed: spec.seed ?? 1,
			seedSource: "spec",
			ordering: "blocked-randomization-v0",
			plan: [{ position: 0, task: task.id, condition: condition.id, trial: 0 }],
			isolation,
			profiles: [{ condition: condition.id, sha256: H("3") }],
			evaluators: [
				{
					task: task.id,
					definitionSha256: task.evaluator.sha256,
					driverSha256: H("7"),
					reference: "passed",
					negative: "failed",
				},
			],
			createdAt: "2026-11-23T05:00:00.000Z",
		};
		writeFileSync(join(dir, "protected-run.json"), canonicalEndoJsonV0(run as never));
		const copy = join(dir, ".agents", condition.id);
		mkdirSync(join(dir, ".agents"), { recursive: true });
		cpSync(condition.agent.directory, copy, { recursive: true });
		if (o.promptOverride !== undefined) writeFileSync(join(copy, "prompt.txt"), o.promptOverride);
		if (o.interruptBeforeRecord) throw new Error("controller killed (test) before the record was sealed");
		const attemptDir = join(dir, "trials", task.id, condition.id, "0", "attempt-1");
		const baselineDir = join(attemptDir, "baseline");
		const workDir = join(attemptDir, "work");
		mkdirSync(baselineDir, { recursive: true });
		mkdirSync(workDir, { recursive: true });
		for (const [path, text] of Object.entries(task.workspace)) {
			writeFileSync(join(baselineDir, path), text);
			writeFileSync(join(workDir, path), text);
		}
		writeFileSync(join(workDir, "calc.mjs"), o.workContent ?? FIXED);
		writeFileSync(join(attemptDir, "agent.log"), "done\n");
		const pin = endoProtectedStagedBaselineV2(task.workspace);
		let changeset: EndoProtectedTrialV2["changeset"];
		let evaluation: EndoProtectedTrialV2["evaluation"];
		if (o.unconfirmedTermination) {
			changeset = {
				baseline: { status: "pinned", sha256: pin.sha256, files: pin.files.length, totalBytes: pin.totalBytes },
				collection: {
					status: "not-collected",
					changesetSha256: null,
					summary: null,
					...endoProtectedChangeSetRefusalsV2([]),
				},
				verification: { status: "not-run", reason: null, candidateSha256: null },
			};
			evaluation = {
				status: "not-run",
				definitionSha256: task.evaluator.sha256,
				driverSha256: H("7"),
				cases: null,
				reason: null,
				outputSha256: null,
			};
		} else {
			const collected = collectStagedChangeSetV0(
				pin,
				workDir,
				join(attemptDir, "changeset"),
				task.submission.limits,
			);
			if (collected.status !== "collected" || collected.manifest === null) throw new Error("collection failed");
			const candidateSha256 = endoStagedCandidateRecordV0(collected.manifest, pin).sha256;
			changeset = {
				baseline: { status: "pinned", sha256: pin.sha256, files: pin.files.length, totalBytes: pin.totalBytes },
				collection: {
					status: "collected",
					changesetSha256: collected.manifest.changesetSha256,
					summary: collected.manifest.summary,
					...endoProtectedChangeSetRefusalsV2([]),
				},
				verification: { status: "verified", reason: null, candidateSha256 },
			};
			evaluation = {
				status: o.evalFailed ? "failed" : "passed",
				definitionSha256: task.evaluator.sha256,
				driverSha256: H("7"),
				cases: o.evalFailed ? { total: 3, passed: 1 } : { total: 3, passed: 3 },
				reason: null,
				outputSha256: H("8"),
			};
		}
		const record = sealEndoProtectedTrialV0<EndoProtectedTrialV2>({
			schemaVersion: "endo.protected-trial.v2",
			run: { id: spec.id, specSha256, seed: run.seed },
			trial: { position: 0, task: task.id, condition: condition.id, trial: 0, attempt: 1, retryOf: null },
			isolation: {
				...isolation,
				profileSha256: H("3"),
				requested: {
					namespaces: ["cgroup", "ipc", "mnt", "net", "pid", "user", "uts"],
					network: "none",
					rootReadOnly: true,
					userNamespacesDisabled: true,
					environment: ["HOME", "PATH", "TMPDIR"],
					mounts: [
						{ target: "/agent", kind: "ro-dir", role: "agent", sha256: null },
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
				status: o.unconfirmedTermination ? "timed-out" : "completed",
				exitCode: o.unconfirmedTermination ? null : 0,
				signal: o.unconfirmedTermination ? "SIGKILL" : null,
				durationMs: 420,
				termination: o.unconfirmedTermination ? "unconfirmed" : "confirmed",
				outputSha256: sha256HexV0("done\n"),
				scope: {
					unit: `endo-sandbox-${"a".repeat(24)}`,
					established: true,
					ended: o.unconfirmedTermination ? "unconfirmed" : "confirmed",
				},
			},
			changeset,
			evaluation,
			controller: { finalized: "normally" },
			invalidating: o.unconfirmedTermination ? ["termination-unconfirmed"] : [],
			recordedAt: "2026-11-23T05:01:00.000Z",
		} as never);
		writeFileSync(join(attemptDir, "record.json"), canonicalEndoJsonV0(record as never));
	};
}

const approveExactly = async (plan: { phrase: string }) => plan.phrase;

async function launched(
	f: Fixture,
	run: FakeRun = {},
	extra: Partial<Parameters<typeof launchProtectedAttemptV0>[0]> = {},
) {
	const out = join(f.work, "out");
	const result = await launchProtectedAttemptV0({
		root: f.root,
		attemptId: f.attemptId,
		templatePath: f.template,
		out,
		approve: approveExactly,
		runner: fakeRunner(run),
		...extra,
	});
	return { out, result };
}

const bindingPath = (f: Fixture) => join(f.root, "develop", "protected-attempts", `${f.attemptId}.candidate.json`);
const launchPath = (f: Fixture) => join(f.root, "develop", "protected-attempts", `${f.attemptId}.launch.json`);
const readBinding = (f: Fixture) =>
	JSON.parse(readFileSync(bindingPath(f), "utf8")) as EndoDevelopAttemptCandidateBindingV0;
/** Rewrite the binding as a same-uid writer could: change it, recompute its unkeyed seal, replace the file. */
function forgeBinding(f: Fixture, change: (b: Record<string, unknown>) => void): void {
	const { bindingSha256: _seal, ...rest } = readBinding(f) as unknown as Record<string, unknown> & {
		bindingSha256: string;
	};
	change(rest);
	const sealed = sealEndoAttemptCandidateBindingV0(rest as never);
	chmodSync(bindingPath(f), 0o600);
	writeFileSync(bindingPath(f), canonicalEndoJsonV0(sealed as never));
}
const reading = (f: Fixture, extra: { protectedRunDir?: string; specPin?: string; trial?: string } = {}) =>
	readProtectedAttemptV0({ root: f.root, attemptId: f.attemptId, ...extra });
const failed = (r: ReturnType<typeof reading>) =>
	(r?.binding.checks ?? []).filter((c) => c.result === "fail").map((c) => c.check);

describe("DEVELOP-PROTECTED-ATTEMPT-001: launcher and binding (deterministic, fake runner)", () => {
	it("binds a launched attempt to its reconstructed candidate, and the bridge reads it as controller-established", async () => {
		const f = fixture();
		const { out, result } = await launched(f);
		expect(result.status).toBe("bound");
		expect(result.association).toBe("established");
		expect(result.checks.every((c) => c.result === "pass")).toBe(true);
		const binding = validateEndoDevelopAttemptCandidateBindingV0(readBinding(f));
		expect(endoAttemptCandidateBindingSealOkV0(binding)).toBe(true);
		expect(binding.boundBy).toBe("controller");
		expect(binding.standing).toEqual(ENDO_ATTEMPT_BINDING_STANDING_V0.controller);
		expect(binding.briefSha256).toBe(sha256HexV0(f.brief));
		expect(binding.target.agent?.promptSha256).toBe(sha256HexV0(f.brief));
		expect(binding.target.runDirectory).toBe(join(out, "run"));
		expect(readFileSync(join(out, "agent", "prompt.txt"), "utf8")).toBe(f.brief);
		expect(readFileSync(join(out, "run", ".agents", "fixture", "prompt.txt"), "utf8")).toBe(f.brief);
		const spec = JSON.parse(readFileSync(join(out, "spec.json"), "utf8")) as EndoProtectedSpecV2;
		expect(spec.id).toBe(`endo.experiment.attempt-${f.attemptId.slice("endo.attempt.".length)}`);
		expect(binding.target.specSha256).toBe(sha256HexV0(canonicalEndoJsonV0(spec as never)));

		const res = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const pe = res.bridge.verification.protectedExperiment;
		expect(pe.attemptAssociation).toBe("established");
		expect(pe.missingBindingRecord).toBeNull();
		expect(pe.binding.standing).toBe("controller-established");
		expect(pe.authority).toBe("experimental-non-authoritative");
		expect(pe.workstationH0).toBe("blocked");
		expect(res.bridge.candidate.reconstructable.attemptAssociation).toBe("established");
		const t6 = res.bridge.transitions.find((t) => t.id === "attempt-to-reconstructable-candidate")!;
		expect([t6.status, t6.basis, t6.missingRecord]).toEqual(["established", "controller-observed", null]);
		const codes = res.bridge.findings.map((x) => x.code);
		expect(codes).toContain("protected-attempt-association-established");
		expect(codes).not.toContain("protected-attempt-association-unestablished");
		expect(res.bridge.review.suggestedOutcome).not.toBe("ready-for-operator-review");
		expect(res.bridge.review.operatorDecision.accepted).toBe(false);
		const text = renderEndoDevelopEvidenceBridgeV0(res.bridge);
		expect(text).toContain("[established; controller-established]");
		expect(text).not.toContain("NO stored binding");
		expect(text).toContain("bound to this DEVELOP attempt by an established binding record");
		expect(text).toContain("Controller-established");
		expect(text).toContain("not a signature");
		expect(text.match(/authoritative PASS/g)?.length).toBe(text.match(/never an authoritative PASS/g)?.length);
		expect(res.bridge.notEstablished[0]).toContain("not a signature");
		// The task is untouched and the candidate was applied nowhere.
		const tasks = new DevelopTasksStoreV0(f.root).read();
		expect(tasks.ok && tasks.file.tasks[0]?.status).toBe("open");
		expect(readdirSync(f.project)).toEqual([]);
	});

	it("the bounded tree digest is endoTreeDigestV0's, with the prompt override, and refuses links", () => {
		const dir = fresh("tree");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "a.mjs"), "a");
		writeFileSync(join(dir, "sub", "x.sh"), "#!/bin/sh\n");
		chmodSync(join(dir, "sub", "x.sh"), 0o755);
		const own = endoBoundedTreeDigestV0(dir);
		expect(own.ok && own.sha256).toBe(endoTreeDigestV0(dir));
		const brief = Buffer.from("brief\n");
		const virtual = endoBoundedTreeDigestV0(dir, { name: "prompt.txt", bytes: brief });
		writeFileSync(join(dir, "prompt.txt"), brief);
		chmodSync(join(dir, "prompt.txt"), 0o644);
		expect(virtual.ok && virtual.sha256).toBe(endoTreeDigestV0(dir));
		symlinkSync("/etc/hostname", join(dir, "link"));
		const linked = endoBoundedTreeDigestV0(dir);
		expect(linked.ok).toBe(false);
		const bounded = endoBoundedTreeDigestV0(join(dir, "sub"), undefined, {
			maxTemplateBytes: 1,
			maxRecordBytes: 1,
			maxAgentEntries: 0,
			maxAgentBytes: 1,
			maxAgentDepth: 1,
			maxPromptBytes: 1,
		});
		expect(bounded.ok).toBe(false);
	});

	it("declines without writing anything: no answer, a workbench phrase, another operation's phrase, the digest alone", async () => {
		const f = fixture();
		const before = manifest(f.work);
		const plan = planProtectedAttemptV0({
			root: f.root,
			attemptId: f.attemptId,
			templatePath: f.template,
			out: join(f.work, "out"),
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const answers = [
			null,
			`APPROVE ATTEMPT ${plan.plan.operationDigest.slice(0, 16)}`,
			endoProtectedAttemptApprovalPhraseV0(H("e")),
			plan.plan.operationDigest,
			`${plan.plan.phrase} please`,
		];
		let calls = 0;
		for (const typed of answers) {
			const { result } = await launched(
				f,
				{},
				{
					approve: async () => typed,
					runner: async () => {
						calls += 1;
					},
				},
			);
			expect(result.status).toBe("declined");
			expect(result.code).toBe("declined");
		}
		expect(calls).toBe(0);
		expect(manifest(f.work)).toEqual(before);
		expect(endoProtectedAttemptAuthorityV0(plan.plan.phrase, plan.plan.operationDigest).decision).toBe("allow");
		expect(endoProtectedAttemptAuthorityV0(plan.plan.phrase, H("f")).decision).toBe("deny");
	});

	it("refuses when anything changes while the operator reads the operation, and writes nothing", async () => {
		const f = fixture();
		const before = manifest(f.work);
		const { result } = await launched(
			f,
			{},
			{
				approve: async (plan) => {
					writeFileSync(join(f.agentTemplate, "agent.mjs"), "process.exit(0);\n");
					return plan.phrase;
				},
			},
		);
		expect(result.status).toBe("refused");
		expect(result.code).toBe("changed-during-approval");
		const after = manifest(f.work);
		delete before["agent-template/agent.mjs"];
		delete after["agent-template/agent.mjs"];
		expect(after).toEqual(before);
	});

	it("refuses unsupported or unsafe inputs before asking: template, agent template, out directory, attempt", async () => {
		const plan = (f: Fixture, change: Partial<{ templatePath: string; out: string; attemptId: string }> = {}) =>
			planProtectedAttemptV0({
				root: f.root,
				attemptId: f.attemptId,
				templatePath: f.template,
				out: join(f.work, "out"),
				...change,
			});
		const f = fixture();
		const v0 = join(f.work, "v0.json");
		writeFileSync(v0, readFileSync(join(EXAMPLE, "evaluator", "evaluator.json")));
		expect((plan(f, { templatePath: v0 }) as { code: string }).code).toBe("template-unsupported");
		const v3 = fixture({
			templateChange: {
				schemaVersion: "endo.protected-experiment-spec.v3",
				limits: {
					agentTimeoutMs: 30_000,
					evaluationTimeoutMs: 30_000,
					outputBytes: 65_536,
					tmpfsBytes: 16 * 1024 * 1024,
					maxFileBytes: 65_536,
					maxTotalBytes: 262_144,
					memoryMaxBytes: 512 * 1024 * 1024,
					cpuQuotaPercent: 200,
				},
				runtime: { executables: ["/usr/bin/node"], aliases: [] },
				modelAccess: {
					upstream: "http://127.0.0.1:8090",
					model: "m",
					routes: [{ method: "POST", path: "/v1/chat/completions" }],
					maxRequestBytes: 256 * 1024,
					maxTransferredBytes: 16 * 1024 * 1024,
					maxConnections: 8,
					maxTotalConnections: 64,
					maxExchanges: 32,
					maxCompletionTokens: 64,
					minExchanges: 1,
				},
			} as never,
		});
		expect(plan(v3)).toMatchObject({
			ok: false,
			code: "template-unsupported",
			detail: expect.stringContaining("spec.v2 (offline)"),
		});
		const two = fixture({ templateChange: { trials: 2 } });
		expect((plan(two) as { code: string }).code).toBe("template-unsupported");
		const link = join(f.work, "template-link.json");
		symlinkSync(f.template, link);
		expect((plan(f, { templatePath: link }) as { code: string }).code).toBe("template-unreadable");
		mkdirSync(join(f.work, "exists"));
		expect((plan(f, { out: join(f.work, "exists") }) as { code: string }).code).toBe("out-unusable");
		expect((plan(f, { out: join(f.work, "has space") }) as { code: string }).code).toBe("out-unusable");
		expect((plan(f, { out: join(f.work, "missing-parent", "out") }) as { code: string }).code).toBe("out-unusable");
		expect((plan(f, { attemptId: `endo.attempt.${"0".repeat(32)}` }) as { code: string }).code).toBe("not-found");
		expect((plan(f, { attemptId: "../etc" }) as { code: string }).code).toBe("bad-request");
		symlinkSync("/etc/passwd", join(f.agentTemplate, "passwd"));
		expect((plan(f) as { code: string }).code).toBe("agent-template-unusable");
		rmSync(join(f.agentTemplate, "passwd"));
		rmSync(join(f.agentTemplate, "prompt.txt"));
		mkdirSync(join(f.agentTemplate, "prompt.txt"));
		expect((plan(f) as { code: string }).code).toBe("agent-template-unusable");
	});

	it("an attempt already authorised for a workbench send is refused, and a binding next to one is invalid", async () => {
		const f = fixture();
		const { result } = await launched(f);
		expect(result.status).toBe("bound");
		const g = fixture();
		const authorized = {
			schemaVersion: "endo.develop-attempt-authorization.v0",
			attemptId: g.attemptId,
			recordedAtMs: 1,
			briefSha256: sha256HexV0(g.brief),
			taskRevision: 1,
			harness: "pi",
			session: "endo.session.pi.11111111-2222-3333-4444-555555555555",
			attachment: "pi.default",
			launchId: "0123456789abcdef",
			proposalId: "endo.evidence.workbench-prompt-0123456789abcdef0123456789abcdef",
			proposalDigest: H("d"),
			authorizationEventId: "endo.event.22222222222222222222222222222222",
			message: { digest: { algorithm: "hmac-sha256", keyId: "key-1", value: H("a") }, bytes: 10 },
			approvedBy: "operator",
			via: "workbench-terminal",
		};
		expect(new DevelopAttemptsStoreV0(g.root).write(g.attemptId, "authorized", authorized as never)).toBe("created");
		const refused = await launched(g);
		expect(refused.result.code).toBe("already-authorized");
		// Same-uid writer copies an authorisation next to f's bound attempt: two execution routes cannot both own the candidate.
		expect(
			new DevelopAttemptsStoreV0(f.root).write(f.attemptId, "authorized", {
				...authorized,
				attemptId: f.attemptId,
				briefSha256: sha256HexV0(f.brief),
			} as never),
		).toBe("created");
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toEqual(["single-execution-route"]);
	});

	it("never launches the same attempt twice; a second binding never replaces the first", async () => {
		const f = fixture();
		const first = await launched(f);
		expect(first.result.status).toBe("bound");
		const bytes = readFileSync(bindingPath(f));
		const second = await launchProtectedAttemptV0({
			root: f.root,
			attemptId: f.attemptId,
			templatePath: f.template,
			out: join(f.work, "out-2"),
			approve: approveExactly,
			runner: fakeRunner(),
		});
		expect(second.status).toBe("refused");
		expect(second.code).toBe("already-launched");
		expect(existsSync(join(f.work, "out-2"))).toBe(false);
		expect(readFileSync(bindingPath(f))).toEqual(bytes);
	});

	it("races six launcher processes for one attempt: exactly one launch record, one run", async () => {
		const f = fixture();
		const script = join(f.work, "race.mjs");
		writeFileSync(
			script,
			[
				`import { launchProtectedAttemptV0 } from ${JSON.stringify(ADAPTER)};`,
				"const [root, attemptId, templatePath, out] = process.argv.slice(2);",
				"const r = await launchProtectedAttemptV0({ root, attemptId, templatePath, out,",
				"  approve: async (p) => p.phrase,",
				"  runner: async (_spec, dir) => { const fs = await import('node:fs'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/ran', '1'); } });",
				"process.stdout.write(JSON.stringify({ status: r.status, code: r.code }));",
			].join("\n"),
		);
		const results = await Promise.all(
			Array.from(
				{ length: 6 },
				(_, i) =>
					new Promise<{ status: string; code: string | null }>((resolveRun, reject) => {
						const child = spawn(
							process.execPath,
							[script, f.root, f.attemptId, f.template, join(f.work, `race-${i}`)],
							{
								stdio: ["ignore", "pipe", "pipe"],
							},
						);
						let stdout = "";
						let stderr = "";
						child.stdout.on("data", (d) => {
							stdout += d;
						});
						child.stderr.on("data", (d) => {
							stderr += d;
						});
						child.on("close", () => {
							try {
								resolveRun(JSON.parse(stdout));
							} catch {
								reject(new Error(stderr));
							}
						});
					}),
			),
		);
		const winners = results.filter((r) => r.code !== "already-launched");
		expect(winners).toHaveLength(1);
		expect(winners[0]!.status).toBe("not-bound");
		const ran = Array.from({ length: 6 }, (_, i) => existsSync(join(f.work, `race-${i}`, "run", "ran"))).filter(
			Boolean,
		);
		expect(ran).toHaveLength(1);
		expect(existsSync(bindingPath(f))).toBe(false);
		expect(reading(f)?.attemptAssociation).toBe("incomplete-execution");
	});

	it("a runner that refuses or is interrupted leaves an incomplete execution, never a binding, and is never retried", async () => {
		for (const run of [{ refuse: true }, { interruptBeforeRecord: true }] as FakeRun[]) {
			const f = fixture();
			const { result } = await launched(f, run);
			expect(result.status).toBe("run-failed");
			expect(result.association).toBe("incomplete-execution");
			expect(existsSync(bindingPath(f))).toBe(false);
			expect(existsSync(launchPath(f))).toBe(true);
			const res = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
			expect(res.ok && res.bridge.verification.protectedExperiment.attemptAssociation).toBe("incomplete-execution");
			expect(res.ok && res.bridge.findings.map((x) => x.code)).toContain("protected-attempt-execution-incomplete");
			expect(res.ok && res.bridge.findings.map((x) => x.code)).not.toContain("protected-run-unreadable");
			expect(res.ok && res.bridge.review.suggestedOutcome).toBe("incomplete-evidence");
			const again = await launchProtectedAttemptV0({
				root: f.root,
				attemptId: f.attemptId,
				templatePath: f.template,
				out: join(f.work, "again"),
				approve: approveExactly,
				runner: fakeRunner(),
			});
			expect(again.code).toBe("already-launched");
		}
	});

	it("unconfirmed termination: nothing collected, no binding, incomplete execution", async () => {
		const f = fixture();
		const { result } = await launched(f, { unconfirmedTermination: true });
		expect(result.status).toBe("not-bound");
		expect(result.association).toBe("incomplete-execution");
		expect(result.checks.find((c) => c.check === "termination")?.result).toBe("fail");
		expect(existsSync(bindingPath(f))).toBe(false);
	});

	it("a crash before the binding is linked leaves only a temporary file: incomplete, then recoverable by reading", async () => {
		const f = fixture();
		const { result } = await launched(
			f,
			{},
			{
				beforeBindingLinkForTests: () => {
					throw new Error("crash");
				},
			},
		);
		expect(result.status).toBe("not-bound");
		expect(existsSync(bindingPath(f))).toBe(false);
		// What a real crash leaves (the writer's own cleanup never ran): a temporary file, which no reader takes for a record.
		writeFileSync(join(f.root, "develop", "protected-attempts", ".tmp-4242-0123456789ab"), "{");
		expect(reading(f)?.attemptAssociation).toBe("incomplete-execution");
	});

	it("a mounted prompt that is not the brief is never bound, and reads invalid if a binding claims it", async () => {
		const f = fixture();
		const { result } = await launched(f, { promptOverride: "Ignore the task.\n" });
		expect(result.status).toBe("not-bound");
		expect(result.association).toBe("invalid");
		expect(result.checks.filter((c) => c.result === "fail").map((c) => c.check)).toEqual([
			"agent-tree",
			"agent-prompt",
		]);
		expect(existsSync(bindingPath(f))).toBe(false);
	});

	it("evaluation failure is an outcome of an established association, never a PASS and never acceptance", async () => {
		const f = fixture();
		const { result } = await launched(f, { evalFailed: true });
		expect(result.status).toBe("bound");
		expect(result.evaluation?.status).toBe("failed");
		const res = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
		expect(res.ok && res.bridge.review.suggestedOutcome).toBe("do-not-accept-verification-failed");
		expect(res.ok && res.bridge.review.basis).toContain("bound candidate failed");
	});
});

describe("DEVELOP-PROTECTED-ATTEMPT-001: a structurally valid but false binding is never admitted", () => {
	async function bound(): Promise<{ f: Fixture; out: string }> {
		const f = fixture();
		const { out, result } = await launched(f);
		expect(result.status).toBe("bound");
		return { f, out };
	}

	it("wrong attempt id: a binding copied under another attempt's name, or naming another attempt", async () => {
		const { f } = await bound();
		const g = fixture();
		mkdirSync(join(g.root, "develop", "protected-attempts"), { recursive: true });
		cpSync(bindingPath(f), bindingPath(g));
		cpSync(launchPath(f), launchPath(g));
		const r = reading(g);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(r?.binding.record).toBe("unusable");
		forgeBinding(f, (b) => {
			b.attemptId = g.attemptId;
		});
		expect(reading(f)?.attemptAssociation).toBe("invalid");
	});

	it("changed brief: the prepared record rewritten after the launch", async () => {
		const { f } = await bound();
		const prepared = join(f.root, "develop", "attempts", `${f.attemptId}.prepared.json`);
		const record = JSON.parse(readFileSync(prepared, "utf8"));
		record.objective = "Delete calc.mjs";
		chmodSync(prepared, 0o600);
		writeFileSync(prepared, canonicalEndoJsonV0(record));
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toContain("brief-digest");
		expect(failed(r)).toContain("agent-prompt");
	});

	it("changed brief digest in the binding, resealed", async () => {
		const { f } = await bound();
		forgeBinding(f, (b) => {
			b.briefSha256 = H("b");
			(b.target as { agent: { promptSha256: string } }).agent.promptSha256 = H("b");
		});
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toContain("brief-digest");
	});

	it("wrong or absent authorisation: another operation digest, another launch record, no launch record", async () => {
		const { f } = await bound();
		forgeBinding(f, (b) => {
			(b.authorization as { operationDigest: string }).operationDigest = H("c");
		});
		expect(failed(reading(f))).toContain("operation-digest");
		const g = (await bound()).f;
		const launch = JSON.parse(readFileSync(launchPath(g), "utf8"));
		launch.recordedAtMs += 1;
		chmodSync(launchPath(g), 0o600);
		writeFileSync(launchPath(g), canonicalEndoJsonV0(launch));
		expect(failed(reading(g))).toContain("operation-digest");
		const h = (await bound()).f;
		rmSync(launchPath(h));
		const r = reading(h);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toContain("launch-record");
		const i = (await bound()).f;
		const op = JSON.parse(readFileSync(launchPath(i), "utf8"));
		op.operation.taskRevision += 7;
		chmodSync(launchPath(i), 0o600);
		writeFileSync(launchPath(i), canonicalEndoJsonV0(op));
		expect(failed(reading(i))).toContain("operation-digest");
	});

	it("wrong spec pin: from the reader, and in the binding", async () => {
		const { f } = await bound();
		const r = reading(f, { specPin: H("1") });
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toContain("spec-digest");
		forgeBinding(f, (b) => {
			(b.target as { specSha256: string }).specSha256 = H("1");
		});
		expect(failed(reading(f))).toContain("spec-digest");
	});

	it("substituted run, substituted trial record, another trial selected", async () => {
		const { f, out } = await bound();
		// Another valid run of the same spec, with a different (still verified) candidate.
		const run = join(out, "run");
		renameSync(run, join(out, "run-original"));
		await fakeRunner({ workContent: "export function add(a, b) {\n\treturn b + a;\n}\n" })(
			JSON.parse(readFileSync(join(out, "spec.json"), "utf8")),
			run,
		);
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toEqual(expect.arrayContaining(["trial-record", "candidate"]));
		// A differently evaluated record, correctly sealed, in place of the bound one.
		rmSync(run, { recursive: true, force: true });
		renameSync(join(out, "run-original"), run);
		const recordFile = join(run, "trials", "calc-fix", "fixture", "0", "attempt-1", "record.json");
		const record = JSON.parse(readFileSync(recordFile, "utf8"));
		const { recordSha256: _old, ...rest } = record;
		rest.evaluation.cases = { total: 3, passed: 2 };
		rest.evaluation.status = "failed";
		writeFileSync(recordFile, canonicalEndoJsonV0(sealEndoProtectedTrialV0(rest as never) as never));
		const s = reading(f);
		expect(s?.attemptAssociation).toBe("invalid");
		expect(failed(s)).toContain("trial-record");
		expect(reading(f, { trial: "calc-fix/fixture/1" })?.attemptAssociation).toBe("invalid");
		const other = fresh("other-run");
		expect(reading(f, { protectedRunDir: other })?.attemptAssociation).toBe("invalid");
	});

	it("modified baseline or change-set bytes: candidate integrity failure", async () => {
		for (const which of ["changeset", "baseline"] as const) {
			const { f, out } = await bound();
			const attemptDir = join(out, "run", "trials", "calc-fix", "fixture", "0", "attempt-1");
			const file =
				which === "changeset"
					? join(attemptDir, "changeset", "files", "calc.mjs")
					: join(attemptDir, "baseline", "calc.mjs");
			chmodSync(file, 0o644);
			writeFileSync(file, "export function add() { return 5; }\n");
			const r = reading(f);
			expect(r?.attemptAssociation).toBe("candidate-integrity-failure");
			const res = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
			expect(res.ok && res.bridge.findings.map((x) => x.code)).toContain(
				"protected-attempt-candidate-integrity-failure",
			);
			expect(res.ok && res.bridge.review.suggestedOutcome).toBe("blocked-contradictory-or-tampered");
		}
	});

	it("candidate digest mismatch in the binding, resealed", async () => {
		const { f } = await bound();
		forgeBinding(f, (b) => {
			(b.target as { candidate: { candidateSha256: string } }).candidate.candidateSha256 = H("9");
		});
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toEqual(["candidate"]);
	});

	it("a broken seal, a symlinked or oversized record, a symlinked directory: unusable, invalid", async () => {
		const { f } = await bound();
		const raw = readBinding(f) as unknown as Record<string, unknown>;
		raw.recordedAtMs = 1;
		chmodSync(bindingPath(f), 0o600);
		writeFileSync(bindingPath(f), canonicalEndoJsonV0(raw as never));
		expect(reading(f)?.binding.record).toBe("unusable");
		expect(reading(f)?.attemptAssociation).toBe("invalid");
		writeFileSync(bindingPath(f), "x".repeat(70 * 1024));
		expect(reading(f)?.attemptAssociation).toBe("invalid");
		const g = (await bound()).f;
		const real = join(g.work, "elsewhere.json");
		renameSync(bindingPath(g), real);
		symlinkSync(real, bindingPath(g));
		expect(reading(g)?.binding.record).toBe("unusable");
		const h = (await bound()).f;
		const dir = join(h.root, "develop", "protected-attempts");
		renameSync(dir, join(h.root, "develop", "moved"));
		symlinkSync(join(h.root, "develop", "moved"), dir);
		const r = reading(h);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(r?.binding.launch).toBe("unusable");
	});

	it("a link planted in the mounted agent copy is refused, not followed", async () => {
		const { f, out } = await bound();
		symlinkSync("/etc/passwd", join(out, "run", ".agents", "fixture", "passwd"));
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("invalid");
		expect(failed(r)).toContain("agent-tree");
	});

	it("authority escalation: an operator binding cannot claim the controller's standing, via or authorisation", async () => {
		const { f } = await bound();
		const controller = readBinding(f) as unknown as Record<string, unknown>;
		const variants: ((b: Record<string, unknown>) => void)[] = [
			(b) => {
				b.boundBy = "operator";
			},
			(b) => {
				b.via = "operator-declaration";
			},
			(b) => {
				b.standing = { ...ENDO_ATTEMPT_BINDING_STANDING_V0.controller, association: "operator-declared" };
			},
			(b) => {
				b.boundBy = "operator";
				b.via = "operator-declaration";
				b.standing = ENDO_ATTEMPT_BINDING_STANDING_V0.operator;
			},
		];
		for (const change of variants) {
			const { bindingSha256: _s, ...rest } = structuredClone(controller);
			change(rest);
			expect(() =>
				validateEndoDevelopAttemptCandidateBindingV0(sealEndoAttemptCandidateBindingV0(rest as never)),
			).toThrow();
		}
	});

	it("an operator-declared binding that re-verifies reads operator-declared, never established", async () => {
		const { f } = await bound();
		rmSync(launchPath(f));
		forgeBinding(f, (b) => {
			b.boundBy = "operator";
			b.via = "operator-declaration";
			b.standing = ENDO_ATTEMPT_BINDING_STANDING_V0.operator;
			b.authorization = null;
			(b.target as { agent: unknown }).agent = null;
		});
		const r = reading(f);
		expect(r?.attemptAssociation).toBe("operator-declared");
		expect(r?.binding.standing).toBe("operator-declared");
		const res = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
		if (!res.ok) throw new Error("bridge");
		const t6 = res.bridge.transitions.find((t) => t.id === "attempt-to-reconstructable-candidate")!;
		expect([t6.status, t6.basis]).toEqual(["partial", "operator-declared"]);
		expect(t6.evidence).toContain("not controller-established");
		const text = renderEndoDevelopEvidenceBridgeV0(res.bridge);
		expect(text).toContain("[operator-declared; operator-declared] Operator-declared association");
		expect(text).not.toContain("Controller-established");
	});
});

describe("DEVELOP-PROTECTED-ATTEMPT-001: legacy records and the read-only bridge", () => {
	it("an attempt without launch or binding reads exactly as before, with and without a supplied run", async () => {
		const f = fixture();
		const run = join(f.work, "unlinked-run");
		const specRead = planProtectedAttemptV0({
			root: f.root,
			attemptId: f.attemptId,
			templatePath: f.template,
			out: join(f.work, "o"),
		});
		if (!specRead.ok) throw new Error("plan");
		const condition = specRead.plan.spec.conditions[0]!;
		const unlinked: EndoProtectedSpecV2 = {
			...(specRead.plan.spec as EndoProtectedSpecV2),
			conditions: [{ ...condition, agent: { ...condition.agent, directory: f.agentTemplate } }],
		};
		await fakeRunner()(unlinked, run);
		expect(reading(f)).toBeNull();
		const plain = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
		if (!plain.ok) throw new Error("bridge");
		expect(plain.bridge.verification.protectedExperiment.attemptAssociation).toBe("not-supplied");
		expect(renderEndoDevelopEvidenceBridgeV0(plain.bridge)).not.toContain("binding   [");
		const pin = sha256HexV0(canonicalEndoJsonV0(unlinked as never));
		const supplied = await readDevelopEvidenceBridgeV0({
			root: f.root,
			attemptId: f.attemptId,
			protectedRunDir: run,
			specPin: pin,
		});
		if (!supplied.ok) throw new Error("bridge");
		const pe = supplied.bridge.verification.protectedExperiment;
		expect(pe.attemptAssociation).toBe("unestablished");
		expect(pe.missingBindingRecord).toBe("develop-attempt-protected-candidate-binding");
		expect(pe.candidateIntegrity).toBe("verified");
		expect(supplied.bridge.findings.map((x) => x.code)).toContain("protected-attempt-association-unestablished");
		const t6 = supplied.bridge.transitions.find((t) => t.id === "attempt-to-reconstructable-candidate")!;
		expect([t6.status, t6.missingRecord]).toEqual(["unestablished", "develop-attempt-protected-candidate-binding"]);
	});

	it("CLI bridge over a bound attempt writes nothing anywhere and runs nothing", async () => {
		const f = fixture();
		const { out, result } = await launched(f);
		expect(result.status).toBe("bound");
		const before = { store: manifest(f.root), out: manifest(out), project: manifest(f.project) };
		const bin = join(f.work, "bin");
		mkdirSync(bin);
		for (const cmd of ["pi", "bwrap", "systemd-run", "systemctl", "node-evaluator"]) {
			writeFileSync(join(bin, cmd), `#!/bin/sh\ntouch ${join(f.work, `SPAWNED-${cmd}`)}\nexit 1\n`);
			chmodSync(join(bin, cmd), 0o755);
		}
		const r = spawnSync(process.execPath, [CLI, "attempt", "bridge", "--root", f.root, "--attempt", f.attemptId], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		});
		expect(r.status).toBe(0);
		const parsed = JSON.parse(r.stdout);
		expect(parsed.bridge.verification.protectedExperiment.attemptAssociation).toBe("established");
		expect({ store: manifest(f.root), out: manifest(out), project: manifest(f.project) }).toEqual(before);
		expect(readdirSync(f.work).filter((n) => n.startsWith("SPAWNED-"))).toEqual([]);
	});

	it("CLI protected-run refuses a stdin that is not the controlling terminal, before reading or writing anything", () => {
		const f = fixture();
		const before = manifest(f.work);
		const r = spawnSync(
			process.execPath,
			[
				CLI,
				"attempt",
				"protected-run",
				"--root",
				f.root,
				"--attempt",
				f.attemptId,
				"--template",
				f.template,
				"--out",
				join(f.work, "out"),
			],
			{ encoding: "utf8", input: "APPROVE PROTECTED ATTEMPT 0123456789abcdef\n" },
		);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("controlling terminal");
		expect(manifest(f.work)).toEqual(before);
		const flag = spawnSync(
			process.execPath,
			[
				CLI,
				"attempt",
				"protected-run",
				"--root",
				f.root,
				"--attempt",
				f.attemptId,
				"--template",
				f.template,
				"--out",
				join(f.work, "out"),
				"--confirm",
				H("0"),
			],
			{ encoding: "utf8" },
		);
		expect(flag.status).not.toBe(0);
		expect(manifest(f.work)).toEqual(before);
	});
});

// ---- real protected runner -----------------------------------------------------------------------------------------------------------

const detected = detectBubblewrapV0();
const contained = detected.ok ? await detectContainmentV0() : null;
const REAL = detected.ok && contained?.ok === true;
if (!REAL)
	process.stderr.write(
		"develop-protected-attempt: real isolation test skipped (" +
			(detected.ok ? "no usable systemd user manager" : detected.reason) +
			"); the deterministic tests are not kernel-isolation evidence\n",
	);

describe.runIf(REAL)(
	"DEVELOP-PROTECTED-ATTEMPT-001: one bounded real protected run (bubblewrap, systemd user scope, offline v2)",
	() => {
		it("launches a prepared attempt through the real runner, confirms termination, re-verifies and binds the candidate", async () => {
			const f = fixture();
			const { out, result } = await launchProtectedAttemptV0({
				root: f.root,
				attemptId: f.attemptId,
				templatePath: f.template,
				out: join(f.work, "out"),
				approve: approveExactly,
				runner: (spec, dir) => runProtectedExperimentV0({ spec, dir }),
			}).then((r) => ({ out: join(f.work, "out"), result: r }));
			expect(result.checks.filter((c) => c.result === "fail")).toEqual([]);
			expect(result.status).toBe("bound");
			expect(result.association).toBe("established");
			expect(result.evaluation?.status).toBe("passed");
			const record = JSON.parse(
				readFileSync(join(out, "run", "trials", "calc-fix", "fixture", "0", "attempt-1", "record.json"), "utf8"),
			) as EndoProtectedTrialV2;
			expect(record.preflight.status).toBe("established");
			expect(record.agent.termination).toBe("confirmed");
			expect(record.agent.scope?.ended).toBe("confirmed");
			expect(record.changeset.verification.status).toBe("verified");
			const res = await readDevelopEvidenceBridgeV0({ root: f.root, attemptId: f.attemptId });
			expect(res.ok && res.bridge.verification.protectedExperiment.attemptAssociation).toBe("established");
			expect(readdirSync(f.project)).toEqual([]);
			if (process.env.ENDO_PROTECTED_ATTEMPT_EVIDENCE_DIR !== undefined) {
				const keep = process.env.ENDO_PROTECTED_ATTEMPT_EVIDENCE_DIR;
				mkdirSync(keep, { recursive: true });
				writeFileSync(join(keep, "launch-result.json"), canonicalEndoJsonV0(result as never));
				writeFileSync(join(keep, "binding.json"), readFileSync(bindingPath(f)));
				writeFileSync(join(keep, "record.json"), canonicalEndoJsonV0(record as never));
				if (res.ok) writeFileSync(join(keep, "bridge.txt"), renderEndoDevelopEvidenceBridgeV0(res.bridge));
			}
		}, 120_000);
	},
);
