#!/usr/bin/env node
// Partitioned, duration-balanced Vitest runner for both local development and CI (CI-RELIABILITY-001).
//
// Usage:
//   node scripts/run-test-partition.mjs --class=fast|browser|process|all [--shard=k/n] [--max-workers=N]
//     [--json-out=<path>] [--diagnostics-out=<path>] [--step-summary] [-- <extra vitest args>]
//
// Guarantees:
// - Never masks or alters Vitest's failing exit code.
// - Always keeps Vitest file isolation enabled (`--isolate` default).
// - Uses deterministic LPT sharding from `scripts/test-inventory.mjs` and schedules slowest files first.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import {
	allocateLptShard,
	defaultMaxWorkersForClass,
	EXECUTION_CLASSES,
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
	} else if (flag === "--dry-run") {
		dryRun = true;
	} else {
		console.error(`Unrecognized argument: ${arg}`);
		process.exit(2);
	}
}

const { allFiles, classes, hints } = partitionTestFiles(REPO_ROOT);
const poolFiles = cls === "all" ? allFiles : classes[cls];
const allocation = allocateLptShard(poolFiles, hints.durationsMs, shardIndex, shardCount, hints.defaultWeightMs);
const maxWorkers = maxWorkersOverride ?? defaultMaxWorkersForClass(cls);

if (dryRun) {
	console.log(
		JSON.stringify(
			{
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

const vitestBin = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const vitestArgs = [vitestBin, "run", `--maxWorkers=${maxWorkers}`];

if (jsonOut) {
	mkdirSync(dirname(jsonOut), { recursive: true });
	vitestArgs.push("--reporter=default", "--reporter=json", `--outputFile.json=${jsonOut}`);
}

vitestArgs.push(...passthroughArgs, ...allocation.files);

const env = { ...process.env };
if (cls === "fast") {
	env.ENDO_SKIP_STUDIO_UI_PREBUILD = "1";
}

console.log(
	`[ci-partition] class=${cls} shard=${shardIndex}/${shardCount} files=${allocation.files.length} maxWorkers=${maxWorkers} estWeight=${(allocation.shardWeightMs / 1000).toFixed(1)}s`,
);

const startedAt = new Date();
const t0 = Date.now();
const result = spawnSync(process.execPath, vitestArgs, {
	cwd: REPO_ROOT,
	env,
	stdio: "inherit",
});
const elapsedMs = Date.now() - t0;
const exitCode = result.status ?? 1;

if (diagnosticsOut || writeStepSummary) {
	const summary = buildSanitizedSummary({
		cls,
		shardIndex,
		shardCount,
		maxWorkers,
		allocation,
		startedAt: startedAt.toISOString(),
		elapsedMs,
		exitCode,
		signal: result.signal ?? null,
		jsonOut,
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

process.exit(exitCode);

/**
 * Produces a bounded, sanitized CI diagnostics object (no secrets, no full env dump, no developer HOME paths).
 * @param {object} opts
 */
function buildSanitizedSummary(opts) {
	const { cls, shardIndex, shardCount, maxWorkers, allocation, startedAt, elapsedMs, exitCode, signal, jsonOut } = opts;
	/** @type {Array<{ file: string, status: string, durationMs: number, passed: number, failed: number, skipped: number }>} */
	const fileResults = [];
	/** @type {Array<{ file: string, fullName: string, message: string }>} */
	const failures = [];
	let numTotalTests = 0;
	let numPassedTests = 0;
	let numFailedTests = 0;
	let numPendingTests = 0;

	if (jsonOut && existsSync(jsonOut)) {
		try {
			const parsed = JSON.parse(readFileSync(jsonOut, "utf8"));
			numTotalTests = Number(parsed.numTotalTests ?? 0);
			numPassedTests = Number(parsed.numPassedTests ?? 0);
			numFailedTests = Number(parsed.numFailedTests ?? 0);
			numPendingTests = Number(parsed.numPendingTests ?? 0);
			const prefix = `${REPO_ROOT.replace(/\\/g, "/")}`;
			for (const suite of parsed.testResults ?? []) {
				const rawName = String(suite.name ?? "").replace(/\\/g, "/");
				const relFile = rawName.startsWith(prefix)
					? rawName.slice(prefix.length)
					: rawName.replace(/\/(?:home|Users)\/[^/\s:)]+/g, "<home>");
				const durationMs =
					typeof suite.endTime === "number" && typeof suite.startTime === "number"
						? Math.max(0, Math.round(suite.endTime - suite.startTime))
						: 0;
				const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
				let passed = 0;
				let failed = 0;
				let skipped = 0;
				for (const a of assertions) {
					if (a.status === "passed") passed++;
					else if (a.status === "failed") {
						failed++;
						const rawMsg = Array.isArray(a.failureMessages) ? a.failureMessages.join("\n") : "";
						failures.push({
							file: relFile,
							fullName: String(a.fullName ?? a.title ?? "unknown"),
							message: sanitizeMessage(rawMsg, prefix),
						});
					} else {
						skipped++;
					}
				}
				if (suite.status === "failed" && failed === 0) {
					failures.push({
						file: relFile,
						fullName: "(suite-level error)",
						message: sanitizeMessage(String(suite.message ?? "suite failed without assertion details"), prefix),
					});
				}
				fileResults.push({
					file: relFile,
					status: String(suite.status ?? "unknown"),
					durationMs,
					passed,
					failed,
					skipped,
				});
			}
		} catch (err) {
			failures.push({
				file: "(vitest-json-reporter)",
				fullName: "(parse-error)",
				message: String(err instanceof Error ? err.message : err),
			});
		}
	}

	fileResults.sort((a, b) => b.durationMs - a.durationMs || (a.file < b.file ? -1 : 1));
	const gitSha = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
	const vitestPkg = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "vitest", "package.json"), "utf8"));

	return {
		schemaVersion: "endo.ci-diagnostics.v1",
		startedAt,
		elapsedMs,
		exitCode,
		signal,
		partition: {
			class: cls,
			shard: `${shardIndex}/${shardCount}`,
			maxWorkers,
			allocatedFileCount: allocation.files.length,
			estimatedWeightMs: allocation.shardWeightMs,
			classImbalanceMs: allocation.imbalanceMs,
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
			filesReported: fileResults.length,
			testsTotal: numTotalTests,
			testsPassed: numPassedTests,
			testsFailed: numFailedTests,
			testsPending: numPendingTests,
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

/**
 * Strips absolute repo/home paths and truncates failure messages for safe CI summary artifacts.
 * @param {string} msg
 * @param {string} repoPrefix
 */
function sanitizeMessage(msg, repoPrefix) {
	const cleaned = msg
		.replaceAll(repoPrefix, "<repo>/")
		.replace(/\/(?:home|Users)\/[^/\s:)]+/g, "<home>")
		.trim();
	return cleaned.length > 1200 ? `${cleaned.slice(0, 1200)}\n...(truncated)` : cleaned;
}

/** @param {ReturnType<typeof buildSanitizedSummary>} summary */
function formatStepSummaryMarkdown(summary) {
	const lines = [];
	const statusLabel = summary.exitCode === 0 ? "PASS" : `FAIL (exit ${summary.exitCode})`;
	lines.push(
		`### Test Partition: \`${summary.partition.class}\` (${summary.partition.shard}) — ${statusLabel}`,
	);
	lines.push("");
	lines.push(
		`- **Wall time:** ${(summary.elapsedMs / 1000).toFixed(1)}s | **Files:** ${summary.totals.filesReported}/${summary.partition.allocatedFileCount} | **Tests:** ${summary.totals.testsPassed} passed, ${summary.totals.testsFailed} failed, ${summary.totals.testsPending} skipped`,
	);
	lines.push(
		`- **Workers:** \`maxWorkers=${summary.partition.maxWorkers}\` on ${summary.environment.cpuCount} vCPU / ${summary.environment.totalMemMiB} MiB RAM (Node ${summary.environment.nodeVersion}, Vitest ${summary.environment.vitestVersion})`,
	);
	lines.push("");

	if (summary.failures.length > 0) {
		lines.push("#### Failures");
		lines.push("");
		for (const f of summary.failures.slice(0, 10)) {
			const firstLine = f.message.split("\n")[0] ?? "";
			lines.push(`- \`${f.file}\` — **${f.fullName}**: \`${firstLine.slice(0, 220)}\``);
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
				`| \`${f.file}\` | ${(f.durationMs / 1000).toFixed(2)}s | ${f.status} | ${f.passed}/${f.passed + f.failed + f.skipped} |`,
			);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
