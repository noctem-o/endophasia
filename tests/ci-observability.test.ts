import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { partitionTestFiles } from "../scripts/test-inventory.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const cleanup: string[] = [];
afterEach(() => {
	for (const dir of cleanup.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
});

describe("CI observability and history analysis", () => {
	it("computes deduplicated baseline reliability, elapsed time, and runner-minute metrics from the 40-run snapshot", () => {
		const res = spawnSync(
			process.execPath,
			[
				join(REPO_ROOT, "scripts", "analyze-ci-history.mjs"),
				`--input=${join(REPO_ROOT, "research", "ci-reliability", "ci-reliability-001", "historical-runs-40.json")}`,
				"--json",
			],
			{ encoding: "utf8" },
		);
		expect(res.status, res.stderr).toBe(0);
		const metrics = JSON.parse(res.stdout) as {
			totalRuns: number;
			decisiveAttempt1: number;
			firstAttemptSuccess: number;
			failedThenPassed: number;
			firstAttemptFailure: number;
			uniqueJobExecutions: number;
			clonedJobRecordsSkipped: number;
			passingWorkflowElapsedSec: { n: number; medianSec: number; p95Sec: number };
			attempt1PassingElapsedSec: { n: number; medianSec: number; p95Sec: number };
			runnerMinutes: { total: number; rerun: number };
		};
		expect(metrics.totalRuns).toBe(40);
		expect(metrics.decisiveAttempt1).toBe(39);
		expect(metrics.firstAttemptSuccess).toBe(19);
		expect(metrics.failedThenPassed).toBe(9);
		expect(metrics.firstAttemptFailure).toBe(20);
		// Partial-rerun cloned jobs must be deduplicated so elapsed p95 and runner-minutes are not inflated.
		expect(metrics.uniqueJobExecutions).toBe(465);
		expect(metrics.clonedJobRecordsSkipped).toBe(129);
		expect(metrics.passingWorkflowElapsedSec.p95Sec).toBeLessThan(600);
		expect(metrics.attempt1PassingElapsedSec.n).toBe(19);
		expect(metrics.attempt1PassingElapsedSec.medianSec).toBeGreaterThan(400);
		expect(metrics.attempt1PassingElapsedSec.p95Sec).toBeLessThan(600);
		expect(metrics.runnerMinutes.total).toBeCloseTo(1196.0, 0);
		expect(metrics.runnerMinutes.rerun).toBeCloseTo(108.2, 0);
	});

	it("emits sanitized diagnostics JSON and step summary without masking a failing exit code", () => {
		const scratch = mkdtempSync(join(tmpdir(), "endo-ci-obs-"));
		cleanup.push(scratch);
		const jsonOut = join(scratch, "vitest.json");
		const diagOut = join(scratch, "diag.json");
		const summaryFile = join(scratch, "step-summary.md");
		const fastCount = partitionTestFiles(REPO_ROOT).classes.fast.length;
		const singleFastShard = `${fastCount}/${fastCount}`;

		// Passing 1-file slice of the fast partition under --strict-accounting (runs in <2s).
		const passRun = spawnSync(
			process.execPath,
			[
				join(REPO_ROOT, "scripts", "run-test-partition.mjs"),
				"--class=fast",
				`--shard=${singleFastShard}`,
				"--max-workers=1",
				"--strict-accounting",
				`--json-out=${jsonOut}`,
				`--diagnostics-out=${diagOut}`,
				"--step-summary",
			],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
				encoding: "utf8",
			},
		);
		expect(passRun.status, passRun.stderr).toBe(0);
		const diag = JSON.parse(readFileSync(diagOut, "utf8")) as {
			schemaVersion: string;
			executionMode: string;
			exitCode: number;
			partition: { class: string; maxWorkers: number; allocatedFileCount: number };
			reconciliation: { ok: boolean; expectedFileCount: number; observedFileCount: number };
			environment: { nodeVersion: string; vitestVersion: string };
			totals: { filesReported: number; testsPassed: number; testsFailed: number };
		};
		expect(diag.schemaVersion).toBe("endo.ci-diagnostics.v1");
		expect(diag.executionMode).toBe("strict-complete");
		expect(diag.exitCode).toBe(0);
		expect(diag.reconciliation.ok).toBe(true);
		expect(diag.reconciliation.observedFileCount).toBe(1);
		expect(diag.reconciliation.expectedFileCount).toBe(1);
		expect(diag.partition.class).toBe("fast");
		expect(diag.partition.maxWorkers).toBe(1);
		expect(diag.partition.allocatedFileCount).toBe(1);
		expect(diag.environment.nodeVersion).toBe(process.version);
		expect(diag.totals.filesReported).toBe(1);
		expect(diag.totals.testsFailed).toBe(0);
		const summaryMd = readFileSync(summaryFile, "utf8");
		expect(summaryMd).toContain("Test Partition: `fast`");
		expect(summaryMd).toContain("PASS [RECONCILED]");

		// Verify a failing Vitest invocation propagates its non-zero exit code intact.
		const failDiag = join(scratch, "fail-diag.json");
		const failRun = spawnSync(
			process.execPath,
			[
				join(REPO_ROOT, "scripts", "run-test-partition.mjs"),
				"--class=fast",
				`--shard=${singleFastShard}`,
				"--max-workers=1",
				`--diagnostics-out=${failDiag}`,
				"--",
				"--unknown-flag-that-must-fail-vitest",
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);
		expect(failRun.status).not.toBe(0);
		const failParsed = JSON.parse(readFileSync(failDiag, "utf8")) as { exitCode: number };
		expect(failParsed.exitCode).not.toBe(0);
	}, 60_000);
});
