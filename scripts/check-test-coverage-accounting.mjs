#!/usr/bin/env node
// Deterministic CI & developer coverage-accounting check (CI-RELIABILITY-001, Phase C).
// Fails non-zero if any `tests/**/*.test.ts` file is unclassified, duplicated across general partitions,
// dropped by the LPT shard plan, missing from specialist invariants, or contains workstation-specific paths.

import { REPO_ROOT, validateCoverageAccounting } from "./test-inventory.mjs";

const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");

const report = validateCoverageAccounting(REPO_ROOT, {
	fast: 1,
	browser: 1,
	process: 4,
});

if (jsonMode) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`Test coverage accounting: ${report.ok ? "OK" : "FAILED"} (${report.totalDiskFiles} test files on disk)`);
	for (const [cls, info] of Object.entries(report.classSummaries)) {
		const weights = info.shardWeightsMs.map((ms) => `${(ms / 1000).toFixed(1)}s`).join(", ");
		console.log(
			`  - ${cls.padEnd(7)} : ${String(info.fileCount).padStart(3)} files | ${info.shards} shard(s) | total ${(info.totalWeightMs / 1000).toFixed(1)}s | per-shard [${weights}] | imbalance ${(info.imbalanceMs / 1000).toFixed(1)}s`,
		);
	}
	console.log(`  - specialist jobs verified: ${report.specialistJobs.join(", ")}`);
	for (const w of report.warnings) {
		console.warn(`  [warn] ${w}`);
	}
	for (const e of report.errors) {
		console.error(`  [ERROR] ${e}`);
	}
}

if (!report.ok) {
	process.exit(1);
}
