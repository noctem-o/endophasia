#!/usr/bin/env node
// Read-only CI reliability and timing metrics analyzer (CI-RELIABILITY-001, Phase F).
//
// Usage:
//   node scripts/analyze-ci-history.mjs --input=<path-to-historical-runs.json> [--json]
//   node scripts/analyze-ci-history.mjs --live [--repo=noctem-o/endophasia] [--workflow=ci.yml] [--limit=30] [--json]
//
// Works offline on captured/sanitized JSON snapshots or online via bounded read-only `gh api` calls.
// Preserves raw denominators, never silently discards failed attempts, and deduplicates GitHub Actions
// partial-rerun cloned jobs (which carry earlier attempts' timestamps under new job IDs).

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {number[]} values
 * @param {number} p
 */
export function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Computes reliability, elapsed time, per-job duration, and runner-minute metrics from a normalized
 * array of workflow run records (matching `historical-runs-40.json` schema).
 *
 * Deduplicates GitHub Actions partial-rerun cloned jobs per run using `(name, startedAt, completedAt)`
 * so already-passed jobs carried forward from Attempt 1 do not double-count runner-minutes or span
 * multi-hour elapsed windows when computing workflow duration.
 *
 * @param {Array<{
 *   runId: number,
 *   event?: string,
 *   branch?: string,
 *   prNumbers?: number[],
 *   attemptsCount?: number,
 *   firstAttemptConclusion?: string | null,
 *   attempt1Conclusion?: string | null,
 *   latestConclusion?: string | null,
 *   finalConclusion?: string | null,
 *   attempts: Array<{
 *     attempt: number,
 *     conclusion: string | null,
 *     workflowElapsedSec?: number | null,
 *     jobs: Array<{
 *       name: string,
 *       conclusion: string | null,
 *       startedAt?: string | null,
 *       completedAt?: string | null,
 *       createdAt?: string | null,
 *       durationSec?: number | null,
 *       queueSec?: number | null,
 *     }>
 *   }>
 * }>} runs
 */
export function computeCiHistoryMetrics(runs) {
	const totalRuns = runs.length;
	let cancelledAttempt1 = 0;
	let decisiveAttempt1 = 0;
	let firstAttemptSuccess = 0;
	let firstAttemptFailure = 0;
	let decisiveFinal = 0;
	let eventualSuccess = 0;
	let failedThenPassed = 0;
	let rerunToCompletion = 0;

	/** @type {number[]} */
	const passingWorkflowElapsedSec = [];
	/** @type {number[]} */
	const attempt1PassingElapsedSec = [];
	/** @type {Map<string, number[]>} */
	const passingJobDurations = new Map();
	/** @type {Map<string, { passed: number, failed: number, other: number }>} */
	const jobOutcomes = new Map();
	let uniqueJobExecutions = 0;
	let clonedJobRecordsSkipped = 0;
	let totalRunnerSec = 0;
	let rerunRunnerSec = 0;
	/** @type {number[]} */
	const shardImbalancesSec = [];

	for (const run of runs) {
		const attempts = [...(run.attempts ?? [])].sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
		// Never silently promote a later attempt (e.g., attempt 2) to first-attempt standing if attempt 1 is absent.
		const attempt1Record = attempts.find((a) => a.attempt === 1);
		const a1 = run.firstAttemptConclusion ?? run.attempt1Conclusion ?? attempt1Record?.conclusion ?? null;
		const fin =
			run.latestConclusion ??
			run.finalConclusion ??
			attempts[Math.max(0, attempts.length - 1)]?.conclusion ??
			null;
		if (a1 === "cancelled") {
			cancelledAttempt1++;
		} else if (a1 === "success" || a1 === "failure" || a1 === "timed_out") {
			decisiveAttempt1++;
			if (a1 === "success") firstAttemptSuccess++;
			else firstAttemptFailure++;
		}
		if (fin === "success" || fin === "failure" || fin === "timed_out") {
			decisiveFinal++;
			if (fin === "success") eventualSuccess++;
		}
		if (a1 === "failure" || a1 === "timed_out") {
			if (fin === "success") failedThenPassed++;
			if (attempts.length > 1 && (fin === "success" || fin === "failure" || fin === "timed_out")) {
				rerunToCompletion++;
			}
		}

		// Track unique executed jobs per run by (name, startedAt, completedAt) so partial-rerun clones are excluded.
		/** @type {Set<string>} */
		const seenExecutedJobs = new Set();

		for (const att of attempts) {
			const jobList = att.jobs ?? [];
			/** @type {typeof jobList} */
			const executedInAttempt = [];
			/** @type {number[]} */
			const generalShardDurs = [];

			for (const job of jobList) {
				const st = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
				const cp = job.completedAt ? Date.parse(job.completedAt) : Number.NaN;
				const rawDur =
					typeof job.durationSec === "number"
						? job.durationSec
						: Number.isFinite(st) && Number.isFinite(cp)
							? Math.max(0, (cp - st) / 1000)
							: null;

				if (job.conclusion === "success" && typeof rawDur === "number") {
					if (/^Test \(shard \d+\/\d+\)$/.test(job.name) || /^Test \(process \d+\/\d+\)$/.test(job.name)) {
						generalShardDurs.push(rawDur);
					}
				}

				const dedupKey =
					job.startedAt && job.completedAt ? `${job.name}|${job.startedAt}|${job.completedAt}` : null;
				if (dedupKey && seenExecutedJobs.has(dedupKey)) {
					clonedJobRecordsSkipped++;
					continue;
				}
				if (dedupKey) seenExecutedJobs.add(dedupKey);
				executedInAttempt.push(job);
				uniqueJobExecutions++;

				const dur = typeof rawDur === "number" && rawDur >= 0 ? rawDur : 0;
				totalRunnerSec += dur;
				if (att.attempt >= 2) rerunRunnerSec += dur;

				const stat = jobOutcomes.get(job.name) ?? { passed: 0, failed: 0, other: 0 };
				if (job.conclusion === "success") {
					stat.passed++;
					if (typeof rawDur === "number") {
						const arr = passingJobDurations.get(job.name) ?? [];
						arr.push(rawDur);
						passingJobDurations.set(job.name, arr);
					}
				} else if (job.conclusion === "failure" || job.conclusion === "timed_out") {
					stat.failed++;
				} else {
					stat.other++;
				}
				jobOutcomes.set(job.name, stat);
			}

			// Compute attempt elapsed time solely over jobs that actually executed in this attempt (excluding Attempt 1 clones).
			const execStarts = executedInAttempt
				.map((j) => (j.startedAt ? Date.parse(j.startedAt) : Number.NaN))
				.filter(Number.isFinite);
			const execEnds = executedInAttempt
				.map((j) => (j.completedAt ? Date.parse(j.completedAt) : Number.NaN))
				.filter(Number.isFinite);
			const attemptElapsedSec =
				typeof att.workflowElapsedSec === "number"
					? att.workflowElapsedSec
					: execStarts.length > 0 && execEnds.length > 0
						? Math.max(0, (Math.max(...execEnds) - Math.min(...execStarts)) / 1000)
						: null;

			if (att.conclusion === "success" && typeof attemptElapsedSec === "number") {
				passingWorkflowElapsedSec.push(attemptElapsedSec);
				if (att.attempt === 1) {
					attempt1PassingElapsedSec.push(attemptElapsedSec);
				}
			}
			if (att.conclusion === "success" && generalShardDurs.length >= 2) {
				shardImbalancesSec.push(Math.max(...generalShardDurs) - Math.min(...generalShardDurs));
			}
		}
	}

	/** @type {Record<string, { n: number, medianSec: number | null, p95Sec: number | null, passed: number, failed: number }>} */
	const jobs = {};
	for (const [name, outcome] of [...jobOutcomes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const durs = passingJobDurations.get(name) ?? [];
		jobs[name] = {
			n: durs.length,
			medianSec: durs.length > 0 ? round1(percentile(durs, 0.5)) : null,
			p95Sec: durs.length > 0 ? round1(percentile(durs, 0.95)) : null,
			passed: outcome.passed,
			failed: outcome.failed,
		};
	}

	return {
		totalRuns,
		cancelledAttempt1,
		decisiveAttempt1,
		firstAttemptSuccess,
		firstAttemptFailure,
		firstAttemptSuccessRate: decisiveAttempt1 > 0 ? round4(firstAttemptSuccess / decisiveAttempt1) : null,
		decisiveFinal,
		eventualSuccess,
		eventualSuccessRate: decisiveFinal > 0 ? round4(eventualSuccess / decisiveFinal) : null,
		failedThenPassed,
		sameRevisionFailureToPassRate: firstAttemptFailure > 0 ? round4(failedThenPassed / firstAttemptFailure) : null,
		rerunToCompletion,
		uniqueJobExecutions,
		clonedJobRecordsSkipped,
		passingWorkflowElapsedSec: {
			n: passingWorkflowElapsedSec.length,
			medianSec: round1(percentile(passingWorkflowElapsedSec, 0.5)),
			p95Sec: round1(percentile(passingWorkflowElapsedSec, 0.95)),
		},
		attempt1PassingElapsedSec: {
			n: attempt1PassingElapsedSec.length,
			medianSec: round1(percentile(attempt1PassingElapsedSec, 0.5)),
			p95Sec: round1(percentile(attempt1PassingElapsedSec, 0.95)),
		},
		shardImbalanceSec: {
			n: shardImbalancesSec.length,
			medianSec: round1(percentile(shardImbalancesSec, 0.5)),
			maxSec: shardImbalancesSec.length > 0 ? round1(Math.max(...shardImbalancesSec)) : null,
		},
		runnerMinutes: {
			total: round1(totalRunnerSec / 60),
			rerun: round1(rerunRunnerSec / 60),
			rerunShare: totalRunnerSec > 0 ? round4(rerunRunnerSec / totalRunnerSec) : 0,
		},
		jobs,
	};
}

/** @param {number | null} v */
function round1(v) {
	return v === null ? null : Math.round(v * 10) / 10;
}
/** @param {number | null} v */
function round4(v) {
	return v === null ? null : Math.round(v * 10000) / 10000;
}

/**
 * Fetches bounded read-only workflow run & original attempt data via `gh api`.
 * Preserves `createdAt`/`startedAt`/`completedAt` so deduplication matches offline analysis.
 * Fails explicitly if any historical attempt or jobs retrieval fails, so incomplete history can
 * never silently substitute a later passing rerun as Attempt 1.
 *
 * @param {{
 *   repo: string,
 *   workflow: string,
 *   limit: number,
 *   runGh?: (args: string[]) => { status: number | null, stdout: string, stderr: string },
 * }} opts
 */
export function fetchLiveRuns({ repo, workflow, limit, runGh }) {
	const execGh =
		runGh ??
		((ghArgs) => {
			const res = spawnSync("gh", ghArgs, { encoding: "utf8" });
			return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
		});
	const safeLimit = Math.max(1, Math.min(50, limit));
	const listRes = execGh([
		"api",
		`repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=${safeLimit}`,
	]);
	if (listRes.status !== 0) {
		throw new Error(`gh api failed listing runs: ${listRes.stderr || listRes.stdout}`);
	}
	const list = JSON.parse(listRes.stdout).workflow_runs ?? [];
	const normalized = [];
	for (const r of list) {
		const attemptsCount = Number(r.run_attempt ?? 1);
		const attempts = [];
		for (let a = 1; a <= attemptsCount; a++) {
			const attRes = execGh(["api", `repos/${repo}/actions/runs/${r.id}/attempts/${a}`]);
			if (attRes.status !== 0) {
				throw new Error(
					`Incomplete CI history: failed to fetch attempt ${a}/${attemptsCount} for run ${r.id} (exit ${attRes.status}): ${attRes.stderr || attRes.stdout}`,
				);
			}
			const jobsRes = execGh(["api", `repos/${repo}/actions/runs/${r.id}/attempts/${a}/jobs?per_page=100`]);
			if (jobsRes.status !== 0) {
				throw new Error(
					`Incomplete CI history: failed to fetch jobs for run ${r.id} attempt ${a}/${attemptsCount} (exit ${jobsRes.status}): ${jobsRes.stderr || jobsRes.stdout}`,
				);
			}
			const attObj = JSON.parse(attRes.stdout);
			const jobsObj = JSON.parse(jobsRes.stdout).jobs ?? [];
			const jobs = jobsObj.map((j) => {
				const st = j.started_at ? Date.parse(j.started_at) : Number.NaN;
				const cp = j.completed_at ? Date.parse(j.completed_at) : Number.NaN;
				const cr = j.created_at ? Date.parse(j.created_at) : Number.NaN;
				return {
					name: String(j.name),
					conclusion: j.conclusion ?? null,
					createdAt: j.created_at ?? null,
					startedAt: j.started_at ?? null,
					completedAt: j.completed_at ?? null,
					durationSec: Number.isFinite(st) && Number.isFinite(cp) ? Math.max(0, (cp - st) / 1000) : null,
					queueSec: Number.isFinite(cr) && Number.isFinite(st) ? Math.max(0, (st - cr) / 1000) : null,
				};
			});
			attempts.push({
				attempt: a,
				conclusion: attObj.conclusion ?? null,
				jobs,
			});
		}
		const attempt1 = attempts.find((a) => a.attempt === 1);
		if (!attempt1) {
			throw new Error(`Incomplete CI history: run ${r.id} is missing attempt 1`);
		}
		normalized.push({
			runId: r.id,
			event: r.event,
			branch: r.head_branch,
			attemptsCount,
			firstAttemptConclusion: attempt1.conclusion,
			latestConclusion: r.conclusion ?? null,
			attempts,
		});
	}
	return normalized;
}

const isCliEntry =
	Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));

if (isCliEntry) {
	const args = process.argv.slice(2);
	let inputPath = null;
	let live = false;
	let repo = "noctem-o/endophasia";
	let workflow = "ci.yml";
	let limit = 30;
	let jsonMode = false;

	for (let i = 0; i < args.length; i++) {
		const [flag, inline] = args[i].split(/=(.*)/s, 2);
		const requireVal = () => {
			const v = inline !== undefined ? inline : args[++i];
			if (v === undefined || v === "" || (inline === undefined && v.startsWith("--"))) {
				console.error(`${flag} requires a value`);
				process.exit(2);
			}
			return v;
		};
		if (flag === "--input") inputPath = requireVal();
		else if (flag === "--live") live = true;
		else if (flag === "--repo") repo = requireVal();
		else if (flag === "--workflow") workflow = requireVal();
		else if (flag === "--limit") {
			const raw = requireVal();
			const n = Number(raw);
			if (!Number.isInteger(n) || n < 1 || n > 50) {
				console.error(`Invalid --limit=${raw}; expected integer 1..50`);
				process.exit(2);
			}
			limit = n;
		} else if (flag === "--json") jsonMode = true;
		else {
			console.error(`Unknown argument: ${args[i]}`);
			process.exit(2);
		}
	}

	if (!inputPath && !live) {
		console.error("Specify either --input=<runs.json> or --live");
		process.exit(2);
	}
	if (live) {
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
			console.error(`Invalid --repo=${repo}; expected <owner>/<repo>`);
			process.exit(2);
		}
		if (!/^[A-Za-z0-9_.-]+$/.test(workflow)) {
			console.error(`Invalid --workflow=${workflow}; expected a workflow filename or numeric id`);
			process.exit(2);
		}
	}

	const runs = live ? fetchLiveRuns({ repo, workflow, limit }) : JSON.parse(readFileSync(inputPath, "utf8"));
	const metrics = computeCiHistoryMetrics(Array.isArray(runs) ? runs : runs.runs ?? []);

	if (jsonMode) {
		console.log(JSON.stringify(metrics, null, 2));
	} else {
		const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
		console.log(
			`CI History Summary (${metrics.totalRuns} completed runs, ${metrics.uniqueJobExecutions} unique job executions, ${metrics.clonedJobRecordsSkipped} partial-rerun clones skipped)`,
		);
		console.log(
			`  First-attempt success  : ${metrics.firstAttemptSuccess}/${metrics.decisiveAttempt1} (${pct(metrics.firstAttemptSuccessRate)}) [cancelled attempt 1: ${metrics.cancelledAttempt1}]`,
		);
		console.log(
			`  Eventual success       : ${metrics.eventualSuccess}/${metrics.decisiveFinal} (${pct(metrics.eventualSuccessRate)})`,
		);
		console.log(
			`  Failure -> Pass rerun  : ${metrics.failedThenPassed}/${metrics.firstAttemptFailure} (${pct(metrics.sameRevisionFailureToPassRate)})`,
		);
		console.log(
			`  Attempt-1 pass elapsed : median=${metrics.attempt1PassingElapsedSec.medianSec ?? "n/a"}s p95=${metrics.attempt1PassingElapsedSec.p95Sec ?? "n/a"}s (n=${metrics.attempt1PassingElapsedSec.n})`,
		);
		console.log(
			`  All passing attempts   : median=${metrics.passingWorkflowElapsedSec.medianSec ?? "n/a"}s p95=${metrics.passingWorkflowElapsedSec.p95Sec ?? "n/a"}s (n=${metrics.passingWorkflowElapsedSec.n})`,
		);
		console.log(
			`  Shard imbalance        : median=${metrics.shardImbalanceSec.medianSec ?? "n/a"}s max=${metrics.shardImbalanceSec.maxSec ?? "n/a"}s`,
		);
		console.log(
			`  Runner-minutes (unique): total=${metrics.runnerMinutes.total}m rerun=${metrics.runnerMinutes.rerun}m (${pct(metrics.runnerMinutes.rerunShare)})`,
		);
	}
}
