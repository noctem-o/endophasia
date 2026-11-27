#!/usr/bin/env node
// Read-only CI reliability and timing metrics analyzer (CI-RELIABILITY-001, Phase F).
//
// Usage:
//   node scripts/analyze-ci-history.mjs --input=<path-to-historical-runs.json> [--json]
//   node scripts/analyze-ci-history.mjs --live [--repo=noctem-o/endophasia] [--workflow=ci.yml] [--limit=30] [--json]
//
// Works offline on captured/sanitized JSON snapshots or online via bounded read-only `gh api` calls.
// Preserves raw denominators and never silently discards failed attempts.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
 * @param {Array<{
 *   runId: number,
 *   event?: string,
 *   branch?: string,
 *   prNumbers?: number[],
 *   attemptsCount?: number,
 *   attempt1Conclusion: string | null,
 *   finalConclusion: string | null,
 *   attempts: Array<{
 *     attempt: number,
 *     conclusion: string | null,
 *     workflowElapsedSec?: number | null,
 *     jobs: Array<{
 *       name: string,
 *       conclusion: string | null,
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
	/** @type {Map<string, number[]>} */
	const passingJobDurations = new Map();
	/** @type {Map<string, { passed: number, failed: number, other: number }>} */
	const jobOutcomes = new Map();
	let totalRunnerSec = 0;
	let rerunRunnerSec = 0;
	/** @type {number[]} */
	const shardImbalancesSec = [];

	for (const run of runs) {
		const a1 = run.firstAttemptConclusion ?? run.attempt1Conclusion ?? run.attempts?.[0]?.conclusion ?? null;
		const fin =
			run.latestConclusion ??
			run.finalConclusion ??
			run.attempts?.[Math.max(0, (run.attempts?.length ?? 1) - 1)]?.conclusion ??
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
			if ((run.attempts?.length ?? 1) > 1 && (fin === "success" || fin === "failure" || fin === "timed_out")) {
				rerunToCompletion++;
			}
		}

		for (const att of run.attempts ?? []) {
			const jobList = att.jobs ?? [];
			const jobStarts = jobList
				.map((j) => (j.startedAt ? Date.parse(j.startedAt) : Number.NaN))
				.filter(Number.isFinite);
			const jobEnds = jobList
				.map((j) => (j.completedAt ? Date.parse(j.completedAt) : Number.NaN))
				.filter(Number.isFinite);
			const elapsedSec =
				typeof att.workflowElapsedSec === "number"
					? att.workflowElapsedSec
					: jobStarts.length > 0 && jobEnds.length > 0
						? Math.max(0, (Math.max(...jobEnds) - Math.min(...jobStarts)) / 1000)
						: null;
			if (att.conclusion === "success" && typeof elapsedSec === "number") {
				passingWorkflowElapsedSec.push(elapsedSec);
			}
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
						if (/^Test \(shard \d+\/\d+\)$/.test(job.name) || /^Test \(process \d+\/\d+\)$/.test(job.name)) {
							generalShardDurs.push(rawDur);
						}
					}
				} else if (job.conclusion === "failure" || job.conclusion === "timed_out") {
					stat.failed++;
				} else {
					stat.other++;
				}
				jobOutcomes.set(job.name, stat);
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
		passingWorkflowElapsedSec: {
			n: passingWorkflowElapsedSec.length,
			medianSec: round1(percentile(passingWorkflowElapsedSec, 0.5)),
			p95Sec: round1(percentile(passingWorkflowElapsedSec, 0.95)),
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
 * @param {{ repo: string, workflow: string, limit: number }} opts
 */
function fetchLiveRuns({ repo, workflow, limit }) {
	const safeLimit = Math.max(1, Math.min(50, limit));
	const listRes = spawnSync(
		"gh",
		["api", `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=${safeLimit}`],
		{ encoding: "utf8" },
	);
	if (listRes.status !== 0) {
		throw new Error(`gh api failed: ${listRes.stderr || listRes.stdout}`);
	}
	const list = JSON.parse(listRes.stdout).workflow_runs ?? [];
	const normalized = [];
	for (const r of list) {
		const attemptsCount = Number(r.run_attempt ?? 1);
		const attempts = [];
		for (let a = 1; a <= attemptsCount; a++) {
			const attRes = spawnSync("gh", ["api", `repos/${repo}/actions/runs/${r.id}/attempts/${a}`], {
				encoding: "utf8",
			});
			const jobsRes = spawnSync(
				"gh",
				["api", `repos/${repo}/actions/runs/${r.id}/attempts/${a}/jobs?per_page=100`],
				{ encoding: "utf8" },
			);
			if (attRes.status !== 0 || jobsRes.status !== 0) continue;
			const attObj = JSON.parse(attRes.stdout);
			const jobsObj = JSON.parse(jobsRes.stdout).jobs ?? [];
			const jobs = jobsObj.map((j) => {
				const st = j.started_at ? Date.parse(j.started_at) : Number.NaN;
				const cp = j.completed_at ? Date.parse(j.completed_at) : Number.NaN;
				const cr = j.created_at ? Date.parse(j.created_at) : Number.NaN;
				return {
					name: String(j.name),
					conclusion: j.conclusion ?? null,
					durationSec: Number.isFinite(st) && Number.isFinite(cp) ? Math.max(0, (cp - st) / 1000) : null,
					queueSec: Number.isFinite(cr) && Number.isFinite(st) ? Math.max(0, (st - cr) / 1000) : null,
				};
			});
			const starts = jobsObj.map((j) => Date.parse(j.started_at)).filter(Number.isFinite);
			const ends = jobsObj.map((j) => Date.parse(j.completed_at)).filter(Number.isFinite);
			const elapsedSec =
				starts.length > 0 && ends.length > 0 ? Math.max(0, (Math.max(...ends) - Math.min(...starts)) / 1000) : null;
			attempts.push({
				attempt: a,
				conclusion: attObj.conclusion ?? null,
				workflowElapsedSec: elapsedSec,
				jobs,
			});
		}
		normalized.push({
			runId: r.id,
			event: r.event,
			branch: r.head_branch,
			attemptsCount,
			attempt1Conclusion: attempts[0]?.conclusion ?? r.conclusion ?? null,
			finalConclusion: r.conclusion ?? null,
			attempts,
		});
	}
	return normalized;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	let inputPath = null;
	let live = false;
	let repo = "noctem-o/endophasia";
	let workflow = "ci.yml";
	let limit = 30;
	let jsonMode = false;

	for (let i = 0; i < args.length; i++) {
		const [flag, inline] = args[i].split(/=(.*)/s, 2);
		const val = () => (inline !== undefined ? inline : args[++i]);
		if (flag === "--input") inputPath = val();
		else if (flag === "--live") live = true;
		else if (flag === "--repo") repo = val();
		else if (flag === "--workflow") workflow = val();
		else if (flag === "--limit") limit = Number(val());
		else if (flag === "--json") jsonMode = true;
		else {
			console.error(`Unknown argument: ${args[i]}`);
			process.exit(2);
		}
	}

	if (!inputPath && !live) {
		console.error("Specify either --input=<runs.json> or --live");
		process.exit(2);
	}

	const runs = live ? fetchLiveRuns({ repo, workflow, limit }) : JSON.parse(readFileSync(inputPath, "utf8"));
	const metrics = computeCiHistoryMetrics(Array.isArray(runs) ? runs : runs.runs ?? []);

	if (jsonMode) {
		console.log(JSON.stringify(metrics, null, 2));
	} else {
		const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
		console.log(`CI History Summary (${metrics.totalRuns} completed runs)`);
		console.log(
			`  First-attempt success : ${metrics.firstAttemptSuccess}/${metrics.decisiveAttempt1} (${pct(metrics.firstAttemptSuccessRate)}) [cancelled attempt 1: ${metrics.cancelledAttempt1}]`,
		);
		console.log(
			`  Eventual success      : ${metrics.eventualSuccess}/${metrics.decisiveFinal} (${pct(metrics.eventualSuccessRate)})`,
		);
		console.log(
			`  Failure -> Pass rerun : ${metrics.failedThenPassed}/${metrics.firstAttemptFailure} (${pct(metrics.sameRevisionFailureToPassRate)})`,
		);
		console.log(
			`  Passing elapsed       : median=${metrics.passingWorkflowElapsedSec.medianSec ?? "n/a"}s p95=${metrics.passingWorkflowElapsedSec.p95Sec ?? "n/a"}s (n=${metrics.passingWorkflowElapsedSec.n})`,
		);
		console.log(
			`  Shard imbalance       : median=${metrics.shardImbalanceSec.medianSec ?? "n/a"}s max=${metrics.shardImbalanceSec.maxSec ?? "n/a"}s`,
		);
		console.log(
			`  Runner-minutes        : total=${metrics.runnerMinutes.total}m rerun=${metrics.runnerMinutes.rerun}m (${pct(metrics.runnerMinutes.rerunShare)})`,
		);
	}
}
