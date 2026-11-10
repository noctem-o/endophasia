// Behavioural checks (docs/designs/develop-behavioural-checks.md): a planned check that declares what its command is expected to DO (exit
// code and exact standard output), read by what each receipt observed of that behaviour rather than by its exit status.
//
//   1. the plan: an expectation's invariants, and how the brief states it
//   2. the receipt v1: the output's digest always, its first bytes only when asked; derived facts checked; v0 still read
//   3. the runner: the digest is of every byte, kept bytes are bounded, nothing is kept by default
//   4. the rule: one function decides a behavioural outcome; the page's copy agrees with it everywhere
//   5. end to end, through the real CLI in a real repository: a broken parser that exits 0 FAILS the check, the fix passes it; the
//      negative control matters more than the pass
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCheckV0 } from "../adapters/develop/check-runner.ts";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { type EndoDevelopAttemptV0, renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_RECEIPT_LIMITS_V0,
	ENDO_DEVELOP_RECEIPT_SCHEMA_V1,
	type EndoDevelopReceiptV0,
	type EndoReceiptExecutionV0,
	type EndoReceiptOutcomeV0,
	validateEndoDevelopReceiptV0,
} from "../protocol/develop-receipts.ts";
import {
	type EndoVerificationPlanV0,
	endoBehaviourOutcomeV0,
	endoFirstDifferenceV0,
	validateEndoVerificationPlanV0,
} from "../protocol/develop-verification.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { keptStdoutV0 } from "../runtime/contracts/develop-receipts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0, endoKeptStdoutMatchesV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { behaviourOutcome, firstDifference, readAttempts } from "../studio-ui/src/model/attempts-wire.ts";
import { git, haveGit } from "./git-fixtures.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-behaviour-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const refused = (plan: unknown): boolean => {
	try {
		validateEndoVerificationPlanV0(plan);
		return false;
	} catch {
		return true;
	}
};

const PLAN: EndoVerificationPlanV0 = {
	checks: [
		{
			name: "precedence",
			argv: ["node", "calc.mjs", "2+3*4"],
			shows: "multiplication binds tighter than addition",
			expect: { exitCode: 0, stdout: "14\n" },
		},
		{ name: "unit", argv: ["node", "--test"], shows: "the unit tests pass" },
	],
	criteria: [
		{ text: "2+3*4 prints 14", checks: ["precedence"] },
		{ text: "Tests pass", checks: ["unit"] },
	],
};

// ---- 1. the plan --------------------------------------------------------------------------------------------------------------------

describe("an expected behaviour in a plan", () => {
	it("is accepted with an exit code and exact output, empty output included, and a check without one is unchanged", () => {
		expect(validateEndoVerificationPlanV0(clone(PLAN))).toEqual(PLAN);
		const empty = clone(PLAN);
		Object.assign(empty.checks[0]!, { expect: { exitCode: 2, stdout: "" } });
		expect(validateEndoVerificationPlanV0(empty).checks[0]?.expect).toEqual({ exitCode: 2, stdout: "" });
		expect("expect" in validateEndoVerificationPlanV0(clone(PLAN)).checks[1]!).toBe(false);
	});

	it("refuses an expectation that could not be compared or shown exactly", () => {
		const cases: [string, unknown][] = [
			["an exit code over 255", { exitCode: 256, stdout: "x" }],
			["a negative exit code", { exitCode: -1, stdout: "x" }],
			["a fractional exit code", { exitCode: 0.5, stdout: "x" }],
			["no output member", { exitCode: 0 }],
			["an unknown member", { exitCode: 0, stdout: "x", stderr: "" }],
			["a carriage return", { exitCode: 0, stdout: "14\r\n" }],
			["a bidirectional override", { exitCode: 0, stdout: "a\u202eb" }],
			["a control character", { exitCode: 0, stdout: "a\u0007" }],
			["a lone surrogate", { exitCode: 0, stdout: "\ud800" }],
			["output over 4 KiB", { exitCode: 0, stdout: "x".repeat(4097) }],
			["null", null],
		];
		for (const [why, expect_] of cases) {
			const p = clone(PLAN) as unknown as { checks: Record<string, unknown>[] };
			p.checks[0]!.expect = expect_;
			expect(refused(p), why).toBe(true);
		}
		// Line breaks and tabs are text.
		const ok = clone(PLAN);
		Object.assign(ok.checks[0]!, { expect: { exitCode: 0, stdout: "a\tb\nc\n" } });
		expect(refused(ok)).toBe(false);
	});

	it("is stated in the brief: Endophasia's words outside the fence, the bytes and the final line break said, stderr not compared", () => {
		const attempt = {
			schemaVersion: "endo.develop-attempt.v1",
			brief: "endo.develop-brief.v1",
			id: `endo.attempt.${"a".repeat(32)}`,
			projectId: `endo.project.${"b".repeat(32)}`,
			taskId: `endo.task.${"c".repeat(32)}`,
			preparedAtMs: 1,
			task: { revision: 1, projectName: "demo", title: "Fix precedence", description: "", acceptance: "" },
			objective: "Make the calculator respect precedence",
			constraints: "",
			reportBack: "",
			recordedBy: "operator",
			via: "cli",
			verification: clone(PLAN),
		} as EndoDevelopAttemptV0;
		const brief = renderEndoDevelopBriefV0(attempt);
		expect(brief).toContain(
			"What the operator expects it to do: exit with code 0 and write exactly this to standard output (3 bytes as UTF-8; it ends with a line break).",
		);
		expect(brief).toContain("```text\n14\n```");
		expect(brief).toContain("standard error is not compared");
		// The check without an expectation is described as before.
		expect(brief.match(/What the operator expects it to do/g)).toHaveLength(1);
		const silent = clone(attempt) as EndoDevelopAttemptV0 & { verification: EndoVerificationPlanV0 };
		Object.assign(silent.verification.checks[0]!, { expect: { exitCode: 2, stdout: "" } });
		expect(renderEndoDevelopBriefV0(silent)).toContain("exit with code 2 and write nothing to standard output");
	});
});

// ---- 2. the receipt v1 ---------------------------------------------------------------------------------------------------------------

const C = "c".repeat(40);
const T = "d".repeat(40);
function receiptV1(
	stdout: NonNullable<EndoDevelopReceiptV0["output"]["stdout"]>,
	stdoutBytes: number,
	execution: EndoReceiptExecutionV0 = { kind: "exited", code: 0 },
): Record<string, unknown> {
	const outcome: EndoReceiptOutcomeV0 =
		execution.kind !== "exited" ? "inconclusive" : execution.code === 0 ? "passed" : "failed";
	return {
		schemaVersion: ENDO_DEVELOP_RECEIPT_SCHEMA_V1,
		id: `endo.receipt.${"1".repeat(32)}`,
		attemptId: `endo.attempt.${"a".repeat(32)}`,
		projectId: `endo.project.${"b".repeat(32)}`,
		requestedBy: "operator",
		via: "cli",
		observer: { tool: "endo", version: "0.1.0" },
		startedAtMs: 1,
		endedAtMs: 2,
		durationMs: 1,
		repository: { worktree: "/w", commonDir: "/w/.git", linked: false },
		revision: { commit: C, tree: T, branch: null },
		reflog: "compared",
		check: {
			argv: ["node", "calc.mjs"],
			executable: "/usr/bin/node",
			realExecutable: "/usr/bin/node",
			timeoutMs: 1000,
		},
		execution,
		output: { stdoutBytes, stderrBytes: 0, stdout },
		strayProcesses: false,
		escapedProcess: false,
		after: {
			state: "observed",
			sameRepository: true,
			commit: C,
			tree: T,
			clean: true,
			reflogsUnchanged: true,
			rulesUnchanged: true,
		},
		outcome,
		reasons: execution.kind !== "exited" ? [execution.kind] : [],
		limitations: [
			"command-defines-the-check",
			"ignored-files-not-examined",
			"environment-not-recorded",
			"changes-reverted-during-check-not-detected",
			"concurrent-writers-not-excluded",
			"clean-is-gits-stat-based-view",
			"processes-leaving-group-not-tracked",
			"attempt-link-is-operator-declared",
			"unsigned-local-record",
		],
	};
}
const invalid = (v: unknown): boolean => {
	try {
		validateEndoDevelopReceiptV0(v);
		return false;
	} catch {
		return true;
	}
};

describe("a receipt v1 records its output's digest, and its first bytes only when asked", () => {
	it("accepts the digest alone, kept text, and kept text that was cut at its bound", () => {
		expect(invalid(receiptV1({ sha256: sha("14\n"), keep: "off" }, 3))).toBe(false);
		expect(invalid(receiptV1({ sha256: sha("14\n"), keep: "text", text: "14\n", truncated: false }, 3))).toBe(false);
		const max = ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxKeptStdoutBytes;
		expect(
			invalid(receiptV1({ sha256: sha("x"), keep: "text", text: "x".repeat(max), truncated: true }, max + 10)),
		).toBe(false);
		expect(invalid(receiptV1({ sha256: sha("x"), keep: "not-text" }, 3))).toBe(false);
	});

	it("refuses kept text whose facts do not follow from the counts, and a conclusive receipt without a digest", () => {
		const max = ENDO_DEVELOP_RECEIPT_LIMITS_V0.maxKeptStdoutBytes;
		const cases: [string, Record<string, unknown>][] = [
			[
				"text but not truncated, shorter than the output",
				receiptV1({ sha256: sha("1"), keep: "text", text: "1", truncated: false }, 3),
			],
			[
				"truncated, yet all of it",
				receiptV1({ sha256: sha("14\n"), keep: "text", text: "14\n", truncated: true }, 3),
			],
			[
				"cut well short of the bound",
				receiptV1({ sha256: sha("x"), keep: "text", text: "xx", truncated: true }, max + 1),
			],
			[
				"longer than the bound",
				receiptV1({ sha256: null, keep: "text", text: "x".repeat(max + 1), truncated: true }, max + 9, {
					kind: "timed-out",
				}),
			],
			["longer than the output", receiptV1({ sha256: sha("abc"), keep: "text", text: "abc", truncated: false }, 2)],
			["no digest on a pass", receiptV1({ sha256: null, keep: "off" }, 3)],
			["a digest that is not one", receiptV1({ sha256: "zz", keep: "off" }, 3)],
			["an unknown keep", receiptV1({ sha256: sha(""), keep: "some" } as never, 0)],
			["text on 'off'", receiptV1({ sha256: sha(""), keep: "off", text: "" } as never, 0)],
		];
		for (const [why, r] of cases) expect(invalid(r), why).toBe(true);
		// A v1 receipt must have its stdout; a v0 must not.
		const v1 = receiptV1({ sha256: sha(""), keep: "off" }, 0) as { output: Record<string, unknown> };
		delete v1.output.stdout;
		expect(invalid(v1)).toBe(true);
		const v0 = receiptV1({ sha256: sha(""), keep: "off" }, 0);
		v0.schemaVersion = "endo.develop-receipt.v0";
		expect(invalid(v0)).toBe(true);
		delete (v0.output as Record<string, unknown>).stdout;
		expect(invalid(v0)).toBe(false);
		// An inconclusive receipt (output not read whole) may lack its digest.
		expect(invalid(receiptV1({ sha256: null, keep: "off" }, 3, { kind: "output-limit" }))).toBe(false);
	});

	it("the store refuses kept text that is not what the digest says (a forged or damaged output)", () => {
		const good = validateEndoDevelopReceiptV0(
			receiptV1({ sha256: sha("14\n"), keep: "text", text: "14\n", truncated: false }, 3),
		);
		expect(endoKeptStdoutMatchesV0(good)).toBe(true);
		const forged = validateEndoDevelopReceiptV0(
			receiptV1({ sha256: sha("20\n"), keep: "text", text: "14\n", truncated: false }, 3),
		);
		expect(endoKeptStdoutMatchesV0(forged)).toBe(false);
		const root = fresh("store");
		const attemptId = forged.attemptId;
		const dir = join(root, "develop", "receipts", attemptId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${forged.id}.json`), JSON.stringify(forged));
		const read = new DevelopReceiptsStoreV0(root).read(attemptId);
		expect(read.ok && read.receipts).toEqual([]);
		expect(read.ok && read.problems).toEqual([{ name: `${forged.id}.json`, reason: "invalid" }]);
	});

	it("keeps text only up to a whole character, and keeps nothing that is not UTF-8", () => {
		const out = (bytes: Buffer, total: number) =>
			keptStdoutV0({ output: { stdoutBytes: total, stderrBytes: 0 }, stdout: { sha256: sha(bytes), kept: bytes } });
		expect(out(Buffer.from("14\n"), 3)).toEqual({
			sha256: sha("14\n"),
			keep: "text",
			text: "14\n",
			truncated: false,
		});
		// "é" is two bytes; a cut after its first byte keeps the text before it.
		const cut = Buffer.from("aé", "utf8").subarray(0, 2);
		expect(out(cut, 10)).toMatchObject({ keep: "text", text: "a", truncated: true });
		expect(out(Buffer.from([0xff, 0xfe, 0x00]), 3)).toMatchObject({ keep: "not-text" });
		expect(
			keptStdoutV0({ output: { stdoutBytes: 3, stderrBytes: 0 }, stdout: { sha256: sha("x"), kept: null } }),
		).toEqual({
			sha256: sha("x"),
			keep: "off",
		});
	});
});

// ---- 3. the runner -------------------------------------------------------------------------------------------------------------------

describe("the check runner hashes standard output and keeps it only when asked", () => {
	const run = (script: string, keep = 0) =>
		runCheckV0({
			executable: process.execPath,
			args: ["-e", script],
			cwd: base,
			env: { PATH: process.env.PATH ?? "" },
			timeoutMs: 20_000,
			maxOutputBytes: 1024 * 1024,
			keepStdoutBytes: keep,
			stdout: new PassThrough().resume(),
			stderr: new PassThrough().resume(),
		});

	it("the digest is of every byte written, across chunks; nothing is kept by default", async () => {
		const r = await run(
			"for (let i = 0; i < 300; i++) process.stdout.write('line ' + i + '\\n'); process.stderr.write('noise')",
		);
		const expected = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join("");
		expect(r.stdout.sha256).toBe(sha(expected));
		expect(r.stdout.kept).toBeNull();
		expect(r.output.stdoutBytes).toBe(Buffer.byteLength(expected));
	});

	it("keeps at most the bound, and the digest still covers everything", async () => {
		const r = await run("process.stdout.write('x'.repeat(10000))", 100);
		expect(r.stdout.kept?.length).toBe(100);
		expect(r.stdout.sha256).toBe(sha("x".repeat(10000)));
	});

	it("records no digest for output cut off at the limit", async () => {
		const r = await runCheckV0({
			executable: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(5000))"],
			cwd: base,
			env: { PATH: process.env.PATH ?? "" },
			timeoutMs: 20_000,
			maxOutputBytes: 1000,
			stdout: new PassThrough().resume(),
			stderr: new PassThrough().resume(),
		});
		expect(r.execution.kind).toBe("output-limit");
		expect(r.stdout.sha256).toBeNull();
	});
});

// ---- 4. the rule ---------------------------------------------------------------------------------------------------------------------

describe("one rule reads a receipt against an expected behaviour", () => {
	const E = { exitCode: 0, stdoutSha256: sha("14\n") };
	it("passes only the expected exit code with the expected output; exit 0 with the wrong output FAILS", () => {
		const r = (outcome: EndoReceiptOutcomeV0, execution: EndoReceiptExecutionV0, stdoutSha256: string | null) =>
			endoBehaviourOutcomeV0({ outcome, execution, stdoutSha256 }, E);
		expect(r("passed", { kind: "exited", code: 0 }, sha("14\n"))).toBe("passed");
		expect(r("passed", { kind: "exited", code: 0 }, sha("20\n"))).toBe("failed");
		expect(r("failed", { kind: "exited", code: 1 }, sha("14\n"))).toBe("failed");
		expect(r("passed", { kind: "exited", code: 0 }, null)).toBe("inconclusive");
		expect(r("inconclusive", { kind: "exited", code: 0 }, sha("14\n"))).toBe("inconclusive");
		expect(r("inconclusive", { kind: "timed-out" }, null)).toBe("inconclusive");
		// An expected failure: exiting 2 with the expected (empty) output passes the behaviour, though the receipt "failed".
		expect(
			endoBehaviourOutcomeV0(
				{ outcome: "failed", execution: { kind: "exited", code: 2 }, stdoutSha256: sha("") },
				{ exitCode: 2, stdoutSha256: sha("") },
			),
		).toBe("passed");
	});

	it("the page's copy agrees with the protocol's over every combination", () => {
		const executions: EndoReceiptExecutionV0[] = [
			{ kind: "exited", code: 0 },
			{ kind: "exited", code: 1 },
			{ kind: "exited", code: 2 },
			{ kind: "signaled", signal: "SIGKILL" },
			{ kind: "timed-out" },
		];
		for (const outcome of ["passed", "failed", "inconclusive"] as const)
			for (const execution of executions)
				for (const digest of [sha("14\n"), sha("20\n"), null])
					for (const expected of [E, { exitCode: 2, stdoutSha256: sha("20\n") }]) {
						const protocol = endoBehaviourOutcomeV0({ outcome, execution, stdoutSha256: digest }, expected);
						const page = behaviourOutcome(
							{ outcome, execution, stdout: { sha256: digest, bytes: 3, recorded: true } },
							expected,
						);
						expect(page, JSON.stringify([outcome, execution, digest, expected])).toBe(protocol);
					}
	});

	it("points at the first differing line, and never decides anything", () => {
		expect(endoFirstDifferenceV0("14\n", "14\n")).toBeNull();
		expect(endoFirstDifferenceV0("14\n", "20\n")).toEqual({ line: 1, expected: "14", observed: "20" });
		expect(endoFirstDifferenceV0("a\nb\n", "a\n")).toEqual({ line: 2, expected: "b", observed: "" });
		expect(endoFirstDifferenceV0("a", "a\n")).toEqual({ line: 2, expected: null, observed: "" });
		const texts = ["", "\n", "a", "a\n", "a\nb", "a\nb\n", "a\nc\n", "b\n", "\n\n", "a\tb\n"];
		for (const x of texts) for (const y of texts) expect(firstDifference(x, y)).toEqual(endoFirstDifferenceV0(x, y));
	});
});

// ---- 5. end to end -------------------------------------------------------------------------------------------------------------------

/** A tiny calculator. BROKEN evaluates left to right (2+3*4 = 20) and still exits 0; FIXED respects precedence (14). */
const CALC_BROKEN = `const e = process.argv[2] ?? "";
if (!/^\\d+([+*]\\d+)*$/.test(e)) { process.stderr.write("cannot parse\\n"); process.exit(2); }
const t = e.match(/\\d+|[+*]/g);
let v = Number(t[0]);
for (let i = 1; i < t.length; i += 2) v = t[i] === "+" ? v + Number(t[i + 1]) : v * Number(t[i + 1]);
process.stdout.write(v + "\\n");
`;
const CALC_FIXED = `const e = process.argv[2] ?? "";
if (!/^\\d+([+*]\\d+)*$/.test(e)) { process.stderr.write("cannot parse\\n"); process.exit(2); }
const sum = e.split("+").map((p) => p.split("*").reduce((a, b) => a * Number(b), 1)).reduce((a, b) => a + b, 0);
process.stdout.write(sum + "\\n");
`;

describe.skipIf(!haveGit)(
	"end to end: a behavioural check rejects a broken CLI that exits 0, and accepts the fix",
	() => {
		const HOME = fresh("home");
		const endo = (args: string[]) =>
			spawnSync(process.execPath, [CLI, ...args], {
				cwd: base,
				encoding: "utf8",
				env: { ...process.env, HOME, XDG_CONFIG_HOME: join(HOME, ".config") },
				timeout: 60_000,
			});
		const commit = (project: string, message: string) =>
			git(project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-am", message);

		it("the negative control, then the fix, with the evidence an operator reads", async () => {
			const root = fresh("store");
			const project = fresh("repo");
			git(project, "init", "-q", "-b", "main");
			writeFileSync(join(project, "calc.mjs"), CALC_BROKEN);
			git(project, "add", ".");
			commit(project, "a calculator, evaluating left to right");
			const p = JSON.parse(
				endo(["project", "add", "--root", root, "--name", "calc", "--path", project]).stdout,
			).project;
			const t = JSON.parse(
				endo(["task", "add", "--root", root, "--project", p.id, "--title", "Respect operator precedence"]).stdout,
			).task;
			const plan: EndoVerificationPlanV0 = {
				checks: [
					{
						name: "precedence",
						argv: ["node", "calc.mjs", "2+3*4"],
						shows: "2+3*4 is 14: multiplication first",
						expect: { exitCode: 0, stdout: "14\n" },
					},
					{
						name: "rejects-garbage",
						argv: ["node", "calc.mjs", "2+"],
						shows: "an incomplete expression is refused, with nothing on stdout",
						expect: { exitCode: 2, stdout: "" },
					},
				],
				criteria: [
					{ text: "Multiplication binds tighter than addition", checks: ["precedence"] },
					{ text: "Malformed input is still refused", checks: ["rejects-garbage"] },
					{ text: "The change is small and readable", checks: [] },
				],
			};
			const planFile = join(fresh("plan"), "plan.json");
			writeFileSync(planFile, JSON.stringify(plan));
			const prepared = endo([
				"attempt",
				"prepare",
				"--root",
				root,
				"--project",
				p.id,
				"--task",
				t.id,
				"--objective",
				"Make 2+3*4 print 14",
				"--plan-file",
				planFile,
			]);
			expect(prepared.status, prepared.stderr).toBe(0);
			const id = JSON.parse(prepared.stdout).attempt.attempt.id as string;
			const brief = endo(["attempt", "brief", "--root", root, "--attempt", id]).stdout;
			expect(brief).toContain("exit with code 0 and write exactly this to standard output (3 bytes as UTF-8");

			const check = (keep: boolean, ...argv: string[]) =>
				endo([
					"attempt",
					"check",
					"--root",
					root,
					"--attempt",
					id,
					...(keep ? ["--keep-output"] : []),
					"--",
					...argv,
				]);
			const evidence = () => endo(["attempt", "evidence", "--root", root, "--attempt", id]);

			// --- the negative control: the broken calculator exits 0 and prints 20 ---
			const broken = check(true, "node", "calc.mjs", "2+3*4");
			// The receipt says what it always said: the command exited 0.
			expect(broken.status).toBe(0);
			expect(broken.stderr).toContain("WILL BE STORED in the receipt");
			const brokenReceipt = JSON.parse(broken.stdout).receipt.receipt as EndoDevelopReceiptV0;
			expect(brokenReceipt.output.stdout).toEqual({
				sha256: sha("20\n"),
				keep: "text",
				text: "20\n",
				truncated: false,
			});
			expect(check(false, "node", "calc.mjs", "2+").status).toBe(3); // exits 2: the receipt "failed", the behaviour holds
			let e = JSON.parse(evidence().stdout).evidence;
			expect(e.verification.checks.map((c: { name: string; state: string }) => [c.name, c.state])).toEqual([
				["precedence", "failed"],
				["rejects-garbage", "passed"],
			]);
			expect(e.verification.criteria.map((c: { state: string }) => c.state)).toEqual([
				"failed",
				"passed",
				"judgment",
			]);
			const brokenText = evidence().stderr;
			expect(brokenText).toContain(
				'  behaviour [plan: expected; observed] expected exit 0 and 3 byte(s) of output; observed exit 0, 3 byte(s), output different; first difference at line 1: expected "14", observed "20"',
			);
			expect(brokenText).toContain(
				"  behaviour [plan: expected; observed] expected exit 2 and 0 byte(s) of output; observed exit 2, 0 byte(s), output the same",
			);

			// --- the fix ---
			writeFileSync(join(project, "calc.mjs"), CALC_FIXED);
			commit(project, "respect precedence");
			expect(check(false, "node", "calc.mjs", "2+3*4").status).toBe(0);
			expect(check(false, "node", "calc.mjs", "2+").status).toBe(3);
			e = JSON.parse(evidence().stdout).evidence;
			expect(e.verification.checks.map((c: { state: string }) => c.state)).toEqual(["passed", "passed"]);
			expect(e.verification.checks[0].otherCommit.outcome).toBe("failed"); // the broken commit, still on record
			expect(e.verification.criteria.map((c: { state: string }) => c.state)).toEqual([
				"passed",
				"passed",
				"judgment",
			]);
			const fixedText = evidence().stderr;
			expect(fixedText).toContain("observed exit 0, 3 byte(s), output the same");
			// The expected exit 2 is not a "check did not pass" gap: the ledger reads that command by its behaviour, and the line says so.
			expect(e.gaps.map((g: { code: string }) => g.code)).not.toContain("check-not-passed-at-current-head");
			expect(e.gaps.map((g: { code: string }) => g.code)).not.toContain("planned-check-not-passed-at-current-head");
			expect(fixedText).toContain("node calc.mjs 2+: Observed check failed at");
			expect(fixedText).toContain("(exit status only: the plan reads this command by its behaviour, below)");

			// The page's view, through the page's own gate; then a forged pass is refused whole.
			const seen = await new GitRevisionObserverV0({ env: { HOME } }).observe(project, { within: true });
			if (!seen.ok) throw new Error("unobservable");
			const current = {
				worktree: seen.observation.worktree,
				commonDir: seen.observation.commonDir,
				commit: seen.observation.commit,
				clean: seen.observation.dirty.length === 0,
			};
			new DevelopTasksStoreV0(root).selectTask(p.id, t.id);
			const service = new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root));
			const view = service.viewFor(p.id, { store: new DevelopReceiptsStoreV0(root), current });
			const page = readAttempts(clone(view));
			const checks = page?.attempts[0]?.verification?.checks;
			expect(
				checks?.map((c) => [c.state, c.behaviour?.observed?.stdoutSha256 === c.behaviour?.expected.stdoutSha256]),
			).toEqual([
				["passed", true],
				["passed", true],
			]);
			// No output was kept at HEAD (only for the broken commit), and the receipts list never carries output.
			expect(checks?.[0]?.behaviour?.observed?.kept).toEqual({ state: "off" });
			expect(JSON.stringify(page?.attempts[0]?.receipts)).not.toContain('"text"');
			// Forgery: claim the broken commit's receipt matched by giving the expectation its digest. The gate re-derives and refuses.
			const forged = clone(view);
			const fc = forged.attempts[0]!.verification!.checks[0]!;
			fc.behaviour!.expected.stdoutSha256 = sha("nonsense");
			expect(readAttempts(forged)).toBeNull();
			// Other forgeries, each refused whole: an observation of another receipt, another exit code or digest, a v0 "not recorded" claim
			// for a v1 receipt, a conclusive receipt with no digest, an observation with no receipt at HEAD.
			const forgeries: [string, (v: typeof view) => void][] = [
				[
					"another receipt",
					(v) =>
						Object.assign(v.attempts[0]!.verification!.checks[0]!.behaviour!.observed!, {
							receiptId: `endo.receipt.${"9".repeat(32)}`,
						}),
				],
				[
					"another exit code",
					(v) => Object.assign(v.attempts[0]!.verification!.checks[0]!.behaviour!.observed!, { exitCode: 1 }),
				],
				[
					"another digest",
					(v) =>
						Object.assign(v.attempts[0]!.verification!.checks[0]!.behaviour!.observed!, {
							stdoutSha256: sha("20\n"),
						}),
				],
				[
					"not recorded",
					(v) =>
						Object.assign(v.attempts[0]!.verification!.checks[0]!.behaviour!.observed!, {
							kept: { state: "not-recorded" },
						}),
				],
				[
					"no digest on a pass",
					(v) => Object.assign(v.attempts[0]!.receipts.list.at(-2)!.stdout, { sha256: null }),
				],
				[
					"an observation with no receipt at HEAD",
					(v) => Object.assign(v.attempts[0]!.verification!.checks[0]!, { current: null }),
				],
			];
			for (const [why, forge] of forgeries) {
				const v = clone(view);
				forge(v);
				expect(readAttempts(v), why).toBeNull();
			}

			// For the record: the evidence an operator reads, written where a demo asks (docs/designs/develop-behavioural-checks.md).
			const out = process.env.ENDO_DEMO_DIR;
			if (out !== undefined && out !== "") {
				writeFileSync(join(out, "broken-check.stderr.txt"), broken.stderr);
				writeFileSync(join(out, "broken-receipt.json"), `${JSON.stringify(brokenReceipt, null, 2)}\n`);
				writeFileSync(join(out, "evidence-broken.txt"), brokenText);
				writeFileSync(join(out, "evidence-fixed.txt"), fixedText);
			}
			// Nothing was written in the repository.
			expect(readdirSync(project).sort()).toEqual([".git", "calc.mjs"]);
			expect(readFileSync(join(project, "calc.mjs"), "utf8")).toBe(CALC_FIXED);
		});
	},
);
