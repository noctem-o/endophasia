// Deterministic test-suite classification, duration-balanced LPT sharding, and coverage accounting
// (CI-RELIABILITY-001, Phases C & D).
//
// Design invariants:
// 1. Every `tests/**/*.test.ts` file on disk belongs to EXACTLY ONE general execution class:
//    - `fast`: pure/lightweight in-process tests with hosted duration < 5000 ms and no child-process,
//      network-server, Studio-UI-build, or browser dependencies.
//    - `browser`: tests that launch headless Chromium (including Studio UI browser & screenshot suites).
//    - `process`: safe conservative default for all real child-process, fake-Pi, ACP, AA, HTTP/Unix-server,
//      CLI, multi-process concurrency, slow pure-compute (>= 5000 ms), and newly added unmeasured tests.
// 2. Newly added test files can NEVER be silently omitted: unmeasured non-browser files automatically fall
//    into the executed `process` partition with a conservative default LPT weight, and browser files fall into
//    `browser`.
// 3. Specialist CI jobs (trust-reader, trust004-freeze, live-scopes, exchange, package, package-floor,
//    acceptance, numerical-probe) are tracked explicitly alongside the general partitions so intentional
//    repetitions and host-capability requirements remain auditable.

import { readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const EXECUTION_CLASSES = /** @type {const} */ (["fast", "browser", "process"]);
export const FAST_DURATION_THRESHOLD_MS = 5000;
export const DEFAULT_UNMEASURED_WEIGHT_MS = 5000;

/**
 * Documented exception(s) permitted to reference archived raw study paths under a developer home directory,
 * gated behind `rawDataAvailable(...)` so CI skips cleanly without failing.
 */
export const WORKSTATION_PATH_EXCEPTIONS = new Set(["tests/steering-raw-data.test.ts"]);

/**
 * Files that mention `ENDO_REQUIRE_BROWSER` purely as static text (e.g. auditing `.github/workflows/ci.yml`)
 * without launching a browser.
 */
export const BROWSER_TEXT_ONLY_FILES = new Set(["tests/release-readiness.test.ts"]);

/**
 * Explicit inventory of specialist CI verification jobs and their targeted test files / commands.
 * Used by coverage accounting to prove all specialist invariants remain present and wired.
 */
export const SPECIALIST_SUITES = {
	"trust-reader": {
		description: "Real Bubblewrap namespace sandbox and shallow-checkout guest archive reanalysis",
		files: ["tests/develop-verify-trust-003-reader.test.ts"],
		env: { ENDO_REQUIRE_TRUST_SANDBOX: "1" },
	},
	"trust004-freeze": {
		description: "Full-history/tag TRUST-004 operator freeze consistency",
		files: ["tests/develop-verify-trust-004-freeze.test.ts"],
		env: { TRUST004_FREEZE_CHECK: "1" },
	},
	"live-scopes": {
		description: "Real systemd user scopes containment and CLI live-scope suites",
		files: [
			"tests/develop-tasks-cli.test.ts",
			"tests/develop-ux-001.test.ts",
			"tests/develop-ux-002-cli.test.ts",
			"tests/steer-cli.test.ts",
			"tests/prime-runtime-ingress.test.ts",
			"tests/endo-workbench-cli.test.ts",
			"tests/endo-workbench-attempts-cli.test.ts",
			"tests/endo-workbench-attempt-page.test.ts",
			"tests/live-process-containment.test.ts",
		],
		env: { ENDO_REAL_SCOPES: "1" },
	},
	exchange: {
		description: "Reference exchange on coreutils with mv --exchange (Fedora container)",
		files: [
			"tests/conformance-lab.test.ts",
			"tests/prime-097-conformance.test.ts",
			"tests/prime-097-review5.test.ts",
		],
		env: {},
	},
};

const PROCESS_SIGNALS = [
	"node:child_process",
	"child_process",
	"spawn(",
	"spawnSync(",
	"execFile(",
	"execFileSync(",
	"fork(",
	"installFakePi",
	"fake-pi/install",
	"fake-acp",
	"PiAttachmentV0",
	"AcpClient",
	"startEndoControlServer",
	"aa-operator-rig",
	"ensureSharedStudioUiDir",
	"buildStudioUi",
	"createServer(",
	"http.createServer",
	"net.createServer",
	"cockpit-http/server",
	"cockpit-http-fixtures",
	"startFakeOpenAiServer",
	"verifiedInitialCheckpointFixture",
	"startStudioServer",
	"startEndoStudio",
];

/**
 * Recursively discovers all `tests/**\/*.test.ts` files in deterministic POSIX-sorted order.
 * @param {string} [rootDir]
 * @returns {string[]}
 */
export function discoverTestFiles(rootDir = REPO_ROOT) {
	const testsDir = join(rootDir, "tests");
	/** @type {string[]} */
	const found = [];
	/** @param {string} dir */
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
				const rel = relative(rootDir, full).split("\\").join(posix.sep);
				found.push(rel);
			}
		}
	};
	walk(testsDir);
	found.sort();
	return found;
}

/**
 * Loads hosted duration hints from `tests/test-durations.json`.
 * @param {string} [rootDir]
 * @returns {{ sourceRunId: number | null, sourceCommit: string | null, runner: string | null, defaultWeightMs: number, durationsMs: Record<string, number> }}
 */
export function loadDurationHints(rootDir = REPO_ROOT) {
	const path = join(rootDir, "tests", "test-durations.json");
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	return {
		sourceRunId: typeof parsed.sourceRunId === "number" ? parsed.sourceRunId : null,
		sourceCommit: typeof parsed.sourceCommit === "string" ? parsed.sourceCommit : null,
		runner: typeof parsed.runner === "string" ? parsed.runner : null,
		defaultWeightMs:
			typeof parsed.defaultWeightMs === "number" && parsed.defaultWeightMs > 0
				? parsed.defaultWeightMs
				: DEFAULT_UNMEASURED_WEIGHT_MS,
		durationsMs: parsed.durationsMs && typeof parsed.durationsMs === "object" ? parsed.durationsMs : {},
	};
}

/**
 * Returns true if the test file launches headless Chromium (browser or screenshot suite).
 * @param {string} relPath
 * @param {string} sourceText
 */
export function isBrowserTestFile(relPath, sourceText) {
	if (BROWSER_TEXT_ONLY_FILES.has(relPath)) return false;
	if (
		relPath.endsWith("-browser.test.ts") ||
		relPath.endsWith("-shots.test.ts") ||
		relPath === "tests/endo-workbench-attempt-page.test.ts"
	) {
		return true;
	}
	return sourceText.includes("Browser.launch(") || sourceText.includes("ENDO_REQUIRE_BROWSER");
}

/**
 * Classifies a single test file into `"fast" | "browser" | "process"`.
 * Unknown / newly added non-browser files default safely to `"process"`.
 * @param {string} relPath
 * @param {string} sourceText
 * @param {Record<string, number>} durationsMs
 * @returns {"fast" | "browser" | "process"}
 */
export function classifyTestFile(relPath, sourceText, durationsMs) {
	if (isBrowserTestFile(relPath, sourceText)) {
		return "browser";
	}
	const knownMs = durationsMs[relPath];
	const hasProcessSignal = PROCESS_SIGNALS.some((signal) => sourceText.includes(signal));
	if (!hasProcessSignal && typeof knownMs === "number" && knownMs < FAST_DURATION_THRESHOLD_MS) {
		return "fast";
	}
	return "process";
}

/**
 * Discovers and partitions all test files on disk into disjoint execution classes.
 * @param {string} [rootDir]
 */
export function partitionTestFiles(rootDir = REPO_ROOT) {
	const allFiles = discoverTestFiles(rootDir);
	const hints = loadDurationHints(rootDir);
	/** @type {{ fast: string[], browser: string[], process: string[] }} */
	const classes = { fast: [], browser: [], process: [] };
	/** @type {Record<string, string>} */
	const sources = {};
	for (const relPath of allFiles) {
		const sourceText = readFileSync(join(rootDir, relPath), "utf8");
		sources[relPath] = sourceText;
		const cls = classifyTestFile(relPath, sourceText, hints.durationsMs);
		classes[cls].push(relPath);
	}
	return { allFiles, classes, hints, sources };
}

/**
 * Allocates `files` across `shardCount` shards using deterministic Longest-Processing-Time-first (LPT)
 * bin-packing. Within each shard, files are ordered descending by weight so Vitest schedules the slowest
 * files immediately at t=0 and minimizes worker tail latency.
 *
 * @param {string[]} files
 * @param {Record<string, number>} durationsMs
 * @param {number} shardIndex 1-based shard index (`1..shardCount`)
 * @param {number} shardCount total shards (`>= 1`)
 * @param {number} [defaultWeightMs]
 */
export function allocateLptShard(
	files,
	durationsMs,
	shardIndex,
	shardCount,
	defaultWeightMs = DEFAULT_UNMEASURED_WEIGHT_MS,
) {
	if (!Number.isInteger(shardCount) || shardCount < 1) {
		throw new RangeError(`shardCount must be an integer >= 1, got ${shardCount}`);
	}
	if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
		throw new RangeError(`shardIndex must be in 1..${shardCount}, got ${shardIndex}`);
	}

	const weighted = files.map((file) => {
		const raw = durationsMs[file];
		const weightMs = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : defaultWeightMs;
		return { file, weightMs };
	});
	// Deterministic LPT order: heaviest first, tie-broken lexicographically by POSIX path.
	weighted.sort((a, b) => b.weightMs - a.weightMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

	/** @type {Array<Array<{ file: string, weightMs: number }>>} */
	const bins = Array.from({ length: shardCount }, () => []);
	const totals = new Array(shardCount).fill(0);

	for (const entry of weighted) {
		let target = 0;
		for (let i = 1; i < shardCount; i++) {
			if (
				totals[i] < totals[target] ||
				(totals[i] === totals[target] && bins[i].length < bins[target].length)
			) {
				target = i;
			}
		}
		bins[target].push(entry);
		totals[target] += entry.weightMs;
	}

	const selected = bins[shardIndex - 1];
	const maxWeightMs = Math.max(...totals);
	const minWeightMs = Math.min(...totals);
	return {
		shardIndex,
		shardCount,
		files: selected.map((e) => e.file),
		shardWeightMs: totals[shardIndex - 1],
		allShardWeightsMs: totals,
		imbalanceMs: maxWeightMs - minWeightMs,
	};
}

/**
 * Returns conservative default Vitest `maxWorkers` per execution class for a given CPU count.
 * - `fast`: uses up to 8 workers (4 on 4-vCPU CI runners) for rapid unit feedback.
 * - `browser`: strictly caps Chromium concurrency at 2 per runner to avoid RAM/CPU spikes.
 * - `process`: leaves >= 1 vCPU headroom for spawned child processes (3 on 4-vCPU CI runners, up to 6 locally).
 *
 * @param {"fast" | "browser" | "process" | "all"} cls
 * @param {number} [cpuCount]
 */
export function defaultMaxWorkersForClass(cls, cpuCount = availableParallelism()) {
	const cpus = Math.max(1, cpuCount);
	if (cls === "browser") return Math.min(cpus, 2);
	if (cls === "fast") return Math.min(cpus, 8);
	if (cls === "process") {
		if (cpus <= 2) return 1;
		if (cpus <= 4) return 3;
		return Math.min(6, cpus - 2);
	}
	return cpus <= 4 ? Math.max(1, cpus - 1) : Math.min(6, cpus - 2);
}

/**
 * Validates complete coverage accounting across all general execution classes, shard plans,
 * specialist suite files, and workstation-path hygiene rules.
 *
 * @param {string} [rootDir]
 * @param {{ fast: number, browser: number, process: number }} [shardPlan]
 */
export function validateCoverageAccounting(rootDir = REPO_ROOT, shardPlan = { fast: 1, browser: 1, process: 4 }) {
	const { allFiles, classes, hints, sources } = partitionTestFiles(rootDir);
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];

	const diskSet = new Set(allFiles);
	/** @type {Map<string, string>} */
	const seenClass = new Map();

	for (const cls of EXECUTION_CLASSES) {
		for (const file of classes[cls]) {
			if (!diskSet.has(file)) {
				errors.push(`phantom file in class "${cls}": ${file}`);
			}
			const prev = seenClass.get(file);
			if (prev) {
				errors.push(`duplicate file across classes "${prev}" and "${cls}": ${file}`);
			} else {
				seenClass.set(file, cls);
			}
		}
	}

	for (const file of allFiles) {
		if (!seenClass.has(file)) {
			errors.push(`unclassified test file omitted from all general partitions: ${file}`);
		}
	}

	// Verify each class's LPT shard plan covers the class completely with zero overlap.
	/** @type {Record<string, { fileCount: number, totalWeightMs: number, shards: number, shardWeightsMs: number[], imbalanceMs: number }>} */
	const classSummaries = {};
	for (const cls of EXECUTION_CLASSES) {
		const shardCount = shardPlan[cls];
		const classFiles = classes[cls];
		/** @type {Set<string>} */
		const covered = new Set();
		let shardWeightsMs = /** @type {number[]} */ ([]);
		let imbalanceMs = 0;

		for (let i = 1; i <= shardCount; i++) {
			const alloc = allocateLptShard(classFiles, hints.durationsMs, i, shardCount, hints.defaultWeightMs);
			shardWeightsMs = alloc.allShardWeightsMs;
			imbalanceMs = alloc.imbalanceMs;
			for (const file of alloc.files) {
				if (covered.has(file)) {
					errors.push(`duplicate file across shards in class "${cls}": ${file}`);
				}
				covered.add(file);
			}
		}
		for (const file of classFiles) {
			if (!covered.has(file)) {
				errors.push(`file dropped by shard plan in class "${cls}": ${file}`);
			}
		}
		const totalWeightMs = shardWeightsMs.reduce((a, b) => a + b, 0);
		classSummaries[cls] = {
			fileCount: classFiles.length,
			totalWeightMs,
			shards: shardCount,
			shardWeightsMs,
			imbalanceMs,
		};
	}

	// Verify browser files are never misplaced outside `browser` and never in `fast`.
	for (const file of allFiles) {
		const src = sources[file];
		if (!BROWSER_TEXT_ONLY_FILES.has(file) && (src.includes("Browser.launch(") || src.includes("ENDO_REQUIRE_BROWSER"))) {
			if (seenClass.get(file) !== "browser") {
				errors.push(`browser-requiring test file is not in "browser" class: ${file} (in "${seenClass.get(file)}")`);
			}
		}
		if (seenClass.get(file) === "fast" && src.includes("ensureSharedStudioUiDir")) {
			errors.push(`Studio UI test file must not be in "fast" class: ${file}`);
		}
	}

	// Verify every specialist suite file still exists on disk.
	for (const [job, spec] of Object.entries(SPECIALIST_SUITES)) {
		for (const file of spec.files) {
			if (!diskSet.has(file)) {
				errors.push(`specialist job "${job}" references missing test file: ${file}`);
			}
		}
	}

	// Cross-check `.github/workflows/ci.yml` against the shard plan and specialist invariants so workflow drift fails loudly.
	const ciPath = join(rootDir, ".github", "workflows", "ci.yml");
	try {
		const ciText = readFileSync(ciPath, "utf8");
		const extractJob = (name) => {
			const start = ciText.indexOf(`\n  ${name}:\n`);
			if (start === -1) return null;
			const next = ciText.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
			return next === -1 ? ciText.slice(start) : ciText.slice(start, start + 1 + next);
		};
		const fastJob = extractJob("test-fast");
		if (!fastJob || !fastJob.includes("--class=fast")) {
			errors.push('ci.yml job "test-fast" is missing or does not run --class=fast');
		}
		const browserJob = extractJob("test-browser");
		if (!browserJob || !browserJob.includes("--class=browser")) {
			errors.push('ci.yml job "test-browser" is missing or does not run --class=browser');
		} else if (!/ENDO_REQUIRE_BROWSER:\s*"1"/.test(browserJob)) {
			errors.push('ci.yml job "test-browser" must set ENDO_REQUIRE_BROWSER: "1"');
		}
		const processJob = extractJob("test-process");
		const expectedShards = Array.from({ length: shardPlan.process }, (_, idx) => idx + 1).join(", ");
		if (!processJob || !processJob.includes(`--class=process --shard=\${{ matrix.shard }}/${shardPlan.process}`)) {
			errors.push(
				`ci.yml job "test-process" is missing or does not run --class=process --shard=\${{ matrix.shard }}/${shardPlan.process}`,
			);
		} else if (!processJob.includes(`shard: [${expectedShards}]`)) {
			errors.push(`ci.yml job "test-process" matrix.shard must be [${expectedShards}]`);
		}
		for (const [jobName, spec] of Object.entries(SPECIALIST_SUITES)) {
			const block = extractJob(jobName);
			if (!block) {
				errors.push(`ci.yml is missing required specialist job "${jobName}"`);
				continue;
			}
			for (const file of spec.files) {
				if (!block.includes(file)) {
					errors.push(`ci.yml specialist job "${jobName}" does not reference required test file: ${file}`);
				}
			}
		}
	} catch (error) {
		errors.push(`unable to read .github/workflows/ci.yml for coverage cross-check: ${String(error)}`);
	}

	// Verify no hardcoded workstation user-home executable paths sneak into tests (B4 guard).
	const workstationPathPattern = /\/home\/noctem\//;
	for (const file of allFiles) {
		if (WORKSTATION_PATH_EXCEPTIONS.has(file)) continue;
		if (workstationPathPattern.test(sources[file])) {
			errors.push(`workstation-specific home path found in test file: ${file}`);
		}
	}

	// Warn (do not fail) if duration hints contain entries for removed/renamed files or miss newly added ones.
	const unmeasured = allFiles.filter((f) => typeof hints.durationsMs[f] !== "number");
	if (unmeasured.length > 0) {
		warnings.push(
			`${unmeasured.length} test file(s) lack hosted duration hints and use conservative default (${hints.defaultWeightMs}ms): ${unmeasured.slice(0, 5).join(", ")}${unmeasured.length > 5 ? ", ..." : ""}`,
		);
	}
	const stale = Object.keys(hints.durationsMs).filter((f) => !diskSet.has(f));
	if (stale.length > 0) {
		warnings.push(`${stale.length} stale entry/entries in tests/test-durations.json: ${stale.slice(0, 5).join(", ")}`);
	}

	return {
		ok: errors.length === 0,
		totalDiskFiles: allFiles.length,
		classSummaries,
		specialistJobs: Object.keys(SPECIALIST_SUITES),
		errors,
		warnings,
	};
}
