import { describe, expect, it } from "vitest";
import {
	allocateLptShard,
	classifyTestFile,
	defaultMaxWorkersForClass,
	partitionTestFiles,
	REPO_ROOT,
	validateCoverageAccounting,
} from "../scripts/test-inventory.mjs";

describe("CI test inventory and coverage accounting", () => {
	it("accounts for every test file on disk across disjoint partitions and specialist jobs", () => {
		const report = validateCoverageAccounting(REPO_ROOT, {
			fast: 1,
			browser: 1,
			process: 4,
		});
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.totalDiskFiles).toBeGreaterThanOrEqual(336);
		expect(report.classSummaries.fast.fileCount).toBeGreaterThan(100);
		expect(report.classSummaries.browser.fileCount).toBeGreaterThanOrEqual(20);
		expect(report.classSummaries.process.fileCount).toBeGreaterThan(100);
		expect(
			report.classSummaries.fast.fileCount +
				report.classSummaries.browser.fileCount +
				report.classSummaries.process.fileCount,
		).toBe(report.totalDiskFiles);
	});

	it("places newly added unmeasured non-browser tests into the conservative executed process partition", () => {
		expect(classifyTestFile("tests/brand-new-feature.test.ts", "import { it } from 'vitest';", {})).toBe("process");
		expect(
			classifyTestFile("tests/brand-new-browser.test.ts", "import { Browser } from './cockpit-browser.ts';", {}),
		).toBe("browser");
		expect(
			classifyTestFile("tests/brand-new-unit.test.ts", "import { it } from 'vitest';", {
				"tests/brand-new-unit.test.ts": 120,
			}),
		).toBe("fast");
		expect(
			classifyTestFile("tests/brand-new-spawn.test.ts", 'import { spawn } from "node:child_process";', {
				"tests/brand-new-spawn.test.ts": 120,
			}),
		).toBe("process");
	});

	it("allocates deterministic, disjoint, duration-balanced LPT shards with heaviest files first", () => {
		const { classes, hints } = partitionTestFiles(REPO_ROOT);
		const shards = [1, 2, 3, 4].map((i) =>
			allocateLptShard(classes.process, hints.durationsMs, i, 4, hints.defaultWeightMs),
		);
		const combined = shards.flatMap((s) => s.files);
		expect(new Set(combined).size).toBe(classes.process.length);
		expect(combined.length).toBe(classes.process.length);
		// LPT should dramatically beat alphabetical sharding imbalance (which was ~148s median / 270s max).
		expect(shards[0]!.imbalanceMs).toBeLessThan(15_000);
		// Each shard schedules its heaviest file first to avoid worker tail stragglers.
		for (const shard of shards) {
			const weights = shard.files.map((f) => hints.durationsMs[f] ?? hints.defaultWeightMs);
			for (let i = 1; i < weights.length; i++) {
				expect(weights[i - 1]).toBeGreaterThanOrEqual(weights[i]!);
			}
		}
		// Identical call is 100% deterministic.
		expect(allocateLptShard(classes.process, hints.durationsMs, 2, 4, hints.defaultWeightMs).files).toEqual(
			shards[1]!.files,
		);
	});

	it("bounds default worker concurrency safely per execution class", () => {
		expect(defaultMaxWorkersForClass("browser", 4)).toBe(2);
		expect(defaultMaxWorkersForClass("browser", 16)).toBe(2);
		expect(defaultMaxWorkersForClass("process", 4)).toBe(3);
		expect(defaultMaxWorkersForClass("process", 2)).toBe(1);
		expect(defaultMaxWorkersForClass("fast", 4)).toBe(4);
		expect(defaultMaxWorkersForClass("fast", 16)).toBe(8);
	});
});
