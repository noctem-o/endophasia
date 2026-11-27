#!/usr/bin/env node
// Partitioned, duration-balanced Vitest runner for both local development and CI
// (CI-RELIABILITY-001, hardened with F3 fail-closed execution reconciliation & F6 confidential summaries).
//
// Usage:
//   node scripts/run-test-partition.mjs --class=fast|browser|process|all [--shard=k/n] [--max-workers=N]
//     [--strict-accounting] [--json-out=<path>] [--diagnostics-out=<path>] [--step-summary]
//     [-- <extra vitest args (local partial mode only; rejected in --strict-accounting)>]
//
// Guarantees:
// - Never masks or alters Vitest's failing exit code.
// - In `--strict-accounting` mode (used by CI), rejects passthrough filters that weaken completeness or
//   isolation, generates a fresh per-invocation JSON report, reconciles exact expected vs observed file
//   identities, fails closed on missing/unexpected/duplicate/zero-test/all-skipped-mandatory suites, and
//   never allows Vitest exit code 0 to override a failed reconciliation.
// - Always keeps Vitest file isolation enabled (`isolate: true`).
// - Diagnostic artifacts and `$GITHUB_STEP_SUMMARY` emit only host-generated failure categories, error
//   class names, normalized paths, sanitized bounded labels, and source locations — never raw assertion
//   diffs, tokens, capability URLs, environment dumps, or private fixture payloads.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import {
	escapeMarkdownCell,
	formatMarkdownCodeSpan,
	reconcileVitestExecution,
	validateStrictPassthroughArgs,
} from "./reconcile-test-execution.mjs";
import {
	allocateLptShard,
	defaultMaxWorkersForClass,
	EXECUTION_CLASSES,
	PERMITTED_OPTIONAL_WHOLE_FILE_SKIPS,
	partitionTestFiles,
	REPO_ROOT,
} from "./test-inventory.mjs";

const rawArgs = process.argv.slice(2);
const separatorIndex = rawArgs.indexOf("--");
const ownArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
const passthroughArgs = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);

/** @type {"fast" | "browser" | "process" | "all"} */
let cls = "all";
let shardIndex = 1;
let shardCount = 1;
/** @type {number | null} */
let maxWorkersOverride = null;
/** @type {string | null} */
let jsonOut = null;
/** @type {string | null} */
let diagnosticsOut = null;
let writeStepSummary = false;
let strictAccounting = false;
let dryRun = false;

for (let i = 0; i < ownArgs.length; i++) {
	const arg = ownArgs[i];
	const [flag, inline] = arg.split(/=(.*)/s, 2);
	const nextVal = () => (inline !== undefined ? inline : ownArgs[++i]);
	if (flag === "--class") {
		const v = nextVal();
		if (v !== "all" && !EXECUTION_CLASSES.includes(/** @type {any} */ (v))) {
			console.error(`Invalid --class=${v}; expected one of: fast, browser, process, all`);
			process.exit(2);
		}
		cls = /** @type {any} */ (v);
	} else if (flag === "--shard") {
		const v = nextVal() ?? "";
		const m = /^(\d+)\/(\d+)$/.exec(v);
		if (!m) {
			console.error(`Invalid --shard=${v}; expected <index>/<count> (e.g. 1/4)`);
			process.exit(2);
		}
		shardIndex = Number(m[1]);
		shardCount = Number(m[2]);
	} else if (flag === "--max-workers") {
		const v = Number(nextVal());
		if (!Number.isInteger(v) || v < 1) {
			console.error(`Invalid --max-workers; expected positive integer`);
			process.exit(2);
		}
		maxWorkersOverride = v;
	} else if (flag === "--json-out") {
		const v = nextVal();
		if (!v || (inline === undefined && v.startsWith("--"))) {
			console.error("--json-out requires a file path");
			process.exit(2);
		}
		jsonOut = v;
	} else if (flag === "--diagnostics-out") {
		const v = nextVal();
		if (!v || (inline === undefined && v.startsWith("--"))) {
			console.error("--diagnostics-out requires a file path");
			process.exit(2);
		}
		diagnosticsOut = v;
	} else if (flag === "--step-summary") {
		writeStepSummary = true;
	} else if (flag === "--strict-accounting") {
		strictAccounting = true;
	} else if (flag === "--dry-run") {
		dryRun = true;
	} else {
		console.error(`Unrecognized argument: ${arg}`);
		process.exit(2);
	}
}

if (strictAccounting && passthroughArgs.length > 0) {
	const violations = validateStrictPassthroughArgs(passthroughArgs);
	if (violations.length > 0) {
		for (const v of violations) console.error(`[ci-partition] ERROR: ${v}`);
		process.exit(2);
	}
}

const { allFiles, classes, hints } = partitionTestFiles(REPO_ROOT);
const poolFiles = cls === "all" ? allFiles : classes[cls];
const allocation = allocateLptShard(poolFiles, hints.durationsMs, shardIndex, shardCount, hints.defaultWeightMs);
const maxWorkers = maxWorkersOverride ?? defaultMaxWorkersForClass(cls);
const executionMode = strictAccounting
	? "strict-complete"
	: passthroughArgs.length > 0
		? "partial-local"
		: "local-partition";

if (dryRun) {
	console.log(
		JSON.stringify(
			{
				mode: executionMode,
				class: cls,
				shard: `${shardIndex}/${shardCount}`,
				maxWorkers,
				fileCount: allocation.files.length,
				shardWeightMs: allocation.shardWeightMs,
				imbalanceMs: allocation.imbalanceMs,
				files: allocation.files,
			},
			null,
			2,
		),
	);
	process.exit(0);
}

if (allocation.files.length === 0) {
	console.error(`No test files selected for class=${cls} shard=${shardIndex}/${shardCount}`);
	process.exit(1);
}

// Allocate a fresh, invocation-unique report file whenever strict accounting or diagnostics is enabled
// so stale reports from earlier attempts can never be reused.
let ownedReportTempDir = null;
let effectiveJsonOut = jsonOut;
if (!effectiveJsonOut && (strictAccounting || diagnosticsOut || writeStepSummary)) {
	ownedReportTempDir = mkdtempSync(join(tmpdir(), "endo-vitest-report-"));
	effectiveJsonOut = join(ownedReportTempDir, `vitest-${process.pid}-${randomBytes(6).toString("hex")}.json`);
}
if (effectiveJsonOut) {
	mkdirSync(dirname(effectiveJsonOut), { recursive: true });
	if (existsSync(effectiveJsonOut)) {
		// Remove any stale report at the requested path prior to running Vitest.
		unlinkSync(effectiveJsonOut);
	}
}

const vitestBin = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const vitestArgs = [vitestBin, "run", `--maxWorkers=${maxWorkers}`];

if (effectiveJsonOut) {
	vitestArgs.push("--reporter=default", "--reporter=json", `--outputFile.json=${effectiveJsonOut}`);
}

// Pass rooted file paths; strict accounting additionally reconciles exact observed vs expected file sets.
vitestArgs.push(...passthroughArgs, ...allocation.files.map((f) => join(REPO_ROOT, f)));

const env = { ...process.env };
if (cls === "fast") {
	env.ENDO_SKIP_STUDIO_UI_PREBUILD = "1";
}

console.log(
	`[ci-partition] mode=${executionMode} class=${cls} shard=${shardIndex}/${shardCount} files=${allocation.files.length} maxWorkers=${maxWorkers} estWeight=${(allocation.shardWeightMs / 1000).toFixed(1)}s`,
);
if (executionMode === "partial-local") {
	console.log(
		"[ci-partition] NOTE: targeted local passthrough args active; complete partition execution accounting is NOT enforced.",
	);
}

const startedAt = new Date();
const startedAtMs = Date.now();
const result = spawnSync(process.execPath, vitestArgs, {
	cwd: REPO_ROOT,
	env,
	stdio: "inherit",
});
const endedAtMs = Date.now();
const elapsedMs = endedAtMs - startedAtMs;
const vitestExitCode = result.status ?? 1;
const vitestSignal = result.signal ?? null;

let finalExitCode = vitestExitCode;
let reconciliation = null;
try {
	if (effectiveJsonOut) {
		reconciliation = reconcileVitestExecution({
			repoRoot: REPO_ROOT,
			expectedFiles: allocation.files,
			reportPath: effectiveJsonOut,
			startedAtMs,
			endedAtMs,
			vitestExitCode,
			vitestSignal,
			permittedOptionalWholeFileSkips: PERMITTED_OPTIONAL_WHOLE_FILE_SKIPS,
		});
	}

	// Fail-closed exit code calculation:
	// - Never mask a non-zero Vitest exit code.
	// - In strict accounting mode, Vitest exit 0 NEVER overrides a failed reconciliation.
	finalExitCode =
		vitestExitCode !== 0 ? vitestExitCode : strictAccounting && (!reconciliation || !reconciliation.ok) ? 1 : 0;

	if (strictAccounting && reconciliation) {
		if (reconciliation.ok) {
			console.log(
				`[ci-accounting] PASS reconciled ${reconciliation.summary.observedFileCount}/${reconciliation.summary.expectedFileCount} exact files ` +
					`(${reconciliation.summary.passedTests} passed, ${reconciliation.summary.skippedTests} skipped, ` +
					`${reconciliation.summary.permittedWholeFileSkips.length} permitted optional whole-file skip(s))`,
			);
		} else {
			console.error(
				`[ci-accounting] FAIL execution reconciliation failed (${reconciliation.errors.length} issue(s)):`,
			);
			for (const err of reconciliation.errors) {
				console.error(`  - [${err.code}] ${err.detail}`);
			}
		}
	}

	if (diagnosticsOut || writeStepSummary) {
		const summary = buildConfidentialSummary({
			executionMode,
			cls,
			shardIndex,
			shardCount,
			maxWorkers,
			allocation,
			startedAt: startedAt.toISOString(),
			elapsedMs,
			vitestExitCode,
			finalExitCode,
			signal: vitestSignal,
			reconciliation,
		});
		if (diagnosticsOut) {
			mkdirSync(dirname(diagnosticsOut), { recursive: true });
			writeFileSync(diagnosticsOut, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
		}
		if (writeStepSummary && process.env.GITHUB_STEP_SUMMARY) {
			const md = formatStepSummaryMarkdown(summary);
			writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: "a", encoding: "utf8" });
		}
	}
} catch (error) {
	console.error(
		`[ci-accounting] ERROR during post-run reconciliation/diagnostics (${error instanceof Error ? error.name : "Error"})`,
	);
	// Preserve Vitest's specific non-zero exit code if it failed; otherwise fail closed with exit 1.
	if (finalExitCode === 0) finalExitCode = 1;
} finally {
	if (ownedReportTempDir) {
		rmSync(ownedReportTempDir, { recursive: true, force: true });
	}
}

process.exit(finalExitCode);

/**
 * Produces a bounded, confidential CI diagnostics summary (`endo.ci-diagnostics.v1`).
 * Deliberately omits raw assertion payloads/diffs, tokens, capability URLs, environment dumps,
 * and private fixture contents; retains host-generated failure categories, error names, normalized
 * paths, sanitized labels, locations, and exact execution reconciliation metadata.
 *
 * @param {object} opts
 */
function buildConfidentialSummary(opts) {
	const {
		executionMode,
		cls,
		shardIndex,
		shardCount,
		maxWorkers,
		allocation,
		startedAt,
		elapsedMs,
		vitestExitCode,
		finalExitCode,
		signal,
		reconciliation,
	} = opts;

	const gitSha = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
	const vitestPkg = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "vitest", "package.json"), "utf8"));
	const fileResults = reconciliation?.fileResults ?? [];
	const failures = reconciliation?.failures ?? [];
	const recSummary = reconciliation?.summary ?? {
		expectedFileCount: allocation.files.length,
		observedFileCount: 0,
		missingFiles: [],
		unexpectedFiles: [],
		duplicateFiles: [],
		zeroTestFiles: [],
		mandatoryWholeFileSkips: [],
		permittedWholeFileSkips: [],
		totalTests: 0,
		passedTests: 0,
		failedTests: 0,
		skippedTests: 0,
		todoTests: 0,
	};

	return {
		schemaVersion: "endo.ci-diagnostics.v1",
		confidentialityNote:
			"Host-generated failure categories and bounded identifiers only; raw assertion values, diffs, env dumps, and transcripts are omitted.",
		executionMode,
		startedAt,
		elapsedMs,
		vitestExitCode,
		exitCode: finalExitCode,
		signal,
		partition: {
			class: cls,
			shard: `${shardIndex}/${shardCount}`,
			maxWorkers,
			allocatedFileCount: allocation.files.length,
			estimatedWeightMs: allocation.shardWeightMs,
			classImbalanceMs: allocation.imbalanceMs,
		},
		reconciliation: {
			ok: reconciliation ? reconciliation.ok : false,
			errors: (reconciliation?.errors ?? []).slice(0, 25),
			expectedFileCount: recSummary.expectedFileCount,
			observedFileCount: recSummary.observedFileCount,
			missingFileCount: recSummary.missingFiles.length,
			unexpectedFileCount: recSummary.unexpectedFiles.length,
			duplicateFileCount: recSummary.duplicateFiles.length,
			zeroTestFileCount: recSummary.zeroTestFiles.length,
			mandatoryWholeFileSkipCount: recSummary.mandatoryWholeFileSkips.length,
			permittedWholeFileSkips: recSummary.permittedWholeFileSkips,
		},
		environment: {
			nodeVersion: process.version,
			vitestVersion: String(vitestPkg.version ?? "unknown"),
			gitShortSha: gitSha.status === 0 ? gitSha.stdout.trim() : null,
			platform: platform(),
			kernelRelease: release(),
			availableParallelism: availableParallelism(),
			cpuCount: cpus().length,
			totalMemMiB: Math.round(totalmem() / (1024 * 1024)),
			freeMemMiB: Math.round(freemem() / (1024 * 1024)),
			ci: Boolean(process.env.CI),
			requireBrowser: process.env.ENDO_REQUIRE_BROWSER === "1",
		},
		totals: {
			filesReported: recSummary.observedFileCount,
			testsTotal: recSummary.totalTests,
			testsPassed: recSummary.passedTests,
			testsFailed: recSummary.failedTests,
			testsPending: recSummary.skippedTests + recSummary.todoTests,
		},
		slowestFiles: fileResults.slice(0, 15),
		failures: failures.slice(0, 50),
		allFileDurations: fileResults.map((f) => ({
			file: f.file,
			durationMs: f.durationMs,
			status: f.status,
			passed: f.passed,
			failed: f.failed,
			skipped: f.skipped,
		})),
	};
}

/** @param {ReturnType<typeof buildConfidentialSummary>} summary */
function formatStepSummaryMarkdown(summary) {
	const lines = [];
	const statusLabel = summary.exitCode === 0 ? "PASS" : `FAIL (exit ${summary.exitCode})`;
	const acctLabel = summary.reconciliation.ok ? "RECONCILED" : "ACCOUNTING FAILED";
	lines.push(
		`### Test Partition: \`${summary.partition.class}\` (${summary.partition.shard}) — ${statusLabel} [${acctLabel}]`,
	);
	lines.push("");
	lines.push(
		`- **Wall time:** ${(summary.elapsedMs / 1000).toFixed(1)}s | **Mode:** \`${summary.executionMode}\` | **Files:** ${summary.reconciliation.observedFileCount}/${summary.reconciliation.expectedFileCount} | **Tests:** ${summary.totals.testsPassed} passed, ${summary.totals.testsFailed} failed, ${summary.totals.testsPending} skipped`,
	);
	lines.push(
		`- **Workers:** \`maxWorkers=${summary.partition.maxWorkers}\` on ${summary.environment.cpuCount} vCPU / ${summary.environment.totalMemMiB} MiB RAM (Node ${summary.environment.nodeVersion}, Vitest ${summary.environment.vitestVersion})`,
	);
	if (summary.reconciliation.permittedWholeFileSkips.length > 0) {
		lines.push(
			`- **Permitted optional whole-file skips:** ${summary.reconciliation.permittedWholeFileSkips.length} (${summary.reconciliation.permittedWholeFileSkips.map((s) => formatMarkdownCodeSpan(s.file, 80)).join(", ")})`,
		);
	}
	lines.push("");

	if (!summary.reconciliation.ok && summary.reconciliation.errors.length > 0) {
		lines.push("#### Execution Accounting Issues");
		lines.push("");
		for (const e of summary.reconciliation.errors.slice(0, 10)) {
			lines.push(`- ${formatMarkdownCodeSpan(e.code, 48)}: ${escapeMarkdownCell(e.detail, 180)}`);
		}
		lines.push("");
	}

	if (summary.failures.length > 0) {
		lines.push("#### Failures (host-generated categories; see job logs for full details)");
		lines.push("");
		lines.push("| File | Test | Category | Error | Location |");
		lines.push("|---|---|---|---|---|");
		for (const f of summary.failures.slice(0, 15)) {
			const loc = f.location ? `L${f.location.line}:C${f.location.column}` : "—";
			lines.push(
				`| ${formatMarkdownCodeSpan(f.file, 90)} | ${escapeMarkdownCell(f.fullName, 120)} | ${formatMarkdownCodeSpan(f.category, 32)} | ${formatMarkdownCodeSpan(f.errorName, 48)} | ${loc} |`,
			);
		}
		lines.push("");
	}

	if (summary.slowestFiles.length > 0) {
		lines.push("#### Slowest Test Files");
		lines.push("");
		lines.push("| File | Duration | Status | Tests |");
		lines.push("|---|---:|---|---:|");
		for (const f of summary.slowestFiles.slice(0, 10)) {
			lines.push(
				`| ${formatMarkdownCodeSpan(f.file, 90)} | ${(f.durationMs / 1000).toFixed(2)}s | ${escapeMarkdownCell(f.status, 16)} | ${f.passed}/${f.passed + f.failed + f.skipped} |`,
			);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
