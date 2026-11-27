// Comprehensive unit and real-Vitest integration tests for fail-closed actual test execution accounting
// and confidential failure summarization (CI-RELIABILITY-001 Follow-up: F3 & F6).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyFailureSignature,
	escapeMarkdownCell,
	formatMarkdownCodeSpan,
	reconcileVitestExecution,
	sanitizeBoundedLabel,
	validateStrictPassthroughArgs,
} from "../scripts/reconcile-test-execution.mjs";
import { partitionTestFiles } from "../scripts/test-inventory.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const cleanupDirs: string[] = [];

afterEach(() => {
	while (cleanupDirs.length > 0) {
		rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
	}
});

function makeScratch(prefix = "endo-reconcile-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

function writeSyntheticReport(
	scratch: string,
	repoRoot: string,
	overrides: {
		startTime?: number;
		success?: boolean;
		numTotalTests?: number;
		numPassedTests?: number;
		numFailedTests?: number;
		numPendingTests?: number;
		numTodoTests?: number;
		numFailedTestSuites?: number;
		numPendingTestSuites?: number;
		testResults?: Array<Record<string, unknown>>;
	},
): string {
	const now = Date.now();
	const defaultResults = [
		{
			name: join(repoRoot, "tests", "alpha.test.ts"),
			status: "passed",
			startTime: now,
			endTime: now + 20,
			message: "",
			assertionResults: [{ fullName: "alpha passes", status: "passed", failureMessages: [] }],
		},
		{
			name: join(repoRoot, "tests", "beta.test.ts"),
			status: "passed",
			startTime: now,
			endTime: now + 30,
			message: "",
			assertionResults: [{ fullName: "beta passes", status: "passed", failureMessages: [] }],
		},
	];
	const payload = {
		startTime: overrides.startTime ?? now,
		success: overrides.success ?? true,
		numTotalTestSuites: 2,
		numPassedTestSuites: 2,
		numFailedTestSuites: overrides.numFailedTestSuites ?? 0,
		numPendingTestSuites: overrides.numPendingTestSuites ?? 0,
		numTotalTests: overrides.numTotalTests ?? 2,
		numPassedTests: overrides.numPassedTests ?? 2,
		numFailedTests: overrides.numFailedTests ?? 0,
		numPendingTests: overrides.numPendingTests ?? 0,
		numTodoTests: overrides.numTodoTests ?? 0,
		testResults: overrides.testResults ?? defaultResults,
	};
	const reportPath = join(scratch, "report.json");
	writeFileSync(reportPath, JSON.stringify(payload), "utf8");
	return reportPath;
}

describe("F3 fail-closed execution accounting (unit matrix)", () => {
	it("passes when observed files exactly match expected files and all outcomes are consistent", () => {
		const scratch = makeScratch();
		const fakeRepo = join(scratch, "repo");
		mkdirSync(join(fakeRepo, "tests"), { recursive: true });
		const t0 = Date.now();
		const reportPath = writeSyntheticReport(scratch, fakeRepo, { startTime: t0 });
		const res = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(res.errors).toEqual([]);
		expect(res.ok).toBe(true);
		expect(res.summary.observedFileCount).toBe(2);
		expect(res.summary.passedTests).toBe(2);
	});

	it("fails on missing expected file, unexpected file, duplicate file, zero-test file, and inconsistent totals", () => {
		const scratch = makeScratch();
		const fakeRepo = join(scratch, "repo");
		mkdirSync(join(fakeRepo, "tests"), { recursive: true });
		const t0 = Date.now();

		// Missing expected file
		const missingReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 1,
			numPassedTests: 1,
			testResults: [
				{
					name: join(fakeRepo, "tests", "alpha.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }],
				},
			],
		});
		const missingRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath: missingReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(missingRes.ok).toBe(false);
		expect(missingRes.errors.some((e) => e.code === "MISSING_EXPECTED_FILES")).toBe(true);

		// Unexpected file
		const extraReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 3,
			numPassedTests: 3,
			testResults: [
				{
					name: join(fakeRepo, "tests", "alpha.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }],
				},
				{
					name: join(fakeRepo, "tests", "beta.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "b", status: "passed", failureMessages: [] }],
				},
				{
					name: join(fakeRepo, "tests", "sneaky.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "s", status: "passed", failureMessages: [] }],
				},
			],
		});
		const extraRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath: extraReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(extraRes.ok).toBe(false);
		expect(extraRes.errors.some((e) => e.code === "UNEXPECTED_FILES")).toBe(true);

		// Duplicate report entry
		const dupReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 2,
			numPassedTests: 2,
			testResults: [
				{
					name: join(fakeRepo, "tests", "alpha.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }],
				},
				{
					name: join(fakeRepo, "tests", "alpha.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }],
				},
			],
		});
		const dupRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts"],
			reportPath: dupReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(dupRes.ok).toBe(false);
		expect(dupRes.errors.some((e) => e.code === "DUPLICATE_FILE_REPORT")).toBe(true);

		// Zero-test file
		const zeroReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 0,
			numPassedTests: 0,
			testResults: [
				{
					name: join(fakeRepo, "tests", "alpha.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [],
				},
			],
		});
		const zeroRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts"],
			reportPath: zeroReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(zeroRes.ok).toBe(false);
		expect(zeroRes.errors.some((e) => e.code === "ZERO_TEST_FILE")).toBe(true);

		// Inconsistent aggregate totals (both numTotalTests mismatch and inflated numPendingTests mismatch)
		const badTotalsReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 99,
			numPassedTests: 2,
		});
		const badTotalsRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath: badTotalsReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(badTotalsRes.ok).toBe(false);
		expect(badTotalsRes.errors.some((e) => e.code === "AGGREGATE_MISMATCH")).toBe(true);

		const inflatedPendingReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 2,
			numPassedTests: 2,
			numPendingTests: 99,
		});
		const inflatedPendingRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath: inflatedPendingReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(inflatedPendingRes.ok).toBe(false);
		expect(inflatedPendingRes.errors.some((e) => e.code === "AGGREGATE_MISMATCH")).toBe(true);

		// Empty expected set must fail closed
		const emptyExpectedRes = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: [],
			reportPath: writeSyntheticReport(scratch, fakeRepo, {
				startTime: t0,
				numTotalTests: 0,
				numPassedTests: 0,
				testResults: [],
			}),
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 100,
			vitestExitCode: 0,
		});
		expect(emptyExpectedRes.ok).toBe(false);
		expect(emptyExpectedRes.errors.some((e) => e.code === "EMPTY_EXPECTED_SET")).toBe(true);
	});

	it("fails on missing, corrupt, and stale reports, and never overrides a nonzero Vitest exit code", () => {
		const scratch = makeScratch();
		const fakeRepo = join(scratch, "repo");
		mkdirSync(join(fakeRepo, "tests"), { recursive: true });
		const t0 = Date.now();

		// Missing report
		const missing = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts"],
			reportPath: join(scratch, "absent.json"),
			startedAtMs: t0,
			endedAtMs: t0 + 50,
			vitestExitCode: 0,
		});
		expect(missing.ok).toBe(false);
		expect(missing.errors.some((e) => e.code === "MISSING_REPORT")).toBe(true);

		// Corrupt JSON report containing a secret token: fails closed and NEVER echoes raw JSON excerpt (F6 HIGH #1).
		const corruptPath = join(scratch, "corrupt.json");
		writeFileSync(corruptPath, '{"success": true, "failureMessages": ["Bearer sk-corrupt-secret-12345"', "utf8");
		const corrupt = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts"],
			reportPath: corruptPath,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 50,
			vitestExitCode: 0,
		});
		expect(corrupt.ok).toBe(false);
		expect(corrupt.errors.some((e) => e.code === "CORRUPT_REPORT")).toBe(true);
		expect(JSON.stringify(corrupt.errors)).not.toContain("sk-corrupt-secret-12345");

		// Stale report (mtime older than invocation start)
		const stalePath = writeSyntheticReport(scratch, fakeRepo, { startTime: t0 - 60_000 });
		const oldSec = (t0 - 60_000) / 1000;
		utimesSync(stalePath, oldSec, oldSec);
		const stale = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath: stalePath,
			startedAtMs: t0,
			endedAtMs: t0 + 50,
			vitestExitCode: 0,
		});
		expect(stale.ok).toBe(false);
		expect(stale.errors.some((e) => e.code === "STALE_REPORT")).toBe(true);

		// Nonzero exit code always fails even if report says success
		const okPath = writeSyntheticReport(scratch, fakeRepo, { startTime: t0 });
		const nonzero = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/beta.test.ts"],
			reportPath: okPath,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 50,
			vitestExitCode: 1,
		});
		expect(nonzero.ok).toBe(false);
		expect(nonzero.errors.some((e) => e.code === "VITEST_NONZERO_EXIT")).toBe(true);
	});

	it("fails when a mandatory suite is entirely skipped, and passes with accounting for permitted optional suites", () => {
		const scratch = makeScratch();
		const fakeRepo = join(scratch, "repo");
		mkdirSync(join(fakeRepo, "tests"), { recursive: true });
		const t0 = Date.now();
		const skippedReport = writeSyntheticReport(scratch, fakeRepo, {
			startTime: t0,
			numTotalTests: 2,
			numPassedTests: 1,
			numPendingTests: 1,
			testResults: [
				{
					name: join(fakeRepo, "tests", "alpha.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "a", status: "passed", failureMessages: [] }],
				},
				{
					name: join(fakeRepo, "tests", "optional-raw.test.ts"),
					status: "passed",
					startTime: t0,
					endTime: t0 + 10,
					message: "",
					assertionResults: [{ fullName: "opt", status: "skipped", failureMessages: [] }],
				},
			],
		});

		// Without allowlist entry -> mandatory suite all-skipped FAILS!
		const mandatoryFail = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/optional-raw.test.ts"],
			reportPath: skippedReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 50,
			vitestExitCode: 0,
		});
		expect(mandatoryFail.ok).toBe(false);
		expect(mandatoryFail.errors.some((e) => e.code === "MANDATORY_SUITE_ALL_SKIPPED")).toBe(true);

		// With explicit allowlist entry -> PASSES with explicit accounting!
		const optionalPass = reconcileVitestExecution({
			repoRoot: fakeRepo,
			expectedFiles: ["tests/alpha.test.ts", "tests/optional-raw.test.ts"],
			reportPath: skippedReport,
			startedAtMs: t0 - 50,
			endedAtMs: t0 + 50,
			vitestExitCode: 0,
			permittedOptionalWholeFileSkips: {
				"tests/optional-raw.test.ts": "opt-in raw data archive",
			},
		});
		expect(optionalPass.errors).toEqual([]);
		expect(optionalPass.ok).toBe(true);
		expect(optionalPass.summary.permittedWholeFileSkips).toEqual([
			{ file: "tests/optional-raw.test.ts", skipped: 1, reason: "opt-in raw data archive" },
		]);
	});

	it("rejects all passthrough flags unconditionally in strict accounting mode and separates local partial runs", () => {
		expect(validateStrictPassthroughArgs(["-t", "subset"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["--no-isolate"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["--passWithNoTests"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["--retry=3"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["--config", "other.ts"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["--allowOnly"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["--no-file-parallelism"]).length).toBeGreaterThan(0);
		expect(validateStrictPassthroughArgs(["tests/only-one.test.ts"]).length).toBeGreaterThan(0);

		const fastCount = partitionTestFiles(REPO_ROOT).classes.fast.length;
		const rejected = spawnSync(
			process.execPath,
			[
				join(REPO_ROOT, "scripts", "run-test-partition.mjs"),
				"--class=fast",
				`--shard=${fastCount}/${fastCount}`,
				"--strict-accounting",
				"--",
				"-t",
				"should-be-refused",
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toMatch(/passthrough argument not allowed/i);

		// Without --strict-accounting, targeted local runs remain usable and clearly announce partial-local mode.
		const dryLocal = spawnSync(
			process.execPath,
			[
				join(REPO_ROOT, "scripts", "run-test-partition.mjs"),
				"--class=fast",
				`--shard=${fastCount}/${fastCount}`,
				"--dry-run",
				"--",
				"-t",
				"local-only",
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		expect(dryLocal.status).toBe(0);
		expect(JSON.parse(dryLocal.stdout).mode).toBe("partial-local");
	});
});

describe("F3 real installed Vitest integration & F6 confidentiality", () => {
	it("reconciles real Vitest runs against synthetic test files (pass, mandatory all-skipped fail, and confidential failure)", () => {
		const scratch = makeScratch("endo-real-vitest-");
		const testsDir = join(scratch, "tests");
		mkdirSync(testsDir, { recursive: true });
		symlinkSync(join(REPO_ROOT, "node_modules"), join(scratch, "node_modules"), "dir");
		writeFileSync(
			join(scratch, "vitest.config.mjs"),
			'export default { test: { environment: "node", include: ["tests/**/*.test.ts"] } };\n',
			"utf8",
		);
		writeFileSync(
			join(testsDir, "ok.test.ts"),
			'import { expect, it } from "vitest";\nit("passes cleanly", () => { expect(1 + 1).toBe(2); });\n',
			"utf8",
		);
		writeFileSync(
			join(testsDir, "all-skipped.test.ts"),
			'import { it } from "vitest";\nit.skip("accidentally skipped mandatory test", () => {});\n',
			"utf8",
		);
		writeFileSync(
			join(testsDir, "secret-fail.test.ts"),
			[
				'import { expect, it } from "vitest";',
				'it("fails with \\n### Injected Markdown and secret payload", () => {',
				'  expect("Bearer sk-top-secret-token-9999").toBe("http://127.0.0.1:4321/deadbeef00112233/cap");',
				"});",
				"",
			].join("\n"),
			"utf8",
		);

		const vitestBin = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
		const runVitest = (relFiles: string[], reportName: string) => {
			const reportPath = join(scratch, reportName);
			const t0 = Date.now();
			const run = spawnSync(
				process.execPath,
				[
					vitestBin,
					"run",
					"--config",
					join(scratch, "vitest.config.mjs"),
					"--root",
					scratch,
					"--maxWorkers=1",
					"--reporter=json",
					`--outputFile.json=${reportPath}`,
					...relFiles.map((f) => join(scratch, f)),
				],
				{ cwd: scratch, encoding: "utf8" },
			);
			const t1 = Date.now();
			return { run, reportPath, t0, t1 };
		};

		// 1. Passing real Vitest run reconciles PASS.
		const passRun = runVitest(["tests/ok.test.ts"], "pass.json");
		expect(passRun.run.status, passRun.run.stderr || passRun.run.stdout).toBe(0);
		const passRec = reconcileVitestExecution({
			repoRoot: scratch,
			expectedFiles: ["tests/ok.test.ts"],
			reportPath: passRun.reportPath,
			startedAtMs: passRun.t0,
			endedAtMs: passRun.t1,
			vitestExitCode: passRun.run.status ?? 1,
		});
		expect(passRec.errors).toEqual([]);
		expect(passRec.ok).toBe(true);

		// 2. Mandatory suite entirely skipped: Vitest exits 0, but reconciliation FAILS CLOSED!
		const skipRun = runVitest(["tests/ok.test.ts", "tests/all-skipped.test.ts"], "skip.json");
		expect(skipRun.run.status).toBe(0);
		const skipRec = reconcileVitestExecution({
			repoRoot: scratch,
			expectedFiles: ["tests/ok.test.ts", "tests/all-skipped.test.ts"],
			reportPath: skipRun.reportPath,
			startedAtMs: skipRun.t0,
			endedAtMs: skipRun.t1,
			vitestExitCode: skipRun.run.status ?? 1,
		});
		expect(skipRec.ok).toBe(false);
		expect(skipRec.errors.some((e) => e.code === "MANDATORY_SUITE_ALL_SKIPPED")).toBe(true);

		// 3. Real failing test with secrets & Markdown injection: exits nonzero AND failure summary strips raw secrets!
		const failRun = runVitest(["tests/secret-fail.test.ts"], "fail.json");
		expect(failRun.run.status).not.toBe(0);
		const failRec = reconcileVitestExecution({
			repoRoot: scratch,
			expectedFiles: ["tests/secret-fail.test.ts"],
			reportPath: failRun.reportPath,
			startedAtMs: failRun.t0,
			endedAtMs: failRun.t1,
			vitestExitCode: failRun.run.status ?? 1,
		});
		expect(failRec.ok).toBe(false);
		expect(failRec.failures).toHaveLength(1);
		expect(failRec.failures[0]!.category).toBe("assertion");
		expect(failRec.failures[0]!.errorName).toBe("AssertionError");
		const serialized = JSON.stringify(failRec);
		expect(serialized).not.toContain("sk-top-secret-token-9999");
		expect(serialized).not.toContain("deadbeef00112233");
		expect(failRec.failures[0]!.fullName).not.toContain("\n");
	}, 60_000);

	it("classifies failure categories without leaking secrets and escapes Markdown/ANSI injection in summaries (F6)", () => {
		const sig = classifyFailureSignature([
			'AssertionError: expected "Bearer sk-secret-value" to equal "PRIVATE_EVALUATOR_ANSWER"',
		]);
		expect(sig).toEqual({ category: "assertion", errorName: "AssertionError" });
		expect(JSON.stringify(sig)).not.toContain("sk-secret-value");
		expect(JSON.stringify(sig)).not.toContain("PRIVATE_EVALUATOR_ANSWER");

		const dirty = "\x1b[31mTest\x1b[0m\n### Injected | `code` <script>alert(1)</script>\r\n*bold*";
		const cleaned = sanitizeBoundedLabel(dirty, 80);
		expect(cleaned).not.toContain("\x1b");
		expect(cleaned).not.toContain("\n");
		expect(cleaned).not.toContain("\r");
		const escaped = escapeMarkdownCell(dirty, 120);
		expect(escaped).toContain("\\#\\#\\#");
		expect(escaped).toContain("\\|");
		expect(escaped).toContain("\\`code\\`");
		expect(escaped).toContain("\\<script\\>");

		// Inline code spans must NOT backslash-escape dots/hyphens/underscores and must fence embedded backticks safely.
		expect(formatMarkdownCodeSpan("tests/ci-observability.test.ts")).toBe("`tests/ci-observability.test.ts`");
		expect(formatMarkdownCodeSpan("MISSING_EXPECTED_FILES")).toBe("`MISSING_EXPECTED_FILES`");
		expect(formatMarkdownCodeSpan("foo`bar|baz")).toBe("``foo`bar/baz``");
		expect(formatMarkdownCodeSpan("`leading`")).toBe("`` `leading` ``");
	});
});
