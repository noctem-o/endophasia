// Staged change-set submission in "endo experiment protected-run" (docs/designs/protected-staged-changeset.md), run in REAL Bubblewrap
// sandboxes under systemd scopes, offline (a version 2 spec). Skipped, and said so, where the host cannot isolate (as
// tests/protected-isolation.test.ts). Each test is one run of the real runner over a small, pre-pruned repository fixture: the baseline
// pinned from the spec, the agent's whole workspace collected after its termination was confirmed, verified against the complete baseline
// record and tree in the evaluator step, reconstructed in a fresh candidate directory, and evaluated there. The agents are small node
// scripts that each do exactly what the test is about.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { detectBubblewrapV0, processAliveV0 } from "../adapters/sandbox/bubblewrap.ts";
import { detectContainmentV0 } from "../adapters/sandbox/containment.ts";
import {
	EndoProtectedRefusalV0,
	reportProtectedExperimentV0,
	runProtectedExperimentV0,
} from "../cli/experiment-protected.ts";
import {
	ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2,
	ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2,
	type EndoProtectedSpecV2,
	type EndoProtectedTrialV2,
	endoProtectedTrialOutcomeV0,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import {
	DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	ENDO_CHANGESET_REFUSAL_REASONS_V0,
	type EndoChangeSetLimitsV0,
	type EndoChangeSetRefusalReasonV0,
} from "../protocol/staged-changeset.ts";

/** A complete refusal census: every reason, 0 unless given. */
const census = (given: Partial<Record<EndoChangeSetRefusalReasonV0, number>> = {}) =>
	Object.fromEntries(ENDO_CHANGESET_REFUSAL_REASONS_V0.map((k) => [k, given[k] ?? 0]));

import { readEndoProtectedTrialFileV0, sealEndoProtectedTrialV0 } from "../runtime/contracts/protected-experiment.ts";

const EXAMPLE = fileURLToPath(new URL("../research/protected-eval/example/", import.meta.url));
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-staged-run-")));
function chmodTree(path: string): void {
	try {
		const s = statSync(path);
		if (s.isDirectory()) {
			chmodSync(path, 0o700);
			for (const n of readdirSync(path)) chmodTree(join(path, n));
		} else if (s.isFile()) chmodSync(path, 0o600);
	} catch {
		// gone
	}
}
afterAll(() => {
	chmodTree(base);
	rmSync(base, { recursive: true, force: true });
});
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const d = join(base, `${name}-${made}`);
	mkdirSync(d, { recursive: true });
	return d;
};
const detected = detectBubblewrapV0();
const contained = detected.ok ? await detectContainmentV0() : null;
const REAL = detected.ok && contained?.ok === true;
if (!REAL) process.stderr.write("protected-staged-run: real isolation tests skipped (no bubblewrap or user manager)\n");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const SOLUTION = readFileSync(join(EXAMPLE, "evaluator", "reference", "src", "interval.mjs"), "utf8");
const WRONG = readFileSync(join(EXAMPLE, "evaluator", "negative", "src", "interval.mjs"), "utf8");

/** The small, pre-pruned repository every agent starts from: well inside the walk limits below. */
const FIXTURE: Record<string, string> = {
	"README.md": "Implement mergeIntervals in src/interval.mjs.\n",
	"package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
	"src/interval.mjs": "export function mergeIntervals() { throw new Error('todo'); }\n",
	"src/util/legacy.mjs": "export const legacy = true;\n",
	docs: "see README\n",
	"bin/check.sh": "#!/bin/sh\nexit 0\n",
};
const LIMITS = {
	maxFileBytes: 65_536,
	maxTotalStagedBytes: 262_144,
	maxWorkspaceBytes: 1_048_576,
	maxWalkedEntries: 256,
	maxChangedFiles: 32,
	maxDepth: 8,
};

/** An agent that makes every kind of change: modify, add, delete, mode, file -> directory and directory -> file. */
const ALL_CHANGES = (solution: string) =>
	[
		'import fs from "node:fs";',
		`fs.writeFileSync('src/interval.mjs', ${JSON.stringify(solution)});`,
		"fs.mkdirSync('src/extra'); fs.writeFileSync('src/extra/notes.txt', 'notes\\n');",
		"fs.rmSync('src/util', { recursive: true }); fs.writeFileSync('src/util', 'util is a file now\\n');",
		"fs.rmSync('docs'); fs.mkdirSync('docs'); fs.writeFileSync('docs/index.md', '# docs\\n');",
		"fs.chmodSync('bin/check.sh', 0o755);",
		"fs.rmSync('README.md');",
	].join("\n");

function specWith(
	agents: Record<string, string>,
	change: Partial<EndoProtectedSpecV2> = {},
	limits: EndoChangeSetLimitsV0 = LIMITS,
): EndoProtectedSpecV2 {
	const evaluatorDir = fresh("evaluator");
	for (const part of ["reference", "negative"]) {
		mkdirSync(join(evaluatorDir, part, "src"), { recursive: true });
		writeFileSync(
			join(evaluatorDir, part, "src", "interval.mjs"),
			readFileSync(join(EXAMPLE, "evaluator", part, "src", "interval.mjs")),
		);
	}
	writeFileSync(join(evaluatorDir, "evaluator.json"), readFileSync(join(EXAMPLE, "evaluator", "evaluator.json")));
	const conditions = Object.entries(agents).map(([id, source]) => {
		const dir = fresh(`agent-${id}`);
		writeFileSync(join(dir, "agent.mjs"), source);
		return { id, description: id, agent: { directory: dir, argv: ["/usr/bin/node", "/agent/agent.mjs"] } };
	});
	const read = readEndoProtectedSpecV0({
		schemaVersion: "endo.protected-experiment-spec.v2",
		id: "endo.experiment.staged-test",
		description: "test",
		seed: 7,
		trials: 1,
		limits: {
			agentTimeoutMs: 20_000,
			evaluationTimeoutMs: 20_000,
			outputBytes: 1_048_576,
			tmpfsBytes: 16_777_216,
			maxFileBytes: 65_536,
			maxTotalBytes: 262_144,
		},
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "merge-intervals",
				workspace: FIXTURE,
				submission: { mode: "staged-changeset", limits },
				evaluator: {
					file: join(evaluatorDir, "evaluator.json"),
					sha256: sha(join(evaluatorDir, "evaluator.json")),
				},
			},
		],
		conditions,
		...change,
	});
	if (!read.ok) throw new Error(read.message);
	return read.value as EndoProtectedSpecV2;
}
const attemptOf = (dir: string, condition: string, attempt = 1) =>
	join(dir, "trials", "merge-intervals", condition, "0", `attempt-${attempt}`);
const recordOf = (dir: string, condition: string, attempt = 1): EndoProtectedTrialV2 => {
	const r = readEndoProtectedTrialFileV0(join(attemptOf(dir, condition, attempt), "record.json"));
	if (!r.ok) throw new Error(r.reason);
	return r.value as EndoProtectedTrialV2;
};
const cellOf = (dir: string, condition: string) => {
	const report = reportProtectedExperimentV0(dir);
	return { cell: report.cells.find((c) => c.condition === condition), refused: report.refusedRecords };
};
const overwrite = (path: string, content: string) => {
	chmodSync(path, 0o644);
	writeFileSync(path, content);
	chmodSync(path, 0o444);
};

describe.runIf(REAL)("staged change-set submission in a real protected run", () => {
	it("collects every kind of change, verifies it, reconstructs the candidate afresh and passes a correct coding submission", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: ALL_CHANGES(SOLUTION) });
		expect(await runProtectedExperimentV0({ spec, dir: out })).toMatchObject({ attempts: 1 });
		const r = recordOf(out, "honest");
		expect(r.schemaVersion).toBe("endo.protected-trial.v2");
		expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
		expect(r.changeset.baseline).toMatchObject({ status: "pinned", files: 6 });
		expect(r.changeset.collection.status).toBe("collected");
		expect(r.changeset.collection.summary).toEqual({
			baselineFiles: 6,
			candidateFiles: 6,
			unchangedFiles: 1,
			addedFiles: 3,
			modifiedFiles: 1,
			modeChangedFiles: 1,
			deletedFiles: 3,
			stagedBytes: r.changeset.collection.summary?.stagedBytes,
		});
		expect(r.changeset.verification).toMatchObject({ status: "verified", reason: null });
		expect(r.evaluation).toMatchObject({ status: "passed", cases: { total: 7, passed: 7 } });
		expect(r.invalidating).toEqual([]);
		expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "passed", reason: null });
		// The pin was recorded before the agent started, and is the one derived from the spec.
		const attempt = attemptOf(out, "honest");
		expect(JSON.parse(readFileSync(join(attempt, "baseline.json"), "utf8")).sha256).toBe(r.changeset.baseline.sha256);
		// What was evaluated is the reconstructed candidate: read-only, never executable, the agent's changes applied to the baseline.
		const candidate = join(attempt, "candidate");
		const listed: string[] = [];
		const walk = (d: string, rel = "") => {
			for (const n of readdirSync(d).sort()) {
				const p = join(d, n);
				if (statSync(p).isDirectory()) walk(p, `${rel + n}/`);
				else {
					listed.push(rel + n);
					expect(statSync(p).mode & 0o777).toBe(0o444);
				}
			}
		};
		walk(candidate);
		expect(listed.sort()).toEqual(
			[
				"bin/check.sh",
				"docs/index.md",
				"package.json",
				"src/extra/notes.txt",
				"src/interval.mjs",
				"src/util",
			].sort(),
		);
		expect(readFileSync(join(candidate, "src/interval.mjs"), "utf8")).toBe(SOLUTION);
		// The pristine baseline tree is untouched.
		expect(readFileSync(join(attempt, "baseline", "README.md"), "utf8")).toBe(FIXTURE["README.md"]);
		const { cell, refused } = cellOf(out, "honest");
		expect(refused).toEqual([]);
		expect(cell).toMatchObject({ planned: 1, qualified: 1, passed: 1, failed: 0 });
	});

	it("fails an incorrect coding submission, and an agent that changes nothing", async () => {
		const out = fresh("run");
		const spec = specWith({ wrong: ALL_CHANGES(WRONG), idle: "" });
		await runProtectedExperimentV0({ spec, dir: out });
		for (const c of ["wrong", "idle"]) {
			const r = recordOf(out, c);
			expect(r.changeset.verification.status).toBe("verified");
			expect(r.evaluation.status).toBe("failed");
			expect(endoProtectedTrialOutcomeV0(r).outcome).toBe("failed");
		}
		expect(recordOf(out, "idle").changeset.collection.summary).toMatchObject({
			unchangedFiles: 6,
			candidateFiles: 6,
		});
		expect(cellOf(out, "wrong").cell).toMatchObject({
			qualified: 1,
			passed: 0,
			failed: 1,
			failedWithoutSubmission: 0,
		});
	});

	it("evaluates the staged bytes, never the agent's live workspace", async () => {
		const out = fresh("run");
		const spec = specWith({ wrong: ALL_CHANGES(WRONG) });
		await runProtectedExperimentV0({
			spec,
			dir: out,
			// After collection, someone puts the correct solution into the agent's workspace: it must play no part.
			onChangeSetCollected: (attempt) => writeFileSync(join(attempt, "work", "src", "interval.mjs"), SOLUTION),
		});
		const r = recordOf(out, "wrong");
		expect(r.changeset.verification.status).toBe("verified");
		expect(r.evaluation.status).toBe("failed");
	});

	it("never evaluates a change set whose staged bytes were replaced after collection: changeset-unverified attrition", async () => {
		const out = fresh("run");
		const spec = specWith({ wrong: ALL_CHANGES(WRONG) });
		await runProtectedExperimentV0({
			spec,
			dir: out,
			// The staged bytes are replaced with a passing solution between collection and the evaluator step.
			onChangeSetCollected: (attempt) =>
				overwrite(join(attempt, "changeset", "files", "src", "interval.mjs"), SOLUTION),
		});
		const r = recordOf(out, "wrong");
		expect(r.changeset.collection.status).toBe("collected");
		expect(r.changeset.verification).toEqual({
			status: "failed",
			reason: "staged-bytes-mismatch",
			candidateSha256: null,
		});
		expect(r.evaluation.status).toBe("not-run");
		expect(r.invalidating).toEqual(["changeset-unverified"]);
		expect(existsSync(join(attemptOf(out, "wrong"), "candidate"))).toBe(false);
		expect(cellOf(out, "wrong").cell).toMatchObject({
			qualified: 0,
			passed: 0,
			attrition: { "changeset-unverified": 1 },
		});
	});

	it("never evaluates against a baseline tree changed after collection", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: ALL_CHANGES(SOLUTION) });
		await runProtectedExperimentV0({
			spec,
			dir: out,
			onChangeSetCollected: (attempt) => overwrite(join(attempt, "baseline", "package.json"), "{}\n"),
		});
		const r = recordOf(out, "honest");
		expect(r.changeset.verification).toMatchObject({ status: "failed", reason: "baseline-mismatch" });
		expect(r.evaluation.status).toBe("not-run");
		expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "attrition", reason: "changeset-unverified" });
	});

	it("does not start the agent when its workspace is not the pinned baseline: baseline-mismatch attrition", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: ALL_CHANGES(SOLUTION) });
		await runProtectedExperimentV0({
			spec,
			dir: out,
			onBeforeBaselinePinned: (attempt) => writeFileSync(join(attempt, "work", "README.md"), "planted\n"),
		});
		const attempt = attemptOf(out, "honest");
		const r = recordOf(out, "honest");
		expect(r.preflight.status).toBe("established");
		expect(r.agent).toMatchObject({ status: "not-run", scope: null });
		expect(existsSync(join(attempt, "agent-started.json"))).toBe(false);
		expect(existsSync(join(attempt, "baseline.json"))).toBe(false);
		expect(r.changeset.baseline.status).toBe("mismatch");
		expect(r.changeset.collection.status).toBe("not-collected");
		expect(r.invalidating).toEqual(["baseline-mismatch"]);
	});

	it("counts what the collector refuses (a link, .git, too many changes) as the agent's failure, never evaluated", async () => {
		const out = fresh("run");
		const many = 'import fs from "node:fs"; for (let i = 0; i < 40; i++) fs.writeFileSync("f" + i, "x");';
		const spec = specWith({
			link: 'import fs from "node:fs"; fs.rmSync("src/interval.mjs"); fs.symlinkSync("/etc/passwd", "src/interval.mjs");',
			git: 'import fs from "node:fs"; fs.mkdirSync(".git"); fs.writeFileSync(".git/config", "");',
			many,
		});
		await runProtectedExperimentV0({ spec, dir: out });
		const expected: Record<string, string> = { link: "symbolic-link", git: "git-metadata", many: "too-many-files" };
		for (const [c, reason] of Object.entries(expected)) {
			const r = recordOf(out, c);
			expect(r.changeset.collection.status).toBe("refused");
			expect(r.changeset.collection.refusals[0]?.reason).toBe(reason);
			expect(r.changeset.verification.status).toBe("not-run");
			expect(r.evaluation.status).toBe("not-run");
			expect(existsSync(join(attemptOf(out, c), "changeset"))).toBe(false);
			expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "failed", reason: `changeset-${reason}` });
			expect(cellOf(out, c).cell).toMatchObject({ qualified: 1, failed: 1, failedWithoutSubmission: 1 });
		}
	});

	it("collects nothing from an agent interrupted by the controller's death; the resume records it as attrition", async () => {
		const spec = specWith({
			sleeper: 'import fs from "node:fs"; fs.writeFileSync("src/interval.mjs", "x"); setInterval(() => {}, 1000);',
		});
		const specFile = join(fresh("spec"), "spec.json");
		writeFileSync(specFile, JSON.stringify(spec));
		const out = fresh("run");
		const controller = spawn(process.execPath, [CLI, "experiment", "protected-run", specFile, "--out", out], {
			stdio: "ignore",
		});
		const started = join(attemptOf(out, "sleeper"), "agent-started.json");
		for (let i = 0; i < 300 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
		expect(existsSync(started)).toBe(true);
		const ns = JSON.parse(readFileSync(started, "utf8")).init;
		controller.kill("SIGKILL");
		await new Promise((r) => controller.on("close", r));
		for (let i = 0; i < 200 && processAliveV0(ns); i++) await new Promise((r) => setTimeout(r, 50));
		expect(await runProtectedExperimentV0({ spec, dir: out })).toMatchObject({ finalizedOnResume: 1 });
		const r = recordOf(out, "sleeper");
		expect(r.controller.finalized).toBe("on-resume");
		expect(r.agent.status).toBe("interrupted");
		expect(r.changeset.baseline.status).toBe("pinned");
		expect(r.changeset.collection.status).toBe("not-collected");
		expect(r.changeset.verification.status).toBe("not-run");
		expect(existsSync(join(attemptOf(out, "sleeper"), "changeset"))).toBe(false);
		expect(r.invalidating).toEqual(["controller-interrupted", "agent-interrupted"]);
	}, 60_000);

	it("the report re-verifies a verified change set from disk, and refuses a record whose staging no longer matches it", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: ALL_CHANGES(SOLUTION) });
		await runProtectedExperimentV0({ spec, dir: out });
		expect(cellOf(out, "honest").refused).toEqual([]);
		overwrite(join(attemptOf(out, "honest"), "changeset", "files", "src", "interval.mjs"), WRONG);
		const { cell, refused } = cellOf(out, "honest");
		expect(refused[0]?.reason).toMatch(/does not verify against its record \(staged-bytes-mismatch\)/);
		expect(cell).toMatchObject({ passed: 0, attrition: { "record-refused": 1 } });
	});

	it("refuses the run before any trial when the workspace exceeds its limits or the evaluator does not qualify through the staged path", async () => {
		const tight = specWith({ idle: "" });
		const t = tight.tasks[0]!;
		const limited = {
			...tight,
			tasks: [{ ...t, submission: { ...t.submission, limits: { ...LIMITS, maxWalkedEntries: 3 } } }],
		};
		await expect(runProtectedExperimentV0({ spec: limited, dir: fresh("run") })).rejects.toThrow(
			/does not fit its change-set limits \(too-many-files\)/,
		);
		// An evaluator whose reference fails is refused: qualification takes the staged path too.
		const swapped = specWith({ idle: "" });
		const evaluatorFile = swapped.tasks[0]!.evaluator.file;
		const dir = join(evaluatorFile, "..");
		writeFileSync(join(dir, "reference", "src", "interval.mjs"), WRONG);
		await expect(runProtectedExperimentV0({ spec: swapped, dir: fresh("run") })).rejects.toThrow(
			EndoProtectedRefusalV0,
		);
	});

	describe("every refusal the collector can make seals, bounded explicitly (the record's own constants, at and one past each)", () => {
		const PATH_MAX = ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2;
		const LIST_MAX = ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2;
		/** A refused path of exactly `length` characters: two walkable directories and a name the collector refuses as unsafe. */
		const longPath = (length: number) => `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(length - 202)}`;
		const pathAgent = (length: number) =>
			`import fs from "node:fs"; const p = ${JSON.stringify(longPath(length))}; fs.mkdirSync(p.slice(0, 201), { recursive: true }); fs.writeFileSync(p, "x");`;
		const linksAgent = (n: number) =>
			`import fs from "node:fs"; for (let i = 0; i < ${n}; i++) fs.symlinkSync("/etc/passwd", "l" + String(i).padStart(5, "0"));`;
		const PATHS = [PATH_MAX, PATH_MAX + 1, PATH_MAX + 3, PATH_MAX + 4];
		const LINKS = [LIST_MAX, LIST_MAX + 1, LIST_MAX + 2];
		const agents = {
			...Object.fromEntries(PATHS.map((n) => [`path-${n}`, pathAgent(n)])),
			...Object.fromEntries(LINKS.map((n) => [`links-${n}`, linksAgent(n)])),
			honest: ALL_CHANGES(SOLUTION),
		};
		/** The agent's own refusal, recorded as the agent's failure: finalized normally, never evaluated, never attrition. */
		const expectAgentRefusal = (r: EndoProtectedTrialV2, reason: string) => {
			expect(r.controller.finalized).toBe("normally");
			expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
			expect(r.changeset.collection.status).toBe("refused");
			expect(r.changeset.verification.status).toBe("not-run");
			expect(r.evaluation.status).toBe("not-run");
			expect(r.invalidating).toEqual([]);
			expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "failed", reason: `changeset-${reason}` });
		};
		const expectPath = (r: EndoProtectedTrialV2, n: number) => {
			expectAgentRefusal(r, "unsafe-path");
			expect(r.changeset.collection.refusalsOmitted).toBe(0);
			expect(r.changeset.collection.refusalCounts).toEqual(census({ "unsafe-path": 1 }));
			expect(r.changeset.collection.refusals).toEqual([
				n <= PATH_MAX
					? { path: longPath(n), reason: "unsafe-path", truncated: null }
					: {
							path: longPath(n).slice(0, PATH_MAX),
							reason: "unsafe-path",
							truncated: { length: n, sha256: createHash("sha256").update(longPath(n)).digest("hex") },
						},
			]);
		};
		const expectLinks = (r: EndoProtectedTrialV2, n: number) => {
			expectAgentRefusal(r, "symbolic-link");
			expect(r.changeset.collection.refusals).toHaveLength(Math.min(n, LIST_MAX));
			expect(
				r.changeset.collection.refusals.every((x) => x.reason === "symbolic-link" && x.truncated === null),
			).toBe(true);
			expect(r.changeset.collection.refusals.at(-1)?.path).toBe(`l${String(LIST_MAX - 1).padStart(5, "0")}`);
			expect(r.changeset.collection.refusalsOmitted).toBe(Math.max(0, n - LIST_MAX));
			expect(r.changeset.collection.refusalCounts).toEqual(census({ "symbolic-link": n }));
		};

		it("records each as the agent's refusal, never evaluated, and the run goes on to its remaining trials", async () => {
			const out = fresh("run");
			const spec = specWith(agents, {}, DEFAULT_ENDO_CHANGESET_LIMITS_V0);
			expect(await runProtectedExperimentV0({ spec, dir: out })).toMatchObject({
				attempts: Object.keys(agents).length,
				finalizedOnResume: 0,
			});
			for (const n of PATHS) expectPath(recordOf(out, `path-${n}`), n);
			for (const n of LINKS) expectLinks(recordOf(out, `links-${n}`), n);
			expect(recordOf(out, "honest").evaluation.status).toBe("passed");
			const report = reportProtectedExperimentV0(out);
			expect(report.refusedRecords).toEqual([]);
			for (const c of [...PATHS.map((n) => `path-${n}`), ...LINKS.map((n) => `links-${n}`)])
				expect(report.cells.find((x) => x.condition === c)).toMatchObject({
					qualified: 1,
					failed: 1,
					failedWithoutSubmission: 1,
				});

			// The reader holds the bounds: nothing past them reads, and a record cannot claim an omission or a cut it did not make.
			const reseal = (
				r: EndoProtectedTrialV2,
				mutate: (c: EndoProtectedTrialV2["changeset"]["collection"]) => void,
			) => {
				const { recordSha256: _ignored, ...rest } = structuredClone(r);
				mutate(rest.changeset.collection);
				return () => sealEndoProtectedTrialV0(rest as never);
			};
			const full = recordOf(out, `links-${LIST_MAX + 1}`);
			const cut = recordOf(out, `path-${PATH_MAX + 3}`);
			expect(reseal(full, () => {})).not.toThrow();
			expect(reseal(cut, () => {})).not.toThrow();
			const refused: [string, RegExp, () => unknown][] = [
				[
					"one refusal past the list's bound",
					/refusals is not a list/,
					reseal(full, (c) => {
						c.refusals.push({ path: "l99999", reason: "symbolic-link", truncated: null });
					}),
				],
				[
					"an omission from a list that is not full",
					/omitted only from a full list/,
					reseal(full, (c) => {
						c.refusals.pop();
					}),
				],
				[
					"no count of omitted refusals",
					/missing field refusalsOmitted/,
					reseal(full, (c) => {
						delete (c as Partial<typeof c>).refusalsOmitted;
					}),
				],
				[
					"a path one past the bound, uncut",
					/path is not acceptable text/,
					reseal(cut, (c) => {
						c.refusals[0] = { path: longPath(PATH_MAX + 1), reason: "unsafe-path", truncated: null };
					}),
				],
				[
					"a cut path past the bound",
					/path is not acceptable text/,
					reseal(cut, (c) => {
						(c.refusals[0] as { path: string }).path = longPath(PATH_MAX + 1);
					}),
				],
				[
					"a cut that kept less than the bound",
					/a truncated path keeps the bound's length/,
					reseal(cut, (c) => {
						(c.refusals[0] as { path: string }).path = "a";
					}),
				],
				[
					"a cut claimed for a path within the bound",
					/truncated.length is not an integer in range/,
					reseal(cut, (c) => {
						(c.refusals[0] as { truncated: { length: number } }).truncated.length = PATH_MAX;
					}),
				],
				[
					"no word on whether the path was cut",
					/missing field truncated/,
					reseal(cut, (c) => {
						delete (c.refusals[0] as { truncated?: unknown }).truncated;
					}),
				],
				[
					"a census that is not the listed and omitted refusals",
					/the refusal counts are not the listed and omitted refusals/,
					reseal(full, (c) => {
						c.refusalCounts["symbolic-link"] += 1;
					}),
				],
				[
					"a census with fewer of a reason than the list",
					/the refusal counts list fewer unsafe-path refusals than the record does/,
					reseal(cut, (c) => {
						c.refusalCounts["unsafe-path"] = 0;
						c.refusalCounts["symbolic-link"] = 1;
					}),
				],
				[
					"no census",
					/missing field refusalCounts/,
					reseal(full, (c) => {
						delete (c as Partial<typeof c>).refusalCounts;
					}),
				],
				[
					"a disturbance past the list's bound, without its invalidating condition",
					/invalidating is not what the record's facts imply \(collection-disturbed\)/,
					reseal(full, (c) => {
						c.refusalCounts["symbolic-link"] -= 1;
						c.refusalCounts["changed-during-collection"] = 1;
					}),
				],
			];
			for (const [what, why, seal] of refused) {
				expect(seal, what).toThrow(/unreadable protected-trial record/);
				expect(seal, what).toThrow(why);
			}
		}, 180_000);

		/** Codex's scenario (4656402978): links, then `z.txt`, which sorts after them and changes while the collector reads it. */
		const disturbed = async (links: number) => {
			const out = fresh("run");
			const spec = specWith(
				{
					disturbed: `${linksAgent(links)} fs.writeFileSync("z.txt", "z\\n");`,
				},
				{},
				DEFAULT_ENDO_CHANGESET_LIMITS_V0,
			);
			let attempt = "";
			await runProtectedExperimentV0({
				spec,
				dir: out,
				onBeforeBaselinePinned: (a) => {
					attempt = a;
				},
				changeSetHooksForTests: {
					afterOpen: (rel) => {
						if (rel === "z.txt") writeFileSync(join(attempt, "work", "z.txt"), "changed while read\n");
					},
				},
			});
			const r = recordOf(out, "disturbed");
			expect(r.controller.finalized).toBe("normally");
			expect(r.agent).toMatchObject({ status: "completed", termination: "confirmed" });
			expect(r.changeset.collection.status).toBe("refused");
			expect(r.changeset.collection.refusalCounts).toEqual(
				census({ "symbolic-link": links, "changed-during-collection": 1 }),
			);
			expect(r.changeset.verification.status).toBe("not-run");
			expect(r.evaluation.status).toBe("not-run");
			// The disturbance is the controller's, wherever it falls in the list: attrition, never the agent's failure.
			expect(r.invalidating).toEqual(["collection-disturbed"]);
			expect(endoProtectedTrialOutcomeV0(r)).toEqual({ outcome: "attrition", reason: "collection-disturbed" });
			const { cell, refused } = cellOf(out, "disturbed");
			expect(refused).toEqual([]);
			expect(cell).toMatchObject({ qualified: 0, failed: 0, attrition: { "collection-disturbed": 1 } });
			return r.changeset.collection;
		};

		it("a disturbance the list's bound omits is still attrition: the record derives it from the complete census", async () => {
			const c = await disturbed(LIST_MAX);
			expect(c.refusals).toHaveLength(LIST_MAX);
			expect(c.refusals.every((x) => x.reason === "symbolic-link")).toBe(true);
			expect(c.refusalsOmitted).toBe(1);
		}, 120_000);

		it("a disturbance inside the list's bound is attrition as before", async () => {
			const c = await disturbed(8);
			expect(c.refusalsOmitted).toBe(0);
			expect(c.refusals).toHaveLength(9);
			expect(c.refusals.at(-1)).toEqual({ path: "z.txt", reason: "changed-during-collection", truncated: null });
		}, 120_000);

		it("through an interrupted run and its resume: the agent's refusal stays the agent's, and only the interrupted attempt is attrition", async () => {
			const spec = specWith(
				{
					[`path-${PATH_MAX + 3}`]: pathAgent(PATH_MAX + 3),
					[`links-${LIST_MAX + 1}`]: linksAgent(LIST_MAX + 1),
					sleeper:
						'import fs from "node:fs"; fs.writeFileSync("src/interval.mjs", "x"); setInterval(() => {}, 1000);',
				},
				{},
				DEFAULT_ENDO_CHANGESET_LIMITS_V0,
			);
			const specFile = join(fresh("spec"), "spec.json");
			writeFileSync(specFile, JSON.stringify(spec));
			const out = fresh("run");
			const controller = spawn(process.execPath, [CLI, "experiment", "protected-run", specFile, "--out", out], {
				stdio: "ignore",
			});
			const started = join(attemptOf(out, "sleeper"), "agent-started.json");
			for (let i = 0; i < 1200 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
			expect(existsSync(started)).toBe(true);
			const ns = JSON.parse(readFileSync(started, "utf8")).init;
			controller.kill("SIGKILL");
			await new Promise((r) => controller.on("close", r));
			for (let i = 0; i < 200 && processAliveV0(ns); i++) await new Promise((r) => setTimeout(r, 50));
			expect(await runProtectedExperimentV0({ spec, dir: out })).toMatchObject({ finalizedOnResume: 1 });
			expectPath(recordOf(out, `path-${PATH_MAX + 3}`), PATH_MAX + 3);
			expectLinks(recordOf(out, `links-${LIST_MAX + 1}`), LIST_MAX + 1);
			const sleeper = recordOf(out, "sleeper");
			expect(sleeper.controller.finalized).toBe("on-resume");
			expect(sleeper.invalidating).toEqual(["controller-interrupted", "agent-interrupted"]);
			const report = reportProtectedExperimentV0(out);
			expect(report.refusedRecords).toEqual([]);
			expect(report.cells.find((x) => x.condition === `path-${PATH_MAX + 3}`)).toMatchObject({
				qualified: 1,
				failed: 1,
			});
			expect(report.cells.find((x) => x.condition === `links-${LIST_MAX + 1}`)).toMatchObject({
				qualified: 1,
				failed: 1,
			});
		}, 180_000);
	});

	describe("termination that cannot be confirmed (the runner's test-only seam): nothing collected, nothing evaluated", () => {
		const expectNothingHanded = (r: EndoProtectedTrialV2, attempt: string) => {
			expect(r.agent.termination).toBe("unconfirmed");
			expect(r.agent.scope?.ended).toBe("unconfirmed");
			expect(r.changeset.baseline.status).toBe("pinned");
			expect(r.changeset.collection).toEqual({
				status: "not-collected",
				changesetSha256: null,
				summary: null,
				refusals: [],
				refusalsOmitted: 0,
				refusalCounts: census(),
			});
			expect(r.changeset.verification).toEqual({ status: "not-run", reason: null, candidateSha256: null });
			expect(r.evaluation).toMatchObject({ status: "not-run", cases: null, outputSha256: null });
			expect(r.invalidating).toContain("termination-unconfirmed");
			expect(endoProtectedTrialOutcomeV0(r).outcome).toBe("attrition");
			for (const d of ["changeset", "candidate", ".evaluation", "evaluation-scope.json"])
				expect(existsSync(join(attempt, d)), d).toBe(false);
		};

		it("after a normal attempt: the sealed record says the agent's end was unconfirmed and nothing was handed on", async () => {
			const out = fresh("run");
			const spec = specWith({ honest: ALL_CHANGES(SOLUTION) });
			await runProtectedExperimentV0({ spec, dir: out, unconfirmedTerminationForTests: true });
			const r = recordOf(out, "honest");
			expect(r.controller.finalized).toBe("normally");
			expect(r.agent.status).toBe("completed");
			expectNothingHanded(r, attemptOf(out, "honest"));
			expect(r.invalidating).toEqual(["termination-unconfirmed"]);
			const { cell, refused } = cellOf(out, "honest");
			expect(refused).toEqual([]);
			expect(cell).toMatchObject({ qualified: 0, passed: 0, attrition: { "termination-unconfirmed": 1 } });
		});

		it("on a resume after the controller died: finalized on resume with the agent's end unconfirmed, nothing collected", async () => {
			const spec = specWith({
				sleeper:
					'import fs from "node:fs"; fs.writeFileSync("src/interval.mjs", "x"); setInterval(() => {}, 1000);',
			});
			const specFile = join(fresh("spec"), "spec.json");
			writeFileSync(specFile, JSON.stringify(spec));
			const out = fresh("run");
			const controller = spawn(process.execPath, [CLI, "experiment", "protected-run", specFile, "--out", out], {
				stdio: "ignore",
			});
			const started = join(attemptOf(out, "sleeper"), "agent-started.json");
			for (let i = 0; i < 300 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
			expect(existsSync(started)).toBe(true);
			controller.kill("SIGKILL");
			await new Promise((r) => controller.on("close", r));
			expect(await runProtectedExperimentV0({ spec, dir: out, unconfirmedTerminationForTests: true })).toMatchObject(
				{
					finalizedOnResume: 1,
				},
			);
			const r = recordOf(out, "sleeper");
			expect(r.controller.finalized).toBe("on-resume");
			expect(r.agent.status).toBe("interrupted");
			expectNothingHanded(r, attemptOf(out, "sleeper"));
			expect(r.invalidating).toEqual(["controller-interrupted", "agent-interrupted", "termination-unconfirmed"]);
			expect(cellOf(out, "sleeper").refused).toEqual([]);
		}, 60_000);
	});

	it("fails closed on a staged record whose facts contradict each other, even sealed consistently", async () => {
		const out = fresh("run");
		const spec = specWith({ honest: ALL_CHANGES(SOLUTION) });
		await runProtectedExperimentV0({ spec, dir: out });
		const good = recordOf(out, "honest");
		const { recordSha256: _ignored, ...rest } = good;
		const reseal = (mutate: (r: Record<string, unknown>) => void) => {
			const r = structuredClone(rest) as unknown as Record<string, unknown>;
			mutate(r);
			return () => sealEndoProtectedTrialV0(r as never);
		};
		const cs = (r: Record<string, unknown>) => r.changeset as EndoProtectedTrialV2["changeset"];
		expect(reseal(() => {})).not.toThrow();
		const refusals: [string, RegExp, (r: Record<string, unknown>) => void][] = [
			[
				"collected without confirmed termination",
				/collected only after the agent's termination was confirmed/,
				(r) => {
					(r.agent as { termination: string }).termination = "unconfirmed";
					(r.agent as { scope: { ended: string } }).scope.ended = "unconfirmed";
					r.invalidating = ["termination-unconfirmed"];
				},
			],
			[
				"evaluated though unverified",
				/an evaluation result needs a verified change set/,
				(r) => {
					cs(r).verification = { status: "failed", reason: "staged-bytes-mismatch", candidateSha256: null };
					r.invalidating = ["changeset-unverified"];
				},
			],
			[
				"evaluated though verification did not run",
				/an evaluation result needs a verified change set/,
				(r) => {
					cs(r).verification = { status: "not-run", reason: null, candidateSha256: null };
				},
			],
			[
				"agent ran on an unpinned baseline",
				/an agent is started only on a pinned baseline/,
				(r) => {
					cs(r).baseline.status = "not-pinned";
				},
			],
			[
				"verified without a candidate",
				/names the candidate it reconstructed/,
				(r) => {
					cs(r).verification.candidateSha256 = null;
				},
			],
			[
				"collected without a digest",
				/has a digest and a summary/,
				(r) => {
					cs(r).collection.changesetSha256 = null;
				},
			],
			[
				"unverified change set not invalidating",
				/invalidating is not what the record's facts imply \(changeset-unverified\)/,
				(r) => {
					cs(r).verification = { status: "failed", reason: "baseline-conflict", candidateSha256: null };
					(r.evaluation as Record<string, unknown>).status = "not-run";
					(r.evaluation as Record<string, unknown>).cases = null;
					(r.evaluation as Record<string, unknown>).outputSha256 = null;
				},
			],
			[
				"summary contradicting the pinned baseline",
				/the change set's baseline is not the pinned baseline/,
				(r) => {
					(cs(r).collection.summary as { baselineFiles: number }).baselineFiles = 7;
				},
			],
			[
				"a fixed-path submission in a staged record",
				/unknown field "submission"/,
				(r) => {
					r.submission = { status: "not-collected", files: [], sha256: null, refusals: [] };
				},
			],
			[
				"no change-set evidence at all",
				/missing field changeset/,
				(r) => {
					delete r.changeset;
				},
			],
		];
		for (const [what, why, mutate] of refusals) {
			expect(reseal(mutate), what).toThrow(/unreadable protected-trial record/);
			expect(reseal(mutate), what).toThrow(why);
		}
	});
});
