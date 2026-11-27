// Reproducible simulated 24-hour S2 Coordinator workload (COORDINATOR-AUTOMATION-S2).
//
//   node scripts/s2-simulate-24h.ts            # prints a JSON summary; creates and removes a temporary store
//
// SIMULATED, NOT MEASURED: the model runner and the member observer are deterministic fakes (no network, no model, no
// 127.0.0.1:8091). The scheduler, leases, stores, budgets, semantic digests and projections are the real implementation over a
// real temporary store. Token figures are the fake's reported usage (200 completion tokens per turn) or the conservative
// reservation where usage is withheld; they say nothing about a real model's speed or output size.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addEndoAdvisoryScheduleV0,
	authorizeEndoAdvisoryScheduleV0,
	readEndoAdvisoryProjectionV0,
	setEndoAdvisoryScheduleEnabledV0,
} from "../adapters/develop/advisory-operator.ts";
import { runEndoAdvisoryTickV0 } from "../adapters/develop/advisory-tick.ts";
import {
	ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
	parseEndoCoordinatorModelPoolV0,
} from "../protocol/coordinator-model-pool.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { DevelopAdvisoryStoreV0 } from "../storage/develop-advisory.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = Date.parse("2026-11-26T00:00:00.000Z");
const TICK_EVERY = 5 * MIN;
let now = BASE;
const clock = () => now;
const ok = <T>(r: { ok: true; value: T } | { ok: false }): T => {
	if (!r.ok) throw new Error(JSON.stringify(r));
	return r.value;
};

const root = mkdtempSync(join(tmpdir(), "endo-s2-sim-"));
const repo = mkdtempSync(join(tmpdir(), "endo-s2-sim-repo-"));
try {
	const tasks = new DevelopTasksStoreV0(root);
	const project = ok(tasks.registerProject({ name: "sim", path: repo, observedGitRoot: null }));
	const taskA = ok(tasks.createTask(project.id, { title: "Task A" }));
	const taskB = ok(tasks.createTask(project.id, { title: "Task B" }));
	const setStatus = (taskId: string, to: string) => {
		const read = tasks.read();
		if (!read.ok || !read.exists) throw new Error("tasks");
		const t = read.file.tasks.find((x) => x.id === taskId)!;
		ok(tasks.setStatus(project.id, taskId, t.revision, to, null));
	};
	const pool = parseEndoCoordinatorModelPoolV0({
		schemaVersion: ENDO_COORDINATOR_MODEL_POOL_SCHEMA_V0,
		selection: { fallback: "availability", unconfirmedModel: "refuse" },
		members: [
			{
				memberId: "local",
				kind: "local-openai-compat",
				endpoint: "http://127.0.0.1:18091",
				modelId: "sim-model",
				priority: 100,
				maxPromptBytes: 8192,
				maxOutputTokens: 512,
				timeoutMs: 60_000,
				advisoryOnly: true,
			},
		],
	});
	const budget = {
		periodMs: 24 * HOUR,
		maxTurnsPerPeriod: 12,
		completionRequestsPerTurn: 2 as const,
		maxOutputTokensPerRequest: 512,
		maxGeneratedTokensPerPeriod: 8192,
		maxTurnWallClockMs: 120_000,
	};
	const policy = {
		permitCapacityUnknown: true,
		permitModelUnconfirmed: false,
		// A store with no event log reads "status-events-unavailable" (partial); the operator permits reasoning over it explicitly.
		permitPartialObservation: true,
		observationSource: "recorded-or-passive-probe" as const,
		recordedObservationMaxAgeMs: 10 * MIN,
	};
	for (const [scheduleId, actionKind, wake, everyMs] of [
		["brief-on-change", "generate-advisory-brief", "on-change", 15 * MIN],
		["proposal-digest", "emit-operator-proposal", "digest-window", 6 * HOUR],
	] as const) {
		ok(
			addEndoAdvisoryScheduleV0(
				root,
				{
					scheduleId,
					label: null,
					projectId: project.id,
					actionKind,
					wake,
					missedRunPolicy: "skip-and-report",
					trigger: { kind: "interval", everyMs, anchorMs: BASE },
				},
				clock,
			),
		);
		const enabled = ok(setEndoAdvisoryScheduleEnabledV0(root, scheduleId, true, 1, clock));
		ok(
			authorizeEndoAdvisoryScheduleV0(
				root,
				{
					scheduleId,
					scheduleRevision: enabled.schedule.revision,
					pool,
					policy,
					budget,
					lifetimeMs: 2 * 24 * HOUR,
				},
				clock,
			),
		);
	}

	const events = new Map<number, () => void>([
		[3 * HOUR, () => setStatus(taskA.id, "in-progress")],
		[8 * HOUR, () => setStatus(taskA.id, "blocked")],
		[13 * HOUR, () => setStatus(taskB.id, "in-progress")],
		[18 * HOUR, () => setStatus(taskB.id, "review")],
		[20 * HOUR, () => setStatus(taskA.id, "in-progress")],
	]);
	const outageFrom = 7 * HOUR;
	const outageTo = 9 * HOUR;
	const crashAt = 13 * HOUR;
	const withheldUsageAt = 18 * HOUR;

	let inferenceRequests = 0;
	let ticks = 0;
	let refusedTicks = 0;
	let crashes = 0;
	const timeline: string[] = [];
	const tally: Record<string, number> = {};
	for (let t = BASE; t < BASE + 24 * HOUR; t += TICK_EVERY) {
		now = t + 1_000;
		const offset = t - BASE;
		events.get(offset)?.();
		const outage = offset >= outageFrom && offset < outageTo;
		ticks += 1;
		try {
			const result = await runEndoAdvisoryTickV0({
				root,
				now: clock,
				observeMember: async (m) => ({
					memberId: m.memberId,
					endpoint: m.endpoint,
					modelId: m.modelId,
					basis: "controller-observed",
					observedAtMs: now,
					elapsedMs: 2,
					readiness: outage ? "unreachable" : "capacity-unknown",
					detail: outage ? "connect-failed" : "slots-not-observable",
					backend: "llama.cpp-single",
					build: null,
					requests: [{ path: "/health", status: outage ? null : 200 }],
					inferenceTokens: 0,
				}),
				hooks:
					offset === crashAt
						? {
								afterDispatchRecord: () => {
									crashes += 1;
									throw new Error("simulated crash after dispatch record");
								},
							}
						: {},
				run: (async (
					_r: string,
					request: { projectId: string; question?: string },
					options: Record<string, any>,
				) => {
					inferenceRequests += 1;
					now += 40_000;
					const pinnedSha =
						options.pinnedObservation === undefined
							? "b".repeat(64)
							: sha256HexV0(canonicalEndoJsonV0(options.pinnedObservation.status));
					options.trial?.({
						promptSha256: "a".repeat(64),
						inference: {},
						wire: {
							responses: [
								{
									finish: "tool_calls",
									usage: offset === withheldUsageAt ? null : { prompt_tokens: 500, completion_tokens: 40 },
									text: "",
									toolCalled: true,
								},
								{
									finish: "stop",
									usage: offset === withheldUsageAt ? null : { prompt_tokens: 900, completion_tokens: 160 },
									text: "",
									toolCalled: false,
								},
							],
						},
						dispatched: true,
						toolOutcome: null,
						evidence: { readAtMs: now, projectionSha256: pinnedSha, modelViewSha256: "c".repeat(64) },
						latencyMs: 40_000,
						inferenceElapsedMs: 40_000,
						admittedExchanges: 2,
						recorderClean: true,
						stderr: "",
					});
					const answer =
						request.question === undefined
							? "- Task A is blocked; verification is not established."
							: `- Task A is blocked.\nPROPOSAL: resolve-blocked-task ${taskA.id}`;
					return {
						schemaVersion: "endo.coordinator-brief.v0",
						projectId: request.projectId,
						runtime: { harness: "OpenClaw 2026.11.7", provider: "sim", model: options.target.model },
						availability: "available",
						answer,
						evidence: { readAtMs: now, projectionSha256: pinnedSha, modelViewSha256: "c".repeat(64) },
						toolSurface: ["endophasia_status"],
					};
				}) as never,
			});
			if (!result.ok) {
				refusedTicks += 1;
				tally[`tick:${result.refusal}`] = (tally[`tick:${result.refusal}`] ?? 0) + 1;
				continue;
			}
			for (const o of result.outcomes) {
				tally[o.status] = (tally[o.status] ?? 0) + 1;
				if (o.status !== "skipped-unchanged")
					timeline.push(
						`+${(offset / HOUR).toFixed(2)}h ${o.scheduleId} ${o.status}${o.detail === null ? "" : `: ${o.detail}`}`,
					);
			}
		} catch (error) {
			timeline.push(`+${(offset / HOUR).toFixed(2)}h tick crashed: ${(error as Error).message}`);
		}
	}
	const view = readEndoAdvisoryProjectionV0(root, { now: clock, limit: 256 });
	const turns = new DevelopAdvisoryStoreV0(root).listTurns();
	const settled = turns.ok ? turns.entries.filter((t) => t.briefing !== null) : [];
	process.stdout.write(
		`${JSON.stringify(
			{
				simulated: true,
				ticks,
				tickCadenceMinutes: TICK_EVERY / MIN,
				refusedTicks,
				injectedCrashes: crashes,
				inferenceRequests,
				fireOutcomes: tally,
				turns: {
					admitted: turns.ok ? turns.entries.length : null,
					dispatched: turns.ok ? turns.entries.filter((t) => t.dispatch !== null).length : null,
					briefingsAvailable: settled.filter((t) => t.briefing!.availability === "available").length,
					notDispatched: settled.filter((t) => t.briefing!.availability === "not-dispatched").length,
					states: view.turns.reduce<Record<string, number>>((acc, t) => {
						acc[t.state] = (acc[t.state] ?? 0) + 1;
						return acc;
					}, {}),
				},
				budget: view.schedules.map((s) => ({
					scheduleId: s.schedule.scheduleId,
					turnsCharged: s.budget?.turnsCharged,
					generatedTokensCharged: s.budget?.generatedTokensCharged,
					uncertainTurns: s.budget?.uncertainTurns,
					maxTurnsPerPeriod: s.budget?.maxTurnsPerPeriod,
					maxGeneratedTokensPerPeriod: s.budget?.maxGeneratedTokensPerPeriod,
				})),
				proposals: view.proposals.map((p) => ({
					kind: p.proposal.kind,
					queueState: p.queueState,
					currency: p.currency,
				})),
				proposalOutcomes: settled.reduce<Record<string, number>>((acc, t) => {
					acc[t.briefing!.proposal.outcome] = (acc[t.briefing!.proposal.outcome] ?? 0) + 1;
					return acc;
				}, {}),
				timeline,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
}
