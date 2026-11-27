// Fail-closed actual Vitest execution reconciliation and confidential CI failure summarization
// (CI-RELIABILITY-001 Follow-up: F3 & F6).
//
// Core invariant:
//   A planned allocation (`scripts/test-inventory.mjs`) does NOT prove execution.
//   Complete CI partition runs must reconcile the exact expected file set against a fresh, valid JSON
//   report written by that exact Vitest invocation — failing closed on missing files, unexpected files,
//   duplicate entries, missing/corrupt/stale reports, zero-test files, unexpected whole-file skips of
//   mandatory suites, inconsistent totals, or nonzero exit status.
//
// Confidentiality invariant (F6):
//   Sanitized diagnostic artifacts and `$GITHUB_STEP_SUMMARY` tables emit only host-generated failure
//   categories, bounded error class names, normalized relative paths, sanitized test labels, and source
//   locations — never raw assertion bodies, expected/received diffs, environment variables, tokens, or
//   private fixture payloads. Full output remains scoped to the standard GitHub Actions job log.

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";

/**
 * Flags/patterns forbidden in `--strict-accounting` mode because they can narrow discovery, skip tests,
 * allow empty runs, or weaken isolation.
 */
const FORBIDDEN_STRICT_FLAGS = [
	"-t",
	"--testNamePattern",
	"--test-name-pattern",
	"--include",
	"--exclude",
	"--passWithNoTests",
	"--pass-with-no-tests",
	"--no-isolate",
	"--isolate=false",
	"--changed",
	"--related",
	"--bail",
	"--shard",
	"--grep",
	"--file-parallelism=false",
	"--only",
];

/**
 * Validates that passthrough arguments cannot weaken strict complete-partition CI execution.
 * Returns an array of violation messages (empty when safe).
 * @param {readonly string[]} passthroughArgs
 * @returns {string[]}
 */
export function validateStrictPassthroughArgs(passthroughArgs) {
	/** @type {string[]} */
	const violations = [];
	for (const raw of passthroughArgs) {
		const arg = String(raw);
		const flagName = arg.split("=", 1)[0];
		if (
			FORBIDDEN_STRICT_FLAGS.includes(arg) ||
			FORBIDDEN_STRICT_FLAGS.includes(flagName) ||
			arg === "--isolate=false"
		) {
			violations.push(`forbidden passthrough argument in strict accounting mode: ${arg}`);
			continue;
		}
		if (!arg.startsWith("-")) {
			violations.push(`positional filter not allowed in strict accounting mode: ${arg}`);
		}
	}
	return violations;
}

/**
 * Normalizes a reported file path from Vitest's JSON reporter into a POSIX repo-relative path.
 * Rejects empty, non-string, escaping (`..`), or outside-repo paths.
 * @param {unknown} rawPath
 * @param {string} canonicalRepoRoot
 * @returns {{ ok: true, relPath: string } | { ok: false, reason: string }}
 */
export function normalizeReportedFilePath(rawPath, canonicalRepoRoot) {
	if (typeof rawPath !== "string" || rawPath.trim() === "") {
		return { ok: false, reason: "empty or non-string reported file path" };
	}
	let resolved;
	try {
		const candidate = isAbsolute(rawPath) ? rawPath : resolve(canonicalRepoRoot, rawPath);
		resolved = lstatExistsSafe(candidate) ? realpathSync(candidate) : resolve(candidate);
	} catch (error) {
		return { ok: false, reason: `unresolvable path (${String(error)})` };
	}
	const rel = relative(canonicalRepoRoot, resolved).split("\\").join(posix.sep);
	if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
		return { ok: false, reason: "reported file path escapes repository root" };
	}
	return { ok: true, relPath: rel };
}

/** @param {string} p */
function lstatExistsSafe(p) {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Strips ANSI escape sequences and ASCII control characters, collapses whitespace, and bounds length.
 * @param {unknown} value
 * @param {number} [maxLen]
 */
export function sanitizeBoundedLabel(value, maxLen = 180) {
	const raw = String(value ?? "");
	// Strip CSI/OSC ANSI escape sequences and ASCII control characters (0x00-0x1F, 0x7F).
	const stripped = raw
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/[\x00-\x1f\x7f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 3)}...` : stripped;
}

/**
 * Escapes characters that could inject Markdown headings, code spans, HTML, or table cell breaks into
 * `$GITHUB_STEP_SUMMARY`.
 * @param {unknown} value
 * @param {number} [maxLen]
 */
export function escapeMarkdownCell(value, maxLen = 180) {
	return sanitizeBoundedLabel(value, maxLen).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

/**
 * Derives a closed, host-generated failure category from raw Vitest error messages without persisting
 * the raw assertion payloads or values.
 * @param {readonly string[]} failureMessages
 * @param {string} [suiteMessage]
 * @returns {{ category: string, errorName: string }}
 */
export function classifyFailureSignature(failureMessages, suiteMessage = "") {
	const combined = [...failureMessages, suiteMessage].filter(Boolean).join("\n");
	// Inspect only message header lines (exclude stack frames starting with `at ` which can mention `runWithTimeout`).
	const headerLines = combined
		.split("\n")
		.filter((line) => !/^\s*at\s+/.test(line))
		.slice(0, 6)
		.join("\n");
	const firstLine = sanitizeBoundedLabel(headerLines.split("\n")[0] ?? "", 200);
	const nameMatch = /^([A-Za-z][A-Za-z0-9_]{1,63}(?:Error|Exception))\b/.exec(firstLine);
	const errorName = nameMatch ? nameMatch[1] : "Error";

	let category = "unknown";
	if (errorName === "AssertionError" || /\bAssertionError\b/.test(firstLine)) category = "assertion";
	else if (/timed?\s*out|\btimeout\b|AcpTimeoutError/i.test(headerLines)) category = "timeout";
	else if (/\bexpected\b.+\bto\b/i.test(headerLines)) category = "assertion";
	else if (/ENOENT|EACCES|EPERM|EISDIR|ENOTEMPTY/i.test(headerLines)) category = "filesystem";
	else if (/EADDRINUSE|ECONNREFUSED|ECONNRESET|socket/i.test(headerLines)) category = "network";
	else if (/exited|SIGKILL|SIGTERM|spawn/i.test(headerLines)) category = "process-lifecycle";
	else if (/TypeError|RangeError|SyntaxError|ReferenceError/i.test(headerLines)) category = "runtime-error";
	else if (suiteMessage && failureMessages.length === 0) category = "suite-error";

	return { category, errorName };
}

/**
 * Reconciles the expected test file allocation against the actual JSON report written by Vitest.
 * Fails closed on any missing/unexpected/duplicate file, missing/corrupt/stale report, zero-test file,
 * unpermitted whole-file skip, inconsistent aggregate totals, or nonzero exit status.
 *
 * @param {{
 *   repoRoot: string,
 *   expectedFiles: readonly string[],
 *   reportPath: string,
 *   startedAtMs: number,
 *   endedAtMs: number,
 *   vitestExitCode: number,
 *   vitestSignal?: string | null,
 *   permittedOptionalWholeFileSkips?: Readonly<Record<string, string>>,
 * }} opts
 */
export function reconcileVitestExecution(opts) {
	const {
		repoRoot,
		expectedFiles,
		reportPath,
		startedAtMs,
		endedAtMs,
		vitestExitCode,
		vitestSignal = null,
		permittedOptionalWholeFileSkips = {},
	} = opts;

	const canonicalRoot = realpathSync(repoRoot);
	const expectedSet = new Set(expectedFiles);
	/** @type {Array<{ code: string, detail: string }>} */
	const errors = [];

	if (vitestSignal) {
		errors.push({ code: "VITEST_SIGNALLED", detail: `Vitest terminated by signal ${vitestSignal}` });
	}
	if (vitestExitCode !== 0) {
		errors.push({ code: "VITEST_NONZERO_EXIT", detail: `Vitest exited with status ${vitestExitCode}` });
	}

	/** @type {Array<{ file: string, status: string, durationMs: number, passed: number, failed: number, skipped: number, todo: number }>} */
	const fileResults = [];
	/** @type {Array<{ file: string, fullName: string, category: string, errorName: string, location: { line: number, column: number } | null }>} */
	const failures = [];
	/** @type {string[]} */
	const duplicateFiles = [];
	/** @type {string[]} */
	const unexpectedFiles = [];
	/** @type {string[]} */
	const zeroTestFiles = [];
	/** @type {string[]} */
	const mandatoryWholeFileSkips = [];
	/** @type {Array<{ file: string, skipped: number, reason: string }>} */
	const permittedWholeFileSkipsObserved = [];

	let parsed = null;
	if (!reportPath) {
		errors.push({ code: "MISSING_REPORT_PATH", detail: "No JSON report path was configured" });
	} else {
		let stat;
		try {
			stat = lstatSync(reportPath);
		} catch {
			errors.push({ code: "MISSING_REPORT", detail: "Expected Vitest JSON report file does not exist" });
			stat = null;
		}
		if (stat !== null) {
			if (!stat.isFile()) {
				errors.push({ code: "INVALID_REPORT_TYPE", detail: "Vitest JSON report path is not a regular file" });
			} else if (stat.size === 0) {
				errors.push({ code: "EMPTY_REPORT", detail: "Vitest JSON report file is empty" });
			} else if (stat.mtimeMs < startedAtMs - 1_000) {
				errors.push({
					code: "STALE_REPORT",
					detail: `Vitest JSON report mtime (${Math.round(stat.mtimeMs)}) precedes invocation start (${Math.round(startedAtMs)})`,
				});
			} else {
				try {
					const obj = JSON.parse(readFileSync(reportPath, "utf8"));
					if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
						errors.push({ code: "MALFORMED_REPORT", detail: "Vitest JSON report root is not an object" });
					} else {
						parsed = obj;
					}
				} catch (error) {
					errors.push({
						code: "CORRUPT_REPORT",
						detail: `Failed to parse Vitest JSON report: ${sanitizeBoundedLabel(error instanceof Error ? error.message : error, 120)}`,
					});
				}
			}
		}
	}

	const observedSet = new Set();
	let sumPassed = 0;
	let sumFailed = 0;
	let sumSkipped = 0;
	let sumTodo = 0;
	let sumTotal = 0;

	if (parsed !== null) {
		const requiredNumeric = [
			"startTime",
			"numTotalTests",
			"numPassedTests",
			"numFailedTests",
			"numPendingTests",
			"numTodoTests",
			"numFailedTestSuites",
			"numPendingTestSuites",
		];
		let schemaOk = typeof parsed.success === "boolean" && Array.isArray(parsed.testResults);
		for (const field of requiredNumeric) {
			if (typeof parsed[field] !== "number" || !Number.isFinite(parsed[field])) schemaOk = false;
		}
		if (!schemaOk) {
			errors.push({ code: "MALFORMED_REPORT_SCHEMA", detail: "Vitest JSON report is missing required fields" });
		} else {
			if (parsed.startTime < startedAtMs - 5_000 || parsed.startTime > endedAtMs + 5_000) {
				errors.push({
					code: "STALE_REPORT_TIMESTAMP",
					detail: `Vitest JSON report startTime (${parsed.startTime}) outside invocation window [${startedAtMs - 5_000}, ${endedAtMs + 5_000}]`,
				});
			}
			if (parsed.success !== true) {
				errors.push({ code: "REPORT_UNSUCCESSFUL", detail: "Vitest JSON report marked success=false" });
			}
			if (parsed.numFailedTestSuites !== 0) {
				errors.push({
					code: "FAILED_SUITES_REPORTED",
					detail: `Vitest JSON report recorded ${parsed.numFailedTestSuites} failed suite(s)`,
				});
			}
			if (parsed.numPendingTestSuites !== 0) {
				errors.push({
					code: "PENDING_SUITES_REPORTED",
					detail: `Vitest JSON report recorded ${parsed.numPendingTestSuites} unfinished/pending suite(s)`,
				});
			}

			for (const suite of parsed.testResults) {
				const norm = normalizeReportedFilePath(suite?.name, canonicalRoot);
				if (!norm.ok) {
					errors.push({ code: "INVALID_REPORTED_PATH", detail: norm.reason });
					continue;
				}
				const relFile = norm.relPath;
				if (observedSet.has(relFile)) {
					duplicateFiles.push(relFile);
					continue;
				}
				observedSet.add(relFile);
				if (!expectedSet.has(relFile)) {
					unexpectedFiles.push(relFile);
				}

				const durationMs =
					typeof suite.endTime === "number" && typeof suite.startTime === "number"
						? Math.max(0, Math.round(suite.endTime - suite.startTime))
						: 0;
				const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : null;
				if (assertions === null) {
					errors.push({ code: "MALFORMED_ASSERTIONS", detail: `${relFile} has non-array assertionResults` });
					continue;
				}

				let passed = 0;
				let failed = 0;
				let skipped = 0;
				let todo = 0;
				let pendingRunning = 0;

				for (const a of assertions) {
					const st = String(a?.status ?? "");
					if (st === "passed") passed++;
					else if (st === "failed") {
						failed++;
						const msgs = Array.isArray(a.failureMessages) ? a.failureMessages.map(String) : [];
						const sig = classifyFailureSignature(msgs);
						const loc =
							a?.location && typeof a.location.line === "number" && typeof a.location.column === "number"
								? { line: a.location.line, column: a.location.column }
								: null;
						failures.push({
							file: relFile,
							fullName: sanitizeBoundedLabel(a.fullName ?? a.title ?? "unknown", 180),
							category: sig.category,
							errorName: sig.errorName,
							location: loc,
						});
					} else if (st === "skipped") skipped++;
					else if (st === "todo") todo++;
					else if (st === "pending") pendingRunning++;
					else {
						errors.push({
							code: "UNKNOWN_ASSERTION_STATUS",
							detail: `${relFile} reported unknown assertion status "${sanitizeBoundedLabel(st, 32)}"`,
						});
					}
				}

				const suiteStatus = String(suite.status ?? "unknown");
				if (suiteStatus !== "passed" && failed === 0) {
					const sig = classifyFailureSignature([], String(suite.message ?? ""));
					failures.push({
						file: relFile,
						fullName: "(suite-level error)",
						category: sig.category === "unknown" ? "suite-error" : sig.category,
						errorName: sig.errorName,
						location: null,
					});
					errors.push({ code: "SUITE_FAILED", detail: `${relFile} reported suite status "${suiteStatus}"` });
				}
				if (pendingRunning > 0) {
					errors.push({
						code: "INTERRUPTED_TESTS",
						detail: `${relFile} has ${pendingRunning} unfinished/pending test(s)`,
					});
				}
				if (assertions.length === 0) {
					zeroTestFiles.push(relFile);
				} else if (passed === 0 && failed === 0) {
					const permittedReason = permittedOptionalWholeFileSkips[relFile];
					if (permittedReason && skipped > 0) {
						permittedWholeFileSkipsObserved.push({ file: relFile, skipped, reason: permittedReason });
					} else {
						mandatoryWholeFileSkips.push(relFile);
					}
				}

				sumPassed += passed;
				sumFailed += failed;
				sumSkipped += skipped;
				sumTodo += todo;
				sumTotal += assertions.length;

				fileResults.push({
					file: relFile,
					status: suiteStatus,
					durationMs,
					passed,
					failed,
					skipped,
					todo,
				});
			}

			// Reconcile aggregate counts against summed per-file assertion results.
			if (
				sumTotal !== parsed.numTotalTests ||
				sumPassed !== parsed.numPassedTests ||
				sumFailed !== parsed.numFailedTests ||
				sumTodo !== parsed.numTodoTests ||
				sumSkipped > parsed.numPendingTests
			) {
				errors.push({
					code: "AGGREGATE_MISMATCH",
					detail: `Aggregate mismatch: summed(total=${sumTotal}, passed=${sumPassed}, failed=${sumFailed}, skipped=${sumSkipped}, todo=${sumTodo}) vs report(total=${parsed.numTotalTests}, passed=${parsed.numPassedTests}, failed=${parsed.numFailedTests}, pending=${parsed.numPendingTests}, todo=${parsed.numTodoTests})`,
				});
			}
			if (parsed.numFailedTests !== 0 || sumFailed !== 0) {
				errors.push({
					code: "FAILED_TESTS_REPORTED",
					detail: `Vitest reported ${Math.max(parsed.numFailedTests, sumFailed)} failed test(s)`,
				});
			}
		}
	}

	const missingFiles = expectedFiles.filter((f) => !observedSet.has(f));
	if (missingFiles.length > 0) {
		errors.push({
			code: "MISSING_EXPECTED_FILES",
			detail: `${missingFiles.length} expected file(s) missing from report: ${missingFiles.slice(0, 5).join(", ")}${missingFiles.length > 5 ? ", ..." : ""}`,
		});
	}
	if (unexpectedFiles.length > 0) {
		errors.push({
			code: "UNEXPECTED_FILES",
			detail: `${unexpectedFiles.length} unexpected file(s) in report: ${unexpectedFiles.slice(0, 5).join(", ")}${unexpectedFiles.length > 5 ? ", ..." : ""}`,
		});
	}
	if (duplicateFiles.length > 0) {
		errors.push({
			code: "DUPLICATE_FILE_REPORT",
			detail: `${duplicateFiles.length} duplicate file entry/entries in report: ${duplicateFiles.slice(0, 5).join(", ")}`,
		});
	}
	if (zeroTestFiles.length > 0) {
		errors.push({
			code: "ZERO_TEST_FILE",
			detail: `${zeroTestFiles.length} file(s) reported zero tests: ${zeroTestFiles.slice(0, 5).join(", ")}`,
		});
	}
	if (mandatoryWholeFileSkips.length > 0) {
		errors.push({
			code: "MANDATORY_SUITE_ALL_SKIPPED",
			detail: `${mandatoryWholeFileSkips.length} mandatory file(s) had all tests skipped: ${mandatoryWholeFileSkips.slice(0, 5).join(", ")}`,
		});
	}

	fileResults.sort((a, b) => b.durationMs - a.durationMs || (a.file < b.file ? -1 : 1));

	return {
		ok: errors.length === 0,
		errors,
		fileResults,
		failures: failures.slice(0, 50),
		summary: {
			expectedFileCount: expectedFiles.length,
			observedFileCount: observedSet.size,
			missingFiles,
			unexpectedFiles,
			duplicateFiles,
			zeroTestFiles,
			mandatoryWholeFileSkips,
			permittedWholeFileSkips: permittedWholeFileSkipsObserved,
			totalTests: sumTotal,
			passedTests: sumPassed,
			failedTests: sumFailed,
			skippedTests: sumSkipped,
			todoTests: sumTodo,
		},
	};
}
